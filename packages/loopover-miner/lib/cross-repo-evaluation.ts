// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";
import type { RepoStackResult } from "./stack-detection.js";

/** Failure taxonomy surfaced in per-repo reports. Readiness-mode categories (#4788) plus the full-execution
 *  categories (#7634) that classify how a live discover → plan → code → test attempt fell short. */
export const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
  STACK_DETECTION: "stack_detection_gap";
  EXECUTION: "execution_gap";
  GITTENSOR_ASSUMPTION: "loopover_assumption";
  CLONE_SETUP: "clone_setup";
  EXECUTION_NO_DIFF: "execution_no_diff";
  EXECUTION_COMPILE: "execution_compile_gap";
  EXECUTION_TEST: "execution_test_failure";
  EXECUTION_NOOP: "execution_noop_diff";
  OTHER: "other";
}> = Object.freeze({
  STACK_DETECTION: "stack_detection_gap",
  EXECUTION: "execution_gap",
  GITTENSOR_ASSUMPTION: "loopover_assumption",
  CLONE_SETUP: "clone_setup",
  // Full-execution taxonomy (#7634): the plan formed and the coding agent ran, but the attempt failed at a
  // later stage — the agent produced no usable diff, the diff didn't build, the target test suite failed, or
  // the tests passed only because the diff was a no-op.
  EXECUTION_NO_DIFF: "execution_no_diff",
  EXECUTION_COMPILE: "execution_compile_gap",
  EXECUTION_TEST: "execution_test_failure",
  EXECUTION_NOOP: "execution_noop_diff",
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
  /** Opt this entry into full-execution mode (#7634): `--full-execution` runs the live attempt against every
   *  entry flagged `true` (a `--repo` filter overrides the flag and runs that one entry regardless). */
  fullExecution?: boolean;
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
  };
};

/** Result of running a local shell command (build/test) during a full-execution attempt (#7634). */
export type LocalCommandResult = {
  ok: boolean;
  /** True when there was no command to run (e.g. the stack inferred no build command) — treated as a pass. */
  skipped?: boolean;
  code?: number | null;
  output?: string;
};

/** Everything a coding-agent executor needs to run one benchmark repo's live attempt (#7634). */
export type CodingAttemptContext = {
  repoFullName: string;
  repoPath: string;
  stack: RepoStackResult;
  instructions: string;
  attemptId: string;
  maxTurns: number;
};

/** What a coding-agent executor reports back: the real unified diff it produced (empty string when it made no
 *  change), plus whether the agent itself considered the run successful (#7634). */
export type CodingAttemptOutcome = {
  ok: boolean;
  diff: string;
  summary?: string;
  error?: string;
};

export type ExecuteRepoAttemptOptions = EvaluateRepoReadinessOptions & {
  /** Discover → plan → code step: run the coding agent against the clone and return its diff. The CLI injects a
   *  real driver-backed executor; unit tests inject a fake. Left unset, the harness reports `execution_no_diff`
   *  rather than pretending an agent ran. */
  runCodingAttempt?: (context: CodingAttemptContext) => CodingAttemptOutcome | Promise<CodingAttemptOutcome>;
  /** Build/compile the clone after the diff is applied. Defaults to running `stack.buildCommand` locally. */
  compileRepo?: (context: { repoPath: string; stack: RepoStackResult }) => LocalCommandResult | Promise<LocalCommandResult>;
  /** Run the target repo's own test suite locally. Defaults to running `stack.testCommand`. */
  runRepoTests?: (context: { repoPath: string; stack: RepoStackResult }) => LocalCommandResult | Promise<LocalCommandResult>;
  /** Shared spawn used by the default compile/test runners; defaults to a real `spawnSync` in the clone dir. */
  runLocalCommand?: (command: string, context: { cwd: string; env?: NodeJS.ProcessEnv }) => LocalCommandResult;
  /** Turn budget handed to the coding agent (CLI default: 30). */
  maxTurns?: number;
};

