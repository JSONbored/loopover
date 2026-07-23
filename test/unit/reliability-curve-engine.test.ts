import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / repo-corpus-engine.test.ts.
import {
  computeReliabilityCurve,
  DEFAULT_RELIABILITY_BUCKET_EDGES,
  deriveThresholdSuggestion,
} from "../../packages/loopover-engine/src/calibration/reliability-curve";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

function labeled(confidence: number | undefined, label: BacktestCase["label"], key = `t#${Math.trunc((confidence ?? 0) * 1000)}`): BacktestCase {
  return {
    ruleId: "ai_consensus_defect",
    targetKey: `acme/widgets${key}`,
    outcome: "close",
    label,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
    ...(confidence !== undefined ? { metadata: { confidence } } : {}),
  };
}

describe("computeReliabilityCurve (#8226)", () => {
  it("buckets decided cases by claimed confidence on the documented default edges, with per-bucket empirical precision", () => {
    const curve = computeReliabilityCurve([
      labeled(0.97, "confirmed", "#1"),
      labeled(0.97, "confirmed", "#2"),
      labeled(0.96, "reversed", "#3"),
      labeled(0.87, "reversed", "#4"),
      labeled(0.3, "confirmed", "#5"),
    ]);
    expect(curve.map((bucket) => [bucket.from, bucket.to])).toEqual([
      [0, 0.5],
      [0.5, 0.6],
      [0.6, 0.7],
      [0.7, 0.8],
      [0.8, 0.85],
      [0.85, 0.9],
      [0.9, 0.95],
      [0.95, 1],
    ]);
    const top = curve[curve.length - 1]!;
    expect(top).toMatchObject({ cases: 3, confirmed: 2, reversed: 1, precision: 2 / 3 });
    expect(curve.find((bucket) => bucket.from === 0.85)).toMatchObject({ cases: 1, confirmed: 0, reversed: 1, precision: 0 });
    expect(curve[0]).toMatchObject({ cases: 1, confirmed: 1, precision: 1 });
  });

  it("reports null (never 0) precision for an empty bucket, and lands confidence 1.0 in the final inclusive bucket", () => {
    const curve = computeReliabilityCurve([labeled(1, "confirmed", "#1")]);
    expect(curve[curve.length - 1]).toMatchObject({ cases: 1, precision: 1 });
    for (const bucket of curve.slice(0, -1)) {
      expect(bucket.cases).toBe(0);
      expect(bucket.precision).toBeNull();
    }
  });

  it("excludes cases with a missing, non-numeric, or out-of-range claimed confidence — never guessed into a bucket", () => {
    const curve = computeReliabilityCurve([
      labeled(undefined, "confirmed", "#1"),
      { ...labeled(0.9, "confirmed", "#2"), metadata: { confidence: "high" } },
      labeled(1.5, "confirmed", "#3"),
      labeled(-0.1, "confirmed", "#4"),
      labeled(0.92, "reversed", "#5"),
    ]);
    expect(curve.reduce((sum, bucket) => sum + bucket.cases, 0)).toBe(1);
    expect(curve.find((bucket) => bucket.from === 0.9)).toMatchObject({ cases: 1, reversed: 1 });
  });

  it("honors caller-supplied bucket edges and is deterministic for identical input", () => {
    const cases = [labeled(0.25, "confirmed", "#1"), labeled(0.75, "reversed", "#2")];
    const curve = computeReliabilityCurve(cases, [0, 0.5]);
    expect(curve.map((bucket) => [bucket.from, bucket.to, bucket.cases])).toEqual([
      [0, 0.5, 1],
      [0.5, 1, 1],
    ]);
    expect(computeReliabilityCurve(cases, [0, 0.5])).toEqual(curve);
  });
});

describe("deriveThresholdSuggestion (#8226)", () => {
  // A monotone corpus: the higher the claimed confidence, the more precise the rule empirically was.
  const monotone = [
    ...Array.from({ length: 10 }, (_, i) => labeled(0.55, i < 4 ? "confirmed" : "reversed", `#a${i}`)), // 0.4
    ...Array.from({ length: 10 }, (_, i) => labeled(0.82, i < 7 ? "confirmed" : "reversed", `#b${i}`)), // 0.7
    ...Array.from({ length: 10 }, (_, i) => labeled(0.92, i < 9 ? "confirmed" : "reversed", `#c${i}`)), // 0.9
    ...Array.from({ length: 10 }, (_, i) => labeled(0.97, i < 10 ? "confirmed" : "reversed", `#d${i}`)), // 1.0
  ];
  const curve = computeReliabilityCurve(monotone);

  it("suggests the LOOSEST floor whose pooled at-or-above precision meets the target", () => {
    // Pooled from 0.6 up already excludes the noisy 0.55 bucket: (7+9+10)/30 ≈ 0.867 meets a 0.85 target,
    // and the empty 0.6–0.8 buckets make 0.6 the LOOSEST equivalent floor — not 0.8.
    expect(deriveThresholdSuggestion(curve, 0.85, 0)).toBe(0.6);
    // A stricter 0.95 target: pooling from the (empty) 0.85 bucket up gives (9+10)/20 = 0.95 exactly, so
    // 0.85 is the loosest qualifying edge — the empty band widens the suggestion, it never blocks it.
    expect(deriveThresholdSuggestion(curve, 0.95, 0)).toBe(0.85);
  });

  it("never suggests below the hard minimum even when a looser floor would meet the target", () => {
    expect(deriveThresholdSuggestion(curve, 0.85, 0.85)).toBe(0.85);
  });

  it("monotonicity invariant: a stricter target never yields a looser suggestion", () => {
    const targets = [0.5, 0.7, 0.85, 0.95, 1];
    const suggestions = targets.map((target) => deriveThresholdSuggestion(curve, target, 0));
    for (let i = 1; i < suggestions.length; i += 1) {
      const previous = suggestions[i - 1];
      const current = suggestions[i];
      if (typeof previous === "number" && typeof current === "number") expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  it("returns null when no candidate meets the target, and for an undecided (insufficient-density) curve", () => {
    expect(deriveThresholdSuggestion(curve, 1.01, 0)).toBeNull(); // nothing can pool above 1
    expect(deriveThresholdSuggestion(computeReliabilityCurve([]), 0.5, 0)).toBeNull(); // no decided cases anywhere
  });

  it("skips an insufficient-density candidate (empty pooled slice) instead of treating it as qualifying", () => {
    // Only sub-0.5 evidence exists: every candidate at/above 0.5 pools zero decided cases and is skipped.
    const lowOnly = computeReliabilityCurve([labeled(0.2, "confirmed", "#1")]);
    expect(deriveThresholdSuggestion(lowOnly, 0.5, 0.5)).toBeNull();
  });
});
