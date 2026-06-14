import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-slop-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP gittensory_check_slop_risk", () => {
  it("assesses slop from local diff metadata (no repo/auth needed) and returns the rubric", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_check_slop_risk",
      arguments: { changedFiles: [{ path: "src/api/routes.ts", additions: 6, deletions: 1 }], description: "" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { slopRisk: number; band: string; findings: Array<{ code: string }>; rubric: string };
    expect(data.slopRisk).toBeGreaterThan(0);
    expect(["low", "elevated", "high"]).toContain(data.band);
    // Code change + no tests + empty description → both signals.
    expect(data.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["missing_test_evidence", "empty_pr_description"]));
    expect(data.rubric).toContain("slop assessment rubric");
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("returns a clean assessment for a documented, tested change", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_check_slop_risk",
      arguments: {
        changedFiles: [{ path: "src/x.ts", additions: 20, deletions: 3 }, { path: "test/x.test.ts", additions: 15, deletions: 0 }],
        description: "Adds a retry path with regression coverage.",
      },
    });
    const data = result.structuredContent as { slopRisk: number; band: string };
    expect(data.slopRisk).toBe(0);
    expect(data.band).toBe("clean");
  });
});
