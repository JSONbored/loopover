import { describe, expect, it } from "vitest";
import { scoreJudgmentAgreement, UNCORROBORATED_AGREEMENT } from "../../src/review/judgment-agreement";

// #8834: the per-decision confidence signal. The contract worth pinning is that the score can never read as
// MORE certain than its weakest input, and that a run with nothing to corroborate it is never scored as
// unanimous — the same "silence is not certainty" failure #8845 fixed for absent verbalized confidence.

describe("scoreJudgmentAgreement (#8834)", () => {
  const fail = { votedFail: true };
  const pass = { votedFail: false };

  it("unanimous reviewers score full agreement and keep the verbalized confidence intact", () => {
    expect(scoreJudgmentAgreement([fail, fail], 0.9)).toEqual({ agreement: 1, confidence: 0.9, sampleCount: 2, uncorroborated: false });
    // Unanimity on the NON-fail stance is equally unanimous — agreement is about reproducibility, not verdict.
    expect(scoreJudgmentAgreement([pass, pass], 0.8)).toMatchObject({ agreement: 1, confidence: 0.8 });
  });

  it("a split scores below unanimity and drags the combined confidence down with it", () => {
    const split = scoreJudgmentAgreement([fail, pass], 0.9);
    expect(split).toMatchObject({ agreement: 0.5, sampleCount: 2, uncorroborated: false });
    // 0.5 agreement x 0.9 stated = 0.45: a disagreed-upon judgment is recorded as materially less certain
    // than the same judgment reached unanimously (0.9 above), which is the whole point of the signal.
    expect(split.confidence).toBeCloseTo(0.45, 10);
    expect(split.confidence).toBeLessThan(scoreJudgmentAgreement([fail, fail], 0.9).confidence);
  });

  it("2-of-3 is the modal stance regardless of which side holds it", () => {
    expect(scoreJudgmentAgreement([fail, fail, pass], 1).agreement).toBeCloseTo(2 / 3, 10);
    expect(scoreJudgmentAgreement([pass, pass, fail], 1).agreement).toBeCloseTo(2 / 3, 10);
    expect(scoreJudgmentAgreement([fail, fail, fail], 1).agreement).toBe(1);
  });

  it("a lone run is UNCORROBORATED, never fabricated unanimity — the budget-degraded arm", () => {
    // A single reviewer (single-reviewer plan, or a dual plan whose second leg failed / was budget-cut)
    // cannot corroborate itself. It must record a LOWER confidence than a genuinely agreed judgment, not a
    // flattering 1.0.
    const lone = scoreJudgmentAgreement([fail], 0.9);
    expect(lone).toMatchObject({ agreement: UNCORROBORATED_AGREEMENT, sampleCount: 1, uncorroborated: true });
    expect(lone.confidence).toBeCloseTo(0.45, 10);
    expect(lone.confidence).toBeLessThan(scoreJudgmentAgreement([fail, fail], 0.9).confidence);
  });

  it("zero samples still refuses to invent a score", () => {
    expect(scoreJudgmentAgreement([], 0.9)).toMatchObject({ agreement: UNCORROBORATED_AGREEMENT, sampleCount: 0, uncorroborated: true });
  });

  it("clamps and totalizes a hostile verbalized confidence instead of propagating it", () => {
    expect(scoreJudgmentAgreement([fail, fail], 5).confidence).toBe(1);
    expect(scoreJudgmentAgreement([fail, fail], -3).confidence).toBe(0);
    expect(scoreJudgmentAgreement([fail, fail], Number.NaN).confidence).toBe(0);
    expect(scoreJudgmentAgreement([fail, fail], Number.POSITIVE_INFINITY).confidence).toBe(0);
  });

  it("INVARIANT: the combined score never exceeds either input, at any sample shape", () => {
    const shapes = [[fail], [fail, fail], [fail, pass], [pass, pass], [fail, fail, pass], [pass, fail, fail], [fail, fail, fail], []];
    for (const stated of [0, 0.13, 0.5, 0.93, 1]) {
      for (const shape of shapes) {
        const scored = scoreJudgmentAgreement(shape, stated);
        expect(scored.confidence).toBeLessThanOrEqual(scored.agreement + 1e-12);
        expect(scored.confidence).toBeLessThanOrEqual(stated + 1e-12);
        expect(scored.agreement).toBeGreaterThanOrEqual(0);
        expect(scored.agreement).toBeLessThanOrEqual(1);
      }
    }
  });
});
