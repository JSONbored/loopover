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
  renderEventLedgerMetrics,
  renderLedgerTable,
  runLedgerCli,
  runLedgerList,
  runLedgerMetrics,
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

function tempEventDbPath() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-event-ledger-metrics-"));
  roots.push(root);
  return join(root, "event-ledger.sqlite3");
}

function metricEntry(seq: number, type: string): LedgerEntry {
  return { id: seq, seq, type, repoFullName: null, payload: {}, createdAt: "2026-07-04T12:00:00.000Z" };
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

describe("gittensory-miner ledger metrics CLI (#4841)", () => {
  it("renderEventLedgerMetrics emits one sorted gittensory_miner_events_total series per type", () => {
    const text = renderEventLedgerMetrics([
      metricEntry(1, "manage_pr_update"),
      metricEntry(2, "discovered_issue"),
      metricEntry(3, "manage_pr_update"),
    ]);
    expect(text).toContain(
      "# HELP gittensory_miner_events_total Event-ledger entries the miner has recorded, by event type.",
    );
    expect(text).toContain("# TYPE gittensory_miner_events_total counter");
    // Series are emitted in sorted type order, so "discovered_issue" precedes "manage_pr_update".
    expect(text).toContain('gittensory_miner_events_total{type="discovered_issue"} 1');
    expect(text).toContain('gittensory_miner_events_total{type="manage_pr_update"} 2');
    expect(text.indexOf("discovered_issue")).toBeLessThan(text.indexOf("manage_pr_update"));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("renderEventLedgerMetrics still emits a well-formed document for an empty ledger", () => {
    expect(renderEventLedgerMetrics([])).toBe(
      "# HELP gittensory_miner_events_total Event-ledger entries the miner has recorded, by event type.\n" +
        "# TYPE gittensory_miner_events_total counter\n",
    );
  });

  it("renderEventLedgerMetrics escapes label-breaking characters in the event type", () => {
    expect(renderEventLedgerMetrics([metricEntry(1, 'weird"type')])).toContain(
      'gittensory_miner_events_total{type="weird\\"type"} 1',
    );
  });

  it("runLedgerMetrics renders event counters as Prometheus text and returns 0", () => {
    const eventLedger = tempLedger();
    eventLedger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 1 } });
    eventLedger.appendEvent({ type: "manage_pr_update", repoFullName: "acme/widgets", payload: { prNumber: 2 } });
    eventLedger.appendEvent({ type: "manage_pr_update", repoFullName: "acme/other", payload: { prNumber: 3 } });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runLedgerMetrics([], { initEventLedger: () => eventLedger })).toBe(0);

    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("# TYPE gittensory_miner_events_total counter");
    expect(text).toContain('gittensory_miner_events_total{type="discovered_issue"} 1');
    expect(text).toContain('gittensory_miner_events_total{type="manage_pr_update"} 2');
    // The output is a single, once-terminated document (no doubled trailing blank line).
    expect(text.endsWith("\n")).toBe(false);
  });

  it("runLedgerMetrics opens and closes its own default ledger when none is injected", () => {
    const dbPath = tempEventDbPath();
    const seed = initEventLedger(dbPath);
    seed.appendEvent({ type: "plan_built", payload: { steps: 1 } });
    seed.close();

    const prev = process.env.GITTENSORY_MINER_EVENT_LEDGER_DB;
    process.env.GITTENSORY_MINER_EVENT_LEDGER_DB = dbPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runLedgerMetrics([])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.GITTENSORY_MINER_EVENT_LEDGER_DB;
      else process.env.GITTENSORY_MINER_EVENT_LEDGER_DB = prev;
    }
    expect(String(log.mock.calls[0]?.[0])).toContain('gittensory_miner_events_total{type="plan_built"} 1');
  });

  it("runLedgerMetrics rejects unexpected arguments with a usage error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runLedgerMetrics(["--json"], { initEventLedger: () => tempLedger() })).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "Usage: gittensory-miner ledger metrics",
    });
    error.mockClear();
    log.mockClear();
    expect(runLedgerMetrics(["--nope"], { initEventLedger: () => tempLedger() })).toBe(2);
    expect(error).toHaveBeenCalledWith("Usage: gittensory-miner ledger metrics");
    expect(log).not.toHaveBeenCalled();
  });

  it("runLedgerMetrics surfaces a thrown Error message and exits non-zero", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runLedgerMetrics([], {
        initEventLedger: () => {
          throw new Error("event ledger is locked");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("event ledger is locked");
  });

  it("runLedgerMetrics stringifies a non-Error throw", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runLedgerMetrics([], {
        initEventLedger: () => {
          throw "event-ledger-unavailable";
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("event-ledger-unavailable");
  });

  it("runLedgerCli dispatches the metrics subcommand", () => {
    const eventLedger = tempLedger();
    eventLedger.appendEvent({ type: "plan_built", payload: { steps: 1 } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runLedgerCli("metrics", [], { initEventLedger: () => eventLedger })).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('gittensory_miner_events_total{type="plan_built"} 1');
  });
});
