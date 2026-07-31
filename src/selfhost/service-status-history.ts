// Uptime and incident history for the public status board (#9985, slice 2 of #9747).
//
// #9983 publishes the live board and deliberately published no uptime figure, because there was no source
// for one: Alertmanager serves ACTIVE alerts only, resolved ones are gone, and nothing persisted a history.
// This is that source -- one sample per component per cron tick -- and the aggregation over it.
//
// ── THE WINDOW MUST NOT LIE ABOUT ITSELF ─────────────────────────────────────────────────────────────
// A "30-day uptime" computed over three days of samples is the same class of falsehood as a verifier that
// reports green because it checked nothing. So every window reports its COVERAGE -- how much of the window
// actually has samples -- alongside the percentage, and `since` says when history begins. A reader can then
// tell "99.9% over a full month" from "99.9% over the two days we have been recording".
//
// ── UNMEASURED TIME IS NOT UPTIME, AND NOT DOWNTIME ──────────────────────────────────────────────────
// An `unknown` sample means the alerting source could not be read on that tick. It is excluded from the
// percentage entirely rather than counted either way: counting it as up inflates the figure exactly when we
// were blind, and counting it as down invents an outage nobody observed. It is reported as its own number so
// the blindness is visible instead of averaged away.

/** The status vocabulary the live board publishes, mirrored here because samples store it verbatim. */
export type SampledStatus = "operational" | "degraded" | "outage" | "unknown";

export type StatusSample = { status: SampledStatus; sampledAt: string };

/** A contiguous run of non-operational, non-unknown samples: an incident, derived rather than posted.
 *  `endedAt` is null while the run reaches the newest sample -- the incident is still open. */
export type StatusIncident = { status: "degraded" | "outage"; startedAt: string; endedAt: string | null };

export type UptimeWindow = {
  windowDays: number;
  /** Share of MEASURED samples that were operational, 0..1. Null when nothing was measured -- no data must
   *  render as no claim, never as 0% (which reads as a total outage) or 100% (which reads as perfect). */
  uptime: number | null;
  /** Samples that carried a real reading. The denominator of `uptime`. */
  measured: number;
  /** Samples where the source could not be read. Reported, never folded into `uptime`. */
  unmeasured: number;
  /** Oldest sample in the window, or null when the window is empty. What makes a partial window legible. */
  since: string | null;
  /** True when history does not reach back across the whole window, so the figure covers less than it says. */
  partial: boolean;
};

/** PURE. Is this a state a reader should see as an incident? `unknown` is deliberately NOT one -- we did not
 *  observe a problem, we failed to look. */
export function isIncidentStatus(status: SampledStatus): status is "degraded" | "outage" {
  return status === "degraded" || status === "outage";
}

/**
 * PURE. Uptime over a trailing window, with the honesty fields that make it readable.
 *
 * `samples` may be in any order and may include rows outside the window; both are filtered here so the
 * caller's query does not have to be the thing that is correct.
 */
export function computeUptimeWindow(samples: readonly StatusSample[], windowDays: number, nowMs: number): UptimeWindow {
  const startMs = nowMs - windowDays * 86_400_000;
  const inWindow = samples.filter((sample) => {
    const at = Date.parse(sample.sampledAt);
    return Number.isFinite(at) && at >= startMs && at <= nowMs;
  });
  const measuredSamples = inWindow.filter((sample) => sample.status !== "unknown");
  const operational = measuredSamples.filter((sample) => sample.status === "operational").length;
  const since = inWindow.length === 0 ? null : inWindow.reduce((oldest, s) => (s.sampledAt < oldest ? s.sampledAt : oldest), inWindow[0]!.sampledAt);
  // Partiality is decided by the oldest sample OVERALL, not the oldest one inside the window. `inWindow` is
  // filtered to `>= startMs`, so an in-window `since` can never predate the window start -- deriving
  // partiality from it would mark every window partial forever, including ones with years of history behind
  // them. What actually answers "does history reach back across this window" is whether recording began
  // before the window did.
  const oldestOverall = samples
    .map((entry) => Date.parse(entry.sampledAt))
    .filter((ms) => Number.isFinite(ms))
    .reduce<number | null>((oldest, ms) => (oldest === null || ms < oldest ? ms : oldest), null);
  return {
    windowDays,
    // Guard the denominator, else null -- the same discipline every other published rate here uses.
    uptime: measuredSamples.length > 0 ? operational / measuredSamples.length : null,
    measured: measuredSamples.length,
    unmeasured: inWindow.length - measuredSamples.length,
    since,
    // An empty history is partial too: it covers none of the period it names.
    partial: oldestOverall === null || oldestOverall > startMs,
  };
}

