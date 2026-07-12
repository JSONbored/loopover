import { Buffer } from "node:buffer";
import { resolveAiPolicyVerdict } from "@jsonbored/gittensory-engine";
import { fetchWithRetry } from "./http-retry.js";

const defaultApiBaseUrl = "https://api.github.com";
const defaultConcurrency = 5;
const defaultPerPage = 100;
// Overall pagination cap per fetch path (maxPages × perPage results) to avoid a runaway follow loop (#4831).
const defaultMaxPages = 10;
const githubApiVersion = "2022-11-28";

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

function targetFromSearchIssue(issue) {
  const repositoryFullName = targetFromFullName(issue?.repository?.full_name);
  if (repositoryFullName) return repositoryFullName;

  const repositoryUrl =
    typeof issue?.repository_url === "string"
      ? issue.repository_url.match(/\/repos\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/)
      : null;
  if (repositoryUrl) {
    const owner = decodeURIComponent(repositoryUrl[1]);
    const repo = decodeURIComponent(repositoryUrl[2]);
    return { owner, repo, repoFullName: `${owner}/${repo}` };
  }

  const htmlUrl =
    typeof issue?.html_url === "string"
      ? issue.html_url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+(?:[?#].*)?$/)
      : null;
  if (htmlUrl) {
    const owner = decodeURIComponent(htmlUrl[1]);
    const repo = decodeURIComponent(htmlUrl[2]);
    return { owner, repo, repoFullName: `${owner}/${repo}` };
  }

  return null;
}

function githubHeaders(githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "gittensory-miner",
    "x-github-api-version": githubApiVersion,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function apiUrl(apiBaseUrl, path, query = "") {
  return `${apiBaseUrl.replace(/\/+$/, "")}${path}${query}`;
}

function repoPath(target, suffix) {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${suffix}`;
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

async function githubGetJson(url, githubToken, summary, options) {
  // Retry a transient 5xx from GitHub before dropping this target's results for the whole run (#4830) — the same
  // discipline as the CI/gate-verdict pollers. A thrown network error still propagates to each caller's try/catch.
  const response = await fetchWithRetry(
    fetch,
    url,
    { method: "GET", headers: githubHeaders(githubToken) },
    { sleepFn: options?.sleepFn },
  );
  recordRateLimit(summary, response);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

/** Parse a GitHub `Link` header for the `rel="next"` page URL, or null when there is no next page. Pure. */
export function nextPageUrl(linkHeader) {
  if (typeof linkHeader !== "string") return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch every page starting at `firstUrl`, following the `Link` header's `rel="next"` up to `maxPages` (a cap to
 * avoid runaway fetches). `extractPage(payload)` pulls one page's item array out of its payload, or returns null
 * for a malformed payload. Returns `{ items }` on full success, or `{ items, notOk }` / `{ items, badPayload }`
 * when a page failed — `items` holds whatever was collected from the earlier pages so a later failure never
 * discards the results already fetched. A thrown error propagates to the caller's try/catch.
 */
async function fetchAllPages(firstUrl, githubToken, summary, options, extractPage, maxPages) {
  const items = [];
  let url = firstUrl;
  let pages = 0;
  while (url && pages < maxPages) {
    pages += 1;
    const { response, payload } = await githubGetJson(url, githubToken, summary, options);
    if (!response.ok) return { items, notOk: response };
    const page = extractPage(payload);
    if (page === null) return { items, badPayload: true };
    items.push(...page);
    url = nextPageUrl(response.headers.get("link"));
  }
  return { items };
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

async function fetchRepoDoc(target, path, githubToken, options, summary, warnings) {
  const url = apiUrl(
    options.apiBaseUrl,
    repoPath(target, `/contents/${encodeURIComponent(path)}`),
  );
  try {
    const { response, payload } = await githubGetJson(url, githubToken, summary, options);
    if (response.status === 404) return null;
    if (!response.ok) {
      warnings.push(warning(target, `policy:${path}`, `GitHub returned ${response.status}`));
      return null;
    }
    return decodeContentPayload(payload);
  } catch (error) {
    warnings.push(
      warning(target, `policy:${path}`, error instanceof Error ? error.message : "policy fetch failed"),
    );
    return null;
  }
}

async function resolveRepoAiPolicy(target, githubToken, options, summary, warnings) {
  const aiUsage = await fetchRepoDoc(target, "AI-USAGE.md", githubToken, options, summary, warnings);
  // Short-circuit only on AI-USAGE.md that has real content. A present-but-blank AI-USAGE.md must still fall
  // through to CONTRIBUTING.md — otherwise a stub AI-USAGE.md silently fails open and swallows a ban declared in
  // CONTRIBUTING.md (the exact case resolveAiPolicyVerdict was fixed to handle in #2900, which can only fire if
  // both docs reach it).
  if (aiUsage !== null && aiUsage.trim().length > 0) {
    return resolveAiPolicyVerdict({ aiUsage, contributing: null });
  }
  const contributing = await fetchRepoDoc(
    target,
    "CONTRIBUTING.md",
    githubToken,
    options,
    summary,
    warnings,
  );
  return resolveAiPolicyVerdict({ aiUsage: null, contributing });
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

function searchQueryWithIssueQualifiers(searchQuery) {
  const trimmed = typeof searchQuery === "string" ? searchQuery.trim() : "";
  if (!trimmed) return "";
  return `${trimmed} state:open type:issue`;
}

async function fetchTargetIssues(target, githubToken, options, summary, warnings) {
  const verdict = await resolveRepoAiPolicy(target, githubToken, options, summary, warnings);
  if (!verdict.allowed) return [];

  const url = apiUrl(
    options.apiBaseUrl,
    repoPath(target, "/issues"),
    `?state=open&per_page=${options.perPage}`,
  );
  try {
    const { items, notOk, badPayload } = await fetchAllPages(
      url,
      githubToken,
      summary,
      options,
      (payload) => (Array.isArray(payload) ? payload : null),
      options.maxPages,
    );
    if (notOk) warnings.push(warning(target, "issues", `GitHub returned ${notOk.status}`));
    else if (badPayload) warnings.push(warning(target, "issues", "GitHub returned a non-array issues payload"));
    return items
      .map((issue) => normalizeIssue(target, issue, verdict.source))
      .filter((issue) => issue !== null);
  } catch (error) {
    warnings.push(
      warning(target, "issues", error instanceof Error ? error.message : "issue fetch failed"),
    );
    return [];
  }
}

async function fetchSearchIssues(searchQuery, githubToken, options, summary, warnings) {
  const qualifiedQuery = searchQueryWithIssueQualifiers(searchQuery);
  if (!qualifiedQuery) return [];

  const url = apiUrl(
    options.apiBaseUrl,
    "/search/issues",
    `?q=${encodeURIComponent(qualifiedQuery)}&per_page=${options.perPage}`,
  );
  try {
    const { items, notOk, badPayload } = await fetchAllPages(
      url,
      githubToken,
      summary,
      options,
      (payload) => (payload && typeof payload === "object" && Array.isArray(payload.items) ? payload.items : null),
      options.maxPages,
    );
    if (notOk) {
      warnings.push({ repoFullName: "*", stage: "search", message: `GitHub returned ${notOk.status}` });
    } else if (badPayload) {
      warnings.push({ repoFullName: "*", stage: "search", message: "GitHub returned a non-array search payload" });
    }
    return items;
  } catch (error) {
    warnings.push({
      repoFullName: "*",
      stage: "search",
      message: error instanceof Error ? error.message : "issue search failed",
    });
    return [];
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeOptions(options = {}) {
  return {
    apiBaseUrl:
      typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
        ? options.apiBaseUrl.trim()
        : defaultApiBaseUrl,
    concurrency: normalizeLimit(options.concurrency, defaultConcurrency, 1, 10),
    perPage: normalizeLimit(options.perPage, defaultPerPage, 1, 100),
    maxPages: normalizeLimit(options.maxPages, defaultMaxPages, 1, 50),
    // Passed through to the per-fetch retry so tests can inject an instant sleep; undefined uses the real backoff.
    sleepFn: typeof options.sleepFn === "function" ? options.sleepFn : undefined,
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
  const batches = await mapWithConcurrency(normalizedTargets, normalizedOptions.concurrency, (target) =>
    fetchTargetIssues(target, githubToken, normalizedOptions, summary, warnings),
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
    const target = targetFromSearchIssue(item);
    if (target && !targetsByKey.has(targetKey(target))) targetsByKey.set(targetKey(target), target);
  }

  const policyEntries = await mapWithConcurrency(
    [...targetsByKey.values()],
    normalizedOptions.concurrency,
    async (target) => {
      const verdict = await resolveRepoAiPolicy(target, githubToken, normalizedOptions, summary, warnings);
      return [targetKey(target), verdict];
    },
  );
  const policiesByKey = new Map(policyEntries);
  const issues = [];
  for (const item of searchItems) {
    const target = targetFromSearchIssue(item);
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
