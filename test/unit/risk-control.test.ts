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

  it("a floor-clearing set that no threshold certifies reports its TRUE label count, not the residual stratum (#9048)", () => {
    // 50 pristine pairs at 0.99, then 600 errors: 650 labels clear the sample floor (>= 598), so this is NOT
    // an insufficient-labels case. No λ certifies (the clean 0.99 prefix is under-powered; the full set is 92%
    // wrong), so it is a "no certifiable threshold" outcome. `totalPairs` must be the true 650 usable labels --
    // the old `insufficient_labels.have` reported the residual 50 here, the exact conflation #9048 fixes.
    const pairs = [...Array.from({ length: 50 }, () => pair(0.99, true)), ...Array.from({ length: 600 }, () => pair(0.5, false))];
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result).toMatchObject({ status: "no_certifiable_threshold", needed: 598, totalPairs: 650 });
    // Never a residual: totalPairs is the label supply, distinct from the best surviving stratum's bestN.
    if (result.status === "no_certifiable_threshold") {
      expect(result.totalPairs).toBe(650);
      expect(result.bestUpperBound).toBeGreaterThan(0.005); // still above alpha -- genuinely uncertifiable
    }
  });

  it("branch B carries the tightest bound achieved and never mislabels a precision problem as a supply problem (#9048)", () => {
    const rep = (n: number, confidence: number, wrongBelow: number) =>
      Array.from({ length: n }, (_, i) => pair(confidence, i >= wrongBelow));

    // A high error rate at every candidate; dropping low-confidence strata TIGHTENS the bound but never to
    // alpha=0.2. The final 0.9 stratum (n=5) is under the floor and must be excluded from `bestN`.
    const tightensThenSubFloor = [...rep(14, 0.3, 7), ...rep(14, 0.6, 2), ...rep(5, 0.9, 3)];
    const a = calibrateActThreshold(tightensThenSubFloor, 0.2, 0.05);
    expect(a).toMatchObject({ status: "no_certifiable_threshold", totalPairs: 33, needed: 14, bestN: 19, bestLambda: 0.6 });

    // Dropping a CLEAN low-confidence stratum raises the residual error rate, so the tightest bound is the
    // full set here -- the reduce must keep the earlier, lower bound rather than the looser later one.
    const loosensAfterDrop = [...rep(14, 0.5, 0), ...rep(14, 0.9, 6)];
    const b = calibrateActThreshold(loosensAfterDrop, 0.2, 0.05);
    expect(b).toMatchObject({ status: "no_certifiable_threshold", totalPairs: 28, needed: 14, bestN: 28, bestLambda: 0.5 });
    if (a.status === "no_certifiable_threshold" && b.status === "no_certifiable_threshold") {
      // The tightest bound is genuinely the minimum across the sweep, above alpha in both directions of the drop.
      expect(a.bestUpperBound).toBeGreaterThan(0.2);
      expect(b.bestUpperBound).toBeGreaterThan(0.2);
    }
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
