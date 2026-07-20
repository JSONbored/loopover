// Core query logic for POST /v1/discovery-index/query (#7164). Centralizes what
// packages/loopover-miner/lib/opportunity-fanout.js's fetchTargetIssues/fetchSearchIssues/resolveRepoAiPolicy
// do per-instance — same metadata fields, same AI-USAGE.md-then-CONTRIBUTING.md short-circuit resolution —
// behind one shared, TTL-cached result set per unique (repos, orgs, searchTerms) scope, so repeated queries
// across the fleet don't re-hit GitHub. Response candidates are built exclusively from
// DiscoveryIndexCandidate object literals (never copied from raw GitHub payloads), so the forbidden-field
// boundary (DISCOVERY_INDEX_FORBIDDEN_FIELDS) is structurally impossible to violate here — no
// economic/identity/source field is ever computed, let alone forwarded.
import {
  DISCOVERY_INDEX_CONTRACT_VERSION,
  type AiPolicyVerdict,
  type DiscoveryIndexCandidate,
  type DiscoveryIndexQuery,
  type DiscoveryIndexResponse,
  normalizeDiscoveryIndexResponse,
  resolveAiPolicyVerdict,
} from "@loopover/engine";
import type { TtlCache } from "./cache.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { GitHubIssue } from "./github-client.js";
import { incr } from "./metrics.js";

/** The subset of GitHubClient this module actually calls — kept as an interface so tests can inject a plain
 *  stub instead of a real GitHubClient (which would need a real/mocked global fetch). */
export interface GitHubClientLike {
  fetchRepoIssues(repoFullName: string): Promise<{ issues: GitHubIssue[]; warnings: string[] }>;
  searchIssues(query: string): Promise<{ issues: GitHubIssue[]; warnings: string[] }>;
  fetchRepoFile(repoFullName: string, path: string): Promise<{ content: string | null }>;
}

export interface DiscoveryQueryDeps {
  github: GitHubClientLike;
  /** Full, unpaginated candidate lists, keyed by a stable scope signature (see scopeCacheKey). */
  resultCache: TtlCache<DiscoveryIndexCandidate[]>;
  /** Resolved AI-policy verdicts, keyed by repoFullName. */
  policyCache: TtlCache<AiPolicyVerdict>;
  cacheTtlMs: number;
}

export const DEFAULT_CACHE_TTL_MS = 300_000;

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label;
      if (label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string") {
        return (label as { name: string }).name;
      }
      return "";
    })
    .filter((name) => name.length > 0);
}

/** `https://api.github.com/repos/{owner}/{repo}` (present on `/search/issues` items) → `owner/repo`, or null
 *  if the field is absent/malformed. */
