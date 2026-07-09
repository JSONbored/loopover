/** Parser-side inline-finding category normalization (#2147). */

import { isFindingCategory, type FindingCategory } from "./finding-category-classify";

/**
 * Normalize a model-emitted `category` to a fixed enum literal when possible.
 * Unknown or absent values stay uncategorized so deterministic path/body fallback can run downstream.
 */
export function parseInlineFindingCategory(value: unknown): FindingCategory | undefined {
  return isFindingCategory(value) ? value : undefined;
}
