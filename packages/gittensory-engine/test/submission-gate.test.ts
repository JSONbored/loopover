import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSlopBandWithinThreshold,
  shouldSubmit,
  SUBMISSION_GATE_PASSING_CONCLUSION,
  type PredictedGateVerdict,
  type SelfReviewSlopAssessment,
  type SelfReviewSlopBand,
  type SubmissionGateCandidate,
} from "../dist/index.js";

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
    predictedGateVerdict: passingVerdict(),
    slopAssessment: slop("clean"),
    slopThreshold: "low",
    mode: "enforce",
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports the submission gate (#2336)", () => {
  assert.equal(typeof shouldSubmit, "function");
  assert.equal(typeof isSlopBandWithinThreshold, "function");
  assert.equal(SUBMISSION_GATE_PASSING_CONCLUSION, "success");
});

test("pass/pass: a clean predicted-gate pass with slop under threshold allows, with no reasons", () => {
  const decision = shouldSubmit(baseCandidate());
  assert.deepEqual(decision, { allow: true, reasons: [] });
});

test("fail/pass: a non-passing predicted-gate verdict blocks even with slop cleanly under threshold", () => {
  const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: failingVerdict() }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reasons.length, 1);
  assert.match(decision.reasons[0] ?? "", /^predicted_gate_not_passing:failure:duplicate_pr_risk$/);
});

test("fail/pass: a non-passing verdict with NO blockers listed still formats a reason, without a dangling separator", () => {
  const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: failingVerdict([]) }));
  assert.equal(decision.reasons[0], "predicted_gate_not_passing:failure");
});

test("pass/fail: a clean predicted-gate pass blocks when slop exceeds the configured threshold", () => {
  const decision = shouldSubmit(baseCandidate({ slopAssessment: slop("high"), slopThreshold: "low" }));
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["slop_band_exceeds_threshold:high>low"]);
});

test("both-fail: a non-passing verdict AND over-threshold slop blocks with both reasons listed", () => {
  const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: failingVerdict(), slopAssessment: slop("high"), slopThreshold: "low" }));
  assert.equal(decision.allow, false);
  assert.equal(decision.reasons.length, 2);
  assert.ok(decision.reasons.some((r) => r.startsWith("predicted_gate_not_passing")));
  assert.ok(decision.reasons.some((r) => r.startsWith("slop_band_exceeds_threshold")));
});

test("fail-closed: a null predictedGateVerdict (predictor unreachable) blocks, never treated as no-opinion-so-allow", () => {
  const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: null }));
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["predicted_gate_unavailable"]);
});

test("fail-closed: a null slopAssessment (slop check errored) blocks, never treated as no-opinion-so-allow", () => {
  const decision = shouldSubmit(baseCandidate({ slopAssessment: null }));
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["slop_assessment_unavailable"]);
});

test("fail-closed: both signals missing blocks with both unavailable reasons listed", () => {
  const decision = shouldSubmit(baseCandidate({ predictedGateVerdict: null, slopAssessment: null }));
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["predicted_gate_unavailable", "slop_assessment_unavailable"]);
});

test("observe mode: forces allow: false even for signals that would otherwise cleanly pass", () => {
  const decision = shouldSubmit(baseCandidate({ mode: "observe" }));
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["observe_mode_active:would_have_allowed"]);
});

test("observe mode: a would-have-blocked decision is distinguishable from a would-have-allowed one, with the real reasons preserved", () => {
  const decision = shouldSubmit(baseCandidate({ mode: "observe", predictedGateVerdict: null }));
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["observe_mode_active:would_have_blocked", "predicted_gate_unavailable"]);
});

test("isSlopBandWithinThreshold: a band exactly equal to the threshold passes (inclusive boundary)", () => {
  assert.equal(isSlopBandWithinThreshold("elevated", "elevated"), true);
});

test("isSlopBandWithinThreshold: a band one severity level under the threshold passes", () => {
  assert.equal(isSlopBandWithinThreshold("low", "elevated"), true);
});

test("isSlopBandWithinThreshold: a band one severity level over the threshold fails", () => {
  assert.equal(isSlopBandWithinThreshold("high", "elevated"), false);
});

test("isSlopBandWithinThreshold: the full clean..high ordering is respected end to end", () => {
  const order: SelfReviewSlopBand[] = ["clean", "low", "elevated", "high"];
  for (let i = 0; i < order.length; i += 1) {
    for (let j = 0; j < order.length; j += 1) {
      const band = order[i] as SelfReviewSlopBand;
      const threshold = order[j] as SelfReviewSlopBand;
      assert.equal(isSlopBandWithinThreshold(band, threshold), i <= j, `${band} within ${threshold}`);
    }
  }
});
