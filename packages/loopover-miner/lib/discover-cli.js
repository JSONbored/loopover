/** `discover` CLI command (#4247): wires the existing fanout -> rank -> enqueue pipeline together so a miner
 * can actually run it. Every piece already exists and is independently tested; this module only composes them. */
import { resolveForgeConfig } from "./forge-config.js";
import { fetchCandidateIssuesWithSummary, searchCandidateIssuesWithSummary, } from "./opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "./opportunity-ranker.js";
import { initPolicyDocCacheStore } from "./policy-doc-cache.js";
import { initPolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import { enqueueRankedDiscovery } from "./portfolio-discovery.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRankedCandidatesStore } from "./ranked-candidates.js";
import { extractContributionProfile } from "./contribution-profile-extract.js";
import { initContributionProfileCache } from "./contribution-profile-cache.js";
import { filterCandidatesByProfiles } from "./contribution-profile-filter.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isDiscoveryPlaneEnabled, queryDiscoveryIndex, recordDiscoveryTelemetry } from "./discovery-index-client.js";
const DISCOVER_USAGE = "Usage: loopover-miner discover <owner/repo> [<owner/repo>...] | --search <query> [--dry-run] [--json] [--api-base-url <url>] [--token-env <VAR>]";
const MAX_DISCOVER_TITLE_DISPLAY_LENGTH = 240;
const OSC_SEQUENCE_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const ANSI_ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROL_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function sanitizeDiscoverDisplayText(value) {
    return String(value ?? "")
        .replace(OSC_SEQUENCE_PATTERN, "")
        .replace(ANSI_ESCAPE_PATTERN, "")
        .replace(CONTROL_CHARACTER_PATTERN, " ")
        .replace(BIDI_CONTROL_PATTERN, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_DISCOVER_TITLE_DISPLAY_LENGTH);
}
function dedupeKey(repoFullName, issueNumber) {
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
async function supplementWithDiscoveryIndex(fanOut, queryScope, options) {
    const env = options.env ?? process.env;
    if (!isDiscoveryPlaneEnabled(env))
        return fanOut;
    const queryIndex = options.queryDiscoveryIndex ?? queryDiscoveryIndex;
    const response = await queryIndex(queryScope, { env });
    recordDiscoveryTelemetry("discover_query", response.candidates.length > 0 ? "supplemented" : "empty", { env });
    if (response.candidates.length === 0)
        return fanOut;
    const seen = new Set(fanOut.issues.map((issue) => dedupeKey(issue.repoFullName, issue.issueNumber)));
    const supplemented = response.candidates
        .filter((candidate) => !seen.has(dedupeKey(candidate.repoFullName, candidate.issueNumber)))
        // DiscoveryIndexCandidate is a near-superset of RawCandidateIssue; copy the real assignees through when the
        // hosted contract carried them (#7442), falling back to [] only when the served response genuinely omitted the
        // field — cast preserves pre-existing runtime shape rather than re-mapping.
        .map((candidate) => ({ ...candidate, assignees: [...(candidate.assignees ?? [])], labels: [...candidate.labels] }));
    if (supplemented.length === 0)
        return fanOut;
    return { ...fanOut, issues: [...fanOut.issues, ...supplemented] };
}
function parseRepoTarget(value) {
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
export function parseDiscoverArgs(args) {
    // `--api-base-url` and `--token-env` (#4784) thread the tenant's forge host and credential env var into the
    // fan-out; they are kept off the parsed result unless supplied, so callers that pass neither see the exact
    // pre-#4784 `{ targets, search, json }` shape.
    const options = { json: false, dryRun: false, search: null, apiBaseUrl: null, tokenEnv: null };
    const targets = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
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
            if (!query || query.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.search = query;
            index += 1;
            continue;
        }
        if (token === "--api-base-url") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.apiBaseUrl = value;
            index += 1;
            continue;
        }
        if (token === "--token-env") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: DISCOVER_USAGE };
            options.tokenEnv = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        const target = parseRepoTarget(token);
        if (!target)
            return { error: `Repository must be in owner/repo form: ${token}` };
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
function renderRateLimitLine(result) {
    const remaining = result.rateLimitRemaining === null ? "unknown" : String(result.rateLimitRemaining);
    const resetSuffix = result.rateLimitResetAt === null ? "" : ` (resets ${result.rateLimitResetAt})`;
    return `rate-limit remaining: ${remaining}${resetSuffix}`;
}
export function renderDiscoverSummary(result) {
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
        lines.push("note: ranked with the built-in default goal spec (no per-tenant .loopover-miner.yml supplied)");
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
export async function resolveContributionProfilesForDiscover(repoFullNames, ctx = {}) {
    const profiles = new Map();
    if (!ctx.githubToken)
        return profiles;
    const initCache = ctx.initCache ?? initContributionProfileCache;
    const extract = ctx.extract ?? extractContributionProfile;
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
            });
            cache.put(profile, ctx.nowMs);
            profiles.set(repoFullName, profile);
        }
    }
    finally {
        cache.close();
    }
    return profiles;
}
export async function runDiscover(args, options = {}) {
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
    const discoveryQueryScope = parsed.search !== null
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
        };
        try {
            let fanOut = parsed.search !== null
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
            const { kept, excluded } = filterCandidatesByProfiles(fanOut.issues, profilesByRepo);
            const rankedSummary = rankIssues(kept, {
                ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
                ...(options.goalSpecsByRepo !== undefined ? { goalSpecsByRepo: options.goalSpecsByRepo } : {}),
                ...(options.goalSpecContentByRepo !== undefined
                    ? { goalSpecContentByRepo: options.goalSpecContentByRepo }
                    : {}),
            });
            const noopQueueStore = { enqueue: () => { } };
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
            options.onResult?.(result);
            if (parsed.json) {
                console.log(JSON.stringify(result, null, 2));
            }
            else {
                console.log(renderDiscoverSummary(result));
                console.log("\nDRY RUN: no portfolio-queue write was made.");
            }
            return 0;
        }
        catch (error) {
            return reportCliFailure(parsed.json, describeCliError(error));
        }
    }
    const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
    let portfolioQueue;
    try {
        portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    // Local ETag cache so a repeated discover revalidates each repo's policy docs with a conditional GET instead of
    // re-downloading them (#4842). Opened inside its OWN try/catch, separate from the portfolio queue above: the
    // queue is required infrastructure (discovery genuinely cannot enqueue anything without it, so a real open
    // failure should abort the run), but the policy-doc cache is a pure performance optimization -- a corrupt or
    // unwritable cache DB must degrade to "no cache" (every doc fetched in full, exactly as before #4842) rather
    // than fail discovery outright.
    let policyDocCache = null;
    let ownsPolicyDocCache = false;
    try {
        ownsPolicyDocCache = options.initPolicyDocCache === undefined;
        policyDocCache = (options.initPolicyDocCache ?? initPolicyDocCacheStore)();
    }
    catch {
        policyDocCache = null;
        ownsPolicyDocCache = false;
    }
    // Persisted cache of resolved policy verdicts (#4843), same "own try/catch, degrade to null" discipline as the
    // doc cache above and for the same reason: purely a performance optimization the feature is inert without, so a
    // corrupt/unwritable cache DB must never abort a run.
    let policyVerdictCache = null;
    let ownsPolicyVerdictCache = false;
    try {
        ownsPolicyVerdictCache = options.initPolicyVerdictCache === undefined;
        policyVerdictCache = (options.initPolicyVerdictCache ?? initPolicyVerdictCacheStore)();
    }
    catch {
        policyVerdictCache = null;
        ownsPolicyVerdictCache = false;
    }
    // Snapshot of this run's full ranked output (#4859 prerequisite), so a local HTTP endpoint (and eventually the
    // miner-ui/browser-extension live-fetch it's meant for) can serve the same per-issue breakdown `--json` prints,
    // without the operator re-running discover or hand-pasting its output. Same "own try/catch, degrade to null"
    // discipline as the two caches above: a corrupt/unwritable snapshot store must never abort discovery's actual
    // job (fan out, rank, enqueue). Unlike the caches, this store is a WRITE target, not a read optimization -- the
    // save call itself gets its own try/catch below for the same reason.
    let rankedCandidatesStore = null;
    let ownsRankedCandidatesStore = false;
    try {
        ownsRankedCandidatesStore = options.initRankedCandidatesStore === undefined;
        rankedCandidatesStore = (options.initRankedCandidatesStore ?? initRankedCandidatesStore)();
    }
    catch {
        rankedCandidatesStore = null;
        ownsRankedCandidatesStore = false;
    }
    const fanOutOptions = {
        apiBaseUrl,
        forge: options.forge,
        policyDocCache,
        policyVerdictCache,
    };
    try {
        let fanOut = parsed.search !== null
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
        const { kept, excluded } = filterCandidatesByProfiles(fanOut.issues, profilesByRepo);
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
        }
        catch {
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
        }
        else {
            console.log(renderDiscoverSummary(result));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        if (ownsPortfolioQueue && portfolioQueue)
            portfolioQueue.close();
        if (ownsPolicyDocCache && policyDocCache)
            policyDocCache.close();
        if (ownsPolicyVerdictCache && policyVerdictCache)
            policyVerdictCache.close();
        if (ownsRankedCandidatesStore && rankedCandidatesStore)
            rankedCandidatesStore.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlzY292ZXItY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGlzY292ZXItY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO2tIQUNrSDtBQUNsSCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUV2RCxPQUFPLEVBQ0wsK0JBQStCLEVBQy9CLGdDQUFnQyxHQUNqQyxNQUFNLHlCQUF5QixDQUFDO0FBT2pDLE9BQU8sRUFBRSw4QkFBOEIsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBTXpFLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBRWhFLE9BQU8sRUFBRSwyQkFBMkIsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBRXhFLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBRWxFLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRS9ELE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBRW5FLE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxNQUFNLG1DQUFtQyxDQUFDO0FBQy9FLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxNQUFNLGlDQUFpQyxDQUFDO0FBQy9FLE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxNQUFNLGtDQUFrQyxDQUFDO0FBRTlFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsdUJBQXVCLEVBQUUsbUJBQW1CLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQW9HckgsTUFBTSxjQUFjLEdBQ2xCLGtKQUFrSixDQUFDO0FBRXJKLE1BQU0saUNBQWlDLEdBQUcsR0FBRyxDQUFDO0FBQzlDLE1BQU0sb0JBQW9CLEdBQUcsc0NBQXNDLENBQUM7QUFDcEUsTUFBTSxtQkFBbUIsR0FBRyxzQ0FBc0MsQ0FB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