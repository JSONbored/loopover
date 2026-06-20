import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));

const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

const FOCUS_MANIFEST_PATH = "/v1/repos/JSONbored/gittensory/focus-manifest";
const OWNED_REPO_PATH = "/v1/repos/repo-owner/owned-repo/focus-manifest";

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`,
    "content-type": "application/json",
  };
}

async function seedRegisteredInstalledRepo(env: Env, installationId: number, owner: string, name: string): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", contents: "read" },
      events: ["repository"],
    },
  });
  await upsertRepositoryFromGitHub(
    env,
    { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } },
    installationId,
  );
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?")
    .bind(`${owner}/${name}`)
    .run();
}

describe("focus-manifest route auth", () => {
  beforeEach(() => mockedPermission.mockReset());
  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(FOCUS_MANIFEST_PATH, {}, env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects unauthorized session access", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "new-user", id: 2468 });
    const response = await app.request(FOCUS_MANIFEST_PATH, { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("allows same-repo owner sessions with GitHub write permission to read and update focus manifests", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    mockedPermission.mockResolvedValue("write");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const cookie = `gittensory_session=${token}`;

    const getResponse = await app.request(OWNED_REPO_PATH, { headers: { cookie } }, env);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      manifest: { present: expect.any(Boolean) },
      policy: { present: expect.any(Boolean) },
    });

    const putResponse = await app.request(
      OWNED_REPO_PATH,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ wantedPaths: ["src/"], blockedPaths: ["dist/"] }),
      },
      env,
    );
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      manifest: { present: true, source: "api_record", wantedPaths: ["src/"] },
    });
  });

  it("rejects focus-manifest writes from sessions without live GitHub write permission", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await upsertPullRequestFromGitHub(env, "repo-owner/owned-repo", {
      number: 5,
      title: "docs tweak",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "abc123", ref: "docs" },
      base: { ref: "main" },
      labels: [],
    });
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });

    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "PUT",
        headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ settings: { autonomy: { merge: "auto", close: "auto", approve: "auto" } } }),
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_repo_permission" });
  });

  it("rejects cross-repo owner sessions with forbidden_repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await seedRegisteredInstalledRepo(env, 202, "other-owner", "other-repo");
    const { token: ownerToken } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const { token: otherOwnerToken } = await createSessionForGitHubUser(env, { login: "other-owner", id: 202 });
    const ownerCookie = `gittensory_session=${ownerToken}`;
    const otherOwnerCookie = `gittensory_session=${otherOwnerToken}`;

    const crossRepoGet = await app.request(OWNED_REPO_PATH, { headers: { cookie: otherOwnerCookie } }, env);
    expect(crossRepoGet.status).toBe(403);
    await expect(crossRepoGet.json()).resolves.toMatchObject({ error: "forbidden_repo" });

    const crossRepoPut = await app.request(
      OWNED_REPO_PATH,
      {
        method: "PUT",
        headers: { cookie: otherOwnerCookie, "content-type": "application/json" },
        body: JSON.stringify({ wantedPaths: ["src/"] }),
      },
      env,
    );
    expect(crossRepoPut.status).toBe(403);
    await expect(crossRepoPut.json()).resolves.toMatchObject({ error: "forbidden_repo" });

    const ownRepoGet = await app.request(OWNED_REPO_PATH, { headers: { cookie: ownerCookie } }, env);
    expect(ownRepoGet.status).toBe(200);
  });

  it("allows a same-repo owner session with GitHub write permission to POST focus-manifest refresh", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await seedRegisteredInstalledRepo(env, 202, "other-owner", "other-repo");
    mockedPermission.mockResolvedValue("write");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const { token: otherToken } = await createSessionForGitHubUser(env, { login: "other-owner", id: 202 });

    // Same-repo owner session must reach the refresh handler (was 403'd by the blanket session gate).
    const refreshed = await app.request(`${OWNED_REPO_PATH}/refresh`, { method: "POST", headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ repoFullName: "repo-owner/owned-repo" });

    // Cross-repo owner session is still rejected -- by the route handler (forbidden_repo), not the blanket middleware.
    const crossRepo = await app.request(`${OWNED_REPO_PATH}/refresh`, { method: "POST", headers: { cookie: `gittensory_session=${otherToken}` } }, env);
    expect(crossRepo.status).toBe(403);
    await expect(crossRepo.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });

  it("rejects focus-manifest refresh from sessions without live GitHub write permission", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await upsertPullRequestFromGitHub(env, "repo-owner/owned-repo", {
      number: 6,
      title: "manifest docs",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "def456", ref: "docs" },
      base: { ref: "main" },
      labels: [],
    });
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });

    const response = await app.request(`${OWNED_REPO_PATH}/refresh`, { method: "POST", headers: { cookie: `gittensory_session=${token}` } }, env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_repo_permission" });
  });

  it("allows operator sessions to access any repo focus manifest", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const response = await app.request(OWNED_REPO_PATH, { headers: { cookie: `gittensory_session=${token}` } }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ repoFullName: "repo-owner/owned-repo" });
  });

  it("returns bundled manifest and policy for authorized static-token callers", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_DRIFT_ISSUE_REPO: "JSONbored/gittensory" });
    const response = await app.request(FOCUS_MANIFEST_PATH, { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "JSONbored/gittensory",
      manifest: {
        present: true,
        wantedPaths: expect.arrayContaining(["apps/gittensory-ui/"]),
        blockedPaths: expect.arrayContaining(["site/"]),
      },
      policy: {
        present: true,
        publicSafe: expect.objectContaining({
          contributionLanes: expect.arrayContaining([
            expect.objectContaining({
              id: "direct-pr",
              discouragedPaths: expect.arrayContaining(["site/"]),
            }),
          ]),
        }),
      },
    });
  });

  it("does not refresh cached manifests from GET query parameters", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_DRIFT_ISSUE_REPO: "JSONbored/gittensory" });
    const headers = apiHeaders(env);
    const putResponse = await app.request(
      FOCUS_MANIFEST_PATH,
      { method: "PUT", headers, body: JSON.stringify({ wantedPaths: ["private-cache/"] }) },
      env,
    );
    expect(putResponse.status).toBe(200);

    const response = await app.request(`${FOCUS_MANIFEST_PATH}?refresh=true`, { headers }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      manifest: { present: true, source: "api_record", wantedPaths: ["private-cache/"] },
    });
  });

  it("refreshes cached manifests from an unsafe POST endpoint", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_DRIFT_ISSUE_REPO: "JSONbored/gittensory" });
    const headers = apiHeaders(env);
    const putResponse = await app.request(
      FOCUS_MANIFEST_PATH,
      { method: "PUT", headers, body: JSON.stringify({ wantedPaths: ["private-cache/"] }) },
      env,
    );
    expect(putResponse.status).toBe(200);

    const refreshed = await app.request(`${FOCUS_MANIFEST_PATH}/refresh`, { method: "POST", headers }, env);
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      manifest: { present: true, source: "repo_file", wantedPaths: expect.arrayContaining(["apps/gittensory-ui/"]) },
    });
  });

  it("rejects malformed JSON on PUT with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      FOCUS_MANIFEST_PATH,
      { method: "PUT", headers: { ...apiHeaders(env), "content-type": "application/json" }, body: "not-json" },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("accepts an empty JSON object on PUT by falling back to defaults", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      FOCUS_MANIFEST_PATH,
      { method: "PUT", headers: apiHeaders(env), body: JSON.stringify({}) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      manifest: { present: false, source: "api_record" },
    });
  });

  it("persists API-backed manifest updates for authorized callers", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      FOCUS_MANIFEST_PATH,
      {
        method: "PUT",
        headers: apiHeaders(env),
        body: JSON.stringify({
          wantedPaths: ["src/"],
          blockedPaths: ["dist/"],
          publicNotes: ["Keep changes focused."],
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "JSONbored/gittensory",
      manifest: {
        present: true,
        source: "api_record",
        wantedPaths: ["src/"],
        blockedPaths: ["dist/"],
      },
    });
  });
});
