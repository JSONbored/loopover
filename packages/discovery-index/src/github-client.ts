// A minimal GitHub REST client for the discovery-index service: its own token, retry-on-5xx/rate-limit,
// and in-process rate-limit-budget tracking — isolated from any other component's GitHub token (REES's,
// the main engine's installation tokens, a miner instance's own token). Adapted from, but not importing,
// packages/loopover-miner/lib/http-retry.js's fetchWithRetry and opportunity-fanout.js's githubGetJson/
// recordRateLimit/nextPageUrl (a different npm workspace package, and built for a much bigger multi-forge/
// historical-backfill system this single-forge server-side fan-out doesn't need) — same retry/backoff/
// rate-limit-observation shape, proportionately smaller.

import { incr } from "./metrics.js";

const API_BASE_URL = "https://api.github.com";
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export interface GitHubIssue {
  number?: unknown;
  title?: unknown;
  labels?: unknown;
  comments?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
  /** Present on `/search/issues` items only — `https://api.github.com/repos/{owner}/{repo}`. */
  repository_url?: unknown;
}

export interface RateLimitObservation {
  remaining: number | null;
  resetAt: string | null;
}

export interface GitHubClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  perPage?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
}

export interface RepoFileResult {
  content: string | null;
}

function defaultBackoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, DEFAULT_BASE_BACKOFF_MS * 2 ** (Math.max(1, attempt) - 1));
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRateLimitStatus(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (response.headers.get("retry-after") != null) return true;
  const remaining = response.headers.get("x-ratelimit-remaining");
  return remaining != null && Number(remaining) === 0;
}

function isRetryableStatus(response: Response): boolean {
  return response.status >= 500 || isRateLimitStatus(response);
}

function retryDelayMs(response: Response, attempt: number, backoffMs: (attempt: number) => number): number {
  const base = backoffMs(attempt);
  // Same null-header gotcha as recordRateLimit above: `Number(null) === 0` would otherwise make an absent
  // header indistinguishable from an explicit "retry-after: 0" and always take the branch below.
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader === null) return base;
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(MAX_BACKOFF_MS, Math.max(base, retryAfterSeconds * 1000));
  }
  return base;
}

/** GitHub's `Link: <url>; rel="next"` header, constrained to the same origin+path as the request that produced
 *  it — a forged Link header can't redirect the next call (and its bearer token) off-origin. */
function nextPageUrl(response: Response, expectedUrl: URL): string | null {
  const linkHeader = response.headers.get("link") ?? "";
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (match === null || !match[1]) return null;
  let nextUrl: URL;
  try {
    nextUrl = new URL(match[1], expectedUrl);
  } catch {
    return null;
  }
  if (nextUrl.protocol !== "https:" || nextUrl.origin !== expectedUrl.origin || nextUrl.pathname !== expectedUrl.pathname) {
    return null;
  }
  return nextUrl.toString();
}

