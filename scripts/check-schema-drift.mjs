#!/usr/bin/env tsx
// #2565: src/db/schema.ts (Drizzle ORM sqliteTable declarations) is a single shared file where two
// independently-valid PRs can each add a new column to the SAME table. scripts/check-migrations.mjs's
// detectColumnCollisions (#2551) only catches a git-merge-race collision between two DIFFERENT migration
// files that both add the same (table, column) pair -- it never reads src/db/schema.ts at all, so it cannot
// see the DIFFERENT gap this check closes: schema.ts's DECLARED shape (what Drizzle thinks a table's columns
// are) drifting from what migrations/ ACTUALLY produces when replayed against a fresh DB -- e.g. schema.ts
// declares a column no migration ever created, or a migration created a column later dropped from schema.ts
// without cleaning up the migration. Nothing else in CI catches that.
//
// Mechanism: replay every migrations/*.sql file into a fresh in-memory node:sqlite DB (mirrors
// test/helpers/d1.ts's TestD1Database -- same concatenate-sorted-files-then-exec approach, so this check and
// the test suite's DB can never silently disagree about what migrations "actually" produce), introspect each
// table's REAL columns via `PRAGMA table_info`, then compare against src/db/schema.ts's DECLARED columns via
// drizzle-orm's getTableColumns (keyed by each column's .name -- the actual DB column name, not the JS
// property name). Diff the two column-name sets per table.
//
// Run via `tsx` (not plain `node`) for the same reason as check-migrations.mjs and
// check-openapi-settings-parity.mjs: this script imports src/db/schema.ts (a .ts module) directly, and a bare
// `node` invocation can't resolve a `.ts` import without an experimental flag CI's pinned Node isn't
// guaranteed to support.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getTableColumns, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema.ts";

const MIGRATIONS_DIR = process.env.CHECK_SCHEMA_DRIFT_DIR || "migrations";

// Feature/aggregate tables that intentionally live ONLY in migrations/ and are accessed via raw SQL
// (env.DB.prepare(...)) rather than through a Drizzle sqliteTable declaration -- the house pattern documented
// in .claude/skills/contributing-to-gittensory/reference.md ("core tables use Drizzle; feature/aggregate
// tables use raw-SQL migrations"). Each of these is confirmed (by direct inspection at the time this check
// was added) to be actively read/written via raw SQL elsewhere in src/ -- this is not a dead-table allowlist,
// it is a declared exception to "every migrated table must have a matching schema.ts declaration". Adding a
// table here without also confirming it is genuinely raw-SQL-only is a reviewer-visible diff, not a silent
// gap this check would otherwise catch.
export const RAW_SQL_ONLY_TABLES = new Set([
  "contributor_gate_history",
  "global_agent_controls",
  "global_contributor_blacklist",
  "global_moderation_config",
  "orb_enrollments",
  "orb_export_cursor",
  "orb_github_installations",
  "orb_instances",
  "orb_pr_outcomes",
  "orb_relay_failures",
  "orb_signals",
  "orb_webhook_events",
  "override_audit",
  "repo_chunks",
  "review_audit",
  "review_targets",
  "submission_drafts",
  "submission_user_tokens",
  "submitter_stats",
  "system_flags",
  "tunables_overrides",
  "tunables_overrides_shadow",
]);

/** Replay every migrations/*.sql file (concatenated, sorted -- the same order wrangler and
 *  test/helpers/d1.ts's TestD1Database use) into a fresh in-memory SQLite DB and return it. Deliberately not
 *  importing TestD1Database directly: that helper caches the concatenated SQL into module-scope state sized
 *  for the test suite's lifetime and always reads the repo's real `migrations/` dir, whereas this script's
 *  tests need an independently directed migrations dir (CHECK_SCHEMA_DRIFT_DIR) to exercise a deliberately
 *  drifted fixture without touching the real migrations/. */
export function replayMigrations(dir) {
  const sql = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(`${dir}/${file}`, "utf8"))
    .join("\n");
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return db;
}

/** The set of real, non-sqlite-internal table names present in a replayed migrations DB. */
export function listActualTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  return new Set(rows.map((row) => String(row.name)));
}

