import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-scorer-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP gittensory_run_local_scorer (#782)", () => {
  it("returns deterministic token scores from changed-file metadata (no repo/auth needed)", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_run_local_scorer",
      arguments: {
        changedFiles: [
          { path: "src/foo.ts", additions: 10, deletions: 2 },
          { path: "src/foo.test.ts", additions: 8 },
          { path: "README.md", additions: 5 },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { tokenScores: { mode: string; sourceTokenScore: number; testTokenScore: number; nonCodeTokenScore: number; totalTokenScore: number }; usage: string };
    expect(data.tokenScores).toMatchObject({ mode: "external_command", sourceTokenScore: 12, testTokenScore: 8, nonCodeTokenScore: 5, totalTokenScore: 25 });
    expect(data.usage).toMatch(/localScorer/);
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("surfaces a validation-failure warning", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_run_local_scorer",
      arguments: { changedFiles: [{ path: "src/a.ts", additions: 4 }], validation: [{ command: "npm test", status: "failed" }] },
    });
    const data = result.structuredContent as { tokenScores: { warnings?: string[] } };
    expect(data.tokenScores.warnings?.[0]).toMatch(/validation reported failures/i);
  });
});
