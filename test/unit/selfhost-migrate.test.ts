import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { runSelfHostMigrations } from "../../src/selfhost/migrate";

describe("runSelfHostMigrations (#980)", () => {
  it("applies un-applied migrations in order, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER);");
    const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));

    expect(await runSelfHostMigrations(db, dir)).toBe(2); // both applied
    expect(await runSelfHostMigrations(db, dir)).toBe(0); // idempotent — nothing re-applied

    writeFileSync(join(dir, "0003_c.sql"), "CREATE TABLE c (id INTEGER);");
    expect(await runSelfHostMigrations(db, dir)).toBe(1); // only the new one
  });
});
