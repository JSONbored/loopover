import type {
  AiAttributedPullRequestMetadata,
  AiPolicyFatigueSignal,
} from "@jsonbored/gittensory-engine";

export type FanoutTarget = {
  owner: string;
  repo: string;
};

export type FanoutOptions = {
  apiBaseUrl?: string;
  concurrency?: number;
  perPage?: number;
  nowMs?: number;
  closedPullRequestsByRepo?: Record<string, readonly AiAttributedPullRequestMetadata[]>;
  previousContributingByRepo?: Record<string, string | null>;
  contributingObservedAtByRepo?: Record<string, string | null>;
};

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
  aiPolicyFatigue: AiPolicyFatigueSignal;
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
  options?: FanoutOptions,
): Promise<CandidateIssueSummary>;

export function fetchCandidateIssues(
  targets: FanoutTarget[],
  githubToken: string,
  options?: FanoutOptions,
): Promise<RawCandidateIssue[]>;

export function searchCandidateIssuesWithSummary(
  searchQuery: string,
  githubToken: string,
  options?: FanoutOptions,
): Promise<CandidateIssueSummary>;

export function searchCandidateIssues(
  searchQuery: string,
  githubToken: string,
  options?: FanoutOptions,
): Promise<RawCandidateIssue[]>;
