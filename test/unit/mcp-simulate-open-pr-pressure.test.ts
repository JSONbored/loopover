import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-open-pr-pressure-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function queueHealth(level: "low" | "medium" | "high" | "critical", overrides: { openIssues?: number; openPullRequests?: number; stalePullRequests?: number } = {}) {
  return {
    repoFullName: "acme/widgets",
    generatedAt: "2026-07-08T00:00:00.000Z",
    burdenScore: 0,
    level,
    summary: `Queue pressure is ${level}.`,
    signals: {
      openIssues: overrides.openIssues ?? 4,
      openPullRequests: overrides.openPullRequests ?? 6,
      unlinkedPullRequests: 0,
      stalePullRequests: overrides.stalePullRequests ?? 0,
      draftPullRequests: 0,
      maintainerAuthoredPullRequests: 0,
      collisionClusters: 0,
      ageBuckets: { under7Days: 3, days7To30: 2, over30Days: 1 },
      likelyReviewablePullRequests: 5,
    },
    findings: [],
  };
}

type Scenario = { option: string; label: string; rank: number; recommended: boolean; facts: string[] };
type Simulation = {
  repoFullName: string;
  generatedAt: string;
  lane: string;
  queuePressure: string;
  recommendedOption: string;
  scenarios: Scenario[];
  summary: string;
};

describe("MCP gittensory_simulate_open_pr_pressure (#2224)", () => {
  it("registers with an outputSchema and needs no repo access", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_simulate_open_pr_pressure");
    expect(tool).toBeDefined();
    expect(tool?.outputSchema?.type).toBe("object");
  });

  it("recommends opening new work for a contributor with no open PRs under low pressure", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_simulate_open_pr_pressure",
      arguments: {
        repoFullName: "acme/widgets",
        generatedAt: "2026-07-08T00:00:00.000Z",
        queueHealth: queueHealth("low"),
        roleContext: { maintainerLane: false },
        contributorOpenPrCount: 0,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Simulation;
    expect(data.repoFullName).toBe("acme/widgets");
    expect(data.lane).toBe("contributor");
    expect(data.queuePressure).toBe("low");
    expect(data.recommendedOption).toBe("open_new_work");
    expect(data.scenarios).toHaveLength(3);
    expect(data.scenarios[0]).toMatchObject({ option: "open_new_work", rank: 1, recommended: true });
    expect(data.summary).toContain("contributor");
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|coldkey|reward|payout|trust score/i);
  });

  it("recommends cleaning up first when a contributor already has open work under heavy pressure", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_simulate_open_pr_pressure",
      arguments: {
        repoFullName: "acme/widgets",
        generatedAt: "2026-07-08T00:00:00.000Z",
        queueHealth: queueHealth("high", { stalePullRequests: 2 }),
        roleContext: { maintainerLane: false },
        contributorOpenPrCount: 3,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Simulation;
    expect(data.queuePressure).toBe("high");
    expect(data.recommendedOption).toBe("cleanup_first");
    expect(data.scenarios.map((s) => s.option)).toEqual(["cleanup_first", "wait", "open_new_work"]);
  });

  it("ranks maintainer-lane authors separately", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_simulate_open_pr_pressure",
      arguments: {
        repoFullName: "acme/widgets",
        generatedAt: "2026-07-08T00:00:00.000Z",
        queueHealth: queueHealth("critical"),
        roleContext: { maintainerLane: true },
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Simulation;
    expect(data.lane).toBe("maintainer");
    expect(data.recommendedOption).toBe("cleanup_first");
    expect(data.summary).toContain("maintainer");
  });

  it("falls back to unknown pressure when queue health is unavailable", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_simulate_open_pr_pressure",
      arguments: {
        repoFullName: "acme/widgets",
        generatedAt: "2026-07-08T00:00:00.000Z",
        queueHealth: null,
        roleContext: { maintainerLane: false },
        contributorOpenPrCount: 0,
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Simulation;
    expect(data.queuePressure).toBe("unknown");
    expect(data.recommendedOption).toBe("wait");
    expect(data.summary).toMatch(/conservative default|unavailable/i);
  });

  it("rejects a null role context at the MCP boundary", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_simulate_open_pr_pressure",
      arguments: {
        repoFullName: "acme/widgets",
        generatedAt: "2026-07-08T00:00:00.000Z",
        queueHealth: queueHealth("low"),
        roleContext: null,
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects queue health without bounded numeric signals at the MCP boundary", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_simulate_open_pr_pressure",
      arguments: {
        repoFullName: "acme/widgets",
        generatedAt: "2026-07-08T00:00:00.000Z",
        queueHealth: { level: "low" },
        roleContext: { maintainerLane: false },
      },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects oversized string queue counts before they can be reflected in output", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_simulate_open_pr_pressure",
      arguments: {
        repoFullName: "acme/widgets",
        generatedAt: "2026-07-08T00:00:00.000Z",
        queueHealth: {
          ...queueHealth("low"),
          signals: {
            ...queueHealth("low").signals,
            openPullRequests: "x".repeat(1024),
          },
        },
        roleContext: { maintainerLane: false },
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("x".repeat(512));
  });
});
