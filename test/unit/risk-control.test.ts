import { describe, expect, it } from "vitest";
import { calibrateActThreshold, clopperPearsonUpperBound, minimumCalibrationLabels, validateCalibrationPayload, type CalibrationPair } from "../../src/review/risk-control";

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

describe("calibrateActThreshold", () => {
  const pair = (confidence: number, correct: boolean, backfilled = false): CalibrationPair => ({ confidence, correct, backfilled });

  it("REFUSES below the sample-size floor — insufficient labels is never a degraded guess", () => {
    const clean = Array.from({ length: 100 }, () => pair(0.99, true));
    const result = calibrateActThreshold(clean, 0.005, 0.05);
    expect(result).toMatchObject({ status: "insufficient_labels", needed: 598, have: 100 });
  });

  it("certifies a clean, large set at full coverage — the least conservative candidate still certifies", () => {
    // Sized to still certify under the #9066 Bonferroni-split delta (3 distinct confidences here → delta/3):
    // the zero-error bound at n=900, delta/3≈0.01667 is ≈0.0045, comfortably under alpha=0.005.
    const clean = Array.from({ length: 900 }, (_, i) => pair(0.9 + (i % 3) / 100, true));
    const result = calibrateActThreshold(clean, 0.005, 0.05);
    expect(result.status).toBe("calibrated");
    if (result.status === "calibrated") {
      expect(result.lambda).toBe(0.9);
      expect(result.coverageAtLambda).toBe(1);
      expect(result.errorsAtLambda).toBe(0);
      expect(result.nAtLambda).toBe(900);
      expect(result.backfilledPairs).toBe(0); // #9050: none of these pairs are backfilled
    }
  });

  it("stops the sweep at the first certifying candidate — errors clustered at low confidence RAISE lambda and cut coverage", () => {
    // 800 clean pairs at 0.97, then a dirty low-confidence band: the sweep must drop the dirty band before
    // certifying. 800 (not 650) leaves headroom for the #9066 Bonferroni split across these 2 candidates
    // (delta/2=0.025): the zero-error bound at n=800 is ≈0.0046, just under alpha=0.005.
    const pairs = [
      ...Array.from({ length: 800 }, () => pair(0.97, true)),
      ...Array.from({ length: 100 }, (_, i) => pair(0.6, i % 3 !== 0)), // ~33% wrong below the band
    ];
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result.status).toBe("calibrated");
    if (result.status === "calibrated") {
      expect(result.lambda).toBe(0.97);
      expect(result.nAtLambda).toBe(800);
      expect(result.coverageAtLambda).toBeCloseTo(800 / 900, 5);
      expect(result.errorsAtLambda).toBe(0);
    }
  });

  it("REGRESSION (#9048): a repo with AMPLE labels that cannot certify reports its true total, not a residual stratum size", () => {
    // 650 total labels (well over the 598-label floor for alpha=0.005) — but every candidate either has a
    // ruinous error rate (the 600 pairs at 0.5, all wrong) or falls below the sample-size floor once that
    // dirty stratum is dropped (only 50 remain at 0.99). Before #9048 this reported `have: 50` under
    // `insufficient_labels` — exactly the "N usable labels of 59/598 needed" bug: a residual stratum size
    // misreported as the repo's total label supply.
    const pairs = [...Array.from({ length: 600 }, () => pair(0.5, false)), ...Array.from({ length: 50 }, () => pair(0.99, true))];
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result.status).toBe("no_certifiable_threshold");
    if (result.status === "no_certifiable_threshold") {
      expect(result.totalPairs).toBe(650); // the TRUE total, never a residual stratum size
      expect(result.bestN).toBe(650); // the only candidate that cleared the sample-size floor
      expect(result.bestLambda).toBe(0.5);
      expect(result.bestUpperBound).toBeGreaterThan(0.005); // could not certify alpha
      expect(result.bestUpperBound).toBeLessThanOrEqual(1);
    }
  });

  it("REGRESSION (#9066): does not over-certify across many observed confidence candidates — Bonferroni-splits delta across the K distinct thresholds actually tested", () => {
    // Same shape the pre-fix code certified at lambda=0.9 (700 clean pairs, 10 distinct confidences, zero
    // errors, alpha=0.005): the RAW zero-error bound at n=700, delta=0.05 is ≈0.0043 (<=0.005, would certify),
    // but split across K=10 candidates (delta/10=0.005) the bound is ≈0.0075 (>0.005) — correctly refuses,
    // because reporting whichever of 10 tested candidates passes first is a selection, not a single test.
    const pairs = Array.from({ length: 700 }, (_, i) => pair(0.9 + (i % 10) / 100, true));
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result.status).toBe("no_certifiable_threshold");
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

  it("#9050: tags backfilledPairs from each pair's provenance", () => {
    const pairs = [
      ...Array.from({ length: 300 }, () => pair(0.9, true, true)), // backfilled
      ...Array.from({ length: 600 }, () => pair(0.95, true, false)), // live
    ];
    const result = calibrateActThreshold(pairs, 0.015, 0.05);
    expect(result.status).toBe("calibrated");
    if (result.status === "calibrated") {
      expect(result.totalPairs).toBe(900);
      expect(result.backfilledPairs).toBe(300);
    }
  });
});

describe("validateCalibrationPayload (#9068)", () => {
  const valid = { status: "calibrated", alpha: 0.015, lambda: 0.9, coverageAtLambda: 0.8, nAtLambda: 200, delta: 0.05 };

  it("accepts a well-formed calibrated payload that clears the sample-size floor", () => {
    expect(validateCalibrationPayload(valid)).toEqual({ alpha: 0.015, lambda: 0.9, coverageAtLambda: 0.8, nAtLambda: 200, delta: 0.05 });
  });

  it("rejects a non-object / null payload", () => {
    expect(validateCalibrationPayload(null)).toBeNull();
    expect(validateCalibrationPayload("nope")).toBeNull();
    expect(validateCalibrationPayload(42)).toBeNull();
  });

  it("rejects anything whose status is not 'calibrated' — a refusal must never publish as a guarantee", () => {
    expect(validateCalibrationPayload({ ...valid, status: "insufficient_labels" })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, status: undefined })).toBeNull();
  });

  it("range-checks alpha (0, 0.05]", () => {
    expect(validateCalibrationPayload({ ...valid, alpha: 0 })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, alpha: 0.06 })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, alpha: "0.015" })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, alpha: 0.05 })).not.toBeNull(); // inclusive upper bound
  });

  it("range-checks lambda [0, 1]", () => {
    expect(validateCalibrationPayload({ ...valid, lambda: -0.01 })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, lambda: 1.01 })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, lambda: 1 })).not.toBeNull();
  });

  it("range-checks coverageAtLambda [0, 1]", () => {
    expect(validateCalibrationPayload({ ...valid, coverageAtLambda: -0.01 })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, coverageAtLambda: 1.5 })).toBeNull();
  });

  it("enforces the zero-error sample-size floor on nAtLambda given the payload's own alpha/delta", () => {
    // minimumCalibrationLabels(0.015, 0.05) = 199 — 198 could not have been legitimately certified.
    expect(validateCalibrationPayload({ ...valid, nAtLambda: 198 })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, nAtLambda: 199 })).not.toBeNull();
  });

  it("rejects a missing/non-numeric delta (needed to evaluate the sample-size floor at all)", () => {
    expect(validateCalibrationPayload({ ...valid, delta: undefined })).toBeNull();
    expect(validateCalibrationPayload({ ...valid, delta: "0.05" })).toBeNull();
  });
});
