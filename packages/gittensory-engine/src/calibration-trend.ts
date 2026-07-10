import { DOCUMENTED_CALIBRATION_BASELINE, type Phase7CalibrationLoopResult } from "./phase7-calibration-loop.js";

// Calibration accuracy-trend view (#4268). A read-only projection of a SERIES of accumulated calibration
// snapshots (each a point-in-time computePhase7CalibrationLoop result) into a trend over a rolling window —
// the multi-snapshot counterpart to the single-snapshot calibration-dashboard.ts (#4261/#4504). Pure: it
// re-shapes an already-accumulated series and adds NO new calibration computation. Public-safe: only
// accuracies, the documented baseline, and observation timestamps are surfaced (no scores/rewards). A
// brand-new install has zero snapshots, so empty/single-point history renders an explicit
// "insufficient history" state rather than a broken/empty chart.

/** One accumulated point in the calibration history: when it was computed and its combined accuracy. */
export type CalibrationTrendSnapshot = {
  observedAt: string;
  combinedAccuracy: number | null;
  baselineAccuracy: number;
};

export type CalibrationTrendDirection = "improving" | "degrading" | "flat" | "insufficient";

/** One rendered point on the trend line: a data-bearing snapshot with its delta vs the baseline. */
export type CalibrationTrendPoint = {
  observedAt: string;
  combinedAccuracy: number;
  /** Whole percentage-point delta vs that snapshot's baseline (e.g. +6 / -4). */
  deltaFromBaseline: number;
  aboveBaseline: boolean;
};

/** The read-only trend projection of a calibration-snapshot series. */
export type CalibrationTrendView = {
  direction: CalibrationTrendDirection;
  headline: string;
  /** Unicode sparkline of the data points' combined accuracy, normalized across the window. */
  sparkline: string;
  points: readonly CalibrationTrendPoint[];
  latestAccuracy: number | null;
  /** Latest minus earliest combined accuracy, in whole percentage points; null with < 2 data points. */
  changeOverWindow: number | null;
  /** Snapshots that carry a combined accuracy (an install still warming up contributes none). */
  sampleCount: number;
  baselineAccuracy: number;
};

const SPARK_TICKS = "▁▂▃▄▅▆▇█";

/** Derive a trend snapshot from a computed calibration-loop result observed at a given time. */
export function calibrationSnapshotFromResult(
  result: Phase7CalibrationLoopResult,
  observedAt: string,
): CalibrationTrendSnapshot {
  return { observedAt, combinedAccuracy: result.combinedAccuracy, baselineAccuracy: result.baselineAccuracy };
}

function percentPoints(value: number): number {
  return Math.round(value * 100);
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${percentPoints(value)}%`;
}

function formatDeltaPoints(points: number): string {
  return `${points >= 0 ? "+" : ""}${points}pts`;
}

/** Map data-point accuracies onto sparkline ticks, normalized across the window's own min..max. */
function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  return values
    .map((v) => SPARK_TICKS[span === 0 ? 0 : Math.round(((v - min) / span) * (SPARK_TICKS.length - 1))])
    .join("");
}

/**
 * Project an accumulated series of calibration snapshots into a read-only trend view. Pure and
 * deterministic. Snapshots without a combined accuracy (an install still warming up) are dropped from the
 * trend line; if fewer than two data points remain, the view reports an explicit "insufficient" state
 * instead of a misleading flat line. `baselineAccuracy` is taken from the most recent snapshot (or the
 * documented default when there is no history yet).
 */
export function buildCalibrationTrendView(snapshots: readonly CalibrationTrendSnapshot[]): CalibrationTrendView {
  const baselineAccuracy =
    snapshots.length === 0 ? DOCUMENTED_CALIBRATION_BASELINE : snapshots[snapshots.length - 1]!.baselineAccuracy;

  const points: CalibrationTrendPoint[] = snapshots
    .filter((s): s is CalibrationTrendSnapshot & { combinedAccuracy: number } => s.combinedAccuracy !== null)
    .map((s) => ({
      observedAt: s.observedAt,
      combinedAccuracy: s.combinedAccuracy,
      deltaFromBaseline: percentPoints(s.combinedAccuracy - s.baselineAccuracy),
      aboveBaseline: s.combinedAccuracy >= s.baselineAccuracy,
    }));

  const sampleCount = points.length;
  const spark = sparkline(points.map((p) => p.combinedAccuracy));
  const latestAccuracy = sampleCount === 0 ? null : points[sampleCount - 1]!.combinedAccuracy;

  if (sampleCount < 2) {
    const headline =
      sampleCount === 0
        ? "No calibration history yet"
        : `Insufficient history: 1 snapshot (${formatPercent(latestAccuracy)})`;
    return { direction: "insufficient", headline, sparkline: spark, points, latestAccuracy, changeOverWindow: null, sampleCount, baselineAccuracy };
  }

  const earliest = points[0]!.combinedAccuracy;
  const latest = points[sampleCount - 1]!.combinedAccuracy;
  const changeOverWindow = percentPoints(latest - earliest);
  const direction: CalibrationTrendDirection =
    changeOverWindow > 0 ? "improving" : changeOverWindow < 0 ? "degrading" : "flat";
  const headline =
    direction === "flat"
      ? `Flat at ${formatPercent(latest)} over ${sampleCount} snapshots`
      : `${direction === "improving" ? "Improving" : "Degrading"}: ${formatPercent(earliest)} → ${formatPercent(latest)} over ${sampleCount} snapshots (${formatDeltaPoints(changeOverWindow)})`;

  return { direction, headline, sparkline: spark, points, latestAccuracy, changeOverWindow, sampleCount, baselineAccuracy };
}
