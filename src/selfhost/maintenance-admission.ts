// Maintenance-job backpressure / admission policy (#selfhost-runtime-pressure). User-facing work --
// github-webhook, agent-regate-pr, the regate sweep trigger, recapture-preview (everything at or above
// FOREGROUND_QUEUE_PRIORITY_FLOOR, see queue-common.ts) -- must always win a resource race against periodic
// maintenance sweeps (contributor evidence, burden forecasts, RAG re-indexing, drift scans, product rollups,
// notifications...). Those sweeps already run on a conservative cadence (every 30min/hourly/6-hourly, see
// index.ts's enqueueScheduledJobs) and already yield to an EXHAUSTED GitHub REST budget
// (shouldWaitForGitHubRateLimit) -- this module adds an ORTHOGONAL signal: is the box itself under load RIGHT
// NOW (a live-work backlog, an aging live job, a hot host CPU), independent of whether GitHub's API happens to
// be rate-limited. The queue backends (sqlite-queue.ts / pg-queue.ts) consult this at CLAIM time, the same way
// they already consult GitHub rate-limit admission: a denied maintenance job is pushed back to 'pending' with
// a jittered future run_after -- its original enqueue time is left untouched, so the age-based trickle below
// still works -- never dropped and never run early.
//
// TRICKLE: a maintenance job that has been pending since `maxDeferAgeMs` is force-admitted regardless of
// current pressure, so a box under SUSTAINED load can never starve maintenance work forever -- it just runs at
// a bounded minimum rate instead of its normal cadence.
//
// DRAIN (#selfhost-maintenance-self-pin): `maintenance_pending_high` alone is a LANE-WIDE aggregate count, with
// no feedback loop back to that count as individual jobs age out via the trickle above -- so once the lane backs
// up past `maxMaintenancePendingCount` and stays there (new maintenance work keeps arriving as fast as, or faster
// than, the trickle drains it), EVERY claim is denied `maintenance_pending_high` until each job independently
// reaches the full `maxDeferAgeMs` (hours later), and the aggregate count never has a chance to fall back under
// the threshold in the meantime -- the backlog is deferred because it's high, and stays high because it's
// deferred. `maintenanceDrainAgeMs` is a second, much shorter age escape scoped ONLY to the
// `maintenance_pending_high` branch: a job that has waited at least this long is admitted despite the lane still
// being over threshold, so the oldest jobs steadily leak through (throttled further by the queue's own
// `backgroundConcurrency` claim cap) and the aggregate count can actually shrink well before the 4h backstop.
// Newly-arrived jobs in the same burst still wait out `maintenanceDrainAgeMs` first, so this is a bounded trickle,
// not a flood -- and it applies to `maintenance_pending_high` alone: `live_pending_high` / `live_job_age_high` /
// `host_load_high` keep blocking maintenance outright, so live-review priority and host-load safety are untouched.
import { deterministicJitterMs, parsePositiveIntEnv } from "./queue-common";

// Periodic, repo/contributor-set-wide sweeps -- the heavy, deferrable maintenance lane. Deliberately EXCLUDES
// the targeted, per-PR/per-repo jobs fanned out FROM some of these (or that serve a specific in-flight
// PR/webhook directly): "backfill-repo-segment", "backfill-pr-details", "run-agent", "submit-draft",
// "retry-orb-relay" stay on the normal background lane, unthrottled by this policy. Foreground job types
// (github-webhook, agent-regate-pr, agent-regate-sweep, recapture-preview) are never listed here either -- they
// are already priority-gated (FOREGROUND_QUEUE_PRIORITY_FLOOR) and this policy only ever runs for a
// background-priority job.
export const MAINTENANCE_JOB_TYPES: ReadonlySet<string> = new Set([
  "backfill-registered-repos",
  "refresh-registry",
  "refresh-installation-health",
  "refresh-scoring-model",
  "refresh-upstream-sources",
  "build-upstream-ruleset",
  "detect-upstream-drift",
  "refresh-upstream-drift",
  "file-upstream-drift-issues",
  "build-contributor-evidence",
  "build-contributor-decision-packs",
  "refresh-contributor-activity",
  "build-burden-forecasts",
  "repair-data-fidelity",
  "rollup-product-usage",
  "prune-retention",
  "generate-weekly-value-report",
  "generate-signal-snapshots",
  "notify-evaluate",
  "notify-deliver",
  "ops-alerts",
  "selftune",
  "rag-index-repo",
  "backlog-convergence-sweep",
]);

