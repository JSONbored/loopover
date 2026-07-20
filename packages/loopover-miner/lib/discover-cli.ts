/** `discover` CLI command (#4247): wires the existing fanout -> rank -> enqueue pipeline together so a miner
 * can actually run it. Every piece already exists and is independently tested; this module only composes them. */
import { resolveForgeConfig } from "./forge-config.js";
import type { ForgeConfig } from "./forge-config.js";
import {
  fetchCandidateIssuesWithSummary,
  searchCandidateIssuesWithSummary,
} from "./opportunity-fanout.js";
import type {
  CandidateIssueWarning,
  FanoutOptions,
  FanoutTarget,
  RawCandidateIssue,
} from "./opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "./opportunity-ranker.js";
import type {
  RankCandidateIssuesOptions,
  RankedCandidateIssue,
  RankedCandidateSummary,
} from "./opportunity-ranker.js";
import { initPolicyDocCacheStore } from "./policy-doc-cache.js";
import type { PolicyDocCacheStore } from "./policy-doc-cache.js";
import { initPolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import type { PolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import { enqueueRankedDiscovery } from "./portfolio-discovery.js";
import type { EnqueueRankedDiscoverySummary } from "./portfolio-discovery.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";
import { initRankedCandidatesStore } from "./ranked-candidates.js";
import type { RankedCandidatesStore } from "./ranked-candidates.js";
import { extractContributionProfile } from "./contribution-profile-extract.js";
import { initContributionProfileCache } from "./contribution-profile-cache.js";
import { filterCandidatesByProfiles } from "./contribution-profile-filter.js";
import type { ContributionProfile } from "./contribution-profile.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isDiscoveryPlaneEnabled, queryDiscoveryIndex, recordDiscoveryTelemetry } from "./discovery-index-client.js";
import type { queryDiscoveryIndex as QueryDiscoveryIndexFn } from "./discovery-index-client.js";
import type { DiscoveryIndexQuery } from "@loopover/engine";


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
  queryDiscoveryIndex?: typeof QueryDiscoveryIndexFn;
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

const DISCOVER_USAGE =
  "Usage: loopover-miner discover <owner/repo> [<owner/repo>...] | --search <query> [--dry-run] [--json] [--api-base-url <url>] [--token-env <VAR>]";

const MAX_DISCOVER_TITLE_DISPLAY_LENGTH = 240;
const OSC_SEQUENCE_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const ANSI_ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeDiscoverDisplayText(value: unknown): string {
  return String(value ?? "")
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(BIDI_CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISCOVER_TITLE_DISPLAY_LENGTH);
}

function dedupeKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName.toLowerCase()}#${issueNumber}`;
}

/**
 * Supplements `fanOut.issues` with hosted discovery-index results for the same scope (#7168) -- a complete
 * no-op (returns `fanOut` unchanged) unless the plane is enabled, so a run with the flag unset behaves exactly
 * as before this feature existed. Local results always win on a duplicate issue (the discovery-index candidate
 * is dropped, not merged over it) -- this instance's own live fan-out is more current than a cached shared
 * index entry. Discovery-index candidates now carry their real `assignees` when the hosted contract supplies them
 * (#7442): the value flows through so contribution-profile-filter.js's repo-owner exclusion (#7040) engages for
 * index-sourced candidates exactly as it does for direct fan-out ones. A candidate whose response omitted the
 * field (older discovery-index build) falls back to `[]` -- fail-safe: the filter still runs, it just can't detect
 * an owner-assignment it was never told about, rather than the check being silently skipped.
 */
