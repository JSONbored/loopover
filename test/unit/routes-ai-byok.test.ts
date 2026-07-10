import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositorySettings, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositorySettings, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

// The secret-key write gate resolves real GitHub push permission via the installation; mock just that
// call (leave the rest of github/app real) so the per-repo write check is deterministic in tests.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

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
    await upsertRepositorySettings(env, { repoFullName: REPO, gateCheckMode: "enabled", gittensorLabel: "custom-label", blacklistLabel: "abuse" });
    const res = await app.request(
      `/v1/repos/${REPO}/ai-review`,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "block", byok: true, provider: "anthropic", model: "claude-3-5-sonnet-latest", allAuthors: true, closeOwnerAuthors: true }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "block", aiReviewByok: true, aiReviewProvider: "anthropic", aiReviewModel: "claude-3-5-sonnet-latest", aiReviewAllAuthors: true, closeOwnerAuthors: true });
    const settings = await getRepositorySettings(env, REPO);
    expect(settings.aiReviewMode).toBe("block");
    expect(settings.aiReviewAllAuthors).toBe(true); // persisted + read back (DB column round-trip)
    expect(settings.closeOwnerAuthors).toBe(true); // persisted + read back (DB column round-trip)
    expect(settings.gateCheckMode).toBe("enabled"); // preserved
    expect(settings.gittensorLabel).toBe("custom-label"); // preserved
    expect(settings.blacklistLabel).toBe("abuse"); // #1425 round-trips through the DB
  });

  it("defaults closeOwnerAuthors off when the AI-review config omits it", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(
      `/v1/repos/${REPO}/ai-review`,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "block", byok: true, provider: "anthropic", model: "claude-3-5-sonnet-latest", allAuthors: true }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ closeOwnerAuthors: false });
    expect((await getRepositorySettings(env, REPO)).closeOwnerAuthors).toBe(false);
  });

  it("preserves closeOwnerAuthors when an AI-review update omits it", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositorySettings(env, { repoFullName: REPO, closeOwnerAuthors: true });

    const res = await app.request(
      `/v1/repos/${REPO}/ai-review`,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "advisory", byok: false }) },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "advisory", closeOwnerAuthors: true });
    expect((await getRepositorySettings(env, REPO)).closeOwnerAuthors).toBe(true);
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

  it("sets aiReviewLowConfidenceDisposition (#4603) and preserves unrelated settings", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositorySettings(env, { repoFullName: REPO, gateCheckMode: "enabled", gittensorLabel: "custom-label" });
    const res = await app.request(
      `/v1/repos/${REPO}/ai-review`,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "block", byok: false, lowConfidenceDisposition: "advisory_only" }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "block", aiReviewLowConfidenceDisposition: "advisory_only" });
    const settings = await getRepositorySettings(env, REPO);
    expect(settings.aiReviewLowConfidenceDisposition).toBe("advisory_only"); // persisted + read back (DB column round-trip)
    expect(settings.gateCheckMode).toBe("enabled"); // preserved
    expect(settings.gittensorLabel).toBe("custom-label"); // preserved
  });

  it("defaults aiReviewLowConfidenceDisposition to hold_for_review when the AI-review config omits it (fresh repo, no row)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(
      `/v1/repos/${REPO}/ai-review`,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "advisory", byok: false }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewLowConfidenceDisposition: "hold_for_review" });
    expect((await getRepositorySettings(env, REPO)).aiReviewLowConfidenceDisposition).toBe("hold_for_review");
  });

  it("preserves aiReviewLowConfidenceDisposition when an AI-review update omits it (read-modify-write, not a reset)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositorySettings(env, { repoFullName: REPO, aiReviewLowConfidenceDisposition: "one_shot" });

    const res = await app.request(
      `/v1/repos/${REPO}/ai-review`,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "advisory", byok: false }) },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "advisory", aiReviewLowConfidenceDisposition: "one_shot" });
    expect((await getRepositorySettings(env, REPO)).aiReviewLowConfidenceDisposition).toBe("one_shot");
  });

  it("rejects an invalid aiReviewLowConfidenceDisposition value", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(`/v1/repos/${REPO}/ai-review`, { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ mode: "block", lowConfidenceDisposition: "sometimes" }) }, env);
    expect(res.status).toBe(400);
  });

  it("lets maintainer settings set closeOwnerAuthors without resetting unrelated fields", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await upsertRepositorySettings(env, { repoFullName: REPO, gateCheckMode: "enabled", gittensorLabel: "custom-label" });
    const res = await app.request(`/v1/repos/${REPO}/settings`, { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ closeOwnerAuthors: true }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ closeOwnerAuthors: true, gateCheckMode: "enabled", gittensorLabel: "custom-label" });
    const settings = await getRepositorySettings(env, REPO);
    expect(settings.closeOwnerAuthors).toBe(true);
    expect(settings.gateCheckMode).toBe("enabled");
  });

  it("round-trips requireFreshRebaseWindowMinutes through the maintainer settings PUT route (#2552 gate finding)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(`/v1/repos/${REPO}/settings`, { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({ requireFreshRebaseWindowMinutes: 15 }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requireFreshRebaseWindowMinutes: 15 });
    expect((await getRepositorySettings(env, REPO)).requireFreshRebaseWindowMinutes).toBe(15);
  });

  it("lets the internal full settings route persist closeOwnerAuthors", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request(`/v1/internal/repos/${REPO}/settings`, { method: "POST", headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ closeOwnerAuthors: true }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ closeOwnerAuthors: true });
    expect((await getRepositorySettings(env, REPO)).closeOwnerAuthors).toBe(true);
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

  it("rejects a key whose prefix does not match the selected provider (400)", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    // An OpenAI-shaped key stored under Anthropic, and an Anthropic key stored under OpenAI — both rejected.
    const wrongAnthropic = await app.request(`/v1/repos/${REPO}/ai-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ provider: "anthropic", key: "sk-openai-not-anthropic-123456" }) }, env);
    expect(wrongAnthropic.status).toBe(400);
    const wrongOpenai = await app.request(`/v1/repos/${REPO}/ai-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ provider: "openai", key: "sk-ant-not-openai-1234567890" }) }, env);
    expect(wrongOpenai.status).toBe(400);
    // An OpenAI key that doesn't start with sk- at all is also rejected.
    const noPrefix = await app.request(`/v1/repos/${REPO}/ai-key`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ provider: "openai", key: "ghp-not-a-provider-key-12345" }) }, env);
    expect(noPrefix.status).toBe(400);
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
  beforeEach(() => mockedPermission.mockReset());
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

  it("allows the repo owner (admin permission) via session to write the AI-review config", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("admin"); // real GitHub write access
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const res = await app.request(`${OWNED}/ai-review`, { method: "PUT", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "advisory", byok: true, provider: "anthropic" }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aiReviewMode: "advisory", aiReviewProvider: "anthropic" });
  });

  it("allows the repo owner (admin permission) via session to set a BYOK key", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("admin"); // real GitHub write access
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const res = await app.request(`${OWNED}/ai-key`, { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic", key: "sk-ant-owner-key-4242" }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, provider: "anthropic", last4: "4242" });
  });

  it("forbids a read-only collaborator (in scope via a PR, but no push) from AI-review and BYOK key routes", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    // "reader" authored a PR as COLLABORATOR → in maintainer scope, but only has read permission.
    await upsertPullRequestFromGitHub(env, "repo-owner/owned-repo", { number: 5, title: "tweak", state: "open", user: { login: "reader" }, author_association: "COLLABORATOR", head: { sha: "a1", ref: "f" }, base: { ref: "main" }, labels: [] });
    stubMinerFetch();
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });
    const json = { cookie: `gittensory_session=${token}`, "content-type": "application/json" };
    const post = await app.request(`${OWNED}/ai-key`, { method: "POST", headers: json, body: JSON.stringify({ provider: "anthropic", key: "sk-ant-reader-key-9999" }) }, env);
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({ error: "insufficient_repo_permission" });
    // DELETE is gated the same way.
    expect((await app.request(`${OWNED}/ai-key`, { method: "DELETE", headers: { cookie: `gittensory_session=${token}` } }, env)).status).toBe(403);
    // GET key status and AI-review writes are also gated by real GitHub write access.
    expect((await app.request(`${OWNED}/ai-key`, { headers: { cookie: `gittensory_session=${token}` } }, env)).status).toBe(403);
    const review = await app.request(`${OWNED}/ai-review`, { method: "PUT", headers: json, body: JSON.stringify({ mode: "advisory", byok: false }) }, env);
    expect(review.status).toBe(403);
    expect(await review.json()).toMatchObject({ error: "insufficient_repo_permission" });
  });

  it("allows an operator to set the BYOK key without a per-repo push check", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "ops-admin" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    stubMinerFetch();
    const { token } = await createSessionForGitHubUser(env, { login: "ops-admin", id: 9 });
    const res = await app.request(`${OWNED}/ai-key`, { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "openai", key: "sk-openai-operator-key-123" }) }, env);
    expect(res.status).toBe(200);
    expect(mockedPermission).not.toHaveBeenCalled(); // operators skip the push check
  });

  it("fails closed when GitHub reports no write access (permission 'none')", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("none");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const res = await app.request(`${OWNED}/ai-key`, { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic", key: "sk-ant-owner-key-4242" }) }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_repo_permission" });
  });

  it("fails closed when the repo has no installation to verify permission against", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET, ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "repo-owner", "owned-repo", 201);
    // Keep the repo "installed" (so the owner stays in scope) but drop the installation id.
    await env.DB.prepare("UPDATE repositories SET installation_id = NULL WHERE full_name = ?").bind("repo-owner/owned-repo").run();
    stubMinerFetch();
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const res = await app.request(`${OWNED}/ai-key`, { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic", key: "sk-ant-owner-key-4242" }) }, env);
    expect(res.status).toBe(403);
    expect(mockedPermission).not.toHaveBeenCalled();
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
