// Calibration report: join the miner's own predicted gate verdicts with the realized outcomes it later observed
// (#4849). Read-only aggregation only — it never touches the live scoring/calibration logic that feeds the gate
// (maintainer-owned). Builds on the types-only scaffolding in calibration-types.js.
import { isCalibrationReport, isCalibrationRow, isObservedOutcomeRecord, isPredictedVerdictRecord, } from "./calibration-types.js";
export { isCalibrationReport, isCalibrationRow, isObservedOutcomeRecord, isPredictedVerdictRecord };
/** Normalize a decision string to the calibration vocabulary (`merge` / `close` / `hold`), or `""` when it is
 *  unrecognized. `value` is always the already-validated non-empty string field of a record (the type guards run
 *  first), so no non-string handling is needed here. Accepts both the predicted (`merge`/`close`/`hold`) and the
 *  realized (`merged`/`closed`) forms. */
function normalizeDecision(value) {
    const decision = value.trim().toLowerCase();
    if (decision === "merge" || decision === "merged")
        return "merge";
    if (decision === "close" || decision === "closed")
        return "close";
    if (decision === "hold")
        return "hold";
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
 */
export function buildCalibrationReport(predictions, outcomes) {
    const outcomeByKey = new Map();
    for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
        if (!isObservedOutcomeRecord(outcome))
            continue;
        outcomeByKey.set(recordKey(outcome.project, outcome.targetId), normalizeDecision(outcome.outcomeDecision));
    }
    const byProject = new Map();
    for (const prediction of Array.isArray(predictions) ? predictions : []) {
        if (!isPredictedVerdictRecord(prediction))
            continue;
        const observed = outcomeByKey.get(recordKey(prediction.project, prediction.targetId));
        if (observed !== "merge" && observed !== "close")
            continue; // pending or unclassifiable outcome
        let row = byProject.get(prediction.project);
        if (!row) {
            row = emptyRow(prediction.project);
            byProject.set(prediction.project, row);
        }
        row.decided += 1;
        const predicted = normalizeDecision(prediction.predictedDecision);
        if (predicted === "merge") {
            row.wouldMerge += 1;
            if (observed === "merge")
                row.mergeConfirmed += 1;
            else
                row.mergeFalse += 1;
        }
        else if (predicted === "close") {
            row.wouldClose += 1;
            if (observed === "close")
                row.closeConfirmed += 1;
            else
                row.closeFalse += 1;
        }
        else if (predicted === "hold") {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FsaWJyYXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjYWxpYnJhdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxnSEFBZ0g7QUFDaEgsZ0hBQWdIO0FBQ2hILG9GQUFvRjtBQUNwRixPQUFPLEVBQ0wsbUJBQW1CLEVBQ25CLGdCQUFnQixFQUNoQix1QkFBdUIsRUFDdkIsd0JBQXdCLEdBQ3pCLE1BQU0sd0JBQXdCLENBQUM7QUFlaEMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLGdCQUFnQixFQUFFLHVCQUF1QixFQUFFLHdCQUF3QixFQUFFLENBQUM7QUFFcEc7OzswQ0FHMEM7QUFDMUMsU0FBUyxpQkFBaUIsQ0FBQyxLQUFhO0lBQ3RDLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUM1QyxJQUFJLFFBQVEsS0FBSyxPQUFPLElBQUksUUFBUSxLQUFLLFFBQVE7UUFBRSxPQUFPLE9BQU8sQ0FBQztJQUNsRSxJQUFJLFFBQVEsS0FBSyxPQUFPLElBQUksUUFBUSxLQUFLLFFBQVE7UUFBRSxPQUFPLE9BQU8sQ0FBQztJQUNsRSxJQUFJLFFBQVEsS0FBSyxNQUFNO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFDdkMsT0FBTyxFQUFFLENBQUM7QUFDWixDQUFDO0FBRUQsU0FBUyxRQUFRLENBQUMsT0FBZTtJQUMvQixPQUFPO1FBQ0wsT0FBTztRQUNQLFVBQVUsRUFBRSxDQUFDO1FBQ2IsY0FBYyxFQUFFLENBQUM7UUFDakIsVUFBVSxFQUFFLENBQUM7UUFDYixVQUFVLEVBQUUsQ0FBQztRQUNiLGNBQWMsRUFBRSxDQUFDO1FBQ2pCLFVBQVUsRUFBRSxDQUFDO1FBQ2IsSUFBSSxFQUFFLENBQUM7UUFDUCxPQUFPLEVBQUUsQ0FBQztRQUNWLGNBQWMsRUFBRSxJQUFJO1FBQ3BCLGNBQWMsRUFBRSxJQUFJO0tBQ3JCLENBQUM7QUFDSixDQUFDO0FBRUQsMkdBQTJHO0FBQzNHLHlH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