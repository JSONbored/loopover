#!/usr/bin/env node
// Read-only D1 → self-host export (#selfhost-migration Phase 3). Enumerates the cloud D1's tables, SELECTs each
// via `wrangler d1 execute --json` (no writes to D1), and emits a redacted, checksummed, per-table JSON dump plus
// a manifest the self-host importer validates against. The data transformation lives in export-d1-core.ts (pure,
// unit-tested); this file is the thin IO wrapper.
//
//   tsx scripts/export-d1-data.ts --db loopover --output ./export [--remote] [--since-date 2026-06-01T00:00:00Z] [--since-column updated_at]
//
// --remote reads the deployed D1 (default is the local miniflare DB). --since-date does an INCREMENTAL export
// (rows whose --since-column is >= the date); omit it for a full export. NEVER pass a write command.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildExportManifest, buildTableExport, EXCLUDED_TABLES, isSafeTableName, type D1Row, type TableExport } from "./export-d1-core.js";

type Args = {
  db: string | undefined;
  output: string;
  remote: boolean;
  sinceDate: string | undefined;
  sinceColumn: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { db: undefined, output: "./export", remote: false, sinceDate: undefined, sinceColumn: "updated_at" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--db") args.db = argv[++i];
    else if (flag === "--output") args.output = argv[++i]!;
    else if (flag === "--since-date") args.sinceDate = argv[++i];
    else if (flag === "--since-column") args.sinceColumn = argv[++i]!;
  }
  return args;
}

// Run a read-only SQL statement via wrangler and return the result rows. Throws on any wrangler failure so a
// partial/garbled export can never be mistaken for a complete one.
function d1Query(db: string, remote: boolean, sql: string): D1Row[] {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  const parsed = JSON.parse(result.stdout);
  // wrangler returns [{ results: [...], success, meta }] (one entry per statement).
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

function listTables(db: string, remote: boolean): string[] {
  const rows = d1Query(db, remote, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  // Only export plain-identifier table names (sqlite_master is trusted, but the name is interpolated into the SELECT
  // below, so validate it anyway). A non-conforming name is skipped loudly rather than risking an injected SELECT.
  return rows
    .map((row) => row.name)
    .filter((name): name is string => {
      if (!isSafeTableName(name) || EXCLUDED_TABLES.has(name as string)) {
        if (typeof name === "string" && !isSafeTableName(name)) console.error(`skipping table with an unexpected name: ${JSON.stringify(name).slice(0, 80)}`);
        return false;
      }
      return true;
    });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db) {
    console.error("Usage: tsx scripts/export-d1-data.ts --db <database> --output <dir> [--remote] [--since-date <iso>] [--since-column <col>]");
    process.exit(2);
  }
  const tablesDir = join(args.output, "tables");
  mkdirSync(tablesDir, { recursive: true });

  const tableExports: TableExport[] = [];
  for (const table of listTables(args.db, args.remote)) {
    if (!isSafeTableName(table)) continue; // provably-safe interpolation: the name is a validated plain identifier
    const rows = d1Query(args.db, args.remote, `SELECT * FROM "${table}"`);
    const exported = buildTableExport(table, rows, { sinceColumn: args.sinceColumn, sinceDate: args.sinceDate });
    if (exported === null) continue; // excluded
    writeFileSync(join(tablesDir, `${table}.json`), `${JSON.stringify({ table: exported.table, checksum: exported.checksum, redactedColumns: exported.redactedColumns, rows: exported.rows }, null, 2)}\n`);
    tableExports.push(exported);
    console.error(`exported ${table}: ${exported.rowCount} rows${exported.redactedColumns.length ? ` (redacted: ${exported.redactedColumns.join(", ")})` : ""}`);
  }

  const manifest = buildExportManifest(tableExports, {
    source: args.remote ? "d1-remote" : "d1-local",
    database: args.db,
    incremental: Boolean(args.sinceDate),
    ...(args.sinceDate ? { sinceColumn: args.sinceColumn, sinceDate: args.sinceDate } : {}),
  });
  writeFileSync(join(args.output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`\nexport complete: ${manifest.tableCount} tables, ${manifest.totalRows} rows → ${args.output}`);
}

main();
