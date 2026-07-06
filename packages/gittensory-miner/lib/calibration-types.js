// Shared calibration shapes for the miner self-improvement phase (#2332). Types-only scaffolding —
// report/ledger/metrics issues build on this module. Field names mirror `GateEvalRow` /
// `GateEvalReport` in `src/review/parity.ts` for easy mental mapping without importing cloud code.

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value) {
  return value === undefined || isNonEmptyString(value);
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableRatio(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

/** @param {unknown} value */
export function isPredictedVerdictRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return (
    isNonEmptyString(record.targetId)
    && isNonEmptyString(record.project)
    && isNonEmptyString(record.predictedDecision)
    && isNonEmptyString(record.recordedAt)
    && isOptionalString(record.source)
  );
}

/** @param {unknown} value */
export function isObservedOutcomeRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return (
    isNonEmptyString(record.targetId)
    && isNonEmptyString(record.project)
    && isNonEmptyString(record.outcomeDecision)
    && isNonEmptyString(record.recordedAt)
  );
}

/** @param {unknown} value */
export function isCalibrationRow(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = /** @type {Record<string, unknown>} */ (value);
  return (
    isNonEmptyString(row.project)
    && isNonNegativeInteger(row.wouldMerge)
    && isNonNegativeInteger(row.mergeConfirmed)
    && isNonNegativeInteger(row.mergeFalse)
    && isNonNegativeInteger(row.wouldClose)
    && isNonNegativeInteger(row.closeConfirmed)
    && isNonNegativeInteger(row.closeFalse)
    && isNonNegativeInteger(row.hold)
    && isNonNegativeInteger(row.decided)
    && isNullableRatio(row.mergePrecision)
    && isNullableRatio(row.closePrecision)
  );
}

/** @param {unknown} value */
export function isCalibrationReport(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const report = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof report.hasSignal === "boolean"
    && Array.isArray(report.rows)
    && report.rows.every((row) => isCalibrationRow(row))
  );
}
