import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateGateCheck } from "../dist/advisory/gate-advisory.js";
import type { Advisory, AdvisoryFinding } from "../dist/types/predicted-gate-types.js";

function inconclusiveAdvisory(extraFindings: AdvisoryFinding[] = []): Advisory {
  const finding: AdvisoryFinding = {
    code: "ai_review_inconclusive",
    title: "AI review could not complete for this PR head",
    severity: "warning",
    detail: "The AI review attempt did not produce a result.",
    action: "The review is retried automatically after a short cooldown.",
  };
  return {
    id: "advisory-1",
    targetType: "pull_request",
    targetKey: "JSONbored/loopover#1",
    repoFullName: "JSONbored/loopover",
    conclusion: "success",
    severity: "warning",
    title: "LoopOver review",
    summary: "",
    findings: [finding, ...extraFindings],
    generatedAt: "2026-07-31T00:00:00.000Z",
  };
}

// #10016 (gate-decision twin of src/rules/advisory.ts, kept in sync per checkGateDecisionVersionBump): mirrors
// the host copy's own regression tests for the ai_review_inconclusive hold's aiReviewGateMode gating.

test("REGRESSION: an inconclusive review does not hold an advisory-mode repo's otherwise-clean gate", () => {
  const evaluation = evaluateGateCheck(inconclusiveAdvisory());
  assert.equal(evaluation.conclusion, "success");
  assert.ok(evaluation.warnings.some((finding) => finding.code === "ai_review_inconclusive"));
});

test("stays non-blocking under an explicit advisory or off mode", () => {
  const advisory = inconclusiveAdvisory();
  const advisoryMode = evaluateGateCheck(advisory, { aiReviewGateMode: "advisory" });
  assert.equal(advisoryMode.conclusion, "success");
  assert.ok(advisoryMode.warnings.some((finding) => finding.code === "ai_review_inconclusive"));

  const offMode = evaluateGateCheck(advisory, { aiReviewGateMode: "off" });
  assert.equal(offMode.conclusion, "success");
  assert.ok(offMode.warnings.some((finding) => finding.code === "ai_review_inconclusive"));
});

test("still HOLDS the gate (neutral) under aiReviewGateMode: block, with the unchanged title", () => {
  const evaluation = evaluateGateCheck(inconclusiveAdvisory(), { aiReviewGateMode: "block" });
  assert.equal(evaluation.conclusion, "neutral");
  assert.equal(evaluation.title, "LoopOver Orb Review Agent — held for human review");
  assert.equal(evaluation.blockers.length, 0);
});

test("the unconditional secret_scan_incomplete hold still fires once the AI hold no longer does", () => {
  const advisory = inconclusiveAdvisory([
    {
      code: "secret_scan_incomplete",
      title: "Patch-less file(s) could not be fully scanned for secrets (1)",
      severity: "critical",
      detail: "GitHub omitted inline diff for: secrets.env.",
      action: "Ensure patch-less files are within scan limits or split the change so secrets can be verified.",
    },
  ]);
  const evaluation = evaluateGateCheck(advisory);
  assert.equal(evaluation.conclusion, "neutral");
  assert.equal(evaluation.blockers.length, 0);
});
