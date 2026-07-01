import { afterEach, describe, expect, it, vi } from "vitest";
import { setGitHubResponseCache, type CachedGitHubResponse } from "../../src/github/client";

// Only shouldWaitForGitHubRateLimit is mocked (the budget signal); the real response-cache path in timeoutFetch
// runs so the dedup can be exercised end-to-end.
const rateLimitMock = vi.hoisted(() => ({ shouldWaitForGitHubRateLimit: vi.fn() }));
vi.mock("../../src/github/rate-limit", async (importActual) => ({
  ...(await importActual<typeof import("../../src/github/rate-limit")>()),
  shouldWaitForGitHubRateLimit: rateLimitMock.shouldWaitForGitHubRateLimit,
}));

import { resolveUpstreamCommitSha } from "../../src/upstream/commit";

const config = { repo: "entrius/gittensor", ref: "main" };
const env = { GITHUB_PUBLIC_TOKEN: "pub-tok" } as unknown as Env;

afterEach(() => {
  setGitHubResponseCache(null);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveUpstreamCommitSha — one shared, cached, budget-gated upstream ref→SHA resolve (#1942)", () => {
  it("resolves the ref to its HEAD commit SHA via a single bare /commits/{ref} read", async () => {
    rateLimitMock.shouldWaitForGitHubRateLimit.mockResolvedValue(undefined);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ sha: "abc123def" });
    });
    expect(await resolveUpstreamCommitSha(env, config)).toBe("abc123def");
    expect(calls).toEqual(["https://api.github.com/repos/entrius/gittensor/commits/main"]);
  });

  it("budget-gates: yields null WITHOUT any request when the shared REST budget is depleted", async () => {
    rateLimitMock.shouldWaitForGitHubRateLimit.mockResolvedValue("2099-01-01T00:00:00.000Z");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolveUpstreamCommitSha(env, config)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dedups: a second resolve within the window is served from the response cache — ONE /commits read for both", async () => {
    rateLimitMock.shouldWaitForGitHubRateLimit.mockResolvedValue(undefined);
    const store = new Map<string, CachedGitHubResponse>();
    setGitHubResponseCache({ get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ sha: "shared-sha" });
    });
    // Two jobs (scoring + drift) resolving the SAME upstream ref within the cache window.
    expect(await resolveUpstreamCommitSha(env, config)).toBe("shared-sha");
    expect(await resolveUpstreamCommitSha(env, config)).toBe("shared-sha");
    expect(fetches).toBe(1);
  });

  it("still serves a CACHED resolve under budget pressure — only a FRESH network read is gated (#1998 review)", async () => {
    const store = new Map<string, CachedGitHubResponse>();
    setGitHubResponseCache({ get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) });
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches += 1;
      return Response.json({ sha: "cached-sha" });
    });
    // 1) Budget OK → the first resolve populates the cache (one network read).
    rateLimitMock.shouldWaitForGitHubRateLimit.mockResolvedValue(undefined);
    expect(await resolveUpstreamCommitSha(env, config)).toBe("cached-sha");
    // 2) Budget now DEPLETED — a fresh read would be gated, but the cached resolve is served for free.
    rateLimitMock.shouldWaitForGitHubRateLimit.mockResolvedValue("2099-01-01T00:00:00.000Z");
    expect(await resolveUpstreamCommitSha(env, config)).toBe("cached-sha");
    expect(fetches).toBe(1); // no new network read despite budget pressure — the cache hit was served
  });

  it("budget-gates a cache MISS: with the response cache ON but empty, still skips the network (null) and makes no request", async () => {
    rateLimitMock.shouldWaitForGitHubRateLimit.mockResolvedValue("2099-01-01T00:00:00.000Z");
    setGitHubResponseCache({ get: async () => null, set: async () => undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolveUpstreamCommitSha(env, config)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails open (null) on a non-OK status, a missing/empty sha, or a thrown fetch", async () => {
    rateLimitMock.shouldWaitForGitHubRateLimit.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    expect(await resolveUpstreamCommitSha(env, config)).toBeNull();
    vi.stubGlobal("fetch", async () => Response.json({ sha: "" }));
    expect(await resolveUpstreamCommitSha(env, config)).toBeNull();
    vi.stubGlobal("fetch", async () => Response.json({}));
    expect(await resolveUpstreamCommitSha(env, config)).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await resolveUpstreamCommitSha(env, config)).toBeNull();
  });
});
