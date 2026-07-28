#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH,
  formatCrossRepoEvaluationReport,
  parseCrossRepoEvaluationManifest,
  runCrossRepoEvaluation,
  runCrossRepoFullExecution,
  summarizeCrossRepoEvaluation,
  type ParsedCrossRepoEvaluationManifest,
} from "../dist/lib/cross-repo-evaluation.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// dist/lib/cross-repo-evaluation.js DOES ship a sibling .d.ts (that package's declaration: true),
// so the real ParsedCrossRepoEvaluationManifest type is available -- reused here rather than
// duplicated. repoFilter is string | null (not string | undefined) to match
// parseCrossRepoEvaluationArgs' own inferred return shape below.
type CliOptions = { parsed?: ParsedCrossRepoEvaluationManifest; manifestPath?: string; repoFilter?: string | null };

export function resolveDefaultManifestPath() {
  return join(PACKAGE_ROOT, DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH);
}

export function parseCrossRepoEvaluationArgs(argv?: string[]) {
  const args = argv ?? process.argv.slice(2);
  let manifestPath = resolveDefaultManifestPath();
  let json = false;
  let repoFilter = null;
  let requireMajority = false;
  let fullExecution = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--require-majority") {
      requireMajority = true;
      continue;
    }
    if (token === "--full-execution") {
      fullExecution = true;
      continue;
    }
    if (token === "--manifest") {
      const value = args[i + 1];
      if (!value) return { error: "Missing value for --manifest." };
      manifestPath = value;
      i += 1;
      continue;
    }
    if (token === "--repo") {
      const value = args[i + 1];
      if (!value) return { error: "Missing value for --repo." };
      repoFilter = value;
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    return { error: `Unknown argument: ${token}` };
  }
  return { manifestPath, json, repoFilter, requireMajority, fullExecution };
}

export function loadCrossRepoEvaluationManifest(manifestPath: string): ParsedCrossRepoEvaluationManifest {
  const content = readFileSync(manifestPath, "utf8");
  return parseCrossRepoEvaluationManifest(content);
}

export function runCrossRepoEvaluationCli(options: CliOptions = {}) {
  const parsed = options.parsed ?? loadCrossRepoEvaluationManifest(options.manifestPath ?? resolveDefaultManifestPath());
  // exactOptionalPropertyTypes: conditionally spread rather than always set repoFilter to a
  // possibly-undefined/null value -- the target type's repoFilter?: string admits "absent", not
  // "present and undefined". null and undefined are equally falsy at every downstream truthiness
  // check either way, so this is a type-only normalization, not a behavior change.
  const results = runCrossRepoEvaluation(parsed, options.repoFilter ? { repoFilter: options.repoFilter } : {});
  const summary = summarizeCrossRepoEvaluation(results);
  return { parsed, results, summary };
}

/** Full-execution counterpart of runCrossRepoEvaluationCli (#7634) — same shape, async because agent runs and
 *  the benchmark repos' own test suites are. Dry-run: see runCrossRepoFullExecution. */
export async function runCrossRepoFullExecutionCli(options: CliOptions = {}) {
  const parsed = options.parsed ?? loadCrossRepoEvaluationManifest(options.manifestPath ?? resolveDefaultManifestPath());
  const results = await runCrossRepoFullExecution(parsed, options.repoFilter ? { repoFilter: options.repoFilter } : {});
  const summary = summarizeCrossRepoEvaluation(results);
  return { parsed, results, summary };
}

function printHelp() {
  console.log(
    [
      "loopover-miner cross-repo evaluation (#4788)",
      "",
      "Usage:",
      "  node --experimental-strip-types packages/loopover-miner/scripts/cross-repo-evaluation.ts [options]",
      "",
      "Options:",
      "  --manifest <path>     Benchmark manifest (default: benchmarks/cross-repo/manifest.json)",
      "  --repo <owner/repo>     Evaluate a single benchmark entry",
      "  --full-execution        Past readiness, run the coding agent + the repo's own test suite in a",
      "                          discardable scratch copy (dry-run: no PRs, no writes to the clone).",
      "                          Requires MINER_CODING_AGENT_PROVIDER to be configured.",
      "  --json                  Emit machine-readable JSON on stdout",
      "  --require-majority      Exit 1 unless a strict majority of repos pass",
      "  -h, --help              Show this help",
      "",
      "Prerequisite: clone benchmark repos into LOOPOVER_MINER_REPO_CLONE_DIR (see docs/cross-repo-evaluation.md).",
    ].join("\n"),
  );
}

async function main() {
  const parsedArgs = parseCrossRepoEvaluationArgs();
  if (parsedArgs.help) {
    printHelp();
    return 0;
  }
  if (parsedArgs.error) {
    console.error(parsedArgs.error);
    return 2;
  }

  const { parsed, results, summary } = parsedArgs.fullExecution
    ? await runCrossRepoFullExecutionCli(parsedArgs)
    : runCrossRepoEvaluationCli(parsedArgs);
  if (parsedArgs.json) {
    console.log(JSON.stringify({ warnings: parsed.warnings, results, summary }, null, 2));
  } else {
    if (parsed.warnings.length > 0) {
      console.error(`manifest warnings:\n- ${parsed.warnings.join("\n- ")}`);
    }
    console.log(formatCrossRepoEvaluationReport(results, summary));
  }

  if (parsedArgs.requireMajority && !summary.majorityPassed) return 1;
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
