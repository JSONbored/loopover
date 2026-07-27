// Per-decision confidence via inter-run agreement (#8834, epic #8828 Phase 3) — PURE.
//
// Verbalized confidence alone is poorly calibrated: a model asked "how sure are you" answers on a scale it
// has no grounding in, and #8845 already had to stop treating an ABSENT confidence as certainty. Sampling-based
// consistency is the better-behaved signal, and the risk-control literature this epic builds on (Trust or
// Escalate, ICLR 2025) finds two samples capture most of the available benefit.
//
// This module scores the samples the engine ALREADY runs. A dual-model review produces one independent stance
// per reviewer (`LoopOverAiReviewResult.reviewerVotes`, #8229) at zero additional AI spend, so inter-run
// agreement is computable today without multiplying the per-review bill. See the "not implemented here" note
// at the bottom for the paid rotated-exemplar extension and why it is deliberately absent.
//
// The score is ADDITIVE: it is recorded with the decision (`DecisionRecord.aiAgreement`) so it can join the
// risk-control calibration set (#8835) as the input an abstention threshold needs. It deliberately does NOT
// re-route the gate. Disagreement already routes to a hold today — one reviewer flagging and the other not
// IS the `ai_review_split` finding, which blocks or holds via the existing confidence floor — so adding a
// second, parallel disagreement route would double-count the same evidence rather than measure it.

/** One reviewer's stance on a single evaluation run. */
export type JudgmentSample = {
  /** Whether this run flagged a blocking defect. The agreement axis. */
  votedFail: boolean;
};

export type JudgmentAgreement = {
  /** Share of runs holding the MODAL stance, in [0,1]. Unanimity across N≥2 runs is 1; an even split is 0.5. */
  agreement: number;
  /** Inter-run agreement combined with the verbalized confidence — the calibrated per-decision signal. */
  confidence: number;
  /** How many runs actually produced a stance. */
  sampleCount: number;
  /** True when fewer than two runs were available, so agreement was never actually observed. */
  uncorroborated: boolean;
};

/** The agreement credited to a lone run. A single sample cannot corroborate itself: scoring it 1.0 would
 *  fabricate unanimity out of one opinion, which is exactly the failure #8845 fixed for absent confidence.
 *  0.5 — "no evidence either way" — keeps a single-run decision strictly below any genuinely corroborated
 *  one, so a budget-degraded run records a LOWER confidence rather than a flattering one. */
export const UNCORROBORATED_AGREEMENT = 0.5;

/**
 * Score inter-run agreement and fold it into the verbalized confidence. PURE and total.
 *
 * `verbalizedConfidence` is the model's own calibrated confidence in its blocker (`AdvisoryFinding.confidence`).
 * The combined score multiplies the two: a claim is only as trustworthy as BOTH how sure the judge said it was
 * AND how reproducibly the judges reached it. Multiplication (rather than an average) keeps the result
 * monotonically below either input, so the combined signal can never read as more certain than its weakest
 * component — the property an abstention threshold depends on.
 *
 * ZERO samples (every reviewer failed to produce a usable opinion) is not a fabricated score: it reports
 * `uncorroborated`, the uncorroborated agreement floor, and whatever confidence was actually stated. That
 * decision is already held as `ai_review_inconclusive` upstream; this just refuses to invent a number for it.
 */
export function scoreJudgmentAgreement(samples: readonly JudgmentSample[], verbalizedConfidence: number): JudgmentAgreement {
  const sampleCount = samples.length;
  const failCount = samples.filter((sample) => sample.votedFail).length;
  const modal = Math.max(failCount, sampleCount - failCount);
  // Below two runs there is nothing to agree WITH — fall back to the uncorroborated floor rather than
  // dividing by a sample count that cannot express disagreement.
  const uncorroborated = sampleCount < 2;
  const agreement = uncorroborated ? UNCORROBORATED_AGREEMENT : modal / sampleCount;
  const stated = Number.isFinite(verbalizedConfidence) ? Math.min(1, Math.max(0, verbalizedConfidence)) : 0;
  return { agreement, confidence: agreement * stated, sampleCount, uncorroborated };
}

// NOT IMPLEMENTED HERE, deliberately (#8834): the issue also describes running N=2-3 evaluations of the SAME
// judge with few-shot exemplars rotated out of the golden corpus ("simulated annotators"). That is a strictly
// better agreement signal than two different models voting once each — it isolates the judge's own
// reproducibility instead of confounding it with the two models' differing priors — but every extra run is a
// real, per-review AI charge on every reviewed PR, and this engine pays that bill in production. The scoring
// above is the half that costs nothing; the extra-sampling half needs a budget decision (and a flag defaulting
// OFF) before it can ship, so it is not stubbed here rather than landing as unreachable code.
