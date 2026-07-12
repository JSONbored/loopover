import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  createMinerMcpServer,
  MINER_PING_STATUS,
} from "../../packages/gittensory-miner/bin/gittensory-miner-mcp.js";

// Smoke test for the gittensory-miner MCP scaffold (#5153). Drives the real server over an in-memory
// transport (no child process, no AMS state on disk) and exercises the single gittensory_miner_ping tool.

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-test", version: "0.0.0" });
  await Promise.all([createMinerMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function pingText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

describe("gittensory-miner MCP scaffold (#5153)", () => {
  it("exposes exactly the gittensory_miner_ping tool", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["gittensory_miner_ping"]);
  });

  it("gittensory_miner_ping returns the static, non-secret status object", async () => {
    const client = await connectedClient();
    const result = (await client.callTool({ name: "gittensory_miner_ping", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(JSON.parse(pingText(result))).toEqual({ status: "ok", tool: "gittensory_miner_ping" });
    expect(JSON.parse(pingText(result))).toEqual(MINER_PING_STATUS);
  });

  it("returns the same object on every call, with no AMS state required on disk (invariant)", async () => {
    const client = await connectedClient();
    const first = (await client.callTool({ name: "gittensory_miner_ping", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const second = (await client.callTool({ name: "gittensory_miner_ping", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(pingText(first)).toBe(pingText(second));
    expect(JSON.parse(pingText(first))).toEqual(MINER_PING_STATUS);
  });
});
