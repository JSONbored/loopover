import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositorySettings, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

const FULL_NAME = "owner/repo";
const PATH_PREVIEW = "/v1/repos/owner/repo/activation-preview";
const PATH_ACTIVATE = "/v1/repos/owner/repo/activation";

async function seedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: owner, id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(`${owner}/${name}`).run();
}

function stubMinerFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString().includes("gittensor.io")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
}

describe("maintainer activation routes", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => mockedPermission.mockReset());
  it("lets a maintainer preview activation and flip on advisory mode in one action", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-admin" });
    const { token } = await createSessionForGitHubUser(env, { login: "operator-admin", id: 1 });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const preview = await app.request(PATH_PREVIEW, { headers }, env);
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { repoFullName: string; recommendedAction: string | null; currentReviewCheckMode: string; evaluatedCount: number };
    expect(previewBody).toMatchObject({ repoFullName: FULL_NAME, recommendedAction: "enable_advisory", currentReviewCheckMode: "disabled", evaluatedCount: 0 });

    const activate = await app.request(PATH_ACTIVATE, { method: "POST", headers, body: "{}" }, env);
    expect(activate.status).toBe(200);
    expect(await activate.json()).toMatchObject({
      repoFullName: FULL_NAME,
      reviewCheckMode: "required",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
    });

    // The flip persisted, and the preview now reports nothing left to enable.
    expect((await getRepositorySettings(env, FULL_NAME)).reviewCheckMode).toBe("required");
    const afterPreview = await app.request(PATH_PREVIEW, { headers }, env);
    expect((await afterPreview.json() as { recommendedAction: string | null }).recommendedAction).toBeNull();
  });


  it("forbids read-only repo collaborators from activating advisory checks", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 201);
    await upsertPullRequestFromGitHub(env, FULL_NAME, {
      number: 7,
      title: "docs tweak",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "abc123", ref: "docs" },
      base: { ref: "main" },
      labels: [],
    });
    stubMinerFetch();
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });
    const headers = { cookie: `gittensory_session=${token}`, "content-type": "application/json" };

    const preview = await app.request(PATH_PREVIEW, { headers }, env);
    expect(preview.status).toBe(200);

    const activate = await app.request(PATH_ACTIVATE, { method: "POST", headers, body: "{}" }, env);
    expect(activate.status).toBe(403);
    expect(await activate.json()).toMatchObject({ error: "insufficient_repo_permission" });
    expect((await getRepositorySettings(env, FULL_NAME)).reviewCheckMode).toBe("disabled");
  });

  it("allows a session with GitHub write permission to activate advisory checks", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 201);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("write");
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 201 });
    const response = await app.request(PATH_ACTIVATE, { method: "POST", headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" }, body: "{}" }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repoFullName: FULL_NAME, reviewCheckMode: "required" });
  });

  it("forbids read-only repo collaborators from writing agent settings", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 201);
    await upsertPullRequestFromGitHub(env, FULL_NAME, {
      number: 8,
      title: "docs tweak",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "def456", ref: "docs-2" },
      base: { ref: "main" },
      labels: [],
    });
    stubMinerFetch();
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });
    const headers = { cookie: `gittensory_session=${token}`, "content-type": "application/json" };

    const update = await app.request(`${PATH_ACTIVATE.replace("/activation", "/settings")}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ autonomy: { merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "merge" } }),
    }, env);

    expect(update.status).toBe(403);
    expect(await update.json()).toMatchObject({ error: "insufficient_repo_permission" });
    const persisted = await getRepositorySettings(env, FULL_NAME);
    expect(persisted.autonomy).not.toMatchObject({ merge: "auto" });
    expect(persisted.autoMaintain?.requireApprovals).toBe(1);
  });

  it("allows a session with GitHub write permission to update repository settings", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 201);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("write");
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 201 });
    const response = await app.request(`${PATH_ACTIVATE.replace("/activation", "/settings")}`, {
      method: "PUT",
      headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ autonomy: { merge: "auto_with_approval" }, autoMaintain: { requireApprovals: 2, mergeMethod: "rebase" } }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ autonomy: { merge: "auto_with_approval" }, autoMaintain: { requireApprovals: 2, mergeMethod: "rebase" } });
  });

  it("persists selfAuthoredLinkedIssueGateMode from the settings PUT (API/OpenAPI parity)", async () => {
    // The dashboard save path (maintainerSettingsSchema) omitted this DB-backed gate mode, so a maintainer
    // setting it to `block` via the API had it silently stripped by the validator — while its OpenAPI schema
    // and config-as-code path both accept it, and the gate genuinely enforces `block`. Prove the round-trip.
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 202);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("write");
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 202 });
    const response = await app.request(`${PATH_ACTIVATE.replace("/activation", "/settings")}`, {
      method: "PUT",
      headers: { cookie: `gittensory_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ selfAuthoredLinkedIssueGateMode: "block" }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selfAuthoredLinkedIssueGateMode: "block" });
    const persisted = await getRepositorySettings(env, FULL_NAME);
    expect(persisted.selfAuthoredLinkedIssueGateMode).toBe("block");
  });

  it("forbids a non-maintainer session from the activation preview", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-admin" });
    const { token } = await createSessionForGitHubUser(env, { login: "random-user", id: 2 });
    const response = await app.request(PATH_PREVIEW, { headers: { authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(403);
  });

  it("allows a server-to-server token", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(PATH_PREVIEW, { headers: { authorization: `Bearer ${env.GITTENSORY_API_TOKEN}` } }, env);
    expect(response.status).toBe(200);
  });
});
