// Unit tests for pg-vectorize (#980 pgvector RAG). Uses a mock pg Pool so no real Postgres is required.
// The integration path (initPgVectorize + real Postgres) is covered by selfhost-pg-queue.test.ts (which
// already spins up Postgres in CI via the pg integration harness).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPgVectorize, initPgVectorize } from "../../src/selfhost/pg-vectorize";
import type { Pool } from "pg";

/** A minimal Pool mock that records queries and returns configurable rows. */
function makePool(rows: Record<string, unknown>[] = []): Pool {
  const mock = {
    _queries: [] as Array<{ sql: string; params: unknown[] }>,
    async query(sql: string, params: unknown[] = []) {
      mock._queries.push({ sql: String(sql), params });
      return { rows, rowCount: rows.length };
    },
  };
  return mock as unknown as Pool;
}

describe("initPgVectorize (#980)", () => {
  it("runs CREATE EXTENSION and CREATE TABLE at startup", async () => {
    const pool = makePool();
    await initPgVectorize(pool);
    const sqls = (pool as unknown as { _queries: Array<{ sql: string }> })._queries.map((q) => q.sql);
    expect(sqls.some((s) => s.includes("CREATE EXTENSION IF NOT EXISTS vector"))).toBe(true);
    expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true);
  });
});

describe("createPgVectorize (#980 pgvector RAG)", () => {
  let pool: Pool & { _queries: Array<{ sql: string; params: unknown[] }> };
  beforeEach(() => {
    pool = makePool() as unknown as Pool & { _queries: Array<{ sql: string; params: unknown[] }> };
  });

  it("upsert generates INSERT … ON CONFLICT with vector literal", async () => {
    const v = createPgVectorize(pool);
    // pg-vectorize is cast `as unknown as Vectorize` — read internal shape via unknown cast
    await v.upsert([{ id: "v1", values: [0.1, 0.2], namespace: "repo1", metadata: { path: "a.ts" } }]);
    const q = pool._queries[0];
    expect(q?.sql).toContain("ON CONFLICT(id)");
    expect(q?.sql).toContain("::vector");
    expect(q?.params[0]).toBe("v1");
    expect(q?.params[1]).toBe("repo1");
    expect(q?.params[2]).toBe("[0.1,0.2]");
  });

  it("upsert uses empty-string namespace when namespace is absent", async () => {
    const v = createPgVectorize(pool);
    await v.upsert([{ id: "ns-less", values: [1, 0] }]);
    expect(pool._queries[0]?.params[1]).toBe("");
  });

  it("query with namespace adds WHERE namespace= clause", async () => {
    const matchPool = makePool([{ id: "v1", score: 0.95, metadata: null }]);
    const v = createPgVectorize(matchPool);
    const { matches } = await v.query([0.1, 0.2], { topK: 3, namespace: "n1" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("v1");
    expect(matches[0]?.score).toBeCloseTo(0.95);
    const q = (matchPool as unknown as { _queries: Array<{ sql: string }> })._queries[0];
    expect(q?.sql).toContain("namespace=$2");
  });

  it("query without namespace omits the WHERE clause", async () => {
    const matchPool = makePool([{ id: "v2", score: 0.8, metadata: null }]);
    const v = createPgVectorize(matchPool);
    await v.query([0.1, 0.2], { topK: 5 });
    const q = (matchPool as unknown as { _queries: Array<{ sql: string }> })._queries[0];
    expect(q?.sql).not.toContain("namespace=");
  });

  it("query without topK uses the default of 12", async () => {
    const matchPool = makePool([{ id: "v4", score: 0.6, metadata: null }]);
    const v = createPgVectorize(matchPool);
    await v.query([1, 0], {}); // topK omitted → default 12
    const q = (matchPool as unknown as { _queries: Array<{ sql: string; params: unknown[] }> })._queries[0];
    // The LIMIT param should be 12 (the default)
    expect(q?.params).toContain(12);
  });

  it("query maps metadata JSONB rows to Match.metadata", async () => {
    const matchPool = makePool([{ id: "v3", score: 0.7, metadata: { path: "x.ts" } }]);
    const v = createPgVectorize(matchPool);
    const { matches } = await v.query([1, 0], { topK: 1, namespace: "n" });
    expect(matches[0]?.metadata?.path).toBe("x.ts");
  });

  it("deleteByIds with ids sends DELETE … IN (…) with placeholders", async () => {
    const v = createPgVectorize(pool);
    await v.deleteByIds(["a", "b", "c"]);
    const q = pool._queries[0];
    expect(q?.sql).toContain("IN ($1,$2,$3)");
    expect(q?.params).toEqual(["a", "b", "c"]);
  });

  it("deleteByIds with empty array is a no-op (no query issued)", async () => {
    const v = createPgVectorize(pool);
    await v.deleteByIds([]);
    expect(pool._queries).toHaveLength(0);
  });
});
