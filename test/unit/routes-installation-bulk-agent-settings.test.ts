import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositorySettings, listPullRequests, markPullRequestRegated, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

function stubMinerDetection(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString().includes("gittensor.io")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
}

async function seedOwnedInstallation(env: Env, owner: string, installationId: number, repoNames: string[]): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read" },
      events: ["repository"],
    },
    repositories: repoNames.map((name) => ({ name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } })),
  });
  for (const name of repoNames) {
    await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  }
}

// #9018 (bulk path): mirrors the single-repo pause/resume tool's own catch-up (mcp/server.ts setAgentPaused) --
// PUT /v1/app/installations/:id/agent/bulk-settings applies agentPaused across every repo in an installation
// in one call, so it needs the SAME paused->live catch-up per repo, not just the per-repo MCP tool.
describe("PUT /v1/app/installations/:id/agent/bulk-settings (#7676, #9018)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("#9018: clears lastRegatedAt for every open PR across all repos on a paused->live bulk transition", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedInstallation(env, "owner", 202, ["repo-a", "repo-b"]);
    stubMinerDetection();
    await upsertPullRequestFromGitHub(env, "owner/repo-a", { number: 1, title: "Went green during pause", state: "open", user: { login: "contributor" }, head: { sha: "a1" }, labels: [], body: "" });
    await upsertPullRequestFromGitHub(env, "owner/repo-b", { number: 5, title: "Also went green", state: "open", user: { login: "contributor" }, head: { sha: "b5" }, labels: [], body: "" });
    await markPullRequestRegated(env, "owner/repo-a", 1);
    await markPullRequestRegated(env, "owner/repo-b", 5);
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 202 });
    const headers = { cookie: `loopover_session=${token}`, "content-type": "application/json" };

    const pauseRes = await app.request(
      "/v1/app/installations/202/agent/bulk-settings",
      { method: "PUT", headers, body: JSON.stringify({ agentPaused: true }) },
      env,
    );
    expect(pauseRes.status).toBe(200);
    expect((await getRepositorySettings(env, "owner/repo-a")).agentPaused).toBe(true);
    // Pausing must never clear the marker.
    expect((await listPullRequests(env, "owner/repo-a")).find((pr) => pr.number === 1)?.lastRegatedAt).toBeTruthy();

    const resumeRes = await app.request(
      "/v1/app/installations/202/agent/bulk-settings",
      { method: "PUT", headers, body: JSON.stringify({ agentPaused: false }) },
      env,
    );
    expect(resumeRes.status).toBe(200);
    expect((await getRepositorySettings(env, "owner/repo-a")).agentPaused).toBe(false);
    expect((await listPullRequests(env, "owner/repo-a")).find((pr) => pr.number === 1)?.lastRegatedAt).toBeNull();
    expect((await listPullRequests(env, "owner/repo-b")).find((pr) => pr.number === 5)?.lastRegatedAt).toBeNull();
  });

  it("does not clear lastRegatedAt when the bulk change does not touch agentPaused at all (e.g. only agentDryRun)", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedInstallation(env, "owner", 203, ["repo-c"]);
    stubMinerDetection();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo-c", agentPaused: true });
    await upsertPullRequestFromGitHub(env, "owner/repo-c", { number: 9, title: "Paused repo, unrelated bulk change", state: "open", user: { login: "contributor" }, head: { sha: "c9" }, labels: [], body: "" });
    await markPullRequestRegated(env, "owner/repo-c", 9);
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 203 });

    const res = await app.request(
      "/v1/app/installations/203/agent/bulk-settings",
      { method: "PUT", headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentDryRun: true }) },
      env,
    );

    expect(res.status).toBe(200);
    expect((await getRepositorySettings(env, "owner/repo-c")).agentPaused).toBe(true); // untouched
    expect((await listPullRequests(env, "owner/repo-c")).find((pr) => pr.number === 9)?.lastRegatedAt).toBeTruthy();
  });
});
