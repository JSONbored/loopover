import type { z } from "zod";
import type { PublicStatsSchema } from "@loopover/contract/public-api";
// Pure types + helpers for the Proof of Power (#1059) homepage stats band, split from the component so the
// component file only exports components (react-refresh) — mirrors the audit-feed / audit-feed-model split.

// #9282/#9521: DERIVED, not hand-authored. `PublicStats` was a parallel TypeScript interface kept in sync
// with the backend by whoever last touched both files, and it had drifted -- it was missing
// `fleetAccuracy.basis` and `rulePrecision.rules[].confirmed` outright, called `decidedCount` optional where
// the wire says nullable, called `accuracyTrend`'s counts non-null where the wire says nullable, and made
// `rulePrecision` optional where the wire says required. Inferring from the schema the Worker actually
// serves makes the next such change a compile error here instead of broken rendering.
export type { PublicRulePrecision } from "@loopover/contract/public-api";
export type PublicStats = z.infer<typeof PublicStatsSchema>;

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
