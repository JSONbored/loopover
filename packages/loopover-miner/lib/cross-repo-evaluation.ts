// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { ensureRepoCloned, isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";
import type { RepoStackResult } from "./stack-detection.js";

/** Failure taxonomy surfaced in per-repo reports (#4788). The first five members are the offline
 *  readiness taxonomy; the four `EXEC_*`/plan/test/no-op members are the dry-run full-execution taxonomy
 *  (#7634) surfaced only when the `--full-execution` loop actually clones, runs the agent, and runs the
 *  target repo's own tests. New members are appended in the same frozen literal so existing members are
 *  never removed. */
export const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
  STACK_DETECTION: "stack_detection_gap";
  EXECUTION: "execution_gap";
  GITTENSOR_ASSUMPTION: "loopover_assumption";
  CLONE_SETUP: "clone_setup";
  OTHER: "other";
  EXEC_SETUP: "exec_setup_gap";
  PLAN_COMPILE: "plan_compile_gap";
  TEST_FAILURE: "test_failure";
  NO_OP_DIFF: "no_op_diff";
}> = Object.freeze({
  STACK_DETECTION: "stack_detection_gap",
  EXECUTION: "execution_gap",
  GITTENSOR_ASSUMPTION: "loopover_assumption",
  CLONE_SETUP: "clone_setup",
  OTHER: "other",
  // Dry-run full-execution taxonomy (#7634):
  EXEC_SETUP: "exec_setup_gap", // clone / checkout of the target repo failed before the loop could start
  PLAN_COMPILE: "plan_compile_gap", // plan formed but the code phase did not produce a compiling change
  TEST_FAILURE: "test_failure", // change compiled but the target repo's own tests failed
  NO_OP_DIFF: "no_op_diff", // tests passed but the coding agent produced an empty (no-op) diff
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
  /** Full-execution (dry-run) fields (#7634); absent on readiness-only results. */
  executed?: boolean;
  changedFiles?: string[];
  testCommand?: string | null;
  testExitCode?: number | null;
};

export type CrossRepoEvaluationSummary = {
  total: number;
  passed: number;
  failed: number;
  majorityPassed: boolean;
  withoutLoopoverConfig: number;
  /** Repos that entered the dry-run clone+agent+test loop (#7634); 0 for a readiness-only run. */
  executedCount: number;
  failuresByCategory: Record<string, number>;
};

/** Result of the dry-run clone/checkout seam (#7634). Mirrors repo-clone's EnsureRepoClonedResult. */
export type CrossRepoExecutionCloneResult = {
  ok: boolean;
  repoPath?: string;
  error?: string;
};

/** Context handed to the dry-run coding-agent seam (#7634). */
export type CrossRepoExecutionAgentContext = {
  repoFullName: string;
  repoPath: string;
  instructions: string;
  stack: RepoStackResult;
  entry: CrossRepoEvaluationManifestRepo;
};

/** Result of the dry-run coding-agent seam (#7634): the produced (canned/real) diff surface. */
export type CrossRepoExecutionAgentResult = {
  ok: boolean;
  changedFiles?: readonly string[];
  summary?: string;
  error?: string;
};

/** Result of the dry-run target-repo test seam (#7634). Mirrors the executeLocalWrite subprocess shape. */
export type CrossRepoExecutionTestResult = {
  code: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
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
  // Full-execution (dry-run) seams (#7634). Every one is defaulted with `?? realImpl` exactly like the
  // readiness seams above, so unit tests drive the whole loop with fakes and zero real IO. There is NO
  // PR-open / forge-write / credential path anywhere in the execution loop -- the boundary is structural.
  fullExecution?: boolean;
  testTimeoutMs?: number;
  cloneRepo?: (
    entry: CrossRepoEvaluationManifestRepo,
    options: EvaluateRepoReadinessOptions,
  ) => CrossRepoExecutionCloneResult | Promise<CrossRepoExecutionCloneResult>;
  runCodingAgent?: (
    context: CrossRepoExecutionAgentContext,
  ) => CrossRepoExecutionAgentResult | Promise<CrossRepoExecutionAgentResult>;
  runTests?: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => CrossRepoExecutionTestResult | Promise<CrossRepoExecutionTestResult>;
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compose the synthetic coding-task spec both the readiness gate and the full-execution loop use (#4788 / #7634).
 * Shared so the "plan" (spec instructions) is derived identically in both modes -- readiness validates it is
 * leak-free; full-execution reuses it as the agent's plan.
 */
function composeCrossRepoEvaluationSpec(
  repoFullName: string,
  repoPath: string,
  buildSpecImpl: NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]>,
  detectImpl: (repoPath: string) => RepoStackResult,
): { ready: boolean; verdict?: string; instructions?: string } {
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

/** Internal readiness evaluation carrying the single composed spec so full-execution can reuse it (#7634). */
type ReadinessEvaluation = {
  result: CrossRepoEvaluationResult;
  /** The composed coding-task plan/instructions when the repo passed readiness; "" otherwise. */
  instructions: string;
  /** The local working-copy path readiness resolved (may be unusable on an early failure). */
  repoPath: string;
};

/**
 * Readiness core (#4788 / #7634). Identical logic to {@link evaluateRepoReadiness} but also returns the plan
 * instructions from the SINGLE `buildCodingTaskSpec` call, so the full-execution loop never re-invokes that
 * (production `buildCodingTaskSpec` is side-effecting -- it writes acceptance-criteria.json -- and not idempotent).
 */
function evaluateRepoReadinessCore(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions = {},
): ReadinessEvaluation {
  const repoFullName = entry?.repoFullName;
  if (typeof repoFullName !== "string" || !normalizeCrossRepoFullName(repoFullName)) {
    return {
      result: buildFailure(
        typeof repoFullName === "string" ? repoFullName : "(invalid)",
        CROSS_REPO_FAILURE_CATEGORY.OTHER,
        "Benchmark entry is missing a valid owner/repo name.",
      ),
      instructions: "",
      repoPath: "",
    };
  }

  const existsImpl = options.existsSync ?? existsSync;
  const detectImpl = options.detectRepoStack ?? detectRepoStack;
  const goalSpecImpl = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
  const buildSpecImpl: NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]> =
    options.buildCodingTaskSpec ??
    (buildCodingTaskSpec as unknown as NonNullable<EvaluateRepoReadinessOptions["buildCodingTaskSpec"]>);
  const repoPath = resolveEvaluationRepoPath(entry, options);

  if (!existsImpl(repoPath)) {
    return {
      result: buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP,
        `Repository path does not exist: ${repoPath}. Clone the repo or set LOOPOVER_MINER_REPO_CLONE_DIR.`,
      ),
      instructions: "",
      repoPath,
    };
  }

  const goalSpec = goalSpecImpl(repoPath);
  const usedDefaultGoalSpec = goalSpec?.present !== true;

  const stack = detectImpl(repoPath);
  if (stack?.detected !== true) {
    return {
      result: buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION,
        stack?.reason ?? "Stack auto-detection did not recognize this repository.",
        { stackDetected: false, usedDefaultGoalSpec },
      ),
      instructions: "",
      repoPath,
    };
  }

  if (entry.requireTestCommand === true && !stack.testCommand) {
    return {
      result: buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
        "Stack detection succeeded but no test command was inferred while requireTestCommand is set.",
        { stackDetected: true, usedDefaultGoalSpec, stack },
      ),
      instructions: "",
      repoPath,
    };
  }

  let specResult;
  try {
    specResult = composeCrossRepoEvaluationSpec(repoFullName, repoPath, buildSpecImpl, detectImpl);
  } catch (error) {
    return {
      result: buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, describeError(error), {
        stackDetected: true,
        usedDefaultGoalSpec,
        stack,
      }),
      instructions: "",
      repoPath,
    };
  }

  if (specResult?.ready !== true) {
    return {
      result: buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.EXECUTION,
        `Coding task spec is not ready (verdict: ${specResult?.verdict ?? "unknown"}).`,
        { stackDetected: true, usedDefaultGoalSpec, stack },
      ),
      instructions: "",
      repoPath,
    };
  }

  const assumptionFindings = scanPositiveLoopoverAssumptions(specResult.instructions ?? "");
  if (assumptionFindings.length > 0) {
    return {
      result: buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.GITTENSOR_ASSUMPTION,
        `Agent instructions leak loopover-specific assumptions (${assumptionFindings.map((f) => f.id).join(", ")}).`,
        { stackDetected: true, usedDefaultGoalSpec, stack, assumptionFindings },
      ),
      instructions: "",
      repoPath,
    };
  }

  return {
    result: buildPass(repoFullName, { usedDefaultGoalSpec, stack }),
    instructions: specResult.instructions ?? "",
    repoPath,
  };
}

