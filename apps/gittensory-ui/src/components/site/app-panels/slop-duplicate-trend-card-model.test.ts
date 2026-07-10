import { describe, expect, it } from "vitest";

import {
  chartValuesForSeries,
  formatGeneratedAt,
  formatTrendRatePct,
  latestWeekWithSignal,
  seriesHasSignal,
  trendHasAnySignal,
} from "@/components/site/app-panels/slop-duplicate-trend-card-model";

const week = {
  weekStart: "2026-06-09",
  slopFlagRatePct: 12.5,
  slopBandLabel: "low" as const,
  duplicateFlagRatePct: 25,
};

describe("slop-duplicate-trend-card-model", () => {
  it("formats trend rates and generatedAt timestamps", () => {
    expect(formatTrendRatePct(null)).toBe("—");
    expect(formatTrendRatePct(12.5)).toBe("12.5%");
    expect(formatGeneratedAt("not-a-date")).toBe("not-a-date");
    expect(formatGeneratedAt("2026-06-14T12:00:00.000Z")).toMatch(/Jun/);
  });

  it("maps chart values and detects per-series signal", () => {
    const weeks = [
      week,
      { ...week, slopFlagRatePct: null, slopBandLabel: null, duplicateFlagRatePct: null },
    ];
    expect(chartValuesForSeries(weeks, "slop")).toEqual([12.5, 0]);
    expect(chartValuesForSeries(weeks, "duplicate")).toEqual([25, 0]);
    expect(seriesHasSignal(weeks, "slop")).toBe(true);
    expect(seriesHasSignal(weeks, "duplicate")).toBe(true);
    expect(seriesHasSignal([weeks[1]!], "slop")).toBe(false);
    expect(trendHasAnySignal([weeks[1]!])).toBe(false);
    expect(latestWeekWithSignal(weeks)?.weekStart).toBe("2026-06-09");
    expect(latestWeekWithSignal([weeks[1]!])).toBeNull();
  });
});
