import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { resolveRepositorySettings } from "../../src/settings/repository-settings";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// #9297: loopover_get_repo_settings mirrors GET /v1/repos/:owner/:repo/settings -- the RAW effective settings
// row (resolveRepositorySettings), maintainer-gated like the REST route, distinct from the derived
// automation-state / gate-config-effective views that already have MCP tools.
async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-repo-settings-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_get_repo_settings (#9297)", () => {
  it("returns a repo's RAW effective settings for an authorized (maintainer-scoped) caller", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", gatePack: "oss-anti-slop", slopGateMode: "block", autonomy: { merge: "auto" } });

    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_repo_settings", arguments: { owner: "owner", repo: "repo" } });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.gatePack).toBe("oss-anti-slop");
    expect(data.slopGateMode).toBe("block");
    // No reward/wallet/hotkey leakage in the exposed settings surface.
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("REGRESSION (#9297): its output is byte-identical to GET /v1/repos/:owner/:repo/settings for the same repo", async () => {
    // The REST route returns `resolveRepositorySettings(env, fullName)` unmodified; this tool must return the
    // exact same row (no derived fields, no reshaping) so the two surfaces cannot drift.
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", commentMode: "all_prs", reviewCheckMode: "required" });

    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_repo_settings", arguments: { owner: "owner", repo: "repo" } });

    const restShape = await resolveRepositorySettings(env, "owner/repo");
    expect(result.structuredContent).toEqual(restShape);
  });

  it("forbids a static MCP-token caller when the repo is not in MCP_READ_REPO_ALLOWLIST (#2455)", async () => {
    // "" overrides createTestEnv's own MCP_READ_REPO_ALLOWLIST: "*" default back to unset, exercising the real
    // deny-by-default maintainer boundary (requireRepoAccess throws -> isError, never leaking the settings row).
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }
    const result = await client.callTool({ name: "loopover_get_repo_settings", arguments: { owner: "owner", repo: "repo" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/cannot access this repository/i);
  });
});
