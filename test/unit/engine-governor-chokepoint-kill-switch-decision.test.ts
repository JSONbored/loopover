import { describe, expect, it } from "vitest";

import {
  evaluateGovernorChokepoint,
  type GovernorChokepointInput,
} from "../../packages/loopover-engine/src/governor/chokepoint";

function baseInput(overrides: Partial<GovernorChokepointInput> = {}): GovernorChokepointInput {
  return {
    actionClass: "open_pr",
    repoFullName: "acme/widgets",
    nowMs: 10_000,
    wouldBeAction: { action: "open_pr", title: "Fix bug" },
    killSwitchGlobal: false,
    killSwitchRepoPaused: false,
    liveModeGlobalOptIn: true,
    liveModeRepoOptIn: "live",
    rateLimitBuckets: { global: {}, perRepo: {} },
    rateLimitBackoffAttempts: {},
    capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 },
    capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
    convergenceInput: { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false },
    ...overrides,
  };
}

describe("denyResult ledger decision keys off eventType (#8864)", () => {
  it("budget-cap termination ceiling ledgers decision paused (kill_switch eventType, budget_cap stage)", () => {
    const decision = evaluateGovernorChokepoint(
      baseInput({
        capUsage: { budgetSpent: 0, turnsTaken: 0, elapsedMs: 2_000_000 },
        capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
      }),
    );
    expect(decision.stage).toBe("budget_cap");
    expect(decision.ledgerEvent.eventType).toBe("kill_switch");
    expect(decision.ledgerEvent.decision).toBe("paused");
  });

  it("top-level kill_switch stage still ledgers paused", () => {
    const decision = evaluateGovernorChokepoint(baseInput({ killSwitchGlobal: true }));
    expect(decision.stage).toBe("kill_switch");
    expect(decision.ledgerEvent.eventType).toBe("kill_switch");
    expect(decision.ledgerEvent.decision).toBe("paused");
  });

  it("budget-cap soft deny (non-termination) still ledgers deny", () => {
    const decision = evaluateGovernorChokepoint(
      baseInput({
        capUsage: { budgetSpent: 100, turnsTaken: 0, elapsedMs: 0 },
        capLimits: { budget: 100, turns: 100, elapsedMs: 1_000_000 },
      }),
    );
    expect(decision.stage).toBe("budget_cap");
    expect(decision.ledgerEvent.eventType).toBe("denied");
    expect(decision.ledgerEvent.decision).toBe("deny");
  });
});
