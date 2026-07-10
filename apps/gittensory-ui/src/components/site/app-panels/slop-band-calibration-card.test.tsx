import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SlopBandCalibrationCard } from "@/components/site/app-panels/slop-band-calibration-card";
import {
  formatMergeRate,
  formatSlopBandLabel,
  type SlopBandCalibration,
} from "@/components/site/app-panels/slop-band-calibration-card-model";

function calibration(overrides: Partial<SlopBandCalibration> = {}): SlopBandCalibration {
  return {
    totalResolved: 0,
    overallMergeRate: null,
    discriminates: null,
    bands: [
      { band: "clean", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
      { band: "low", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
      { band: "elevated", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
      { band: "high", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
    ],
    ...overrides,
  };
}

describe("slop-band calibration formatters", () => {
  it("capitalizes band labels and renders merge rate or em dash", () => {
    expect(formatSlopBandLabel("elevated")).toBe("Elevated");
    expect(formatMergeRate(0.82, 11)).toBe("82%");
    expect(formatMergeRate(0.5, 0)).toBe("—");
  });
});

describe("SlopBandCalibrationCard", () => {
  it("renders all four band rows when every band has samples", () => {
    render(
      <SlopBandCalibrationCard
        calibration={calibration({
          totalResolved: 24,
          overallMergeRate: 0.75,
          discriminates: true,
          bands: [
            { band: "clean", sampleSize: 6, merged: 5, closed: 1, mergeRate: 5 / 6 },
            { band: "low", sampleSize: 6, merged: 4, closed: 2, mergeRate: 4 / 6 },
            { band: "elevated", sampleSize: 6, merged: 3, closed: 3, mergeRate: 0.5 },
            { band: "high", sampleSize: 6, merged: 1, closed: 5, mergeRate: 1 / 6 },
          ],
        })}
      />,
    );
    expect(screen.getByText("Slop-band calibration")).toBeTruthy();
    expect(screen.getByText("Clean")).toBeTruthy();
    expect(screen.getByText("Low")).toBeTruthy();
    expect(screen.getByText("Elevated")).toBeTruthy();
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("predictive")).toBeTruthy();
    expect(screen.getByText("Overall merge rate across assessed bands: 75%")).toBeTruthy();
  });

  it("shows em dash for a single empty band while other bands still render", () => {
    render(
      <SlopBandCalibrationCard
        calibration={calibration({
          totalResolved: 12,
          overallMergeRate: 0.67,
          discriminates: null,
          bands: [
            { band: "clean", sampleSize: 6, merged: 4, closed: 2, mergeRate: 4 / 6 },
            { band: "low", sampleSize: 6, merged: 4, closed: 2, mergeRate: 4 / 6 },
            { band: "elevated", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
            { band: "high", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
          ],
        })}
      />,
    );
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("insufficient per-band sample")).toBeTruthy();
  });

  it("shows inline empty copy and the no-data status pill arm when there are no samples", () => {
    render(<SlopBandCalibrationCard calibration={calibration()} />);
    expect(screen.getByText("no samples yet")).toBeTruthy();
    expect(
      screen.getByText(/Resolved pull requests with a persisted slop band will appear here/),
    ).toBeTruthy();
  });

  it("surfaces the not-discriminating status arm", () => {
    render(
      <SlopBandCalibrationCard
        calibration={calibration({
          totalResolved: 12,
          discriminates: false,
          bands: [
            { band: "clean", sampleSize: 6, merged: 1, closed: 5, mergeRate: 1 / 6 },
            { band: "low", sampleSize: 6, merged: 2, closed: 4, mergeRate: 2 / 6 },
            { band: "elevated", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
            { band: "high", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
          ],
        })}
      />,
    );
    expect(screen.getByText("not discriminating")).toBeTruthy();
  });
});
