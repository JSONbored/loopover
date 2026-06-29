// Durable, SQLite-backed job queue for the self-host runtime (#980 reliability). Unlike the in-process FIFO,
// jobs are PERSISTED — a restart (or crash) re-claims anything left in flight instead of losing it. It still
// presents the Cloudflare `Queue` binding surface (send / sendBatch) so the app code is unchanged; only the
// backing store differs. Single-process model: node:sqlite is synchronous + serial, so claim (SELECT→UPDATE)
// is atomic with no row-lock dance.
import type { SqliteDriver } from "./d1-adapter";
import { logAudit, extractPayloadType } from "./audit";
import { incr } from "./metrics";
import { captureError } from "./sentry";
import {
  deterministicJitterMs,
  githubRateLimitRetryDelayMs,
  jobCoalesceKey,
  jobPriority,
  nonConsumingRetryDelayMs,
  queueRecoveryJitterMs,
  queueStartupJitterMinJobs,
  queueStartupJitterMs,
  rateLimitRetryDelayWithJitter,
} from "./queue-common";
import type { JobMessage } from "../types";

const TABLE = "_selfhost_jobs";
const STATS_TABLE = "_selfhost_job_stats";
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
  job_key TEXT
);`;
const STATS_DDL = `
CREATE TABLE IF NOT EXISTS ${STATS_TABLE} (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);`;
const CLAIM_INDEX_DDL = `
DROP INDEX IF EXISTS ${TABLE}_claim;
CREATE INDEX ${TABLE}_claim ON ${TABLE}(status, run_after, priority);`;
const JOB_KEY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS ${TABLE}_pending_job_key ON ${TABLE}(job_key, status);`;

export interface DurableQueue {
  binding: Queue;
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  size(): number;
  deadCount(): number;
  stats(): Record<string, number>;
}

interface JobRow {
  id: number;
  payload: string;
  attempts: number;
  job_key?: string | null;
}

