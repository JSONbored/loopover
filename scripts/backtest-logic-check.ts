#!/usr/bin/env node
// Logic/regex-change backtest CLI (#8139, epic #8082) — the CI-side runner .github/workflows/
// calibration-advisory.yml invokes. Loads a corpus manifest (produced by backtest-corpus-export.ts),
// dynamically imports the registered detection function from TWO checkout roots (the PR's head and its base
// — the dual checkout is what makes an honest before/after comparison possible), runs the pure core's
// scoring/comparison, writes the PR-comment Markdown, and optionally persists the run to D1 via
// `wrangler d1 execute` (the one write this epic's CI side performs — a sibling event to #8138's
// THRESHOLD_BACKTEST_EVENT_TYPE rows). All logic lives in backtest-logic-check-core.ts (unit-tested); this
// file is the thin IO wrapper — mirrors backtest-corpus-export.ts's identical split.
//
//   tsx scripts/backtest-logic-check.ts --rule-id <ruleId> --corpus <manifest.json> \
//     --head-root <dir> --base-root <dir> --output <comment.md> \
//     [--head-sha <sha>] [--base-sha <sha>] \
//     [--persist --repo <owner/name> --pr <number> [--db loopover] [--remote]]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { BacktestCase } from "@loopover/engine";
import { checksumCases } from "./backtest-corpus-export-core.js";
import {
  buildLogicBacktestAuditInsertSql,
  filterReplayableCases,
  renderLogicBacktestComment,
  resolveKnownLogicRule,
  runLogicBacktest,
  type LogicDetectionFn,
} from "./backtest-logic-check-core.js";

type Args = {
  ruleId: string | undefined;
  corpus: string | undefined;
  headRoot: string | undefined;
  baseRoot: string | undefined;
  output: string | undefined;
  headSha: string;
  baseSha: string;
  persist: boolean;
  repo: string | undefined;
  pr: string | undefined;
  db: string;
  remote: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    ruleId: undefined,
    corpus: undefined,
    headRoot: undefined,
    baseRoot: undefined,
    output: undefined,
    headSha: "",
    baseSha: "",
    persist: false,
    repo: undefined,
    pr: undefined,
    db: "loopover",
    remote: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--persist") args.persist = true;
    else if (flag === "--remote") args.remote = true;
    else if (flag === "--rule-id") args.ruleId = argv[++i];
    else if (flag === "--corpus") args.corpus = argv[++i];
    else if (flag === "--head-root") args.headRoot = argv[++i];
    else if (flag === "--base-root") args.baseRoot = argv[++i];
    else if (flag === "--output") args.output = argv[++i];
    else if (flag === "--head-sha") args.headSha = argv[++i] ?? "";
    else if (flag === "--base-sha") args.baseSha = argv[++i] ?? "";
    else if (flag === "--repo") args.repo = argv[++i];
    else if (flag === "--pr") args.pr = argv[++i];
    else if (flag === "--db") args.db = argv[++i]!;
  }
  return args;
}

// Import the registered detection function from one checkout root. tsx compiles the checkout's own TS on
// the fly; bare npm specifiers inside it resolve by walking up from the file's directory, so a base checkout
// nested INSIDE the head workspace shares the head's node_modules (see the workflow's checkout layout).
async function importDetectionFn(checkoutRoot: string, filePath: string, exportName: string): Promise<LogicDetectionFn> {
  const moduleUrl = pathToFileURL(resolve(checkoutRoot, filePath)).href;
  const imported = (await import(moduleUrl)) as Record<string, unknown>;
  const fn = imported[exportName];
  if (typeof fn !== "function") {
    throw new Error(`${filePath} in ${checkoutRoot} has no function export named ${exportName}`);
  }
  return fn as LogicDetectionFn;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ruleId || !args.corpus || !args.headRoot || !args.baseRoot || !args.output || (args.persist && (!args.repo || !args.pr))) {
    console.error(
      "Usage: tsx scripts/backtest-logic-check.ts --rule-id <ruleId> --corpus <manifest.json> --head-root <dir> --base-root <dir>" +
        " --output <comment.md> [--head-sha <sha>] [--base-sha <sha>] [--persist --repo <owner/name> --pr <number> [--db loopover] [--remote]]",
    );
    process.exit(2);
  }

  const entry = resolveKnownLogicRule(args.ruleId);

  const manifest = JSON.parse(readFileSync(args.corpus, "utf8")) as { ruleId: string; checksum: string; cases: BacktestCase[] };
  if (manifest.ruleId !== args.ruleId) {
    throw new Error(`corpus manifest is for rule ${manifest.ruleId}, not ${args.ruleId}`);
  }
  if (checksumCases(manifest.cases) !== manifest.checksum) {
    throw new Error(`corpus manifest checksum mismatch — re-export with backtest-corpus-export.ts`);
  }

  const baselineDetect = await importDetectionFn(args.baseRoot, entry.filePath, entry.exportName);
  const candidateDetect = await importDetectionFn(args.headRoot, entry.filePath, entry.exportName);

  const replayable = filterReplayableCases(manifest.cases);
  const skippedCount = manifest.cases.length - replayable.length;
  const comparison = runLogicBacktest(args.ruleId, replayable, baselineDetect, candidateDetect);

  writeFileSync(
    args.output,
    renderLogicBacktestComment(comparison, {
      replayableCount: replayable.length,
      skippedCount,
      headSha: args.headSha,
      baseSha: args.baseSha,
      corpusChecksum: manifest.checksum,
    }),
  );

  if (args.persist) {
    const sql = buildLogicBacktestAuditInsertSql({
      id: crypto.randomUUID(),
      targetKey: `${args.repo}#${args.pr}`,
      comparison,
      headSha: args.headSha,
      baseSha: args.baseSha,
      corpusChecksum: manifest.checksum,
      replayableCount: replayable.length,
      skippedCount,
      createdAt: new Date().toISOString(),
    });
    const result = spawnSync("npx", ["wrangler", "d1", "execute", args.db, args.remote ? "--remote" : "--local", "--json", "--command", sql], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) {
      // Best-effort, mirroring persistThresholdBacktestRuns's .catch(() => undefined): a persistence failure
      // must never fail the advisory check that produced the comparison — the comment still posts.
      console.error(`warning: audit-event persist failed (${result.status}): ${(result.stderr || result.stdout || "").slice(0, 500)}`);
    }
  }

  console.error(
    `logic backtest for ${args.ruleId}: ${comparison.verdict} (${replayable.length} replayed, ${skippedCount} skipped) → ${args.output}`,
  );
}

await main();
