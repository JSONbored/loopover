import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp, MCP_TOOL_CATEGORIES, MCP_TOOL_CATEGORY_IDS } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function listRegisteredTools() {
  const mcpServer = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "tool-category-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return { client, tools };
}

// #6301 — every registered tool carries exactly one category, surfaced as MCP `_meta.category` so
// tools/list clients (and the CLI `tools` command) can group the surface instead of reading a flat list.
describe("MCP remote server tool categorization (#6301)", () => {
  it("exposes exactly one known category on every registered tool via _meta", async () => {
    const { client, tools } = await listRegisteredTools();
    const validIds = new Set<string>(MCP_TOOL_CATEGORY_IDS);
    expect(tools.length).toBeGreaterThan(0);

    const uncategorized: string[] = [];
    const unknown: string[] = [];
    for (const tool of tools) {
      const category = (tool._meta as { category?: unknown } | undefined)?.category;
      if (typeof category !== "string" || category.length === 0) {
        uncategorized.push(tool.name);
        continue;
      }
      if (!validIds.has(category)) unknown.push(`${tool.name}:${category}`);
    }
    expect(uncategorized, `tools missing a category: ${uncategorized.join(", ")}`).toEqual([]);
    expect(unknown, `tools with an unknown category: ${unknown.join(", ")}`).toEqual([]);
    await client.close();
  });

  it("keeps the MCP_TOOL_CATEGORIES map in exact sync with the registered tool set", async () => {
    const { client, tools } = await listRegisteredTools();
    const registered = new Set(tools.map((tool) => tool.name));
    const mapped = new Set(Object.keys(MCP_TOOL_CATEGORIES));

    const missingFromMap = [...registered].filter((name) => !mapped.has(name)).sort();
    const staleInMap = [...mapped].filter((name) => !registered.has(name)).sort();
    expect(missingFromMap, `registered tools with no category entry: ${missingFromMap.join(", ")}`).toEqual([]);
    expect(staleInMap, `category entries for tools that are no longer registered: ${staleInMap.join(", ")}`).toEqual([]);

    // The category surfaced over the wire matches the source-of-truth map for every tool.
    for (const tool of tools) {
      const category = (tool._meta as { category?: unknown } | undefined)?.category;
      expect(category, `wire category mismatch for ${tool.name}`).toBe(MCP_TOOL_CATEGORIES[tool.name]);
    }
    await client.close();
  });

  it("only uses category ids drawn from the canonical id list", () => {
    const validIds = new Set<string>(MCP_TOOL_CATEGORY_IDS);
    for (const [name, category] of Object.entries(MCP_TOOL_CATEGORIES)) {
      expect(validIds.has(category), `${name} maps to unknown category ${category}`).toBe(true);
    }
    // The canonical id list has no duplicates.
    expect(new Set(MCP_TOOL_CATEGORY_IDS).size).toBe(MCP_TOOL_CATEGORY_IDS.length);
  });
});
