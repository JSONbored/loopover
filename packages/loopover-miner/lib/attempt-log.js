import { formatAttemptLogJsonl, normalizeAttemptLogEvent } from "@loopover/engine";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
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
// `event_type`/`mode` are cast to their literal-union types: every row was written through
// appendAttemptLogEvent's own normalizeAttemptLogEvent call, which already validates both against the engine's
// fixed vocabulary, so a row read back from this table always carries a recognized value.
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
                const { nextSeq } = nextSeqStatement.get();
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
            const rows = attemptId === undefined ? readAllStatement.all() : readByAttemptStatement.all(attemptId);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXR0ZW1wdC1sb2cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhdHRlbXB0LWxvZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUscUJBQXFCLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUduRixPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQTRDeEcsTUFBTSxpQkFBaUIsR0FBRyxxQkFBcUIsQ0FBQztBQUNoRCxJQUFJLGlCQUFpQixHQUFzQixJQUFJLENBQUM7QUFFaEQsTUFBTSxVQUFVLHVCQUF1QixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQzNGLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsK0JBQStCLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDMUYsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsdUJBQXVCLEVBQUUsRUFBRSw2QkFBNkIsQ0FBQyxDQUFDO0FBQ3JHLENBQUM7QUFFRCw0R0FBNEc7QUFDNUcsU0FBUyw0QkFBNEIsQ0FBQyxTQUFvQztJQUN4RSxJQUFJLFNBQVMsS0FBSyxTQUFTLElBQUksU0FBUyxLQUFLLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUNwRSxJQUFJLE9BQU8sU0FBUyxLQUFLLFFBQVE7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLG9CQUFvQixDQUFDLENBQUM7SUFDekUsTUFBTSxPQUFPLEdBQUcsU0FBUyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQ2pDLElBQUksQ0FBQyxPQUFPO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3BELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxtRkFBbUY7QUFDbkYsU0FBUywwQkFBMEIsQ0FBQyxTQUFpQjtJQUNuRCxNQUFNLFVB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