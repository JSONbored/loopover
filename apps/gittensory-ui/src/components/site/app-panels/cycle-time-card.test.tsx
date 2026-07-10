import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CycleTimeCard } from "@/components/site/app-panels/cycle-time-card";
import {
  formatCycleTimeMs,
  type CycleTimeAggregate,
} from "@/components/site/app-panels/cycle-time-card-model";

describe("formatCycleTimeMs", () => {
  it("formats seconds, minutes, and hours for present values", () => {
    expect(formatCycleTimeMs(45_000)).toBe("45s");
    expect(formatCycleTimeMs(120_000)).toBe("2m");
    expect(formatCycleTimeMs(7_200_000)).toBe("2.0h");
  });

  it("renders em dash for nullish percentiles (nullish arm)", () => {
    expect(formatCycleTimeMs(null)).toBe("—");
    expect(formatCycleTimeMs(undefined)).toBe("—");
  });
});

describe("CycleTimeCard", () => {
  it("renders p50/p90/p99 tiles and the distribution sparkbar for populated percentiles", () => {
    const cycleTime: CycleTimeAggregate = {
      p50Ms: 60_000,
      p90Ms: 120_000,
      p99Ms: 300_000,
      distribution: [1, 3, 5, 2],
      sampleSize: 11,
    };
    render(<CycleTimeCard cycleTime={cycleTime} />);
    expect(screen.getByText("Review cycle time")).toBeTruthy();
    expect(screen.getByText("1m")).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
    expect(screen.getByText("5m")).toBeTruthy();
    expect(screen.getByText("11 paired PR(s)")).toBeTruthy();
    expect(screen.getByText("Cycle-time distribution")).toBeTruthy();
  });

  it("shows em dashes when percentiles are null (nullish arm)", () => {
    const cycleTime: CycleTimeAggregate = {
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
      distribution: [2],
      sampleSize: 2,
    };
    render(<CycleTimeCard cycleTime={cycleTime} />);
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.getByText("2 paired PR(s)")).toBeTruthy();
  });

  it("shows inline empty copy when there are no samples", () => {
    const cycleTime: CycleTimeAggregate = {
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
      distribution: [],
      sampleSize: 0,
    };
    render(<CycleTimeCard cycleTime={cycleTime} />);
    expect(screen.getByText("no samples yet")).toBeTruthy();
    expect(screen.queryByText("Cycle-time distribution")).toBeNull();
  });

  it("omits the sparkbar when the distribution is empty", () => {
    const cycleTime: CycleTimeAggregate = {
      p50Ms: 60_000,
      p90Ms: 90_000,
      p99Ms: 120_000,
      distribution: [],
      sampleSize: 3,
    };
    render(<CycleTimeCard cycleTime={cycleTime} />);
    expect(screen.getByText("3 paired PR(s)")).toBeTruthy();
    expect(screen.queryByText("Cycle-time distribution")).toBeNull();
  });
});
