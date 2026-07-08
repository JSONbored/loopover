import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { ENRICHMENT_ANALYZERS_URI } from "../../src/review/enrichment-analyzers-taxonomy";
import { createTestEnv } from "../helpers/d1";

const metadataPath = join(process.cwd(), "review-enrichment/analyzer-metadata.json");

async function connectTestClient() {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-enrichment-analyzers-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

describe("MCP enrichment-analyzers resource (#2226)", () => {
  it("discovers the enrichment-analyzers resource", async () => {
    const { client } = await connectTestClient();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(ENRICHMENT_ANALYZERS_URI);
  });

  it("returns analyzers with categories, cost classes, and profiles as JSON", async () => {
    const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      defaultProfile: string;
      analyzers: Array<{ name: string; category: string; cost: string; profiles: string[] }>;
    };
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: ENRICHMENT_ANALYZERS_URI });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content?.mimeType).toBe("application/json");
    if (!content || !("text" in content)) throw new Error("expected text content");
    const body = JSON.parse(content.text ?? "") as {
      defaultProfile: string;
      analyzers: Array<{ name: string; category: string; costClass: string; profiles: string[] }>;
    };
    expect(body.defaultProfile).toBe(raw.defaultProfile);
    expect(body.analyzers).toHaveLength(raw.analyzers.length);
    for (const expected of raw.analyzers) {
      const actual = body.analyzers.find((analyzer) => analyzer.name === expected.name);
      expect(actual).toMatchObject({
        category: expected.category,
        costClass: expected.cost,
        profiles: expected.profiles,
      });
    }
    for (const category of ["supply-chain", "security", "performance", "ownership"]) {
      expect(body.analyzers.some((analyzer) => analyzer.category === category)).toBe(true);
    }
  });
});
