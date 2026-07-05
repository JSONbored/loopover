import { describe, expect, it } from "vitest";

import { bestRankedOpportunityAtOrAboveScore } from "../../packages/gittensory-engine/src/ranked-opportunity-best-min-score";
import type { OpportunityRankInput } from "../../packages/gittensory-engine/src/opportunity-ranker";

function input(over: Partial<OpportunityRankInput> = {}): OpportunityRankInput {
  return { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0, ...over };
}

describe("bestRankedOpportunityAtOrAboveScore", () => {
  const candidates = [
    { id: "low", ...input({ potential: 0.2 }) },
    { id: "mid", ...input({ potential: 0.5 }) },
    { id: "top", ...input() },
    { id: "weak", ...input({ potential: 0.5, feasibility: 0.5, laneFit: 0.5 }) },
  ];

  it("returns null for an empty candidate list", () => {
    expect(bestRankedOpportunityAtOrAboveScore([], 0.5)).toBeNull();
  });

  it("returns null when the score threshold excludes every candidate", () => {
    expect(
      bestRankedOpportunityAtOrAboveScore(
        [
          { id: "a", ...input({ potential: 0.2 }) },
          { id: "b", ...input({ potential: 0.3 }) },
        ],
        0.5,
      ),
    ).toBeNull();
  });

  it("returns null for a non-finite threshold", () => {
    expect(bestRankedOpportunityAtOrAboveScore(candidates, Number.NaN)).toBeNull();
    expect(bestRankedOpportunityAtOrAboveScore(candidates, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns the highest-scoring survivor at or above the threshold", () => {
    const best = bestRankedOpportunityAtOrAboveScore(candidates, 0.5);
    expect(best?.id).toBe("top");
    expect(best?.rankScore).toBeGreaterThanOrEqual(0.5);
  });

  it("breaks score ties by input order among qualifying candidates", () => {
    const tie = input({ potential: 0.5, feasibility: 0.5, laneFit: 0.5, freshness: 0.5 });
    const best = bestRankedOpportunityAtOrAboveScore(
      [
        { id: "first", ...tie },
        { id: "second", ...tie },
      ],
      0.05,
    );
    expect(best?.id).toBe("first");
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.bestRankedOpportunityAtOrAboveScore).toBe("function");
    expect(barrel.bestRankedOpportunityAtOrAboveScore(candidates, 0.5)?.id).toBe("top");
  });
});
