import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";

// Import .ts so CI's build:miner-before-coverage layout attributes hits under --coverage.all=false.
import { openLocalStoreDb } from "../../packages/loopover-miner/lib/local-store.ts";
import { createD1Adapter, nodeSqliteDriver } from "../../packages/loopover-miner/lib/store-db-adapter.ts";
import { createPgAdapter } from "../../src/selfhost/pg-adapter.ts";

// #4942: SqliteDriver / createD1Adapter (and optional Postgres) concurrent increment correctness.

const roots: string[] = [];

function tempRoot(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-shared-store-adapter-"));
  roots.push(root);
  return { root, dbPath: join(root, "store.sqlite3") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteDriver / createD1Adapter concurrent increments (#4942)", () => {
  it("N concurrent atomic UPDATE n = n + 1 writers produce exactly N (no lost updates)", async () => {
    const { dbPath } = tempRoot();
    const db = openLocalStoreDb(dbPath);
    const driver = nodeSqliteDriver(db);
    driver.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    driver.query("INSERT INTO counters (id, n) VALUES (?, ?)", ["shared", 0]);

    const adapter = createD1Adapter(driver);
    const workers = 32;
    await Promise.all(
      Array.from({ length: workers }, () =>
        adapter.batch([adapter.prepare("UPDATE counters SET n = n + 1 WHERE id = ?").bind("shared")]),
      ),
    );

    const row = driver.query("SELECT n AS n FROM counters WHERE id = ?", ["shared"]).rows[0] as { n: number };
    expect(row.n).toBe(workers);
    db.close();
  });

  it("naive app-level RMW across separate statements can lose updates (documents the non-guarantee)", () => {
    const { dbPath } = tempRoot();
    const a = openLocalStoreDb(dbPath);
    const b = openLocalStoreDb(dbPath);
    a.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    a.prepare("INSERT INTO counters (id, n) VALUES (?, ?)").run("shared", 0);

    const readA = (a.prepare("SELECT n AS n FROM counters WHERE id = ?").get("shared") as { n: number }).n;
    const readB = (b.prepare("SELECT n AS n FROM counters WHERE id = ?").get("shared") as { n: number }).n;
    a.prepare("UPDATE counters SET n = ? WHERE id = ?").run(readA + 1, "shared");
    b.prepare("UPDATE counters SET n = ? WHERE id = ?").run(readB + 1, "shared");

    const final = (a.prepare("SELECT n AS n FROM counters WHERE id = ?").get("shared") as { n: number }).n;
    expect(final).toBe(1);
    a.close();
    b.close();
  });
});

const PG_URL = process.env.PG_TEST_URL;
const pgSuite = PG_URL ? describe : describe.skip;

pgSuite("Postgres createPgAdapter concurrent increments (#4942)", () => {
  it("N concurrent atomic UPDATE n = n + 1 writers produce exactly N (no lost updates)", async () => {
    pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
    const pool = new pg.Pool({ connectionString: PG_URL });
    try {
      await pool.query("DROP TABLE IF EXISTS ams_concurrency_counters");
      await pool.query("CREATE TABLE ams_concurrency_counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
      const db = createPgAdapter(pool);
      await db.prepare("INSERT INTO ams_concurrency_counters (id, n) VALUES (?, ?)").bind("shared", 0).run();

      const workers = 32;
      await Promise.all(
        Array.from({ length: workers }, () =>
          db.prepare("UPDATE ams_concurrency_counters SET n = n + 1 WHERE id = ?").bind("shared").run(),
        ),
      );

      const row = await db
        .prepare("SELECT n AS n FROM ams_concurrency_counters WHERE id = ?")
        .bind("shared")
        .first<{ n: number }>();
      expect(row?.n).toBe(workers);
    } finally {
      await pool.end();
    }
  });
});
