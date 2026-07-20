import { normalizeGovernorLedgerEvent } from "@loopover/engine";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { GOVERNOR_LEDGER_PURGE_SPEC, GOVERNOR_LEDGER_RETENTION_SPEC, purgeStoreByRepo, pruneLedgerByRetention, resolveLedgerRetentionPolicy, } from "./store-maintenance.js";
const defaultDbFileName = "governor-ledger.sqlite3";
let defaultGovernorLedger = null;
export function resolveGovernorLedgerDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_GOVERNOR_LEDGER_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveGovernorLedgerDbPath(), "invalid_governor_ledger_db_path");
}
function normalizeOptionalRepoFullName(repoFullName) {
    if (repoFullName === undefined || repoFullName === null)
        return undefined;
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function rowToEntry(row) {
    let payload;
    try {
        payload = JSON.parse(row.payload_json);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("corrupted_governor_row");
        }
    }
    catch {
        throw new Error("corrupted_governor_row");
    }
    return {
        id: row.id,
        ts: row.ts,
        eventType: row.event_type,
        repoFullName: row.repo_full_name,
        actionClass: row.action_class,
        decision: row.decision,
        reason: row.reason,
        payload: payload,
    };
}
// Decision-log projection (#5159): the public, MCP-exposed shape. Deliberately omits payload_json (which #5134
// is expanding with reputation/self-plagiarism/budget state). Kept honest by an explicit named-column SELECT
// below — never SELECT * — so the sensitive column cannot leak even by accident.
function rowToDecision(row) {
    return {
        id: row.id,
        ts: row.ts,
        eventType: row.event_type,
        repoFullName: row.repo_full_name,
        actionClass: row.action_class,
        decision: row.decision,
        reason: row.reason,
    };
}
// v1 -> v2 (#4939/#6597): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of
// this same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing
// reads or writes it yet. Same defensive column-presence guard as this file's sibling stores' own additive
// migrations (e.g. event-ledger.js's addTenantIdColumn).
function addTenantIdColumn(db) {
    const hasTenantIdColumn = db
        .prepare("PRAGMA table_info(governor_events)")
        .all()
        .some((column) => column.name === "tenant_id");
    if (!hasTenantIdColumn)
        db.exec("ALTER TABLE governor_events ADD COLUMN tenant_id TEXT");
}
function asGovernorDbRow(row) {
    return row;
}
/**
 * Opens the append-only governor ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#2328)
 */
export function initGovernorLedger(dbPath = resolveGovernorLedgerDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const db = openLocalStoreDb(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS governor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      repo_full_name TEXT,
      action_class TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_governor_events_repo ON governor_events (repo_full_name, id)");
    // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
    applySchemaMigrations(db, [addTenantIdColumn]);
    // Opt-in retention (#4834): prune aged/excess rows when an operator has enabled it; a no-op by default.
    pruneLedgerByRetention(db, GOVERNOR_LEDGER_RETENTION_SPEC, resolveLedgerRetentionPolicy(), Date.now());
    const appendStatement = db.prepare(`
    INSERT INTO governor_events (ts, event_type, repo_full_name, action_class, decision, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    const getByIdStatement = db.prepare("SELECT * FROM governor_events WHERE id = ?");
    const readAllStatement = db.prepare("SELECT * FROM governor_events ORDER BY id ASC");
    const readByRepoStatement = db.prepare("SELECT * FROM governor_events WHERE repo_full_name = ? ORDER BY id ASC");
    // Explicit named-column projection for the read-only decision log (#5159) — payload_json is intentionally
    // NOT in this list, so widening it would be a deliberate edit that the redaction test guards against.
    const decisionColumns = "id, ts, event_type, repo_full_name, action_class, decision, reason";
    const readDecisionsAllStatement = db.prepare(`SELECT ${decisionColumns} FROM governor_events ORDER BY id ASC`);
    const readDecisionsByRepoStatement = db.prepare(`SELECT ${decisionColumns} FROM governor_events WHERE repo_full_name = ? ORDER BY id ASC`);
    return {
        dbPath: resolvedPath,
        appendGovernorEvent(event) {
            const normalized = normalizeGovernorLedgerEvent(event);
            const ts = new Date().toISOString();
            const result = appendStatement.run(ts, normalized.eventType, normalized.repoFullName, normalized.actionClass, normalized.decision, normalized.reason, normalized.payloadJson);
            return rowToEntry(asGovernorDbRow(getByIdStatement.get(Number(result.lastInsertRowid))));
        },
        readGovernorEvents(filter = {}) {
            const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
            const rows = repoFullName === undefined
                ? readAllStatement.all()
                : readByRepoStatement.all(repoFullName);
            return rows.map((row) => rowToEntry(asGovernorDbRow(row)));
        },
        readGovernorDecisions(filter = {}) {
            const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
            const rows = repoFullName === undefined
                ? readDecisionsAllStatement.all()
                : readDecisionsByRepoStatement.all(repoFullName);
            return rows.map((row) => rowToDecision(asGovernorDbRow(row)));
        },
        // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. See the
        // IMMUTABILITY INVARIANT note above: this is a deliberate, separate exception, not a normal ledger write.
        // Requires a real repoFullName (unlike the optional filters above): a purge must never silently no-op.
        purgeByRepo(repoFullName) {
            const normalized = normalizeOptionalRepoFullName(repoFullName);
            if (normalized === undefined)
                throw new Error("invalid_repo_full_name");
            return purgeStoreByRepo(db, GOVERNOR_LEDGER_PURGE_SPEC, normalized);
        },
        close() {
            db.close();
        },
    };
}
function getDefaultGovernorLedger() {
    defaultGovernorLedger ??= initGovernorLedger();
    return defaultGovernorLedger;
}
export function appendGovernorEvent(event) {
    return getDefaultGovernorLedger().appendGovernorEvent(event);
}
export function readGovernorEvents(filter) {
    return getDefaultGovernorLedger().readGovernorEvents(filter);
}
export function closeDefaultGovernorLedger() {
    if (!defaultGovernorLedger)
        return;
    defaultGovernorLedger.close();
    defaultGovernorLedger = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItbGVkZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZ292ZXJub3ItbGVkZ2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2hFLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxnQkFBZ0IsRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ3hHLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQzVELE9BQU8sRUFDTCwwQkFBMEIsRUFDMUIsOEJBQThCLEVBQzlCLGdCQUFnQixFQUNoQixzQkFBc0IsRUFDdEIsNEJBQTRCLEdBQzdCLE1BQU0sd0JBQXdCLENBQUM7QUEwRGhDLE1BQU0saUJBQWlCLEdBQUcseUJBQXlCLENBQUM7QUFDcEQsSUFBSSxxQkFBcUIsR0FBMEIsSUFBSSxDQUFDO0FBRXhELE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUMvRixPQUFPLHVCQUF1QixDQUFDLGlCQUFpQixFQUFFLG1DQUFtQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQzlGLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxNQUFjO0lBQ3JDLE9BQU8seUJBQXlCLENBQUMsTUFBTSxFQUFFLDJCQUEyQixFQUFFLEVBQUUsaUNBQWlDLENBQUMsQ0FBQztBQUM3RyxDQUFDO0FBRUQsU0FBUyw2QkFBNkIsQ0FBQyxZQUF1QztJQUM1RSxJQUFJLFlBQVksS0FBSyxTQUFTLElBQUksWUFBWSxLQUFLLElBQUk7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUMxRSxJQUFJLE9BQU8sWUFBWSxLQUFLLFFBQVE7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDaEYsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsWUFBWSxDQUFDLElBQUksRUFB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