import { renderMinerPredictionMetrics } from "@loopover/engine";
import type { MinerPredictionMetricRow } from "@loopover/engine";
import { buildOutcomeDecisionMap, resolvePredictionCorrectness } from "./calibration.js";
import type { ObservedOutcomeRecord } from "./calibration-types.js";
import { toOutcomeRecords, toPredictionRecords } from "./calibration-cli.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import type { EventLedger } from "./event-ledger.js";
import { initPredictionLedger } from "./prediction-ledger.js";
import type { PredictionLedger } from "./prediction-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

// `metrics` (#4838): render the miner's prediction-calibration counters as Prometheus text-exposition to stdout,
// for a scrape wrapper or cron redirect. The counters are produced by the engine's already-built
// renderMinerPredictionMetrics (packages/loopover-engine/src/miner-prediction-metrics.ts) -- this command reads
// the local prediction ledger, joins each row with realized `pr_outcome` events from the event ledger
// (calibration-cli.js's toPredictionRecords/toOutcomeRecords + calibration.js's join), and feeds the resolved
// rows to the renderer. Strictly local + offline: no network, no writes.

const METRICS_USAGE = "Usage: loopover-miner metrics";

/**
 * Project prediction-ledger rows onto the engine renderer's metric-row shape, pairing each predicted `conclusion`
 * with a realized outcome when one exists for the same `(repoFullName, targetId)`. Reuses calibration-cli.js's
 * record mappers and calibration.js's {@link resolvePredictionCorrectness} so the join matches
 * `buildCalibrationReport` exactly.
 */
export function collectPredictionMetricRows(
  ledger: PredictionLedger,
  outcomes: ObservedOutcomeRecord[] = [],
): MinerPredictionMetricRow[] {
  const outcomeByKey = buildOutcomeDecisionMap(outcomes);
  return toPredictionRecords(ledger.readPredictions()).map((prediction) => {
    const correct = resolvePredictionCorrectness(prediction, outcomeByKey);
    const row: MinerPredictionMetricRow = { conclusion: prediction.predictedDecision };
    if (correct !== undefined) row.correct = correct;
    return row;
  });
}

// Open the local prediction ledger (or a test-injected one) for the duration of `run`, closing it only when we
// opened it -- an injected ledger is owned by the caller. Mirrors event-ledger-cli.js's withEventLedger.
function withPredictionLedger<T>(
  options: { initPredictionLedger?: () => PredictionLedger },
  run: (ledger: PredictionLedger) => T,
): T {
  const ownsLedger = options.initPredictionLedger === undefined;
  const ledger = (options.initPredictionLedger ?? initPredictionLedger)();
  try {
    return run(ledger);
  } finally {
    if (ownsLedger) ledger.close();
  }
}

export function runMetrics(
  args: string[],
  options: {
    initPredictionLedger?: () => PredictionLedger;
    initEventLedger?: () => EventLedger;
    env?: Record<string, string | undefined>;
  } = {},
): number {
  if (args.length > 0) {
    return reportCliFailure(argsWantJson(args), METRICS_USAGE);
  }

  const env = options.env ?? process.env;
  let eventLedger: EventLedger | undefined;
  const ownsEventLedger = options.initEventLedger === undefined;

  try {
    return withPredictionLedger(options, (ledger) => {
      eventLedger = (options.initEventLedger ?? (() => initEventLedger(resolveEventLedgerDbPath(env))))();
      const outcomes = toOutcomeRecords(eventLedger.readEvents());
      // renderMinerPredictionMetrics returns a newline-terminated document; console.log re-adds the terminator, so
      // trim it to emit exactly one trailing newline.
      console.log(renderMinerPredictionMetrics(collectPredictionMetricRows(ledger, outcomes)).trimEnd());
      return 0;
    });
  } catch (error) {
    return reportCliFailure(argsWantJson(args), describeCliError(error));
  } finally {
    if (ownsEventLedger) eventLedger?.close();
  }
}
