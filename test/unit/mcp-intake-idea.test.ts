import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-intake-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_intake_idea", () => {
  it("turns a simple idea into a single-issue task-graph with verdict go (spec §4 Example A)", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_intake_idea",
      arguments: {
        id: "idea-A", title: "Retry flaky uploads",
        body: "Our upload client gives up on the first 5xx; it should retry a few times before failing.",
        targetRepo: "acme/widgets", constraints: ["no new dependencies"],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { ok: boolean; verdict: string; taskGraph: { issues: unknown[] } };
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe("go");
    expect(data.taskGraph.issues).toHaveLength(1);
  });

  it("holds a dependent issue at raise when given a multi-step decomposition (spec §4 Example B)", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_intake_idea",
      arguments: {
        id: "idea-B", title: "Add API key auth to the public endpoints",
        body: "Let callers authenticate the read API with an API key instead of leaving it open.",
        targetRepo: "acme/widgets",
        decomposition: [
          { key: "issue-1", title: "Introduce API-key store + validation helper", body: "A valid key validates." },
          { key: "issue-2", title: "Gate the read endpoints behind key validation", body: "Require a valid key.", dependsOn: ["issue-1"] },
        ],
      },
    });
    const data = result.structuredContent as { ok: boolean; verdict: string; taskGraph: { issues: unknown[] } };
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe("raise");
    expect(data.taskGraph.issues).toHaveLength(2);
  });

  it("returns an actionable error list for a malformed/empty submission", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_intake_idea",
      arguments: { title: "missing id and body", targetRepo: "not-a-slug" },
    });
    const data = result.structuredContent as { ok: boolean; errors: string[] };
    expect(data.ok).toBe(false);
    expect(data.errors).toEqual(expect.arrayContaining(["id_required", "body_required", "target_repo_malformed"]));
  });
});

describe("MCP loopover_plan_idea_claims", () => {
  it("routes an idea into a loop claim plan (claimable / deferred / skipped)", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_plan_idea_claims",
      arguments: {
        id: "idea-P", title: "Add API key auth", body: "Authenticate the read API with a key.", targetRepo: "acme/widgets",
        decomposition: [
          { key: "issue-1", title: "Introduce API-key store", body: "validate keys" },
          { key: "issue-2", title: "Gate the read endpoints", body: "require a key", dependsOn: ["issue-1"] },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { ok: boolean; verdict: string; claimPlan: { targetRepo: string; claimable: unknown[]; deferred: unknown[] } };
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe("raise");
    expect(data.claimPlan.targetRepo).toBe("acme/widgets");
    expect(data.claimPlan.claimable).toHaveLength(1); // issue-1
    expect(data.claimPlan.deferred).toHaveLength(1); // issue-2 held on its prerequisite
  });

  it("returns an actionable error for a malformed/empty submission", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "loopover_plan_idea_claims", arguments: { title: "no id/body", targetRepo: "not-a-slug" } });
    const data = result.structuredContent as { ok: boolean; errors: string[] };
    expect(data.ok).toBe(false);
    expect(data.errors).toEqual(expect.arrayContaining(["id_required", "body_required", "target_repo_malformed"]));
  });
});
