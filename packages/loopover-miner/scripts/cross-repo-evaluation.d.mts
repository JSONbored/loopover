import type {
  CrossRepoEvaluationResult,
  CrossRepoEvaluationSummary,
  CrossRepoExecutionResult,
  CrossRepoExecutionSummary,
  EvaluateRepoFullExecutionOptions,
  ParsedCrossRepoEvaluationManifest,
} from "../lib/cross-repo-evaluation.js";

export type CrossRepoEvaluationCliArgs =
  | { manifestPath: string; json: boolean; repoFilter: string | null; requireMajority: boolean; fullExecution: boolean }
  | { error: string }
  | { help: true };

export type CrossRepoEvaluationCliOptions = {
  parsed?: ParsedCrossRepoEvaluationManifest;
  manifestPath?: string;
  repoFilter?: string | null;
};

/** Options for the dry-run full-execution CLI (#7634): the readiness options plus the injectable execution seams
 *  (all optional — the CLI supplies real defaults) and the process env. */
export type CrossRepoFullExecutionCliOptions = CrossRepoEvaluationCliOptions &
  Partial<EvaluateRepoFullExecutionOptions> & { env?: NodeJS.ProcessEnv };

export declare function resolveDefaultManifestPath(): string;

export declare function parseCrossRepoEvaluationArgs(argv?: readonly string[]): CrossRepoEvaluationCliArgs;

export declare function loadCrossRepoEvaluationManifest(manifestPath: string): ParsedCrossRepoEvaluationManifest;

export declare function runCrossRepoEvaluationCli(options?: CrossRepoEvaluationCliOptions): {
  parsed: ParsedCrossRepoEvaluationManifest;
  results: CrossRepoEvaluationResult[];
  summary: CrossRepoEvaluationSummary;
};

export declare function runFullCrossRepoExecutionCli(options?: CrossRepoFullExecutionCliOptions): Promise<{
  parsed: ParsedCrossRepoEvaluationManifest;
  results: CrossRepoExecutionResult[];
  summary: CrossRepoExecutionSummary;
}>;
