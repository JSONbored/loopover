import type { DatabaseSync } from "node:sqlite";
import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { applySchemaMigrations } from "./schema-version.js";
import {
  PREDICTION_LEDGER_PURGE_SPEC,
  PREDICTION_LEDGER_RETENTION_SPEC,
  purgeStoreByRepo,
  pruneLedgerByRetention,
  resolveLedgerRetentionPolicy,
} from "./store-maintenance.js";

// Append-only prediction ledger (#4263): every predicted-gate verdict the miner computes for a target lands in
// a local SQLite table so a later self-improve pass can score the prediction against the realized pr_outcome.
// IMMUTABILITY INVARIANT: `appendPrediction`/`readPredictions` only ever issue INSERT and SELECT — never
// UPDATE/DELETE. Two documented exceptions, both separate maintenance operations rather than part of normal
// ledger operation: opt-in retention pruning (#4834, automatic) and `purgeByRepo` (#5564, always explicit and
// operator-invoked, never automatic). Rows are kept small and stable for later diffing: blocker/warning CODES
// only (no free-text detail), plus the ENGINE_VERSION that produced the call so a row self-reports which engine
// build made it. Mirrors governor-ledger.js's shape; normalization is local (like event-ledger.js) so the
// offline miner package pulls in no engine module.

export type PredictionLedgerEntry = {
  id: number;
  ts: string;
  repoFullName: string;
  targetId: number;
  headSha: string | null;
  conclusion: string;
  pack: string;
  readinessScore: number | null;
  blockerCodes: string[];
  warningCodes: string[];
  engineVersion: string;
};

export type AppendPredictionInput = {
  repoFullName: string;
  targetId: number;
  headSha?: string | null;
  conclusion: string;
  pack: string;
  readinessScore?: number | null;
  blockerCodes?: string[];
  warningCodes?: string[];
  engineVersion: string;
};

export type ReadPredictionsFilter = {
  repoFullName?: string | null;
};

export type PredictionLedger = {
  dbPath: string;
  appendPrediction(input: AppendPredictionInput): PredictionLedgerEntry;
  readPredictions(filter?: ReadPredictionsFilter): PredictionLedgerEntry[];
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

/** Private shape of a `predictions` SELECT * row after casting off `Record<string, SQLOutputValue>`. */
type PredictionDbRow = {
  id: number;
  ts: string;
  repo_full_name: string;
  target_id: number;
  head_sha: string | null;
  conclusion: string;
  pack: string;
  readiness_score: number | null;
  blocker_codes_json: string;
  warning_codes_json: string;
  engine_version: string;
};

const defaultDbFileName = "prediction-ledger.sqlite3";
let defaultPredictionLedger: PredictionLedger | null = null;

export function resolvePredictionLedgerDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_PREDICTION_LEDGER_DB", env);
}

function normalizeDbPath(dbPath: string): string {
  return normalizeLocalStoreDbPath(dbPath, resolvePredictionLedgerDbPath(), "invalid_prediction_ledger_db_path");
}

function normalizeRepoFullName(repoFullName: string): string {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeOptionalRepoFullName(repoFullName: string | null | undefined): string | undefined {
  if (repoFullName === undefined || repoFullName === null) return undefined;
  return normalizeRepoFullName(repoFullName);
}

function requiredNonEmptyString(value: unknown, error: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(error);
  return value.trim();
}

function optionalString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("invalid_head_sha");
  const trimmed = value.trim();
  return trimmed || null;
}

// Codes are stored as a JSON array of the non-empty trimmed strings, in order — a stable, small projection of a
// verdict's blockers/warnings that drops all free-text detail.
function normalizeCodes(codes: string[] | null | undefined, error: string): string[] {
  if (codes === undefined || codes === null) return [];
  if (!Array.isArray(codes)) throw new Error(error);
  return codes.map((code) => {
    if (typeof code !== "string" || !code.trim()) throw new Error(error);
    return code.trim();
  });
}

function normalizeReadinessScore(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_readiness_score");
  return value;
}

