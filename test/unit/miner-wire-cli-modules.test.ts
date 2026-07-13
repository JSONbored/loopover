import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runQueueClaimBatch,
  parseQueueClaimBatchArgs,
} from "../../packages/gittensory-miner/lib/portfolio-queue-cli.js";
import { initPortfolioQueueManager } from "../../packages/gittensory-miner/lib/portfolio-queue-manager.js";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";
import {
  runOrbExportCli,
  parseOrbExportArgs,
  openOrbExportStore,
} from "../../packages/gittensory-miner/lib/orb-export.js";
import { initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";

const roots: string[] = [];
const closeables: Array<{ close(): void }> = [];
let logs: string[] = [];

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-wire-cli-"));
  roots.push(root);
  return root;
}

function captureLog() {
  logs = [];
  return vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const c of closeables.splice(0)) c.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("queue claim-batch — wires the WIP-cap-aware batch claimer (#4833)", () => {
  it("parses the wip flags, rejecting a non-numeric/negative value", () => {
    expect(parseQueueClaimBatchArgs(["--global-wip", "3", "--per-repo-wip", "1", "--json"])).toEqual({
      json: true,
      dryRun: false,
      globalWipCap: 3,
      perRepoWipCap: 1,
    });
    expect(parseQueueClaimBatchArgs(["--json"])).toEqual({
      json: true,
      dryRun: false,
      globalWipCap: undefined,
      perRepoWipCap: undefined,
    });
    expect(parseQueueClaimBatchArgs(["--global-wip", "x"])).toHaveProperty("error");
    expect(parseQueueClaimBatchArgs(["--per-repo-wip", "-1"])).toHaveProperty("error");
    expect(parseQueueClaimBatchArgs(["--bogus"])).toHaveProperty("error");
  });

  it("#4847: --dry-run reports what a claim would do and returns 0 without opening the manager", () => {
    const initPortfolioQueueManagerSpy = vi.fn();
    const spy = captureLog();

    const jsonCode = runQueueClaimBatch(["--global-wip", "3", "--per-repo-wip", "2", "--dry-run", "--json"], {
      initPortfolioQueueManager: initPortfolioQueueManagerSpy,
    });
    expect(jsonCode).toBe(0);
    expect(initPortfolioQueueManagerSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join(""))).toEqual({ outcome: "dry_run", globalWipCap: 3, perRepoWipCap: 2 });

    logs = [];
    const textCode = runQueueClaimBatch(["--dry-run"], { initPortfolioQueueManager: initPortfolioQueueManagerSpy });
    expect(textCode).toBe(0);
    expect(logs.join("")).toContain("DRY RUN: would claim a batch (global-wip: 1, per-repo-wip: 1)");
    spy.mockRestore();
  });

  it("claims a diversified batch across repos via the manager", () => {
    const store = initPortfolioQueueStore(join(tempDir(), "q.sqlite3"));
    closeables.push(store);
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 2, perRepoWipCap: 1 } });
    manager.enqueue({ repoFullName: "o/a", identifier: "1" });
    manager.enqueue({ repoFullName: "o/b", identifier: "2" });

    const spy = captureLog();
    const code = runQueueClaimBatch(["--json"], { initPortfolioQueueManager: () => manager });
    spy.mockRestore();

    expect(code).toBe(0);
    const out = JSON.parse(logs.join(""));
    expect(out.claimed.map((e: { identifier: string }) => e.identifier).sort()).toEqual(["1", "2"]);
    // Both are now in_progress (claimed), so a second claim yields nothing.
    expect(store.listInProgress()).toHaveLength(2);
  });

  it("prints 'none' when the queue is empty", () => {
    const store = initPortfolioQueueStore(join(tempDir(), "q.sqlite3"));
    closeables.push(store);
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 1, perRepoWipCap: 1 } });
    const spy = captureLog();
    const code = runQueueClaimBatch([], { initPortfolioQueueManager: () => manager });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(logs.join("")).toBe("none");
  });

  it("returns 2 (not a crash) when the manager fails to open", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runQueueClaimBatch(["--json"], {
      initPortfolioQueueManager: () => {
        throw new Error("bad_store_path");
      },
    });
    errSpy.mockRestore();
    expect(code).toBe(2);
  });
});

describe("orb export — wires the anonymized telemetry batch-builder (#4833)", () => {
  const stores = () => {
    const dir = tempDir();
    const store = openOrbExportStore(join(dir, "orb.sqlite3"));
    const ledger = initEventLedger(join(dir, "ledger.sqlite3"));
    closeables.push(store, ledger);
    return { openOrbExportStore: () => store, initEventLedger: () => ledger };
  };

  it("#4847: --dry-run reports what an export would do and returns 0 without opening any store", () => {
    const openOrbExportStoreSpy = vi.fn();
    const initEventLedgerSpy = vi.fn();
    const spy = captureLog();

    const disabledCode = runOrbExportCli(["--dry-run", "--json"], {
      openOrbExportStore: openOrbExportStoreSpy,
      initEventLedger: initEventLedgerSpy,
    });
    expect(disabledCode).toBe(0);
    expect(openOrbExportStoreSpy).not.toHaveBeenCalled();
    expect(initEventLedgerSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join(""))).toEqual({ outcome: "dry_run", enabled: false });

    logs = [];
    const enabledCode = runOrbExportCli(["--enable", "--dry-run"], {
      openOrbExportStore: openOrbExportStoreSpy,
      initEventLedger: initEventLedgerSpy,
    });
    expect(enabledCode).toBe(0);
    expect(openOrbExportStoreSpy).not.toHaveBeenCalled();
    expect(logs.join("")).toContain("DRY RUN: would build and report an anonymized Orb export batch");

    logs = [];
    const disabledTextCode = runOrbExportCli(["--dry-run"], {
      openOrbExportStore: openOrbExportStoreSpy,
      initEventLedger: initEventLedgerSpy,
    });
    expect(disabledTextCode).toBe(0);
    expect(openOrbExportStoreSpy).not.toHaveBeenCalled();
    expect(logs.join("")).toContain("DRY RUN: orb export is opt-in and disabled — pass --enable");
    spy.mockRestore();
  });

  it("is opt-in: exports nothing (null batch) without --enable", () => {
    const spy = captureLog();
    const code = runOrbExportCli(["--json"], stores());
    spy.mockRestore();
    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: false, batch: null });
  });

  it("builds an anonymized batch when --enable is passed (empty ledger → empty batch)", () => {
    const spy = captureLog();
    const code = runOrbExportCli(["--enable", "--json"], stores());
    spy.mockRestore();
    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual({ enabled: true, batch: [] });
  });

  it("rejects an unknown flag", () => {
    expect(parseOrbExportArgs(["--nope"])).toHaveProperty("error");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runOrbExportCli(["--nope"], stores())).toBe(2);
    errSpy.mockRestore();
  });

  it("returns 2 (not a crash) when the store fails to open — the open is inside the try", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = runOrbExportCli(["--enable"], {
      openOrbExportStore: () => {
        throw new Error("bad_config_path");
      },
      initEventLedger: () => {
        throw new Error("should_not_reach");
      },
    });
    errSpy.mockRestore();
    expect(code).toBe(2);
  });
});
