#!/usr/bin/env node
// Slop-corpus replay backfill CLI (#8277) — phase 3 of the calibration backfill family. Reads a
// backtest-corpus MANIFEST (backtest-corpus-export.ts's output for ai_consensus_defect — the archived
// raw-context diffs plus human labels), replays the deterministic slop scorer over each diff via the pure
// core (backfill-slop-corpus-core.ts), and — ONLY with --apply — writes the provenance-tagged
// `slop_gate_score` fired/override pairs back. Zero GitHub traffic: every input is already on disk or in
// the store. Mirrors backfill-calibration-corpus.ts's exact wrangler/--pg dual-path + dry-run-default.
//
//   tsx scripts/backfill-slop-corpus.ts --corpus corpus.json [--apply] [--db loopover] [--remote]
//   tsx scripts/backfill-slop-corpus.ts --corpus corpus.json --apply --pg postgres://…   (bare --pg uses DATABASE_URL)
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { BacktestCase } from "@loopover/engine";
import { openPgDatabase, resolvePgConnection, type PgCliSession } from "./pg-cli.js";
import { buildBackfillInsertStatements } from "./backfill-calibration-corpus-core.js";
import { renderSlopReplayReport, replaySlopCorpus, type SlopReplaySourceCase } from "./backfill-slop-corpus-core.js";

type Args = { corpus: string | undefined; db: string; remote: boolean; apply: boolean; pgPresent: boolean; pgValue: string | undefined };

function parseArgs(argv: string[]): Args {
  const args: Args = { corpus: undefined, db: "loopover", remote: false, apply: false, pgPresent: false, pgValue: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--corpus") args.corpus = argv[++i];
    else if (flag === "--remote") args.remote = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--db") args.db = argv[++i]!;
    else if (flag === "--pg") {
      args.pgPresent = true;
      if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) args.pgValue = argv[++i];
    }
  }
  return args;
}

function d1Execute(db: string, remote: boolean, sql: string): void {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
}

/** Project manifest cases into replay sources: only cases carrying a non-empty archived diff qualify
 *  (the core re-checks and counts, so the numbers stay honest either way). */
export function manifestToSourceCases(cases: readonly BacktestCase[]): SlopReplaySourceCase[] {
  const sources: SlopReplaySourceCase[] = [];
  for (const backtestCase of cases) {
    const diff = backtestCase.metadata?.diff;
    sources.push({
      targetKey: backtestCase.targetKey,
      label: backtestCase.label,
      firedAt: backtestCase.firedAt,
      decidedAt: backtestCase.decidedAt,
      diff: typeof diff === "string" ? diff : "",
    });
  }
  return sources;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.corpus) {
    console.error("Usage: tsx scripts/backfill-slop-corpus.ts --corpus <manifest.json> [--apply] [--db loopover|--remote|--pg …]");
    return 1;
  }
  const manifest = JSON.parse(readFileSync(args.corpus, "utf8")) as { cases?: BacktestCase[] };
  if (!Array.isArray(manifest.cases)) {
    console.error("--corpus file has no cases[] — expected a backtest-corpus-export manifest.");
    return 1;
  }

  const report = replaySlopCorpus(manifestToSourceCases(manifest.cases));
  console.log(renderSlopReplayReport(report, args.apply ? "apply" : "dry-run"));
  if (!args.apply || report.rows.length === 0) return 0;

  const pgConnection = resolvePgConnection(args.pgPresent, args.pgValue, process.env.DATABASE_URL);
  const pgSession: PgCliSession | null = pgConnection ? openPgDatabase(pgConnection) : null;
  try {
    for (const statement of buildBackfillInsertStatements(report.rows)) {
      if (pgSession) await pgSession.db.prepare(statement).run();
      else d1Execute(args.db, args.remote, statement);
    }
    console.log(`applied ${report.rows.length} row(s) to ${pgSession ? "postgres" : `d1:${args.db}${args.remote ? " (remote)" : ""}`}.`);
    return 0;
  } finally {
    await pgSession?.close();
  }
}

// Entry guard (the audit-quality-gate-min-score.ts idiom): tests import this module's exported helpers,
// so main() must run ONLY under direct execution — an import-time process.exit fails the whole vitest run
// as an unhandled rejection even with every test green.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
