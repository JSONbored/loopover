import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initPredictionLedger } from "../../packages/gittensory-miner/lib/prediction-ledger.js";
import {
  collectPredictionMetricRows,
  runMetrics,
} from "../../packages/gittensory-miner/lib/metrics-cli.js";
import type { PredictionLedger } from "../../packages/gittensory-miner/lib/prediction-ledger.d.ts";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger(): PredictionLedger {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  const ledger = initPredictionLedger(join(root, "prediction-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function tempDbPath() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  return join(root, "prediction-ledger.sqlite3");
}

function appendPrediction(ledger: PredictionLedger, targetId: number, conclusion: string) {
  ledger.appendPrediction({ repoFullName: "acme/widgets", targetId, conclusion, pack: "gittensor", engineVersion: "0.2.0" });
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner metrics CLI (#4838)", () => {
  it("collectPredictionMetricRows projects ledger rows onto the renderer's conclusion-only shape", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge");
    appendPrediction(ledger, 2, "close");
    expect(collectPredictionMetricRows(ledger)).toEqual([{ conclusion: "merge" }, { conclusion: "close" }]);
  });

  it("runMetrics renders prediction counters as Prometheus text and returns 0", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge");
    appendPrediction(ledger, 2, "close");
    appendPrediction(ledger, 3, "merge");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runMetrics([], { initPredictionLedger: () => ledger })).toBe(0);

    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("# TYPE loopover_miner_predictions_total counter");
    // Series are emitted in sorted conclusion order, so "close" precedes "merge".
    expect(text).toContain('loopover_miner_predictions_total{conclusion="close"} 1');
    expect(text).toContain('loopover_miner_predictions_total{conclusion="merge"} 2');
    // No outcome-join exists yet, so both the correct and incorrect counters stay zero.
    expect(text).toContain("loopover_miner_prediction_correct_total 0");
    expect(text).toContain("loopover_miner_prediction_incorrect_total 0");
    // The output is a single, once-terminated document (no doubled trailing blank line).
    expect(text.endsWith("\n")).toBe(false);
  });

  it("runMetrics opens and closes its own default ledger when none is injected", () => {
    const dbPath = tempDbPath();
    const seed = initPredictionLedger(dbPath);
    appendPrediction(seed, 1, "hold");
    seed.close();

    const prev = process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB;
    process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = dbPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runMetrics([])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB;
      else process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = prev;
    }
    expect(String(log.mock.calls[0]?.[0])).toContain('loopover_miner_predictions_total{conclusion="hold"} 1');
  });

  it("runMetrics rejects unexpected arguments with a usage error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runMetrics(["--json"], { initPredictionLedger: () => tempLedger() })).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "Usage: loopover-miner metrics",
    });
    error.mockClear();
    log.mockClear();
    expect(runMetrics(["--nope"], { initPredictionLedger: () => tempLedger() })).toBe(2);
    expect(error).toHaveBeenCalledWith("Usage: loopover-miner metrics");
    expect(log).not.toHaveBeenCalled();
  });

  it("runMetrics surfaces a thrown Error message and exits non-zero", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runMetrics([], {
        initPredictionLedger: () => {
          throw new Error("prediction ledger is locked");
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("prediction ledger is locked");
  });

  it("runMetrics stringifies a non-Error throw", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runMetrics([], {
        initPredictionLedger: () => {
          throw "prediction-ledger-unavailable";
        },
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("prediction-ledger-unavailable");
  });
});
