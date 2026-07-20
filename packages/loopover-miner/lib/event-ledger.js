import { isDeepStrictEqual } from "node:util";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { EVENT_LEDGER_PURGE_SPEC, EVENT_LEDGER_RETENTION_SPEC, purgeStoreByRepo, pruneLedgerByRetention, resolveLedgerRetentionPolicy, } from "./store-maintenance.js";
const defaultDbFileName = "event-ledger.sqlite3";
let defaultEventLedger = null;
export function resolveEventLedgerDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_EVENT_LEDGER_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveEventLedgerDbPath(), "invalid_event_ledger_db_path");
}
function normalizeEventType(type) {
    if (typeof type !== "string")
        throw new Error("invalid_event_type");
    const trimmed = type.trim();
    if (!trimmed)
        throw new Error("invalid_event_type");
    return trimmed;
}
/** Optional repo scope: omitted/nullish → null; otherwise a validated `owner/repo`. */
function normalizeOptionalRepoFullName(repoFullName) {
    if (repoFullName === undefined || repoFullName === null)
        return null;
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
/** Optional seq cursor for polling: omitted → undefined; otherwise a non-negative integer last-seen seq. */
function normalizeOptionalSince(since) {
    if (since === undefined || since === null)
        return undefined;
    if (typeof since !== "number" || !Number.isInteger(since) || since < 0) {
        throw new Error("invalid_since");
    }
    return since;
}
/** Read-filter repo scope: omitted/nullish → unscoped (all events); otherwise a validated `owner/repo`. */
function normalizeReadRepoFilter(repoFullName) {
    if (repoFullName === undefined || repoFullName === null)
        return undefined;
    return normalizeOptionalRepoFullName(repoFullName);
}
// Serialize an audit payload, enforcing that it round-trips through JSON VERBATIM. A plain JSON.stringify would
// silently drop `undefined`/function/symbol values and coerce `NaN`/`Infinity` to `null` (and throw on BigInt or a
// cycle), so a read-back would not equal the appended event. We reject any such lossy payload outright — an audit
// ledger must return exactly what was recorded.
function serializePayload(payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("invalid_payload");
    }
    let json;
    try {
        json = JSON.stringify(payload);
    }
    catch {
        throw new Error("invalid_payload"); // BigInt value or circular reference
    }
    if (!isDeepStrictEqual(JSON.parse(json), payload)) {
        throw new Error("invalid_payload"); // a value JSON would drop or coerce (undefined/NaN/function/symbol/Date/…)
    }
    return json;
}
function rowToEntry(row) {
    return {
        id: row.id,
        seq: row.seq,
        type: row.event_type,
        repoFullName: row.repo_full_name,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
    };
}
function asEventDbRow(row) {
    return row;
}
// v1 -> v2 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
// same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads or
// writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
// column-presence guard as this file's sibling stores' own additive migrations (e.g. portfolio-queue.js's
// leased_at addition).
function addTenantIdColumn(db) {
    const hasTenantIdColumn = db
        .prepare("PRAGMA table_info(miner_event_ledger)")
        .all()
        .some((column) => column.name === "tenant_id");
    if (!hasTenantIdColumn)
        db.exec("ALTER TABLE miner_event_ledger ADD COLUMN tenant_id TEXT");
}
/**
 * Opens the local append-only event ledger, creating the table on first use. `seq` is a monotonically increasing
 * counter maintained by this module (next = current MAX(seq) + 1) rather than relying on `AUTOINCREMENT`'s
 * reuse-after-vacuum behavior, so consumers get a stable ordering guarantee. Rows read back in `seq ASC` order.
 * (#2290)
 */
