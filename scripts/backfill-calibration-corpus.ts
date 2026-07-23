#!/usr/bin/env node
// Calibration-corpus backfill CLI (#8157 phase 1, epic #8082). Reads historical review_targets decisions
// out of D1 via `wrangler d1 execute --json`, synthesizes the fired/override pairs the live capture
// writers (#8101) would have produced, and — ONLY with --apply — writes them back as idempotent
// `INSERT OR IGNORE` rows. Dry-run is the default and prints the report #8157 requires before any apply.
// All transform logic lives in backfill-calibration-corpus-core.ts (unit-tested); this file is the thin IO
// wrapper — mirrors backtest-corpus-export.ts's identical split.
//
//   tsx scripts/backfill-calibration-corpus.ts --db loopover [--remote] [--apply]
//   … --pg postgres://…   runs against a self-host Postgres instead (#8171; bare --pg uses DATABASE_URL)
//
// Deployment note (#8157): source AND destination are the same database — the ledger of record for
// WHICHEVER deployment the flags select: the D1 default, or a self-host Postgres via --pg (#8171). The
// pg path rides the same selfhost adapter the Worker uses, so INSERT OR IGNORE keeps its idempotency
// contract through the dialect translation.
import { spawnSync } from "node:child_process";
import { openPgDatabase, resolvePgConnection, type PgCliSession } from "./pg-cli.js";
import {
  buildBackfillInsertStatements,
  renderBackfillReport,
  synthesizeBackfillRows,
  type ReviewTargetDecisionRow,
} from "./backfill-calibration-corpus-core.js";

type Args = { db: string; remote: boolean; apply: boolean; pgPresent: boolean; pgValue: string | undefined };

function parseArgs(argv: string[]): Args {
  const args: Args = { db: "loopover", remote: false, apply: false, pgPresent: false, pgValue: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--db") args.db = argv[++i]!;
    else if (flag === "--pg") {
      args.pgPresent = true;
      if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) args.pgValue = argv[++i];
    }
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pgConnection = resolvePgConnection(args.pgPresent, args.pgValue, process.env.DATABASE_URL);
  const pgSession: PgCliSession | null = pgConnection ? openPgDatabase(pgConnection) : null;
  try {
    await run(args, pgSession);
  } finally {
    await pgSession?.close();
  }
}

async function run(args: Args, pgSession: PgCliSession | null): Promise<void> {
  const execute = async (sql: string): Promise<Array<Record<string, unknown>>> =>
    pgSession ? ((await pgSession.db.prepare(sql).all<Record<string, unknown>>()).results ?? []) : d1Execute(args.db, args.remote, sql);

  const rows = await execute(
    `SELECT repo, number, verdict, status, json_extract(decision_json, '$.confidence') AS confidence, terminal_at
       FROM review_targets WHERE kind = 'pull_request'`,
  );
  const projected: ReviewTargetDecisionRow[] = rows.map((row) => ({
    repo: typeof row.repo === "string" ? row.repo : "",
    number: typeof row.number === "number" ? row.number : Number(row.number ?? 0),
    verdict: typeof row.verdict === "string" ? row.verdict : null,
    status: typeof row.status === "string" ? row.status : null,
    // D1's json_extract returns a JSON number as a number; Postgres's translated `->>` ALWAYS returns
    // text (the same #4997 semantics the dialect suite pins) — coerce, don't type-gate (#8171).
    confidence: toFiniteNumber(row.confidence),
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
    await execute(statement);
    written += 1;
    console.error(`applied statement ${written}/${statements.length}`);
  }
  console.error(`backfill applied: ${report.rows.length} row(s) across ${statements.length} statement(s) (re-runs are no-ops).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
