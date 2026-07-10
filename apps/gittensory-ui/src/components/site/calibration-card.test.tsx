import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CalibrationCard } from "@/components/site/calibration-card";
import {
  calibrationBandRows,
  calibrationVerdictLabel,
  calibrationVerdictTone,
  type FleetOutcomeCalibration,
  type SlopBandCalibration,
} from "@/components/site/calibration-card-model";

function band(overrides: Partial<SlopBandCalibration> = {}): SlopBandCalibration {
  return { band: "clean", sampleSize: 0, merged: 0, closed: 0, mergeRate: 0, ...overrides };
}

function calibration(overrides: Partial<FleetOutcomeCalibration> = {}): FleetOutcomeCalibration {
  return {
    generatedAt: "2026-07-10T00:00:00.000Z",
    slop: {
      totalResolved: 0,
      bands: [
        band({ band: "clean" }),
        band({ band: "low" }),
        band({ band: "elevated" }),
        band({ band: "high" }),
      ],
      overallMergeRate: null,
      discriminates: null,
    },
    recommendations: { total: 0, positive: 0, negative: 0, pending: 0, positiveRate: null },
    signals: [],
    ...overrides,
  };
}

describe("calibrationBandRows", () => {
  it("marks a zero-sample band's merge rate as null (no bar), not a real 0%", () => {
    const rows = calibrationBandRows({
      totalResolved: 0,
      bands: [band({ band: "clean", sampleSize: 0 })],
      overallMergeRate: null,
      discriminates: null,
    });
    expect(rows).toEqual([
      { band: "clean", label: "Clean", sampleSize: 0, mergeRatePercent: null },
    ]);
  });

  it("converts a populated band's merge rate to a rounded 0-100 percent", () => {
    const rows = calibrationBandRows({
      totalResolved: 6,
      bands: [band({ band: "high", sampleSize: 6, merged: 1, closed: 5, mergeRate: 0.167 })],
      overallMergeRate: 0.167,
      discriminates: null,
    });
    expect(rows).toEqual([{ band: "high", label: "High", sampleSize: 6, mergeRatePercent: 17 }]);
  });
});

describe("calibrationVerdictTone / calibrationVerdictLabel", () => {
  it("reports a ready/predictive verdict when the score discriminates", () => {
    expect(calibrationVerdictTone(true)).toBe("ready");
    expect(calibrationVerdictLabel(true)).toBe("Predictive");
  });
  it("reports a blocked/not-discriminating verdict when the score inverts", () => {
    expect(calibrationVerdictTone(false)).toBe("blocked");
    expect(calibrationVerdictLabel(false)).toBe("Not discriminating");
  });
  it("reports a warn/insufficient-data verdict when there isn't enough signal to judge", () => {
    expect(calibrationVerdictTone(null)).toBe("warn");
    expect(calibrationVerdictLabel(null)).toBe("Insufficient data");
  });
});

describe("CalibrationCard", () => {
  it("renders nothing when there is no resolved-PR or recommendation signal at all (empty bins)", () => {
    const { container } = render(<CalibrationCard calibration={calibration()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a single populated band alongside the rest as 'no data'", () => {
    render(
      <CalibrationCard
        calibration={calibration({
          slop: {
            totalResolved: 6,
            bands: [
              band({ band: "clean", sampleSize: 6, merged: 5, closed: 1, mergeRate: 0.833 }),
              band({ band: "low" }),
              band({ band: "elevated" }),
              band({ band: "high" }),
            ],
            overallMergeRate: 0.833,
            discriminates: null,
          },
          signals: ["Not enough resolved PRs per band to judge slop calibration yet (6 resolved)."],
        })}
      />,
    );
    expect(screen.getByText("Confidence calibration")).toBeTruthy();
    expect(screen.getByText("83% · n=6")).toBeTruthy();
    expect(screen.getAllByText("no data")).toHaveLength(3);
    expect(screen.getByText("Insufficient data")).toBeTruthy();
    expect(screen.getByText(/Not enough resolved PRs per band/)).toBeTruthy();
  });

  it("renders the full curve across every band plus the recommendation-outcome split", () => {
    render(
      <CalibrationCard
        calibration={calibration({
          slop: {
            totalResolved: 24,
            bands: [
              band({ band: "clean", sampleSize: 6, merged: 5, closed: 1, mergeRate: 0.833 }),
              band({ band: "low", sampleSize: 6, merged: 3, closed: 3, mergeRate: 0.5 }),
              band({ band: "elevated", sampleSize: 6, merged: 2, closed: 4, mergeRate: 0.333 }),
              band({ band: "high", sampleSize: 6, merged: 1, closed: 5, mergeRate: 0.167 }),
            ],
            overallMergeRate: 0.458,
            discriminates: true,
          },
          recommendations: { total: 5, positive: 3, negative: 1, pending: 1, positiveRate: 0.75 },
          signals: [
            "Slop score is predictive: merge rate falls as the band rises (24 resolved PRs).",
          ],
        })}
      />,
    );
    expect(screen.getByText("Predictive")).toBeTruthy();
    expect(screen.getByText("24 resolved")).toBeTruthy();
    expect(screen.getByText("83% · n=6")).toBeTruthy();
    expect(screen.getByText("50% · n=6")).toBeTruthy();
    expect(screen.getByText("33% · n=6")).toBeTruthy();
    expect(screen.getByText("17% · n=6")).toBeTruthy();
    expect(screen.queryByText("no data")).toBeNull();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText(/3\/4 positive/)).toBeTruthy();
    expect(screen.getByText(/1 pending/)).toBeTruthy();
  });

  it("shows a '—' recommendation rate when nothing is resolved yet, even with slop signal present", () => {
    render(
      <CalibrationCard
        calibration={calibration({
          slop: {
            totalResolved: 6,
            bands: [
              band({ band: "clean", sampleSize: 6, merged: 5, closed: 1, mergeRate: 0.833 }),
              band({ band: "low" }),
              band({ band: "elevated" }),
              band({ band: "high" }),
            ],
            overallMergeRate: 0.833,
            discriminates: null,
          },
          recommendations: { total: 2, positive: 0, negative: 0, pending: 2, positiveRate: null },
        })}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/0\/0 positive/)).toBeTruthy();
  });
});
