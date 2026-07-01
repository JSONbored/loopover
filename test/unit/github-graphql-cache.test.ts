import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubGraphQlCacheForTest,
  fetchCachedGitHubGraphQl,
  githubGraphQlCacheTtlSeconds,
  graphqlCacheClassForQuery,
  graphqlOperationName,
  isCacheableGraphQlQuery,
  isCacheableGraphQlResponseBody,
} from "../../src/github/graphql-cache";
import {
  clearGitHubResponseCacheForTest,
  GITHUB_RESPONSE_CACHE_REPLAY_HEADER,
  isGitHubResponseCacheReplay,
  setGitHubResponseCache,
  type CachedGitHubResponse,
} from "../../src/github/client";
import { listLatestGitHubRateLimitObservations, recordGitHubRateLimitObservation } from "../../src/db/repositories";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

const TOTALS_QUERY = `query GittensoryRepoTotals {
  rateLimit { remaining resetAt }
  repository(owner: "o", name: "r") {
    issues(states: OPEN) { totalCount }
    openPullRequests: pullRequests(states: OPEN) { totalCount }
    mergedPullRequests: pullRequests(states: MERGED) { totalCount }
    closedPullRequests: pullRequests(states: CLOSED) { totalCount }
    labels { totalCount }
  }
}`;

const MUTABLE_QUERY = `query GittensoryPullRequestDetails {
  repository(owner: "o", name: "r") {
    pullRequest(number: 1) { title }
  }
}`;

const ANONYMOUS_QUERY = `query {
  rateLimit { remaining }
}`;

function installMemoryResponseCache(): Map<string, CachedGitHubResponse> {
  const store = new Map<string, CachedGitHubResponse>();
  setGitHubResponseCache({
    get: async (key) => store.get(key) ?? null,
    set: async (key, value, ttlSeconds) => void store.set(key, { ...value, ...(ttlSeconds ? {} : {}) }),
  });
  return store;
}

