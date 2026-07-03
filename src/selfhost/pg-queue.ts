// Postgres-backed durable job queue for multi-instance self-host (#977). Same contract as the SQLite queue
// (persist → restart re-claims, backoff retries, dead-letter) but uses `FOR UPDATE SKIP LOCKED` so multiple
// app instances sharing one Postgres can claim jobs concurrently without double-processing. size()/deadCount()
// are async (the metrics gauges accept async samplers).
import type { Pool, QueryResult } from "pg";
import { logAudit, extractPayloadType, extractPayloadContext } from "./audit";
import { incr } from "./metrics";
import { withReviewSpan } from "./tracing";
import { withOtelSpan } from "./otel";
import { captureError } from "./sentry";
import {
  consumingRetryDelayMs,
  deterministicJitterMs,
  FOREGROUND_QUEUE_PRIORITY_FLOOR,
  errorMessageWithCause,
  githubRateLimitAdmissionDelayMs,
  githubRateLimitAdmissionTargetForJob,
  githubRateLimitMetricContext,
  githubRateLimitRetryDelayMs,
  buildSelfHostQueueSnapshot,
  isForegroundJobPriority,
  jobCoalesceAbsorbedByKey,
  jobCoalesceKey,
  jobCoalesceMergeKeyPrefix,
  jobCoalesceMergedPayload,
  jobCoalesceSupersededKeyPrefix,
  jobPriority,
  parsePositiveIntEnv,
  queueBackgroundConcurrency,
  queueDeadLetterAutoRetryMaxExtraAttempts,
  queueDeadLetterReviveIntervalMs,
  queueProcessingTimeoutMs,
  queueRecoveryJitterMs,
  queueStartupJitterMinJobs,
  queueStartupJitterMs,
  rateLimitRetryDelayWithJitter,
  matchesGitHubRateLimitAdmissionTarget,
  type GitHubRateLimitAdmissionTarget,
  type SelfHostQueueSnapshot,
} from "./queue-common";

// PostgreSQL SQLSTATE codes that unambiguously indicate a dead/terminated Postgres connection.
// Unlike generic Node.js network codes (ECONNRESET etc.), these can ONLY come from the pg driver
// talking to Postgres, so they're safe to use anywhere an error might come from — including code
// that also runs unrelated network calls (e.g. GitHub API requests inside consume()).
const PG_SQLSTATE_CONNECTION_CODES = new Set([
  "57P01", // terminating connection due to administrator command
  "57P02", // crash shutdown
  "57P03", // cannot connect now
  "08006", // connection failure
  "08003", // connection does not exist
  "08001", // unable to establish connection
  "08004", // rejected connection
]);

// Generic Node.js error codes that ALSO indicate a dead connection, but only when we already know
// the error came from our own pool.query() call (e.g. inside retryPoolQuery) — these codes are
// ambiguous on their own, since any network call (not just Postgres) can throw them.
const NODE_CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE"]);

function hasErrorCode(err: unknown, codes: Set<string>): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (typeof e["code"] === "string" && codes.has(e["code"])) return true;
  // node-postgres wraps some errors; check cause too
  if (e["cause"] && hasErrorCode(e["cause"], codes)) return true;
  return false;
}

/** Use ONLY on errors known to come from our own pool.query() calls (e.g. inside retryPoolQuery) —
 *  covers both unambiguous Postgres SQLSTATE codes and generic Node network codes. */
function isPgConnectionError(err: unknown): boolean {
  return hasErrorCode(err, PG_SQLSTATE_CONNECTION_CODES) || hasErrorCode(err, NODE_CONNECTION_ERROR_CODES);
}

/** Safe to use on ANY caught error, including one thrown by arbitrary application logic (consume()) that
 *  may make its own unrelated network calls — only matches codes that can exclusively mean "Postgres
 *  connection lost" (excludes generic Node codes like ECONNRESET, which a non-PG network failure could
 *  also throw and would otherwise be wrongly left in 'processing' instead of going through normal
 *  retry/dead-letter handling). */
function isPgSqlStateConnectionError(err: unknown): boolean {
  return hasErrorCode(err, PG_SQLSTATE_CONNECTION_CODES);
}

/** Retry a pool query up to `retries` times on transient connection errors, with a short delay
 *  between attempts. The pool will establish a new connection automatically. */