export class GitHubClient {
  private rateLimit: RateLimitObservation = { remaining: null, resetAt: null };
  private readonly fetchImpl: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly perPage: number;
  private readonly maxPages: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly token: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.perPage = options.perPage ?? DEFAULT_PER_PAGE;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
  }

  /** The most recently observed rate-limit state for this client's own token (never another component's). */
  get lastRateLimit(): RateLimitObservation {
    return this.rateLimit;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "loopover-discovery-index",
      "x-github-api-version": "2022-11-28",
      ...extra,
    };
    const token = this.token.trim();
    if (token) base.authorization = `Bearer ${token}`;
    return base;
  }

  private recordRateLimit(response: Response): void {
    // `response.headers.get(...)` returns null when the header is absent, and `Number(null) === 0` -- a
    // naive `Number(header)` would misread "no rate-limit header on this response" as "0 remaining" (a real
    // signal to back off), rather than "no signal". Check for absence explicitly before parsing.
    const remainingHeader = response.headers.get("x-ratelimit-remaining");
    if (remainingHeader !== null) {
      const remaining = Number(remainingHeader);
      if (Number.isFinite(remaining)) {
        this.rateLimit.remaining = this.rateLimit.remaining === null ? remaining : Math.min(this.rateLimit.remaining, remaining);
      }
    }
    const resetHeader = response.headers.get("x-ratelimit-reset");
    if (resetHeader !== null) {
      const resetSeconds = Number(resetHeader);
      if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
        const resetAt = new Date(resetSeconds * 1000).toISOString();
        this.rateLimit.resetAt = this.rateLimit.resetAt === null || resetAt > this.rateLimit.resetAt ? resetAt : this.rateLimit.resetAt;
      }
    }
  }

  private async fetchWithRetry(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit = { method: "GET", headers: this.headers(extraHeaders) };
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetchImpl(
        url,
        this.requestTimeoutMs && this.requestTimeoutMs > 0 ? { ...init, signal: AbortSignal.timeout(this.requestTimeoutMs) } : init,
      );
      this.recordRateLimit(response);
      if (!isRetryableStatus(response) || attempt >= this.maxAttempts) {
        incr("discovery_index_github_requests_total", { outcome: response.ok ? "ok" : "failed" });
        return response;
      }
      incr("discovery_index_github_requests_total", { outcome: "retried" });
      await this.sleepFn(retryDelayMs(response, attempt, this.backoffMs));
    }
  }

  /** GET a whole repo's open issues (PRs excluded server-side is NOT guaranteed by this endpoint — callers must
   *  still filter `pull_request` out of the results), following pagination up to `maxPages`. */
  async fetchRepoIssues(repoFullName: string): Promise<{ issues: GitHubIssue[]; warnings: string[] }> {
    const warnings: string[] = [];
    const issues: GitHubIssue[] = [];
    const expectedUrl = new URL(`/repos/${repoFullName}/issues`, API_BASE_URL);
    expectedUrl.search = `?state=open&per_page=${this.perPage}`;
    let url: string | null = expectedUrl.toString();
    for (let page = 0; url !== null && page < this.maxPages; page += 1) {
      const response: Response = await this.fetchWithRetry(url);
      if (!response.ok) {
        warnings.push(`GitHub returned ${response.status} for ${repoFullName} issues`);
        return { issues, warnings };
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!Array.isArray(payload)) {
        warnings.push(`GitHub returned a non-array issues payload for ${repoFullName}`);
        return { issues, warnings };
      }
      issues.push(...(payload as GitHubIssue[]));
      url = nextPageUrl(response, expectedUrl);
    }
    return { issues, warnings };
  }

  /** GET `/search/issues?q=...`, following pagination up to `maxPages`. */
  async searchIssues(query: string): Promise<{ issues: GitHubIssue[]; warnings: string[] }> {
    const warnings: string[] = [];
    const issues: GitHubIssue[] = [];
    if (!query.trim()) return { issues, warnings };
    const expectedUrl = new URL("/search/issues", API_BASE_URL);
    expectedUrl.search = `?q=${encodeURIComponent(query)}&per_page=${this.perPage}`;
    let url: string | null = expectedUrl.toString();
    for (let page = 0; url !== null && page < this.maxPages; page += 1) {
      const response: Response = await this.fetchWithRetry(url);
      if (!response.ok) {
        warnings.push(`GitHub returned ${response.status} for search "${query}"`);
        return { issues, warnings };
      }
      const payload: unknown = await response.json().catch(() => null);
      const items = payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)
        ? ((payload as { items: GitHubIssue[] }).items)
        : null;
      if (items === null) {
        warnings.push(`GitHub returned a non-array search payload for "${query}"`);
        return { issues, warnings };
      }
      issues.push(...items);
      url = nextPageUrl(response, expectedUrl);
    }
    return { issues, warnings };
  }

  /**
   * GET a repo file's raw content via the Contents API. Returns `{content: null}` on a 404 (file absent) or
   * any non-OK response — a missing/unreadable policy doc degrades to "no policy declared", never an error.
   * The caller (discovery-query.ts) is responsible for its own TTL caching of the resolved verdict; this
   * method always performs a fresh request.
   */
  async fetchRepoFile(repoFullName: string, path: string): Promise<RepoFileResult> {
    const url = new URL(`/repos/${repoFullName}/contents/${encodeURIComponent(path)}`, API_BASE_URL).toString();
    const response = await this.fetchWithRetry(url);
    if (!response.ok) return { content: null };
    const payload: unknown = await response.json().catch(() => null);
    return { content: decodeContentsApiPayload(payload) };
  }
}

function decodeContentsApiPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { content?: unknown; encoding?: unknown };
  if (typeof record.content !== "string") return null;
  if (record.encoding !== "base64") return null;
  // Buffer.from(_, "base64") is lenient (skips invalid characters) and Buffer#toString("utf8") never throws on
  // arbitrary bytes, so there is no error case here to guard — unlike cursor.ts's JSON.parse, which genuinely can.
  return Buffer.from(record.content, "base64").toString("utf8");
}
