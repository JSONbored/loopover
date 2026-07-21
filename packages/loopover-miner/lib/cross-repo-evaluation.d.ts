import type { RepoStackResult } from "./stack-detection.js";
/** Failure taxonomy surfaced in per-repo reports. Readiness-mode categories (#4788) plus the full-execution
 *  categories (#7634) that classify how a live discover → plan → code → test attempt fell short. */
export declare const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
    STACK_DETECTION: "stack_detection_gap";
    EXECUTION: "execution_gap";
    GITTENSOR_ASSUMPTION: "loopover_assumption";
    CLONE_SETUP: "clone_setup";
    EXECUTION_NO_DIFF: "execution_no_diff";
    EXECUTION_COMPILE: "execution_compile_gap";
    EXECUTION_TEST: "execution_test_failure";
    EXECUTION_NOOP: "execution_noop_diff";
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
    /** Opt this entry into full-execution mode (#7634): `--full-execution` runs the live attempt against every
     *  entry flagged `true` (a `--repo` filter overrides the flag and runs that one entry regardless). */
    fullExecution?: boolean;
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
    };
};
/** Result of running a local shell command (build/test) during a full-execution attempt (#7634). */
export type LocalCommandResult = {
    ok: boolean;
    /** True when there was no command to run (e.g. the stack inferred no build command) — treated as a pass. */
    skipped?: boolean;
    code?: number | null;
    output?: string;
};
/** Everything a coding-agent executor needs to run one benchmark repo's live attempt (#7634). */
export type CodingAttemptContext = {
    repoFullName: string;
    repoPath: string;
    stack: RepoStackResult;
    instructions: string;
    attemptId: string;
    maxTurns: number;
};
/** What a coding-agent executor reports back: the real unified diff it produced (empty string when it made no
 *  change), plus whether the agent itself considered the run successful (#7634). */
export type CodingAttemptOutcome = {
    ok: boolean;
    diff: string;
    summary?: string;
    error?: string;
};
export type ExecuteRepoAttemptOptions = EvaluateRepoReadinessOptions & {
    /** Discover → plan → code step: run the coding agent against the clone and return its diff. The CLI injects a
     *  real driver-backed executor; unit tests inject a fake. Left unset, the harness reports `execution_no_diff`
     *  rather than pretending an agent ran. */
    runCodingAttempt?: (context: CodingAttemptContext) => CodingAttemptOutcome | Promise<CodingAttemptOutcome>;
    /** Build/compile the clone after the diff is applied. Defaults to running `stack.buildCommand` locally. */
    compileRepo?: (context: {
        repoPath: string;
        stack: RepoStackResult;
    }) => LocalCommandResult | Promise<LocalCommandResult>;
    /** Run the target repo's own test suite locally. Defaults to running `stack.testCommand`. */
    runRepoTests?: (context: {
        repoPath: string;
        stack: RepoStackResult;
    }) => LocalCommandResult | Promise<LocalCommandResult>;
    /** Shared spawn used by the default compile/test runners; defaults to a real `spawnSync` in the clone dir. */
    runLocalCommand?: (command: string, context: {
        cwd: string;
        env?: NodeJS.ProcessEnv;
    }) => LocalCommandResult;
    /** Turn budget handed to the coding agent (CLI default: 30). */
    maxTurns?: number;
};
export type CrossRepoExecutionResult = CrossRepoEvaluationResult & {
    /** False when the attempt never reached the live agent (readiness gated it out). */
    executed: boolean;
    compilePassed?: boolean | null;
    testsPassed?: boolean | null;
    /** Character length of the produced diff (0 for a no-op); null when no agent ran. */
    diffChars?: number | null;
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
export declare function executeRepoAttempt(entry: CrossRepoEvaluationManifestRepo, options?: ExecuteRepoAttemptOptions): Promise<CrossRepoExecutionResult>;
/**
 * Run the full-execution harness across a parsed manifest (#7634). Without a `repoFilter`, only entries flagged
 * `fullExecution: true` run (the curated subset); a `repoFilter` overrides the flag and runs that one entry.
 */
export declare function runCrossRepoExecution(parsed: ParsedCrossRepoEvaluationManifest, options?: {
    repoFilter?: string;
} & ExecuteRepoAttemptOptions): Promise<CrossRepoExecutionResult[]>;
/**
 * Reduce per-repo results to pass/fail counts and whether a strict majority passed (#4788).
 */
export declare function summarizeCrossRepoEvaluation(results: CrossRepoEvaluationResult[]): CrossRepoEvaluationSummary;
/**
 * Human-readable pass/fail report for one evaluation run (#4788).
 */
export declare function formatCrossRepoEvaluationReport(results: CrossRepoEvaluationResult[], summary?: CrossRepoEvaluationSummary): string;
export {};
