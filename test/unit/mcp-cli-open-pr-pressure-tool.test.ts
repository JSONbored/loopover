import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #6751: the CLI mirror of loopover_simulate_open_pr_pressure. It PROXIES to POST /v1/lint/open-pr-pressure
// (simulateOpenPrPressure lives app-side in src/services/, not @loopover/engine), so the route is the single
// source of truth for the ranking. The bin cannot import from src/, so its zod shape is a hand-mirror of the
// tool's — these tests pin that mirror: a payload the shape accepts reaches the route, and the fields the real
// schema requires (nested signals, findings) are enforced here too rather than being waved through.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");
let client: Client;
let transport: StdioClientTransport;
let configDir: string;
let captured: Array<{ url: string; method: string }>;

const SIGNALS = {
  openIssues: 12,
  openPullRequests: 9,
  unlinkedPullRequests: 3,
  stalePullRequests: 2,
  draftPullRequests: 1,
  maintainerAuthoredPullRequests: 1,
  collisionClusters: 1,
  ageBuckets: { under7Days: 4, days7To30: 3, over30Days: 2 },
  likelyReviewablePullRequests: 5,
};
const VALID = {
  repoFullName: "acme/widgets",
  generatedAt: "2026-07-17T00:00:00.000Z",
  queueHealth: { repoFullName: "acme/widgets", generatedAt: "2026-07-17T00:00:00.000Z", burdenScore: 42.5, level: "high", summary: "Backed up.", signals: SIGNALS, findings: [] },
  roleContext: { maintainerLane: false },
  contributorOpenPrCount: 3,
};

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-pr-pressure-"));
  captured = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => {
      if (request.url?.includes("/lint/open-pr-pressure")) captured.push({ url: request.url ?? "", method: request.method ?? "" });
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: { ...process.env, LOOPOVER_CONFIG_DIR: configDir, LOOPOVER_API_URL: apiUrl, LOOPOVER_TOKEN: "session-token", LOOPOVER_API_TIMEOUT_MS: "5000" },
  });
  client = new Client({ name: "pr-pressure-tool-test", version: "0.0.1" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_simulate_open_pr_pressure stdio mirror (#6751)", () => {
  it("registers the tool on the stdio server", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("loopover_simulate_open_pr_pressure");
  });

  it("proxies a valid payload to POST /v1/lint/open-pr-pressure and returns the ranking", async () => {
    const result = await client.callTool({ name: "loopover_simulate_open_pr_pressure", arguments: VALID });
    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    expect(JSON.stringify(result)).toContain("close_stale");
  });

  it("accepts a null queueHealth, exactly like the tool's shape", async () => {
    const result = await client.callTool({ name: "loopover_simulate_open_pr_pressure", arguments: { ...VALID, queueHealth: null } });
    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
  });

  it("rejects input the real schema rejects — before any API call", async () => {
    for (const args of [
      {},
      { ...VALID, repoFullName: "ab" },
      { ...VALID, queueHealth: { ...VALID.queueHealth, level: "bogus" } },
      { ...VALID, queueHealth: { ...VALID.queueHealth, signals: undefined } }, // nested signals are required
      { ...VALID, roleContext: {} },
      { ...VALID, contributorOpenPrCount: -1 },
    ]) {
      const rejected = await client.callTool({ name: "loopover_simulate_open_pr_pressure", arguments: args }).then((r) => Boolean(r.isError), () => true);
      expect(rejected, JSON.stringify(args).slice(0, 50)).toBe(true);
    }
    expect(captured).toHaveLength(0);
  });
});
