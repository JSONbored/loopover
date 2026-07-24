import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initEventLedger,
  resolveEventLedgerDbPath,
} from "../../packages/loopover-miner/lib/event-ledger.js";
import type { EventLedger, LedgerEntry } from "../../packages/loopover-miner/lib/event-ledger.js";
import {
  initPredictionLedger,
  resolvePredictionLedgerDbPath,
} from "../../packages/loopover-miner/lib/prediction-ledger.js";
import {
  collectPredictionMetricRows,
  runMetrics,
} from "../../packages/loopover-miner/lib/metrics-cli.js";
import type { PredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger.d.ts";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger(): PredictionLedger {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  const ledger = initPredictionLedger(join(root, "prediction-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function tempEventLedger(): EventLedger {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-evt-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  return root;
}

/** Env pointing both local stores at a fresh temp config dir (mirrors miner-calibration-cli.test.ts). */
function tempConfigEnv(): Record<string, string | undefined> {
  return { LOOPOVER_MINER_CONFIG_DIR: tempDir() };
}

function appendPrediction(ledger: PredictionLedger, targetId: number, conclusion: string) {
  ledger.appendPrediction({ repoFullName: "acme/widgets", targetId, conclusion, pack: "gittensor", engineVersion: "0.2.0" });
}

function seedPredictionEnv(env: Record<string, string | undefined>, targetId: number, conclusion: string) {
  const store = initPredictionLedger(resolvePredictionLedgerDbPath(env));
  store.appendPrediction({ repoFullName: "acme/widgets", targetId, conclusion, pack: "gittensor", engineVersion: "0.2.0" });
  store.close();
}

function seedOutcomeEnv(env: Record<string, string | undefined>, prNumber: number, decision: string) {
  const ledger = initEventLedger(resolveEventLedgerDbPath(env));
  ledger.appendEvent({ type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber, decision } });
  ledger.close();
}

// Build a raw `pr_outcome` ledger row (or a deliberately malformed one) for the in-process join, exactly as
// toOutcomeRecords would read it off the event ledger.
let seq = 0;
function outcomeEvent(prNumber: unknown, decision: unknown, repoFullName: string | null = "acme/widgets"): LedgerEntry {
  seq += 1;
  return {
    id: seq,
    seq,
    type: "pr_outcome",
    repoFullName,
    payload: { prNumber, decision } as Record<string, unknown>,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner metrics CLI (#4838)", () => {
  it("collectPredictionMetricRows leaves `correct` unset when no outcome events are supplied", () => {
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
    // Inject an empty event ledger: no realized outcomes, so the correct/incorrect counters stay zero.
    expect(runMetrics([], { initPredictionLedger: () => ledger, initEventLedger: () => tempEventLedger() })).toBe(0);

    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("# TYPE loopover_miner_predictions_total counter");
    // Series are emitted in sorted conclusion order, so "close" precedes "merge".
    expect(text).toContain('loopover_miner_predictions_total{conclusion="close"} 1');
    expect(text).toContain('loopover_miner_predictions_total{conclusion="merge"} 2');
    // No realized outcomes joined, so both the correct and incorrect counters stay zero.
    expect(text).toContain("loopover_miner_prediction_correct_total 0");
    expect(text).toContain("loopover_miner_prediction_incorrect_total 0");
    // The output is a single, once-terminated document (no doubled trailing blank line).
    expect(text.endsWith("\n")).toBe(false);
  });

  it("runMetrics opens and closes its own default ledgers when none are injected", () => {
    const dir = tempDir();
    const predictionDbPath = join(dir, "prediction-ledger.sqlite3");
    const eventDbPath = join(dir, "event-ledger.sqlite3");
    const seed = initPredictionLedger(predictionDbPath);
    appendPrediction(seed, 1, "hold");
    seed.close();

    const prevPrediction = process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB;
    const prevEvent = process.env.LOOPOVER_MINER_EVENT_LEDGER_DB;
    process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = predictionDbPath;
    process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = eventDbPath;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runMetrics([])).toBe(0);
    } finally {
      if (prevPrediction === undefined) delete process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB;
      else process.env.LOOPOVER_MINER_PREDICTION_LEDGER_DB = prevPrediction;
      if (prevEvent === undefined) delete process.env.LOOPOVER_MINER_EVENT_LEDGER_DB;
      else process.env.LOOPOVER_MINER_EVENT_LEDGER_DB = prevEvent;
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

  describe("outcome-join (#8315)", () => {
    it("resolves each prediction's `correct` against the realized pr_outcome via the calibration join", () => {
      const ledger = tempLedger();
      appendPrediction(ledger, 1, "merge"); // realized merged  -> correct
      appendPrediction(ledger, 2, "merge"); // realized closed  -> incorrect
      appendPrediction(ledger, 3, "close"); // realized closed  -> correct
      appendPrediction(ledger, 4, "close"); // realized merged  -> incorrect
      appendPrediction(ledger, 5, "hold"); // hold has no realized counterpart -> unresolved
      appendPrediction(ledger, 6, "merge"); // no outcome yet (pending)         -> unresolved
      appendPrediction(ledger, 7, "merge"); // outcome present but unclassifiable -> unresolved

      const events: LedgerEntry[] = [
        outcomeEvent(1, "merged"),
        outcomeEvent(2, "closed"),
        outcomeEvent(3, "closed"),
        outcomeEvent(4, "merged"),
        outcomeEvent(5, "merged"),
        // no event for prediction 6 (still pending)
        outcomeEvent(7, "reopened"), // a well-formed pr_outcome whose decision is neither merged nor closed
        outcomeEvent("not-a-number", "merged"), // malformed: non-integer prNumber -> skipped by toOutcomeRecords
      ];

      expect(collectPredictionMetricRows(ledger, events)).toEqual([
        { conclusion: "merge", correct: true },
        { conclusion: "merge", correct: false },
        { conclusion: "close", correct: true },
        { conclusion: "close", correct: false },
        { conclusion: "hold" },
        { conclusion: "merge" },
        { conclusion: "merge" },
      ]);
    });

    it("runMetrics opens the event ledger by env path and moves the correct/incorrect counters", () => {
      const env = tempConfigEnv();
      seedPredictionEnv(env, 1, "merge");
      seedPredictionEnv(env, 2, "close");
      seedOutcomeEnv(env, 1, "merged"); // merge predicted, merged realized  -> correct
      seedOutcomeEnv(env, 2, "merged"); // close predicted, merged realized  -> incorrect

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(runMetrics([], { env })).toBe(0);

      const text = String(log.mock.calls[0]?.[0]);
      expect(text).toContain("loopover_miner_prediction_correct_total 1");
      expect(text).toContain("loopover_miner_prediction_incorrect_total 1");
    });
  });
});
