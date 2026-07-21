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
/** One shared thrown-value formatter so every catch in both harness modes carries the same two branches. */
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
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
/** The synthetic-issue spec input both harness modes hand to buildCodingTaskSpec — readiness composes it against
 *  the benchmark clone, full-execution mode against the scratch workspace copy (#7634), so the acceptance-criteria
 *  file buildCodingTaskSpec writes lands inside whichever tree the caller is actually working in. */
function buildHarnessSpecInput(repoFullName, workingDirectory, detectImpl) {
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
        specResult = buildSpecImpl(buildHarnessSpecInput(repoFullName, repoPath, detectImpl));
    }
    catch (error) {
        return buildFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, describeError(error), {
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
// ---------------------------------------------------------------------------------------------------------------
// Full-execution mode (#7634): past readiness, actually run the discover -> plan -> code -> test loop against a
// benchmark repo — dry-run only. The attempt runs inside a scratch COPY of the local clone that is discarded
// afterward: no live PR submission, no forge API calls, and the benchmark clone itself is never mutated by the
// agent or the test run. Same taxonomy extension point as the readiness categories above — summarize/format are
// data-driven over category strings, so these flow through the existing report unchanged.
/** Execution-specific failure taxonomy (#7634), extending — not replacing — CROSS_REPO_FAILURE_CATEGORY. */
export const CROSS_REPO_EXECUTION_FAILURE_CATEGORY = Object.freeze({
    AGENT_RUN: "agent_run_failed",
    NOOP_DIFF: "noop_diff",
    BUILD: "build_failed",
    TEST: "test_failed",
});
/** A benchmark attempt works a small synthetic issue, so a modest turn cap keeps dry-runs bounded without
 *  starving a real agent; callers tune via options.maxTurns. */
export const DEFAULT_CROSS_REPO_EXECUTION_MAX_TURNS = 24;
/** Per-command (build, then test) wall-clock cap — generous enough for a cold dependency install on the larger
 *  benchmark repos, small enough that a hung suite cannot wedge the whole run. */
export const DEFAULT_CROSS_REPO_EXECUTION_COMMAND_TIMEOUT_MS = 600_000;
/** Copy the benchmark clone into a discardable temp tree — the agent and the repo's test suite only ever touch
 *  the copy, so the clone stays pristine and cleanup is a single recursive remove. */
export function defaultPrepareExecutionWorkspace(repoPath) {
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
export function createDefaultCrossRepoExecutionRunCommand() {
    return (command, options) => new Promise((resolve) => {
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
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ stdout, stderr: err.message, code: null, timedOut: false });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code, timedOut: false });
        });
    });
}
function buildExecutionFailure(repoFullName, category, reason, base, execution) {
    return { ...buildFailure(repoFullName, category, reason, base), execution };
}
/**
 * Run the full discover -> plan -> code -> test loop for one benchmark repo, dry-run (#7634). Readiness gates
 * first (its failures pass through unchanged); execution then happens entirely inside a scratch copy that is
 * discarded in every outcome.
 */
