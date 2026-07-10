import { describe, expect, it } from "vitest";
import {
  buildCalibrationTrendView,
  calibrationSnapshotFromResult,
} from "../../packages/gittensory-engine/src/index";
import type {
  CalibrationTrendSnapshot,
  Phase7CalibrationLoopResult,
} from "../../packages/gittensory-engine/src/index";

function snap(observedAt: string, combinedAccuracy: number | null, baselineAccuracy = 0.62): CalibrationTrendSnapshot {
  return { observedAt, combinedAccuracy, baselineAccuracy };
}

function makeResult(over: Partial<Phase7CalibrationLoopResult> = {}): Phase7CalibrationLoopResult {
  const metric = { source: "pr_outcome" as const, accuracy: 0.66, sampleSize: 12, observedAt: null, fresh: true };
  return {
    enabled: true,
    baselineAccuracy: 0.62,
    combinedAccuracy: 0.68,
    deltaFromBaseline: 0.06,
    weights: { historicalReplay: 0.5, prOutcome: 0.5 },
    bySource: { historical_replay: { ...metric, source: "historical_replay" }, pr_outcome: metric },
    replayHarnessHold: false,
    replayHarnessStatus: "healthy",
    autonomyIncreasePermitted: true,
    holdReasons: [],
    replayRunDue: false,
    audit: { contributingSources: ["pr_outcome"], rejectedSources: [] },
    ...over,
  };
}

describe("buildCalibrationTrendView (#4268)", () => {
  it("reports an explicit empty state for a brand-new install with no history", () => {
    const view = buildCalibrationTrendView([]);
    expect(view.direction).toBe("insufficient");
    expect(view.headline).toBe("No calibration history yet");
    expect(view.sparkline).toBe("");
    expect(view.points).toEqual([]);
    expect(view.latestAccuracy).toBeNull();
    expect(view.changeOverWindow).toBeNull();
    expect(view.sampleCount).toBe(0);
    expect(view.baselineAccuracy).toBe(0.62);
  });

  it("reports insufficient history with a single data point (can't trend one)", () => {
    const view = buildCalibrationTrendView([snap("2026-01-01T00:00:00Z", 0.66)]);
    expect(view.direction).toBe("insufficient");
    expect(view.headline).toBe("Insufficient history: 1 snapshot (66%)");
    expect(view.sparkline).toBe("▁");
    expect(view.latestAccuracy).toBe(0.66);
    expect(view.changeOverWindow).toBeNull();
    expect(view.sampleCount).toBe(1);
    expect(view.points[0]).toEqual({
      observedAt: "2026-01-01T00:00:00Z",
      combinedAccuracy: 0.66,
      deltaFromBaseline: 4,
      aboveBaseline: true,
    });
  });

  it("projects an improving multi-point series with a rising sparkline", () => {
    const view = buildCalibrationTrendView([
      snap("2026-01-01T00:00:00Z", 0.58),
      snap("2026-01-02T00:00:00Z", 0.63),
      snap("2026-01-03T00:00:00Z", 0.71),
    ]);
    expect(view.direction).toBe("improving");
    expect(view.headline).toBe("Improving: 58% → 71% over 3 snapshots (+13pts)");
    expect(view.sparkline).toBe("▁▄█");
    expect(view.latestAccuracy).toBe(0.71);
    expect(view.changeOverWindow).toBe(13);
    expect(view.sampleCount).toBe(3);
    // crosses the baseline: first point below, last point above
    expect(view.points[0]?.aboveBaseline).toBe(false);
    expect(view.points[0]?.deltaFromBaseline).toBe(-4);
    expect(view.points[2]?.aboveBaseline).toBe(true);
    expect(view.points[2]?.deltaFromBaseline).toBe(9);
  });

  it("projects a degrading multi-point series with a falling sparkline", () => {
    const view = buildCalibrationTrendView([
      snap("2026-01-01T00:00:00Z", 0.7),
      snap("2026-01-02T00:00:00Z", 0.6),
      snap("2026-01-03T00:00:00Z", 0.52),
    ]);
    expect(view.direction).toBe("degrading");
    expect(view.headline).toBe("Degrading: 70% → 52% over 3 snapshots (-18pts)");
    expect(view.sparkline).toBe("█▄▁");
    expect(view.changeOverWindow).toBe(-18);
  });

  it("reports a flat series (zero net change) without dividing by a zero span", () => {
    const view = buildCalibrationTrendView([
      snap("2026-01-01T00:00:00Z", 0.64),
      snap("2026-01-02T00:00:00Z", 0.64),
      snap("2026-01-03T00:00:00Z", 0.64),
    ]);
    expect(view.direction).toBe("flat");
    expect(view.headline).toBe("Flat at 64% over 3 snapshots");
    expect(view.sparkline).toBe("▁▁▁");
    expect(view.changeOverWindow).toBe(0);
  });

  it("drops warming-up snapshots (null combined accuracy) from the trend line", () => {
    const view = buildCalibrationTrendView([
      snap("2026-01-01T00:00:00Z", null),
      snap("2026-01-02T00:00:00Z", 0.66),
      snap("2026-01-03T00:00:00Z", 0.7),
    ]);
    expect(view.sampleCount).toBe(2);
    expect(view.direction).toBe("improving");
    expect(view.headline).toBe("Improving: 66% → 70% over 2 snapshots (+4pts)");
    expect(view.sparkline).toBe("▁█");
  });

  it("takes the baseline from the most recent snapshot, not the documented default", () => {
    const view = buildCalibrationTrendView([snap("2026-01-01T00:00:00Z", 0.6, 0.55), snap("2026-01-02T00:00:00Z", 0.62, 0.55)]);
    expect(view.baselineAccuracy).toBe(0.55);
    expect(view.points[1]?.aboveBaseline).toBe(true);
  });
});

describe("calibrationSnapshotFromResult", () => {
  it("bridges a computed loop result into a trend snapshot", () => {
    const snapshot = calibrationSnapshotFromResult(makeResult({ combinedAccuracy: 0.71 }), "2026-01-03T00:00:00Z");
    expect(snapshot).toEqual({ observedAt: "2026-01-03T00:00:00Z", combinedAccuracy: 0.71, baselineAccuracy: 0.62 });
  });

  it("carries a null accuracy through so the trend can filter it as warming-up", () => {
    const series = [
      calibrationSnapshotFromResult(makeResult({ combinedAccuracy: null, deltaFromBaseline: null }), "2026-01-01T00:00:00Z"),
      calibrationSnapshotFromResult(makeResult({ combinedAccuracy: 0.65 }), "2026-01-02T00:00:00Z"),
      calibrationSnapshotFromResult(makeResult({ combinedAccuracy: 0.73 }), "2026-01-03T00:00:00Z"),
    ];
    const view = buildCalibrationTrendView(series);
    expect(view.sampleCount).toBe(2);
    expect(view.direction).toBe("improving");
    expect(view.latestAccuracy).toBe(0.73);
  });
});
