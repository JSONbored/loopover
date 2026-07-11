import { describe, expect, it } from "vitest";
import {
  buildRunLoopHaltGovernorLedgerEvent,
  clearRunLoopHalt,
  detectNonConvergence,
  evaluateBudgetCaps,
  evaluateRunLoopHalt,
} from "../../packages/gittensory-engine/src/governor/run-halt";
import type { GovernorCapLimits, GovernorCapUsage } from "../../packages/gittensory-engine/src/governor/budget-cap";
import type { PortfolioConvergenceInput } from "../../packages/gittensory-engine/src/portfolio/non-convergence";

const LIMITS: GovernorCapLimits = { budget: 100, turns: 5, elapsedMs: 60_000 };
const HEALTHY_USAGE: GovernorCapUsage = { budgetSpent: 10, turnsTaken: 1, elapsedMs: 1_000 };
const HEALTHY_CONVERGENCE: PortfolioConvergenceInput = {
  attempts: 2,
  consecutiveFailures: 0,
  reenqueues: 0,
  reachedDone: false,
};

describe("evaluateRunLoopHalt (#2347)", () => {
  it("allows a healthy run to continue claiming on the iteration boundary", () => {
    const verdict = evaluateRunLoopHalt({
      runHalted: false,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: HEALTHY_CONVERGENCE,
    });
    expect(verdict.shouldHalt).toBe(false);
    expect(verdict.canClaimNext).toBe(true);
    expect(verdict.reason).toBe("cleared");
    expect(verdict.ledgerEventType).toBe("allowed");
  });

  it("halts a flapping run when non-convergence is detected and blocks further claims", () => {
    const verdict = evaluateRunLoopHalt({
      runHalted: false,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: {
        attempts: 4,
        consecutiveFailures: 3,
        reenqueues: 0,
        reachedDone: false,
      },
    });
    expect(verdict.shouldHalt).toBe(true);
    expect(verdict.canClaimNext).toBe(false);
    expect(verdict.reason).toBe("non_convergence");
    expect(verdict.convergence.tripped).toBe(true);
  });

  it("halts immediately when a budget cap is breached on the next iteration boundary", () => {
    const verdict = evaluateRunLoopHalt({
      runHalted: false,
      usage: { budgetSpent: 100, turnsTaken: 1, elapsedMs: 1_000 },
      limits: LIMITS,
      convergence: HEALTHY_CONVERGENCE,
    });
    expect(verdict.shouldHalt).toBe(true);
    expect(verdict.reason).toBe("budget_exceeded");
    expect(verdict.ledgerEventType).toBe("denied");
  });

  it("halts on turn-cap and termination-cap breaches with the matching ledger severity", () => {
    const turnCap = evaluateRunLoopHalt({
      runHalted: false,
      usage: { budgetSpent: 1, turnsTaken: 5, elapsedMs: 1_000 },
      limits: LIMITS,
      convergence: HEALTHY_CONVERGENCE,
    });
    expect(turnCap.reason).toBe("turn_cap_exceeded");

    const termination = evaluateRunLoopHalt({
      runHalted: false,
      usage: { budgetSpent: 1, turnsTaken: 1, elapsedMs: 60_000 },
      limits: LIMITS,
      convergence: HEALTHY_CONVERGENCE,
    });
    expect(termination.reason).toBe("termination_cap_exceeded");
    expect(termination.ledgerEventType).toBe("kill_switch");
  });

  it("keeps a prior halt latched until an operator clears it", () => {
    const latched = evaluateRunLoopHalt({
      runHalted: true,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: HEALTHY_CONVERGENCE,
    });
    expect(latched.reason).toBe("prior_halt");
    expect(latched.canClaimNext).toBe(false);
    expect(clearRunLoopHalt()).toEqual({ runHalted: false });
  });

  it("prefers termination over budget and non-convergence when multiple signals trip together", () => {
    const verdict = evaluateRunLoopHalt({
      runHalted: false,
      usage: { budgetSpent: 999, turnsTaken: 999, elapsedMs: 60_000 },
      limits: LIMITS,
      convergence: { attempts: 5, consecutiveFailures: 9, reenqueues: 9, reachedDone: false },
    });
    expect(verdict.reason).toBe("termination_cap_exceeded");
  });

  it("buildRunLoopHaltGovernorLedgerEvent records halt context for retries and operator review", () => {
    const verdict = evaluateRunLoopHalt({
      runHalted: false,
      usage: HEALTHY_USAGE,
      limits: LIMITS,
      convergence: { attempts: 4, consecutiveFailures: 3, reenqueues: 0, reachedDone: false },
    });
    const event = buildRunLoopHaltGovernorLedgerEvent("acme/repo-a", "issue:42", verdict);
    expect(event).toMatchObject({
      eventType: "denied",
      actionClass: "run_loop",
      decision: "halt",
      reason: "non_convergence_detected",
      payload: {
        haltReason: "non_convergence",
        inFlightIdentifier: "issue:42",
      },
    });
    expect(event.payload?.convergenceReasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/consecutive failures/i)]),
    );
  });

  it("exposes issue vocabulary aliases over the pure calculators", () => {
    expect(evaluateBudgetCaps(HEALTHY_USAGE, LIMITS).verdict).toBe("allowed");
    expect(
      detectNonConvergence({ attempts: 4, consecutiveFailures: 3, reenqueues: 0, reachedDone: false }).tripped,
    ).toBe(true);
  });
});