export function isMaintenanceJobType(type: string): boolean {
  return MAINTENANCE_JOB_TYPES.has(type);
}

export interface MaintenancePressureSignals {
  livePendingCount: number;
  oldestLivePendingAgeMs: number | null;
  maintenancePendingCount: number;
  oldestMaintenancePendingAgeMs: number | null;
  /** Null when unavailable (see host-pressure.ts) -- a caller must treat null as "skip this check". */
  hostLoadAvg1PerCore: number | null;
}

export interface MaintenanceAdmissionConfig {
  enabled: boolean;
  maxLivePendingCount: number;
  maxLiveJobAgeMs: number;
  maxMaintenancePendingCount: number;
  maxHostLoadAvg1PerCore: number;
  deferMs: number;
  maxDeferAgeMs: number;
  maintenanceDrainAgeMs: number;
}

const DEFAULT_MAX_LIVE_PENDING_COUNT = 5;
const DEFAULT_MAX_LIVE_JOB_AGE_MS = 2 * 60_000;
const DEFAULT_MAX_MAINTENANCE_PENDING_COUNT = 15;
const DEFAULT_MAX_HOST_LOAD_AVG1_PER_CORE = 1.5;
const DEFAULT_DEFER_MS = 3 * 60_000;
const DEFAULT_MAX_DEFER_AGE_MS = 4 * 60 * 60_000;
const DEFAULT_MAINTENANCE_DRAIN_AGE_MS = 10 * 60_000;

