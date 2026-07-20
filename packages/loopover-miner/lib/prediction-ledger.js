import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { PREDICTION_LEDGER_PURGE_SPEC, PREDICTION_LEDGER_RETENTION_SPEC, purgeStoreByRepo, pruneLedgerByRetention, resolveLedgerRetentionPolicy, } from "./store-maintenance.js";
const defaultDbFileName = "prediction-ledger.sqlite3";
let defaultPredictionLedger = null;
export function resolvePredictionLedgerDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_PREDICTION_LEDGER_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolvePredictionLedgerDbPath(), "invalid_prediction_ledger_db_path");
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeOptionalRepoFullName(repoFullName) {
    if (repoFullName === undefined || repoFullName === null)
        return undefined;
    return normalizeRepoFullName(repoFullName);
}
function requiredNonEmptyString(value, error) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(error);
    return value.trim();
}
function optionalString(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string")
        throw new Error("invalid_head_sha");
    const trimmed = value.trim();
    return trimmed || null;
}
// Codes are stored as a JSON array of the non-empty trimmed strings, in order — a stable, small projection of a
// verdict's blockers/warnings that drops all free-text detail.
function normalizeCodes(codes, error) {
    if (codes === undefined || codes === null)
        return [];
    if (!Array.isArray(codes))
        throw new Error(error);
    return codes.map((code) => {
        if (typeof code !== "string" || !code.trim())
            throw new Error(error);
        return code.trim();
    });
}
function normalizeReadinessScore(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error("invalid_readiness_score");
    return value;
}
/** Validate + normalize an append input, throwing on any invalid field (mirrors normalizeGovernorLedgerEvent). */
function normalizePredictionInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("invalid_prediction_input");
    if (!Number.isInteger(input.targetId) || input.targetId <= 0)
        throw new Error("invalid_target_id");
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
        if (!Array.isArray(blockerCodes) || !Array.isArray(warningCodes))
            throw new Error("corrupted_prediction_row");
    }
    catch {
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
        blockerCodes: blockerCodes,
        warningCodes: warningCodes,
        engineVersion: row.engine_version,
    };
}
function asPredictionDbRow(row) {
    return row;
}
// v1 -> v2 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
// same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads or
// writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
// column-presence guard as this file's sibling stores' own additive migrations (e.g. event-ledger.js's and
// run-state.js's own tenant_id additions), so re-running it against an already-migrated file is a no-op.
function addTenantIdColumn(db) {
    const hasTenantIdColumn = db
        .prepare("PRAGMA table_info(predictions)")
        .all()
        .some((column) => column.name === "tenant_id");
    if (!hasTenantIdColumn)
        db.exec("ALTER TABLE predictions ADD COLUMN tenant_id TEXT");
}
/**
 * Opens the append-only prediction ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#4263)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema creation/migrations / retention / purge still use the underlying DatabaseSync until those
 * helpers are migrated. Public API stays synchronous so callers need no async cascade in this #7282 slice.
 */