export async function evaluateRepoExecution(entry, options = {}) {
    const readiness = evaluateRepoReadiness(entry, options);
    if (!readiness.passed)
        return { ...readiness, execution: null };
    const prepareWorkspace = options.prepareExecutionWorkspace ?? defaultPrepareExecutionWorkspace;
    let workspace;
    try {
        workspace = prepareWorkspace(resolveEvaluationRepoPath(entry, options));
    }
    catch (error) {
        const reason = `Failed to prepare a scratch execution workspace: ${describeError(error)}`;
        // A passed readiness result always carries its detected stack (buildPass is invoked with it).
        const base = { stackDetected: true, usedDefaultGoalSpec: readiness.usedDefaultGoalSpec, stack: readiness.stack };
        return buildExecutionFailure(readiness.repoFullName, CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP, reason, base, null);
    }
    try {
        return await runExecutionPhases(readiness, workspace, options);
    }
    finally {
        try {
            workspace.cleanup();
        }
        catch {
            // Best-effort discard — a cleanup failure must never mask the evaluation outcome itself.
        }
    }
}
async function runExecutionPhases(readiness, workspace, options) {
    const repoFullName = readiness.repoFullName;
    // Readiness passed, so the stack is present and detected — narrow once instead of re-branching on it.
    const stack = readiness.stack;
    const usedDefaultGoalSpec = readiness.usedDefaultGoalSpec;
    const failureBase = { stackDetected: true, usedDefaultGoalSpec, stack };
    const detectImpl = options.detectRepoStack ?? detectRepoStack;
    const buildSpecImpl = options.buildCodingTaskSpec ??
        buildCodingTaskSpec;
    // Re-compose the coding-task spec INSIDE the scratch copy: buildCodingTaskSpec writes the acceptance-criteria
    // document into its workingDirectory, and the agent must find it (and work) in the tree it is allowed to touch.
    // The readiness pass already wrote that document into the clone (pre-existing #4788 behavior), so the copy
    // inherits it -- and writeAcceptanceCriteriaFile opens O_EXCL (never overwrites), so clear the inherited file
    // first. The scratch tree is ours to mutate; the clone itself stays untouched.
    rmSync(join(workspace.path, ACCEPTANCE_CRITERIA_FILENAME), { force: true });
    let specResult;
    try {
        specResult = buildSpecImpl(buildHarnessSpecInput(repoFullName, workspace.path, detectImpl));
    }
    catch (error) {
        return buildExecutionFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.OTHER, `Coding task spec failed inside the scratch workspace: ${describeError(error)}`, failureBase, null);
    }
    if (specResult?.ready !== true) {
        return buildExecutionFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, `Coding task spec is not ready inside the scratch workspace (verdict: ${specResult?.verdict ?? "unknown"}).`, failureBase, null);
    }
    let driver = options.driver;
    if (!driver) {
        try {
            // Lazy so the readiness-only path (and its consumers) never load the engine-backed driver construction.
            const { constructProductionCodingAgentDriver } = await import("./coding-agent-construction.js");
            driver = constructProductionCodingAgentDriver(options.env ?? process.env);
        }
        catch (error) {
            return buildExecutionFailure(repoFullName, CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN, `No runnable coding-agent driver: ${describeError(error)}`, failureBase, { attempted: false, changedFileCount: null, buildRan: false, testRan: false });
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
    }
    catch (error) {
        return buildExecutionFailure(repoFullName, CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN, `Coding agent run threw: ${describeError(error)}`, failureBase, { attempted: true, changedFileCount: null, buildRan: false, testRan: false });
    }
    if (agentResult?.ok !== true) {
        return buildExecutionFailure(repoFullName, CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN, `Coding agent run did not succeed: ${agentResult?.error ?? agentResult?.summary ?? "no failure detail reported"}`, failureBase, { attempted: true, changedFileCount: null, buildRan: false, testRan: false });
    }
    const changedFileCount = Array.isArray(agentResult.changedFiles) ? agentResult.changedFiles.length : 0;
    if (changedFileCount === 0) {
        return buildExecutionFailure(repoFullName, CROSS_REPO_EXECUTION_FAILURE_CATEGORY.NOOP_DIFF, "Coding agent reported success but the generated diff is a no-op (no files changed).", failureBase, { attempted: true, changedFileCount: 0, buildRan: false, testRan: false });
    }
    const runCommand = options.runCommand ?? createDefaultCrossRepoExecutionRunCommand();
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_CROSS_REPO_EXECUTION_COMMAND_TIMEOUT_MS;
    let buildRan = false;
    if (stack.buildCommand) {
        buildRan = true;
        const buildResult = await runCommand(stack.buildCommand, { cwd: workspace.path, timeoutMs: commandTimeoutMs });
        if (buildResult.timedOut || buildResult.code !== 0) {
            return buildExecutionFailure(repoFullName, CROSS_REPO_EXECUTION_FAILURE_CATEGORY.BUILD, `Diff generated but the build ${buildResult.timedOut ? "timed out" : `failed (exit ${buildResult.code})`}: ${stack.buildCommand}`, failureBase, { attempted: true, changedFileCount, buildRan: true, testRan: false });
        }
    }
    if (!stack.testCommand) {
        return buildExecutionFailure(repoFullName, CROSS_REPO_FAILURE_CATEGORY.EXECUTION, "Stack detection inferred no test command, so the generated diff cannot be validated in execution mode.", failureBase, { attempted: true, changedFileCount, buildRan, testRan: false });
    }
    const testResult = await runCommand(stack.testCommand, { cwd: workspace.path, timeoutMs: commandTimeoutMs });
    if (testResult.timedOut || testResult.code !== 0) {
        return buildExecutionFailure(repoFullName, CROSS_REPO_EXECUTION_FAILURE_CATEGORY.TEST, `Diff generated but the repo's own test suite ${testResult.timedOut ? "timed out" : `failed (exit ${testResult.code})`}: ${stack.testCommand}`, failureBase, { attempted: true, changedFileCount, buildRan, testRan: true });
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
export async function runCrossRepoFullExecution(parsed, options = {}) {
    const repos = parsed?.manifest?.repos ?? [];
    const results = [];
    for (const entry of repos) {
        if (options.repoFilter && entry.repoFullName !== options.repoFilter)
            continue;
        results.push(await evaluateRepoExecution(entry, options));
    }
    return results;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY3Jvc3MtcmVwby1ldmFsdWF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLGlIQUFpSDtBQUNqSCw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFFckcsT0FBTyxFQUFFLEtBQUssSUFBSSxTQUFTLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUN4RCxPQUFPLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsTUFBTSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xFLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDakMsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUNqQyw0R0FBNEc7QUFDNUcsT0FBTyxFQUFFLDRCQUE0QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDaEUsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDNUQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLG1CQUFtQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDMUUsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBR3ZELDZEQUE2RDtBQUM3RCxNQUFNLENBQUMsTUFBTSwyQkFBMkIsR0FNbkMsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNqQixlQUFlLEVBQUUscUJBQXFCO0lBQ3RDLFNBQVMsRUFBRSxlQUFlO0lBQzFCLG9CQUFvQixFQUFFLHFCQUFxQjtJQUMzQyxXQUFXLEVBQUUsYUFBYTtJQUMxQixLQUFLLEVBQUUsT0FBTztDQUNmLENBQUMsQ0FBQztBQUVIO21HQUNtRztBQUNuRyxNQUFNLENBQUMsTUFBTSxvQ0FBb0MsR0FBbUQsTUFBTSxDQUFDLE1BQU0sQ0FB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