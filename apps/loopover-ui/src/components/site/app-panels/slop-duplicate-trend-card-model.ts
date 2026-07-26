// Slop + duplicate trend card model (#2202). UI-side mirror of MaintainerSlopDuplicateTrend from
// src/services/maintainer-slop-duplicate-trend.ts — plus pure helpers for chart series mapping.

export type SlopBandLabel = "clean" | "low" | "elevated" | "high";

export type SlopDuplicateTrendWeek = {
  weekStart: string;
  slopFlagRatePct: number | null;
  slopBandLabel: SlopBandLabel | null;
  duplicateFlagRatePct: number | null;
};

export type MaintainerSlopDuplicateTrend = {
  generatedAt: string;
  stale: boolean;
  weeks: SlopDuplicateTrendWeek[];
  summary: string;
};

export function formatTrendRatePct(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value}%`;
}

export function chartValuesForSeries(
  weeks: SlopDuplicateTrendWeek[],
  series: "slop" | "duplicate",
): number[] {
  return weeks.map((week) => {
    const value = series === "slop" ? week.slopFlagRatePct : week.duplicateFlagRatePct;
    return value ?? 0;
  });
}

export function seriesHasSignal(
  weeks: SlopDuplicateTrendWeek[],
  series: "slop" | "duplicate",
): boolean {
  return weeks.some((week) =>
    series === "slop" ? week.slopFlagRatePct !== null : week.duplicateFlagRatePct !== null,
  );
}

export function trendHasAnySignal(weeks: SlopDuplicateTrendWeek[]): boolean {
  return seriesHasSignal(weeks, "slop") || seriesHasSignal(weeks, "duplicate");
}

/** Latest week bearing a signal for ONE series. The two rates are independently nullable, so each
 *  legend must resolve its own latest week — a single shared "any signal" lookup would let one
 *  series' null in the newest signal-bearing week hide an older real value for the other (#8667). */
export function latestWeekWithSignal(
  weeks: SlopDuplicateTrendWeek[],
  series: "slop" | "duplicate",
): SlopDuplicateTrendWeek | null {
  for (let index = weeks.length - 1; index >= 0; index -= 1) {
    const week = weeks[index];
    if (!week) continue;
    const value = series === "slop" ? week.slopFlagRatePct : week.duplicateFlagRatePct;
    if (value !== null) return week;
  }
  return null;
}

export function formatGeneratedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toUTCString().slice(5, 22);
}
