// Miner prediction-calibration metrics (#4264). A pure Prometheus text-exposition renderer for the miner's own
// predicted-gate accuracy, the miner-side counterpart to the server's src/selfhost/metrics.ts registry. It turns
// prediction-ledger rows (packages/gittensory-miner/lib/prediction-ledger.js `readPredictions`) — optionally
// joined with their realized outcome — into counters a future dashboard can scrape.
//
// Scoped as an on-demand RENDERER, not a live HTTP registry: gittensory-miner is a local CLI, not a daemon, so a
// caller renders this to stdout for its own scrape/cron setup and reads the ledger itself (no data collection of
// its own lives here — this stays a pure, side-effect-free function like the rest of gittensory-engine). It mirrors
// the metric-naming (`gittensory_miner_*_total`) and HELP/TYPE/label conventions of src/selfhost/metrics.ts rather
// than importing across the package boundary.
//
// Counters emitted:
// - `gittensory_miner_predictions_total{conclusion="..."}` — predictions recorded, one series per predicted
//   conclusion (e.g. merge/close/hold).
// - `gittensory_miner_prediction_correct_total` — predictions whose realized outcome matched the prediction.
// - `gittensory_miner_prediction_incorrect_total` — predictions whose realized outcome differed.
// The correct/incorrect counters only move for rows carrying a resolved outcome; unresolved rows count toward
// `predictions_total` only, so the surface is meaningful before outcome-pairing exists and grows once it does.

export const MINER_PREDICTIONS_TOTAL = "gittensory_miner_predictions_total";
export const MINER_PREDICTION_CORRECT_TOTAL = "gittensory_miner_prediction_correct_total";
export const MINER_PREDICTION_INCORRECT_TOTAL = "gittensory_miner_prediction_incorrect_total";

/** One prediction-ledger row for metrics: its predicted `conclusion`, plus an optional realized-outcome pairing
 *  (`correct`: true = matched, false = differed, null/undefined = not yet resolved). */
export type MinerPredictionMetricRow = {
  conclusion: string;
  correct?: boolean | null;
};

/** Mirror src/selfhost/metrics.ts:204 — HELP text escapes backslash and newline. */
function escapeHelpText(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Prometheus label-value escaping (backslash, double-quote, newline), a correctness-complete superset of
 *  src/selfhost/metrics.ts:193's `"`-only escape so an arbitrary conclusion string can never break the line. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render prediction-calibration counters as Prometheus text-exposition format. Pure and side-effect-free: a caller
 * supplies the ledger rows (joined with any resolved outcomes) and prints the result. Deterministic — conclusion
 * series are emitted in sorted order. Always emits HELP/TYPE for every counter, so the surface is well-formed even
 * for an empty ledger.
 */
export function renderMinerPredictionMetrics(rows: readonly MinerPredictionMetricRow[]): string {
  const totalByConclusion = new Map<string, number>();
  let correct = 0;
  let incorrect = 0;
  for (const row of rows) {
    totalByConclusion.set(row.conclusion, (totalByConclusion.get(row.conclusion) ?? 0) + 1);
    if (row.correct === true) correct += 1;
    else if (row.correct === false) incorrect += 1;
  }

  const lines: string[] = [];
  lines.push(`# HELP ${MINER_PREDICTIONS_TOTAL} ${escapeHelpText("Gate-outcome predictions the miner has recorded, by predicted conclusion.")}`);
  lines.push(`# TYPE ${MINER_PREDICTIONS_TOTAL} counter`);
  for (const [conclusion, count] of [...totalByConclusion.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${MINER_PREDICTIONS_TOTAL}{conclusion="${escapeLabelValue(conclusion)}"} ${count}`);
  }

  lines.push(`# HELP ${MINER_PREDICTION_CORRECT_TOTAL} ${escapeHelpText("Predictions whose realized outcome matched the predicted conclusion.")}`);
  lines.push(`# TYPE ${MINER_PREDICTION_CORRECT_TOTAL} counter`);
  lines.push(`${MINER_PREDICTION_CORRECT_TOTAL} ${correct}`);

  lines.push(`# HELP ${MINER_PREDICTION_INCORRECT_TOTAL} ${escapeHelpText("Predictions whose realized outcome differed from the predicted conclusion.")}`);
  lines.push(`# TYPE ${MINER_PREDICTION_INCORRECT_TOTAL} counter`);
  lines.push(`${MINER_PREDICTION_INCORRECT_TOTAL} ${incorrect}`);

  return `${lines.join("\n")}\n`;
}
