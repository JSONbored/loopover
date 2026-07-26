import { describe, expect, it } from "vitest";
import {
  computeGateVerdictCompositeCalibrationScore,
  computeFindingSeverityCompositeCalibrationScore,
  computePairwiseCalibrationScore,
  computeReviewerConsensusCompositeCalibrationScore,
  ingestReviewerConsensusCalibrationSignals,
} from "../../packages/loopover-engine/src/index";

// Converges gate-verdict + finding-severity calibration with reviewer-consensus-calibration.ts's already-correct
// all-zero-weight + malformed-repo handling (#6170). These run under vitest (Codecov-measured) so the changed
// engine-src branches are covered; the engine's own node:test suites carry the equivalent assertions.
describe("gate-verdict/finding-severity calibration convergence (#6170)", () => {
  it("gate-verdict: all-zero weights fall back to objective-only, not the default 45/35/20 blend", () => {
    const result = computeGateVerdictCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      gateVerdicts: [
        {
          repoFullName: "acme/widgets",
          replayRunId: "replay-1",
          gateRunId: "gate-1",
          optedIn: true,
          dimensions: [{ dimension: "correctness", outcome: "pass" }],
        },
      ],
      weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredGateVerdict: 0 },
    });
    expect(result.weights).toEqual({ objectiveAnchor: 1, pairwiseJudge: 0, structuredGateVerdict: 0 });
    expect(result.compositeScore).toBe(0.4);
  });

  it("finding-severity: all-zero weights fall back to objective-only, not the default blend", () => {
    const result = computeFindingSeverityCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      findingSeverity: [
        { repoFullName: "acme/widgets", replayRunId: "replay-1", reviewRunId: "review-1", optedIn: true, tiers: [{ tier: "blocker", total: 2, confirmed: 2 }] },
      ],
      weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredFindingSeverity: 0 },
    });
    expect(result.weights).toEqual({ objectiveAnchor: 1, pairwiseJudge: 0, structuredFindingSeverity: 0 });
    expect(result.compositeScore).toBe(0.4);
  });

  it("finding-severity: non-zero (default) weights take the normalized path, NOT the objective-only fallback (covers the total>0 branch)", () => {
    const result = computeFindingSeverityCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      findingSeverity: [
        { repoFullName: "acme/widgets", replayRunId: "replay-1", reviewRunId: "review-1", optedIn: true, tiers: [{ tier: "blocker", total: 2, confirmed: 2 }] },
      ],
    });
    // Default (non-zero) weights sum to > 0, so the fallback is NOT taken: every component keeps a real share.
    expect(result.weights.objectiveAnchor).toBeGreaterThan(0);
    expect(result.weights.structuredFindingSeverity).toBeGreaterThan(0);
  });

  it("gate-verdict: NaN/negative weights recover to the default 45/35/20 blend, NOT a 100%-objective-anchor collapse (#8643)", () => {
    const result = computeGateVerdictCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      gateVerdicts: [
        {
          repoFullName: "acme/widgets",
          replayRunId: "replay-1",
          gateRunId: "gate-1",
          optedIn: true,
          dimensions: [{ dimension: "correctness", outcome: "pass" }],
        },
      ],
      weights: { objectiveAnchor: Number.NaN, pairwiseJudge: -1, structuredGateVerdict: -1 },
    });
    // Real pairwise + structured scores are present, so the recovered default blend survives unrenormalized.
    expect(result.weights).toEqual({ objectiveAnchor: 0.45, pairwiseJudge: 0.35, structuredGateVerdict: 0.2 });
  });

  it("finding-severity: NaN/negative weights recover to the default blend, NOT the objective-only collapse (#8643)", () => {
    const result = computeFindingSeverityCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      findingSeverity: [
        { repoFullName: "acme/widgets", replayRunId: "replay-1", reviewRunId: "review-1", optedIn: true, tiers: [{ tier: "blocker", total: 2, confirmed: 2 }] },
      ],
      weights: { objectiveAnchor: Number.NaN, pairwiseJudge: -1, structuredFindingSeverity: -1 },
    });
    expect(result.weights).toEqual({ objectiveAnchor: 0.45, pairwiseJudge: 0.35, structuredFindingSeverity: 0.2 });
  });

  it("reviewer-consensus: explicit all-zero weights fall back to objective-only (covers the total<=0 real-zeros arm)", () => {
    const ingestion = ingestReviewerConsensusCalibrationSignals([
      { repoFullName: "acme/widgets", replayRunId: "replay-1", reviewRunId: "review-1", optedIn: true, dimensions: [{ dimension: "correctness", votes: ["pass", "pass"] }] },
    ]);
    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      reviewerConsensus: ingestion,
      weights: { objectiveAnchor: 0, pairwiseJudge: 0, structuredReviewerConsensus: 0 },
    });
    expect(result.weights).toEqual({ objectiveAnchor: 1, pairwiseJudge: 0, structuredReviewerConsensus: 0 });
    expect(result.compositeScore).toBe(0.4);
  });

  it("reviewer-consensus: NaN/negative weights recover to the default blend, NOT the objective-only collapse (#8643)", () => {
    const ingestion = ingestReviewerConsensusCalibrationSignals([
      { repoFullName: "acme/widgets", replayRunId: "replay-1", reviewRunId: "review-1", optedIn: true, dimensions: [{ dimension: "correctness", votes: ["pass", "pass"] }] },
    ]);
    const result = computeReviewerConsensusCompositeCalibrationScore({
      objectiveAnchor: 0.4,
      pairwise: 0.4,
      reviewerConsensus: ingestion,
      weights: { objectiveAnchor: Number.NaN, pairwiseJudge: -1, structuredReviewerConsensus: -1 },
    });
    expect(result.weights).toEqual({ objectiveAnchor: 0.45, pairwiseJudge: 0.35, structuredReviewerConsensus: 0.2 });
  });

  it("gate-verdict: preserves a malformed-repo (invalid_repo) rejected row instead of dropping it; keeps a valid repo and drops a non-string one", () => {
    const result = computeGateVerdictCompositeCalibrationScore({
      objectiveAnchor: 0.5,
      pairwise: 0.5,
      gateVerdicts: {
        accepted: [],
        rejected: [
          { repoFullName: "acme/widgets", replayRunId: "replay-1", gateRunId: "gate-1", reason: "not_opted_in" },
          { repoFullName: "bad", replayRunId: "replay-2", gateRunId: "gate-2", reason: "invalid_repo" },
          { repoFullName: 123, replayRunId: "replay-3", gateRunId: "gate-3", reason: "invalid_repo" },
        ],
      } as never,
    });
    // "bad" is not a valid owner/repo, so normalizeRepoFullName returns null; the `?? normalizeId` fallback
    // preserves the raw string instead of dropping the row (matching reviewer-consensus). The non-string repo
    // (123) still drops (ternary false branch).
    expect(result.audit.rejected).toEqual([
      { repoFullName: "acme/widgets", replayRunId: "replay-1", gateRunId: "gate-1", reason: "not_opted_in" },
      { repoFullName: "bad", replayRunId: "replay-2", gateRunId: "gate-2", reason: "invalid_repo" },
    ]);
  });
});

