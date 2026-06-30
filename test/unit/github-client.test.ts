import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubResponseCacheForTest,
  forcedSelfhostMode,
  githubRateLimitAdmissionKeyForInstallation,
  GITHUB_RESPONSE_CACHE_REPLAY_HEADER,
  githubResponseCacheTtlSeconds,
  isCacheableGithubUrl,
  isRateLimitedResponse,
  latestGitHubRestRateLimitObservation,
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it("records only live GitHub core REST rate-limit observations", async () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    const otherKey = githubRateLimitAdmissionKeyForInstallation(456);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let headers = new Headers({
      "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": String(Math.floor(Date.parse("2026-06-24T12:10:00.000Z") / 1000)),
    });
    vi.stubGlobal("fetch", async () => new Response("ok", { headers }));

    await timeoutFetch("https://api.github.com/repos/o/r/issues", { githubRateLimitAdmission: true });
    expect(latestGitHubRestRateLimitObservation(key)).toBeNull();

    await timeoutFetch("https://api.github.com/repos/o/r/issues", { githubRateLimitAdmission: true, githubRateLimitAdmissionKey: key });
    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 42,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: now,
    });
    expect(await renderMetrics()).toContain('gittensory_github_rest_rate_limit_observations_total{key_scope="installation",remaining_bucket="1-75"} 1');
    expect(latestGitHubRestRateLimitObservation(otherKey)).toBeNull();

    headers = new Headers({
      "x-ratelimit-resource": "search",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.parse("2026-06-24T12:30:00.000Z") / 1000)),
    });
    await timeoutFetch("https://api.github.com/search/issues?q=repo:o/r", { githubRateLimitAdmission: true, githubRateLimitAdmissionKey: key });
    await timeoutFetch("https://example.test/health");
    headers = new Headers({
      "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.parse("2026-06-24T12:40:00.000Z") / 1000)),
    });
    await timeoutFetch("https://api.github.com/repos/o/r/pulls");
    headers = new Headers();
    await timeoutFetch("https://api.github.com/repos/o/r/comments", { githubRateLimitAdmission: true, githubRateLimitAdmissionKey: key });
    headers = new Headers({
      "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "not-a-number",
      "x-ratelimit-reset": String(Math.floor(Date.parse("2026-06-24T12:40:00.000Z") / 1000)),
    });
    await timeoutFetch("https://api.github.com/repos/o/r/pulls", { githubRateLimitAdmission: true, githubRateLimitAdmissionKey: key });
    headers = new Headers({
      "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.parse("2026-06-24T12:50:00.000Z") / 1000)),
    });
    await timeoutFetch("https://example.test/health", { githubRateLimitAdmission: true, githubRateLimitAdmissionKey: key });

    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 42,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: now,
    });
  });

  it("buckets GitHub REST rate-limit observations by remaining budget and admission-key scope", async () => {
    const reset = String(Math.floor(Date.parse("2026-06-24T12:10:00.000Z") / 1000));
    const remainingByCall = ["0", "75", "150", "151"];
    vi.stubGlobal("fetch", async () => {
      const remaining = remainingByCall.shift() ?? "151";
      return new Response("ok", {
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": remaining,
          "x-ratelimit-reset": reset,
        },
      });
    });

    await timeoutFetch("https://api.github.com/repos/o/r/issues?bucket=zero", {
      githubRateLimitAdmission: true,
      githubRateLimitAdmissionKey: githubRateLimitAdmissionKeyForInstallation(1),
    });
    await timeoutFetch("https://api.github.com/repos/o/r/issues?bucket=low", {
      githubRateLimitAdmission: true,
      githubRateLimitAdmissionKey: githubRateLimitAdmissionKeyForInstallation(2),
    });
    await timeoutFetch("https://api.github.com/repos/o/r/issues?bucket=reserved", {
      githubRateLimitAdmission: true,
      githubRateLimitAdmissionKey: "pat:shared",
    });
    await timeoutFetch("https://api.github.com/repos/o/r/issues?bucket=healthy", {
      githubRateLimitAdmission: true,
      githubRateLimitAdmissionKey: "pat:shared",
    });

    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_github_rest_rate_limit_observations_total{key_scope="installation",remaining_bucket="0"} 1');
    expect(metrics).toContain('gittensory_github_rest_rate_limit_observations_total{key_scope="installation",remaining_bucket="1-75"} 1');
    expect(metrics).toContain('gittensory_github_rest_rate_limit_observations_total{key_scope="other",remaining_bucket="76-150"} 1');
    expect(metrics).toContain('gittensory_github_rest_rate_limit_observations_total{key_scope="other",remaining_bucket="151+"} 1');
  });

  it("records keyed REST admission telemetry from installation Octokit reads", async () => {
    const now = Date.parse("2026-06-24T12:00:00.000Z");
    const key = githubRateLimitAdmissionKeyForInstallation(789);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal(
      "fetch",
      async () =>
        Response.json(
          [{ id: 1 }],
          {
            headers: {
              "x-ratelimit-resource": "core",
              "x-ratelimit-remaining": "12",
              "x-ratelimit-reset": String(Math.floor(Date.parse("2026-06-24T12:10:00.000Z") / 1000)),
            },
          },
        ),
    );
    const octokit = makeInstallationOctokit(createTestEnv(), "tok", "live", key);

    await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner: "o", repo: "r", issue_number: 1 });

    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 12,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: now,
    });
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

  it("negative-caches stable branch-protection permission and missing-resource responses", async () => {
    installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      getFetches += 1;
      const branch = String(input).includes("/branches/dev/");
      return Response.json(
        { message: branch ? "Branch not found" : "Resource not accessible by integration" },
        { status: branch ? 404 : 403 },
      );
    });

    const forbiddenUrl = "https://api.github.com/repos/o/r/branches/main/protection/required_status_checks";
    const missingUrl = "https://api.github.com/repos/o/r/branches/dev/protection/required_status_checks";
    const forbidden = await timeoutFetch(forbiddenUrl);
    const forbiddenReplay = await timeoutFetch(forbiddenUrl);
    const missing = await timeoutFetch(missingUrl);
    const missingReplay = await timeoutFetch(missingUrl);

    expect(forbidden.status).toBe(403);
    expect(forbiddenReplay.status).toBe(403);
    expect(forbiddenReplay.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("hit");
    expect(await forbiddenReplay.json()).toEqual({ message: "Resource not accessible by integration" });
    expect(missing.status).toBe(404);
    expect(missingReplay.status).toBe(404);
    expect(missingReplay.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("hit");
    expect(await missingReplay.json()).toEqual({ message: "Branch not found" });
    expect(getFetches).toBe(2);
  });

  it("does not cache GitHub rate-limit 403 responses as branch-protection metadata", async () => {
    installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      return Response.json(
        { message: getFetches === 1 ? "API rate limit exceeded" : "Resource not accessible by integration" },
        getFetches === 1
          ? { status: 403, headers: { "x-ratelimit-remaining": "0" } }
          : { status: 403 },
      );
    });

    const url = "https://api.github.com/repos/o/r/branches/main/protection/required_status_checks";
    const first = await timeoutFetch(url);
    const second = await timeoutFetch(url);
    const replay = await timeoutFetch(url);

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(replay.status).toBe(403);
    expect(replay.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("hit");
    expect(await replay.json()).toEqual({ message: "Resource not accessible by integration" });
    expect(getFetches).toBe(2);
  });

  it("does not cache a branch-protection 403 while every inline retry is still rate-limited", async () => {
    const set = vi.fn(async () => undefined);
    setGitHubResponseCache({
      get: async () => null,
      set,
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "retry-after": "0", "x-ratelimit-remaining": "0" } },
      );
    });

    const response = await timeoutFetch("https://api.github.com/repos/o/r/branches/main/protection/required_status_checks");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "API rate limit exceeded" });
    expect(getFetches).toBe(4);
    expect(set).not.toHaveBeenCalled();
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_github_rest_rate_limit_responses_total{key_scope="global",retry="scheduled",status="403"} 3');
    expect(metrics).toContain('gittensory_github_rest_rate_limit_responses_total{key_scope="global",retry="exhausted",status="403"} 1');
  });

  it("does not negative-cache stable metadata denials outside branch protection", async () => {
    installMemoryResponseCache();
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      return Response.json({ message: `denied-${getFetches}` }, { status: 403 });
    });

    const url = "https://api.github.com/repos/o/r";
    expect(await (await timeoutFetch(url)).json()).toEqual({ message: "denied-1" });
    expect(await (await timeoutFetch(url)).json()).toEqual({ message: "denied-2" });
    expect(getFetches).toBe(2);
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

  it("resolves per-class cache TTL env overrides with safe fallbacks", () => {
    expect(githubResponseCacheTtlSeconds("branch_protection", {})).toBe(20 * 60);
    expect(githubResponseCacheTtlSeconds("metadata", {})).toBe(10 * 60);
    expect(githubResponseCacheTtlSeconds("branch_protection", { GITHUB_BRANCH_PROTECTION_CACHE_TTL_SECONDS: "3600" })).toBe(3600);
    expect(githubResponseCacheTtlSeconds("metadata", { GITHUB_METADATA_CACHE_TTL_SECONDS: "90.8" })).toBe(90);
    expect(githubResponseCacheTtlSeconds("branch_protection", { GITHUB_BRANCH_PROTECTION_CACHE_TTL_SECONDS: "" })).toBe(20 * 60);
    expect(githubResponseCacheTtlSeconds("metadata", { GITHUB_METADATA_CACHE_TTL_SECONDS: "0" })).toBe(10 * 60);
    expect(githubResponseCacheTtlSeconds("metadata", { GITHUB_METADATA_CACHE_TTL_SECONDS: "0.5" })).toBe(10 * 60);
    expect(githubResponseCacheTtlSeconds("metadata", { GITHUB_METADATA_CACHE_TTL_SECONDS: "not-a-number" })).toBe(10 * 60);
    expect(githubResponseCacheTtlSeconds("metadata", { GITHUB_METADATA_CACHE_TTL_SECONDS: "Infinity" })).toBe(10 * 60);
  });

  it("uses configured TTL overrides for stable GitHub metadata and branch-protection reads", async () => {
    vi.stubEnv("GITHUB_BRANCH_PROTECTION_CACHE_TTL_SECONDS", "3600");
    vi.stubEnv("GITHUB_METADATA_CACHE_TTL_SECONDS", "900");
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
    expect(branchTtl).toBe(3600);
    expect(repoTtl).toBe(900);
    expect(userTtl).toBe(900);
    expect(installationTtl).toBe(900);
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

  it("single-flights concurrent mutable GitHub GETs without persisting them in Redis", async () => {
    const cacheGet = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ state: "stale" }),
      contentType: "application/json",
    }));
    const cacheSet = vi.fn(async () => undefined);
    setGitHubResponseCache({ get: cacheGet, set: cacheSet });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      if (getFetches === 1) {
        markFetchStarted();
        await fetchGate;
      }
      return Response.json([{ state: `live-${getFetches}` }]);
    });

    const url = "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=1";
    const init = { headers: { authorization: "Bearer volatile-token" } };
    const first = timeoutFetch(url, init);
    await fetchStarted;
    await Promise.resolve();
    const second = timeoutFetch(url, init);
    releaseFetch();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const later = await timeoutFetch(url, init);

    expect(await firstResponse.json()).toEqual([{ state: "live-1" }]);
    expect(await secondResponse.json()).toEqual([{ state: "live-1" }]);
    expect(secondResponse.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("coalesced");
    expect(await later.json()).toEqual([{ state: "live-2" }]);
    expect(getFetches).toBe(2);
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
    const metrics = await renderMetrics();
    expect(metrics).toContain('gittensory_github_response_cache_total{class="sensitive",result="bypassed"} 2');
    expect(metrics).toContain('gittensory_github_response_cache_total{class="sensitive",result="coalesced"} 1');
  });

  it("single-flights concurrent mutable GitHub GETs even when Redis is disabled", async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      if (getFetches === 1) {
        markFetchStarted();
        await fetchGate;
      }
      return Response.json([{ state: `live-${getFetches}` }]);
    });

    const url = "https://api.github.com/repos/o/r/issues/7/events?per_page=100&page=1";
    const first = timeoutFetch(url);
    await fetchStarted;
    const second = timeoutFetch(url);
    releaseFetch();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const later = await timeoutFetch(url);

    expect(await firstResponse.json()).toEqual([{ state: "live-1" }]);
    expect(await secondResponse.json()).toEqual([{ state: "live-1" }]);
    expect(secondResponse.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBe("coalesced");
    expect(await later.json()).toEqual([{ state: "live-2" }]);
    expect(getFetches).toBe(2);
  });

  it("falls back to a fresh mutable GET when the volatile leader cannot be replayed", async () => {
    class UncloneableResponse extends Response {
      override clone(): Response {
        throw new Error("cannot replay");
      }
    }
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      getFetches += 1;
      if (getFetches === 1) {
        markFetchStarted();
        await fetchGate;
        return new UncloneableResponse(JSON.stringify({ state: "leader-only" }), { headers: { "content-type": "application/json" } });
      }
      return Response.json({ state: "fresh-follower" });
    });

    const url = "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=1";
    const first = timeoutFetch(url);
    await fetchStarted;
    const second = timeoutFetch(url);
    releaseFetch();

    await expect(first.then((response) => response.json())).resolves.toEqual({ state: "leader-only" });
    await expect(second.then((response) => response.json())).resolves.toEqual({ state: "fresh-follower" });
    expect(getFetches).toBe(2);
  });

  it("does not volatile-single-flight raw contents reads that callers stream-cap", async () => {
    setGitHubResponseCache({
      get: async () => null,
      set: async () => undefined,
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async () => {
      const fetchId = (getFetches += 1);
      await fetchGate;
      return new Response(`body-${fetchId}`, { headers: { "content-type": "text/plain" } });
    });

    const url = "https://api.github.com/repos/o/r/contents/src/big.ts?ref=main";
    const init = { headers: { accept: "application/vnd.github.raw+json" } };
    const first = timeoutFetch(url, init);
    const second = timeoutFetch(url, init);
    await Promise.resolve();
    expect(getFetches).toBe(2);
    releaseFetch();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBeNull();
    expect(secondResponse.headers.get(GITHUB_RESPONSE_CACHE_REPLAY_HEADER)).toBeNull();
    expect(await firstResponse.text()).toBe("body-1");
    expect(await secondResponse.text()).toBe("body-2");
  });

  it("keeps volatile single-flight scoped by exact authorization identity", async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let getFetches = 0;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      getFetches += 1;
      await fetchGate;
      const authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ caller: authorization?.endsWith("token-a") ? "a" : "b" });
    });

    const url = "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=1";
    const firstA = timeoutFetch(url, { headers: { authorization: "Bearer token-a" } });
    const firstB = timeoutFetch(url, { headers: { authorization: "Bearer token-b" } });
    await Promise.resolve();
    expect(getFetches).toBe(2);
    releaseFetch();

    expect(await (await firstA).json()).toEqual({ caller: "a" });
    expect(await (await firstB).json()).toEqual({ caller: "b" });
  });

  it("lets a coalesced mutable GitHub GET follower honor its own abort signal", async () => {
    setGitHubResponseCache({
      get: async () => null,
      set: async () => undefined,
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal("fetch", async () => {
      markFetchStarted();
      await fetchGate;
      return Response.json({ state: "live" });
    });

    const url = "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=1";
    const first = timeoutFetch(url);
    await fetchStarted;
    const preAborted = new AbortController();
    preAborted.abort("caller stopped");
    await expect(timeoutFetch(new Request(url, { signal: preAborted.signal }))).rejects.toThrow("The operation was aborted.");
    const controller = new AbortController();
    const second = timeoutFetch(url, { signal: controller.signal });
    controller.abort(new Error("caller aborted"));

    await expect(second).rejects.toThrow("caller aborted");
    releaseFetch();
    await expect(first.then((response) => response.json())).resolves.toEqual({ state: "live" });
    expect(await renderMetrics()).toContain('gittensory_github_response_cache_total{class="sensitive",result="coalesced"} 2');
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
    const first = timeoutFetch(url);
    const second = timeoutFetch(url);
    await bothCacheReads;
    releaseFetch();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 500]);
    const replayable = responses.find((response) => response.status === 200);
    expect(replayable).toBeDefined();
    expect(await replayable!.json()).toEqual({ contexts: ["after-fallback"] });
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
    const first = timeoutFetch(url).then(
      (response) => ({ type: "response" as const, response }),
      (error: Error) => ({ type: "error" as const, message: error.message }),
    );
    const second = timeoutFetch(url).then(
      (response) => ({ type: "response" as const, response }),
      (error: Error) => ({ type: "error" as const, message: error.message }),
    );
    await bothCacheReads;
    releaseFetch();

    const results = await Promise.all([first, second]);
    const failed = results.find((result) => result.type === "error");
    const succeeded = results.find((result) => result.type === "response");
    expect(failed).toMatchObject({ type: "error", message: "network down" });
    if (!succeeded || succeeded.type !== "response") throw new Error("missing successful fallback response");
    await expect(succeeded.response.json()).resolves.toEqual({ contexts: ["after-throw"] });
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
