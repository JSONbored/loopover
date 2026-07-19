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
function defaultClaimLedger(repoFullName) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGlIQUFpSDtBQUNqSCw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFFckcsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUVyQyxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUM1RCxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUM1RCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUMxRSxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFHdkQsNkRBQTZEO0FBQzdELE1BQU0sQ0FBQyxNQUFNLDJCQUEyQixHQU1uQyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ2pCLGVBQWUsRUFBRSxxQkFBcUI7SUFDdEMsU0FBUyxFQUFFLGVBQWU7SUFDMUIsb0JBQW9CLEVBQUUscUJBQXFCO0lBQzNDLFdBQVcsRUFBRSxhQUFhO0lBQzFCLEtBQUssRUFBRSxPQUFPO0NBQ2YsQ0FBQyxDQUFDO0FBRUg7bUdBQ21HO0FBQ25HLE1BQU0sQ0FBQyxNQUFNLG9DQUFvQyxHQUFtRCxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ2hILEVBQUUsRUFBRSxFQUFFLGdCQUFnQixFQUFFLE9BQU8sRUFBRSxrQkFBa0IsRUFBRTtJQUNyRCxFQUFFLEVBQUUsRUFBRSxlQUFlLEVBQUUsT0FBTyxFQUFFLGlCQUFpQixFQUFFO0lBQ25ELEVBQUUsRUFBRSxFQUFFLGlCQUFpQixFQUFFLE9BQU8sRUFBRSxxQ0FBcUMsRUFBRTtJQUN6RSxFQUFFLEVBQUUsRUFBRSxlQUFlLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFO0NBQ25E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