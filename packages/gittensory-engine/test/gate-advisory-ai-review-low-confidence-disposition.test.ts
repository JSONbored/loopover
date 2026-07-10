import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateGateCheck } from "../dist/advisory/gate-advisory.js";
import type { Advisory, AdvisoryFinding } from "../dist/types/predicted-gate-types.js";

const DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE = 0.93;

function consensusAdvisory(confidence: number): Advisory {
  const finding: AdvisoryFinding = {
    code: "ai_consensus_defect",
    title: "AI reviewers agree on a likely critical defect",
    severity: "critical",
    detail: "Both reviewers flagged the same blocker.",
    confidence,
  };
  return {
    id: "advisory-1",
    targetType: "pull_request",
    targetKey: "JSONbored/gittensory#1",
    repoFullName: "JSONbored/gittensory",
    conclusion: "action_required",
    severity: "critical",
    title: "Gittensory review",
    summary: "",
    findings: [finding],
    generatedAt: "2026-07-10T00:00:00.000Z",
  };
}

// #4603 (gate-decision twin of src/rules/advisory.ts, kept in sync per checkGateDecisionVersionBump): mirrors
// the host copy's own regression tests for isConfiguredGateBlocker's aiReviewLowConfidenceDisposition branch.

test("at-or-above-floor confidence blocks identically across all three dispositions", () => {
  const advisory = consensusAdvisory(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
  for (const disposition of ["one_shot", "hold_for_review", "advisory_only"] as const) {
    const evaluation = evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: disposition });
    assert.equal(evaluation.conclusion, "failure");
  }
});

test("sub-floor + one_shot or hold_for_review still blocks (today's behavior, unchanged at the gate level)", () => {
  const advisory = consensusAdvisory(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE - 0.1);
  assert.equal(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "one_shot" }).conclusion, "failure");
  assert.equal(evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "hold_for_review" }).conclusion, "failure");
  // Unset ⇒ hold_for_review is the default.
  assert.equal(evaluateGateCheck(advisory, { aiReviewGateMode: "block" }).conclusion, "failure");
});

test("sub-floor + advisory_only drops the finding to fully non-blocking", () => {
  const advisory = consensusAdvisory(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE - 0.1);
  const evaluation = evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "advisory_only" });
  assert.equal(evaluation.conclusion, "success");
  assert.equal(evaluation.blockers.length, 0);
});

test("respects a custom aiReviewCloseConfidence floor under advisory_only", () => {
  const advisory = consensusAdvisory(0.5);
  assert.equal(
    evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "advisory_only", aiReviewCloseConfidence: 0.6 }).conclusion,
    "success",
  );
  assert.equal(
    evaluateGateCheck(advisory, { aiReviewGateMode: "block", aiReviewLowConfidenceDisposition: "advisory_only", aiReviewCloseConfidence: 0.4 }).conclusion,
    "failure",
  );
});

test("aiReviewGateMode !== block stays non-blocking regardless of disposition", () => {
  const advisory = consensusAdvisory(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE - 0.1);
  for (const disposition of ["one_shot", "hold_for_review", "advisory_only"] as const) {
    const evaluation = evaluateGateCheck(advisory, { aiReviewGateMode: "advisory", aiReviewLowConfidenceDisposition: disposition });
    assert.equal(evaluation.conclusion, "success");
  }
});
