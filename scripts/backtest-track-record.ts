#!/usr/bin/env node
// Read-only D1 → REGRESSED-verdict track-record summary (#8140, epic #8082). Reads the BacktestComparison
// results the advisory backtests persist — #8138's ORB-native threshold runs AND #8139's CI-side logic
// runs, sibling event types with the same metadata.comparison shape — out of audit_events via `wrangler d1
// execute --json`, aggregates them with the pure computeRegressedVerdictTrackRecord (@loopover/engine), and
// prints the summary #8105's Phase-2 merge-gating decision needs. The aggregation lives in the engine
// (pure, unit-tested); this file is the thin IO wrapper — mirrors backtest-corpus-export.ts's identical split.
//
//   tsx scripts/backtest-track-record.ts --db loopover [--remote]
//
// --remote reads the deployed D1 (default is the local miniflare DB). NEVER pass a write command.
import { spawnSync } from "node:child_process";
import { computeRegressedVerdictTrackRecord, type BacktestComparison } from "@loopover/engine";
import { LOGIC_BACKTEST_EVENT_TYPE } from "./backtest-logic-check-core.js";

// Mirrors THRESHOLD_BACKTEST_EVENT_TYPE in src/services/threshold-backtest-run.ts (#8138's writer) and must
// be kept in sync with it by hand — that module is Worker-bound (D1 repositories import graph) and
// deliberately not imported into this standalone script, the same posture backtest-corpus-export.ts takes
// toward signal-tracking-wire's private helpers. The logic-run sibling (#8139) lives in a scripts-local
// module with no Worker-bound imports, so THAT one is imported for real rather than hand-mirrored.
const THRESHOLD_BACKTEST_EVENT_TYPE = "calibration.threshold_backtest_run";

type Args = { db: string | undefined; remote: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { db: undefined, remote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--remote") args.remote = true;
    else if (flag === "--db") args.db = argv[++i];
  }
  return args;
}

// Mirrors export-d1-data.ts's d1Query: read-only, fail-loud so a partial read never passes as a full record.
function d1Query(db: string, remote: boolean, sql: string): Array<Record<string, unknown>> {
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
  if (!args.db) {
    console.error("Usage: tsx scripts/backtest-track-record.ts --db <database> [--remote]");
    process.exit(2);
  }
  const rows = d1Query(
    args.db,
    args.remote,
    `SELECT metadata_json FROM audit_events WHERE event_type IN ('${THRESHOLD_BACKTEST_EVENT_TYPE}', '${LOGIC_BACKTEST_EVENT_TYPE}') ORDER BY created_at ASC`,
  );
  const comparisons: BacktestComparison[] = [];
  for (const row of rows) {
    try {
      const metadata: unknown = JSON.parse(typeof row.metadata_json === "string" ? row.metadata_json : "{}");
      const comparison = (metadata as { comparison?: BacktestComparison }).comparison;
      if (comparison && typeof comparison === "object" && typeof comparison.ruleId === "string") comparisons.push(comparison);
    } catch {
      /* corrupt row -- skip, matching listAuditEventsByType's own fail-open metadata parse */
    }
  }
  const record = computeRegressedVerdictTrackRecord(comparisons);
  console.log(`Backtest track record (threshold + logic runs): ${record.totalRuns} run(s), ${record.regressedRuns} REGRESSED`);
  console.log(`REGRESSED rate: ${record.regressedRate === null ? "N/A (no runs yet)" : record.regressedRate.toFixed(3)}`);
  for (const [ruleId, bucket] of record.perRule) {
    console.log(`  ${ruleId}: total=${bucket.total} regressed=${bucket.regressed} improved=${bucket.improved} unchanged=${bucket.unchanged}`);
  }
}

main();
