import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/routes";
import { recordAuditEvent, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
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

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

// advisoryAiRouting is config-as-code only (never DB-writable via upsertRepositorySettings, #6489) --
// enable chatQa the real way, through the repo's published `.loopover.yml` raw-fetch, same as production
// (mirrors test/unit/queue-5.test.ts's #4595 chat-dispatch test).
function stubChatQaManifestFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("raw.githubusercontent.com") && url.includes(".loopover.yml")) {
      return new Response("settings:\n  advisoryAiRouting:\n    chatQa: true\n", { status: 200 });
    }
    if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
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

  it("builds a bundle via planNextWork and passes it, the question, and settings through to generateChatQaAnswer, returning its result verbatim", async () => {
    vi.resetModules();
    const generateChatQaAnswer = vi.fn().mockResolvedValue({ status: "ok", model: "test-model", estimatedNeurons: 12, text: "This PR is blocked on a failing check." });
    vi.doMock("../../src/services/ai-chat-qa", () => ({ generateChatQaAnswer }));
    const { createApp: createMockedApp } = await import("../../src/api/routes");
    const mockedApp = createMockedApp();

    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seedRepoWithPull(env, { authorLogin: "a-contributor" });
    stubChatQaManifestFetch();

    const res = await mockedApp.request("/v1/repos/owner/repo/pulls/11/chat-qa", { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ question: "why is this blocked?" }) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", model: "test-model", estimatedNeurons: 12, text: "This PR is blocked on a failing check." });

    expect(generateChatQaAnswer).toHaveBeenCalledTimes(1);
    const [, request] = generateChatQaAnswer.mock.calls[0]!;
    expect(request).toMatchObject({
      question: "why is this blocked?",
      advisoryAiRouting: ADVISORY_ON,
      repoFullName: "owner/repo",
      issueNumber: 11,
      actor: "api",
      route: "app.maintainer_dashboard.chat_qa",
    });
    expect(request.bundle).toBeTruthy();
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
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", commandRateLimitPolicy: "hold", commandRateLimitAiMaxPerWindow: 2, commandRateLimitWindowHours: 24 });
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
});
