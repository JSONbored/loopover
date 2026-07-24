// Root-level vitest coverage twin for `packages/loopover-engine/src/miner/harness-submission-trigger.ts` (#8346).
//
// `evaluateHarnessSubmissionTrigger` (#2337) is the final gate before a real call site may build an `open_pr`
// local-write spec from a passing `HandoffPacket`: it checks a session-level circuit breaker FIRST, then
// delegates to the separately-tested `shouldSubmit`. It is live and fully exercised by the engine package's own
// `node --test` suite (`packages/loopover-engine/test/harness-submission-trigger.test.ts`), but that runner is
// not part of the root vitest run Codecov reads `codecov/patch` from, so it reports as ~0% covered despite
// being genuinely tested (same blind spot as #6250). This twin imports the primitive via the engine barrel and
// mirrors every scenario the package suite covers — matching the sibling pattern in
// `test/unit/calibration-dashboard.test.ts`. Fixtures are built the same way the package suite does; no source
// file is modified.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS,
  evaluateHarnessSubmissionTrigger,
} from "../../packages/loopover-engine/src/index";
import type {
  HandoffPacket,
  HarnessSubmissionTriggerCandidate,
  PredictedGateVerdict,
  SelfReviewSlopAssessment,
  SelfReviewVerdict,
} from "../../packages/loopover-engine/src/index";

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
  return {
    ...passingVerdictFields(),
    conclusion: "failure",
    blockers: [{ code: "duplicate_pr_risk", title: "t", detail: "d" }],
  };
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
    killSwitchScope: "none",
    handoffPacket: handoffPacket(),
    slopThreshold: "low",
    mode: "enforce",
    consecutiveGateBlocks: 0,
    ...overrides,
  };
}

describe("barrel: the harness submission trigger is re-exported from the engine entrypoint (#2337)", () => {
  it("exposes the trigger function and the default ceiling constant", () => {
    expect(typeof evaluateHarnessSubmissionTrigger).toBe("function");
    expect(typeof DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS).toBe("number");
  });
});

describe("evaluateHarnessSubmissionTrigger — circuit breaker", () => {
  it("N consecutive blocks trips it, refusing even an otherwise-clean handoff, without consulting shouldSubmit (boundary: exactly max)", () => {
    const decision = evaluateHarnessSubmissionTrigger(baseCandidate({ consecutiveGateBlocks: 3, maxConsecutiveGateBlocks: 3 }));
    expect(decision.allow).toBe(false);
    expect(decision.circuitBreakerTripped).toBe(true);
    expect(decision.reasons).toEqual(["circuit_breaker_tripped_after_consecutive_blocks:3>=3"]);
  });

  it("below the ceiling still proceeds to consult shouldSubmit (>= not-taken arm)", () => {
    const decision = evaluateHarnessSubmissionTrigger(baseCandidate({ consecutiveGateBlocks: 2, maxConsecutiveGateBlocks: 3 }));
    expect(decision.allow).toBe(true);
    expect(decision.circuitBreakerTripped).toBe(false);
  });

  it("the default ceiling applies via the `?? DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS` fallback when the override is omitted (both arms)", () => {
    const justUnder = evaluateHarnessSubmissionTrigger(
      baseCandidate({ consecutiveGateBlocks: DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS - 1 }),
    );
    expect(justUnder.allow).toBe(true);

    const atDefault = evaluateHarnessSubmissionTrigger(
      baseCandidate({ consecutiveGateBlocks: DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS }),
    );
    expect(atDefault.allow).toBe(false);
    expect(atDefault.circuitBreakerTripped).toBe(true);
  });
});

describe("evaluateHarnessSubmissionTrigger — delegation to shouldSubmit (below the breaker)", () => {
  it("a passing handoff with the breaker well clear allows, forwarding shouldSubmit's empty reasons", () => {
    const decision = evaluateHarnessSubmissionTrigger(baseCandidate());
    expect(decision).toEqual({ allow: true, reasons: [], circuitBreakerTripped: false });
  });

  it("the kill-switch is forwarded to shouldSubmit's own check, blocking an otherwise-clean handoff", () => {
    const decision = evaluateHarnessSubmissionTrigger(baseCandidate({ killSwitchScope: "global" }));
    expect(decision.allow).toBe(false);
    expect(decision.circuitBreakerTripped).toBe(false);
    expect(decision.reasons).toEqual(["global_kill_switch_active"]);
  });

  it("a handoff whose verdict fails predicted-gate is blocked by shouldSubmit, not the circuit breaker", () => {
    const decision = evaluateHarnessSubmissionTrigger(
      baseCandidate({ handoffPacket: handoffPacket({ predictedGateVerdict: failingVerdictFields(), passesPredictedGate: false }) }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.circuitBreakerTripped).toBe(false);
    expect(decision.reasons.some((r) => r.startsWith("predicted_gate_not_passing"))).toBe(true);
  });

  it("a handoff whose slop assessment exceeds the configured threshold is blocked by shouldSubmit", () => {
    const decision = evaluateHarnessSubmissionTrigger(
      baseCandidate({ handoffPacket: handoffPacket({ slopAssessment: slop("high") }), slopThreshold: "low" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(["slop_band_exceeds_threshold:high>low"]);
  });

  it("observe mode forces allow: false even for an otherwise-clean handoff, below the circuit breaker", () => {
    const decision = evaluateHarnessSubmissionTrigger(baseCandidate({ mode: "observe" }));
    expect(decision.allow).toBe(false);
    expect(decision.circuitBreakerTripped).toBe(false);
    expect(decision.reasons).toEqual(["observe_mode_active:would_have_allowed"]);
  });
});
