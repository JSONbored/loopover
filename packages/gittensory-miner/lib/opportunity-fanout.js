import { Buffer } from "node:buffer";
import { resolveAiPolicyVerdict } from "@jsonbored/gittensory-engine";
import { resolveForgeConfig } from "./forge-config.js";
import {
  DEFAULT_RATE_LIMIT_HIGH_WATER_MARK,
  DEFAULT_RATE_LIMIT_LOW_WATER_MARK,
  resolveThrottledConcurrency,
} from "./discovery-throttle.js";
import { fetchWithRetry } from "./http-retry.js";

const defaultConcurrency = 5;
// How long a parked worker waits before re-checking the live rate-limit-derived concurrency limit (#4844).
const throttleParkMs = 25;
const defaultPerPage = 100;
// Follow the GitHub Link header past the first page so a repo/search with >100 open issues isn't silently
// truncated (#4831); cap the follow loop so a pathological Link chain can't run away.
const defaultMaxPages = 10;

function normalizeLimit(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function targetKey(target) {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}

function normalizeTargets(targets) {
  const seen = new Set();
  const normalized = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    const owner = typeof target?.owner === "string" ? target.owner.trim() : "";
    const repo = typeof target?.repo === "string" ? target.repo.trim() : "";
    if (!owner || !repo) continue;
    const key = targetKey({ owner, repo });
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ owner, repo, repoFullName: `${owner}/${repo}` });
  }
  return normalized;
}

function targetFromFullName(fullName) {
  if (typeof fullName !== "string") return null;
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) return null;
  return { owner, repo, repoFullName: `${owner}/${repo}` };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Derive owner/repo from a search hit when `repository.full_name` is absent, using the tenant forge's own
