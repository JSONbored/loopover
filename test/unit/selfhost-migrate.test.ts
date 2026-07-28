import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { runSelfHostMigrations } from "../../src/selfhost/migrate";
import { normalizePostgresValue } from "../../scripts/migrate-selfhost-sqlite-to-postgres";
import type { Pool } from "pg";
import { createPgAdapter, MIGRATION_ADVISORY_LOCK_KEY, pgPoolForAdapter, withPgMigrationLock } from "../../src/selfhost/pg-adapter";

const sha256 = (sql: string) => createHash("sha256").update(sql, "utf8").digest("hex");

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

  describe("content_sha256 ledger (#9164: an applied migration edited in place must be detected)", () => {
    it("records each applied migration's content hash", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
      const sql = "CREATE TABLE a (id INTEGER);";
      writeFileSync(join(dir, "0001_a.sql"), sql);
      const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));

      expect(await runSelfHostMigrations(db, dir)).toBe(1);
      const row = await db.prepare("SELECT content_sha256 FROM _selfhost_migrations WHERE name = ?").bind("0001_a.sql").first<{ content_sha256: string }>();
      expect(row?.content_sha256).toBe(sha256(sql));
    });

    it("throws and logs loudly when an already-applied migration's on-disk content no longer matches its recorded hash", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
      writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
      const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));
      expect(await runSelfHostMigrations(db, dir)).toBe(1); // applied + hash recorded

      // Edited in place AFTER being applied — the exact hazard #9164 exists to catch.
      writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER, extra INTEGER);");
      await expect(runSelfHostMigrations(db, dir)).rejects.toThrow(/0001_a\.sql/);

      // The ledger itself is untouched by the failed re-run — still records the ORIGINAL hash, not the new one.
      const row = await db.prepare("SELECT content_sha256 FROM _selfhost_migrations WHERE name = ?").bind("0001_a.sql").first<{ content_sha256: string }>();
      expect(row?.content_sha256).toBe(sha256("CREATE TABLE a (id INTEGER);"));
    });

    it("backfills content_sha256 for a pre-#9164 ledger row that predates the column, using its CURRENT content as the baseline", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
      const sql = "CREATE TABLE a (id INTEGER);";
      writeFileSync(join(dir, "0001_a.sql"), sql);
      const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));

      // Simulate a ledger written before #9164 — no content_sha256 column at all — with the migration already
      // recorded applied (this repo's actual pre-#9164 shape).
      await db.exec("CREATE TABLE _selfhost_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      await db.exec(`INSERT INTO _selfhost_migrations (name, applied_at) VALUES ('0001_a.sql', '2020-01-01T00:00:00.000Z')`);

      expect(await runSelfHostMigrations(db, dir)).toBe(0); // already applied — not re-run, just backfilled
      const row = await db.prepare("SELECT content_sha256 FROM _selfhost_migrations WHERE name = ?").bind("0001_a.sql").first<{ content_sha256: string }>();
      expect(row?.content_sha256).toBe(sha256(sql));

      // Once backfilled, an unrelated later boot with the SAME content is a no-op — no false drift from the backfill itself.
      expect(await runSelfHostMigrations(db, dir)).toBe(0);
    });

    it("does not flag drift for a ledger row whose file was later removed from the repo (a distinct, unrelated concern)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gtmig-"));
      writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
      const db = createD1Adapter(nodeSqliteDriver(new DatabaseSync(":memory:") as never));
      expect(await runSelfHostMigrations(db, dir)).toBe(1);

      const dir2 = mkdtempSync(join(tmpdir(), "gtmig-")); // 0001_a.sql no longer present on disk
      await expect(runSelfHostMigrations(db, dir2)).resolves.toBe(0);
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

// #9486: two instances booting concurrently could both apply migrations. Instance A applies one atomically;
// B's identical transaction fails "already exists", which runSelfHostMigrations treats as DRIFT and retries
// statement-by-statement -- so a table-rebuild INSERT ... SELECT or an UPDATE backfill RE-EXECUTES against the
// already-migrated schema. B then dies on the ledger INSERT's unique violation, whose message matches neither
// "duplicate column" nor "already exists", and crash-loops a cycle. #9027 made a single migration atomic
// against a crash; this makes the whole RUN atomic against a concurrent boot.
describe("withPgMigrationLock (#9486)", () => {
  it("runs straight through on a non-Postgres backend (SQLite is single-process by construction)", async () => {
    // Any db that was not built by createPgAdapter has no registered pool, so there is no lock to take.
    const notPg = {} as unknown as D1Database;
    let ran = false;
    const result = await withPgMigrationLock(notPg, async () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
  });

  it("takes and releases a session advisory lock on the Postgres adapter, around the work", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const db = createPgAdapter(pool);

    const order: string[] = [];
    const out = await withPgMigrationLock(db, async () => {
      order.push("work");
      return "done";
    });

    expect(out).toBe("done");
    // Locked BEFORE the work and unlocked after -- an unlock-before-work ordering would serialize nothing.
    expect(queries[0]).toContain("pg_advisory_lock");
    expect(queries.at(-1)).toContain("pg_advisory_unlock");
    expect(order).toEqual(["work"]);
  });

  it("INVARIANT: releases the lock and the client even when the work THROWS", async () => {
    // A migration failure must not strand the advisory lock -- every later boot would block on it forever.
    const queries: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => { released = true; },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const db = createPgAdapter(pool);

    await expect(withPgMigrationLock(db, async () => { throw new Error("migration blew up"); })).rejects.toThrow("migration blew up");

    expect(queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
    expect(released).toBe(true);
  });

  it("registers the pool so a caller needing a DEDICATED connection can find it", () => {
    // A session advisory lock is held by its connection, so it cannot be taken through the pooled adapter --
    // hence the registry rather than a new statement on the D1 surface.
    const pool = { connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) } as unknown as Pool;
    const db = createPgAdapter(pool);
    expect(pgPoolForAdapter(db)).toBe(pool);
    expect(pgPoolForAdapter({} as unknown as D1Database)).toBeUndefined();
  });

  it("uses one stable key, so separate instances actually serialize against each other", () => {
    expect(typeof MIGRATION_ADVISORY_LOCK_KEY).toBe("number");
    expect(Number.isInteger(MIGRATION_ADVISORY_LOCK_KEY)).toBe(true);
  });
});
