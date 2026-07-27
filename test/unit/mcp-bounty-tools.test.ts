import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { listBounties, listBountyLifecycleEvents, persistBountyLifecycleEvent, upsertBounty } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "bounty-tools-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

// #9296 — the two new read-only MCP bounty tools that close the bounty read-parity gap with REST.
describe("loopover_list_bounties (#9296)", () => {
  it("registers the tool in tools/list under the discovery category", async () => {
    const client = await connect(createTestEnv());
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_list_bounties");
    expect(tool).toBeDefined();
    expect((tool?._meta as { category?: string } | undefined)?.category).toBe("discovery");
    await client.close();
  });

  it("returns the same bounty set GET /v1/bounties serves, no repo/owner input", async () => {
    const env = createTestEnv();
    await upsertBounty(env, { id: "octo/demo#1", repoFullName: "octo/demo", issueNumber: 1, status: "active", payload: {} });
    await upsertBounty(env, { id: "octo/demo#2", repoFullName: "octo/demo", issueNumber: 2, status: "resolved", payload: { note: "done" } });
    const client = await connect(env);

    const result = await client.callTool({ name: "loopover_list_bounties", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { bounties: unknown[] };
    // Regression: the tool payload must mirror the REST route's data exactly (listBounties(env)).
    expect(data.bounties).toEqual(await listBounties(env));
    expect(data.bounties).toHaveLength(2);
  });

  it("returns an empty list when no bounties are cached", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_list_bounties", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ bounties: [] });
    await client.close();
  });
});

describe("loopover_get_bounty_lifecycle (#9296)", () => {
  it("returns the { bountyId, events } shape GET /v1/bounties/:id/lifecycle serves", async () => {
    const env = createTestEnv();
    await upsertBounty(env, { id: "octo/demo#1", repoFullName: "octo/demo", issueNumber: 1, status: "active", payload: {} });
    await persistBountyLifecycleEvent(env, {
      id: "evt-1",
      bountyId: "octo/demo#1",
      repoFullName: "octo/demo",
      issueNumber: 1,
      status: "active",
      payload: { phase: "opened" },
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    const client = await connect(env);

    const result = await client.callTool({ name: "loopover_get_bounty_lifecycle", arguments: { id: "octo/demo#1" } });
    expect(result.isError).toBeFalsy();
    // Regression: mirrors the REST route's exact body -- id echoed back + the raw lifecycle events.
    expect(result.structuredContent).toEqual({ bountyId: "octo/demo#1", events: await listBountyLifecycleEvents(env, "octo/demo#1") });
    expect((result.structuredContent as { events: unknown[] }).events).toHaveLength(1);
  });

  it("surfaces a tool error (not a silent empty result) when the bounty id is unknown", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_get_bounty_lifecycle", arguments: { id: "missing#1" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/bounty not found/i);
    expect(result.structuredContent).toBeUndefined();
    await client.close();
  });

  it("rejects a missing/empty id at the input-schema boundary", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_get_bounty_lifecycle", arguments: { id: "" } });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
