import { FINDING_CATEGORIES } from "./finding-category-classify";
import { REVIEW_FINDING_SEVERITY_LADDER } from "../signals/focus-manifest";

/** MCP resource URI for the canonical review finding taxonomy (#2225). */
export const FINDING_TAXONOMY_URI = "loopover://finding-taxonomy" as const;

export interface FindingTaxonomyDocument {
  categories: readonly (typeof FINDING_CATEGORIES)[number][];
  severities: readonly (typeof REVIEW_FINDING_SEVERITY_LADDER)[number][];
}

/** Static, machine-readable taxonomy for AI review findings — categories + severity ladder. */
export function buildFindingTaxonomyDocument(): FindingTaxonomyDocument {
  return {
    categories: [...FINDING_CATEGORIES],
    severities: [...REVIEW_FINDING_SEVERITY_LADDER],
  };
}
