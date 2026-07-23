import { describe, expect, it } from "vitest";
// Direct src-path import (not the `@loopover/engine` package barrel, which resolves to dist and is NOT in
// vitest's coverage.include): the engine's own node:test suite runs against dist and is invisible to Codecov,
// so this vitest mirror is what gives packages/loopover-engine/src/calibration/reliability-curve.ts its
// codecov/patch coverage (the "engine blind-spot rule"). The companion
// packages/loopover-engine/test/reliability-curve.test.ts is the node:test that gates the engine workspace's
// own `npm run test`. Vite resolves the `.js` specifier to the sibling `.ts` on disk.
import {
  computeReliabilityCurve,
  deriveThresholdSuggestion,
  DEFAULT_RELIABILITY_BUCKET_EDGES,
  RELIABILITY_BUCKET_SAMPLE_FLOOR,
  type ReliabilityCurve,
} from "../../packages/loopover-engine/src/calibration/reliability-curve.js";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus.js";

function caseWith(label: BacktestCase["label"], confidence?: unknown): BacktestCase {
  const backtestCase: BacktestCase = {
    ruleId: "linked_issue_scope_mismatch",
    targetKey: "acme/widgets#1",
    outcome: "block",
    label,
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
  };
  if (confidence !== undefined) backtestCase.metadata = { confidence };
  return backtestCase;
}

function curveOf(sampleFloor: number, buckets: Array<[floor: number, ceiling: number, confirmed: number, reversed: number]>): ReliabilityCurve {
  return {
    sampleFloor,
    buckets: buckets.map(([floor, ceiling, confirmed, reversed]) => ({
      floor,
      ceiling,
      cases: confirmed + reversed,
      confirmed,
      reversed,
      precision: confirmed + reversed >= sampleFloor ? confirmed / (confirmed + reversed) : null,
    })),
  };
}

