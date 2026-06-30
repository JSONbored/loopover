import { Octokit } from "@octokit/core";
import { isGlobalAgentFrozen, recordAuditEvent } from "../db/repositories";
import { isGlobalAgentPause, resolveAgentActionMode, type AgentActionMode } from "../settings/agent-execution";
import { incr } from "../selfhost/metrics";
import type { RepositorySettings } from "../types";

// The SINGLE place an installation-scoped Octokit is built. Every GitHub write in src/github/** routes through
// makeInstallationOctokit; when the repo's action mode is not "live" a request hook SUPPRESSES every
// state-changing verb (POST/PATCH/PUT/DELETE) — auditing the intent and returning a route-shaped synthetic
// response — so NO mutation reaches GitHub during a dry-run / pause / global freeze. GET/HEAD always pass through
// (pure reads + the load-bearing create-vs-update / dedup probes). This makes "no mutation unless live" a
// STRUCTURAL invariant rather than a per-call convention; test/unit/no-direct-octokit.test.ts forbids a raw
// `new Octokit` anywhere else in src/github/**. (#dry-run-chokepoint)
//
// Scope note: this governs INSTALLATION-token Octokit writes only. A few paths write via raw fetch() with
// non-installation tokens (upstream drift issues, contributor-issue drafts, end-user fork drafting) and are NOT
// covered here — they carry their own mode guard / are a separate actor class.

const GITHUB_FETCH_TIMEOUT_MS = 12_000;
const GITHUB_API_PREFIX = "https://api.github.com";
const GITHUB_RESPONSE_CACHE_METRIC = "gittensory_github_response_cache_total";
const DEFAULT_BRANCH_PROTECTION_TTL_SECONDS = 20 * 60;
const DEFAULT_METADATA_TTL_SECONDS = 10 * 60;
export const GITHUB_RESPONSE_CACHE_REPLAY_HEADER = "x-gittensory-cache";

/** A shared cache for safe GitHub GET responses (e.g. Redis on the self-host). Stores only status/body/
 *  content-type plus pagination/validator headers — never rate-limit or encoding headers. Set on the self-host;
 *  the Worker leaves it null. */
export interface CachedGitHubResponse {
  status: number;
  body: string;
  contentType: string;
  link?: string;
  etag?: string;
  lastModified?: string;
}
export interface GitHubResponseCache {
  get(key: string): Promise<CachedGitHubResponse | null>;
  set(key: string, value: CachedGitHubResponse, ttlSeconds?: number): Promise<void>;
}
let responseCache: GitHubResponseCache | null = null;
export function setGitHubResponseCache(cache: GitHubResponseCache | null): void {
  responseCache = cache;
}

export type GitHubCacheClass = "branch_protection" | "metadata";
type EnvLookup = Record<string, string | undefined>;

/** Only cache explicitly stable GitHub REST reads. PR/issue/comment/label/event/check/status reads are mutable
 * review inputs and must always reflect the current GitHub state. Exported for tests. */
export function isCacheableGithubUrl(url: string): boolean {
  return githubCacheClassForUrl(url) !== null;
}

function githubApiPath(url: string): string {
  return url.slice(GITHUB_API_PREFIX.length);
}

