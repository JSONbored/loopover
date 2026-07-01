import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { runSelfHostMigrations } from "../../src/selfhost/migrate";
import { normalizePostgresValue } from "../../scripts/migrate-selfhost-sqlite-to-postgres";

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

  it("tolerates a migration whose schema change is already present (column drift), but rethrows real errors (#migrate-drift)", async () => {
    // 0001 adds column x; 0002 re-adds the SAME column under a new filename (a renumbered-migration collision, as
    // happened with ai_review_all_authors 0071→0075). "duplicate column" must be tolerated — recorded applied, not
    // crash-looping the boot.
    const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
    writeFileSync(join(dir, "0001_add_x.sql"), "CREATE TABLE t (id INTEGER); ALTER TABLE t ADD COLUMN x INTEGER;");
    writeFileSync(join(dir, "0002_readd_x.sql"), "ALTER TABLE t ADD COLUMN x INTEGER;");
    const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));
    expect(await runSelfHostMigrations(db, dir)).toBe(2); // both recorded; the duplicate-column 0002 is tolerated

    // A genuine error (invalid SQL, not a duplicate/exists) still aborts the boot.
    const dir2 = mkdtempSync(join(tmpdir(), "gtmig-"));
    writeFileSync(join(dir2, "0001_bad.sql"), "THIS IS NOT VALID SQL;");
    const db2 = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));
    await expect(runSelfHostMigrations(db2, dir2)).rejects.toThrow();
  });

  it("continues later statements before recording a drifted migration as applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
    writeFileSync(join(dir, "0001_base.sql"), "CREATE TABLE t (id INTEGER, x INTEGER);");
    writeFileSync(join(dir, "0002_drifted.sql"), "ALTER TABLE t ADD COLUMN x INTEGER; ALTER TABLE t ADD COLUMN y INTEGER;");
    const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));

    expect(await runSelfHostMigrations(db, dir)).toBe(2);
    expect(await db.prepare("SELECT y FROM t").all()).toMatchObject({ success: true });
    expect(await runSelfHostMigrations(db, dir)).toBe(0);
  });

  it("applies valid SQL containing semicolons and comment markers inside strings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
    writeFileSync(
      join(dir, "0001_strings.sql"),
      "CREATE TABLE notes (body TEXT); INSERT INTO notes (body) VALUES ('semi;colon -- literal');",
    );
    const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));

    expect(await runSelfHostMigrations(db, dir)).toBe(1);
    await expect(db.prepare("SELECT body FROM notes").first<{ body: string }>()).resolves.toEqual({
      body: "semi;colon -- literal",
    });
  });

  it("preserves SQL comments outside strings without treating their semicolons as delimiters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
    writeFileSync(
      join(dir, "0001_comments.sql"),
      `-- leading comment; ignored by SQLite
/* block comment; ignored by SQLite */
CREATE TABLE "quoted;table" (\`body;column\` TEXT);
INSERT INTO "quoted;table" (\`body;column\`) VALUES ('it''s; ok')`,
    );
    const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));

    expect(await runSelfHostMigrations(db, dir)).toBe(1);
    await expect(db.prepare('SELECT `body;column` AS body FROM "quoted;table"').first<{ body: string }>()).resolves.toEqual({
      body: "it's; ok",
    });
  });

  it("applies trigger bodies that contain internal statement semicolons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
    writeFileSync(
      join(dir, "0001_trigger.sql"),
      `CREATE TABLE notes (body TEXT);
CREATE TABLE audit (body TEXT);
CREATE TRIGGER notes_ai AFTER INSERT ON notes
BEGIN
  INSERT INTO audit (body) VALUES (NEW.body);
END;
INSERT INTO notes (body) VALUES ('triggered');`,
    );
    const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));

    expect(await runSelfHostMigrations(db, dir)).toBe(1);
    await expect(db.prepare("SELECT body FROM audit").first<{ body: string }>()).resolves.toEqual({
      body: "triggered",
    });
  });

});

describe("SQLite-to-Postgres migrator helpers", () => {
  it("normalizes embedded NUL bytes in SQLite text before Postgres copy", () => {
    expect(normalizePostgresValue("repo\0chunk")).toBe("repo\uFFFDchunk");
    expect(normalizePostgresValue("plain text")).toBe("plain text");
    expect(normalizePostgresValue(null)).toBeNull();
    expect(normalizePostgresValue(42)).toBe(42);
  });
});