describe("computeReliabilityCurve (#8226)", () => {
  it("buckets decided cases by claimed confidence and reports per-bucket precision", () => {
    const curve = computeReliabilityCurve(
      [
        caseWith("confirmed", 0.2),
        caseWith("reversed", 0.3),
        caseWith("confirmed", 0.7),
        caseWith("confirmed", 0.9),
        caseWith("reversed", 0.6),
      ],
      [0, 0.5, 1],
      1,
    );
    expect(curve).toEqual({
      sampleFloor: 1,
      buckets: [
        { floor: 0, ceiling: 0.5, cases: 2, confirmed: 1, reversed: 1, precision: 0.5 },
        { floor: 0.5, ceiling: 1, cases: 3, confirmed: 2, reversed: 1, precision: 2 / 3 },
      ],
    });
  });

  it("uses the documented default edges and sample floor when omitted", () => {
    const curve = computeReliabilityCurve([caseWith("confirmed", 0.95)]);
    expect(curve.sampleFloor).toBe(RELIABILITY_BUCKET_SAMPLE_FLOOR);
    expect(curve.buckets.map((bucket) => bucket.floor)).toEqual(DEFAULT_RELIABILITY_BUCKET_EDGES.slice(0, -1));
    expect(curve.buckets.map((bucket) => bucket.ceiling)).toEqual(DEFAULT_RELIABILITY_BUCKET_EDGES.slice(1));
    // Every registry candidate ladder value (loosening-knobs.ts) is a landable bucket floor by default.
    for (const registryValue of [0.3, 0.35, 0.4, 0.45, 0.85, 0.9]) {
      expect(curve.buckets.some((bucket) => bucket.floor === registryValue)).toBe(true);
    }
    const top = curve.buckets[curve.buckets.length - 1]!;
    expect([top.floor, top.ceiling]).toEqual([0.95, 1]);
    expect(top.cases).toBe(1);
    // 1 case sits below the default sample floor of 5 -> null, never a fabricated 1.0 precision.
    expect(top.precision).toBeNull();
  });

  it("treats an interior edge as floor-inclusive -- a claim exactly at it lands in the higher bucket", () => {
    const curve = computeReliabilityCurve([caseWith("confirmed", 0.5)], [0, 0.5, 1], 1);
    expect(curve.buckets[0]!.cases).toBe(0);
    expect(curve.buckets[1]!.cases).toBe(1);
  });

  it("keeps the first edge inclusive and the TOP edge ceiling-inclusive", () => {
    const curve = computeReliabilityCurve([caseWith("confirmed", 0), caseWith("reversed", 1)], [0, 0.5, 1], 1);
    expect(curve.buckets[0]!.cases).toBe(1);
    expect(curve.buckets[1]!.cases).toBe(1);
  });

  it("drops cases with no numeric claimed confidence instead of fabricating one (diverges from #8138's degrade-to-1)", () => {
    const curve = computeReliabilityCurve(
      [caseWith("confirmed"), { ...caseWith("confirmed"), metadata: {} }, caseWith("confirmed", "high")],
      [0, 0.5, 1],
      1,
    );
    expect(curve.buckets.map((bucket) => bucket.cases)).toEqual([0, 0]);
  });

  it("drops out-of-range and NaN claims, never clamping them into a bucket", () => {
    const curve = computeReliabilityCurve(
      [caseWith("confirmed", -0.1), caseWith("confirmed", 1.5), caseWith("confirmed", Number.NaN)],
      [0, 0.5, 1],
      1,
    );
    expect(curve.buckets.map((bucket) => bucket.cases)).toEqual([0, 0]);
  });

  it("reports null precision, never 0, for a bucket below the sample floor", () => {
    const curve = computeReliabilityCurve([caseWith("reversed", 0.7), caseWith("reversed", 0.7)], [0, 0.5, 1], 3);
    // 2 all-reversed cases: a coerced precision would read 0 -- the N/A-over-zero rule keeps it null.
    expect(curve.buckets[1]!.cases).toBe(2);
    expect(curve.buckets[1]!.precision).toBeNull();
  });

  it("reports the real precision for a bucket exactly AT the sample floor", () => {
    const curve = computeReliabilityCurve(
      [caseWith("confirmed", 0.7), caseWith("confirmed", 0.8), caseWith("reversed", 0.9)],
      [0, 0.5, 1],
      3,
    );
    expect(curve.buckets[1]!.precision).toBe(2 / 3);
  });

  it("yields all-zero buckets with null precision everywhere for an empty corpus", () => {
    const curve = computeReliabilityCurve([], [0, 0.5, 1], 1);
    expect(curve.buckets).toEqual([
      { floor: 0, ceiling: 0.5, cases: 0, confirmed: 0, reversed: 0, precision: null },
      { floor: 0.5, ceiling: 1, cases: 0, confirmed: 0, reversed: 0, precision: null },
    ]);
  });

  it("throws on malformed bucket edges", () => {
    expect(() => computeReliabilityCurve([], [0.5], 1)).toThrow(/invalid_bucket_edges/);
    expect(() => computeReliabilityCurve([], [0, 0.5, 0.5, 1], 1)).toThrow(/invalid_bucket_edges/);
    expect(() => computeReliabilityCurve([], [0, 0.7, 0.5, 1], 1)).toThrow(/invalid_bucket_edges/);
    expect(() => computeReliabilityCurve([], [-0.1, 0.5, 1], 1)).toThrow(/invalid_bucket_edges/);
    expect(() => computeReliabilityCurve([], [0, 0.5, 1.5], 1)).toThrow(/invalid_bucket_edges/);
    expect(() => computeReliabilityCurve([], [0, Number.NaN, 1], 1)).toThrow(/invalid_bucket_edges/);
  });

  it("throws on a sample floor below 1 (NaN fails closed into the throw)", () => {
    expect(() => computeReliabilityCurve([], [0, 1], 0)).toThrow(/invalid_sample_floor/);
    expect(() => computeReliabilityCurve([], [0, 1], Number.NaN)).toThrow(/invalid_sample_floor/);
  });

  it("is deterministic -- identical inputs yield an equal curve", () => {
    const cases = [caseWith("confirmed", 0.4), caseWith("reversed", 0.8)];
    expect(computeReliabilityCurve(cases, [0, 0.5, 1], 1)).toEqual(computeReliabilityCurve(cases, [0, 0.5, 1], 1));
  });
});

