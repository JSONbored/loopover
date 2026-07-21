import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

// #7764: REST mirror of the loopover_plan_repo_issues MCP tool. Structure mirrors
// routes-contributor-issue-draft.test.ts exactly (same requireAppRole + requireSessionRepoAccess +
// requireRepoWriteAccess gate), plus the required free-form `goal` and the write-GRANTED branch that lets the
// create path fall through to the service (still dry-run-safe: createTestEnv leaves env.AI unset, so the
// service short-circuits to a `disabled` posture before any GitHub write).
const PLAN_PATH = "/v1/repos/JSONbored/loopover/issue-plan-drafts/generate";
const OWNED_REPO_PATH = "/v1/repos/repo-owner/owned-repo/issue-plan-drafts/generate";

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`,
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

describe("issue-plan-drafts route auth (#7764)", () => {
  beforeEach(() => mockedPermission.mockReset());

  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(PLAN_PATH, { method: "POST", body: "{}" }, env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects unauthorized session access", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "new-user", id: 2468 });
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("allows same-repo owner sessions to preview dry-run drafts", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 301, "repo-owner", "owned-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 301 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "Improve the onboarding docs", dryRun: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      dryRun: true,
      createRequested: false,
      drafts: expect.any(Array),
    });
  });

  it("requires live GitHub write permission before session issue creation", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 301, "repo-owner", "owned-repo");
    await upsertPullRequestFromGitHub(env, "repo-owner/owned-repo", {
      number: 5,
      title: "cached collaborator scope",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "a1", ref: "f" },
      base: { ref: "main" },
      labels: [],
    });
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });

    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "Ship a queue fix", dryRun: false, create: true, limit: 1 }),
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_repo_permission" });
    expect(mockedPermission).toHaveBeenCalledWith(env, 301, "repo-owner/owned-repo", "reader");
  });

  it("lets a write-granted owner session reach the (still-gated) create path", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 301, "repo-owner", "owned-repo");
    // env.AI is unset in createTestEnv, so the service returns a `disabled` posture instead of calling any
    // model or opening any issue -- this test's job is only to cover the write-GRANTED branch of the route's
    // requireRepoWriteAccess gate (the negative branch is covered by the test above).
    mockedPermission.mockResolvedValue("admin");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 301 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "Plan the next milestone", dryRun: false, create: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      createRequested: true,
    });
  });

  it("rejects cross-repo owner sessions with forbidden_repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 301, "repo-owner", "owned-repo");
    await seedRegisteredInstalledRepo(env, 302, "other-owner", "other-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "other-owner", id: 302 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "Anything", dryRun: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });

  it("rejects malformed JSON with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: { ...apiHeaders(env), "content-type": "application/json" }, body: "not-json" },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("rejects explicit create without dryRun false", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ goal: "Improve tests", create: true }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "explicit_create_requires_dry_run_false" });
  });

  it("rejects invalid request bodies (missing goal)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ limit: 2 }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_issue_plan_draft_request" });
  });

  it("returns dry-run drafts for authorized static-token callers", async () => {
    const app = createApp();
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: "JSONbored/loopover" });
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ goal: "Reduce reviewer noise", dryRun: true, limit: 2 }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "JSONbored/loopover",
      dryRun: true,
      createRequested: false,
      drafts: expect.any(Array),
    });
  });
});
