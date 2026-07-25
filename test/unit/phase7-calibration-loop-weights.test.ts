import { describe, expect, it } from "vitest";

import { computePhase7CalibrationLoop, resolvePhase7CalibrationConfig } from "../../packages/loopover-engine/src/index";

// #8644: root-vitest mirror so `normalizeCompositeWeights`'s explicit-all-zero branch in
// phase7-calibration-loop.ts is Codecov-measured. The package-native node:test suite
// (packages/loopover-engine/test/) runs under the engine workspace, not this root run that Codecov grades --
// same reasoning as #8438's signal-tracking root mirror. Imports the engine SOURCE (src/index) so coverage
// attributes to the .ts rather than the built dist.
describe("phase7 composite weights — explicit all-zero is preserved (#8644)", () => {
  it("preserves both weights as 0 instead of silently reverting to the 50/50 default", () => {
    const config = resolvePhase7CalibrationConfig({
      miner: { calibration: { phase7LoopEnabled: true, historicalReplayWeight: 0, prOutcomeWeight: 0 } },
    });
    // Precondition: an explicit 0 is stored as 0, not defaulted — otherwise the branch under test is unreachable.
    expect(config.historicalReplayWeight).toBe(0);
    expect(config.prOutcomeWeight).toBe(0);

    const result = computePhase7CalibrationLoop({ config });
    expect(result.weights).toEqual({ historicalReplay: 0, prOutcome: 0 });
    // {0,0} leaves no composite weighting, so combinedAccuracy is null — the same state reached when no
    // source contributes, not a silently-defaulted weighted average.
    expect(result.combinedAccuracy).toBeNull();
  });

  it("still normalizes a normal positive config to sum 1 (the unchanged happy path, both branches covered)", () => {
    const config = resolvePhase7CalibrationConfig({
      miner: { calibration: { phase7LoopEnabled: true, historicalReplayWeight: 3, prOutcomeWeight: 1 } },
    });
    const result = computePhase7CalibrationLoop({ config });
    expect(result.weights).toEqual({ historicalReplay: 0.75, prOutcome: 0.25 });
  });
});