function githubCacheClassForUrl(url: string): GitHubCacheClass | null {
  if (!url.startsWith(`${GITHUB_API_PREFIX}/`)) return null;
  const path = githubApiPath(url);
  if (/^\/repos\/[^/]+\/[^/]+\/branches\/[^/]+\/protection\/required_status_checks(?:$|[?#])/.test(path)) return "branch_protection";
  if (
    (/^\/users\/[^/?#]+(?:$|[?#])/.test(path) ||
      /^\/repos\/[^/?#]+\/[^/?#]+(?:$|[?#])/.test(path) ||
      /^\/app\/installations\/\d+(?:$|[?#])/.test(path))
  ) {
    return "metadata";
  }
  return null;
}

function positiveEnvSeconds(env: EnvLookup, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const seconds = Math.floor(value);
  return seconds >= 1 ? seconds : fallback;
}

export function githubResponseCacheTtlSeconds(cls: GitHubCacheClass, env: EnvLookup = process.env): number {
  if (cls === "branch_protection") {
    return positiveEnvSeconds(env, "GITHUB_BRANCH_PROTECTION_CACHE_TTL_SECONDS", DEFAULT_BRANCH_PROTECTION_TTL_SECONDS);
  }
  return positiveEnvSeconds(env, "GITHUB_METADATA_CACHE_TTL_SECONDS", DEFAULT_METADATA_TTL_SECONDS);
}

function hasConditionalRequestHeader(headers: Headers): boolean {
  return headers.has("if-none-match") || headers.has("if-modified-since") || headers.has("if-match") || headers.has("if-unmodified-since");
}

function cacheBypassClass(method: string, url: string, headers: Headers): string {
  if (responseCache === null) return "disabled";
  if (method !== "GET") return "non_get";
  if (!url.startsWith(`${GITHUB_API_PREFIX}/`)) return "non_github";
  if (hasConditionalRequestHeader(headers)) return "conditional";
  return "sensitive";
}

function recordGitHubCacheMetric(result: "hit" | "miss" | "set" | "coalesced" | "bypassed" | "error", cls: string): void {
  incr(GITHUB_RESPONSE_CACHE_METRIC, { result, class: cls });
}

async function sha256Short(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function responseCacheKey(url: string, headers: Headers): Promise<string> {
  const authHash = await sha256Short(headers.get("authorization") || "");
  const accept = encodeURIComponent(headers.get("accept") || "");
  const apiVersion = encodeURIComponent(headers.get("x-github-api-version") || "");
  return `v2:${authHash}:${accept}:${apiVersion}:${url}`;
}

function requestHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : undefined) ?? "GET").toUpperCase();
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof Request !== "undefined" && input instanceof Request ? input.url : String(input);
}

export function isGitHubResponseCacheReplay(response: Response): boolean {
  return response.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER) !== null;
}

// Transient GitHub rate-limit handling (#ratelimit-resilience). A primary (x-ratelimit-remaining:0) or secondary
// (Retry-After / "secondary rate limit" body) limit returns 403/429. Instead of surfacing it as a failure — or
// MISCLASSIFYING a 403 as a permission gap — back off a few times and retry. A sustained limit exhausts the
// retries and the response is returned so the caller (and the queue) handles it. Bounded so a review never stalls.
const GITHUB_RATE_LIMIT_MAX_RETRIES = 3;
const GITHUB_RATE_LIMIT_MAX_DELAY_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Does this GitHub response signal a rate limit (primary or secondary)? 403/429 with a Retry-After header, an
 *  exhausted x-ratelimit-remaining, or a secondary-limit/abuse body. A 403 with NONE of these is a real
 *  permission/other error and must surface — not retry, not be mistaken for a rate limit. Exported for tests. */
export async function isRateLimitedResponse(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.headers.get("retry-after") != null) return true;
  if (response.headers.get("x-ratelimit-remaining") === "0") return true;
  try {
    return /secondary rate limit|\babuse\b|api rate limit exceeded/i.test(await response.clone().text());
    /* v8 ignore next 3 -- defensive: a cloned Response body that fails to read isn't reachable in practice */
  } catch {
    return false;
  }
}

/** How long to wait before the next rate-limit retry: honor a valid Retry-After (seconds), else exponential
 *  backoff — each capped so a review can never stall on one call. A sustained PRIMARY limit (reset up to an hour
 *  out) simply exhausts the few inline retries and the queue retries the job later. Exported for tests. */
export function rateLimitRetryMs(response: Response, attempt: number): number {
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader != null) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, GITHUB_RATE_LIMIT_MAX_DELAY_MS);
  }
  return Math.min(500 * 2 ** attempt, GITHUB_RATE_LIMIT_MAX_DELAY_MS);
}

function responseFromCached(hit: CachedGitHubResponse, replayKind: "hit" | "coalesced"): Response {
  const headers = new Headers({ "content-type": hit.contentType, [GITHUB_RESPONSE_CACHE_REPLAY_HEADER]: replayKind });
  if (hit.link) headers.set("link", hit.link);
  if (hit.etag) headers.set("etag", hit.etag);
  if (hit.lastModified) headers.set("last-modified", hit.lastModified);
  return new Response(hit.body, {
    status: hit.status,
    headers,
  });
}

async function fetchWithGitHubRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<GitHubFetchResult> {
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = init?.signal
        ? await fetch(input, init)
        : await fetch(input, {
            ...(init ?? {}),
            signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
          });
    } catch (error) {
      return { ok: false, error };
    }
    // Retry a transient rate-limit (with backoff) instead of surfacing it; stop once exhausted or it's not a limit.
    if (attempt >= GITHUB_RATE_LIMIT_MAX_RETRIES || !(await isRateLimitedResponse(response))) break;
    await sleep(rateLimitRetryMs(response, attempt));
  }
  return { ok: true, response };
}

