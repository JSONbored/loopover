// Shared contract test for the self-host D1-shaped storage adapter pair (#4010): runs the IDENTICAL
// assertion suite against createD1Adapter (real node:sqlite) and createPgAdapter (real Postgres) via one
// shared spec function, so a future change that breaks behavioral parity between the two -- despite both
// still satisfying SelfHostD1Database structurally -- is caught here instead of discovered later as a silent
// production divergence.
//
// The sqlite side always runs (node:sqlite is built-in and instant, matching
// test/unit/selfhost-d1-adapter.test.ts's own pattern). The Postgres side needs a REAL Postgres -- there is
// no meaningful way to fake generic SQL execution for an arbitrary CREATE TABLE/INSERT/SELECT -- so it
// follows the exact same PG_TEST_URL gate test/integration/selfhost-pg.test.ts already established: unset in
// CI (skipped, not failed), set locally against a real Postgres to actually exercise it:
//   docker run -d -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=gittensory -p 55432:5432 postgres:16
//   PG_TEST_URL=postgres://postgres:devpw@localhost:55432/gittensory npx vitest run test/contract/selfhost-d1-database.test.ts
// Every statement here uses only PG-native column types (INTEGER/TEXT) and `?`-style placeholders with
// explicit values (never relying on SQLite ROWID auto-assignment), which pg-dialect.ts's translateDdl/
// translateSql already pass through/translate unchanged (see its own doc comments) -- so the same SQL text is
// valid, and means the same thing, against both backends. This does not replace either backend's own richer
// test file -- it is the narrow, identical-inputs slice both must agree on.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { createPgAdapter } from "../../src/selfhost/pg-adapter";

/** The identical assertion suite, run against whichever concrete D1Database `make()` returns. Each `it` calls
 *  `make()` itself (not a shared hoisted instance) so the sqlite side gets a fresh in-memory database per
 *  test; the Postgres side reuses one real connection pool across tests (see below) and instead relies on
 *  each test using its own uniquely-named table to stay isolated. */
function runD1DatabaseContractTests(make: () => D1Database): void {
  it("creates a table, inserts, and reads it back via all()/first()", async () => {
    const db = make();
    await db.exec("CREATE TABLE contract_all_first (id INTEGER PRIMARY KEY, name TEXT)");
    await db.prepare("INSERT INTO contract_all_first (id, name) VALUES (?, ?)").bind(1, "a").run();
    await db.prepare("INSERT INTO contract_all_first (id, name) VALUES (?, ?)").bind(2, "b").run();

    const all = await db.prepare("SELECT id, name FROM contract_all_first ORDER BY id").all<{ id: number; name: string }>();
    expect(all.success).toBe(true);
    expect(all.results).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);

    const first = await db.prepare("SELECT name FROM contract_all_first WHERE id = ?").bind(1).first<{ name: string }>();
    expect(first).toEqual({ name: "a" });
  });

  it("first() returns null for no matching row", async () => {
    const db = make();
    await db.exec("CREATE TABLE contract_empty (id INTEGER PRIMARY KEY)");
    expect(await db.prepare("SELECT id FROM contract_empty WHERE id = 99").first()).toBeNull();
  });

  it("run() reports success:true and a meta object", async () => {
    const db = make();
    await db.exec("CREATE TABLE contract_run (id INTEGER PRIMARY KEY, name TEXT)");
    const result = await db.prepare("INSERT INTO contract_run (id, name) VALUES (1, 'x')").run();
    expect(result.success).toBe(true);
    expect(typeof result.meta).toBe("object");
  });

  it("batch() runs every statement, in order", async () => {
    const db = make();
    await db.exec("CREATE TABLE contract_batch (id INTEGER PRIMARY KEY, name TEXT)");
    await db.batch([
      db.prepare("INSERT INTO contract_batch (id, name) VALUES (1, 'x')"),
      db.prepare("INSERT INTO contract_batch (id, name) VALUES (2, 'y')"),
    ]);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM contract_batch").first<{ n: number | string }>();
    expect(Number(count?.n)).toBe(2);
  });

  it("dump() returns an ArrayBuffer", async () => {
    expect(await make().dump()).toBeInstanceOf(ArrayBuffer);
  });
}

describe("D1Database contract (sqlite, #4010)", () => {
  runD1DatabaseContractTests(() => createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never)));
});

const PG_TEST_URL = process.env.PG_TEST_URL;
const pgSuite = PG_TEST_URL ? describe : describe.skip;

pgSuite("D1Database contract (postgres, #4010) — real Postgres", () => {
  let pool: Pool;

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10)); // int8 (COUNT) → number, like D1
    pool = new pg.Pool({ connectionString: PG_TEST_URL });
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  });

  afterAll(async () => {
    await pool?.end();
  });

  runD1DatabaseContractTests(() => createPgAdapter(pool));
});