/** The actual DB column names (via PRAGMA table_info's `name`, not cid/type/etc.) for one table. */
export function actualColumnsFor(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

/** Every exported drizzle sqliteTable in the given schema module, keyed by its declared DB table name (not
 *  the JS export name -- schema.ts's export identifiers are camelCase, but getTableColumns / PRAGMA both key
 *  on the actual snake_case DB name). Guards against a non-table export (schema.ts today exports only
 *  tables, but this stays correct if a helper/type export is ever added alongside them). */
export function collectSchemaTables(schemaModule) {
  const tables = new Map();
  for (const value of Object.values(schemaModule)) {
    if (!is(value, SQLiteTable)) continue;
    tables.set(value[SQLiteTable.Symbol.Name], value);
  }
  return tables;
}

/** The declared DB column names (getTableColumns(table)[key].name -- the actual DB column, not the JS
 *  property name) for one drizzle table object. */
export function declaredColumnsFor(table) {
  return new Set(Object.values(getTableColumns(table)).map((column) => column.name));
}

/**
 * Diff migrations/'s actually-produced schema against src/db/schema.ts's declared shape. Pure given the two
 * already-loaded inputs (an open replayed DB and the imported schema module) -- no filesystem/import side
 * effects of its own, so it's directly unit-testable against a hand-built fixture DB + fake schema module.
 * Returns one mismatch entry per (table, column) or per whole missing table; empty when they agree.
 */
export function diffSchemaAgainstMigrations(db, schemaModule, rawSqlOnlyTables = RAW_SQL_ONLY_TABLES) {
  const actualTables = listActualTables(db);
  const schemaTables = collectSchemaTables(schemaModule);
  const mismatches = [];

  for (const [tableName, table] of [...schemaTables].sort(([a], [b]) => a.localeCompare(b))) {
    if (!actualTables.has(tableName)) {
      mismatches.push(`table "${tableName}" is declared in src/db/schema.ts but no migration creates it`);
      continue;
    }
    const declared = declaredColumnsFor(table);
    const actual = actualColumnsFor(db, tableName);
    const missingFromMigrations = [...declared].filter((column) => !actual.has(column)).sort();
    const missingFromSchema = [...actual].filter((column) => !declared.has(column)).sort();
    for (const column of missingFromMigrations) {
      mismatches.push(`${tableName}.${column} is declared in src/db/schema.ts but no migration creates that column`);
    }
    for (const column of missingFromSchema) {
      mismatches.push(`${tableName}.${column} exists in migrations/ but is missing from src/db/schema.ts's ${tableName} declaration`);
    }
  }

  // A table that only exists in migrations/ (never in schema.ts at all) is either a legitimate raw-SQL-only
  // feature table (rawSqlOnlyTables) or an undeclared drift -- flag anything not on the allowlist.
  for (const tableName of [...actualTables].sort()) {
    if (schemaTables.has(tableName) || rawSqlOnlyTables.has(tableName)) continue;
    mismatches.push(`table "${tableName}" exists in migrations/ but has no src/db/schema.ts declaration and is not in RAW_SQL_ONLY_TABLES (scripts/check-schema-drift.mjs)`);
  }

  return mismatches;
}

function main() {
  const db = replayMigrations(MIGRATIONS_DIR);
  const mismatches = diffSchemaAgainstMigrations(db, schema);

  if (mismatches.length > 0) {
    process.stderr.write(`check-schema-drift: src/db/schema.ts has drifted from migrations/ -- ${mismatches.length} mismatch(es):\n`);
    for (const mismatch of mismatches) process.stderr.write(`  - ${mismatch}\n`);
    process.stderr.write("Fix by either updating src/db/schema.ts to match migrations/, adding a migration for the missing column/table, or (for an intentionally raw-SQL-only table) adding it to RAW_SQL_ONLY_TABLES in scripts/check-schema-drift.mjs.\n");
    process.exit(1);
  }

  const tableCount = collectSchemaTables(schema).size;
  process.stdout.write(`check-schema-drift: src/db/schema.ts matches migrations/ -- ${tableCount} Drizzle tables OK, ${RAW_SQL_ONLY_TABLES.size} raw-SQL-only tables allowlisted.\n`);
}

// Guard so importing this module for its pure exports (tests) never triggers the file-read/exit side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
