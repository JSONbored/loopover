import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import {
  applyMcpPlanningChoices,
  buildMcpPlanningElicitationAudit,
  buildMcpPlanningElicitationRequest,
  MCP_PLANNING_ELICITATION_FIELDS,
  planningChoicesFromElicitationResult,
  validateMcpPlanningElicitationRequest,
} from "../../src/services/mcp-planning-elicitation";
import { createTestEnv } from "../helpers/d1";

async function connectTestClient(capabilities: ClientCapabilities) {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-planning-elicitation-test", version: "0.1.0" }, { capabilities });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

describe("MCP planning elicitation", () => {
  it("builds an allowlisted form request without sensitive planning fields", () => {
    const request = buildMcpPlanningElicitationRequest();
    validateMcpPlanningElicitationRequest(request);
    expect(Object.keys(request.requestedSchema.properties)).toEqual([...MCP_PLANNING_ELICITATION_FIELDS]);
    expect(JSON.stringify(request)).not.toMatch(
      /token|secret|wallet|hotkey|coldkey|private keys?|pat|mnemonic|seed phrase|private maintainer evidence/i,
    );
  });

  it("blocks request fixtures that add sensitive fields", () => {
    const request = buildMcpPlanningElicitationRequest();
    request.requestedSchema.properties.wallet = {
      type: "string",
      title: "Wallet",
      description: "Wallet address",
    };
    expect(() => validateMcpPlanningElicitationRequest(request)).toThrow("Unsafe MCP planning elicitation request.");
  });

  it("blocks request fixtures with missing fields or sensitive descriptions", () => {
    const missing = buildMcpPlanningElicitationRequest();
    delete missing.requestedSchema.properties.cleanupFirst;
    expect(() => validateMcpPlanningElicitationRequest(missing)).toThrow("Unsafe MCP planning elicitation request.");

    const sensitive = buildMcpPlanningElicitationRequest();
    sensitive.requestedSchema.properties.repoFullName = {
      type: "string",
      title: "Repository",
      description: "Token-backed repository context",
      minLength: 3,
      maxLength: 120,
    };
    expect(() => validateMcpPlanningElicitationRequest(sensitive)).toThrow("Unsafe MCP planning elicitation request.");
  });

  it("sanitizes accepted content down to safe planning choices", () => {
    const choices = planningChoicesFromElicitationResult({
      action: "accept",
      content: {
        repoFullName: "JSONbored/gittensory",
        contributionLane: "direct_pr",
        timeHorizon: "this_week",
        riskAppetite: "medium",
        cleanupFirst: true,
        token: "github_pat_private",
        wallet: "coldkey",
      },
    });
    expect(choices).toEqual({
      repoFullName: "JSONbored/gittensory",
      contributionLane: "direct_pr",
      timeHorizon: "this_week",
      riskAppetite: "medium",
      cleanupFirst: true,
    });
    expect(JSON.stringify(choices)).not.toMatch(/token|wallet|hotkey|coldkey|github_pat_private/i);
  });

  it("drops declined, missing, invalid, and sensitive elicitation content", () => {
    expect(planningChoicesFromElicitationResult({ action: "decline" })).toEqual({});
    expect(planningChoicesFromElicitationResult({ action: "accept" })).toEqual({});
    expect(
      planningChoicesFromElicitationResult({
        action: "accept",
        content: {
          repoFullName: "not-a-repo",
          contributionLane: "secret",
          timeHorizon: "someday",
          riskAppetite: "extreme",
          cleanupFirst: "yes",
        },
      }),
    ).toEqual({});
    expect(
      planningChoicesFromElicitationResult({ action: "accept", content: { repoFullName: "secret-owner/repo" } }),
    ).toEqual({});
  });

  it("keeps explicit planner input while applying missing safe choices", () => {
    expect(
      applyMcpPlanningChoices(
        { login: "oktofeesh1", objective: "Use the explicit objective.", repoFullName: "explicit/repo" },
        { repoFullName: "ignored/repo", contributionLane: "cleanup" },
      ),
    ).toEqual({ login: "oktofeesh1", objective: "Use the explicit objective.", repoFullName: "explicit/repo" });
    expect(
      applyMcpPlanningChoices(
        { login: "oktofeesh1" },
        { repoFullName: "JSONbored/gittensory" },
      ),
    ).toMatchObject({
      login: "oktofeesh1",
      repoFullName: "JSONbored/gittensory",
      objective: expect.stringContaining("repo JSONbored/gittensory"),
    });
    expect(applyMcpPlanningChoices({ login: "oktofeesh1" }, {})).toEqual({ login: "oktofeesh1" });
    expect(applyMcpPlanningChoices({ login: "oktofeesh1" }, { cleanupFirst: false })).toMatchObject({
      objective: expect.stringContaining("cleanup first optional"),
    });
  });

  it("summarizes accepted fields for public audit output", () => {
    expect(
      buildMcpPlanningElicitationAudit(
        { supported: true, requested: true, accepted: true },
        { repoFullName: "JSONbored/gittensory", cleanupFirst: false },
      ),
    ).toEqual({
      supported: true,
      requested: true,
      accepted: true,
      fields: ["repoFullName", "cleanupFirst"],
    });
  });

  it("uses form elicitation when the MCP client supports it", async () => {
    const { client, mcpServer } = await connectTestClient({ elicitation: { form: {} } });
    let requestPayload = "";
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requestPayload = JSON.stringify(request.params);
      return {
        action: "accept",
        content: {
          repoFullName: "JSONbored/gittensory",
          contributionLane: "cleanup",
          timeHorizon: "today",
          riskAppetite: "low",
          cleanupFirst: true,
          hotkey: "should-be-ignored",
        },
      };
    });
    const result = await client.callTool({ name: "gittensory_agent_plan_next_work", arguments: { login: "oktofeesh1" } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(requestPayload).not.toBe("");
    expect(requestPayload).not.toMatch(/token|secret|wallet|hotkey|coldkey|private keys?|pat|mnemonic|private maintainer evidence/i);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.planningElicitation).toEqual({
      supported: true,
      requested: true,
      accepted: true,
      fields: ["repoFullName", "contributionLane", "timeHorizon", "riskAppetite", "cleanupFirst"],
    });
    expect(data.planningChoices).toMatchObject({ repoFullName: "JSONbored/gittensory", cleanupFirst: true });
    expect(JSON.stringify(data.planningChoices)).not.toMatch(/hotkey|should-be-ignored/i);
    await mcpServer.close();
  });

  it("treats empty elicitation capabilities as form-capable", async () => {
    const { client, mcpServer } = await connectTestClient({ elicitation: {} });
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { repoFullName: "JSONbored/gittensory" },
    }));
    const result = await client.callTool({ name: "gittensory_agent_plan_next_work", arguments: { login: "oktofeesh1" } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.planningElicitation).toMatchObject({ supported: true, requested: true, accepted: true });
    expect(data.planningChoices).toEqual({ repoFullName: "JSONbored/gittensory" });
    await mcpServer.close();
  });

  it("does not elicit when explicit planner context is already supplied", async () => {
    const { client, mcpServer } = await connectTestClient({ elicitation: { form: {} } });
    let requestCount = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      requestCount += 1;
      return { action: "accept", content: { repoFullName: "ignored/repo" } };
    });
    const result = await client.callTool({
      name: "gittensory_agent_plan_next_work",
      arguments: { login: "oktofeesh1", objective: "Use explicit context.", repoFullName: "JSONbored/gittensory" },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(requestCount).toBe(0);
    expect(data.planningElicitation).toEqual({ supported: true, requested: false, accepted: false, fields: [] });
    expect(data.planningChoices).toEqual({});
    await mcpServer.close();
  });

  it("falls back without elicitation for unsupported MCP clients", async () => {
    const { client, mcpServer } = await connectTestClient({});
    const result = await client.callTool({ name: "gittensory_agent_plan_next_work", arguments: { login: "oktofeesh1" } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.planningElicitation).toEqual({ supported: false, requested: false, accepted: false, fields: [] });
    expect(data.planningChoices).toEqual({});
    await mcpServer.close();
  });
});