// `repoPathPrefix` for the API `repository_url` and a forge-agnostic host for the web `html_url` (#4784). Hardcoding
// `/repos/` and `github.com` here dropped every custom-forge search result whose payload omitted `full_name`.
function targetFromSearchIssue(issue, forge) {
  const repositoryFullName = targetFromFullName(issue?.repository?.full_name);
  if (repositoryFullName) return repositoryFullName;

  const repoPathPrefix = escapeRegExp(forge.repoPathPrefix.replace(/\/+$/, ""));
  const repositoryUrl =
    typeof issue?.repository_url === "string"
      ? issue.repository_url.match(new RegExp(`${repoPathPrefix}/([^/?#]+)/([^/?#]+)(?:[?#].*)?$`))
      : null;
  if (repositoryUrl) {
    const owner = decodeURIComponent(repositoryUrl[1]);
    const repo = decodeURIComponent(repositoryUrl[2]);
    return { owner, repo, repoFullName: `${owner}/${repo}` };
  }

  const htmlUrl =
    typeof issue?.html_url === "string"
      ? issue.html_url.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+(?:[?#].*)?$/)
      : null;
  if (htmlUrl) {
    const owner = decodeURIComponent(htmlUrl[1]);
    const repo = decodeURIComponent(htmlUrl[2]);
    return { owner, repo, repoFullName: `${owner}/${repo}` };
  }

  return null;
}

function githubHeaders(githubToken, forge) {
  const headers = {
    accept: forge.acceptHeader,
    "user-agent": forge.userAgent,
    [forge.apiVersionHeader]: forge.apiVersion,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function apiUrl(apiBaseUrl, path, query = "") {
  return `${apiBaseUrl.replace(/\/+$/, "")}${path}${query}`;
}

function repoPath(forge, target, suffix) {
  return `${forge.repoPathPrefix}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${suffix}`;
}

function recordRateLimit(summary, response) {
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(remaining)) {
    summary.rateLimitRemaining =
      summary.rateLimitRemaining === null
        ? remaining
        : Math.min(summary.rateLimitRemaining, remaining);
  }
  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    const resetAt = new Date(resetSeconds * 1000).toISOString();
    summary.rateLimitResetAt =
      summary.rateLimitResetAt === null || resetAt > summary.rateLimitResetAt
        ? resetAt
        : summary.rateLimitResetAt;
  }
}

async function githubGetJson(url, githubToken, summary, options, extraHeaders = {}) {
  // Retry a transient 5xx from GitHub before dropping this target's results for the whole run (#4830) — the same
  // discipline as the CI/gate-verdict pollers. A thrown network error still propagates to each caller's try/catch.
  // `extraHeaders` carries per-call additions (e.g. a policy-doc If-None-Match, #4842) on top of the base auth set.
  const response = await fetchWithRetry(
    fetch,
    url,
    { method: "GET", headers: { ...githubHeaders(githubToken, options.forge), ...extraHeaders } },
    { sleepFn: options?.sleepFn },
  );
  recordRateLimit(summary, response);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function decodeContentPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.content !== "string") return null;
  if (payload.encoding === "base64") {
    return Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  return payload.content;
}

function warning(target, stage, message) {
  return { repoFullName: target.repoFullName, stage, message };
}

// Read a URL's prior ETag so an unchanged doc can be revalidated with a conditional GET (#4842). A cache that is
// absent, or whose read throws (corrupt/locked file), is treated as a plain miss: the caller does a full fetch,
// per the "never risk a stale policy" rule — the cache only ever makes discovery cheaper, never less correct.
function readCachedPolicyDoc(cache, url) {
  if (!cache) return null;
  try {
    return cache.get(url);
  } catch {
    return null;
  }
}

function readEtagHeader(response) {
  const etag = response.headers.get("etag");
  return typeof etag === "string" && etag.trim() ? etag : null;
}

// Persist the fresh ETag + body so the NEXT discover run can revalidate instead of re-downloading. Only a real
// ETag paired with decoded content is stored, and a write that throws must never fail discovery (same stale-safe
// rule) — it degrades to "not cached", so the next run simply refetches in full.
function writeCachedPolicyDoc(cache, url, etag, content) {
  if (!cache || content === null || etag === null) return;
  try {
    cache.put(url, etag, content);
  } catch {
    // Leave this URL uncached; the next run refetches fully rather than serving anything stale.
  }
}

// Read a repo's previously-resolved verdict for the SAME decisive doc + ETag (#4843). A cache that is absent, or
// whose read throws (corrupt/locked file), is treated as a plain miss — the caller resolves the verdict fresh,
// per the same "never risk a stale policy" rule as the doc cache above.
function readCachedPolicyVerdict(cache, repoFullName) {
  if (!cache) return null;
  try {
    return cache.get(repoFullName);
  } catch {
    return null;
  }
}

// Persist the freshly-resolved verdict against the ETag of the doc that decided it, so the next run can reuse it
// outright once that ETag is confirmed unchanged. Only ever called with a real ETag; a write that throws must
// never fail discovery — it degrades to "not cached", so the next run just resolves the verdict again.
function writeCachedPolicyVerdict(cache, repoFullName, decisiveDoc, etag, verdict) {
  if (!cache || etag === null) return;
  try {
    cache.put(repoFullName, decisiveDoc, etag, verdict);
  } catch {
    // Leave this repo uncached; the next run just resolves the verdict fresh again.
  }
}

async function fetchRepoDoc(target, path, githubToken, options, summary, warnings) {
  const url = apiUrl(
    options.apiBaseUrl,
    repoPath(options.forge, target, `/contents/${encodeURIComponent(path)}`),
  );
  const cached = readCachedPolicyDoc(options.policyDocCache, url);
  const conditionalHeaders = cached ? { "if-none-match": cached.etag } : {};
  try {
    const { response, payload } = await githubGetJson(url, githubToken, summary, options, conditionalHeaders);
    // A 304 only ever follows the If-None-Match we send above, which we only send when `cached` exists — so the
    // cached body is the GitHub-confirmed current content, served with no extra rate-limit spend.
    if (response.status === 304) return { content: cached.content, etag: cached.etag };
    if (response.status === 404) return { content: null, etag: null };
    if (!response.ok) {
      warnings.push(warning(target, `policy:${path}`, `GitHub returned ${response.status}`));
      return { content: null, etag: null };
    }
    const content = decodeContentPayload(payload);
    const etag = readEtagHeader(response);
    writeCachedPolicyDoc(options.policyDocCache, url, etag, content);
    return { content, etag };
  } catch (error) {
    warnings.push(
      warning(target, `policy:${path}`, error instanceof Error ? error.message : "policy fetch failed"),
    );
    return { content: null, etag: null };
  }
}

// Resolve a repo's AI-usage-policy verdict, reusing a cached one when the deciding doc's ETag hasn't moved since
// it was last resolved (#4843). Only ever consulted with an ETag that a same-run conditional-GET just confirmed
// is current, so a cache hit is exactly as correct as recomputing — it just skips the (cheap, but not free) parse.
function resolveOrCacheVerdict(cache, repoFullName, decisiveDoc, etag, computeVerdict) {
  if (etag !== null) {
    const cached = readCachedPolicyVerdict(cache, repoFullName);
    if (cached && cached.decisiveDoc === decisiveDoc && cached.etag === etag) return cached.verdict;
  }
  const verdict = computeVerdict();
  writeCachedPolicyVerdict(cache, repoFullName, decisiveDoc, etag, verdict);
  return verdict;
}

async function resolveRepoAiPolicy(target, githubToken, options, summary, warnings) {
  const { content: aiUsage, etag: aiUsageEtag } = await fetchRepoDoc(
    target,
    "AI-USAGE.md",
    githubToken,
    options,
    summary,
    warnings,
  );
  // Short-circuit only on AI-USAGE.md that has real content. A present-but-blank AI-USAGE.md must still fall
  // through to CONTRIBUTING.md — otherwise a stub AI-USAGE.md silently fails open and swallows a ban declared in
  // CONTRIBUTING.md (the exact case resolveAiPolicyVerdict was fixed to handle in #2900, which can only fire if
  // both docs reach it).
  if (aiUsage !== null && aiUsage.trim().length > 0) {
    return resolveOrCacheVerdict(options.policyVerdictCache, target.repoFullName, "AI-USAGE.md", aiUsageEtag, () =>
      resolveAiPolicyVerdict({ aiUsage, contributing: null }),
    );
  }
  const { content: contributing, etag: contributingEtag } = await fetchRepoDoc(
    target,
    "CONTRIBUTING.md",
    githubToken,
    options,
    summary,
    warnings,
  );
  return resolveOrCacheVerdict(
    options.policyVerdictCache,
    target.repoFullName,
    "CONTRIBUTING.md",
    contributingEtag,
    () => resolveAiPolicyVerdict({ aiUsage: null, contributing }),
  );
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label;
      if (label && typeof label === "object" && typeof label.name === "string") return label.name;
      return "";
    })
    .filter((name) => name.length > 0);
}

