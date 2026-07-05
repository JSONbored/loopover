import {
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "./opportunity-metadata.js";
import type { OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Return the highest-scoring metadata candidate, or `null` when none are targetable/ranked.
 * Pure — delegates to {@link rankMetadataOpportunities} for scoring and tie-breaking.
 */
export function bestMetadataOpportunity<T extends MetadataCandidateIssue>(
  candidates: readonly T[],
  context: MetadataRankContext,
): (T & OpportunityRankInput & { rankScore: number }) | null {
  const ranked = rankMetadataOpportunities(candidates, context);
  return ranked[0] ?? null;
}
