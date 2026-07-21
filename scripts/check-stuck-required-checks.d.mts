export type GithubApi = (
  path: string,
  options?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<unknown>;

export type PullRequestRef = {
  number: number;
  draft?: boolean;
  head: { sha: string };
};

export type StuckCheck = {
  name: string;
  status: string;
  startedAt: string;
  elapsedMinutes: number;
  htmlUrl?: string;
};

export type CommentScope = {
  githubApi: GithubApi;
  owner: string;
  repoName: string;
};

export type FindStuckOptions = CommentScope & { thresholdMinutes: number };

export declare const MARKER: string;
export declare const REQUIRED_CONTEXTS: Set<string>;
export declare const EXTERNAL_REQUIRED_CHECKS: Set<string>;

export declare function minutesSince(isoString: string): number;

export declare function findStuckChecksForPr(
  pr: PullRequestRef,
  requiredContexts: Set<string>,
  options: FindStuckOptions,
): Promise<StuckCheck[]>;

export declare function hasExistingWatchdogComment(
  prNumber: number,
  options: CommentScope,
): Promise<boolean>;

export declare function runStuckCheckWatchdog(options: {
  githubApi: GithubApi;
  owner: string;
  repoName: string;
  thresholdMinutes: number;
  dryRun?: boolean;
  requiredContexts?: Set<string>;
  log?: (message: string) => void;
}): Promise<number>;
