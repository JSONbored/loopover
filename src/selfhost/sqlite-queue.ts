// Durable, SQLite-backed job queue for the self-host runtime (#980 reliability). Unlike the in-process FIFO,
// jobs are PERSISTED — a restart (or crash) re-claims anything left in flight instead of losing it. It still
// presents the Cloudflare `Queue` binding surface (send / sendBatch) so the app code is unchanged; only the
// backing store differs. Single-process model: node:sqlite is synchronous + serial, so claim (SELECT→UPDATE)
// is atomic with no row-lock dance.
import type { SqliteDriver } from "./d1-adapter";
import type { DurableQueue } from "./backend-contracts";
import { logAudit, extractPayloadType, extractPayloadContext } from "./audit";
import { incr } from "./metrics";
import { withReviewSpan } from "./tracing";
import { withOtelSpan } from "./otel";
import { capturePostHogError, withPostHogMonitor } from "./posthog";
import {
  ATTEMPT_FREE_RETRY_DEADLINE_MS,
  consumingRetryDelayMs,
  isAttemptFreeRetry,
  deterministicJitterMs,
  FOREGROUND_QUEUE_PRIORITY_FLOOR,
  githubRateLimitAdmissionDelayMs,
  githubRateLimitAdmissionTargetForJob,
  errorMessageWithCause,
  githubRateLimitMetricContext,
  githubRateLimitRetryDelayMs,
  buildSelfHostQueueSnapshot,
  installationConcurrencyKeyForJob,
  isForegroundJobPriority,
  jobCoalesceAbsorbedByKey,
  jobCoalesceKey,
  jobCoalesceMergeKeyPrefix,
  jobCoalesceMergedPayload,
  jobCoalesceSupersededKeyPrefix,
  jobClaimSortKey,
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
  type DeadLetterJob,
  type GitHubRateLimitAdmissionTarget,
  type SelfHostQueueSnapshot,
} from "./queue-common";
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
  evaluateInstallationConcurrencyAdmission,
  installationConcurrencyDeferMs,
  resolveInstallationConcurrencyConfig,
  InstallationConcurrencyTracker,
} from "./installation-concurrency-admission";
import {
  AGENT_REGATE_PR_JOB_KEY_PREFIX,
  DEFAULT_FOREGROUND_LANE_RATIO,
  backlogRepoCandidatesFromJobKeys,
  foregroundLaneForJob,
  nextForegroundLane,
  pickBacklogRepo,
  shouldEscapeLanePriorityGate,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_error TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  job_key TEXT,
  claim_sort_key INTEGER NOT NULL DEFAULT 0
);`;
const DEAD_LETTER_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ${TABLE}_dead ON ${TABLE}(status, dead_at, id);`;
const STATS_DDL = `
CREATE TABLE IF NOT EXISTS ${STATS_TABLE} (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);`;
const FAIRNESS_DDL = `
CREATE TABLE IF NOT EXISTS ${FAIRNESS_TABLE} (
  id TEXT PRIMARY KEY,
  claim_sequence INTEGER NOT NULL DEFAULT 0,
  last_backlog_repo TEXT
);`;
const CLAIM_INDEX_DDL = `
DROP INDEX IF EXISTS ${TABLE}_claim;
CREATE INDEX ${TABLE}_claim ON ${TABLE}(status, priority, claim_sort_key, run_after);`;
const JOB_KEY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ${TABLE}_pending_job_key ON ${TABLE}(job_key, status);`;
const LANE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ${TABLE}_lane_claim ON ${TABLE}(status, foreground_lane, run_after);`;
// #9155: mirrors pg-queue.ts's ${TABLE}_maintenance_status index -- maintenancePressureSignals' maintenance-lane
// COUNT/MIN scan (WHERE is_maintenance=1 AND status IN (...)) had no supporting index; partial (is_maintenance=1
// only) since the maintenance lane is a small minority of rows and non-maintenance jobs never need it.
const MAINTENANCE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ${TABLE}_maintenance_status ON ${TABLE}(is_maintenance, status) WHERE is_maintenance=1;`;

interface JobRow {
  id: number;
  payload: string;
  attempts: number;
  job_key?: string | null;
  priority: number;
  created_at: number;
  backgroundSlotReserved?: boolean;
  // #selfhost-installation-concurrency: set only when this job was ADMITTED-AND-COUNTED against a specific
  // installation's in-flight tracker -- stamped at admission time so the shared finally can release the SAME
  // key, mirroring backgroundSlotReserved's own admit-time-stamp / release-in-finally shape.
  installationConcurrencyKey?: string;
}

export interface SqliteQueueOptions {
  maxRetries?: number;
  pollIntervalMs?: number;
  backoffMs?: (attempt: number) => number;
  /** Max concurrent `processOne()` loops. Defaults to QUEUE_CONCURRENCY env var or 8 — review jobs are I/O-bound
   *  (GitHub + AI awaits dominate), so overlapping a handful drains a PR burst far faster while SQLite's WAL +
   *  busy_timeout absorb the short serialized write windows. Sized for multi-tenant volume (#4892) to match the
   *  hosted Cloudflare consumer default and the #4913 load-test concurrency=8 band. Set QUEUE_CONCURRENCY=1 to
   *  force strict serial. */
  concurrency?: number;
  /** Max background jobs (priority < 8) allowed to consume concurrent slots. Defaults to
   *  QUEUE_BACKGROUND_CONCURRENCY or 4 — raised with #4892 so multiple installations can progress under
   *  installation-concurrency-admission (default per-install limit 2) instead of a single-operator background=1. */
  backgroundConcurrency?: number;
}

/** #9139/#9136: append a `dead_lettered` review_audit row for a queue job that just permanently failed --
 *  mirrors pg-queue.ts's identical helper (see its own doc comment for the full "why": ops.ts's DLQ
 *  anomaly signal reads `event_type = 'dead_lettered'`, but nothing wrote that event type anywhere before
 *  this fix). Scoped to jobs with an identifiable repo+PR; a job with no PR context has nothing sensible to
 *  attribute a REVIEW dead-letter to and still increments loopover_jobs_dead_total exactly as before.
 *  target_id uses the SAME `owner/repo#pr` shape outcomes-wire.ts's reviewAuditTargetId stamps. Best-effort:
 *  a write failure here must never mask the job's own already-successful dead-letter transition above. */
function recordReviewAuditDeadLetter(driver: SqliteDriver, payload: string, errMsg: string): void {
  const context = extractPayloadContext(payload);
  if (!context?.repo || context.pr_number === undefined) return;
  const project = process.env.GITHUB_APP_SLUG?.trim() || "loopover";
  const targetId = `${context.repo.slice(0, 200)}#${context.pr_number}`;
  try {
    driver.query(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES (?, ?, ?, 'dead_lettered', NULL, 'selfhost-queue', NULL, ?, ?)`,
      [`dead_lettered:${targetId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, project, targetId, errMsg.slice(0, 500), new Date().toISOString()],
    );
  } catch (auditError) {
    console.warn(
      JSON.stringify({
        event: "review_audit_dead_letter_record_error",
        targetId,
        message: errorMessageWithCause(auditError).slice(0, 160),
      }),
    );
  }
}

