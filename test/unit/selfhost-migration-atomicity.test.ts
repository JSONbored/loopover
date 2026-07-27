import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { runSelfHostMigrations } from "../../src/selfhost/migrate";

function sqliteDb(): { db: ReturnType<typeof createD1Adapter>; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  return { db: createD1Adapter(nodeSqliteDriver(raw as never)), raw };
}

function migrationDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gtmig-atomic-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

// #9027: each statement ran individually and the file was recorded applied only after the LAST one succeeded,
// so a crash mid-file re-ran the WHOLE file next boot. Harmless for pure DDL; actively destructive for the
// several migrations carrying real DML (the table-rebuild INSERT ... SELECT pattern, plus UPDATE/DELETE steps),
// where a re-run either double-inserts or raises a PK conflict that — not matching the tolerated "already
// exists" shape — throws and bricks boot. With deploys currently ending in SIGKILL under load (#9007), a
// mid-migration kill is not hypothetical.
describe("self-host migrations are all-or-nothing per file (#9027)", () => {
  it("rolls the whole file back when a later statement fails, leaving no partial DDL and no ledger row", async () => {
    const { db, raw } = sqliteDb();
    const dir = migrationDir({
      "0001_partial.sql": "CREATE TABLE keep (id INTEGER);\nCREATE TABLE dropme (id INTEGER);\nTHIS IS NOT VALID SQL;",
    });

    await expect(runSelfHostMigrations(db, dir)).rejects.toThrow();

    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    // Neither table survives: before this fix `keep` and `dropme` were both left behind, and the file was NOT
    // recorded — so the next boot re-ran it from the top against a schema that had already half-changed.
    expect(tables.map((t) => t.name)).not.toContain("dropme");
    expect(tables.map((t) => t.name)).not.toContain("keep");
  });

  it("does not double-apply DML when a file is retried after a crash", async () => {
    const { db, raw } = sqliteDb();
    raw.exec("CREATE TABLE src (id INTEGER PRIMARY KEY); INSERT INTO src (id) VALUES (1), (2);");
    // The table-rebuild shape several real migrations use, with a failing tail standing in for the crash.
    const dir = migrationDir({
      "0001_rebuild.sql": "CREATE TABLE dst (id INTEGER PRIMARY KEY);\nINSERT INTO dst (id) SELECT id FROM src;\nBROKEN;",
    });

    await expect(runSelfHostMigrations(db, dir)).rejects.toThrow();

    const dstExists = (raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='dst'").get() as { c: number }).c;
    // The INSERT ... SELECT was rolled back with everything else, so a retry starts from a clean slate rather
    // than inserting the same rows a second time.
    expect(dstExists).toBe(0);
  });

  it("records the ledger row inside the same transaction, so 'applied' and 'actually applied' cannot diverge", async () => {
    const { db, raw } = sqliteDb();
    const dir = migrationDir({ "0001_ok.sql": "CREATE TABLE ok (id INTEGER);" });

    expect(await runSelfHostMigrations(db, dir)).toBe(1);
    const ledger = raw.prepare("SELECT name FROM _selfhost_migrations").all() as Array<{ name: string }>;
    expect(ledger.map((row) => row.name)).toEqual(["0001_ok.sql"]);
    expect(await runSelfHostMigrations(db, dir)).toBe(0);
  });

  it("still heals a drifted database through the per-statement fallback, and says so", async () => {
    const { db, raw } = sqliteDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = migrationDir({
      "0001_add_x.sql": "CREATE TABLE t (id INTEGER);\nALTER TABLE t ADD COLUMN x INTEGER;",
      // A renumbered-migration collision re-adds the same column: the atomic attempt fails, and the tolerant
      // path must still record the file rather than crash-looping the boot.
      "0002_readd_x.sql": "ALTER TABLE t ADD COLUMN x INTEGER;",
    });

    expect(await runSelfHostMigrations(db, dir)).toBe(2);
    expect(warn.mock.calls.some(([line]) => String(line).includes("selfhost_migration_transaction_failed"))).toBe(true);
    const ledger = raw.prepare("SELECT COUNT(*) AS c FROM _selfhost_migrations").get() as { c: number };
    expect(ledger.c).toBe(2);
    vi.restoreAllMocks();
  });

  it("applies a file whose final statement has no trailing semicolon", async () => {
    const { db, raw } = sqliteDb();
    // The ledger INSERT is concatenated onto the file's statements, so an unterminated tail would otherwise
    // fuse onto it and fail to parse.
    const dir = migrationDir({ "0001_tail.sql": "CREATE TABLE tail (id INTEGER)" });

    expect(await runSelfHostMigrations(db, dir)).toBe(1);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tail'").all();
    expect(tables).toHaveLength(1);
  });

  it("falls back to the pre-existing path when the adapter has no transactional surface (real D1)", async () => {
    const { db, raw } = sqliteDb();
    const dir = migrationDir({ "0001_plain.sql": "CREATE TABLE plain (id INTEGER);" });
    // Real Cloudflare D1 exposes no multi-statement transaction; migrations must still apply there.
    const withoutTransaction = { ...(db as unknown as Record<string, unknown>) };
    delete withoutTransaction.execTransaction;

    expect(await runSelfHostMigrations(withoutTransaction as never, dir)).toBe(1);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plain'").all()).toHaveLength(1);
  });
});