export interface SqliteQueueOptions {
  maxRetries?: number;
  pollIntervalMs?: number;
  backoffMs?: (attempt: number) => number;
  /** Max concurrent `processOne()` loops. Defaults to QUEUE_CONCURRENCY env var or 4 — review jobs are I/O-bound
   *  (GitHub + AI awaits dominate), so overlapping a handful drains a PR burst far faster while SQLite's WAL +
   *  busy_timeout absorb the short serialized write windows. Set QUEUE_CONCURRENCY=1 to force strict serial. */
  concurrency?: number;
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
    Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? "4"));

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
  driver.exec(CLAIM_INDEX_DDL);
  driver.exec(JOB_KEY_INDEX_DDL);
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
  // Recover jobs a crashed previous run left mid-flight → make them claimable again.
  const recovered = recoverProcessingJobs(driver);
  if (recovered)
    console.log(
      JSON.stringify({ event: "selfhost_queue_recovered", count: recovered }),
    );
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
  let active = 0; // number of concurrent pump() loops currently draining jobs
  let timer: ReturnType<typeof setTimeout> | null = null;
  let githubRateLimitCooldownUntil = 0;

  function enqueue(message: JobMessage, delaySeconds: number): void {
    const now = Date.now();
    const payload = JSON.stringify(message);
    const runAfter = now + delaySeconds * 1000;
    const priority = jobPriority(payload);
    const key = jobCoalesceKey(payload);
    if (key) {
      const existing = driver.query(
        `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=? ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
        [key],
      ).rows[0] as { id: number } | undefined;
      if (existing) {
        driver.query(
          `UPDATE ${TABLE}
             SET payload=?, run_after=max(run_after, ?), created_at=?, priority=max(priority, ?), last_error=NULL
           WHERE id=?`,
          [payload, runAfter, now, priority, existing.id],
        );
        recordQueueMetric(driver, "gittensory_jobs_coalesced_total");
        void pump();
        return;
      }
    }
    driver.query(
      `INSERT INTO ${TABLE} (payload, status, attempts, run_after, created_at, priority, job_key) VALUES (?, 'pending', 0, ?, ?, ?, ?)`,
      [payload, runAfter, now, priority, key],
    );
    recordQueueMetric(driver, "gittensory_jobs_enqueued_total");
    void pump();
  }

  function claimNext(): JobRow | null {
    if (Date.now() < githubRateLimitCooldownUntil) return null;
    const { rows } = driver.query(
      `SELECT id, payload, attempts, job_key FROM ${TABLE} WHERE status='pending' AND run_after<=? ORDER BY priority DESC, run_after, id LIMIT 1`,
      [Date.now()],
    );
    const row = rows[0] as JobRow | undefined;
    if (!row) return null;
    const { changes } = driver.query(
      `UPDATE ${TABLE} SET status='processing' WHERE id=? AND status='pending'`,
      [row.id],
    );
    /* v8 ignore next */ // the no-rows branch is a multi-writer guard; unreachable in the single-process model
    return changes ? row : null;
  }

  async function processOne(): Promise<boolean> {
    const job = claimNext();
    if (!job) return false;
    const claimedAt = Date.now();
    let message: JobMessage;
    try {
      message = JSON.parse(job.payload) as JobMessage;
    } catch {
      driver.query(
        `UPDATE ${TABLE} SET status='dead', last_error='unparseable payload' WHERE id=?`,
        [job.id],
      );
      recordQueueMetric(driver, "gittensory_jobs_dead_total");
      logAudit({
        event: "job_dead",
        ts: Date.now(),
        job_id: job.id,
        latency_ms: Date.now() - claimedAt,
        attempts: job.attempts + 1,
        error: "unparseable payload",
      });
      captureError(new Error("unparseable queue payload"), {
        kind: "job_dead",
        reason: "unparseable_payload",
        jobId: job.id,
      });
      return true;
    }
    try {
      await consume(message);
      driver.query(`DELETE FROM ${TABLE} WHERE id=?`, [job.id]);
      recordQueueMetric(driver, "gittensory_jobs_processed_total");
      logAudit({
        event: "job_complete",
        ts: Date.now(),
        job_id: job.id,
        payload_type: extractPayloadType(job.payload),
        latency_ms: Date.now() - claimedAt,
        attempts: job.attempts + 1,
      });
    } catch (error) {
      const attempts = job.attempts + 1;
      const errMsg = error instanceof Error ? error.message : "unknown error";
      const nonConsumingDelayMs = nonConsumingRetryDelayMs(error);
      if (nonConsumingDelayMs !== null) {
        const rateLimited = githubRateLimitRetryDelayMs(error) !== null;
        const now = Date.now();
        const retryAfter = now + (rateLimited ? rateLimitRetryDelayWithJitter(nonConsumingDelayMs, `${job.job_key ?? ""}:${job.id}:${job.payload}`) : nonConsumingDelayMs);
        if (rateLimited) {
          githubRateLimitCooldownUntil = Math.max(githubRateLimitCooldownUntil, now + nonConsumingDelayMs);
          const deferred = deferPendingJobsForRateLimit(driver, nonConsumingDelayMs, now);
          if (deferred) {
            recordQueueMetric(driver, "gittensory_jobs_rate_limit_deferred_total", deferred);
            console.warn(
              JSON.stringify({
                level: "warn",
                event: "selfhost_queue_rate_limit_cooldown",
                deferred,
                cooldown_until: githubRateLimitCooldownUntil,
              }),
            );
          }
        }
        if (job.job_key && mergeRescheduledJobIntoPending(driver, job, retryAfter, errMsg)) {
          recordQueueMetric(driver, "gittensory_jobs_coalesced_total");
        } else {
          driver.query(
            `UPDATE ${TABLE} SET status='pending', run_after=?, last_error=? WHERE id=?`,
            [retryAfter, errMsg, job.id],
          );
        }
        recordQueueMetric(driver, rateLimited ? "gittensory_jobs_rate_limited_total" : "gittensory_jobs_deferred_total");
        logAudit({
          event: "job_rate_limited",
          ts: Date.now(),
          job_id: job.id,
          payload_type: extractPayloadType(job.payload),
          latency_ms: Date.now() - claimedAt,
          attempts,
          retry_after_ms: Math.max(0, retryAfter - Date.now()),
          error: errMsg,
        });
        return true;
      }
      recordQueueMetric(driver, "gittensory_jobs_failed_total");
      if (attempts >= maxRetries) {
        driver.query(
          `UPDATE ${TABLE} SET status='dead', attempts=?, last_error=? WHERE id=?`,
          [attempts, errMsg, job.id],
        );
        recordQueueMetric(driver, "gittensory_jobs_dead_total");
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
          latency_ms: Date.now() - claimedAt,
          attempts,
          error: errMsg,
        });
        captureError(error, {
          kind: "job_dead",
          reason: "max_retries_exhausted",
          jobType: extractPayloadType(job.payload),
          jobId: job.id,
          attempts,
        });
      } else {
        driver.query(
          `UPDATE ${TABLE} SET status='pending', attempts=?, run_after=?, last_error=? WHERE id=?`,
          [attempts, Date.now() + backoff(attempts), errMsg, job.id],
        );
        logAudit({
          event: "job_error",
          ts: Date.now(),
          job_id: job.id,
          payload_type: extractPayloadType(job.payload),
          latency_ms: Date.now() - claimedAt,
          attempts,
          error: errMsg,
        });
      }
    }
    return true;
  }

  // Drains every job that is currently DUE. A retry is rescheduled into the future (run_after > now) so it is
  // not re-claimed here — the next poll tick picks it up — which also bounds this loop. Up to `concurrency`
  // pump loops may run simultaneously (each claims its own job row, atomic under node:sqlite's serial writes).
  async function pump(): Promise<void> {
    if (active >= concurrency) return;
    active++;
    try {
      while (await processOne()) {
        /* keep draining due jobs */
      }
    } finally {
      active--;
    }
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
  } as unknown as Queue;

  return {
    binding,
    start() {
      if (running) return;
      running = true;
      const tick = (): void => {
        /* v8 ignore next */ // stop() clears the timer, so a tick never fires with running=false
        if (!running) return;
        void pump().finally(() => {
          if (running) timer = setTimeout(tick, pollIntervalMs);
        });
      };
      tick();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      while (active > 0) await new Promise((r) => setTimeout(r, 10)); // let in-flight pumps finish
    },
    async drain() {
      // send() fire-and-forgets a pump; wait for any in-flight pumps to settle, then drain to completion.
      while (active > 0) await new Promise((r) => setTimeout(r, 5));
      await pump();
    },
    size() {
      return Number(
        (
          driver.query(
            `SELECT COUNT(*) AS c FROM ${TABLE} WHERE status IN ('pending','processing')`,
            [],
          ).rows[0] as { c: number }
        ).c,
      );
    },
    deadCount() {
      return Number(
        (
          driver.query(
            `SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='dead'`,
            [],
          ).rows[0] as { c: number }
        ).c,
      );
    },
    stats() {
      return readQueueStats(driver);
    },
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
    if (priority === Number(row.priority ?? 0)) continue;
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
): number {
  const { rows } = driver.query(
    `SELECT id, payload, job_key FROM ${TABLE} WHERE status='pending' AND run_after<=?`,
    [now + delayMs],
  );
  let changed = 0;
  for (const row of rows as Array<{ id: number; payload: string; job_key?: string | null }>) {
    const runAfter = now + rateLimitRetryDelayWithJitter(delayMs, `${row.job_key ?? ""}:${row.id}:${row.payload}`);
    const { changes } = driver.query(
      `UPDATE ${TABLE} SET run_after=max(run_after, ?), last_error=coalesce(last_error, ?) WHERE id=? AND status='pending'`,
      [runAfter, "github rate-limit cooldown", row.id],
    );
    changed += changes;
  }
  return changed;
}

function mergeRescheduledJobIntoPending(
  driver: SqliteDriver,
  job: JobRow,
  runAfter: number,
  errMsg: string,
): boolean {
  if (!job.job_key) return false;
  const existing = driver.query(
    `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=? AND id<>? ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
    [job.job_key, job.id],
  ).rows[0] as { id: number } | undefined;
  if (!existing) return false;
  driver.query(
    `UPDATE ${TABLE} SET run_after=max(run_after, ?), last_error=? WHERE id=?`,
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
      Number(row.value ?? 0),
    ]),
  );
}