export function createSqliteQueue(
  driver: SqliteDriver,
  consume: (message: JobMessage) => Promise<void>,
  opts: SqliteQueueOptions = {},
): DurableQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const backoff =
    opts.backoffMs ??
    ((attempt: number) => Math.min(60_000, 1000 * 2 ** attempt));
  const concurrency =
    opts.concurrency ??
    parsePositiveIntEnv("QUEUE_CONCURRENCY", { min: 1, fallback: 8 });
  const backgroundConcurrency = queueBackgroundConcurrency(
    concurrency,
    opts.backgroundConcurrency,
  );
  const processingTimeoutMs = queueProcessingTimeoutMs();

  driver.exec(DDL);
  driver.exec(STATS_DDL);
  // Idempotent add for queues created before the priority column existed (#review-latency): the CREATE is skipped
  // for a pre-existing table, so ALTER must run before any index references the new column.
  try {
    driver.exec(
      `ALTER TABLE ${TABLE} ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already present */
  }
  try {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN job_key TEXT`);
  } catch {
    /* column already present */
  }
  try {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN claim_sort_key INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* column already present */
  }
  try {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN is_maintenance INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* column already present */
  }
  try {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN foreground_lane TEXT`);
  } catch {
    /* column already present */
  }
  try {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN dead_at INTEGER`);
  } catch {
    /* column already present */
  }
  // #9127: provenance tag for releaseStaleForegroundDeferrals' rate-limit-clear recheck. Set ONLY at an admission
  // gate's own defer site (rate-limit / maintenance-admission / installation-concurrency), NEVER by enqueue()'s
  // delaySeconds -- see foreground-liveness.ts's module header for the full rationale.
  try {
    driver.exec(`ALTER TABLE ${TABLE} ADD COLUMN deferred_by TEXT`);
  } catch {
    /* column already present */
  }
  driver.exec(CLAIM_INDEX_DDL);
  driver.exec(JOB_KEY_INDEX_DDL);
  driver.exec(LANE_INDEX_DDL);
  driver.exec(MAINTENANCE_INDEX_DDL);
  driver.exec(DEAD_LETTER_INDEX_DDL);
  driver.exec(FAIRNESS_DDL);
  driver.exec(`INSERT OR IGNORE INTO ${FAIRNESS_TABLE} (id, claim_sequence) VALUES ('singleton', 0)`);
  const priorityBackfilled = backfillJobPriorities(driver);
  if (priorityBackfilled)
    console.log(
      JSON.stringify({
        event: "selfhost_queue_priority_backfilled",
        count: priorityBackfilled,
      }),
    );
  const keyBackfilled = backfillJobKeys(driver);
  if (keyBackfilled)
    console.log(
      JSON.stringify({
        event: "selfhost_queue_job_keys_backfilled",
        count: keyBackfilled,
      }),
    );
  const sortKeysBackfilled = backfillJobClaimSortKeys(driver);
  if (sortKeysBackfilled)
    console.log(
      JSON.stringify({
        event: "selfhost_queue_claim_sort_keys_backfilled",
        count: sortKeysBackfilled,
      }),
    );
  const maintenanceFlagsBackfilled = backfillJobMaintenanceFlags(driver);
  if (maintenanceFlagsBackfilled)
    console.log(
      JSON.stringify({
        event: "selfhost_queue_maintenance_flags_backfilled",
        count: maintenanceFlagsBackfilled,
      }),
    );
  const lanesBackfilled = backfillJobForegroundLanes(driver);
  if (lanesBackfilled)
    console.log(
      JSON.stringify({
        event: "selfhost_queue_foreground_lanes_backfilled",
        count: lanesBackfilled,
      }),
    );
  const maintenanceAdmissionConfig: MaintenanceAdmissionConfig = resolveMaintenanceAdmissionConfig();
  const foregroundLivenessConfig: ForegroundLivenessConfig = resolveForegroundLivenessConfig();
  const installationConcurrencyConfig = resolveInstallationConcurrencyConfig();
  const installationConcurrencyTracker = new InstallationConcurrencyTracker();
  // #9155: memoization state for maintenancePressureSignals below -- same feedback-loop rationale as
  // pg-queue.ts's cache (see maintenanceAdmissionConfig's pressureSignalsCacheTtlMs doc comment): a denied
  // maintenance job returns `true` from processOne(), so the pump's drain loop immediately claims the next due
  // maintenance row and re-evaluates admission, recomputing all four aggregate scans per denial without this.
  // Unlike pg-queue.ts's version, no separate in-flight-promise dedup is needed: node:sqlite's queries are
  // synchronous, so a cache check followed by a (synchronous) recompute can never interleave with another call
  // the way concurrent async Postgres round-trips could.
  let cachedPressureSignals: { value: MaintenancePressureSignals; computedAtMs: number } | null = null;

  /** Cached wrapper around maintenancePressureSignals -- the actual four-aggregate-query read. Every caller
   *  (maintenance-admission gating in processOne, and the binding.pressureSignals() observability method) goes
   *  through this, so both benefit from -- and share -- the same short-TTL cache. */
  function getMaintenancePressureSignals(now: number): MaintenancePressureSignals {
    if (
      cachedPressureSignals &&
      now - cachedPressureSignals.computedAtMs < maintenanceAdmissionConfig.pressureSignalsCacheTtlMs
    ) {
      return cachedPressureSignals.value;
    }
    const value = maintenancePressureSignals(driver, now);
    cachedPressureSignals = { value, computedAtMs: now };
    return value;
  }
  // Recover jobs a crashed previous run left mid-flight → make them claimable again.
  const recovered = recoverProcessingJobs(driver);
  if (recovered) {
    recordQueueMetric(driver, "loopover_jobs_recovered_total", recovered);
    console.log(
      JSON.stringify({ event: "selfhost_queue_recovered", count: recovered }),
    );
  }
  const spread = spreadDueJobsOnStartup(driver);
  if (spread)
    console.log(
      JSON.stringify({
        event: "selfhost_queue_startup_spread",
        count: spread,
        jitter_ms: queueStartupJitterMs(),
      }),
    );
  let running = false;
  // #9007: distinct from `running`, which also governs pre-start()/direct pump()-drain() usage (binding.send()'s
  // fire-and-forget kickOne(), and drain()'s own direct pump() call, both legitimately run a pump loop before
  // start() has ever been called or after stop() -- gating the loop below on `running` itself broke exactly
  // that path). `shuttingDown` instead means ONLY "stop() has been called and hasn't been superseded by a
  // later start()" -- it starts false, flips true at the very top of stop() (before its own drain-wait), and
  // resets false in start() so a stop()-then-restart cycle claims fresh again.
  let shuttingDown = false;
  let active = 0; // number of concurrent pump() loops currently draining jobs
  let activeBackground = 0;
  const activeJobIds = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadLetterReviveTimer: ReturnType<typeof setInterval> | null = null;
  let foregroundLivenessTimer: ReturnType<typeof setInterval> | null = null;

  // Self-heal on boot (#selfhost-queue-liveness): a deploy/restart inherits whatever run_after values were
  // already written before it, so a foreground lane over-deferred before the restart must not require manual
  // intervention to unstick. releaseStaleForegroundDeferrals is declared below (function-hoisted, see
  // foreground-liveness.ts) and logs + records its own metric when it finds work. MUST run after `active`/
  // `activeBackground` above are initialized -- a release calls kickAll(), which reads them, and both are
  // still in the temporal dead zone before this point (#selfhost-queue-liveness-tdz).
  void releaseStaleForegroundDeferrals();

  async function reviveDeadLetterJobs(): Promise<number> {
    const revived = reviveEligibleDeadJobs(driver, maxRetries);
    if (revived) {
      recordQueueMetric(driver, "loopover_jobs_dead_letter_revived_total", revived);
      console.log(JSON.stringify({ event: "selfhost_queue_dead_letter_revived", count: revived }));
      kickAll();
    }
    return revived;
  }

  /** Wraps reviveDeadLetterJobs() for the setInterval callback below, which has no error handler of its own --
   *  a transient driver/metric failure here would otherwise surface as an uncaught exception and terminate the
   *  process, uniformly regardless of PostHog config (#9133: installSelfHostCrashHandlers is now the sole,
   *  unconditional crash-and-restart contract -- previously this was fatal only when POSTHOG_API_KEY was
   *  UNSET, since initPostHog's enableExceptionAutocapture, when configured, silently captured-without-exiting
   *  the async/rejection case specifically), exactly the failure mode pump()'s own try/catch above guards
   *  against for the main poll loop. A failed revive tick just waits for the next interval, same as a failed
   *  poll tick waits for the next poll.
   *
   *  Also wrapped in a PostHog monitor heartbeat (#1824): dead-letter revival stopping SILENTLY (the timer
   *  never fires again) is worse than one throwing tick -- a crashed tick self-reports via capturePostHogError
   *  below, but a stopped one reports nothing without a monitor watching for the missed heartbeat.
   *  withPostHogMonitor rethrows on failure so its own capture fires; the outer try/catch (this function's
   *  actual job) still guards the setInterval callback. Async now (setInterval tolerates a Promise-returning
   *  callback the same as the synchronous one it replaces -- see the call site). */
  async function reviveDeadLetterJobsSafely(): Promise<void> {
    try {
      await withPostHogMonitor(
        "queue-dead-letter-revive",
        { jobType: "queue-dead-letter-revive" },
        () => Promise.resolve(reviveDeadLetterJobs()),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_queue_dead_letter_revive_crashed",
          error: errorMessageWithCause(error),
        }),
      );
      capturePostHogError(error, { kind: "queue_dead_letter_revive_crashed" }, "queue_dead_letter_revive_crashed");
    }
  }

  /** #selfhost-queue-liveness: re-evaluate rate-limit admission for an already-deferred foreground candidate
   *  against CURRENT observations, independent of how long ago it was deferred. Returns true when it would be
   *  admitted right now (no longer blocked); false when still blocked OR the payload is unparseable (best-
   *  effort -- an unparseable payload is left for the normal dead-letter path, never force-released here). */
  function isRateLimitAdmissionNowClear(payload: string, admissionCache: Map<string, boolean>): boolean {
    let message: JobMessage;
    try {
      message = JSON.parse(payload) as JobMessage;
    } catch {
      return false;
    }
    const target = githubRateLimitAdmissionTargetForJob(message);
    if (target === null) return true;
    const cacheKey = `${target.kind}:${target.admissionKey ?? ""}`;
    const cached = admissionCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const clear = rateLimitAdmissionDelayMs(driver, message) === null;
    admissionCache.set(cacheKey, clear);
    return clear;
  }

  /** See foreground-liveness.ts for the full rationale. A bounded candidate SELECT (foreground-priority, pending,
   *  not currently due, ADMISSION-GATE-DEFERRED -- see below), an eligibility pass, a ramp-up CAP, then a per-row
   *  conditional UPDATE only for the capped subset -- mirroring reviveEligibleDeadJobs' shape but with the extra
   *  ramp-up step. Each candidate is ELIGIBLE on EITHER of two independent conditions: it has genuinely been
   *  waiting past the age-based trickle ceiling (isForegroundDeferralStale, unconditional backstop), OR --
   *  CONDITION-BASED recovery (#selfhost-queue-liveness VPS incident), restricted to rows an admission gate itself
   *  deferred for a rate-limit reason (`deferred_by='rate_limit'`) -- re-evaluating rate-limit admission against
   *  CURRENT observations right now says it would be admitted immediately. The age floor alone can leave a job
   *  pinned to a stale reset timestamp for up to its full original delay (observed up to ~15m) even when a
   *  fresher, healthier observation arrived moments after it was deferred; the condition check recovers it on the
   *  NEXT sweep tick instead (bounded by FOREGROUND_LIVENESS_CHECK_INTERVAL_MS, default 60s) whenever the
   *  underlying rate-limit pressure has actually cleared, regardless of job age. When more jobs are eligible than
   *  maxReleasePerSweep allows, selectForegroundDeferralsToRelease picks the oldest first -- a large inherited
   *  backlog drains gradually over several sweep ticks instead of flooding GitHub with every re-attempt at once.
   *  Logs + records a metric ONCE per sweep (aggregate count), not per row, so a large release batch cannot spam
   *  the log.
   *
   *  #9127 -- PROVENANCE filter (`deferred_by IS NOT NULL`, enforced by the candidate SELECT's own WHERE clause,
   *  not by an application-side check on the returned rows): only a row an admission gate itself deferred
   *  (rate-limit / maintenance-admission / installation-concurrency -- see the three defer sites' own
   *  `deferred_by=coalesce(deferred_by, ...)` writes) is EVER a release candidate. A row whose future run_after
   *  came from enqueue(message, delaySeconds) -- a deliberate delay, e.g. the linked-issue flag-then-close grace
   *  window -- never has deferred_by set, so it is structurally excluded here regardless of age or rate-limit
   *  state. See pg-queue.ts's twin (and foreground-liveness.ts's module header) for the full incident writeup --
   *  this and pg-queue.ts's own copy must stay in lockstep (verified twin, see foreground-liveness.ts).
   *
   *  Candidate selection queries an OLDEST window AND a NEWEST window (#selfhost-queue-liveness clear-bucket
   *  starvation fix), not just one oldest-first window. A single `ORDER BY created_at ASC LIMIT` window can be
   *  filled ENTIRELY by older still-rate-limited jobs once the backlog exceeds the limit -- selectForegroundDeferralsToRelease's
   *  clear-bucket-priority sort can only prioritize candidates it is actually shown, so a large-enough glut of
   *  older blocked jobs would permanently hide every newer, already-admittable candidate from it, defeating the
   *  whole point of the clear-bucket check. The newest window guarantees a fresh clear-bucket candidate is
   *  always represented in `eligible` regardless of how large the older-blocked backlog grows, at the same
   *  total worst-case row/admission-check budget as before (still `maxReleasePerSweep * 2` candidates, just
   *  split fairly across both ends of the age spectrum instead of packed entirely into the oldest end). */
  async function releaseStaleForegroundDeferrals(): Promise<number> {
    if (!foregroundLivenessConfig.enabled) return 0;
    const now = Date.now();
    const candidateLimit = foregroundLivenessConfig.maxReleasePerSweep;
    const oldest = driver.query(
      `SELECT id, payload, created_at, deferred_by FROM ${TABLE} WHERE status='pending' AND priority>=? AND run_after>? AND deferred_by IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT ?`,
      [FOREGROUND_QUEUE_PRIORITY_FLOOR, now, candidateLimit],
    ).rows;
    const newest = driver.query(
      `SELECT id, payload, created_at, deferred_by FROM ${TABLE} WHERE status='pending' AND priority>=? AND run_after>? AND deferred_by IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ?`,
      [FOREGROUND_QUEUE_PRIORITY_FLOOR, now, candidateLimit],
    ).rows;
    const candidateRowsById = new Map<number, { id: number; payload: string; created_at: number; deferred_by: string | null }>();
    for (const row of [...oldest, ...newest] as Array<{ id: number; payload: string; created_at: number; deferred_by: string | null }>) {
      candidateRowsById.set(row.id, row);
    }
    const eligible: Array<{ id: number; pendingSinceMs: number; ageStale: boolean; rateLimitClear: boolean }> = [];
    const admissionCache = new Map<string, boolean>();
    for (const row of candidateRowsById.values()) {
      const ageStale = isForegroundDeferralStale(foregroundLivenessConfig, row.created_at, now);
      // See pg-queue.ts's twin: the rate-limit-clear recheck is only trusted for a row deferred SPECIFICALLY for
      // a rate-limit reason -- a maintenance-admission or installation-concurrency deferral has no rate-limit
      // bucket either, and isRateLimitAdmissionNowClear degrading to "clear" for it would release it on the very
      // next sweep tick regardless of whether its OWN gate has actually cleared.
      const rateLimitClear = row.deferred_by === "rate_limit" && isRateLimitAdmissionNowClear(row.payload, admissionCache);
      if (!ageStale && !rateLimitClear) continue;
      eligible.push({ id: row.id, pendingSinceMs: row.created_at, ageStale, rateLimitClear });
    }
    const toRelease = selectForegroundDeferralsToRelease(eligible, foregroundLivenessConfig.maxReleasePerSweep);
    let released = 0;
    let releasedByAge = 0;
    let releasedByRateLimitClear = 0;
    for (const candidate of toRelease) {
      // Clears deferred_by on release too (not just run_after): the row is no longer deferred by anything, so a
      // FUTURE re-defer (of whatever kind next applies) writes its own fresh tag via coalesce(deferred_by, ...)
      // instead of inheriting a stale tag from whichever admission gate deferred it this time.
      const { changes } = driver.query(
        `UPDATE ${TABLE} SET run_after=?, deferred_by=NULL WHERE id=? AND status='pending' AND run_after>?`,
        [now, candidate.id, now],
      );
      released += changes;
      if (candidate.ageStale) releasedByAge += changes;
      else releasedByRateLimitClear += changes;
    }
    if (released) {
      recordQueueMetric(driver, "loopover_jobs_foreground_liveness_released_total", released);
      if (releasedByAge) incr("loopover_jobs_foreground_liveness_released_by_reason_total", { reason: "age" }, releasedByAge);
      if (releasedByRateLimitClear) incr("loopover_jobs_foreground_liveness_released_by_reason_total", { reason: "rate_limit_cleared" }, releasedByRateLimitClear);
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
   *  reviveDeadLetterJobsSafely's own rationale: an uncaught exception here would surface as an unhandled
   *  exception and can terminate the process when SENTRY_DSN is unset. A failed sweep just waits for the next
   *  interval, same as a failed poll tick waits for the next poll. */
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
      capturePostHogError(error, { kind: "queue_foreground_liveness_release_crashed" }, "queue_foreground_liveness_release_crashed");
    }
  }

  // #audit-webhook-supersede-trace: best-effort, never blocks a coalesce on a write hiccup -- the row it marks
  // is purely an audit trace (webhook_events), not the actual job data, so a failure here must not resurrect the
  // "abort the whole enqueue" class of bug this whole issue exists to close. `oldPayload` is the row's payload
  // BEFORE it gets overwritten by the coalesce; `incomingMessage` is what it's about to become. Only a
  // github-webhook delivery has a webhook_events row at all (rag-index-repo etc. never do), and only when the
  // superseded id genuinely differs from the surviving one (defense-in-depth against a same-id no-op).
  function markSupersededWebhookEvent(oldPayload: string, incomingMessage: JobMessage): void {
    let old: { type?: unknown; deliveryId?: unknown } | null;
    try {
      old = JSON.parse(oldPayload) as { type?: unknown; deliveryId?: unknown };
    } catch {
      return;
    }
    if (old?.type !== "github-webhook" || typeof old.deliveryId !== "string") return;
    /* v8 ignore next -- defensive: jobCoalesceKey partitions its key format strictly by message.type, so a
     * github-webhook job_key can only ever be matched by another github-webhook message; the non-webhook arm
     * is unreachable through this call site, not load-bearing. */
    const incomingDeliveryId = incomingMessage.type === "github-webhook" ? incomingMessage.deliveryId : undefined;
    if (old.deliveryId === incomingDeliveryId) return;
    try {
      driver.query(`UPDATE webhook_events SET status='superseded', processed_at=? WHERE delivery_id=? AND status='queued'`, [new Date().toISOString(), old.deliveryId]);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "webhook_supersede_mark_failed",
          error: errorMessageWithCause(error),
        }),
      );
    }
  }

  function enqueue(message: JobMessage, delaySeconds: number): void {
    const now = Date.now();
    const payload = JSON.stringify(message);
    const priority = jobPriority(payload);
    const key = jobCoalesceKey(payload);
    const lane = foregroundLaneForJob(message.type, payload);
    const runAfter = now + delaySeconds * 1000;
    const claimSortKey = jobClaimSortKey(payload, runAfter);
    const absorbedByKey = jobCoalesceAbsorbedByKey(payload);
    if (absorbedByKey) {
      const existingFull = driver.query(
        `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=? ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
        [absorbedByKey],
      ).rows[0] as { id: number } | undefined;
      if (existingFull) {
        recordQueueMetric(driver, "loopover_jobs_coalesced_total");
        kickOne();
        return;
      }
    }
    // Merge two INCREMENTAL rag-index-repo jobs for the same repo (#selfhost-maintenance-self-pin), e.g. several
    // merged PRs touching different files in a burst, into one pending row's UNION path set instead of piling up
    // as separate maintenance-lane rows.
    const mergeKeyPrefix = jobCoalesceMergeKeyPrefix(payload);
    if (mergeKeyPrefix) {
      const prefixLength = mergeKeyPrefix.length;
      // `absorbedByKey` shares mergeKeyPrefix's exact guard (both require an incoming path-scoped rag-index-repo
      // message), so it's provably non-null here -- it's asserted, not defaulted, because we only reach this
      // branch once it found no pending FULL job to absorb into; excluding that same key guards against a
      // job_key collision, it can never actually match a row here.
      const mergeCandidate = driver.query(
        `SELECT id, payload FROM ${TABLE}
         WHERE status='pending' AND job_key IS NOT NULL AND substr(job_key, 1, ?)=? AND job_key<>?
         ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
        [prefixLength, mergeKeyPrefix, absorbedByKey as string],
      ).rows[0] as { id: number; payload: string } | undefined;
      if (mergeCandidate) {
        const mergedPayload = jobCoalesceMergedPayload(mergeCandidate.payload, payload);
        if (mergedPayload) {
          const mergedKey = jobCoalesceKey(mergedPayload);
          driver.query(
            `UPDATE ${TABLE}
               SET payload=?, run_after=max(run_after, ?), created_at=?, priority=max(priority, ?), job_key=?,
                   claim_sort_key=CASE WHEN claim_sort_key>0 THEN min(claim_sort_key, ?) ELSE ? END,
                   last_error=NULL, deferred_by=NULL
             WHERE id=?`,
            [mergedPayload, runAfter, now, priority, mergedKey, claimSortKey, claimSortKey, mergeCandidate.id],
          );
          recordQueueMetric(driver, "loopover_jobs_coalesced_total");
          kickOne();
          return;
        }
      }
    }
    const supersededKeyPrefix = jobCoalesceSupersededKeyPrefix(payload);
    if (key && supersededKeyPrefix) {
      const prefixLength = supersededKeyPrefix.length;
      const existing = driver.query(
        `SELECT id FROM ${TABLE}
         WHERE status='pending' AND job_key IS NOT NULL AND substr(job_key, 1, ?)=?
         ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
        [prefixLength, supersededKeyPrefix],
      ).rows[0] as { id: number } | undefined;
      if (existing) {
        // created_at is deliberately NOT overwritten here (#selfhost-runtime-drift): it anchors the maintenance
        // trickle's age clock (see maintenance-admission.ts). A periodic scheduler re-enqueuing the SAME still-
        // pending maintenance need must coalesce into the existing row without resetting how long that need has
        // genuinely been outstanding -- otherwise a re-enqueue cadence shorter than the trickle's maxDeferAgeMs
        // (4h default) can keep re-arming the clock forever, and sustained pressure defers the job indefinitely.
        driver.query(
          `UPDATE ${TABLE}
             SET payload=?, run_after=max(run_after, ?), priority=max(priority, ?), job_key=?, foreground_lane=?,
                 claim_sort_key=CASE WHEN claim_sort_key>0 THEN min(claim_sort_key, ?) ELSE ? END,
                 last_error=NULL, deferred_by=NULL
           WHERE id=?`,
          [payload, runAfter, priority, key, lane, claimSortKey, claimSortKey, existing.id],
        );
        driver.query(
          `DELETE FROM ${TABLE}
           WHERE status='pending' AND id<>? AND job_key IS NOT NULL AND substr(job_key, 1, ?)=?`,
          [existing.id, prefixLength, supersededKeyPrefix],
        );
        recordQueueMetric(driver, "loopover_jobs_coalesced_total");
        kickOne();
        return;
      }
    }
    if (key) {
      const existing = driver.query(
        `SELECT id, payload FROM ${TABLE} WHERE status='pending' AND job_key=? ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
        [key],
      ).rows[0] as { id: number; payload: string } | undefined;
      if (existing) {
        // #audit-webhook-supersede-trace: the row about to be overwritten below may itself be a github-webhook
        // delivery (e.g. a "PR opened" pr-refresh coalesce) whose own webhook_events row was written as 'queued'
        // BEFORE it ever reached this coalesce -- overwriting the payload here discards that delivery's id
        // forever, so nothing would ever advance its webhook_events row past 'queued'. Mark it superseded FIRST,
        // while the OLD payload (and its deliveryId) is still readable.
        markSupersededWebhookEvent(existing.payload, message);
        // See the supersededKeyPrefix branch above: created_at is preserved across a coalesced re-enqueue so the
        // maintenance trickle clock reflects genuine wait time, not the most recent re-request.
        driver.query(
          `UPDATE ${TABLE}
             SET payload=?, run_after=max(run_after, ?), priority=max(priority, ?), foreground_lane=?,
                 claim_sort_key=CASE WHEN claim_sort_key>0 THEN min(claim_sort_key, ?) ELSE ? END,
                 last_error=NULL, deferred_by=NULL
           WHERE id=?`,
          [payload, runAfter, priority, lane, claimSortKey, claimSortKey, existing.id],
        );
        recordQueueMetric(driver, "loopover_jobs_coalesced_total");
        kickOne();
        return;
      }
    }
    driver.query(
      `INSERT INTO ${TABLE} (payload, status, attempts, run_after, created_at, priority, job_key, is_maintenance, foreground_lane, claim_sort_key) VALUES (?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`,
      [payload, runAfter, now, priority, key, isMaintenanceJobType(message.type) ? 1 : 0, lane, claimSortKey],
    );
    recordQueueMetric(driver, "loopover_jobs_enqueued_total");
    kickOne();
  }

  function claimNext(): JobRow | null {
    const now = Date.now();
    const foreground = claimNextForegroundLane(now) ?? claimNextWhere(now, "candidate.priority>=?");
    if (foreground) return foreground;
    if (activeBackground >= backgroundConcurrency) return null;
    activeBackground++;
    let background: JobRow | null;
    try {
      background = claimNextWhere(now, "candidate.priority<?");
    } catch (error) {
      // Release the reserved background slot if the claim query itself throws (a SQLite "database is locked" / I/O
      // error). claimNext() runs OUTSIDE processOne's try/finally, so without this rollback the reserved slot leaks
      // permanently; since backgroundConcurrency is intentionally small relative to total concurrency, a single such error would starve the entire
      // background/maintenance lane with no recovery short of a restart. (#selfhost-bg-slot-leak)
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
   *  ONE lane-scoped claim before falling back to the plain unscoped foreground claim (claimNext() OR's this
   *  return value with claimNextWhere(now, "priority>=?")) -- a null here just means "no work to prefer this
   *  cycle," never "no foreground work at all." One slot per fairness window is deliberately left unscoped, and
   *  lane-scoped claims must beat the best unclassified foreground priority, so manual/repair work the classifier
   *  intentionally leaves as lane `null` keeps its plain priority ordering instead of sitting behind a perpetually
   *  non-empty classified lane -- UNLESS that gate has starved the lane past shouldEscapeLanePriorityGate's
   *  bounded age (#9153: an unclassified priority-10 webhook is essentially always due on a repo with CI, which
   *  would otherwise make the `>` gate permanently unsatisfiable and this whole mechanism inert; see
   *  queue-fairness.ts's module comment on that constant). The fairness singleton's claim_sequence always
   *  advances (best-effort, hit or miss) so the ratio cycle keeps progressing even through empty cycles. */
  function claimNextForegroundLane(now: number): JobRow | null {
    const fairness = driver.query(
      `SELECT claim_sequence, last_backlog_repo FROM ${FAIRNESS_TABLE} WHERE id='singleton'`,
      [],
    ).rows[0] as { claim_sequence: number; last_backlog_repo: string | null } | undefined;
    const sequence = fairness?.claim_sequence ?? 0;
    const fairnessWindow = DEFAULT_FOREGROUND_LANE_RATIO.backlogPer + DEFAULT_FOREGROUND_LANE_RATIO.freshPer;
    const lane: ForegroundLane = nextForegroundLane(sequence);
    driver.query(`UPDATE ${FAIRNESS_TABLE} SET claim_sequence=claim_sequence+1 WHERE id='singleton'`, []);
    if (sequence % (fairnessWindow + 1) === fairnessWindow) return null;
    const unclassifiedPriority = maxDueUnclassifiedForegroundPriority(now);
    if (lane === "fresh") {
      const oldestDueLaneAgeMs = oldestDueForegroundLaneAgeMs(now, "fresh");
      const { predicate: lanePriorityPredicate, floor: lanePriorityFloor } = lanePriorityGate(
        unclassifiedPriority,
        oldestDueLaneAgeMs,
      );
      const freshRow = claimNextWhere(now, lanePriorityPredicate, { sql: "candidate.foreground_lane='fresh'", params: [] }, lanePriorityFloor);
      if (freshRow) incr("loopover_jobs_claimed_by_lane_total", { lane: "fresh" });
      return freshRow;
    }
    const { rows: backlogRows } = driver.query(
      `SELECT job_key, created_at FROM ${TABLE} WHERE status='pending' AND run_after<=? AND foreground_lane='backlog'`,
      [now],
    );
    const backlogRowsTyped = backlogRows as Array<{ job_key: string | null; created_at: number }>;
    // Oldest due backlog row's age, computed straight from the rows just fetched above -- no extra query needed
    // (unlike the fresh lane, which has no equivalent pre-fetched row set to reuse).
    const oldestDueLaneAgeMs =
      backlogRowsTyped.length === 0 ? null : Math.max(...backlogRowsTyped.map((row) => now - Number(row.created_at)));
    const { predicate: lanePriorityPredicate, floor: lanePriorityFloor } = lanePriorityGate(
      unclassifiedPriority,
      oldestDueLaneAgeMs,
    );
    const candidates = backlogRepoCandidatesFromJobKeys(
      backlogRowsTyped.map((row) => ({
        jobKey: row.job_key,
        createdAtMs: Number(row.created_at),
      })),
      now,
    );
    const repo = pickBacklogRepo(candidates, fairness?.last_backlog_repo ?? null);
    if (!repo) return null;
    const row = claimNextWhere(now, lanePriorityPredicate, {
      sql: "candidate.foreground_lane='backlog' AND candidate.job_key LIKE ?",
      params: [`agent-regate-pr:${repo}#%`],
    }, lanePriorityFloor);
    if (row) {
      driver.query(`UPDATE ${FAIRNESS_TABLE} SET last_backlog_repo=? WHERE id='singleton'`, [repo]);
      incr("loopover_jobs_claimed_by_lane_total", { lane: "backlog" });
    }
    return row;
  }

  /** The lane-scoped claim's priority predicate + floor for this cycle: strictly beat `unclassifiedPriority`
   *  (when there is a due unclassified row) unless the age escape (#9153) fires, in which case fall back to the
   *  same `>=` floor the unscoped claim itself uses -- letting the lane's own priority ordering (still scoped to
   *  this lane via claimNextWhere's `extra` predicate) decide instead of being blocked outright. */
  function lanePriorityGate(
    unclassifiedPriority: number | null,
    oldestDueLaneAgeMs: number | null,
  ): { predicate: string; floor: number } {
    if (unclassifiedPriority === null || shouldEscapeLanePriorityGate(oldestDueLaneAgeMs)) {
      return { predicate: "candidate.priority>=?", floor: FOREGROUND_QUEUE_PRIORITY_FLOOR };
    }
    return { predicate: "candidate.priority>?", floor: unclassifiedPriority };
  }

  function maxDueUnclassifiedForegroundPriority(now: number): number | null {
    const row = driver.query(
      `SELECT MAX(priority) AS priority FROM ${TABLE} WHERE status='pending' AND run_after<=? AND priority>=? AND foreground_lane IS NULL`,
      [now, FOREGROUND_QUEUE_PRIORITY_FLOOR],
    ).rows[0] as { priority: number | null } | undefined;
    return row?.priority === null || row?.priority === undefined ? null : Number(row.priority);
  }

  /** Age (ms) of the oldest DUE row currently in the given classified lane -- null when the lane has no due
   *  candidate at all right now. Only needed for the fresh lane; the backlog lane derives this directly from
   *  the row set claimNextForegroundLane already fetches for repo selection, without a separate query. */
  function oldestDueForegroundLaneAgeMs(now: number, lane: "fresh" | "backlog"): number | null {
    const row = driver.query(
      `SELECT MIN(created_at) AS oldest FROM ${TABLE} WHERE status='pending' AND run_after<=? AND foreground_lane=?`,
      [now, lane],
    ).rows[0] as { oldest: number | null } | undefined;
    return row?.oldest != null ? now - Number(row.oldest) : null;
  }

  /** Top-N repos by backlog-convergence pending DEPTH, for the observability dashboard's per-repo backlog panel
   *  (#selfhost-lane-observability) -- a snapshot read, distinct from claimNextForegroundLane's own backlog
   *  query (which is scoped to run_after<=now and only reads job_key+created_at for the round-robin picker).
   *  This one counts EVERY pending+processing backlog-lane row regardless of run_after, matching the "how deep
   *  is each repo's backlog right now" framing of a dashboard panel rather than a claim-time eligibility set.
   *  The COUNT/GROUP BY/ORDER BY/LIMIT run IN SQL (gate review, #selfhost-lane-observability) -- a self-host
   *  install with a large real backlog must never pull every matching job_key into JS on every /metrics scrape
   *  just to throw away all but the top 10; only the final, already-bounded rows ever leave the DB. */
  async function topBacklogRepos(limit: number): Promise<BacklogRepoCount[]> {
    const { rows } = driver.query(
      `WITH backlog_rest AS (
         SELECT substr(job_key, length(?) + 1) AS rest
           FROM ${TABLE}
          WHERE status IN ('pending','processing') AND foreground_lane='backlog' AND job_key LIKE ?
       ),
       backlog_repos AS (
         SELECT CASE WHEN instr(rest, '#') > 0 THEN substr(rest, 1, instr(rest, '#') - 1) ELSE rest END AS repo
           FROM backlog_rest
       )
       SELECT repo, COUNT(*) AS cnt
         FROM backlog_repos
        WHERE repo != ''
        GROUP BY repo
        ORDER BY cnt DESC, repo ASC
        LIMIT ?`,
      [AGENT_REGATE_PR_JOB_KEY_PREFIX, `${AGENT_REGATE_PR_JOB_KEY_PREFIX}%`, Math.max(0, limit)],
    );
    return (rows as Array<{ repo: string; cnt: number }>).map((row) => ({ repo: row.repo, count: Number(row.cnt) }));
  }

  async function deadCount(): Promise<number> {
    return Number(
      (driver.query(`SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='dead'`, []).rows[0] as { c: number }).c,
    );
  }

  /** #9139: jobs dead-lettered within the trailing `windowMs` -- see backend-contracts.ts's DurableQueue
   *  doc comment for the full "why" (the cloud-worker source this backs on self-host is unreachable here). */
  async function recentDeadCount(windowMs: number): Promise<number> {
    return Number(
      (
        driver.query(`SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='dead' AND dead_at IS NOT NULL AND dead_at > ?`, [
          Date.now() - windowMs,
        ]).rows[0] as { c: number }
      ).c,
    );
  }

  async function listDeadLetterJobs(limit: number, offset: number): Promise<DeadLetterJob[]> {
    const { rows } = driver.query(
      `SELECT id, payload, attempts, last_error, created_at, dead_at
         FROM ${TABLE}
        WHERE status='dead'
        ORDER BY COALESCE(dead_at, created_at) DESC, id DESC
        LIMIT ? OFFSET ?`,
      [Math.max(0, limit), Math.max(0, offset)],
    );
    return (
      rows as Array<{
        id: number;
        payload: string;
        attempts: number;
        last_error: string | null;
        created_at: number;
        dead_at: number | null;
      }>
    ).map((row) => ({
      id: row.id,
      jobType: extractPayloadType(row.payload) ?? "unknown",
      attempts: Number(row.attempts),
      lastError: row.last_error,
      createdAtMs: Number(row.created_at),
      deadAtMs: row.dead_at === null ? null : Number(row.dead_at),
    }));
  }

  // Manual, operator-initiated dead-letter actions (#2215) -- distinct from reviveEligibleDeadJobs above, which
  // is an unattended timer sweep that deliberately preserves `attempts` under a ceiling. These three are each
  // triggered by a human clicking a specific button for a specific job on the dashboard, so they don't need (and
  // must not reuse) that automatic ceiling/jitter machinery.

  /** Manually requeues ONE dead job with a FRESH retry budget (attempts reset to 0) -- see the doc comment on
   *  SelfHostQueueDeadLetterAdmin.replayDeadLetterJob in queue-common.ts for the full rationale. Returns false
   *  if no row with that id is currently dead. */
  async function replayDeadLetterJob(id: number): Promise<boolean> {
    const { changes } = driver.query(
      `UPDATE ${TABLE} SET status='pending', run_after=?, last_error=NULL, dead_at=NULL, attempts=0 WHERE id=? AND status='dead'`,
      [Date.now(), id],
    );
    return changes > 0;
  }

  /** Permanently deletes ONE dead job by id. Returns false if no row with that id is currently dead. */
  async function deleteDeadLetterJob(id: number): Promise<boolean> {
    const { changes } = driver.query(`DELETE FROM ${TABLE} WHERE id=? AND status='dead'`, [id]);
    return changes > 0;
  }

  /** Permanently deletes EVERY dead job. Returns the number of rows deleted. */
  async function purgeDeadLetterJobs(): Promise<number> {
    const { changes } = driver.query(`DELETE FROM ${TABLE} WHERE status='dead'`, []);
    return changes;
  }

  function claimNextWhere(
    now: number,
    priorityPredicate: string,
    extra?: { sql: string; params: readonly unknown[] },
    priorityFloor = FOREGROUND_QUEUE_PRIORITY_FLOOR,
  ): JobRow | null {
    const extraSql = extra ? ` AND ${extra.sql}` : "";
    const { rows } = driver.query(
      `SELECT candidate.id, candidate.payload, candidate.attempts, candidate.job_key, candidate.priority, candidate.created_at
         FROM ${TABLE} AS candidate
        WHERE candidate.status='pending' AND candidate.run_after<=? AND ${priorityPredicate}${extraSql}
          AND (
            candidate.job_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM ${TABLE} AS processing
               WHERE processing.status='processing' AND processing.job_key=candidate.job_key
            )
          )
        ORDER BY candidate.priority DESC, candidate.claim_sort_key, candidate.run_after, candidate.id
        LIMIT 1`,
      [now, priorityFloor, ...(extra?.params ?? [])],
    );
    const row = rows[0] as JobRow | undefined;
    if (!row) return null;
    const { changes } = driver.query(
      `UPDATE ${TABLE} SET status='processing', run_after=? WHERE id=? AND status='pending'`,
      [now, row.id],
    );
    /* v8 ignore next */ // the no-rows branch is a multi-writer guard; unreachable in the single-process model
    return changes ? row : null;
  }

  async function processOne(): Promise<boolean> {
    const recovered = reclaimExpiredProcessingJobs(
      driver,
      processingTimeoutMs,
      activeJobIds,
    );
    if (recovered) {
      recordQueueMetric(driver, "loopover_jobs_recovered_total", recovered);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "selfhost_queue_processing_reclaimed",
          count: recovered,
          timeout_ms: processingTimeoutMs,
        }),
      );
      capturePostHogError(new Error("self-host queue processing lease expired"), {
        kind: "job_recovered",
        reason: "processing_timeout",
        recovered,
        timeoutMs: processingTimeoutMs,
      }, "processing_timeout");
    }
    const job = claimNext();
    if (!job) return false;
    activeJobIds.add(job.id);
    const claimedAt = Date.now();
    try {
      let message: JobMessage;
      try {
        message = JSON.parse(job.payload) as JobMessage;
      } catch {
        driver.query(
          `UPDATE ${TABLE} SET status='dead', attempts=attempts+1, last_error='unparseable payload', dead_at=? WHERE id=?`,
          [Date.now(), job.id],
        );
        recordQueueMetric(driver, "loopover_jobs_dead_total");
        logAudit({
          event: "job_dead",
          ts: Date.now(),
          job_id: job.id,
          latency_ms: Date.now() - claimedAt,
          attempts: job.attempts + 1,
          error: "unparseable payload",
        });
        capturePostHogError(new Error("unparseable queue payload"), {
          kind: "job_dead",
          reason: "unparseable_payload",
          jobId: job.id,
        }, "unparseable_payload");
        return true;
      }
      const jobTraceParent = message.type === "github-webhook" ? message.traceParent : undefined;
      const payloadContext = extractPayloadContext(job.payload);
      const rateLimitAdmission = rateLimitAdmissionDelayMs(driver, message);
      if (rateLimitAdmission !== null) {
        const rateLimitMetric = githubRateLimitMetricContext(message, rateLimitAdmission);
        await withReviewSpan(
          "selfhost.queue.admission_deferred",
          {
            "job.type": message.type,
            "queue.backend": "sqlite",
            ...rateLimitMetric.spanAttributes,
          },
          async () => {
            const now = Date.now();
            const retryAfter = now + rateLimitRetryDelayWithJitter(
              rateLimitAdmission.delayMs,
              `${job.job_key ?? ""}:${job.id}:${job.payload}`,
            );
            const lastError = `github rate-limit ${rateLimitAdmission.kind} admission`;
            const { changes } = driver.query(
              `UPDATE ${TABLE} SET status='pending', run_after=max(run_after, ?), last_error=coalesce(last_error, ?), deferred_by=coalesce(deferred_by, 'rate_limit') WHERE id=?`,
              [retryAfter, lastError, job.id],
            );
            if (changes) {
              recordQueueMetric(driver, "loopover_jobs_rate_limit_deferred_total");
              incr("loopover_jobs_rate_limit_admission_deferred_total", rateLimitMetric.labels);
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
      if (!isForegroundJobPriority(job.priority) && isMaintenanceJobType(message.type)) {
        const decision = evaluateMaintenanceAdmission(
          getMaintenancePressureSignals(Date.now()),
          maintenanceAdmissionConfig,
          job.created_at,
          Date.now(),
        );
        if (!decision.admit) {
          await withReviewSpan(
            "selfhost.queue.maintenance_admission_deferred",
            { "job.type": message.type, "queue.backend": "sqlite", "maintenance_admission.reason": decision.reason },
            async () => {
              const now = Date.now();
              const retryAfter = now + maintenanceAdmissionDeferMs(
                maintenanceAdmissionConfig,
                `${job.job_key ?? ""}:${job.id}:${job.payload}`,
              );
              const { changes } = driver.query(
                `UPDATE ${TABLE} SET status='pending', run_after=max(run_after, ?), last_error=coalesce(last_error, ?), deferred_by=coalesce(deferred_by, 'maintenance_admission') WHERE id=?`,
                [retryAfter, `maintenance admission deferred: ${decision.reason}`, job.id],
              );
              if (changes) {
                recordQueueMetric(driver, "loopover_jobs_maintenance_admission_deferred_total");
                incr("loopover_jobs_maintenance_admission_deferred_by_reason_total", {
                  reason: decision.reason,
                  job_type: message.type,
                });
                console.log(
                  JSON.stringify({
                    level: "info",
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
          recordQueueMetric(driver, "loopover_jobs_maintenance_trickle_admitted_total");
          incr("loopover_jobs_maintenance_trickle_admitted_by_type_total", { job_type: message.type });
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "selfhost_queue_maintenance_trickle_admitted",
              jobType: message.type,
              pending_ms: Date.now() - job.created_at,
            }),
          );
        }
        // Broader force-admitted-under-pressure signal (#selfhost-maintenance-self-pin): covers trickle_max_defer_age
        // above PLUS maintenance_pending_high_drain (the new scoped drain escape this PR adds) under one counter,
        // so an operator can trend "how often does pressure admission get overridden at all" without needing to
        // sum multiple per-reason metrics.
        if (isMaintenanceAdmissionGrantedUnderPressure(decision.reason)) {
          incr("loopover_jobs_maintenance_admission_granted_under_pressure_total", {
            reason: decision.reason,
            job_type: message.type,
          });
        }
      }
      // Per-installation GitHub-fetch concurrency admission (#selfhost-installation-concurrency), the last-mile
      // gate: only reached by a job that already passed rate-limit admission and (if applicable) maintenance-
      // lane admission above, immediately before it actually claims a dispatch slot. installationConcurrencyKeyForJob
      // already excludes the truly-foreground agent-regate-pr job type by construction (not by priority -- see its
      // own doc comment for why agent-regate-sweep's priority-8/floor-8 collision rules out a priority-based
      // guard here). installationConcurrencyKey is null for background jobs whose payload carries no resolvable
      // installationId too -- those fall through unaffected.
      const installationConcurrencyKey = installationConcurrencyKeyForJob(message);
      if (installationConcurrencyKey) {
        const decision = evaluateInstallationConcurrencyAdmission(
          installationConcurrencyConfig,
          installationConcurrencyTracker.currentCount(installationConcurrencyKey),
        );
        if (!decision.admit) {
          await withReviewSpan(
            "selfhost.queue.installation_concurrency_deferred",
            { "job.type": message.type, "queue.backend": "sqlite", "installation_concurrency.reason": decision.reason },
            async () => {
              const now = Date.now();
              const retryAfter = now + installationConcurrencyDeferMs(
                installationConcurrencyConfig,
                `${job.job_key ?? ""}:${job.id}:${job.payload}`,
              );
              const { changes } = driver.query(
                `UPDATE ${TABLE} SET status='pending', run_after=max(run_after, ?), last_error=coalesce(last_error, ?), deferred_by=coalesce(deferred_by, 'installation_concurrency') WHERE id=?`,
                [retryAfter, `installation concurrency admission deferred: ${decision.reason}`, job.id],
              );
              if (changes) {
                recordQueueMetric(driver, "loopover_jobs_installation_concurrency_deferred_total");
                incr("loopover_jobs_installation_concurrency_deferred_by_reason_total", {
                  reason: decision.reason,
                  job_type: message.type,
                });
                console.warn(
                  JSON.stringify({
                    level: "warn",
                    event: "selfhost_queue_installation_concurrency_deferred",
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
        installationConcurrencyTracker.increment(installationConcurrencyKey);
        job.installationConcurrencyKey = installationConcurrencyKey;
      }
      try {
        await withReviewSpan(
          "selfhost.queue.job",
          { "job.type": message.type, "queue.backend": "sqlite", "job.attempt": job.attempts + 1 },
          () => consume(message),
          { parentTraceParent: message.type === "github-webhook" ? message.traceParent : undefined },
        );
        driver.query(`DELETE FROM ${TABLE} WHERE id=?`, [job.id]);
        recordQueueMetric(driver, "loopover_jobs_processed_total");
        logAudit({
          event: "job_complete",
          ts: Date.now(),
          job_id: job.id,
          payload_type: extractPayloadType(job.payload),
          ...payloadContext,
          latency_ms: Date.now() - claimedAt,
          attempts: job.attempts + 1,
        }, jobTraceParent);
      } catch (error) {
        const attempts = job.attempts + 1;
        const errMsg = errorMessageWithCause(error);
        // #9465: parity with the pg backend -- lock contention re-pends WITHOUT consuming an attempt, so a
        // waiter cannot die after ~25s against a lock legitimately held for minutes. Bounded by job age so a
        // wedged lock still converges to a dead job.
        if (isAttemptFreeRetry(error) && Date.now() - job.created_at < ATTEMPT_FREE_RETRY_DEADLINE_MS) {
          const retryDelayMs = consumingRetryDelayMs(error, backoff(attempts));
          driver.query(
            `UPDATE ${TABLE} SET status='pending', run_after=?, last_error=?, deferred_by='lock_contended' WHERE id=?`,
            [Date.now() + retryDelayMs, errMsg, job.id],
          );
          recordQueueMetric(driver, "loopover_jobs_lock_contended_deferred_total");
          logAudit({
            event: "job_lock_contended",
            ts: Date.now(),
            job_id: job.id,
            payload_type: extractPayloadType(job.payload),
            ...payloadContext,
            latency_ms: Date.now() - claimedAt,
            attempts: job.attempts,
            retry_after_ms: retryDelayMs,
            error: errMsg,
          }, jobTraceParent);
          return true;
        }
        const rateLimitDelayMs = githubRateLimitRetryDelayMs(error);
        if (rateLimitDelayMs !== null) {
          const now = Date.now();
          const retryAfter = now + rateLimitRetryDelayWithJitter(rateLimitDelayMs, `${job.job_key ?? ""}:${job.id}:${job.payload}`);
          const target = githubRateLimitAdmissionTargetForJob(message);
          const deferred = target ? deferPendingJobsForRateLimit(driver, rateLimitDelayMs, now, target) : 0;
          const rateLimitMetric = githubRateLimitMetricContext(message, target);
          if (target !== null && deferred > 0) {
            recordQueueMetric(driver, "loopover_jobs_rate_limit_deferred_total", deferred);
            incr("loopover_jobs_rate_limit_budget_deferred_total", rateLimitMetric.labels, deferred);
            console.warn(
              JSON.stringify({
                level: "warn",
                event: "selfhost_queue_rate_limit_budget_deferred",
                ...rateLimitMetric.logFields,
                deferred,
              }),
            );
          }
          if (job.job_key && mergeRescheduledJobIntoPending(driver, job as JobRow & { job_key: string }, retryAfter, errMsg)) {
            recordQueueMetric(driver, "loopover_jobs_coalesced_total");
          } else {
            driver.query(
              `UPDATE ${TABLE} SET status='pending', run_after=?, last_error=?, deferred_by='rate_limit' WHERE id=?`,
              [retryAfter, errMsg, job.id],
            );
          }
          recordQueueMetric(driver, "loopover_jobs_rate_limited_total");
          incr("loopover_jobs_rate_limited_by_type_total", rateLimitMetric.labels);
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
        recordQueueMetric(driver, "loopover_jobs_failed_total");
        if (attempts >= maxRetries) {
          driver.query(
            `UPDATE ${TABLE} SET status='dead', attempts=?, last_error=?, dead_at=? WHERE id=?`,
            [attempts, errMsg, Date.now(), job.id],
          );
          recordQueueMetric(driver, "loopover_jobs_dead_total");
          recordReviewAuditDeadLetter(driver, job.payload, errMsg);
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
          capturePostHogError(error, {
            kind: "job_dead",
            reason: "max_retries_exhausted",
            jobType: extractPayloadType(job.payload),
            jobId: job.id,
            attempts,
          }, "job_dead");
        } else {
          const retryDelayMs = consumingRetryDelayMs(error, backoff(attempts));
          driver.query(
            `UPDATE ${TABLE} SET status='pending', attempts=?, run_after=?, last_error=? WHERE id=?`,
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
      if (job.installationConcurrencyKey) installationConcurrencyTracker.decrement(job.installationConcurrencyKey);
    }
  }

  // Drains every job that is currently DUE. A retry is rescheduled into the future (run_after > now) so it is
  // not re-claimed here — the next poll tick picks it up — which also bounds this loop. Up to `concurrency`
  // pump loops may run simultaneously (each claims its own job row, atomic under node:sqlite's serial writes).
  async function pump(): Promise<void> {
    if (active >= concurrency) return;
    active++;
    try {
      // #9007: `shuttingDown` is re-checked on every iteration (not just at pump() entry) so that stop() --
      // which sets it synchronously, before its own `while (active > 0)` wait -- actually bounds this loop to
      // the job already in flight. Without this guard, a pump already draining due work keeps calling
      // processOne() for as long as more due jobs exist, entirely blind to a concurrent stop(): shutdown then
      // waits for the WHOLE backlog to drain rather than for in-flight work to finish, so under sustained load
      // stop() never returns before the container's SIGKILL grace period expires -- the root cause of every
      // review pass severed mid-flight by a deploy.
      while (!shuttingDown && (await processOne())) {
        /* keep draining due jobs, but stop as soon as shutdown begins */
      }
    } catch (error) {
      // claimNext()/reclaimExpiredProcessingJobs() run OUTSIDE processOne's own try/finally, so a raw driver
      // failure (e.g. a transient SQLite error) lands here. Every `void pump()` call site (kickOne/kickAll) is
      // fire-and-forget, so an uncaught rejection here would surface as an unhandled promise rejection — fatal
      // when POSTHOG_API_KEY is unset (initPostHog's enableExceptionAutocapture only installs a handler when
      // PostHog is configured) (#2498).
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_queue_pump_crashed",
          error: errorMessageWithCause(error),
        }),
      );
      capturePostHogError(error, { kind: "queue_pump_crashed" }, "queue_pump_crashed");
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
      enqueue(message, options?.delaySeconds ?? 0);
    },
    async sendBatch(
      messages: Iterable<{ body: JobMessage; delaySeconds?: number }>,
    ): Promise<void> {
      for (const m of messages) enqueue(m.body, m.delaySeconds ?? 0);
    },
    async snapshot() {
      return buildSelfHostQueueSnapshot(
        driver.query(
          `SELECT payload, status, run_after FROM ${TABLE} WHERE status IN ('pending','processing','dead')`,
          [],
        ).rows as Array<{ payload: string; status: string; run_after: number }>,
      );
    },
    deadCount,
    listDeadLetterJobs,
    replayDeadLetterJob,
    deleteDeadLetterJob,
    purgeDeadLetterJobs,
  } as unknown as Queue & {
    snapshot(): Promise<SelfHostQueueSnapshot>;
    deadCount(): Promise<number>;
    listDeadLetterJobs(limit: number, offset: number): Promise<DeadLetterJob[]>;
    replayDeadLetterJob(id: number): Promise<boolean>;
    deleteDeadLetterJob(id: number): Promise<boolean>;
    purgeDeadLetterJobs(): Promise<number>;
  };

  return {
    binding,
    // Every setup step (DDL, column backfills, crash recovery, startup jitter, the foreground-liveness
    // self-heal above) already ran SYNCHRONOUSLY above, inline in createSqliteQueue() itself -- node:sqlite
    // has no connection to await, so by the time this object is returned there is nothing left to do. init()
    // exists purely so callers that treat both queue backends uniformly (`await createXQueue(...).init()`,
    // see server.ts's Postgres branch) get correct behavior regardless of which backend is active (#4010).
    async init(): Promise<void> {
      /* no-op: see comment above */
    },
    start() {
      if (running) return;
      running = true;
      shuttingDown = false; // #9007: a stop()-then-restart cycle claims fresh again
      const tick = (): void => {
        /* v8 ignore next */ // stop() clears the timer, so a tick never fires with running=false
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
      foregroundLivenessTimer = setInterval(() => void releaseStaleForegroundDeferralsSafely(), foregroundLivenessConfig.checkIntervalMs);
    },
    async stop() {
      // #9007: set BEFORE the drain-wait below (and before `running = false`) so any pump loop still actively
      // draining due work sees it on its very next iteration and stops claiming new jobs immediately, rather
      // than continuing to drain the whole backlog while this wait loop sits idle.
      shuttingDown = true;
      running = false;
      if (timer) clearTimeout(timer);
      if (deadLetterReviveTimer) clearInterval(deadLetterReviveTimer);
      if (foregroundLivenessTimer) clearInterval(foregroundLivenessTimer);
      while (active > 0) await new Promise((r) => setTimeout(r, 10)); // let in-flight pumps finish
    },
    async drain() {
      // send() fire-and-forgets a pump; wait for any in-flight pumps to settle, then drain to completion.
      while (active > 0) await new Promise((r) => setTimeout(r, 5));
      await pump();
    },
    async size() {
      return Number(
        (
          driver.query(
            `SELECT COUNT(*) AS c FROM ${TABLE} WHERE status IN ('pending','processing')`,
            [],
          ).rows[0] as { c: number }
        ).c,
      );
    },
    deadCount,
    recentDeadCount,
    async processingCount() {
      return Number(
        (
          driver.query(
            `SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='processing'`,
            [],
          ).rows[0] as { c: number }
        ).c,
      );
    },
    async stats() {
      return readQueueStats(driver);
    },
    snapshot: binding.snapshot,
    reviveDeadLetterJobs,
    releaseStaleForegroundDeferrals,
    async pressureSignals() {
      return getMaintenancePressureSignals(Date.now());
    },
    topBacklogRepos,
    listDeadLetterJobs,
    replayDeadLetterJob,
    deleteDeadLetterJob,
    purgeDeadLetterJobs,
  };
}

function backfillJobPriorities(driver: SqliteDriver): number {
  const { rows } = driver.query(
    `SELECT id, payload, priority FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    [],
  );
  let changed = 0;
  for (const row of rows as Array<{ id: number; payload: string; priority: number }>) {
    const priority = jobPriority(row.payload);
    if (priority === Number(row.priority)) continue;
    driver.query(`UPDATE ${TABLE} SET priority=? WHERE id=?`, [
      priority,
      row.id,
    ]);
    changed += 1;
  }
  return changed;
}

function backfillJobKeys(driver: SqliteDriver): number {
  const { rows } = driver.query(
    `SELECT id, payload, job_key FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    [],
  );
  let changed = 0;
  for (const row of rows as Array<{ id: number; payload: string; job_key?: string | null }>) {
    const key = jobCoalesceKey(row.payload);
    if ((row.job_key ?? null) === key) continue;
    driver.query(`UPDATE ${TABLE} SET job_key=? WHERE id=?`, [key, row.id]);
    changed += 1;
  }
  return changed;
}

function backfillJobClaimSortKeys(driver: SqliteDriver): number {
  const { rows } = driver.query(
    `SELECT id, payload, run_after, claim_sort_key FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    [],
  );
  let changed = 0;
  for (const row of rows as Array<{ id: number; payload: string; run_after: number; claim_sort_key: number }>) {
    const sortKey = jobClaimSortKey(row.payload, row.run_after);
    if (sortKey === Number(row.claim_sort_key)) continue;
    driver.query(`UPDATE ${TABLE} SET claim_sort_key=? WHERE id=?`, [
      sortKey,
      row.id,
    ]);
    changed += 1;
  }
  return changed;
}

function backfillJobMaintenanceFlags(driver: SqliteDriver): number {
  const { rows } = driver.query(
    `SELECT id, payload, is_maintenance FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    [],
  );
  let changed = 0;
  for (const row of rows as Array<{ id: number; payload: string; is_maintenance: number }>) {
    const isMaintenance = isMaintenanceJobType(extractPayloadType(row.payload) ?? "") ? 1 : 0;
    if (Number(row.is_maintenance) === isMaintenance) continue;
    driver.query(`UPDATE ${TABLE} SET is_maintenance=? WHERE id=?`, [isMaintenance, row.id]);
    changed += 1;
  }
  return changed;
}

function backfillJobForegroundLanes(driver: SqliteDriver): number {
  const { rows } = driver.query(
    `SELECT id, payload, foreground_lane FROM ${TABLE} WHERE status IN ('pending', 'processing')`,
    [],
  );
  let changed = 0;
  for (const row of rows as Array<{ id: number; payload: string; foreground_lane: string | null }>) {
    const type = extractPayloadType(row.payload) ?? "";
    const lane = foregroundLaneForJob(type, row.payload);
    if ((row.foreground_lane ?? null) === lane) continue;
    driver.query(`UPDATE ${TABLE} SET foreground_lane=? WHERE id=?`, [lane, row.id]);
    changed += 1;
  }
  return changed;
}

/** Cheap aggregate reads behind the maintenance-admission policy (and the observability gauges in server.ts):
 *  how much LIVE (foreground) work is queued and how old the oldest of it is -- both overall
 *  (pending+processing) and RUNNABLE right now (pending, due) -- and the same PENDING/oldest pair for the
 *  MAINTENANCE lane specifically (not "all background" -- targeted jobs like backfill-repo-segment don't
 *  count, see maintenance-admission.ts). The runnable-now split is the #selfhost-queue-liveness diagnostic:
 *  distinguishes "queue large but intentionally deferred" from "queue stuck, nothing runnable" without manual
 *  SQL. Host load is an independent, optional signal (see host-pressure.ts). */
function maintenancePressureSignals(driver: SqliteDriver, now: number): MaintenancePressureSignals {
  // runnable_cnt counts a row as genuinely active RIGHT NOW when it's either already 'processing' (real,
  // in-flight resource use) or 'pending' AND due (run_after<=now) -- NOT merely present in the outer
  // pending/processing set, which also includes work deliberately deferred to the future. oldest_runnable is
  // narrower still (#9155): it excludes 'processing' rows entirely, so a normal in-flight job (routinely
  // minutes long) never by itself ages past maxLiveJobAgeMs and trips live_job_age_high -- only a due row
  // that's still WAITING to be claimed counts toward that signal (see maintenance-admission.ts's
  // MaintenancePressureSignals doc comments).
  const live = driver.query(
    `SELECT COUNT(*) as cnt, MIN(created_at) as oldest,
            SUM(CASE WHEN status='processing' OR run_after<=? THEN 1 ELSE 0 END) as runnable_cnt,
            MIN(CASE WHEN status='pending' AND run_after<=? THEN created_at ELSE NULL END) as oldest_runnable
       FROM ${TABLE} WHERE status IN ('pending','processing') AND priority>=?`,
    [now, now, FOREGROUND_QUEUE_PRIORITY_FLOOR],
  ).rows[0] as { cnt: number; oldest: number | null; runnable_cnt: number | null; oldest_runnable: number | null };
  const maintenance = driver.query(
    `SELECT COUNT(*) as cnt, MIN(created_at) as oldest FROM ${TABLE} WHERE status IN ('pending','processing') AND is_maintenance=1`,
    [],
  ).rows[0] as { cnt: number; oldest: number | null };
  const backlogConvergence = driver.query(
    `SELECT COUNT(*) as cnt FROM ${TABLE} WHERE status IN ('pending','processing') AND foreground_lane='backlog'`,
    [],
  ).rows[0] as { cnt: number };
  const freshIntake = driver.query(
    `SELECT COUNT(*) as cnt FROM ${TABLE} WHERE status IN ('pending','processing') AND foreground_lane='fresh'`,
    [],
  ).rows[0] as { cnt: number };
  return {
    livePendingCount: Number(live.cnt),
    oldestLivePendingAgeMs: live.oldest != null ? now - Number(live.oldest) : null,
    liveRunnableNowCount: Number(live.runnable_cnt ?? 0),
    oldestLiveRunnableAgeMs: live.oldest_runnable != null ? now - Number(live.oldest_runnable) : null,
    maintenancePendingCount: Number(maintenance.cnt),
    oldestMaintenancePendingAgeMs: maintenance.oldest != null ? now - Number(maintenance.oldest) : null,
    backlogConvergencePendingCount: Number(backlogConvergence.cnt),
    freshIntakePendingCount: Number(freshIntake.cnt),
    hostLoadAvg1PerCore: hostLoadAvg1PerCore(),
  };
}

function recoverProcessingJobs(driver: SqliteDriver): number {
  const { rows } = driver.query(
    `SELECT id, payload, job_key FROM ${TABLE} WHERE status='processing'`,
    [],
  );
  let changed = 0;
  const now = Date.now();
  const maxJitter = queueRecoveryJitterMs();
  for (const row of rows as Array<{ id: number; payload: string; job_key?: string | null }>) {
    const runAfter = now + deterministicJitterMs(`${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
    driver.query(
      `UPDATE ${TABLE} SET status='pending', run_after=? WHERE id=?`,
      [runAfter, row.id],
    );
    changed += 1;
  }
  return changed;
}

// Dead-letter auto-retry (#audit-rate-headroom): a job dies once `attempts >= maxRetries` (see the
// max-retries branch in processOne below). Reviving it here only clears `status`/`run_after`/`last_error` —
// `attempts` is left untouched, so it already satisfies `attempts >= maxRetries` and will die again after
// exactly ONE more failed attempt, not a fresh full retry budget. The `attempts < ceiling` filter (ceiling =
// maxRetries + the configured extra-attempts budget) is what actually bounds how many times a permanently-
// broken job can be revived before it stops being a candidate here and requires manual intervention.
function reviveEligibleDeadJobs(driver: SqliteDriver, maxRetries: number): number {
  const ceiling = maxRetries + queueDeadLetterAutoRetryMaxExtraAttempts();
  const { rows } = driver.query(
    `SELECT id, payload, job_key FROM ${TABLE} WHERE status='dead' AND attempts<?`,
    [ceiling],
  );
  let revived = 0;
  const now = Date.now();
  const maxJitter = queueRecoveryJitterMs();
  for (const row of rows as Array<{ id: number; payload: string; job_key?: string | null }>) {
    const runAfter = now + deterministicJitterMs(`revive:${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
    // AND status='dead' re-checks the row is STILL dead at UPDATE time (mirrors deferPendingJobsForRateLimit /
    // the processing-lease reclaim below) — the SELECT above is a stale snapshot, and without this predicate an
    // overlapping revive (a slow prior revive tick still running when the next one fires) could flip a row
    // that's already been claimed into 'processing' back to 'pending', letting it run a second time concurrently.
    // `changes` is 0 (not counted as revived) when the row already moved out of 'dead'.
    const { changes } = driver.query(
      `UPDATE ${TABLE} SET status='pending', run_after=?, last_error=NULL, dead_at=NULL WHERE id=? AND status='dead'`,
      [runAfter, row.id],
    );
    revived += changes;
  }
  return revived;
}

function spreadDueJobsOnStartup(driver: SqliteDriver): number {
  const now = Date.now();
  const { rows } = driver.query(
    `SELECT id, payload, job_key FROM ${TABLE} WHERE status='pending' AND run_after<=?`,
    [now],
  );
  const due = rows as Array<{ id: number; payload: string; job_key?: string | null }>;
  if (due.length < queueStartupJitterMinJobs()) return 0;
  const maxJitter = queueStartupJitterMs();
  if (maxJitter <= 0) return 0;
  for (const row of due) {
    const runAfter = now + deterministicJitterMs(`${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
    driver.query(`UPDATE ${TABLE} SET run_after=? WHERE id=?`, [runAfter, row.id]);
  }
  return due.length;
}

function deferPendingJobsForRateLimit(
  driver: SqliteDriver,
  delayMs: number,
  now: number,
  blocked: GitHubRateLimitAdmissionTarget,
): number {
  const { rows } = driver.query(
    `SELECT id, payload, job_key FROM ${TABLE} WHERE status='pending' AND run_after<=?`,
    [now + delayMs],
  );
  let changed = 0;
  for (const row of rows as Array<{ id: number; payload: string; job_key?: string | null }>) {
    let candidate: GitHubRateLimitAdmissionTarget | null = null;
    try {
      candidate = githubRateLimitAdmissionTargetForJob(JSON.parse(row.payload) as JobMessage);
    } catch {
      candidate = null;
    }
    if (!matchesGitHubRateLimitAdmissionTarget(candidate, blocked)) continue;
    const runAfter = now + rateLimitRetryDelayWithJitter(delayMs, `${row.job_key ?? ""}:${row.id}:${row.payload}`);
    const { changes } = driver.query(
      `UPDATE ${TABLE} SET run_after=max(run_after, ?), last_error=coalesce(last_error, ?), deferred_by=coalesce(deferred_by, 'rate_limit') WHERE id=? AND status='pending'`,
      [runAfter, "github rate-limit budget deferred", row.id],
    );
    changed += changes;
  }
  return changed;
}

function rateLimitAdmissionDelayMs(
  driver: SqliteDriver,
  message: JobMessage,
): (GitHubRateLimitAdmissionTarget & { delayMs: number }) | null {
  const target = githubRateLimitAdmissionTargetForJob(message);
  if (target === null) return null;
  try {
    const rows = driver.query(
      `WITH exact_observation AS (
        SELECT admission_key, remaining, reset_at, observed_at FROM github_rate_limit_observations
          WHERE resource='rest' AND remaining IS NOT NULL AND ? IS NOT NULL AND admission_key=?
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
      [target.admissionKey, target.admissionKey],
    ).rows as Array<{ admission_key?: string | null; remaining?: number | null; reset_at?: string | null; observed_at?: string | null }>;
    const delayMs = githubRateLimitAdmissionDelayMs(target.kind, target.admissionKey, rows);
    return delayMs === null ? null : { ...target, delayMs };
  } catch {
    return null;
  }
}

function reclaimExpiredProcessingJobs(
  driver: SqliteDriver,
  timeoutMs: number,
  activeJobIds: Set<number>,
): number {
  if (timeoutMs <= 0) return 0;
  const now = Date.now();
  const cutoff = now - timeoutMs;
  const { rows } = driver.query(
    `SELECT id, payload, job_key FROM ${TABLE} WHERE status='processing' AND run_after<=?`,
    [cutoff],
  );
  let changed = 0;
  const maxJitter = queueRecoveryJitterMs();
  for (const row of rows as Array<{ id: number; payload: string; job_key?: string | null }>) {
    if (activeJobIds.has(row.id)) continue;
    const runAfter = now + deterministicJitterMs(`${row.job_key ?? ""}:${row.id}:${row.payload}`, maxJitter);
    const { changes } = driver.query(
      `UPDATE ${TABLE} SET status='pending', run_after=?, last_error=coalesce(last_error, ?) WHERE id=? AND status='processing'`,
      [runAfter, "processing lease expired; requeued", row.id],
    );
    changed += changes;
  }
  return changed;
}

function mergeRescheduledJobIntoPending(
  driver: SqliteDriver,
  job: JobRow & { job_key: string },
  runAfter: number,
  errMsg: string,
): boolean {
  const existing = driver.query(
    `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=? AND id<>? ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
    [job.job_key, job.id],
  ).rows[0] as { id: number } | undefined;
  if (!existing) return false;
  driver.query(
    `UPDATE ${TABLE} SET run_after=max(run_after, ?), last_error=?, deferred_by=coalesce(deferred_by, 'rate_limit') WHERE id=?`,
    [runAfter, errMsg, existing.id],
  );
  driver.query(`DELETE FROM ${TABLE} WHERE id=?`, [job.id]);
  return true;
}

function recordQueueMetric(driver: SqliteDriver, name: string, by = 1): void {
  incr(name, undefined, by);
  driver.query(
    `INSERT INTO ${STATS_TABLE} (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value=value+?`,
    [name, by, by],
  );
}

function readQueueStats(driver: SqliteDriver): Record<string, number> {
  const { rows } = driver.query(`SELECT name, value FROM ${STATS_TABLE}`, []);
  return Object.fromEntries(
    (rows as Array<{ name: string; value: number }>).map((row) => [
      row.name,
      Number(row.value),
    ]),
  );
}
