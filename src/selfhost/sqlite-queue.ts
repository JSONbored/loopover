// Durable, SQLite-backed job queue for the self-host runtime (#980 reliability). Unlike the in-process FIFO,
// jobs are PERSISTED — a restart (or crash) re-claims anything left in flight instead of losing it. It still
// presents the Cloudflare `Queue` binding surface (send / sendBatch) so the app code is unchanged; only the
// backing store differs. Single-process model: node:sqlite is synchronous + serial, so claim (SELECT→UPDATE)
// is atomic with no row-lock dance.
import type { SqliteDriver } from "./d1-adapter";
import { logAudit, extractPayloadType } from "./audit";
import { incr } from "./metrics";
import type { JobMessage } from "../types";

const TABLE = "_selfhost_jobs";
const DDL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS ${TABLE}_claim ON ${TABLE}(status, run_after);`;

export interface DurableQueue {
  binding: Queue;
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  size(): number;
  deadCount(): number;
}

interface JobRow {
  id: number;
  payload: string;
  attempts: number;
}

export interface SqliteQueueOptions {
  maxRetries?: number;
  pollIntervalMs?: number;
  backoffMs?: (attempt: number) => number;
  /** Max concurrent `processOne()` loops. Defaults to QUEUE_CONCURRENCY env var or 1. */
  concurrency?: number;
}

export function createSqliteQueue(driver: SqliteDriver, consume: (message: JobMessage) => Promise<void>, opts: SqliteQueueOptions = {}): DurableQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const backoff = opts.backoffMs ?? ((attempt: number) => Math.min(60_000, 1000 * 2 ** attempt));
  const concurrency = opts.concurrency ?? Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? "1"));

  driver.exec(DDL);
  // Recover jobs a crashed previous run left mid-flight → make them claimable again.
  const recovered = driver.query(`UPDATE ${TABLE} SET status='pending' WHERE status='processing'`, []).changes;
  if (recovered) console.log(JSON.stringify({ event: "selfhost_queue_recovered", count: recovered }));

  let running = false;
  let active = 0;  // number of concurrent pump() loops currently draining jobs
  let timer: ReturnType<typeof setTimeout> | null = null;

  function enqueue(message: JobMessage, delaySeconds: number): void {
    const now = Date.now();
    driver.query(`INSERT INTO ${TABLE} (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, ?, ?)`, [JSON.stringify(message), now + delaySeconds * 1000, now]);
    incr("gittensory_jobs_enqueued_total");
    void pump();
  }

  function claimNext(): JobRow | null {
    const { rows } = driver.query(`SELECT id, payload, attempts FROM ${TABLE} WHERE status='pending' AND run_after<=? ORDER BY id LIMIT 1`, [Date.now()]);
    const row = rows[0] as JobRow | undefined;
    if (!row) return null;
    const { changes } = driver.query(`UPDATE ${TABLE} SET status='processing' WHERE id=? AND status='pending'`, [row.id]);
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
      driver.query(`UPDATE ${TABLE} SET status='dead', last_error='unparseable payload' WHERE id=?`, [job.id]);
      incr("gittensory_jobs_dead_total");
      logAudit({ event: "job_dead", ts: Date.now(), job_id: job.id, latency_ms: Date.now() - claimedAt, attempts: job.attempts + 1, error: "unparseable payload" });
      return true;
    }
    try {
      await consume(message);
      driver.query(`DELETE FROM ${TABLE} WHERE id=?`, [job.id]);
      incr("gittensory_jobs_processed_total");
      logAudit({ event: "job_complete", ts: Date.now(), job_id: job.id, payload_type: extractPayloadType(job.payload), latency_ms: Date.now() - claimedAt, attempts: job.attempts + 1 });
    } catch (error) {
      const attempts = job.attempts + 1;
      const errMsg = error instanceof Error ? error.message : "unknown error";
      incr("gittensory_jobs_failed_total");
      if (attempts >= maxRetries) {
        driver.query(`UPDATE ${TABLE} SET status='dead', attempts=?, last_error=? WHERE id=?`, [attempts, errMsg, job.id]);
        incr("gittensory_jobs_dead_total");
        console.error(JSON.stringify({ level: "error", event: "selfhost_job_dead", id: job.id, attempts, error: errMsg }));
        logAudit({ event: "job_dead", ts: Date.now(), job_id: job.id, payload_type: extractPayloadType(job.payload), latency_ms: Date.now() - claimedAt, attempts, error: errMsg });
      } else {
        driver.query(`UPDATE ${TABLE} SET status='pending', attempts=?, run_after=?, last_error=? WHERE id=?`, [attempts, Date.now() + backoff(attempts), errMsg, job.id]);
        logAudit({ event: "job_error", ts: Date.now(), job_id: job.id, payload_type: extractPayloadType(job.payload), latency_ms: Date.now() - claimedAt, attempts, error: errMsg });
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
    async send(message: JobMessage, options?: { delaySeconds?: number }): Promise<void> {
      enqueue(message, options?.delaySeconds ?? 0);
    },
    async sendBatch(messages: Iterable<{ body: JobMessage; delaySeconds?: number }>): Promise<void> {
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
      return Number((driver.query(`SELECT COUNT(*) AS c FROM ${TABLE} WHERE status IN ('pending','processing')`, []).rows[0] as { c: number }).c);
    },
    deadCount() {
      return Number((driver.query(`SELECT COUNT(*) AS c FROM ${TABLE} WHERE status='dead'`, []).rows[0] as { c: number }).c);
    },
  };
}
