import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// #8338: getMaintainerNoise / getAmsMinerCohort / getActivationPreview must use requireRepoAccess
// (cached maintainer/owner/operator scope), matching their REST mirrors and sibling read tools — not the
// live-write requireRepoApprovalQueueAccess gate reserved for approval-queue / write tools.

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
  createInstallationToken: vi.fn(async () => "test-installation-token"),
}));

const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

const READ_REPORT_TOOLS = ["loopover_get_maintainer_noise", "loopover_get_ams_miner_cohort", "loopover_get_activation_preview"] as const;

beforeEach(() => {
  mockedPermission.mockReset();
  // Fail closed on live collaborator lookup — the regression is that these three tools used to deny
  // when this failed even though cached maintainer scope was enough for every sibling read tool.
  mockedPermission.mockRejectedValue(new Error("github collaborator lookup unavailable"));
});

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-read-report-gate-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedOwnedRepo(env: Env): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: 5,
      account: { login: "owner", id: 1, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", contents: "read", pull_requests: "read", issues: "read" },
      events: ["pull_request"],
    },
    repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
}

describe("MCP read-only maintainer report gate parity (#8338)", () => {
  it("REGRESSION (#8338): cached maintainer scope succeeds even when live collaborator lookup fails", async () => {
    const env = createTestEnv();
    await seedOwnedRepo(env);
    // Cached COLLABORATOR association grants maintainer scope via canLoginAccessRepo / requireRepoAccess,
    // but is intentionally insufficient for requireRepoApprovalQueueAccess (live write required).
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 7,
      title: "x",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "sha" },
    });

    const client = await connect(env, { kind: "session", actor: "reader" } as AuthIdentity);
    for (const name of READ_REPORT_TOOLS) {
      const result = await client.callTool({ name, arguments: { owner: "owner", repo: "repo" } });
      expect(result.isError, name).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text, name).toContain("owner/repo");
      expect(text, name).not.toMatch(/wallet|hotkey|raw trust|payout|reward estimate/i);
    }
    // Live lookup must not be required for these read tools after the fix (sibling write tools still use it).
    expect(mockedPermission).not.toHaveBeenCalled();
  });

  it("rejects a session with no cached maintainer/owner scope on all three tools", async () => {
    const env = createTestEnv();
    await seedOwnedRepo(env);

    const client = await connect(env, { kind: "session", actor: "rando" } as AuthIdentity);
    for (const name of READ_REPORT_TOOLS) {
      const result = await client.callTool({ name, arguments: { owner: "owner", repo: "repo" } });
      expect(result.isError, name).toBe(true);
      expect(JSON.stringify(result), name).toMatch(/Forbidden: session cannot access this repository/i);
    }
  });

  it("allows the owning session when live collaborator lookup is unavailable", async () => {
    const env = createTestEnv();
    await seedOwnedRepo(env);

    const client = await connect(env, { kind: "session", actor: "owner" } as AuthIdentity);
    for (const name of READ_REPORT_TOOLS) {
      const result = await client.callTool({ name, arguments: { owner: "owner", repo: "repo" } });
      expect(result.isError, name).toBeFalsy();
    }
    expect(mockedPermission).not.toHaveBeenCalled();
  });
});
