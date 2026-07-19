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
import type { RankedCandidatesStore } from "./ranked-candidates.js";
import type { queryDiscoveryIndex } from "./discovery-index-client.js";

export type ParsedDiscoverArgs =
  | {
      targets: FanoutTarget[];
      search: string | null;
      dryRun: boolean;
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
export type DiscoverRankedEntry = Pick<
  RankedCandidateIssue,
  "repoFullName" | "issueNumber" | "title" | "rankScore"
>;

export type DiscoverResult = {
  fanOutCount: number;
  warnings: CandidateIssueWarning[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  ranked: DiscoverRankedEntry[];
  /** Candidates the eligibility filter dropped, each with the repo/issue and the reason (#6798). */
  excluded?: Array<{
    repoFullName: string;
    issueNumber: number;
    reason: string;
  }>;
  /** True when ranking fell back to the built-in default goal spec because no per-tenant spec was supplied (#4784). */
  usedDefaultGoalSpec?: boolean;
  enqueueSummary: EnqueueRankedDiscoverySummary;
};

export type RunDiscoverOptions = {
  /** Read for the discovery-index opt-in gate (#7168) -- defaults to `process.env`. */
  env?: Record<string, string | undefined>;
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
  initRankedCandidatesStore?: () => RankedCandidatesStore;
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
  /** Supplements the local fan-out with hosted discovery-index results for the same scope, when the plane is
   *  enabled (#7168). Defaults to discovery-index-client.js's own queryDiscoveryIndex. */
  queryDiscoveryIndex?: typeof queryDiscoveryIndex;
  /** Invoked with the real structured result at each success return point (dry-run and full-run), in addition
   *  to (never instead of) the plain exit-code return -- mirrors `RunAttemptOptions.onResult`. Never fires on a
   *  parse-error/unexpected-error `reportCliFailure` branch, matching runAttempt's own asymmetry (#6522). */
  onResult?: (result: DiscoverResult) => void;
  /** Resolve each candidate repo's ContributionProfile for eligibility filtering (#6798). Defaults to
   *  resolveContributionProfilesForDiscover; injectable so tests avoid the network. */
  resolveContributionProfiles?: (
    repoFullNames: string[],
    ctx: { githubToken?: string; apiBaseUrl?: string; nowMs?: number },
  ) => Promise<Map<string, unknown>>;
};

export function resolveContributionProfilesForDiscover(
  repoFullNames: string[],
  ctx?: {
    githubToken?: string;
    apiBaseUrl?: string;
    nowMs?: number;
    initCache?: unknown;
    extract?: unknown;
  },
): Promise<Map<string, unknown>>;

export function parseDiscoverArgs(args: string[]): ParsedDiscoverArgs;

export function sanitizeDiscoverDisplayText(value: unknown): string;

export function renderDiscoverSummary(result: DiscoverResult): string;

export function runDiscover(
  args: string[],
  options?: RunDiscoverOptions,
): Promise<number>;
