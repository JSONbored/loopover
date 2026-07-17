import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { createPendingAgentActionIfAbsent, upsertInstallation, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
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
}

describe("automation-state route (#6742)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);

    const res = await app.request("/v1/repos/owner/repo/automation-state", {}, env);

    expect(res.status).toBe(401);
  });

  it("allows a repository owner session to read the automation state, matching buildAutomationStateResponse's shape", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", label: "auto_with_approval" }, agentDryRun: true });
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 101, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 101 });

    const res = await app.request("/v1/repos/owner/repo/automation-state", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      repoFullName: "owner/repo",
      configured: true,
      mode: "dry_run",
      actingActionClasses: expect.arrayContaining(["merge", "label"]),
      pendingActionCount: 1,
    });
  });

  it("reports unconfigured + not_required readiness and zero pending actions for a repo with no settings row", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 101 });

    const res = await app.request("/v1/repos/owner/repo/automation-state", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      configured: false,
      actingActionClasses: [],
      permissionReadiness: "not_required",
      pendingActionCount: 0,
      mode: "live",
    });
  });

  it("forbids a maintainer of repo A from reading repo B's automation state", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "alice", "repo-a", 101);
    await seedOwnedRepo(env, "bob", "repo-b", 102);
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 101 });

    const res = await app.request("/v1/repos/bob/repo-b/automation-state", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });

  it("never leaks a wallet/hotkey/reward term regardless of pending-action detail", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedRepo(env, "owner", "repo", 101);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 101, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "reward estimate leaked" });
    stubMinerDetection();
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 101 });

    const res = await app.request("/v1/repos/owner/repo/automation-state", { headers: { cookie: `loopover_session=${token}` } }, env);

    const body = await res.text();
    expect(body).not.toMatch(/wallet|hotkey|coldkey|reward|payout|trust score/i);
  });
});
