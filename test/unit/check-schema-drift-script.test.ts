import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  actualColumnsFor,
  collectSchemaTables,
  declaredColumnsFor,
  diffSchemaAgainstMigrations,
  listActualTables,
  RAW_SQL_ONLY_TABLES,
  replayMigrations,
} from "../../scripts/check-schema-drift.js";
import * as realSchema from "../../src/db/schema";

// #2565: the script imports src/db/schema.ts (a .ts module), so -- like check-migrations.mjs and
// check-openapi-settings-parity.ts -- it must run via `tsx`, the same binary package.json's
// db:schema-drift:check uses, rather than plain `node`.
const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-schema-drift script (#2565)", () => {
  // Most important regression test in this file: proves the REAL current src/db/schema.ts and the REAL
  // migrations/ directory are not already drifted -- if they were, this check would fail on `main` from
  // the moment it merges.
  it("the real repo's schema.ts and migrations/ agree (regression guard)", () => {
    const db = replayMigrations("migrations");
    const mismatches = diffSchemaAgainstMigrations(db, realSchema);

    expect(mismatches).toEqual([]);
  });

  it("prints a clean summary for the real repo state when run as a subprocess", () => {
    const output = execFileSync(TSX_BIN, ["scripts/check-schema-drift.ts"], { encoding: "utf8" });

    expect(output).toMatch(/src\/db\/schema\.ts matches migrations\/ -- \d+ Drizzle tables OK/);
  });

  it("fails when schema.ts declares a column no migration creates", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);\n");
    // Fake a schema module whose declared shape has an extra column vs. the fixture migration.
    const fakeSchema = {
      widgets: fakeSqliteTable("widgets", { id: "id", name: "name", color: "color" }),
    };
    const db = replayMigrations(dir);
    const mismatches = diffSchemaAgainstMigrations(db, fakeSchema);

    expect(mismatches).toContain("widgets.color is declared in src/db/schema.ts but no migration creates that column");
  });

  it("fails when a migration creates a column schema.ts no longer declares", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT, legacy_flag INTEGER);\n");
    const fakeSchema = { widgets: fakeSqliteTable("widgets", { id: "id", name: "name" }) };
    const db = replayMigrations(dir);
    const mismatches = diffSchemaAgainstMigrations(db, fakeSchema);

    expect(mismatches).toContain("widgets.legacy_flag exists in migrations/ but is missing from src/db/schema.ts's widgets declaration");
  });

  it("fails when schema.ts declares a table no migration ever creates", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id INTEGER PRIMARY KEY);\n");
    const fakeSchema = {
      widgets: fakeSqliteTable("widgets", { id: "id" }),
      ghosts: fakeSqliteTable("ghosts", { id: "id" }),
    };
    const db = replayMigrations(dir);
    const mismatches = diffSchemaAgainstMigrations(db, fakeSchema);

    expect(mismatches).toContain('table "ghosts" is declared in src/db/schema.ts but no migration creates it');
  });

  it("fails when a migrated table has no schema.ts declaration and is not raw-SQL-allowlisted", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "0001_undeclared.sql"), "CREATE TABLE undeclared_thing (id INTEGER PRIMARY KEY);\n");
    const db = replayMigrations(dir);
    const mismatches = diffSchemaAgainstMigrations(db, {});

    expect(mismatches).toContain('table "undeclared_thing" exists in migrations/ but has no src/db/schema.ts declaration and is not in RAW_SQL_ONLY_TABLES (scripts/check-schema-drift.ts)');
  });

  it("does not flag a migrated table that is on the raw-SQL-only allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "0001_raw.sql"), "CREATE TABLE feature_flags (id INTEGER PRIMARY KEY);\n");
    const db = replayMigrations(dir);
    const mismatches = diffSchemaAgainstMigrations(db, {}, new Set(["feature_flags"]));

    expect(mismatches).toEqual([]);
  });

  it("does not flag a non-table export (e.g. a helper/type) alongside real tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id INTEGER PRIMARY KEY);\n");
    const fakeSchema = {
      widgets: fakeSqliteTable("widgets", { id: "id" }),
      someHelperFn: () => "not a table",
      someConstant: 42,
    };
    const db = replayMigrations(dir);
    const mismatches = diffSchemaAgainstMigrations(db, fakeSchema);

    expect(mismatches).toEqual([]);
  });

  it("passes cleanly when schema.ts and migrations/ agree exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "0001_widgets.sql"), "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);\n");
    const fakeSchema = { widgets: fakeSqliteTable("widgets", { id: "id", name: "name" }) };
    const db = replayMigrations(dir);

    expect(diffSchemaAgainstMigrations(db, fakeSchema)).toEqual([]);
  });

  it("CLI: reports every mismatch and exits non-zero for a deliberately drifted schema/migration pair", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtschema-drift-cli-"));
    tmpDirs.push(dir);
    // No src/db/schema.ts override exists for the CLI path (main() always imports the REAL schema.ts), so
    // exercise the CLI's drift-reporting/exit-code behavior through a migrations fixture that omits a
    // column the real schema.ts declares on an actual table, guaranteeing at least one reported mismatch
    // without needing to fake-import a schema module through the CLI entrypoint.
    writeFileSync(join(dir, "0001_stub.sql"), "CREATE TABLE stub_only (id INTEGER PRIMARY KEY);\n");
    try {
      execFileSync(TSX_BIN, ["scripts/check-schema-drift.ts"], {
        encoding: "utf8",
        env: { ...process.env, CHECK_SCHEMA_DRIFT_DIR: dir },
      });
      expect.unreachable("expected the CLI to exit non-zero for a drifted fixture");
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      expect(e.status).toBe(1);
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      expect(out).toContain("check-schema-drift: src/db/schema.ts has drifted from migrations/");
      expect(out).toContain("Fix by either updating src/db/schema.ts");
    }
  });

  it("collectSchemaTables / declaredColumnsFor / actualColumnsFor / listActualTables agree on the real repo's webhook_events table", () => {
    const db = replayMigrations("migrations");
    const tables = collectSchemaTables(realSchema);
    const webhookEventsTable = tables.get("webhook_events");
    expect(webhookEventsTable).toBeDefined();

    const declared = declaredColumnsFor(webhookEventsTable!);
    const actual = actualColumnsFor(db, "webhook_events");
    expect(declared).toEqual(actual);
    expect(listActualTables(db).has("webhook_events")).toBe(true);
  });

  it("the RAW_SQL_ONLY_TABLES allowlist covers every migrated table that has no schema.ts declaration", () => {
    // A structural guard on the allowlist itself: every entry must correspond to a table that ACTUALLY
    // exists in the real migrations/ output (otherwise it's dead weight that could mask a real removal),
    // and no entry may also be schema.ts-declared (that would make the allowlist entry redundant/misleading).
    const db = replayMigrations("migrations");
    const actualTables = listActualTables(db);
    const schemaTableNames = new Set(collectSchemaTables(realSchema).keys());

    for (const table of RAW_SQL_ONLY_TABLES) {
      expect(actualTables.has(table)).toBe(true);
      expect(schemaTableNames.has(table)).toBe(false);
    }
  });
});

// --- test-local helpers -----------------------------------------------------------------------------------

/** Build a minimal fake drizzle-shaped table object sufficient for collectSchemaTables/declaredColumnsFor:
 *  real sqliteTable() objects key their DB table name under drizzle-orm's internal Symbol and expose their
 *  columns via getTableColumns(), which itself reads each column's own internal name Symbol -- too much
 *  drizzle-internal surface to fake directly. Instead, build a REAL sqliteTable() via drizzle-orm/sqlite-core
 *  so is(value, SQLiteTable) and getTableColumns() behave identically to the production schema.ts tables
 *  these functions are exercised against elsewhere in this file. */
function fakeSqliteTable(tableName: string, columnDbNames: Record<string, string>) {
  const columns: Record<string, ReturnType<typeof text>> = {};
  for (const [jsKey, dbName] of Object.entries(columnDbNames)) columns[jsKey] = text(dbName);
  return sqliteTable(tableName, columns);
}
