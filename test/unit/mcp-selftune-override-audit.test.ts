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
  const client = new Client({ name: "loopover-selftune-audit-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedAudit(env: Env) {
  const storage = env as unknown as StorageEnv;
  await recordOverrideAudit(storage, REPO, "override_applied", { force: true });
  await recordOverrideAudit(storage, REPO, "override_shadowed", { reason: "queued" });
  await recordOverrideAudit(storage, REPO, "override_promoted", { reason: "soak_passed" });
}

describe("MCP loopover_get_selftune_override_audit (#7798)", () => {
  it("returns the override audit trail for an authorized caller and passes limit through", async () => {
    const env = createTestEnv();
    await seedAudit(env);
    const client = await connect(env);
    const result = await client.callTool({
      name: "loopover_get_selftune_override_audit",
      arguments: { owner: "owner", repo: "widgets", limit: 2 },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      repoFullName: string;
      audit: Array<{ eventType: string; detail: string | null; createdAt: string }>;
    };
    expect(data.repoFullName).toBe(REPO);
    expect(data.audit).toHaveLength(2);
    expect(data.audit.every((entry) => typeof entry.eventType === "string")).toBe(true);
    expect(JSON.stringify(result.content)).toContain("2 event(s)");
  });

  it("returns an empty audit when no override events are recorded (no limit)", async () => {
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
    await seedAudit(env);
    const client = await connect(env);
    const result = await client.callTool({
      name: "loopover_get_selftune_override_audit",
      arguments: { owner: "owner", repo: "widgets" },
    });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
