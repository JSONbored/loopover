/** `discover` CLI command (#4247): wires the existing fanout -> rank -> enqueue pipeline together so a miner
 * can actually run it. Every piece already exists and is independently tested; this module only composes them. */
import { resolveForgeConfig } from "./forge-config.js";
import {
  fetchCandidateIssuesWithSummary,
  searchCandidateIssuesWithSummary,
} from "./opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "./opportunity-ranker.js";
import { initPolicyDocCacheStore } from "./policy-doc-cache.js";
import { initPolicyVerdictCacheStore } from "./policy-verdict-cache.js";
import { enqueueRankedDiscovery } from "./portfolio-discovery.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

const DISCOVER_USAGE =
  "Usage: gittensory-miner discover <owner/repo> [<owner/repo>...] | --search <query> [--dry-run] [--json] [--api-base-url <url>] [--token-env <VAR>]";

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

function parseRepoTarget(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) return null;
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
  // Make the fall-back to gittensory's built-in rubric explicit instead of silent (#4784): when no per-tenant goal
  // spec is supplied, lane fit reflects gittensory's defaults, not the target repo's own conventions.
  if (result.usedDefaultGoalSpec) {
    lines.push(
      "note: ranked with the built-in default goal spec (no per-tenant .gittensory-miner.yml supplied)",
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

  // #4847: fetch + rank are read-only GitHub GETs and pure local computation, so a dry run still does them for
  // real (that's the useful "what would this discover?" output) -- but it never opens any local store (portfolio
  // queue, policy-doc cache, policy-verdict cache), since opening a not-yet-existing SQLite store file is itself
  // a write. The ranked issues are fed through a no-op queue stub so enqueueRankedDiscovery's own classification
  // logic (valid/invalid, below-min-rank) still runs for real, just without ever touching the real queue.
  if (parsed.dryRun) {
    const fanOutOptions = { apiBaseUrl, forge: options.forge, policyDocCache: null, policyVerdictCache: null };
    try {
      const fanOut =
        parsed.search !== null
          ? await searchTargets(parsed.search, githubToken, fanOutOptions)
          : await fetchTargets(parsed.targets, githubToken, fanOutOptions);
      const rankedSummary = rankIssues(fanOut.issues, {
        nowMs: options.nowMs,
        goalSpecsByRepo: options.goalSpecsByRepo,
        goalSpecContentByRepo: options.goalSpecContentByRepo,
      });
      const noopQueueStore = { enqueue: () => {} };
      const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: noopQueueStore });
      const result = {
        outcome: "dry_run",
        fanOutCount: fanOut.issues.length,
        warnings: fanOut.warnings,
        rateLimitRemaining: fanOut.rateLimitRemaining,
        rateLimitResetAt: fanOut.rateLimitResetAt,
        ranked: rankedSummary.issues,
        usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
        enqueueSummary,
      };
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderDiscoverSummary(result));
        console.log("\nDRY RUN: no portfolio-queue write was made.");
      }
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
  let portfolioQueue;
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
  let policyDocCache = null;
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
  let policyVerdictCache = null;
  let ownsPolicyVerdictCache = false;
  try {
    ownsPolicyVerdictCache = options.initPolicyVerdictCache === undefined;
    policyVerdictCache = (options.initPolicyVerdictCache ?? initPolicyVerdictCacheStore)();
  } catch {
    policyVerdictCache = null;
    ownsPolicyVerdictCache = false;
  }
  const fanOutOptions = { apiBaseUrl, forge: options.forge, policyDocCache, policyVerdictCache };

  try {
    const fanOut =
      parsed.search !== null
        ? await searchTargets(parsed.search, githubToken, fanOutOptions)
        : await fetchTargets(parsed.targets, githubToken, fanOutOptions);

    // Pass any caller-supplied per-tenant goal specs through to the ranker so lane fit uses the tenant's
    // conventions instead of silently falling back to gittensory's defaults (#4784); the fallback is surfaced via
    // `usedDefaultGoalSpec` below rather than hidden.
    const rankedSummary = rankIssues(fanOut.issues, {
      nowMs: options.nowMs,
      goalSpecsByRepo: options.goalSpecsByRepo,
      goalSpecContentByRepo: options.goalSpecContentByRepo,
    });
    const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: portfolioQueue, apiBaseUrl });

    const result = {
      fanOutCount: fanOut.issues.length,
      warnings: fanOut.warnings,
      rateLimitRemaining: fanOut.rateLimitRemaining,
      rateLimitResetAt: fanOut.rateLimitResetAt,
      ranked: rankedSummary.issues,
      usedDefaultGoalSpec: rankedSummary.usedDefaultGoalSpec,
      enqueueSummary,
    };

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
  }
}
