import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // Parity regression (#627-class): under the default `gittensor` pack, only CONFIRMED Gittensor
  // contributors are ever hard-blocked. The prediction must resolve the caller's confirmed status — if it
  // doesn't (the bug), a non-confirmed contributor whose synthetic PR trips a blocker is wrongly told
  // `failure` when the real maintainer gate would return `neutral`.
  describe("contributor-confirmation parity under the gittensor pack", () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubGittensorMiners(confirmedLogins: Array<{ login: string; id: number }>) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = input.toString();
        // The miners LIST endpoint decides confirmation; follow-up detail/prs/issues calls are best-effort.
        if (/\/miners$/.test(url)) {
          return Response.json(confirmedLogins.map((m) => ({ githubId: m.id, githubUsername: m.login })));
        }
        return Response.json([]);
      });
    }

    it("stays NEUTRAL for a non-confirmed contributor even when a blocker fires", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
      // gittensor pack, linked-issue blocks; the contributor supplies no linked issue → blocker fires.
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "gittensor", linkedIssue: "block" } });
      stubGittensorMiners([]); // miner1 is NOT a confirmed Gittensor contributor
      const client = await connect(env);

      const result = await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client", linkedIssues: [] },
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { pack: string; conclusion: string; confirmedContributor: boolean | undefined };
      expect(data.pack).toBe("gittensor");
      expect(data.conclusion).toBe("neutral");
      expect(data.confirmedContributor).toBe(false);
    });

    it("predicts FAILURE for a confirmed contributor when the same blocker fires", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "gittensor", linkedIssue: "block" } });
      stubGittensorMiners([{ login: "miner1", id: 4242 }]); // miner1 IS confirmed
      const client = await connect(env);

      const result = await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client", linkedIssues: [] },
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { conclusion: string; confirmedContributor: boolean | undefined; blockers: Array<{ code: string }> };
      expect(data.confirmedContributor).toBe(true);
      expect(data.conclusion).toBe("failure");
      expect(data.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);
    });
  });

  it("is repo-scoped: a session cannot predict against an inaccessible repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "private-roadmap", full_name: "victimco/private-roadmap", private: true, owner: { login: "victimco" } });
    await upsertRepoFocusManifest(env, "victimco/private-roadmap", { gate: { pack: "oss-anti-slop", linkedIssue: "block" } });
    const { session } = await createSessionForGitHubUser(env, { login: "miner1", id: 1 });
    const client = await connect(env, { kind: "session", actor: "miner1", session });

    const result = await client.callTool({
      name: "gittensory_predict_gate",
      arguments: { login: "miner1", owner: "victimco", repo: "private-roadmap", title: "Probe private repo" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("session cannot access this repository");
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
