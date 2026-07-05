import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGE_PR_UPDATE_EVENT,
  collectManageStatus,
  formatManagedPrIdentifier,
  indexLatestManageUpdates,
  parseManagedPrIdentifier,
  renderManageStatusTable,
  runManageStatus,
  type ManageStatusRow,
} from "../../packages/gittensory-miner/lib/manage-status.js";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStores() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-manage-status-"));
  roots.push(root);
  const portfolioQueue = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  const eventLedger = initEventLedger(join(root, "event-ledger.sqlite3"));
  stores.push(portfolioQueue, eventLedger);
  return { portfolioQueue, eventLedger };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
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

  it("runManageStatus prints table and JSON output", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-manage-status-cli-"));
    roots.push(root);
    const portfolioQueue = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
    const eventLedger = initEventLedger(join(root, "event-ledger.sqlite3"));
    stores.push(portfolioQueue, eventLedger);
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

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      runManageStatus([], {
        initPortfolioQueue: () => portfolioQueue,
        initEventLedger: () => eventLedger,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("acme/widgets");
    expect(String(log.mock.calls[0]?.[0])).toContain("success");

    log.mockClear();
    expect(
      runManageStatus(["--json"], {
        initPortfolioQueue: () => portfolioQueue,
        initEventLedger: () => eventLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      rows: [
        expect.objectContaining({
          repoFullName: "acme/widgets",
          prNumber: 4,
          ciState: "success",
          queueStatus: "queued",
        }),
      ],
    });
  });

  it("rejects unknown CLI options", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runManageStatus(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown option");
  });
});
