import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { GittensoryMcp } from "../../src/mcp/server";
import { recordGateBlockOutcome, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gate-precision-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("gittensory_get_gate_precision MCP tool", () => {
  it("returns the gate-precision report for a trusted identity, honoring windowDays and surfacing a blocked-then-merged false positive", async () => {
    const env = createTestEnv();
    // One PR blocked, then merged anyway → a gate false positive within the window.
    await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: 1, headSha: "sha1", blockerCodes: ["slop_risk"] });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "merged", state: "closed", user: { login: "alice" }, merged_at: "2026-06-01T00:00:00.000Z" });

    const result = await (await connect(env)).callTool({ name: "gittensory_get_gate_precision", arguments: { owner: "owner", repo: "repo", windowDays: 30 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      repoFullName: string;
      windowDays: number | null;
      overall: { blocked: number; blockedThenMerged: number };
      perGateType: unknown[];
    };
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.windowDays).toBe(30);
    expect(data.overall).toMatchObject({ blocked: 1, blockedThenMerged: 1 });
    expect(Array.isArray(data.perGateType)).toBe(true);
    // windowDays present ⇒ the "over 30 day(s)" summary arm.
    expect(JSON.stringify(result.content)).toContain("over 30 day(s)");
    // Public-safe by construction: no private scoring terms leak through the tool payload.
    expect(JSON.stringify(result)).not.toMatch(/reward|payout|trust score|wallet|hotkey/i);
  });

  it("returns a zeroed all-time report when windowDays is omitted (empty window, null-window summary arm)", async () => {
    const result = await (await connect(createTestEnv())).callTool({ name: "gittensory_get_gate_precision", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { windowDays: number | null; overall: { blocked: number; blockedThenMerged: number } };
    // windowDays omitted ⇒ loadGatePrecisionReport's `?? null` ⇒ the "over all day(s)" summary arm.
    expect(data.windowDays).toBeNull();
    expect(data.overall).toMatchObject({ blocked: 0, blockedThenMerged: 0 });
    expect(JSON.stringify(result.content)).toContain("over all day(s)");
  });

  it("forbids a session identity that cannot access the repository", async () => {
    const env = createTestEnv();
    const { session } = await createSessionForGitHubUser(env, { login: "rando", id: 2 });
    const result = await (await connect(env, { kind: "session", actor: "rando", session })).callTool({
      name: "gittensory_get_gate_precision",
      arguments: { owner: "owner", repo: "repo" },
    });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