/** Validate + normalize an append input, throwing on any invalid field (mirrors normalizeGovernorLedgerEvent). */
function normalizePredictionInput(input: AppendPredictionInput): {
  repoFullName: string;
  targetId: number;
  headSha: string | null;
  conclusion: string;
  pack: string;
  readinessScore: number | null;
  blockerCodes: string[];
  warningCodes: string[];
  engineVersion: string;
} {
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

function rowToEntry(row: PredictionDbRow): PredictionLedgerEntry {
  let blockerCodes: unknown;
  let warningCodes: unknown;
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
    blockerCodes: blockerCodes as string[],
    warningCodes: warningCodes as string[],
    engineVersion: row.engine_version,
  };
}

function asPredictionDbRow(row: Record<string, unknown>): PredictionDbRow {
  return row as unknown as PredictionDbRow;
}

// v1 -> v2 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
// same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads or
// writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
// column-presence guard as this file's sibling stores' own additive migrations (e.g. event-ledger.js's and
// run-state.js's own tenant_id additions), so re-running it against an already-migrated file is a no-op.
function addTenantIdColumn(db: DatabaseSync): void {
  const hasTenantIdColumn = db
    .prepare("PRAGMA table_info(predictions)")
    .all()
    .some((column) => column.name === "tenant_id");
  if (!hasTenantIdColumn) db.exec("ALTER TABLE predictions ADD COLUMN tenant_id TEXT");
}

/**
 * Opens the append-only prediction ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#4263)
 */
export function initPredictionLedger(dbPath: string = resolvePredictionLedgerDbPath()): PredictionLedger {
  const resolvedPath = normalizeDbPath(dbPath);
  // Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): the INSERT/SELECT CRUD goes through
  // `driver.query`, while schema creation/migrations, retention pruning, and the repo-scoped purge still use the
  // underlying DatabaseSync until those helpers are migrated. Public API stays synchronous (part-1 slice).
  const { db, driver } = openLocalStoreAdapter(resolvedPath);
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
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
  applySchemaMigrations(db, [addTenantIdColumn]);
  // Opt-in retention (#4834): prune aged/excess rows when an operator has enabled it; a no-op by default.
  pruneLedgerByRetention(db, PREDICTION_LEDGER_RETENTION_SPEC, resolveLedgerRetentionPolicy(), Date.now());

  const appendSql = `
    INSERT INTO predictions
      (ts, repo_full_name, target_id, head_sha, conclusion, pack, readiness_score, blocker_codes_json, warning_codes_json, engine_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const getByIdSql = "SELECT * FROM predictions WHERE id = ?";
  const readAllSql = "SELECT * FROM predictions ORDER BY id ASC";
  const readByRepoSql = "SELECT * FROM predictions WHERE repo_full_name = ? ORDER BY id ASC";

  return {
    dbPath: resolvedPath,
    appendPrediction(input) {
      const n = normalizePredictionInput(input);
      const ts = new Date().toISOString();
      // A plain INSERT (no RETURNING) is a zero-result-column statement, so `driver.query` runs it on the write
      // path and returns the coerced `lastInsertRowid` to re-read the row just written.
      const { lastInsertRowid } = driver.query(appendSql, [
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
      ]);
      return rowToEntry(asPredictionDbRow(driver.query(getByIdSql, [lastInsertRowid]).rows[0]!));
    },
    readPredictions(filter = {}) {
      const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
      const rows =
        repoFullName === undefined
          ? driver.query(readAllSql, []).rows
          : driver.query(readByRepoSql, [repoFullName]).rows;
      return rows.map((row) => rowToEntry(asPredictionDbRow(row)));
    },
    // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. See the
    // IMMUTABILITY INVARIANT note above: this is a deliberate, separate exception, not a normal ledger write.
    purgeByRepo(repoFullName) {
      return purgeStoreByRepo(db, PREDICTION_LEDGER_PURGE_SPEC, normalizeRepoFullName(repoFullName));
    },
    close() {
      db.close();
    },
  };
}

function getDefaultPredictionLedger(): PredictionLedger {
  defaultPredictionLedger ??= initPredictionLedger();
  return defaultPredictionLedger;
}

export function appendPrediction(input: AppendPredictionInput): PredictionLedgerEntry {
  return getDefaultPredictionLedger().appendPrediction(input);
}

export function readPredictions(filter?: ReadPredictionsFilter): PredictionLedgerEntry[] {
  return getDefaultPredictionLedger().readPredictions(filter);
}

export function closeDefaultPredictionLedger(): void {
  if (!defaultPredictionLedger) return;
  defaultPredictionLedger.close();
  defaultPredictionLedger = null;
}
