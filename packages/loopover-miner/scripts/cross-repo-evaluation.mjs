#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constructProductionCodingAgentDriver } from "../lib/coding-agent-construction.js";
import {
  DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH,
  formatCrossRepoEvaluationReport,
  parseCrossRepoEvaluationManifest,
  runCrossRepoEvaluation,
  runCrossRepoExecution,
  summarizeCrossRepoEvaluation,
} from "../lib/cross-repo-evaluation.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDefaultManifestPath() {
  return join(PACKAGE_ROOT, DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH);
}

export function parseCrossRepoEvaluationArgs(argv) {
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

export function loadCrossRepoEvaluationManifest(manifestPath) {
  const content = readFileSync(manifestPath, "utf8");
  return parseCrossRepoEvaluationManifest(content);
}

export function runCrossRepoEvaluationCli(options = {}) {
  const parsed = options.parsed ?? loadCrossRepoEvaluationManifest(options.manifestPath ?? resolveDefaultManifestPath());
  const results = runCrossRepoEvaluation(parsed, { repoFilter: options.repoFilter ?? null });
  const summary = summarizeCrossRepoEvaluation(results);
  return { parsed, results, summary };
}

// Real, dry-run full-execution coding attempt (#7634): resolve the configured coding agent, let it edit the
// local clone, then capture the resulting diff with git -- all against a throwaway clone, no forge writes.
// `git add -A` before the diff so brand-new untracked files count; the acceptance-criteria file is written to
// the OS temp dir (never the clone) so it can't leak into the captured diff.
export async function defaultFullExecutionCodingAttempt(context, deps = {}) {
  const env = deps.env ?? process.env;
  const driver = deps.driver ?? constructProductionCodingAgentDriver(env);
  const scratch = mkdtempSync(join(tmpdir(), "loopover-cross-repo-exec-"));
  const acceptanceCriteriaPath = join(scratch, "acceptance-criteria.md");
  writeFileSync(acceptanceCriteriaPath, context.instructions || "Address the synthetic benchmark issue.", "utf8");
  try {
    const result = await driver.run({
      attemptId: context.attemptId,
      workingDirectory: context.repoPath,
      acceptanceCriteriaPath,
      instructions: context.instructions,
      maxTurns: context.maxTurns,
    });
    const spawn = deps.spawnSync ?? spawnSync;
    spawn("git", ["add", "-A"], { cwd: context.repoPath });
    const diffResult = spawn("git", ["--no-pager", "diff", "--cached"], {
      cwd: context.repoPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const diff = typeof diffResult.stdout === "string" ? diffResult.stdout : "";
    return { ok: result.ok === true, diff, summary: result.summary, error: result.error };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function runCrossRepoExecutionCli(options = {}) {
  const parsed = options.parsed ?? loadCrossRepoEvaluationManifest(options.manifestPath ?? resolveDefaultManifestPath());
  const env = options.env ?? process.env;
  const runCodingAttempt =
    options.runCodingAttempt ?? ((context) => defaultFullExecutionCodingAttempt(context, { env }));
  const results = await runCrossRepoExecution(parsed, {
    repoFilter: options.repoFilter ?? null,
    runCodingAttempt,
    env,
    ...(options.compileRepo ? { compileRepo: options.compileRepo } : {}),
    ...(options.runRepoTests ? { runRepoTests: options.runRepoTests } : {}),
    ...(options.runLocalCommand ? { runLocalCommand: options.runLocalCommand } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });
  const summary = summarizeCrossRepoEvaluation(results);
  return { parsed, results, summary };
}

function printHelp() {
  console.log(
    [
      "loopover-miner cross-repo evaluation (#4788)",
      "",
      "Usage:",
      "  node packages/loopover-miner/scripts/cross-repo-evaluation.mjs [options]",
      "",
      "Options:",
      "  --manifest <path>     Benchmark manifest (default: benchmarks/cross-repo/manifest.json)",
      "  --repo <owner/repo>     Evaluate a single benchmark entry",
      "  --json                  Emit machine-readable JSON on stdout",
      "  --require-majority      Exit 1 unless a strict majority of repos pass",
      "  --full-execution        Dry-run the live discover→plan→code→test loop (#7634) against the",
      "                          fullExecution subset, generating a real diff and running each repo's",
      "                          own test suite locally — no PR submission, no forge writes. Requires a",
      "                          configured coding agent (MINER_CODING_AGENT_PROVIDER).",
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
    ? await runCrossRepoExecutionCli(parsedArgs)
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
  main().then((code) => {
    process.exitCode = code;
  });
}
