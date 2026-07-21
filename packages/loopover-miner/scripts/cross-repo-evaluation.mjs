#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH,
  formatCrossRepoEvaluationReport,
  formatCrossRepoExecutionReport,
  parseCrossRepoEvaluationManifest,
  runCrossRepoEvaluation,
  runFullCrossRepoExecution,
  summarizeCrossRepoEvaluation,
  summarizeCrossRepoExecution,
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

// --- Full-execution seams (#7634) -------------------------------------------------------------------------------
// Real, DRY-RUN implementations wired into the harness's injectable seams. Every one operates on the local clone
// only: builds/tests run the target repo's OWN commands in its clone, and the coding-agent step edits the clone,
// captures the diff, and then hard-resets it back to HEAD -- nothing is ever pushed and no PR is ever opened.

/** Run one of the target repo's own commands (build or test) in its clone. `ok` is a clean exit 0. The command
 *  string comes from stack detection (`detectRepoStack`, e.g. "npm test", "pytest", "cargo build"); it is split on
 *  whitespace and spawned WITHOUT a shell, so there is no shell metacharacter interpretation of the command. */
export function spawnRepoCommand({ repoPath, command }) {
  const [bin, ...args] = String(command).split(/\s+/).filter(Boolean);
  if (!bin) return { ok: false, detail: "empty command" };
  const child = spawnSync(bin, args, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false });
  if (child.error) return { ok: false, detail: child.error.message };
  const ok = child.status === 0;
  const detail = ok ? undefined : (child.stderr || child.stdout || `exit ${child.status}`).trim().split("\n").slice(-3).join("\n");
  return { ok, detail };
}

/** Discard the coding agent's edits so the clone is pristine for the next run (dry-run: never keep the change). */
export function resetRepo(repoPath) {
  spawnSync("git", ["-C", repoPath, "checkout", "--", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", repoPath, "clean", "-fd"], { encoding: "utf8" });
}

/**
 * Build the real coding-agent seam. Runs the configured coding-agent driver against the clone (dry-run gating
 * honored), then returns the `git diff` it produced and hard-resets the clone. Lazy-imports the engine + spec
 * modules so the readiness-only CLI path never pays for them. Requires a configured driver + its credentials
 * (see docs/cross-repo-evaluation.md); an unconfigured environment surfaces as an `other` execution failure.
 */
export async function buildAgentAttemptSeam(env) {
  const [{ runCodingAgentAttempt, resolveFirstConfiguredCodingAgentDriverName }, { buildCodingTaskSpec }] =
    await Promise.all([import("@loopover/engine"), import("../lib/coding-task-spec.js")]);
  return async function runAgentAttempt({ repoFullName, repoPath, stack }) {
    const providerName = resolveFirstConfiguredCodingAgentDriverName(env);
    if (!providerName) throw new Error("no coding-agent provider configured (set MINER_CODING_AGENT_PROVIDER)");
    const spec = buildCodingTaskSpec({
      repoFullName,
      issue: {
        number: 1,
        title: "Cross-repo full-execution benchmark task",
        body: "Make a small, correct, self-contained improvement to this repository and keep its own test suite green.",
        labels: ["bug"],
      },
      context: { issues: [{ number: 1 }], pullRequests: [] },
      claimLedger: { listClaims: () => [] },
      workingDirectory: repoPath,
      detectRepoStack: () => stack,
    });
    const acceptanceCriteriaPath = join(mkdtempSync(join(tmpdir(), "cross-repo-exec-")), "acceptance.md");
    writeFileSync(acceptanceCriteriaPath, "The change compiles and the repository's own test suite passes.\n");
    try {
      await runCodingAgentAttempt({
        providerName,
        env,
        agentDryRun: false, // the agent must really edit the clone to produce a diff; the DISCARD below is the dry-run guard
        task: {
          attemptId: `cross-repo-${repoFullName.replace(/[^\w.-]+/g, "-")}`,
          workingDirectory: repoPath,
          acceptanceCriteriaPath,
          instructions: spec.instructions ?? "Make a small, correct, tested improvement to this repository.",
          maxTurns: 40,
        },
      });
      const diffResult = spawnSync("git", ["-C", repoPath, "--no-pager", "diff"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { diff: diffResult.status === 0 ? diffResult.stdout : "" };
    } finally {
      resetRepo(repoPath);
      rmSync(dirname(acceptanceCriteriaPath), { recursive: true, force: true });
    }
  };
}

export async function runFullCrossRepoExecutionCli(options = {}) {
  const env = options.env ?? process.env;
  const parsed = options.parsed ?? loadCrossRepoEvaluationManifest(options.manifestPath ?? resolveDefaultManifestPath());
  const seams = {
    runAgentAttempt: options.runAgentAttempt ?? (await buildAgentAttemptSeam(env)),
    buildRepo: options.buildRepo ?? spawnRepoCommand,
    runRepoTests: options.runRepoTests ?? spawnRepoCommand,
    env,
  };
  const results = await runFullCrossRepoExecution(parsed, { ...options, repoFilter: options.repoFilter ?? null, ...seams });
  const summary = summarizeCrossRepoExecution(results);
  return { parsed, results, summary };
}

function printHelp() {
  console.log(
    [
      "loopover-miner cross-repo evaluation (#4788, full-execution #7634)",
      "",
      "Usage:",
      "  node packages/loopover-miner/scripts/cross-repo-evaluation.mjs [options]",
      "",
      "Options:",
      "  --manifest <path>     Benchmark manifest (default: benchmarks/cross-repo/manifest.json)",
      "  --repo <owner/repo>     Evaluate a single benchmark entry",
      "  --full-execution        Run the discover->plan->code->test loop in dry-run (needs a configured",
      "                          coding-agent driver + credentials); default is readiness-only",
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

  if (parsedArgs.fullExecution) {
    const { parsed, results, summary } = await runFullCrossRepoExecutionCli(parsedArgs);
    if (parsedArgs.json) {
      console.log(JSON.stringify({ warnings: parsed.warnings, results, summary }, null, 2));
    } else {
      if (parsed.warnings.length > 0) console.error(`manifest warnings:\n- ${parsed.warnings.join("\n- ")}`);
      console.log(formatCrossRepoExecutionReport(results, summary));
    }
    if (parsedArgs.requireMajority && !summary.majorityPassed) return 1;
    return 0;
  }

  const { parsed, results, summary } = runCrossRepoEvaluationCli(parsedArgs);
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
