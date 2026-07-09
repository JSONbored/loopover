// Finding acceptance-rate analytics card model (#2197). UI-only display slice: the card consumes an acceptance
// shape assumed present on the operator-dashboard payload (backend computation is tracked separately in #1967).
// Types + the pure rate/band helpers live here (not in the .tsx) so the component file exports only components
// (react-refresh/only-export-components).

/** The finding-acceptance slice delivered on the operator-dashboard payload: how many posted inline findings the
 *  contributor acted on (the PR merged after the finding was posted), over a rolling window. Public-safe counts. */
export interface AcceptanceRateReport {
  /** Findings a contributor acted on (finding posted inline → PR merged). */
  accepted: number;
  /** Inline findings posted in the window (the denominator). */
  total: number;
  /** Rolling measurement window, in days. */
  windowDays: number;
}

/** The card's derived view: the raw counts plus the acceptance rate (null when nothing was posted). */
export interface AcceptanceRateSummary {
  accepted: number;
  total: number;
  /** accepted / total; null when `total` is 0 (empty denominator — nothing to be a rate of). */
  rate: number | null;
}

/** Pure fold: derive the acceptance rate from the raw counts. An empty denominator yields a null rate. */
export function summarizeAcceptanceRate(report: AcceptanceRateReport): AcceptanceRateSummary {
  return {
    accepted: report.accepted,
    total: report.total,
    rate: report.total > 0 ? report.accepted / report.total : null,
  };
}

/** StatusPill quality band for an acceptance rate: >= 50% reads healthy, below that warns, an empty rate is
 *  informational (no signal yet). Mirrors the Status vocabulary in control-primitives.ts. */
export function bandForAcceptanceRate(rate: number | null): "ready" | "warn" | "info" {
  if (rate === null) return "info";
  return rate >= 0.5 ? "ready" : "warn";
}
