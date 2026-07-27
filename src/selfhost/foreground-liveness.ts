// Foreground-liveness invariant (#selfhost-queue-liveness): live contributor-PR-review work (github-webhook,
// agent-regate-pr, agent-regate-sweep, recapture-preview -- everything at or above FOREGROUND_QUEUE_PRIORITY_FLOOR,
// see queue-common.ts) must always have a BOUNDED runnable trickle, mirroring the maintenance lane's own
// maxDeferAgeMs escape hatch (maintenance-admission.ts). Unlike maintenance jobs, foreground jobs never go through
// an admission gate that EXEMPTS them the way maintenance-admission exempts maintenance jobs entirely -- but three
// distinct ADMISSION GATES (not just rate-limiting) can each independently push a foreground job's run_after into
// the future: the GitHub rate-limit admission check (processOne, before consume(), plus the rate-limit BUDGET
// sweep, deferPendingJobsForRateLimit), the per-installation concurrency admission check, and (for jobs sharing a
// priority band with maintenance work) the maintenance-admission check itself. A GITHUB_BUDGET_BACKGROUND_TYPES
// job like agent-regate-pr (a literal "contributor PR review", priority 9, foreground) is rate-limited with the
// SAME conservative headroom as genuine maintenance sweeps (MAINTENANCE_RESERVED_HEADROOM, see queue-common.ts's
// githubRateLimitAdmissionTargetForJob), so a shared REST budget drained by a post-deploy catch-up burst can defer
// it for the full rate-limit reset window (up to MAX_GITHUB_RATE_LIMIT_RETRY_MS = 65 minutes) with no floor.
// Without this module, that lane can silently starve entirely: hundreds of pending contributor-PR-review jobs,
// zero processing, zero runnable, requiring manual intervention -- the production incident this module exists to
// make structurally impossible.
//
// #9127 -- CORRECTION: an earlier version of this comment claimed admission gates were the ONLY way a foreground
// job's run_after could land in the future. That premise was false: enqueue(message, delaySeconds) sets
// run_after = now + delaySeconds*1000 for foreground job types too -- e.g. the linked-issue flag-then-close grace
// window (processors.ts) enqueues a delayed "recapture-preview" verify job the exact same way. Because the
// candidate SELECT below had no provenance filter, it could not tell a deliberate enqueue-time delay from an
// admission-gate defer, and released BOTH -- collapsing a promised multi-minute grace window to one sweep tick
// (as little as FOREGROUND_LIVENESS_CHECK_INTERVAL_MS, 60s default). The `deferred_by` column (set ONLY at the
// three admission-gate defer sites, never by enqueue()) is the provenance filter that fixes this: the candidate
// SELECT now requires `deferred_by IS NOT NULL`, so an enqueue-time delay is structurally ineligible for release
// regardless of age or rate-limit state, no matter how long it is pending.
//
// The queue backends (pg-queue.ts / sqlite-queue.ts) run releaseStaleForegroundDeferrals() periodically (see
// start()) AND once at boot (init()), so a restart/deploy self-heals inherited over-deferral instead of needing
// manual unsticking. A dedicated slow interval (not the 1s poll tick) bounds retry cost: a job still genuinely
// rate-limited after being released just re-defers and waits for the NEXT sweep, never a busy-loop on every tick.
import { parsePositiveIntEnv } from "./queue-common";

const DEFAULT_MAX_DEFER_MS = 10 * 60_000; // 10 minutes -- long enough to not fight a normal rate-limit backoff
// (which typically resolves within DEFAULT_GITHUB_RATE_LIMIT_RETRY_MS + jitter, see queue-common.ts), short
// enough that live contributor-PR-review work is never parked anywhere near the ~65-minute worst case.
const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 minute
// Ramp-up cap (#selfhost-queue-liveness): a large inherited backlog (the production incident this module
// exists for had ~190 over-deferred foreground jobs) must not release ALL of it in one sweep tick -- that
// many jobs re-attempting GitHub reads at once can immediately re-trip the same rate-limit bucket they were
// deferred for, undoing the release. Draining a couple dozen per minute clears even a large backlog within
// several minutes while never presenting GitHub with more than a bounded burst.
const DEFAULT_MAX_RELEASE_PER_SWEEP = 25;

