import type { ForgeConfig } from "./forge-config.js";

export type FanoutTarget = {
  owner: string;
  repo: string;
};

/** Options shared by every fan-out entry point. `apiBaseUrl` is the legacy top-level forge-host override (it still
 * wins over `forge.apiBaseUrl`); `forge` (#4784) carries the rest of the per-tenant forge knobs. */
export type FanoutOptions = {
  apiBaseUrl?: string;
  forge?: Partial<ForgeConfig>;
  concurrency?: number;
  perPage?: number;
  maxPages?: number;
  sleepFn?: (ms: number) => Promise<unknown>;
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
