import { describe, expect, it } from "vitest";
import { calibrateActThreshold, clopperPearsonUpperBound, minimumCalibrationLabels, type CalibrationPair } from "../../src/review/risk-control";

// #8835: the math that turns "99.5%" into a guarantee is pinned exactly — an anti-conservative bound here
// would publish a certainty the labels cannot support, which is the epic's original sin.
describe("clopperPearsonUpperBound", () => {
  it("matches the exact zero-error closed form 1 - delta^(1/n)", () => {
    for (const [n, delta] of [[10, 0.05], [100, 0.05], [598, 0.05], [59, 0.05]] as const) {
      expect(clopperPearsonUpperBound(0, n, delta)).toBeCloseTo(1 - delta ** (1 / n), 6);
    }
  });

  it("is monotone: more errors or fewer trials never tightens the bound; edges are honest", () => {
    expect(clopperPearsonUpperBound(1, 100, 0.05)).toBeGreaterThan(clopperPearsonUpperBound(0, 100, 0.05));
    expect(clopperPearsonUpperBound(0, 50, 0.05)).toBeGreaterThan(clopperPearsonUpperBound(0, 100, 0.05));
    expect(clopperPearsonUpperBound(5, 5, 0.05)).toBe(1); // all wrong → no upper bound below 1
    expect(clopperPearsonUpperBound(0, 0, 0.05)).toBe(1); // no data → no claim
    // Sanity against the rule of three: 0 errors in n gives roughly 3/n at 95%.
    expect(clopperPearsonUpperBound(0, 1000, 0.05)).toBeCloseTo(3 / 1000, 3);
  });
});

describe("minimumCalibrationLabels", () => {
  it("encodes the exact zero-error floor (598 clean labels for alpha=0.005 at 95%)", () => {
    expect(minimumCalibrationLabels(0.005, 0.05)).toBe(598);
    expect(minimumCalibrationLabels(0.015, 0.05)).toBe(199);
    expect(minimumCalibrationLabels(0.002, 0.05)).toBe(1497);
  });
});

describe("calibrateActThreshold (fixed-sequence)", () => {
  const pair = (confidence: number, correct: boolean): CalibrationPair => ({ confidence, correct });

  it("REFUSES below the sample-size floor — insufficient labels is never a degraded guess", () => {
    const clean = Array.from({ length: 100 }, () => pair(0.99, true));
    const result = calibrateActThreshold(clean, 0.005, 0.05);
    expect(result).toMatchObject({ status: "insufficient_labels", needed: 598, have: 100 });
  });

  it("certifies a clean, large set at full coverage", () => {
    const clean = Array.from({ length: 700 }, (_, i) => pair(0.9 + (i % 10) / 100, true));
    const result = calibrateActThreshold(clean, 0.005, 0.05);
    expect(result.status).toBe("calibrated");
    if (result.status === "calibrated") {
      expect(result.lambda).toBe(0.9); // the least conservative candidate still certifies
      expect(result.coverageAtLambda).toBe(1);
      expect(result.errorsAtLambda).toBe(0);
    }
  });

  it("stops the sweep at the first failing candidate — errors clustered at low confidence RAISE lambda and cut coverage", () => {
    // 650 clean pairs at 0.97, then a dirty low-confidence band: the sweep must stop before absorbing it.
    const pairs = [
      ...Array.from({ length: 650 }, () => pair(0.97, true)),
      ...Array.from({ length: 100 }, (_, i) => pair(0.6, i % 3 !== 0)), // ~33% wrong below the band
    ];
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result.status).toBe("calibrated");
    if (result.status === "calibrated") {
      expect(result.lambda).toBe(0.97);
      expect(result.nAtLambda).toBe(650);
      expect(result.coverageAtLambda).toBeCloseTo(650 / 750, 5);
      expect(result.errorsAtLambda).toBe(0);
    }
  });

  it("a passing-but-tiny high-confidence clique cannot certify — the prefix itself must clear the floor", () => {
    // 50 pristine pairs at 0.99, then errors immediately: the 0.99 prefix passes its bound test... but 50
    // labels cannot certify alpha=0.005, and pretending otherwise is the exact dishonesty this refuses.
    const pairs = [...Array.from({ length: 50 }, () => pair(0.99, true)), ...Array.from({ length: 600 }, () => pair(0.5, false))];
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result).toMatchObject({ status: "insufficient_labels", needed: 598, have: 50 });
  });

  it("is deterministic and input-order independent", () => {
    const base = Array.from({ length: 700 }, (_, i) => pair(0.9 + (i % 10) / 100, i % 400 !== 0));
    const shuffled = [...base].reverse();
    expect(calibrateActThreshold(base, 0.015, 0.05)).toEqual(calibrateActThreshold(shuffled, 0.015, 0.05));
  });

  it("looser alpha certifies where tighter alpha refuses — the NP arms genuinely differ", () => {
    const pairs = Array.from({ length: 250 }, () => pair(0.95, true));
    expect(calibrateActThreshold(pairs, 0.015, 0.05).status).toBe("calibrated"); // close-arm alpha
    expect(calibrateActThreshold(pairs, 0.002, 0.05).status).toBe("insufficient_labels"); // merge-arm alpha
  });
});
