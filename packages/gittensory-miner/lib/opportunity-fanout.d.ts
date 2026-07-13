import type { ForgeConfig } from "./forge-config.js";
import type { PolicyDocCache } from "./policy-doc-cache.js";
import type { PolicyVerdictCache } from "./policy-verdict-cache.js";

export type FanoutTarget = {
  owner: string;
  repo: string;
};

/** Options shared by every fan-out entry point. `apiBaseUrl` is the legacy top-level forge-host override (it still
 * wins over `forge.apiBaseUrl`); `forge` (#4784) carries the rest of the per-tenant forge knobs. `policyDocCache`,
 * when supplied, lets discovery revalidate each repo's policy docs with a conditional GET instead of a full
 * refetch (#4842). `policyVerdictCache`, when supplied, lets discovery reuse an already-resolved verdict once its
 * deciding doc's ETag is confirmed unchanged, instead of re-resolving it (#4843). */
export type FanoutOptions = {
  apiBaseUrl?: string;
  forge?: Partial<ForgeConfig>;
  concurrency?: number;
  rateLimitLowWaterMark?: number;
  rateLimitHighWaterMark?: number;
  perPage?: number;
  maxPages?: number;
  sleepFn?: (ms: number) => Promise<unknown>;
  policyDocCache?: PolicyDocCache | null;
  policyVerdictCache?: PolicyVerdictCache | null;
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

export function mapWithConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  resolveLimit: () => number,
  sleepFn?: (ms: number) => Promise<unknown>,
): Promise<R[]>;

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
