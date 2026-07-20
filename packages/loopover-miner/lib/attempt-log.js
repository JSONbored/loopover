import { formatAttemptLogJsonl, normalizeAttemptLogEvent } from "@loopover/engine";
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
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_ATTEMPT_LOG_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveAttemptLogDbPath(), "invalid_attempt_log_db_path");
}
/** Read-filter attempt scope: omitted/nullish → unscoped (all events); otherwise a non-empty attempt id. */
function normalizeReadAttemptIdFilter(attemptId) {
    if (attemptId === undefined || attemptId === null)
        return undefined;
    if (typeof attemptId !== "string")
        throw new Error("invalid_attempt_id");
    const trimmed = attemptId.trim();
    if (!trimmed)
        throw new Error("invalid_attempt_id");
    return trimmed;
}
/** Export requires an explicit attempt id — JSONL dumps are always per attempt. */
function normalizeRequiredAttemptId(attemptId) {
    const normalized = normalizeReadAttemptIdFilter(attemptId);
    if (normalized === undefined)
        throw new Error("invalid_attempt_id");
    return normalized;
}
function rowToEntry(row) {
    let payload;
    try {
        const parsed = JSON.parse(row.payload_json);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("corrupted_attempt_log_row");
        }
        payload = parsed;
    }
    catch {
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
function rowToNormalized(row) {
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
function ensureOutcomeColumns(db) {
    const existingColumns = new Set(db.prepare("PRAGMA table_info(attempt_log_events)").all().map((column) => column.name));
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
    ensureOutcomeColumns(db);
    db.exec("CREATE INDEX IF NOT EXISTS idx_attempt_log_attempt ON attempt_log_events (attempt_id, seq)");
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
    const readByAttemptStatement = db.prepare("SELECT * FROM attempt_log_events WHERE attempt_id = ? ORDER BY seq ASC");
    return {
        dbPath: resolvedPath,
        appendAttemptLogEvent(event) {
            const normalized = normalizeAttemptLogEvent(event);
            const createdAt = new Date().toISOString();
            db.exec("BEGIN IMMEDIATE");
            try {
                const nextSeqRow = nextSeqStatement.get();
                const nextSeq = nextSeqRow.nextSeq;
                const result = appendStatement.run(nextSeq, normalized.attemptId, normalized.eventType, normalized.actionClass, normalized.mode, normalized.reason, normalized.payloadJson, normalized.provider, normalized.costUsd, normalized.tokensUsed, createdAt);
                const entry = rowToEntry(getByIdStatement.get(Number(result.lastInsertRowid)));
                db.exec("COMMIT");
                return entry;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        readAttemptLogEvents(filter = {}) {
            const attemptId = normalizeReadAttemptIdFilter(filter.attemptId);
            const rows = attemptId === undefined
                ? readAllStatement.all()
                : readByAttemptStatement.all(attemptId);
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
    if (!defaultAttemptLog)
        return;
    defaultAttemptLog.close();
    defaultAttemptLog = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXR0ZW1wdC1sb2cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhdHRlbXB0LWxvZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUscUJBQXFCLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUduRixPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUV4RyxtSEFBbUg7QUFDbkgsZ0hBQWdIO0FBQ2hILHFDQUFxQztBQUNyQyxFQUFFO0FBQ0YsK0dBQStHO0FBQy9HLCtHQUErRztBQUMvRyxnSEFBZ0g7QUFDaEgsa0hBQWtIO0FBQ2xILHNIQUFzSDtBQUV0SCxNQUFNLGlCQUFpQixHQUFHLHFCQUFxQixDQUFDO0FBQ2hELElBQUksaUJBQWlCLEdBQXNCLElBQUksQ0FBQztBQW1EaEQsTUFBTSxVQUFVLHVCQUF1QixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQzNGLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsK0JBQStCLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDMUYsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsdUJBQXVCLEVBQUUsRUFBRSw2QkFBNkIsQ0FBQyxDQUFDO0FBQ3JHLENBQUM7QUFFRCw0R0FBNEc7QUFDNUcsU0FBUyw0QkFBNEIsQ0FBQyxTQUFrQjtJQUN0RCxJQUFJLFNBQVMsS0FBSyxTQUFTLElBQUksU0FBUyxLQUFLLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUNwRSxJQUFJLE9BQU8sU0FBUyxLQUFLLFFBQVE7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLG9CQUFvQixDQUFDLENBQUM7SUFDekUsTUFBTSxPQUFPLEdBQUcsU0FBUyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQ2pDLElBQUksQ0FBQyxPQUFPO1FBQUUsTUFBTSxJQUFJ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