/**
 * PURE. Incidents as contiguous runs of non-operational, non-unknown samples.
 *
 * DERIVED, NEVER POSTED -- that is #9747's "incidents appear without manual posting". An `unknown` sample
 * does NOT close an incident and does not start one: a tick where we could not read the source is no evidence
 * either way, and letting it split one outage into two would manufacture incidents out of our own blindness.
 * A run's severity is the WORST status within it, so a degradation that escalates reports as an outage rather
 * than as two adjacent incidents.
 */
export function computeIncidents(samples: readonly StatusSample[], windowDays: number, nowMs: number): StatusIncident[] {
  const startMs = nowMs - windowDays * 86_400_000;
  const ordered = samples
    .filter((sample) => {
      const at = Date.parse(sample.sampledAt);
      return Number.isFinite(at) && at >= startMs && at <= nowMs;
    })
    .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));

  const incidents: StatusIncident[] = [];
  let open: StatusIncident | null = null;
  for (const sample of ordered) {
    if (isIncidentStatus(sample.status)) {
      if (open === null) open = { status: sample.status, startedAt: sample.sampledAt, endedAt: null };
      else if (sample.status === "outage") open.status = "outage";
      continue;
    }
    // `unknown` is not evidence of recovery, so only an `operational` sample closes a run.
    if (sample.status === "operational" && open !== null) {
      open.endedAt = sample.sampledAt;
      incidents.push(open);
      open = null;
    }
  }
  // Still open at the newest sample: reported with a null end rather than closed at "now", which would
  // assert a recovery that was never observed.
  if (open !== null) incidents.push(open);
  return incidents;
}

/** The windows the public board reports. Fixed rather than caller-supplied: a status page whose windows vary
 *  per request is not comparable to itself. */
export const UPTIME_WINDOW_DAYS: readonly number[] = [1, 7, 30];

export type ComponentHistory = { uptime: UptimeWindow[]; incidents: StatusIncident[] };

/** PURE. Everything the board publishes about one component's past. */
export function buildComponentHistory(samples: readonly StatusSample[], nowMs: number): ComponentHistory {
  return {
    uptime: UPTIME_WINDOW_DAYS.map((days) => computeUptimeWindow(samples, days, nowMs)),
    // Over the widest window, so the incident list and the longest uptime figure describe the same period.
    incidents: computeIncidents(samples, Math.max(...UPTIME_WINDOW_DAYS), nowMs),
  };
}

// ── PERSISTENCE ───────────────────────────────────────────────────────────────────────────────────────
// Kept in this module rather than a sibling so the write shape and the read shape are one file apart: the
// sampler stores exactly the vocabulary the aggregation above reads, and a change to one is visibly a change
// to the other.

/** BEST EFFORT. Record one sample per component. A telemetry write must never fail the tick that carries it,
 *  and a missed sample is already representable -- it simply widens the gap the coverage fields report. */
export async function recordServiceStatusSamples(
  env: Env,
  components: readonly { component: string; status: SampledStatus }[],
  now: Date = new Date(),
): Promise<void> {
  const sampledAt = now.toISOString();
  // try/catch around the whole loop, not `.catch()` on the promise: `prepare()` throws SYNCHRONOUSLY when the
  // binding is unusable, so a promise-only guard lets that escape and fail the tick this write is riding on --
  // exactly what "best effort" is supposed to prevent. Caught once around the loop rather than per row because
  // a binding that fails for one component fails for all of them, and a partial sample set is worse than none:
  // it would look like a real reading of only some components.
  try {
    for (const entry of components) {
      await env.DB.prepare(`INSERT INTO service_status_samples (component, status, sampled_at) VALUES (?, ?, ?)`)
        .bind(entry.component, entry.status, sampledAt)
        .run();
    }
  } catch {
    // A missed sample is already representable: it simply widens the gap the coverage fields report.
  }
}

/**
 * Load one component's samples over the widest reported window.
 *
 * FAIL-SAFE, like every other read behind this public surface: a read error yields no samples, which the
 * aggregation reports as an empty, PARTIAL window with a null uptime -- "we cannot say", never a fabricated
 * figure and never a thrown public endpoint.
 */
export async function loadServiceStatusSamples(env: Env, component: string, now: Date = new Date()): Promise<StatusSample[]> {
  const sinceIso = new Date(now.getTime() - Math.max(...UPTIME_WINDOW_DAYS) * 86_400_000).toISOString();
  try {
    const result = await env.DB.prepare(
      `SELECT status, sampled_at FROM service_status_samples WHERE component = ? AND sampled_at >= ? ORDER BY sampled_at`,
    )
      .bind(component, sinceIso)
      .all<{ status: string; sampled_at: string }>();
    return (result.results ?? []).map((row) => ({ status: row.status as SampledStatus, sampledAt: row.sampled_at }));
  } catch {
    return [];
  }
}
