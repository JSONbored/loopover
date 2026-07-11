import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS,
  evaluateHarnessSubmissionTrigger,
  type HandoffPacket,
  type HarnessSubmissionTriggerCandidate,
  type PredictedGateVerdict,
  type SelfReviewSlopAssessment,
  type SelfReviewVerdict,
} from "../dist/index.js";

function passingVerdictFields(): PredictedGateVerdict {
  return {
    predicted: true,
    basis: "public_config",
    pack: "oss-anti-slop",
    conclusion: "success",
    title: "t",
    summary: "s",
    readinessScore: 92,
    confirmedContributor: undefined,
    blockers: [],
    warnings: [],
    funnel: null,
    note: "",
  };
}

function failingVerdictFields(): PredictedGateVerdict {
  return { ...passingVerdictFields(), conclusion: "failure", blockers: [{ code: "duplicate_pr_risk", title: "t", detail: "d" }] };
}

function slop(band: SelfReviewSlopAssessment["band"]): SelfReviewSlopAssessment {
  return { slopRisk: 0, band, findings: [] };
}

function selfReviewVerdict(overrides: Partial<SelfReviewVerdict> = {}): SelfReviewVerdict {
  return {
    predictedGateVerdict: passingVerdictFields(),
    slopAssessment: slop("clean"),
    changedPaths: ["src/upload.ts"],
    passesPredictedGate: true,
    ...overrides,
  };
}

function handoffPacket(verdictOverrides: Partial<SelfReviewVerdict> = {}): HandoffPacket {
  return {
    worktreePath: "/tmp/attempt-1",
    diffSummary: "added retry logic",
    selfReviewVerdict: selfReviewVerdict(verdictOverrides),
    attemptLogReference: "attempt-1",
  };
}

function baseCandidate(overrides: Partial<HarnessSubmissionTriggerCandidate> = {}): HarnessSubmissionTriggerCandidate {
  return {
    handoffPacket: handoffPacket(),
    slopThreshold: "low",
    mode: "enforce",
    consecutiveGateBlocks: 0,
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports the harness submission trigger (#2337)", () => {
  assert.equal(typeof evaluateHarnessSubmissionTrigger, "function");
  assert.equal(typeof DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS, "number");
});

test("a passing handoff with the circuit breaker well clear allows, forwarding shouldSubmit's own empty reasons", () => {
  const decision = evaluateHarnessSubmissionTrigger(baseCandidate());
  assert.deepEqual(decision, { allow: true, reasons: [], circuitBreakerTripped: false });
});

test("circuit breaker: N consecutive blocks trips it, refusing even an otherwise-clean handoff -- never consulting shouldSubmit", () => {
  const decision = evaluateHarnessSubmissionTrigger(baseCandidate({ consecutiveGateBlocks: 3, maxConsecutiveGateBlocks: 3 }));
  assert.equal(decision.allow, false);
  assert.equal(decision.circuitBreakerTripped, true);
  assert.deepEqual(decision.reasons, ["circuit_breaker_tripped_after_consecutive_blocks:3>=3"]);
});

test("circuit breaker: below the ceiling still proceeds to consult shouldSubmit", () => {
  const decision = evaluateHarnessSubmissionTrigger(baseCandidate({ consecutiveGateBlocks: 2, maxConsecutiveGateBlocks: 3 }));
  assert.equal(decision.allow, true);
  assert.equal(decision.circuitBreakerTripped, false);
});

test("default circuit-breaker ceiling applies when the candidate omits its own override", () => {
  const justUnder = evaluateHarnessSubmissionTrigger(baseCandidate({ consecutiveGateBlocks: DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS - 1 }));
  assert.equal(justUnder.allow, true);

  const atDefault = evaluateHarnessSubmissionTrigger(baseCandidate({ consecutiveGateBlocks: DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS }));
  assert.equal(atDefault.allow, false);
  assert.equal(atDefault.circuitBreakerTripped, true);
});

test("a handoff whose verdict fails predicted-gate is blocked by shouldSubmit, not the circuit breaker -- defense in depth against a malformed handoff", () => {
  const decision = evaluateHarnessSubmissionTrigger(
    baseCandidate({ handoffPacket: handoffPacket({ predictedGateVerdict: failingVerdictFields(), passesPredictedGate: false }) }),
  );
  assert.equal(decision.allow, false);
  assert.equal(decision.circuitBreakerTripped, false);
  assert.ok(decision.reasons.some((r) => r.startsWith("predicted_gate_not_passing")));
});

test("a handoff whose slop assessment exceeds the configured threshold is blocked by shouldSubmit", () => {
  const decision = evaluateHarnessSubmissionTrigger(
    baseCandidate({ handoffPacket: handoffPacket({ slopAssessment: slop("high") }), slopThreshold: "low" }),
  );
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["slop_band_exceeds_threshold:high>low"]);
});

test("observe mode forces allow: false even for an otherwise-clean handoff, below the circuit breaker", () => {
  const decision = evaluateHarnessSubmissionTrigger(baseCandidate({ mode: "observe" }));
  assert.equal(decision.allow, false);
  assert.equal(decision.circuitBreakerTripped, false);
  assert.deepEqual(decision.reasons, ["observe_mode_active:would_have_allowed"]);
});
