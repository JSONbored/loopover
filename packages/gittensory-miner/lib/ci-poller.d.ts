export type CheckRunConclusion = "pending" | "success" | "failure" | "neutral";

export type NormalizedCheckRun = {
  name: string;
  status: string;
  conclusion: CheckRunConclusion;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PollCheckRunsResult = {
  conclusion: CheckRunConclusion;
  checks: NormalizedCheckRun[];
  headSha: string;
  attempts: number;
};

export type PollCheckRunsOptions = {
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  githubToken?: string;
  maxAttempts?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  sleepFn?: (delayMs: number) => Promise<unknown>;
};

export function pollCheckRuns(
  repoFullName: string,
  prNumber: number,
  options?: PollCheckRunsOptions,
): Promise<PollCheckRunsResult>;
