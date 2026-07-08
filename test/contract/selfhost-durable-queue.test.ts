// Shared contract test for the self-host queue pair (#4010): runs the IDENTICAL assertion suite against
// createSqliteQueue and createPgQueue via describe.each, so a future change that breaks structural parity
// between the two DurableQueue implementations (a renamed method, a changed return shape, a dropped field)
// is caught here -- not discovered later as a silent divergence on whichever backend the change didn't
// touch. This is DELIBERATELY narrow: it exercises the introspection/admin surface (size, deadCount,
// pressureSignals, the dead-letter admin methods, ...) against a freshly-initialized, EMPTY queue on both
// backends, where the correct answer (0 / [] / false) is identical and unambiguous for both. It does not
// replace either backend's own much richer implementation-specific test file (selfhost-sqlite-queue.test.ts,
// selfhost-pg-queue.test.ts), which already cover real enqueue/claim/coalesce/retry semantics per backend.
//
// The Postgres side uses a minimal mock Pool (no real Postgres required, matching the existing
// selfhost-pg-queue.test.ts / selfhost-pg-vectorize.test.ts convention of mocking `pg.Pool` for unit-level
// coverage) that answers every aggregate/count query with a single zero-valued row and every list-style query
// with an empty row set -- both are the objectively correct answers for a genuinely empty table, so this
// mock needs no per-test scripting, unlike the richer scenario-specific MockPool in selfhost-pg-queue.test.ts.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { createSqliteQueue } from "../../src/selfhost/sqlite-queue";
import { createPgQueue } from "../../src/selfhost/pg-queue";
import type { DurableQueue } from "../../src/selfhost/backend-contracts";
import type { JobMessage } from "../../src/types";

const noopConsume = async (_message: JobMessage): Promise<void> => undefined;

/** A single zero-valued row satisfying every aggregate column name the queue's own pressure/count queries
 *  select (`c`, `cnt`, `oldest`, `runnable_cnt`, `oldest_runnable`) -- correct for ANY of those queries when
 *  the underlying table is genuinely empty. */
function zeroAggregateRow(): Record<string, number | null> {
  return { c: 0, cnt: 0, oldest: null, runnable_cnt: 0, oldest_runnable: null };
}

/** Minimal mock `pg.Pool` for an always-empty queue table: distinguishes a plain aggregate (COUNT with no
 *  GROUP BY -- deadCount/pressureSignals) from a grouped aggregate or a plain list query (GROUP BY, or no
 *  COUNT at all -- topBacklogRepos, the backfill/recovery SELECTs, listDeadLetterJobs, ...) by SQL text, since
 *  an empty base table genuinely produces a single zero/null row for the former and zero rows for the
 *  latter. Every UPDATE/DELETE reports rowCount 0 (nothing to touch). */
function makeEmptyPgPool(): Pool {
  return {
    async query(sql: string) {
      const text = String(sql);
      const isPlainAggregate = /count\(\*\)/i.test(text) && !/group by/i.test(text);
      return isPlainAggregate ? { rows: [zeroAggregateRow()], rowCount: 0 } : { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

const backends: Array<{ name: string; make: () => Promise<DurableQueue> }> = [
  {
    name: "sqlite",
    make: async () => {
      const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
      const q = createSqliteQueue(driver, noopConsume);
      await q.init();
      return q;
    },
  },
  {
    name: "postgres",
    make: async () => {
      const q = createPgQueue(makeEmptyPgPool(), noopConsume);
      await q.init();
      return q;
    },
  },
];

describe.each(backends)("DurableQueue contract ($name, #4010)", ({ make }) => {
  it("init() resolves without throwing", async () => {
    await expect(make()).resolves.toBeDefined();
  });

  it("exposes a Queue-shaped binding (send/sendBatch)", async () => {
    const q = await make();
    expect(typeof q.binding.send).toBe("function");
    expect(typeof q.binding.sendBatch).toBe("function");
  });

  it("size/deadCount/processingCount are all 0 on a fresh empty queue", async () => {
    const q = await make();
    expect(await q.size()).toBe(0);
    expect(await q.deadCount()).toBe(0);
    expect(await q.processingCount()).toBe(0);
  });

  it("stats() returns an empty Record", async () => {
    const q = await make();
    expect(await q.stats()).toEqual({});
  });

  it("snapshot() returns the SelfHostQueueSnapshot shape with zeroed totals", async () => {
    const q = await make();
    const snapshot = await q.snapshot();
    expect(snapshot.totals).toEqual({ pending: 0, processing: 0, dead: 0, due: 0 });
    expect(snapshot.byType).toEqual([]);
  });

  it("pressureSignals() reports clear pressure on every documented field", async () => {
    const q = await make();
    const signals = await q.pressureSignals();
    expect(signals).toMatchObject({
      livePendingCount: 0,
      oldestLivePendingAgeMs: null,
      liveRunnableNowCount: 0,
      oldestLiveRunnableAgeMs: null,
      maintenancePendingCount: 0,
      oldestMaintenancePendingAgeMs: null,
      backlogConvergencePendingCount: 0,
      freshIntakePendingCount: 0,
    });
  });

  it("topBacklogRepos() returns an empty array", async () => {
    const q = await make();
    expect(await q.topBacklogRepos(10)).toEqual([]);
  });

  it("listDeadLetterJobs() returns an empty array", async () => {
    const q = await make();
    expect(await q.listDeadLetterJobs(10, 0)).toEqual([]);
  });

  it("replayDeadLetterJob/deleteDeadLetterJob return false for a nonexistent id", async () => {
    const q = await make();
    expect(await q.replayDeadLetterJob(999_999)).toBe(false);
    expect(await q.deleteDeadLetterJob(999_999)).toBe(false);
  });

  it("purgeDeadLetterJobs/reviveDeadLetterJobs/releaseStaleForegroundDeferrals all report 0 work done", async () => {
    const q = await make();
    expect(await q.purgeDeadLetterJobs()).toBe(0);
    expect(await q.reviveDeadLetterJobs()).toBe(0);
    expect(await q.releaseStaleForegroundDeferrals()).toBe(0);
  });

  it("drain() and stop() resolve without throwing", async () => {
    const q = await make();
    await expect(q.drain()).resolves.toBeUndefined();
    await expect(q.stop()).resolves.toBeUndefined();
  });
});
