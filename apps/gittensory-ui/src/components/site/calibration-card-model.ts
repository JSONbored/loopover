import type { Status } from "@/components/site/control-primitives";

// UI-side mirror of FleetOutcomeCalibration (src/services/outcome-calibration.ts), delivered on the
// operator-dashboard payload's `calibration` field (#2192, part of #1967). "Bins" here are slop-severity
// bands (clean/low/elevated/high) — the deterministic PREDICTED-risk signal gittensory actually computes
// — each carrying its REALIZED merge rate (the "kept rate"). This intentionally does not mirror #2192's
// own reference (src/review/ops.ts's `Calibration`/`computeCalibration`): that module is ported-but-unwired
// "reviewbot" code whose `review_targets`/`review_audit` tables are never populated in gittensory (see
// src/review/ops-wire.ts's header comment) — nothing constructs its config anywhere in this codebase, and
// its handlers are registered on no route. This mirrors the live native equivalent instead.
export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopBandCalibration = {
  band: SlopBand;
  sampleSize: number;
  merged: number;
  closed: number;
  mergeRate: number;
};

export type SlopOutcomeCalibration = {
  totalResolved: number;
  bands: SlopBandCalibration[];
  overallMergeRate: number | null;
  discriminates: boolean | null;
};

export type RecommendationOutcomeCalibration = {
  total: number;
  positive: number;
  negative: number;
  pending: number;
  positiveRate: number | null;
};

export type FleetOutcomeCalibration = {
  generatedAt: string;
  slop: SlopOutcomeCalibration;
  recommendations: RecommendationOutcomeCalibration;
  signals: string[];
};

export const SLOP_BAND_LABEL: Record<SlopBand, string> = {
  clean: "Clean",
  low: "Low",
  elevated: "Elevated",
  high: "High",
};

export type CalibrationBandRow = {
  band: SlopBand;
  label: string;
  sampleSize: number;
  /** 0-100, or null when there's no sample to show a bar for (distinct from a real 0% merge rate). */
  mergeRatePercent: number | null;
};

/** Pure: shape each slop band into a display-ready row. */
export function calibrationBandRows(slop: SlopOutcomeCalibration): CalibrationBandRow[] {
  return slop.bands.map((entry) => ({
    band: entry.band,
    label: SLOP_BAND_LABEL[entry.band],
    sampleSize: entry.sampleSize,
    mergeRatePercent: entry.sampleSize > 0 ? Math.round(entry.mergeRate * 100) : null,
  }));
}

/** Pure: pill tone for the discrimination verdict. */
export function calibrationVerdictTone(discriminates: boolean | null): Status {
  if (discriminates === true) return "ready";
  if (discriminates === false) return "blocked";
  return "warn";
}

/** Pure: human label for the discrimination verdict. */
export function calibrationVerdictLabel(discriminates: boolean | null): string {
  if (discriminates === true) return "Predictive";
  if (discriminates === false) return "Not discriminating";
  return "Insufficient data";
}
