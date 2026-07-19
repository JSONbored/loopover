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
export {};