async function supplementWithDiscoveryIndex(
  fanOut: DiscoverFanOutSummary,
  queryScope: Partial<DiscoveryIndexQuery>,
  options: RunDiscoverOptions,
): Promise<DiscoverFanOutSummary> {
  const env = options.env ?? process.env;
  if (!isDiscoveryPlaneEnabled(env)) return fanOut;
  const queryIndex = options.queryDiscoveryIndex ?? queryDiscoveryIndex;
  const response = await queryIndex(queryScope, { env });
  recordDiscoveryTelemetry("discover_query", response.candidates.length > 0 ? "supplemented" : "empty", { env });
  if (response.candidates.length === 0) return fanOut;

  const seen = new Set(fanOut.issues.map((issue) => dedupeKey(issue.repoFullName, issue.issueNumber)));
  const supplemented = response.candidates
    .filter((candidate) => !seen.has(dedupeKey(candidate.repoFullName, candidate.issueNumber)))
    // DiscoveryIndexCandidate is a near-superset of RawCandidateIssue; copy the real assignees through when the
    // hosted contract carried them (#7442), falling back to [] only when the served response genuinely omitted the
    // field — cast preserves pre-existing runtime shape rather than re-mapping.
    .map((candidate) => ({ ...candidate, assignees: [...(candidate.assignees ?? [])], labels: [...candidate.labels] }) as RawCandidateIssue);
  if (supplemented.length === 0) return fanOut;
  return { ...fanOut, issues: [...fanOut.issues, ...supplemented] };
}

function parseRepoTarget(value: string): FanoutTarget | null {
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
}

export function parseDiscoverArgs(args: string[]): ParsedDiscoverArgs {
  // `--api-base-url` and `--token-env` (#4784) thread the tenant's forge host and credential env var into the
  // fan-out; they are kept off the parsed result unless supplied, so callers that pass neither see the exact
  // pre-#4784 `{ targets, search, json }` shape.
  const options: {
    json: boolean;
    dryRun: boolean;
    search: string | null;
    apiBaseUrl: string | null;
    tokenEnv: string | null;
  } = { json: false, dryRun: false, search: null, apiBaseUrl: null, tokenEnv: null };
  const targets: FanoutTarget[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // #4847: fetches + ranks exactly as a real run, but skips opening any local store and makes zero writes.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--search") {
      const query = args[index + 1];
      if (!query || query.startsWith("-")) return { error: DISCOVER_USAGE };
      options.search = query;
      index += 1;
      continue;
    }
    if (token === "--api-base-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: DISCOVER_USAGE };
      options.apiBaseUrl = value;
      index += 1;
      continue;
    }
    if (token === "--token-env") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: DISCOVER_USAGE };
      options.tokenEnv = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    const target = parseRepoTarget(token);
    if (!target) return { error: `Repository must be in owner/repo form: ${token}` };
    targets.push(target);
  }

  if (options.search === null && targets.length === 0) {
    return { error: DISCOVER_USAGE };
  }
  if (options.search !== null && targets.length > 0) {
    return { error: "Pass either repository targets or --search, not both." };
  }

  return {
    targets,
    search: options.search,
    dryRun: options.dryRun,
    json: options.json,
    ...(options.apiBaseUrl !== null ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.tokenEnv !== null ? { tokenEnv: options.tokenEnv } : {}),
  };
}

// The rate-limit line surfaces the telemetry the fanout already records (#4837) so an operator sees how close a
// `discover` run is to being throttled without running a separate command. `unknown` covers the no-fetch/no-header
// case where the fanout captured no remaining count.
function renderRateLimitLine(result: Pick<DiscoverResult, "rateLimitRemaining" | "rateLimitResetAt">): string {
  const remaining = result.rateLimitRemaining === null ? "unknown" : String(result.rateLimitRemaining);
  const resetSuffix = result.rateLimitResetAt === null ? "" : ` (resets ${result.rateLimitResetAt})`;
  return `rate-limit remaining: ${remaining}${resetSuffix}`;
}

