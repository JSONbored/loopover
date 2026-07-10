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
  /** Trailing weekly history of totals.accuracyPct's SAME formula (#4447). */
  accuracyTrend: Array<{
    weekStart: string;
    merged: number;
    closed: number;
    reversed: number;
    accuracyPct: number | null;
  }>;
  /** Trailing weekly "how often we avoid redoing AI work" trend (#4448). */
  reuseRateTrend: Array<{
    weekStart: string;
    hits: number;
    misses: number;
    reuseRatePct: number | null;
  }>;
  /** Trailing weekly review-volume/filtered-rate trend (#4445 follow-up) -- each week is the cohort of PRs
   *  first published that week; `merged` reflects their CURRENT disposition, not necessarily merged that
   *  same week. */
  reviewVolumeTrend: Array<{
    weekStart: string;
    reviewed: number;
    merged: number;
    filteredPct: number | null;
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

const WEEK_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "Jun 15" from a `weekStart` (YYYY-MM-DD, always a UTC Monday). Falls back to the raw string on a malformed
 *  date rather than throwing or rendering "Invalid Date". */
export function formatWeekLabel(weekStart: string): string {
  const ms = Date.parse(`${weekStart}T00:00:00.000Z`);
  return Number.isFinite(ms) ? WEEK_LABEL_FORMATTER.format(ms) : weekStart;
}

/** A single trend chart's plot-ready point: a chart-agnostic {label, value} pair for a fixed X/Y encoding
 *  (recharts, or any other renderer). `value` is null for a week below its own MIN_SAMPLE floor -- the caller
 *  decides how to render a gap (recharts breaks a Line's segment at a null point by default, which is exactly
 *  the "insufficient data" signal a reader should see rather than a fabricated 0%). */
export type TrendPoint = { label: string; value: number | null };

/** Shared shape both accuracyTrend and reuseRateTrend already satisfy -- a week label plus a nullable percent. */
export function toTrendPoints<T extends { weekStart: string }>(
  weeks: ReadonlyArray<T>,
  pct: (week: T) => number | null,
): TrendPoint[] {
  return weeks.map((week) => ({ label: formatWeekLabel(week.weekStart), value: pct(week) }));
}
