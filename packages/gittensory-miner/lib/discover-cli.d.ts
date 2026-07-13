import type { ForgeConfig } from "./forge-config.js";
import type {
  CandidateIssueWarning,
  FanoutOptions,
  FanoutTarget,
  RawCandidateIssue,
} from "./opportunity-fanout.js";
import type {
  RankCandidateIssuesOptions,
  RankedCandidateIssue,
  RankedCandidateSummary,
} from "./opportunity-ranker.js";
import type { PolicyDocCacheStore } from "./policy-doc-cache.js";
import type { PolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import type { EnqueueRankedDiscoverySummary } from "./portfolio-discovery.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";

export type ParsedDiscoverArgs =
  | {
      targets: FanoutTarget[];
      search: string | null;
      json: boolean;
      /** Present only when `--api-base-url` is supplied (#4784); threads the tenant's forge host to the fan-out. */
      apiBaseUrl?: string;
      /** Present only when `--token-env` is supplied (#4784); names the credential env var to read. */
      tokenEnv?: string;
    }
  | { error: string };

/** The subset of `CandidateIssueSummary` runDiscover actually reads. It surfaces the rate-limit telemetry (#4837),
 * so a fake must supply it. A real `fetchCandidateIssuesWithSummary` result satisfies this, since it is a superset. */
export type DiscoverFanOutSummary = {
  issues: RawCandidateIssue[];
  warnings: CandidateIssueWarning[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
};

/** The subset of a ranked entry that `renderDiscoverSummary` reads for its top-candidates listing. */
export type DiscoverRankedEntry = Pick<RankedCandidateIssue, "repoFullName" | "issueNumber" | "title" | "rankScore">;

export type DiscoverResult = {
  fanOutCount: number;
  warnings: CandidateIssueWarning[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  ranked: DiscoverRankedEntry[];
  /** True when ranking fell back to the built-in default goal spec because no per-tenant spec was supplied (#4784). */
  usedDefaultGoalSpec?: boolean;
  enqueueSummary: EnqueueRankedDiscoverySummary;
};

export type RunDiscoverOptions = {
  githubToken?: string;
  apiBaseUrl?: string;
  /** Per-tenant credential env var name (#4784); defaults to GITHUB_TOKEN. Overridden by a `--token-env` flag. */
  tokenEnv?: string;
  /** Per-tenant forge knobs beyond the host (#4784), forwarded to the fan-out. */
  forge?: Partial<ForgeConfig>;
  nowMs?: number;
  /** Per-tenant goal specs threaded to the ranker so lane fit uses the tenant's conventions, not the defaults (#4784). */
  goalSpecsByRepo?: RankCandidateIssuesOptions["goalSpecsByRepo"];
  goalSpecContentByRepo?: RankCandidateIssuesOptions["goalSpecContentByRepo"];
  initPortfolioQueue?: () => PortfolioQueueStore;
  initPolicyDocCache?: () => PolicyDocCacheStore;
  initPolicyVerdictCache?: () => PolicyVerdictCacheStore;
  fetchCandidateIssuesWithSummary?: (
    targets: FanoutTarget[],
    githubToken: string,
    options?: FanoutOptions,
  ) => Promise<DiscoverFanOutSummary>;
  searchCandidateIssuesWithSummary?: (
    searchQuery: string,
    githubToken: string,
    options?: FanoutOptions,
  ) => Promise<DiscoverFanOutSummary>;
  rankCandidateIssuesWithSummary?: (
    candidates: RawCandidateIssue[],
    options?: RankCandidateIssuesOptions,
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