export function initEventLedger(dbPath = resolveEventLedgerDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const db = openLocalStoreDb(resolvedPath);
    // `UNIQUE(seq)` makes the monotonic-ordering guarantee an enforced invariant: a duplicate seq can never persist,
    // even if the append path were ever changed.
    db.exec(`
    CREATE TABLE IF NOT EXISTS miner_event_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      repo_full_name TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
    // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
    applySchemaMigrations(db, [addTenantIdColumn]);
    // Opt-in retention (#4834): prune aged/excess rows when an operator has enabled it; a no-op by default.
    pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, resolveLedgerRetentionPolicy(), Date.now());
    const nextSeqStatement = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM miner_event_ledger");
    const appendStatement = db.prepare(`
    INSERT INTO miner_event_ledger (seq, event_type, repo_full_name, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
    const getByIdStatement = db.prepare("SELECT * FROM miner_event_ledger WHERE id = ?");
    const readAllStatement = db.prepare("SELECT * FROM miner_event_ledger ORDER BY seq ASC");
    const readByRepoStatement = db.prepare("SELECT * FROM miner_event_ledger WHERE repo_full_name = ? ORDER BY seq ASC");
    const readSinceStatement = db.prepare("SELECT * FROM miner_event_ledger WHERE seq > ? ORDER BY seq ASC");
    const readByRepoSinceStatement = db.prepare("SELECT * FROM miner_event_ledger WHERE repo_full_name = ? AND seq > ? ORDER BY seq ASC");
    return {
        dbPath: resolvedPath,
        appendEvent(event) {
            const type = normalizeEventType(event?.type);
            const repoFullName = normalizeOptionalRepoFullName(event?.repoFullName);
            const payloadJson = serializePayload(event?.payload);
            const createdAt = new Date().toISOString();
            // Serialize the read-then-write: BEGIN IMMEDIATE takes the write lock BEFORE reading MAX(seq), so two ledger
            // instances on the same file cannot both compute the same next seq and corrupt the ordering guarantee.
            db.exec("BEGIN IMMEDIATE");
            try {
                const { nextSeq } = nextSeqStatement.get();
                const result = appendStatement.run(nextSeq, type, repoFullName, payloadJson, createdAt);
                const entry = rowToEntry(asEventDbRow(getByIdStatement.get(Number(result.lastInsertRowid))));
                db.exec("COMMIT");
                return entry;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        readEvents(filter = {}) {
            const repoFullName = normalizeReadRepoFilter(filter.repoFullName);
            // `since` returns events with a seq STRICTLY greater than it — the "give me everything after the last seq I
            // saw" polling shape.
            const since = normalizeOptionalSince(filter.since);
            let rows;
            if (repoFullName !== undefined && since !== undefined) {
                rows = readByRepoSinceStatement.all(repoFullName, since);
            }
            else if (repoFullName !== undefined) {
                rows = readByRepoStatement.all(repoFullName);
            }
            else if (since !== undefined) {
                rows = readSinceStatement.all(since);
            }
            else {
                rows = readAllStatement.all();
            }
            return rows.map((row) => rowToEntry(asEventDbRow(row)));
        },
        // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. See the
        // IMMUTABILITY INVARIANT note above: this is a deliberate, separate exception, not a normal ledger write.
        // Requires a real repoFullName (unlike the optional filter above): a purge must never silently no-op on a
        // missing/blank argument.
        purgeByRepo(repoFullName) {
            const normalized = normalizeOptionalRepoFullName(repoFullName);
            if (normalized === null)
                throw new Error("invalid_repo_full_name");
            return purgeStoreByRepo(db, EVENT_LEDGER_PURGE_SPEC, normalized);
        },
        close() {
            db.close();
        },
    };
}
function getDefaultEventLedger() {
    defaultEventLedger ??= initEventLedger();
    return defaultEventLedger;
}
export function appendEvent(event) {
    return getDefaultEventLedger().appendEvent(event);
}
export function readEvents(filter) {
    return getDefaultEventLedger().readEvents(filter);
}
export function closeDefaultEventLedger() {
    if (!defaultEventLedger)
        return;
    defaultEventLedger.close();
    defaultEventLedger = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnQtbGVkZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZXZlbnQtbGVkZ2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUM5QyxPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUN4RyxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUM1RCxPQUFPLEVBQ0wsdUJBQXVCLEVBQ3ZCLDJCQUEyQixFQUMzQixnQkFBZ0IsRUFDaEIsc0JBQXNCLEVBQ3RCLDRCQUE0QixHQUM3QixNQUFNLHdCQUF3QixDQUFDO0FBbURoQyxNQUFNLGlCQUFpQixHQUFHLHNCQUFzQixDQUFDO0FBQ2pELElBQUksa0JBQWtCLEdBQXVCLElBQUksQ0FBQztBQUVsRCxNQUFNLFVBQVUsd0JBQXdCLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7SUFDNUYsT0FBTyx1QkFBdUIsQ0FBQyxpQkFBaUIsRUFBRSxnQ0FBZ0MsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUMzRixDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsTUFBaUM7SUFDeEQsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsd0JBQXdCLEVBQUUsRUFBRSw4QkFBOEIsQ0FBQyxDQUFDO0FBQ3ZHLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLElBQWE7SUFDdkMsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3BFLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM1QixJQUFJLENBQUMsT0FBTztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUNwRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FB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