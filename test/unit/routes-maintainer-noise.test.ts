import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

function stubMinerDetection(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString().includes("gittensor.io")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
}

async function seedOwnedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: owner, id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(`${owner}/${name}`).run();
}

describe("maintainer-noise route (#2228)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    const res = await app.request("/v1/repos/owner/repo/maintainer-noise", {}, env);
    expect(res.status).toBe(401);
  });

  it("allows a repository owner session to read maintainer-noise on their repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 101 });

    const res = await app.request("/v1/repos/owner/repo/maintainer-noise", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      repoFullName: "owner/repo",
      score: expect.any(Number),
      level: expect.any(String),
      noiseSources: expect.any(Array),
    });
  });

  it("forbids a contributor (non-maintainer) session even though the coarse allowlist permits the path", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "contributor", id: 999 });

    const res = await app.request("/v1/repos/owner/repo/maintainer-noise", { headers: { authorization: `Bearer ${token}` } }, env);

    expect([401, 403]).toContain(res.status);
  });

  it("forbids a maintainer of repo A from reading repo B maintainer-noise", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "alice", "repo-a", 101);
    await seedOwnedRepo(env, "bob", "repo-b", 102);
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 101 });

    const res = await app.request("/v1/repos/bob/repo-b/maintainer-noise", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });
});
