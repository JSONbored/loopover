import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { initEventLedger, resolveEventLedgerDbPath } from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  initPredictionLedger,
  resolvePredictionLedgerDbPath,
} from "../../packages/gittensory-miner/lib/prediction-ledger.js";
import { runMetricsCli } from "../../packages/gittensory-miner/lib/prediction-metrics-cli.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envForTempStores(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "miner-metrics-cli-"));
  tempDirs.push(dir);
  return { GITTENSORY_MINER_CONFIG_DIR: dir };
}

function seedPrediction(env: Record<string, string | undefined>, targetId: number, conclusion: string) {
  const store = initPredictionLedger(resolvePredictionLedgerDbPath(env));
  store.appendPrediction({
    repoFullName: "acme/widgets",
    targetId,
    conclusion,
    pack: "oss",
    readinessScore: 90,
    blockerCodes: [],
    warningCodes: [],
    engineVersion: "1.0.0",
  });
  store.close();
}

function seedEvent(env: Record<string, string | undefined>, payload: Record<string, unknown>, type = "pr_outcome") {
  const ledger = initEventLedger(resolveEventLedgerDbPath(env));
  ledger.appendEvent({ type, repoFullName: "acme/widgets", payload });
  ledger.close();
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

describe("gittensory-miner metrics CLI (#4838)", () => {
  it("renders prediction counters and pairs realized outcomes into correct/incorrect", () => {
    const env = envForTempStores();
    seedPrediction(env, 1, "merge");
    seedPrediction(env, 2, "close");
    seedPrediction(env, 3, "hold"); // no realized outcome ⇒ counts to predictions_total only
    seedEvent(env, { prNumber: 1, decision: "merged" }); // predicted merge, realized merge ⇒ correct
    seedEvent(env, { prNumber: 2, decision: "merged" }); // predicted close, realized merge ⇒ incorrect
    const out = captureStdout();

    expect(runMetricsCli([], env)).toBe(0);
    const text = out.text();
    expect(text).toContain("# HELP gittensory_miner_predictions_total");
    expect(text).toContain("# TYPE gittensory_miner_predictions_total counter");
    expect(text).toContain('gittensory_miner_predictions_total{conclusion="close"} 1');
    expect(text).toContain('gittensory_miner_predictions_total{conclusion="hold"} 1');
    expect(text).toContain('gittensory_miner_predictions_total{conclusion="merge"} 1');
    expect(text).toContain("gittensory_miner_prediction_correct_total 1");
    expect(text).toContain("gittensory_miner_prediction_incorrect_total 1");
  });

  it("uses the latest outcome per PR and ignores non-outcome / malformed events", () => {
    const env = envForTempStores();
    seedPrediction(env, 5, "merge");
    seedEvent(env, { prNumber: 5, decision: "closed" }); // earlier, superseded
    seedEvent(env, { prNumber: 5, decision: "merged" }); // latest wins ⇒ correct
    seedEvent(env, { note: "not an outcome" }, "some_other_event"); // wrong type ⇒ ignored
    seedEvent(env, { prNumber: "bad", decision: "merged" }); // malformed prNumber ⇒ ignored
    seedEvent(env, { prNumber: 9 }); // missing decision ⇒ ignored
    const out = captureStdout();

    expect(runMetricsCli([], env)).toBe(0);
    const text = out.text();
    expect(text).toContain("gittensory_miner_prediction_correct_total 1");
    expect(text).toContain("gittensory_miner_prediction_incorrect_total 0");
  });

  it("emits a well-formed empty surface when the ledgers are empty", () => {
    const env = envForTempStores();
    const out = captureStdout();

    expect(runMetricsCli([], env)).toBe(0);
    const text = out.text();
    expect(text).toContain("# TYPE gittensory_miner_predictions_total counter");
    expect(text).toContain("gittensory_miner_prediction_correct_total 0");
    expect(text).toContain("gittensory_miner_prediction_incorrect_total 0");
    expect(text).not.toContain("predictions_total{"); // no series without any predictions
  });

  it("rejects an unknown option with exit code 1", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runMetricsCli(["--bogus"], envForTempStores())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option");
  });
});