function maintenanceAdmissionEnabled(): boolean {
  const raw = (process.env.MAINTENANCE_ADMISSION_ENABLED ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function parsePositiveFloatEnv(name: string, fallback: number): number {
  const supplied = process.env[name];
  if (supplied === undefined) return fallback;
  const parsed = Number(supplied);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Reads every MAINTENANCE_ADMISSION_* knob from process.env, each with a sane, protective default. Resolved
 *  ONCE per queue instance (mirrors queueBackgroundConcurrency / queueStartupJitterMs) rather than per job, so
 *  a misconfigured value only warns once at startup instead of on every claim. */
export function resolveMaintenanceAdmissionConfig(): MaintenanceAdmissionConfig {
  const maxDeferAgeMs = parsePositiveIntEnv("MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS", {
    min: 60_000,
    fallback: DEFAULT_MAX_DEFER_AGE_MS,
  });
  const requestedDrainAgeMs = parsePositiveIntEnv("MAINTENANCE_ADMISSION_DRAIN_AGE_MS", {
    min: 1_000,
    fallback: DEFAULT_MAINTENANCE_DRAIN_AGE_MS,
  });
  return {
    enabled: maintenanceAdmissionEnabled(),
    maxLivePendingCount: parsePositiveIntEnv("MAINTENANCE_ADMISSION_MAX_LIVE_PENDING", {
      min: 0,
      fallback: DEFAULT_MAX_LIVE_PENDING_COUNT,
    }),
    maxLiveJobAgeMs: parsePositiveIntEnv("MAINTENANCE_ADMISSION_MAX_LIVE_AGE_MS", {
      min: 0,
      fallback: DEFAULT_MAX_LIVE_JOB_AGE_MS,
    }),
    maxMaintenancePendingCount: parsePositiveIntEnv("MAINTENANCE_ADMISSION_MAX_PENDING", {
      min: 0,
      fallback: DEFAULT_MAX_MAINTENANCE_PENDING_COUNT,
    }),
    maxHostLoadAvg1PerCore: parsePositiveFloatEnv(
      "MAINTENANCE_ADMISSION_MAX_HOST_LOAD",
      DEFAULT_MAX_HOST_LOAD_AVG1_PER_CORE,
    ),
    deferMs: parsePositiveIntEnv("MAINTENANCE_ADMISSION_DEFER_MS", { min: 1_000, fallback: DEFAULT_DEFER_MS }),
    maxDeferAgeMs,
    // Never longer than the trickle backstop itself -- a misconfigured drain age above maxDeferAgeMs would be a
    // no-op (the trickle would always win first), so clamp it down rather than let it silently do nothing.
    maintenanceDrainAgeMs: Math.min(requestedDrainAgeMs, maxDeferAgeMs),
  };
}

export type MaintenanceAdmissionReason =
  | "disabled"
  | "trickle_max_defer_age"
  | "live_pending_high"
  | "live_job_age_high"
  | "maintenance_pending_high"
  | "maintenance_pending_high_drain"
  | "host_load_high"
  | "pressure_clear";

export interface MaintenanceAdmissionDecision {
  admit: boolean;
  reason: MaintenanceAdmissionReason;
}

/** PURE policy decision: admit this maintenance job now, or defer it? Checked in priority order -- the
 *  trickle (age) escape hatch first, so a starved job is never re-denied by a later check, then each pressure
 *  signal in turn. `pendingSinceMs` is the job's ORIGINAL enqueue time (its row's created_at), which the queue
 *  backends (sqlite-queue.ts / pg-queue.ts) preserve across BOTH an admission-deferral requeue AND a coalesced
 *  re-enqueue (a periodic scheduler re-requesting the same still-pending maintenance need) -- only a truly
 *  fresh need, enqueued after the prior row was fully processed and deleted, starts a new clock. Otherwise a
 *  re-enqueue cadence shorter than `maxDeferAgeMs` would keep re-arming the clock and defeat the trickle
 *  entirely under sustained pressure.
 *
 *  `maintenance_pending_high` alone gets a SECOND, shorter age escape (`maintenanceDrainAgeMs`, see the module
 *  comment above) so an aggregate-count block on the whole lane can't self-pin indefinitely -- live-pending,
 *  live-job-age, and host-load stay hard blocks with no drain, since those signals aren't about the maintenance
 *  lane's own size and letting maintenance through under THEM would defeat their purpose. */
export function evaluateMaintenanceAdmission(
  signals: MaintenancePressureSignals,
  config: MaintenanceAdmissionConfig,
  pendingSinceMs: number,
  nowMs: number,
): MaintenanceAdmissionDecision {
  if (!config.enabled) return { admit: true, reason: "disabled" };
  if (nowMs - pendingSinceMs >= config.maxDeferAgeMs) return { admit: true, reason: "trickle_max_defer_age" };
  if (signals.livePendingCount > config.maxLivePendingCount) return { admit: false, reason: "live_pending_high" };
  if (signals.oldestLivePendingAgeMs !== null && signals.oldestLivePendingAgeMs > config.maxLiveJobAgeMs) {
    return { admit: false, reason: "live_job_age_high" };
  }
  const hostLoadHigh =
    signals.hostLoadAvg1PerCore !== null && signals.hostLoadAvg1PerCore > config.maxHostLoadAvg1PerCore;
  if (signals.maintenancePendingCount > config.maxMaintenancePendingCount) {
    if (nowMs - pendingSinceMs >= config.maintenanceDrainAgeMs) {
      // Host load is re-checked HERE, gating the drain escape specifically: draining more maintenance work onto
      // an already CPU-overloaded box is exactly what host_load_high exists to prevent. A job that hasn't hit
      // drain age yet is denied `maintenance_pending_high` regardless of host load (unchanged from before this
      // escape existed) -- this check only ever changes the outcome for a job the drain would otherwise admit.
      if (hostLoadHigh) return { admit: false, reason: "host_load_high" };
      return { admit: true, reason: "maintenance_pending_high_drain" };
    }
    return { admit: false, reason: "maintenance_pending_high" };
  }
  if (hostLoadHigh) return { admit: false, reason: "host_load_high" };
  return { admit: true, reason: "pressure_clear" };
}

/** Admission reasons that grant a maintenance job despite active pressure -- every reason except the two
 *  "pressure was never a problem" ones (disabled / pressure_clear). Callers record a dedicated
 *  granted-under-pressure metric for these, the counterpart to the existing deferred-by-reason metric, so an
 *  operator can see the bounded trickle/drain actually firing instead of only ever seeing denials. */
export function isMaintenanceAdmissionGrantedUnderPressure(reason: MaintenanceAdmissionReason): boolean {
  return reason === "trickle_max_defer_age" || reason === "maintenance_pending_high_drain";
}

/** Jittered defer duration for a denied maintenance job -- the base `deferMs` plus up to another `deferMs` of
 *  deterministic jitter (seeded by the job's own identity) so a whole cohort of denied jobs doesn't wake up on
 *  the same tick and immediately re-trip the same pressure check (mirrors rateLimitRetryDelayWithJitter). */
export function maintenanceAdmissionDeferMs(config: MaintenanceAdmissionConfig, jitterSeed: string): number {
  return config.deferMs + deterministicJitterMs(jitterSeed, config.deferMs);
}
