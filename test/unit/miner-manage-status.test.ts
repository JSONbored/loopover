import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGE_PR_UPDATE_EVENT,
  collectManageStatus,
  collectRunPortfolio,
  formatManagedPrIdentifier,
  indexLatestManageUpdates,
  parseManagedPrIdentifier,
  renderManageStatusTable,
  renderRunPortfolioTable,
  runManageStatus,
  type ManageStatusRow,
  type RunPortfolioRow,
} from "../../packages/gittensory-miner/lib/manage-status.js";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import {
  closeDefaultRunStateStore,
  initRunStateStore,
} from "../../packages/gittensory-miner/lib/run-state.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStores() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-manage-status-"));
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

describe("gittensory-miner manage status (#2325)", () => {
  it("parses and formats managed PR identifiers", () => {
    expect(parseManagedPrIdentifier("pr:42")).toBe(42);
    expect(parseManagedPrIdentifier("issue:42")).toBeNull();
    expect(formatManagedPrIdentifier(42)).toBe("pr:42");
    expect(() => formatManagedPrIdentifier(0)).toThrow("invalid_pr_number");
  });

  it("returns an empty snapshot for an empty portfolio and ledger", () => {
    const { portfolioQueue, eventLedger } = tempStores();
    expect(collectManageStatus({ portfolioQueue, eventLedger })).toEqual([]);
    expect(renderManageStatusTable([])).toBe("no managed pull requests");
  });

  it("merges portfolio queue rows with the latest manage_pr_update event per PR", () => {
    const { portfolioQueue, eventLedger } = tempStores();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:12", priority: 3 });
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "issue:99", priority: 1 });
    eventLedger.appendEvent({
      type: MANAGE_PR_UPDATE_EVENT,
      repoFullName: "acme/widgets",
      payload: {
        prNumber: 12,
        branch: "feat/a",
        ciState: "pending",
        gateVerdict: "advisory",
        outcome: "open",
        lastPolledAt: "2026-07-04T10:00:00.000Z",
      },
    });
    eventLedger.appendEvent({
      type: MANAGE_PR_UPDATE_EVENT,
      repoFullName: "acme/widgets",
      payload: {
        prNumber: 12,
        branch: "feat/a",
        ciState: "success",
        gateVerdict: "pass",
        outcome: "ready",
        lastPolledAt: "2026-07-04T11:00:00.000Z",
      },
    });
    eventLedger.appendEvent({
      type: MANAGE_PR_UPDATE_EVENT,
      repoFullName: "acme/other",
      payload: {
        prNumber: 7,
        branch: "fix/b",
        ciState: "failure",
        gateVerdict: "block",
        outcome: "needs-work",
        lastPolledAt: "2026-07-04T11:05:00.000Z",
      },
    });

    expect(collectManageStatus({ portfolioQueue, eventLedger })).toEqual([
      {
        repoFullName: "acme/other",
        prNumber: 7,
        branch: "fix/b",
        ciState: "failure",
        gateVerdict: "block",
        outcome: "needs-work",
        lastPolledAt: "2026-07-04T11:05:00.000Z",
        queueStatus: null,
        priority: null,
      },
      {
        repoFullName: "acme/widgets",
        prNumber: 12,
        branch: "feat/a",
        ciState: "success",
        gateVerdict: "pass",
        outcome: "ready",
        lastPolledAt: "2026-07-04T11:00:00.000Z",
        queueStatus: "queued",
        priority: 3,
      },
    ]);
  });

  it("ignores malformed manage_pr_update payloads when indexing events", () => {
    const { eventLedger } = tempStores();
    eventLedger.appendEvent({
      type: MANAGE_PR_UPDATE_EVENT,
      repoFullName: "acme/widgets",
      payload: { prNumber: 0, branch: "bad" },
    });
    expect(indexLatestManageUpdates(eventLedger.readEvents()).size).toBe(0);
  });

  it("renders numeric queue priority in the table output", () => {
    const rows: ManageStatusRow[] = [
      {
        repoFullName: "acme/widgets",
        prNumber: 4,
        branch: "feat/x",
        ciState: "success",
        gateVerdict: "pass",
        outcome: "ready",
        lastPolledAt: "2026-07-04T12:00:00.000Z",
        queueStatus: "queued",
        priority: 2,
      },
    ];
    expect(renderManageStatusTable(rows)).toContain("     2");
  });

  it("collectRunPortfolio: a repo with a run state but zero PRs still appears (#4279)", () => {
    const { portfolioQueue, eventLedger, runStateStore } = tempStores();
    runStateStore.setRunState("acme/discovering-only", "discovering");

    expect(collectRunPortfolio({ portfolioQueue, eventLedger, runStateStore })).toEqual([
      { repoFullName: "acme/discovering-only", runState: "discovering", runStateUpdatedAt: expect.any(String), prCount: 0, prs: [] },
    ]);
  });

  it("collectRunPortfolio: a repo with PRs but no recorded run state reports runState: null (#4279)", () => {
    const { portfolioQueue, eventLedger, runStateStore } = tempStores();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:4", priority: 1 });

    const portfolio = collectRunPortfolio({ portfolioQueue, eventLedger, runStateStore });
    expect(portfolio).toEqual([
      { repoFullName: "acme/widgets", runState: null, runStateUpdatedAt: null, prCount: 1, prs: [expect.objectContaining({ prNumber: 4 })] },
    ]);
  });

  it("collectRunPortfolio: folds a repo's run state alongside its multiple PR rows, sorted by repo", () => {
    const { portfolioQueue, eventLedger, runStateStore } = tempStores();
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:4", priority: 1 });
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:5", priority: 2 });
    portfolioQueue.enqueue({ repoFullName: "acme/aaa", identifier: "pr:1", priority: 1 });
    runStateStore.setRunState("acme/widgets", "preparing");

    const portfolio = collectRunPortfolio({ portfolioQueue, eventLedger, runStateStore });
    expect(portfolio.map((entry) => entry.repoFullName)).toEqual(["acme/aaa", "acme/widgets"]);
    const widgets = portfolio.find((entry) => entry.repoFullName === "acme/widgets")!;
    expect(widgets.runState).toBe("preparing");
    expect(widgets.prCount).toBe(2);
  });

  it("collectRunPortfolio rejects a missing/invalid run-state store", () => {
    const { portfolioQueue, eventLedger } = tempStores();
    expect(() =>
      collectRunPortfolio({
        portfolioQueue,
        eventLedger,
        runStateStore: undefined,
      } as unknown as Parameters<typeof collectRunPortfolio>[0]),
    ).toThrow("invalid_run_state_store");
  });

  it("renderRunPortfolioTable reports 'no tracked repos' for an empty portfolio, and renders repo/run-state/PR-count otherwise", () => {
    expect(renderRunPortfolioTable([])).toBe("no tracked repos");
    const portfolio: RunPortfolioRow[] = [
      { repoFullName: "acme/widgets", runState: "planning", runStateUpdatedAt: "2026-07-04T12:00:00.000Z", prCount: 2, prs: [] },
    ];
    const rendered = renderRunPortfolioTable(portfolio);
    expect(rendered).toContain("acme/widgets");
    expect(rendered).toContain("planning");
    expect(rendered).toContain("2026-07-04T12:00:00.000Z");
    expect(rendered).toMatch(/\s2$/);
  });

  it("renderRunPortfolioTable renders '-' for a repo with no recorded run state", () => {
    const portfolio: RunPortfolioRow[] = [
      { repoFullName: "acme/widgets", runState: null, runStateUpdatedAt: null, prCount: 0, prs: [] },
    ];
    expect(renderRunPortfolioTable(portfolio)).toContain("-");
  });

  it("runManageStatus prints the PR table + run portfolio table, and JSON output additive to the existing rows key (#4279)", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-manage-status-cli-"));
    roots.push(root);
    const portfolioQueue = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
    const eventLedger = initEventLedger(join(root, "event-ledger.sqlite3"));
    const runStateStore = initRunStateStore(join(root, "run-state.sqlite3"));
    stores.push(portfolioQueue, eventLedger, runStateStore);
    portfolioQueue.enqueue({ repoFullName: "acme/widgets", identifier: "pr:4", priority: 2 });
    eventLedger.appendEvent({
      type: MANAGE_PR_UPDATE_EVENT,
      repoFullName: "acme/widgets",
      payload: {
        prNumber: 4,
        branch: "feat/x",
        ciState: "success",
        gateVerdict: "pass",
        outcome: "ready",
        lastPolledAt: "2026-07-04T12:00:00.000Z",
      },
    });
    runStateStore.setRunState("acme/widgets", "planning");
    runStateStore.setRunState("acme/discovering-only", "discovering"); // no PRs yet -- must still appear

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const initStores = {
      initPortfolioQueue: () => portfolioQueue,
      initEventLedger: () => eventLedger,
      initRunStateStore: () => runStateStore,
    };
    expect(runManageStatus([], initStores)).toBe(0);
    const textOutput = String(log.mock.calls[0]?.[0]);
    expect(textOutput).toContain("acme/widgets");
    expect(textOutput).toContain("success");
    expect(textOutput).toContain("planning"); // the run-portfolio section
    expect(textOutput).toContain("acme/discovering-only");
    expect(textOutput).toContain("discovering");

    log.mockClear();
    expect(runManageStatus(["--json"], initStores)).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        repoFullName: "acme/widgets",
        prNumber: 4,
        ciState: "success",
        queueStatus: "queued",
      }),
    ]);
    expect(parsed.runPortfolio).toEqual([
      expect.objectContaining({ repoFullName: "acme/discovering-only", runState: "discovering", prCount: 0 }),
      expect.objectContaining({ repoFullName: "acme/widgets", runState: "planning", prCount: 1 }),
    ]);
  });

  it("rejects unknown CLI options", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runManageStatus(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown option");
  });

  it("rejects a stray positional argument with usage", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runManageStatus(["acme/widgets"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Usage: loopover-miner manage status [--json]");
  });
});
