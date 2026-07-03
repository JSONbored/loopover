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
}

const DEFAULT_MAX_LIVE_PENDING_COUNT = 5;
const DEFAULT_MAX_LIVE_JOB_AGE_MS = 2 * 60_000;
const DEFAULT_MAX_MAINTENANCE_PENDING_COUNT = 15;
const DEFAULT_MAX_HOST_LOAD_AVG1_PER_CORE = 1.5;
const DEFAULT_DEFER_MS = 3 * 60_000;
const DEFAULT_MAX_DEFER_AGE_MS = 4 * 60 * 60_000;

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
    maxDeferAgeMs: parsePositiveIntEnv("MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS", {
      min: 60_000,
      fallback: DEFAULT_MAX_DEFER_AGE_MS,
    }),
  };
}

export type MaintenanceAdmissionReason =
  | "disabled"
  | "trickle_max_defer_age"
  | "live_pending_high"
  | "live_job_age_high"
  | "maintenance_pending_high"
  | "host_load_high"
  | "pressure_clear";

export interface MaintenanceAdmissionDecision {
  admit: boolean;
  reason: MaintenanceAdmissionReason;
}

/** PURE policy decision: admit this maintenance job now, or defer it? Checked in priority order -- the
 *  trickle (age) escape hatch first, so a starved job is never re-denied by a later check, then each pressure
 *  signal in turn. `pendingSinceMs` is the job's ORIGINAL enqueue time (its row's created_at), not the time of
 *  its most recent deferral, so the trickle clock only resets on a genuine fresh request (a coalesced
 *  re-enqueue), never on a repeated denial of the same wait. */
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
  if (signals.maintenancePendingCount > config.maxMaintenancePendingCount) {
    return { admit: false, reason: "maintenance_pending_high" };
  }
  if (signals.hostLoadAvg1PerCore !== null && signals.hostLoadAvg1PerCore > config.maxHostLoadAvg1PerCore) {
    return { admit: false, reason: "host_load_high" };
  }
  return { admit: true, reason: "pressure_clear" };
}

/** Jittered defer duration for a denied maintenance job -- the base `deferMs` plus up to another `deferMs` of
 *  deterministic jitter (seeded by the job's own identity) so a whole cohort of denied jobs doesn't wake up on
 *  the same tick and immediately re-trip the same pressure check (mirrors rateLimitRetryDelayWithJitter). */
export function maintenanceAdmissionDeferMs(config: MaintenanceAdmissionConfig, jitterSeed: string): number {
  return config.deferMs + deterministicJitterMs(jitterSeed, config.deferMs);
}
