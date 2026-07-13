import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const ISSUE_RAG_PATH = "/v1/issue-rag/retrieve";
const VALID_TITLE = "Add observability context for self-hosted review planning failures";

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

describe("issue-rag retrieve route (#4293)", () => {
  it("returns metadata-only retrieval for API tokens", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRegisteredInstalledRepo(env, 301, "repo-owner", "owned-repo");

    const response = await app.request(
      ISSUE_RAG_PATH,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ owner: "repo-owner", repo: "owned-repo", title: VALID_TITLE }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      repoFullName: "repo-owner/owned-repo",
      telemetry: {
        attempted: expect.any(Boolean),
        injected: expect.any(Boolean),
        retrievedPaths: expect.any(Array),
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/RELEVANT EXISTING CODE|export function/i);
  });

  it("rejects invalid requests and malformed JSON bodies", async () => {
    const app = createApp();
    const env = createTestEnv();

    const invalid = await app.request(
      ISSUE_RAG_PATH,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ owner: "repo-owner", repo: "owned-repo", title: "" }),
      },
      env,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ status: "invalid_request", reason: "title_required" });

    const malformed = await app.request(
      ISSUE_RAG_PATH,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" },
        body: "{not json",
      },
      env,
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ status: "invalid_request", reason: "owner_and_repo_required" });
  });

  it("allows sessions through the path allowlist and scopes repo access", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 301, "repo-owner", "owned-repo");
    await seedRegisteredInstalledRepo(env, 302, "other-owner", "other-repo");

    const { token: ownerToken } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 301 });
    const own = await app.request(
      ISSUE_RAG_PATH,
      {
        method: "POST",
        headers: { cookie: `gittensory_session=${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ owner: "repo-owner", repo: "owned-repo", title: VALID_TITLE }),
      },
      env,
    );
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({
      status: "ok",
      repoFullName: "repo-owner/owned-repo",
    });

    const { token: minerToken } = await createSessionForGitHubUser(env, { login: "miner-only", id: 900 });
    const forbidden = await app.request(
      ISSUE_RAG_PATH,
      {
        method: "POST",
        headers: { cookie: `gittensory_session=${minerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ owner: "repo-owner", repo: "owned-repo", title: VALID_TITLE }),
      },
      env,
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: "forbidden_repo" });

    const { token: otherOwnerToken } = await createSessionForGitHubUser(env, { login: "other-owner", id: 302 });
    const crossRepo = await app.request(
      ISSUE_RAG_PATH,
      {
        method: "POST",
        headers: { cookie: `gittensory_session=${otherOwnerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ owner: "repo-owner", repo: "owned-repo", title: VALID_TITLE }),
      },
      env,
    );
    expect(crossRepo.status).toBe(403);
    await expect(crossRepo.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });
});
