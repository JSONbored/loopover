import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCalibrationCli } from "../../packages/gittensory-miner/lib/calibration-cli.js";
import { initEventLedger, resolveEventLedgerDbPath } from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  initPredictionLedger,
  resolvePredictionLedgerDbPath,
} from "../../packages/gittensory-miner/lib/prediction-ledger.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envForTempStores(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "miner-calibration-cli-"));
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

function seedOutcomeEvent(
  env: Record<string, string | undefined>,
  payload: Record<string, unknown>,
  type = "pr_outcome",
) {
  const ledger = initEventLedger(resolveEventLedgerDbPath(env));
  ledger.appendEvent({ type, repoFullName: "acme/widgets", payload });
  ledger.close();
}

describe("gittensory-miner calibration CLI (#4849)", () => {
  it("joins a merge prediction with a merged outcome and renders the per-project accuracy", () => {
    const env = envForTempStores();
    seedPrediction(env, 42, "merge");
    seedOutcomeEvent(env, { prNumber: 42, decision: "merged" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("acme/widgets: 1 decided");
    expect(output).toContain("merge 1/1 (100%)");
    expect(output).toContain("close 0/0 (n/a)"); // no close predictions ⇒ n/a
  });

  it("renders n/a merge precision and a realized close precision for a close-only project", () => {
    const env = envForTempStores();
    seedPrediction(env, 99, "close");
    seedOutcomeEvent(env, { prNumber: 99, decision: "closed" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("merge 0/0 (n/a)"); // no merge predictions ⇒ n/a
    expect(output).toContain("close 1/1 (100%)"); // realized close ⇒ precision rendered
  });

  it("emits the structured report under --json", () => {
    const env = envForTempStores();
    seedPrediction(env, 7, "merge");
    seedOutcomeEvent(env, { prNumber: 7, decision: "merged" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli(["--json"], env)).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.hasSignal).toBe(true);
    expect(report.rows[0]).toMatchObject({ project: "acme/widgets", mergeConfirmed: 1, mergePrecision: 1 });
  });

  it("reports no signal when there are no decided predictions", () => {
    const env = envForTempStores();
    seedPrediction(env, 1, "merge"); // prediction with no realized outcome yet
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("no decided predictions");
  });

  it("takes the latest outcome per PR and skips non-outcome / malformed events", () => {
    const env = envForTempStores();
    seedPrediction(env, 5, "merge");
    seedOutcomeEvent(env, { prNumber: 5, decision: "closed" }); // earlier, superseded
    seedOutcomeEvent(env, { prNumber: 5, decision: "merged" }); // latest wins
    seedOutcomeEvent(env, { note: "not a pr outcome" }, "some_other_event"); // wrong type ⇒ ignored
    seedOutcomeEvent(env, { prNumber: "bad" }); // malformed payload ⇒ ignored
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli(["--json"], env)).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.rows[0]).toMatchObject({ mergeConfirmed: 1, mergeFalse: 0 }); // latest "merged" confirmed the merge
  });

  it("rejects an unknown option with exit code 1", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCalibrationCli(["--bogus"], envForTempStores())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option");
  });
});
