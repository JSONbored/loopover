import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "../../packages/gittensory-miner/lib/prediction-ledger.js";

const ledgers: Array<{ close: () => void }> = [];
const roots: string[] = [];
function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-prediction-"));
  roots.push(root);
  const ledger = initPredictionLedger(join(root, "prediction-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VALID = {
  repoFullName: "owner/repo",
  targetId: 42,
  headSha: "abc123",
  conclusion: "failure",
  pack: "gittensor",
  readinessScore: 55,
  blockerCodes: ["missing_linked_issue", "duplicate_pr"],
  warningCodes: ["readiness_low"],
  engineVersion: "0.2.0",
};

describe("miner prediction ledger (#4263)", () => {
  it("resolvePredictionLedgerDbPath honors the explicit DB, config-dir, XDG, then home default", () => {
    expect(resolvePredictionLedgerDbPath({ GITTENSORY_MINER_PREDICTION_LEDGER_DB: "/custom/pred.sqlite3" })).toBe("/custom/pred.sqlite3");
    expect(resolvePredictionLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/state" })).toBe(join("/state", "prediction-ledger.sqlite3"));
    expect(resolvePredictionLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "gittensory-miner", "prediction-ledger.sqlite3"));
    expect(resolvePredictionLedgerDbPath({})).toMatch(/gittensory-miner[\\/]prediction-ledger\.sqlite3$/);
  });

  it("appends a verdict and reads it back with codes + engine version intact", () => {
    const ledger = tempLedger();
    const entry = ledger.appendPrediction(VALID);
    expect(entry).toMatchObject({
      id: 1,
      repoFullName: "owner/repo",
      targetId: 42,
      headSha: "abc123",
      conclusion: "failure",
      pack: "gittensor",
      readinessScore: 55,
      blockerCodes: ["missing_linked_issue", "duplicate_pr"],
      warningCodes: ["readiness_low"],
      engineVersion: "0.2.0",
    });
    expect(typeof entry.ts).toBe("string");
    expect(ledger.readPredictions()).toEqual([entry]);
  });

  it("stores a headSha-less, no-blocker clean pass with a null readiness score", () => {
    const ledger = tempLedger();
    const entry = ledger.appendPrediction({ repoFullName: "owner/repo", targetId: 9, conclusion: "success", pack: "oss-anti-slop", readinessScore: null, engineVersion: "0.2.0" });
    expect(entry).toMatchObject({ headSha: null, readinessScore: null, blockerCodes: [], warningCodes: [] });
  });

  it("rejects invalid inputs field by field", () => {
    const ledger = tempLedger();
    expect(() => ledger.appendPrediction({ ...VALID, repoFullName: "no-slash" })).toThrow(/invalid_repo_full_name/);
    expect(() => ledger.appendPrediction({ ...VALID, targetId: 0 })).toThrow(/invalid_target_id/);
    expect(() => ledger.appendPrediction({ ...VALID, conclusion: "" })).toThrow(/invalid_conclusion/);
    expect(() => ledger.appendPrediction({ ...VALID, engineVersion: "" })).toThrow(/invalid_engine_version/);
    expect(() => ledger.appendPrediction({ ...VALID, blockerCodes: ["ok", ""] })).toThrow(/invalid_blocker_codes/);
    expect(() => ledger.appendPrediction({ ...VALID, readinessScore: Number.NaN })).toThrow(/invalid_readiness_score/);
  });

  it("scopes readPredictions by repo, preserving insertion order", () => {
    const ledger = tempLedger();
    ledger.appendPrediction({ ...VALID, repoFullName: "owner/repo-a", targetId: 1 });
    ledger.appendPrediction({ ...VALID, repoFullName: "owner/repo-b", targetId: 2 });
    ledger.appendPrediction({ ...VALID, repoFullName: "owner/repo-a", targetId: 3 });
    expect(ledger.readPredictions({ repoFullName: "owner/repo-a" }).map((entry) => entry.targetId)).toEqual([1, 3]);
    expect(ledger.readPredictions()).toHaveLength(3);
  });
});
