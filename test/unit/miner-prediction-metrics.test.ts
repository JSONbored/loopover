import { describe, expect, it } from "vitest";
import {
  MINER_PREDICTIONS_TOTAL,
  MINER_PREDICTION_CORRECT_TOTAL,
  MINER_PREDICTION_INCORRECT_TOTAL,
  renderMinerPredictionMetrics,
} from "../../packages/gittensory-engine/src/index";

/** Parse `name{labels} value` / `name value` data lines out of an exposition string, keyed for easy assertions. */
function dataLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.lastIndexOf(" ");
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

describe("miner prediction-calibration metrics (#4264)", () => {
  it("re-exports the renderer and metric-name constants from the engine barrel", () => {
    expect(typeof renderMinerPredictionMetrics).toBe("function");
    expect(MINER_PREDICTIONS_TOTAL).toBe("gittensory_miner_predictions_total");
    expect(MINER_PREDICTION_CORRECT_TOTAL).toBe("gittensory_miner_prediction_correct_total");
    expect(MINER_PREDICTION_INCORRECT_TOTAL).toBe("gittensory_miner_prediction_incorrect_total");
  });

  it("emits well-formed HELP/TYPE and zeroed counters for an empty ledger", () => {
    const text = renderMinerPredictionMetrics([]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain(`# HELP ${MINER_PREDICTIONS_TOTAL} `);
    expect(text).toContain(`# TYPE ${MINER_PREDICTIONS_TOTAL} counter`);
    // no predictions_total series when empty; correct/incorrect are single zeroed lines
    expect(text).not.toContain(`${MINER_PREDICTIONS_TOTAL}{`);
    expect(dataLines(text)).toEqual({
      [MINER_PREDICTION_CORRECT_TOTAL]: "0",
      [MINER_PREDICTION_INCORRECT_TOTAL]: "0",
    });
  });

  it("counts predictions per conclusion in sorted order and ignores unresolved rows for correct/incorrect", () => {
    const text = renderMinerPredictionMetrics([
      { conclusion: "merge" },
      { conclusion: "merge", correct: true },
      { conclusion: "close", correct: false },
      { conclusion: "hold" }, // unresolved: counts toward total only
      { conclusion: "merge", correct: null }, // explicit unresolved
    ]);
    const d = dataLines(text);
    expect(d[`${MINER_PREDICTIONS_TOTAL}{conclusion="merge"}`]).toBe("3");
    expect(d[`${MINER_PREDICTIONS_TOTAL}{conclusion="close"}`]).toBe("1");
    expect(d[`${MINER_PREDICTIONS_TOTAL}{conclusion="hold"}`]).toBe("1");
    expect(d[MINER_PREDICTION_CORRECT_TOTAL]).toBe("1");
    expect(d[MINER_PREDICTION_INCORRECT_TOTAL]).toBe("1");

    // deterministic: conclusion series are alphabetically sorted (close, hold, merge)
    const order = [...text.matchAll(/conclusion="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["close", "hold", "merge"]);
  });

  it("escapes backslashes, quotes, and newlines in a conclusion label value", () => {
    const text = renderMinerPredictionMetrics([{ conclusion: 'we"ird\\\nvalue' }]);
    expect(text).toContain(`${MINER_PREDICTIONS_TOTAL}{conclusion="we\\"ird\\\\\\nvalue"} 1`);
  });
});
