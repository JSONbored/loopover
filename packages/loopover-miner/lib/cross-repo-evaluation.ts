// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.

import { spawn as nodeSpawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Already a transitive dependency via coding-task-spec.js's own engine imports -- this adds no load weight.
import { ACCEPTANCE_CRITERIA_FILENAME } from "@loopover/engine";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";
import type { DetectedRepoStack, RepoStackResult } from "./stack-detection.js";

/** Failure taxonomy surfaced in per-repo reports (#4788). */
export const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
  STACK_DETECTION: "stack_detection_gap";
  EXECUTION: "execution_gap";
  GITTENSOR_ASSUMPTION: "loopover_assumption";
  CLONE_SETUP: "clone_setup";
  OTHER: "other";
}> = Object.freeze({
  STACK_DETECTION: "stack_detection_gap",
  EXECUTION: "execution_gap",
  GITTENSOR_ASSUMPTION: "loopover_assumption",
  CLONE_SETUP: "clone_setup",
  OTHER: "other",
});

/** Instruction substrings that indicate a POSITIVE loopover/LoopOver CI assumption leaked into the agent prompt.
 *  Lines that explicitly tell the agent *not* to assume these are filtered out before scanning. */
export const GITTENSOR_POSITIVE_ASSUMPTION_CHECKS: ReadonlyArray<{ id: string; pattern: RegExp }> = Object.freeze([
  { id: "test_ci_script", pattern: /npm run test:ci/i },
  { id: "codecov_patch", pattern: /codecov\/patch/i },
  { id: "gittensor_label", pattern: /gittensor:(?:bug|feature|priority)/i },
  { id: "loopover_gate", pattern: /loopover gate/i },
]);

export const DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH: string = "benchmarks/cross-repo/manifest.json";
export const MAX_CROSS_REPO_MANIFEST_BYTES: number = 65_536;
export const MAX_CROSS_REPO_MANIFEST_REPOS: number = 100;

export type CrossRepoEvaluationManifestRepo = {
  repoFullName: string;
  stackHint?: string;
  requireTestCommand?: boolean;
  fixturePath?: string;
};

export type ParsedCrossRepoEvaluationManifest = {
  present: boolean;
  manifest: { repos: CrossRepoEvaluationManifestRepo[] };
  warnings: string[];
};

export type CrossRepoEvaluationResult = {
  repoFullName: string;
  passed: boolean;
  failureCategory: string | null;
  reason: string | null;
  stackDetected: boolean;
  usedDefaultGoalSpec: boolean | null;
  assumptionFindings: Array<{ id: string; line: string }>;
  stack?: RepoStackResult;
};

export type CrossRepoEvaluationSummary = {
  total: number;
  passed: number;
  failed: number;
  majorityPassed: boolean;
  withoutLoopoverConfig: number;
  failuresByCategory: Record<string, number>;
};

type EvaluateRepoReadinessOptions = {
  repoPath?: string;
  resolveRepoPath?: (entry: { repoFullName: string }) => string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  detectRepoStack?: (repoPath: string) => RepoStackResult;
  resolveMinerGoalSpec?: (repoPath: string) => { present: boolean };
  buildCodingTaskSpec?: (input: Record<string, unknown>) => {
    ready: boolean;
    verdict?: string;
    instructions?: string;
    acceptanceCriteriaPath?: string;
  };
};

// True UTF-8 byte count for the size guard (#7223): JS string `.length` is UTF-16 code units, which under-counts
// any multi-byte character (up to 4x for astral-plane code points), so `MAX_CROSS_REPO_MANIFEST_BYTES` -- named
// and warned about in BYTES -- was actually being compared against a code-unit count. Mirrors the identical helper
// in the three siblings this parser's own comment claims to follow: fleet-run-manifest.ts, miner-goal-spec.ts,
// and ams-policy-spec.ts.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function cloneEmptyManifest(warnings: string[] = []): ParsedCrossRepoEvaluationManifest {
  return { present: false, manifest: { repos: [] }, warnings };
}

/** Canonical `owner/repo` with exactly one slash and safe segments; anything else → null. */
export function normalizeCrossRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [owner, repo, extra] = value.trim().split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;
  return `${owner}/${repo}`;
}

