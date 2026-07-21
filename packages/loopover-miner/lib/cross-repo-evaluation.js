// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";
/** Failure taxonomy surfaced in per-repo reports. Readiness-mode categories (#4788) plus the full-execution
 *  categories (#7634) that classify how a live discover → plan → code → test attempt fell short. */
export const CROSS_REPO_FAILURE_CATEGORY = Object.freeze({
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
        let fullExecution = false;
        if (typeof entry === "string") {
            repoFullName = normalizeCrossRepoFullName(entry);
        }
        else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const record = entry;
            repoFullName = normalizeCrossRepoFullName(record.repoFullName);
            stackHint = normalizeOptionalString(record.stackHint, "stackHint", warnings);
            requireTestCommand = normalizeBoolean(record.requireTestCommand, "requireTestCommand", false, warnings);
            fixturePath = normalizeOptionalString(record.fixturePath, "fixturePath", warnings);
            fullExecution = normalizeBoolean(record.fullExecution, "fullExecution", false, warnings);
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
        if (fullExecution)
            normalized.fullExecution = true;
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
/** Compose the synthetic coding-task spec both readiness and full-execution evaluate against, so the two modes
 *  drive the exact same discover/plan surface a real attempt would (#7634). */
function buildEvaluationCodingTaskSpec(repoFullName, repoPath, buildSpecImpl, detectImpl) {
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
        specResult = buildEvaluationCodingTaskSpec(repoFullName, repoPath, buildSpecImpl, detectImpl);
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
/** First non-empty line of command output, trimmed and length-capped, for a compact failure reason (#7634). */
function firstOutputLine(output) {
    if (typeof output !== "string")
        return "";
    const line = output.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
/** Real default local-command runner: split the detected command into an argv and spawn it directly in the clone
 *  dir with NO shell (`shell: false`), so shell metacharacters in untrusted repo metadata (e.g. a crafted
 *  package.json script name) cannot inject extra commands (#7641). Stack commands are plain whitespace-separated
 *  argv (`npm run build`, `cargo test`, `go build ./...`). Resolve-not-throw: a non-zero exit becomes `ok: false`
 *  with its captured output rather than an exception (#7634). Exported for direct unit coverage. */
export function defaultRunLocalCommand(command, context, spawn = spawnSync) {
    const [file, ...args] = command.trim().split(/\s+/).filter(Boolean);
    if (!file)
        return { ok: false, code: null, output: "empty command" };
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
function runStackCommand(command, context, runLocalCommand, options) {
    if (!command)
        return { ok: true, skipped: true };
    return runLocalCommand(command, {
        cwd: context.repoPath,
        ...(options.env !== undefined ? { env: options.env } : {}),
    });
}
function executionResult(base, extra) {
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
export async function executeRepoAttempt(entry, options = {}) {
    const readiness = evaluateRepoReadiness(entry, options);
    if (!readiness.passed) {
        return { ...readiness, executed: false };
    }
    const repoFullName = readiness.repoFullName;
    const repoPath = resolveEvaluationRepoPath(entry, options);
    const stack = readiness.stack;
    const detectImpl = options.detectRepoStack ?? detectRepoStack;
    const buildSpecImpl = options.buildCodingTaskSpec ?? buildCodingTaskSpec;
    const runLocalCommand = options.runLocalCommand ?? defaultRunLocalCommand;
    const compileImpl = options.compileRepo ?? ((context) => runStackCommand(context.stack.detected ? context.stack.buildCommand : null, context, runLocalCommand, options));
    const testImpl = options.runRepoTests ?? ((context) => runStackCommand(context.stack.detected ? context.stack.testCommand : null, context, runLocalCommand, options));
    // Re-derive the same coding-task instructions readiness already validated, to hand the live agent (#7634).
    let instructions = "";
    try {
        instructions = buildEvaluationCodingTaskSpec(repoFullName, repoPath, buildSpecImpl, detectImpl).instructions ?? "";
    }
    catch {
        instructions = "";
    }
    // Stage 2 — discover → plan → code. Without an injected executor the harness will not fabricate a run.
    if (typeof options.runCodingAttempt !== "function") {
        return executionResult(buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF, "No coding-agent executor configured for full-execution mode (set MINER_CODING_AGENT_PROVIDER and run via the CLI).", { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack }), { diffChars: null });
    }
    let attempt;
    try {
        attempt = await options.runCodingAttempt({
            repoFullName,
            repoPath,
            stack,
            instructions,
            attemptId: `cross-repo-exec-${repoFullName.replace("/", "__")}`,
            maxTurns: Number.isFinite(options.maxTurns) ? options.maxTurns : 30,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return executionResult(buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF, `Coding agent did not run: ${message}`, {
            stackDetected: true,
            usedDefaultGoalSpec: readiness.usedDefaultGoalSpec,
            stack,
        }), { diffChars: null });
    }
    const diff = typeof attempt?.diff === "string" ? attempt.diff : "";
    if (!attempt || (attempt.ok === false && diff.trim().length === 0)) {
        return executionResult(buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF, attempt?.error ?? "Coding agent reported failure and produced no diff.", { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack }), { diffChars: diff.length });
    }
    // Stage 3 — the produced diff must still build.
    const compile = await compileImpl({ repoPath, stack });
    if (!compile.ok) {
        return executionResult(buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_COMPILE, `Generated diff did not build${firstOutputLine(compile.output) ? `: ${firstOutputLine(compile.output)}` : "."}`, { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack }), { compilePassed: false, diffChars: diff.length });
    }
    // Stage 4 — the target repo's own test suite must pass.
    const test = await testImpl({ repoPath, stack });
    if (!test.ok) {
        return executionResult(buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_TEST, `Target test suite failed${firstOutputLine(test.output) ? `: ${firstOutputLine(test.output)}` : "."}`, { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack }), { compilePassed: true, testsPassed: false, diffChars: diff.length });
    }
    // Stage 5 — a passing run with no actual change is a no-op, not a success.
    if (diff.trim().length === 0) {
        return executionResult(buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NOOP, "Tests passed but the coding agent produced a no-op diff (no file changes).", { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack }), { compilePassed: true, testsPassed: true, diffChars: 0 });
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
export async function runCrossRepoExecution(parsed, options = {}) {
    const repos = parsed?.manifest?.repos ?? [];
    const results = [];
    for (const entry of repos) {
        if (options.repoFilter) {
            if (entry.repoFullName !== options.repoFilter)
                continue;
        }
        else if (entry.fullExecution !== true) {
            continue;
        }
        results.push(await executeRepoAttempt(entry, options));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGlIQUFpSDtBQUNqSCw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFFckcsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQy9DLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFFckMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDNUQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLG1CQUFtQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDMUUsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBR3ZEO29HQUNvRztBQUNwRyxNQUFNLENBQUMsTUFBTSwyQkFBMkIsR0FVbkMsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNqQixlQUFlLEVBQUUscUJBQXFCO0lBQ3RDLFNBQVMsRUFBRSxlQUFlO0lBQzFCLG9CQUFvQixFQUFFLHFCQUFxQjtJQUMzQyxXQUFXLEVBQUUsYUFBYTtJQUMxQix5R0FBeUc7SUFDekcsMkdBQTJHO0lBQzNHLHNEQUFzRDtJQUN0RCxpQkFBaUIsRUFBRSxtQkFBbUI7SUFDdEMsaUJBQWlCLEVBQUUsdUJBQXVCO0lBQzFDLGNBQWMsRUFBRSx3QkFBd0I7SUFDeEMsY0FBYyxFQUFFLHFCQUFxQjtJQUNyQyxLQUFLLEVBQUUsT0FBTztDQUNmLENBQUMsQ0FBQztBQUVIO21HQUNtRztBQUNuRyxNQUFNLENBQUMsTUFBTSxvQ0FBb0MsR0FBbUQsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNoSCxFQUFFLEVBQUUsRUFBRSxnQkFBZ0IsRUFBRSxPQUFPLEVBQUUs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