async function fetchAndMaybeCacheGitHubGet(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
  cacheKey: string,
  cls: GitHubCacheClass,
): Promise<InFlightCacheableGet> {
  const fetched = await fetchWithGitHubRetry(input, init);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const { response } = fetched;
  if (response.status !== 200) return { ok: true, response, cached: null };
  try {
    const cached = {
      status: 200,
      body: await response.clone().text(),
      contentType: response.headers.get("content-type") ?? "application/json",
      ...(response.headers.get("link") ? { link: response.headers.get("link")! } : {}),
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    };
    await responseCache!.set(cacheKey, cached, githubResponseCacheTtlSeconds(cls));
    recordGitHubCacheMetric("set", cls);
    return { ok: true, response, cached };
  } catch {
    recordGitHubCacheMetric("error", cls);
    return { ok: true, response, cached: null };
  }
}

type InFlightCacheableGet =
  | {
      ok: true;
      response: Response;
      cached: CachedGitHubResponse | null;
    }
  | {
      ok: false;
      error: unknown;
    };

type GitHubFetchResult =
  | {
      ok: true;
      response: Response;
    }
  | {
      ok: false;
      error: unknown;
    };

// Single-flight cacheable GETs inside one isolate: a webhook burst often asks for the same metadata
// before Redis has been populated. Join those cold misses so GitHub sees one request, then replay the cached body.
const inFlightCacheableGets = new Map<string, Promise<InFlightCacheableGet>>();

// A 12s hard cap on every GitHub request. Centralised here so the app token/installation raw fetches plus comment /
// label / check-run / pr-action Octokit helpers all inherit the cache boundary, retry, and timeout behavior.
export async function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = requestMethod(input, init);
  const url = requestUrl(input);
  const headers = requestHeaders(input, init);
  const conditional = hasConditionalRequestHeader(headers);
  const cls = method === "GET" && !conditional ? githubCacheClassForUrl(url) : null;
  const useCache = responseCache !== null && cls !== null;
  if (!useCache) {
    recordGitHubCacheMetric("bypassed", cacheBypassClass(method, url, headers));
    const fetched = await fetchWithGitHubRetry(input, init);
    if (!fetched.ok) throw fetched.error;
    return fetched.response;
  }

  const cacheKey = await responseCacheKey(url, headers);
  let hit: CachedGitHubResponse | null = null;
  try {
    hit = await responseCache!.get(cacheKey);
  } catch {
    recordGitHubCacheMetric("error", cls);
  }
  if (hit) {
    recordGitHubCacheMetric("hit", cls);
    return responseFromCached(hit, "hit");
  }
  recordGitHubCacheMetric("miss", cls);

  const existing = inFlightCacheableGets.get(cacheKey);
  if (existing) {
    recordGitHubCacheMetric("coalesced", cls);
    const replay = await existing;
    if (replay.ok && replay.cached)
      return responseFromCached(replay.cached, "coalesced");
  }

  const request = (async (): Promise<InFlightCacheableGet> => {
    try {
      return await fetchAndMaybeCacheGitHubGet(
        input,
        init,
        url,
        cacheKey,
        cls,
      );
    } catch (error) {
      return { ok: false, error };
    } finally {
      inFlightCacheableGets.delete(cacheKey);
    }
  })();
  inFlightCacheableGets.set(cacheKey, request);
  const result = await request;
  if (!result.ok) throw result.error;
  return result.response;
}

/** Test-only: reset shared GitHub response cache state between tests. */
export function clearGitHubResponseCacheForTest(): void {
  responseCache = null;
  inFlightCacheableGets.clear();
}

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Resolve a repo's agent action mode the SAME way the executor does: the env emergency brake OR the DB global
 * freeze OR the per-repo pause/dry-run. Call this ONCE per review and thread the result into every surface write
 * — it performs one isGlobalAgentFrozen() read, so it must never sit on a per-write hot path.
 */
