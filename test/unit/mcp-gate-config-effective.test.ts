import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import {
  writeLiveOverride,
  writeShadowOverride,
  type StorageEnv,
} from "../../src/review/auto-apply";
import { createTestEnv } from "../helpers/d1";

type GateConfigResponse = {
  status?: string;
  repoFullName?: string;
  effective?: {
    confidenceFloor: number | null;
    scopeCap: { files: number | null; lines: number | null };
  };
  shadowPending?: boolean;
};

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "loopover-gate-config-test", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_get_gate_config_effective (#7800)", () => {
  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const client = await connect(env);
    const result = await client.callTool({
      name: "loopover_get_gate_config_effective",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as GateConfigResponse).status).toBe(
      "forbidden",
    );
  });

  it("returns empty effective thresholds when no override is stored", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({
      name: "loopover_get_gate_config_effective",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      repoFullName: "owner/repo",
      effective: {
        confidenceFloor: null,
        scopeCap: { files: null, lines: null },
      },
      shadowPending: false,
    });
  });

  it("returns live override values and shadowPending when a shadow is soaking", async () => {
    const env = createTestEnv();
    const storageEnv = env as unknown as StorageEnv;
    await writeLiveOverride(storageEnv, "owner/repo", {
      confidenceFloor: 0.9,
      scopeCap: { files: 12, lines: 400 },
    });
    await writeShadowOverride(
      storageEnv,
      "owner/repo",
      { confidenceFloor: 0.8 },
      "2099-01-01T00:00:00.000Z",
    );
    const client = await connect(env);
    const result = await client.callTool({
      name: "loopover_get_gate_config_effective",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      repoFullName: "owner/repo",
      effective: { confidenceFloor: 0.9, scopeCap: { files: 12, lines: 400 } },
      shadowPending: true,
    });
  });
});
