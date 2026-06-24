import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { createSqliteQueue } from "../../src/selfhost/sqlite-queue";
import type { JobMessage } from "../../src/types";

function makeDriver(): ReturnType<typeof nodeSqliteDriver> {
  return nodeSqliteDriver(new DatabaseSync(":memory:") as never);
}
const msg = (t: string): JobMessage => ({ type: t }) as unknown as JobMessage;
const typeOf = (m: JobMessage): string => (m as unknown as { type: string }).type;

describe("createSqliteQueue (durable #980)", () => {
  // Suppress audit log stdout noise.
  beforeEach(() => { vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("persists + drains FIFO through the consumer", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));
    await q.binding.send(msg("a"));
    await q.binding.send(msg("b"));
    await q.drain();
    expect(seen).toEqual(["a", "b"]);
    expect(q.size()).toBe(0);
  });

  it("retries then dead-letters after maxRetries", async () => {
    const driver = makeDriver();
    let calls = 0;
    const q = createSqliteQueue(
      driver,
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      { maxRetries: 3, backoffMs: () => 0 },
    );
    await q.binding.send(msg("x"));
    await q.drain(); // backoff 0 → all 3 attempts run within one drain, then dead-lettered
    expect(calls).toBe(3);
    expect(q.deadCount()).toBe(1);
    expect(q.size()).toBe(0);
  });

  it("SURVIVES A RESTART: a fresh queue over the same DB processes a persisted pending job", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const fresh = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m))); // creates the table
    // a job left pending on disk by a prior run (insert directly so this instance doesn't auto-process it first)
    driver.query("INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'pending', 0, 0, 0)", [JSON.stringify(msg("persisted"))]);
    await fresh.drain(); // the "new process" picks it up
    expect(seen).toEqual(["persisted"]);
  });

  it("start() runs the poll loop and processes a job, stop() halts it", async () => {
    const driver = makeDriver();
    const seen: string[] = [];
    const q = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)), { pollIntervalMs: 10 });
    q.start();
    await q.binding.send(msg("ticked"));
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    await q.stop();
    expect(seen).toEqual(["ticked"]);
  });

  it("recovers a job left 'processing' by a crash", async () => {
    const driver = makeDriver();
    createSqliteQueue(driver, async () => undefined); // creates the table
    driver.query("INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES (?, 'processing', 0, 0, 0)", [JSON.stringify(msg("stuck"))]);
    const seen: string[] = [];
    const fresh = createSqliteQueue(driver, async (m) => void seen.push(typeOf(m)));
    await fresh.drain();
    expect(seen).toEqual(["stuck"]);
  });

  it("records 'unknown error' when a consumer throws a non-Error", async () => {
    const q = createSqliteQueue(
      makeDriver(),
      async () => {
        throw "boom-string"; // not an Error instance
      },
      { maxRetries: 1, backoffMs: () => 0 },
    );
    await q.binding.send(msg("x"));
    await q.drain();
    expect(q.deadCount()).toBe(1);
  });

  it("dead-letters an unparseable payload", async () => {
    const driver = makeDriver();
    const q = createSqliteQueue(driver, async () => undefined);
    driver.query("INSERT INTO _selfhost_jobs (payload, status, attempts, run_after, created_at) VALUES ('not-json','pending',0,0,0)", []);
    await q.drain();
    expect(q.deadCount()).toBe(1);
  });

  it("sendBatch enqueues all; default backoff reschedules a failure into the future", async () => {
    const seen: string[] = [];
    const q = createSqliteQueue(makeDriver(), async (m) => void seen.push(typeOf(m)));
    await q.binding.sendBatch([{ body: msg("a") }, { body: msg("b") }]);
    await q.drain();
    expect(seen.sort()).toEqual(["a", "b"]);

    let calls = 0;
    const q2 = createSqliteQueue(makeDriver(), async () => {
      calls += 1;
      throw new Error("x");
    }, { maxRetries: 5 }); // default backoff (~2s) → not re-claimed this drain
    await q2.binding.send(msg("f"));
    await q2.drain();
    expect(calls).toBe(1);
    expect(q2.size()).toBe(1);
  });

  it("stop() is a no-op when start() was never called (timer is null)", async () => {
    const q = createSqliteQueue(makeDriver(), async () => undefined);
    await q.stop(); // timer=null → the false branch of `if (timer) clearTimeout(timer)` is taken
    expect(q.size()).toBe(0); // still usable after a spurious stop()
  });

  it("concurrency=1 saturates after one active pump (active >= concurrency → early return)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = createSqliteQueue(makeDriver(), async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 1, pollIntervalMs: 100_000 });
    // sendBatch fires two void pump() calls synchronously; the second sees active=1 >= 1 and returns.
    await q.binding.sendBatch([{ body: msg("a") }, { body: msg("b") }]);
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(1);
    expect(q.size()).toBe(0);
  });

  it("concurrency=2 allows two jobs to run simultaneously", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = createSqliteQueue(makeDriver(), async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    }, { concurrency: 2, pollIntervalMs: 100_000 });
    await q.binding.sendBatch([{ body: msg("a") }, { body: msg("b") }]);
    await new Promise((r) => setTimeout(r, 60));
    await q.stop();
    expect(maxConcurrent).toBe(2);
    expect(q.size()).toBe(0);
  });

  it("start() is idempotent and stop() waits for an in-flight pump", async () => {
    let done = false;
    const q = createSqliteQueue(makeDriver(), async () => {
      await new Promise((r) => setTimeout(r, 40));
      done = true;
    }, { pollIntervalMs: 5 });
    q.start();
    q.start(); // idempotent
    await q.binding.send(msg("slow"));
    await new Promise((r) => setTimeout(r, 12)); // let the tick claim it + enter the slow consume
    await q.stop(); // waits for the in-flight consume to finish
    expect(done).toBe(true);
  });
});
