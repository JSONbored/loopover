import { describe, expect, it } from "vitest";
import {
  computeGateVerdictCompositeCalibrationScore,
  computeFindingSeverityCompositeCalibrationScore,
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
