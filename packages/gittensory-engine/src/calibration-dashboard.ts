import {
  DOCUMENTED_CALIBRATION_BASELINE,
  type CalibrationSourceMetric,
  type Phase7CalibrationLoopResult,
} from "./phase7-calibration-loop.js";

// Calibration dashboard view (#4261). A read-only projection of a Phase7CalibrationLoopResult
// (phase7-calibration-loop.ts, computePhase7CalibrationLoop) into a human-readable dashboard shape that a CLI table
// or a UI panel renders. Pure: it re-shapes an ALREADY-computed result and adds NO new calibration computation — so
// predicted-gate accuracy vs realized pr_outcome is presented, never recomputed here. Public-safe: only accuracies,
// sample sizes, freshness, and hold reasons are surfaced (no raw scores/rewards).

export type CalibrationDashboardStatus = "on_track" | "below_baseline" | "insufficient_signal" | "disabled";

/** One labeled row in the dashboard: a metric name, its formatted value, and a short detail line. */
export type CalibrationDashboardRow = {
  label: string;
  value: string;
  detail: string;
};

/** The read-only dashboard projection of a calibration-loop result. */
export type CalibrationDashboardView = {
  status: CalibrationDashboardStatus;
  headline: string;
  rows: readonly CalibrationDashboardRow[];
  holdReasons: readonly string[];
};

/** A whole-number percentage, or an em dash when there is no signal yet. */
function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** A signed percentage-point delta (e.g. "+6pts" / "-4pts"), or an em dash when unknown. */
function formatDeltaPoints(value: number | null): string {
  if (value === null) return "—";
  const points = Math.round(value * 100);
  return `${points >= 0 ? "+" : ""}${points}pts`;
}

function sourceRow(label: string, metric: CalibrationSourceMetric): CalibrationDashboardRow {
  return {
    label,
    value: formatPercent(metric.accuracy),
    detail: `n=${metric.sampleSize} · ${metric.fresh ? "fresh" : "stale"}`,
  };
}

/** Classify the overall calibration state for the dashboard's headline banner. */
export function resolveCalibrationDashboardStatus(result: Phase7CalibrationLoopResult): CalibrationDashboardStatus {
  if (!result.enabled) return "disabled";
  if (result.combinedAccuracy === null) return "insufficient_signal";
  return result.combinedAccuracy >= result.baselineAccuracy ? "on_track" : "below_baseline";
}

/**
 * Project a computed {@link Phase7CalibrationLoopResult} into a read-only dashboard view. Pure and deterministic;
 * adds no computation of its own. `holdReasons` are surfaced verbatim so an operator can see why an autonomy
 * increase is (or isn't) permitted.
 */
export function buildCalibrationDashboardView(result: Phase7CalibrationLoopResult): CalibrationDashboardView {
  const status = resolveCalibrationDashboardStatus(result);
  const rows: CalibrationDashboardRow[] = [
    {
      label: "Combined accuracy",
      value: formatPercent(result.combinedAccuracy),
      detail: `baseline ${formatPercent(result.baselineAccuracy)}`,
    },
    {
      label: "Delta from baseline",
      value: formatDeltaPoints(result.deltaFromBaseline),
      detail: `documented baseline ${formatPercent(DOCUMENTED_CALIBRATION_BASELINE)}`,
    },
    sourceRow("Historical replay", result.bySource.historical_replay),
    sourceRow("PR outcome", result.bySource.pr_outcome),
    {
      label: "Replay harness",
      value: result.replayHarnessStatus,
      detail: result.replayHarnessHold ? "hold" : "ok",
    },
    {
      label: "Autonomy increase",
      value: result.autonomyIncreasePermitted ? "permitted" : "held",
      detail: result.replayRunDue ? "replay run due" : "up to date",
    },
  ];
  const headline =
    status === "disabled"
      ? "Calibration loop disabled"
      : status === "insufficient_signal"
        ? "Insufficient signal to score calibration yet"
        : `${formatPercent(result.combinedAccuracy)} combined (${formatDeltaPoints(result.deltaFromBaseline)} vs baseline)`;
  return { status, headline, rows, holdReasons: [...result.holdReasons] };
}
