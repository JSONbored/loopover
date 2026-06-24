import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { readiness } from "../../src/selfhost/health";

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
});
