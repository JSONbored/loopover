import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "../../packages/loopover-miner/lib/prediction-ledger.js";
import { readSchemaVersion } from "../../packages/loopover-miner/lib/schema-version.js";

const ledgers: Array<{ close: () => void }> = [];
const roots: string[] = [];
function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-prediction-"));
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
    expect(resolvePredictionLedgerDbPath({ LOOPOVER_MINER_PREDICTION_LEDGER_DB: "/custom/pred.sqlite3" })).toBe("/custom/pred.sqlite3");
    expect(resolvePredictionLedgerDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/state" })).toBe(join("/state", "prediction-ledger.sqlite3"));
    expect(resolvePredictionLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "loopover-miner", "prediction-ledger.sqlite3"));
    expect(resolvePredictionLedgerDbPath({})).toMatch(/loopover-miner[\\/]prediction-ledger\.sqlite3$/);
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
    // #7795: `.`/`..`/control-char segments must be rejected too (both owner and repo), not just missing/extra slashes.
    expect(() => ledger.appendPrediction({ ...VALID, repoFullName: "../etc" })).toThrow(/invalid_repo_full_name/);
    expect(() => ledger.appendPrediction({ ...VALID, repoFullName: "owner/.." })).toThrow(/invalid_repo_full_name/);
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

  describe("purgeByRepo (#5564)", () => {
    it("deletes every prediction for one repo and leaves other repos untouched", () => {
      const ledger = tempLedger();
      ledger.appendPrediction({ ...VALID, repoFullName: "owner/repo-a", targetId: 1 });
      ledger.appendPrediction({ ...VALID, repoFullName: "owner/repo-a", targetId: 2 });
      ledger.appendPrediction({ ...VALID, repoFullName: "owner/repo-b", targetId: 3 });

      expect(ledger.purgeByRepo("owner/repo-a")).toBe(2);
      expect(ledger.readPredictions({ repoFullName: "owner/repo-a" })).toEqual([]);
      expect(ledger.readPredictions()).toHaveLength(1);
    });

    it("returns 0 when nothing matches the repo", () => {
      const ledger = tempLedger();
      ledger.appendPrediction({ ...VALID, repoFullName: "owner/repo-b" });
      expect(ledger.purgeByRepo("owner/repo-a")).toBe(0);
      expect(ledger.readPredictions()).toHaveLength(1);
    });

    it("rejects a missing/malformed repoFullName rather than silently no-opping", () => {
      const ledger = tempLedger();
      expect(() => ledger.purgeByRepo(undefined as never)).toThrow("invalid_repo_full_name");
      expect(() => ledger.purgeByRepo("no-slash")).toThrow("invalid_repo_full_name");
    });
  });

  describe("schema version + tenant_id migration (#4832/#4939)", () => {
    function tempDbPath() {
      const root = mkdtempSync(join(tmpdir(), "loopover-miner-prediction-"));
      roots.push(root);
      return join(root, "prediction-ledger.sqlite3");
    }

    it("stamps a freshly-opened store at schema version 2 (baseline + the tenant_id migration)", () => {
      const ledger = tempLedger();
      const reader = new DatabaseSync(ledger.dbPath, { readOnly: true });
      try {
        expect(readSchemaVersion(reader)).toBe(2);
        const hasTenantId = reader
          .prepare("PRAGMA table_info(predictions)")
          .all()
          .some((column) => column.name === "tenant_id");
        expect(hasTenantId).toBe(true);
      } finally {
        reader.close();
      }
    });

    it("upgrades a pre-migration file in place: adds tenant_id, preserves rows, reads null for old and new rows", () => {
      const dbPath = tempDbPath();
      // Craft the pre-versioning on-disk shape: the bare v1 predictions table (no tenant_id), user_version 0,
      // with one existing row -- exactly what the current code wrote before this migration existed.
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE predictions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          head_sha TEXT,
          conclusion TEXT NOT NULL,
          pack TEXT NOT NULL,
          readiness_score REAL,
          blocker_codes_json TEXT NOT NULL,
          warning_codes_json TEXT NOT NULL,
          engine_version TEXT NOT NULL
        )
      `);
      seed
        .prepare(
          "INSERT INTO predictions (ts, repo_full_name, target_id, head_sha, conclusion, pack, readiness_score, blocker_codes_json, warning_codes_json, engine_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("2020-01-01T00:00:00.000Z", "owner/old-repo", 7, null, "failure", "gittensor", null, "[]", "[]", "0.1.0");
      expect(readSchemaVersion(seed)).toBe(0);
      seed.close();

      const ledger = initPredictionLedger(dbPath);
      ledgers.push(ledger);
      // The pre-existing row survives the in-place upgrade.
      expect(ledger.readPredictions().map((entry) => entry.targetId)).toEqual([7]);
      // A newly-appended row goes in through the normal path, which never writes tenant_id.
      ledger.appendPrediction({ ...VALID, repoFullName: "owner/new-repo", targetId: 8 });

      const reader = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(readSchemaVersion(reader)).toBe(2);
        const rows = reader.prepare("SELECT target_id, tenant_id FROM predictions ORDER BY id ASC").all();
        expect(rows).toEqual([
          { target_id: 7, tenant_id: null },
          { target_id: 8, tenant_id: null },
        ]);
      } finally {
        reader.close();
      }
    });

    it("re-running the migration against a file that already has tenant_id is a no-op (idempotent guard)", () => {
      const dbPath = tempDbPath();
      // First open migrates the fresh file up to v2: the tenant_id column is added and the version is stamped.
      const first = initPredictionLedger(dbPath);
      first.appendPrediction({ ...VALID, repoFullName: "owner/repo", targetId: 1 });
      first.close();

      // Force the migration to run AGAIN on the next open: the column is already present, but resetting the
      // stamped version below the target makes applySchemaMigrations re-invoke addTenantIdColumn -- exercising
      // its column-already-present skip branch (no duplicate-column ALTER, no throw).
      const reset = new DatabaseSync(dbPath);
      reset.exec("PRAGMA user_version = 0");
      reset.close();

      const reopened = initPredictionLedger(dbPath);
      ledgers.push(reopened);
      // Re-opened cleanly, the row survived, and the store re-stamped back to v2 with a single tenant_id column.
      expect(reopened.readPredictions().map((entry) => entry.targetId)).toEqual([1]);
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(readSchemaVersion(reader)).toBe(2);
        const tenantIdColumns = reader
          .prepare("PRAGMA table_info(predictions)")
          .all()
          .filter((column) => column.name === "tenant_id");
        expect(tenantIdColumns).toHaveLength(1);
      } finally {
        reader.close();
      }
    });
  });
});
