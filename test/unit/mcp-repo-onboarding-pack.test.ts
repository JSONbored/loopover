import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { persistSignalSnapshot, upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "repo-onboarding-pack-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
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

describe("gittensory_get_repo_onboarding_pack MCP tool (#2223)", () => {
  it("returns a structured onboarding-pack preview for an authorized repo maintainer session", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await persistSignalSnapshot(env, {
      id: "owned-repo-focus-manifest",
      signalType: "repo-focus-manifest",
      targetKey: "repo-owner/owned-repo",
      repoFullName: "repo-owner/owned-repo",
      payload: {
        wantedPaths: ["src/"],
        testExpectations: ["npm test"],
        publicNotes: ["Keep onboarding guidance public-safe."],
      },
      generatedAt: new Date().toISOString(),
    });
    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const result = await (await connect(env, { kind: "session", actor: "repo-owner", session })).callTool({
      name: "gittensory_get_repo_onboarding_pack",
      arguments: { owner: "repo-owner", repo: "owned-repo" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      accepted: true,
      policySource: "policy_compiler",
      preview: { previewOnly: true, publicSafe: true },
    });
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("forbids a session that cannot access the repository", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await seedRegisteredInstalledRepo(env, 202, "other-owner", "other-repo");
    const { session } = await createSessionForGitHubUser(env, { login: "other-owner", id: 202 });
    const result = await (await connect(env, { kind: "session", actor: "other-owner", session })).callTool({
      name: "gittensory_get_repo_onboarding_pack",
      arguments: { owner: "repo-owner", repo: "owned-repo" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });

  it("returns repo_not_accepted when the repository is not registered", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, {
      name: "unregistered",
      full_name: "octo/unregistered",
      private: false,
      owner: { login: "octo" },
    });
    const result = await (await connect(env)).callTool({
      name: "gittensory_get_repo_onboarding_pack",
      arguments: { owner: "octo", repo: "unregistered" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      error: "repo_not_accepted",
      repoFullName: "octo/unregistered",
    });
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/not accepted/i) })]);
  });
});
