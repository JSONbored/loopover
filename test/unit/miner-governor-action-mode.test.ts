import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { resolveMinerActionModeGate, recordMinerDryRunShadow } from "../../packages/gittensory-miner/lib/governor-action-mode.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveMinerActionModeGate (#2342)", () => {
  it("defaults to dry_run with no config anywhere", () => {
    expect(resolveMinerActionModeGate({ killSwitchScope: "none", env: {} })).toEqual({
      mode: "dry_run",
      executes: false,
    });
  });

  it("the repo's exact opt-in alone stays dry_run without operator opt-in", () => {
    expect(resolveMinerActionModeGate({ killSwitchScope: "none", repoLiveModeOptIn: "live", env: {} })).toEqual({
      mode: "dry_run",
      executes: false,
    });
  });

  it("the operator's global env opt-in alone also stays dry_run without repo opt-in", () => {
    expect(
      resolveMinerActionModeGate({ killSwitchScope: "none", env: { GITTENSORY_MINER_LIVE_MODE: "live" } }),
    ).toEqual({ mode: "dry_run", executes: false });
  });

  it("requires both repo and operator opt-ins for live execution", () => {
    expect(
      resolveMinerActionModeGate({
        killSwitchScope: "none",
        repoLiveModeOptIn: "live",
        env: { GITTENSORY_MINER_LIVE_MODE: "live" },
      }),
    ).toEqual({ mode: "live", executes: true });
  });

  it("a near-miss opt-in value stays dry_run (fail closed)", () => {
    expect(
      resolveMinerActionModeGate({ killSwitchScope: "none", repoLiveModeOptIn: "YES", env: { GITTENSORY_MINER_LIVE_MODE: "1" } }),
    ).toEqual({ mode: "dry_run", executes: false });
  });

  it("the kill-switch always wins over a live opt-in", () => {
    expect(
      resolveMinerActionModeGate({ killSwitchScope: "repo", repoLiveModeOptIn: "live", env: { GITTENSORY_MINER_LIVE_MODE: "live" } }),
    ).toEqual({ mode: "paused", executes: false });
  });

  it("defaults to reading process.env when no env override is given", () => {
    const original = process.env.GITTENSORY_MINER_LIVE_MODE;
    try {
      process.env.GITTENSORY_MINER_LIVE_MODE = "live";
      expect(resolveMinerActionModeGate({ killSwitchScope: "none", repoLiveModeOptIn: "live" })).toEqual({
        mode: "live",
        executes: true,
      });
    } finally {
      if (original === undefined) delete process.env.GITTENSORY_MINER_LIVE_MODE;
      else process.env.GITTENSORY_MINER_LIVE_MODE = original;
    }
  });
});

describe("recordMinerDryRunShadow (#2342)", () => {
  it("records the would-be action to the governor ledger without executing anything", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-action-mode-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const recorded = recordMinerDryRunShadow(
      { repoFullName: "acme/widgets", actionClass: "open_pr", wouldBeAction: { action: "open_pr", title: "example" } },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(recorded.eventType).toBe("allowed");
    expect(recorded.decision).toBe("dry_run");
    expect(recorded.payload).toEqual({ wouldBeAction: { action: "open_pr", title: "example" } });

    const rows = ledger.readGovernorEvents({ repoFullName: "acme/widgets" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("dry_run");
  });
});
