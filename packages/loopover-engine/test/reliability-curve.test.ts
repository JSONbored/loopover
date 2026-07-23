import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeReliabilityCurve,
  DEFAULT_RELIABILITY_BUCKET_EDGES,
  deriveThresholdSuggestion,
  type BacktestCase,
} from "../dist/index.js";

function labeled(confidence: number, label: BacktestCase["label"], key: string): BacktestCase {
  return {
    ruleId: "ai_consensus_defect",
    targetKey: `acme/widgets${key}`,
    outcome: "close",
    label,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
    metadata: { confidence },
  };
}

test("barrel: the public entrypoint re-exports the reliability-curve primitives (#8226)", () => {
  assert.equal(typeof computeReliabilityCurve, "function");
  assert.equal(typeof deriveThresholdSuggestion, "function");
  assert.ok(DEFAULT_RELIABILITY_BUCKET_EDGES.length > 0);
});

test("curve + suggestion round-trip: buckets carry empirical precision and the loosest qualifying floor falls out", () => {
  const cases = [
    ...Array.from({ length: 10 }, (_, i) => labeled(0.87, i < 6 ? "confirmed" : "reversed", `#a${i}`)),
    ...Array.from({ length: 10 }, (_, i) => labeled(0.97, i < 10 ? "confirmed" : "reversed", `#b${i}`)),
  ];
  const curve = computeReliabilityCurve(cases);
  const band = curve.find((bucket) => bucket.from === 0.85)!;
  assert.equal(band.cases, 10);
  assert.equal(band.precision, 0.6);
  const top = curve[curve.length - 1]!;
  assert.equal(top.precision, 1);
  // Pooled from the (empty) 0.9 bucket up is 10/10 = 1 — the loosest floor meeting a 0.99 target; pooled
  // from 0.85 ((6+10)/20 = 0.8) meets 0.75.
  assert.equal(deriveThresholdSuggestion(curve, 0.99, 0), 0.9);
  assert.equal(deriveThresholdSuggestion(curve, 0.75, 0), 0);
  assert.equal(deriveThresholdSuggestion(curve, 0.75, 0.6), 0.6);
});

test("null discipline: empty buckets and unmet targets report null, never 0", () => {
  const curve = computeReliabilityCurve([]);
  for (const bucket of curve) assert.equal(bucket.precision, null);
  assert.equal(deriveThresholdSuggestion(curve, 0.5, 0), null);
});
