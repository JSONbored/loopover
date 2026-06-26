// Postgres-backed durable job queue for multi-instance self-host (#977). Same contract as the SQLite queue
// (persist → restart re-claims, backoff retries, dead-letter) but uses `FOR UPDATE SKIP LOCKED` so multiple
// app instances sharing one Postgres can claim jobs concurrently without double-processing. size()/deadCount()
// are async (the metrics gauges accept async samplers).
import type { Pool } from "pg";
import { logAudit, extractPayloadType } from "./audit";
import { incr } from "./metrics";
import type { JobMessage } from "../types";

const TABLE = "_selfhost_jobs";
const DDL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id BIGSERIAL PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS ${TABLE}_claim ON ${TABLE}(status, run_after);`;

export interface PgDurableQueue {
  binding: Queue;
  init(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  size(): Promise<number>;
  deadCount(): Promise<number>;
}

interface JobRow {
  id: string;
  payload: string;
  attempts: number;
}

export interface PgQueueOptions {
  maxRetries?: number;
  pollIntervalMs?: number;
  backoffMs?: (attempt: number) => number;
  /** Max concurrent `processOne()` loops. Defaults to QUEUE_CONCURRENCY env var or 4 — review jobs are I/O-bound
   *  (GitHub + AI awaits dominate), so overlapping a handful drains a PR burst far faster; FOR UPDATE SKIP LOCKED
   *  keeps claims race-free across the pool (and across replicas). Set QUEUE_CONCURRENCY=1 to force strict serial. */
  concurrency?: number;
}

export function createPgQueue(pool: Pool, consume: (message: JobMessage) => Promise<void>, opts: PgQueueOptions = {}): PgDurableQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const backoff = opts.backoffMs ?? ((attempt: number) => Math.min(60_000, 1000 * 2 ** attempt));
  const concurrency = opts.concurrency ?? Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? "4"));

  let running = false;
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function init(): Promise<void> {
    await pool.query(DDL);
    const recovered = (await pool.query(`UPDATE ${TABLE} SET status='pending' WHERE status='processing'`)).rowCount ?? 0;
    if (recovered) console.log(JSON.stringify({ event: "selfhost_queue_recovered", count: recovered }));
  }

  async function enqueue(message: JobMessage, delaySeconds: number): Promise<void> {
    const now = Date.now();
    await pool.query(`INSERT INTO ${TABLE} (payload, status, attempts, run_after, created_at) VALUES ($1,'pending',0,$2,$3)`, [JSON.stringify(message), now + delaySeconds * 1000, now]);
    incr("gittensory_jobs_enqueued_total");
    void pump();
  }

  async function claimNext(): Promise<JobRow | null> {
    // Atomic, multi-instance-safe: lock + claim one due job, skipping rows another instance already locked.
    const res = await pool.query(
      `UPDATE ${TABLE} SET status='processing'
       WHERE id = (SELECT id FROM ${TABLE} WHERE status='pending' AND run_after<=$1 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, payload, attempts`,
      [Date.now()],
    );
    return (res.rows[0] as JobRow | undefined) ?? null;
  }

  async function processOne(): Promise<boolean> {
    const job = await claimNext();
    if (!job) return false;
    const claimedAt = Date.now();
    let message: JobMessage;
    try {
      message = JSON.parse(job.payload) as JobMessage;
    } catch {
      await pool.query(`UPDATE ${TABLE} SET status='dead', last_error='unparseable payload' WHERE id=$1`, [job.id]);
      incr("gittensory_jobs_dead_total");
      logAudit({ event: "job_dead", ts: Date.now(), job_id: job.id, latency_ms: Date.now() - claimedAt, attempts: Number(job.attempts) + 1, error: "unparseable payload" });
      return true;
    }
    try {
      await consume(message);
      await pool.query(`DELETE FROM ${TABLE} WHERE id=$1`, [job.id]);
      incr("gittensory_jobs_processed_total");
      logAudit({ event: "job_complete", ts: Date.now(), job_id: job.id, payload_type: extractPayloadType(job.payload), latency_ms: Date.now() - claimedAt, attempts: Number(job.attempts) + 1 });
    } catch (error) {
      const attempts = Number(job.attempts) + 1;
      const errMsg = error instanceof Error ? error.message : "unknown error";
      incr("gittensory_jobs_failed_total");
      if (attempts >= maxRetries) {
        await pool.query(`UPDATE ${TABLE} SET status='dead', attempts=$1, last_error=$2 WHERE id=$3`, [attempts, errMsg, job.id]);
        incr("gittensory_jobs_dead_total");
        console.error(JSON.stringify({ level: "error", event: "selfhost_job_dead", id: job.id, attempts, error: errMsg }));
        logAudit({ event: "job_dead", ts: Date.now(), job_id: job.id, payload_type: extractPayloadType(job.payload), latency_ms: Date.now() - claimedAt, attempts, error: errMsg });
      } else {
        await pool.query(`UPDATE ${TABLE} SET status='pending', attempts=$1, run_after=$2, last_error=$3 WHERE id=$4`, [attempts, Date.now() + backoff(attempts), errMsg, job.id]);
        logAudit({ event: "job_error", ts: Date.now(), job_id: job.id, payload_type: extractPayloadType(job.payload), latency_ms: Date.now() - claimedAt, attempts, error: errMsg });
      }
    }
    return true;
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

  const binding = {
    async send(message: JobMessage, options?: { delaySeconds?: number }): Promise<void> {
      await enqueue(message, options?.delaySeconds ?? 0);
    },
    async sendBatch(messages: Iterable<{ body: JobMessage; delaySeconds?: number }>): Promise<void> {
      for (const m of messages) await enqueue(m.body, m.delaySeconds ?? 0);
    },
  } as unknown as Queue;

  return {
    binding,
    init,
    start() {
      if (running) return;
      running = true;
      const tick = (): void => {
        /* v8 ignore next */ // stop() clears the timer before the next tick can fire with running=false
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
      while (active > 0) await new Promise((r) => setTimeout(r, 10));
    },
    async drain() {
      while (active > 0) await new Promise((r) => setTimeout(r, 5));
      await pump();
    },
    async size() {
      return Number((await pool.query(`SELECT COUNT(*) AS c FROM ${TABLE} WHERE status IN ('pending','processing')`)).rows[0].c);
    },
    async deadCount() {
      return Number((await pool.query(`SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='dead'`)).rows[0].c);
    },
  };
}
