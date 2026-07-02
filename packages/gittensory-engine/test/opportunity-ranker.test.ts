// Units for the opportunity ranker (#2302). Runs against the compiled dist/ (built by the `test` script first),
// mirroring the review-enrichment package's node:test convention. Imports through the package's public barrel
// (dist/index.js) so the export contract itself is exercised. Pure module — no network, never flakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankOpportunityScore, rankOpportunities } from "../dist/index.js";

test("barrel: the public entrypoint re-exports the ranker API", () => {
  assert.equal(typeof rankOpportunityScore, "function");
  assert.equal(typeof rankOpportunities, "function");
});

const full = { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 };

/** Product of floats isn't bit-exact (0.5*0.8*0.5*0.8 = 0.16000000000000003), so compare within a tolerance. */
const closeTo = (actual: number, expected: number): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);

test("rankOpportunityScore: all factors at max, no dup risk → 1", () => {
  assert.equal(rankOpportunityScore(full), 1);
});

test("rankOpportunityScore: composes the five signals as a product", () => {
  // 0.5 * 0.8 * 0.5 * 1 * (1 - 0.2) = 0.16
  closeTo(
    rankOpportunityScore({ potential: 0.5, feasibility: 0.8, laneFit: 0.5, freshness: 1, dupRisk: 0.2 }),
    0.16,
  );
});

test("rankOpportunityScore: any single factor at 0 collapses the score to 0", () => {
  for (const field of ["potential", "feasibility", "laneFit", "freshness"] as const) {
    assert.equal(rankOpportunityScore({ ...full, [field]: 0 }), 0, `${field}=0 must zero the score`);
  }
});

test("rankOpportunityScore: a dupRisk of exactly 1 zeroes the score", () => {
  assert.equal(rankOpportunityScore({ ...full, dupRisk: 1 }), 0);
});

const POSITIVE_FACTORS = ["potential", "feasibility", "laneFit", "freshness"] as const;
const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

test("rankOpportunityScore: every positive factor clamps out-of-range/non-finite input, never passing it raw", () => {
  for (const field of POSITIVE_FACTORS) {
    // Over-max clamps to 1 → unchanged from the all-max baseline of 1.
    assert.equal(rankOpportunityScore({ ...full, [field]: 5 }), 1, `${field}>1 must clamp to 1`);
    // Negative clamps to 0 → collapses the product (never a negative / sign-inverted score).
    assert.equal(rankOpportunityScore({ ...full, [field]: -3 }), 0, `${field}<0 must clamp to 0`);
    // Non-finite degrades to 0 → collapses the product (never NaN).
    for (const bad of NON_FINITE) {
      assert.equal(rankOpportunityScore({ ...full, [field]: bad }), 0, `${field}=${bad} must degrade to 0`);
    }
  }
});

test("rankOpportunityScore: dupRisk clamps finite values; only a non-finite value fails closed", () => {
  closeTo(rankOpportunityScore({ ...full, dupRisk: 0.25 }), 0.75); // in-range penalty applies: 1 - 0.25
  // A FINITE out-of-range dupRisk is clamped like every field: above-range → 1 (full penalty → score 0),
  // below-range → 0 (no penalty → score 1). So -0.1 reads as no contention, matching the documented formula.
  assert.equal(rankOpportunityScore({ ...full, dupRisk: 1.4 }), 0);
  assert.equal(rankOpportunityScore({ ...full, dupRisk: -0.1 }), 1);
  assert.equal(rankOpportunityScore({ ...full, dupRisk: -2 }), 1);
  // A NON-finite dupRisk can't be clamped, so it fails closed to MAX risk (1) → (1 - 1) = 0: a broken contention
  // signal must not look safe. This is the one asymmetry vs the positive factors, which degrade to 0.
  for (const bad of NON_FINITE) {
    assert.equal(rankOpportunityScore({ ...full, dupRisk: bad }), 0, `dupRisk=${bad} must fail closed to 0`);
  }
});

test("rankOpportunities: sorts descending by score and annotates rankScore", () => {
  const ranked = rankOpportunities([
    { id: "low", potential: 0.2, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 },
    { id: "high", potential: 0.9, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 },
    { id: "mid", potential: 0.5, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 },
  ]);
  assert.deepEqual(ranked.map((c) => c.id), ["high", "mid", "low"]);
  assert.equal(ranked[0]!.rankScore, 0.9);
});

test("rankOpportunities: equal scores keep input order (stable tie-break)", () => {
  const tie = { potential: 0.5, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 };
  const ranked = rankOpportunities([
    { id: "a", ...tie },
    { id: "b", ...tie },
    { id: "c", ...tie },
  ]);
  assert.deepEqual(ranked.map((c) => c.id), ["a", "b", "c"]);
});

test("rankOpportunities: does not mutate the input array or its elements", () => {
  const input = [{ id: "x", ...full }];
  const snapshot = JSON.parse(JSON.stringify(input));
  rankOpportunities(input);
  assert.deepEqual(input, snapshot); // no rankScore leaked back onto the source
});

test("rankOpportunities: a stale rankScore on the input is overwritten with the computed score", () => {
  const ranked = rankOpportunities([{ id: "x", rankScore: 999, ...full }]);
  assert.equal(ranked[0]!.rankScore, 1); // the freshly computed score wins; the caller's stale value is discarded
});

test("rankOpportunities: an empty list ranks to an empty list", () => {
  assert.deepEqual(rankOpportunities([]), []);
});
