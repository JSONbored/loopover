import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { closeDefaultGovernorLedger, initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import type { GovernorLedgerEntry } from "../../packages/gittensory-miner/lib/governor-ledger.d.ts";
import {
  filterGovernorEvents,
  parseGovernorListArgs,
  renderGovernorTable,
  runGovernorCli,
  runGovernorList,
} from "../../packages/gittensory-miner/lib/governor-ledger-cli.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-ledger-cli-"));
  roots.push(root);
  const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultGovernorLedger();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner governor ledger CLI (#2328)", () => {
  it("parseGovernorListArgs validates argv", () => {
    expect(parseGovernorListArgs([])).toEqual({
      json: false,
      repoFullName: null,
      type: null,
    });
    expect(
      parseGovernorListArgs(["--repo", "acme/widgets", "--type", "denied", "--json"]),
    ).toEqual({
      json: true,
      repoFullName: "acme/widgets",
      type: "denied",
    });
    expect(parseGovernorListArgs(["--type", "bogus"])).toEqual({
      error: expect.stringMatching(/Invalid type/),
    });
    expect(parseGovernorListArgs(["--repo", "bad"])).toEqual({
      error: "Repository must be in owner/repo form.",
    });
  });

  it("filterGovernorEvents and renderGovernorTable format rows", () => {
    const events: GovernorLedgerEntry[] = [
      {
        id: 1,
        ts: "2026-07-04T12:00:00.000Z",
        eventType: "denied",
        repoFullName: "acme/widgets",
        actionClass: "write",
        decision: "block",
        reason: "kill switch active",
        payload: { rule: "global_kill_switch" },
      },
    ];
    expect(filterGovernorEvents(events, { type: "allowed" })).toEqual([]);
    expect(filterGovernorEvents(events, { type: "denied" })).toEqual(events);
    expect(renderGovernorTable([])).toBe("no governor ledger entries");
    expect(renderGovernorTable(events)).toContain("denied");
    expect(renderGovernorTable(events)).toContain("   1");
  });

  it("runGovernorList prints table and JSON output with repo and type filters", () => {
    const governorLedger = tempLedger();
    governorLedger.appendGovernorEvent({
      eventType: "allowed",
      repoFullName: "acme/widgets",
      actionClass: "analyze",
      decision: "allow",
      reason: "within budget",
    });
    governorLedger.appendGovernorEvent({
      eventType: "denied",
      repoFullName: "acme/widgets",
      actionClass: "write",
      decision: "block",
      reason: "house rule",
    });
    governorLedger.appendGovernorEvent({
      eventType: "denied",
      repoFullName: "acme/other",
      actionClass: "write",
      decision: "block",
      reason: "other repo",
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runGovernorList([], {
        initGovernorLedger: () => governorLedger,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("allowed");

    log.mockClear();
    expect(
      runGovernorList(["--repo", "acme/widgets", "--type", "denied", "--json"], {
        initGovernorLedger: () => governorLedger,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      events: [
        expect.objectContaining({
          id: 2,
          eventType: "denied",
          repoFullName: "acme/widgets",
        }),
      ],
    });
  });

  it("runGovernorCli dispatches list and rejects unknown subcommands", () => {
    const governorLedger = tempLedger();
    governorLedger.appendGovernorEvent({
      eventType: "throttled",
      actionClass: "write",
      decision: "retry",
      reason: "rate limit",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runGovernorCli("list", ["--json"], { initGovernorLedger: () => governorLedger })).toBe(0);
    expect(log).toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runGovernorCli("tail", [])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown governor subcommand");
  });

  it("rejects unknown options from argv parsing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runGovernorList(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown option");
  });
});
