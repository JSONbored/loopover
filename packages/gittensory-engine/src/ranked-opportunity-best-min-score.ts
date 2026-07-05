import { rankOpportunitiesAtOrAboveScore } from "./ranked-opportunity-min-score.js";
import type { OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Return the highest-scoring candidate at or above `minScore`, or `null` when none qualify.
 * Non-finite thresholds return `null`. Pure — delegates to {@link rankOpportunitiesAtOrAboveScore}.
 */
export function bestRankedOpportunityAtOrAboveScore<T>(
  candidates: Array<T & OpportunityRankInput>,
  minScore: number,
): (Omit<T, "rankScore"> & OpportunityRankInput & { rankScore: number }) | null {
  const survivors = rankOpportunitiesAtOrAboveScore(candidates, minScore);
  return survivors[0] ?? null;
}
