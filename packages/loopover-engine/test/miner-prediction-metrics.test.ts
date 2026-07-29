import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINER_PREDICTIONS_TOTAL,
  MINER_PREDICTION_CORRECT_TOTAL,
  MINER_PREDICTION_INCORRECT_TOTAL,
  collectMinerPredictionMetrics,
  renderMinerPredictionMetrics,
  type MinerPredictionMetricRow,
} from "../dist/index.js";

// #9523: the miner's prediction-calibration metrics, now split into an aggregation
// (`collectMinerPredictionMetrics`) and a text renderer that formats it. The split exists so the miner's
// `loopover_miner_get_metrics_snapshot` MCP tool can return the SAME families the Prometheus scrape emits --
// a second summing pass for the JSON surface would be a second definition of what each counter means, free
// to drift from what a scrape reports.

const ROWS: MinerPredictionMetricRow[] = [
  { conclusion: "merge", correct: true },
  { conclusion: "merge", correct: false },
  { conclusion: "close", correct: true },
  { conclusion: "hold" },
];

test("collect: counts every prediction by conclusion, in sorted order", () => {
  const families = collectMinerPredictionMetrics(ROWS);
  const totals = families.find((family) => family.name === MINER_PREDICTIONS_TOTAL);
  assert.ok(totals);
  // Sorted so the surface is deterministic across runs.
  assert.deepEqual(
    totals.samples.map((sample) => sample.labels?.conclusion),
    ["close", "hold", "merge"],
  );
  assert.deepEqual(
    totals.samples.map((sample) => sample.value),
    [1, 1, 2],
  );
});

test("collect: correct/incorrect only move for rows carrying a RESOLVED outcome", () => {
  const families = collectMinerPredictionMetrics(ROWS);
  // The `hold` row has no `correct` field: it counts toward predictions_total only, so the surface stays
  // meaningful before outcome-pairing exists and grows once it does.
  assert.equal(families.find((family) => family.name === MINER_PREDICTION_CORRECT_TOTAL)?.samples[0]?.value, 2);
  assert.equal(families.find((family) => family.name === MINER_PREDICTION_INCORRECT_TOTAL)?.samples[0]?.value, 1);
});

test("collect: emits all three counters for an EMPTY ledger, so the surface is well-formed from day one", () => {
  const families = collectMinerPredictionMetrics([]);
  assert.deepEqual(families.map((family) => family.name), [
    MINER_PREDICTIONS_TOTAL,
    MINER_PREDICTION_CORRECT_TOTAL,
    MINER_PREDICTION_INCORRECT_TOTAL,
  ]);
  // No conclusions seen yet, so the labelled counter has no series -- but it still declares itself.
  assert.deepEqual(families[0]?.samples, []);
  assert.equal(families[1]?.samples[0]?.value, 0);
  assert.equal(families[2]?.samples[0]?.value, 0);
});

test("collect: treats a null `correct` as unresolved, not as incorrect", () => {
  const families = collectMinerPredictionMetrics([{ conclusion: "merge", correct: null }]);
  assert.equal(families.find((family) => family.name === MINER_PREDICTION_CORRECT_TOTAL)?.samples[0]?.value, 0);
  assert.equal(families.find((family) => family.name === MINER_PREDICTION_INCORRECT_TOTAL)?.samples[0]?.value, 0);
});

test("render: formats the collected families as Prometheus text exposition", () => {
  const text = renderMinerPredictionMetrics(ROWS);
  assert.match(text, new RegExp(`# HELP ${MINER_PREDICTIONS_TOTAL} `));
  assert.match(text, new RegExp(`# TYPE ${MINER_PREDICTIONS_TOTAL} counter`));
  assert.match(text, new RegExp(`${MINER_PREDICTIONS_TOTAL}\\{conclusion="merge"\\} 2`));
  assert.match(text, new RegExp(`${MINER_PREDICTION_CORRECT_TOTAL} 2`));
  assert.match(text, new RegExp(`${MINER_PREDICTION_INCORRECT_TOTAL} 1`));
  assert.ok(text.endsWith("\n"), "the document is newline-terminated");
});

test("render: an unlabelled counter emits no braces at all", () => {
  const text = renderMinerPredictionMetrics([]);
  assert.match(text, new RegExp(`\\n${MINER_PREDICTION_CORRECT_TOTAL} 0\\n`));
});

test("render: escapes a hostile conclusion so it cannot break the exposition line", () => {
  // A conclusion is data, not a literal: a quote, a backslash, or a newline in it must not forge a series.
  const text = renderMinerPredictionMetrics([{ conclusion: 'we"ird\\back\nline' }]);
  assert.match(text, /conclusion="we\\"ird\\\\back\\nline"/);
  // Exactly one sample line for that counter -- the injected newline did not split it into two.
  const sampleLines = text.split("\n").filter((line) => line.startsWith(`${MINER_PREDICTIONS_TOTAL}{`));
  assert.equal(sampleLines.length, 1);
});

test("render and collect agree: every collected sample appears in the rendered text", () => {
  // The whole point of the split -- the scrape and the JSON snapshot cannot report different numbers.
  const families = collectMinerPredictionMetrics(ROWS);
  const text = renderMinerPredictionMetrics(ROWS);
  for (const family of families) {
    for (const sample of family.samples) {
      const labels = sample.labels ? `{conclusion="${sample.labels.conclusion}"}` : "";
      assert.ok(text.includes(`${family.name}${labels} ${sample.value}`), `${family.name}${labels} should be rendered`);
    }
  }
});
