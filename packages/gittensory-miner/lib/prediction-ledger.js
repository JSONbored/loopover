import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Append-only prediction ledger (#4263): every predicted-gate verdict the miner computes for a target lands in
// a local SQLite table so a later self-improve pass can score the prediction against the realized pr_outcome.
// IMMUTABILITY INVARIANT: INSERT + SELECT only — never UPDATE/DELETE. Rows are kept small and stable for later
// diffing: blocker/warning CODES only (no free-text detail), plus the ENGINE_VERSION that produced the call so
// a row self-reports which engine build made it. Mirrors governor-ledger.js's shape; normalization is local
// (like event-ledger.js) so the offline miner package pulls in no engine module.

const defaultDbFileName = "prediction-ledger.sqlite3";
let defaultPredictionLedger = null;

export function resolvePredictionLedgerDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_PREDICTION_LEDGER_DB === "string"
    ? env.GITTENSORY_MINER_PREDICTION_LEDGER_DB.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolvePredictionLedgerDbPath()).trim();
  if (!path) throw new Error("invalid_prediction_ledger_db_path");
  return path;
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeOptionalRepoFullName(repoFullName) {
  if (repoFullName === undefined || repoFullName === null) return undefined;
  return normalizeRepoFullName(repoFullName);
}

function requiredNonEmptyString(value, error) {
  if (typeof value !== "string" || !value.trim()) throw new Error(error);
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("invalid_head_sha");
  const trimmed = value.trim();
  return trimmed || null;
}

// Codes are stored as a JSON array of the non-empty trimmed strings, in order — a stable, small projection of a
// verdict's blockers/warnings that drops all free-text detail.
function normalizeCodes(codes, error) {
  if (codes === undefined || codes === null) return [];
  if (!Array.isArray(codes)) throw new Error(error);
  return codes.map((code) => {
    if (typeof code !== "string" || !code.trim()) throw new Error(error);
    return code.trim();
  });
}

function normalizeReadinessScore(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_readiness_score");
  return value;
}

/** Validate + normalize an append input, throwing on any invalid field (mirrors normalizeGovernorLedgerEvent). */
function normalizePredictionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_prediction_input");
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("invalid_target_id");
  return {
    repoFullName: normalizeRepoFullName(input.repoFullName),
    targetId: input.targetId,
    headSha: optionalString(input.headSha),
    conclusion: requiredNonEmptyString(input.conclusion, "invalid_conclusion"),
    pack: requiredNonEmptyString(input.pack, "invalid_pack"),
    readinessScore: normalizeReadinessScore(input.readinessScore),
    blockerCodes: normalizeCodes(input.blockerCodes, "invalid_blocker_codes"),
    warningCodes: normalizeCodes(input.warningCodes, "invalid_warning_codes"),
    engineVersion: requiredNonEmptyString(input.engineVersion, "invalid_engine_version"),
  };
}

function rowToEntry(row) {
  let blockerCodes;
  let warningCodes;
  try {
    blockerCodes = JSON.parse(row.blocker_codes_json);
    warningCodes = JSON.parse(row.warning_codes_json);
    if (!Array.isArray(blockerCodes) || !Array.isArray(warningCodes)) throw new Error("corrupted_prediction_row");
  } catch {
    throw new Error("corrupted_prediction_row");
  }
  return {
    id: row.id,
    ts: row.ts,
    repoFullName: row.repo_full_name,
    targetId: row.target_id,
    headSha: row.head_sha,
    conclusion: row.conclusion,
    pack: row.pack,
    readinessScore: row.readiness_score,
    blockerCodes,
    warningCodes,
    engineVersion: row.engine_version,
  };
}

/**
 * Opens the append-only prediction ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#4263)
 */
export function initPredictionLedger(dbPath = resolvePredictionLedgerDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS predictions (
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_predictions_repo ON predictions (repo_full_name, id)");

  const appendStatement = db.prepare(`
    INSERT INTO predictions
      (ts, repo_full_name, target_id, head_sha, conclusion, pack, readiness_score, blocker_codes_json, warning_codes_json, engine_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getByIdStatement = db.prepare("SELECT * FROM predictions WHERE id = ?");
  const readAllStatement = db.prepare("SELECT * FROM predictions ORDER BY id ASC");
  const readByRepoStatement = db.prepare("SELECT * FROM predictions WHERE repo_full_name = ? ORDER BY id ASC");

  return {
    dbPath: resolvedPath,
    appendPrediction(input) {
      const n = normalizePredictionInput(input);
      const ts = new Date().toISOString();
      const result = appendStatement.run(
        ts,
        n.repoFullName,
        n.targetId,
        n.headSha,
        n.conclusion,
        n.pack,
        n.readinessScore,
        JSON.stringify(n.blockerCodes),
        JSON.stringify(n.warningCodes),
        n.engineVersion,
      );
      return rowToEntry(getByIdStatement.get(Number(result.lastInsertRowid)));
    },
    readPredictions(filter = {}) {
      const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
      const rows = repoFullName === undefined ? readAllStatement.all() : readByRepoStatement.all(repoFullName);
      return rows.map(rowToEntry);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultPredictionLedger() {
  defaultPredictionLedger ??= initPredictionLedger();
  return defaultPredictionLedger;
}

export function appendPrediction(input) {
  return getDefaultPredictionLedger().appendPrediction(input);
}

export function readPredictions(filter) {
  return getDefaultPredictionLedger().readPredictions(filter);
}

export function closeDefaultPredictionLedger() {
  if (!defaultPredictionLedger) return;
  defaultPredictionLedger.close();
  defaultPredictionLedger = null;
}