/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 */
export function evaluateRepoReadiness(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions = {},
): CrossRepoEvaluationResult {
  return evaluateRepoReadinessCore(entry, options).result;
}

/** 10-minute cap on a target repo's own test suite when the caller does not override `testTimeoutMs` (#7634). */
export const DEFAULT_EXECUTION_TEST_TIMEOUT_MS: number = 600_000;

/**
 * Default clone seam (#7634): a read-only local clone/checkout. When the working copy is already on disk (the
 * normal case -- readiness resolves the same path via entry.fixturePath / options.repoPath / the clone cache and
 * has already gated its existence), it is reused directly with NO network. Otherwise it falls back to repo-clone's
 * ensureRepoCloned. Either way it never writes back to the third-party repo and never opens a PR -- it is the
 * "local clone" the dry-run permits.
 */
async function defaultCloneRepo(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions,
): Promise<CrossRepoExecutionCloneResult> {
  const existsImpl = options.existsSync ?? existsSync;
  const localPath = resolveEvaluationRepoPath(entry, options);
  if (localPath && existsImpl(localPath)) {
    return { ok: true, repoPath: localPath };
  }
  const result = await ensureRepoCloned(entry.repoFullName, {
    env: (options.env ?? process.env) as Record<string, string | undefined>,
  });
  const out: CrossRepoExecutionCloneResult = { ok: result.ok, repoPath: result.repoPath };
  if (result.error !== undefined) out.error = result.error;
  return out;
}