describe("deriveThresholdSuggestion (#8226)", () => {
  it("suggests the LOOSEST floor whose at-or-above pooled precision meets the target", () => {
    // Pooled from 0: (4 + 5 confirmed) / 10 = 0.9 -- already at target, so the loosest floor wins.
    const curve = curveOf(5, [
      [0, 0.5, 4, 1],
      [0.5, 1, 5, 0],
    ]);
    expect(deriveThresholdSuggestion(curve, 0.9, 0)).toBe(0);
  });

  it("pushes the suggestion up when a weak low bucket dilutes the pool", () => {
    // Pooled from 0: 6/10 = 0.6 < 0.9; pooled from 0.5: 5/5 = 1 >= 0.9.
    const curve = curveOf(5, [
      [0, 0.5, 1, 4],
      [0.5, 1, 5, 0],
    ]);
    expect(deriveThresholdSuggestion(curve, 0.9, 0)).toBe(0.5);
  });

  it("pools raw counts from buckets individually below the per-bucket sample floor", () => {
    // Each bucket alone is below the floor of 5 (3 and 4 cases -> null bucket precision), but the pooled
    // window from 0.5 has 7 cases -- enough density for a real, qualifying pooled precision.
    const curve = curveOf(5, [
      [0.5, 0.8, 3, 0],
      [0.8, 1, 4, 0],
    ]);
    expect(curve.buckets[0]!.precision).toBeNull();
    expect(curve.buckets[1]!.precision).toBeNull();
    expect(deriveThresholdSuggestion(curve, 0.9, 0)).toBe(0.5);
  });

  it("never suggests below the hard minimum -- an at-minimum bucket floor is the loosest candidate", () => {
    const curve = curveOf(5, [
      [0, 0.5, 5, 0],
      [0.5, 1, 5, 0],
    ]);
    // Floor 0 qualifies on evidence but sits below the hard minimum, so the at-minimum floor 0.5 is suggested.
    expect(deriveThresholdSuggestion(curve, 0.9, 0.5)).toBe(0.5);
  });

  it("excludes a bucket's floor as a candidate when the hard minimum falls inside the bucket", () => {
    const curve = curveOf(5, [
      [0.5, 0.7, 5, 0],
      [0.7, 1, 5, 0],
    ]);
    expect(deriveThresholdSuggestion(curve, 0.9, 0.6)).toBe(0.7);
  });

  it("returns null when the only qualifying floors sit below the hard minimum", () => {
    // Pooled from 0: 9/10 = 0.9 qualifies; pooled from 0.5 alone: 4/5 = 0.8 does not. No clamping up.
    const curve = curveOf(5, [
      [0, 0.5, 5, 0],
      [0.5, 1, 4, 1],
    ]);
    expect(deriveThresholdSuggestion(curve, 0.9, 0.5)).toBeNull();
  });

  it("returns null when pooled density is insufficient everywhere (N/A over a fabricated qualifier)", () => {
    const curve = curveOf(5, [
      [0, 0.5, 2, 0],
      [0.5, 1, 2, 0],
    ]);
    // Every pooled window has 4 < 5 cases: perfect-looking precision, but the evidence is too thin to act on.
    expect(deriveThresholdSuggestion(curve, 0.5, 0)).toBeNull();
  });

  it("returns null when no pooled window meets the target precision", () => {
    const curve = curveOf(5, [
      [0, 0.5, 3, 2],
      [0.5, 1, 3, 2],
    ]);
    expect(deriveThresholdSuggestion(curve, 0.95, 0)).toBeNull();
  });

  it("returns null for an empty-corpus curve", () => {
    expect(deriveThresholdSuggestion(computeReliabilityCurve([], [0, 0.5, 1], 5), 0.5, 0)).toBeNull();
  });

  it("throws when targetPrecision or hardMinimum is outside [0, 1] (NaN fails closed)", () => {
    const curve = curveOf(1, [[0, 1, 1, 0]]);
    expect(() => deriveThresholdSuggestion(curve, -0.1, 0)).toThrow(/invalid_target_precision/);
    expect(() => deriveThresholdSuggestion(curve, 1.5, 0)).toThrow(/invalid_target_precision/);
    expect(() => deriveThresholdSuggestion(curve, Number.NaN, 0)).toThrow(/invalid_target_precision/);
    expect(() => deriveThresholdSuggestion(curve, 0.9, -0.1)).toThrow(/invalid_hard_minimum/);
    expect(() => deriveThresholdSuggestion(curve, 0.9, 1.5)).toThrow(/invalid_hard_minimum/);
    expect(() => deriveThresholdSuggestion(curve, 0.9, Number.NaN)).toThrow(/invalid_hard_minimum/);
  });

  it("invariant: as the target rises the suggestion only tightens, never dips below the hard minimum, and is always a bucket floor", () => {
    const curve = curveOf(3, [
      [0, 0.3, 2, 3],
      [0.3, 0.5, 3, 2],
      [0.5, 0.7, 4, 1],
      [0.7, 0.9, 4, 0],
      [0.9, 1, 3, 0],
    ]);
    const floors = curve.buckets.map((bucket) => bucket.floor);
    for (const hardMinimum of [0, 0.3, 0.5, 0.9]) {
      let previous = -Infinity;
      for (const target of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1]) {
        const suggestion = deriveThresholdSuggestion(curve, target, hardMinimum);
        const effective = suggestion ?? Infinity; // null = "no floor qualifies" = tighter than any floor
        expect(effective).toBeGreaterThanOrEqual(previous);
        if (suggestion !== null) {
          expect(suggestion).toBeGreaterThanOrEqual(hardMinimum);
          expect(floors).toContain(suggestion);
        }
        previous = effective;
      }
    }
  });
});
