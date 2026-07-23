import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeReliabilityCurve,
  deriveThresholdSuggestion,
  DEFAULT_RELIABILITY_BUCKET_EDGES,
  RELIABILITY_BUCKET_SAMPLE_FLOOR,
  type BacktestCase,
  type ReliabilityCurve,
} from "../dist/index.js";

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

test("barrel: the public entrypoint re-exports the reliability-curve primitives (#8226)", () => {
  assert.equal(typeof computeReliabilityCurve, "function");
  assert.equal(typeof deriveThresholdSuggestion, "function");
  assert.ok(Array.isArray(DEFAULT_RELIABILITY_BUCKET_EDGES));
  assert.equal(typeof RELIABILITY_BUCKET_SAMPLE_FLOOR, "number");
});

test("computeReliabilityCurve: buckets decided cases by claimed confidence and reports per-bucket precision", () => {
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
  assert.deepEqual(curve, {
    sampleFloor: 1,
    buckets: [
      { floor: 0, ceiling: 0.5, cases: 2, confirmed: 1, reversed: 1, precision: 0.5 },
      { floor: 0.5, ceiling: 1, cases: 3, confirmed: 2, reversed: 1, precision: 2 / 3 },
    ],
  });
});

test("computeReliabilityCurve: uses the documented default edges and sample floor when omitted", () => {
  const curve = computeReliabilityCurve([caseWith("confirmed", 0.95)]);
  assert.equal(curve.sampleFloor, RELIABILITY_BUCKET_SAMPLE_FLOOR);
  assert.deepEqual(
    curve.buckets.map((bucket) => bucket.floor),
    DEFAULT_RELIABILITY_BUCKET_EDGES.slice(0, -1),
  );
  assert.deepEqual(
    curve.buckets.map((bucket) => bucket.ceiling),
    DEFAULT_RELIABILITY_BUCKET_EDGES.slice(1),
  );
  // Every registry candidate ladder value (loosening-knobs.ts) is a landable bucket floor by default.
  for (const registryValue of [0.3, 0.35, 0.4, 0.45, 0.85, 0.9]) {
    assert.ok(curve.buckets.some((bucket) => bucket.floor === registryValue), `no bucket floor at ${registryValue}`);
  }
  const top = curve.buckets[curve.buckets.length - 1]!;
  assert.deepEqual([top.floor, top.ceiling], [0.95, 1]);
  assert.equal(top.cases, 1);
  // 1 case sits below the default sample floor of 5 -> null, never a fabricated 1.0 precision.
  assert.equal(top.precision, null);
});

test("computeReliabilityCurve: an interior edge is floor-inclusive -- a claim exactly at it lands in the higher bucket", () => {
  const curve = computeReliabilityCurve([caseWith("confirmed", 0.5)], [0, 0.5, 1], 1);
  assert.equal(curve.buckets[0]!.cases, 0);
  assert.equal(curve.buckets[1]!.cases, 1);
});

test("computeReliabilityCurve: the first edge is inclusive and the TOP edge is ceiling-inclusive", () => {
  const curve = computeReliabilityCurve([caseWith("confirmed", 0), caseWith("reversed", 1)], [0, 0.5, 1], 1);
  assert.equal(curve.buckets[0]!.cases, 1);
  assert.equal(curve.buckets[1]!.cases, 1);
});

test("computeReliabilityCurve: drops cases with no numeric claimed confidence instead of fabricating one (diverges from #8138's degrade-to-1)", () => {
  const curve = computeReliabilityCurve(
    [
      caseWith("confirmed"), // no metadata at all
      { ...caseWith("confirmed"), metadata: {} }, // metadata without confidence
      caseWith("confirmed", "high"), // non-numeric claim
    ],
    [0, 0.5, 1],
    1,
  );
  assert.deepEqual(
    curve.buckets.map((bucket) => bucket.cases),
    [0, 0],
  );
});

test("computeReliabilityCurve: drops out-of-range and NaN claims, never clamping them into a bucket", () => {
  const curve = computeReliabilityCurve(
    [caseWith("confirmed", -0.1), caseWith("confirmed", 1.5), caseWith("confirmed", Number.NaN)],
    [0, 0.5, 1],
    1,
  );
  assert.deepEqual(
    curve.buckets.map((bucket) => bucket.cases),
    [0, 0],
  );
});

