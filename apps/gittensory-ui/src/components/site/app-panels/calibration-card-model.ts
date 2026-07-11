// Confidence-calibration analytics card model (#2192). UI-side mirror of the Calibration / CalibrationBin
// shapes from src/review/ops.ts surfaced on the operator-dashboard payload.

export type CalibrationBin = {
  label: string;
  minConfidence: number;
  maxConfidence: number;
  sampleSize: number;
  keptCount: number;
  revertedCount: number;
  keptRate: number | null;
};

/** Mirror of src/review/ops.ts Calibration for the analytics card. */
export type GateCalibration = {
  currentFloor: number;
  mergedCount: number;
  revertedCount: number;
  keptAvgConfidence: number | null;
  revertedMaxConfidence: number | null;
  recommendedFloor: number | null;
  note: string;
  bins: CalibrationBin[];
};

export function formatConfidencePct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function calibrationHasSamples(calibration: GateCalibration): boolean {
  return calibration.bins.some((bin) => bin.sampleSize > 0);
}

/** Kept-rate curve values for TrendChart — empty-sample bins read as 0 on the chart axis. */
export function calibrationTrendValues(bins: CalibrationBin[]): number[] {
  return bins.map((bin) => (bin.keptRate === null ? 0 : bin.keptRate * 100));
}

export function calibrationStatus(calibration: GateCalibration): {
  tone: "ready" | "warn" | "info";
  label: string;
} {
  if (!calibrationHasSamples(calibration)) {
    return { tone: "info", label: "no merge samples" };
  }
  if (calibration.recommendedFloor !== null) {
    return { tone: "warn", label: "raise confidence floor" };
  }
  return { tone: "ready", label: "floor adequate" };
}
