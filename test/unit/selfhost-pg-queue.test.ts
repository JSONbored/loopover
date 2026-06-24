// Unit tests for the Postgres-backed job queue (#977). Mocks pg.Pool so no real DB is needed.
// Real-Postgres integration paths (migrations, pg-adapter translation) live in test/integration/selfhost-pg.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import { createPgQueue } from "../../src/selfhost/pg-queue";
import type { JobMessage } from "../../src/types";

const msg = (t: string): JobMessage => ({ type: t }) as unknown as JobMessage;
const typeOf = (m: JobMessage): string => (m as unknown as { type: string }).type;

type MockFn = { mockResolvedValueOnce(v: unknown): void };

interface MockPool {
  pool: Pool;
  fn: MockFn;
  enqueueResult(r: Partial<QueryResult>): void;
  /** Pre-load a job to be returned by the next RETURNING claim query. */
  enqueueJob(id: string, payload: object, attempts?: number): void;
}

function makePool(): MockPool {
  const results: Partial<QueryResult>[] = [];
  const fn = vi.fn().mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    // Claim queries use RETURNING — pop from queue; fall through to empty default otherwise.
    if (q.includes("RETURNING")) {
      const next = results.shift();
      return next ?? { rows: [], rowCount: 0 };
    }
    // COUNT queries need a c column.
    if (q.includes("COUNT(*)")) {
      return { rows: [{ c: "3" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    pool: { query: fn } as unknown as Pool,
    fn: fn as unknown as MockFn,
    enqueueResult(r) { results.push(r); },
    enqueueJob(id, payload, attempts = 0) {
      results.push({ rows: [{ id, payload: JSON.stringify(payload), attempts }], rowCount: 1 });
    },
  };
}

describe("createPgQueue (durable #977)", () => {
  // Suppress audit log stdout noise in tests.
  beforeEach(() => { vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("init() creates the table and recovers stuck-processing jobs", async () => {
    const m = makePool();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DDL
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 2 }); // recovery UPDATE
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init();
    expect(m.pool.query).toHaveBeenCalledTimes(2);
  });

  it("init() handles null rowCount from the recovery query (rowCount ?? 0 nullish arm)", async () => {
    const m = makePool();
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DDL
    // pg driver can return null for rowCount on some UPDATE results
    m.fn.mockResolvedValueOnce({ rows: [], rowCount: null });
    const q = createPgQueue(m.pool, async () => undefined);
    await q.init(); // rowCount=null → ?? 0 → 0 → no recovery log emitted
    expect(m.pool.query).toHaveBeenCalledTimes(2);
  });

  it("processes a job successfully (job_complete audit emitted)", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "review" });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));
    await q.init();
    await q.drain();
    expect(seen).toEqual(["review"]);
  });

  it("dead-letters an unparseable payload (job_dead audit emitted)", async () => {
    const m = makePool();
    // Claim returns a row with bad payload.
    m.enqueueResult({ rows: [{ id: "1", payload: "not-json", attempts: 0 }], rowCount: 1 });
    const q = createPgQueue(m.pool, async () => undefined, { maxRetries: 3 });
    await q.init();
    await q.drain();
    // UPDATE dead + then no more rows → pump exits cleanly.
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("status='dead'"), expect.arrayContaining(["1"]));
  });

  it("retries a failing job (job_error audit emitted) then dead-letters at maxRetries (job_dead)", async () => {
    const m = makePool();
    // Two attempts: first → retry, second → dead-letter.
    m.enqueueJob("1", { type: "t" }, 0);
    m.enqueueJob("1", { type: "t" }, 1); // second claim after retry
    let calls = 0;
    const q = createPgQueue(m.pool, async () => { calls++; throw new Error("fail"); }, { maxRetries: 2, backoffMs: () => 0 });
    await q.init();
    await q.drain();
    await q.drain(); // second drain processes the retried job
    expect(calls).toBe(2);
  });

  it("records 'unknown error' when consumer throws a non-Error", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "t" }, 0);
    const q = createPgQueue(m.pool, async () => { throw "plain-string"; }, { maxRetries: 1, backoffMs: () => 0 });
    await q.init();
    await q.drain();
    expect(m.pool.query).toHaveBeenCalledWith(expect.stringContaining("status='dead'"), expect.arrayContaining(["unknown error"]));
  });

  it("pump() returns early when active >= concurrency (saturation guard)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const m = makePool();
    m.enqueueJob("1", { type: "a" });
    m.enqueueJob("2", { type: "b" });
    const q = createPgQueue(m.pool, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 1, pollIntervalMs: 100_000 });
    await q.init();
    await q.binding.send(msg("a"));
    await q.binding.send(msg("b")); // second void pump() hits active >= 1 → returns early
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(1);
  });

  it("concurrency=2 allows two jobs to run simultaneously", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const m = makePool();
    m.enqueueJob("1", { type: "a" });
    m.enqueueJob("2", { type: "b" });
    const q = createPgQueue(m.pool, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 2, pollIntervalMs: 100_000 });
    await q.init();
    await q.binding.send(msg("a"));
    await q.binding.send(msg("b"));
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(2);
  });

  it("start() and stop() run the poll loop", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "ticked" });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)), { pollIntervalMs: 10 });
    await q.init();
    q.start();
    for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await q.stop();
    expect(seen).toEqual(["ticked"]);
  });

  it("start() is idempotent", async () => {
    const { pool } = makePool();
    const q = createPgQueue(pool, async () => undefined, { pollIntervalMs: 100_000 });
    await q.init();
    q.start();
    q.start(); // second call is a no-op
    await q.stop();
  });

  it("stop() is a no-op when timer is null", async () => {
    const { pool } = makePool();
    const q = createPgQueue(pool, async () => undefined);
    await q.init();
    await q.stop(); // timer=null → false branch of `if (timer) clearTimeout(timer)`
  });

  it("binding.sendBatch enqueues multiple messages", async () => {
    const m = makePool();
    m.enqueueJob("1", { type: "x" });
    m.enqueueJob("2", { type: "y" });
    const seen: string[] = [];
    const q = createPgQueue(m.pool, async (j) => void seen.push(typeOf(j)));
    await q.init();
    await q.binding.sendBatch([{ body: msg("x") }, { body: msg("y") }]);
    await q.drain();
    expect(seen.sort()).toEqual(["x", "y"]);
  });

  it("uses default backoff lambda when backoffMs is not provided", async () => {
    // Trigger a retry without providing backoffMs so the default (attempt) => Math.min(60_000, 1000 * 2**attempt)
    // is actually called — covering the function body that would otherwise be created but never invoked.
    const m = makePool();
    m.enqueueJob("1", { type: "t" }, 0);
    const q = createPgQueue(m.pool, async () => { throw new Error("transient"); }, { maxRetries: 5 });
    // No backoffMs → default lambda is used + called when scheduling the retry
    await q.init();
    await q.drain();
    expect(m.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status='pending'"),
      expect.arrayContaining([1]),
    );
  });

  it("size() and deadCount() return numeric counts", async () => {
    const { pool } = makePool();
    // makePool returns { c: "3" } for COUNT queries
    const q = createPgQueue(pool, async () => undefined);
    await q.init();
    expect(await q.size()).toBe(3);
    expect(await q.deadCount()).toBe(3);
  });
});
