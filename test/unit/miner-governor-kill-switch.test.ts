import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { checkMinerKillSwitch, recordMinerKillSwitchTransition } from "../../packages/gittensory-miner/lib/governor-kill-switch.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("checkMinerKillSwitch (#2341)", () => {
  it("global env switch halts regardless of per-repo state", () => {
    expect(checkMinerKillSwitch({ repoPaused: false, env: { GITTENSORY_MINER_KILL_SWITCH: "true" } })).toEqual({
      scope: "global",
      active: true,
    });
    expect(checkMinerKillSwitch({ repoPaused: true, env: { GITTENSORY_MINER_KILL_SWITCH: "true" } })).toEqual({
      scope: "global",
      active: true,
    });
  });

  it("per-repo pause halts only when the global switch is not tripped", () => {
    expect(checkMinerKillSwitch({ repoPaused: true, env: {} })).toEqual({ scope: "repo", active: true });
    expect(checkMinerKillSwitch({ repoPaused: false, env: {} })).toEqual({ scope: "none", active: false });
  });

  it("defaults to reading process.env when no env override is given", () => {
    const original = process.env.GITTENSORY_MINER_KILL_SWITCH;
    try {
      process.env.GITTENSORY_MINER_KILL_SWITCH = "1";
      expect(checkMinerKillSwitch({ repoPaused: false })).toEqual({ scope: "global", active: true });
    } finally {
      if (original === undefined) delete process.env.GITTENSORY_MINER_KILL_SWITCH;
      else process.env.GITTENSORY_MINER_KILL_SWITCH = original;
    }
  });
});

describe("recordMinerKillSwitchTransition (#2341)", () => {
  it("records a tripped transition to the governor ledger and resuming records a second row", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-kill-switch-"));
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

  it("is a no-op and appends nothing when the scope has not changed", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-kill-switch-noop-"));
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
});
