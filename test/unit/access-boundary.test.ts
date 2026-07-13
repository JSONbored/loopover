import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// The miner ⊕ maintainer access boundary, locked against regression.
//   • Identity is per-login: a session reads ONLY its own contributor/miner data.
//   • Authority is per-repo: a session reads maintainer data ONLY for repos it maintains.
//   • Maintainer-of-repo-A grants ZERO access to repo B. Operators and server tokens bypass per-repo scope.
// GET /v1/repos/:owner/:repo/settings is the maintainer-DATA exemplar (repo gittensory config).

async function seedOwnedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: owner, id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(`${owner}/${name}`).run();
}

// Role derivation (loadControlPanelRoleSummary) makes a miner-detection fetch; stub it for determinism.
function stubMinerDetection(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString().includes("gittensor.io")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
}

const SETTINGS_A = "/v1/repos/alice/repo-a/settings";
const SETTINGS_B = "/v1/repos/bob/repo-b/settings";

async function setup(extraEnv: Partial<Env> = {}) {
  const app = createApp();
  const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "", ...extraEnv });
  await seedOwnedRepo(env, "alice", "repo-a", 101);
  await seedOwnedRepo(env, "bob", "repo-b", 102);
  stubMinerDetection();
  return { app, env };
}

describe("access boundary: per-repo maintainer data is repo-scoped", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a maintainer reads their OWN repo's settings but NOT another maintainer's repo", async () => {
    const { app, env } = await setup();
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 101 });
    const cookie = `gittensory_session=${token}`;
    expect((await app.request(SETTINGS_A, { headers: { cookie } }, env)).status).toBe(200);
    const other = await app.request(SETTINGS_B, { headers: { cookie } }, env);
    expect(other.status).toBe(403); // maintainer of A cannot reach B's maintainer data
    expect(await other.json()).toMatchObject({ error: "forbidden_repo" });
  });

  it("a maintainer can REACH validate-linked-issue on their OWN repo, scoped per-repo (allowlist parity with check-before-start)", async () => {
    const { app, env } = await setup();
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 101 });
    const cookie = `gittensory_session=${token}`;
    // Before the fix this returned 403 insufficient_role at the session allowlist (the route was omitted),
    // even though the handler's requireSessionRepoAccess guard would admit a maintainer of their own repo.
    const own = await app.request(
      "/v1/repos/alice/repo-a/validate-linked-issue",
      { method: "POST", headers: { cookie }, body: JSON.stringify({ issueNumber: 1 }) },
      env,
    );
    expect(own.status).toBe(200);
    // The per-route guard still scopes: maintainer of A cannot validate against B.
    const other = await app.request(
      "/v1/repos/bob/repo-b/validate-linked-issue",
      { method: "POST", headers: { cookie }, body: JSON.stringify({ issueNumber: 1 }) },
      env,
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: "forbidden_repo" });
  });

  it("a maintainer can REACH agent pending-actions on their OWN repo (allowlist parity with audit-feed)", async () => {
    const { app, env } = await setup();
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 101 });
    const cookie = `gittensory_session=${token}`;
    const own = await app.request("/v1/repos/alice/repo-a/agent/pending-actions", { headers: { cookie } }, env);
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ repoFullName: "alice/repo-a", pendingActions: [] });
  });

  it("a pure miner (no maintainer role on any repo) cannot read ANY repo's maintainer settings", async () => {
    const { app, env } = await setup();
    const { token } = await createSessionForGitHubUser(env, { login: "miner-only", id: 900 });
    const res = await app.request(SETTINGS_A, { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_role" });
  });

  it("an operator bypasses per-repo scope (can read any repo's settings)", async () => {
    const { app, env } = await setup({ ADMIN_GITHUB_LOGINS: "ops-admin" });
    const { token } = await createSessionForGitHubUser(env, { login: "ops-admin", id: 9 });
    expect((await app.request(SETTINGS_B, { headers: { cookie: `gittensory_session=${token}` } }, env)).status).toBe(200);
  });

  it("a server-to-server token reads settings without per-repo session scope", async () => {
    const { app, env } = await setup();
    const res = await app.request(SETTINGS_A, { headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } }, env);
    expect(res.status).toBe(200);
  });

  it("unauthenticated access is rejected", async () => {
    const { app, env } = await setup();
    expect((await app.request(SETTINGS_A, {}, env)).status).toBe(401);
  });

  it("the dual miner+maintainer case: maintainer of A still cannot reach repo B", async () => {
    // A login can be both a miner (contributor) and a maintainer of specific repos. Maintaining repo-a
    // grants no access to repo-b — the two scopes are independent and per-repo.
    const { app, env } = await setup();
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 101 });
    const cookie = `gittensory_session=${token}`;
    expect((await app.request(SETTINGS_A, { headers: { cookie } }, env)).status).toBe(200);
    expect((await app.request(SETTINGS_B, { headers: { cookie } }, env)).status).toBe(403);
  });
});

describe("access boundary: contributor (miner) data is self-scoped", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a non-maintainer session cannot reach another login's contributor surface", async () => {
    // Contributor routes are not in the session path allowlist, so a non-operator session is rejected by
    // the global middleware (insufficient_role) regardless of the requested login — miners reach their own
    // contributor data through the per-user MCP, never another miner's via the HTTP surface.
    const { app, env } = await setup();
    const { token } = await createSessionForGitHubUser(env, { login: "miner-only", id: 900 });
    const res = await app.request("/v1/contributors/alice/profile", { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(res.status).toBe(403);
  });
});
