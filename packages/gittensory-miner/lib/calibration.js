// Calibration report: join the miner's own predicted gate verdicts with the realized outcomes it later observed
// (#4849). Read-only aggregation only — it never touches the live scoring/calibration logic that feeds the gate
// (maintainer-owned). Builds on the types-only scaffolding in calibration-types.js.
import {
  isCalibrationReport,
  isCalibrationRow,
  isObservedOutcomeRecord,
  isPredictedVerdictRecord,
} from "./calibration-types.js";

export { isCalibrationReport, isCalibrationRow, isObservedOutcomeRecord, isPredictedVerdictRecord };

/** Normalize a decision string to the calibration vocabulary (`merge` / `close` / `hold`), or `""` when it is
 *  unrecognized. `value` is always the already-validated non-empty string field of a record (the type guards run
 *  first), so no non-string handling is needed here. Accepts both the predicted (`merge`/`close`/`hold`) and the
 *  realized (`merged`/`closed`) forms. */
function normalizeDecision(value) {
  const decision = value.trim().toLowerCase();
  if (decision === "merge" || decision === "merged") return "merge";
  if (decision === "close" || decision === "closed") return "close";
  if (decision === "hold") return "hold";
  return "";
}

function emptyRow(project) {
  return {
    project,
    wouldMerge: 0,
    mergeConfirmed: 0,
    mergeFalse: 0,
    wouldClose: 0,
    closeConfirmed: 0,
    closeFalse: 0,
    hold: 0,
    decided: 0,
    mergePrecision: null,
    closePrecision: null,
  };
}

// Key a record by its (project, targetId). Project and targetId are validated non-empty strings; the space
// separator is fine for keying (collisions across different (project, targetId) pairs are astronomically
// unlikely and would only merge two projects' tallies, never fabricate a false one).
function recordKey(project, targetId) {
  return `${project} ${targetId}`;
}

/**
 * Join predicted-verdict records with realized-outcome records into a per-project calibration report. Pure and
 * read-only. A prediction counts as "decided" only when a realized outcome for the SAME `(project, targetId)`
 * exists AND resolves to a clear `merge` or `close`; a still-pending prediction (no outcome) or one whose outcome
 * is unrecognized is skipped. Per project it tallies the confusion matrix (would-merge/close vs confirmed/false,
 * plus holds) and derives merge/close precision (null below one relevant sample). Malformed records on either
 * side are ignored. Rows are sorted by project for a stable render.
 *
 * @param {import("./calibration-types.js").PredictedVerdictRecord[]} predictions
 * @param {import("./calibration-types.js").ObservedOutcomeRecord[]} outcomes
 * @returns {import("./calibration-types.js").CalibrationReport}
 */
export function buildCalibrationReport(predictions, outcomes) {
  const outcomeByKey = new Map();
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (!isObservedOutcomeRecord(outcome)) continue;
    outcomeByKey.set(recordKey(outcome.project, outcome.targetId), normalizeDecision(outcome.outcomeDecision));
  }

  const byProject = new Map();
  for (const prediction of Array.isArray(predictions) ? predictions : []) {
    if (!isPredictedVerdictRecord(prediction)) continue;
    const observed = outcomeByKey.get(recordKey(prediction.project, prediction.targetId));
    if (observed !== "merge" && observed !== "close") continue; // pending or unclassifiable outcome
    let row = byProject.get(prediction.project);
    if (!row) {
      row = emptyRow(prediction.project);
      byProject.set(prediction.project, row);
    }
    row.decided += 1;
    const predicted = normalizeDecision(prediction.predictedDecision);
    if (predicted === "merge") {
      row.wouldMerge += 1;
      if (observed === "merge") row.mergeConfirmed += 1;
      else row.mergeFalse += 1;
    } else if (predicted === "close") {
      row.wouldClose += 1;
      if (observed === "close") row.closeConfirmed += 1;
      else row.closeFalse += 1;
    } else if (predicted === "hold") {
      row.hold += 1;
    }
  }

  const rows = [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
  for (const row of rows) {
    row.mergePrecision = row.wouldMerge > 0 ? row.mergeConfirmed / row.wouldMerge : null;
    row.closePrecision = row.wouldClose > 0 ? row.closeConfirmed / row.wouldClose : null;
  }
  // Signal exists once any project carries at least one decided (predicted-then-realized) sample.
  return { hasSignal: rows.length > 0, rows };
}