export function renderDiscoverSummary(result: DiscoverResult): string {
  const lines = [
    `fanned out: ${result.fanOutCount} candidate issue(s)`,
    `ai-policy warnings: ${result.warnings.length}`,
    `ranked: ${result.ranked.length}`,
    `enqueued: ${result.enqueueSummary.enqueued}`,
    renderRateLimitLine(result),
  ];
  if (result.enqueueSummary.skippedBelowMinRank > 0) {
    lines.push(`skipped (below min rank): ${result.enqueueSummary.skippedBelowMinRank}`);
  }
  // #6798: surface what the eligibility filter dropped and why, so a human sees AMS's inference.
  const excluded = result.excluded ?? [];
  if (excluded.length > 0) {
    lines.push(`excluded (eligibility): ${excluded.length}`);
    for (const entry of excluded.slice(0, 10)) {
      lines.push(`  ${entry.repoFullName}#${entry.issueNumber}  ${entry.reason}`);
    }
  }
  // Make the fall-back to loopover's built-in rubric explicit instead of silent (#4784): when no per-tenant goal
  // spec is supplied, lane fit reflects loopover's defaults, not the target repo's own conventions.
  if (result.usedDefaultGoalSpec) {
    lines.push(
      "note: ranked with the built-in default goal spec (no per-tenant .loopover-miner.yml supplied)",
    );
  }
  if (result.ranked.length === 0) {
    lines.push("", "no candidates found.");
    return lines.join("\n");
  }
  lines.push("", "top candidates:");
  for (const entry of result.ranked.slice(0, 10)) {
    const title = sanitizeDiscoverDisplayText(entry.title);
    lines.push(`  ${entry.repoFullName}#${entry.issueNumber}  score=${entry.rankScore.toFixed(4)}  ${title}`);
  }
  return lines.join("\n");
}

/**
 * Default per-repo ContributionProfile resolver (#6798): reads the local cache and, on a miss/stale entry,
 * extracts a fresh profile and caches it. Returns a Map keyed by repoFullName.
 *
 * WITHOUT a github token this returns an empty map and does no network work at all — AMS can't reliably read a
 * repo's label taxonomy/docs unauthenticated (rate limits), so it safe-defaults to no eligibility filtering.
 * That also keeps callers that don't supply a token (the common CLI path, and every test) hermetic.
 *
 * @param {string[]} repoFullNames unique repos among the fanned-out candidates
 * @param {{ githubToken?: string, apiBaseUrl?: string, nowMs?: number, initCache?: typeof initContributionProfileCache, extract?: typeof extractContributionProfile }} ctx
 * @returns {Promise<Map<string, object>>}
 */
export async function resolveContributionProfilesForDiscover(
  repoFullNames: string[],
  ctx: {
    githubToken?: string;
    apiBaseUrl?: string;
    nowMs?: number;
    initCache?: unknown;
    extract?: unknown;
  } = {},
): Promise<Map<string, unknown>> {
  const profiles = new Map();
  if (!ctx.githubToken) return profiles;
  const initCache = (ctx.initCache as typeof initContributionProfileCache | undefined) ?? initContributionProfileCache;
  const extract = (ctx.extract as typeof extractContributionProfile | undefined) ?? extractContributionProfile;
  const cache = initCache();
  try {
    for (const repoFullName of repoFullNames) {
      const cached = cache.get(repoFullName, ctx.nowMs);
      if (cached && !cached.stale) {
        profiles.set(repoFullName, cached.profile);
        continue;
      }
      const profile = await extract(repoFullName, {
        githubToken: ctx.githubToken,
        // exactOptionalPropertyTypes: omit apiBaseUrl when unset (pre-existing optional-prop shape).
        ...(ctx.apiBaseUrl !== undefined ? { apiBaseUrl: ctx.apiBaseUrl } : {}),
      } as Parameters<typeof extractContributionProfile>[1]);
      cache.put(profile, ctx.nowMs);
      profiles.set(repoFullName, profile);
    }
  } finally {
    cache.close();
  }
  return profiles;
}