/**
 * Default coding-agent seam (#7634): a DRY-RUN SHADOW that never spawns a coding agent, never forwards
 * credentials, and produces no diff. A real diff is produced only when a caller injects options.runCodingAgent
 * (unit tests inject a fake CodingAgentDriver-shaped runner; a future live mode would inject the real driver).
 */
function defaultRunCodingAgent(_context: CrossRepoExecutionAgentContext): CrossRepoExecutionAgentResult {
  return {
    ok: true,
    changedFiles: [],
    summary: "dry-run: coding agent not executed (shadow); inject options.runCodingAgent to produce a diff.",
  };
}

/**
 * Default test seam (#7634): run the TARGET repo's own inferred test command locally via `sh -c`, mirroring the
 * executeLocalWrite subprocess wrapper (resolve-not-reject; SIGKILL on timeout). Purely local; no network.
 */
function defaultRunTests(command: string, cwd: string, timeoutMs: number): Promise<CrossRepoExecutionTestResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn("sh", ["-c", command], { cwd });
    } catch (error) {
      resolve({ code: null, stdout, stderr: describeError(error), timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${describeError(error)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * DRY-RUN full-execution evaluation of one benchmark repo (#7634). Reuses the readiness gate unchanged, then --
 * only for a repo that already passes readiness -- runs the discover->plan->code->test loop LOCALLY:
 *
 *   1. clone/checkout the repo (setup)          -> EXEC_SETUP on failure
 *   2. reuse the readiness-composed spec (plan) -- no second (side-effecting) buildCodingTaskSpec call
 *   3. run the coding agent to produce a diff   -> PLAN_COMPILE when the code phase does not converge
 *   4. run the target repo's own tests locally  -> TEST_FAILURE when the suite is red
 *   5. no-op guard                              -> NO_OP_DIFF when tests pass but the diff is empty
 *
 * Every side-effecting step (clone, agent, tests) is behind an injectable `options.*` seam so unit tests drive
 * the whole loop with fakes and zero real IO. There is deliberately NO PR-open / forge-write / credential path:
 * the harness clones and executes locally, then discards. Readiness-mode behavior is untouched.
 */
export async function evaluateRepoExecution(
  entry: CrossRepoEvaluationManifestRepo,
  options: EvaluateRepoReadinessOptions = {},
): Promise<CrossRepoEvaluationResult> {
  // Step 2 (plan) is folded into the readiness gate: the plan instructions come from readiness's SINGLE
  // buildCodingTaskSpec call (production buildCodingTaskSpec is side-effecting + non-idempotent, so we must
  // never call it twice).
  const readiness = evaluateRepoReadinessCore(entry, options);
  if (!readiness.result.passed) return readiness.result;

  const repoFullName = readiness.result.repoFullName;
  const usedDefaultGoalSpec = readiness.result.usedDefaultGoalSpec;
  const instructions = readiness.instructions;
  const stack = readiness.result.stack;
  if (!stack || stack.detected !== true) {
    // Defensive: a passing readiness always carries a detected stack. Guards type-narrowing + robustness.
    return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, "Readiness passed without a detected stack.", {
      stackDetected: false,
      usedDefaultGoalSpec,
      executed: true,
    });
  }

  const cloneImpl = options.cloneRepo ?? defaultCloneRepo;
  const agentImpl = options.runCodingAgent ?? defaultRunCodingAgent;
  const testImpl = options.runTests ?? defaultRunTests;
  const testTimeoutMs =
    typeof options.testTimeoutMs === "number" && options.testTimeoutMs > 0
      ? options.testTimeoutMs
      : DEFAULT_EXECUTION_TEST_TIMEOUT_MS;

  const execExtra: Partial<CrossRepoEvaluationResult> = {
    stackDetected: true,
    usedDefaultGoalSpec,
    stack,
    executed: true,
  };

  // Step 1 (setup): clone/checkout the target repo locally. Read-only -- never writes back upstream.
  let clone: CrossRepoExecutionCloneResult;
  try {
    clone = await cloneImpl(entry, options);
  } catch (error) {
    return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXEC_SETUP, describeError(error), execExtra);
  }
  if (clone?.ok !== true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.EXEC_SETUP,
      clone?.error ?? "Repository clone/checkout failed before the execution loop could start.",
      execExtra,
    );
  }
  const workingDirectory =
    typeof clone.repoPath === "string" && clone.repoPath.trim()
      ? clone.repoPath.trim()
      : readiness.repoPath || resolveEvaluationRepoPath(entry, options);

  // Step 3 (code): run the coding agent to produce a diff. Default is a non-spawning shadow (dry-run).
  let agentResult: CrossRepoExecutionAgentResult;
  try {
    agentResult = await agentImpl({ repoFullName, repoPath: workingDirectory, instructions, stack, entry });
  } catch (error) {
    return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, describeError(error), execExtra);
  }
  if (agentResult?.ok !== true) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.PLAN_COMPILE,
      agentResult?.error ?? "Coding agent formed a plan but the code phase did not produce a compiling change.",
      execExtra,
    );
  }
  const changedFiles = Array.isArray(agentResult.changedFiles) ? [...agentResult.changedFiles] : [];

  // Step 4 (test): run the TARGET repo's own test suite locally against the produced change.
  const testCommand = stack.testCommand;
  const withDiff: Partial<CrossRepoEvaluationResult> = {
    ...execExtra,
    changedFiles,
    testCommand: testCommand ?? null,
  };
  if (typeof testCommand === "string" && testCommand.trim()) {
    let testResult: CrossRepoExecutionTestResult;
    try {
      testResult = await testImpl(testCommand, workingDirectory, testTimeoutMs);
    } catch (error) {
      return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, describeError(error), withDiff);
    }
    const exitCode = testResult?.code ?? null;
    const withExit: Partial<CrossRepoEvaluationResult> = { ...withDiff, testExitCode: exitCode };
    if (testResult?.timedOut === true) {
      return buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.TEST_FAILURE,
        `Target repo test command timed out after ${testTimeoutMs}ms: ${testCommand}.`,
        withExit,
      );
    }
    if (exitCode !== 0) {
      return buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.TEST_FAILURE,
        `Target repo test command exited ${exitCode ?? "null"} (${testCommand}).`,
        withExit,
      );
    }
    // Step 5 (no-op guard): tests are green but the agent changed nothing -> a vacuous fix.
    if (changedFiles.length === 0) {
      return buildFailure(
        repoFullName,
        CROSS_REPO_FAILURE_CATEGORY.NO_OP_DIFF,
        "Target repo tests passed but the coding agent produced an empty diff (no-op change).",
        withExit,
      );
    }
    return buildPass(repoFullName, withExit);
  }

  // No inferred test command (only reachable when requireTestCommand is not set): still guard the no-op diff.
  if (changedFiles.length === 0) {
    return buildFailure(
      repoFullName,
      CROSS_REPO_FAILURE_CATEGORY.NO_OP_DIFF,
      "Coding agent produced an empty diff (no-op change) and no test command was available to verify a fix.",
      withDiff,
    );
  }
  return buildPass(repoFullName, { ...withDiff, testExitCode: null });
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
 * DRY-RUN full-execution run across every repo in a parsed manifest (#7634). Sequential (one clone+agent+test
 * loop at a time) so the local machine is never hammered. Same options-injection surface as the readiness run,
 * plus the clone/agent/test seams. Repos are read/executed-locally-and-discarded; no PR is ever opened.
 */
export async function runCrossRepoExecution(
  parsed: ParsedCrossRepoEvaluationManifest,
  options: { repoFilter?: string } & EvaluateRepoReadinessOptions = {},
): Promise<CrossRepoEvaluationResult[]> {
  const repos = parsed?.manifest?.repos ?? [];
  const results: CrossRepoEvaluationResult[] = [];
  for (const entry of repos) {
    if (options.repoFilter && entry.repoFullName !== options.repoFilter) continue;
    results.push(await evaluateRepoExecution(entry, options));
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
  const executedCount = list.filter((r) => r?.executed === true).length;
  return {
    total,
    passed,
    failed,
    majorityPassed,
    withoutLoopoverConfig,
    executedCount,
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
  // Dry-run full-execution runs surface how many repos actually entered the clone+agent+test loop (#7634).
  // Readiness-only runs never set `executed`, so this line is omitted and the readiness format is unchanged.
  if (summary.executedCount > 0) {
    lines.push(`dry-run full-execution: ${summary.executedCount}/${summary.total} entered the code+test loop`);
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
