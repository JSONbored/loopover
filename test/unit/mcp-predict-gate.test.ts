import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { setLocalManifestReader, upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
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
  afterEach(() => setLocalManifestReader(null));
  it("predicts the gate from public config on an unregistered repo under oss-anti-slop", async () => {
    const env = createTestEnv();
    // A non-Gittensor repo: app-installed (so gittensory has "seen" it) but NOT Gittensor-registered, with
    // public config only (gate.pack oss-anti-slop, linked-issue blocks any author).
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
    await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", linkedIssue: "block" } }, "repo_file");
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

  it("rejects changedPaths entries above the path metadata size cap", async () => {
    const env = createTestEnv();
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_predict_gate",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Huge path", changedPaths: [`src/${"a".repeat(301)}.ts`] },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Too big");
  });

  it("ignores legacy focus-manifest blockedPaths when changedPaths are supplied (#11-13/#18)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
    // Public config: oss-anti-slop (no account needed), manifest policy in block mode, legacy dist/** blocked.
    // Stored as a PUBLIC repo_file manifest — predict_gate reads only public config (#selfhost-app-id / #1405).
    await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", manifestPolicy: "block" }, blockedPaths: ["dist/**"] }, "repo_file");
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_predict_gate",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Build output", changedPaths: ["dist/bundle.js"] },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { conclusion: string; blockers: Array<{ code: string }>; warnings: Array<{ code: string }>; note: string };
    expect(data.conclusion).toBe("success");
    expect(data.blockers.some((b) => b.code === "manifest_blocked_path")).toBe(false);
    expect(data.warnings.some((w) => w.code === "manifest_blocked_path")).toBe(false);
    // With paths supplied the note drops the "provide changed paths" disclaimer but still disclaims slop.
    expect(data.note).not.toContain("Provide the PR's changed paths");
    expect(data.note.toLowerCase()).toContain("slop");
  });

  it("ignores container-private manifests and predicts from the public repo file", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
    await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", linkedIssue: "off", readiness: { mode: "off" } } }, "repo_file");
    setLocalManifestReader(async (repo) =>
      repo === "acme/widgets"
        ? `gate:
  pack: oss-anti-slop
  linkedIssue: block
  readiness:
    mode: block
    minScore: 99
blockedPaths:
  - secret/private/**
testExpectations:
  - run private fuzz suite
`
        : null,
    );
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_predict_gate",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Public config only", linkedIssues: [] },
    });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { pack: string; conclusion: string; blockers: Array<{ detail?: string }> };
    expect(data.pack).toBe("oss-anti-slop");
    expect(data.conclusion).toBe("success");
    expect(JSON.stringify(data)).not.toContain("secret/private/**");
    expect(JSON.stringify(data)).not.toContain("private fuzz suite");
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
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "gittensor", linkedIssue: "block" } }, "repo_file");
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
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "gittensor", linkedIssue: "block" } }, "repo_file");
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
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { linkedIssue: "block" } }, "repo_file");
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
    await upsertRepoFocusManifest(env, "victimco/private-roadmap", { gate: { pack: "oss-anti-slop", linkedIssue: "block" } }, "repo_file");
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

  describe("records the call for predicted-vs-live agreement measurement (#predicted-live-gate-agreement)", () => {
    async function rawAll(env: Env, sql: string): Promise<Record<string, unknown>[]> {
      const res = await (env.DB as unknown as { prepare: (s: string) => { all: <T>() => Promise<{ results: T[] }> } }).prepare(sql).all<Record<string, unknown>>();
      return res.results;
    }

    it("SELF-HOSTED instances record a predicted_gate_calls row on a successful predict_gate call", async () => {
      const env = createTestEnv(); // SELFHOST_TRANSIENT_CACHE present by default → self-hosted
      const client = await connect(env);

      await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client" },
      });

      const rows = await rawAll(env, "SELECT * FROM predicted_gate_calls");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ login: "miner1", project: "acme/widgets" });
    });

    it("also records from gittensory_explain_gate_disposition (both tools share computePredictedGateVerdict)", async () => {
      const env = createTestEnv();
      const client = await connect(env);

      await client.callTool({
        name: "gittensory_explain_gate_disposition",
        arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client" },
      });

      expect(await rawAll(env, "SELECT * FROM predicted_gate_calls")).toHaveLength(1);
    });

    it("records NOTHING on the CLOUD WORKER when GITTENSORY_REVIEW_PARITY_AUDIT is unset (byte-identical default)", async () => {
      const env = createTestEnv();
      delete env.SELFHOST_TRANSIENT_CACHE; // simulate the cloud worker
      const client = await connect(env);

      await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client" },
      });

      expect(await rawAll(env, "SELECT * FROM predicted_gate_calls")).toHaveLength(0);
    });
  });

  describe("personalized calibration wiring (#2349)", () => {
    async function seedLedgerRow(env: Env, opts: { login: string; agreed: boolean; pullNumber: number }) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO predicted_gate_calibration_ledger (id, login, project, target_id, predicted_action, real_decision, agreed, predicted_at, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), opts.login, "acme/widgets", `acme/widgets#${opts.pullNumber}`, "merge", opts.agreed ? "merge" : "hold", opts.agreed ? 1 : 0, now, now, now)
        .run();
    }

    it("a login with a weak predict-vs-real track record gets a LOWER readinessScore than an identical fresh login", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", duplicates: "block", linkedIssue: "advisory" } }, "repo_file");
      // 6 rows, mostly disagreements -- well above MIN_CALIBRATION_SAMPLES (5), well below neutral (50%).
      for (let i = 0; i < 6; i++) await seedLedgerRow(env, { login: "shaky-miner", pullNumber: i, agreed: i === 0 });
      const client = await connect(env);

      const fresh = await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "fresh-miner", owner: "acme", repo: "widgets", title: "Add retry to upload client" },
      });
      const weak = await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "shaky-miner", owner: "acme", repo: "widgets", title: "Add retry to upload client" },
      });

      const freshData = fresh.structuredContent as { readinessScore: number };
      const weakData = weak.structuredContent as { readinessScore: number };
      expect(typeof freshData.readinessScore).toBe("number");
      expect(weakData.readinessScore).toBeLessThan(freshData.readinessScore);
    });

    it("never echoes the raw calibration numbers (sampleSize, agreementRate) back to the caller", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
      await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", duplicates: "block", linkedIssue: "advisory" } }, "repo_file");
      for (let i = 0; i < 6; i++) await seedLedgerRow(env, { login: "shaky-miner", pullNumber: i, agreed: false });
      const client = await connect(env);

      const result = await client.callTool({
        name: "gittensory_predict_gate",
        arguments: { login: "shaky-miner", owner: "acme", repo: "widgets", title: "Add retry to upload client" },
      });

      const serialized = JSON.stringify(result.structuredContent);
      expect(serialized).not.toContain("agreementRate");
      expect(serialized).not.toContain("sampleSize");
    });
  });
});
