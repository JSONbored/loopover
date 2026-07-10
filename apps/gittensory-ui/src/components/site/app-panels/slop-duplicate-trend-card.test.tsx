import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SlopDuplicateTrendCard } from "@/components/site/app-panels/slop-duplicate-trend-card";
import type { MaintainerSlopDuplicateTrend } from "@/components/site/app-panels/slop-duplicate-trend-card-model";

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
    expect(screen.getAllByLabelText("Trend chart")).toHaveLength(2);
  });

  it("shows a one-series-empty branch when only slop samples exist", () => {
    render(
      <SlopDuplicateTrendCard
        trend={trend({
          weeks: [
            {
              weekStart: "2026-06-09",
              slopFlagRatePct: 33,
              slopBandLabel: "elevated",
              duplicateFlagRatePct: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/latest band: elevated/i)).toBeTruthy();
    expect(screen.getByText("No duplicate-flag samples in the snapshot window yet.")).toBeTruthy();
    expect(screen.getByLabelText("Trend chart")).toBeTruthy();
  });

  it("shows slop latest rate when band label is absent", () => {
    render(
      <SlopDuplicateTrendCard
        trend={trend({
          weeks: [
            {
              weekStart: "2026-06-09",
              slopFlagRatePct: 15,
              slopBandLabel: null,
              duplicateFlagRatePct: 10,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/latest: 15%/i)).toBeTruthy();
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
    expect(screen.getByLabelText("Trend chart")).toBeTruthy();
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
    expect(
      screen.getByText(
        /Queue-health snapshot history will appear here after signal snapshot jobs run/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Trend chart")).toBeNull();
  });

  it("surfaces the stale snapshot pill when data is old", () => {
    render(<SlopDuplicateTrendCard trend={trend({ stale: true })} />);
    expect(screen.getByText(/stale snapshot/i)).toBeTruthy();
  });
});