export async function runDiscover(args: string[], options: RunDiscoverOptions = {}): Promise<number> {
  const parsed = parseDiscoverArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  // Credential env var is per-tenant (#4784): a `--token-env FORGE_PAT` flag (or `options.tokenEnv`) reads a
  // non-`GITHUB_TOKEN` variable so a non-github.com forge's token is reachable. The default falls through to the
  // forge adapter's own `tokenEnvVar` (github.com's `GITHUB_TOKEN`), so there's a single source of truth for the
  // default credential env instead of a second hardcoded literal that could drift from `DEFAULT_FORGE_CONFIG`.
  const tokenEnv = parsed.tokenEnv ?? options.tokenEnv ?? resolveForgeConfig(options.forge).tokenEnvVar;
  const githubToken = options.githubToken ?? process.env[tokenEnv] ?? "";
  // A `--api-base-url` flag (or `options.apiBaseUrl`) surfaces the fan-out's existing forge-host override at the CLI
  // (#4784); `options.forge` carries any remaining per-tenant forge knobs for a programmatic caller.
  const apiBaseUrl = parsed.apiBaseUrl ?? options.apiBaseUrl;
  const fetchTargets = options.fetchCandidateIssuesWithSummary ?? fetchCandidateIssuesWithSummary;
  const searchTargets = options.searchCandidateIssuesWithSummary ?? searchCandidateIssuesWithSummary;
  const rankIssues = options.rankCandidateIssuesWithSummary ?? rankCandidateIssuesWithSummary;
  const enqueue = options.enqueueRankedDiscovery ?? enqueueRankedDiscovery;
  // Eligibility filtering (#6798): resolve each candidate repo's ContributionProfile and drop candidates the
  // repo's own conventions would reject, BEFORE ranking. Safe by default -- see resolveContributionProfilesForDiscover.
  const resolveProfiles = options.resolveContributionProfiles ?? resolveContributionProfilesForDiscover;
  // Same scope this run already asks GitHub about (#7168) -- the discovery-index supplement, when enabled,
  // asks the shared hosted index about the identical targets/search rather than a different query entirely.
  const discoveryQueryScope =
    parsed.search !== null
      ? { repos: [], orgs: [], searchTerms: [parsed.search] }
      : { repos: parsed.targets.map((target) => `${target.owner}/${target.repo}`), orgs: [], searchTerms: [] };

  // #4847: fetch + rank are read-only GitHub GETs and pure local computation, so a dry run still does them for
  // real (that's the useful "what would this discover?" output) -- but it never opens any local store (portfolio
  // queue, policy-doc cache, policy-verdict cache), since opening a not-yet-existing SQLite store file is itself
  // a write. The ranked issues are fed through a no-op queue stub so enqueueRankedDiscovery's own classification
  // logic (valid/invalid, below-min-rank) still runs for real, just without ever touching the real queue.
  if (parsed.dryRun) {
    // exactOptionalPropertyTypes: cast through FanoutOptions — apiBaseUrl/forge may be unset at runtime.
    const fanOutOptions = {
      apiBaseUrl,
      forge: options.forge,
      policyDocCache: null,
      policyVerdictCache: null,
    } as FanoutOptions;
    try {
      let fanOut =
        parsed.search !== null
          ? await searchTargets(parsed.search, githubToken, fanOutOptions)
          : await fetchTargets(parsed.targets, githubToken, fanOutOptions);
      fanOut = await supplementWithDiscoveryIndex(fanOut, discoveryQueryScope, options);
      // #6798: same eligibility filter as the real path, so a dry run shows the exact candidate set a real run
      // would enqueue (and the same excluded set), rather than an unfiltered preview.
      const repoFullNames = [...new Set(fanOut.issues.map((issue) => issue.repoFullName))];
      const profilesByRepo = await resolveProfiles(repoFullNames, {
        githubToken,
        ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      });
      // RunDiscoverOptions.resolveContributionProfiles is typed as Map<string, unknown> (pre-existing .d.ts);
      // the filter expects ContributionProfile values — same runtime objects.
      const { kept, excluded } = filterCandidatesByProfiles(
        fanOut.issues,
        profilesByRepo as Map<string, ContributionProfile>,
      );
      const rankedSummary = rankIssues(kept, {
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
        ...(options.goalSpecsByRepo !== undefined ? { goalSpecsByRepo: options.goalSpecsByRepo } : {}),
        ...(options.goalSpecContentByRepo !== undefined
          ? { goalSpecContentByRepo: options.goalSpecContentByRepo }
          : {}),
      });
      const noopQueueStore = { enqueue: () => {} } as unknown as PortfolioQueueStore;
      const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: noopQueueStore });
      const result = {
        outcome: "dry_run",
        fanOutCount: fanOut.issues.length,
        warnings: fanOut.warnings,
        rateLimitRemaining: fanOut.rateLimitRemaining,
        rateLimitResetAt: fanOut.rateLimitResetAt,
        ranked: rankedSummary.issues,
        excluded: excluded.map((entry) => ({
          repoFullName: entry.candidate.repoFullName,
          issueNumber: entry.candidate.issueNumber,
          reason: entry.reason,
        })),
        usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
        enqueueSummary,
      };
      // Structured-outcome hook (#6522), mirroring runAttempt's onResult convention: fires only at a real
      // structured success point (never the reportCliFailure branches), in addition to -- never instead of --
      // the plain exit-code return, so a non-CLI caller (the /api/discover route) can read the result.
      // Dry-run result adds `outcome: "dry_run"` at runtime; DiscoverResult/.d.ts omits it — pre-existing drift.
      options.onResult?.(result as DiscoverResult);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderDiscoverSummary(result as DiscoverResult));
        console.log("\nDRY RUN: no portfolio-queue write was made.");
      }
      return 0;
    } catch (error) {
      return reportCliFailure(parsed.json, describeCliError(error));
    }
  }

  const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
  let portfolioQueue: PortfolioQueueStore | undefined;
  try {
    portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }

  // Local ETag cache so a repeated discover revalidates each repo's policy docs with a conditional GET instead of
  // re-downloading them (#4842). Opened inside its OWN try/catch, separate from the portfolio queue above: the
  // queue is required infrastructure (discovery genuinely cannot enqueue anything without it, so a real open
  // failure should abort the run), but the policy-doc cache is a pure performance optimization -- a corrupt or
  // unwritable cache DB must degrade to "no cache" (every doc fetched in full, exactly as before #4842) rather
  // than fail discovery outright.
  let policyDocCache: PolicyDocCacheStore | null = null;
  let ownsPolicyDocCache = false;
  try {
    ownsPolicyDocCache = options.initPolicyDocCache === undefined;
    policyDocCache = (options.initPolicyDocCache ?? initPolicyDocCacheStore)();
  } catch {
    policyDocCache = null;
    ownsPolicyDocCache = false;
  }

  // Persisted cache of resolved policy verdicts (#4843), same "own try/catch, degrade to null" discipline as the
  // doc cache above and for the same reason: purely a performance optimization the feature is inert without, so a
  // corrupt/unwritable cache DB must never abort a run.
  let policyVerdictCache: PolicyVerdictCacheStore | null = null;
  let ownsPolicyVerdictCache = false;
  try {
    ownsPolicyVerdictCache = options.initPolicyVerdictCache === undefined;
    policyVerdictCache = (options.initPolicyVerdictCache ?? initPolicyVerdictCacheStore)();
  } catch {
    policyVerdictCache = null;
    ownsPolicyVerdictCache = false;
  }

  // Snapshot of this run's full ranked output (#4859 prerequisite), so a local HTTP endpoint (and eventually the
  // miner-ui/browser-extension live-fetch it's meant for) can serve the same per-issue breakdown `--json` prints,
  // without the operator re-running discover or hand-pasting its output. Same "own try/catch, degrade to null"
  // discipline as the two caches above: a corrupt/unwritable snapshot store must never abort discovery's actual
  // job (fan out, rank, enqueue). Unlike the caches, this store is a WRITE target, not a read optimization -- the
  // save call itself gets its own try/catch below for the same reason.
  let rankedCandidatesStore: RankedCandidatesStore | null = null;
  let ownsRankedCandidatesStore = false;
  try {
    ownsRankedCandidatesStore = options.initRankedCandidatesStore === undefined;
    rankedCandidatesStore = (options.initRankedCandidatesStore ?? initRankedCandidatesStore)();
  } catch {
    rankedCandidatesStore = null;
    ownsRankedCandidatesStore = false;
  }
  const fanOutOptions = {
    apiBaseUrl,
    forge: options.forge,
    policyDocCache,
    policyVerdictCache,
  } as FanoutOptions;

  try {
    let fanOut =
      parsed.search !== null
        ? await searchTargets(parsed.search, githubToken, fanOutOptions)
        : await fetchTargets(parsed.targets, githubToken, fanOutOptions);
    fanOut = await supplementWithDiscoveryIndex(fanOut, discoveryQueryScope, options);

    // Eligibility filter (#6798): drop candidates a target repo's own conventions would reject, before ranking.
    // A repo with no trustworthy eligibility profile keeps every candidate (filterCandidatesByProfiles' safe
    // default), so this never silently skips real work on a repo whose conventions AMS couldn't read.
    const repoFullNames = [...new Set(fanOut.issues.map((issue) => issue.repoFullName))];
    const profilesByRepo = await resolveProfiles(repoFullNames, {
      githubToken,
      ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
    // RunDiscoverOptions.resolveContributionProfiles is typed as Map<string, unknown> (pre-existing .d.ts);
    // the filter expects ContributionProfile values — same runtime objects.
    const { kept, excluded } = filterCandidatesByProfiles(
      fanOut.issues,
      profilesByRepo as Map<string, ContributionProfile>,
    );

    // Pass any caller-supplied per-tenant goal specs through to the ranker so lane fit uses the tenant's
    // conventions instead of silently falling back to loopover's defaults (#4784); the fallback is surfaced via
    // `usedDefaultGoalSpec` below rather than hidden.
    const rankedSummary = rankIssues(kept, {
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.goalSpecsByRepo !== undefined ? { goalSpecsByRepo: options.goalSpecsByRepo } : {}),
      ...(options.goalSpecContentByRepo !== undefined
        ? { goalSpecContentByRepo: options.goalSpecContentByRepo }
        : {}),
    });
    const enqueueSummary = enqueue(rankedSummary.issues, {
      queueStore: portfolioQueue,
      ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
    });

    try {
      // Optional chaining rather than an `if (rankedCandidatesStore)` guard: a null store (open failed above)
      // short-circuits to a no-op read, so the same try/catch below also covers the open-failed case without a
      // second explicit branch.
      rankedCandidatesStore?.saveRankedCandidates(rankedSummary.issues, options.nowMs);
    } catch {
      // Non-fatal: the ranked-candidates snapshot is a nice-to-have for the local HTTP endpoint, not a
      // requirement for discover's own job (fan out, rank, enqueue), which already succeeded above.
    }

    const result = {
      fanOutCount: fanOut.issues.length,
      warnings: fanOut.warnings,
      rateLimitRemaining: fanOut.rateLimitRemaining,
      rateLimitResetAt: fanOut.rateLimitResetAt,
      ranked: rankedSummary.issues,
      // #6798: candidates the eligibility filter dropped, each with the repo + issue + reason, so a human sees
      // what AMS inferred and why a candidate was skipped. Empty when no profile was trustworthy enough to filter.
      excluded: excluded.map((entry) => ({
        repoFullName: entry.candidate.repoFullName,
        issueNumber: entry.candidate.issueNumber,
        reason: entry.reason,
      })),
      usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
      enqueueSummary,
    };

    // Structured-outcome hook (#6522) for the full-run success point -- same convention as the dry-run branch
    // above and as runAttempt's onResult: real result only, additive to the unchanged exit-code return.
    options.onResult?.(result);
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderDiscoverSummary(result));
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  } finally {
    if (ownsPortfolioQueue && portfolioQueue) portfolioQueue.close();
    if (ownsPolicyDocCache && policyDocCache) policyDocCache.close();
    if (ownsPolicyVerdictCache && policyVerdictCache) policyVerdictCache.close();
    if (ownsRankedCandidatesStore && rankedCandidatesStore) rankedCandidatesStore.close();
  }
}
