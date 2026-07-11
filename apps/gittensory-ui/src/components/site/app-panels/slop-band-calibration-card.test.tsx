import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SlopBandCalibrationCard } from "@/components/site/app-panels/slop-band-calibration-card";

describe("SlopBandCalibrationCard", () => {
  it("renders a row per band with merge rate + counts and the discrimination verdict when all bands have data", () => {
    render(
      <SlopBandCalibrationCard
        calibration={{
          totalResolved: 40,
          overallMergeRate: 0.6,
          discriminates: true,
          bands: [
            { band: "clean", sampleSize: 20, merged: 18, closed: 2, mergeRate: 0.9 },
            { band: "low", sampleSize: 10, merged: 6, closed: 4, mergeRate: 0.6 },
            { band: "elevated", sampleSize: 6, merged: 2, closed: 4, mergeRate: 0.333 },
            { band: "high", sampleSize: 4, merged: 0, closed: 4, mergeRate: 0 },
          ],
        }}
      />,
    );
    expect(screen.getByText("clean")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("90% merged")).toBeTruthy();
    expect(screen.getByText("predictive")).toBeTruthy();
    expect(screen.getByText(/40 resolved · 60% merged overall/)).toBeTruthy();
  });

  it("shows the '— no samples' state for an empty band and marks insufficient data", () => {
    render(
      <SlopBandCalibrationCard
        calibration={{
          totalResolved: 3,
          overallMergeRate: 1,
          discriminates: null,
          bands: [
            { band: "clean", sampleSize: 3, merged: 3, closed: 0, mergeRate: 1 },
            { band: "high", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0 },
          ],
        }}
      />,
    );
    expect(screen.getByText("— no samples")).toBeTruthy();
    expect(screen.getByText("insufficient data")).toBeTruthy();
  });

  it("flags an inverted (non-predictive) score", () => {
    render(
      <SlopBandCalibrationCard
        calibration={{
          totalResolved: 20,
          overallMergeRate: 0.5,
          discriminates: false,
          bands: [{ band: "clean", sampleSize: 20, merged: 10, closed: 10, mergeRate: 0.5 }],
        }}
      />,
    );
    expect(screen.getByText("inverted")).toBeTruthy();
  });

  it("shows the 'no resolved PRs' empty state when the calibration has no resolved data", () => {
    render(
      <SlopBandCalibrationCard
        calibration={{ totalResolved: 0, overallMergeRate: null, discriminates: null, bands: [] }}
      />,
    );
    expect(screen.getByText("No resolved PRs with a slop band")).toBeTruthy();
    expect(screen.queryByText("predictive")).toBeNull();
  });

  it("shows the 'not yet available' empty state when the calibration field is absent", () => {
    render(<SlopBandCalibrationCard />);
    expect(screen.getByText("Not yet available")).toBeTruthy();
  });
});
