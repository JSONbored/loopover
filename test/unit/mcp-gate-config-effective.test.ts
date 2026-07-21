import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { writeLiveOverride, writeShadowOverride, type StorageEnv } from "../../src/review/auto-apply";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-gate-config-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type GateConfigResponse = {
  status?: string;
  repoFullName?: string;
  effective?: { confidenceFloor: number | null; scopeCap: { files: number | null; lines: number | null } };
  shadowPending?: boolean;
};

describe("MCP loopover_get_gate_config_effective (#7800)", () => {
  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as GateConfigResponse;
    expect(data.status).toBe("forbidden");
    expect(data.repoFullName).toBe("owner/repo");
  });

  it("returns null effective thresholds and shadowPending false when no override is soaking", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as GateConfigResponse;
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.effective).toEqual({ confidenceFloor: null, scopeCap: { files: null, lines: null } });
    expect(data.shadowPending).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });

  it("returns the resolved live override values and flags a soaking shadow", async () => {
    const env = createTestEnv();
    await writeLiveOverride(env as unknown as StorageEnv, "owner/repo", { confidenceFloor: 0.85, scopeCap: { files: 20, lines: 400 } });
    await writeShadowOverride(env as unknown as StorageEnv, "owner/repo", { confidenceFloor: 0.9 }, "2999-01-01T00:00:00.000Z");
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as GateConfigResponse;
    expect(data.effective).toEqual({ confidenceFloor: 0.85, scopeCap: { files: 20, lines: 400 } });
    expect(data.shadowPending).toBe(true);
    // The queued shadow recommendation itself is never surfaced — only the boolean that one is soaking.
    expect(JSON.stringify(data)).not.toContain("0.9");
  });

  it("nulls the scope cap when the live override sets only a confidence floor", async () => {
    const env = createTestEnv();
    await writeLiveOverride(env as unknown as StorageEnv, "owner/repo", { confidenceFloor: 0.7 });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "repo" } });
    const data = result.structuredContent as GateConfigResponse;
    expect(data.effective).toEqual({ confidenceFloor: 0.7, scopeCap: { files: null, lines: null } });
    expect(data.shadowPending).toBe(false);
  });
});
