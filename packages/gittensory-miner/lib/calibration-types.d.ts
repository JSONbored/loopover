/** A single gate-prediction row the miner will replay against observed outcomes. */
export type PredictedVerdictRecord = {
  targetId: string;
  project: string;
  predictedDecision: string;
  recordedAt: string;
  source?: string;
};

/** The realized human outcome for a previously predicted target. */
export type ObservedOutcomeRecord = {
  targetId: string;
  project: string;
  outcomeDecision: string;
  recordedAt: string;
};

/** Per-project confusion-matrix row — field names mirror `GateEvalRow` in `src/review/parity.ts`. */
export type CalibrationRow = {
  project: string;
  wouldMerge: number;
  mergeConfirmed: number;
  mergeFalse: number;
  wouldClose: number;
  closeConfirmed: number;
  closeFalse: number;
  hold: number;
  decided: number;
  mergePrecision: number | null;
  closePrecision: number | null;
};

/** Aggregate calibration report over one or more projects. */
export type CalibrationReport = {
  rows: CalibrationRow[];
  /** True once at least one project has enough decided samples to read meaningfully. */
  hasSignal: boolean;
};

export function isPredictedVerdictRecord(value: unknown): value is PredictedVerdictRecord;

export function isObservedOutcomeRecord(value: unknown): value is ObservedOutcomeRecord;

export function isCalibrationRow(value: unknown): value is CalibrationRow;

export function isCalibrationReport(value: unknown): value is CalibrationReport;
