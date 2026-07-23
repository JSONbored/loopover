import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCalibrationCli, toAmsRealizedOutcomes } from "../../packages/loopover-miner/lib/calibration-cli.js";
import { initEventLedger, resolveEventLedgerDbPath } from "../../packages/loopover-miner/lib/event-ledger.js";
import {
  initPredictionLedger,
  resolvePredictionLedgerDbPath,
} from "../../packages/loopover-miner/lib/prediction-ledger.js";
import * as predictionLedger from "../../packages/loopover-miner/lib/prediction-ledger.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envForTempStores(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "miner-calibration-cli-"));
  tempDirs.push(dir);
  return { LOOPOVER_MINER_CONFIG_DIR: dir };
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

describe("loopover-miner calibration CLI (#4849)", () => {
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

  it("prints the #8183 corpus stats line: labeled cases with class counts + engine build, aggregates only", () => {
    const env = envForTempStores();
    seedPrediction(env, 42, "merge"); // merged -> confirmed
    seedPrediction(env, 43, "merge"); // closed -> reversed
    seedOutcomeEvent(env, { prNumber: 42, decision: "merged" });
    seedOutcomeEvent(env, { prNumber: 43, decision: "closed" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("corpus (ams_gate_prediction): 2 case(s) | confirmed 1 | reversed 1 | engine build(s): 1.0.0");
    expect(output).not.toContain("#42"); // corpus CONTENT never prints -- aggregates only
  });

  it("renders the explicit empty-corpus line and embeds corpus stats under --json (#8183)", () => {
    const env = envForTempStores();
    seedPrediction(env, 1, "merge"); // pending: no outcome -> zero labeled cases
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runCalibrationCli([], env)).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("corpus: no labeled cases yet");

    log.mockClear();
    seedOutcomeEvent(env, { prNumber: 1, decision: "merged" });
    expect(runCalibrationCli(["--json"], env)).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.corpus).toEqual({ ruleId: "ams_gate_prediction", cases: 1, confirmed: 1, reversed: 0, engineVersions: ["1.0.0"] });
  });

  it("toAmsRealizedOutcomes drops events without a usable repoFullName (#8183)", () => {
    // Direct mapper call: LedgerEntry.repoFullName is nullable for other event kinds, and the mapper must
    // never fabricate a repo for a malformed pr_outcome row.
    const rows = toAmsRealizedOutcomes([
      { id: 1, seq: 1, type: "pr_outcome", repoFullName: null, payload: { prNumber: 5, decision: "merged" }, createdAt: "2026-07-01T00:00:00.000Z" },
      { id: 2, seq: 2, type: "pr_outcome", repoFullName: "  ", payload: { prNumber: 6, decision: "merged" }, createdAt: "2026-07-01T00:00:00.000Z" },
      { id: 3, seq: 3, type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber: 7, decision: "closed" }, createdAt: "2026-07-01T00:00:00.000Z" },
    ] as never);
    expect(rows).toEqual([{ repoFullName: "acme/widgets", prNumber: 7, decision: "closed", recordedAt: "2026-07-01T00:00:00.000Z" }]);
  });

  it("rejects an unknown option with exit code 1", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCalibrationCli(["--bogus"], envForTempStores())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option");
  });

  // #5834: the check only rejected tokens starting with "-", so a stray positional was silently ignored and the
  // command reported a calibration run the operator never asked for. This command takes no positionals at all.
  it("rejects a stray positional argument with exit code 1 (#5834)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCalibrationCli(["foo"], envForTempStores())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option: foo");
  });

  it("rejects a stray positional alongside --json, on the JSON error contract (#5834)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCalibrationCli(["--json", "extra"], envForTempStores())).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
    expect(String(JSON.parse(String(log.mock.calls[0]?.[0])).error)).toContain("Unknown option: extra");
    expect(err).not.toHaveBeenCalled();
  });

  it("emits JSON when ledger open fails with --json (#4836)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(predictionLedger, "initPredictionLedger").mockImplementation(() => {
      throw new Error("corrupt_prediction_ledger");
    });
    expect(runCalibrationCli(["--json"], envForTempStores())).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "corrupt_prediction_ledger",
    });
    expect(err).not.toHaveBeenCalled();
  });
});

// ── #8184/#8185/#8186/#8187: the calibration subcommands + report sections ─────────────────────────────────

import { resolveAmsPolicyConfigPath } from "../../packages/loopover-miner/lib/ams-policy.js";
import {
  MINER_AMS_THRESHOLD_BACKTEST_EVENT,
  readMinRankOverride,
} from "../../packages/loopover-miner/lib/ams-calibration.js";

function seedTakenHistory(env: Record<string, string | undefined>): void {
  const ledger = initEventLedger(resolveEventLedgerDbPath(env));
  for (let i = 1; i <= 60; i += 1) {
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: i, rankScore: 0.15, title: "t", labels: [] } });
    ledger.appendEvent({
      type: "pr_outcome",
      repoFullName: "acme/widgets",
      payload: { prNumber: 1000 + i, decision: "closed", closedAt: "2026-07-10T00:00:00Z", reason: null, issueNumber: i },
    });
  }
  for (const i of [101, 102]) {
    ledger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: i, rankScore: 0.4, title: "t", labels: [] } });
    ledger.appendEvent({ type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber: 1000 + i, decision: "merged", closedAt: null, reason: null, issueNumber: i } });
  }
  ledger.close();
}

function enableAutotune(env: Record<string, string | undefined>): void {
  writeFileSync(resolveAmsPolicyConfigPath(env), "minRankAutotuneEnabled: true\n");
}

