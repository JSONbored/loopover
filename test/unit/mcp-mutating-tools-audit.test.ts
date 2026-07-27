import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { setConfigAdminFunctions } from "../../src/mcp/private-config-admin-registry";
import { setRedeployTrigger } from "../../src/mcp/redeploy-companion-registry";
import type { AuthIdentity } from "../../src/auth/security";
import { listAuditEventsByType, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const MCP_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp" };
const MCP_ADMIN_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp-admin" };
const SINCE = "2000-01-01T00:00:00.000Z";

async function connect(env: Env, identity: AuthIdentity = MCP_IDENTITY) {
  const server = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-mutating-tools-audit-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  setConfigAdminFunctions(null);
  setRedeployTrigger(null);
});

// #9137: every mutating MCP tool must leave a forensic `audit_events` row -- previously NONE of them did
// (`grep -n "recordAuditEvent" src/mcp/server.ts` returned zero hits). Table-driven across the four tools the
// issue calls out by name: the kill switch, the autonomy dial, the private-config writer, and the redeploy
// trigger. Assertions read back via listAuditEventsByType (an exact-eventType, unscoped read) rather than
// loopover_get_agent_audit_feed / listAgentAuditEvents, which is intentionally scoped to `agent.action.%` /
// `agent.pending_action.%` event types keyed by a `repo#pr` target -- none of these four events are PR-scoped.
describe("MCP mutating tools leave an audit_events row (#9137)", () => {
  it("loopover_set_agent_paused records repo.settings_updated with the actor, repo, and changed field", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);

    const result = await client.callTool({ name: "loopover_set_agent_paused", arguments: { owner: "owner", repo: "repo", paused: true } });
    expect(result.isError).toBeFalsy();

    const events = await listAuditEventsByType(env, "repo.settings_updated", SINCE);
    const own = events.filter((event) => event.targetKey === "owner/repo");
    expect(own).toHaveLength(1);
    expect(own[0]?.metadata).toMatchObject({ repoFullName: "owner/repo", fields: ["agentPaused"], agentPaused: true });
  });

  it("loopover_set_action_autonomy records repo.settings_updated with the action and level", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    const client = await connect(env);

    const result = await client.callTool({ name: "loopover_set_action_autonomy", arguments: { owner: "owner", repo: "repo", action: "merge", level: "auto" } });
    expect(result.isError).toBeFalsy();

    const events = await listAuditEventsByType(env, "repo.settings_updated", SINCE);
    const own = events.filter((event) => event.targetKey === "owner/repo");
    expect(own).toHaveLength(1);
    expect(own[0]?.metadata).toMatchObject({ repoFullName: "owner/repo", fields: ["autonomy"], action: "merge", level: "auto" });
  });

  it("loopover_admin_write_config records config.private_write on both a successful and a failed write", async () => {
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" });
    const writeGlobal = vi.fn().mockResolvedValueOnce({ ok: true, path: ".loopover.yml", backupPath: null }).mockResolvedValueOnce({ ok: false, error: "Content is empty." });
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal, writeRepo: vi.fn(), listBackups: vi.fn() });
    const client = await connect(env, MCP_ADMIN_IDENTITY);

    const ok = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "global", content: "gate:\n  mode: advisory\n" } });
    expect(ok.isError).toBeFalsy();
    const failed = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "global", content: "" } });
    expect(failed.isError).toBeFalsy(); // a rejected write is a normal tool result, not an MCP-level error

    const events = await listAuditEventsByType(env, "config.private_write", SINCE);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.metadata.ok === true)).toMatchObject({ targetKey: "global", metadata: { scope: "global", ok: true } });
    expect(events.find((event) => event.metadata.ok === false)).toMatchObject({ targetKey: "global", metadata: { scope: "global", ok: false } });
  });

  it("loopover_admin_write_config records config.private_write scoped to the target repo, not 'global'", async () => {
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" });
    const writeRepo = vi.fn().mockResolvedValue({ ok: true, path: "loopover/.loopover.yml", backupPath: null });
    setConfigAdminFunctions({ readGlobal: vi.fn(), readRepo: vi.fn(), writeGlobal: vi.fn(), writeRepo, listBackups: vi.fn() });
    const client = await connect(env, MCP_ADMIN_IDENTITY);

    const result = await client.callTool({ name: "loopover_admin_write_config", arguments: { scope: "repo", repoFullName: "JSONbored/loopover", content: "gate:\n  mode: advisory\n" } });
    expect(result.isError).toBeFalsy();

    const events = await listAuditEventsByType(env, "config.private_write", SINCE);
    const own = events.filter((event) => event.targetKey === "JSONbored/loopover");
    expect(own).toHaveLength(1);
    expect(own[0]?.metadata).toMatchObject({ scope: "repo", repoFullName: "JSONbored/loopover", ok: true });
  });

  it("loopover_admin_trigger_redeploy records instance.redeploy_triggered on success, a failed run, and a companion connection error", async () => {
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" });
    const client = await connect(env, MCP_ADMIN_IDENTITY);

    setRedeployTrigger(vi.fn().mockResolvedValue({ ok: true, exitCode: 0, log: [] }));
    await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: { image: "ghcr.io/jsonbored/loopover-selfhost:v1" } });

    setRedeployTrigger(vi.fn().mockResolvedValue({ ok: false, exitCode: 1, error: "health check timed out", log: [] }));
    await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });

    setRedeployTrigger(vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED /run/loopover-redeploy.sock")));
    await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });

    const events = await listAuditEventsByType(env, "instance.redeploy_triggered", SINCE);
    expect(events).toHaveLength(3);
    expect(events.find((event) => event.metadata.ok === true)).toMatchObject({
      targetKey: "ghcr.io/jsonbored/loopover-selfhost:v1",
      metadata: { ok: true, exitCode: 0 },
    });
    expect(events.find((event) => event.metadata.ok === false && event.metadata.exitCode === 1)).toMatchObject({
      targetKey: "default",
      metadata: { ok: false, exitCode: 1 },
    });
    expect(events.find((event) => event.metadata.ok === false && event.metadata.exitCode === null)).toMatchObject({
      targetKey: "default",
      metadata: { ok: false, exitCode: null },
    });
  });

  // listAuditEventsByType (used above) deliberately doesn't project `actor` -- read it back directly, the
  // same raw-SQL pattern the rest of the suite already uses for audit_events assertions (e.g.
  // test/unit/github-client.test.ts, test/unit/impact-map.test.ts).
  it("records the caller's own identity actor on the audit row, not a generic placeholder", async () => {
    const env = createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" });
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    setRedeployTrigger(vi.fn().mockResolvedValue({ ok: true, exitCode: 0, log: [] }));

    const pausedClient = await connect(env); // default static "mcp" identity
    await pausedClient.callTool({ name: "loopover_set_agent_paused", arguments: { owner: "owner", repo: "repo", paused: true } });
    const adminClient = await connect(env, MCP_ADMIN_IDENTITY);
    await adminClient.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });

    const pauseRow = await env.DB.prepare("SELECT actor FROM audit_events WHERE event_type = ? AND target_key = ?")
      .bind("repo.settings_updated", "owner/repo")
      .first<{ actor: string | null }>();
    expect(pauseRow?.actor).toBe("mcp");
    const redeployRow = await env.DB.prepare("SELECT actor FROM audit_events WHERE event_type = ?")
      .bind("instance.redeploy_triggered")
      .first<{ actor: string | null }>();
    expect(redeployRow?.actor).toBe("mcp-admin");
  });
});
