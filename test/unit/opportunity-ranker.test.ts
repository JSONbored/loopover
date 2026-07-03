import { describe, expect, it } from "vitest";
import { rankOpportunities, rankOpportunityScore, type OpportunityRankInput } from "../../packages/gittensory-engine/src/opportunity-ranker";

// A neutral, all-passing candidate (every factor 1, no contention → score 1); tests override one field at a time.
function input(over: Partial<OpportunityRankInput> = {}): OpportunityRankInput {
  return { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0, ...over };
}

// The four positive factors behave identically (each is clamped and multiplied in); the tables below drive one law
// across all of them at once. This is a hand-maintained list: a new positive factor must be added here for these
// same laws to cover it.
const POSITIVE_FACTORS = ["potential", "feasibility", "laneFit", "freshness"] as const;

describe("rankOpportunityScore", () => {
  it("multiplies the four clamped positive factors by (1 - dupRisk)", () => {
    expect(rankOpportunityScore(input())).toBe(1);
    expect(rankOpportunityScore(input({ potential: 0.5, freshness: 0.5, dupRisk: 0.5 }))).toBeCloseTo(0.125, 10);
  });

  it.each(POSITIVE_FACTORS)("collapses the whole score to 0 when %s is 0", (factor) => {
    expect(rankOpportunityScore(input({ [factor]: 0 }))).toBe(0);
  });

  it("fully suppresses the score when dupRisk is exactly 1", () => {
    expect(rankOpportunityScore(input({ dupRisk: 1 }))).toBe(0);
  });

  const SWEEP = [0, 0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 1];

  it.each(POSITIVE_FACTORS)("is monotonic non-decreasing in %s across a rising sweep (others fixed)", (factor) => {
    const scores = SWEEP.map((v) => rankOpportunityScore(input({ [factor]: v, dupRisk: 0.1 })));
    // Raising the factor from 0 to 1 must never lower the score: the score list is already ascending, and strictly
    // rises from the first sweep point to the last.
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(scores[scores.length - 1]).toBeGreaterThan(scores[0] ?? 0);
  });

  it("is monotonic non-increasing in dupRisk across a rising sweep (more contention never raises the score)", () => {
    const scores = SWEEP.map((v) => rankOpportunityScore(input({ dupRisk: v })));
    // Raising dupRisk must never raise the score: the score list is already descending, and strictly falls end to end.
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[scores.length - 1]).toBeLessThan(scores[0] ?? 0);
  });

  it.each(POSITIVE_FACTORS)("clamps %s below 0 to 0 and above 1 to 1", (factor) => {
    expect(rankOpportunityScore(input({ [factor]: -0.5 }))).toBe(0);
    expect(rankOpportunityScore(input({ [factor]: 1.5 }))).toBe(1); // clamped to 1, other factors already 1
  });

  it("clamps a finite dupRisk: below 0 reads as no contention, above 1 as full contention", () => {
    expect(rankOpportunityScore(input({ dupRisk: -0.1 }))).toBe(1); // (1 - 0)
    expect(rankOpportunityScore(input({ dupRisk: 1.4 }))).toBe(0); // (1 - 1)
  });

  it.each(POSITIVE_FACTORS)("degrades %s to 0 for a non-finite value", (factor) => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(rankOpportunityScore(input({ [factor]: bad }))).toBe(0);
    }
  });

  it("fails closed to maximum risk (score 0) for a non-finite dupRisk", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(rankOpportunityScore(input({ dupRisk: bad }))).toBe(0);
    }
  });

  // Property table: the ranker is pure and forbids randomness, so instead of seeded random draws this pins a fixed
  // set of varied inputs with independently hand-computed expected scores — deterministic and reproducible — so the
  // product and clamp/fail-closed rules are exercised across the whole [0,1] range (and past its edges) at once.
  const CASES: Array<{ in: OpportunityRankInput; score: number }> = [
    { in: input(), score: 1 },
    { in: input({ dupRisk: 0.5 }), score: 0.5 },
    { in: input({ potential: 0.5 }), score: 0.5 },
    { in: input({ potential: 0.5, feasibility: 0.5 }), score: 0.25 },
    { in: input({ potential: 0.5, feasibility: 0.5, laneFit: 0.5, freshness: 0.5 }), score: 0.0625 },
    { in: input({ freshness: 0.25, dupRisk: 0.2 }), score: 0.2 },
    { in: input({ potential: 0.8, feasibility: 0.5, laneFit: 0.5, freshness: 0.5, dupRisk: 0.5 }), score: 0.05 },
    { in: input({ laneFit: 0 }), score: 0 },
    { in: input({ dupRisk: 1 }), score: 0 },
    { in: input({ potential: 2, feasibility: 2 }), score: 1 }, // both clamp to 1
    { in: input({ potential: -1 }), score: 0 },
    { in: input({ freshness: NaN }), score: 0 },
    { in: input({ dupRisk: Infinity }), score: 0 },
    { in: input({ dupRisk: -5 }), score: 1 }, // clamps to 0 contention
    { in: input({ potential: 0.1, feasibility: 0.1, laneFit: 0.1, freshness: 0.1, dupRisk: 0 }), score: 0.0001 },
    { in: input({ potential: 0.9, feasibility: 0.9, laneFit: 0.9, freshness: 0.9, dupRisk: 0.1 }), score: 0.59049 }, // 0.9^4 * 0.9
    { in: input({ potential: 0.75, dupRisk: 0.25 }), score: 0.5625 }, // 0.75 * 0.75
    { in: input({ feasibility: 0.4, freshness: 0.5 }), score: 0.2 },
    { in: input({ potential: 0.6, laneFit: 0.5, dupRisk: 0.5 }), score: 0.15 },
    { in: input({ potential: 0, dupRisk: 1 }), score: 0 },
  ];

  it.each(CASES)("scores $in.potential/$in.feasibility/$in.laneFit/$in.freshness dup=$in.dupRisk as $score", ({ in: value, score }) => {
    expect(rankOpportunityScore(value)).toBeCloseTo(score, 10);
  });
});

