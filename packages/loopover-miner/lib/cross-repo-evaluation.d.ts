import type { RepoStackResult } from "./stack-detection.js";
/** Failure taxonomy surfaced in per-repo reports (#4788). The first five members are the offline
 *  readiness taxonomy; the four `EXEC_*`/plan/test/no-op members are the dry-run full-execution taxonomy
 *  (#7634) surfaced only when the `--full-execution` loop actually clones, runs the agent, and runs the
 *  target repo's own tests. New members are appended in the same frozen literal so existing members are
 *  never removed. */
export declare const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
    STACK_DETECTION: "stack_detection_gap";
    EXECUTION: "execution_gap";
    GITTENSOR_ASSUMPTION: "loopover_assumption";
    CLONE_SETUP: "clone_setup";
    OTHER: "other";
    EXEC_SETUP: "exec_setup_gap";
    PLAN_COMPILE: "plan_compile_gap";
    TEST_FAILURE: "test_failure";
    NO_OP_DIFF: "no_op_diff";
}>;
/** Instruction substrings that indicate a POSITIVE loopover/LoopOver CI assumption leaked into the agent prompt.
 *  Lines that explicitly tell the agent *not* to assume these are filtered out before scanning. */
export declare const GITTENSOR_POSITIVE_ASSUMPTION_CHECKS: ReadonlyArray<{
    id: string;
    pattern: RegExp;
}>;
export declare const DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH: string;
export declare const MAX_CROSS_REPO_MANIFEST_BYTES: number;
export declare const MAX_CROSS_REPO_MANIFEST_REPOS: number;
export type CrossRepoEvaluationManifestRepo = {
    repoFullName: string;
    stackHint?: string;
    requireTestCommand?: boolean;
    fixturePath?: string;
};
export type ParsedCrossRepoEvaluationManifest = {
    present: boolean;
    manifest: {
        repos: CrossRepoEvaluationManifestRepo[];
    };
    warnings: string[];
};
export type CrossRepoEvaluationResult = {
    repoFullName: string;
    passed: boolean;
    failureCategory: string | null;
    reason: string | null;
    stackDetected: boolean;
    usedDefaultGoalSpec: boolean | null;
    assumptionFindings: Array<{
        id: string;
        line: string;
    }>;
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
    resolveRepoPath?: (entry: {
        repoFullName: string;
    }) => string;
    env?: NodeJS.ProcessEnv;
    existsSync?: (path: string) => boolean;
    detectRepoStack?: (repoPath: string) => RepoStackResult;
    resolveMinerGoalSpec?: (repoPath: string) => {
        present: boolean;
    };
    buildCodingTaskSpec?: (input: Record<string, unknown>) => {
        ready: boolean;
        verdict?: string;
        instructions?: string;
    };
    fullExecution?: boolean;
    testTimeoutMs?: number;
    cloneRepo?: (entry: CrossRepoEvaluationManifestRepo, options: EvaluateRepoReadinessOptions) => CrossRepoExecutionCloneResult | Promise<CrossRepoExecutionCloneResult>;
    runCodingAgent?: (context: CrossRepoExecutionAgentContext) => CrossRepoExecutionAgentResult | Promise<CrossRepoExecutionAgentResult>;
    runTests?: (command: string, cwd: string, timeoutMs: number) => CrossRepoExecutionTestResult | Promise<CrossRepoExecutionTestResult>;
};
/** Canonical `owner/repo` with exactly one slash and safe segments; anything else → null. */
export declare function normalizeCrossRepoFullName(value: unknown): string | null;
/**
 * Tolerant JSON manifest parser (#4788). Malformed input degrades to an empty repo list with warnings rather than
 * throwing, mirroring the fleet-run-manifest / miner-goal-spec convention.
 */
export declare function parseCrossRepoEvaluationManifest(content: string | null | undefined): ParsedCrossRepoEvaluationManifest;
/**
 * Scan agent instructions for positive loopover/LoopOver assumptions (#4788). Lines that already tell the agent
 * *not* to assume LoopOver conventions (the negative guidance from buildValidationGuidance) are skipped.
 */
export declare function scanPositiveLoopoverAssumptions(text: string): Array<{
    id: string;
    line: string;
}>;
/**
 * Evaluate one benchmark repo's miner readiness without running a live coding agent (#4788).
 */
export declare function evaluateRepoReadiness(entry: CrossRepoEvaluationManifestRepo, options?: EvaluateRepoReadinessOptions): CrossRepoEvaluationResult;
/** 10-minute cap on a target repo's own test suite when the caller does not override `testTimeoutMs` (#7634). */
export declare const DEFAULT_EXECUTION_TEST_TIMEOUT_MS: number;
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
export declare function evaluateRepoExecution(entry: CrossRepoEvaluationManifestRepo, options?: EvaluateRepoReadinessOptions): Promise<CrossRepoEvaluationResult>;
/**
 * Run the harness across every repo in a parsed manifest (#4788).
 */
export declare function runCrossRepoEvaluation(parsed: ParsedCrossRepoEvaluationManifest, options?: {
    repoFilter?: string;
} & EvaluateRepoReadinessOptions): CrossRepoEvaluationResult[];
/**
 * DRY-RUN full-execution run across every repo in a parsed manifest (#7634). Sequential (one clone+agent+test
 * loop at a time) so the local machine is never hammered. Same options-injection surface as the readiness run,
 * plus the clone/agent/test seams. Repos are read/executed-locally-and-discarded; no PR is ever opened.
 */
export declare function runCrossRepoExecution(parsed: ParsedCrossRepoEvaluationManifest, options?: {
    repoFilter?: string;
} & EvaluateRepoReadinessOptions): Promise<CrossRepoEvaluationResult[]>;
/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 */
export declare function summarizeCrossRepoEvaluation(results: CrossRepoEvaluationResult[]): CrossRepoEvaluationSummary;
/**
 * Human-readable pass/fail report for one evaluation run (#4788).
 */
export declare function formatCrossRepoEvaluationReport(results: CrossRepoEvaluationResult[], summary?: CrossRepoEvaluationSummary): string;
export {};
