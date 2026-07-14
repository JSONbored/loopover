import { renderMinerPredictionMetrics } from "@loopover/engine";
import { initPredictionLedger } from "./prediction-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

// `metrics` (#4838): render the miner's prediction-calibration counters as Prometheus text-exposition to stdout,
// for a scrape wrapper or cron redirect. The counters are produced by the engine's already-built
// renderMinerPredictionMetrics (packages/gittensory-engine/src/miner-prediction-metrics.ts) -- this command only
// reads the local prediction ledger and feeds it in, never touching the renderer itself. Strictly local + offline:
// no network, no writes.

const METRICS_USAGE = "Usage: loopover-miner metrics";

/**
 * Project prediction-ledger rows onto the engine renderer's metric-row shape -- the predicted `conclusion` only.
 * The realized-outcome pairing (`correct`) is intentionally left unset: the miner has no outcome-join yet, so the
 * correct/incorrect counters stay zero and only `predictions_total{conclusion}` moves -- exactly how the renderer
 * is designed to degrade before outcome-pairing exists (see its header comment).
 */
export function collectPredictionMetricRows(ledger) {
  return ledger.readPredictions().map((entry) => ({ conclusion: entry.conclusion }));
}

// Open the local prediction ledger (or a test-injected one) for the duration of `run`, closing it only when we
// opened it -- an injected ledger is owned by the caller. Mirrors event-ledger-cli.js's withEventLedger.
function withPredictionLedger(options, run) {
  const ownsLedger = options.initPredictionLedger === undefined;
  const ledger = (options.initPredictionLedger ?? initPredictionLedger)();
  try {
    return run(ledger);
  } finally {
    if (ownsLedger) ledger.close();
  }
}

export function runMetrics(args, options = {}) {
  if (args.length > 0) {
    return reportCliFailure(argsWantJson(args), METRICS_USAGE);
  }

  try {
    return withPredictionLedger(options, (ledger) => {
      // renderMinerPredictionMetrics returns a newline-terminated document; console.log re-adds the terminator, so
      // trim it to emit exactly one trailing newline.
      console.log(renderMinerPredictionMetrics(collectPredictionMetricRows(ledger)).trimEnd());
      return 0;
    });
  } catch (error) {
    return reportCliFailure(argsWantJson(args), describeCliError(error));
  }
}
