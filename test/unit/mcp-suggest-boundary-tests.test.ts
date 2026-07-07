import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-boundary-tests-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP gittensory_suggest_boundary_tests (#1972)", () => {
  it("returns a finding + action spec when a boundary pattern is touched with no test evidence", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_suggest_boundary_tests",
      arguments: {
        changedFiles: [{ path: "src/list.ts" }],
        boundaryTouches: [{ path: "src/list.ts", kind: "empty_collection_check" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { finding: { code: string } | null; spec: { action: string; touches: unknown[] } | null };
    expect(data.finding?.code).toBe("boundary_test_generation_available");
    expect(data.spec?.action).toBe("scaffold_boundary_tests");
    expect(data.spec?.touches).toEqual([{ path: "src/list.ts", kind: "empty_collection_check" }]);
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("returns no finding and no spec when boundary touches already have test evidence", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_suggest_boundary_tests",
      arguments: {
        changedFiles: [{ path: "src/list.ts" }],
        boundaryTouches: [{ path: "src/list.ts", kind: "empty_collection_check" }],
        testFiles: ["test/unit/list.test.ts"],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { finding: unknown; spec: unknown };
    expect(data.finding).toBeNull();
    expect(data.spec).toBeNull();
  });

  it("returns no finding when nothing touches a boundary pattern", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_suggest_boundary_tests",
      arguments: {
        changedFiles: [{ path: "src/util.ts" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { finding: unknown };
    expect(data.finding).toBeNull();
  });

  it("rejects raw patch input at the MCP boundary", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_suggest_boundary_tests",
      arguments: {
        changedFiles: [{ path: "src/list.ts", patch: "+if (items.length === 0) return null;\n" }],
      },
    });
    expect(result.isError).toBe(true);
  });

  it("ignores boundary touches for files not listed in changedFiles", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_suggest_boundary_tests",
      arguments: {
        changedFiles: [{ path: "src/list.ts" }],
        boundaryTouches: [{ path: "src/other.ts", kind: "empty_collection_check" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { finding: unknown; spec: unknown };
    expect(data.finding).toBeNull();
    expect(data.spec).toBeNull();
  });
});
