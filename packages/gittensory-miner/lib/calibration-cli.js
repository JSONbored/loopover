// `gittensory-miner calibration [--json]` (#4849): a read-only report joining the miner's own predicted gate
// verdicts (prediction-ledger) with the realized PR outcomes it later observed (event-ledger `pr_outcome`
// events), via the pure buildCalibrationReport join. Opens both local stores, maps their rows to the
// calibration record shapes, renders, and closes. Never modifies the live scoring/calibration logic.
import { buildCalibrationReport } from "./calibration.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import { MINER_PR_OUTCOME_EVENT } from "./pr-outcome.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";

const CALIBRATION_USAGE = "Usage: gittensory-miner calibration [--json]";

/** Map prediction-ledger rows to predicted-verdict records: the target id becomes a string key and the recorded
 *  prediction verdict is the `conclusion`. */
function toPredictionRecords(rows) {
  return rows.map((row) => ({
    project: row.repoFullName,
    targetId: String(row.targetId),
    predictedDecision: row.conclusion,
    recordedAt: row.ts,
  }));
}

/** Reduce the append-only `pr_outcome` event stream to the LATEST observed outcome per (repo, PR), as
 *  observed-outcome records. `recordedAt` comes from the event's own timestamp (always present), so an outcome is
 *  never dropped for lacking a `closedAt`. Malformed payloads are skipped. */
function toOutcomeRecords(events) {
  const latest = new Map();
  for (const event of events) {
    if (event?.type !== MINER_PR_OUTCOME_EVENT) continue;
    const payload = event.payload;
    if (!payload || !Number.isInteger(payload.prNumber) || typeof payload.decision !== "string") continue;
    latest.set(`${event.repoFullName}:${payload.prNumber}`, {
      project: event.repoFullName,
      targetId: String(payload.prNumber),
      outcomeDecision: payload.decision,
      recordedAt: event.createdAt,
    });
  }
  return [...latest.values()];
}

function renderReportText(report) {
  if (!report.hasSignal) {
    console.log("calibration: no decided predictions yet (predictions need a realized merge/close outcome).");
    return;
  }
  for (const row of report.rows) {
    const merge = row.mergePrecision === null ? "n/a" : `${Math.round(row.mergePrecision * 100)}%`;
    const close = row.closePrecision === null ? "n/a" : `${Math.round(row.closePrecision * 100)}%`;
    console.log(
      `${row.project}: ${row.decided} decided | ` +
        `merge ${row.mergeConfirmed}/${row.wouldMerge} (${merge}) | ` +
        `close ${row.closeConfirmed}/${row.wouldClose} (${close}) | hold ${row.hold}`,
    );
  }
}

/**
 * Run `gittensory-miner calibration [--json]`. Reads the prediction ledger + PR-outcome events, joins them into a
 * calibration report, and prints it (a JSON dump under `--json`, else a per-project text summary). Returns the
 * process exit code: 0 on success, 1 on an unknown option.
 * @param {string[]} [args]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function runCalibrationCli(args = [], env = process.env) {
  const json = args.includes("--json");
  const unknown = args.find((token) => token.startsWith("-") && token !== "--json");
  if (unknown) {
    console.error(`Unknown option: ${unknown}. ${CALIBRATION_USAGE}`);
    return 1;
  }

  const predictionStore = initPredictionLedger(resolvePredictionLedgerDbPath(env));
  const eventLedger = initEventLedger(resolveEventLedgerDbPath(env));
  try {
    const report = buildCalibrationReport(
      toPredictionRecords(predictionStore.readPredictions()),
      toOutcomeRecords(eventLedger.readEvents()),
    );
    if (json) console.log(JSON.stringify(report, null, 2));
    else renderReportText(report);
    return 0;
  } finally {
    predictionStore.close();
    eventLedger.close();
  }
}
