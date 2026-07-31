import { Buffer } from "node:buffer";
import type { AiPolicyVerdict } from "@loopover/engine";
import { resolveAiPolicyVerdict } from "@loopover/engine";
import type { ForgeConfig } from "./forge-config.js";
import { resolveForgeConfig } from "./forge-config.js";
import type { PolicyDocCache } from "./policy-doc-cache.js";
import type { PolicyVerdictCache } from "./policy-verdict-cache.js";
import {
  DEFAULT_RATE_LIMIT_HIGH_WATER_MARK,
  DEFAULT_RATE_LIMIT_LOW_WATER_MARK,
  resolveThrottledConcurrency,
} from "./discovery-throttle.js";
import { fetchWithRetry } from "./http-retry.js";

export type FanoutTarget = {
  owner: string;
  repo: string;
};

/** Options shared by every fan-out entry point. `apiBaseUrl` is the legacy top-level forge-host override (it still
 * wins over `forge.apiBaseUrl`); `forge` (#4784) carries the rest of the per-tenant forge knobs. `policyDocCache`,
 * when supplied, lets discovery revalidate each repo's policy docs with a conditional GET instead of a full
 * refetch (#4842). `policyVerdictCache`, when supplied, lets discovery reuse an already-resolved verdict once its
 * deciding doc's ETag is confirmed unchanged, instead of re-resolving it (#4843). */
export type FanoutOptions = {
  apiBaseUrl?: string;
  forge?: Partial<ForgeConfig>;
  concurrency?: number;
  rateLimitLowWaterMark?: number;
  rateLimitHighWaterMark?: number;
  perPage?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  sleepFn?: (ms: number) => Promise<unknown>;
  policyDocCache?: PolicyDocCache | null;
  policyVerdictCache?: PolicyVerdictCache | null;
};

export type RawCandidateIssue = {
  owner: string;
  repo: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: string[];
  /** Assignee logins (#7040), already present in the same list/search payload as labels — no extra request. */
  assignees: string[];
  commentsCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  htmlUrl: string | null;
  aiPolicyAllowed: true;
  aiPolicySource: "AI-USAGE.md" | "CONTRIBUTING.md" | "none";
};

export type CandidateIssueWarning = {
  repoFullName: string;
  stage: string;
  message: string;
};

