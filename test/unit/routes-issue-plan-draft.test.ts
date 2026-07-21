import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

// #7764: the REST mirror of the remote loopover_plan_repo_issues tool. Same maintainer gate + create-safety
// posture as routes-contributor-issue-draft.test.ts, plus the extra free-form `goal` the plan route requires.
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

describe("issue-plan-drafts route auth", () => {
  afterEach(() => vi.unstubAllGlobals());
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

  it("allows same-repo owner sessions to plan dry-run drafts", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "add cursor pagination", dryRun: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    // env.AI is unset in the test env, so the plan short-circuits to a disabled/unavailable status -- the route
    // still returns 200 with the full result shape, which is all this auth-focused test asserts.
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      dryRun: true,
      createRequested: false,
    });
  });

  it("the plan-path session allowlist entry does not shadow its sibling contributor-drafts route", async () => {
    // The plan and contributor draft routes share one session path-allowlist; a session hitting the contributor
    // path must still fall through the plan-path entry (its `false` arm) and be admitted by the sibling entry.
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const response = await app.request(
      "/v1/repos/repo-owner/owned-repo/contributor-issue-drafts/generate",
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ repoFullName: "repo-owner/owned-repo", dryRun: true });
  });

  it("requires live GitHub write permission before session issue creation", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
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
        body: JSON.stringify({ goal: "add cursor pagination", dryRun: false, create: true, limit: 1 }),
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_repo_permission" });
    expect(mockedPermission).toHaveBeenCalledWith(env, 201, "repo-owner/owned-repo", "reader");
  });

  it("proceeds to the planner once live GitHub write permission is confirmed for a session create", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await upsertPullRequestFromGitHub(env, "repo-owner/owned-repo", {
      number: 6,
      title: "cached collaborator scope",
      state: "open",
      user: { login: "writer" },
      author_association: "COLLABORATOR",
      head: { sha: "b2", ref: "g" },
      base: { ref: "main" },
      labels: [],
    });
    mockedPermission.mockResolvedValue("admin");
    const { token } = await createSessionForGitHubUser(env, { login: "writer", id: 888 });

    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "add cursor pagination", dryRun: false, create: true, limit: 1 }),
      },
      env,
    );
    // Write access is granted, so the create-guard falls through to generateIssuePlanDrafts. With env.AI unset the
    // planner short-circuits to a disabled/unavailable status, but the route still returns its 200 result shape.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ repoFullName: "repo-owner/owned-repo", createRequested: true });
    expect(mockedPermission).toHaveBeenCalledWith(env, 201, "repo-owner/owned-repo", "writer");
  });

  it("rejects cross-repo owner sessions with forbidden_repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await seedRegisteredInstalledRepo(env, 202, "other-owner", "other-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "other-owner", id: 202 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "add cursor pagination", dryRun: true, limit: 1 }),
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

  it("rejects a body with no goal", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ dryRun: true }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_issue_plan_draft_request" });
  });

  it("rejects explicit create without dryRun false", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ goal: "add pagination", create: true }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "explicit_create_requires_dry_run_false" });
  });

  it("returns a dry-run plan for authorized static-token callers, echoing the goal-driven result shape", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ goal: "add cursor pagination", dryRun: true, limit: 2 }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "JSONbored/loopover",
      dryRun: true,
      createRequested: false,
    });
  });
});
