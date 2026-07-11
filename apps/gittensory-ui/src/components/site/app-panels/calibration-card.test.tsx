import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CalibrationCard } from "@/components/site/app-panels/calibration-card";
import {
  calibrationHasSamples,
  calibrationStatus,
  calibrationTrendValues,
  type GateCalibration,
} from "@/components/site/app-panels/calibration-card-model";

function emptyBins() {
  return [
    {
      label: "50–60%",
      minConfidence: 0.5,
      maxConfidence: 0.6,
      sampleSize: 0,
      keptCount: 0,
      revertedCount: 0,
      keptRate: null,
    },
    {
      label: "60–70%",
      minConfidence: 0.6,
      maxConfidence: 0.7,
      sampleSize: 0,
      keptCount: 0,
      revertedCount: 0,
      keptRate: null,
    },
    {
      label: "70–80%",
      minConfidence: 0.7,
      maxConfidence: 0.8,
      sampleSize: 0,
      keptCount: 0,
      revertedCount: 0,
      keptRate: null,
    },
    {
      label: "80–90%",
      minConfidence: 0.8,
      maxConfidence: 0.9,
      sampleSize: 0,
      keptCount: 0,
      revertedCount: 0,
      keptRate: null,
    },
    {
      label: "90–100%",
      minConfidence: 0.9,
      maxConfidence: 1,
      sampleSize: 0,
      keptCount: 0,
      revertedCount: 0,
      keptRate: null,
    },
  ];
}

function calibration(overrides: Partial<GateCalibration> = {}): GateCalibration {
  return {
    currentFloor: 0.9,
    mergedCount: 0,
    revertedCount: 0,
    keptAvgConfidence: null,
    revertedMaxConfidence: null,
    recommendedFloor: null,
    note: "No reverted auto-merges — the current floor looks adequate.",
    bins: emptyBins(),
    ...overrides,
  };
}

describe("calibrationStatus", () => {
  it("returns info when every bin is empty (no merge samples arm)", () => {
    expect(calibrationStatus(calibration())).toEqual({ tone: "info", label: "no merge samples" });
    expect(calibrationHasSamples(calibration())).toBe(false);
  });

  it("returns warn when recommendedFloor is present (above-current-floor arm)", () => {
    expect(
      calibrationStatus(
        calibration({
          recommendedFloor: 0.94,
          bins: [
            {
              label: "90–100%",
              minConfidence: 0.9,
              maxConfidence: 1,
              sampleSize: 2,
              keptCount: 1,
              revertedCount: 1,
              keptRate: 0.5,
            },
          ],
        }),
      ),
    ).toEqual({ tone: "warn", label: "raise confidence floor" });
  });

  it("returns ready when there are samples but no floor change is recommended", () => {
    expect(
      calibrationStatus(
        calibration({
          bins: [
            {
              label: "90–100%",
              minConfidence: 0.9,
              maxConfidence: 1,
              sampleSize: 3,
              keptCount: 3,
              revertedCount: 0,
              keptRate: 1,
            },
          ],
        }),
      ),
    ).toEqual({ tone: "ready", label: "floor adequate" });
  });
});

describe("calibrationTrendValues", () => {
  it("maps null keptRate bins to 0 for the chart axis", () => {
    expect(calibrationTrendValues(emptyBins())).toEqual([0, 0, 0, 0, 0]);
  });

  it("scales kept rates to percentage points for TrendChart", () => {
    expect(
      calibrationTrendValues([
        {
          label: "80–90%",
          minConfidence: 0.8,
          maxConfidence: 0.9,
          sampleSize: 2,
          keptCount: 2,
          revertedCount: 0,
          keptRate: 1,
        },
        {
          label: "90–100%",
          minConfidence: 0.9,
          maxConfidence: 1,
          sampleSize: 2,
          keptCount: 1,
          revertedCount: 1,
          keptRate: 0.5,
        },
      ]),
    ).toEqual([100, 50]);
  });
});

describe("CalibrationCard", () => {
  it("renders the empty-bins state without the curve or per-bin sparkbars", () => {
    render(<CalibrationCard calibration={calibration()} />);
    expect(screen.getByText("Confidence calibration")).toBeTruthy();
    expect(screen.getByText("no merge samples")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/Merge-confidence calibration bins appear once/)).toBeTruthy();
    expect(screen.queryByText("Kept-rate curve by confidence band")).toBeNull();
  });

  it("renders a single populated bin with kept rate and em dash for empty bins", () => {
    render(
      <CalibrationCard
        calibration={calibration({
          mergedCount: 2,
          keptAvgConfidence: 0.95,
          bins: [
            ...emptyBins().slice(0, 4),
            {
              label: "90–100%",
              minConfidence: 0.9,
              maxConfidence: 1,
              sampleSize: 2,
              keptCount: 2,
              revertedCount: 0,
              keptRate: 1,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("floor adequate")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText("Kept-rate curve by confidence band")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("renders the full curve across multiple bins and surfaces the recommended floor", () => {
    render(
      <CalibrationCard
        calibration={calibration({
          mergedCount: 5,
          revertedCount: 1,
          revertedMaxConfidence: 0.92,
          recommendedFloor: 0.94,
          keptAvgConfidence: 0.88,
          note: "Raise confidenceFloor 0.9 → 0.94: a merge at 0.92 confidence was reverted.",
          bins: [
            {
              label: "50–60%",
              minConfidence: 0.5,
              maxConfidence: 0.6,
              sampleSize: 0,
              keptCount: 0,
              revertedCount: 0,
              keptRate: null,
            },
            {
              label: "60–70%",
              minConfidence: 0.6,
              maxConfidence: 0.7,
              sampleSize: 0,
              keptCount: 0,
              revertedCount: 0,
              keptRate: null,
            },
            {
              label: "70–80%",
              minConfidence: 0.7,
              maxConfidence: 0.8,
              sampleSize: 1,
              keptCount: 1,
              revertedCount: 0,
              keptRate: 1,
            },
            {
              label: "80–90%",
              minConfidence: 0.8,
              maxConfidence: 0.9,
              sampleSize: 2,
              keptCount: 2,
              revertedCount: 0,
              keptRate: 1,
            },
            {
              label: "90–100%",
              minConfidence: 0.9,
              maxConfidence: 1,
              sampleSize: 2,
              keptCount: 1,
              revertedCount: 1,
              keptRate: 0.5,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("raise confidence floor")).toBeTruthy();
    expect(screen.getByText("94%")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText(/Raise confidenceFloor 0.9 → 0.94/)).toBeTruthy();
    expect(screen.getByText("70–80%")).toBeTruthy();
    expect(screen.getByText("90–100%")).toBeTruthy();
  });
});