function normalizeBoolean(value: unknown, field: string, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a boolean; falling back to ${fallback}.`);
  return fallback;
}

function normalizeOptionalString(value: unknown, field: string, warnings: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a string; ignoring the value.`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRepoList(value: unknown, warnings: string[]): CrossRepoEvaluationManifestRepo[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`CrossRepoEvaluationManifest field "repos" must be a list; ignoring a ${typeof value} value.`);
    return [];
  }
  const result: CrossRepoEvaluationManifestRepo[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (index >= MAX_CROSS_REPO_MANIFEST_REPOS) {
      warnings.push(
        `CrossRepoEvaluationManifest field "repos" exceeded ${MAX_CROSS_REPO_MANIFEST_REPOS} entries; extra entries ignored.`,
      );
      break;
    }
    let repoFullName: string | null = null;
    let stackHint: string | null = null;
    let requireTestCommand = false;
    let fixturePath: string | null = null;
    if (typeof entry === "string") {
      repoFullName = normalizeCrossRepoFullName(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      repoFullName = normalizeCrossRepoFullName(record.repoFullName);
      stackHint = normalizeOptionalString(record.stackHint, "stackHint", warnings);
      requireTestCommand = normalizeBoolean(record.requireTestCommand, "requireTestCommand", false, warnings);
      fixturePath = normalizeOptionalString(record.fixturePath, "fixturePath", warnings);
    } else {
      warnings.push(`CrossRepoEvaluationManifest "repos" skipped a non-string, non-mapping entry.`);
      continue;
    }
    if (repoFullName === null) {
      warnings.push(`CrossRepoEvaluationManifest "repos" skipped an entry with an invalid "owner/repo" name.`);
      continue;
    }
    if (seen.has(repoFullName)) {
      warnings.push(`CrossRepoEvaluationManifest "repos" skipped a duplicate entry for ${repoFullName}.`);
      continue;
    }
    seen.add(repoFullName);
    const normalized: CrossRepoEvaluationManifestRepo = { repoFullName, requireTestCommand };
    if (stackHint) normalized.stackHint = stackHint;
    if (fixturePath) normalized.fixturePath = fixturePath;
    result.push(normalized);
  }
  return result;
}

/**
 * Tolerant JSON manifest parser (#4788). Malformed input degrades to an empty repo list with warnings rather than
 * throwing, mirroring the fleet-run-manifest / miner-goal-spec convention.
 */
export function parseCrossRepoEvaluationManifest(
  content: string | null | undefined,
): ParsedCrossRepoEvaluationManifest {
  if (content === undefined || content === null) return cloneEmptyManifest();
  if (typeof content !== "string") {
    return cloneEmptyManifest([`CrossRepoEvaluationManifest content must be a string; got ${typeof content}.`]);
  }
  const trimmed = content.trim();
  if (!trimmed) return cloneEmptyManifest();
  if (utf8ByteLength(trimmed) > MAX_CROSS_REPO_MANIFEST_BYTES) {
    return cloneEmptyManifest([
      `CrossRepoEvaluationManifest exceeded ${MAX_CROSS_REPO_MANIFEST_BYTES} bytes; ignoring the file.`,
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return cloneEmptyManifest(["CrossRepoEvaluationManifest is not valid JSON."]);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return cloneEmptyManifest(["CrossRepoEvaluationManifest root must be a JSON object."]);
  }
  const warnings: string[] = [];
  const repos = normalizeRepoList((raw as { repos?: unknown }).repos, warnings);
  return { present: true, manifest: { repos }, warnings };
}

/**
 * Scan agent instructions for positive loopover/LoopOver assumptions (#4788). Lines that already tell the agent
 * *not* to assume LoopOver conventions (the negative guidance from buildValidationGuidance) are skipped.
 */
export function scanPositiveLoopoverAssumptions(text: string): Array<{ id: string; line: string }> {
  if (typeof text !== "string") return [];
  const findings: Array<{ id: string; line: string }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /do not assume/i.test(trimmed)) continue;
    for (const check of GITTENSOR_POSITIVE_ASSUMPTION_CHECKS) {
      if (check.pattern.test(line)) findings.push({ id: check.id, line: trimmed });
    }
  }
  return findings;
}

