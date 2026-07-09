/** `discover` CLI command (#4247): wires the existing fanout -> rank -> enqueue pipeline together so a miner
 * can actually run it. Every piece already exists and is independently tested; this module only composes them. */
import {
  fetchCandidateIssuesWithSummary,
  searchCandidateIssuesWithSummary,
} from "./opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "./opportunity-ranker.js";
import { enqueueRankedDiscovery } from "./portfolio-discovery.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";

const DISCOVER_USAGE =
  "Usage: gittensory-miner discover <owner/repo> [<owner/repo>...] | --search <query> [--json]";

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
  const options = { json: false, search: null };
  const targets = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--search") {
      const query = args[index + 1];
      if (!query || query.startsWith("-")) return { error: DISCOVER_USAGE };
      options.search = query;
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

  return { targets, search: options.search, json: options.json };
}

export function renderDiscoverSummary(result) {
  const lines = [
    `fanned out: ${result.fanOutCount} candidate issue(s)`,
    `ai-policy warnings: ${result.warnings.length}`,
    `ranked: ${result.ranked.length}`,
    `enqueued: ${result.enqueueSummary.enqueued}`,
  ];
  if (result.enqueueSummary.skippedBelowMinRank > 0) {
    lines.push(`skipped (below min rank): ${result.enqueueSummary.skippedBelowMinRank}`);
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
    console.error(parsed.error);
    return 2;
  }

  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN ?? "";
  const fetchTargets = options.fetchCandidateIssuesWithSummary ?? fetchCandidateIssuesWithSummary;
  const searchTargets = options.searchCandidateIssuesWithSummary ?? searchCandidateIssuesWithSummary;
  const rankIssues = options.rankCandidateIssuesWithSummary ?? rankCandidateIssuesWithSummary;
  const enqueue = options.enqueueRankedDiscovery ?? enqueueRankedDiscovery;

  const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
  const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();

  try {
    const fanOut =
      parsed.search !== null
        ? await searchTargets(parsed.search, githubToken, { apiBaseUrl: options.apiBaseUrl })
        : await fetchTargets(parsed.targets, githubToken, { apiBaseUrl: options.apiBaseUrl });

    const rankedSummary = rankIssues(fanOut.issues, { nowMs: options.nowMs });
    const enqueueSummary = enqueue(rankedSummary.issues, { queueStore: portfolioQueue });

    const result = {
      fanOutCount: fanOut.issues.length,
      warnings: fanOut.warnings,
      ranked: rankedSummary.issues,
      enqueueSummary,
    };

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderDiscoverSummary(result));
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (ownsPortfolioQueue) portfolioQueue.close();
  }
}