export interface ForegroundLivenessConfig {
  enabled: boolean;
  maxDeferMs: number;
  checkIntervalMs: number;
  maxReleasePerSweep: number;
}

function foregroundLivenessEnabled(): boolean {
  const raw = (process.env.FOREGROUND_LIVENESS_ENABLED ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/** Reads every FOREGROUND_LIVENESS_* knob from process.env, each with a sane, protective default. Resolved ONCE
 *  per queue instance (mirrors resolveMaintenanceAdmissionConfig / queueBackgroundConcurrency) rather than per
 *  sweep, so a misconfigured value only warns once at startup instead of on every tick. */
export function resolveForegroundLivenessConfig(): ForegroundLivenessConfig {
  return {
    enabled: foregroundLivenessEnabled(),
    maxDeferMs: parsePositiveIntEnv("FOREGROUND_LIVENESS_MAX_DEFER_MS", { min: 60_000, fallback: DEFAULT_MAX_DEFER_MS }),
    checkIntervalMs: parsePositiveIntEnv("FOREGROUND_LIVENESS_CHECK_INTERVAL_MS", { min: 5_000, fallback: DEFAULT_CHECK_INTERVAL_MS }),
    maxReleasePerSweep: parsePositiveIntEnv("FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP", { min: 1, fallback: DEFAULT_MAX_RELEASE_PER_SWEEP }),
  };
}

/** PURE decision: is a pending foreground job's deferral stale enough to force-release regardless of its current
 *  run_after? Mirrors evaluateMaintenanceAdmission's own trickle_max_defer_age condition, but keyed on
 *  `pendingSinceMs` (the row's created_at -- never reset across a coalesced re-enqueue or an admission-style
 *  re-defer, see maintenance-admission.ts's own doc comment on the same anchor) rather than run_after, so a job
 *  repeatedly re-deferred to a fresh future timestamp still gets released once its GENUINE wait time crosses the
 *  ceiling. `enabled: false` never releases (the operator-disable escape hatch, mirroring
 *  MAINTENANCE_ADMISSION_ENABLED=false). */
export function isForegroundDeferralStale(config: ForegroundLivenessConfig, pendingSinceMs: number, nowMs: number): boolean {
  return config.enabled && nowMs - pendingSinceMs >= config.maxDeferMs;
}

/** PURE ramp-up selection: given every candidate ELIGIBLE for release this sweep (already filtered by
 *  isForegroundDeferralStale or a live rate-limit-clear check -- this function does not itself decide
 *  eligibility), pick at most `maxReleasePerSweep` of them, prioritizing candidates whose rate-limit bucket is
 *  CURRENTLY clear before using age order. The stale-age backstop must not let an older still-blocked bucket
 *  monopolize the global ramp-up cap and starve newer clear-bucket foreground work across repeated sweeps.
 *  When candidates already fit within the cap, every one is released (a small/moderate backlog is never
 *  artificially throttled) -- the cap only engages for a genuinely large backlog, gradually draining it over
 *  several sweep ticks instead of releasing hundreds of jobs into one instant. Ties broken by the original
 *  array order (stable) so behavior is deterministic given the same input. Pure. */
export function selectForegroundDeferralsToRelease<T extends { pendingSinceMs: number; rateLimitClear: boolean }>(
  candidates: readonly T[],
  maxReleasePerSweep: number,
): T[] {
  if (candidates.length <= maxReleasePerSweep) return [...candidates];
  return [...candidates]
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        Number(b.candidate.rateLimitClear) - Number(a.candidate.rateLimitClear) ||
        a.candidate.pendingSinceMs - b.candidate.pendingSinceMs ||
        a.index - b.index,
    )
    .slice(0, maxReleasePerSweep)
    .map(({ candidate }) => candidate);
}