export function initPredictionLedger(dbPath = resolvePredictionLedgerDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
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
            const result = driver.query(appendSql, [
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
            const { rows } = driver.query(getByIdSql, [Number(result.lastInsertRowid)]);
            return rowToEntry(asPredictionDbRow(rows[0]));
        },
        readPredictions(filter = {}) {
            const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
            const { rows } = repoFullName === undefined ? driver.query(readAllSql, []) : driver.query(readByRepoSql, [repoFullName]);
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
    if (!defaultPredictionLedger)
        return;
    defaultPredictionLedger.close();
    defaultPredictionLedger = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJlZGljdGlvbi1sZWRnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwcmVkaWN0aW9uLWxlZGdlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEVBQUUseUJBQXlCLEVBQUUscUJBQXFCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUM3RyxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUM1RCxPQUFPLEVBQ0wsNEJBQTRCLEVBQzVCLGdDQUFnQyxFQUNoQyxnQkFBZ0IsRUFDaEIsc0JBQXNCLEVBQ3RCLDRCQUE0QixHQUM3QixNQUFNLHdCQUF3QixDQUFDO0FBaUVoQyxNQUFNLGlCQUFpQixHQUFHLDJCQUEyQixDQUFDO0FBQ3RELElBQUksdUJBQXVCLEdBQTRCLElBQUksQ0FBQztBQUU1RCxNQUFNLFVBQVUsNkJBQTZCLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7SUFDakcsT0FBTyx1QkFBdUIsQ0FBQyxpQkFBaUIsRUFBRSxxQ0FBcUMsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUNoRyxDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsTUFBYztJQUNyQyxPQUFPLHlCQUF5QixDQUFDLE1BQU0sRUFBRSw2QkFBNkIsRUFBRSxFQUFFLG1DQUFtQyxDQUFDLENBQUM7QUFDakgsQ0FBQztBQUVELFNBQVMscUJBQXFCLENBQUMsWUFBb0I7SUFDakQsSUFBSSxPQUFPLFlBQVksS0FBSyxRQUFRO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQ2hGLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLFlBQVksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDNUQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUN0RixPQUFPLEdBQUcsS0FBSyxJQUFJLElBQUksRUFBRSxDQUFDO0FBQzVCLENBQUM7QUFFRCxTQUFTLDZCQUE2QixDQUFDLFlBQXVDO0lBQzVFLElBQUksWUFBWSxLQUFLLFNBQVMsSUFBSSxZQUFZLEtBQUssSUFBSTtRQUFFLE9BQU8sU0FBUyxDQUFDO0lBQzFFLE9BQU8scUJBQXFCLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDN0MsQ0FBQztBQUVELFNBQVMsc0JBQXNCLENBQUMsS0FBYyxFQUFFLEtBQWE7SUFDM0QsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN2RSxPQUFPLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUN0QixDQUFDO0FBRUQsU0FBUyxjQUFjLENBQUMsS0FBZ0M7SUFDdEQsSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdkQsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0lBQ25FLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixPQUFPLE9BQU8sSUFBSSxJQUFJLENBQUM7QUFDekIsQ0FBQztBQUVELGdIQUFnSDtBQUNoSCwrREFBK0Q7QUFDL0QsU0FBUyxjQUFjLENBQUMsS0FBa0MsRUFBRSxLQUFhO0lBQ3ZFLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSTtRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ3JELElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDbEQsT0FBTyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUU7UUFDeEIsSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNyRSxPQUFPLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNyQixDQUFDLENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLEtBQWdDO0lBQy9ELElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3ZELElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHlCQUF5QixDQUFDLENBQUM7SUFDckcsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDO0FBRUQsa0hBQWtIO0FBQ2xILFNBQVMsd0JBQXdCLENBQUMsS0FBNEI7SUFXNUQsSUFBSSxDQUFDLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLDBCQUEwQixDQUFDLENBQUM7SUFDN0csSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEtBQUssQ0FBQyxRQUFRLElBQUksQ0FBQztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsbUJBQW1CLENBQUMsQ0FBQztJQUNuRyxPQUFPO1FBQ0wsWUFBWSxFQUFFLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUM7UUFDdkQsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRO1FBQ3hCLE9BQU8sRUFBRSxjQUFjLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQztRQUN0QyxVQUFVLEVBQUUsc0JBQXNCLENBQUMsS0FBSyxDQUFDLFVBQVUsRUFBRSxvQkFBb0IsQ0FBQztRQUMxRSxJQUFJLEVBQUUsc0JBQXNCLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxjQUFjLENBQUM7UUFDeEQsY0FBYyxFQUFFLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUM7UUFDN0QsWUFBWSxFQUFFLGNBQWMsQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFLHVCQUF1QixDQUFDO1FBQ3pFLFlBQVksRUFBRSxjQUFjLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSx1QkFBdUIsQ0FBQztRQUN6RSxhQUFhLEVBQUUsc0JBQXNCLENBQUMsS0FBSyxDQUFDLGFBQWEsRUFBRSx3QkFBd0IsQ0FBQztLQUNyRixDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLEdBQW9CO0lBQ3RDLElBQUksWUFBcUIsQ0FBQztJQUMxQixJQUFJLFlBQXFCLENBQUM7SUFDMUIsSUFBSSxDQUFDO1FBQ0gsWUFBWSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLGtCQUFrQixDQUFDLENBQUM7UUFDbEQsWUFBWSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLGtCQUFrQixDQUFDLENBQUM7UUFDbEQsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQztZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsMEJBQTBCLENBQUMsQ0FBQztJQUNoSCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsTUFBTSxJQUFJLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQzlDLENBQUM7SUFDRCxPQUFPO1FBQ0wsRUFBRSxFQUFFLEdBQUcsQ0FBQyxFQUFFO1FBQ1YsRUFBRSxFQUFFLEdBQUcsQ0FBQyxFQUFFO1FBQ1YsWUFBWSxFQUFFLEdBQUcsQ0FBQyxjQUFjO1FBQ2hDLFFBQVEsRUFBRSxHQUFHLENBQUMsU0FBUztRQUN2QixPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVE7UUFDckIsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVO1FBQzFCLElBQUksRUFBRSxHQUFHLENBQUMsSUFBSTtRQUNkLGNBQWMsRUFBRSxHQUFHLENBQUMsZUFBZTtRQUNuQyxZQUFZLEVBQUUsWUFBd0I7UUFDdEMsWUFBWSxFQUFFLFlBQXdCO1FBQ3RDLGFBQWEsRUFBRSxHQUFHLENBQUMsY0FBYztLQUNsQyxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsaUJBQWlCLENBQUMsR0FBNEI7SUFDckQsT0FBTyxHQUFpQyxDQUFDO0FBQzNDLENBQUM7QUFFRCw0R0FBNEc7QUFDNUcsK0dBQStHO0FBQy9HLG1HQUFtRztBQUNuRywyR0FBMkc7QUFDM0cseUdBQXlHO0FBQ3pHLFNBQVMsaUJBQWlCLENBQUMsRUFBZ0I7SUFDekMsTUFBTSxpQkFBaUIsR0FBRyxFQUFFO1NBQ3pCLE9BQU8sQ0FBQyxnQ0FBZ0MsQ0FBQztTQUN6QyxHQUFHLEVBQUU7U0FDTCxJQUFJLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssV0FBVyxDQUFDLENBQUM7SUFDakQsSUFBSSxDQUFDLGlCQUFpQjtRQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsbURBQW1ELENBQUMsQ0FBQztBQUN2RixDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILE1BQU0sVUFBVSxvQkFBb0IsQ0FBQyxTQUFpQiw2QkFBNkIsRUFBRTtJQUNuRixNQUFNLFlBQVksR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDN0MsTUFBTSxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsR0FBRyxxQkFBcUIsQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUMzRCxFQUFFLENBQUMsSUFBSSxDQUFDOzs7Ozs7Ozs7Ozs7OztHQWNQLENBQUMsQ0FBQztJQUNILEVBQUUsQ0FBQyxJQUFJLENBQUMscUZBQXFGLENBQUMsQ0FBQztJQUMvRiw4RkFBOEY7SUFDOUYscUJBQXFCLENBQUMsRUFBRSxFQUFFLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDO0lBQy9DLHdHQUF3RztJQUN4RyxzQkFBc0IsQ0FBQyxFQUFFLEVBQUUsZ0NBQWdDLEVBQUUsNEJBQTRCLEVBQUUsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztJQUV6RyxNQUFNLFNBQVMsR0FBRzs7OztHQUlqQixDQUFDO0lBQ0YsTUFBTSxVQUFVLEdBQUcsd0NBQXdDLENBQUM7SUFDNUQsTUFBTSxVQUFVLEdBQUcsMkNBQTJDLENBQUM7SUFDL0QsTUFBTSxhQUFhLEdBQUcsb0VBQW9FLENBQUM7SUFFM0YsT0FBTztRQUNMLE1BQU0sRUFBRSxZQUFZO1FBQ3BCLGdCQUFnQixDQUFDLEtBQUs7WUFDcEIsTUFBTSxDQUFDLEdBQUcsd0JBQXdCLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDMUMsTUFBTSxFQUFFLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNwQyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsRUFBRTtnQkFDckMsRUFBRTtnQkFDRixDQUFDLENBQUMsWUFBWTtnQkFDZCxDQUFDLENBQUMsUUFBUTtnQkFDVixDQUFDLENBQUMsT0FBTztnQkFDVCxDQUFDLENBQUMsVUFBVTtnQkFDWixDQUFDLENBQUMsSUFBSTtnQkFDTixDQUFDLENBQUMsY0FBYztnQkFDaEIsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDO2dCQUM5QixJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7Z0JBQzlCLENBQUMsQ0FBQyxhQUFhO2FBQ2hCLENBQUMsQ0FBQztZQUNILE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQzVFLE9BQU8sVUFBVSxDQUFDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUUsQ0FBQyxDQUFDLENBQUM7UUFDakQsQ0FBQztRQUNELGVBQWUsQ0FBQyxNQUFNLEdBQUcsRUFBRTtZQUN6QixNQUFNLFlBQVksR0FBRyw2QkFBNkIsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDeEUsTUFBTSxFQUFFLElBQUksRUFBRSxHQUFHLFlBQVksS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7WUFDekgsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQy9ELENBQUM7UUFDRCxxR0FBcUc7UUFDckcsMEdBQTBHO1FBQzFHLFdBQVcsQ0FBQyxZQUFZO1lBQ3RCLE9BQU8sZ0JBQWdCLENBQUMsRUFBRSxFQUFFLDRCQUE0QixFQUFFLHFCQUFxQixDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7UUFDakcsQ0FBQztRQUNELEtBQUs7WUFDSCxFQUFFLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDYixDQUFDO0tBQ0YsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLDBCQUEwQjtJQUNqQyx1QkFBdUIsS0FBSyxvQkFBb0IsRUFBRSxDQUFDO0lBQ25ELE9BQU8sdUJBQXVCLENBQUM7QUFDakMsQ0FBQztBQUVELE1BQU0sVUFBVSxnQkFBZ0IsQ0FBQyxLQUE0QjtJQUMzRCxPQUFPLDBCQUEwQixFQUFFLENBQUMsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDOUQsQ0FBQztBQUVELE1BQU0sVUFBVSxlQUFlLENBQUMsTUFBOEI7SUFDNUQsT0FBTywwQkFBMEIsRUFBRSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM5RCxDQUFDO0FBRUQsTUFBTSxVQUFVLDRCQUE0QjtJQUMxQyxJQUFJLENBQUMsdUJBQXVCO1FBQUUsT0FBTztJQUNyQyx1QkFBdUIsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNoQyx1QkFBdUIsR0FBRyxJQUFJLENBQUM7QUFDakMsQ0FBQyJ9