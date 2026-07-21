import type {
  CrossRepoEvaluationManifestRepo,
  CrossRepoEvaluationResult,
  CrossRepoEvaluationSummary,
  CrossRepoExecutionAgentContext,
  CrossRepoExecutionAgentResult,
  CrossRepoExecutionCloneResult,
  CrossRepoExecutionTestResult,
  ParsedCrossRepoEvaluationManifest,
} from "../lib/cross-repo-evaluation.js";

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

/** Full-execution (dry-run) CLI options (#7634): the readiness options plus the injectable clone/agent/test seams
 *  that unit tests replace with fakes for zero real IO. */
export type CrossRepoExecutionCliOptions = CrossRepoEvaluationCliOptions & {
  fullExecution?: boolean;
  testTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  existsSync?: (path: string) => boolean;
  buildCodingTaskSpec?: (input: Record<string, unknown>) => {
    ready: boolean;
    verdict?: string;
    instructions?: string;
  };
  cloneRepo?: (
    entry: CrossRepoEvaluationManifestRepo,
    options: CrossRepoExecutionCliOptions,
  ) => CrossRepoExecutionCloneResult | Promise<CrossRepoExecutionCloneResult>;
  runCodingAgent?: (
    context: CrossRepoExecutionAgentContext,
  ) => CrossRepoExecutionAgentResult | Promise<CrossRepoExecutionAgentResult>;
  runTests?: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => CrossRepoExecutionTestResult | Promise<CrossRepoExecutionTestResult>;
};

export declare function resolveDefaultManifestPath(): string;

export declare function parseCrossRepoEvaluationArgs(argv?: readonly string[]): CrossRepoEvaluationCliArgs;

export declare function loadCrossRepoEvaluationManifest(manifestPath: string): ParsedCrossRepoEvaluationManifest;

export declare function runCrossRepoEvaluationCli(options?: CrossRepoEvaluationCliOptions): {
  parsed: ParsedCrossRepoEvaluationManifest;
  results: CrossRepoEvaluationResult[];
  summary: CrossRepoEvaluationSummary;
};

/** DRY-RUN full-execution driver (#7634): clones each benchmark repo locally, runs the discover->plan->code->test
 *  loop, and runs the target repo's own tests. Async; never opens a PR. */
export declare function runCrossRepoExecutionCli(options?: CrossRepoExecutionCliOptions): Promise<{
  parsed: ParsedCrossRepoEvaluationManifest;
  results: CrossRepoEvaluationResult[];
  summary: CrossRepoEvaluationSummary;
}>;
