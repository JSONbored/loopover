import { isCalibrationReport, isCalibrationRow, isObservedOutcomeRecord, isPredictedVerdictRecord } from "./calibration-types.js";
import type { CalibrationReport, ObservedOutcomeRecord, PredictedVerdictRecord } from "./calibration-types.js";
export type { CalibrationReport, CalibrationRow, ObservedOutcomeRecord, PredictedVerdictRecord, } from "./calibration-types.js";
export { isCalibrationReport, isCalibrationRow, isObservedOutcomeRecord, isPredictedVerdictRecord };
/**
 * Join predicted-verdict records with realized-outcome records into a per-project calibration report. Pure and
 * read-only. A prediction counts as "decided" only when a realized outcome for the SAME `(project, targetId)`
 * exists AND resolves to a clear `merge` or `close`; a still-pending prediction (no outcome) or one whose outcome
 * is unrecognized is skipped. Per project it tallies the confusion matrix (would-merge/close vs confirmed/false,
 * plus holds) and derives merge/close precision (null below one relevant sample). Malformed records on either
 * side are ignored. Rows are sorted by project for a stable render.
 */
export declare function buildCalibrationReport(predictions: PredictedVerdictRecord[], outcomes: ObservedOutcomeRecord[]): CalibrationReport;
