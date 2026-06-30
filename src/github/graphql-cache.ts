import {
  GITHUB_RESPONSE_CACHE_REPLAY_HEADER,
  getGitHubResponseCache,
  isRateLimitedResponse,
  rateLimitRetryMs,
  type CachedGitHubResponse,
} from "./client";
import { incr } from "../selfhost/metrics";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_GRAPHQL_CACHE_METRIC = "gittensory_github_graphql_cache_total";
const GITHUB_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_GRAPHQL_TTL_SECONDS = 10 * 60;

export type GitHubGraphQlCacheClass = "repo_totals" | "contributor_activity";

/** Only cache explicitly stable GraphQL operations used by backfill sweeps. PR/issue/review/thread/detail
 *  reads are mutable gate inputs and must always reflect current GitHub state. Exported for tests. */
export function graphqlOperationName(query: string): string | null {
  const match = /^\s*query\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match?.[1] ?? null;
}

export function graphqlCacheClassForQuery(query: string): GitHubGraphQlCacheClass | null {
  const operation = graphqlOperationName(query);
  if (operation === "GittensoryRepoTotals") return "repo_totals";
  if (operation === "GittensoryContributorActivity") return "contributor_activity";
  return null;
}

export function isCacheableGraphQlQuery(query: string): boolean {
  return graphqlCacheClassForQuery(query) !== null;
}

function positiveEnvSeconds(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const seconds = Math.floor(value);
  return seconds >= 1 ? seconds : fallback;
}

export function githubGraphQlCacheTtlSeconds(cls: GitHubGraphQlCacheClass, env: Record<string, string | undefined> = process.env): number {
  return positiveEnvSeconds(env, "GITHUB_GRAPHQL_CACHE_TTL_SECONDS", DEFAULT_GRAPHQL_TTL_SECONDS);
}

async function sha256Short(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function graphqlCacheKey(query: string, token: string): Promise<string> {
  const authHash = await sha256Short(`Bearer ${token}`);
  const queryHash = await sha256Short(query);
  return `gql:v1:${authHash}:${queryHash}`;
}

function recordGraphQlCacheMetric(result: "hit" | "miss" | "set" | "coalesced" | "bypassed" | "error", cls: string): void {
  incr(GITHUB_GRAPHQL_CACHE_METRIC, { result, class: cls });
}

function responseFromCached(hit: CachedGitHubResponse, replayKind: "hit" | "coalesced"): Response {
  const headers = new Headers({ "content-type": hit.contentType, [GITHUB_RESPONSE_CACHE_REPLAY_HEADER]: replayKind });
  return new Response(hit.body, { status: hit.status, headers });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const GITHUB_RATE_LIMIT_MAX_RETRIES = 3;

async function fetchGraphQlWithRetry(query: string, token: string): Promise<Response> {
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "gittensory/0.1",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
    if (attempt >= GITHUB_RATE_LIMIT_MAX_RETRIES || !(await isRateLimitedResponse(response))) break;
    await sleep(rateLimitRetryMs(response, attempt));
  }
  return response;
}

async function fetchAndMaybeCacheGraphQl(
  query: string,
  token: string,
  cacheKey: string,
  cls: GitHubGraphQlCacheClass,
): Promise<{ response: Response; cached: CachedGitHubResponse | null }> {
  const response = await fetchGraphQlWithRetry(query, token);
  if (response.status !== 200) return { response, cached: null };
  try {
    const cached = {
      status: 200,
      body: await response.clone().text(),
      contentType: response.headers.get("content-type") ?? "application/json",
    };
    await getGitHubResponseCache()!.set(cacheKey, cached, githubGraphQlCacheTtlSeconds(cls));
    recordGraphQlCacheMetric("set", cls);
    return { response, cached };
  } catch {
    recordGraphQlCacheMetric("error", cls);
    return { response, cached: null };
  }
}

const inFlightGraphQlPosts = new Map<string, Promise<CachedGitHubResponse | null>>();

/** Auth-aware shared cache for allowlisted stable GitHub GraphQL POST reads. */
export async function fetchCachedGitHubGraphQl(query: string, token: string): Promise<Response> {
  const cache = getGitHubResponseCache();
  const cls = graphqlCacheClassForQuery(query);
  const useCache = cache !== null && cls !== null;
  if (!useCache) {
    recordGraphQlCacheMetric("bypassed", cls ?? "sensitive");
    return fetchGraphQlWithRetry(query, token);
  }

  const cacheKey = await graphqlCacheKey(query, token);
  let hit: CachedGitHubResponse | null = null;
  try {
    hit = await cache.get(cacheKey);
  } catch {
    recordGraphQlCacheMetric("error", cls);
  }
  if (hit?.status === 200) {
    recordGraphQlCacheMetric("hit", cls);
    return responseFromCached(hit, "hit");
  }
  recordGraphQlCacheMetric("miss", cls);

  const existing = inFlightGraphQlPosts.get(cacheKey);
  if (existing) {
    recordGraphQlCacheMetric("coalesced", cls);
    const replay = await existing;
    if (replay) return responseFromCached(replay, "coalesced");
  }

  const request = fetchAndMaybeCacheGraphQl(query, token, cacheKey, cls).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const shared = request.then((settled) => (settled.ok ? settled.result.cached : null));
  const sharedWithCleanup = shared.finally(() => inFlightGraphQlPosts.delete(cacheKey));
  inFlightGraphQlPosts.set(cacheKey, sharedWithCleanup);
  const result = await request;
  if (!result.ok) throw result.error;
  return result.result.response;
}

/** Test-only: reset shared GraphQL cache single-flight state between tests. */
export function clearGitHubGraphQlCacheForTest(): void {
  inFlightGraphQlPosts.clear();
}
