import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SlopDuplicateTrendCard } from "@/components/site/app-panels/slop-duplicate-trend-card";
import {
  chartValuesForSeries,
  latestWeekWithSignal,
  type MaintainerSlopDuplicateTrend,
  type SlopDuplicateTrendWeek,
} from "@/components/site/app-panels/slop-duplicate-trend-card-model";

function trend(
  overrides: Partial<MaintainerSlopDuplicateTrend> = {},
): MaintainerSlopDuplicateTrend {
  return {
    generatedAt: "2026-06-14T12:00:00.000Z",
    stale: false,
    summary: "8-week slop + duplicate flag rates across 1 shaped repo(s).",
    weeks: Array.from({ length: 8 }, (_, index) => ({
      weekStart: `2026-04-${String(21 + index).padStart(2, "0")}`,
      slopFlagRatePct: 12.5,
      slopBandLabel: "low" as const,
      duplicateFlagRatePct: 25,
    })),
    ...overrides,
  };
}

describe("SlopDuplicateTrendCard", () => {
  it("renders both trend series, shared legend, and freshness metadata", () => {
    render(<SlopDuplicateTrendCard trend={trend()} />);
    expect(screen.getByText("Slop + duplicate trend")).toBeTruthy();
    expect(screen.getAllByText("Slop flag rate").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Duplicate flag rate").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/latest band: low/i)).toBeTruthy();
    expect(screen.getByText(/latest: 25%/i)).toBeTruthy();
    expect(screen.getByText(/fresh snapshot/i)).toBeTruthy();
    expect(screen.getByText(/generated/i)).toBeTruthy();
    expect(screen.getByLabelText("Slop flag rate trend")).toBeTruthy();
    expect(screen.getByLabelText("Duplicate flag rate trend")).toBeTruthy();
  });

  it("shows a one-series-empty branch when only duplicate samples exist", () => {
    render(
      <SlopDuplicateTrendCard
        trend={trend({
          weeks: [
            {
              weekStart: "2026-06-09",
              slopFlagRatePct: null,
              slopBandLabel: null,
              duplicateFlagRatePct: 50,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("No slop-flag samples in the snapshot window yet.")).toBeTruthy();
    expect(screen.getByLabelText("Duplicate flag rate trend")).toBeTruthy();
    expect(screen.queryByLabelText("Slop flag rate trend")).toBeNull();
    expect(screen.getByText(/latest: 50%/i)).toBeTruthy();
  });

  it("shows the no-data branch when every weekly bucket is empty", () => {
    render(
      <SlopDuplicateTrendCard
        trend={trend({
          summary:
            "No queue-health snapshot history yet for slop + duplicate trends across 1 shaped repo(s).",
          weeks: [
            {
              weekStart: "2026-06-09",
              slopFlagRatePct: null,
              slopBandLabel: null,
              duplicateFlagRatePct: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("No snapshot history yet")).toBeTruthy();
    expect(
      screen.getByText(
        /Queue-health snapshot history will appear here after signal snapshot jobs run/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Slop flag rate trend")).toBeNull();
    expect(screen.queryByLabelText("Duplicate flag rate trend")).toBeNull();
    // The header action slot (freshness pill + generated-at stamp) renders in every state (#6175).
    expect(screen.getByText("fresh snapshot")).toBeTruthy();
  });

  it("surfaces the stale snapshot pill when data is old", () => {
    render(<SlopDuplicateTrendCard trend={trend({ stale: true })} />);
    expect(screen.getByText(/stale snapshot/i)).toBeTruthy();
  });

  // The two series are independently nullable (#8667): each legend must resolve its OWN latest
  // signal-bearing week, not share the single most-recent week that has *any* signal.
  it("keeps the slop legend on its own latest signal week when the newest signal week only has duplicate data", () => {
    render(
      <SlopDuplicateTrendCard
        trend={trend({
          weeks: [
            {
              weekStart: "2026-06-02",
              slopFlagRatePct: 40,
              slopBandLabel: "elevated",
              duplicateFlagRatePct: null,
            },
            {
              weekStart: "2026-06-09",
              slopFlagRatePct: null,
              slopBandLabel: null,
              duplicateFlagRatePct: 12.5,
            },
          ],
        })}
      />,
    );
    // Slop legend reflects the EARLIER week's real band — not "latest: —" from the newest week's null.
    expect(screen.getByText(/latest band: elevated/i)).toBeTruthy();
    expect(screen.queryByText("latest: —")).toBeNull();
    // Duplicate legend independently reflects the newest week's own value.
    expect(screen.getByText(/latest: 12\.5%/i)).toBeTruthy();
  });

  it("keeps the duplicate legend on its own latest signal week when the newest signal week only has slop data", () => {
    render(
      <SlopDuplicateTrendCard
        trend={trend({
          weeks: [
            {
              weekStart: "2026-06-02",
              slopFlagRatePct: null,
              slopBandLabel: null,
              duplicateFlagRatePct: 25,
            },
            {
              weekStart: "2026-06-09",
              slopFlagRatePct: 10,
              slopBandLabel: "low",
              duplicateFlagRatePct: null,
            },
          ],
        })}
      />,
    );
    // Duplicate legend reflects the EARLIER week's real value — not the newest week's null.
    expect(screen.getByText(/latest: 25%/i)).toBeTruthy();
    expect(screen.queryByText("latest: —")).toBeNull();
    // Slop legend independently reflects the newest week's own band.
    expect(screen.getByText(/latest band: low/i)).toBeTruthy();
  });
});

describe("latestWeekWithSignal", () => {
  const week = (
    weekStart: string,
    slopFlagRatePct: number | null,
    duplicateFlagRatePct: number | null,
  ): SlopDuplicateTrendWeek => ({
    weekStart,
    slopFlagRatePct,
    slopBandLabel: slopFlagRatePct === null ? null : "low",
    duplicateFlagRatePct,
  });

  it("resolves a different latest week per series when the two series' nulls diverge", () => {
    const weeks = [week("2026-06-02", 40, null), week("2026-06-09", null, 12.5)];
    expect(latestWeekWithSignal(weeks, "slop")?.weekStart).toBe("2026-06-02");
    expect(latestWeekWithSignal(weeks, "duplicate")?.weekStart).toBe("2026-06-09");
  });

  it("returns the same (newest) week for both series when null-ness stays in lockstep", () => {
    const weeks = [
      week("2026-06-02", 30, 20),
      week("2026-06-09", null, null),
      week("2026-06-16", 10, 5),
    ];
    expect(latestWeekWithSignal(weeks, "slop")?.weekStart).toBe("2026-06-16");
    expect(latestWeekWithSignal(weeks, "duplicate")?.weekStart).toBe("2026-06-16");
  });

  it("returns null for a series with no signal in any week, independently of the other series", () => {
    const weeks = [week("2026-06-02", 40, null), week("2026-06-09", 10, null)];
    expect(latestWeekWithSignal(weeks, "slop")?.weekStart).toBe("2026-06-09");
    expect(latestWeekWithSignal(weeks, "duplicate")).toBeNull();
    expect(latestWeekWithSignal([], "slop")).toBeNull();
  });

  it("skips sparse holes while scanning backwards", () => {
    const weeks: SlopDuplicateTrendWeek[] = [];
    weeks[0] = week("2026-06-02", 40, 25);
    weeks.length = 2; // trailing hole — scanned first, must be skipped, not crashed on
    expect(latestWeekWithSignal(weeks, "slop")?.weekStart).toBe("2026-06-02");
    expect(latestWeekWithSignal(weeks, "duplicate")?.weekStart).toBe("2026-06-02");
  });
});

describe("chartValuesForSeries", () => {
  const week = (
    weekStart: string,
    slopFlagRatePct: number | null,
    duplicateFlagRatePct: number | null,
  ): SlopDuplicateTrendWeek => ({
    weekStart,
    slopFlagRatePct,
    slopBandLabel: slopFlagRatePct === null ? null : "low",
    duplicateFlagRatePct,
  });

  it("preserves a null slop rate as null instead of substituting 0", () => {
    const weeks = [week("2026-06-02", null, 25), week("2026-06-09", 10, 20)];
    expect(chartValuesForSeries(weeks, "slop")).toEqual([null, 10]);
  });

  it("preserves a null duplicate rate as null instead of substituting 0", () => {
    const weeks = [week("2026-06-02", 40, null), week("2026-06-09", 30, 20)];
    expect(chartValuesForSeries(weeks, "duplicate")).toEqual([null, 20]);
  });
});
