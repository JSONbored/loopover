import type {
  CalibrationReport,
  ObservedOutcomeRecord,
  PredictedVerdictRecord,
} from "./calibration-types.js";

export type {
  CalibrationReport,
  CalibrationRow,
  ObservedOutcomeRecord,
  PredictedVerdictRecord,
} from "./calibration-types.js";

export {
  isCalibrationReport,
  isCalibrationRow,
  isObservedOutcomeRecord,
  isPredictedVerdictRecord,
} from "./calibration-types.js";

export function buildCalibrationReport(
  predictions: PredictedVerdictRecord[],
  outcomes: ObservedOutcomeRecord[],
): CalibrationReport;
