import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const DRAFTS_PATH = "/v1/repos/JSONbored/gittensory/contributor-issue-drafts/generate";
const OWNED_REPO_PATH = "/v1/repos/repo-owner/owned-repo/contributor-issue-drafts/generate";

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

describe("contributor-issue-drafts route auth", () => {
  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(DRAFTS_PATH, { method: "POST", body: "{}" }, env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects unauthorized session access", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "new-user", id: 2468 });
    const response = await app.request(
      DRAFTS_PATH,
      { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("allows same-repo owner sessions to generate dry-run drafts", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      dryRun: true,
      drafts: expect.any(Array),
    });
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
        headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true, limit: 1 }),
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
      DRAFTS_PATH,
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
      DRAFTS_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ create: true }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "explicit_create_requires_dry_run_false" });
  });

  it("rejects invalid request bodies", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      DRAFTS_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ limit: "many" }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_contributor_issue_draft_request" });
  });

  it("returns dry-run drafts for authorized static-token callers", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_DRIFT_ISSUE_REPO: "JSONbored/gittensory" });
    const response = await app.request(
      DRAFTS_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ dryRun: true, limit: 2 }) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "JSONbored/gittensory",
      dryRun: true,
      createRequested: false,
      drafts: expect.any(Array),
    });
  });
});