export async function resolveRepoActionMode(env: Env, settings: Pick<RepositorySettings, "agentPaused" | "agentDryRun"> | null | undefined): Promise<AgentActionMode> {
  return resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
    agentPaused: settings?.agentPaused,
    agentDryRun: settings?.agentDryRun,
  });
}

// A route-shaped synthetic response for a SUPPRESSED write, so every mutation-response reader survives a dry-run:
//  - check-runs: id MUST be truthy AND !== undefined (app.ts tests `if (checkRunId)`, processors test `!== undefined`).
//    -1 satisfies both; 0 would be falsy and is forbidden. The follow-up completion PATCH it feeds is also suppressed.
//  - comments: { id:-1, html_url:"" } — callers read id?.??null / Boolean(id) and tolerate any value.
//  - reviews: { id:-1 } — the executor reads nothing, it only must not throw.
//  - merge (PUT): { merged:true, sha:null } — no reader; a non-throw records the action as a completed shadow.
//  - everything else (labels, update-branch, close, reactions): {} — no reader.
function syntheticWriteResponse(url: string): { status: number; url: string; headers: Record<string, string>; data: unknown } {
  const base = { status: 200, url, headers: {} as Record<string, string> };
  if (/\/check-runs(\/|$|\?)/.test(url)) return { ...base, data: { id: -1, dryRunSuppressed: true } };
  if (/\/comments(\/|$|\?)/.test(url)) return { ...base, data: { id: -1, html_url: "", dryRunSuppressed: true } };
  if (/\/reviews(\/|$|\?)/.test(url)) return { ...base, data: { id: -1, dryRunSuppressed: true } };
  if (/\/merge(\/|$|\?)/.test(url)) return { ...base, data: { merged: true, sha: null, dryRunSuppressed: true } };
  return { ...base, data: { dryRunSuppressed: true } };
}

/**
 * Instance-wide self-host kill switch (#selfhost-deployment-mode). SELFHOST_DEPLOYMENT_MODE=dry-run|disabled
 * forces write suppression for the WHOLE instance regardless of the per-call mode — so a self-host running in
 * PARALLEL with the live cloud App can receive the same webhooks but provably post NOTHING (no check-run /
 * comment / label / merge) until an explicit cutover, without relying on every call site threading the repo mode.
 * Unset (the cloud Worker never sets it) → null → behavior is byte-identical to today.
 */
export function forcedSelfhostMode(env: { SELFHOST_DEPLOYMENT_MODE?: string | undefined }): AgentActionMode | null {
  const m = (env.SELFHOST_DEPLOYMENT_MODE ?? "").trim().toLowerCase();
  if (m === "disabled") return "paused"; // suppress + audit as denied
  if (m === "dry-run" || m === "dry_run") return "dry_run"; // suppress + audit as completed-shadow
  return null; // "live" / unset → no forcing
}

/**
 * Build an installation Octokit from an ALREADY-minted token. Takes the token (not the installationId) so this
 * module never imports createInstallationToken — the mint stays in app.ts via raw fetch and can never be reached
 * by the suppression hook. `mode` defaults to "live", so the action helpers (pr-actions) that are already gated by
 * the executor are not double-denied; surface callers (check-run / comment / label) pass the resolved repo mode.
 * A SELFHOST_DEPLOYMENT_MODE override beats the per-call mode so the whole instance can be forced non-actuating.
 */
export function makeInstallationOctokit(env: Env, token: string, mode: AgentActionMode = "live"): Octokit {
  const octokit = new Octokit({ auth: token, request: { fetch: timeoutFetch } });
  const effectiveMode = forcedSelfhostMode(env) ?? mode;
  if (effectiveMode !== "live") {
    octokit.hook.wrap("request", async (request, options) => {
      const method = options.method.toUpperCase();
      if (!WRITE_METHODS.has(method)) return request(options); // reads + create-vs-update probes always run
      const url = options.url;
      await recordAuditEvent(env, {
        eventType: "github.write.suppressed",
        actor: "gittensory",
        targetKey: url,
        outcome: effectiveMode === "dry_run" ? "completed" : "denied",
        detail: `${effectiveMode}: suppressed ${method} ${url}`,
        metadata: { method, url, mode: effectiveMode },
      }).catch(
        /* v8 ignore next -- fail-safe: an audit-write failure never blocks the suppression itself */
        () => undefined,
      );
      return syntheticWriteResponse(url);
    });
  }
  return octokit;
}
