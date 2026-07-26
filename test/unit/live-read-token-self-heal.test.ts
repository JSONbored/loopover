import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiveIssueState,
  fetchLivePullRequestHeadSha,
  fetchLivePullRequestResult,
} from "../../src/github/backfill";
import {
  clearInstallationTokenCacheForTest,
  setInstallationTokenStore,
} from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

// These read helpers historically fed a (possibly-stale) cached installation token straight into a raw GitHub
// GET with no retry, so a single 401 was surfaced as unavailable/undefined -- failing the reopen-guard and
// gate-override re-checks closed on a transient token issue. Passing an installationId now routes the read
// through withInstallationTokenRetry (#6191): the stale token is evicted, a fresh one is minted once, and the
// read succeeds -- matching the write-path self-heal convention.

function authToken(init: RequestInit | undefined): string {
  return (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

// A cache store whose get() hands out `stale-token` until the first rejection, then `fresh-token`; the fetch
// stub rejects the stale token with a 401 exactly once and serves `body` to the freshly-minted token. Returns
// the ordered list of tokens the network actually saw so a test can prove the retry re-minted.
function seedSelfHealingToken(body: unknown): { seenTokens: string[] } {
  let rejected = false;
  setInstallationTokenStore({
    get: async () => ({ token: rejected ? "fresh-token" : "stale-token", expiresAtMs: Date.now() + 60 * 60_000 }),
    set: async () => {},
  });
  const seenTokens: string[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const token = authToken(init);
    seenTokens.push(token);
    if (token === "stale-token") {
      rejected = true;
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }
    return Response.json(body);
  });
  return { seenTokens };
}

describe("live read helpers self-heal a stale cached installation token (#6191)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setInstallationTokenStore(null);
    clearInstallationTokenCacheForTest();
  });

  it("fetchLivePullRequestResult retries a 401 with a freshly-minted token", async () => {
    const env = createTestEnv();
    const { seenTokens } = seedSelfHealingToken({ state: "open", head: { sha: "sha7" } });
    const result = await fetchLivePullRequestResult(env, "owner/repo", 7, "stale-token", undefined, 123);
    expect(result).toEqual({ status: "ok", data: { state: "open", head: { sha: "sha7" } } });
    expect(seenTokens).toEqual(["stale-token", "fresh-token"]);
  });

  it("fetchLiveIssueState retries a 401 with a freshly-minted token", async () => {
    const env = createTestEnv();
    const { seenTokens } = seedSelfHealingToken({ state: "open" });
    expect(await fetchLiveIssueState(env, "owner/repo", 42, "stale-token", undefined, 123)).toBe("open");
    expect(seenTokens).toEqual(["stale-token", "fresh-token"]);
  });

  it("fetchLivePullRequestHeadSha retries a 401 with a freshly-minted token", async () => {
    const env = createTestEnv();
    const { seenTokens } = seedSelfHealingToken({ head: { sha: "live-sha" } });
    expect(await fetchLivePullRequestHeadSha(env, "owner/repo", 90, "stale-token", undefined, 123)).toBe("live-sha");
    expect(seenTokens).toEqual(["stale-token", "fresh-token"]);
  });

  // Without an installationId the helpers keep their prior behavior exactly: the passed token is used as-is and a
  // 401 is NOT retried (surfaced as error/undefined), since a public-token read has no installation to re-mint.
  it("does not retry when no installationId is supplied (public-token read path unchanged)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    const seenTokens: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenTokens.push(authToken(init));
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    });
    const result = await fetchLivePullRequestResult(env, "owner/repo", 7, "public-token");
    expect(result.status).toBe("error");
    expect(await fetchLiveIssueState(env, "owner/repo", 42, "public-token")).toBeUndefined();
    expect(await fetchLivePullRequestHeadSha(env, "owner/repo", 90, "public-token")).toBeUndefined();
    expect(seenTokens).toEqual(["public-token", "public-token", "public-token"]);
  });
});
