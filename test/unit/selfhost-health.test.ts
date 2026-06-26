import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { readiness, sqliteBackupAdvisory } from "../../src/selfhost/health";

describe("sqliteBackupAdvisory (#8 data-safety)", () => {
  it("warns on SQLite without an acknowledged backup, and is silent otherwise", () => {
    expect(sqliteBackupAdvisory({ usingSqlite: true, backupAcknowledged: false })).toMatch(/single SQLite file with no acknowledged backup/);
    expect(sqliteBackupAdvisory({ usingSqlite: true, backupAcknowledged: true })).toBeNull(); // operator acknowledged
    expect(sqliteBackupAdvisory({ usingSqlite: false, backupAcknowledged: false })).toBeNull(); // Postgres
  });
});

describe("readiness (#982)", () => {
  it("is not ready until the migrations table has applied rows", async () => {
    const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
    const db = createD1Adapter(driver);
    // db answers but no migrations table yet → not ready
    expect(await readiness(db)).toEqual({ ok: false, checks: { db: true, migrations: false } });
    // empty migrations table → still not ready
    driver.exec("CREATE TABLE _selfhost_migrations (name TEXT, applied_at INTEGER)");
    expect((await readiness(db)).ok).toBe(false);
    // an applied migration → ready
    driver.query("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)", ["0001", 0]);
    expect(await readiness(db)).toEqual({ ok: true, checks: { db: true, migrations: true } });
  });

  it("reports db=false and migrations=false when the SELECT 1 probe throws (db down)", async () => {
    const throwingDb = {
      prepare: () => ({
        bind: function() { return this; },
        first: () => Promise.reject(new Error("sqlite_io_error")),
        all: () => Promise.reject(new Error("sqlite_io_error")),
        run: () => Promise.reject(new Error("sqlite_io_error")),
        raw: () => Promise.reject(new Error("sqlite_io_error")),
      }),
      exec: () => Promise.resolve({ results: [], success: true, meta: {} }),
      batch: () => Promise.resolve([]),
      dump: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as D1Database;
    expect(await readiness(throwingDb)).toEqual({ ok: false, checks: { db: false, migrations: false } });
  });

  it("gates readiness on configured backend probes (#4) and reports each in checks", async () => {
    const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
    const db = createD1Adapter(driver);
    driver.exec("CREATE TABLE _selfhost_migrations (name TEXT, applied_at INTEGER)");
    driver.query("INSERT INTO _selfhost_migrations (name, applied_at) VALUES (?, ?)", ["0001", 0]);
    // A healthy probe → still ready, reported in checks.
    expect(await readiness(db, [{ name: "redis", check: async () => true }])).toEqual({ ok: true, checks: { db: true, migrations: true, redis: true } });
    // A failing probe → NOT ready (a configured backend that's down means the instance is degraded).
    expect(await readiness(db, [{ name: "redis", check: async () => false }])).toEqual({ ok: false, checks: { db: true, migrations: true, redis: false } });
    // A throwing probe → caught → false → not ready.
    expect(await readiness(db, [{ name: "qdrant", check: async () => { throw new Error("unreachable"); } }])).toEqual({ ok: false, checks: { db: true, migrations: true, qdrant: false } });
  });
});
