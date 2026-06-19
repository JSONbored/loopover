import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createPendingAgentActionIfAbsent, listPendingAgentActions, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

beforeEach(() => {
  mockedPermission.mockReset();
  mockedPermission.mockResolvedValue("write");
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-automation-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type State = {
  configured: boolean;
  autonomy: Record<string, string>;
  agentPaused: boolean;
  agentDryRun: boolean;
  mode: string;
  permissionReadiness: string;
  actingActionClasses: string[];
  pendingActionCount: number;
};

describe("MCP gittensory_get_automation_state (#784)", () => {
  it("surfaces a configured repo's autonomy, mode, readiness, and pending-approval count", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", label: "auto_with_approval" }, agentDryRun: true });
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as State;
    expect(data.configured).toBe(true);
    expect(data.mode).toBe("dry_run"); // agentDryRun → dry_run
    expect(data.permissionReadiness).toBe("ready"); // pull_requests: write granted
    expect(data.actingActionClasses).toEqual(expect.arrayContaining(["merge", "label"]));
    expect(data.pendingActionCount).toBe(1);
    // surfaces the COUNT, not the queue details — no reward/wallet leakage either
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("reports the total pending-approval count beyond the list page size", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
    for (let pullNumber = 1; pullNumber <= 201; pullNumber += 1) {
      await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });
    }

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "repo" } });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as State;
    expect(data.pendingActionCount).toBe(201);
  });

  it("reports unconfigured + not_required readiness for an unknown / un-onboarded repo (no repo record)", async () => {
    const env = createTestEnv();
    // no repo seeded → getRepository returns null (exercises the no-installation path) + default settings.
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "ghost" } });
    const data = result.structuredContent as State;
    expect(data.configured).toBe(false);
    expect(data.actingActionClasses).toEqual([]);
    expect(data.permissionReadiness).toBe("not_required"); // no acting PR-write class
    expect(data.pendingActionCount).toBe(0);
    expect(data.mode).toBe("live"); // nothing paused or dry-run
  });
});

describe("MCP gittensory_propose_action (#784)", () => {
  it("stages a proposed action into the approval queue (idempotent)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);
    const first = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge", mergeMethod: "squash", reason: "clean" } });
    expect(first.isError).toBeFalsy();
    const data = first.structuredContent as { created: boolean; action: { actionClass: string; status: string; pullNumber: number } };
    expect(data.created).toBe(true);
    expect(data.action).toMatchObject({ actionClass: "merge", status: "pending", pullNumber: 7 });

    const pending = await listPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.params).toMatchObject({ mergeMethod: "squash" });
    expect(pending[0]?.autonomyLevel).toBe("auto_with_approval"); // staged, never auto-executes

    const second = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect((second.structuredContent as { created: boolean }).created).toBe(false);
  });

  it("carries the action-specific params (label / reviewBody / closeComment) into the staged action", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);
    await client.callTool({
      name: "gittensory_propose_action",
      arguments: { owner: "owner", repo: "repo", pullNumber: 9, actionClass: "close", label: "gittensory:blocked", reviewBody: "please fix", closeComment: "closing as noise" },
    });
    const [staged] = await listPendingAgentActions(env, { repoFullName: "owner/repo", status: "pending" });
    expect(staged?.params).toMatchObject({ label: "gittensory:blocked", reviewBody: "please fix", closeComment: "closing as noise" });
  });

  it("allows a session that maintains the repo (owned installation)", async () => {
    const env = createTestEnv();
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env, { kind: "session", actor: "owner" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { created: boolean }).created).toBe(true);
  });

  it("errors when the App is not installed on the repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "noinstall", full_name: "owner/noinstall", private: false, owner: { login: "owner" } });
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "noinstall", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/not installed/i);
  });

  it("forbids a session without live GitHub write access to the repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    mockedPermission.mockResolvedValue("read");
    const client = await connect(env, { kind: "session", actor: "rando" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access/i);
    expect(await listPendingAgentActions(env, { repoFullName: "owner/repo" })).toHaveLength(0);
  });

  it("does not trust cached collaborator association without live write permission", async () => {
    const env = createTestEnv();
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", pull_requests: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "x", state: "open", user: { login: "reader" }, author_association: "COLLABORATOR", head: { sha: "sha" } });
    mockedPermission.mockResolvedValue("read");

    const client = await connect(env, { kind: "session", actor: "reader" } as AuthIdentity);
    const result = await client.callTool({ name: "gittensory_propose_action", arguments: { owner: "owner", repo: "repo", pullNumber: 7, actionClass: "merge" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/write access/i);
    expect(mockedPermission).toHaveBeenCalledWith(env, 5, "owner/repo", "reader");
    expect(await listPendingAgentActions(env, { repoFullName: "owner/repo" })).toHaveLength(0);
  });
});
