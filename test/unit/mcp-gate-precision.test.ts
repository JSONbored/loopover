import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { recordGateBlockOutcome, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-gate-precision-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

// 6 blocks citing one code, 2 on PRs that later merged (false positives) → rate 2/6 = 0.333,
// comfortably above the service's MIN_SAMPLE guard so the per-type rate is a number, not null.
async function seedGateLedger(env: Env) {
  for (let n = 1; n <= 6; n += 1) {
    await recordGateBlockOutcome(env, { repoFullName: REPO, pullNumber: n, headSha: `sha${n}`, blockerCodes: ["missing_linked_issue"] });
    await upsertPullRequestFromGitHub(env, REPO, {
      number: n,
      title: `PR ${n}`,
      state: "closed",
      user: { login: "alice" },
      ...(n <= 2 ? { merged_at: "2026-06-01T00:00:00.000Z" } : {}),
    });
  }
}

describe("MCP loopover_get_gate_precision (#2220)", () => {
  it("returns the per-gate-type precision report for an authorized caller and passes windowDays through", async () => {
    const env = createTestEnv();
    await seedGateLedger(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_precision", arguments: { owner: "owner", repo: "widgets", windowDays: 30 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      repoFullName: string;
      windowDays: number | null;
      perGateType: Array<{ gateType: string; blocked: number; blockedThenMerged: number; falsePositiveRate: number | null }>;
      overall: { blocked: number; blockedThenMerged: number; falsePositiveRate: number | null };
      signals: string[];
    };
    expect(data.repoFullName).toBe(REPO);
    expect(data.windowDays).toBe(30);
    expect(data.overall).toMatchObject({ blocked: 6, blockedThenMerged: 2, falsePositiveRate: 0.333 });
    expect(data.perGateType[0]).toMatchObject({ gateType: "missing_linked_issue", blocked: 6, blockedThenMerged: 2, falsePositiveRate: 0.333 });
    expect(Array.isArray(data.signals)).toBe(true);
    // Numeric branch of the summary's ?? fallback.
    expect(JSON.stringify(result.content)).toContain("overall false-positive rate 0.333");
  });

  it("returns an empty report with a null rate when no gate blocks are recorded (no windowDays)", async () => {
    const env = createTestEnv();
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_precision", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { windowDays: number | null; perGateType: unknown[]; overall: { blocked: number; falsePositiveRate: number | null } };
    expect(data.windowDays).toBeNull();
    expect(data.perGateType).toEqual([]);
    expect(data.overall.blocked).toBe(0);
    expect(data.overall.falsePositiveRate).toBeNull();
    // Null branch of the summary's ?? fallback.
    expect(JSON.stringify(result.content)).toContain("n/a (below sample threshold)");
  });

  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    await seedGateLedger(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_gate_precision", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/cannot access this repository/i);
  });
});
