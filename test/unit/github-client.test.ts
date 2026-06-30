import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubResponseCacheForTest,
  forcedSelfhostMode,
  GITHUB_RESPONSE_CACHE_REPLAY_HEADER,
  isCacheableGithubUrl,
  isRateLimitedResponse,
  makeInstallationOctokit,
  resolveRepoActionMode,
  setGitHubResponseCache,
  timeoutFetch,
  type CachedGitHubResponse,
} from "../../src/github/client";
import { setGlobalAgentFrozen } from "../../src/db/repositories";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv } from "../helpers/d1";

type RecordedCall = { url: string; method: string };

function stubFetchRecording(calls: RecordedCall[], body: unknown = { id: 5 }): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function installMemoryResponseCache(): Map<string, CachedGitHubResponse> {
  const store = new Map<string, CachedGitHubResponse>();
  setGitHubResponseCache({
    get: async (url) => store.get(url) ?? null,
    set: async (url, value) => void store.set(url, value),
  });
  return store;
}

afterEach(() => {
  clearGitHubResponseCacheForTest();
  resetMetrics();
  vi.unstubAllGlobals();
});

describe("makeInstallationOctokit", () => {
  it("live mode lets a write reach GitHub (no suppression hook)", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const octokit = makeInstallationOctokit(createTestEnv(), "tok", "live");
    const r = await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/check-runs"))).toBe(true);
    expect((r.data as unknown as { id: number }).id).toBe(5); // the real (stubbed) response, not the synthetic
  });

  it("dry_run mode suppresses a write: no fetch, synthetic check-run id -1, and an audit row", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const env = createTestEnv();
    const octokit = makeInstallationOctokit(env, "tok", "dry_run");
    const r = await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    expect(calls.some((c) => c.method === "POST")).toBe(false); // the write never reached the network
    expect((r.data as unknown as { id: number; dryRunSuppressed: boolean }).id).toBe(-1); // truthy AND !== undefined
    expect((r.data as unknown as { dryRunSuppressed: boolean }).dryRunSuppressed).toBe(true);
    const audit = await env.DB.prepare("SELECT outcome, detail FROM audit_events WHERE event_type = ?").bind("github.write.suppressed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed"); // dry_run audits as completed-shadow
    expect(audit?.detail).toContain("suppressed POST");
  });

  it("paused mode also suppresses writes and audits them as denied", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const env = createTestEnv();
    const octokit = makeInstallationOctokit(env, "tok", "paused");
    await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { owner: "o", repo: "r", issue_number: 1, name: "x" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const audit = await env.DB.prepare("SELECT outcome FROM audit_events WHERE event_type = ?").bind("github.write.suppressed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("denied"); // paused audits as denied
  });

  it("dry_run mode lets a GET read pass through to GitHub", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls, [{ name: "existing" }]);
    const octokit = makeInstallationOctokit(createTestEnv(), "tok", "dry_run");
    await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner: "o", repo: "r", issue_number: 1 });
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/labels"))).toBe(true);
  });

  it("returns a route-shaped synthetic response for each suppressed write route", async () => {
    const octokit = makeInstallationOctokit(createTestEnv(), "tok", "dry_run");
    stubFetchRecording([]); // any network hit would be a bug; suppression returns before fetch

    const review = await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner: "o", repo: "r", pull_number: 1, event: "COMMENT" });
    expect((review.data as unknown as { id: number }).id).toBe(-1);

    const merge = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", { owner: "o", repo: "r", pull_number: 1 });
    expect(merge.data as unknown as { merged: boolean; sha: null }).toMatchObject({ merged: true, sha: null });

    const comment = await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { owner: "o", repo: "r", comment_id: 7, body: "x" });
    expect(comment.data as unknown as { id: number; html_url: string }).toMatchObject({ id: -1, html_url: "" });

    const label = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner: "o", repo: "r", issue_number: 1, labels: ["x"] });
    expect((label.data as unknown as { dryRunSuppressed: boolean; id?: number }).dryRunSuppressed).toBe(true);
    expect((label.data as unknown as { id?: number }).id).toBeUndefined(); // the default route carries no id
  });
});

