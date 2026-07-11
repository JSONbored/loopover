import { describe, expect, it } from "vitest";
import {
  isSlopBandWithinThreshold,
  shouldSubmit,
  SUBMISSION_GATE_PASSING_CONCLUSION,
  type PredictedGateVerdict,
  type SelfReviewSlopAssessment,
  type SelfReviewSlopBand,
  type SubmissionGateCandidate,
} from "../../packages/gittensory-engine/src/index";

function passingVerdict(): PredictedGateVerdict {
  return {
    predicted: true,
    basis: "public_config",
    pack: "oss-anti-slop",
    conclusion: "success",
    title: "Predicted gate: pass",
    summary: "Every check is expected to pass.",
    readinessScore: 92,
    confirmedContributor: undefined,
    blockers: [],
    warnings: [],
    funnel: null,
    note: "",
  };
}

function failingVerdict(blockers: PredictedGateVerdict["blockers"] = [{ code: "duplicate_pr_risk", title: "Likely duplicate", detail: "Matches an existing open PR." }]): PredictedGateVerdict {
  return {
    predicted: true,
    basis: "public_config",
    pack: "oss-anti-slop",
    conclusion: "failure",
    title: "Predicted gate: fail",
    summary: "At least one check is expected to fail.",
    readinessScore: 15,
    confirmedContributor: undefined,
    blockers,
    warnings: [],
    funnel: null,
    note: "",
  };
}

function slop(band: SelfReviewSlopBand, slopRisk = 0): SelfReviewSlopAssessment {
  return { slopRisk, band, findings: [] };
}

function baseCandidate(overrides: Partial<SubmissionGateCandidate> = {}): SubmissionGateCandidate {
  return {
    killSwitchScope: "none",
    predictedGateVerdict: passingVerdict(),
    slopAssessment: slop("clean"),
    slopThreshold: "low",
    mode: "enforce",
    ...overrides,
  };
}

describe("shouldSubmit (#2336)", () => {
  it("barrel: the public entrypoint re-exports the submission gate", () => {
    expect(typeof shouldSubmit).toBe("function");
    expect(typeof isSlopBandWithinThreshold).toBe("function");
    expect(SUBMISSION_GATE_PASSING_CONCLUSION).toBe("success");
  });

  it("pass/pass: a clean predicted-gate pass with slop under threshold allows, with no reasons", () => {
    const decision = shouldSubmit(baseCandidate());
    expect(decision).toEqual({ allow: true, reasons: [] });
  });

  it("kill-switch (#2339): a global kill-switch blocks unconditionally, even with every other signal otherwise passing", () => {
    const decision = shouldSubmit(baseCandidate({ killSwitchScope: "global" }));
    expect(decision).toEqual({ allow: false, reasons: ["global_kill_switch_active"] });
  });

  it("kill-switch (#2339): a per-repo kill-switch blocks unconditionally, checked before any signal or mode logic", () => {
    const decision = shouldSubmit(baseCandidate({ killSwitchScope: "repo", mode: "observe" }));
    expect(decision).toEqual({ allow: false, reasons: ["repo_kill_switch_active"] });
  });

  it("kill-switch (#2339): an inactive kill-switch (scope 'none') never itself blocks -- signals are still evaluated normally", () => {
    const decision = shouldSubmit(baseCandidate({ killSwitchScope: "none" }));
    expect(decision.allow).toBe(true);
  });

  it("fail/pass: a non-passing predicted-gate verdict blocks even with slop cleanly under threshold", () => {
    const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: failingVerdict() }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toMatch(/^predicted_gate_not_passing:failure:duplicate_pr_risk$/);
  });

  it("fail/pass: a non-passing verdict with NO blockers listed still formats a reason, without a dangling separator", () => {
    const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: failingVerdict([]) }));
    expect(decision.reasons[0]).toBe("predicted_gate_not_passing:failure");
  });

  it("pass/fail: a clean predicted-gate pass blocks when slop exceeds the configured threshold", () => {
    const decision = shouldSubmit(baseCandidate({ slopAssessment: slop("high"), slopThreshold: "low" }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(["slop_band_exceeds_threshold:high>low"]);
  });

  it("both-fail: a non-passing verdict AND over-threshold slop blocks with both reasons listed", () => {
    const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: failingVerdict(), slopAssessment: slop("high"), slopThreshold: "low" }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toHaveLength(2);
    expect(decision.reasons.some((r) => r.startsWith("predicted_gate_not_passing"))).toBe(true);
    expect(decision.reasons.some((r) => r.startsWith("slop_band_exceeds_threshold"))).toBe(true);
  });

  it("fail-closed: a null predictedGateVerdict (predictor unreachable) blocks, never treated as no-opinion-so-allow", () => {
    const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: null }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(["predicted_gate_unavailable"]);
  });

  it("fail-closed: a null slopAssessment (slop check errored) blocks, never treated as no-opinion-so-allow", () => {
    const decision = shouldSubmit(baseCandidate({ slopAssessment: null }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(["slop_assessment_unavailable"]);
  });

  it("fail-closed: both signals missing blocks with both unavailable reasons listed", () => {
    const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: null, slopAssessment: null }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(["predicted_gate_unavailable", "slop_assessment_unavailable"]);
  });

  it("observe mode: forces allow: false even for signals that would otherwise cleanly pass", () => {
    const decision = shouldSubmit(baseCandidate({ mode: "observe" }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(["observe_mode_active:would_have_allowed"]);
  });

  it("observe mode: a would-have-blocked decision is distinguishable from a would-have-allowed one, with the real reasons preserved", () => {
    const decision = shouldSubmit(baseCandidate({ mode: "observe", predictedGateVerdict: null }));
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toEqual(["observe_mode_active:would_have_blocked", "predicted_gate_unavailable"]);
  });
});

describe("isSlopBandWithinThreshold (#2336)", () => {
  it("a band exactly equal to the threshold passes (inclusive boundary)", () => {
    expect(isSlopBandWithinThreshold("elevated", "elevated")).toBe(true);
  });

  it("a band one severity level under the threshold passes", () => {
    expect(isSlopBandWithinThreshold("low", "elevated")).toBe(true);
  });

  it("a band one severity level over the threshold fails", () => {
    expect(isSlopBandWithinThreshold("high", "elevated")).toBe(false);
  });

  it("the full clean..high ordering is respected end to end", () => {
    const order: SelfReviewSlopBand[] = ["clean", "low", "elevated", "high"];
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < order.length; j += 1) {
        const band = order[i] as SelfReviewSlopBand;
        const threshold = order[j] as SelfReviewSlopBand;
        expect(isSlopBandWithinThreshold(band, threshold)).toBe(i <= j);
      }
    }
  });
});