function normalizeIssue(target, issue, policySource) {
  if (!issue || typeof issue !== "object" || issue.pull_request) return null;
  if (!Number.isInteger(issue.number) || issue.number <= 0) return null;
  if (typeof issue.title !== "string" || issue.title.trim().length === 0) return null;
  return {
    owner: target.owner,
    repo: target.repo,
    repoFullName: target.repoFullName,
    issueNumber: issue.number,
    title: issue.title,
    labels: labelNames(issue.labels),
    commentsCount: Number.isFinite(issue.comments) ? issue.comments : 0,
    createdAt: typeof issue.created_at === "string" ? issue.created_at : null,
    updatedAt: typeof issue.updated_at === "string" ? issue.updated_at : null,
    htmlUrl: typeof issue.html_url === "string" ? issue.html_url : null,
    aiPolicyAllowed: true,
    aiPolicySource: policySource,
  };
}

function searchQueryWithIssueQualifiers(searchQuery, forge) {
  const trimmed = typeof searchQuery === "string" ? searchQuery.trim() : "";
  if (!trimmed) return "";
  return `${trimmed} ${forge.searchQualifiers}`;
}

// The URL of the next page from a GitHub Link header (`<url>; rel="next"`), constrained to the current
// token-bearing GitHub API endpoint so a forged Link header cannot redirect credentials off-origin.
function nextPageUrl(response, apiBaseUrl, expectedPath) {
  const linkHeader = response.headers.get("link") ?? "";
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (match === null) return null;

  let nextUrl;
  let expectedUrl;
  try {
    expectedUrl = new URL(apiUrl(apiBaseUrl, expectedPath));
    nextUrl = new URL(match[1], expectedUrl);
  } catch {
    return null;
  }

  if (
    nextUrl.protocol !== "https:" ||
    nextUrl.origin !== expectedUrl.origin ||
    nextUrl.pathname !== expectedUrl.pathname
  ) {
    return null;
  }
  return nextUrl.toString();
}

