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

  it("predicts the focus-manifest path policy when changedPaths are supplied (#11-13/#18)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
    // Public config: oss-anti-slop (no account needed), manifest path policy in block mode, dist/** blocked.
    await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", manifestPolicy: "block" }, blockedPaths: ["dist/**"] });
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_predict_gate",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Build output", changedPaths: ["dist/bundle.js"] },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { conclusion: string; blockers: Array<{ code: string }>; note: string };
    expect(data.conclusion).toBe("failure");
    expect(data.blockers.some((b) => b.code === "manifest_blocked_path")).toBe(true);
    // With paths supplied the note drops the "provide changed paths" disclaimer but still disclaims slop.
    expect(data.note).not.toContain("Provide the PR's changed paths");
    expect(data.note.toLowerCase()).toContain("slop");
  });

  // Parity (#gate-nonconfirmed): every author is gated identically now — a synthetic PR that trips a blocker
  // predicts `failure` regardless of confirmed status, matching the real maintainer gate. The prediction still
  // resolves + surfaces the caller's confirmed status (transparency / on-chain scoring context) but it no
  // longer changes the verdict.
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

    it("predicts FAILURE for a non-confirmed contributor when a blocker fires (#gate-nonconfirmed)", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
      // gittensor pack, linked-issue blocks; the contributor supplies no linked issue → blocker fires.
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "gittensor", linkedIssue: "block" } });
      stubGittensorMiners([]); // miner1 is NOT a confirmed Gittensor contributor — gated the same regardless
      const client = await connect(env);

      const result = await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client", linkedIssues: [] },
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { pack: string; conclusion: string; confirmedContributor: boolean | undefined; blockers: Array<{ code: string }> };
      expect(data.pack).toBe("gittensor");
      expect(data.conclusion).toBe("failure");
      expect(data.blockers.some((b) => b.code === "missing_linked_issue")).toBe(true);
      // Confirmed status is still surfaced (transparency / scoring) — it just no longer changes the verdict.
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

    it("treats a Gittensor API failure as non-confirmed, but the gate verdict is unaffected by it (#gate-nonconfirmed)", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
      // No explicit pack → defaults to the gittensor pack, which still resolves confirmed status via the API.
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { linkedIssue: "block" } });
      // The confirmation lookup is the only network call on the prediction path (the URL is a fixed constant
      // base; the login is never interpolated into it — it is filtered client-side — so there is no SSRF
      // surface). When that call fails/times out, fetchGittensorContributorSnapshot resolves to null, so the
      // contributor is surfaced as non-confirmed. Confirmed status no longer changes the verdict, so the gate
      // is computed purely from the public config and still predicts FAILURE on the configured blocker — an API
      // outage can neither falsely block nor falsely un-block a contributor.
      vi.stubGlobal("fetch", async () => {
        throw new Error("network down");
      });
      const client = await connect(env);

      const result = await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client", linkedIssues: [] },
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { conclusion: string; confirmedContributor: boolean | undefined; blockers: Array<{ code: string }> };
      expect(data.confirmedContributor).toBe(false);
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