describe("calibration backtest-threshold (#8184)", () => {
  it("replays, prints both split reports via the shared renderer, persists the run event, exits 0", () => {
    const env = envForTempStores();
    seedTakenHistory(env);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runCalibrationCli(["backtest-threshold", "--candidate", "0.2"], env)).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("current 0 -> candidate 0.2");
    expect(output).toContain("visible split");
    expect(output).toContain("held-out split");
    expect(output).toContain("advisory only");
    expect(output).toContain("Verdict");
    const ledger = initEventLedger(resolveEventLedgerDbPath(env));
    const runs = ledger.readEvents().filter((e) => e.type === MINER_AMS_THRESHOLD_BACKTEST_EVENT);
    ledger.close();
    expect(runs).toHaveLength(1);
  });

  it("an under-floored corpus prints the explicit line, persists NOTHING, and still exits 0 (never on verdict)", () => {
    const env = envForTempStores();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runCalibrationCli(["backtest-threshold", "--candidate", "0.2"], env)).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("not enough labeled taken opportunities");
    expect(runCalibrationCli(["backtest-threshold", "--candidate", "0.2", "--json"], env)).toBe(0);
    const jsonLine = logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.includes("insufficient_corpus"));
    expect(jsonLine).toBeDefined();
    const ledger = initEventLedger(resolveEventLedgerDbPath(env));
    expect(ledger.readEvents().filter((e) => e.type === MINER_AMS_THRESHOLD_BACKTEST_EVENT)).toHaveLength(0);
    ledger.close();
  });

  it("JSON mode dumps the full result; a missing/invalid --candidate is a usage error (exit 1)", () => {
    const env = envForTempStores();
    seedTakenHistory(env);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runCalibrationCli(["backtest-threshold", "--candidate", "0.2", "--json"], env)).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.trimStart().startsWith("{"))!) as { ran: boolean; visible: { verdict: string } };
    expect(parsed.ran).toBe(true);
    expect(parsed.visible.verdict).toBe("improved");
    expect(runCalibrationCli(["backtest-threshold"], env)).toBe(1);
    expect(runCalibrationCli(["backtest-threshold", "--candidate", "banana"], env)).toBe(1);
  });

  it("fails operationally (exit 1) when the ledger store cannot open", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { LOOPOVER_MINER_EVENT_LEDGER_DB: "/dev/null/nope/ledger.sqlite" };
    expect(runCalibrationCli(["backtest-threshold", "--candidate", "0.2"], env)).toBe(2);
  });
});

describe("calibration apply-min-rank / revert-min-rank (#8187)", () => {
  it("walks the full double-gated path: flag_off -> not_approved -> no_supporting_run -> applied -> reverted", () => {
    const env = envForTempStores();
    seedTakenHistory(env);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runCalibrationCli(["apply-min-rank", "--candidate", "0.2", "--approve"], env)).toBe(1); // gate one off
    enableAutotune(env);
    expect(runCalibrationCli(["apply-min-rank", "--candidate", "0.2"], env)).toBe(1); // gate two missing
    expect(runCalibrationCli(["apply-min-rank", "--candidate", "0.2", "--approve"], env)).toBe(1); // no evidence yet
    expect(runCalibrationCli(["apply-min-rank", "--approve"], env)).toBe(1); // usage: no candidate

    expect(runCalibrationCli(["backtest-threshold", "--candidate", "0.2"], env)).toBe(0); // earn the evidence
    expect(runCalibrationCli(["apply-min-rank", "--candidate", "0.2", "--approve"], env)).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("min-rank override 0.2 applied");

    const ledger = initEventLedger(resolveEventLedgerDbPath(env));
    expect(readMinRankOverride(ledger, { enabled: true })).toBe(0.2);
    ledger.close();

    expect(runCalibrationCli(["revert-min-rank"], env)).toBe(1); // revert also needs approval
    expect(runCalibrationCli(["revert-min-rank", "--approve", "--json"], env)).toBe(0);
    const after = initEventLedger(resolveEventLedgerDbPath(env));
    expect(readMinRankOverride(after, { enabled: true })).toBeNull();
    after.close();
  });

  it("fails operationally (exit 1) when the ledger store cannot open", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { LOOPOVER_MINER_EVENT_LEDGER_DB: "/dev/null/nope/ledger.sqlite" };
    expect(runCalibrationCli(["apply-min-rank", "--candidate", "0.2", "--approve"], env)).toBe(2);
    expect(runCalibrationCli(["revert-min-rank", "--approve"], env)).toBe(2);
  });
});

describe("calibration report sections (#8185/#8186)", () => {
  it("prints the explicit no-runs line on an empty history, and the track record + proposals + no-autonomy line once runs exist", () => {
    const env = envForTempStores();
    seedTakenHistory(env);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runCalibrationCli([], env)).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("backtest track record: no backtest runs recorded.");

    expect(runCalibrationCli(["backtest-threshold", "--candidate", "0.2"], env)).toBe(0);
    logSpy.mockClear();
    expect(runCalibrationCli([], env)).toBe(0);
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("backtest track record: 2 comparison(s) | REGRESSED 0 (rate 0.000)");
    expect(output).toContain("backtest-cleared proposal: min-rank 0 -> 0.2");
    expect(output).toContain("nothing applies automatically");

    logSpy.mockClear();
    expect(runCalibrationCli(["--json"], env)).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.trimStart().startsWith("{"))!) as {
      backtestTrackRecord: { totalRuns: number; regressedRuns: number };
      backtestProposals: Array<{ candidateThreshold: number }>;
    };
    expect(parsed.backtestTrackRecord).toMatchObject({ totalRuns: 2, regressedRuns: 0 });
    expect(parsed.backtestProposals[0]?.candidateThreshold).toBe(0.2);
  });
});
