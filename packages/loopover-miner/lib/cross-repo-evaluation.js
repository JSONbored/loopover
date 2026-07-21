// Cross-repo evaluation harness (#4788): a repeatable, offline-first readiness check that asks whether the miner
// can approach a diverse benchmark repo set without loopover-specific target-repo configuration. Each repo is
// evaluated through the same stack-detection + coding-task-spec path a real attempt uses (detectRepoStack,
// resolveMinerGoalSpec, buildCodingTaskSpec) and failures are categorized as stack-detection gaps, execution
// readiness gaps, leaked loopover assumptions in agent instructions, clone/setup problems, or other.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { buildCodingTaskSpec } from "./coding-task-spec.js";
import { resolveMinerGoalSpec } from "./miner-goal-spec.js";
import { ensureRepoCloned, isValidRepoSegment, resolveRepoCloneDir } from "./repo-clone.js";
import { detectRepoStack } from "./stack-detection.js";
/** Failure taxonomy surfaced in per-repo reports (#4788). The first five members are the offline
 *  readiness taxonomy; the four `EXEC_*`/plan/test/no-op members are the dry-run full-execution taxonomy
 *  (#7634) surfaced only when the `--full-execution` loop actually clones, runs the agent, and runs the
 *  target repo's own tests. New members are appended in the same frozen literal so existing members are
 *  never removed. */