describe("forcedSelfhostMode (instance-wide self-host kill switch)", () => {
  it("maps SELFHOST_DEPLOYMENT_MODE to a forced action mode (else null)", () => {
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "dry-run" })).toBe("dry_run");
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "dry_run" })).toBe("dry_run"); // underscore variant
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "DISABLED" })).toBe("paused"); // case-insensitive
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "live" })).toBeNull();
    expect(forcedSelfhostMode({})).toBeNull();
  });

  it("forces suppression for the WHOLE instance even when the caller passes mode=live", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const env = { ...createTestEnv(), SELFHOST_DEPLOYMENT_MODE: "dry-run" };
    const octokit = makeInstallationOctokit(env, "tok", "live"); // a LIVE caller…
    const r = await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    expect(calls.some((c) => c.method === "POST")).toBe(false); // …but the instance switch suppresses it anyway
    expect((r.data as unknown as { id: number }).id).toBe(-1);
  });

  it("'disabled' forces suppression audited as denied (vs dry-run's completed-shadow)", async () => {
    stubFetchRecording([]);
    const env = { ...createTestEnv(), SELFHOST_DEPLOYMENT_MODE: "disabled" };
    const octokit = makeInstallationOctokit(env, "tok", "live");
    await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    const audit = await env.DB.prepare("SELECT outcome FROM audit_events WHERE event_type = ?").bind("github.write.suppressed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("denied");
  });
});

describe("resolveRepoActionMode", () => {
  it("maps the env brake, DB freeze, per-repo pause and dry-run to the same modes the executor uses", async () => {
    const env = createTestEnv();
    expect(await resolveRepoActionMode(env, { agentPaused: false, agentDryRun: false })).toBe("live");
    expect(await resolveRepoActionMode(env, { agentPaused: false, agentDryRun: true })).toBe("dry_run");
    expect(await resolveRepoActionMode(env, { agentPaused: true, agentDryRun: false })).toBe("paused");
    expect(await resolveRepoActionMode(env, null)).toBe("live"); // nullish settings → live

    expect(await resolveRepoActionMode({ ...env, AGENT_ACTIONS_PAUSED: "true" }, { agentPaused: false, agentDryRun: true })).toBe("paused"); // env brake wins

    await setGlobalAgentFrozen(env, true);
    expect(await resolveRepoActionMode(env, { agentPaused: false, agentDryRun: false })).toBe("paused"); // DB freeze wins
  });
});

