import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-predict-gate-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP gittensory_predict_gate", () => {
  it("predicts the gate from public config on an unregistered repo under oss-anti-slop", async () => {
    const env = createTestEnv();
    // A non-Gittensor repo: app-installed (so gittensory has "seen" it) but NOT Gittensor-registered, with
    // public config only (gate.pack oss-anti-slop, linked-issue blocks any author).
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
    await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", linkedIssue: "block" } });
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_predict_gate",
      // Pass body + labels + linkedIssues so the optional-field plumbing is exercised.
      arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client", body: "Improves upload reliability.", labels: ["enhancement"], linkedIssues: [] },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { pack: string; conclusion: string; blockers: Array<{ code: string }> };
    expect(data.pack).toBe("oss-anti-slop");
    expect(data.conclusion).toBe("failure");
    expect(data.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward estimate|trust score/i);

    // Also works with only the required fields (optional body/labels/linkedIssues omitted).
    const minimal = await client.callTool({
      name: "gittensory_predict_gate",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Minimal self-check" },
    });
    expect(minimal.isError).toBeFalsy();
    expect((minimal.structuredContent as { pack: string }).pack).toBe("oss-anti-slop");
  });

  it("is self-scoped: a session cannot predict for another login", async () => {
    const env = createTestEnv();
    const { session } = await createSessionForGitHubUser(env, { login: "miner1", id: 1 });
    const client = await connect(env, { kind: "session", actor: "miner1", session });

    const result = await client.callTool({
      name: "gittensory_predict_gate",
      arguments: { login: "someone-else", owner: "acme", repo: "widgets", title: "x" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("authenticated GitHub login");
  });
});