export const CROSS_REPO_FAILURE_CATEGORY = Object.freeze({
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
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Compose the synthetic coding-task spec both the readiness gate and the full-execution loop use (#4788 / #7634).
 * Shared so the "plan" (spec instructions) is derived identically in both modes -- readiness validates it is
 * leak-free; full-execution reuses it as the agent's plan.
 */
function composeCrossRepoEvaluationSpec(repoFullName, repoPath, buildSpecImpl, detectImpl) {
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
 * Readiness core (#4788 / #7634). Identical logic to {@link evaluateRepoReadiness} but also returns the plan
 * instructions from the SINGLE `buildCodingTaskSpec` call, so the full-execution loop never re-invokes that
 * (production `buildCodingTaskSpec` is side-effecting -- it writes acceptance-criteria.json -- and not idempotent).
 */
function evaluateRepoReadinessCore(entry, options = {}) {
    const repoFullName = entry?.repoFullName;
    if (typeof repoFullName !== "string" || !normalizeCrossRepoFullName(repoFullName)) {
        return {
            result: buildFailure(typeof repoFullName === "string" ? repoFullName : "(invalid)", CROSS_REPO_FAILURE_CATEGORY.OTHER, "Benchmark entry is missing a valid owner/repo name."),
            instructions: "",
            repoPath: "",
        };
    }
    const existsImpl = options.existsSync ?? existsSync;
    const detectImpl = options.detectRepoStack ?? detectRepoStack;
    const goalSpecImpl = options.resolveMinerGoalSpec ?? resolveMinerGoalSpec;
    const buildSpecImpl = options.buildCodingTaskSpec ??
        buildCodingTaskSpec;
    const repoPath = resolveEvaluationRepoPath(entry, options);
    if (!existsImpl(repoPath)) {
        return {
            result: buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP, `Repository path does not exist: ${repoPath}. Clone the repo or set LOOPOVER_MINER_REPO_CLONE_DIR.`),
            instructions: "",
            repoPath,
        };
    }
    const goalSpec = goalSpecImpl(repoPath);
    const usedDefaultGoalSpec = goalSpec?.present !== true;
    const stack = detectImpl(repoPath);
    if (stack?.detected !== true) {
        return {
            result: buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION, stack?.reason ?? "Stack auto-detection did not recognize this repository.", { stackDetected: false, usedDefaultGoalSpec }),
            instructions: "",
            repoPath,
        };
    }
    if (entry.requireTestCommand === true && !stack.testCommand) {
        return {
            result: buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, "Stack detection succeeded but no test command was inferred while requireTestCommand is set.", { stackDetected: true, usedDefaultGoalSpec, stack }),
            instructions: "",
            repoPath,
        };
    }
    let specResult;
    try {
        specResult = composeCrossRepoEvaluationSpec(repoFullName, repoPath, buildSpecImpl, detectImpl);
    }
    catch (error) {
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
            result: buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, `Coding task spec is not ready (verdict: ${specResult?.verdict ?? "unknown"}).`, { stackDetected: true, usedDefaultGoalSpec, stack }),
            instructions: "",
            repoPath,
        };
    }
    const assumptionFindings = scanPositiveLoopoverAssumptions(specResult.instructions ?? "");
    if (assumptionFindings.length > 0) {
        return {
            result: buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.GITTENSOR_ASSUMPTION, `Agent instructions leak loopover-specific assumptions (${assumptionFindings.map((f) => f.id).join(", ")}).`, { stackDetected: true, usedDefaultGoalSpec, stack, assumptionFindings }),
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
export function evaluateRepoReadiness(entry, options = {}) {
    return evaluateRepoReadinessCore(entry, options).result;
}
/** 10-minute cap on a target repo's own test suite when the caller does not override `testTimeoutMs` (#7634). */
export const DEFAULT_EXECUTION_TEST_TIMEOUT_MS = 600_000;
/**
 * Default clone seam (#7634): a read-only local clone/checkout. When the working copy is already on disk (the
 * normal case -- readiness resolves the same path via entry.fixturePath / options.repoPath / the clone cache and
 * has already gated its existence), it is reused directly with NO network. Otherwise it falls back to repo-clone's
 * ensureRepoCloned. Either way it never writes back to the third-party repo and never opens a PR -- it is the
 * "local clone" the dry-run permits.
 */
async function defaultCloneRepo(entry, options) {
    const existsImpl = options.existsSync ?? existsSync;
    const localPath = resolveEvaluationRepoPath(entry, options);
    if (localPath && existsImpl(localPath)) {
        return { ok: true, repoPath: localPath };
    }
    const result = await ensureRepoCloned(entry.repoFullName, {
        env: (options.env ?? process.env),
    });
    const out = { ok: result.ok, repoPath: result.repoPath };
    if (result.error !== undefined)
        out.error = result.error;
    return out;
}
/**
 * Default coding-agent seam (#7634): a DRY-RUN SHADOW that never spawns a coding agent, never forwards
 * credentials, and produces no diff. A real diff is produced only when a caller injects options.runCodingAgent
 * (unit tests inject a fake CodingAgentDriver-shaped runner; a future live mode would inject the real driver).
 */
function defaultRunCodingAgent(_context) {
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
function defaultRunTests(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let child;
        try {
            child = spawn("sh", ["-c", command], { cwd });
        }
        catch (error) {
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
export async function evaluateRepoExecution(entry, options = {}) {
    // Step 2 (plan) is folded into the readiness gate: the plan instructions come from readiness's SINGLE
    // buildCodingTaskSpec call (production buildCodingTaskSpec is side-effecting + non-idempotent, so we must
    // never call it twice).
    const readiness = evaluateRepoReadinessCore(entry, options);
    if (!readiness.result.passed)
        return readiness.result;
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
    const testTimeoutMs = typeof options.testTimeoutMs === "number" && options.testTimeoutMs > 0
        ? options.testTimeoutMs
        : DEFAULT_EXECUTION_TEST_TIMEOUT_MS;
    const execExtra = {
        stackDetected: true,
        usedDefaultGoalSpec,
        stack,
        executed: true,
    };
    // Step 1 (setup): clone/checkout the target repo locally. Read-only -- never writes back upstream.
    let clone;
    try {
        clone = await cloneImpl(entry, options);
    }
    catch (error) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXEC_SETUP, describeError(error), execExtra);
    }
    if (clone?.ok !== true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXEC_SETUP, clone?.error ?? "Repository clone/checkout failed before the execution loop could start.", execExtra);
    }
    const workingDirectory = typeof clone.repoPath === "string" && clone.repoPath.trim()
        ? clone.repoPath.trim()
        : readiness.repoPath || resolveEvaluationRepoPath(entry, options);
    // Step 3 (code): run the coding agent to produce a diff. Default is a non-spawning shadow (dry-run).
    let agentResult;
    try {
        agentResult = await agentImpl({ repoFullName, repoPath: workingDirectory, instructions, stack, entry });
    }
    catch (error) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, describeError(error), execExtra);
    }
    if (agentResult?.ok !== true) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.PLAN_COMPILE, agentResult?.error ?? "Coding agent formed a plan but the code phase did not produce a compiling change.", execExtra);
    }
    const changedFiles = Array.isArray(agentResult.changedFiles) ? [...agentResult.changedFiles] : [];
    // Step 4 (test): run the TARGET repo's own test suite locally against the produced change.
    const testCommand = stack.testCommand;
    const withDiff = {
        ...execExtra,
        changedFiles,
        testCommand: testCommand ?? null,
    };
    if (typeof testCommand === "string" && testCommand.trim()) {
        let testResult;
        try {
            testResult = await testImpl(testCommand, workingDirectory, testTimeoutMs);
        }
        catch (error) {
            return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, describeError(error), withDiff);
        }
        const exitCode = testResult?.code ?? null;
        const withExit = { ...withDiff, testExitCode: exitCode };
        if (testResult?.timedOut === true) {
            return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.TEST_FAILURE, `Target repo test command timed out after ${testTimeoutMs}ms: ${testCommand}.`, withExit);
        }
        if (exitCode !== 0) {
            return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.TEST_FAILURE, `Target repo test command exited ${exitCode ?? "null"} (${testCommand}).`, withExit);
        }
        // Step 5 (no-op guard): tests are green but the agent changed nothing -> a vacuous fix.
        if (changedFiles.length === 0) {
            return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.NO_OP_DIFF, "Target repo tests passed but the coding agent produced an empty diff (no-op change).", withExit);
        }
        return buildPass(repoFullName, withExit);
    }
    // No inferred test command (only reachable when requireTestCommand is not set): still guard the no-op diff.
    if (changedFiles.length === 0) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.NO_OP_DIFF, "Coding agent produced an empty diff (no-op change) and no test command was available to verify a fix.", withDiff);
    }
    return buildPass(repoFullName, { ...withDiff, testExitCode: null });
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
 * DRY-RUN full-execution run across every repo in a parsed manifest (#7634). Sequential (one clone+agent+test
 * loop at a time) so the local machine is never hammered. Same options-injection surface as the readiness run,
 * plus the clone/agent/test seams. Repos are read/executed-locally-and-discarded; no PR is ever opened.
 */