describe("timeoutFetch", () => {
  it("passes an explicit caller signal straight through", async () => {
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return new Response("ok");
    });
    const controller = new AbortController();
    await timeoutFetch("https://example.test", { signal: controller.signal });
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it("injects an AbortSignal timeout when the caller gives none", async () => {
    let injected: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
      injected = init?.signal ?? undefined;
      return new Response("ok");
    });
    await timeoutFetch("https://example.test");
    expect(injected).toBeInstanceOf(AbortSignal);
  });

  it("serves stable installation Octokit metadata GETs from the shared GitHub response cache", async () => {
    const store = installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/o/r") {
        getFetches += 1;
        return Response.json({ full_name: "o/r", fetches: getFetches });
      }
      return new Response("not found", { status: 404 });
    });

    const octokit = makeInstallationOctokit(createTestEnv(), "tok");
    const first = await octokit.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" });
    const second = await octokit.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" });

    expect(first.data).toMatchObject({ full_name: "o/r", fetches: 1 });
    expect(second.data).toMatchObject({ full_name: "o/r", fetches: 1 });
    expect(getFetches).toBe(1);
    expect([...store.keys()].some((url) => url.endsWith("/repos/o/r"))).toBe(true);
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_github_response_cache_total{class="metadata",result="miss"} 1');
    expect(metrics).toContain('gittensory_github_response_cache_total{class="metadata",result="hit"} 1');
    expect(metrics).toContain('gittensory_github_response_cache_total{class="metadata",result="set"} 1');
  });

  it("single-flights concurrent cacheable Octokit GET misses before Redis is warm", async () => {
    let cacheReads = 0;
    let resolveBothCacheReads!: () => void;
    const bothCacheReads = new Promise<void>((resolve) => {
      resolveBothCacheReads = resolve;
    });
    setGitHubResponseCache({
      get: async () => {
        cacheReads += 1;
        if (cacheReads === 2) resolveBothCacheReads();
        return null;
      },
      set: async () => undefined,
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/repos/o/r/branches/main/protection/required_status_checks")) {
        getFetches += 1;
        await fetchGate;
        return Response.json({ contexts: ["ci"] });
      }
      return new Response("not found", { status: 404 });
    });

    const octokit = makeInstallationOctokit(createTestEnv(), "tok");
    const first = octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks", { owner: "o", repo: "r", branch: "main" });
    const second = octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks", { owner: "o", repo: "r", branch: "main" });
    await bothCacheReads;
    releaseFetch();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ data: { contexts: ["ci"] } }),
      expect.objectContaining({ data: { contexts: ["ci"] } }),
    ]);
    expect(getFetches).toBe(1);
    expect(await renderMetrics()).toContain('gittensory_github_response_cache_total{class="branch_protection",result="coalesced"} 1');
  });

  it("keys safe GitHub GETs by auth identity and response-shaping headers without storing the token", async () => {
    const store = installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      getFetches += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ caller: authorization?.endsWith("token-a") ? "a" : "b" });
    });

    const url = "https://api.github.com/repos/o/r";
    const firstA = await timeoutFetch(url, { headers: { authorization: "Bearer token-a", accept: "application/vnd.github+json" } });
    const firstB = await timeoutFetch(url, { headers: { authorization: "Bearer token-b", accept: "application/vnd.github+json" } });
    const secondA = await timeoutFetch(url, { headers: { authorization: "Bearer token-a", accept: "application/vnd.github+json" } });

    expect(await firstA.json()).toEqual({ caller: "a" });
    expect(await firstB.json()).toEqual({ caller: "b" });
    expect(await secondA.json()).toEqual({ caller: "a" });
    expect(secondA.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("hit");
    expect(getFetches).toBe(2);
    expect([...store.keys()].some((key) => key.includes("token-a") || key.includes("token-b"))).toBe(false);
    expect([...store.keys()].filter((key) => key.includes(url))).toHaveLength(2);
  });

  it("replays pagination and validator headers while dropping rate-limit headers", async () => {
    installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      return Response.json(
        [{ number: getFetches }],
        {
          headers: {
            link: '<https://api.github.com/repos/o/r/branches/main/protection/required_status_checks?page=2>; rel="next"',
            etag: '"abc123"',
            "last-modified": "Mon, 29 Jun 2026 20:00:00 GMT",
            "x-ratelimit-remaining": "4999",
          },
        },
      );
    });

    const url = "https://api.github.com/repos/o/r/branches/main/protection/required_status_checks";
    expect(await (await timeoutFetch(url)).json()).toEqual([{ number: 1 }]);
    const replay = await timeoutFetch(url);

    expect(await replay.json()).toEqual([{ number: 1 }]);
    expect(replay.headers.get("link")).toBe('<https://api.github.com/repos/o/r/branches/main/protection/required_status_checks?page=2>; rel="next"');
    expect(replay.headers.get("etag")).toBe('"abc123"');
    expect(replay.headers.get("last-modified")).toBe("Mon, 29 Jun 2026 20:00:00 GMT");
    expect(replay.headers.get("x-ratelimit-remaining")).toBeNull();
    expect(getFetches).toBe(1);
  });

  it("defaults cached replays to application/json when GitHub omits content-type", async () => {
    const store = installMemoryResponseCache();
    vi.stubGlobal("fetch", async () => new Response(new TextEncoder().encode('{"ok":true}'), { status: 200 }));

    const url = "https://api.github.com/users/alice";
    expect(await (await timeoutFetch(url)).json()).toEqual({ ok: true });
    const replay = await timeoutFetch(url);

    expect([...store.values()][0]?.contentType).toBe("application/json");
    expect(replay.headers.get("content-type")).toBe("application/json");
    expect(await replay.json()).toEqual({ ok: true });
  });

  it("uses longer TTL overrides for stable GitHub metadata and branch-protection reads", async () => {
    const ttlByUrl = new Map<string, number | undefined>();
    setGitHubResponseCache({
      get: async () => null,
      set: async (key, _value, ttl) => void ttlByUrl.set(key, ttl),
    });
    vi.stubGlobal("fetch", async () => Response.json({ ok: true }));

    await timeoutFetch("https://api.github.com/repos/o/r/branches/main/protection/required_status_checks");
    await timeoutFetch("https://api.github.com/repos/o/r");
    await timeoutFetch("https://api.github.com/users/alice");
    await timeoutFetch("https://api.github.com/app/installations/123");
    await timeoutFetch("https://api.github.com/repos/o/r/commits/abc/status");

    const branchTtl = [...ttlByUrl].find(([key]) => key.includes("/required_status_checks"))?.[1];
    const repoTtl = [...ttlByUrl].find(([key]) => key.endsWith("/repos/o/r"))?.[1];
    const userTtl = [...ttlByUrl].find(([key]) => key.endsWith("/users/alice"))?.[1];
    const installationTtl = [...ttlByUrl].find(([key]) => key.endsWith("/app/installations/123"))?.[1];
    const statusTtl = [...ttlByUrl].find(([key]) => key.includes("/commits/abc/status"))?.[1];
    expect(branchTtl).toBe(20 * 60);
    expect(repoTtl).toBe(10 * 60);
    expect(userTtl).toBe(10 * 60);
    expect(installationTtl).toBe(10 * 60);
    expect(statusTtl).toBeUndefined();
    expect([...ttlByUrl.keys()].some((key) => key.includes("/commits/abc/status"))).toBe(false);
  });

  it("bypasses live CI and mergeability decision endpoints instead of replaying stale Redis data", async () => {
    const stale = {
      status: 200,
      body: JSON.stringify({ state: "stale" }),
      contentType: "application/json",
    };
    setGitHubResponseCache({
      get: async () => stale,
      set: async () => undefined,
    });
    const decisionCases = [
      { url: "https://api.github.com/repos/o/r/commits/abc/status?per_page=100&page=1", first: { state: "pending" }, second: { state: "success" } },
      {
        url: "https://api.github.com/repos/o/r/commits/abc/check-runs?per_page=100&page=1",
        first: { total_count: 1, check_runs: [{ status: "queued" }] },
        second: { total_count: 0, check_runs: [] },
      },
      {
        url: "https://api.github.com/repos/o/r/commits/abc/check-suites?per_page=100",
        first: { check_suites: [{ status: "in_progress" }] },
        second: { check_suites: [] },
      },
      { url: "https://api.github.com/repos/o/r/pulls/7", first: { mergeable_state: "unknown" }, second: { mergeable_state: "clean" } },
      { url: "https://api.github.com/repos/o/r/pulls/7/merge", first: { merged: false }, second: { merged: true } },
      { url: "https://api.github.com/repos/o/r/check-runs/99", first: { status: "queued" }, second: { status: "completed" } },
      { url: "https://api.github.com/repos/o/r/check-suites/99", first: { status: "in_progress" }, second: { status: "completed" } },
    ];
    const responses = new Map(decisionCases.map(({ url, first, second }) => [url, [first, second]]));
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      getFetches += 1;
      const url = String(input);
      return Response.json(responses.get(url)?.shift() ?? { state: "unexpected" });
    });

    for (const { url, first, second } of decisionCases) {
      expect(isCacheableGithubUrl(url)).toBe(false);
      expect(await (await timeoutFetch(url)).json()).toEqual(first);
      expect(await (await timeoutFetch(url)).json()).toEqual(second);
    }

    expect(getFetches).toBe(decisionCases.length * 2);
    expect(await renderMetrics()).toContain(`gittensory_github_response_cache_total{class="sensitive",result="bypassed"} ${decisionCases.length * 2}`);
  });

  it("bypasses mutable PR and issue subresources instead of replaying stale coordination state", async () => {
    const stale = {
      status: 200,
      body: JSON.stringify({ state: "stale" }),
      contentType: "application/json",
    };
    setGitHubResponseCache({
      get: async () => stale,
      set: async () => undefined,
    });
    const mutableCases = [
      { url: "https://api.github.com/repos/o/r/pulls/7/files?per_page=100&page=1", first: [{ filename: "old.ts" }], second: [{ filename: "new.ts" }] },
      { url: "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=1", first: [{ state: "COMMENTED" }], second: [{ state: "APPROVED" }] },
      { url: "https://api.github.com/repos/o/r/pulls/7/commits?per_page=100&page=1", first: [{ sha: "old" }], second: [{ sha: "new" }] },
      { url: "https://api.github.com/repos/o/r/pulls?state=open&per_page=100&page=1", first: [{ number: 7, head: { sha: "old" } }], second: [{ number: 7, head: { sha: "new" } }] },
      { url: "https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=1", first: [], second: [{ id: 1 }] },
      { url: "https://api.github.com/repos/o/r/issues/7/labels", first: [], second: [{ name: "ready" }] },
      { url: "https://api.github.com/repos/o/r/issues/7/events?per_page=100&page=1", first: [{ event: "labeled" }], second: [{ event: "closed" }] },
    ];
    const responses = new Map(mutableCases.map(({ url, first, second }) => [url, [first, second]]));
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      getFetches += 1;
      const url = String(input);
      return Response.json(responses.get(url)?.shift() ?? { state: "unexpected" });
    });

    for (const { url, first, second } of mutableCases) {
      expect(isCacheableGithubUrl(url)).toBe(false);
      expect(await (await timeoutFetch(url)).json()).toEqual(first);
      expect(await (await timeoutFetch(url)).json()).toEqual(second);
    }

    expect(getFetches).toBe(mutableCases.length * 2);
    expect(await renderMetrics()).toContain(`gittensory_github_response_cache_total{class="sensitive",result="bypassed"} ${mutableCases.length * 2}`);
  });

  it("bypasses conditional GitHub GETs so validator headers keep shaping the live response", async () => {
    const store = installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      return Response.json({ fetches: getFetches });
    });

    const url = "https://api.github.com/repos/o/r";
    const first = await timeoutFetch(url, { headers: { "if-none-match": '"cached-etag"' } });
    const second = await timeoutFetch(url, { headers: { "if-none-match": '"cached-etag"' } });

    expect(await first.json()).toEqual({ fetches: 1 });
    expect(await second.json()).toEqual({ fetches: 2 });
    expect(store.size).toBe(0);
    expect(await renderMetrics()).toContain('gittensory_github_response_cache_total{class="conditional",result="bypassed"} 2');
  });

  it("normalizes Request inputs for GitHub cache detection and auth-aware keys", async () => {
    const store = installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      return Response.json({ fetches: getFetches });
    });

    const request = () =>
      new Request("https://api.github.com/repos/o/r", {
        headers: {
          authorization: "Bearer request-token",
          accept: "application/vnd.github+json",
        },
      });
    const first = await timeoutFetch(request());
    const second = await timeoutFetch(request());

    expect(await first.json()).toEqual({ fetches: 1 });
    expect(await second.json()).toEqual({ fetches: 1 });
    expect(second.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("hit");
    expect(getFetches).toBe(1);
    expect([...store.keys()].some((key) => key.includes("request-token"))).toBe(false);
  });

  it("falls back to a fresh request when the in-flight GET cannot be replayed", async () => {
    let cacheReads = 0;
    let resolveBothCacheReads!: () => void;
    const bothCacheReads = new Promise<void>((resolve) => {
      resolveBothCacheReads = resolve;
    });
    setGitHubResponseCache({
      get: async () => {
        cacheReads += 1;
        if (cacheReads === 2) resolveBothCacheReads();
        return null;
      },
      set: async () => undefined,
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/repos/o/r/branches/main/protection/required_status_checks")) {
        getFetches += 1;
        if (getFetches === 1) {
          await fetchGate;
          return new Response("temporary failure", { status: 500 });
        }
        return Response.json({ contexts: ["after-fallback"] });
      }
      return new Response("not found", { status: 404 });
    });

    const url = "https://api.github.com/repos/o/r/branches/main/protection/required_status_checks";
    const first = timeoutFetch(url).then((response) => response.status);
    const second = timeoutFetch(url);
    await bothCacheReads;
    releaseFetch();

    await expect(first).resolves.toBe(500);
    await expect(second.then((response) => response.json())).resolves.toEqual({ contexts: ["after-fallback"] });
    expect(getFetches).toBe(2);
  });

  it("also falls back when the shared in-flight GET leader throws before a response exists", async () => {
    let cacheReads = 0;
    let resolveBothCacheReads!: () => void;
    const bothCacheReads = new Promise<void>((resolve) => {
      resolveBothCacheReads = resolve;
    });
    setGitHubResponseCache({
      get: async () => {
        cacheReads += 1;
        if (cacheReads === 2) resolveBothCacheReads();
        return null;
      },
      set: async () => undefined,
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/repos/o/r/branches/main/protection/required_status_checks")) {
        getFetches += 1;
        if (getFetches === 1) {
          await fetchGate;
          throw new Error("network down");
        }
        return Response.json({ contexts: ["after-throw"] });
      }
      return new Response("not found", { status: 404 });
    });

    const url = "https://api.github.com/repos/o/r/branches/main/protection/required_status_checks";
    const first = timeoutFetch(url).catch((error: Error) => error.message);
    const second = timeoutFetch(url);
    await bothCacheReads;
    releaseFetch();

    await expect(first).resolves.toContain("network down");
    await expect(second.then((response) => response.json())).resolves.toEqual({ contexts: ["after-throw"] });
    expect(getFetches).toBe(2);
  });

  it("fails open when the shared response cache throws on read or write", async () => {
    let cacheReads = 0;
    let cacheWrites = 0;
    setGitHubResponseCache({
      get: async () => {
        cacheReads += 1;
        throw new Error("redis read unavailable");
      },
      set: async () => {
        cacheWrites += 1;
        throw new Error("redis write unavailable");
      },
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "https://api.github.com/repos/o/r") {
        getFetches += 1;
        return Response.json({ number: 4 });
      }
      return new Response("not found", { status: 404 });
    });

    const response = await timeoutFetch("https://api.github.com/repos/o/r");

    expect(await response.json()).toEqual({ number: 4 });
    expect(cacheReads).toBe(1);
    expect(cacheWrites).toBe(1);
    expect(getFetches).toBe(1);
    expect(await renderMetrics()).toContain('gittensory_github_response_cache_total{class="metadata",result="error"} 2');
  });

  it("counts bypassed non-GET, non-GitHub, and sensitive GitHub requests", async () => {
    setGitHubResponseCache({
      get: async () => null,
      set: async () => undefined,
    });
    vi.stubGlobal("fetch", async () => new Response("ok"));

    await timeoutFetch("https://api.github.com/repos/o/r/issues", { method: "POST" });
    await timeoutFetch("https://example.test/health");
    await timeoutFetch("https://api.github.com/repos/o/r/collaborators/alice/permission");

    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_github_response_cache_total{class="non_get",result="bypassed"} 1');
    expect(metrics).toContain('gittensory_github_response_cache_total{class="non_github",result="bypassed"} 1');
    expect(metrics).toContain('gittensory_github_response_cache_total{class="sensitive",result="bypassed"} 1');
  });
});

describe("isRateLimitedResponse", () => {
  it("fails closed to non-rate-limited when the defensive cloned body read throws", async () => {
    const response = {
      status: 403,
      headers: new Headers(),
      clone: () => ({
        text: async () => {
          throw new Error("body read failed");
        },
      }),
    } as unknown as Response;

    await expect(isRateLimitedResponse(response)).resolves.toBe(false);
  });
});
