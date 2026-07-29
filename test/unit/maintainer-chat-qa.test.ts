import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { recordAuditEvent, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #6489 (per #6230's scope decision): the maintainer-dashboard chat Q&A route is a thin wrapper -- build the
// SAME AgentRunBundle grounding the PR-comment `@loopover chat` command builds (planNextWork), then hand it
// unchanged to the EXISTING generateChatQaAnswer service. generateChatQaAnswer itself is mocked for most cases
// here (its own status/branch coverage lives in test/unit/ai-chat-qa.test.ts) so these tests isolate the
// route's OWN logic: auth/validation, the shared per-command rate-limit counter, and pass-through of the
// service's result verbatim.

const app = createApp();
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });

const ADVISORY_ON = { slop: false, e2eTestGen: false, planner: false, summaries: false, chatQa: true, chatQaFrontierFallback: false, intentRouting: false };

// advisoryAiRouting is config-as-code only (never DB-writable via upsertRepositorySettings, #6489) --
// enable chatQa the real way, through the repo's published `.loopover.yml` raw-fetch, same as production.
// This is a plain, unauthenticated raw.githubusercontent.com read (no installation-token exchange), so no
// GitHub App private key is needed to stub it -- unlike test/unit/queue-5.test.ts's #4595 chat-dispatch
// test, which also drives a real GitHub API call downstream and does need one.
// commandRateLimit* is likewise config-as-code only (#6445): DB upserts silently ignore those fields.
function stubChatQaManifestFetch(options: { rateLimitHoldMax?: number } = {}) {
  const rateLimitYaml =
    options.rateLimitHoldMax !== undefined
      ? `  commandRateLimitPolicy: hold\n  commandRateLimitAiMaxPerWindow: ${options.rateLimitHoldMax}\n  commandRateLimitWindowHours: 24\n`
      : "";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("raw.githubusercontent.com") && url.includes(".loopover.yml")) {
      return new Response(`settings:\n  advisoryAiRouting:\n    chatQa: true\n${rateLimitYaml}`, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

async function seedRepoWithPull(env: Env, options: { authorLogin?: string | null } = {}) {
  await upsertInstallation(env, {
    installation: { id: 9, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 9);
  await upsertPullRequestFromGitHub(env, "owner/repo", {
    number: 11,
    title: "Fix cache invalidation",
    state: "open",
    ...(options.authorLogin === null ? {} : { user: { login: options.authorLogin ?? "a-contributor" } }),
    labels: [],
    body: "x",
  });
}

describe("POST /v1/repos/:owner/:repo/pulls/:number/chat-qa (#6489)", () => {
  afterEach(() => {
    vi.doUnmock("../../src/services/ai-chat-qa");
    vi.doUnmock("../../src/services/agent-orchestrator");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("requires authentication", async () => {
    const env = createTestEnv();
    const res = await app.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", body: JSON.stringify({ question: "why is this blocked?" }) }, env);
    expect(res.status).toBe(401);
  });

  it("rejects a non-positive/non-integer pull number", async () => {
    const env = createTestEnv();
    const res = await app.request("/v1/repos/owner/repo/pulls/0/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why?" }) }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_pull_number" });
  });

  it("rejects a blank question", async () => {
    const env = createTestEnv();
    await seedRepoWithPull(env);
    const res = await app.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "   " }) }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_chat_qa_request" });
  });

  it("rejects invalid JSON the same way as a blank question (json().catch → null body)", async () => {
    const env = createTestEnv();
    await seedRepoWithPull(env);
    const res = await app.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: "{not-json" }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_chat_qa_request" });
  });

  it("404s when the pull request is not cached", async () => {
    const env = createTestEnv();
    const res = await app.request("/v1/repos/owner/repo/pulls/999/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why?" }) }, env);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "pull_request_not_found" });
  });

  it("returns a disabled status (the real, unmocked service) when advisoryAiRouting.chatQa is off for the repo (the default, no .loopover.yml)", async () => {
    const env = createTestEnv();
    await seedRepoWithPull(env);
    const res = await app.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why is this blocked?" }) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "disabled", reason: "Chat Q&A is not enabled on this instance (settings.advisoryAiRouting.chatQa is off)." });
  });

  it("#9714: a disabled repo does NOT record a rate-limit audit row (it must not spend the shared @loopover-chat budget)", async () => {
    const env = createTestEnv();
    await seedRepoWithPull(env);
    // chatQa is off (no .loopover.yml stub). The request still returns disabled, but must not have consumed a slot.
    const res = await app.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why is this blocked?" }) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "disabled" });

    const invocationRows = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_invocation' and target_key = 'owner/repo#11#chat'").first<{ n: number }>();
    expect(invocationRows?.n).toBe(0);
  });

  it("#9714: a disabled repo does NOT call planNextWork (it must not pay for the grounding bundle)", async () => {
    vi.resetModules();
    const planNextWork = vi.fn();
    vi.doMock("../../src/services/agent-orchestrator", async () => {
      const actual = await vi.importActual<typeof import("../../src/services/agent-orchestrator")>("../../src/services/agent-orchestrator");
      return { ...actual, planNextWork };
    });
    const { createApp: createMockedApp } = await import("../../src/api/routes");
    const mockedApp = createMockedApp();

    const env = createTestEnv();
    await seedRepoWithPull(env);
    // chatQa off (no stub): the short-circuit must return before the planNextWork grounding-bundle build.
    const res = await mockedApp.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why?" }) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "disabled" });
    expect(planNextWork).not.toHaveBeenCalled();
  });

  it("builds a bundle via planNextWork and passes it, the question, and settings through to generateChatQaAnswer, returning its result verbatim", async () => {
    vi.resetModules();
    const generateChatQaAnswer = vi.fn().mockResolvedValue({ status: "ok", model: "test-model", estimatedNeurons: 12, text: "This PR is blocked on a failing check." });
    vi.doMock("../../src/services/ai-chat-qa", () => ({ generateChatQaAnswer }));
    const fixtureBundle = { run: { status: "completed" }, actions: [], contextSnapshots: [], summary: "" };
    const planNextWork = vi.fn().mockResolvedValue(fixtureBundle);
    vi.doMock("../../src/services/agent-orchestrator", async () => {
      const actual = await vi.importActual<typeof import("../../src/services/agent-orchestrator")>("../../src/services/agent-orchestrator");
      return { ...actual, planNextWork };
    });
    const { createApp: createMockedApp } = await import("../../src/api/routes");
    const mockedApp = createMockedApp();

    const env = createTestEnv();
    await seedRepoWithPull(env, { authorLogin: "a-contributor" });
    stubChatQaManifestFetch();

    const res = await mockedApp.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why is this blocked?" }) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", model: "test-model", estimatedNeurons: 12, text: "This PR is blocked on a failing check." });

    expect(planNextWork).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ login: "a-contributor", repoFullName: "owner/repo" }));
    expect(generateChatQaAnswer).toHaveBeenCalledTimes(1);
    const [, request] = generateChatQaAnswer.mock.calls[0]!;
    expect(request).toMatchObject({
      bundle: fixtureBundle,
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 11,
      actor: "api",
      route: "app.maintainer_dashboard.chat_qa",
    });
  });

  it("falls back to the caller's own actor as the grounding login when the pull request has no cached author", async () => {
    vi.resetModules();
    const generateChatQaAnswer = vi.fn().mockResolvedValue({ status: "ok", model: "test-model", estimatedNeurons: 1, text: "answer" });
    vi.doMock("../../src/services/ai-chat-qa", () => ({ generateChatQaAnswer }));
    const planNextWork = vi.fn().mockResolvedValue({ run: { status: "completed" }, actions: [], contextSnapshots: [], summary: "" });
    vi.doMock("../../src/services/agent-orchestrator", async () => {
      const actual = await vi.importActual<typeof import("../../src/services/agent-orchestrator")>("../../src/services/agent-orchestrator");
      return { ...actual, planNextWork };
    });
    const { createApp: createMockedApp } = await import("../../src/api/routes");
    const mockedApp = createMockedApp();

    const env = createTestEnv();
    await seedRepoWithPull(env, { authorLogin: null });
    // chatQa must be ENABLED for this test to reach planNextWork -- it exercises the grounding-login fallback on
    // the enabled path. (#9714 now short-circuits a disabled repo before planNextWork, so the enable is explicit.)
    stubChatQaManifestFetch();

    const res = await mockedApp.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why is this blocked?" }) }, env);
    expect(res.status).toBe(200);
    expect(planNextWork).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ login: "api" }));
  });

  it("never throttles when commandRateLimitPolicy is off (the default), even with many prior invocations recorded", async () => {
    vi.resetModules();
    const generateChatQaAnswer = vi.fn().mockResolvedValue({ status: "ok", model: "m", estimatedNeurons: 1, text: "answer" });
    vi.doMock("../../src/services/ai-chat-qa", () => ({ generateChatQaAnswer }));
    const { createApp: createMockedApp } = await import("../../src/api/routes");
    const mockedApp = createMockedApp();

    const env = createTestEnv();
    await seedRepoWithPull(env);
    for (let i = 0; i < 10; i += 1) {
      await recordAuditEvent(env, { eventType: "github_app.command_invocation", actor: "api", targetKey: "owner/repo#11#chat", outcome: "completed" });
    }

    const res = await mockedApp.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why?" }) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
    expect(generateChatQaAnswer).toHaveBeenCalledTimes(1);
  });

  it("shares the SAME per-(actor, targetKey) rate-limit counter as the @loopover chat PR-comment command: allows up to the AI ceiling, then throttles without calling the service", async () => {
    vi.resetModules();
    const generateChatQaAnswer = vi.fn().mockResolvedValue({ status: "ok", model: "m", estimatedNeurons: 1, text: "answer" });
    vi.doMock("../../src/services/ai-chat-qa", () => ({ generateChatQaAnswer }));
    const { createApp: createMockedApp } = await import("../../src/api/routes");
    const mockedApp = createMockedApp();

    const env = createTestEnv();
    await seedRepoWithPull(env);
    // Config-as-code only (#6445): hold + AI ceiling of 2 via .loopover.yml, not upsertRepositorySettings.
    stubChatQaManifestFetch({ rateLimitHoldMax: 2 });
    // One prior invocation already recorded under the SAME event type + targetKey shape the PR-comment
    // command itself would use for this PR -- e.g. from a real `@loopover chat` comment by this same actor.
    await recordAuditEvent(env, { eventType: "github_app.command_invocation", actor: "api", targetKey: "owner/repo#11#chat", outcome: "completed" });

    // 2nd attempt: 1 prior + this one = 2, at the ceiling -- still allowed.
    const allowed = await mockedApp.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why?" }) }, env);
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ status: "ok" });

    // 3rd attempt: now over the ceiling (2 recorded + this one = 3 > 2) -- throttled, service never called again.
    const throttled = await mockedApp.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why?" }) }, env);
    expect(throttled.status).toBe(200);
    const throttledBody = (await throttled.json()) as { status: string; reason: string };
    expect(throttledBody.status).toBe("rate_limited");
    expect(throttledBody.reason).toContain("2 within 24h");
    expect(generateChatQaAnswer).toHaveBeenCalledTimes(1);

    const invocationRows = await env.DB.prepare("select count(*) as n from audit_events where event_type = 'github_app.command_invocation' and target_key = 'owner/repo#11#chat'").first<{ n: number }>();
    // Every attempt (including the throttled one) still records an invocation, mirroring
    // maybeThrottleLoopOverCommand's own ordering: 1 pre-seeded + 2 from this test's own requests.
    expect(invocationRows?.n).toBe(3);
  });

  it("surfaces chatQaEnabled=true on maintainer-dashboard reviewability when .loopover.yml opts into chatQa", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepoWithPull(env);
    await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind("owner/repo").run();
    stubChatQaManifestFetch();
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 1 });
    const res = await app.request("/v1/app/maintainer-dashboard", { headers: { cookie: `loopover_session=${token}` } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviewability: Array<{ pr: string; chatQaEnabled: boolean }> };
    expect(body.reviewability).toEqual(expect.arrayContaining([expect.objectContaining({ pr: "owner/repo#11", chatQaEnabled: true })]));
  });
});
