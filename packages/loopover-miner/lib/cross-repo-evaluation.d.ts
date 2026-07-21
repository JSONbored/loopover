import type { RepoStackResult } from "./stack-detection.js";
/** Failure taxonomy surfaced in per-repo reports (#4788). */
export declare const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
    STACK_DETECTION: "stack_detection_gap";
    EXECUTION: "execution_gap";
    GITTENSOR_ASSUMPTION: "loopover_assumption";
    CLONE_SETUP: "clone_setup";
    OTHER: "other";
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
};
export type CrossRepoEvaluationSummary = {
    total: number;
    passed: number;
    failed: number;
    majorityPassed: boolean;
    withoutLoopoverConfig: number;
    failuresByCategory: Record<string, number>;
};
export type EvaluateRepoReadinessOptions = {
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
/**
 * Run the harness across every repo in a parsed manifest (#4788).
 */
export declare function runCrossRepoEvaluation(parsed: ParsedCrossRepoEvaluationManifest, options?: {
    repoFilter?: string;
} & EvaluateRepoReadinessOptions): CrossRepoEvaluationResult[];
/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 */
export declare function summarizeCrossRepoEvaluation(results: CrossRepoEvaluationResult[]): CrossRepoEvaluationSummary;
/**
 * Human-readable pass/fail report for one evaluation run (#4788).
 */
export declare function formatCrossRepoEvaluationReport(results: CrossRepoEvaluationResult[], summary?: CrossRepoEvaluationSummary): string;
/** Execution-stage failure taxonomy (#7634): extends the readiness taxonomy for the code + test loop. Ordered by
 *  pipeline stage, so a repo that fails an earlier stage is reported against that stage. */
export declare const CROSS_REPO_EXECUTION_CATEGORY: Readonly<{
    PLAN_NOT_FORMED: "plan_not_formed";
    CODE_BUILD_FAILED: "code_build_failed";
    TESTS_FAILED: "tests_failed";
    NO_OP_DIFF: "no_op_diff";
    CLONE_SETUP: "clone_setup";
    OTHER: "other";
}>;
export type CrossRepoExecutionResult = {
    repoFullName: string;
    passed: boolean;
    executionCategory: string | null;
    reason: string | null;
    readinessPassed: boolean;
    diffPresent: boolean | null;
    built: boolean | null;
    testsPassed: boolean | null;
    stack?: RepoStackResult | undefined;
};
export type CrossRepoExecutionSummary = {
    total: number;
    passed: number;
    failed: number;
    majorityPassed: boolean;
    failuresByCategory: Record<string, number>;
};
/** Injectable local-execution seams (#7634). Real implementations (child_process build/test, the coding-agent
 *  driver) are wired by the CLI; unit tests inject fakes. Every seam is dry-run: it operates on the local clone
 *  only, and the harness never pushes or opens a PR. */
export type CrossRepoExecutionSeams = {
    runAgentAttempt?: (context: {
        repoFullName: string;
        repoPath: string;
        stack: RepoStackResult;
    }) => Promise<{
        diff: string;
    }>;
    buildRepo?: (context: {
        repoPath: string;
        command: string;
    }) => Promise<{
        ok: boolean;
        detail?: string;
    }>;
    runRepoTests?: (context: {
        repoPath: string;
        command: string;
    }) => Promise<{
        ok: boolean;
        detail?: string;
    }>;
};
export type EvaluateRepoFullExecutionOptions = EvaluateRepoReadinessOptions & CrossRepoExecutionSeams;
/**
 * Run the full discover -> plan -> code -> test loop for one benchmark repo in dry-run (#7634). Reuses
 * evaluateRepoReadiness for the plan stage, then delegates the code + build + test steps to injectable seams so the
 * orchestration + taxonomy stay unit-testable without a live coding agent. Never pushes or opens a PR.
 */
export declare function evaluateRepoFullExecution(entry: CrossRepoEvaluationManifestRepo, options?: EvaluateRepoFullExecutionOptions): Promise<CrossRepoExecutionResult>;
/** Run full-execution across every repo in a parsed manifest (#7634). Async: each repo runs the real code+test loop. */
export declare function runFullCrossRepoExecution(parsed: ParsedCrossRepoEvaluationManifest, options?: {
    repoFilter?: string;
} & EvaluateRepoFullExecutionOptions): Promise<CrossRepoExecutionResult[]>;
/** Reduce full-execution results to pass/fail counts + a strict-majority verdict (#7634). */
export declare function summarizeCrossRepoExecution(results: CrossRepoExecutionResult[]): CrossRepoExecutionSummary;
/** Human-readable full-execution report (#7634), mirroring formatCrossRepoEvaluationReport's shape. */
export declare function formatCrossRepoExecutionReport(results: CrossRepoExecutionResult[], summary?: CrossRepoExecutionSummary): string;
