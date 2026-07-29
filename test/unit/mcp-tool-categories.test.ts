import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp, MCP_TOOL_CATEGORIES, MCP_TOOL_CATEGORY_IDS } from "../../src/mcp/server";
import { getToolDefinition } from "@loopover/contract/tools";
import { createTestEnv } from "../helpers/d1";

async function listRegisteredTools() {
  // LOOPOVER_MCP_ADMIN_ENABLED: true -- the "admin" category (#7721) is this server's first-ever
  // CONDITIONALLY-registered tool set (every other tool always registers). The default-off test env
  // would otherwise make this file's own "exact sync" test below permanently fail: those 3 tool names
  // are legitimately always present in MCP_TOOL_CATEGORIES (a static map), but never actually
  // registered unless this flag is on. Enabling it here exercises the FULL possible tool surface, which
  // is what "every map entry has a real, registered tool" should mean.
  const mcpServer = new LoopoverMcp(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" })).createServer();
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

  // #9522: MCP_TOOL_CATEGORIES is DERIVED from the contract registry now, not a hand-kept map, so the
  // "stale entry" half of this test is gone -- an entry can no longer fall out of sync with a tool that
  // exists, and the map deliberately indexes all three servers' tools (locality says where a tool's work
  // happens, not which server exposes it, and a dozen "local-git" tools are registered here too). What
  // still matters, and is what actually caught drift, is that every REGISTERED tool resolves a category.
  it("gives every registered tool a category, matching the wire value", async () => {
    const { client, tools } = await listRegisteredTools();
    const registered = new Set(tools.map((tool) => tool.name));
    const mapped = new Set(Object.keys(MCP_TOOL_CATEGORIES));

    const missingFromMap = [...registered].filter((name) => !mapped.has(name)).sort();
    expect(missingFromMap, `registered tools with no category entry: ${missingFromMap.join(", ")}`).toEqual([]);

    // The category surfaced over the wire matches the source-of-truth map for every tool.
    for (const tool of tools) {
      const category = (tool._meta as { category?: unknown } | undefined)?.category;
      expect(category, `wire category mismatch for ${tool.name}`).toBe(MCP_TOOL_CATEGORIES[tool.name]);
    }
    await client.close();
  });

  // #9655: the posture is the operationally load-bearing half of what a server advertises. An MCP client
  // that gates a confirmation prompt on `destructiveHint` got NOTHING from the server that performs the
  // delete, because no remote registration carried annotations at all.
  it("advertises the contract's posture, so a destructive tool says so", async () => {
    const { client, tools } = await listRegisteredTools();
    const listed = new Map(tools.map((tool) => [tool.name, tool]));

    expect(listed.get("loopover_ops_purge_dead_letter_jobs")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed.get("loopover_admin_rotate_secret")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // And the default posture is MATERIALIZED, not omitted: a read-only tool advertises both hints.
    expect(listed.get("loopover_get_repo_context")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // `loopover_delete_branch` is deliberately NOT in the destructive set: the remote tool BUILDS a
    // local-execution spec and touches nothing, and the hints describe the tool call rather than the
    // command a caller may later choose to run with their own credentials. Advertising the contract's
    // posture faithfully means advertising this one too.
    expect(listed.get("loopover_delete_branch")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    // Every registered tool, against the registry's own projection -- the same comparison validate-mcp
    // makes, asserted here too so a posture regression fails in the fast unit suite as well.
    for (const tool of tools) {
      const projected = getToolDefinition(tool.name);
      expect(tool.title, `title mismatch for ${tool.name}`).toBe(projected?.title);
      expect(tool.annotations, `annotations mismatch for ${tool.name}`).toMatchObject(projected!.annotations);
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
