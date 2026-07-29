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
    // 800 total labels (well over the 736-label split-delta floor for these 2 candidates at alpha=0.005,
    // #9637) — but every candidate either has a ruinous error rate (the 700 pairs at 0.5, all wrong) or falls
    // below the split-delta sample-size floor once that dirty stratum is dropped (only 100 remain at 0.99).
    // Before #9048 this reported `have: 100` under `insufficient_labels` — exactly the "N usable labels of
    // 59/598 needed" bug: a residual stratum size misreported as the repo's total label supply.
    const pairs = [...Array.from({ length: 700 }, () => pair(0.5, false)), ...Array.from({ length: 100 }, () => pair(0.99, true))];
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result.status).toBe("no_certifiable_threshold");
    if (result.status === "no_certifiable_threshold") {
      expect(result.totalPairs).toBe(800); // the TRUE total, never a residual stratum size
      expect(result.bestN).toBe(800); // the only candidate that cleared the split-delta sample-size floor
      expect(result.bestLambda).toBe(0.5);
      expect(result.bestUpperBound).toBeGreaterThan(0.005); // could not certify alpha
      expect(result.bestUpperBound).toBeLessThanOrEqual(1);
    }
  });

  it("REGRESSION (#9066): does not over-certify across many observed confidence candidates — Bonferroni-splits delta across the K distinct thresholds actually tested", () => {
    // Same shape the pre-#9066 code certified at lambda=0.9 (700 clean pairs, 10 distinct confidences, zero
    // errors, alpha=0.005): the RAW zero-error bound at n=700, delta=0.05 is ≈0.0043 (<=0.005, would certify),
    // but split across K=10 candidates (delta/10=0.005) the bound is ≈0.0075 (>0.005) — over-certification is
    // refused. #9637: the label floor at that split delta (1058) is now also enforced up front, so 700 pairs —
    // genuinely short of what 10 candidates need — refuses as `insufficient_labels`, not the pre-#9637
    // `no_certifiable_threshold` (which would have wrongly implied the error rate, not the label count, was
    // the shortfall). Either way `calibrated` must never be reached.
    const pairs = Array.from({ length: 700 }, (_, i) => pair(0.9 + (i % 10) / 100, true));
    const result = calibrateActThreshold(pairs, 0.005, 0.05);
    expect(result.status).toBe("insufficient_labels");
    expect(result.status).not.toBe("calibrated");
    if (result.status === "insufficient_labels") {
      expect(result.needed).toBe(1058);
      expect(result.have).toBe(700);
    }
  });

  it("REGRESSION (#9637): the split-delta floor, not the raw floor, gates a zero-error set — 59 clean labels across 59 distinct confidences is insufficient, not uncertifiable", () => {
    // Exactly the raw floor (minimumCalibrationLabels(0.05, 0.05) = 59), so the pre-scan check alone would
    // let this through — but every pair is a distinct confidence (K=59 candidates), so the scan actually
    // tests each candidate at delta/59. The effective floor at that split delta is 138: below it, a
    // ZERO-ERROR set must still refuse as insufficient_labels, not fall through the whole scan into a
    // misleading no_certifiable_threshold (#9048's status split, reintroduced by #9066's Bonferroni
    // correction and the reason this issue exists).
    const pairs = Array.from({ length: 59 }, (_, i) => pair(0.4 + i / 1000, true));
    const result = calibrateActThreshold(pairs, 0.05, 0.05);
    expect(result).toMatchObject({ status: "insufficient_labels", needed: 138, have: 59 });
  });

  it("REGRESSION (#9637): no_certifiable_threshold remains reachable once labels clear the split-delta floor", () => {
    // A single confidence bucket (K=1 candidate, so the split delta equals the raw delta — this is also the
    // `candidates.length === 1` edge the fix must leave behaviorally identical to before #9637) isolates a
    // genuine error-rate shortfall from the label-count shortfall the tests above exercise: 1000 pairs, 12%
    // wrong — comfortably over alpha=0.05's own floor (59) but nowhere near a certifiable error rate.
    const pairs = [...Array.from({ length: 880 }, () => pair(0.9, true)), ...Array.from({ length: 120 }, () => pair(0.9, false))];
    const result = calibrateActThreshold(pairs, 0.05, 0.05);
    expect(result.status).toBe("no_certifiable_threshold");
    if (result.status === "no_certifiable_threshold") {
      expect(result.totalPairs).toBe(1000);
      expect(result.bestN).toBe(1000);
      expect(result.bestLambda).toBe(0.9);
      expect(result.bestUpperBound).toBeGreaterThan(0.05);
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
