import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "fleet-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

let seq = 0;
async function seedMergeSignals(env: Env, instance: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await env.DB
      .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, ?, ?, 'merge', 'merged', 'none')`)
      .bind(instance, `repo${seq}`, `pr${seq++}`)
      .run();
  }
  // Register the instance so it counts toward the fleet (only registered instances are aggregated).
  await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1) ON CONFLICT(instance_id) DO UPDATE SET registered=1`).bind(instance).run();
}

describe("gittensory_get_fleet_analytics MCP tool", () => {
  it("returns fleet analytics for a trusted (non-session) identity, honoring windowDays", async () => {
    const env = createTestEnv();
    await seedMergeSignals(env, "inst1", 5); // ≥ MIN_DECIDED → counts toward the fleet
    const result = await (await connect(env)).callTool({ name: "gittensory_get_fleet_analytics", arguments: { windowDays: 30 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { windowDays: number; instanceCount: number; fleet: { mergePrecision: number } };
    expect(data.windowDays).toBe(30);
    expect(data.instanceCount).toBe(1);
    expect(data.fleet.mergePrecision).toBe(1);
  });

  it("returns an empty report (n/a summary) when there is no data and no windowDays", async () => {
    const result = await (await connect(createTestEnv())).callTool({ name: "gittensory_get_fleet_analytics", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { instanceCount: number };
    expect(data.instanceCount).toBe(0);
  });

  it("allows an operator session", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "boss" });
    const { session } = await createSessionForGitHubUser(env, { login: "boss", id: 1 });
    const result = await (await connect(env, { kind: "session", actor: "boss", session })).callTool({ name: "gittensory_get_fleet_analytics", arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it("forbids a non-operator session", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "boss" });
    const { session } = await createSessionForGitHubUser(env, { login: "rando", id: 2 });
    const result = await (await connect(env, { kind: "session", actor: "rando", session })).callTool({ name: "gittensory_get_fleet_analytics", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/operator authority/i);
  });
});
