// Postgres-backed durable job queue for multi-instance self-host (#977). Same contract as the SQLite queue
// (persist → restart re-claims, backoff retries, dead-letter) but uses `FOR UPDATE SKIP LOCKED` so multiple
// app instances sharing one Postgres can claim jobs concurrently without double-processing. size()/deadCount()
// are async (the metrics gauges accept async samplers).
import type { Pool } from "pg";
import { logAudit, extractPayloadType } from "./audit";
import { incr } from "./metrics";
import { withReviewSpan } from "./tracing";
import { withOtelSpan } from "./otel";
import { captureError } from "./sentry";
import {
  consumingRetryDelayMs,
  deterministicJitterMs,
  FOREGROUND_QUEUE_PRIORITY_FLOOR,
  githubRateLimitAdmissionDelayMs,
  githubRateLimitAdmissionTargetForJob,
  githubRateLimitMetricContext,
  githubRateLimitRetryDelayMs,
  buildSelfHostQueueSnapshot,
  jobCoalesceKey,
  jobPriority,
  queueBackgroundConcurrency,
  queueProcessingTimeoutMs,
  queueRecoveryJitterMs,
  queueStartupJitterMinJobs,
  queueStartupJitterMs,
  rateLimitRetryDelayWithJitter,
  matchesGitHubRateLimitAdmissionTarget,
  type GitHubRateLimitAdmissionTarget,
  type SelfHostQueueSnapshot,
} from "./queue-common";
import type { JobMessage } from "../types";

const TABLE = "_selfhost_jobs";
const STATS_TABLE = "_selfhost_job_stats";
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
CREATE INDEX IF NOT EXISTS ${TABLE}_claim ON ${TABLE}(status, run_after, priority);
CREATE INDEX IF NOT EXISTS ${TABLE}_pending_job_key ON ${TABLE}(job_key, status);
CREATE TABLE IF NOT EXISTS ${STATS_TABLE} (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);`;

export interface PgDurableQueue {
  binding: Queue;
  init(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  size(): Promise<number>;
  deadCount(): Promise<number>;
  stats(): Promise<Record<string, number>>;
  snapshot(): Promise<SelfHostQueueSnapshot>;
}

interface JobRow {
  id: string;
  payload: string;
  attempts: number;
  job_key?: string | null;
  priority: number | string;
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
    Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? "4"));
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

  async function init(): Promise<void> {
    await pool.query(DDL);
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
    const runAfter = now + delaySeconds * 1000;
    if (key) {
      const existing = (
        await pool.query(
          `SELECT id FROM ${TABLE} WHERE status='pending' AND job_key=$1 ORDER BY priority DESC, run_after DESC, id LIMIT 1`,
          [key],
        )
      ).rows[0] as { id: string } | undefined;
      if (existing) {
        await pool.query(
          `UPDATE ${TABLE}
             SET payload=$1, run_after=GREATEST(run_after, $2), created_at=$3, priority=GREATEST(priority, $4), last_error=NULL
           WHERE id=$5`,
          [payload, runAfter, now, priority, existing.id],
        );
        await recordQueueMetric("gittensory_jobs_coalesced_total");
        kickOne();
        return;
      }
    }
    await pool.query(
      `INSERT INTO ${TABLE} (payload, status, attempts, run_after, created_at, priority, job_key) VALUES ($1,'pending',0,$2,$3,$4,$5)`,
      [payload, runAfter, now, priority, key],
    );
    await recordQueueMetric("gittensory_jobs_enqueued_total");
    kickOne();
  }

  async function claimNext(): Promise<JobRow | null> {
    const now = Date.now();
    const foreground = await claimNextWhere(now, "priority >= $2");
    if (foreground) return foreground;
    if (activeBackground >= backgroundConcurrency) return null;
    activeBackground++;
    const background = await claimNextWhere(now, "priority < $2");
    if (!background) {
      activeBackground--;
      return null;
    }
    return { ...background, backgroundSlotReserved: true };
  }

  async function claimNextWhere(
    now: number,
    priorityPredicate: string,
  ): Promise<JobRow | null> {
    // Atomic, multi-instance-safe: lock + claim one due job, skipping rows another instance already locked.
    const res = await pool.query(
      `UPDATE ${TABLE} SET status='processing', run_after=$1
       WHERE id = (
         SELECT id
           FROM ${TABLE}
          WHERE status='pending' AND run_after<=$1 AND ${priorityPredicate}
          ORDER BY priority DESC, run_after, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING id, payload, attempts, job_key, priority`,
      [now, FOREGROUND_QUEUE_PRIORITY_FLOOR],
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
            const update = await pool.query(
              `UPDATE ${TABLE} SET status='pending', run_after=GREATEST(run_after, $1), last_error=COALESCE(last_error, $2) WHERE id=$3`,
              [retryAfter, lastError, job.id],
            );
            if (update.rowCount) {
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
      try {
        await withReviewSpan(
          "selfhost.queue.job",
          { "job.type": message.type, "queue.backend": "postgres", "job.attempt": Number(job.attempts) + 1 },
          () => consume(message),
          { parentTraceParent: message.type === "github-webhook" ? message.traceParent : undefined },
        );
        await pool.query(`DELETE FROM ${TABLE} WHERE id=$1`, [job.id]);
        await recordQueueMetric("gittensory_jobs_processed_total");
        logAudit({
          event: "job_complete",
          ts: Date.now(),
          job_id: job.id,
          payload_type: extractPayloadType(job.payload),
          latency_ms: Date.now() - claimedAt,
          attempts: Number(job.attempts) + 1,
        }, jobTraceParent);
      } catch (error) {
        const attempts = Number(job.attempts) + 1;
        const errMsg = error instanceof Error ? error.message : "unknown error";
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
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
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
    async stats() {
      return readQueueStats();
    },
    snapshot: binding.snapshot,
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
