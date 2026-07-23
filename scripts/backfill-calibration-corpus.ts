#!/usr/bin/env node
// Calibration-corpus backfill CLI (#8157 phase 1, epic #8082). Reads historical review_targets decisions
// out of D1 via `wrangler d1 execute --json`, synthesizes the fired/override pairs the live capture
// writers (#8101) would have produced, and — ONLY with --apply — writes them back as idempotent
// `INSERT OR IGNORE` rows. Dry-run is the default and prints the report #8157 requires before any apply.
// All transform logic lives in backfill-calibration-corpus-core.ts (unit-tested); this file is the thin IO
// wrapper — mirrors backtest-corpus-export.ts's identical split.
//
//   tsx scripts/backfill-calibration-corpus.ts --db loopover [--remote] [--apply]
//
// Deployment note (#8157): source AND destination are the same D1 — the ledger of record for this
// deployment. Self-host operators' corpora live in their own Postgres; a pg-driver variant is an explicit
// non-goal here.
import { spawnSync } from "node:child_process";
import {
  buildBackfillInsertStatements,
  renderBackfillReport,
  synthesizeBackfillRows,
  type ReviewTargetDecisionRow,
} from "./backfill-calibration-corpus-core.js";

type Args = { db: string; remote: boolean; apply: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { db: "loopover", remote: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--db") args.db = argv[++i]!;
  }
  return args;
}

// Mirrors export-d1-data.ts's d1Query: fail-loud so a partial read/write never passes silently.
function d1Execute(db: string, remote: boolean, sql: string): Array<Record<string, unknown>> {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
  const parsed = JSON.parse(result.stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const rows = d1Execute(
    args.db,
    args.remote,
    `SELECT repo, number, verdict, status, json_extract(decision_json, '$.confidence') AS confidence, terminal_at
       FROM review_targets WHERE kind = 'pull_request'`,
  );
  const projected: ReviewTargetDecisionRow[] = rows.map((row) => ({
    repo: typeof row.repo === "string" ? row.repo : "",
    number: typeof row.number === "number" ? row.number : Number(row.number ?? 0),
    verdict: typeof row.verdict === "string" ? row.verdict : null,
    status: typeof row.status === "string" ? row.status : null,
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    terminalAt: typeof row.terminal_at === "string" ? row.terminal_at : null,
  }));

  const report = synthesizeBackfillRows(projected);
  console.log(renderBackfillReport(report, args.apply ? "apply" : "dry-run"));

  if (!args.apply) {
    console.error("dry-run only — re-run with --apply to write. Rows are INSERT OR IGNORE with deterministic ids (idempotent).");
    return;
  }
  const statements = buildBackfillInsertStatements(report.rows);
  let written = 0;
  for (const statement of statements) {
    d1Execute(args.db, args.remote, statement);
    written += 1;
    console.error(`applied statement ${written}/${statements.length}`);
  }
  console.error(`backfill applied: ${report.rows.length} row(s) across ${statements.length} statement(s) (re-runs are no-ops).`);
}

main();
