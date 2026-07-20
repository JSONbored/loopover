import { formatAttemptLogJsonl, normalizeAttemptLogEvent } from "@loopover/engine";
import type { AttemptLogEvent } from "@loopover/engine";
import type { DatabaseSync } from "node:sqlite";
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
let defaultAttemptLog: AttemptLog | null = null;

export type AttemptLogEntry = {
  id: number;
  seq: number;
  eventType: string;
  attemptId: string;
  actionClass: string;
  mode: string;
  reason: string;
  payload: Record<string, unknown>;
  /** Coding-agent provider name, when the event set one (#5185). Null for every event type that predates this
   *  field. */
  provider: string | null;
  /** Real dollar cost, when the event set one (#5185). Null (not 0) when absent -- never fabricated. */
  costUsd: number | null;
  /** Real token count, when some future driver reports one (#5185). Always null today -- no driver reports real
   *  token usage yet (#5395). */
  tokensUsed: number | null;
  createdAt: string;
};

export type ReadAttemptLogEventsFilter = {
  attemptId?: string | null;
};

export type AttemptLog = {
  dbPath: string;
  appendAttemptLogEvent(event: AttemptLogEvent): AttemptLogEntry;
  readAttemptLogEvents(filter?: ReadAttemptLogEventsFilter): AttemptLogEntry[];
  exportAttemptLogJsonl(attemptId: string): string;
  close(): void;
};

type AttemptLogRow = {
  id: number;
  seq: number;
  event_type: string;
  attempt_id: string;
  action_class: string;
  mode: string;
  reason: string;
  payload_json: string;
  provider: string | null;
  cost_usd: number | null;
  tokens_used: number | null;
  created_at: string;
};

type TableInfoRow = { name: string };

export function resolveAttemptLogDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_ATTEMPT_LOG_DB", env);
}

function normalizeDbPath(dbPath: string): string {
  return normalizeLocalStoreDbPath(dbPath, resolveAttemptLogDbPath(), "invalid_attempt_log_db_path");
}

/** Read-filter attempt scope: omitted/nullish → unscoped (all events); otherwise a non-empty attempt id. */
function normalizeReadAttemptIdFilter(attemptId: unknown): string | undefined {
  if (attemptId === undefined || attemptId === null) return undefined;
  if (typeof attemptId !== "string") throw new Error("invalid_attempt_id");
  const trimmed = attemptId.trim();
  if (!trimmed) throw new Error("invalid_attempt_id");
  return trimmed;
}

/** Export requires an explicit attempt id — JSONL dumps are always per attempt. */
function normalizeRequiredAttemptId(attemptId: unknown): string {
  const normalized = normalizeReadAttemptIdFilter(attemptId);
  if (normalized === undefined) throw new Error("invalid_attempt_id");
  return normalized;
}

function rowToEntry(row: AttemptLogRow): AttemptLogEntry {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("corrupted_attempt_log_row");
    }
    payload = parsed as Record<string, unknown>;
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
    provider: row.provider,
    costUsd: row.cost_usd,
    tokensUsed: row.tokens_used,
    createdAt: row.created_at,
  };
}

function rowToNormalized(row: AttemptLogRow) {
  return {
    eventType: row.event_type,
    attemptId: row.attempt_id,
    actionClass: row.action_class,
    mode: row.mode,
    reason: row.reason,
    payloadJson: row.payload_json,
    provider: row.provider,
    costUsd: row.cost_usd,
    tokensUsed: row.tokens_used,
  };
}

// Add the provider/cost_usd/tokens_used columns (#5185) to an on-disk file created before they existed. `CREATE
// TABLE IF NOT EXISTS` above is a no-op against an already-existing table, so a pre-#5185 file needs this
// explicit ALTER -- guarded by a per-column presence check (same technique as governor-state.js's own
// ensurePauseColumns) so a file missing only one of the three still gets exactly what it's missing.
function ensureOutcomeColumns(db: DatabaseSync): void {
  const existingColumns = new Set(
    db.prepare("PRAGMA table_info(attempt_log_events)").all().map((column) => (column as TableInfoRow).name),
  );
  if (!existingColumns.has("provider")) {
    db.exec("ALTER TABLE attempt_log_events ADD COLUMN provider TEXT");
  }
  if (!existingColumns.has("cost_usd")) {
    db.exec("ALTER TABLE attempt_log_events ADD COLUMN cost_usd REAL");
  }
  if (!existingColumns.has("tokens_used")) {
    db.exec("ALTER TABLE attempt_log_events ADD COLUMN tokens_used INTEGER");
  }
}

/**
 * Opens the append-only attempt log, creating the table on first use. `seq` is a monotonically increasing counter
 * maintained by this module (next = current MAX(seq) + 1) with a UNIQUE(seq) constraint. Rows read back in seq ASC
 * order. (#4294)
 */
export function initAttemptLog(dbPath: string = resolveAttemptLogDbPath()): AttemptLog {
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
  ensureOutcomeColumns(db);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_attempt_log_attempt ON attempt_log_events (attempt_id, seq)",
  );

  const nextSeqStatement = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM attempt_log_events");
  const appendStatement = db.prepare(`
    INSERT INTO attempt_log_events (
      seq, attempt_id, event_type, action_class, mode, reason, payload_json, provider, cost_usd, tokens_used,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        const nextSeqRow = nextSeqStatement.get() as { nextSeq: number } | undefined;
        const nextSeq = nextSeqRow!.nextSeq;
        const result = appendStatement.run(
          nextSeq,
          normalized.attemptId,
          normalized.eventType,
          normalized.actionClass,
          normalized.mode,
          normalized.reason,
          normalized.payloadJson,
          normalized.provider,
          normalized.costUsd,
          normalized.tokensUsed,
          createdAt,
        );
        const entry = rowToEntry(getByIdStatement.get(Number(result.lastInsertRowid)) as AttemptLogRow);
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
        attemptId === undefined
          ? (readAllStatement.all() as AttemptLogRow[])
          : (readByAttemptStatement.all(attemptId) as AttemptLogRow[]);
      return rows.map(rowToEntry);
    },
    exportAttemptLogJsonl(attemptId) {
      const scopedAttemptId = normalizeRequiredAttemptId(attemptId);
      const rows = readByAttemptStatement.all(scopedAttemptId) as AttemptLogRow[];
      return formatAttemptLogJsonl(rows.map(rowToNormalized) as Parameters<typeof formatAttemptLogJsonl>[0]);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultAttemptLog(): AttemptLog {
  defaultAttemptLog ??= initAttemptLog();
  return defaultAttemptLog;
}

export function appendAttemptLogEvent(event: AttemptLogEvent): AttemptLogEntry {
  return getDefaultAttemptLog().appendAttemptLogEvent(event);
}

export function readAttemptLogEvents(filter?: ReadAttemptLogEventsFilter): AttemptLogEntry[] {
  return getDefaultAttemptLog().readAttemptLogEvents(filter);
}

export function exportAttemptLogJsonl(attemptId: string): string {
  return getDefaultAttemptLog().exportAttemptLogJsonl(attemptId);
}

export function closeDefaultAttemptLog(): void {
  if (!defaultAttemptLog) return;
  defaultAttemptLog.close();
  defaultAttemptLog = null;
}
