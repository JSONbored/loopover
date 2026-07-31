import { describe, expect, it } from "vitest";

import {
  decideNextActionWithReason,
  type IterationState,
} from "../../packages/loopover-engine/src/index";

// Vitest mirror of packages/loopover-engine/test/iterate-policy.test.ts's autonomy cases (#6560). codecov/patch
// is computed from this app vitest run (vitest.config coverage includes packages/loopover-engine/src/**), so the
// changed engine lines need a vitest test that imports the SRC directly — the engine's own node:test suite is
// not collected here.

function baseState(overrides: Partial<IterationState> = {}): IterationState {
  return {
    iterationNumber: 1,
    maxIterations: 5,
    selfReview: { kind: "fail", blockerCodes: ["missing_linked_issue"] },
    previousBlockerCodes: null,
    rejectionSignaled: false,
    ...overrides,
  };
}

/** A state whose only path is step 3 — a clean predicted-gate pass. */
function passingState(overrides: Partial<IterationState> = {}): IterationState {
  return baseState({ selfReview: { kind: "pass" }, ...overrides });
}

describe("decideNextActionWithReason autonomy gating (#6560)", () => {
  it('"auto" hands off with no requiresApproval', () => {
    const decision = decideNextActionWithReason(passingState({ autonomyLevel: "auto" }));
    expect(decision.action).toBe("handoff");
    expect(decision.requiresApproval).toBeUndefined();
    expect(decision.abandonReason).toBeUndefined();
  });

  it('"auto_with_approval" still hands off, but flags requiresApproval', () => {
    const decision = decideNextActionWithReason(passingState({ autonomyLevel: "auto_with_approval" }));
    expect(decision.action).toBe("handoff");
    expect(decision.requiresApproval).toBe(true);
  });

  it('"observe" abandons with autonomy_observe_only, noting the pass WAS reached', () => {
    const decision = decideNextActionWithReason(passingState({ autonomyLevel: "observe" }));
    expect(decision.action).toBe("abandon");
    expect(decision.abandonReason).toBe("autonomy_observe_only");
    // The reason must say a clean pass was reached and the level is what stopped it — not reuse another
    // reason's wording (nothing went wrong here).
    expect(decision.reason).toContain("clean predicted-gate pass");
    expect(decision.reason).toContain("observe-only");
    expect(decision.requiresApproval).toBeUndefined();
  });

  it("REGRESSION: an unset autonomyLevel is byte-identical to an explicit \"auto\" — the field is a true no-op", () => {
    // Mirrors costCeilingReached's own omitted/explicit-default pair: every pre-#6560 IterationState fixture
    // must keep its exact prior decision.
    const omitted = passingState();
    expect(omitted.autonomyLevel).toBeUndefined();
    const explicitUndefined = passingState({ autonomyLevel: undefined });
    const explicitAuto = passingState({ autonomyLevel: "auto" });

    expect(decideNextActionWithReason(omitted)).toEqual(decideNextActionWithReason(explicitAuto));
    expect(decideNextActionWithReason(explicitUndefined)).toEqual(decideNextActionWithReason(explicitAuto));
    expect(decideNextActionWithReason(omitted)).toEqual({
      action: "handoff",
      reason: "Self-review reached a clean predicted-gate pass.",
    });
  });
});

describe("autonomy never overrides the higher-precedence ladder steps (#6560)", () => {
  it.each(["auto", "auto_with_approval", "observe"] as const)(
    "rejectionSignaled still wins over autonomyLevel=%s",
    (autonomyLevel) => {
      // Step 1 is absolute: disengage silently on rejection, even over an otherwise-passing self-review.
      const decision = decideNextActionWithReason(passingState({ autonomyLevel, rejectionSignaled: true }));
      expect(decision.action).toBe("abandon");
      expect(decision.abandonReason).toBe("rejection_signaled");
      expect(decision.requiresApproval).toBeUndefined();
    },
  );

  it.each(["auto", "auto_with_approval", "observe"] as const)(
    "an ambiguous self-review still wins over autonomyLevel=%s",
    (autonomyLevel) => {
      const decision = decideNextActionWithReason(
        baseState({ autonomyLevel, selfReview: { kind: "ambiguous", reason: "unclear" } }),
      );
      expect(decision.action).toBe("abandon");
      expect(decision.abandonReason).toBe("self_review_ambiguous");
    },
  );

  it.each(["auto", "auto_with_approval", "observe"] as const)(
    "autonomyLevel=%s does not touch the iteration ceiling / no-progress steps below it",
    (autonomyLevel) => {
      // A failing self-review never reaches step 3, so autonomy must be irrelevant to steps 4-6.
      const ceiling = decideNextActionWithReason(
        baseState({ autonomyLevel, iterationNumber: 5, maxIterations: 5 }),
      );
      expect(ceiling.action).toBe("abandon");
      expect(ceiling.abandonReason).toBe("max_iterations_reached");

      const noProgress = decideNextActionWithReason(
        baseState({
          autonomyLevel,
          iterationNumber: 2,
          maxIterations: 10,
          selfReview: { kind: "fail", blockerCodes: ["same_code"] },
          previousBlockerCodes: ["same_code"],
        }),
      );
      expect(noProgress.action).toBe("abandon");
      expect(noProgress.abandonReason).toBe("no_progress");
    },
  );

  it("#9997: a clean pass at or past a ceiling still hands off — the pass branch precedes both ceilings", () => {
    // The field docs used to claim the ceilings abandon "regardless of self-review outcome"; the precedence
    // list (step 3 before steps 4-5) is the real contract, so a clean pass wins over a reached ceiling.
    for (const state of [
      passingState({ iterationNumber: 5, maxIterations: 5 }),
      passingState({ costCeilingReached: true }),
      passingState({ iterationNumber: 5, maxIterations: 5, costCeilingReached: true }),
    ]) {
      const decision = decideNextActionWithReason(state);
      expect(decision.action).toBe("handoff");
      expect(decision.abandonReason).toBeUndefined();
    }
  });
});
