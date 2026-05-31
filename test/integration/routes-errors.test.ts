import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { persistSignalSnapshot } from "../../src/db/repositories";
import { handleMcpRequest } from "../../src/mcp/server";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("api route guards and error branches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates, verifies, and revokes GitHub-backed API sessions", async () => {
    const app = createApp();
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });

    const login = await app.request(
      "/v1/auth/github/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubToken: "github-token" }),
      },
      env,
    );
    expect(login.status).toBe(201);
    const session = (await login.json()) as { token: string; login: string; expiresAt: string };
    expect(session).toMatchObject({ login: "jsonbored" });
    expect(session.token).toMatch(/^gts_/);

    const authHeaders = { authorization: `Bearer ${session.token}` };
    expect((await app.request("/v1/auth/session", { headers: authHeaders }, env)).status).toBe(200);
    expect((await app.request("/v1/repos", { headers: authHeaders }, env)).status).toBe(200);

    const logout = await app.request("/v1/auth/logout", { method: "POST", headers: authHeaders }, env);
    expect(logout.status).toBe(200);
    const signedOut = await app.request("/v1/auth/session", { headers: authHeaders }, env);
    expect(signedOut.status).toBe(200);
    await expect(signedOut.json()).resolves.toMatchObject({ status: "signed_out" });
  });

  it("creates browser cookie sessions through GitHub web OAuth callback", async () => {
    const app = createApp();
    const env = createTestEnv({
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
      ADMIN_GITHUB_LOGINS: "jsonbored",
    });

    const started = await app.request("/v1/auth/github/start?returnTo=https%3A%2F%2Fgittensory.aethereal.dev%2Fapp", {}, env);
    expect(started.status).toBe(302);
    const startCookie = started.headers.get("set-cookie") ?? "";
    const location = new URL(started.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    expect(startCookie).toContain("gittensory_oauth_state=");
    expect(state).toBeTruthy();

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "github-token", scope: "read:user" });
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });

    const callback = await app.request(`/v1/auth/github/callback?code=code&state=${encodeURIComponent(state)}`, { headers: { cookie: firstCookiePair(startCookie) } }, env);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://gittensory.aethereal.dev/app");
    const callbackCookie = callback.headers.get("set-cookie") ?? "";
    expect(callbackCookie).toContain("gittensory_session=");
    expect(callbackCookie).toContain("HttpOnly");

    const sessionCookie = firstCookiePair(callbackCookie, "gittensory_session");
    const session = await app.request("/v1/auth/session", { headers: { cookie: sessionCookie } }, env);
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      status: "authenticated",
      login: "jsonbored",
      roles: ["miner", "maintainer", "owner", "operator"],
    });

    const reposWithCookie = await app.request("/v1/repos", { headers: { cookie: sessionCookie } }, env);
    expect(reposWithCookie.status).toBe(200);

    const logout = await app.request("/v1/auth/logout", { method: "POST", headers: { cookie: sessionCookie } }, env);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("gittensory_session=");
    const signedOut = await app.request("/v1/auth/session", { headers: { cookie: sessionCookie } }, env);
    expect(signedOut.status).toBe(200);
    await expect(signedOut.json()).resolves.toMatchObject({ status: "signed_out" });
  });

  it("rejects bad GitHub web OAuth callbacks without creating a browser session", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret" });
    const invalid = await app.request("/v1/auth/github/callback?code=code&state=wrong", { headers: { cookie: "gittensory_oauth_state=other" } }, env);
    expect(invalid.status).toBe(302);
    expect(invalid.headers.get("location")).toContain("auth=error");
    expect(invalid.headers.get("set-cookie")).toContain("gittensory_oauth_state=");

    const denied = await app.request("/v1/auth/github/callback?error=access_denied", {}, env);
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("access_denied");

    const missingCodeEnv = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret" });
    delete (missingCodeEnv as Partial<Env>).PUBLIC_SITE_ORIGIN;
    const missingCode = await app.request("/v1/auth/github/callback?state=state-only", {}, missingCodeEnv);
    expect(missingCode.status).toBe(302);
    expect(missingCode.headers.get("location")).toContain("github_oauth_callback_invalid");
    const missingState = await app.request("/v1/auth/github/callback?code=code-only", {}, env);
    expect(missingState.status).toBe(302);
    expect(missingState.headers.get("location")).toContain("github_oauth_callback_invalid");
  });

  it("limits GitHub-backed sessions to their own private contributor advisory data", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "attacker" });
    const { token } = await createSessionForGitHubUser(env, { login: "attacker", id: 7 });
    const sessionHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    await persistSignalSnapshot(env, {
      id: "victim-decision-pack",
      signalType: "contributor-decision-pack",
      targetKey: "victim",
      payload: {
        status: "ready",
        source: "computed",
        login: "victim",
        generatedAt: "2026-05-29T00:00:00.000Z",
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        profile: {},
        outcomeHistory: {},
        roleContexts: [],
        repoDecisions: [{ repoFullName: "owner/private-repo", recommendation: "avoid", scoreBlockers: ["private score blocker"] }],
        topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "owner/private-repo", priorityScore: 50, rationale: "private next action" }],
        cleanupFirst: [],
        pursueRepos: [],
        avoidRepos: [{ repoFullName: "owner/private-repo", recommendation: "avoid" }],
        maintainerLaneRepos: [],
        scoreBlockers: ["private score blocker"],
        dataQuality: { signalFidelity: { status: "ready" } },
        summary: "private advisory summary",
        nextActions: ["sensitive next action"],
      } as never,
      generatedAt: "2026-05-29T00:00:00.000Z",
    });

    const ownDecisionPack = await app.request("/v1/contributors/attacker/decision-pack", { headers: sessionHeaders }, env);
    expect(ownDecisionPack.status).toBe(202);

    const victimDecisionPack = await app.request("/v1/contributors/victim/decision-pack", { headers: sessionHeaders }, env);
    expect(victimDecisionPack.status).toBe(403);
    await expect(victimDecisionPack.json()).resolves.toMatchObject({ error: "forbidden_contributor" });

    const victimRepoDecision = await app.request("/v1/contributors/victim/repos/owner/private-repo/decision", { headers: sessionHeaders }, env);
    expect(victimRepoDecision.status).toBe(403);
    await expect(victimRepoDecision.json()).resolves.toMatchObject({ error: "forbidden_contributor" });

    const maintainerPacket = await app.request("/v1/repos/owner/private-repo/pulls/1/maintainer-packet", { headers: sessionHeaders }, env);
    expect(maintainerPacket.status).toBe(403);
    await expect(maintainerPacket.json()).resolves.toMatchObject({ error: "static_token_required" });

    const staticTokenDecisionPack = await app.request("/v1/contributors/victim/decision-pack", { headers: apiHeaders(env) }, env);
    expect(staticTokenDecisionPack.status).toBe(200);
    await expect(staticTokenDecisionPack.json()).resolves.toMatchObject({ login: "victim", summary: "private advisory summary" });

    const victimScorePreview = await app.request(
      "/v1/scoring/preview",
      {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ repoFullName: "owner/private-repo", contributorLogin: "victim", metadataOnly: true }),
      },
      env,
    );
    expect(victimScorePreview.status).toBe(403);
    await expect(victimScorePreview.json()).resolves.toMatchObject({ error: "forbidden_contributor" });

    const victimBranchPayload = {
      login: "victim",
      repoFullName: "owner/private-repo",
      branchName: "feature/private-work",
      changedFiles: [{ path: "src/private.ts", additions: 4, deletions: 1, status: "modified" }],
    };
    for (const path of ["/v1/local/branch-analysis", "/v1/agent/preflight-branch", "/v1/agent/prepare-pr-packet"] as const) {
      const response = await app.request(path, { method: "POST", headers: sessionHeaders, body: JSON.stringify(victimBranchPayload) }, env);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: "forbidden_contributor" });
    }

    for (const [path, payload] of [
      ["/v1/agent/runs", { actorLogin: "victim", objective: "Plan private work" }],
      ["/v1/agent/plan-next-work", { login: "victim", repoFullName: "owner/private-repo" }],
      ["/v1/agent/explain-blockers", { login: "victim", repoFullName: "owner/private-repo" }],
    ] as const) {
      const response = await app.request(path, { method: "POST", headers: sessionHeaders, body: JSON.stringify(payload) }, env);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: "forbidden_contributor" });
    }

    const staticRun = await app.request(
      "/v1/agent/runs",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({ actorLogin: "victim", objective: "Plan private work" }),
      },
      env,
    );
    expect(staticRun.status).toBe(202);
    const staticRunJson = (await staticRun.json()) as { run: { id: string } };
    const victimRun = await app.request(`/v1/agent/runs/${staticRunJson.run.id}`, { headers: sessionHeaders }, env);
    expect(victimRun.status).toBe(403);
    await expect(victimRun.json()).resolves.toMatchObject({ error: "forbidden_contributor" });
  });

  it("keeps OAuth setup, CORS, and rate limits explicit", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/openapi.json", {}, env)).status).toBe(200);
    expect((await app.request("/v1/auth/github/device/start", { method: "POST" }, env)).status).toBe(503);
    expect((await app.request("/v1/auth/github/start", {}, env)).status).toBe(503);
    expect((await app.request("/v1/auth/github/device/poll", { method: "POST", body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/auth/github/device/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: "device-code" }) }, env)).status).toBe(503);
    expect((await app.request("/v1/auth/github/session", { method: "POST", body: "{}" }, env)).status).toBe(400);

    const blockedPreflight = await app.request(
      "/v1/repos",
      {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
      },
      env,
    );
    expect(blockedPreflight.headers.get("access-control-allow-origin")).toBeNull();

    const allowedPreflight = await app.request(
      "/v1/repos",
      {
        method: "OPTIONS",
        headers: { origin: "https://gittensory-api.aethereal.dev", "access-control-request-method": "GET" },
      },
      env,
    );
    expect(allowedPreflight.headers.get("access-control-allow-origin")).toBe("https://gittensory-api.aethereal.dev");

    const frontendPreflight = await app.request(
      "/v1/repos",
      {
        method: "OPTIONS",
        headers: { origin: "https://gittensory.aethereal.dev", "access-control-request-method": "GET" },
      },
      env,
    );
    expect(frontendPreflight.headers.get("access-control-allow-origin")).toBe("https://gittensory.aethereal.dev");

    const limitedEnv = createTestEnv({ RATE_LIMITER: denyAllRateLimiter() as unknown as DurableObjectNamespace });
    const limited = await app.request("/v1/auth/github/device/start", { method: "POST" }, limitedEnv);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: "rate_limited", routeClass: "strict" });
    expect((await app.request("/v1/repos", { headers: apiHeaders(limitedEnv) }, limitedEnv)).status).toBe(429);

    const allowedRateEnv = createTestEnv({ RATE_LIMITER: allowRateLimiter() as unknown as DurableObjectNamespace });
    const allowedRate = await app.request("/v1/repos", { headers: apiHeaders(allowedRateEnv) }, allowedRateEnv);
    expect(allowedRate.status).toBe(200);
    expect(allowedRate.headers.get("x-ratelimit-limit")).toBe("99");
    expect(allowedRate.headers.get("x-ratelimit-reset")).toBe("2026-05-25T00:01:00.000Z");
  });

  it("keeps auth route failures generic for non-Error provider failures", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id" });
    vi.stubGlobal("fetch", async () => {
      throw "provider down";
    });

    const start = await app.request("/v1/auth/github/device/start", { method: "POST" }, env);
    expect(start.status).toBe(502);
    await expect(start.json()).resolves.toEqual({ error: "github_device_flow_start_failed" });

    const poll = await app.request("/v1/auth/github/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "device-code" }),
    }, env);
    expect(poll.status).toBe(502);
    await expect(poll.json()).resolves.toEqual({ error: "github_device_flow_poll_failed" });

    const session = await app.request("/v1/auth/github/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "token" }),
    }, env);
    expect(session.status).toBe(401);
    await expect(session.json()).resolves.toEqual({ error: "github_session_create_failed" });
  });

  it("exposes the GitHub device OAuth route flow without requiring a static token", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("device/code")) {
        return Response.json({
          device_code: "device-code",
          user_code: "USER-CODE",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
        });
      }
      if (url.includes("access_token")) return Response.json({ error: "authorization_pending", error_description: "waiting" });
      return Response.json({});
    });

    const started = await app.request("/v1/auth/github/device/start", { method: "POST" }, env);
    expect(started.status).toBe(201);
    await expect(started.json()).resolves.toMatchObject({ status: "pending", deviceCode: "device-code", userCode: "USER-CODE", interval: 5 });

    const polled = await app.request("/v1/auth/github/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "device-code" }),
    }, env);
    expect(polled.status).toBe(200);
    await expect(polled.json()).resolves.toMatchObject({ status: "authorization_pending" });

    vi.stubGlobal("fetch", async () => Response.json({ message: "bad credentials" }, { status: 401 }));
    expect(
      (
        await app.request("/v1/auth/github/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ githubToken: "bad-token" }),
        }, env)
      ).status,
    ).toBe(401);
  });

  it("covers private route errors, internal guards, and manual job runners", async () => {
    const app = createApp();
    const queued: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          queued.push(message);
        },
      } as unknown as Queue,
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("api.gittensor.io") || url.includes("mirror.gittensor.io")) return new Response("missing", { status: 404 });
      if (url.includes("master_repositories.json")) return Response.json({});
      if (url.includes("constants.py")) return new Response("OSS_EMISSION_SHARE = 0.90\nMIN_TOKEN_SCORE_FOR_BASE_SCORE = 5\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n");
      if (url.includes("programming_languages.json")) return Response.json({ TypeScript: 1 });
      return new Response("not found", { status: 404 });
    });

    expect((await app.request("/v1/repos", {}, env)).status).toBe(401);
    expect((await app.request("/v1/repos", { headers: { authorization: `Bearer ${env.GITTENSORY_MCP_TOKEN}` } }, env)).status).toBe(200);
    expect((await app.request("/v1/registry/snapshot", { headers: apiHeaders(env) }, env)).status).toBe(404);
    expect((await app.request("/v1/repos/nope/missing", { headers: apiHeaders(env) }, env)).status).toBe(404);
    expect((await app.request("/v1/installations/not-a-number/health", { headers: apiHeaders(env) }, env)).status).toBe(400);
    expect((await app.request("/v1/installations/999/health", { headers: apiHeaders(env) }, env)).status).toBe(404);
    const emptyReadiness = await app.request("/v1/readiness", { headers: apiHeaders(env) }, env);
    expect(emptyReadiness.status).toBe(200);
    await expect(emptyReadiness.json()).resolves.toMatchObject({ registry: null, scoringModel: null, readyForPublicReview: false });

    for (const removedPath of [
      "/v1/repos/nope/missing/advisory",
      "/v1/repos/nope/missing/pulls/not-a-number/advisory",
      "/v1/repos/nope/missing/issues/not-a-number/advisory",
      "/v1/repos/nope/missing/pulls/1/advisory",
      "/v1/repos/nope/missing/issues/1/advisory",
    ]) {
      expect((await app.request(removedPath, { headers: apiHeaders(env) }, env)).status).toBe(404);
    }

    const invalidMaintainerPacket = await app.request("/v1/repos/nope/missing/pulls/nope/maintainer-packet", { headers: apiHeaders(env) }, env);
    expect(invalidMaintainerPacket.status).toBe(400);

    expect((await app.request("/v1/bounties/missing/advisory", { headers: apiHeaders(env) }, env)).status).toBe(404);
    expect((await app.request("/v1/preflight/pr", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/preflight/local-diff", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/local/branch-analysis", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/agent/runs/missing-run", { headers: apiHeaders(env) }, env)).status).toBe(404);
    expect((await app.request("/v1/agent/runs", { headers: apiHeaders(env) }, env)).status).toBe(400);
    expect((await app.request("/v1/agent/runs", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/agent/plan-next-work", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/agent/preflight-branch", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/agent/prepare-pr-packet", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/agent/explain-blockers", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/openapi.json", { method: "OPTIONS" }, env)).status).toBe(204);

    const agentRun = await app.request("/v1/agent/runs", {
      method: "POST",
      headers: apiHeaders(env),
      body: JSON.stringify({ objective: "Plan next work", actorLogin: "oktofeesh1", surface: "api" }),
    }, env);
    expect(agentRun.status).toBe(202);
    const agentRunJson = (await agentRun.json()) as { run: { id: string; status: string } };
    expect(agentRunJson.run.status).toBe("queued");
    const loadedAgentRun = await app.request(`/v1/agent/runs/${agentRunJson.run.id}`, { headers: apiHeaders(env) }, env);
    expect(loadedAgentRun.status).toBe(200);

    const agentPlan = await app.request("/v1/agent/plan-next-work", {
      method: "POST",
      headers: apiHeaders(env),
      body: JSON.stringify({ login: "oktofeesh1", objective: "Pick next work", surface: "api" }),
    }, env);
    expect(agentPlan.status).toBe(202);
    await expect(agentPlan.json()).resolves.toMatchObject({ run: { status: "needs_snapshot_refresh" } });

    const agentBlockers = await app.request("/v1/agent/explain-blockers", {
      method: "POST",
      headers: apiHeaders(env),
      body: JSON.stringify({ login: "oktofeesh1", repoFullName: "JSONbored/gittensory" }),
    }, env);
    expect(agentBlockers.status).toBe(202);
    await expect(agentBlockers.json()).resolves.toMatchObject({ run: { status: "needs_snapshot_refresh" } });

    const localAgentPayload = {
      login: "oktofeesh1",
      repoFullName: "JSONbored/gittensory",
      baseRef: "origin/main",
      headRef: "feature/base-agent",
      branchName: "feature/base-agent",
      changedFiles: [{ path: "src/services/agent-orchestrator.ts", additions: 20, deletions: 2, status: "modified" }],
      validation: [{ command: "npm test", status: "passed", summary: "unit tests passed" }],
      title: "Add base-agent planning",
      body: "No issue: base-agent planning surface.",
      localScorer: { mode: "metadata_only", sourceTokenScore: 40, totalTokenScore: 60 },
    };
    expect((await app.request("/v1/agent/preflight-branch", { method: "POST", headers: apiHeaders(env), body: JSON.stringify(localAgentPayload) }, env)).status).toBe(200);
    expect((await app.request("/v1/agent/prepare-pr-packet", { method: "POST", headers: apiHeaders(env), body: JSON.stringify(localAgentPayload) }, env)).status).toBe(200);
    expect((await app.request("/v1/agent/explain-blockers", { method: "POST", headers: apiHeaders(env), body: JSON.stringify(localAgentPayload) }, env)).status).toBe(200);

    expect((await app.request("/v1/scoring/preview", { method: "POST", headers: apiHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/scoring/model", { headers: apiHeaders(env) }, env)).status).toBe(200);
    expect((await app.request("/v1/repos/nope/missing/issue-quality", { headers: apiHeaders(env) }, env)).status).toBe(404);
    expect((await app.request("/v1/repos/nope/missing/burden-forecast", { headers: apiHeaders(env) }, env)).status).toBe(404);
    expect((await app.request("/v1/repos/nope/missing/registry-drift", { headers: apiHeaders(env) }, env)).status).toBe(404);
    expect((await app.request("/v1/repos/nope/missing/pulls/not-a-number/scoring-preview", { headers: apiHeaders(env) }, env)).status).toBe(404);

    expect((await app.request("/v1/internal/jobs/refresh-registry", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/refresh-registry/run", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/backfill-registered-repos", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/backfill-registered-repos/run", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/backfill-repo-segment", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/backfill-pr-details", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/refresh-installation-health/run", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/generate-signal-snapshots", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/refresh-scoring-model", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/refresh-scoring-model/run", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/build-contributor-evidence", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/build-contributor-decision-packs", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/build-contributor-decision-packs/run", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/refresh-contributor-activity", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/refresh-contributor-activity/run", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/build-burden-forecasts", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/repair-data-fidelity", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/jobs/generate-signal-snapshots/run", { method: "POST" }, env)).status).toBe(401);
    expect((await app.request("/v1/internal/bounties/import", { method: "POST" }, env)).status).toBe(401);
    expect(
      (
        await app.request("/v1/internal/jobs/refresh-registry", {
          method: "POST",
          headers: internalHeaders(env),
        }, env)
      ).status,
    ).toBe(202);
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ type: "refresh-registry" })]));

    expect((await app.request("/v1/internal/jobs/repair-data-fidelity", { method: "POST", headers: internalHeaders(env) }, env)).status).toBe(202);
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ type: "repair-data-fidelity" })]));

    expect(
      (
        await app.request("/v1/internal/jobs/backfill-registered-repos", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ repoFullName: "JSONbored/gittensory" }),
        }, env)
      ).status,
    ).toBe(202);
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backfill-registered-repos", repoFullName: "JSONbored/gittensory" })]));

    const queuedAllBackfill = await app.request("/v1/internal/jobs/backfill-registered-repos", {
      method: "POST",
      headers: internalHeaders(env),
      body: "{bad-json",
    }, env);
    expect(queuedAllBackfill.status).toBe(202);
    expect(await queuedAllBackfill.json()).toMatchObject({ ok: true, status: "queued" });
    const queuedFullBackfill = await app.request("/v1/internal/jobs/backfill-registered-repos", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ mode: "full" }),
    }, env);
    expect(queuedFullBackfill.status).toBe(202);
    const queuedResumeBackfill = await app.request("/v1/internal/jobs/backfill-registered-repos", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ mode: "resume" }),
    }, env);
    expect(queuedResumeBackfill.status).toBe(202);

    const queuedSegment = await app.request("/v1/internal/jobs/backfill-repo-segment", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ repoFullName: "infiniflow/ragflow", segment: "open_issues", mode: "resume", force: true, cursor: "12" }),
    }, env);
    expect(queuedSegment.status).toBe(202);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-repo-segment", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ segment: "labels" }),
        }, env)
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-repo-segment", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ repoFullName: "infiniflow/ragflow", segment: "bad" }),
        }, env)
      ).status,
    ).toBe(400);
    for (const segment of ["labels", "open_pull_requests", "recent_merged_pull_requests"]) {
      const response = await app.request("/v1/internal/jobs/backfill-repo-segment", {
        method: "POST",
        headers: internalHeaders(env),
        body: JSON.stringify({ repoFullName: "infiniflow/ragflow", segment }),
      }, env);
      expect(response.status).toBe(202);
    }
    const queuedFullSegment = await app.request("/v1/internal/jobs/backfill-repo-segment", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ repoFullName: "infiniflow/ragflow", segment: "labels", mode: "full" }),
    }, env);
    expect(queuedFullSegment.status).toBe(202);
    const queuedDetails = await app.request("/v1/internal/jobs/backfill-pr-details", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ repoFullName: "infiniflow/ragflow", mode: "resume", cursor: 80 }),
    }, env);
    expect(queuedDetails.status).toBe(202);
    const queuedDetailsWithoutCursor = await app.request("/v1/internal/jobs/backfill-pr-details", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ repoFullName: "infiniflow/ragflow" }),
    }, env);
    expect(queuedDetailsWithoutCursor.status).toBe(202);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-pr-details", {
          method: "POST",
          headers: internalHeaders(env),
          body: "{}",
        }, env)
      ).status,
    ).toBe(400);
    expect(queued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backfill-repo-segment", repoFullName: "infiniflow/ragflow", segment: "open_issues", mode: "resume", force: true, cursor: "12" }),
        expect.objectContaining({ type: "backfill-pr-details", repoFullName: "infiniflow/ragflow", mode: "resume", cursor: 80 }),
      ]),
    );

    const queuedSignals = await app.request("/v1/internal/jobs/generate-signal-snapshots", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ repoFullName: "JSONbored/gittensory" }),
    }, env);
    expect(queuedSignals.status).toBe(202);
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ type: "generate-signal-snapshots", repoFullName: "JSONbored/gittensory" })]));

    const queuedScoring = await app.request("/v1/internal/jobs/refresh-scoring-model", { method: "POST", headers: internalHeaders(env) }, env);
    expect(queuedScoring.status).toBe(202);
    const queuedEvidence = await app.request("/v1/internal/jobs/build-contributor-evidence", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ login: "oktofeesh1" }),
    }, env);
    expect(queuedEvidence.status).toBe(202);
    const queuedDecisionPack = await app.request("/v1/internal/jobs/build-contributor-decision-packs", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ login: "oktofeesh1" }),
    }, env);
    expect(queuedDecisionPack.status).toBe(202);
    expect(
      (
        await app.request("/v1/internal/jobs/refresh-contributor-activity", {
          method: "POST",
          headers: internalHeaders(env),
          body: "{}",
        }, env)
      ).status,
    ).toBe(400);
    const queuedContributorRefresh = await app.request("/v1/internal/jobs/refresh-contributor-activity", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ login: "jsonbored", repoFullName: "JSONbored/gittensory" }),
    }, env);
    expect(queuedContributorRefresh.status).toBe(202);
    const queuedForecasts = await app.request("/v1/internal/jobs/build-burden-forecasts", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({ repoFullName: "JSONbored/gittensory" }),
    }, env);
    expect(queuedForecasts.status).toBe(202);

    expect((await app.request("/v1/internal/jobs/backfill-pr-details", { method: "POST", headers: internalHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/jobs/backfill-pr-details", { method: "POST", headers: internalHeaders(env), body: JSON.stringify({ repoFullName: "" }) }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/jobs/backfill-pr-details/run", { method: "POST", headers: internalHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/jobs/build-contributor-decision-packs", { method: "POST", headers: internalHeaders(env), body: "not-json" }, env)).status).toBe(202);
    expect((await app.request("/v1/internal/jobs/build-contributor-evidence", { method: "POST", headers: internalHeaders(env), body: "not-json" }, env)).status).toBe(202);
    expect(queued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "refresh-scoring-model" }),
        expect.objectContaining({ type: "build-contributor-evidence", login: "oktofeesh1" }),
        expect.objectContaining({ type: "build-contributor-decision-packs", login: "oktofeesh1" }),
        expect.objectContaining({ type: "refresh-contributor-activity", login: "jsonbored", repoFullName: "JSONbored/gittensory" }),
        expect.objectContaining({ type: "build-burden-forecasts", repoFullName: "JSONbored/gittensory" }),
      ]),
    );

    expect((await app.request("/v1/internal/jobs/refresh-registry/run", { method: "POST", headers: internalHeaders(env) }, env)).status).toBe(200);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-registered-repos/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ repoFullName: "JSONbored/gittensory" }),
        }, env)
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-repo-segment/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: "{}",
        }, env)
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-repo-segment/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ repoFullName: "missing/repo", segment: "bad" }),
        }, env)
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-repo-segment/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ repoFullName: "missing/repo", segment: "labels", mode: "full", cursor: "2" }),
        }, env)
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-pr-details/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: "{}",
        }, env)
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-pr-details/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ repoFullName: "missing/repo", mode: "full", cursor: 2 }),
        }, env)
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/internal/jobs/backfill-registered-repos/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: "{bad-json",
        }, env)
      ).status,
    ).toBe(200);
    expect((await app.request("/v1/internal/jobs/refresh-installation-health/run", { method: "POST", headers: internalHeaders(env) }, env)).status).toBe(200);
    expect((await app.request("/v1/internal/jobs/refresh-scoring-model/run", { method: "POST", headers: internalHeaders(env) }, env)).status).toBe(200);
    expect((await app.request("/v1/internal/jobs/generate-signal-snapshots/run", { method: "POST", headers: internalHeaders(env), body: JSON.stringify({ repoFullName: "missing/repo" }) }, env)).status).toBe(200);
    expect((await app.request("/v1/internal/jobs/build-contributor-decision-packs/run", { method: "POST", headers: internalHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect((await app.request("/v1/internal/jobs/refresh-contributor-activity/run", { method: "POST", headers: internalHeaders(env), body: "{}" }, env)).status).toBe(400);
    expect(
      (
        await app.request("/v1/internal/jobs/refresh-contributor-activity/run", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ login: "jsonbored" }),
        }, env)
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request("/v1/internal/repos/JSONbored/gittensory/settings", {
          method: "POST",
          headers: internalHeaders(env),
          body: JSON.stringify({ commentMode: "bad" }),
        }, env)
      ).status,
    ).toBe(400);
  });

  it("covers public MCP preflight and successful repo/settings routes", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_MCP_TOKEN: "" });
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
        { kind: "raw-github", url: "https://example.test" },
        "2026-05-23T00:00:00.000Z",
      ),
    );

    expect((await app.request("/mcp", { method: "OPTIONS" }, env)).status).toBe(204);
    expect(await handleMcpRequest({ req: { method: "OPTIONS" } } as never)).toMatchObject({ status: 204 });
    expect(
      (
        await app.request(
          "/mcp",
          { method: "POST", headers: { authorization: "Bearer anything", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
          env,
        )
      ).status,
    ).toBe(401);

    const snapshot = await app.request("/v1/registry/snapshot", { headers: apiHeaders(env) }, env);
    expect(snapshot.status).toBe(200);

    const repo = await app.request("/v1/repos/JSONbored/gittensory", { headers: apiHeaders(env) }, env);
    expect(repo.status).toBe(200);
    await expect(repo.json()).resolves.toMatchObject({ fullName: "JSONbored/gittensory" });

    const updated = await app.request(
      "/v1/internal/repos/JSONbored/gittensory/settings",
      {
        method: "POST",
        headers: internalHeaders(env),
        body: JSON.stringify({
          commentMode: "all_prs",
          publicSignalLevel: "minimal",
          checkRunDetailLevel: "deep",
          backfillEnabled: false,
          privateTrustEnabled: false,
        }),
      },
      env,
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ commentMode: "all_prs", checkRunDetailLevel: "deep", backfillEnabled: false, privateTrustEnabled: false });
  });
});

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`,
    "content-type": "application/json",
  };
}

function internalHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`,
    "content-type": "application/json",
  };
}

function firstCookiePair(header: string, name?: string): string {
  const cookies = header.split(/,(?=\s*[^;,]+=)/).map((part) => part.trim());
  const cookie = name ? cookies.find((part) => part.startsWith(`${name}=`)) : cookies[0];
  return cookie?.split(";")[0] ?? "";
}

function denyAllRateLimiter() {
  return {
    idFromName() {
      return {};
    },
    get() {
      return {
        async fetch() {
          return Response.json(
            {
              allowed: false,
              limit: 1,
              remaining: 0,
              retryAfterSeconds: 30,
              resetAt: "2026-05-25T00:01:00.000Z",
            },
            { status: 429 },
          );
        },
      };
    },
  };
}

function allowRateLimiter() {
  return {
    idFromName() {
      return {};
    },
    get() {
      return {
        async fetch() {
          return Response.json({
            allowed: true,
            limit: 99,
            remaining: 98,
            resetAt: "2026-05-25T00:01:00.000Z",
          });
        },
      };
    },
  };
}