// Extends the #6170 all-zero-weight pattern to pairwise-calibration.ts (#7443). Vitest coverage is what
// Codecov grades; the engine package's node:test suite mirrors the same assertions.
describe("pairwise calibration zero-weight convergence (#7443)", () => {
  it("explicit all-zero weights fall back to objective-only even when pairwiseJudgeScore is present", () => {
    const result = computePairwiseCalibrationScore({
      objectiveAnchor: 0.42,
      samples: [{ attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] }],
      weights: { objectiveAnchor: 0, pairwiseJudge: 0 },
    });
    expect(result.pairwiseJudgeScore).toBe(1);
    expect(result.weights).toEqual({ objectiveAnchor: 1, pairwiseJudge: 0 });
    expect(result.compositeScore).toBe(0.42);
  });

  it("NaN/negative weights still recover to the 50/50 default (not the objective-only fallback)", () => {
    const result = computePairwiseCalibrationScore({
      objectiveAnchor: 1,
      samples: [{ attempts: [{ replayFirst: "revealed_better", revealedFirst: "replay_better" }] }],
      weights: { objectiveAnchor: Number.NaN, pairwiseJudge: -1 },
    });
    expect(result.weights).toEqual({ objectiveAnchor: 0.5, pairwiseJudge: 0.5 });
    expect(result.compositeScore).toBe(0.5);
  });

  it("non-zero weights take the normalized usable path (covers usableTotal > 0)", () => {
    const result = computePairwiseCalibrationScore({
      objectiveAnchor: 0.55,
      samples: [
        { attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] },
        { attempts: [{ replayFirst: "tie", revealedFirst: "tie" }] },
      ],
      weights: { objectiveAnchor: 1, pairwiseJudge: 3 },
    });
    expect(result.weights).toEqual({ objectiveAnchor: 0.25, pairwiseJudge: 0.75 });
    expect(result.compositeScore).toBe(0.7);
  });

  it("missing pairwise signal zeros that component then falls back to objective-only when usable total is empty", () => {
    const result = computePairwiseCalibrationScore({
      objectiveAnchor: 0.42,
      samples: [{ attempts: [{ replayFirst: "incomparable", revealedFirst: "incomparable" }] }],
      weights: { objectiveAnchor: 0, pairwiseJudge: 0 },
    });
    expect(result.pairwiseJudgeScore).toBeNull();
    expect(result.weights).toEqual({ objectiveAnchor: 1, pairwiseJudge: 0 });
    expect(result.compositeScore).toBe(0.42);
  });

  it("missing pairwise signal with non-zero weights renormalizes to objective-only (covers usableTotal > 0 + null pairwise)", () => {
    const result = computePairwiseCalibrationScore({
      objectiveAnchor: 0.42,
      samples: [{ attempts: [{ replayFirst: "incomparable", revealedFirst: "incomparable" }] }],
      weights: { objectiveAnchor: 1, pairwiseJudge: 1 },
    });
    expect(result.pairwiseJudgeScore).toBeNull();
    expect(result.weights).toEqual({ objectiveAnchor: 1, pairwiseJudge: 0 });
    expect(result.compositeScore).toBe(0.42);
  });
});