async function fetchTargetIssues(target, githubToken, options, summary, warnings) {
  const verdict = await resolveRepoAiPolicy(target, githubToken, options, summary, warnings);
  if (!verdict.allowed) return [];

  const issuesPath = repoPath(options.forge, target, "/issues");
  let url = apiUrl(options.apiBaseUrl, issuesPath, `?state=open&per_page=${options.perPage}`);
  const issues = [];
  try {
    for (let page = 0; url !== null && page < options.maxPages; page += 1) {
      const { response, payload } = await githubGetJson(url, githubToken, summary, options);
      if (!response.ok) {
        warnings.push(warning(target, "issues", `GitHub returned ${response.status}`));
        return issues;
      }
      if (!Array.isArray(payload)) {
        warnings.push(warning(target, "issues", "GitHub returned a non-array issues payload"));
        return issues;
      }
      for (const issue of payload) {
        const normalized = normalizeIssue(target, issue, verdict.source);
        if (normalized !== null) issues.push(normalized);
      }
      url = nextPageUrl(response, options.apiBaseUrl, issuesPath);
    }
    return issues;
  } catch (error) {
    warnings.push(
      warning(target, "issues", error instanceof Error ? error.message : "issue fetch failed"),
    );
    return issues;
  }
}

async function fetchSearchIssues(searchQuery, githubToken, options, summary, warnings) {
  const qualifiedQuery = searchQueryWithIssueQualifiers(searchQuery, options.forge);
  if (!qualifiedQuery) return [];

  const searchPath = options.forge.searchEndpoint;
  let url = apiUrl(
    options.apiBaseUrl,
    searchPath,
    `?q=${encodeURIComponent(qualifiedQuery)}&per_page=${options.perPage}`,
  );
  const items = [];
  try {
    for (let page = 0; url !== null && page < options.maxPages; page += 1) {
      const { response, payload } = await githubGetJson(url, githubToken, summary, options);
      if (!response.ok) {
        warnings.push({
          repoFullName: "*",
          stage: "search",
          message: `GitHub returned ${response.status}`,
        });
        return items;
      }
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
        warnings.push({
          repoFullName: "*",
          stage: "search",
          message: "GitHub returned a non-array search payload",
        });
        return items;
      }
      items.push(...payload.items);
      url = nextPageUrl(response, options.apiBaseUrl, searchPath);
    }
    return items;
  } catch (error) {
    warnings.push({
      repoFullName: "*",
      stage: "search",
      message: error instanceof Error ? error.message : "issue search failed",
    });
    return items;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run `worker` over `items` with a dynamic in-flight cap (#4844). The pool spawns `maxConcurrency` loops, but a
// loop parks (re-checking every `throttleParkMs`) whenever the live `resolveLimit()` — derived from the recorded
// rate-limit budget — is already met by the number of in-flight workers, so effective concurrency tapers off as
// the budget drops instead of sprinting into a 403. `sleepFn` lets tests inject an instant wait for the park.
export async function mapWithConcurrency(items, maxConcurrency, worker, resolveLimit, sleepFn) {
  const results = new Array(items.length);
  const sleep = sleepFn ?? delay;
  let next = 0;
  let active = 0;
  const runOne = async () => {
    while (next < items.length) {
      // Park while the live limit is already saturated. The check and the `active`/`next` bumps below run without
      // an intervening await, so two loops can never claim the same slot.
      while (active >= resolveLimit()) {
        await sleep(throttleParkMs);
      }
      // The shared cursor can be drained by other loops while this one is parked, so re-check before claiming.
      if (next >= items.length) return;
      const index = next;
      next += 1;
      active += 1;
      try {
        results[index] = await worker(items[index], index);
      } finally {
        active -= 1;
      }
    }
  };
  const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

/** A live limit resolver for `mapWithConcurrency`, reading the summary's rate-limit budget as it is updated (#4844). */
function liveConcurrencyResolver(normalizedOptions, summary) {
  return () =>
    resolveThrottledConcurrency(
      normalizedOptions.concurrency,
      summary.rateLimitRemaining,
      normalizedOptions.rateLimitLowWaterMark,
      normalizedOptions.rateLimitHighWaterMark,
    );
}

function normalizeOptions(options = {}) {
  // A legacy top-level `apiBaseUrl` (the pre-#4784 GitHub-Enterprise override every existing caller uses) still wins
  // over `forge.apiBaseUrl`, so nothing that already passes `apiBaseUrl` changes behavior.
  const apiBaseUrlOverride =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
      ? { apiBaseUrl: options.apiBaseUrl }
      : {};
  const forge = resolveForgeConfig({ ...(options.forge ?? {}), ...apiBaseUrlOverride });
  return {
    forge,
    apiBaseUrl: forge.apiBaseUrl,
    concurrency: normalizeLimit(options.concurrency, defaultConcurrency, 1, 10),
    // Below/above these recorded-rate-limit-remaining marks the fanout serializes / runs at full concurrency; in
    // between it scales down linearly (#4844).
    rateLimitLowWaterMark: normalizeLimit(
      options.rateLimitLowWaterMark,
      DEFAULT_RATE_LIMIT_LOW_WATER_MARK,
      0,
      1_000_000,
    ),
    rateLimitHighWaterMark: normalizeLimit(
      options.rateLimitHighWaterMark,
      DEFAULT_RATE_LIMIT_HIGH_WATER_MARK,
      1,
      1_000_000,
    ),
    perPage: normalizeLimit(options.perPage, defaultPerPage, 1, 100),
    maxPages: normalizeLimit(options.maxPages, defaultMaxPages, 1, 100),
    // Passed through to the per-fetch retry so tests can inject an instant sleep; undefined uses the real backoff.
    sleepFn: typeof options.sleepFn === "function" ? options.sleepFn : undefined,
    // Optional local ETag cache for policy-doc revalidation (#4842). Absent (null) => every policy doc is fetched
    // in full, exactly as before; discover-cli.js supplies the real on-disk store for a live run.
    policyDocCache: options.policyDocCache ?? null,
    // Optional local cache of resolved policy verdicts (#4843). Absent (null) => every verdict is resolved fresh,
    // exactly as before; discover-cli.js supplies the real on-disk store for a live run.
    policyVerdictCache: options.policyVerdictCache ?? null,
  };
}

export async function fetchCandidateIssuesWithSummary(targets, githubToken, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const normalizedTargets = normalizeTargets(targets);
  const summary = {
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  };
  const warnings = [];
  const batches = await mapWithConcurrency(
    normalizedTargets,
    normalizedOptions.concurrency,
    (target) => fetchTargetIssues(target, githubToken, normalizedOptions, summary, warnings),
    liveConcurrencyResolver(normalizedOptions, summary),
    normalizedOptions.sleepFn,
  );
  return {
    issues: batches.flat(),
    rateLimitRemaining: summary.rateLimitRemaining,
    rateLimitResetAt: summary.rateLimitResetAt,
    warnings,
  };
}

/**
 * Metadata-only GitHub discovery (#2307): never clones source, never fetches blobs beyond small policy docs,
 * never uploads source, and never performs writes. Call the WithSummary variant when rate-limit telemetry is
 * needed.
 */
export async function fetchCandidateIssues(targets, githubToken, options = {}) {
  const result = await fetchCandidateIssuesWithSummary(targets, githubToken, options);
  return result.issues;
}

export async function searchCandidateIssuesWithSummary(searchQuery, githubToken, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const summary = {
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  };
  const warnings = [];
  const searchItems = await fetchSearchIssues(searchQuery, githubToken, normalizedOptions, summary, warnings);
  const targetsByKey = new Map();
  for (const item of searchItems) {
    if (!item || typeof item !== "object" || item.pull_request) continue;
    const target = targetFromSearchIssue(item, normalizedOptions.forge);
    if (target && !targetsByKey.has(targetKey(target))) targetsByKey.set(targetKey(target), target);
  }

  const policyEntries = await mapWithConcurrency(
    [...targetsByKey.values()],
    normalizedOptions.concurrency,
    async (target) => {
      const verdict = await resolveRepoAiPolicy(target, githubToken, normalizedOptions, summary, warnings);
      return [targetKey(target), verdict];
    },
    liveConcurrencyResolver(normalizedOptions, summary),
    normalizedOptions.sleepFn,
  );
  const policiesByKey = new Map(policyEntries);
  const issues = [];
  for (const item of searchItems) {
    const target = targetFromSearchIssue(item, normalizedOptions.forge);
    if (!target) continue;
    const policy = policiesByKey.get(targetKey(target));
    if (!policy?.allowed) continue;
    const normalizedIssue = normalizeIssue(target, item, policy.source);
    if (normalizedIssue) issues.push(normalizedIssue);
  }

  return {
    issues,
    rateLimitRemaining: summary.rateLimitRemaining,
    rateLimitResetAt: summary.rateLimitResetAt,
    warnings,
  };
}

export async function searchCandidateIssues(searchQuery, githubToken, options = {}) {
  const result = await searchCandidateIssuesWithSummary(searchQuery, githubToken, options);
  return result.issues;
}
