// `gittensory-miner metrics` (#4838): wire the already-built pure Prometheus renderer (gittensory-engine's
// renderMinerPredictionMetrics, designed for cron/scrape use but previously never called) into a real command.
// Reads the local prediction ledger, pairs each prediction with its realized PR outcome (event-ledger pr_outcome
// events) to mark it correct/incorrect, and prints the renderer's Prometheus text-exposition output to stdout for
// a scrape wrapper or cron redirect. Read-only; does not modify the renderer — it is already correct.
import { renderMinerPredictionMetrics } from "@jsonbored/gittensory-engine";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import { MINER_PR_OUTCOME_EVENT } from "./pr-outcome.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";

const METRICS_USAGE = "Usage: gittensory-miner metrics";

/** Normalize a predicted conclusion or a realized outcome decision to a shared vocabulary so the two can be
 *  compared: `merged` → "merge", `closed` → "close", anything else lower-cased and trimmed. Both call sites pass a
 *  guaranteed string (the ledger's `conclusion` is NOT NULL; a decision is `typeof`-checked before this is called). */
function normalizeDecision(value) {
  const text = value.trim().toLowerCase();
  if (text === "merged") return "merge";
  if (text === "closed") return "close";
  return text;
}

/** Reduce the append-only pr_outcome event stream to the latest realized decision per `${repoFullName}:${targetId}`.
 *  Non-outcome events and malformed payloads are skipped. */
function latestOutcomeByKey(events) {
  const latest = new Map();
  for (const event of events) {
    if (event?.type !== MINER_PR_OUTCOME_EVENT) continue;
    const payload = event.payload;
    if (!payload || !Number.isInteger(payload.prNumber) || typeof payload.decision !== "string") continue;
    latest.set(`${event.repoFullName}:${payload.prNumber}`, normalizeDecision(payload.decision));
  }
  return latest;
}

/** Map prediction rows to the renderer's metric-row shape, marking `correct` only for predictions whose target has
 *  a realized outcome (`null` leaves the row counted toward predictions_total but not correct/incorrect). */
function toMetricRows(predictions, outcomesByKey) {
  return predictions.map((prediction) => {
    const outcome = outcomesByKey.get(`${prediction.repoFullName}:${prediction.targetId}`);
    const correct = outcome === undefined ? null : normalizeDecision(prediction.conclusion) === outcome;
    return { conclusion: prediction.conclusion, correct };
  });
}

/**
 * Run `gittensory-miner metrics`. Reads the prediction ledger + realized pr_outcome events, pairs them, and writes
 * the existing renderer's Prometheus text-exposition output to stdout. Returns the process exit code: 0 on success,
 * 1 on an unknown option.
 * @param {string[]} [args]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function runMetricsCli(args = [], env = process.env) {
  const unknown = args.find((token) => token.startsWith("-"));
  if (unknown) {
    console.error(`Unknown option: ${unknown}. ${METRICS_USAGE}`);
    return 1;
  }

  const predictionStore = initPredictionLedger(resolvePredictionLedgerDbPath(env));
  const eventLedger = initEventLedger(resolveEventLedgerDbPath(env));
  try {
    const outcomesByKey = latestOutcomeByKey(eventLedger.readEvents());
    const rows = toMetricRows(predictionStore.readPredictions(), outcomesByKey);
    process.stdout.write(renderMinerPredictionMetrics(rows));
    return 0;
  } finally {
    predictionStore.close();
    eventLedger.close();
  }
}
