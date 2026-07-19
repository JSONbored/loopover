import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { checkMinerKillSwitch, recordMinerKillSwitchTransition } from "../../packages/loopover-miner/lib/governor-kill-switch.js";
import { initGovernorLedger } from "../../packages/loopover-miner/lib/governor-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("checkMinerKillSwitch (#2341)", () => {
  it("global env switch halts regardless of per-repo state", () => {
    expect(checkMinerKillSwitch({ repoPaused: false, env: { LOOPOVER_MINER_KILL_SWITCH: "true" } })).toEqual({
      scope: "global",
      active: true,
    });
    expect(checkMinerKillSwitch({ repoPaused: true, env: { LOOPOVER_MINER_KILL_SWITCH: "true" } })).toEqual({
      scope: "global",
      active: true,
    });
  });

  it("per-repo pause halts only when the global switch is not tripped", () => {
    expect(checkMinerKillSwitch({ repoPaused: true, env: {} })).toEqual({ scope: "repo", active: true });
    expect(checkMinerKillSwitch({ repoPaused: false, env: {} })).toEqual({ scope: "none", active: false });
  });

  it("defaults to reading process.env when no env override is given", () => {
    const original = process.env.LOOPOVER_MINER_KILL_SWITCH;
    try {
      process.env.LOOPOVER_MINER_KILL_SWITCH = "1";
      expect(checkMinerKillSwitch({ repoPaused: false })).toEqual({ scope: "global", active: true });
    } finally {
      if (original === undefined) delete process.env.LOOPOVER_MINER_KILL_SWITCH;
      else process.env.LOOPOVER_MINER_KILL_SWITCH = original;
    }
  });
});

describe("recordMinerKillSwitchTransition (#2341)", () => {
  it("records a tripped transition to the governor ledger and resuming records a second row", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const tripped = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "none", scope: "repo" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(tripped?.eventType).toBe("kill_switch");
    expect(tripped?.decision).toBe("tripped");

    const resumed = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "repo", scope: "none" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(resumed?.decision).toBe("resumed");

    const rows = ledger.readGovernorEvents({ repoFullName: "acme/widgets" });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBeLessThan(rows[1]?.id ?? 0);
  });

  it("a transition with no repoFullName supplied records a null repoFullName, not an omitted or undefined one", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-no-repo-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const tripped = recordMinerKillSwitchTransition(
      { actionClass: "open_pr", previousScope: "none", scope: "global" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(tripped?.repoFullName).toBeNull();
    const rows = ledger.readGovernorEvents({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repoFullName).toBeNull();
  });

  it("is a no-op and appends nothing when the scope has not changed", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-noop-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const append = vi.fn((event: Parameters<typeof ledger.appendGovernorEvent>[0]) => ledger.appendGovernorEvent(event));

    const result = recordMinerKillSwitchTransition(
      { actionClass: "open_pr", previousScope: "none", scope: "none" },
      { append },
    );

    expect(result).toBeNull();
    expect(append).not.toHaveBeenCalled();
    expect(ledger.readGovernorEvents({})).toHaveLength(0);
  });

  it("falls back to the real governor-ledger appendGovernorEvent when no append override is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-default-append-"));
    roots.push(root);
    const dbPath = join(root, "governor-ledger.sqlite3");
    const previousDbPath = process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB;
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = dbPath;
    try {
      const { closeDefaultGovernorLedger } = await import("../../packages/loopover-miner/lib/governor-ledger.js");
      const tripped = recordMinerKillSwitchTransition({
        repoFullName: "acme/widgets",
        actionClass: "open_pr",
        previousScope: "none",
        scope: "repo",
      });
      expect(tripped?.decision).toBe("tripped");
      closeDefaultGovernorLedger();

      // recordMinerKillSwitchTransition wrote through the module-level default appendGovernorEvent (no override
      // passed); reopening the same file after closing that default confirms the write was actually persisted.
      const reopened = initGovernorLedger(dbPath);
      ledgers.push(reopened);
      expect(reopened.readGovernorEvents({ repoFullName: "acme/widgets" })).toHaveLength(1);
    } finally {
      if (previousDbPath === undefined) delete process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB;
      else process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = previousDbPath;
    }
  });
});