test("computeReliabilityCurve: a bucket below the sample floor reports null precision, never 0", () => {
  const curve = computeReliabilityCurve(
    [caseWith("reversed", 0.7), caseWith("reversed", 0.7)],
    [0, 0.5, 1],
    3,
  );
  // 2 all-reversed cases: a coerced precision would read 0 -- the N/A-over-zero rule keeps it null.
  assert.equal(curve.buckets[1]!.cases, 2);
  assert.equal(curve.buckets[1]!.precision, null);
});

test("computeReliabilityCurve: a bucket exactly AT the sample floor reports its real precision", () => {
  const curve = computeReliabilityCurve(
    [caseWith("confirmed", 0.7), caseWith("confirmed", 0.8), caseWith("reversed", 0.9)],
    [0, 0.5, 1],
    3,
  );
  assert.equal(curve.buckets[1]!.precision, 2 / 3);
});

test("computeReliabilityCurve: an empty corpus yields all-zero buckets with null precision everywhere", () => {
  const curve = computeReliabilityCurve([], [0, 0.5, 1], 1);
  assert.deepEqual(curve.buckets, [
    { floor: 0, ceiling: 0.5, cases: 0, confirmed: 0, reversed: 0, precision: null },
    { floor: 0.5, ceiling: 1, cases: 0, confirmed: 0, reversed: 0, precision: null },
  ]);
});

test("computeReliabilityCurve: throws on malformed bucket edges", () => {
  assert.throws(() => computeReliabilityCurve([], [0.5], 1), /invalid_bucket_edges/);
  assert.throws(() => computeReliabilityCurve([], [0, 0.5, 0.5, 1], 1), /invalid_bucket_edges/);
  assert.throws(() => computeReliabilityCurve([], [0, 0.7, 0.5, 1], 1), /invalid_bucket_edges/);
  assert.throws(() => computeReliabilityCurve([], [-0.1, 0.5, 1], 1), /invalid_bucket_edges/);
  assert.throws(() => computeReliabilityCurve([], [0, 0.5, 1.5], 1), /invalid_bucket_edges/);
  assert.throws(() => computeReliabilityCurve([], [0, Number.NaN, 1], 1), /invalid_bucket_edges/);
});

test("computeReliabilityCurve: throws on a sample floor below 1 (NaN fails closed into the throw)", () => {
  assert.throws(() => computeReliabilityCurve([], [0, 1], 0), /invalid_sample_floor/);
  assert.throws(() => computeReliabilityCurve([], [0, 1], Number.NaN), /invalid_sample_floor/);
});

test("computeReliabilityCurve: deterministic -- identical inputs yield an equal curve", () => {
  const cases = [caseWith("confirmed", 0.4), caseWith("reversed", 0.8)];
  assert.deepEqual(computeReliabilityCurve(cases, [0, 0.5, 1], 1), computeReliabilityCurve(cases, [0, 0.5, 1], 1));
});

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

test("deriveThresholdSuggestion: suggests the LOOSEST floor whose at-or-above pooled precision meets the target", () => {
  // Pooled from 0: (4 + 5 confirmed) / 10 = 0.9 -- already at target, so the loosest floor wins.
  const curve = curveOf(5, [
    [0, 0.5, 4, 1],
    [0.5, 1, 5, 0],
  ]);
  assert.equal(deriveThresholdSuggestion(curve, 0.9, 0), 0);
});

test("deriveThresholdSuggestion: a weak low bucket dilutes the pool and pushes the suggestion up", () => {
  // Pooled from 0: 6/10 = 0.6 < 0.9; pooled from 0.5: 5/5 = 1 >= 0.9.
  const curve = curveOf(5, [
    [0, 0.5, 1, 4],
    [0.5, 1, 5, 0],
  ]);
  assert.equal(deriveThresholdSuggestion(curve, 0.9, 0), 0.5);
});

