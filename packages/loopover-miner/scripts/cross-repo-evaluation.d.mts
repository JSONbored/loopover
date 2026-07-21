import type {
  CodingAttemptContext,
  CodingAttemptOutcome,
  CrossRepoEvaluationResult,
  CrossRepoEvaluationSummary,
  CrossRepoExecutionResult,
  ExecuteRepoAttemptOptions,
  LocalCommandResult,
  ParsedCrossRepoEvaluationManifest,
} from "../lib/cross-repo-evaluation.js";
import type { CodingAgentDriver } from "@loopover/engine";

export type CrossRepoEvaluationCliArgs =
  | {
      manifestPath: string;
      json: boolean;
      repoFilter: string | null;
      requireMajority: boolean;
      fullExecution: boolean;
    }
  | { error: string }
  | { help: true };

export type CrossRepoEvaluationCliOptions = {
  parsed?: ParsedCrossRepoEvaluationManifest;
  manifestPath?: string;
  repoFilter?: string | null;
};

export type CrossRepoExecutionCliOptions = CrossRepoEvaluationCliOptions &
  Pick<ExecuteRepoAttemptOptions, "runCodingAttempt" | "compileRepo" | "runRepoTests" | "runLocalCommand" | "env" | "maxTurns">;

export declare function resolveDefaultManifestPath(): string;

export declare function parseCrossRepoEvaluationArgs(argv?: readonly string[]): CrossRepoEvaluationCliArgs;

export declare function loadCrossRepoEvaluationManifest(manifestPath: string): ParsedCrossRepoEvaluationManifest;

export declare function runCrossRepoEvaluationCli(options?: CrossRepoEvaluationCliOptions): {
  parsed: ParsedCrossRepoEvaluationManifest;
  results: CrossRepoEvaluationResult[];
  summary: CrossRepoEvaluationSummary;
};

export declare function defaultFullExecutionCodingAttempt(
  context: CodingAttemptContext,
  deps?: { env?: NodeJS.ProcessEnv; driver?: CodingAgentDriver; spawnSync?: typeof import("node:child_process").spawnSync },
): Promise<CodingAttemptOutcome>;

export declare function runCrossRepoExecutionCli(options?: CrossRepoExecutionCliOptions): Promise<{
  parsed: ParsedCrossRepoEvaluationManifest;
  results: CrossRepoExecutionResult[];
  summary: CrossRepoEvaluationSummary;
}>;
