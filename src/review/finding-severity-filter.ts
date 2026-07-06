import type { ReviewFindingSeverity } from "../signals/focus-manifest";

const SEVERITY_RANK: Record<ReviewFindingSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  nitpick: 3,
};

/** True when `findingSeverity` is at or above the configured floor (critical is highest). null min ⇒ always true. */
export function meetsMinFindingSeverity(
  findingSeverity: ReviewFindingSeverity,
  minSeverity: ReviewFindingSeverity | null | undefined,
): boolean {
  if (!minSeverity) return true;
  return SEVERITY_RANK[findingSeverity] <= SEVERITY_RANK[minSeverity];
}

/** Map inline-comment severities onto the unified review finding ladder for threshold checks. */
export function inlineFindingSeverityTier(severity: "blocker" | "nit"): ReviewFindingSeverity {
  return severity === "blocker" ? "critical" : "nitpick";
}

export function shouldShowInlineFinding(
  severity: "blocker" | "nit",
  minSeverity: ReviewFindingSeverity | null | undefined,
): boolean {
  return meetsMinFindingSeverity(inlineFindingSeverityTier(severity), minSeverity);
}