function extractRepoFullNameFromIssue(issue: GitHubIssue): string | null {
  const repositoryUrl = issue.repository_url;
  if (typeof repositoryUrl !== "string") return null;
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  // A successful match's two `[^/]+` groups can never be empty, so a null-match is the only failure to guard.
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function buildCandidate(repoFullName: string, issue: GitHubIssue, verdict: AiPolicyVerdict): DiscoveryIndexCandidate | null {
  if (issue.pull_request) return null; // the issues-list endpoint includes PRs; the contract is issues-only.
  const issueNumber = issue.number;
  const title = issue.title;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  // repoFullName is always pre-validated `owner/repo` by this function's two callers below (query.repos is
  // normalized by normalizeDiscoveryIndexRequest before it ever reaches this module; search-derived names come
  // from extractRepoFullNameFromIssue's regex, which requires a non-empty segment on each side) — the split
  // below can never produce an empty half.
  const slashIndex = repoFullName.indexOf("/");
  return {
    owner: repoFullName.slice(0, slashIndex),
    repo: repoFullName.slice(slashIndex + 1),
    repoFullName,
    issueNumber,
    title,
    labels: labelNames(issue.labels),
    commentsCount: typeof issue.comments === "number" && Number.isFinite(issue.comments) ? issue.comments : 0,
    createdAt: typeof issue.created_at === "string" ? issue.created_at : null,
    updatedAt: typeof issue.updated_at === "string" ? issue.updated_at : null,
    htmlUrl: typeof issue.html_url === "string" ? issue.html_url : null,
    aiPolicyAllowed: verdict.allowed,
    aiPolicySource: verdict.source,
  };
}

/** Resolve (and cache) a repo's AI-usage-policy verdict: AI-USAGE.md wins if present with real content,
 *  otherwise fall through to CONTRIBUTING.md — mirrors opportunity-fanout.js's resolveRepoAiPolicy exactly
 *  (a present-but-blank AI-USAGE.md must not silently fail open past a ban declared in CONTRIBUTING.md). */
async function resolveRepoAiPolicy(repoFullName: string, deps: DiscoveryQueryDeps): Promise<AiPolicyVerdict> {
  let missed = false;
  const verdict = await deps.policyCache.getOrCompute(repoFullName, deps.cacheTtlMs, async () => {
    missed = true;
    const aiUsage = await deps.github.fetchRepoFile(repoFullName, "AI-USAGE.md");
    if (aiUsage.content !== null && aiUsage.content.trim().length > 0) {
      return resolveAiPolicyVerdict({ aiUsage: aiUsage.content, contributing: null });
    }
    const contributing = await deps.github.fetchRepoFile(repoFullName, "CONTRIBUTING.md");
    return resolveAiPolicyVerdict({ aiUsage: null, contributing: contributing.content });
  });
  incr("discovery_index_cache_lookups_total", { cache: "policy", outcome: missed ? "miss" : "hit" });
  return verdict;
}

function scopeCacheKey(query: DiscoveryIndexQuery): string {
  return JSON.stringify({
    repos: [...query.repos].sort(),
    orgs: [...query.orgs].sort(),
    searchTerms: [...query.searchTerms].sort(),
  });
}

async function computeCandidates(query: DiscoveryIndexQuery, deps: DiscoveryQueryDeps): Promise<DiscoveryIndexCandidate[]> {
  const seen = new Set<string>();
  const candidates: DiscoveryIndexCandidate[] = [];

  const addCandidate = (repoFullName: string, issue: GitHubIssue, verdict: AiPolicyVerdict): void => {
    const candidate = buildCandidate(repoFullName, issue, verdict);
    if (candidate === null) return;
    const key = `${candidate.repoFullName}#${candidate.issueNumber}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const addFromSearch = async (searchIssues: GitHubIssue[]): Promise<void> => {
    for (const issue of searchIssues) {
      const repoFullName = extractRepoFullNameFromIssue(issue);
      if (repoFullName === null) continue;
      const verdict = await resolveRepoAiPolicy(repoFullName, deps);
      if (!verdict.allowed) continue;
      addCandidate(repoFullName, issue, verdict);
    }
  };

  for (const repoFullName of query.repos) {
    const verdict = await resolveRepoAiPolicy(repoFullName, deps);
    if (!verdict.allowed) continue;
    const { issues } = await deps.github.fetchRepoIssues(repoFullName);
    for (const issue of issues) addCandidate(repoFullName, issue, verdict);
  }

  for (const org of query.orgs) {
    const { issues } = await deps.github.searchIssues(`org:${org} state:open type:issue`);
    await addFromSearch(issues);
  }

  for (const term of query.searchTerms) {
    const { issues } = await deps.github.searchIssues(`${term} state:open type:issue`);
    await addFromSearch(issues);
  }

  // Deterministic ordering so pagination offsets are stable across a cache lifetime (and identical for two
  // requests that happen to race a cache miss — see computeCandidates' getOrCompute caller).
  candidates.sort((a, b) => (a.repoFullName === b.repoFullName ? a.issueNumber - b.issueNumber : a.repoFullName.localeCompare(b.repoFullName)));
  return candidates;
}

/**
 * Run a normalized discovery-index query end to end: resolve (from cache or GitHub) the full candidate set
 * for the query's scope, slice it per the request's cursor/limit, and return a response normalized through
 * {@link normalizeDiscoveryIndexResponse} as a structural safety net. If the result cache's TTL expires
 * between two pages of the same walk, the second page is computed from a freshly-fetched result set — this
 * trades strict pagination consistency (a small chance of a skipped/repeated candidate across the boundary)
 * for statelessness (no server-side session/cursor-affinity to manage); acceptable for a rate-limit-mitigation
 * index, not a correctness-critical ledger.
 */
export async function runDiscoveryQuery(query: DiscoveryIndexQuery, deps: DiscoveryQueryDeps): Promise<DiscoveryIndexResponse> {
  const scopeKey = scopeCacheKey(query);
  let missed = false;
  const allCandidates = await deps.resultCache.getOrCompute(scopeKey, deps.cacheTtlMs, () => {
    missed = true;
    return computeCandidates(query, deps);
  });
  incr("discovery_index_cache_lookups_total", { cache: "result", outcome: missed ? "miss" : "hit" });
  const offset = decodeCursor(query.cursor);
  const page = allCandidates.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < allCandidates.length ? encodeCursor(nextOffset) : null;
  const raw: DiscoveryIndexResponse = {
    contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION,
    candidates: page,
    nextCursor,
  };
  return normalizeDiscoveryIndexResponse(raw).response;
}
