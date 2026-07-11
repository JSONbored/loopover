import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { evaluateRunLoopBoundaryGate } from "../../packages/gittensory-miner/lib/governor-run-halt.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";
import { initPortfolioQueueManager } from "../../packages/gittensory-miner/lib/portfolio-queue-manager.js";
import { initPortfolioQueueStore } from "../../packages/gittensory-miner/lib/portfolio-queue.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];
const stores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LIMITS = { budget: 100, turns: 5, elapsedMs: 60_000 };
const HEALTHY_USAGE = { budgetSpent: 10, turnsTaken: 1, elapsedMs: 1_000 };
const HEALTHY_CONVERGENCE = { attempts: 1, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };

describe("evaluateRunLoopBoundaryGate (#2347)", () => {
  it("releases an in-flight portfolio item and records a halt when a flapping run is detected", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-run-halt-"));
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
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-run-halt-budget-"));
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

  it("never halts or records a halt for a healthy run under both signals", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-run-halt-healthy-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const healthy = evaluateRunLoopBoundaryGate(
      {
        runHalted: false,
        usage: HEALTHY_USAGE,
        limits: LIMITS,
        convergence: HEALTHY_CONVERGENCE,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(healthy.runHalted).toBe(false);
    expect(healthy.canClaimNext).toBe(true);
    expect(healthy.recorded?.eventType).toBe("allowed");
    expect(healthy.releasedItem).toBeNull();
  });

  it("does not re-append ledger rows while a prior halt remains latched", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-run-halt-latched-"));
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
});
