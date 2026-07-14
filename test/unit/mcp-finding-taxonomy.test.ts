import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { FINDING_CATEGORIES } from "../../src/review/finding-category-classify";
import { FINDING_TAXONOMY_URI } from "../../src/review/finding-taxonomy";
import { REVIEW_FINDING_SEVERITY_LADDER } from "../../src/signals/focus-manifest";
import { createTestEnv } from "../helpers/d1";

async function connectTestClient() {
  const mcpServer = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-finding-taxonomy-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

describe("MCP finding-taxonomy resource (#2225)", () => {
  it("discovers the finding-taxonomy resource", async () => {
    const { client } = await connectTestClient();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(FINDING_TAXONOMY_URI);
  });

  it("returns the canonical categories and severities as JSON", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: FINDING_TAXONOMY_URI });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content?.mimeType).toBe("application/json");
    if (!content || !("text" in content)) throw new Error("expected text content");
    const body = JSON.parse(content.text ?? "") as { categories: string[]; severities: string[] };
    expect(body.categories).toEqual([...FINDING_CATEGORIES]);
    expect(body.severities).toEqual([...REVIEW_FINDING_SEVERITY_LADDER]);
    for (const category of FINDING_CATEGORIES) {
      expect(body.categories).toContain(category);
    }
    for (const severity of REVIEW_FINDING_SEVERITY_LADDER) {
      expect(body.severities).toContain(severity);
    }
  });
});
