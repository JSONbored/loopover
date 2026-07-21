import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { persistUpstreamRulesetSnapshot } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import type { UpstreamRulesetSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-upstream-ruleset-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function ruleset(id: string, generatedAt: string): UpstreamRulesetSnapshotRecord {
  return {
    id,
    sourceRepo: "entrius/gittensor",
    sourceRef: "test",
    commitSha: `${id}-commit`,
    sourceSnapshotIds: [],
    activeModel: "pending_saturation_model",
    registryRepoCount: 1,
    totalEmissionShare: 0.01,
    semanticHash: `${id}-hash`,
    payload: {
      registry: { repoCount: 1, totalEmissionShare: 0.01, repositories: [] },
      scoring: { activeModel: "pending_saturation_model", constants: {}, semanticFlags: {} },
      issueDiscovery: { branchEligibilityRequired: false },
      mirrorLinkage: { solvedByPrRequired: false },
      languageWeights: { count: 0, weights: {} },
      sourceSnapshots: [],
    },
    warnings: [],
    generatedAt,
  };
}

describe("MCP loopover_get_upstream_ruleset (#7807)", () => {
  it("registers as a utility-category no-argument tool", async () => {
    const client = await connect(createTestEnv());
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "loopover_get_upstream_ruleset");
    expect(tool).toBeDefined();
    expect((tool as { _meta?: { category?: string } })._meta?.category).toBe("utility");
    expect(tool?.inputSchema).toMatchObject({ type: "object" });
  });

  it("returns not_found as a normal result when no snapshot exists", async () => {
    const client = await connect(createTestEnv());
    const result = await client.callTool({ name: "loopover_get_upstream_ruleset", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ error: "upstream_ruleset_not_found" });
  });

  it("returns the latest persisted ruleset snapshot", async () => {
    const env = createTestEnv();
    await persistUpstreamRulesetSnapshot(env, ruleset("ruleset-live", "2026-05-30T00:00:00.000Z"));
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_upstream_ruleset", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as UpstreamRulesetSnapshotRecord;
    expect(payload.id).toBe("ruleset-live");
    expect(payload.activeModel).toBe("pending_saturation_model");
    expect(payload.semanticHash).toBe("ruleset-live-hash");
  });
});
