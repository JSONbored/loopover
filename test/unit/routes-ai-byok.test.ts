import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositorySettings, upsertInstallation, upsertRepositorySettings, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const SECRET = "routes-byok-encryption-secret-at-least-32b";
const REPO = "acme/widgets";

function apiHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`, "content-type": "application/json" };
}

async function seedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: owner, id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(`${owner}/${name}`).run();
}

describe("maintainer AI-review config route", () => {
  it("sets mode/byok/provider/model and preserves unrelated settings", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositorySettings(env, { repoFullName: REPO, gateCheckMode: "enabled", gittensorLabel: "custom-label" });
    const res = await app.request(
      `/v1/repos/${REPO}/ai-review`,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "block", byok: true, provider: "anthropic", model: "claude-3-5-sonnet-latest" }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "block", aiReviewByok: true, aiReviewProvider: "anthropic", aiReviewModel: "claude-3-5-sonnet-latest" });
    const settings = await getRepositorySettings(env, REPO);
    expect(settings.aiReviewMode).toBe("block");
    expect(settings.gateCheckMode).toBe("enabled"); // preserved
    expect(settings.gittensorLabel).toBe("custom-label"); // preserved
  });

  it("accepts a config without provider/model (stored as null)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(`/v1/repos/${REPO}/ai-review`, { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "advisory", byok: false }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "advisory", aiReviewByok: false, aiReviewProvider: null, aiReviewModel: null });
  });

  it("rejects an invalid AI-review config", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(`/v1/repos/${REPO}/ai-review`, { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "loud" }) }, env);
    expect(res.status).toBe(400);
  });
});

describe("maintainer BYOK key route", () => {
  it("POST stores, GET returns secret-free status, DELETE removes — key never echoed", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const post = await app.request(`/v1/repos/${REPO}/ai-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ provider: "anthropic", key: "sk-ant-route-key-7777", model: "claude-3-5-sonnet-latest" }) }, env);
    expect(post.status).toBe(200);
    const body = await post.json();
    expect(body).toMatchObject({ configured: true, provider: "anthropic", last4: "7777" });
    expect(JSON.stringify(body)).not.toContain("sk-ant");

    const get = await app.request(`/v1/repos/${REPO}/ai-key`, { headers: apiHeaders(env) }, env);
    expect(await get.json()).toMatchObject({ configured: true, last4: "7777", model: "claude-3-5-sonnet-latest" });

    const del = await app.request(`/v1/repos/${REPO}/ai-key`, { method: "DELETE", headers: apiHeaders(env) }, env);
    expect(await del.json()).toEqual({ configured: false });
    expect(await (await app.request(`/v1/repos/${REPO}/ai-key`, { headers: apiHeaders(env) }, env)).json()).toEqual({ configured: false });
  });

  it("rejects an invalid key payload (400)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(`/v1/repos/${REPO}/ai-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ provider: "anthropic", key: "short" }) }, env);
    expect(res.status).toBe(400);
  });

  it("reports 503 when key storage (encryption secret) is unavailable", async () => {
    const app = createApp();
    const env = createTestEnv({});
    const res = await app.request(`/v1/repos/${REPO}/ai-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ provider: "openai", key: "sk-openai-valid-key-123456" }) }, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "encryption_unavailable" });
  });
});

describe("maintainer route authz (session-scoped)", () => {
  const OWNED = "/v1/repos/repo-owner/owned-repo";

  // Role resolution (loadControlPanelRoleSummary) makes a miner-detection fetch; stub it so session role
  // derivation is deterministic in tests.
  afterEach(() => vi.unstubAllGlobals());
  function stubMinerFetch() {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("gittensor.io")) return Response.json([]);
      return new Response("not found", { status: 404 });
    });
  }

  it("rejects unauthenticated access on every method", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    expect((await app.request(`${OWNED}/ai-key`, {}, env)).status).toBe(401);
    expect((await app.request(`${OWNED}/ai-key`, { method: "POST", body: "{}" }, env)).status).toBe(401);
    expect((await app.request(`${OWNED}/ai-key`, { method: "DELETE" }, env)).status).toBe(401);
    expect((await app.request(`${OWNED}/ai-review`, { method: "PUT", body: "{}" }, env)).status).toBe(401);
  });

  it("allows the repo owner via session to write the AI-review config", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    stubMinerFetch();
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const res = await app.request(`${OWNED}/ai-review`, { method: "PUT", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "advisory", byok: true, provider: "anthropic" }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "advisory", aiReviewProvider: "anthropic" });
  });

  it("allows the repo owner via session to set a BYOK key", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    stubMinerFetch();
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const res = await app.request(`${OWNED}/ai-key`, { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic", key: "sk-ant-owner-key-4242" }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, provider: "anthropic", last4: "4242" });
  });

  it("forbids a session with no role for the repo on every AI route (403)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    const { token } = await createSessionForGitHubUser(env, { login: "someone-else", id: 999 });
    const cookie = `gittensory_session=${token}`;
    const json = { cookie, "content-type": "application/json" };
    expect((await app.request(`${OWNED}/ai-key`, { headers: { cookie } }, env)).status).toBe(403);
    expect((await app.request(`${OWNED}/ai-key`, { method: "POST", headers: json, body: JSON.stringify({ provider: "anthropic", key: "sk-ant-nope-000000000" }) }, env)).status).toBe(403);
    expect((await app.request(`${OWNED}/ai-key`, { method: "DELETE", headers: { cookie } }, env)).status).toBe(403);
    expect((await app.request(`${OWNED}/ai-review`, { method: "PUT", headers: json, body: JSON.stringify({ mode: "advisory", byok: false }) }, env)).status).toBe(403);
  });

  it("forbids a maintainer of one repo from configuring a different repo (cross-repo)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    await seedRepo(env, "other-owner", "other-repo", 202);
    stubMinerFetch();
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const res = await app.request("/v1/repos/other-owner/other-repo/ai-key", { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(res.status).toBe(403);
  });
});
