import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { createAgentRun, replaceAgentActions, upsertAgentRecommendationOutcome } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "recommendation-quality-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedMergedOutcome(env: Env, updatedAt: string): Promise<void> {
  await createAgentRun(env, {
    id: `run:${updatedAt}`,
    objective: "Track quality",
    actorLogin: "dev",
    surface: "api",
    mode: "copilot",
    status: "completed",
    dataQualityStatus: "complete",
    payload: {},
    createdAt: updatedAt,
    updatedAt,
  });
  await replaceAgentActions(env, `run:${updatedAt}`, [
    {
      id: `action:${updatedAt}`,
      runId: `run:${updatedAt}`,
      actionType: "prepare_pr_packet",
      targetRepoFullName: "owner/repo",
      targetPullNumber: null,
      targetIssueNumber: null,
      status: "recommended",
      recommendation: "pursue",
      why: ["Merged cleanly."],
      blockedBy: [],
      publicSafeSummary: "Merged cleanly.",
      approvalRequired: true,
      safetyClass: "private",
      payload: {},
      createdAt: updatedAt,
    },
  ]);
  await upsertAgentRecommendationOutcome(env, {
    id: `outcome:${updatedAt}`,
    actionId: `action:${updatedAt}`,
    runId: `run:${updatedAt}`,
    actorLogin: "dev",
    actionType: "prepare_pr_packet",
    surface: null,
    targetRepoFullName: "owner/repo",
    targetPullNumber: null,
    targetIssueNumber: null,
    source: "inferred",
    outcomeState: "merged",
    outcomeTargetType: "pull_request",
    outcomeRepoFullName: "owner/repo",
    outcomePullNumber: 7,
    outcomeIssueNumber: null,
    maintainerLane: false,
    confidence: "high",
    reason: "Merged cleanly.",
    updatedAt,
    metadata: {},
  });
}

// #2221 -- registers loopover_get_recommendation_quality next to loopover_get_fleet_analytics. The
// underlying buildRecommendationQualityReport aggregates outcomes across every repo (visibility:
// "operator_only"), so this mirrors the fleet-analytics tool exactly: windowDays-only input + the
// operator-only gate, never a per-repo requireRepoAccess check that a single repo's maintainer could pass.
describe("loopover_get_recommendation_quality MCP tool (#2221)", () => {
  it("returns recommendation quality for a trusted (non-session) identity, honoring windowDays", async () => {
    const env = createTestEnv();
    await seedMergedOutcome(env, new Date().toISOString());
    const result = await (await connect(env)).callTool({ name: "loopover_get_recommendation_quality", arguments: { windowDays: 30 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { windowDays: number; empty: boolean; totals: { total: number; positive: number } };
    expect(data.windowDays).toBe(30);
    expect(data.empty).toBe(false);
    expect(data.totals).toMatchObject({ total: 1, positive: 1 });
  });

  it("returns an empty report (n/a summary) when there is no data and no windowDays", async () => {
    const result = await (await connect(createTestEnv())).callTool({ name: "loopover_get_recommendation_quality", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { empty: boolean; totals: { total: number } };
    expect(data.empty).toBe(true);
    expect(data.totals.total).toBe(0);
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/No recommendation quality outcomes are available/) })]);
  });

  it("allows an operator session", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "boss" });
    const { session } = await createSessionForGitHubUser(env, { login: "boss", id: 1 });
    const result = await (await connect(env, { kind: "session", actor: "boss", session })).callTool({ name: "loopover_get_recommendation_quality", arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it("forbids a non-operator session", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "boss" });
    const { session } = await createSessionForGitHubUser(env, { login: "rando", id: 2 });
    const result = await (await connect(env, { kind: "session", actor: "rando", session })).callTool({ name: "loopover_get_recommendation_quality", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/operator authority/i);
  });

  it("forbids the static mcp identity without an MCP_READ_REPO_ALLOWLIST wildcard opt-in", async () => {
    const result = await (await connect(createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" }))).callTool({ name: "loopover_get_recommendation_quality", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/not authorized for operator-only cross-repo tools/i);
  });

  it("forbids the static mcp identity when MCP_READ_REPO_ALLOWLIST is scoped to specific repos, not the wildcard", async () => {
    const result = await (await connect(createTestEnv({ MCP_READ_REPO_ALLOWLIST: "acme/widgets" }))).callTool({ name: "loopover_get_recommendation_quality", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/not authorized for operator-only cross-repo tools/i);
  });
});
