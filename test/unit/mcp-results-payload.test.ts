import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-results-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_build_results_payload", () => {
  it("packages a completed iteration into a PR link, summary, and diff preview", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_build_results_payload",
      arguments: {
        repoFullName: "acme/widgets",
        prNumber: 42,
        title: "Add retry to uploads",
        changedFiles: [{ path: "src/upload.ts", additions: 12, deletions: 2 }],
        status: "open",
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { prLink: string; summary: string; diffPreview: unknown[]; totals: { files: number } };
    expect(data.prLink).toBe("https://github.com/acme/widgets/pull/42");
    expect(data.summary).toContain("Opened PR #42 in acme/widgets");
    expect(data.diffPreview).toHaveLength(1);
    expect(data.totals.files).toBe(1);
  });

  it("reports no PR when prNumber is null", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_build_results_payload",
      arguments: { repoFullName: "acme/widgets", prNumber: null, title: "No PR produced" },
    });
    const data = result.structuredContent as { prLink: string | null; summary: string };
    expect(data.prLink).toBeNull();
    expect(data.summary).toContain("No pull request was opened");
  });
});
