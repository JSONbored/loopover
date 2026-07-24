import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toOutcomeRecords } from "../../packages/loopover-miner/lib/calibration-cli.js";
import { initEventLedger } from "../../packages/loopover-miner/lib/event-ledger.js";
import type { LedgerEntry } from "../../packages/loopover-miner/lib/event-ledger.js";
import { initPredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger.js";
import type { PredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger.d.ts";

// Import the .ts SOURCE (not the build-time .js) via a non-literal specifier. After `build:miner`, a plain
// `.js` import loads the compiled artifact and leaves coverage.include's `.ts` entry at 0% under CI's
// `--changed=origin/main --coverage.all=false` run (#8315, same pattern as miner-replay-snapshot.test.ts).
const METRICS_CLI_MODULE = "../../packages/loopover-miner/lib/metrics-cli.ts";
const { collectPredictionMetricRows, runMetrics } = (await import(METRICS_CLI_MODULE)) as typeof import("../../packages/loopover-miner/lib/metrics-cli.js");

const REPO = "acme/widgets";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger(): PredictionLedger {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  const ledger = initPredictionLedger(join(root, "prediction-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function tempEventLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-event-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function tempDbPath() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-"));
  roots.push(root);
  return join(root, "prediction-ledger.sqlite3");
}

function appendPrediction(ledger: PredictionLedger, targetId: number, conclusion: string) {
  ledger.appendPrediction({ repoFullName: REPO, targetId, conclusion, pack: "gittensor", engineVersion: "0.2.0" });
}

function prOutcome(prNumber: number, decision: string, repoFullName = REPO): LedgerEntry {
  return {
    id: prNumber,
    seq: prNumber,
    type: "pr_outcome",
    repoFullName,
    payload: { prNumber, decision },
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner metrics CLI (#4838, #8315 outcome join)", () => {
  it("collectPredictionMetricRows leaves correct unset when no outcomes are supplied", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge");
    appendPrediction(ledger, 2, "close");
    expect(collectPredictionMetricRows(ledger)).toEqual([{ conclusion: "merge" }, { conclusion: "close" }]);
  });

  it("collectPredictionMetricRows resolves merge/close predictions against realized outcomes", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge"); // confirmed
    appendPrediction(ledger, 2, "merge"); // false — closed instead
    appendPrediction(ledger, 3, "close"); // confirmed
    appendPrediction(ledger, 4, "close"); // false — merged instead
    appendPrediction(ledger, 5, "hold"); // never scored
    appendPrediction(ledger, 6, "merge"); // pending — no outcome yet

    const outcomes = toOutcomeRecords([
      prOutcome(1, "merged"),
      prOutcome(2, "closed"),
      prOutcome(3, "closed"),
      prOutcome(4, "merged"),
      prOutcome(5, "closed"),
      // pr 6 intentionally omitted
      // malformed pr_outcome — skipped by toOutcomeRecords
      { id: 99, seq: 99, type: "pr_outcome", repoFullName: REPO, payload: { prNumber: 7, decision: "unknown" }, createdAt: "2026-07-08T00:00:00.000Z" },
      { id: 100, seq: 100, type: "pr_outcome", repoFullName: REPO, payload: { prNumber: "bad" }, createdAt: "2026-07-08T00:00:00.000Z" },
    ]);

    expect(collectPredictionMetricRows(ledger, outcomes)).toEqual([
      { conclusion: "merge", correct: true },
      { conclusion: "merge", correct: false },
      { conclusion: "close", correct: true },
      { conclusion: "close", correct: false },
      { conclusion: "hold" },
      { conclusion: "merge" },
    ]);
  });

  it("collectPredictionMetricRows does not join an outcome from a different repo (strict project match)", () => {
    const ledger = tempLedger();
    appendPrediction(ledger, 1, "merge");
    const outcomes = toOutcomeRecords([prOutcome(1, "merged", "other/repo")]);
    expect(collectPredictionMetricRows(ledger, outcomes)).toEqual([{ conclusion: "merge" }]);
  });

  it("runMetrics renders resolved correct/incorrect counters from both ledgers and returns 0", () => {
    const predictionLedger = tempLedger();
    const eventLedger = tempEventLedger();
    appendPrediction(predictionLedger, 1, "merge");
    appendPrediction(predictionLedger, 2, "close");
    appendPrediction(predictionLedger, 3, "merge");
    eventLedger.appendEvent({ type: "pr_outcome", repoFullName: REPO, payload: { prNumber: 1, decision: "merged" } });
    eventLedger.appendEvent({ type: "pr_outcome", repoFullName: REPO, payload: { prNumber: 2, decision: "closed" } });
    eventLedger.appendEvent({ type: "pr_outcome", repoFullName: REPO, payload: { prNumber: 3, decision: "closed" } });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runMetrics([], {
        initPredictionLedger: () => predictionLedger,
        initEventLedger: () => eventLedger,
      }),
    ).toBe(0);

    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain("# TYPE loopover_miner_predictions_total counter");
    expect(text).toContain('loopover_miner_predictions_total{conclusion="close"} 1');
    expect(text).toContain('loopover_miner_predictions_total{conclusion="merge"} 2');
    expect(text).toContain("loopover_miner_prediction_correct_total 2");
    expect(text).toContain("loopover_miner_prediction_incorrect_total 1");
    expect(text.endsWith("\n")).toBe(false);
  });

  it("runMetrics opens and closes its own default ledgers when none are injected", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-metrics-cli-default-"));
    roots.push(root);
    const predictionDbPath = join(root, "prediction-ledger.sqlite3");
    const eventDbPath = join(root, "event-ledger.sqlite3");

    const seedPrediction = initPredictionLedger(predictionDbPath);
    appendPrediction(seedPrediction, 1, "hold");
    seedPrediction.close();

    const seedEvent = initEventLedger(eventDbPath);
    seedEvent.appendEvent({ type: "pr_outcome", repoFullName: REPO, payload: { prNumber: 1, decision: "merged" } });
    seedEvent.close();

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
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain('loopover_miner_predictions_total{conclusion="hold"} 1');
    // Hold is never scored even when an outcome exists.
    expect(text).toContain("loopover_miner_prediction_correct_total 0");
    expect(text).toContain("loopover_miner_prediction_incorrect_total 0");
  });

  it("runMetrics rejects unexpected arguments with a usage error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runMetrics(["--json"], {
        initPredictionLedger: () => tempLedger(),
        initEventLedger: () => tempEventLedger(),
      }),
    ).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "Usage: loopover-miner metrics",
    });
    error.mockClear();
    log.mockClear();
    expect(
      runMetrics(["--nope"], {
        initPredictionLedger: () => tempLedger(),
        initEventLedger: () => tempEventLedger(),
      }),
    ).toBe(2);
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
        initEventLedger: () => tempEventLedger(),
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
        initEventLedger: () => tempEventLedger(),
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("prediction-ledger-unavailable");
  });

  it("runMetrics closes an injected event ledger only when it opened the default store", () => {
    const predictionLedger = tempLedger();
    const eventLedger = tempEventLedger();
    const closeSpy = vi.spyOn(eventLedger, "close");
    appendPrediction(predictionLedger, 1, "merge");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runMetrics([], {
        initPredictionLedger: () => predictionLedger,
        initEventLedger: () => eventLedger,
      }),
    ).toBe(0);
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
