// Unit tests for data-retention pruning (src/db/retention.ts) against the Postgres backend (#977). Mocks
// pg.Pool so no real DB is needed — real-Postgres integration coverage lives in test/integration/selfhost-pg.test.ts.
// retention.ts itself is unchanged: it still emits SQLite-dialect SQL (rowid, `?1`-style numbered
// placeholders); src/selfhost/pg-dialect.ts's translateSql() is what makes it Postgres-safe, same as every
// other query path on this backend. These tests exercise that translation end-to-end through the real
// pruneExpiredRecords()/processJob() call path, not just the dialect translator in isolation.
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPgAdapter } from "../../src/selfhost/pg-adapter";
import { pruneExpiredRecords } from "../../src/db/retention";
import { processJob, runRetentionPrune } from "../../src/queue/processors";

interface MockPgPool {
  pool: Pool;
  calls: string[];
  remaining: Record<string, number>;
}

/** A minimal fake Postgres that also acts as a regression guard: if untranslated SQLite SQL (the `rowid`
 *  pseudo-column) ever reaches it again, it throws the exact error a real Postgres raised in the live
 *  self-host incident (dead-lettered job `_selfhost_jobs.id = 61132`, `prune-retention`, 5 attempts). */
function makeRetentionPgPool(remaining: Record<string, number> = {}): MockPgPool {
  const calls: string[] = [];
  const fn = vi.fn().mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    calls.push(q);
    if (/\browid\b/i.test(q)) throw new Error('column "rowid" does not exist');

    const countMatch = /^SELECT count\(\*\) AS n FROM (\w+) WHERE/i.exec(q);
    if (countMatch) {
      const table = countMatch[1] as string;
      return { rows: [{ n: remaining[table] ?? 0 }], rowCount: 1 };
    }

    const deleteMatch = /^DELETE FROM (\w+) WHERE ctid IN \(SELECT ctid FROM \1 WHERE .*? LIMIT (\d+)\)$/i.exec(q);
    if (deleteMatch) {
      const table = deleteMatch[1] as string;
      const limit = Number(deleteMatch[2]);
      const have = remaining[table] ?? 0;
      const changes = Math.min(have, limit);
      remaining[table] = have - changes;
      return { rows: [], rowCount: changes };
    }

    if (/^insert into "?audit_events"?/i.test(q)) return { rows: [], rowCount: 1 };

    return { rows: [], rowCount: 0 };
  });
  return { pool: { query: fn } as unknown as Pool, calls, remaining };
}

function makeEnv(remaining: Record<string, number> = {}): { env: Env; mock: MockPgPool } {
  const mock = makeRetentionPgPool(remaining);
  return { env: { DB: createPgAdapter(mock.pool) } as unknown as Env, mock };
}

describe("pruneExpiredRecords on the Postgres backend (#977)", () => {
  it("dry-run counts eligible rows without issuing any delete", async () => {
    const { env, mock } = makeEnv({ ai_usage_events: 5 });
    const results = await pruneExpiredRecords(env, {
      dryRun: true,
      policy: [{ table: "ai_usage_events", column: "created_at", days: 90 }],
    });
    expect(results[0]?.deleted).toBe(5);
    expect(mock.calls.some((q) => /^DELETE/i.test(q))).toBe(false);
    expect(mock.remaining.ai_usage_events).toBe(5); // untouched
  });

  it("deletes across multiple bounded batches and stops at the per-table cap, same as the SQLite path", async () => {
    const { env, mock } = makeEnv({ ai_usage_events: 5 });
    const results = await pruneExpiredRecords(env, {
      batchSize: 2,
      maxPerTable: 4,
      policy: [{ table: "ai_usage_events", column: "created_at", days: 90 }],
    });
    expect(results[0]?.deleted).toBe(4); // 2 + 2, then cap reached
    expect(mock.remaining.ai_usage_events).toBe(1); // one row left for the next run
    const deletes = mock.calls.filter((q) => /^DELETE/i.test(q));
    expect(deletes).toHaveLength(2);
  });

  it("keeps the audit_events durable-event exclusion in the translated Postgres delete", async () => {
    const { env, mock } = makeEnv({ audit_events: 1 });
    await pruneExpiredRecords(env, { policy: [{ table: "audit_events", column: "created_at", days: 90 }] });
    const [deleteSql] = mock.calls.filter((q) => /^DELETE/i.test(q));
    expect(deleteSql).toContain("event_type NOT IN ('github_app.pr_public_surface_published')");
    expect(deleteSql?.toLowerCase()).not.toContain("rowid");
  });

  it("translates the numbered `?1` cutoff placeholder to Postgres's $1, not a corrupted $11", async () => {
    const { env, mock } = makeEnv({ ai_usage_events: 0 });
    await pruneExpiredRecords(env, {
      dryRun: true,
      policy: [{ table: "ai_usage_events", column: "created_at", days: 90 }],
    });
    const [countSql] = mock.calls;
    expect(countSql).toContain("created_at < $1");
    expect(countSql).not.toMatch(/\$1\d/); // not $11, $12, ...
  });
});

describe("runRetentionPrune + processJob on the Postgres backend (#977)", () => {
  it("audits a dry-run without deleting", async () => {
    const { env, mock } = makeEnv({ ai_usage_events: 2 });
    await runRetentionPrune(env, "test", true);
    const [insertSql] = mock.calls.filter((q) => /^insert into "?audit_events"?/i.test(q));
    expect(insertSql).toBeDefined();
    expect(mock.remaining.ai_usage_events).toBe(2); // nothing deleted
  });

  it("REGRESSION (self-host dead-letter, job id 61132): processJob prune-retention no longer throws the rowid column error on Postgres", async () => {
    const { env } = makeEnv(); // every table reports 0 eligible rows — exercises the full default policy
    await expect(processJob(env, { type: "prune-retention", requestedBy: "schedule" })).resolves.toBeUndefined();
  });

  it("processJob prune-retention deletes eligible rows and records a success audit event on Postgres", async () => {
    const { env, mock } = makeEnv({ ai_usage_events: 3 });
    await processJob(env, { type: "prune-retention", requestedBy: "schedule" });
    expect(mock.remaining.ai_usage_events).toBe(0);
    const [insertSql] = mock.calls.filter((q) => /^insert into "?audit_events"?/i.test(q));
    expect(insertSql).toBeDefined();
  });
});
