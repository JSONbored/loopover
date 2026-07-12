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

const CLAIM_ROWS = [
  { id: 1, repoFullName: "acme/api", issueNumber: 10, claimedAt: "2026-01-01T00:00:00Z", status: "active", note: null },
  { id: 2, repoFullName: "acme/api", issueNumber: 11, claimedAt: "2026-01-02T00:00:00Z", status: "released", note: "done" },
  { id: 3, repoFullName: "acme/web", issueNumber: 12, claimedAt: "2026-01-03T00:00:00Z", status: "active", note: null },
];

type ClaimFilter = { repoFullName?: string | null; status?: string | null };
type FakeLedger = {
  calls: string[];
  listClaims(filter?: ClaimFilter): unknown[];
  close(): void;
  recordClaim(): never;
  claimIssue(): never;
  releaseClaim(): never;
  expireClaim(): never;
};

// Fake claim ledger that records every method call and throws from any mutator, so a test can assert the
// list-claims tool reaches only read methods. listClaims applies the same repo/status filter the real one does.
function fakeLedger(rows: Array<{ repoFullName: string; status: string }>): FakeLedger {
  const calls: string[] = [];
  const mutation = (name: string) => (): never => {
    calls.push(name);
    throw new Error(`mutation ${name} must not be reachable via the read tool`);
  };
  return {
    calls,
    listClaims(filter: ClaimFilter = {}) {
      calls.push("listClaims");
      return rows.filter(
        (row) =>
          (filter.repoFullName == null || row.repoFullName === filter.repoFullName) &&
          (filter.status == null || row.status === filter.status),
      );
    },
    close() {
      calls.push("close");
    },
    recordClaim: mutation("recordClaim"),
    claimIssue: mutation("claimIssue"),
    releaseClaim: mutation("releaseClaim"),
    expireClaim: mutation("expireClaim"),
  };
}

describe("gittensory-miner MCP server (#5153 scaffold)", () => {
  it("exposes the ping, portfolio-dashboard, and list-claims tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "gittensory_miner_get_audit_feed",
      "gittensory_miner_get_portfolio_dashboard",
      "gittensory_miner_get_run_state",
      "gittensory_miner_list_claims",
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

describe("gittensory_miner_list_claims (#5156)", () => {
  function claimsClient(ledger: FakeLedger): Promise<Client> {
    return connectedClient({ openClaimLedger: () => ledger });
  }
  async function callList(client: Client, args: Record<string, unknown> = {}): Promise<unknown[]> {
    const result = (await client.callTool({ name: "gittensory_miner_list_claims", arguments: args })) as Content;
    return JSON.parse(toolText(result));
  }

  it("lists every claim (all statuses) when no filter is given", async () => {
    const claims = await callList(await claimsClient(fakeLedger(CLAIM_ROWS)));
    expect(claims).toEqual(CLAIM_ROWS);
  });

  it("passes an optional repoFullName filter through to listClaims", async () => {
    const claims = await callList(await claimsClient(fakeLedger(CLAIM_ROWS)), { repoFullName: "acme/web" });
    expect(claims).toEqual([CLAIM_ROWS[2]]);
  });

  it("passes an optional status filter through to listClaims", async () => {
    const claims = await callList(await claimsClient(fakeLedger(CLAIM_ROWS)), { status: "active" });
    expect((claims as Array<{ issueNumber: number }>).map((claim) => claim.issueNumber)).toEqual([10, 12]);
  });

  it("returns an empty list for an empty ledger", async () => {
    const claims = await callList(await claimsClient(fakeLedger([])));
    expect(claims).toEqual([]);
  });

  it("only reads — never reaches a mutating claim-ledger method (invariant)", async () => {
    const ledger = fakeLedger(CLAIM_ROWS);
    await callList(await claimsClient(ledger), { status: "active" });
    expect(ledger.calls).toEqual(["listClaims"]);
    for (const mutator of ["recordClaim", "claimIssue", "releaseClaim", "expireClaim"]) {
      expect(ledger.calls).not.toContain(mutator);
    }
  });
});

const RUN_STATE_ROWS = [
  { repoFullName: "acme/api", state: "discovering" },
  { repoFullName: "acme/web", state: "idle" },
];

// Fake run-state store that records calls and throws from the mutator, so a test can assert the read tool
// reaches only getRunState/listRunStates and never triggers a state transition.
function fakeRunStateStore(rows: Array<{ repoFullName: string; state: string }>) {
  const calls: string[] = [];
  return {
    calls,
    getRunState(repoFullName: string): string | null {
      calls.push("getRunState");
      return rows.find((row) => row.repoFullName === repoFullName)?.state ?? null;
    },
    listRunStates(): Array<{ repoFullName: string; state: string }> {
      calls.push("listRunStates");
      return rows;
    },
    setRunState(): never {
      calls.push("setRunState");
      throw new Error("setRunState must not be reachable via the read tool");
    },
    close(): void {
      calls.push("close");
    },
  };
}

describe("gittensory_miner_get_run_state (#5160)", () => {
  function runStateClient(store: ReturnType<typeof fakeRunStateStore>): Promise<Client> {
    return connectedClient({ initRunStateStore: () => store });
  }
  async function callRunState(client: Client, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = (await client.callTool({ name: "gittensory_miner_get_run_state", arguments: args })) as Content;
    return JSON.parse(toolText(result));
  }

  it("returns a single repo's state when repoFullName is given", async () => {
    const out = await callRunState(await runStateClient(fakeRunStateStore(RUN_STATE_ROWS)), { repoFullName: "acme/api" });
    expect(out).toEqual({ repoFullName: "acme/api", state: "discovering" });
  });

  it("returns a null state for an unknown / no-state-yet repo without throwing", async () => {
    const out = await callRunState(await runStateClient(fakeRunStateStore(RUN_STATE_ROWS)), { repoFullName: "acme/nope" });
    expect(out).toEqual({ repoFullName: "acme/nope", state: null });
  });

  it("lists every repo's state when repoFullName is omitted", async () => {
    const out = await callRunState(await runStateClient(fakeRunStateStore(RUN_STATE_ROWS)));
    expect(out).toEqual({ states: RUN_STATE_ROWS });
  });

  it("only reads — never triggers a state transition (invariant: no setRunState)", async () => {
    const store = fakeRunStateStore(RUN_STATE_ROWS);
    await callRunState(await runStateClient(store), { repoFullName: "acme/api" });
    expect(store.calls).toEqual(["getRunState"]);
    expect(store.calls).not.toContain("setRunState");
  });
});
