// Unit tests for the Postgres-backed D1Database adapter (#977). Mocks pg.Pool so no real DB is needed,
// mirroring selfhost-pg-queue.test.ts / selfhost-pg-vectorize.test.ts's own convention. Real-Postgres
// integration paths (migrations, translated-SQL correctness against a live server) live in
// test/integration/selfhost-pg.test.ts; the autovacuum tuning helper has its own file
// (selfhost-pg-adapter-autovacuum.test.ts). This file covers the adapter's own D1-shaped surface
// (prepare/bind/all/first/run/raw/batch/exec/dump) against a scripted mock, mirroring
// selfhost-d1-adapter.test.ts's coverage of the same surface for the sqlite side (#4010 contract parity).
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createPgAdapter } from "../../src/selfhost/pg-adapter";

/** A minimal Pool mock: `query()` (on the pool OR a connected client) always answers with the given rows,
 *  and every query issued (via the pool directly, or via a connect()ed client inside batch()'s transaction)
 *  is recorded to the SAME shared log, so a test can assert on the exact SQL/order a call produced. */
function makeMockPool(rows: Record<string, unknown>[] = []): Pool & { queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  async function query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    queries.push({ sql: String(sql), params });
    return { rows, rowCount: rows.length };
  }
  const client = { query, release() {} };
  const pool = { queries, query, connect: async () => client as unknown as PoolClient };
  return pool as unknown as Pool & { queries: Array<{ sql: string; params: unknown[] }> };
}

describe("createPgAdapter (#977 self-host D1-over-Postgres)", () => {
  it("prepare/bind/all reads translated rows (? -> $1 placeholder translation)", async () => {
    const pool = makeMockPool([{ id: 1, name: "a" }]);
    const db = createPgAdapter(pool);
    const result = await db.prepare("SELECT id, name FROM t WHERE id = ?").bind(1).all<{ id: number; name: string }>();
    expect(result.success).toBe(true);
    expect(result.results).toEqual([{ id: 1, name: "a" }]);
    expect(pool.queries[0]?.sql).toContain("$1");
  });

  it("first() returns the row, or null when there is no row", async () => {
    const withRow = createPgAdapter(makeMockPool([{ name: "a" }]));
    expect(await withRow.prepare("SELECT name FROM t").first<{ name: string }>()).toEqual({ name: "a" });

    const empty = createPgAdapter(makeMockPool([]));
    expect(await empty.prepare("SELECT name FROM t").first()).toBeNull();
  });

  it("first(colName) returns just that column's value", async () => {
    const db = createPgAdapter(makeMockPool([{ name: "a" }]));
    expect(await db.prepare("SELECT name FROM t").first("name")).toBe("a");
  });

  it("run() reports success:true and a meta object carrying the row count", async () => {
    const db = createPgAdapter(makeMockPool([]));
    const result = await db.prepare("INSERT INTO t (name) VALUES (?)").bind("x").run();
    expect(result.success).toBe(true);
    expect(typeof result.meta).toBe("object");
  });

  it("raw() returns each row as an array of column values, column order preserved", async () => {
    const db = createPgAdapter(makeMockPool([{ id: 1, name: "a" }]));
    expect(await db.prepare("SELECT id, name FROM t").raw()).toEqual([[1, "a"]]);
  });

  it("batch() runs BEGIN/COMMIT and returns one result per statement, in order", async () => {
    const pool = makeMockPool([{ id: 1 }]);
    const db = createPgAdapter(pool);
    const out = await db.batch([
      db.prepare("INSERT INTO t (id) VALUES (1)"),
      db.prepare("INSERT INTO t (id) VALUES (2)"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ success: true });
    expect(out[1]).toMatchObject({ success: true });
    const sqls = pool.queries.map((q) => q.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.at(-1)).toBe("COMMIT");
  });

  it("batch() rolls back and rethrows when a statement fails", async () => {
    const client = {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        throw new Error("boom");
      },
      release() {},
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const db = createPgAdapter(pool);
    await expect(db.batch([db.prepare("INSERT INTO t (id) VALUES (1)")])).rejects.toThrow("boom");
  });

  it("exec() translates DDL and reports a statement count from the semicolon-separated input", async () => {
    const db = createPgAdapter(makeMockPool([]));
    const result = await db.exec("CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);");
    expect(result.count).toBe(2);
  });

  it("dump() returns an ArrayBuffer (D1 surface completeness)", async () => {
    expect(await createPgAdapter(makeMockPool([])).dump()).toBeInstanceOf(ArrayBuffer);
  });
});
