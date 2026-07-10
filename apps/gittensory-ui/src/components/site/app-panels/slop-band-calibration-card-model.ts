// Slop-band calibration card model (#2196). UI-side mirror of SlopOutcomeCalibration from src/review/stats.ts.

export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopBandCalibrationRow = {
  band: SlopBand;
  sampleSize: number;
  merged: number;
  closed: number;
  mergeRate: number;
};

export type SlopBandCalibration = {
  totalResolved: number;
  bands: SlopBandCalibrationRow[];
  overallMergeRate: number | null;
  discriminates: boolean | null;
};

export function formatSlopBandLabel(band: SlopBand): string {
  return band.charAt(0).toUpperCase() + band.slice(1);
}

export function formatMergeRate(rate: number, sampleSize: number): string {
  if (sampleSize <= 0) return "—";
  return `${Math.round(rate * 100)}%`;
}
