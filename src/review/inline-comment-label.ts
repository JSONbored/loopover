/** Pure inline-comment severity/category label rendering (#2149 / #1958). */

import { classifyFindingCategory, type FindingCategory } from "./finding-category-classify";
import type { InlineFinding } from "../services/ai-review";

/** Human-readable category name for inline labels — title-cased enum literal, never free text. */
export function titleCaseFindingCategory(category: FindingCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/** Build the bolded severity prefix for an inline comment (`Blocker · Security`, or severity-only when off). */
export function formatInlineCommentSeverityLabel(finding: InlineFinding, categoriesEnabled: boolean): string {
  const severityLabel = finding.severity === "blocker" ? "Blocker" : "Nit";
  if (!categoriesEnabled) return severityLabel;
  const category = finding.category ?? classifyFindingCategory(finding);
  return `${severityLabel} · ${titleCaseFindingCategory(category)}`;
}
