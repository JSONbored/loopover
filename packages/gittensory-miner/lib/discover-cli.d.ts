import type {
  CandidateIssueWarning,
  FanoutTarget,
  RawCandidateIssue,
} from "./opportunity-fanout.js";
import type { RankedCandidateIssue, RankedCandidateSummary } from "./opportunity-ranker.js";
import type { EnqueueRankedDiscoverySummary } from "./portfolio-discovery.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";

export type ParsedDiscoverArgs =
  | {
      targets: FanoutTarget[];
      search: string | null;
      json: boolean;
    }
  | { error: string };

/** The subset of `CandidateIssueSummary` runDiscover actually reads, so callers may inject a fake without
 * fabricating rate-limit telemetry it never touches. A real `fetchCandidateIssuesWithSummary` result satisfies
 * this too, since it is a strict superset. */
export type DiscoverFanOutSummary = {
  issues: RawCandidateIssue[];
  warnings: CandidateIssueWarning[];
};

/** The subset of a ranked entry that `renderDiscoverSummary` reads for its top-candidates listing. */
export type DiscoverRankedEntry = Pick<RankedCandidateIssue, "repoFullName" | "issueNumber" | "title" | "rankScore">;

export type DiscoverResult = {
  fanOutCount: number;
  warnings: CandidateIssueWarning[];
  ranked: DiscoverRankedEntry[];
  enqueueSummary: EnqueueRankedDiscoverySummary;
};

export type RunDiscoverOptions = {
  githubToken?: string;
  apiBaseUrl?: string;
  nowMs?: number;
  initPortfolioQueue?: () => PortfolioQueueStore;
  fetchCandidateIssuesWithSummary?: (
    targets: FanoutTarget[],
    githubToken: string,
    options?: { apiBaseUrl?: string },
  ) => Promise<DiscoverFanOutSummary>;
  searchCandidateIssuesWithSummary?: (
    searchQuery: string,
    githubToken: string,
    options?: { apiBaseUrl?: string },
  ) => Promise<DiscoverFanOutSummary>;
  rankCandidateIssuesWithSummary?: (
    candidates: RawCandidateIssue[],
    options?: { nowMs?: number },
  ) => RankedCandidateSummary;
  enqueueRankedDiscovery?: (
    rankedIssues: RankedCandidateIssue[],
    options: { queueStore: PortfolioQueueStore },
  ) => EnqueueRankedDiscoverySummary;
};

export function parseDiscoverArgs(args: string[]): ParsedDiscoverArgs;

export function sanitizeDiscoverDisplayText(value: unknown): string;

export function renderDiscoverSummary(result: DiscoverResult): string;

export function runDiscover(args: string[], options?: RunDiscoverOptions): Promise<number>;