describe("rankOpportunities", () => {
  it("returns candidates in descending score order, annotated with rankScore", () => {
    const candidates = [
      { id: "mid", ...input({ potential: 0.5 }) }, // 0.5
      { id: "top", ...input() }, // 1.0
      { id: "low", ...input({ freshness: 0.25 }) }, // 0.25
      { id: "weak", ...input({ potential: 0.5, feasibility: 0.5, laneFit: 0.5 }) }, // 0.125
      { id: "bottom", ...input({ potential: 0.5, feasibility: 0.5, laneFit: 0.5, freshness: 0.5 }) }, // 0.0625
    ];
    const ranked = rankOpportunities(candidates);
    expect(ranked.map((c) => c.id)).toEqual(["top", "mid", "low", "weak", "bottom"]);
    expect(ranked.map((c) => c.rankScore)).toEqual([1, 0.5, 0.25, 0.125, 0.0625]);
  });

  it("breaks an exact score tie by input order (stable), even for differently-shaped candidates", () => {
    const candidates = [
      { id: "tieByPotential", ...input({ potential: 0.5 }) }, // 0.5
      { id: "tieByDupRisk", ...input({ dupRisk: 0.5 }) }, // 0.5
      { id: "winner", ...input() }, // 1.0
    ];
    const ranked = rankOpportunities(candidates);
    // Both tie candidates score 0.5 and the earlier input wins the tie, so the score list pins the ordering.
    expect(ranked.map((c) => c.id)).toEqual(["winner", "tieByPotential", "tieByDupRisk"]);
    expect(ranked.map((c) => c.rankScore)).toEqual([1, 0.5, 0.5]);
  });

  it("does not mutate the input array or its elements", () => {
    const candidates = [{ id: "a", ...input({ potential: 0.5 }) }];
    const snapshot = structuredClone(candidates);
    rankOpportunities(candidates);
    expect(candidates).toEqual(snapshot);
  });

  it("replaces any rankScore already present on an input element", () => {
    const ranked = rankOpportunities([{ id: "a", rankScore: 999, ...input({ potential: 0.5 }) }]);
    expect(ranked.map((c) => c.rankScore)).toEqual([0.5]);
  });

  it("returns an empty array for no candidates", () => {
    expect(rankOpportunities([])).toEqual([]);
  });
});
