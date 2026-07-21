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
        acceptanceCriteriaPath?: string;
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
/** Execution-specific failure taxonomy (#7634), extending — not replacing — CROSS_REPO_FAILURE_CATEGORY. */
export declare const CROSS_REPO_EXECUTION_FAILURE_CATEGORY: Readonly<{
    AGENT_RUN: "agent_run_failed";
    NOOP_DIFF: "noop_diff";
    BUILD: "build_failed";
    TEST: "test_failed";
}>;
/** A benchmark attempt works a small synthetic issue, so a modest turn cap keeps dry-runs bounded without
 *  starving a real agent; callers tune via options.maxTurns. */
export declare const DEFAULT_CROSS_REPO_EXECUTION_MAX_TURNS: number;
/** Per-command (build, then test) wall-clock cap — generous enough for a cold dependency install on the larger
 *  benchmark repos, small enough that a hung suite cannot wedge the whole run. */
export declare const DEFAULT_CROSS_REPO_EXECUTION_COMMAND_TIMEOUT_MS: number;
export type CrossRepoExecutionCommandResult = {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
};
export type CrossRepoExecutionRunCommandFn = (command: string, options: {
    cwd: string;
    timeoutMs: number;
}) => Promise<CrossRepoExecutionCommandResult>;
export type CrossRepoExecutionWorkspace = {
    path: string;
    cleanup: () => void;
};
/** Structural mirror of the engine's CodingAgentDriver contract — kept local so this module only loads the real
 *  driver construction (and its engine dependency) lazily, on the one path that actually runs an agent. */
export type CrossRepoExecutionDriver = {
    run(task: {
        attemptId: string;
        workingDirectory: string;
        acceptanceCriteriaPath: string;
        instructions: string;
        maxTurns: number;
    }): Promise<{
        ok: boolean;
        changedFiles: readonly string[];
        summary: string;
        error?: string | undefined;
    }>;
};
export type CrossRepoExecutionDetails = {
    attempted: boolean;
    changedFileCount: number | null;
    buildRan: boolean;
    testRan: boolean;
};
export type CrossRepoExecutionEvaluationResult = CrossRepoEvaluationResult & {
    execution: CrossRepoExecutionDetails | null;
};
export type EvaluateRepoExecutionOptions = EvaluateRepoReadinessOptions & {
    driver?: CrossRepoExecutionDriver;
    prepareExecutionWorkspace?: (repoPath: string) => CrossRepoExecutionWorkspace;
    runCommand?: CrossRepoExecutionRunCommandFn;
    maxTurns?: number;
    commandTimeoutMs?: number;
};
/** Copy the benchmark clone into a discardable temp tree — the agent and the repo's test suite only ever touch
 *  the copy, so the clone stays pristine and cleanup is a single recursive remove. */
export declare function defaultPrepareExecutionWorkspace(repoPath: string): CrossRepoExecutionWorkspace;
/** Command runner for the stack's inferred build/test commands. detectRepoStack only ever emits simple
 *  `tool subcommand` forms ("npm test", "cargo build", "npm run build"), so the command is tokenized on
 *  whitespace and exec'd DIRECTLY -- deliberately no `shell: true`, so nothing in a benchmark repo's manifest
 *  can smuggle shell metacharacters into an interpreted shell line. Mirrors coding-agent-construction's
 *  createRealCliSubprocessSpawn otherwise: capture both streams and RESOLVE (never reject) on timeout or spawn
 *  error, so partial output stays diagnosable. Promise resolution is idempotent, so a `close` firing after the
 *  timeout already resolved needs no guard. */
export declare function createDefaultCrossRepoExecutionRunCommand(): CrossRepoExecutionRunCommandFn;
/**
 * Run the full discover -> plan -> code -> test loop for one benchmark repo, dry-run (#7634). Readiness gates
 * first (its failures pass through unchanged); execution then happens entirely inside a scratch copy that is
 * discarded in every outcome.
 */
export declare function evaluateRepoExecution(entry: CrossRepoEvaluationManifestRepo, options?: EvaluateRepoExecutionOptions): Promise<CrossRepoExecutionEvaluationResult>;
/**
 * Run full-execution mode across every repo in a parsed manifest (#7634), sequentially — agent runs and test
 * suites are heavyweight, so no parallel fan-out.
 */
export declare function runCrossRepoFullExecution(parsed: ParsedCrossRepoEvaluationManifest, options?: {
    repoFilter?: string;
} & EvaluateRepoExecutionOptions): Promise<CrossRepoExecutionEvaluationResult[]>;
export {};
