import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { recordOverrideAudit } from "../../src/review/auto-apply";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-selftune-audit-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedOverrideAudit(env: Env) {
  await recordOverrideAudit(env as never, REPO, "override_shadowed", { confidenceFloor: 0.9 });
  await recordOverrideAudit(env as never, REPO, "override_promoted", { confidenceFloor: 0.9, validated: true });
}

describe("MCP loopover_get_selftune_override_audit (#7798)", () => {
  it("returns the override audit trail newest-first for an authorized caller", async () => {
    const env = createTestEnv();
    await seedOverrideAudit(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { repoFullName: string; audit: Array<{ eventType: string; detail: string | null; createdAt: string }> };
    expect(data.repoFullName).toBe(REPO);
    // Two writes land in the same CURRENT_TIMESTAMP second, so assert membership + mapping rather than order.
    expect(data.audit.map((row) => row.eventType).sort()).toEqual(["override_promoted", "override_shadowed"]);
    const promoted = data.audit.find((row) => row.eventType === "override_promoted");
    expect(promoted?.detail).toBe(JSON.stringify({ confidenceFloor: 0.9, validated: true }));
    expect(typeof promoted?.createdAt).toBe("string");
    expect(JSON.stringify(result.content)).toContain("2 event(s)");
  });

  it("forwards the limit to listOverrideAudit", async () => {
    const env = createTestEnv();
    await seedOverrideAudit(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets", limit: 1 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { audit: unknown[] };
    expect(data.audit).toHaveLength(1);
  });

  it("returns an empty trail when nothing has been recorded", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { repoFullName: string; audit: unknown[] };
    expect(data.repoFullName).toBe(REPO);
    expect(data.audit).toEqual([]);
    expect(JSON.stringify(result.content)).toContain("0 event(s)");
  });

  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    await seedOverrideAudit(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
