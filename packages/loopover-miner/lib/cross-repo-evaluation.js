// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";

/** Failure taxonomy surfaced in per-repo reports (#4788). */
export const CROSS_REPO_FAILURE_CATEGORY = Object.freeze({
  STACK_DETECTION: "stack_detection_gap",
  EXECUTION: "execution_gap",
  GITTENSOR_ASSUMPTION: "loopover_assumption",
  CLONE_SETUP: "clone_setup",
  OTHER: "other",
});

/** Instruction substrings that indicate a POSITIVE loopover/LoopOver CI assumption leaked into the agent prompt.
 *  Lines that explicitly tell the agent *not* to assume these are filtered out before scanning. */
export const GITTENSOR_POSITIVE_ASSUMPTION_CHECKS = Object.freeze([
  { id: "test_ci_script", pattern: /npm run test:ci/i },
  { id: "codecov_patch", pattern: /codecov\/patch/i },
  { id: "gittensor_label", pattern: /gittensor:(?:bug|feature|priority)/i },
  { id: "loopover_gate", pattern: /loopover gate/i },
]);

export const DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH = "benchmarks/cross-repo/manifest.json";
export const MAX_CROSS_REPO_MANIFEST_BYTES = 65_536;
export const MAX_CROSS_REPO_MANIFEST_REPOS = 100;

function cloneEmptyManifest(warnings = []) {
  return { present: false, manifest: { repos: [] }, warnings };
}

/** Canonical `owner/repo` with exactly one slash and safe segments; anything else → null. */
export function normalizeCrossRepoFullName(value) {
  if (typeof value !== "string") return null;
  const [owner, repo, extra] = value.trim().split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;
  return `${owner}/${repo}`;
}

function normalizeBoolean(value, field, fallback, warnings) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a boolean; falling back to ${fallback}.`);
  return fallback;
}

function normalizeOptionalString(value, field, warnings) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a string; ignoring the value.`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRepoList(value, warnings) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`CrossRepoEvaluationManifest field "repos" must be a list; ignoring a ${typeof value} value.`);
    return [];
  }
  const result = [];
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    if (index >= MAX_CROSS_REPO_MANIFEST_REPOS) {
      warnings.push(
        `CrossRepoEvaluationManifest field "repos" exceeded ${MAX_CROSS_REPO_MANIFEST_REPOS} entries; extra entries ignored.`,
      );
      break;
    }
    let repoFullName = null;
    let stackHint = null;
    let requireTestCommand = false;
    let fixturePath = null;
    if (typeof entry === "string") {
      repoFullName = normalizeCrossRepoFullName(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry;
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
    const normalized = { repoFullName, requireTestCommand };
    if (stackHint) normalized.stackHint = stackHint;
    if (fixturePath) normalized.fixturePath = fixturePath;
    result.push(normalized);
  }
  return result;
}

/**
 * Tolerant JSON manifest parser (#4788). Malformed input degrades to an empty repo list with warnings rather than
 * throwing, mirroring the fleet-run-manifest / miner-goal-spec convention.
 *
 * @param {string | null | undefined} content
 * @returns {{ present: boolean, manifest: { repos: Array<{ repoFullName: string, stackHint?: string, requireTestCommand?: boolean, fixturePath?: string }> }, warnings: string[] }}
 */
export function parseCrossRepoEvaluationManifest(content) {
  if (content === undefined || content === null) return cloneEmptyManifest();
  if (typeof content !== "string") {
    return cloneEmptyManifest([`CrossRepoEvaluationManifest content must be a string; got ${typeof content}.`]);
  }
  const trimmed = content.trim();
  if (!trimmed) return cloneEmptyManifest();
  if (trimmed.length > MAX_CROSS_REPO_MANIFEST_BYTES) {
    return cloneEmptyManifest([
      `CrossRepoEvaluationManifest exceeded ${MAX_CROSS_REPO_MANIFEST_BYTES} bytes; ignoring the file.`,
    ]);
  }
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return cloneEmptyManifest(["CrossRepoEvaluationManifest is not valid JSON."]);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return cloneEmptyManifest(["CrossRepoEvaluationManifest root must be a JSON object."]);
  }
  const warnings = [];
  const repos = normalizeRepoList(raw.repos, warnings);
  return { present: true, manifest: { repos }, warnings };
}

/**
 * Scan agent instructions for positive loopover/LoopOver assumptions (#4788). Lines that already tell the agent
 * *not* to assume LoopOver conventions (the negative guidance from buildValidationGuidance) are skipped.
 *
 * @param {string} text
 * @returns {Array<{ id: string, line: string }>}
 */
export function scanPositiveLoopoverAssumptions(text) {
  if (typeof text !== "string") return [];
  const findings = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /do not assume/i.test(trimmed)) continue;
    for (const check of GITTENSOR_POSITIVE_ASSUMPTION_CHECKS) {
      if (check.pattern.test(line)) findings.push({ id: check.id, line: trimmed });
    }
  }
  return findings;
}

function buildFailure(repoFullName, category, reason, extra = {}) {
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

function buildPass(repoFullName, extra = {}) {
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

function resolveEvaluationRepoPath(entry, options = {}) {
  if (entry.fixturePath && typeof entry.fixturePath === "string") return entry.fixturePath;
  if (typeof options.repoPath === "string" && options.repoPath.trim()) return options.repoPath.trim();
  if (typeof options.resolveRepoPath === "function") return options.resolveRepoPath(entry);
  return resolveRepoCloneDir(entry.repoFullName, options.env ?? process.env);
}

function defaultClaimLedger(repoFullName) {
  return { listClaims: () => [] };
}

/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 *
 * @param {{ repoFullName: string, stackHint?: string, requireTestCommand?: boolean, fixturePath?: string }} entry
 * @param {{
 *   repoPath?: string,
 *   resolveRepoPath?: (entry: { repoFullName: string }) => string,
 *   env?: NodeJS.ProcessEnv,
 *   existsSync?: (path: string) => boolean,
 *   detectRepoStack?: typeof detectRepoStack,
 *   resolveMinerGoalSpec?: typeof resolveMinerGoalSpec,
 *   buildCodingTaskSpec?: typeof buildCodingTaskSpec,
 * }} [options]
 */
export function evaluateRepoReadiness(entry, options = {}) {
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
  const buildSpecImpl = options.buildCodingTaskSpec ?? buildCodingTaskSpec;
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
    specResult = buildSpecImpl({
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
 *
 * @param {ReturnType<typeof parseCrossRepoEvaluationManifest>} parsed
 * @param {{ repoFilter?: string } & Parameters<typeof evaluateRepoReadiness>[1]} [options]
 * @returns {ReturnType<typeof evaluateRepoReadiness>[]}
 */
export function runCrossRepoEvaluation(parsed, options = {}) {
  const repos = parsed?.manifest?.repos ?? [];
  const results = [];
  for (const entry of repos) {
    if (options.repoFilter && entry.repoFullName !== options.repoFilter) continue;
    results.push(evaluateRepoReadiness(entry, options));
  }
  return results;
}

/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 *
 * @param {ReturnType<typeof evaluateRepoReadiness>[]} results
 */
export function summarizeCrossRepoEvaluation(results) {
  const list = Array.isArray(results) ? results : [];
  let passed = 0;
  let failed = 0;
  const failuresByCategory = {};
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
 *
 * @param {ReturnType<typeof evaluateRepoReadiness>[]} results
 * @param {ReturnType<typeof summarizeCrossRepoEvaluation>} [summary]
 */
export function formatCrossRepoEvaluationReport(results, summary = summarizeCrossRepoEvaluation(results)) {
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
