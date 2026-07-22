import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { recordOverrideAudit, type StorageEnv } from "../../src/review/auto-apply";
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

describe("MCP loopover_get_selftune_override_audit (#7798)", () => {
  it("returns the repo-scoped audit trail for an authorized caller and caps rows via limit", async () => {
    const env = createTestEnv();
    const storageEnv = env as unknown as StorageEnv;
    await recordOverrideAudit(storageEnv, REPO, "shadow_written", { confidenceFloor: 0.4 });
    await recordOverrideAudit(storageEnv, REPO, "promoted", { confidenceFloor: 0.91 });
    // A sibling repo's event must never leak into this repo's trail.
    await recordOverrideAudit(storageEnv, "owner/other", "promoted", { confidenceFloor: 0.5 });
    const client = await connect(env);

    const result = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { repoFullName: string; audit: Array<{ eventType: string; detail: string | null; createdAt: string }> };
    expect(data.repoFullName).toBe(REPO);
    expect(data.audit).toHaveLength(2);
    expect(data.audit.map((event) => event.eventType).sort()).toEqual(["promoted", "shadow_written"]);
    expect(JSON.stringify(result.content)).toContain("2 event(s)");

    // The optional limit passes through to listOverrideAudit the same way the route's ?limit query does.
    const capped = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets", limit: 1 } });
    expect(capped.isError).toBeFalsy();
    expect((capped.structuredContent as { audit: unknown[] }).audit).toHaveLength(1);
  });

  it("returns an empty audit trail when no override events are recorded", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ repoFullName: REPO, audit: [] });
    expect(JSON.stringify(result.content)).toContain("0 event(s)");
  });

  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_selftune_override_audit", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
