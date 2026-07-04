import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  filterLedgerEvents,
  parseLedgerListArgs,
  renderLedgerTable,
  runLedgerCli,
  runLedgerList,
} from "../../packages/gittensory-miner/lib/event-ledger-cli.js";
import type { LedgerEntry } from "../../packages/gittensory-miner/lib/event-ledger.d.ts";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-event-ledger-cli-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultEventLedger();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner event ledger CLI (#2290)", () => {
  it("parseLedgerListArgs validates argv", () => {
    expect(parseLedgerListArgs([])).toEqual({
      json: false,
      repoFullName: null,
      since: null,
      type: null,
    });
    expect(
      parseLedgerListArgs(["--repo", "acme/widgets", "--since", "3", "--type", "manage_pr_update", "--json"]),
    ).toEqual({
      json: true,
      repoFullName: "acme/widgets",
      since: 3,
      type: "manage_pr_update",
    });
    expect(parseLedgerListArgs(["--since", "1.5"])).toEqual({
      error: "since must be a non-negative integer seq cursor.",
    });
  });

  it("filterLedgerEvents and renderLedgerTable format rows", () => {
    const events: LedgerEntry[] = [
      {
        id: 1,
        seq: 4,
        type: "manage_pr_update",
        repoFullName: "acme/widgets",
        payload: { prNumber: 7 },
        createdAt: "2026-07-04T12:00:00.000Z",
      },
    ];
    expect(filterLedgerEvents(events, { type: "discovered_issue" })).toEqual([]);
    expect(filterLedgerEvents(events, { type: "manage_pr_update" })).toEqual(events);
    expect(renderLedgerTable([])).toBe("no event ledger entries");
    expect(renderLedgerTable(events)).toContain("manage_pr_update");
    expect(renderLedgerTable(events)).toContain("   4");
  });

  it("runLedgerList prints table and JSON output with repo, since, and type filters", () => {
    const eventLedger = tempLedger();
    eventLedger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 1 } });
    eventLedger.appendEvent({ type: "manage_pr_update", repoFullName: "acme/widgets", payload: { prNumber: 2 } });
    eventLedger.appendEvent({ type: "manage_pr_update", repoFullName: "acme/other", payload: { prNumber: 3 } });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runLedgerList([], {
        initEventLedger: () => eventLedger,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("discovered_issue");

    log.mockClear();
    expect(
      runLedgerList(["--repo", "acme/widgets", "--since", "1", "--type", "manage_pr_update", "--json"], {
        initEventLedger: () => eventLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      events: [expect.objectContaining({ seq: 2, type: "manage_pr_update", repoFullName: "acme/widgets" })],
    });
  });

  it("runLedgerCli dispatches list and rejects unknown subcommands", () => {
    const eventLedger = tempLedger();
    eventLedger.appendEvent({ type: "plan_built", payload: { steps: 1 } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runLedgerCli("list", ["--json"], { initEventLedger: () => eventLedger })).toBe(0);
    expect(log).toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runLedgerCli("tail", [])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown ledger subcommand");
  });

  it("surfaces invalid since cursors from argv parsing and the ledger store", () => {
    const eventLedger = tempLedger();
    eventLedger.appendEvent({ type: "plan_built", payload: {} });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runLedgerList(["--since", "-1"], {
        initEventLedger: () => eventLedger,
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("since must be a non-negative integer seq cursor.");

    error.mockClear();
    expect(
      runLedgerList(["--since", "1.5"], {
        initEventLedger: () => eventLedger,
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("since must be a non-negative integer seq cursor.");
  });
});