afterEach(() => {
  clearGitHubResponseCacheForTest();
  clearGitHubGraphQlCacheForTest();
  resetMetrics();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("graphql cache allowlist", () => {
  it("recognizes stable operations and rejects mutable or anonymous queries", () => {
    expect(graphqlOperationName(TOTALS_QUERY)).toBe("GittensoryRepoTotals");
    expect(graphqlCacheClassForQuery(TOTALS_QUERY)).toBe("repo_totals");
    expect(isCacheableGraphQlQuery(TOTALS_QUERY)).toBe(true);

    expect(graphqlOperationName(`query GittensoryContributorActivity { rateLimit { remaining } }`)).toBe("GittensoryContributorActivity");
    expect(graphqlCacheClassForQuery(`query GittensoryContributorActivity { x: rateLimit { remaining } }`)).toBe("contributor_activity");
    expect(githubGraphQlCacheTtlSeconds("contributor_activity")).toBe(600);
    vi.stubEnv("GITHUB_GRAPHQL_CACHE_TTL_SECONDS", "   ");
    expect(githubGraphQlCacheTtlSeconds("repo_totals")).toBe(600);

    expect(isCacheableGraphQlQuery(MUTABLE_QUERY)).toBe(false);
    expect(isCacheableGraphQlQuery(ANONYMOUS_QUERY)).toBe(false);
    expect(graphqlOperationName(" mutation X { }")).toBeNull();
  });

  it("rejects GraphQL error envelopes and malformed bodies for caching", () => {
    expect(isCacheableGraphQlResponseBody(JSON.stringify({ data: { repository: null } }))).toBe(true);
    expect(isCacheableGraphQlResponseBody(JSON.stringify({ errors: [{ message: "rate limit" }] }))).toBe(false);
    expect(isCacheableGraphQlResponseBody(JSON.stringify({ errors: [] }))).toBe(true);
    expect(isCacheableGraphQlResponseBody("not-json")).toBe(false);
  });

  it("honors GITHUB_GRAPHQL_CACHE_TTL_SECONDS with a positive fallback", () => {
    vi.stubEnv("GITHUB_GRAPHQL_CACHE_TTL_SECONDS", "120");
    expect(githubGraphQlCacheTtlSeconds("repo_totals")).toBe(120);
    vi.stubEnv("GITHUB_GRAPHQL_CACHE_TTL_SECONDS", "0");
    expect(githubGraphQlCacheTtlSeconds("repo_totals")).toBe(600);
    vi.stubEnv("GITHUB_GRAPHQL_CACHE_TTL_SECONDS", "not-a-number");
    expect(githubGraphQlCacheTtlSeconds("repo_totals")).toBe(600);
  });
});

describe("fetchCachedGitHubGraphQl", () => {
  it("serves a cache hit on the second identical totals query and skips duplicate network calls", async () => {
    const store = installMemoryResponseCache();
    let fetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetches += 1;
      expect(String(input)).toBe("https://api.github.com/graphql");
      return Response.json(
        {
          data: {
            rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
            repository: {
              issues: { totalCount: 1 },
              openPullRequests: { totalCount: 2 },
              mergedPullRequests: { totalCount: 3 },
              closedPullRequests: { totalCount: 4 },
              labels: { totalCount: 5 },
            },
          },
        },
        { headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" } },
      );
    });

    const first = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    const second = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");

    expect(first.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBeNull();
    expect(second.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("hit");
    expect(fetches).toBe(1);
    expect(store.size).toBe(1);
    expect([...store.keys()].some((key) => key.startsWith("gql:v1:"))).toBe(true);
    const cacheKey = [...store.keys()][0]!;
    const authHash = cacheKey.split(":")[2];
    expect(authHash).toMatch(/^[0-9a-f]{64}$/);
    expect([...store.keys()].some((key) => key.includes("token-a"))).toBe(false);
  });

  it("isolates cache entries by auth token", async () => {
    installMemoryResponseCache();
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ data: { repository: { issues: { totalCount: fetches } } } });
    });

    await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-b");

    expect(fetches).toBe(2);
  });

  it("single-flights concurrent cold misses for the same query", async () => {
    installMemoryResponseCache();
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ data: { repository: { issues: { totalCount: 1 } } } });
    });

    const [a, b] = await Promise.all([
      fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a"),
      fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a"),
    ]);

    expect(fetches).toBe(1);
    expect(a.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBeNull();
    expect(b.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("coalesced");
  });

  it("bypasses cache for mutable PR detail queries", async () => {
    installMemoryResponseCache();
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ data: { repository: { pullRequest: { title: "x" } } } });
    });

    await fetchCachedGitHubGraphQl(MUTABLE_QUERY, "token-a");
    await fetchCachedGitHubGraphQl(MUTABLE_QUERY, "token-a");

    expect(fetches).toBe(2);
    expect(await renderMetrics()).toContain('gittensory_github_graphql_cache_total{class="sensitive",result="bypassed"}');
  });

  it("does not cache non-200 GraphQL responses", async () => {
    const store = installMemoryResponseCache();
    vi.stubGlobal("fetch", async () => new Response("error", { status: 500 }));
    const response = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    expect(response.status).toBe(500);
    expect(store.size).toBe(0);
  });

  it("does not cache HTTP 200 GraphQL responses that carry an errors envelope", async () => {
    const store = installMemoryResponseCache();
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ errors: [{ message: "Something went wrong" }] });
    });

    await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");

    expect(fetches).toBe(2);
    expect(store.size).toBe(0);
    expect(await renderMetrics()).not.toContain('gittensory_github_graphql_cache_total{class="repo_totals",result="set"}');
  });

  it("treats cached GraphQL error envelopes as a miss on replay", async () => {
    setGitHubResponseCache({
      get: async () => ({
        status: 200,
        body: JSON.stringify({ errors: [{ message: "stale cached failure" }] }),
        contentType: "application/json",
      }),
      set: async () => undefined,
    });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ data: { repository: { issues: { totalCount: 3 } } } });
    });

    const response = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    expect(await response.json()).toMatchObject({ data: { repository: { issues: { totalCount: 3 } } } });
    expect(fetches).toBe(1);
  });

  it("fail-opens on cache write errors after a successful upstream fetch", async () => {
    setGitHubResponseCache({
      get: async () => null,
      set: async () => {
        throw new Error("redis write failed");
      },
    });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ data: { repository: { issues: { totalCount: 1 } } } });
    });

    const response = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    expect(response.ok).toBe(true);
    expect(fetches).toBe(1);
    expect(await renderMetrics()).toContain('gittensory_github_graphql_cache_total{class="repo_totals",result="error"}');
  });

  it("fail-opens on cache read errors and still fetches upstream", async () => {
    setGitHubResponseCache({
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => undefined,
    });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ data: { repository: { issues: { totalCount: 1 } } } });
    });

    const response = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    expect(response.ok).toBe(true);
    expect(fetches).toBe(1);
    expect(await renderMetrics()).toContain('gittensory_github_graphql_cache_total{class="repo_totals",result="error"}');
  });

  it("treats malformed cached payloads as a miss", async () => {
    setGitHubResponseCache({
      get: async () => ({ status: 500, body: "nope", contentType: "application/json" }),
      set: async () => undefined,
    });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ data: { repository: { issues: { totalCount: 2 } } } });
    });

    const response = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    expect(await response.json()).toMatchObject({ data: { repository: { issues: { totalCount: 2 } } } });
    expect(fetches).toBe(1);
  });

  it("retries transient rate limits before caching a successful totals response", async () => {
    installMemoryResponseCache();
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      if (fetches === 1) {
        return new Response("secondary rate limit", { status: 403, headers: { "retry-after": "0" } });
      }
      return Response.json({ data: { repository: { issues: { totalCount: 1 } } } });
    });

    const response = await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    expect(response.ok).toBe(true);
    expect(fetches).toBe(2);
  });

  it("falls through when a coalesced in-flight fetch fails to populate the cache", async () => {
    let setCalls = 0;
    setGitHubResponseCache({
      get: async () => null,
      set: async () => {
        setCalls += 1;
        throw new Error("cache write failed");
      },
    });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return Response.json({ data: { repository: { issues: { totalCount: 1 } } } });
    });

    const [first, second] = await Promise.all([
      fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a"),
      fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a"),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetches).toBe(2);
    expect(setCalls).toBeGreaterThanOrEqual(2);
    expect(await renderMetrics()).toContain('gittensory_github_graphql_cache_total{class="repo_totals",result="coalesced"}');
  });

  it("surfaces upstream fetch failures from the cache path", async () => {
    installMemoryResponseCache();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a")).rejects.toThrow("network down");
  });

  it("bypasses caching when the shared response cache is disabled", async () => {
    clearGitHubResponseCacheForTest();
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ data: { repository: { issues: { totalCount: 1 } } } });
    });

    await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");
    await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a");

    expect(fetches).toBe(2);
    expect(await renderMetrics()).toContain('gittensory_github_graphql_cache_total{class="repo_totals",result="bypassed"}');
  });
});

describe("githubGraphQl rate-limit observation boundary", () => {
  it("records rate-limit observations only for live GraphQL fetches, not cache replays", async () => {
    const env = createTestEnv();
    installMemoryResponseCache();
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { data: { repository: { issues: { totalCount: 1 } } } },
        { headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1782802800" } },
      ),
    );

    const record = async (response: Response) => {
      if (isGitHubResponseCacheReplay(response)) return;
      await recordGitHubRateLimitObservation(env, {
        repoFullName: null,
        resource: "graphql",
        path: "/graphql",
        statusCode: response.status,
        limitValue: Number(response.headers.get("x-ratelimit-limit")),
        remaining: Number(response.headers.get("x-ratelimit-remaining")),
        resetAt: new Date(Number(response.headers.get("x-ratelimit-reset")) * 1000).toISOString(),
      });
    };

    await record(await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a"));
    await record(await fetchCachedGitHubGraphQl(TOTALS_QUERY, "token-a"));

    const observations = await listLatestGitHubRateLimitObservations(env);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ resource: "graphql", path: "/graphql", remaining: 4999 });
  });
});
