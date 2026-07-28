// Miner prediction-calibration metrics (#4264). A pure Prometheus text-exposition renderer for the miner's own
// predicted-gate accuracy, the miner-side counterpart to the server's src/selfhost/metrics.ts registry. It turns
// prediction-ledger rows (packages/loopover-miner/lib/prediction-ledger.js `readPredictions`) — optionally
// joined with their realized outcome — into counters a future dashboard can scrape.
//
// Scoped as an on-demand RENDERER, not a live HTTP registry: loopover-miner is a local CLI, not a daemon, so a
// caller renders this to stdout for its own scrape/cron setup and reads the ledger itself (no data collection of
// its own lives here — this stays a pure, side-effect-free function like the rest of loopover-engine). It mirrors
// the metric-naming (`loopover_miner_*_total`) and HELP/TYPE/label conventions of src/selfhost/metrics.ts rather
// than importing across the package boundary.
//
// Counters emitted:
// - `loopover_miner_predictions_total{conclusion="..."}` — predictions recorded, one series per predicted
//   conclusion (e.g. merge/close/hold).
// - `loopover_miner_prediction_correct_total` — predictions whose realized outcome matched the prediction.
// - `loopover_miner_prediction_incorrect_total` — predictions whose realized outcome differed.
// The correct/incorrect counters only move for rows carrying a resolved outcome; unresolved rows count toward
// `predictions_total` only, so the surface is meaningful before outcome-pairing exists and grows once it does.

export const MINER_PREDICTIONS_TOTAL = "loopover_miner_predictions_total";
export const MINER_PREDICTION_CORRECT_TOTAL = "loopover_miner_prediction_correct_total";
export const MINER_PREDICTION_INCORRECT_TOTAL = "loopover_miner_prediction_incorrect_total";

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

/** One metric family, structured — the same content the text exposition renders. */
export type MinerPredictionMetricFamily = {
  name: string;
  type: "counter";
  help: string;
  samples: { value: number; labels?: Record<string, string> }[];
};

/**
 * Aggregate the ledger rows into structured metric families (#9523).
 *
 * This is the ONE aggregation: {@link renderMinerPredictionMetrics} formats these into Prometheus text, and
 * the miner's `loopover_miner_get_metrics_snapshot` MCP tool returns them as JSON. A second summing pass for
 * the JSON surface would be a second definition of what each counter means, free to drift from the scrape.
 * Deterministic — conclusion series are emitted in sorted order.
 */
export function collectMinerPredictionMetrics(rows: readonly MinerPredictionMetricRow[]): MinerPredictionMetricFamily[] {
  const totalByConclusion = new Map<string, number>();
  let correct = 0;
  let incorrect = 0;
  for (const row of rows) {
    totalByConclusion.set(row.conclusion, (totalByConclusion.get(row.conclusion) ?? 0) + 1);
    if (row.correct === true) correct += 1;
    else if (row.correct === false) incorrect += 1;
  }
  return [
    {
      name: MINER_PREDICTIONS_TOTAL,
      type: "counter",
      help: "Gate-outcome predictions the miner has recorded, by predicted conclusion.",
      samples: [...totalByConclusion.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([conclusion, value]) => ({ value, labels: { conclusion } })),
    },
    {
      name: MINER_PREDICTION_CORRECT_TOTAL,
      type: "counter",
      help: "Predictions whose realized outcome matched the predicted conclusion.",
      samples: [{ value: correct }],
    },
    {
      name: MINER_PREDICTION_INCORRECT_TOTAL,
      type: "counter",
      help: "Predictions whose realized outcome differed from the predicted conclusion.",
      samples: [{ value: incorrect }],
    },
  ];
}

export function renderMinerPredictionMetrics(rows: readonly MinerPredictionMetricRow[]): string {
  const lines: string[] = [];
  for (const family of collectMinerPredictionMetrics(rows)) {
    lines.push(`# HELP ${family.name} ${escapeHelpText(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const labels = sample.labels
        ? `{${Object.entries(sample.labels)
            .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
            .join(",")}}`
        : "";
      lines.push(`${family.name}${labels} ${sample.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
