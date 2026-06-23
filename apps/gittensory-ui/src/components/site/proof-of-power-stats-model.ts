// Pure types + helpers for the Proof of Power (#1059) homepage stats band, split from the component so the
// component file only exports components (react-refresh) — mirrors the audit-feed / audit-feed-model split.

export type PublicStats = {
  generatedAt: string;
  updatedAt: string;
  totals: {
    handled: number;
    reviewed: number;
    merged: number;
    closed: number;
    commented: number;
    ignored: number;
    manual: number;
    error: number;
    reversed: number;
    filteredPct: number | null;
    accuracyPct: number | null;
    minutesSaved: number;
  };
  weekly: { reviewed: number; merged: number };
  byProject: Array<{
    project: string;
    reviewed: number;
    merged: number;
    closed: number;
    accuracyPct: number | null;
  }>;
};

/** Relative "updated Ns ago" label from the payload's updatedAt (mirrors MetaStrip's freshness logic). */
export function formatStatsAgo(updatedAt: string | null, nowMs: number): string {
  if (!updatedAt) return "just now";
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return "just now";
  const diff = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Human-friendly maintainer-time-saved: days once it's ≥ 2 days, else hours. Returns the numeric value (for the
 *  count-up) and its unit separately. */
export function formatTimeSaved(minutes: number): { value: number; unit: string } {
  const days = minutes / 1440;
  if (days >= 2) {
    const v = Math.round(days);
    return { value: v, unit: v === 1 ? "day" : "days" };
  }
  const hours = minutes / 60;
  if (hours >= 1) {
    const v = Math.round(hours);
    return { value: v, unit: v === 1 ? "hr" : "hrs" };
  }
  return { value: Math.round(minutes), unit: "min" };
}