async function retryPoolQuery<T>(fn: () => Promise<T>, retries = 3, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isPgConnectionError(err) || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Run a retryPoolQuery-wrapped update that's safe to skip on a still-dead connection: returns null
 *  (caller should leave the job in 'processing' for reclaim) instead of throwing. An uncaught throw here
 *  would escape processOne() entirely and crash the surrounding pump() loop (see pump()'s catch), stopping
 *  it from processing OTHER already-claimable jobs too -- not just deferring this one job's own retry. */
async function retryPoolUpdateOrLeaveForReclaim(
  fn: () => Promise<QueryResult>,
  jobId: string,
  event: string,
): Promise<QueryResult | null> {
  try {
    return await retryPoolQuery(fn);
  } catch (err) {
    if (!isPgConnectionError(err)) throw err;
    console.warn(
      JSON.stringify({
        level: "warn",
        event,
        id: jobId,
        code: (err as Record<string, unknown>)["code"],
        message: "PG connection terminated; reclaim mechanism will retry",
      }),
    );
    return null;
  }
}
import { hostLoadAvg1PerCore } from "./host-pressure";
import {
  evaluateMaintenanceAdmission,
  isMaintenanceAdmissionGrantedUnderPressure,
  isMaintenanceJobType,
  maintenanceAdmissionDeferMs,
  resolveMaintenanceAdmissionConfig,
  type MaintenanceAdmissionConfig,
  type MaintenancePressureSignals,
} from "./maintenance-admission";
import {
  backlogRepoCandidatesFromJobKeys,
  foregroundLaneForJob,
  nextForegroundLane,
  pickBacklogRepo,
  topBacklogRepoCounts,
  type BacklogRepoCount,
  type ForegroundLane,
} from "./queue-fairness";
import {
  isForegroundDeferralStale,
  resolveForegroundLivenessConfig,
  selectForegroundDeferralsToRelease,
  type ForegroundLivenessConfig,
} from "./foreground-liveness";
import type { JobMessage } from "../types";

const TABLE = "_selfhost_jobs";
const STATS_TABLE = "_selfhost_job_stats";
// Claim-time backlog-vs-fresh-intake fairness state (#selfhost-backlog-convergence, see queue-fairness.ts). A
// SEPARATE singleton table -- NOT the app DB's `global_agent_controls` -- because this queue backend never
// touches the app D1/Postgres database (it owns its own storage, same as _selfhost_jobs/_selfhost_job_stats
// above); reusing global_agent_controls would require a cross-database dependency this queue deliberately has
// never had.
const FAIRNESS_TABLE = "_selfhost_queue_fairness";
const DDL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id BIGSERIAL PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_error TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  job_key TEXT
);
ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS job_key TEXT;
ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS is_maintenance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS foreground_lane TEXT;
CREATE INDEX IF NOT EXISTS ${TABLE}_claim ON ${TABLE}(status, run_after, priority);
CREATE INDEX IF NOT EXISTS ${TABLE}_pending_job_key ON ${TABLE}(job_key, status);
CREATE INDEX IF NOT EXISTS ${TABLE}_lane_claim ON ${TABLE}(status, foreground_lane, run_after);
CREATE TABLE IF NOT EXISTS ${STATS_TABLE} (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ${FAIRNESS_TABLE} (
  id TEXT PRIMARY KEY,
  claim_sequence BIGINT NOT NULL DEFAULT 0,
  last_backlog_repo TEXT
);`;

export interface PgDurableQueue {
  binding: Queue;
  init(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  size(): Promise<number>;
  deadCount(): Promise<number>;
  /** Jobs currently claimed and mid-flight (status='processing') -- distinct from size(), which also
   *  includes still-pending work. See #selfhost-queue-liveness's own observability additions. */
  processingCount(): Promise<number>;
  stats(): Promise<Record<string, number>>;
  snapshot(): Promise<SelfHostQueueSnapshot>;
  /** Live-vs-maintenance queue pressure, for the /metrics gauges (see server.ts) -- the SAME signals the
   *  maintenance-admission policy itself consults at claim time. */
  pressureSignals(): Promise<MaintenancePressureSignals>;
  /** Requeues dead-lettered jobs still under the auto-retry attempts ceiling. Called on a timer while
   *  running (see start()), and exposed directly so tests and an operator-triggered repair path don't have
   *  to wait for the real interval. Returns the number of jobs revived. */
  reviveDeadLetterJobs(): Promise<number>;
  /** Foreground-liveness invariant (#selfhost-queue-liveness): pulls back any FOREGROUND-priority pending job
   *  whose deferral has gone stale (see foreground-liveness.ts) regardless of what deferred it. Called once at
   *  boot and on a timer while running (see init()/start()), and exposed directly so tests and an
   *  operator-triggered repair path don't have to wait for the real interval. Returns the number released. */
  releaseStaleForegroundDeferrals(): Promise<number>;
  /** Top-N repos by backlog-convergence pending depth, for the observability dashboard's per-repo backlog panel
   *  (#selfhost-lane-observability). */
  topBacklogRepos(limit: number): Promise<BacklogRepoCount[]>;
}

interface JobRow {
  id: string;
  payload: string;
  attempts: number;
  job_key?: string | null;
  priority: number | string;
  created_at: number | string;
  backgroundSlotReserved?: boolean;
}

export interface PgQueueOptions {
  maxRetries?: number;
  pollIntervalMs?: number;
  backoffMs?: (attempt: number) => number;
  /** Max concurrent `processOne()` loops. Defaults to QUEUE_CONCURRENCY env var or 4 — review jobs are I/O-bound
   *  (GitHub + AI awaits dominate), so overlapping a handful drains a PR burst far faster; FOR UPDATE SKIP LOCKED
   *  keeps claims race-free across the pool (and across replicas). Set QUEUE_CONCURRENCY=1 to force strict serial. */
  concurrency?: number;
  /** Max background jobs (priority < 8) allowed to consume concurrent slots. Defaults to QUEUE_BACKGROUND_CONCURRENCY or 1. */
  backgroundConcurrency?: number;
}

export function createPgQueue(
  pool: Pool,
  consume: (message: JobMessage) => Promise<void>,
  opts: PgQueueOptions = {},
): PgDurableQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const backoff =
    opts.backoffMs ??
    ((attempt: number) => Math.min(60_000, 1000 * 2 ** attempt));
  const concurrency =
    opts.concurrency ??
    parsePositiveIntEnv("QUEUE_CONCURRENCY", { min: 1, fallback: 4 });
  const backgroundConcurrency = queueBackgroundConcurrency(
    concurrency,
    opts.backgroundConcurrency,
  );
  const processingTimeoutMs = queueProcessingTimeoutMs();

  let running = false;
  let active = 0;
  let activeBackground = 0;
  const activeJobIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadLetterReviveTimer: ReturnType<typeof setInterval> | null = null;
  let foregroundLivenessTimer: ReturnType<typeof setInterval> | null = null;
  const maintenanceAdmissionConfig: MaintenanceAdmissionConfig = resolveMaintenanceAdmissionConfig();
  const foregroundLivenessConfig: ForegroundLivenessConfig = resolveForegroundLivenessConfig();

  async function init(): Promise<void> {
    await pool.query(DDL);
    await pool.query(
      `INSERT INTO ${FAIRNESS_TABLE} (id, claim_sequence) VALUES ('singleton', 0) ON CONFLICT (id) DO NOTHING`,
    );
    const priorityBackfilled = await backfillJobPriorities();
    if (priorityBackfilled)
      console.log(
        JSON.stringify({
          event: "selfhost_queue_priority_backfilled",
          count: priorityBackfilled,
        }),
      );
    const keyBackfilled = await backfillJobKeys();
    if (keyBackfilled)
      console.log(
        JSON.stringify({
          event: "selfhost_queue_job_keys_backfilled",
          count: keyBackfilled,
        }),
      );
    const maintenanceFlagsBackfilled = await backfillJobMaintenanceFlags();
    if (maintenanceFlagsBackfilled)
      console.log(
        JSON.stringify({
          event: "selfhost_queue_maintenance_flags_backfilled",
          count: maintenanceFlagsBackfilled,
        }),
      );
    const lanesBackfilled = await backfillJobForegroundLanes();
    if (lanesBackfilled)
      console.log(
        JSON.stringify({
          event: "selfhost_queue_foreground_lanes_backfilled",
          count: lanesBackfilled,
        }),
      );
    const recovered = await recoverProcessingJobs();
    if (recovered) {
      await recordQueueMetric("gittensory_jobs_recovered_total", recovered);
      console.log(
        JSON.stringify({ event: "selfhost_queue_recovered", count: recovered }),
      );
    }
    const spread = await spreadDueJobsOnStartup();
    if (spread)
      console.log(
        JSON.stringify({
          event: "selfhost_queue_startup_spread",
          count: spread,
          jitter_ms: queueStartupJitterMs(),
        }),
      );
    // Self-heal on boot (#selfhost-queue-liveness): a deploy/restart inherits whatever run_after values were
    // already written before it, so a foreground lane over-deferred before the restart must not require manual
    // intervention to unstick -- releaseStaleForegroundDeferrals logs + records its own metric when it finds work.
    await releaseStaleForegroundDeferrals();
  }

  async function backfillJobPriorities(): Promise<number> {
    const res = await pool.query(
      `SELECT id, payload, priority FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    );
    let changed = 0;
    for (const row of res.rows as Array<{ id: string; payload: string; priority: number | string }>) {
      const priority = jobPriority(row.payload);
      if (priority === Number(row.priority ?? 0)) continue;
      await pool.query(`UPDATE ${TABLE} SET priority=$1 WHERE id=$2`, [
        priority,
        row.id,
      ]);
      changed += 1;
    }
    return changed;
  }

  async function backfillJobKeys(): Promise<number> {
    const res = await pool.query(
      `SELECT id, payload, job_key FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    );
    let changed = 0;
    for (const row of res.rows as Array<{ id: string; payload: string; job_key?: string | null }>) {
      const key = jobCoalesceKey(row.payload);
      if ((row.job_key ?? null) === key) continue;
      await pool.query(`UPDATE ${TABLE} SET job_key=$1 WHERE id=$2`, [
        key,
        row.id,
      ]);
      changed += 1;
    }
    return changed;
  }

  async function backfillJobMaintenanceFlags(): Promise<number> {
    const res = await pool.query(
      `SELECT id, payload, is_maintenance FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    );
    let changed = 0;
    for (const row of res.rows as Array<{ id: string; payload: string; is_maintenance: number | string }>) {
      const isMaintenance = isMaintenanceJobType(extractPayloadType(row.payload) ?? "") ? 1 : 0;
      if (Number(row.is_maintenance ?? 0) === isMaintenance) continue;
      await pool.query(`UPDATE ${TABLE} SET is_maintenance=$1 WHERE id=$2`, [isMaintenance, row.id]);
      changed += 1;
    }
    return changed;
  }

  async function backfillJobForegroundLanes(): Promise<number> {
    const res = await pool.query(
      `SELECT id, payload, foreground_lane FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    );
    let changed = 0;
    for (const row of res.rows as Array<{ id: string; payload: string; foreground_lane: string | null }>) {
      const type = extractPayloadType(row.payload) ?? "";
      const lane = foregroundLaneForJob(type, row.payload);
      if ((row.foreground_lane ?? null) === lane) continue;
      await pool.query(`UPDATE ${TABLE} SET foreground_lane=$1 WHERE id=$2`, [lane, row.id]);
      changed += 1;
    }
    return changed;
  }

  /** Cheap aggregate reads behind the maintenance-admission policy (and the observability gauges in
   *  server.ts): how much LIVE (foreground) work is queued and how old the oldest of it is -- both overall
   *  (pending+processing) and RUNNABLE right now (pending, due) -- and the same PENDING/oldest pair for the
   *  MAINTENANCE lane specifically (not "all background" -- targeted jobs like backfill-repo-segment don't
   *  count, see maintenance-admission.ts). The runnable-now split is the #selfhost-queue-liveness diagnostic:
   *  distinguishes "queue large but intentionally deferred" from "queue stuck, nothing runnable" without
   *  manual SQL. Host load is an independent, optional signal. */
  async function maintenancePressureSignals(now: number): Promise<MaintenancePressureSignals> {
    const liveRes = await pool.query(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest,
              COUNT(*) FILTER (WHERE status='pending' AND run_after<=$2) AS runnable_cnt,
              MIN(created_at) FILTER (WHERE status='pending' AND run_after<=$2) AS oldest_runnable
         FROM ${TABLE} WHERE status IN ('pending','processing') AND priority>=$1`,
      [FOREGROUND_QUEUE_PRIORITY_FLOOR, now],
    );
    const maintenanceRes = await pool.query(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest FROM ${TABLE} WHERE status IN ('pending','processing') AND is_maintenance=1`,
    );
    const backlogConvergenceRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE status IN ('pending','processing') AND foreground_lane='backlog'`,
    );
    const freshIntakeRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ${TABLE} WHERE status IN ('pending','processing') AND foreground_lane='fresh'`,
    );
    const live = liveRes.rows[0] as {
      cnt: string | number;
      oldest: string | number | null;
      runnable_cnt: string | number;
      oldest_runnable: string | number | null;
    };
    const maintenance = maintenanceRes.rows[0] as { cnt: string | number; oldest: string | number | null };
    const backlogConvergence = backlogConvergenceRes.rows[0] as { cnt: string | number };
    const freshIntake = freshIntakeRes.rows[0] as { cnt: string | number };
    return {
      livePendingCount: Number(live.cnt),
      oldestLivePendingAgeMs: live.oldest != null ? now - Number(live.oldest) : null,
      liveRunnableNowCount: Number(live.runnable_cnt),
      oldestLiveRunnableAgeMs: live.oldest_runnable != null ? now - Number(live.oldest_runnable) : null,
      maintenancePendingCount: Number(maintenance.cnt),
      oldestMaintenancePendingAgeMs: maintenance.oldest != null ? now - Number(maintenance.oldest) : null,
      backlogConvergencePendingCount: Number(backlogConvergence.cnt),
      freshIntakePendingCount: Number(freshIntake.cnt),
      hostLoadAvg1PerCore: hostLoadAvg1PerCore(),
    };
  }

  /** Top-N repos by backlog-convergence pending DEPTH, for the observability dashboard's per-repo backlog panel
   *  (#selfhost-lane-observability) -- a snapshot read, distinct from claimNextForegroundLane's own backlog
   *  query (which is scoped to run_after<=now and only reads job_key+created_at for the round-robin picker).
   *  This one counts EVERY pending+processing backlog-lane row regardless of run_after, matching the "how deep
   *  is each repo's backlog right now" framing of a dashboard panel rather than a claim-time eligibility set. */
  async function topBacklogRepos(limit: number): Promise<BacklogRepoCount[]> {
    const res = await pool.query(
      `SELECT job_key FROM ${TABLE} WHERE status IN ('pending','processing') AND foreground_lane='backlog'`,
    );
    return topBacklogRepoCounts(
      (res.rows as Array<{ job_key: string | null }>).map((row) => ({ jobKey: row.job_key })),
      limit,
    );
  }

  async function recoverProcessingJobs(): Promise<number> {
    const res = await pool.query(
      `SELECT id, payload, job_key FROM ${TABLE} WHERE status='processing'`,
    );
    let changed = 0;
    const now = Date.now();
    const maxJitter = queueRecoveryJitterMs();
    for (const row of res.rows as Array<{ id: string; payload: string; job_key?: string | null }>) {
      const runAfter = now + deterministicJitterMs(`${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
      await pool.query(`UPDATE ${TABLE} SET status='pending', run_after=$1 WHERE id=$2`, [
        runAfter,
        row.id,
      ]);
      changed += 1;
    }
    return changed;
  }

  // Dead-letter auto-retry (#audit-rate-headroom): a job dies once `attempts >= maxRetries` (see the
  // max-retries branch in processOne below). Reviving it here only clears `status`/`run_after`/`last_error`
  // -- `attempts` is left untouched, so it already satisfies `attempts >= maxRetries` and will die again
  // after exactly ONE more failed attempt, not a fresh full retry budget. The `attempts < ceiling` filter
  // (ceiling = maxRetries + the configured extra-attempts budget) is what actually bounds how many times a
  // permanently-broken job can be revived before it stops being a candidate here and requires manual
  // intervention.
  async function reviveEligibleDeadJobs(): Promise<number> {
    const ceiling = maxRetries + queueDeadLetterAutoRetryMaxExtraAttempts();
    const res = await pool.query(
      `SELECT id, payload, job_key FROM ${TABLE} WHERE status='dead' AND attempts<$1`,
      [ceiling],
    );
    let revived = 0;
    const now = Date.now();
    const maxJitter = queueRecoveryJitterMs();
    for (const row of res.rows as Array<{ id: string; payload: string; job_key?: string | null }>) {
      const runAfter = now + deterministicJitterMs(`revive:${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
      // AND status='dead' re-checks the row is STILL dead at UPDATE time (mirrors reclaimExpiredProcessingJobs /
      // deferPendingJobsForRateLimit above) — the SELECT above is a stale snapshot, and without this predicate an
      // overlapping reviver (another self-host instance, or a slow prior revive tick still running when the next
      // one fires) could flip a row that's already been claimed into 'processing' back to 'pending', letting it
      // run a second time concurrently. rowCount is 0 (not counted as revived) when another reviver won the race.
      const update = await pool.query(
        `UPDATE ${TABLE} SET status='pending', run_after=$1, last_error=NULL WHERE id=$2 AND status='dead'`,
        [runAfter, row.id],
      );
      revived += update.rowCount ?? 0;
    }
    return revived;
  }

  async function reviveDeadLetterJobs(): Promise<number> {
    const revived = await reviveEligibleDeadJobs();
    if (revived) {
      await recordQueueMetric("gittensory_jobs_dead_letter_revived_total", revived);
      console.log(JSON.stringify({ event: "selfhost_queue_dead_letter_revived", count: revived }));
      kickAll();
    }
    return revived;
  }

  /** Wraps reviveDeadLetterJobs() for the setInterval callback below, which has no rejection handler of its
   *  own -- a transient pool/driver/metric failure here would otherwise surface as an unhandled promise
   *  rejection and can terminate the process (fatal when SENTRY_DSN is unset, since server.ts only installs
   *  the handler when Sentry is configured), exactly the failure mode pump()'s own try/catch above guards
   *  against for the main poll loop. A failed revive tick just waits for the next interval, same as a failed
   *  poll tick waits for the next poll. */
  async function reviveDeadLetterJobsSafely(): Promise<void> {
    try {
      await reviveDeadLetterJobs();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_queue_dead_letter_revive_crashed",
          error: errorMessageWithCause(error),
        }),
      );
      captureError(error, { kind: "queue_dead_letter_revive_crashed" });
    }
  }

  /** #selfhost-queue-liveness: re-evaluate rate-limit admission for an already-deferred foreground candidate
   *  against CURRENT observations, independent of how long ago it was deferred. Returns true when it would be
   *  admitted right now (no longer blocked); false when still blocked OR the payload is unparseable (best-
   *  effort -- an unparseable payload is left for the normal dead-letter path, never force-released here). */
  async function isRateLimitAdmissionNowClear(payload: string): Promise<boolean> {
    let message: JobMessage;
    try {
      message = JSON.parse(payload) as JobMessage;
    } catch {
      return false;
    }
    return (await rateLimitAdmissionDelayMs(message)) === null;
  }

  /** See foreground-liveness.ts for the full rationale. A bounded candidate SELECT (foreground-priority, pending,
   *  not currently due), an eligibility pass, a ramp-up CAP, then a per-row conditional UPDATE only for the
   *  capped subset -- mirroring reviveEligibleDeadJobs' shape but with the extra ramp-up step. Each candidate is
   *  ELIGIBLE on EITHER of two independent conditions: it has genuinely been waiting past the age-based trickle
   *  ceiling (isForegroundDeferralStale, unconditional backstop), OR -- CONDITION-BASED recovery
   *  (#selfhost-queue-liveness VPS incident) -- re-evaluating rateLimitAdmissionDelayMs against CURRENT
   *  observations right now says it would be admitted immediately. The age floor alone can leave a job pinned to
   *  a stale reset timestamp for up to its full original delay (observed up to ~15m) even when a fresher,
   *  healthier observation arrived moments after it was deferred; the condition check recovers it on the NEXT
   *  sweep tick instead (bounded by FOREGROUND_LIVENESS_CHECK_INTERVAL_MS, default 60s) whenever the underlying
   *  rate-limit pressure has actually cleared, regardless of job age. When more jobs are eligible than
   *  maxReleasePerSweep allows, selectForegroundDeferralsToRelease picks the oldest first -- a large inherited
   *  backlog drains gradually over several sweep ticks instead of flooding GitHub with every re-attempt at once.
   *  Logs + records a metric ONCE per sweep (aggregate count), not per row, so a large release batch cannot spam
   *  the log. */
  async function releaseStaleForegroundDeferrals(): Promise<number> {
    if (!foregroundLivenessConfig.enabled) return 0;
    const now = Date.now();
    const res = await pool.query(
      `SELECT id, payload, created_at FROM ${TABLE} WHERE status='pending' AND priority>=$1 AND run_after>$2`,
      [FOREGROUND_QUEUE_PRIORITY_FLOOR, now],
    );
    const eligible: Array<{ id: string; pendingSinceMs: number; ageStale: boolean }> = [];
    for (const row of res.rows as Array<{ id: string; payload: string; created_at: number | string }>) {
      const pendingSinceMs = Number(row.created_at);
      const ageStale = isForegroundDeferralStale(foregroundLivenessConfig, pendingSinceMs, now);
      if (!ageStale && !(await isRateLimitAdmissionNowClear(row.payload))) continue;
      eligible.push({ id: row.id, pendingSinceMs, ageStale });
    }
    const toRelease = selectForegroundDeferralsToRelease(eligible, foregroundLivenessConfig.maxReleasePerSweep);
    let released = 0;
    let releasedByAge = 0;
    let releasedByRateLimitClear = 0;
    for (const candidate of toRelease) {
      const update = await pool.query(
        `UPDATE ${TABLE} SET run_after=$1 WHERE id=$2 AND status='pending' AND run_after>$1`,
        [now, candidate.id],
      );
      const rowsChanged = update.rowCount ?? 0;
      released += rowsChanged;
      if (candidate.ageStale) releasedByAge += rowsChanged;
      else releasedByRateLimitClear += rowsChanged;
    }
    if (released) {
      await recordQueueMetric("gittensory_jobs_foreground_liveness_released_total", released);
      if (releasedByAge) incr("gittensory_jobs_foreground_liveness_released_by_reason_total", { reason: "age" }, releasedByAge);
      if (releasedByRateLimitClear) incr("gittensory_jobs_foreground_liveness_released_by_reason_total", { reason: "rate_limit_cleared" }, releasedByRateLimitClear);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "selfhost_queue_foreground_liveness_released",
          count: released,
          released_by_age: releasedByAge,
          released_by_rate_limit_cleared: releasedByRateLimitClear,
          max_defer_ms: foregroundLivenessConfig.maxDeferMs,
        }),
      );
      kickAll();
    }
    return released;
  }

  /** Wraps releaseStaleForegroundDeferrals() for the setInterval callback below, mirroring
   *  reviveDeadLetterJobsSafely's own rationale: an uncaught rejection here would surface as an unhandled
   *  promise rejection and can terminate the process when SENTRY_DSN is unset. A failed sweep just waits for
   *  the next interval, same as a failed poll tick waits for the next poll. */
  async function releaseStaleForegroundDeferralsSafely(): Promise<void> {
    try {
      await releaseStaleForegroundDeferrals();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_queue_foreground_liveness_release_crashed",
          error: errorMessageWithCause(error),
        }),
      );
      captureError(error, { kind: "queue_foreground_liveness_release_crashed" });
    }
  }

  async function spreadDueJobsOnStartup(): Promise<number> {
    const now = Date.now();
    const res = await pool.query(
      `SELECT id, payload, job_key FROM ${TABLE} WHERE status='pending' AND run_after<=$1`,
      [now],
    );
    const due = res.rows as Array<{ id: string; payload: string; job_key?: string | null }>;
    if (due.length < queueStartupJitterMinJobs()) return 0;
    const maxJitter = queueStartupJitterMs();
    if (maxJitter <= 0) return 0;
    for (const row of due) {
      const runAfter = now + deterministicJitterMs(`${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
      await pool.query(`UPDATE ${TABLE} SET run_after=$1 WHERE id=$2`, [
        runAfter,
        row.id,
      ]);
    }
    return due.length;
  }

  async function enqueue(
    message: JobMessage,
    delaySeconds: number,
  ): Promise<void> {
    const now = Date.now();
    const payload = JSON.stringify(message);
    const priority = jobPriority(payload);
    const key = jobCoalesceKey(payload);
    const lane = foregroundLaneForJob(message.type, payload);
    const runAfter = now + delaySeconds * 1000;
    const absorbedByKey = jobCoalesceAbsorbedByKey(payload);
    if (absorbedByKey) {
      const existingFull = (
        await pool.query(
          `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=$1 ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
          [absorbedByKey],
        )
      ).rows[0] as { id: string } | undefined;
      if (existingFull) {
        await recordQueueMetric("gittensory_jobs_coalesced_total");
        kickOne();
        return;
      }
    }
    // Merge two INCREMENTAL rag-index-repo jobs for the same repo (#selfhost-maintenance-self-pin) into one
    // pending row's UNION path set instead of piling up as separate maintenance-lane rows -- mirrors
    // sqlite-queue.ts exactly. `absorbedByKey` shares mergeKeyPrefix's exact guard so it's provably non-null
    // here (asserted, not defaulted); excluding it is defense-in-depth against a job_key collision, not
    // load-bearing, though under Postgres's multi-instance concurrency it's a real (if narrow) race guard.
    const mergeKeyPrefix = jobCoalesceMergeKeyPrefix(payload);
    if (mergeKeyPrefix) {
      const mergeCandidate = (
        await pool.query(
          `SELECT id, payload, job_key FROM ${TABLE}
           WHERE status='pending' AND job_key IS NOT NULL AND left(job_key, $1)=$2 AND job_key<>$3
           ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
          [mergeKeyPrefix.length, mergeKeyPrefix, absorbedByKey as string],
        )
      ).rows[0] as { id: string; payload: string; job_key: string } | undefined;
      if (mergeCandidate) {
        const mergedPayload = jobCoalesceMergedPayload(mergeCandidate.payload, payload);
        if (mergedPayload) {
          const mergedKey = jobCoalesceKey(mergedPayload);
          // Guarded by status='pending' AND job_key=<the exact row this SELECT saw> so a concurrent claim or a
          // second instance's own merge into this same row between the SELECT and here loses cleanly (rowCount
          // 0) instead of silently overwriting whatever the winner just wrote -- multiple self-host instances
          // can race this exact SELECT-then-UPDATE (gate finding). Falling through (not returning) on a lost
          // race lets the normal supersede/coalesce/insert path below handle this job instead.
          const merged = await pool.query(
            `UPDATE ${TABLE}
               SET payload=$1, run_after=GREATEST(run_after, $2), created_at=$3, priority=GREATEST(priority, $4), job_key=$5, last_error=NULL
             WHERE id=$6 AND status='pending' AND job_key=$7`,
            [mergedPayload, runAfter, now, priority, mergedKey, mergeCandidate.id, mergeCandidate.job_key],
          );
          if (merged.rowCount) {
            await recordQueueMetric("gittensory_jobs_coalesced_total");
            kickOne();
            return;
          }
        }
      }
    }
    const supersededKeyPrefix = jobCoalesceSupersededKeyPrefix(payload);
    if (key && supersededKeyPrefix) {
      const existing = (
        await pool.query(
          `SELECT id FROM ${TABLE}
           WHERE status='pending' AND job_key IS NOT NULL AND left(job_key, $1)=$2
           ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
          [supersededKeyPrefix.length, supersededKeyPrefix],
        )
      ).rows[0] as { id: string } | undefined;
      if (existing) {
        // created_at is deliberately NOT overwritten here (#selfhost-runtime-drift): it anchors the maintenance
        // trickle's age clock (see maintenance-admission.ts). A periodic scheduler re-enqueuing the SAME still-
        // pending maintenance need must coalesce into the existing row without resetting how long that need has
        // genuinely been outstanding -- otherwise a re-enqueue cadence shorter than the trickle's maxDeferAgeMs
        // (4h default) can keep re-arming the clock forever, and sustained pressure defers the job indefinitely.
        await pool.query(
          `UPDATE ${TABLE}
             SET payload=$1, run_after=GREATEST(run_after, $2), priority=GREATEST(priority, $3), job_key=$4, foreground_lane=$5, last_error=NULL
           WHERE id=$6`,
          [payload, runAfter, priority, key, lane, existing.id],
        );
        await pool.query(
          `DELETE FROM ${TABLE}
           WHERE status='pending' AND id<>$1 AND job_key IS NOT NULL AND left(job_key, $2)=$3`,
          [existing.id, supersededKeyPrefix.length, supersededKeyPrefix],
        );
        await recordQueueMetric("gittensory_jobs_coalesced_total");
        kickOne();
        return;
      }
    }
    if (key) {
      const existing = (
        await pool.query(
          `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=$1 ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
          [key],
        )
      ).rows[0] as { id: string } | undefined;
      if (existing) {
        // See the supersededKeyPrefix branch above: created_at is preserved across a coalesced re-enqueue so the
        // maintenance trickle clock reflects genuine wait time, not the most recent re-request.
        await pool.query(
          `UPDATE ${TABLE}
             SET payload=$1, run_after=GREATEST(run_after, $2), priority=GREATEST(priority, $3), foreground_lane=$4, last_error=NULL
           WHERE id=$5`,
          [payload, runAfter, priority, lane, existing.id],
        );
        await recordQueueMetric("gittensory_jobs_coalesced_total");
        kickOne();
        return;
      }
    }
    await pool.query(
      `INSERT INTO ${TABLE} (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance, foreground_lane) VALUES ($1,'pending',0,$2,$3,$4,$5,$6,$7)`,
      [payload, runAfter, now, priority, key, isMaintenanceJobType(message.type) ? 1 : 0, lane],
    );
    await recordQueueMetric("gittensory_jobs_enqueued_total");
    kickOne();
  }

  async function claimNext(): Promise<JobRow | null> {
    const now = Date.now();
    const foreground = (await claimNextForegroundLane(now)) ?? (await claimNextWhere(now, "priority >= $2"));
    if (foreground) return foreground;
    if (activeBackground >= backgroundConcurrency) return null;
    activeBackground++;
    let background: JobRow | null;
    try {
      background = await claimNextWhere(now, "priority < $2");
    } catch (error) {
      // Release the reserved background slot if the claim query itself throws (a dropped connection / lock
      // timeout — the exact raw pool failures pump() below is documented to catch). claimNext() runs OUTSIDE
      // processOne's try/finally, so without this rollback the reserved slot leaks permanently; since
      // backgroundConcurrency defaults to 1, a single such error would starve the entire background/maintenance
      // lane with no recovery short of a restart. (#selfhost-bg-slot-leak)
      activeBackground--;
      throw error;
    }
    if (!background) {
      activeBackground--;
      return null;
    }
    return { ...background, backgroundSlotReserved: true };
  }

  /** Claim-time backlog-vs-fresh-intake fairness (#selfhost-backlog-convergence, see queue-fairness.ts). Tries
   *  ONE lane-scoped claim before falling back to the plain unscoped foreground claim (claimNext() falls back to
   *  claimNextWhere(now, "priority >= $2") when this returns null) -- a null here just means "no work to prefer
   *  this cycle," never "no foreground work at all." The fairness singleton's claim_sequence always advances
   *  (best-effort, hit or miss) so the ratio cycle keeps progressing even through empty cycles. Sequence
   *  allocation is a single atomic UPDATE ... RETURNING (not a separate SELECT-then-UPDATE): this backend is
   *  the multi-instance one (multiple app instances can share one Postgres, see the file header), so two
   *  concurrent callers reading the same pre-increment value would both compute the SAME lane and defeat the
   *  bounded-ratio guarantee -- the row's own lock serializes concurrent allocations instead. */
  async function claimNextForegroundLane(now: number): Promise<JobRow | null> {
    const fairnessRes = await pool.query(
      `UPDATE ${FAIRNESS_TABLE} SET claim_sequence=claim_sequence+1 WHERE id='singleton' RETURNING claim_sequence, last_backlog_repo`,
    );
    const fairness = fairnessRes.rows[0] as { claim_sequence: number | string; last_backlog_repo: string | null } | undefined;
    const sequence = fairness ? Number(fairness.claim_sequence) : 0;
    const lane: ForegroundLane = nextForegroundLane(sequence);
    if (lane === "fresh") {
      const freshRow = await claimNextWhere(now, "priority >= $2", { sql: "foreground_lane='fresh'", params: [] });
      if (freshRow) incr("gittensory_jobs_claimed_by_lane_total", { lane: "fresh" });
      return freshRow;
    }
    const backlogRes = await pool.query(
      `SELECT job_key, created_at FROM ${TABLE} WHERE status='pending' AND run_after<=$1 AND foreground_lane='backlog'`,
      [now],
    );
    const candidates = backlogRepoCandidatesFromJobKeys(
      (backlogRes.rows as Array<{ job_key: string | null; created_at: number | string }>).map((row) => ({
        jobKey: row.job_key,
        createdAtMs: Number(row.created_at),
      })),
      now,
    );
    const repo = pickBacklogRepo(candidates, fairness?.last_backlog_repo ?? null);
    if (!repo) return null;
    const row = await claimNextWhere(now, "priority >= $2", {
      sql: "foreground_lane='backlog' AND job_key LIKE $3",
      params: [`agent-regate-pr:${repo}#%`],
    });
    if (row) {
      await pool.query(`UPDATE ${FAIRNESS_TABLE} SET last_backlog_repo=$1 WHERE id='singleton'`, [repo]);
      incr("gittensory_jobs_claimed_by_lane_total", { lane: "backlog" });
    }
    return row;
  }

  async function claimNextWhere(
    now: number,
    priorityPredicate: string,
    extra?: { sql: string; params: readonly unknown[] },
  ): Promise<JobRow | null> {
    const extraSql = extra ? ` AND ${extra.sql}` : "";
    // Atomic, multi-instance-safe: lock + claim one due job, skipping rows another instance already locked.
    const res = await pool.query(
      `UPDATE ${TABLE} SET status='processing', run_after=$1
       WHERE id = (
         SELECT id
           FROM ${TABLE}
          WHERE status='pending' AND run_after<=$1 AND ${priorityPredicate}${extraSql}
          ORDER BY priority DESC, run_after, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING id, payload, attempts, job_key, priority, created_at`,
      [now, FOREGROUND_QUEUE_PRIORITY_FLOOR, ...(extra?.params ?? [])],
    );
    return (res.rows[0] as JobRow | undefined) ?? null;
  }

  async function processOne(): Promise<boolean> {
    const recovered = await reclaimExpiredProcessingJobs();
    if (recovered) {
      await recordQueueMetric("gittensory_jobs_recovered_total", recovered);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "selfhost_queue_processing_reclaimed",
          count: recovered,
          timeout_ms: processingTimeoutMs,
        }),
      );
      captureError(new Error("self-host queue processing lease expired"), {
        kind: "job_recovered",
        reason: "processing_timeout",
        recovered,
        timeoutMs: processingTimeoutMs,
      });
    }
    const job = await claimNext();
    if (!job) return false;
    activeJobIds.add(job.id);
    const claimedAt = Date.now();
    try {
      let message: JobMessage;
      try {
        message = JSON.parse(job.payload) as JobMessage;
      } catch {
        await pool.query(
          `UPDATE ${TABLE} SET status='dead', last_error='unparseable payload' WHERE id=$1`,
          [job.id],
        );
        await recordQueueMetric("gittensory_jobs_dead_total");
        logAudit({
          event: "job_dead",
          ts: Date.now(),
          job_id: job.id,
          latency_ms: Date.now() - claimedAt,
          attempts: Number(job.attempts) + 1,
          error: "unparseable payload",
        });
        captureError(new Error("unparseable queue payload"), {
          kind: "job_dead",
          reason: "unparseable_payload",
          jobId: job.id,
        });
        return true;
      }
      const jobTraceParent = message.type === "github-webhook" ? message.traceParent : undefined;
      const payloadContext = extractPayloadContext(job.payload);
      const rateLimitAdmission = await rateLimitAdmissionDelayMs(message);
      if (rateLimitAdmission !== null) {
        const rateLimitMetric = githubRateLimitMetricContext(message, rateLimitAdmission);
        await withReviewSpan(
          "selfhost.queue.admission_deferred",
          {
            "job.type": message.type,
            "queue.backend": "postgres",
            ...rateLimitMetric.spanAttributes,
          },
          async () => {
            const now = Date.now();
            const retryAfter = now + rateLimitRetryDelayWithJitter(
              rateLimitAdmission.delayMs,
              `${job.job_key ?? ""}:${job.id}:${job.payload}`,
            );
            const lastError = `github rate-limit ${rateLimitAdmission.kind} admission`;
            const update = await retryPoolUpdateOrLeaveForReclaim(
              () =>
                pool.query(
                  `UPDATE ${TABLE} SET status='pending', run_after=GREATEST(run_after, $1), last_error=COALESCE(last_error, $2) WHERE id=$3`,
                  [retryAfter, lastError, job.id],
                ),
              job.id,
              "selfhost_queue_pg_connection_lost_on_rate_limit_defer",
            );
            if (update?.rowCount) {
              await recordQueueMetric("gittensory_jobs_rate_limit_deferred_total");
              incr("gittensory_jobs_rate_limit_admission_deferred_total", rateLimitMetric.labels);
              console.warn(
                JSON.stringify({
                  level: "warn",
                  event: `selfhost_queue_${rateLimitAdmission.kind}_admission_deferred`,
                  ...rateLimitMetric.logFields,
                  retry_after_ms: Math.max(0, retryAfter - now),
                }),
              );
            }
          },
          { parentTraceParent: jobTraceParent },
        );
        return true;
      }
      if (!isForegroundJobPriority(Number(job.priority)) && isMaintenanceJobType(message.type)) {
        const decision = evaluateMaintenanceAdmission(
          await maintenancePressureSignals(Date.now()),
          maintenanceAdmissionConfig,
          Number(job.created_at),
          Date.now(),
        );
        if (!decision.admit) {
          await withReviewSpan(
            "selfhost.queue.maintenance_admission_deferred",
            { "job.type": message.type, "queue.backend": "postgres", "maintenance_admission.reason": decision.reason },
            async () => {
              const now = Date.now();
              const retryAfter = now + maintenanceAdmissionDeferMs(
                maintenanceAdmissionConfig,
                `${job.job_key ?? ""}:${job.id}:${job.payload}`,
              );
              const update = await retryPoolUpdateOrLeaveForReclaim(
                () =>
                  pool.query(
                    `UPDATE ${TABLE} SET status='pending', run_after=GREATEST(run_after, $1), last_error=COALESCE(last_error, $2) WHERE id=$3`,
                    [retryAfter, `maintenance admission deferred: ${decision.reason}`, job.id],
                  ),
                job.id,
                "selfhost_queue_pg_connection_lost_on_maintenance_defer",
              );
              if (update?.rowCount) {
                await recordQueueMetric("gittensory_jobs_maintenance_admission_deferred_total");
                incr("gittensory_jobs_maintenance_admission_deferred_by_reason_total", {
                  reason: decision.reason,
                  job_type: message.type,
                });
                console.warn(
                  JSON.stringify({
                    level: "warn",
                    event: "selfhost_queue_maintenance_admission_deferred",
                    jobType: message.type,
                    reason: decision.reason,
                    retry_after_ms: Math.max(0, retryAfter - now),
                  }),
                );
              }
            },
            { parentTraceParent: jobTraceParent },
          );
          return true;
        }
        // Force-admitted despite pressure (#selfhost-runtime-drift): a distinct signal from a normal clear-
        // pressure admission -- it means the box has been under SUSTAINED load for the job's entire
        // maxDeferAgeMs wait, not just a brief blip. A dashboard trending this alongside the deferred-by-reason
        // counters distinguishes "load-shed maintenance is working as designed" from "maintenance is chronically
        // starved and only ever runs via the trickle floor" (the "truly stuck" signal operators need).
        if (decision.reason === "trickle_max_defer_age") {
          await recordQueueMetric("gittensory_jobs_maintenance_trickle_admitted_total");
          incr("gittensory_jobs_maintenance_trickle_admitted_by_type_total", { job_type: message.type });
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "selfhost_queue_maintenance_trickle_admitted",
              jobType: message.type,
              pending_ms: Date.now() - Number(job.created_at),
            }),
          );
        }
        // Broader force-admitted-under-pressure signal (#selfhost-maintenance-self-pin): covers trickle_max_defer_age
        // above PLUS maintenance_pending_high_drain (the new scoped drain escape this PR adds) under one counter,
        // so an operator can trend "how often does pressure admission get overridden at all" without needing to
        // sum multiple per-reason metrics.
        if (isMaintenanceAdmissionGrantedUnderPressure(decision.reason)) {
          incr("gittensory_jobs_maintenance_admission_granted_under_pressure_total", {
            reason: decision.reason,
            job_type: message.type,
          });
        }
      }
      try {
        await withReviewSpan(
          "selfhost.queue.job",
          { "job.type": message.type, "queue.backend": "postgres", "job.attempt": Number(job.attempts) + 1 },
          () => consume(message),
          { parentTraceParent: message.type === "github-webhook" ? message.traceParent : undefined },
        );
        // Retry on transient connection errors (the pool auto-reconnects). If all retries fail with a
        // connection error, leave the row in 'processing' -- reclaimExpiredProcessingJobs() resets it to
        // 'pending' on the next tick, so the job is retried rather than double-processed or lost.
        try {
          await retryPoolQuery(() => pool.query(`DELETE FROM ${TABLE} WHERE id=$1`, [job.id]));
        } catch (deleteErr) {
          if (isPgConnectionError(deleteErr)) {
            console.warn(
              JSON.stringify({
                level: "warn",
                event: "selfhost_queue_pg_connection_lost_on_delete",
                id: job.id,
                code: (deleteErr as Record<string, unknown>)["code"],
                message: "PG connection terminated after job succeeded; reclaim mechanism will retry",
              }),
            );
            return true;
          }
          throw deleteErr;
        }
        await recordQueueMetric("gittensory_jobs_processed_total");
        logAudit({
          event: "job_complete",
          ts: Date.now(),
          job_id: job.id,
          payload_type: extractPayloadType(job.payload),
          ...payloadContext,
          latency_ms: Date.now() - claimedAt,
          attempts: Number(job.attempts) + 1,
        }, jobTraceParent);
      } catch (error) {
        // If the connection was lost during job processing itself (consume() made its own PG calls), leave
        // the job in 'processing' state for the reclaim mechanism to reset rather than cascading into a
        // secondary error trying to reschedule it over a dead connection. Still warn so operators can
        // correlate with DB restart events. Uses the STRICT (SQLSTATE-only) check here, since consume() can
        // throw generic network codes (ECONNRESET etc.) from its own unrelated calls (e.g. GitHub API) that
        // must still go through normal retry/dead-letter handling, not be silently left unattempted.
        if (isPgSqlStateConnectionError(error)) {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "selfhost_queue_pg_connection_lost",
              id: job.id,
              code: (error as Record<string, unknown>)["code"],
              message: "PG connection terminated during job processing; reclaim mechanism will retry",
            }),
          );
          return true;
        }
        const attempts = Number(job.attempts) + 1;
        const errMsg = errorMessageWithCause(error);
        const rateLimitDelayMs = githubRateLimitRetryDelayMs(error);
        if (rateLimitDelayMs !== null) {
          const now = Date.now();
          const retryAfter = now + rateLimitRetryDelayWithJitter(rateLimitDelayMs, `${job.job_key ?? ""}:${job.id}:${job.payload}`);
          const target = githubRateLimitAdmissionTargetForJob(message);
          const deferred = target ? await deferPendingJobsForRateLimit(rateLimitDelayMs, now, target) : 0;
          const rateLimitMetric = githubRateLimitMetricContext(message, target);
          if (target !== null && deferred > 0) {
            await recordQueueMetric("gittensory_jobs_rate_limit_deferred_total", deferred);
            incr("gittensory_jobs_rate_limit_budget_deferred_total", rateLimitMetric.labels, deferred);
            console.warn(
              JSON.stringify({
                level: "warn",
                event: "selfhost_queue_rate_limit_budget_deferred",
                ...rateLimitMetric.logFields,
                deferred,
              }),
            );
          }
          if (job.job_key && (await mergeRescheduledJobIntoPending(job as JobRow & { job_key: string }, retryAfter, errMsg))) {
            await recordQueueMetric("gittensory_jobs_coalesced_total");
          } else {
            await pool.query(
              `UPDATE ${TABLE} SET status='pending', run_after=$1, last_error=$2 WHERE id=$3`,
              [retryAfter, errMsg, job.id],
            );
          }
          await recordQueueMetric("gittensory_jobs_rate_limited_total");
          incr("gittensory_jobs_rate_limited_by_type_total", rateLimitMetric.labels);
          logAudit({
            event: "job_rate_limited",
            ts: Date.now(),
            job_id: job.id,
            payload_type: extractPayloadType(job.payload),
            ...payloadContext,
            latency_ms: Date.now() - claimedAt,
            attempts,
            retry_after_ms: Math.max(0, retryAfter - Date.now()),
            error: errMsg,
          }, jobTraceParent);
          return true;
        }
        await recordQueueMetric("gittensory_jobs_failed_total");
        if (attempts >= maxRetries) {
          await pool.query(
            `UPDATE ${TABLE} SET status='dead', attempts=$1, last_error=$2 WHERE id=$3`,
            [attempts, errMsg, job.id],
          );
          await recordQueueMetric("gittensory_jobs_dead_total");
          console.error(
            JSON.stringify({
              level: "error",
              event: "selfhost_job_dead",
              id: job.id,
              attempts,
              error: errMsg,
            }),
          );
          logAudit({
            event: "job_dead",
            ts: Date.now(),
            job_id: job.id,
            payload_type: extractPayloadType(job.payload),
            ...payloadContext,
            latency_ms: Date.now() - claimedAt,
            attempts,
            error: errMsg,
          }, jobTraceParent);
          captureError(error, {
            kind: "job_dead",
            reason: "max_retries_exhausted",
            jobType: extractPayloadType(job.payload),
            jobId: job.id,
            attempts,
          });
        } else {
          const retryDelayMs = consumingRetryDelayMs(error, backoff(attempts));
          await pool.query(
            `UPDATE ${TABLE} SET status='pending', attempts=$1, run_after=$2, last_error=$3 WHERE id=$4`,
            [attempts, Date.now() + retryDelayMs, errMsg, job.id],
          );
          logAudit({
            event: "job_error",
            ts: Date.now(),
            job_id: job.id,
            payload_type: extractPayloadType(job.payload),
            ...payloadContext,
            latency_ms: Date.now() - claimedAt,
            attempts,
            error: errMsg,
          }, jobTraceParent);
        }
      }
      return true;
    } finally {
      activeJobIds.delete(job.id);
      if (job.backgroundSlotReserved)
        activeBackground = Math.max(0, activeBackground - 1);
    }
  }

  async function pump(): Promise<void> {
    if (active >= concurrency) return;
    active++;
    try {
      while (await processOne()) {
        /* drain due jobs */
      }
    } catch (error) {
      // claimNext()/reclaimExpiredProcessingJobs() run OUTSIDE processOne's own try/finally, so a raw pool
      // failure (a dropped connection, a lock timeout) lands here. Every `void pump()` call site (kickOne/kickAll)
      // is fire-and-forget, so an uncaught rejection here would surface as an unhandled promise rejection — fatal
      // when SENTRY_DSN is unset (server.ts only installs the handler when Sentry is configured) (#2498).
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_queue_pump_crashed",
          error: errorMessageWithCause(error),
        }),
      );
      captureError(error, { kind: "queue_pump_crashed" });
    } finally {
      active--;
    }
  }

  function kickOne(): void {
    void pump();
  }

  function kickAll(): void {
    while (active < concurrency) void pump();
  }

  const binding = {
    async send(
      message: JobMessage,
      options?: { delaySeconds?: number },
    ): Promise<void> {
      await enqueue(message, options?.delaySeconds ?? 0);
    },
    async sendBatch(
      messages: Iterable<{ body: JobMessage; delaySeconds?: number }>,
    ): Promise<void> {
      for (const m of messages) await enqueue(m.body, m.delaySeconds ?? 0);
    },
    async snapshot() {
      const res = await pool.query(
        `SELECT payload, status, run_after FROM ${TABLE} WHERE status IN ('pending','processing','dead')`,
      );
      return buildSelfHostQueueSnapshot(
        res.rows as Array<{ payload: string; status: string; run_after: string | number }>,
      );
    },
  } as unknown as Queue & { snapshot(): Promise<SelfHostQueueSnapshot> };

  return {
    binding,
    init,
    start() {
      if (running) return;
      running = true;
      const tick = (): void => {
        /* v8 ignore next */ // stop() clears the timer before the next tick can fire with running=false
        if (!running) return;
        kickAll();
        timer = setTimeout(tick, pollIntervalMs);
      };
      tick();
      // Separate, much slower interval than the poll tick above -- reviving a dead job every second would
      // recreate the retry storm this feature exists to bound. The interval itself is the cooldown between
      // auto-retry rounds for any one job.
      deadLetterReviveTimer = setInterval(() => void reviveDeadLetterJobsSafely(), queueDeadLetterReviveIntervalMs());
      // Foreground-liveness sweep (#selfhost-queue-liveness): also a separate, slow interval -- see
      // foreground-liveness.ts for why a per-tick check would busy-loop under sustained rate-limit pressure.
      foregroundLivenessTimer = setInterval(
        () => void releaseStaleForegroundDeferralsSafely(),
        foregroundLivenessConfig.checkIntervalMs,
      );
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      if (deadLetterReviveTimer) clearInterval(deadLetterReviveTimer);
      if (foregroundLivenessTimer) clearInterval(foregroundLivenessTimer);
      while (active > 0) await new Promise((r) => setTimeout(r, 10));
    },
    async drain() {
      while (active > 0) await new Promise((r) => setTimeout(r, 5));
      await pump();
    },
    async size() {
      return Number(
        (
          await pool.query(
            `SELECT COUNT(*) AS c FROM ${TABLE} WHERE status IN ('pending','processing')`,
          )
        ).rows[0].c,
      );
    },
    async deadCount() {
      return Number(
        (
          await pool.query(
            `SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='dead'`,
          )
        ).rows[0].c,
      );
    },
    async processingCount() {
      return Number(
        (
          await pool.query(
            `SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='processing'`,
          )
        ).rows[0].c,
      );
    },
    async stats() {
      return readQueueStats();
    },
    snapshot: binding.snapshot,
    reviveDeadLetterJobs,
    releaseStaleForegroundDeferrals,
    pressureSignals() {
      return maintenancePressureSignals(Date.now());
    },
    topBacklogRepos,
  };

  async function reclaimExpiredProcessingJobs(): Promise<number> {
    if (processingTimeoutMs <= 0) return 0;
    const now = Date.now();
    const cutoff = now - processingTimeoutMs;
    const res = await pool.query(
      `SELECT id, payload, job_key FROM ${TABLE} WHERE status='processing' AND run_after<=$1`,
      [cutoff],
    );
    let changed = 0;
    const maxJitter = queueRecoveryJitterMs();
    for (const row of res.rows as Array<{ id: string; payload: string; job_key?: string | null }>) {
      if (activeJobIds.has(row.id)) continue;
      const runAfter = now + deterministicJitterMs(`${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
      const update = await pool.query(
        `UPDATE ${TABLE} SET status='pending', run_after=$1, last_error=COALESCE(last_error, $2) WHERE id=$3 AND status='processing'`,
        [runAfter, "processing lease expired; requeued", row.id],
      );
      changed += update.rowCount ?? 0;
    }
    return changed;
  }

  async function deferPendingJobsForRateLimit(
    delayMs: number,
    now: number,
    blocked: GitHubRateLimitAdmissionTarget,
  ): Promise<number> {
    const res = await pool.query(
      `SELECT id, payload, job_key FROM ${TABLE} WHERE status='pending' AND run_after<=$1`,
      [now + delayMs],
    );
    let changed = 0;
    for (const row of res.rows as Array<{ id: string; payload: string; job_key?: string | null }>) {
      let candidate: GitHubRateLimitAdmissionTarget | null = null;
      try {
        candidate = githubRateLimitAdmissionTargetForJob(JSON.parse(row.payload) as JobMessage);
      } catch {
        candidate = null;
      }
      if (!matchesGitHubRateLimitAdmissionTarget(candidate, blocked)) continue;
      const runAfter = now + rateLimitRetryDelayWithJitter(delayMs, `${row.job_key ?? ""}:${row.id}:${row.payload}`);
      const update = await pool.query(
        `UPDATE ${TABLE} SET run_after=GREATEST(run_after, $1), last_error=COALESCE(last_error, $2) WHERE id=$3 AND status='pending'`,
        [runAfter, "github rate-limit budget deferred", row.id],
      );
      changed += update.rowCount ?? 0;
    }
    return changed;
  }

  async function rateLimitAdmissionDelayMs(message: JobMessage): Promise<(GitHubRateLimitAdmissionTarget & { delayMs: number }) | null> {
    const target = githubRateLimitAdmissionTargetForJob(message);
    if (target === null) return null;
    const res = await pool.query(
      `WITH exact_observation AS (
        SELECT admission_key, remaining, reset_at, observed_at FROM github_rate_limit_observations
          WHERE resource='rest' AND remaining IS NOT NULL AND $1::text IS NOT NULL AND admission_key=$1
          ORDER BY observed_at DESC
          LIMIT 1
      ), fallback_observation AS (
        SELECT admission_key, remaining, reset_at, observed_at FROM github_rate_limit_observations
          WHERE resource='rest' AND remaining IS NOT NULL AND admission_key IS NULL
          ORDER BY observed_at DESC
          LIMIT 1
      )
      SELECT admission_key, remaining, reset_at, observed_at FROM exact_observation
      UNION ALL
      SELECT admission_key, remaining, reset_at, observed_at FROM fallback_observation`,
      [target.admissionKey],
    );
    const rows = res.rows as Array<{ admission_key?: string | null; remaining?: number | string | null; reset_at?: string | null; observed_at?: string | null }>;
    const delayMs = githubRateLimitAdmissionDelayMs(target.kind, target.admissionKey, rows);
    return delayMs === null ? null : { ...target, delayMs };
  }

  async function mergeRescheduledJobIntoPending(
    job: JobRow & { job_key: string },
    runAfter: number,
    errMsg: string,
  ): Promise<boolean> {
    const existing = (
      await pool.query(
        `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=$1 AND id<>$2 ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
        [job.job_key, job.id],
      )
    ).rows[0] as { id: string } | undefined;
    if (!existing) return false;
    await pool.query(
      `UPDATE ${TABLE} SET run_after=GREATEST(run_after, $1), last_error=$2 WHERE id=$3`,
      [runAfter, errMsg, existing.id],
    );
    await pool.query(`DELETE FROM ${TABLE} WHERE id=$1`, [job.id]);
    return true;
  }

  async function recordQueueMetric(name: string, by = 1): Promise<void> {
    incr(name, undefined, by);
    await pool.query(
      `INSERT INTO ${STATS_TABLE} (name, value) VALUES ($1, $2)
       ON CONFLICT(name) DO UPDATE SET value=${STATS_TABLE}.value+$2`,
      [name, by],
    );
  }

  async function readQueueStats(): Promise<Record<string, number>> {
    const res = await pool.query(`SELECT name, value FROM ${STATS_TABLE}`);
    return Object.fromEntries(
      (res.rows as Array<{ name: string; value: number | string }>).map((row) => [
        row.name,
        Number(row.value ?? 0),
      ]),
    );
  }
}
