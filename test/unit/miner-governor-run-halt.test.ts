import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import * as engineModule from "@loopover/engine";
import { evaluateRunLoopBoundaryGate } from "../../packages/loopover-miner/lib/governor-run-halt";
import {
  closeDefaultGovernorLedger,
  initGovernorLedger,
} from "../../packages/loopover-miner/lib/governor-ledger";
import { initPortfolioQueueManager } from "../../packages/loopover-miner/lib/portfolio-queue-manager";
import { initPortfolioQueueStore } from "../../packages/loopover-miner/lib/portfolio-queue";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];
const stores: Array<{ close(): void }> = [];
const previousConfigDirs: Array<string | undefined> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const store of stores.splice(0)) store.close();
  closeDefaultGovernorLedger();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousConfigDirs.length > 0) {
    const previousConfigDir = previousConfigDirs.pop();
    if (previousConfigDir === undefined) delete process.env.LOOPOVER_MINER_CONFIG_DIR;
    else process.env.LOOPOVER_MINER_CONFIG_DIR = previousConfigDir;
  }
});

const LIMITS = { budget: 100, turns: 5, elapsedMs: 60_000 };
const HEALTHY_USAGE = { budgetSpent: 10, turnsTaken: 1, elapsedMs: 1_000 };
const HEALTHY_CONVERGENCE = { attempts: 1, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };

describe("evaluateRunLoopBoundaryGate (#2347)", () => {
  it("releases an in-flight portfolio item and records a halt when a flapping run is detected", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const store = initPortfolioQueueStore(":memory:");
    stores.push(store);
    const manager = initPortfolioQueueManager({ store, caps: { globalWipCap: 2, perRepoWipCap: 2 } });
    manager.enqueue({ repoFullName: "acme/repo-a", identifier: "issue:42", priority: 1 });
    const inFlight = store.dequeueNext();
    expect(inFlight?.status).toBe("in_progress");

    const halted = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: { attempts: 4, consecutiveFailures: 3, reenqueues: 0, reachedDone: false },
        inFlightItem: { repoFullName: "acme/repo-a", identifier: "issue:42" },
        markFailed: manager.markFailed.bind(manager),
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(halted.runHalted).toBe(true);
    expect(halted.canClaimNext).toBe(false);
    expect(halted.releasedItem).toMatchObject({ identifier: "issue:42", status: "queued" });
    expect(halted.recorded?.eventType).toBe("denied");
    expect(halted.recorded?.actionClass).toBe("run_loop");

    const blockedClaim = evaluateRunLoopBoundaryGate(
      {
        runHalted: halted.runHalted,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(blockedClaim.canClaimNext).toBe(false);
    const claimed = blockedClaim.canClaimNext ? manager.claimNextBatch() : [];
    expect(claimed).toEqual([]);
  });

  it("halts immediately on a budget-cap breach at the next iteration boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-budget-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const halted = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(halted.runHalted).toBe(true);
    expect(halted.verdict.reason).toBe("budget_exceeded");
    expect(halted.recorded?.reason).toBe("budget_cap_exceeded");
  });

  // #9326: the steady (wasHalted=false, shouldHalt=false) case is not a transition -- it must not append a
  // ledger row on every single healthy iteration. A vi.fn() append spy proves this directly (never called),
  // not just that the returned `recorded` field is null.
  it("never halts and never appends a ledger row for a healthy run under both signals", () => {
    const append = vi.fn();

    const healthy = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append },
    );

    expect(healthy.runHalted).toBe(false);
    expect(healthy.canClaimNext).toBe(true);
    expect(healthy.recorded).toBeNull();
    expect(healthy.releasedItem).toBeNull();
    expect(append).not.toHaveBeenCalled();
  });

  // #9326: the resume transition (wasHalted=true, shouldHalt=false) -- symmetric with the halt-trip case
  // above -- previously left no ledger trace at all. It must now record, the same way a halt trip does.
  // evaluateRunLoopHalt's own real implementation latches shouldHalt:true unconditionally whenever
  // runHalted:true is passed in (its "prior_halt" branch) -- a genuine resume only happens once an
  // operator externally clears that latch outside this call, so this test forces the collaborator's verdict
  // for one call to exercise evaluateRunLoopBoundaryGate's OWN transition-detection condition directly,
  // independent of whether evaluateRunLoopHalt's current coupling makes this reachable today.
  it("records a resume transition when a previously-halted run recovers", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-resume-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    // A real, correctly-shaped "cleared" verdict (from the real function, runHalted:false) spliced in for
    // the next call, rather than hand-constructing every nested cap/convergence field.
    const clearedVerdict = engineModule.evaluateRunLoopHalt({
      runHalted: false,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: HEALTHY_CONVERGENCE,
    });
    expect(clearedVerdict.shouldHalt).toBe(false);
    const spy = vi.spyOn(engineModule, "evaluateRunLoopHalt").mockReturnValueOnce(clearedVerdict);

    const resumed = evaluateRunLoopBoundaryGate(
      {
        runHalted: true,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    spy.mockRestore();

    expect(resumed.runHalted).toBe(false);
    expect(resumed.canClaimNext).toBe(true);
    expect(resumed.recorded).not.toBeNull();
    expect(resumed.recorded?.eventType).toBe("allowed");
    expect(resumed.releasedItem).toBeNull();
  });

  it("does not re-append ledger rows while a prior halt remains latched", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-latched-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const append = vi.fn((event) => ledger.appendGovernorEvent(event));

    const first = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append },
    );
    expect(first.recorded).not.toBeNull();

    const second = evaluateRunLoopBoundaryGate(
      {
        runHalted: true,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append },
    );
    expect(second.recorded).toBeNull();
    expect(second.canClaimNext).toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("forwards custom convergenceThresholds to keep a run healthy, using the default ledger append (never invoked, steady state)", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-thresholds-"));
    roots.push(root);
    previousConfigDirs.push(process.env.LOOPOVER_MINER_CONFIG_DIR);
    process.env.LOOPOVER_MINER_CONFIG_DIR = root;

    // Defaults would halt on consecutiveFailures: 3; raised thresholds keep the run healthy.
    const healthy = evaluateRunLoopBoundaryGate({
      runHalted: false,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: { attempts: 4, consecutiveFailures: 3, reenqueues: 0, reachedDone: false },
      convergenceThresholds: { maxConsecutiveFailures: 10, maxReenqueues: 10 },
    });
    expect(healthy.runHalted).toBe(false);
    expect(healthy.canClaimNext).toBe(true);
    // #9326: steady never-halted state -- no transition, so nothing is recorded (would have used the
    // default ledger append if it had recorded, but the whole point of the fix is that it doesn't).
    expect(healthy.recorded).toBeNull();
    expect(healthy.releasedItem).toBeNull();
  });

  it("halts on a fresh boundary without releasing when markFailed is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-run-halt-no-mark-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const halted = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
        inFlightItem: { repoFullName: "acme/repo-a", identifier: "issue:7" },
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(halted.runHalted).toBe(true);
    expect(halted.releasedItem).toBeNull();
    expect(halted.recorded?.eventType).toBe("denied");
  });
});