/** One shared thrown-value formatter so every catch in both harness modes carries the same two branches. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildFailure(
  repoFullName: string,
  category: string,
  reason: string,
  extra: Partial<CrossRepoEvaluationResult> = {},
): CrossRepoEvaluationResult {
  return {
    repoFullName,
    passed: false,
    failureCategory: category,
    reason,
    stackDetected: false,
    usedDefaultGoalSpec: null,
    assumptionFindings: [],
    ...extra,
  };
}

function buildPass(repoFullName: string, extra: Partial<CrossRepoEvaluationResult> = {}): CrossRepoEvaluationResult {
  return {
    repoFullName,
    passed: true,
    failureCategory: null,
    reason: null,
    stackDetected: true,
    usedDefaultGoalSpec: true,
    assumptionFindings: [],
    ...extra,
  };
}

function resolveEvaluationRepoPath(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions = {},
): string {
  if (entry.fixturePath && typeof entry.fixturePath === "string") return entry.fixturePath;
  if (typeof options.repoPath === "string" && options.repoPath.trim()) return options.repoPath.trim();
  if (typeof options.resolveRepoPath === "function") return options.resolveRepoPath(entry);
  return resolveRepoCloneDir(entry.repoFullName, options.env ?? process.env);
}

function defaultClaimLedger(repoFullName: string): { listClaims: () => never[] } {
  return { listClaims: () => [] };
}

/** The synthetic-issue spec input both harness modes hand to buildCodingTaskSpec — readiness composes it against
 *  the benchmark clone, full-execution mode against the scratch workspace copy (#7634), so the acceptance-criteria
 *  file buildCodingTaskSpec writes lands inside whichever tree the caller is actually working in. */
function buildHarnessSpecInput(
  repoFullName: string,
  workingDirectory: string,
  detectImpl: (repoPath: string) => RepoStackResult,
): Record<string, unknown> {
  return {
    repoFullName,
    issue: {
      number: 1,
      title: "Cross-repo evaluation harness smoke issue",
      body: "Synthetic issue used only by the cross-repo evaluation harness.",
      labels: ["bug"],
    },
    context: { issues: [{ number: 1 }], pullRequests: [] },
    claimLedger: defaultClaimLedger(repoFullName),
    workingDirectory,
    detectRepoStack: detectImpl,
  };
}

/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 */
export function evaluateRepoReadiness(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions = {},
): CrossRepoEvaluationResult {
  const repoFullName = entry?.repoFullName;
  if (typeof repoFullName !== "string" || !normalizeCrossRepoFullName(repoFullName)) {
    return buildFailure(
      typeof repoFullName === "string" ? repoFullName : "(invalid)",
      CROSS_REPO_FAILURE_CATEGORY.OTHER,
      "Benchmark entry is missing a valid owner/repo name.",
    );
  }

  const existsImpl = options.existsSync ?? existsSync;
  const detectImpl = options.detectRepoStack ?? detectRepoStack;
  const goalSpecImpl = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
  const buildSpecImpl: NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]> =
    options.buildCodingTaskSpec ??
    (buildCodingTaskSpec as unknown as NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]>);
  const repoPath = resolveEvaluationRepoPath(entry, options);

  if (!existsImpl(repoPath)) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP,
      `Repository path does not exist: ${repoPath}. Clone the repo or set LOOPOVER_MINER_REPO_CLONE_DIR.`,
    );
  }

  const goalSpec = goalSpecImpl(repoPath);
  const usedDefaultGoalSpec = goalSpec?.present !== true;

  const stack = detectImpl(repoPath);
  if (stack?.detected !== true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION,
      stack?.reason ?? "Stack auto-detection did not recognize this repository.",
      { stackDetected: false, usedDefaultGoalSpec },
    );
  }

  if (entry.requireTestCommand === true && !stack.testCommand) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
      "Stack detection succeeded but no test command was inferred while requireTestCommand is set.",
      { stackDetected: true, usedDefaultGoalSpec, stack },
    );
  }

  let specResult;
  try {
    specResult = buildSpecImpl(buildHarnessSpecInput(repoFullName, repoPath, detectImpl));
  } catch (error) {
    return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, describeError(error), {
      stackDetected: true,
      usedDefaultGoalSpec,
      stack,
    });
  }

  if (specResult?.ready !== true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
      `Coding task spec is not ready (verdict: ${specResult?.verdict ?? "unknown"}).`,
      { stackDetected: true, usedDefaultGoalSpec, stack },
    );
  }

  const assumptionFindings = scanPositiveLoopoverAssumptions(specResult.instructions ?? "");
  if (assumptionFindings.length > 0) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.GITTENSOR_ASSUMPTION,
      `Agent instructions leak loopover-specific assumptions (${assumptionFindings.map((f) => f.id).join(", ")}).`,
      { stackDetected: true, usedDefaultGoalSpec, stack, assumptionFindings },
    );
  }

  return buildPass(repoFullName, { usedDefaultGoalSpec, stack });
}