test("deriveThresholdSuggestion: buckets below the per-bucket sample floor still contribute raw counts to the pool", () => {
  // Each bucket alone is below the floor of 5 (3 and 4 cases -> null bucket precision), but the pooled
  // window from 0.5 has 7 cases -- enough density for a real, qualifying pooled precision.
  const curve = curveOf(5, [
    [0.5, 0.8, 3, 0],
    [0.8, 1, 4, 0],
  ]);
  assert.equal(curve.buckets[0]!.precision, null);
  assert.equal(curve.buckets[1]!.precision, null);
  assert.equal(deriveThresholdSuggestion(curve, 0.9, 0), 0.5);
});

test("deriveThresholdSuggestion: never suggests below the hard minimum -- an at-minimum bucket floor is the loosest candidate", () => {
  const curve = curveOf(5, [
    [0, 0.5, 5, 0],
    [0.5, 1, 5, 0],
  ]);
  // Floor 0 qualifies on evidence but sits below the hard minimum, so the at-minimum floor 0.5 is suggested.
  assert.equal(deriveThresholdSuggestion(curve, 0.9, 0.5), 0.5);
});

test("deriveThresholdSuggestion: a hard minimum inside a bucket excludes that bucket's floor as a candidate", () => {
  const curve = curveOf(5, [
    [0.5, 0.7, 5, 0],
    [0.7, 1, 5, 0],
  ]);
  assert.equal(deriveThresholdSuggestion(curve, 0.9, 0.6), 0.7);
});

test("deriveThresholdSuggestion: null when the only qualifying floors sit below the hard minimum", () => {
  // Pooled from 0: 9/10 = 0.9 qualifies; pooled from 0.5 alone: 4/5 = 0.8 does not. No clamping up.
  const curve = curveOf(5, [
    [0, 0.5, 5, 0],
    [0.5, 1, 4, 1],
  ]);
  assert.equal(deriveThresholdSuggestion(curve, 0.9, 0.5), null);
});

test("deriveThresholdSuggestion: null when pooled density is insufficient everywhere (N/A over a fabricated qualifier)", () => {
  const curve = curveOf(5, [
    [0, 0.5, 2, 0],
    [0.5, 1, 2, 0],
  ]);
  // Every pooled window has 4 < 5 cases: perfect-looking precision, but the evidence is too thin to act on.
  assert.equal(deriveThresholdSuggestion(curve, 0.5, 0), null);
});

test("deriveThresholdSuggestion: null when no pooled window meets the target precision", () => {
  const curve = curveOf(5, [
    [0, 0.5, 3, 2],
    [0.5, 1, 3, 2],
  ]);
  assert.equal(deriveThresholdSuggestion(curve, 0.95, 0), null);
});

test("deriveThresholdSuggestion: null for an empty-corpus curve", () => {
  assert.equal(deriveThresholdSuggestion(computeReliabilityCurve([], [0, 0.5, 1], 5), 0.5, 0), null);
});

test("deriveThresholdSuggestion: throws when targetPrecision or hardMinimum is outside [0, 1] (NaN fails closed)", () => {
  const curve = curveOf(1, [[0, 1, 1, 0]]);
  assert.throws(() => deriveThresholdSuggestion(curve, -0.1, 0), /invalid_target_precision/);
  assert.throws(() => deriveThresholdSuggestion(curve, 1.5, 0), /invalid_target_precision/);
  assert.throws(() => deriveThresholdSuggestion(curve, Number.NaN, 0), /invalid_target_precision/);
  assert.throws(() => deriveThresholdSuggestion(curve, 0.9, -0.1), /invalid_hard_minimum/);
  assert.throws(() => deriveThresholdSuggestion(curve, 0.9, 1.5), /invalid_hard_minimum/);
  assert.throws(() => deriveThresholdSuggestion(curve, 0.9, Number.NaN), /invalid_hard_minimum/);
});

test("deriveThresholdSuggestion: invariant -- as the target rises the suggestion only tightens (never loosens), never dips below the hard minimum, and is always a bucket floor", () => {
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
      assert.ok(effective >= previous, `target ${target} loosened the suggestion (${suggestion}) under minimum ${hardMinimum}`);
      if (suggestion !== null) {
        assert.ok(suggestion >= hardMinimum, `suggestion ${suggestion} fell below the hard minimum ${hardMinimum}`);
        assert.ok(floors.includes(suggestion), `suggestion ${suggestion} is not one of the curve's bucket floors`);
      }
      previous = effective;
    }
  }
});
