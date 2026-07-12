import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  createMinerMcpServer,
  MINER_PING_STATUS,
  type MinerMcpServerOptions,
} from "../../packages/gittensory-miner/bin/gittensory-miner-mcp.js";
import { collectPortfolioDashboard } from "../../packages/gittensory-miner/lib/portfolio-dashboard.js";

// Tests for the gittensory-miner MCP server: the #5153 ping scaffold and the #5155 read-only
// portfolio-dashboard tool. Drives the real server over an in-memory transport (no child process); the
// dashboard tool's store opener and clock are injected so no on-disk AMS state is required.

type Content = { content: Array<{ type: string; text?: string }> };

async function connectedClient(options: MinerMcpServerOptions = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-test", version: "0.0.0" });
  await Promise.all([createMinerMcpServer(options).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function toolText(result: Content): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

const NOW_MS = Date.parse("2026-02-01T00:00:00Z");
const QUEUE_ROWS = [
  { repoFullName: "acme/api", identifier: "pr:1", priority: 0, status: "queued", enqueuedAt: "2026-01-01T00:00:00Z" },
  { repoFullName: "acme/api", identifier: "pr:2", priority: 0, status: "in_progress", enqueuedAt: "2026-01-02T00:00:00Z" },
  { repoFullName: "acme/web", identifier: "pr:3", priority: 0, status: "done", enqueuedAt: "2026-01-03T00:00:00Z" },
  { repoFullName: "acme/web", identifier: "pr:4", priority: 0, status: "queued", enqueuedAt: "2026-01-04T00:00:00Z" },
];

function fakeQueue(rows: unknown[]): { listQueue(): unknown[]; close(): void } {
  return { listQueue: () => rows, close: () => {} };
}

describe("gittensory-miner MCP server (#5153 scaffold)", () => {
  it("exposes the ping and portfolio-dashboard tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "gittensory_miner_get_portfolio_dashboard",
      "gittensory_miner_ping",
    ]);
  });

  it("gittensory_miner_ping returns the static, non-secret status object", async () => {
    const client = await connectedClient();
    const result = (await client.callTool({ name: "gittensory_miner_ping", arguments: {} })) as Content;
    expect(JSON.parse(toolText(result))).toEqual({ status: "ok", tool: "gittensory_miner_ping" });
    expect(JSON.parse(toolText(result))).toEqual(MINER_PING_STATUS);
  });

  it("gittensory_miner_ping returns the same object on every call, no AMS state required (invariant)", async () => {
    const client = await connectedClient();
    const a = (await client.callTool({ name: "gittensory_miner_ping", arguments: {} })) as Content;
    const b = (await client.callTool({ name: "gittensory_miner_ping", arguments: {} })) as Content;
    expect(toolText(a)).toBe(toolText(b));
    expect(JSON.parse(toolText(a))).toEqual(MINER_PING_STATUS);
  });
});

describe("gittensory_miner_get_portfolio_dashboard (#5155)", () => {
  function dashboardClient(rows: unknown[]): Promise<Client> {
    return connectedClient({ initPortfolioQueue: () => fakeQueue(rows), nowMs: NOW_MS });
  }

  it("returns per-repo status counts, totals, and oldest-queued age over a multi-repo backlog", async () => {
    const client = await dashboardClient(QUEUE_ROWS);
    const result = (await client.callTool({
      name: "gittensory_miner_get_portfolio_dashboard",
      arguments: {},
    })) as Content;
    const summary = JSON.parse(toolText(result));
    expect(summary.total).toBe(4);
    expect(summary.byStatus).toEqual({ queued: 2, in_progress: 1, done: 1 });
    expect(summary.repos.map((repo: { repoFullName: string }) => repo.repoFullName)).toEqual(["acme/api", "acme/web"]);
    expect(summary.repos[0]).toEqual({
      repoFullName: "acme/api",
      byStatus: { queued: 1, in_progress: 1, done: 0 },
      total: 2,
    });
    expect(summary.oldestQueuedAgeMs).toBe(NOW_MS - Date.parse("2026-01-01T00:00:00Z"));
  });

  it("handles an empty queue without a clock error (single-repo/empty edge)", async () => {
    const client = await dashboardClient([]);
    const result = (await client.callTool({
      name: "gittensory_miner_get_portfolio_dashboard",
      arguments: {},
    })) as Content;
    expect(JSON.parse(toolText(result))).toEqual({
      total: 0,
      byStatus: { queued: 0, in_progress: 0, done: 0 },
      repos: [],
      oldestQueuedAgeMs: null,
    });
  });

  it("is structurally identical to collectPortfolioDashboard() — the wrapper adds no drift (invariant)", async () => {
    const client = await dashboardClient(QUEUE_ROWS);
    const result = (await client.callTool({
      name: "gittensory_miner_get_portfolio_dashboard",
      arguments: {},
    })) as Content;
    const direct = collectPortfolioDashboard({ portfolioQueue: fakeQueue(QUEUE_ROWS) }, { nowMs: NOW_MS });
    expect(JSON.parse(toolText(result))).toEqual(direct);
  });
});
