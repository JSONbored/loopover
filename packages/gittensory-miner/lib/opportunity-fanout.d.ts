export type FanoutTarget = {
  owner: string;
  repo: string;
};

export function nextPageUrl(linkHeader: unknown): string | null;

export type RawCandidateIssue = {
  owner: string;
  repo: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: string[];
  commentsCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  htmlUrl: string | null;
  aiPolicyAllowed: true;
  aiPolicySource: "AI-USAGE.md" | "CONTRIBUTING.md" | "none";
};

export type CandidateIssueWarning = {
  repoFullName: string;
  stage: string;
  message: string;
};

export type CandidateIssueSummary = {
  issues: RawCandidateIssue[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  warnings: CandidateIssueWarning[];
};

export function fetchCandidateIssuesWithSummary(
  targets: FanoutTarget[],
  githubToken: string,
  options?: {
    apiBaseUrl?: string;
    concurrency?: number;
    perPage?: number;
    maxPages?: number;
    sleepFn?: (ms: number) => Promise<unknown>;
  },
): Promise<CandidateIssueSummary>;

export function fetchCandidateIssues(
  targets: FanoutTarget[],
  githubToken: string,
  options?: {
    apiBaseUrl?: string;
    concurrency?: number;
    perPage?: number;
    maxPages?: number;
    sleepFn?: (ms: number) => Promise<unknown>;
  },
): Promise<RawCandidateIssue[]>;

export function searchCandidateIssuesWithSummary(
  searchQuery: string,
  githubToken: string,
  options?: {
    apiBaseUrl?: string;
    concurrency?: number;
    perPage?: number;
    maxPages?: number;
    sleepFn?: (ms: number) => Promise<unknown>;
  },
): Promise<CandidateIssueSummary>;

export function searchCandidateIssues(
  searchQuery: string,
  githubToken: string,
  options?: {
    apiBaseUrl?: string;
    concurrency?: number;
    perPage?: number;
    maxPages?: number;
    sleepFn?: (ms: number) => Promise<unknown>;
  },
): Promise<RawCandidateIssue[]>;
