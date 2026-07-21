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
  const client = new Client({ name: "loopover-selftune-override-audit-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedOverrideAudit(env: Env) {
  const storage = env as never;
  await recordOverrideAudit(storage, REPO, "override.promoted", { floor: 0.95 });
  await recordOverrideAudit(storage, REPO, "override.applied", { cap: "3f/120l" });
}

describe("MCP loopover_get_selftune_override_audit (#7798)", () => {
  it("returns the override audit trail for an authorized caller and passes limit through", async () => {
    const env = createTestEnv();
    await seedOverrideAudit(env);
    const client = await connect(env);
    const limited = await client.callTool({
      name: "loopover_get_selftune_override_audit",
      arguments: { owner: "owner", repo: "widgets", limit: 1 },
    });
    expect(limited.isError).toBeFalsy();
    const limitedData = limited.structuredContent as {
      repoFullName: string;
      audit: Array<{ eventType: string; detail: string | null; createdAt: string }>;
    };
    expect(limitedData.repoFullName).toBe(REPO);
    expect(limitedData.audit).toHaveLength(1);
    expect(JSON.stringify(limited.content)).toContain("1 event(s)");

    const full = await client.callTool({
      name: "loopover_get_selftune_override_audit",
      arguments: { owner: "owner", repo: "widgets" },
    });
    expect(full.isError).toBeFalsy();
    const fullData = full.structuredContent as { audit: Array<{ eventType: string }> };
    expect(fullData.audit.map((row) => row.eventType).sort()).toEqual(["override.applied", "override.promoted"]);
    expect(JSON.stringify(full.content)).toContain("2 event(s)");
  });

  it("returns an empty audit trail when no overrides have been recorded", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({
      name: "loopover_get_selftune_override_audit",
      arguments: { owner: "owner", repo: "widgets" },
    });
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
    const result = await client.callTool({
      name: "loopover_get_selftune_override_audit",
      arguments: { owner: "owner", repo: "widgets" },
    });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