/**
 * Run the harness across every repo in a parsed manifest (#4788).
 */
export function runCrossRepoEvaluation(
  parsed: ParsedCrossRepoEvaluationManifest,
  options: { repoFilter?: string } & EvaluateRepoReadinessOptions = {},
): CrossRepoEvaluationResult[] {
  const repos = parsed?.manifest?.repos ?? [];
  const results: CrossRepoEvaluationResult[] = [];
  for (const entry of repos) {
    if (options.repoFilter && entry.repoFullName !== options.repoFilter) continue;
    results.push(evaluateRepoReadiness(entry, options));
  }
  return results;
}

/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 */
export function summarizeCrossRepoEvaluation(results: CrossRepoEvaluationResult[]): CrossRepoEvaluationSummary {
  const list = Array.isArray(results) ? results : [];
  let passed = 0;
  let failed = 0;
  const failuresByCategory: Record<string, number> = {};
  for (const result of list) {
    if (result?.passed === true) {
      passed += 1;
      continue;
    }
    failed += 1;
    const category = result?.failureCategory ?? CROSS_REPO_FAILURE_CATEGORY.OTHER;
    failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
  }
  const total = passed + failed;
  const majorityPassed = total > 0 ? passed > failed : false;
  const withoutLoopoverConfig = list.filter((r) => r?.usedDefaultGoalSpec !== false).length;
  return {
    total,
    passed,
    failed,
    majorityPassed,
    withoutLoopoverConfig,
    failuresByCategory,
  };
}

/**
 * Human-readable pass/fail report for one evaluation run (#4788).
 */
