import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMinerMcpServer } from "../../packages/loopover-miner/bin/loopover-miner-mcp.js";
import {
  MANAGE_PR_UPDATE_EVENT,
  collectManageStatus,
  collectRunPortfolio,
} from "../../packages/loopover-miner/lib/manage-status.js";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/loopover-miner/lib/event-ledger.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/loopover-miner/lib/portfolio-queue.js";
import {
  closeDefaultRunStateStore,
  initRunStateStore,
} from "../../packages/loopover-miner/lib/run-state.js";

type Content = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Stores = {
  portfolioQueue: ReturnType<typeof initPortfolioQueueStore>;
  eventLedger: ReturnType<typeof initEventLedger>;
  runStateStore: ReturnType<typeof initRunStateStore>;
};

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStores(): Stores {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-mcp-manage-status-"));
  roots.push(root);
  const portfolioQueue = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  const eventLedger = initEventLedger(join(root, "event-ledger.sqlite3"));
  const runStateStore = initRunStateStore(join(root, "run-state.sqlite3"));
  stores.push(portfolioQueue, eventLedger, runStateStore);
  return { portfolioQueue, eventLedger, runStateStore };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  closeDefaultRunStateStore();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connectedClient(sources: Stores): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-manage-status-test", version: "0.0.0" });
  await Promise.all([
    createMinerMcpServer({
      initPortfolioQueue: () => sources.portfolioQueue,
      initEventLedger: () => sources.eventLedger,
      initRunStateStore: () => sources.runStateStore,
    }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function toolText(result: Content): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

const callManageStatus = async (sources: Stores): Promise<Content> =>
  (await (await connectedClient(sources)).callTool({
    name: "loopover_miner_get_manage_status",
    arguments: {},
  })) as Content;

/** A managed PR in the queue with a manage snapshot, plus a run-state-only repo that has no PRs yet. */
function seed(sources: Stores) {
  sources.portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:12", priority: 3 });
  sources.eventLedger.appendEvent({
    type: MANAGE_PR_UPDATE_EVENT,
    repoFullName: "acme/widgets",
    payload: {
      prNumber: 12,
      branch: "feat/widget-cursor",
      ciState: "passing",
      gateVerdict: "approve",
      outcome: "merged",
      lastPolledAt: "2026-07-04T12:00:00.000Z",
    },
  });
  sources.runStateStore.setRunState("acme/widgets", "preparing");
  sources.runStateStore.setRunState("acme/discovering-only", "discovering");
}

describe("loopover_miner_get_manage_status (#5822)", () => {
  it("is registered on the miner MCP server", async () => {
    const client = await connectedClient(tempStores());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("loopover_miner_get_manage_status");
  });

  it("returns the per-PR rows and the run-portfolio view for a populated managed-PR set", async () => {
    const sources = tempStores();
    seed(sources);
    const payload = JSON.parse(toolText(await callManageStatus(sources)));
    expect(payload.rows).toEqual([
      {
        repoFullName: "acme/widgets",
        prNumber: 12,
        branch: "feat/widget-cursor",
        ciState: "passing",
        gateVerdict: "approve",
        outcome: "merged",
        lastPolledAt: "2026-07-04T12:00:00.000Z",
        queueStatus: "queued",
        priority: 3,
      },
    ]);
    // The run-state-only repo has no PRs but must still appear (#4279), proving the fold is not PR-scoped.
    expect(payload.runPortfolio.map((entry: { repoFullName: string }) => entry.repoFullName)).toEqual([
      "acme/discovering-only",
      "acme/widgets",
    ]);
    expect(payload.runPortfolio).toEqual([
      { repoFullName: "acme/discovering-only", runState: "discovering", runStateUpdatedAt: expect.any(String), prCount: 0, prs: [] },
      { repoFullName: "acme/widgets", runState: "preparing", runStateUpdatedAt: expect.any(String), prCount: 1, prs: payload.rows },
    ]);
  });

  it("returns empty rows and an empty run portfolio when no managed PRs are recorded yet", async () => {
    const payload = JSON.parse(toolText(await callManageStatus(tempStores())));
    expect(payload).toEqual({ rows: [], runPortfolio: [] });
  });

  it("is structurally identical to collectManageStatus/collectRunPortfolio — the wrapper adds no drift (invariant)", async () => {
    const sources = tempStores();
    seed(sources);
    const payload = JSON.parse(toolText(await callManageStatus(sources)));
    expect(payload).toEqual({
      rows: collectManageStatus(sources),
      runPortfolio: collectRunPortfolio(sources),
    });
  });

  it("reads without mutating: no enqueue, no appendEvent, no setRunState (invariant)", async () => {
    const sources = tempStores();
    seed(sources);
    const enqueue = vi.spyOn(sources.portfolioQueue, "enqueue");
    const appendEvent = vi.spyOn(sources.eventLedger, "appendEvent");
    const setRunState = vi.spyOn(sources.runStateStore, "setRunState");
    const listQueue = vi.spyOn(sources.portfolioQueue, "listQueue");
    await callManageStatus(sources);
    expect(listQueue).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(setRunState).not.toHaveBeenCalled();
  });

  it("leaves injected stores open — it closes only the stores it opened itself (invariant)", async () => {
    const sources = tempStores();
    seed(sources);
    const closes = [
      vi.spyOn(sources.portfolioQueue, "close"),
      vi.spyOn(sources.eventLedger, "close"),
      vi.spyOn(sources.runStateStore, "close"),
    ];
    await callManageStatus(sources);
    for (const close of closes) expect(close).not.toHaveBeenCalled();
    // Still usable afterward — a closed sqlite handle would throw here.
    expect(() => sources.portfolioQueue.listQueue(null)).not.toThrow();
  });
});
