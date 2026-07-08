import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { GittensoryMcp, buildGateDispositions } from "../../src/mcp/server";
import { type AuthIdentity } from "../../src/auth/security";
import { setLocalManifestReader, upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new GittensoryMcp(env, identity) : new GittensoryMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-explain-gate-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("buildGateDispositions (#2234)", () => {
  it("maps blockers → block and warnings → advisory (blockers first); pass-all ⇒ empty", () => {
    // pass-all: nothing fired
    expect(buildGateDispositions({ blockers: [], warnings: [] })).toEqual([]);
    // one blocking rule
    expect(buildGateDispositions({ blockers: [{ code: "a", title: "A", detail: "reason a" }], warnings: [] })).toEqual([
      { rule: "a", status: "block", reason: "reason a" },
    ]);
    // multiple blockers + an advisory warning, in order
    expect(
      buildGateDispositions({
        blockers: [
          { code: "a", title: "A", detail: "ra" },
          { code: "b", title: "B", detail: "rb" },
        ],
        warnings: [{ code: "w", title: "W", detail: "rw" }],
      }),
    ).toEqual([
      { rule: "a", status: "block", reason: "ra" },
      { rule: "b", status: "block", reason: "rb" },
      { rule: "w", status: "advisory", reason: "rw" },
    ]);
  });
});

describe("MCP gittensory_explain_gate_disposition (#2234)", () => {
  afterEach(() => setLocalManifestReader(null));

  it("itemizes the blocking disposition when a gate rule blocks", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets" });
    await upsertRepoFocusManifest(env, "acme/widgets", { gate: { pack: "oss-anti-slop", linkedIssue: "block" } }, "repo_file");
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_explain_gate_disposition",
      arguments: { login: "miner1", owner: "acme", repo: "widgets", title: "Add retry to upload client", linkedIssues: [] },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      conclusion: string;
      pack: string;
      dispositions: Array<{ rule: string; status: string; reason: string }>;
    };
    expect(data.pack).toBe("oss-anti-slop");
    expect(data.conclusion).toBe("failure");
    expect(data.dispositions.some((d) => d.rule === "missing_linked_issue" && d.status === "block")).toBe(true);
    // public-safe: never leaks private scoring/wallet terms
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward estimate|trust score/i);
  });

  it("returns no blocking dispositions when the gate passes", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "clean", full_name: "acme/clean" });
    await upsertRepoFocusManifest(env, "acme/clean", { gate: { pack: "oss-anti-slop" } }, "repo_file");
    const client = await connect(env);

    const result = await client.callTool({
      name: "gittensory_explain_gate_disposition",
      arguments: { login: "miner1", owner: "acme", repo: "clean", title: "Minimal self-check" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { dispositions: Array<{ status: string }> };
    expect(data.dispositions.filter((d) => d.status === "block")).toHaveLength(0);
  });
});
