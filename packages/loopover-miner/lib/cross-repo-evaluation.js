// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.
import { existsSync } from "node:fs";
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
// True UTF-8 byte count for the size guard (#7223): JS string `.length` is UTF-16 code units, which under-counts
// any multi-byte character (up to 4x for astral-plane code points), so `MAX_CROSS_REPO_MANIFEST_BYTES` -- named
// and warned about in BYTES -- was actually being compared against a code-unit count. Mirrors the identical helper
// in the three siblings this parser's own comment claims to follow: fleet-run-manifest.ts, miner-goal-spec.ts,
// and ams-policy-spec.ts.
function utf8ByteLength(value) {
    let bytes = 0;
    for (const char of value) {
        // `char` is a non-empty code-point string from the string iterator, so codePointAt(0) is always defined; the
        // cast narrows `number | undefined` without adding an unreachable `?? 0` branch.
        const codePoint = char.codePointAt(0);
        if (codePoint <= 0x7f)
            bytes += 1;
        else if (codePoint <= 0x7ff)
            bytes += 2;
        else if (codePoint <= 0xffff)
            bytes += 3;
        else
            bytes += 4;
    }
    return bytes;
}
function cloneEmptyManifest(warnings = []) {
    return { present: false, manifest: { repos: [] }, warnings };
}
/** Canonical `owner/repo` with exactly one slash and safe segments; anything else → null. */
export function normalizeCrossRepoFullName(value) {
    if (typeof value !== "string")
        return null;
    const [owner, repo, extra] = value.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        return null;
    return `${owner}/${repo}`;
}
function normalizeBoolean(value, field, fallback, warnings) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === "boolean")
        return value;
    warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a boolean; falling back to ${fallback}.`);
    return fallback;
}
function normalizeOptionalString(value, field, warnings) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string") {
        warnings.push(`CrossRepoEvaluationManifest field "${field}" must be a string; ignoring the value.`);
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}
function normalizeRepoList(value, warnings) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value)) {
        warnings.push(`CrossRepoEvaluationManifest field "repos" must be a list; ignoring a ${typeof value} value.`);
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const [index, entry] of value.entries()) {
        if (index >= MAX_CROSS_REPO_MANIFEST_REPOS) {
            warnings.push(`CrossRepoEvaluationManifest field "repos" exceeded ${MAX_CROSS_REPO_MANIFEST_REPOS} entries; extra entries ignored.`);
            break;
        }
        let repoFullName = null;
        let stackHint = null;
        let requireTestCommand = false;
        let fixturePath = null;
        if (typeof entry === "string") {
            repoFullName = normalizeCrossRepoFullName(entry);
        }
        else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const record = entry;
            repoFullName = normalizeCrossRepoFullName(record.repoFullName);
            stackHint = normalizeOptionalString(record.stackHint, "stackHint", warnings);
            requireTestCommand = normalizeBoolean(record.requireTestCommand, "requireTestCommand", false, warnings);
            fixturePath = normalizeOptionalString(record.fixturePath, "fixturePath", warnings);
        }
        else {
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
        if (stackHint)
            normalized.stackHint = stackHint;
        if (fixturePath)
            normalized.fixturePath = fixturePath;
        result.push(normalized);
    }
    return result;
}
/**
 * Tolerant JSON manifest parser (#4788). Malformed input degrades to an empty repo list with warnings rather than
 * throwing, mirroring the fleet-run-manifest / miner-goal-spec convention.
 */
export function parseCrossRepoEvaluationManifest(content) {
    if (content === undefined || content === null)
        return cloneEmptyManifest();
    if (typeof content !== "string") {
        return cloneEmptyManifest([`CrossRepoEvaluationManifest content must be a string; got ${typeof content}.`]);
    }
    const trimmed = content.trim();
    if (!trimmed)
        return cloneEmptyManifest();
    if (utf8ByteLength(trimmed) > MAX_CROSS_REPO_MANIFEST_BYTES) {
        return cloneEmptyManifest([
            `CrossRepoEvaluationManifest exceeded ${MAX_CROSS_REPO_MANIFEST_BYTES} bytes; ignoring the file.`,
        ]);
    }
    let raw;
    try {
        raw = JSON.parse(trimmed);
    }
    catch {
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
 */
export function scanPositiveLoopoverAssumptions(text) {
    if (typeof text !== "string")
        return [];
    const findings = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || /do not assume/i.test(trimmed))
            continue;
        for (const check of GITTENSOR_POSITIVE_ASSUMPTION_CHECKS) {
            if (check.pattern.test(line))
                findings.push({ id: check.id, line: trimmed });
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
    if (entry.fixturePath && typeof entry.fixturePath === "string")
        return entry.fixturePath;
    if (typeof options.repoPath === "string" && options.repoPath.trim())
        return options.repoPath.trim();
    if (typeof options.resolveRepoPath === "function")
        return options.resolveRepoPath(entry);
    return resolveRepoCloneDir(entry.repoFullName, options.env ?? process.env);
}
function defaultClaimLedger(_repoFullName) {
    return { listClaims: () => [] };
}
/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 */
export function evaluateRepoReadiness(entry, options = {}) {
    const repoFullName = entry?.repoFullName;
    if (typeof repoFullName !== "string" || !normalizeCrossRepoFullName(repoFullName)) {
        return buildFailure(typeof repoFullName === "string" ? repoFullName : "(invalid)", CROSS_REPO_FAILURE_CATEGORY.OTHER, "Benchmark entry is missing a valid owner/repo name.");
    }
    const existsImpl = options.existsSync ?? existsSync;
    const detectImpl = options.detectRepoStack ?? detectRepoStack;
    const goalSpecImpl = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
    // The harness feeds buildCodingTaskSpec a synthetic smoke issue with only the fields it actually reads; the
    // option is deliberately typed against a loose `Record<string, unknown>` input (see EvaluateRepoReadinessOptions
    // and the original .d.ts), so the real default is adapted to that same loose contract here.
    const buildSpecImpl = options.buildCodingTaskSpec ??
        buildCodingTaskSpec;
    const repoPath = resolveEvaluationRepoPath(entry, options);
    if (!existsImpl(repoPath)) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP, `Repository path does not exist: ${repoPath}. Clone the repo or set LOOPOVER_MINER_REPO_CLONE_DIR.`);
    }
    const goalSpec = goalSpecImpl(repoPath);
    const usedDefaultGoalSpec = goalSpec?.present !== true;
    const stack = detectImpl(repoPath);
    if (stack?.detected !== true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION, stack?.reason ?? "Stack auto-detection did not recognize this repository.", { stackDetected: false, usedDefaultGoalSpec });
    }
    if (entry.requireTestCommand === true && !stack.testCommand) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, "Stack detection succeeded but no test command was inferred while requireTestCommand is set.", { stackDetected: true, usedDefaultGoalSpec, stack });
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, message, {
            stackDetected: true,
            usedDefaultGoalSpec,
            stack,
        });
    }
    if (specResult?.ready !== true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, `Coding task spec is not ready (verdict: ${specResult?.verdict ?? "unknown"}).`, { stackDetected: true, usedDefaultGoalSpec, stack });
    }
    const assumptionFindings = scanPositiveLoopoverAssumptions(specResult.instructions ?? "");
    if (assumptionFindings.length > 0) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.GITTENSOR_ASSUMPTION, `Agent instructions leak loopover-specific assumptions (${assumptionFindings.map((f) => f.id).join(", ")}).`, { stackDetected: true, usedDefaultGoalSpec, stack, assumptionFindings });
    }
    return buildPass(repoFullName, { usedDefaultGoalSpec, stack });
}
/**
 * Run the harness across every repo in a parsed manifest (#4788).
 */
export function runCrossRepoEvaluation(parsed, options = {}) {
    const repos = parsed?.manifest?.repos ?? [];
    const results = [];
    for (const entry of repos) {
        if (options.repoFilter && entry.repoFullName !== options.repoFilter)
            continue;
        results.push(evaluateRepoReadiness(entry, options));
    }
    return results;
}
/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
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
    lines.push("", `summary: ${summary.passed}/${summary.total} passed` +
        (summary.majorityPassed ? " (majority passed)" : " (majority failed)"));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGlIQUFpSDtBQUNqSCw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFFckcsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNyQyxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUM1RCxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUM1RCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUMxRSxPQUFPLEVBQUUsZUFBZSxFQUF3QixNQUFNLHNCQUFzQixDQUFDO0FBRTdFLDZEQUE2RDtBQUM3RCxNQUFNLENBQUMsTUFBTSwyQkFBMkIsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ3ZELGVBQWUsRUFBRSxxQkFBcUI7SUFDdEMsU0FBUyxFQUFFLGVBQWU7SUFDMUIsb0JBQW9CLEVBQUUscUJBQXFCO0lBQzNDLFdBQVcsRUFBRSxhQUFhO0lBQzFCLEtBQUssRUFBRSxPQUFPO0NBQ04sQ0FBQyxDQUFDO0FBRVo7bUdBQ21HO0FBQ25HLE1BQU0sQ0FBQyxNQUFNLG9DQUFvQyxHQUFtRCxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ2hILEVBQUUsRUFBRSxFQUFFLGdCQUFnQixFQUFFLE9BQU8sRUFBRSxrQkFBa0IsRUFBRTtJQUNyRCxFQUFFLEVBQUUsRUFBRSxlQUFlLEVBQUUsT0FBTyxFQUFFLGlCQUFpQixFQUFFO0lBQ25ELEVBQUUsRUFBRSxFQUFFLGlCQUFpQixFQUFFLE9BQU8sRUFBRSxxQ0FBcUMsRUFBRTtJQUN6RSxFQUFFLEVBQUUsRUFBRSxlQUFlLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFO0NBQ25E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