export type CrossRepoExecutionResult = CrossRepoEvaluationResult & {
  /** False when the attempt never reached the live agent (readiness gated it out). */
  executed: boolean;
  compilePassed?: boolean | null;
  testsPassed?: boolean | null;
  /** Character length of the produced diff (0 for a no-op); null when no agent ran. */
  diffChars?: number | null;
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
    let fullExecution = false;
    if (typeof entry === "string") {
      repoFullName = normalizeCrossRepoFullName(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      repoFullName = normalizeCrossRepoFullName(record.repoFullName);
      stackHint = normalizeOptionalString(record.stackHint, "stackHint", warnings);
      requireTestCommand = normalizeBoolean(record.requireTestCommand, "requireTestCommand", false, warnings);
      fixturePath = normalizeOptionalString(record.fixturePath, "fixturePath", warnings);
      fullExecution = normalizeBoolean(record.fullExecution, "fullExecution", false, warnings);
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
    if (fullExecution) normalized.fullExecution = true;
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

type BuildCodingTaskSpecImpl = NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]>;

/** Compose the synthetic coding-task spec both readiness and full-execution evaluate against, so the two modes
 *  drive the exact same discover/plan surface a real attempt would (#7634). */
function buildEvaluationCodingTaskSpec(
  repoFullName: string,
  repoPath: string,
  buildSpecImpl: BuildCodingTaskSpecImpl,
  detectImpl: (repoPath: string) => RepoStackResult,
): ReturnType<BuildCodingTaskSpecImpl> {
  return buildSpecImpl({
    repoFullName,
    issue: {
      number: 1,
      title: "Cross-repo evaluation harness smoke issue",
      body: "Synthetic issue used only by the cross-repo evaluation harness.",
      labels: ["bug"],
    },
    context: { issues: [{ number: 1 }], pullRequests: [] },
    claimLedger: defaultClaimLedger(repoFullName),
    workingDirectory: repoPath,
    detectRepoStack: detectImpl,
  });
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
    specResult = buildEvaluationCodingTaskSpec(repoFullName, repoPath, buildSpecImpl, detectImpl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, message, {
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

/** First non-empty line of command output, trimmed and length-capped, for a compact failure reason (#7634). */
function firstOutputLine(output: string | undefined): string {
  if (typeof output !== "string") return "";
  const line = output.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Real default local-command runner: split the detected command into an argv and spawn it directly in the clone
 *  dir with NO shell (`shell: false`), so shell metacharacters in untrusted repo metadata (e.g. a crafted
 *  package.json script name) cannot inject extra commands (#7641). Stack commands are plain whitespace-separated
 *  argv (`npm run build`, `cargo test`, `go build ./...`). Resolve-not-throw: a non-zero exit becomes `ok: false`
 *  with its captured output rather than an exception (#7634). Exported for direct unit coverage. */
export function defaultRunLocalCommand(
  command: string,
  context: { cwd: string; env?: NodeJS.ProcessEnv },
  spawn: typeof spawnSync = spawnSync,
): LocalCommandResult {
  const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
  if (!file) return { ok: false, code: null, output: "empty command" };
  const result = spawn(file, args, {
    cwd: context.cwd,
    env: context.env ?? process.env,
    encoding: "utf8",
    shell: false,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    return { ok: false, code: null, output: result.error.message };
  }
  return { ok: result.status === 0, code: result.status, output };
}

function runStackCommand(
  command: string | null,
  context: { repoPath: string; stack: RepoStackResult },
  runLocalCommand: NonNullable<ExecuteRepoAttemptOptions["runLocalCommand"]>,
  options: ExecuteRepoAttemptOptions,
): LocalCommandResult {
  if (!command) return { ok: true, skipped: true };
  return runLocalCommand(command, {
    cwd: context.repoPath,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
}

function executionResult(
  base: CrossRepoEvaluationResult,
  extra: Partial<CrossRepoExecutionResult>,
): CrossRepoExecutionResult {
  return { ...base, executed: true, compilePassed: null, testsPassed: null, diffChars: null, ...extra };
}

/**
 * Run one benchmark repo's full-execution attempt (#7634): gate on readiness, then run the live discover → plan
 * → code → test loop against the local clone and classify the outcome. Dry-run only — no forge writes, no PR
 * submission; the agent edits a throwaway clone and the diff/results are discarded by the caller.
 *
 * The pipeline mirrors the failure taxonomy the issue calls for, in order:
 *   1. readiness fails            → the existing readiness category (attempt never starts; `executed: false`)
 *   2. agent errors / no diff     → `execution_no_diff`
 *   3. diff doesn't build         → `execution_compile_gap`
 *   4. builds but tests fail      → `execution_test_failure`
 *   5. tests pass but diff no-op  → `execution_noop_diff`
 *   6. tests pass, real diff      → PASS
 */
export async function executeRepoAttempt(
  entry: CrossRepoEvaluationManifestRepo,
  options: ExecuteRepoAttemptOptions = {},
): Promise<CrossRepoExecutionResult> {
  const readiness = evaluateRepoReadiness(entry, options);
  if (!readiness.passed) {
    return { ...readiness, executed: false };
  }
  const repoFullName = readiness.repoFullName;
  const repoPath = resolveEvaluationRepoPath(entry, options);
  const stack = readiness.stack as RepoStackResult;

  const detectImpl = options.detectRepoStack ?? detectRepoStack;
  const buildSpecImpl: BuildCodingTaskSpecImpl =
    options.buildCodingTaskSpec ?? (buildCodingTaskSpec as unknown as BuildCodingTaskSpecImpl);
  const runLocalCommand = options.runLocalCommand ?? defaultRunLocalCommand;
  const compileImpl =
    options.compileRepo ?? ((context) => runStackCommand(context.stack.detected ? context.stack.buildCommand : null, context, runLocalCommand, options));
  const testImpl =
    options.runRepoTests ?? ((context) => runStackCommand(context.stack.detected ? context.stack.testCommand : null, context, runLocalCommand, options));

  // Re-derive the same coding-task instructions readiness already validated, to hand the live agent (#7634).
  let instructions = "";
  try {
    instructions = buildEvaluationCodingTaskSpec(repoFullName, repoPath, buildSpecImpl, detectImpl).instructions ?? "";
  } catch {
    instructions = "";
  }

  // Stage 2 — discover → plan → code. Without an injected executor the harness will not fabricate a run.
  if (typeof options.runCodingAttempt !== "function") {
    return executionResult(
      buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF,
        "No coding-agent executor configured for full-execution mode (set MINER_CODING_AGENT_PROVIDER and run via the CLI).",
        { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
      ),
      { diffChars: null },
    );
  }

  let attempt: CodingAttemptOutcome;
  try {
    attempt = await options.runCodingAttempt({
      repoFullName,
      repoPath,
      stack,
      instructions,
      attemptId: `cross-repo-exec-${repoFullName.replace("/", "__")}`,
      maxTurns: Number.isFinite(options.maxTurns) ? (options.maxTurns as number) : 30,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return executionResult(
      buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF, `Coding agent did not run: ${message}`, {
        stackDetected: true,
        usedDefaultGoalSpec: readiness.usedDefaultGoalSpec,
        stack,
      }),
      { diffChars: null },
    );
  }

  const diff = typeof attempt?.diff === "string" ? attempt.diff : "";
  if (!attempt || (attempt.ok === false && diff.trim().length === 0)) {
    return executionResult(
      buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF,
        attempt?.error ?? "Coding agent reported failure and produced no diff.",
        { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
      ),
      { diffChars: diff.length },
    );
  }

  // Stage 3 — the produced diff must still build.
  const compile = await compileImpl({ repoPath, stack });
  if (!compile.ok) {
    return executionResult(
      buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.EXECUTION_COMPILE,
        `Generated diff did not build${firstOutputLine(compile.output) ? `: ${firstOutputLine(compile.output)}` : "."}`,
        { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
      ),
      { compilePassed: false, diffChars: diff.length },
    );
  }

  // Stage 4 — the target repo's own test suite must pass.
  const test = await testImpl({ repoPath, stack });
  if (!test.ok) {
    return executionResult(
      buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.EXECUTION_TEST,
        `Target test suite failed${firstOutputLine(test.output) ? `: ${firstOutputLine(test.output)}` : "."}`,
        { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
      ),
      { compilePassed: true, testsPassed: false, diffChars: diff.length },
    );
  }

  // Stage 5 — a passing run with no actual change is a no-op, not a success.
  if (diff.trim().length === 0) {
    return executionResult(
      buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NOOP,
        "Tests passed but the coding agent produced a no-op diff (no file changes).",
        { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack },
      ),
      { compilePassed: true, testsPassed: true, diffChars: 0 },
    );
  }

  return executionResult(buildPass(repoFullName, { usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack }), {
    compilePassed: true,
    testsPassed: true,
    diffChars: diff.length,
  });
}

/**
 * Run the full-execution harness across a parsed manifest (#7634). Without a `repoFilter`, only entries flagged
 * `fullExecution: true` run (the curated subset); a `repoFilter` overrides the flag and runs that one entry.
 */
export async function runCrossRepoExecution(
  parsed: ParsedCrossRepoEvaluationManifest,
  options: { repoFilter?: string } & ExecuteRepoAttemptOptions = {},
): Promise<CrossRepoExecutionResult[]> {
  const repos = parsed?.manifest?.repos ?? [];
  const results: CrossRepoExecutionResult[] = [];
  for (const entry of repos) {
    if (options.repoFilter) {
      if (entry.repoFullName !== options.repoFilter) continue;
    } else if (entry.fullExecution !== true) {
      continue;
    }
    results.push(await executeRepoAttempt(entry, options));
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
