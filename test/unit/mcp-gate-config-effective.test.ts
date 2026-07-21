import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { writeLiveOverride, writeShadowOverride, type StorageEnv } from "../../src/review/auto-apply";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";
const REPO_FULL_NAME = "owner/widgets";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-gate-config-effective-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type GateConfigEffectiveResponse = {
  status?: string;
  repoFullName?: string;
  effective?: { confidenceFloor: number | null; scopeCap: { files: number | null; lines: number | null } };
  shadowPending?: boolean;
};

// #7800 - mirrors GET /v1/repos/:owner/:repo/gate-config/effective's own integration test (#6247), adapted
// to the MCP surface's canAccessRepo/forbidden-payload convention (matching loopover_get_pr_reviewability
// and loopover_get_issue_quality) rather than the REST route's 401/403 status codes.
describe("MCP loopover_get_gate_config_effective (#7800)", () => {
  it("resolves all-null effective thresholds and no soaking shadow when nothing is overridden", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as GateConfigEffectiveResponse;
    expect(data).toEqual({
      repoFullName: REPO_FULL_NAME,
      effective: { confidenceFloor: null, scopeCap: { files: null, lines: null } },
      shadowPending: false,
    });
    // The nullish branch of the summary's confidenceFloor ?? fallback (no override at all).
    expect(JSON.stringify(result.content)).toContain("confidenceFloor=n/a");
  });

  it("resolves a live override plus a soaking shadow, never leaking the shadow's queued recommendation", async () => {
    const env = createTestEnv();
    const storageEnv = env as unknown as StorageEnv;
    await writeLiveOverride(storageEnv, REPO_FULL_NAME, { confidenceFloor: 0.9, scopeCap: { files: 12, lines: 400 } });
    await writeShadowOverride(storageEnv, REPO_FULL_NAME, { confidenceFloor: 0.8 }, "2099-01-01T00:00:00.000Z");
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as GateConfigEffectiveResponse;
    expect(data).toEqual({
      repoFullName: REPO_FULL_NAME,
      effective: { confidenceFloor: 0.9, scopeCap: { files: 12, lines: 400 } },
      shadowPending: true,
    });
    expect(JSON.stringify(data)).not.toMatch(/0\.8/);
    // Numeric branch of the summary's ?? fallback.
    expect(JSON.stringify(result.content)).toContain("confidenceFloor=0.9");
  });

  it("resolves both scopeCap fields to null when the live override only carries a confidence floor", async () => {
    const env = createTestEnv();
    await writeLiveOverride(env as unknown as StorageEnv, REPO_FULL_NAME, { confidenceFloor: 0.5 });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    const data = result.structuredContent as GateConfigEffectiveResponse;
    expect(data).toEqual({
      repoFullName: REPO_FULL_NAME,
      effective: { confidenceFloor: 0.5, scopeCap: { files: null, lines: null } },
      shadowPending: false,
    });
  });

  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_config_effective", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as GateConfigEffectiveResponse;
    expect(data.status).toBe("forbidden");
    expect(data.repoFullName).toBe(REPO);
    expect(JSON.stringify(result.content)).toContain("Forbidden: session cannot access gate config for owner/widgets.");
  });
});