export type CandidateIssueSummary = {
  issues: RawCandidateIssue[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  warnings: CandidateIssueWarning[];
};

/** A normalized fan-out target: `owner`/`repo` plus the derived `owner/repo` display/key form. */
type Target = {
  owner: string;
  repo: string;
  repoFullName: string;
};

type RateLimitSummary = {
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
};

type NormalizedOptions = {
  forge: ForgeConfig;
  apiBaseUrl: string;
  concurrency: number;
  rateLimitLowWaterMark: number;
  rateLimitHighWaterMark: number;
  perPage: number;
  maxPages: number;
  requestTimeoutMs: number;
  sleepFn?: ((ms: number) => Promise<unknown>) | undefined;
  policyDocCache: PolicyDocCache | null;
  policyVerdictCache: PolicyVerdictCache | null;
};

const defaultConcurrency = 5;
// How long a parked worker waits before re-checking the live rate-limit-derived concurrency limit (#4844).
const throttleParkMs = 25;
const defaultPerPage = 100;
// Follow the GitHub Link header past the first page so a repo/search with >100 open issues isn't silently
// truncated (#4831); cap the follow loop so a pathological Link chain can't run away.
const defaultMaxPages = 10;
const defaultRequestTimeoutMs = 10_000;

/** Minimal shape of a raw GitHub issue/search-hit payload -- every field is read defensively (`typeof` /
 *  `Array.isArray` guarded) since it comes straight off the wire. */
type GithubIssuePayload = {
  pull_request?: unknown;
  number?: unknown;
  title?: unknown;
  labels?: unknown;
  assignees?: unknown;
  comments?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  html_url?: unknown;
  repository?: { full_name?: unknown } | null;
  repository_url?: unknown;
};

type ContentPayload = {
  content?: unknown;
  encoding?: unknown;
};

function normalizeLimit(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function targetKey(target: { owner: string; repo: string }): string {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}

function normalizeTargets(targets: unknown): Target[] {
  const seen = new Set<string>();
  const normalized: Target[] = [];
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

function targetFromFullName(fullName: unknown): Target | null {
  if (typeof fullName !== "string") return null;
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) return null;
  return { owner, repo, repoFullName: `${owner}/${repo}` };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Derive owner/repo from a search hit when `repository.full_name` is absent, using the tenant forge's own
// `repoPathPrefix` for the API `repository_url` and a forge-agnostic host for the web `html_url` (#4784). Hardcoding
// `/repos/` and `github.com` here dropped every custom-forge search result whose payload omitted `full_name`.
function targetFromSearchIssue(issue: GithubIssuePayload, forge: ForgeConfig): Target | null {
  const repositoryFullName = targetFromFullName(issue?.repository?.full_name);
  if (repositoryFullName) return repositoryFullName;

  const repoPathPrefix = escapeRegExp(forge.repoPathPrefix.replace(/\/+$/, ""));
  const repositoryUrl =
    typeof issue?.repository_url === "string"
      ? issue.repository_url.match(new RegExp(`${repoPathPrefix}/([^/?#]+)/([^/?#]+)(?:[?#].*)?$`))
      : null;
  if (repositoryUrl) {
    const owner = decodeURIComponent(repositoryUrl[1]!);
    const repo = decodeURIComponent(repositoryUrl[2]!);
    return { owner, repo, repoFullName: `${owner}/${repo}` };
  }

  const htmlUrl =
    typeof issue?.html_url === "string"
      ? issue.html_url.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+(?:[?#].*)?$/)
      : null;
  if (htmlUrl) {
    const owner = decodeURIComponent(htmlUrl[1]!);
    const repo = decodeURIComponent(htmlUrl[2]!);
    return { owner, repo, repoFullName: `${owner}/${repo}` };
  }

  return null;
}

function githubHeaders(githubToken: unknown, forge: ForgeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    accept: forge.acceptHeader,
    "user-agent": forge.userAgent,
    [forge.apiVersionHeader]: forge.apiVersion,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function apiUrl(apiBaseUrl: string, path: string, query = ""): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}${path}${query}`;
}

function repoPath(forge: ForgeConfig, target: Target, suffix: string): string {
  return `${forge.repoPathPrefix}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${suffix}`;
}

function recordRateLimit(summary: RateLimitSummary, response: Response): void {
  // #9678: Headers.get() returns null for an ABSENT header and Number(null) === 0 (which Number.isFinite
  // accepts) -- so a forge/proxy that omits x-ratelimit-remaining used to record a budget of 0 and pin the
  // whole fan-out to serial concurrency. Read the raw value and skip a null/blank header before converting,
  // matching http-retry.ts's `remaining != null` guard; a genuinely-present "0" (or any finite number) is
  // still recorded, and a present-but-non-numeric value is still skipped by Number.isFinite.
  //
  // #10005: GitHub bills the search endpoint and the per-repo contents/list endpoints against two
  // independent primary rate-limit resources ("search" and "core"), each reporting its own resource in
  // x-ratelimit-resource. Folding both into one Math.min'd number recorded the search bucket's tiny
  // per-minute allowance as the run's whole budget, pinning the core-budget-gated fan-out to serial
  // concurrency. Skip a response billed against a resource other than "core"; a response with no
  // x-ratelimit-resource header at all (an older forge/proxy, or every existing test fixture) is still
  // recorded exactly as before.
  const resource = response.headers.get("x-ratelimit-resource");
  if (resource !== null && resource !== "core") return;
  const rawRemaining = response.headers.get("x-ratelimit-remaining");
  if (rawRemaining !== null && rawRemaining.trim() !== "") {
    const remaining = Number(rawRemaining);
    if (Number.isFinite(remaining)) {
      summary.rateLimitRemaining =
        summary.rateLimitRemaining === null
          ? remaining
          : Math.min(summary.rateLimitRemaining, remaining);
    }
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

async function githubGetJson(
  url: string,
  githubToken: unknown,
  summary: RateLimitSummary,
  options: NormalizedOptions,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; payload: unknown }> {
  // Retry a transient 5xx from GitHub before dropping this target's results for the whole run (#4830) — the same
  // discipline as the CI/gate-verdict pollers. A thrown network error still propagates to each caller's try/catch.
  // `extraHeaders` carries per-call additions (e.g. a policy-doc If-None-Match, #4842) on top of the base auth set.
  // requestTimeoutMs bounds each individual attempt so a stalled connection can't hang discovery forever
  // (#miner-github-read-timeouts) -- fetchWithRetry gives each retry its own fresh AbortSignal.timeout().
  // Spread-omit sleepFn when absent rather than passing `sleepFn: undefined` -- FetchWithRetryOptions doesn't
  // widen its optional properties to `| undefined`, and exactOptionalPropertyTypes treats those as different.
  const retryOptions = { ...(options?.sleepFn ? { sleepFn: options.sleepFn } : {}), timeoutMs: options?.requestTimeoutMs };
  const response = await fetchWithRetry(
    fetch as (url: unknown, init?: unknown) => Promise<Response>,
    url,
    { method: "GET", headers: { ...githubHeaders(githubToken, options.forge), ...extraHeaders } },
    retryOptions,
  );
  recordRateLimit(summary, response);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function decodeContentPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const content = payload as ContentPayload;
  if (typeof content.content !== "string") return null;
  if (content.encoding === "base64") {
    return Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  return content.content;
}

function warning(target: Target, stage: string, message: string): CandidateIssueWarning {
  return { repoFullName: target.repoFullName, stage, message };
}

// Read a URL's prior ETag so an unchanged doc can be revalidated with a conditional GET (#4842). A cache that is
// absent, or whose read throws (corrupt/locked file), is treated as a plain miss: the caller does a full fetch,
// per the "never risk a stale policy" rule — the cache only ever makes discovery cheaper, never less correct.
function readCachedPolicyDoc(cache: PolicyDocCache | null, url: string) {
  if (!cache) return null;
  try {
    return cache.get(url);
  } catch {
    return null;
  }
}

function readEtagHeader(response: Response): string | null {
  const etag = response.headers.get("etag");
  return typeof etag === "string" && etag.trim() ? etag : null;
}

// Persist the fresh ETag + body so the NEXT discover run can revalidate instead of re-downloading. Only a real
// ETag paired with decoded content is stored, and a write that throws must never fail discovery (same stale-safe
// rule) — it degrades to "not cached", so the next run simply refetches in full.
function writeCachedPolicyDoc(cache: PolicyDocCache | null, url: string, etag: string | null, content: string | null): void {
  if (!cache || content === null || etag === null) return;
  try {
    cache.put(url, etag, content);
  } catch {
    // Leave this URL uncached; the next run refetches fully rather than serving anything stale.
  }
}

// A bare `owner/repo` is NOT a safe policy-verdict cache key: two different tenant forge hosts (#4784's
// per-tenant `apiBaseUrl`) can each have their own unrelated repo of the same name, and their policy docs are
// wholly independent. Scope the key by host, mirroring policy-doc-cache.js's own precedent of keying on the full
// request URL rather than a bare path.
function policyVerdictCacheKey(apiBaseUrl: string, repoFullName: string): string {
  return `${apiBaseUrl}::${repoFullName}`;
}

// Read a repo scope's previously-resolved verdict for the SAME decisive doc + ETag (#4843). A cache that is
// absent, or whose read throws (corrupt/locked file), is treated as a plain miss — the caller resolves the
// verdict fresh, per the same "never risk a stale policy" rule as the doc cache above.
function readCachedPolicyVerdict(cache: PolicyVerdictCache | null, repoScope: string) {
  if (!cache) return null;
  try {
    return cache.get(repoScope);
  } catch {
    return null;
  }
}

// Persist the freshly-resolved verdict against the ETag of the doc that decided it, so the next run can reuse it
// outright once that ETag is confirmed unchanged. Only ever called with a real ETag; a write that throws must
// never fail discovery — it degrades to "not cached", so the next run just resolves the verdict again.
function writeCachedPolicyVerdict(
  cache: PolicyVerdictCache | null,
  repoScope: string,
  decisiveDoc: "AI-USAGE.md" | "CONTRIBUTING.md",
  etag: string | null,
  verdict: AiPolicyVerdict,
): void {
  if (!cache || etag === null) return;
  try {
    cache.put(repoScope, decisiveDoc, etag, verdict);
  } catch {
    // Leave this repo scope uncached; the next run just resolves the verdict fresh again.
  }
}

async function fetchRepoDoc(
  target: Target,
  path: string,
  githubToken: unknown,
  options: NormalizedOptions,
  summary: RateLimitSummary,
  warnings: CandidateIssueWarning[],
): Promise<{ content: string | null; etag: string | null }> {
  const url = apiUrl(
    options.apiBaseUrl,
    repoPath(options.forge, target, `/contents/${encodeURIComponent(path)}`),
  );
  const cached = readCachedPolicyDoc(options.policyDocCache, url);
  const conditionalHeaders: Record<string, string> = cached ? { "if-none-match": cached.etag } : {};
  try {
    const { response, payload } = await githubGetJson(url, githubToken, summary, options, conditionalHeaders);
    // A 304 only ever follows the If-None-Match we send above, which we only send when `cached` exists — so the
    // cached body is the GitHub-confirmed current content, served with no extra rate-limit spend.
    if (response.status === 304) return { content: cached!.content, etag: cached!.etag };
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

// Resolve a repo scope's AI-usage-policy verdict, reusing a cached one when the deciding doc's ETag hasn't moved
// since it was last resolved (#4843). Only ever consulted with an ETag that a same-run conditional-GET just
// confirmed is current, so a cache hit is exactly as correct as recomputing — it just skips the (cheap, but not
// free) parse.
function resolveOrCacheVerdict(
  cache: PolicyVerdictCache | null,
  repoScope: string,
  decisiveDoc: "AI-USAGE.md" | "CONTRIBUTING.md",
  etag: string | null,
  computeVerdict: () => AiPolicyVerdict,
): AiPolicyVerdict {
  if (etag !== null) {
    const cached = readCachedPolicyVerdict(cache, repoScope);
    if (cached && cached.decisiveDoc === decisiveDoc && cached.etag === etag) return cached.verdict;
  }
  const verdict = computeVerdict();
  writeCachedPolicyVerdict(cache, repoScope, decisiveDoc, etag, verdict);
  return verdict;
}

async function resolveRepoAiPolicy(
  target: Target,
  githubToken: unknown,
  options: NormalizedOptions,
  summary: RateLimitSummary,
  warnings: CandidateIssueWarning[],
): Promise<AiPolicyVerdict> {
  const repoScope = policyVerdictCacheKey(options.apiBaseUrl, target.repoFullName);
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
    return resolveOrCacheVerdict(options.policyVerdictCache, repoScope, "AI-USAGE.md", aiUsageEtag, () =>
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
    repoScope,
    "CONTRIBUTING.md",
    contributingEtag,
    () => resolveAiPolicyVerdict({ aiUsage: null, contributing }),
  );
}

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

// Assignee logins (#7040): GitHub's issue-list/search payloads already carry `assignees` in the same response
// that supplies labels/comments/etc. -- no extra request needed. contribution-profile-filter.js's
// assignee-exclusion rule uses this to drop candidates assigned to a login the target repo considers off-limits
// (its own owner, by default).
function assigneeLogins(assignees: unknown): string[] {
  if (!Array.isArray(assignees)) return [];
  return assignees
    .map((assignee) =>
      assignee && typeof assignee === "object" && typeof (assignee as { login?: unknown }).login === "string"
        ? (assignee as { login: string }).login
        : "",
    )
    .filter((login) => login.length > 0);
}

function normalizeIssue(target: Target, issue: unknown, policySource: RawCandidateIssue["aiPolicySource"]): RawCandidateIssue | null {
  if (!issue || typeof issue !== "object" || (issue as GithubIssuePayload).pull_request) return null;
  const candidate = issue as GithubIssuePayload;
  if (!Number.isInteger(candidate.number) || (candidate.number as number) <= 0) return null;
  if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) return null;
  return {
    owner: target.owner,
    repo: target.repo,
    repoFullName: target.repoFullName,
    issueNumber: candidate.number as number,
    title: candidate.title,
    labels: labelNames(candidate.labels),
    assignees: assigneeLogins(candidate.assignees),
    commentsCount: Number.isFinite(candidate.comments) ? (candidate.comments as number) : 0,
    createdAt: typeof candidate.created_at === "string" ? candidate.created_at : null,
    updatedAt: typeof candidate.updated_at === "string" ? candidate.updated_at : null,
    htmlUrl: typeof candidate.html_url === "string" ? candidate.html_url : null,
    aiPolicyAllowed: true,
    aiPolicySource: policySource,
  };
}

function searchQueryWithIssueQualifiers(searchQuery: unknown, forge: ForgeConfig): string {
  const trimmed = typeof searchQuery === "string" ? searchQuery.trim() : "";
  if (!trimmed) return "";
  return `${trimmed} ${forge.searchQualifiers}`;
}

// The URL of the next page from a GitHub Link header (`<url>; rel="next"`), constrained to the current
// token-bearing GitHub API endpoint so a forged Link header cannot redirect credentials off-origin.
function nextPageUrl(response: Response, apiBaseUrl: string, expectedPath: string): string | null {
  const linkHeader = response.headers.get("link") ?? "";
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (match === null) return null;

  let nextUrl: URL;
  let expectedUrl: URL;
  try {
    expectedUrl = new URL(apiUrl(apiBaseUrl, expectedPath));
    nextUrl = new URL(match[1]!, expectedUrl);
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

async function fetchTargetIssues(
  target: Target,
  githubToken: unknown,
  options: NormalizedOptions,
  summary: RateLimitSummary,
  warnings: CandidateIssueWarning[],
): Promise<RawCandidateIssue[]> {
  const verdict = await resolveRepoAiPolicy(target, githubToken, options, summary, warnings);
  if (!verdict.allowed) return [];

  const issuesPath = repoPath(options.forge, target, "/issues");
  let url: string | null = apiUrl(options.apiBaseUrl, issuesPath, `?state=open&per_page=${options.perPage}`);
  const issues: RawCandidateIssue[] = [];
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

async function fetchSearchIssues(
  searchQuery: unknown,
  githubToken: unknown,
  options: NormalizedOptions,
  summary: RateLimitSummary,
  warnings: CandidateIssueWarning[],
): Promise<GithubIssuePayload[]> {
  const qualifiedQuery = searchQueryWithIssueQualifiers(searchQuery, options.forge);
  if (!qualifiedQuery) return [];

  const searchPath = options.forge.searchEndpoint;
  let url: string | null = apiUrl(
    options.apiBaseUrl,
    searchPath,
    `?q=${encodeURIComponent(qualifiedQuery)}&per_page=${options.perPage}`,
  );
  const items: GithubIssuePayload[] = [];
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
      const searchPayload = payload as { items?: unknown } | null;
      if (!searchPayload || typeof searchPayload !== "object" || !Array.isArray(searchPayload.items)) {
        warnings.push({
          repoFullName: "*",
          stage: "search",
          message: "GitHub returned a non-array search payload",
        });
        return items;
      }
      items.push(...(searchPayload.items as GithubIssuePayload[]));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run `worker` over `items` with a dynamic in-flight cap (#4844). The pool spawns `maxConcurrency` loops, but a
// loop parks (re-checking every `throttleParkMs`) whenever the live `resolveLimit()` — derived from the recorded
// rate-limit budget — is already met by the number of in-flight workers, so effective concurrency tapers off as
// the budget drops instead of sprinting into a 403. `sleepFn` lets tests inject an instant wait for the park.
export async function mapWithConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  resolveLimit: () => number,
  sleepFn?: (ms: number) => Promise<unknown>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
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
        results[index] = await worker(items[index]!, index);
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
function liveConcurrencyResolver(normalizedOptions: NormalizedOptions, summary: RateLimitSummary): () => number {
  return () =>
    resolveThrottledConcurrency(
      normalizedOptions.concurrency,
      summary.rateLimitRemaining,
      normalizedOptions.rateLimitLowWaterMark,
      normalizedOptions.rateLimitHighWaterMark,
    );
}

function normalizeOptions(options: FanoutOptions = {}): NormalizedOptions {
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
    requestTimeoutMs: normalizeLimit(options.requestTimeoutMs, defaultRequestTimeoutMs, 1, 60_000),
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

export async function fetchCandidateIssuesWithSummary(
  targets: FanoutTarget[],
  githubToken: string,
  options: FanoutOptions = {},
): Promise<CandidateIssueSummary> {
  const normalizedOptions = normalizeOptions(options);
  const normalizedTargets = normalizeTargets(targets);
  const summary: RateLimitSummary = {
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  };
  const warnings: CandidateIssueWarning[] = [];
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
export async function fetchCandidateIssues(
  targets: FanoutTarget[],
  githubToken: string,
  options: FanoutOptions = {},
): Promise<RawCandidateIssue[]> {
  const result = await fetchCandidateIssuesWithSummary(targets, githubToken, options);
  return result.issues;
}

export async function searchCandidateIssuesWithSummary(
  searchQuery: string,
  githubToken: string,
  options: FanoutOptions = {},
): Promise<CandidateIssueSummary> {
  const normalizedOptions = normalizeOptions(options);
  const summary: RateLimitSummary = {
    rateLimitRemaining: null,
    rateLimitResetAt: null,
  };
  const warnings: CandidateIssueWarning[] = [];
  const searchItems = await fetchSearchIssues(searchQuery, githubToken, normalizedOptions, summary, warnings);
  const targetsByKey = new Map<string, Target>();
  for (const item of searchItems) {
    if (!item || typeof item !== "object" || item.pull_request) continue;
    const target = targetFromSearchIssue(item, normalizedOptions.forge);
    if (target && !targetsByKey.has(targetKey(target))) targetsByKey.set(targetKey(target), target);
  }

  const policyEntries = await mapWithConcurrency(
    [...targetsByKey.values()],
    normalizedOptions.concurrency,
    async (target): Promise<[string, AiPolicyVerdict]> => {
      const verdict = await resolveRepoAiPolicy(target, githubToken, normalizedOptions, summary, warnings);
      return [targetKey(target), verdict];
    },
    liveConcurrencyResolver(normalizedOptions, summary),
    normalizedOptions.sleepFn,
  );
  const policiesByKey = new Map(policyEntries);
  const issues: RawCandidateIssue[] = [];
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

export async function searchCandidateIssues(
  searchQuery: string,
  githubToken: string,
  options: FanoutOptions = {},
): Promise<RawCandidateIssue[]> {
  const result = await searchCandidateIssuesWithSummary(searchQuery, githubToken, options);
  return result.issues;
}
