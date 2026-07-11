import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideNextAction,
  decideNextActionWithReason,
  deriveSelfReviewOutcome,
  type IterationState,
  type SelfReviewVerdict,
} from "../dist/index.js";

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

test("barrel: the public entrypoint re-exports the iterate-loop policy (#2335)", () => {
  assert.equal(typeof decideNextAction, "function");
  assert.equal(typeof decideNextActionWithReason, "function");
  assert.equal(typeof deriveSelfReviewOutcome, "function");
});

test("continue: a still-failing self-review whose blocker set changed since the prior iteration", () => {
  const state = baseState({
    selfReview: { kind: "fail", blockerCodes: ["missing_test_evidence"] },
    previousBlockerCodes: ["missing_linked_issue"],
  });
  assert.equal(decideNextAction(state), "continue");
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "continue");
  assert.ok(decision.reason.length > 0, "even a continue decision must carry a populated reason string");
  assert.equal(decision.abandonReason, undefined);
});

test("continue: a failing first iteration with no prior blocker set to compare against", () => {
  const state = baseState({ previousBlockerCodes: null });
  assert.equal(decideNextAction(state), "continue");
});

test("handoff: the ONLY path is a clean self-review pass", () => {
  const state = baseState({ selfReview: { kind: "pass" } });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "handoff");
  assert.ok(decision.reason.length > 0);
});

test("abandon (rejection_signaled): wins over EVERYTHING else, including an otherwise-passing self-review", () => {
  const state = baseState({ selfReview: { kind: "pass" }, rejectionSignaled: true });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "abandon");
  assert.equal(decision.abandonReason, "rejection_signaled");
});

test("abandon (self_review_ambiguous): never optimistically continues or hands off on ambiguity", () => {
  const state = baseState({ selfReview: { kind: "ambiguous", reason: "predicted-gate calculator threw" } });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "abandon");
  assert.equal(decision.abandonReason, "self_review_ambiguous");
  assert.match(decision.reason, /predicted-gate calculator threw/);
});

test("abandon (self_review_ambiguous): the reason is optional and the decision still abandons without it", () => {
  const decision = decideNextActionWithReason(baseState({ selfReview: { kind: "ambiguous" } }));
  assert.equal(decision.action, "abandon");
  assert.equal(decision.abandonReason, "self_review_ambiguous");
});

test("abandon (max_iterations_reached): the hard ceiling stops the loop even if the blocker set is still changing", () => {
  const state = baseState({
    iterationNumber: 5,
    maxIterations: 5,
    selfReview: { kind: "fail", blockerCodes: ["a_brand_new_blocker_never_seen_before"] },
    previousBlockerCodes: ["missing_linked_issue"],
  });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "abandon");
  assert.equal(decision.abandonReason, "max_iterations_reached");
});

test("abandon (max_iterations_reached): fires at or beyond the ceiling, not only exactly at it", () => {
  assert.equal(decideNextAction(baseState({ iterationNumber: 6, maxIterations: 5 })), "abandon");
});

test("continue: one iteration below the ceiling still continues", () => {
  const state = baseState({ iterationNumber: 4, maxIterations: 5, previousBlockerCodes: ["something_else"] });
  assert.equal(decideNextAction(state), "continue");
});

test("abandon (cost_ceiling_reached): the loop's own cumulative cost ceiling stops the loop even mid-progress", () => {
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    costCeilingReached: true,
    selfReview: { kind: "fail", blockerCodes: ["a_brand_new_blocker_never_seen_before"] },
    previousBlockerCodes: ["missing_linked_issue"],
  });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "abandon");
  assert.equal(decision.abandonReason, "cost_ceiling_reached");
});

test("abandon (cost_ceiling_reached): checked before no_progress, but after the iteration ceiling -- max_iterations still wins when both fire", () => {
  const state = baseState({ iterationNumber: 5, maxIterations: 5, costCeilingReached: true });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.abandonReason, "max_iterations_reached");
});

test("continue: costCeilingReached omitted (undefined) does not itself trigger an abandon -- the field is optional", () => {
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    selfReview: { kind: "fail", blockerCodes: ["a_new_code"] },
    previousBlockerCodes: ["a_different_code"],
  });
  assert.equal(state.costCeilingReached, undefined);
  assert.equal(decideNextAction(state), "continue");
});

test("continue: costCeilingReached explicitly false behaves identically to omitted", () => {
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    costCeilingReached: false,
    selfReview: { kind: "fail", blockerCodes: ["a_new_code"] },
    previousBlockerCodes: ["a_different_code"],
  });
  assert.equal(decideNextAction(state), "continue");
});

test("abandon (no_progress): an identical blocker set to the prior iteration stops wasting turns", () => {
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    selfReview: { kind: "fail", blockerCodes: ["missing_linked_issue", "missing_test_evidence"] },
    previousBlockerCodes: ["missing_linked_issue", "missing_test_evidence"],
  });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "abandon");
  assert.equal(decision.abandonReason, "no_progress");
});

test("abandon (no_progress): the comparison is a SET, not an ordered array -- reordered-but-identical blockers still count as no progress", () => {
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    selfReview: { kind: "fail", blockerCodes: ["b_code", "a_code"] },
    previousBlockerCodes: ["a_code", "b_code"],
  });
  assert.equal(decideNextAction(state), "abandon");
});

test("continue: a duplicate blocker code does not falsely widen the set and mask real progress", () => {
  // ["a","a"] and ["a","b"] must NOT compare equal as sets even though naive array-length comparison alone
  // could be fooled by the duplicate.
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    selfReview: { kind: "fail", blockerCodes: ["a_code", "a_code"] },
    previousBlockerCodes: ["a_code", "b_code"],
  });
  assert.equal(decideNextAction(state), "continue");
});

test("continue: a different-length blocker set is never confused with no-progress (the fast-path length check)", () => {
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    selfReview: { kind: "fail", blockerCodes: ["a_code", "b_code", "c_code"] },
    previousBlockerCodes: ["a_code"],
  });
  assert.equal(decideNextAction(state), "continue");
});

test("abandon (no_progress): an empty blocker set unchanged from the prior (also empty) iteration still reads as no progress", () => {
  const state = baseState({
    iterationNumber: 2,
    maxIterations: 10,
    selfReview: { kind: "fail", blockerCodes: [] },
    previousBlockerCodes: [],
  });
  const decision = decideNextActionWithReason(state);
  assert.equal(decision.action, "abandon");
  assert.equal(decision.abandonReason, "no_progress");
  assert.match(decision.reason, /no blockers listed/);
});

test("deriveSelfReviewOutcome: a passing verdict maps to pass with no blocker codes", () => {
  const verdict = { passesPredictedGate: true, predictedGateVerdict: { blockers: [] } } as unknown as SelfReviewVerdict;
  assert.deepEqual(deriveSelfReviewOutcome(verdict), { kind: "pass" });
});

test("deriveSelfReviewOutcome: a failing verdict maps to fail with the real blocker codes extracted", () => {
  const verdict = {
    passesPredictedGate: false,
    predictedGateVerdict: {
      blockers: [
        { code: "duplicate_pr_risk", title: "t1", detail: "d1" },
        { code: "missing_linked_issue", title: "t2", detail: "d2" },
      ],
    },
  } as unknown as SelfReviewVerdict;
  assert.deepEqual(deriveSelfReviewOutcome(verdict), { kind: "fail", blockerCodes: ["duplicate_pr_risk", "missing_linked_issue"] });
});
