import { describe, expect, it } from "vitest";
import { computeOpportunityCompetition } from "../../packages/gittensory-engine/src/opportunity-competition";

describe("computeOpportunityCompetition", () => {
  it("mirrors hosted reward-risk competitionFactor for representative inputs", () => {
    expect(computeOpportunityCompetition(0, 12)).toBe(0);
    expect(computeOpportunityCompetition(3, 6)).toBe(0.5);
    expect(computeOpportunityCompetition(9, 3)).toBe(1);
  });

  it("fails closed when cluster pressure is broken", () => {
    expect(computeOpportunityCompetition(Number.NaN, 3)).toBe(1);
    expect(computeOpportunityCompetition(Number.POSITIVE_INFINITY, 3)).toBe(1);
    expect(computeOpportunityCompetition(Number.NEGATIVE_INFINITY, 3)).toBe(1);
  });

  it("never divides by zero when open PR volume is missing", () => {
    expect(computeOpportunityCompetition(2, 0)).toBe(1);
    expect(computeOpportunityCompetition(2, Number.NaN)).toBe(1);
    expect(computeOpportunityCompetition(0, Number.NaN)).toBe(0);
  });
});
