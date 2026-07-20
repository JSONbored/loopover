import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { closeDefaultGovernorLedger, initGovernorLedger } from "../../packages/loopover-miner/lib/governor-ledger.js";
import type { GovernorLedgerEntry } from "../../packages/loopover-miner/lib/governor-ledger.d.ts";
import {
  filterGovernorEvents,
  parseGovernorListArgs,
  renderGovernorTable,
  runGovernorCli,
  runGovernorList,
} from "../../packages/loopover-miner/lib/governor-ledger-cli.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-ledger-cli-"));
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

describe("loopover-miner governor ledger CLI (#2328)", () => {
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
    // REGRESSION (#7525): a path-traversal / control-char segment is rejected with the SAME error shape as the
    // malformed-slash branch above — ../repo hits the guard's left arm, owner/.. the right, a tab the pattern.
    for (const bad of ["../loopover", "acme/..", "ac\tme/widgets"]) {
      expect(parseGovernorListArgs(["--repo", bad])).toEqual({
        error: "Repository must be in owner/repo form.",
      });
    }
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

  it("runGovernorList prints table and JSON output with repo and type filters", async () => {
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
      await runGovernorList([], {
        initGovernorLedger: () => governorLedger,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("allowed");

    log.mockClear();
    expect(
      await runGovernorList(["--repo", "acme/widgets", "--type", "denied", "--json"], {
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

  it("runGovernorCli dispatches list and rejects unknown subcommands", async () => {
    const governorLedger = tempLedger();
    governorLedger.appendGovernorEvent({
      eventType: "throttled",
      actionClass: "write",
      decision: "retry",
      reason: "rate limit",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runGovernorCli("list", ["--json"], { initGovernorLedger: () => governorLedger })).toBe(0);
    expect(log).toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runGovernorCli("tail", [])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown governor subcommand");
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "loopover-miner governor pause [--reason <text>] [--dry-run] [--json]",
    );
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "loopover-miner governor resume [--dry-run] [--json]",
    );

    error.mockClear();
    log.mockClear();
    expect(await runGovernorCli("tail", ["--json"])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: expect.stringContaining("Unknown governor subcommand"),
    });

    error.mockClear();
    expect(await runGovernorCli(undefined, [])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown governor subcommand: .");
  });

  it("runGovernorCli dispatches pause, resume, and status to governor-pause-cli.js (#4851)", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-ledger-cli-pause-"));
    roots.push(root);
    const { openGovernorState } = await import("../../packages/loopover-miner/lib/governor-state.js");
    const governorState = openGovernorState(join(root, "governor-state.sqlite3"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runGovernorCli("pause", ["--json"], { openGovernorState: () => governorState })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ paused: true });

    log.mockClear();
    expect(await runGovernorCli("status", ["--json"], { openGovernorState: () => governorState })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ paused: true });

    log.mockClear();
    expect(await runGovernorCli("resume", ["--json"], { openGovernorState: () => governorState })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ paused: false });

    log.mockClear();
    expect(await runGovernorCli("metrics", [], { openGovernorState: () => governorState })).toBe(0);
    expect(log).toHaveBeenCalled();

    governorState.close();
  });

  it("rejects unknown options from argv parsing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runGovernorList(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown option");
  });

  it("parseGovernorListArgs rejects missing flag values and stray positionals", () => {
    expect(parseGovernorListArgs(["--repo"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner governor list"),
    });
    expect(parseGovernorListArgs(["--type"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner governor list"),
    });
    expect(parseGovernorListArgs(["extra"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner governor list"),
    });
  });

  it("filterGovernorEvents tolerates a non-array input", () => {
    expect(filterGovernorEvents(undefined as never)).toEqual([]);
  });

  it("renderGovernorTable displays a dash for missing repoFullName/ts", () => {
    const events: GovernorLedgerEntry[] = [
      {
        id: 5,
        ts: undefined as unknown as string,
        eventType: "allowed",
        repoFullName: null,
        actionClass: "analyze",
        decision: "allow",
        reason: "within budget",
        payload: {},
      },
    ];
    expect(renderGovernorTable(events)).toContain("-");
  });

  it("runGovernorList reports a failure raised by the governor ledger", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await runGovernorList([], {
        initGovernorLedger: () => {
          throw new Error("ledger_broken");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("ledger_broken");
  });

  it("withGovernorLedger opens and closes its own default ledger when no initGovernorLedger override is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-ledger-cli-default-"));
    roots.push(root);
    const previousDbPath = process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB;
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = join(root, "governor-ledger.sqlite3");
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runGovernorList([])).toBe(0);
      expect(log).toHaveBeenCalledWith("no governor ledger entries");
    } finally {
      if (previousDbPath === undefined) delete process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB;
      else process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = previousDbPath;
    }
  });
});
