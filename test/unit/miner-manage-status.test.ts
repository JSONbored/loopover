import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGE_STATUS_EVENT_TYPE,
  buildManageStatusSnapshot,
  formatManageStatusJson,
  formatManageStatusTable,
  parseManageStatusArgs,
  runManageStatus,
} from "../../packages/gittensory-miner/lib/manage-status.js";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import { runCapture } from "./support/miner-cli-harness";

const roots: string[] = [];

function tempStores() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-manage-status-"));
  roots.push(root);
  const portfolio = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  stores.push(portfolio, ledger);
  return { portfolio, ledger };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("manage status snapshot (#2325)", () => {
  it("exposes the manage event type constant", () => {
    expect(MANAGE_STATUS_EVENT_TYPE).toBe("manage_pr_update");
  });

  it("returns an empty snapshot when the portfolio has no PR rows", () => {
    const { portfolio, ledger } = tempStores();
    expect(
      buildManageStatusSnapshot({
        listQueue: () => portfolio.listQueue(),
        readEvents: () => ledger.readEvents(),
      }),
    ).toEqual([]);
    expect(formatManageStatusTable([])).toContain("No managed pull requests");
  });

  it("renders portfolio PR rows and merges latest manage_pr_update fields", () => {
    const { portfolio, ledger } = tempStores();
    portfolio.enqueue({ repoFullName: "acme/widgets", identifier: "pr:42", priority: 2 });
    portfolio.dequeueNext();
    portfolio.enqueue({ repoFullName: "acme/widgets", identifier: "issue:99", priority: 1 });
    ledger.appendEvent({
      type: MANAGE_STATUS_EVENT_TYPE,
      repoFullName: "acme/widgets",
      payload: {
        pullNumber: 42,
        branch: "feat/manage-status",
        ciState: "pending",
        gateVerdict: "hold",
        outcome: "open",
        lastPolledAt: "2026-07-03T12:00:00.000Z",
      },
    });
    ledger.appendEvent({
      type: MANAGE_STATUS_EVENT_TYPE,
      repoFullName: "acme/widgets",
      payload: {
        pullNumber: 42,
        ciState: "success",
        gateVerdict: "merge",
        lastPolledAt: "2026-07-03T13:00:00.000Z",
      },
    });
    ledger.appendEvent({
      type: MANAGE_STATUS_EVENT_TYPE,
      repoFullName: "JSONbored/gittensory",
      payload: {
        pullNumber: 7,
        branch: "feat/other",
        ciState: "failure",
        gateVerdict: "close",
        outcome: "closed",
        lastPolledAt: "2026-07-03T14:00:00.000Z",
      },
    });

    const rows = buildManageStatusSnapshot({
      listQueue: () => portfolio.listQueue(),
      readEvents: () => ledger.readEvents(),
    });
    expect(rows).toEqual([
      {
        repoFullName: "JSONbored/gittensory",
        pullNumber: 7,
        branch: "feat/other",
        ciState: "failure",
        gateVerdict: "close",
        outcome: "closed",
        lastPolledAt: "2026-07-03T14:00:00.000Z",
        portfolioStatus: null,
      },
      {
        repoFullName: "acme/widgets",
        pullNumber: 42,
        branch: "feat/manage-status",
        ciState: "success",
        gateVerdict: "merge",
        outcome: "open",
        lastPolledAt: "2026-07-03T13:00:00.000Z",
        portfolioStatus: "in_progress",
      },
    ]);

    const table = formatManageStatusTable(rows);
    expect(table).toContain("acme/widgets");
    expect(table).toContain("42");
    expect(table).toContain("feat/manage-status");
    expect(table).toContain("success");
    expect(table).toContain("merge");
  });

  it("emits stable JSON output shape", () => {
    const rows = [
      {
        repoFullName: "acme/widgets",
        pullNumber: 42,
        branch: "feat/manage-status",
        ciState: "success",
        gateVerdict: "merge",
        outcome: "open",
        lastPolledAt: "2026-07-03T13:00:00.000Z",
        portfolioStatus: "in_progress",
      },
    ];
    expect(JSON.parse(formatManageStatusJson(rows))).toEqual({ rows });
    expect(runManageStatus({ listQueue: () => [], readEvents: () => [] }, { json: true }).output).toContain(
      '"rows": []',
    );
  });

  it("rejects unexpected status arguments", () => {
    expect(() => parseManageStatusArgs(["--json", "extra"])).toThrow(/unexpected_arguments/);
  });
});

describe("gittensory-miner status CLI (#2325)", () => {
  it("prints the empty-portfolio message from the bin entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-status-cli-"));
    roots.push(root);
    vi.stubEnv("GITTENSORY_MINER_CONFIG_DIR", root);
    vi.stubEnv("GITTENSORY_MINER_NO_UPDATE_CHECK", "1");
    const output = runCapture(["status", "--no-update-check"]);
    expect(output).toContain("No managed pull requests");
  });

  it("serves --json from the bin entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-status-cli-json-"));
    roots.push(root);
    vi.stubEnv("GITTENSORY_MINER_CONFIG_DIR", root);
    vi.stubEnv("GITTENSORY_MINER_NO_UPDATE_CHECK", "1");
    const output = runCapture(["status", "--json", "--no-update-check"]);
    expect(JSON.parse(output)).toEqual({ rows: [] });
  });

  it("includes status in help output", () => {
    const output = runCapture(["--help", "--no-update-check"]);
    expect(output).toContain("gittensory-miner status");
    expect(output).toContain("--json");
  });
});
