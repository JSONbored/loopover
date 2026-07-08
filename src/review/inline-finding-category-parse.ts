/** Parser-side inline-finding category normalization (#2147). */

import { isFindingCategory, type FindingCategory } from "./finding-category-classify";

/** Safe parser default when the model omits `category` or emits a value outside the fixed enum. */
export const DEFAULT_INLINE_FINDING_CATEGORY: FindingCategory = "maintainability";

/** Normalize a model-emitted `category` to a fixed enum literal — never leaves a finding uncategorized after parse. */
export function parseInlineFindingCategory(value: unknown): FindingCategory {
  return isFindingCategory(value) ? value : DEFAULT_INLINE_FINDING_CATEGORY;
}