export async function runCrossRepoExecution(parsed, options = {}) {
    const repos = parsed?.manifest?.repos ?? [];
    const results = [];
    for (const entry of repos) {
        if (options.repoFilter && entry.repoFullName !== options.repoFilter)
            continue;
        results.push(await evaluateRepoExecution(entry, options));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGlIQUFpSDtBQUNqSCw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFFckcsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQzNDLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFFckMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDNUQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLGtCQUFrQixFQUFFLG1CQUFtQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDNUYsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBR3ZEOzs7O3FCQUlxQjtBQUNyQixNQUFNLENBQUMsTUFBTSwyQkFBMkIsR0FVbkMsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNqQixlQUFlLEVBQUUscUJBQXFCO0lBQ3RDLFNBQVMsRUFBRSxlQUFlO0lBQzFCLG9CQUFvQixFQUFFLHFCQUFxQjtJQUMzQyxXQUFXLEVBQUUsYUFBYTtJQUMxQixLQUFLLEVBQUUsT0FBTztJQUNkLDJDQUEyQztJQUMzQyxVQUFVLEVBQUUsZ0JBQWdCLEVBQUUseUVBQXlFO0lBQ3ZHLFlBQVksRUFBRSxrQkFBa0IsRUFBRSxvRUFBb0U7SUFDdEcsWUFBWSxFQUFFLGNBQWMsRUFBRSx5REFBeUQ7SUFDdkYsVUFBVSxFQUFFLFlBQVksRUFBRSxtRUFBbUU7Q0FDOUYsQ0FBQyxDQUFDO0FBRUg7bUdBQ21HO0FBQ25HLE1BQU0sQ0FBQyxNQUFNLG9DQUFvQyxHQUFtRCxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ2hILEVBQUUsRUFB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