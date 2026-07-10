import { formatAttemptLogJsonl, normalizeAttemptLogEvent } from "@jsonbored/gittensory-engine";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";

// Append-only driver attempt log (#4294): a structured, attempt-scoped event trace for every CodingAgentDriver run
// (started, tool/edit, succeeded/failed/aborted). IMMUTABILITY INVARIANT: INSERT + SELECT only — rows are never
// rewritten or removed after append.
//
// Why a sibling store instead of extending event-ledger.js: event-ledger is the general miner-loop audit trail
// (discovered_issue, plan_built, pr_prepared, …) keyed by repo scope with a growing free-form type vocabulary.
// Attempt events are keyed by attempt_id, validated against the engine's fixed ATTEMPT_LOG_EVENT_TYPES, and are
// exported per attempt as JSONL — mixing both into one table would couple unrelated lifecycles and complicate the
// per-attempt dump path. This module mirrors governor-ledger.js: engine holds pure normalization, miner holds SQLite.

const defaultDbFileName = "attempt-log.sqlite3";
let defaultAttemptLog = null;

export function resolveAttemptLogDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "GITTENSORY_MINER_ATTEMPT_LOG_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolveAttemptLogDbPath(), "invalid_attempt_log_db_path");
}

/** Read-filter attempt scope: omitted/nullish → unscoped (all events); otherwise a non-empty attempt id. */
function normalizeReadAttemptIdFilter(attemptId) {
  if (attemptId === undefined || attemptId === null) return undefined;
  if (typeof attemptId !== "string") throw new Error("invalid_attempt_id");
  const trimmed = attemptId.trim();
  if (!trimmed) throw new Error("invalid_attempt_id");
  return trimmed;
}

/** Export requires an explicit attempt id — JSONL dumps are always per attempt. */
function normalizeRequiredAttemptId(attemptId) {
  const normalized = normalizeReadAttemptIdFilter(attemptId);
  if (normalized === undefined) throw new Error("invalid_attempt_id");
  return normalized;
}

function rowToEntry(row) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("corrupted_attempt_log_row");
    }
  } catch {
    throw new Error("corrupted_attempt_log_row");
  }
  return {
    id: row.id,
    seq: row.seq,
    eventType: row.event_type,
    attemptId: row.attempt_id,
    actionClass: row.action_class,
    mode: row.mode,
    reason: row.reason,
    payload,
    createdAt: row.created_at,
  };
}

function rowToNormalized(row) {
  return {
    eventType: row.event_type,
    attemptId: row.attempt_id,
    actionClass: row.action_class,
    mode: row.mode,
    reason: row.reason,
    payloadJson: row.payload_json,
  };
}

/**
 * Opens the append-only attempt log, creating the table on first use. `seq` is a monotonically increasing counter
 * maintained by this module (next = current MAX(seq) + 1) with a UNIQUE(seq) constraint. Rows read back in seq ASC
 * order. (#4294)
 */
export function initAttemptLog(dbPath = resolveAttemptLogDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS attempt_log_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action_class TEXT NOT NULL,
      mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_attempt_log_attempt ON attempt_log_events (attempt_id, seq)",
  );

  const nextSeqStatement = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM attempt_log_events");
  const appendStatement = db.prepare(`
    INSERT INTO attempt_log_events (
      seq, attempt_id, event_type, action_class, mode, reason, payload_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getByIdStatement = db.prepare("SELECT * FROM attempt_log_events WHERE id = ?");
  const readAllStatement = db.prepare("SELECT * FROM attempt_log_events ORDER BY seq ASC");
  const readByAttemptStatement = db.prepare(
    "SELECT * FROM attempt_log_events WHERE attempt_id = ? ORDER BY seq ASC",
  );

  return {
    dbPath: resolvedPath,
    appendAttemptLogEvent(event) {
      const normalized = normalizeAttemptLogEvent(event);
      const createdAt = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        const { nextSeq } = nextSeqStatement.get();
        const result = appendStatement.run(
          nextSeq,
          normalized.attemptId,
          normalized.eventType,
          normalized.actionClass,
          normalized.mode,
          normalized.reason,
          normalized.payloadJson,
          createdAt,
        );
        const entry = rowToEntry(getByIdStatement.get(Number(result.lastInsertRowid)));
        db.exec("COMMIT");
        return entry;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    readAttemptLogEvents(filter = {}) {
      const attemptId = normalizeReadAttemptIdFilter(filter.attemptId);
      const rows =
        attemptId === undefined ? readAllStatement.all() : readByAttemptStatement.all(attemptId);
      return rows.map(rowToEntry);
    },
    exportAttemptLogJsonl(attemptId) {
      const scopedAttemptId = normalizeRequiredAttemptId(attemptId);
      const rows = readByAttemptStatement.all(scopedAttemptId);
      return formatAttemptLogJsonl(rows.map(rowToNormalized));
    },
    close() {
      db.close();
    },
  };
}

function getDefaultAttemptLog() {
  defaultAttemptLog ??= initAttemptLog();
  return defaultAttemptLog;
}

export function appendAttemptLogEvent(event) {
  return getDefaultAttemptLog().appendAttemptLogEvent(event);
}

export function readAttemptLogEvents(filter) {
  return getDefaultAttemptLog().readAttemptLogEvents(filter);
}

export function exportAttemptLogJsonl(attemptId) {
  return getDefaultAttemptLog().exportAttemptLogJsonl(attemptId);
}

export function closeDefaultAttemptLog() {
  if (!defaultAttemptLog) return;
  defaultAttemptLog.close();
  defaultAttemptLog = null;
}