export function formatCrossRepoEvaluationReport(
  results: CrossRepoEvaluationResult[],
  summary: CrossRepoEvaluationSummary = summarizeCrossRepoEvaluation(results),
): string {
  const lines = ["loopover-miner cross-repo evaluation", ""];
  for (const result of results) {
    if (result.passed) {
      lines.push(`PASS ${result.repoFullName}`);
      continue;
    }
    lines.push(`FAIL ${result.repoFullName} [${result.failureCategory}] ${result.reason}`);
  }
  lines.push(
    "",
    `summary: ${summary.passed}/${summary.total} passed` +
      (summary.majorityPassed ? " (majority passed)" : " (majority failed)"),
  );
  if (summary.total > 0) {
    lines.push(`without loopover-specific target config: ${summary.withoutLoopoverConfig}/${summary.total}`);
  }
  const categories = Object.entries(summary.failuresByCategory).sort(([a], [b]) => a.localeCompare(b));
  if (categories.length > 0) {
    lines.push("", "failures by category:");
    for (const [category, count] of categories) {
      lines.push(`- ${category}: ${count}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Full-execution mode (#7634): past readiness, actually run the discover -> plan -> code -> test loop against a
// benchmark repo — dry-run only. The attempt runs inside a scratch COPY of the local clone that is discarded
// afterward: no live PR submission, no forge API calls, and the benchmark clone itself is never mutated by the
// agent or the test run. Same taxonomy extension point as the readiness categories above — summarize/format are
// data-driven over category strings, so these flow through the existing report unchanged.

/** Execution-specific failure taxonomy (#7634), extending — not replacing — CROSS_REPO_FAILURE_CATEGORY. */
export const CROSS_REPO_EXECUTION_FAILURE_CATEGORY: Readonly<{
  AGENT_RUN: "agent_run_failed";
  NOOP_DIFF: "noop_diff";
  BUILD: "build_failed";
  TEST: "test_failed";
}> = Object.freeze({
  AGENT_RUN: "agent_run_failed",
  NOOP_DIFF: "noop_diff",
  BUILD: "build_failed",
  TEST: "test_failed",
});

/** A benchmark attempt works a small synthetic issue, so a modest turn cap keeps dry-runs bounded without
 *  starving a real agent; callers tune via options.maxTurns. */
export const DEFAULT_CROSS_REPO_EXECUTION_MAX_TURNS: number = 24;
/** Per-command (build, then test) wall-clock cap — generous enough for a cold dependency install on the larger
 *  benchmark repos, small enough that a hung suite cannot wedge the whole run. */
export const DEFAULT_CROSS_REPO_EXECUTION_COMMAND_TIMEOUT_MS: number = 600_000;

export type CrossRepoExecutionCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CrossRepoExecutionRunCommandFn = (
  command: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<CrossRepoExecutionCommandResult>;

export type CrossRepoExecutionWorkspace = { path: string; cleanup: () => void };

/** Structural mirror of the engine's CodingAgentDriver contract — kept local so this module only loads the real
 *  driver construction (and its engine dependency) lazily, on the one path that actually runs an agent. */
export type CrossRepoExecutionDriver = {
  run(task: {
    attemptId: string;
    workingDirectory: string;
    acceptanceCriteriaPath: string;
    instructions: string;
    maxTurns: number;
  }): Promise<{
    ok: boolean;
    changedFiles: readonly string[];
    summary: string;
    error?: string | undefined;
  }>;
};

export type CrossRepoExecutionDetails = {
  attempted: boolean;
  changedFileCount: number | null;
  buildRan: boolean;
  testRan: boolean;
};

export type CrossRepoExecutionEvaluationResult = CrossRepoEvaluationResult & {
  execution: CrossRepoExecutionDetails | null;
};

export type EvaluateRepoExecutionOptions = EvaluateRepoReadinessOptions & {
  driver?: CrossRepoExecutionDriver;
  prepareExecutionWorkspace?: (repoPath: string) => CrossRepoExecutionWorkspace;
  runCommand?: CrossRepoExecutionRunCommandFn;
  maxTurns?: number;
  commandTimeoutMs?: number;
};

/** Copy the benchmark clone into a discardable temp tree — the agent and the repo's test suite only ever touch
 *  the copy, so the clone stays pristine and cleanup is a single recursive remove. */
export function defaultPrepareExecutionWorkspace(repoPath: string): CrossRepoExecutionWorkspace {
  const scratchRoot = mkdtempSync(join(tmpdir(), "loopover-cross-repo-exec-"));
  const path = join(scratchRoot, "repo");
  cpSync(repoPath, path, { recursive: true });
  return {
    path,
    cleanup: () => {
      rmSync(scratchRoot, { recursive: true, force: true });
    },
  };
}

/** Command runner for the stack's inferred build/test commands. detectRepoStack only ever emits simple
 *  `tool subcommand` forms ("npm test", "cargo build", "npm run build"), so the command is tokenized on
 *  whitespace and exec'd DIRECTLY -- deliberately no `shell: true`, so nothing in a benchmark repo's manifest
 *  can smuggle shell metacharacters into an interpreted shell line. Mirrors coding-agent-construction's
 *  createRealCliSubprocessSpawn otherwise: capture both streams and RESOLVE (never reject) on timeout or spawn
 *  error, so partial output stays diagnosable. Promise resolution is idempotent, so a `close` firing after the
 *  timeout already resolved needs no guard. */
export function createDefaultCrossRepoExecutionRunCommand(): CrossRepoExecutionRunCommandFn {
  return (command, options) =>
    new Promise((resolve) => {
      const [executable, ...args] = command.split(/\s+/).filter(Boolean);
      if (!executable) {
        resolve({ stdout: "", stderr: "empty_command", code: null, timedOut: false });
        return;
      }
      const child = nodeSpawn(executable, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ stdout, stderr, code: null, timedOut: true });
      }, options.timeoutMs);
      // stdio is always ["ignore","pipe","pipe"] above, so both streams exist — assert instead of branching.
      child.stdout!.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr!.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, code: null, timedOut: false });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, timedOut: false });
      });
    });
}

function buildExecutionFailure(
  repoFullName: string,
  category: string,
  reason: string,
  base: Partial<CrossRepoEvaluationResult>,
  execution: CrossRepoExecutionDetails | null,
): CrossRepoExecutionEvaluationResult {
  return { ...buildFailure(repoFullName, category, reason, base), execution };
}

/**
 * Run the full discover -> plan -> code -> test loop for one benchmark repo, dry-run (#7634). Readiness gates
 * first (its failures pass through unchanged); execution then happens entirely inside a scratch copy that is
 * discarded in every outcome.
 */
export async function evaluateRepoExecution(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoExecutionOptions = {},
): Promise<CrossRepoExecutionEvaluationResult> {
  const readiness = evaluateRepoReadiness(entry, options);
  if (!readiness.passed) return { ...readiness, execution: null };

  const prepareWorkspace = options.prepareExecutionWorkspace ?? defaultPrepareExecutionWorkspace;
  let workspace: CrossRepoExecutionWorkspace;
  try {
    workspace = prepareWorkspace(resolveEvaluationRepoPath(entry, options));
  } catch (error) {
    const reason = `Failed to prepare a scratch execution workspace: ${describeError(error)}`;
    // A passed readiness result always carries its detected stack (buildPass is invoked with it).
    const base = { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack: readiness.stack! };
    return buildExecutionFailure(readiness.repoFullName, CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP, reason, base, null);
  }
  try {
    return await runExecutionPhases(readiness, workspace, options);
  } finally {
    try {
      workspace.cleanup();
    } catch {
      // Best-effort discard — a cleanup failure must never mask the evaluation outcome itself.
    }
  }
}

async function runExecutionPhases(
  readiness: CrossRepoEvaluationResult,
  workspace: CrossRepoExecutionWorkspace,
  options: EvaluateRepoExecutionOptions,
): Promise<CrossRepoExecutionEvaluationResult> {
  const repoFullName = readiness.repoFullName;
  // Readiness passed, so the stack is present and detected — narrow once instead of re-branching on it.
  const stack = readiness.stack as DetectedRepoStack;
  const usedDefaultGoalSpec = readiness.usedDefaultGoalSpec;
  const failureBase = { stackDetected: true, usedDefaultGoalSpec, stack };

  const detectImpl = options.detectRepoStack ?? detectRepoStack;
  const buildSpecImpl: NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]> =
    options.buildCodingTaskSpec ??
    (buildCodingTaskSpec as unknown as NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]>);

  // Re-compose the coding-task spec INSIDE the scratch copy: buildCodingTaskSpec writes the acceptance-criteria
  // document into its workingDirectory, and the agent must find it (and work) in the tree it is allowed to touch.
  // The readiness pass already wrote that document into the clone (pre-existing #4788 behavior), so the copy
  // inherits it -- and writeAcceptanceCriteriaFile opens O_EXCL (never overwrites), so clear the inherited file
  // first. The scratch tree is ours to mutate; the clone itself stays untouched.
  rmSync(join(workspace.path, ACCEPTANCE_CRITERIA_FILENAME), { force: true });
  let specResult;
  try {
    specResult = buildSpecImpl(buildHarnessSpecInput(repoFullName, workspace.path, detectImpl));
  } catch (error) {
    return buildExecutionFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.OTHER,
      `Coding task spec failed inside the scratch workspace: ${describeError(error)}`,
      failureBase,
      null,
    );
  }
  if (specResult?.ready !== true) {
    return buildExecutionFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
      `Coding task spec is not ready inside the scratch workspace (verdict: ${specResult?.verdict ?? "unknown"}).`,
      failureBase,
      null,
    );
  }

  let driver = options.driver;
  if (!driver) {
    try {
      // Lazy so the readiness-only path (and its consumers) never load the engine-backed driver construction.
      const { constructProductionCodingAgentDriver } = await import("./coding-agent-construction.js");
      driver = constructProductionCodingAgentDriver(options.env ?? process.env);
    } catch (error) {
      return buildExecutionFailure(
        repoFullName,
        CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN,
        `No runnable coding-agent driver: ${describeError(error)}`,
        failureBase,
        { attempted: false, changedFileCount: null, buildRan: false, testRan: false },
      );
    }
  }

  const task = {
    attemptId: `cross-repo-eval-${repoFullName.replace("/", "-")}`,
    workingDirectory: workspace.path,
    acceptanceCriteriaPath: specResult.acceptanceCriteriaPath ?? join(workspace.path, "ACCEPTANCE_CRITERIA.md"),
    instructions: specResult.instructions ?? "",
    maxTurns: options.maxTurns ?? DEFAULT_CROSS_REPO_EXECUTION_MAX_TURNS,
  };
  let agentResult;
  try {
    agentResult = await driver.run(task);
  } catch (error) {
    return buildExecutionFailure(
      repoFullName,
      CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN,
      `Coding agent run threw: ${describeError(error)}`,
      failureBase,
      { attempted: true, changedFileCount: null, buildRan: false, testRan: false },
    );
  }
  if (agentResult?.ok !== true) {
    return buildExecutionFailure(
      repoFullName,
      CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN,
      `Coding agent run did not succeed: ${agentResult?.error ?? agentResult?.summary ?? "no failure detail reported"}`,
      failureBase,
      { attempted: true, changedFileCount: null, buildRan: false, testRan: false },
    );
  }

  const changedFileCount = Array.isArray(agentResult.changedFiles) ? agentResult.changedFiles.length : 0;
  if (changedFileCount === 0) {
    return buildExecutionFailure(
      repoFullName,
      CROSS_REPO_EXECUTION_FAILURE_CATEGORY.NOOP_DIFF,
      "Coding agent reported success but the generated diff is a no-op (no files changed).",
      failureBase,
      { attempted: true, changedFileCount: 0, buildRan: false, testRan: false },
    );
  }

  const runCommand = options.runCommand ?? createDefaultCrossRepoExecutionRunCommand();
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_CROSS_REPO_EXECUTION_COMMAND_TIMEOUT_MS;

  let buildRan = false;
  if (stack.buildCommand) {
    buildRan = true;
    const buildResult = await runCommand(stack.buildCommand, { cwd: workspace.path, timeoutMs: commandTimeoutMs });
    if (buildResult.timedOut || buildResult.code !== 0) {
      return buildExecutionFailure(
        repoFullName,
        CROSS_REPO_EXECUTION_FAILURE_CATEGORY.BUILD,
        `Diff generated but the build ${buildResult.timedOut ? "timed out" : `failed (exit ${buildResult.code})`}: ${stack.buildCommand}`,
        failureBase,
        { attempted: true, changedFileCount, buildRan: true, testRan: false },
      );
    }
  }

  if (!stack.testCommand) {
    return buildExecutionFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
      "Stack detection inferred no test command, so the generated diff cannot be validated in execution mode.",
      failureBase,
      { attempted: true, changedFileCount, buildRan, testRan: false },
    );
  }
  const testResult = await runCommand(stack.testCommand, { cwd: workspace.path, timeoutMs: commandTimeoutMs });
  if (testResult.timedOut || testResult.code !== 0) {
    return buildExecutionFailure(
      repoFullName,
      CROSS_REPO_EXECUTION_FAILURE_CATEGORY.TEST,
      `Diff generated but the repo's own test suite ${testResult.timedOut ? "timed out" : `failed (exit ${testResult.code})`}: ${stack.testCommand}`,
      failureBase,
      { attempted: true, changedFileCount, buildRan, testRan: true },
    );
  }

  return {
    ...buildPass(repoFullName, { usedDefaultGoalSpec, stack }),
    execution: { attempted: true, changedFileCount, buildRan, testRan: true },
  };
}

/**
 * Run full-execution mode across every repo in a parsed manifest (#7634), sequentially — agent runs and test
 * suites are heavyweight, so no parallel fan-out.
 */
export async function runCrossRepoFullExecution(
  parsed: ParsedCrossRepoEvaluationManifest,
  options: { repoFilter?: string } & EvaluateRepoExecutionOptions = {},
): Promise<CrossRepoExecutionEvaluationResult[]> {
  const repos = parsed?.manifest?.repos ?? [];
  const results: CrossRepoExecutionEvaluationResult[] = [];
  for (const entry of repos) {
    if (options.repoFilter && entry.repoFullName !== options.repoFilter) continue;
    results.push(await evaluateRepoExecution(entry, options));
  }
  return results;
}
