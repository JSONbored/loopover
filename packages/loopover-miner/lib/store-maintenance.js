// Local-store maintenance for the miner (#4834): SQLite integrity checks + append-only ledger retention.
//
// Three independent, side-effect-light helpers used by `doctor`, the ledgers, and `purge-cli.js`:
//   1. checkStoreIntegrity — run `PRAGMA integrity_check` on one store file and report health, so `doctor` can
//      flag a corrupted store instead of only probing a single one with `SELECT 1`.
//   2. resolveLedgerRetentionPolicy / pruneLedgerByRetention — an opt-in, age- and/or size-based retention
//      policy for the unbounded append-only ledgers (event, governor, prediction), which otherwise grow forever.
//      OFF by default: retention only runs when an operator sets the env opt-in.
//   3. purgeStoreByRepo — an explicit, operator-invoked delete of every row for one repo (#5564, right-to-be-
//      forgotten). Distinct from retention pruning: never runs automatically, always caller-initiated via
//      `purge-cli.js`, and always reports how many rows it removed so a purge is never silent.
// Pure control flow over injected inputs (a DB handle, an env object, a caller-supplied clock) — no network, and
// no internal clock read in the prune path so it stays deterministic and unit-testable.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CONTRIBUTION_PROFILE_STORE_TABLE } from "./contribution-profile.js";
/** Env opt-ins for ledger retention (unset ⇒ retention disabled). */
export const LEDGER_RETENTION_DAYS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_DAYS";
export const LEDGER_RETENTION_MAX_ROWS_ENV = "LOOPOVER_MINER_LEDGER_RETENTION_MAX_ROWS";
/** Fixed retention specs for the three append-only ledgers. These identifiers are INTERNAL constants — never
 *  caller/user text — and are validated as plain identifiers before interpolation as defence in depth. */
export const EVENT_LEDGER_RETENTION_SPEC = { table: "miner_event_ledger", timestampColumn: "created_at", orderColumn: "id" };
export const GOVERNOR_LEDGER_RETENTION_SPEC = { table: "governor_events", timestampColumn: "ts", orderColumn: "id" };
export const PREDICTION_LEDGER_RETENTION_SPEC = { table: "predictions", timestampColumn: "ts", orderColumn: "id" };
/** Fixed purge specs (#5564, #6599) for the six stores whose rows are directly scoped by a `repoColumn`. Same
 *  internal-constant-only discipline as the retention specs above. `attempt-log.js` is deliberately absent: its
 *  payload is a free-form `Record<string, unknown>` with no dedicated repo column, so a precise per-repo purge
 *  isn't possible there without risking false matches — `purge-cli.js` reports it as not-purgeable instead. */
export const CLAIM_LEDGER_PURGE_SPEC = { table: "miner_claims", repoColumn: "repo_full_name" };
export const EVENT_LEDGER_PURGE_SPEC = { table: "miner_event_ledger", repoColumn: "repo_full_name" };
export const GOVERNOR_LEDGER_PURGE_SPEC = { table: "governor_events", repoColumn: "repo_full_name" };
export const PREDICTION_LEDGER_PURGE_SPEC = { table: "predictions", repoColumn: "repo_full_name" };
export const PORTFOLIO_QUEUE_PURGE_SPEC = { table: "miner_portfolio_queue", repoColumn: "repo_full_name" };
export const RUN_STATE_PURGE_SPEC = { table: "miner_run_state", repoColumn: "repo_full_name" };
/** Three more repo-scoped stores the original six missed (#7091), same `repoColumn` shape and same internal-
 *  constant-only discipline. The contribution-profile-cache table name comes from its schema module's own
 *  `CONTRIBUTION_PROFILE_STORE_TABLE` constant so this spec can't drift from a second hardcoded literal.
 *  governor-state holds two genuinely repo-scoped tables (reputation history + own submissions);
 *  `governor_scalar_state` is intentionally excluded — it is a single whole-run scalar row with no repo
 *  dimension. `governor_reputation_history` is purged on `repo_full_name` alone (its key is composite with
 *  `api_base_url`), so a right-to-be-forgotten sweep clears the repo across every forge host it was recorded
 *  against, not just the default one. */
export const CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC = { table: CONTRIBUTION_PROFILE_STORE_TABLE, repoColumn: "repo_full_name" };
export const GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC = { table: "governor_reputation_history", repoColumn: "repo_full_name" };
export const GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC = { table: "governor_own_submissions", repoColumn: "repo_full_name" };
/** policy-verdict-cache (#6987), another repo-scoped store the earlier sweeps missed. Its `repo_scope TEXT
 *  PRIMARY KEY` is the per-repo column (a tenant forge host + `owner/repo`), the same `repoColumn` shape and
 *  internal-constant-only discipline as the specs above. `policy-doc-cache.js` stays out (keyed by URL, no repo
 *  column, exactly like `attempt-log.js`). */
export const POLICY_VERDICT_CACHE_PURGE_SPEC = { table: "policy_verdict_cache", repoColumn: "repo_scope" };
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A readable message for a caught value, whether or not it is an Error. */
export function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Classify raw `PRAGMA integrity_check` rows. A healthy database yields a single `"ok"` row; a corrupt one yields
 * one row per problem. Pure — extracted so both the healthy and problem paths are testable without a genuinely
 * corrupt file (which SQLite typically refuses to open at all, i.e. the catch path below).
 */
export function classifyIntegrityRows(rows) {
    const problems = rows.map((row) => String(row.integrity_check)).filter((value) => value !== "ok");
    return problems.length === 0 ? { ok: true, note: "ok" } : { ok: false, note: problems.join("; ") };
}
/**
 * Run `PRAGMA integrity_check` on a single store file. A store that does not exist yet is healthy by absence
 * (nothing to corrupt). Never throws: a store that cannot be opened or read is reported as not-ok, so one bad
 * store cannot abort the whole doctor sweep. Opens the connection driver-enforced read-only -- `readOnly`
 * (camelCase) is the only option key node:sqlite recognizes for this; the lowercase `readonly` is silently
 * ignored and opens read-write instead (the exact gotcha claim-ledger.js's own openClaimLedgerReadOnly already
 * documents), which would defeat the read-only guarantee this function's own docs claim.
 */
export function checkStoreIntegrity(name, dbPath) {
    if (!existsSync(dbPath)) {
        return { name, ok: true, detail: `${dbPath}: not created yet` };
    }
    let db;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const { ok, note } = classifyIntegrityRows(db.prepare("PRAGMA integrity_check").all());
        return { name, ok, detail: `${dbPath}: ${note}` };
    }
    catch (error) {
        return { name, ok: false, detail: `${dbPath}: ${describeError(error)}` };
    }
    finally {
        db?.close();
    }
}
/** Coerce an env value to a positive integer, or null (unset/blank/zero/negative/non-finite ⇒ null ⇒ disabled).
 *  Floors BEFORE the positivity test, so a fractional value below 1 (e.g. "0.5") floors to 0 and disables the
 *  bound rather than becoming a dangerous 0 that would prune the whole ledger. */
function positiveIntOrNull(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === "")
        return null;
    const numeric = Math.floor(Number(raw));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
/**
 * Resolve the opt-in ledger retention policy from an env object. OFF by default: returns null unless at least
 * one bound is set to a positive value. A zero/negative/non-numeric value is treated as unset. When set, returns
 * `{ maxAgeMs? }` (from a day count) and/or `{ maxRows? }`.
 */
export function resolveLedgerRetentionPolicy(env = process.env) {
    const maxAgeDays = positiveIntOrNull(env[LEDGER_RETENTION_DAYS_ENV]);
    const maxRows = positiveIntOrNull(env[LEDGER_RETENTION_MAX_ROWS_ENV]);
    if (maxAgeDays === null && maxRows === null)
        return null;
    const policy = {};
    if (maxAgeDays !== null)
        policy.maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (maxRows !== null)
        policy.maxRows = maxRows;
    return policy;
}
/**
 * Prune one append-only ledger per a resolved retention policy: delete rows older than the age bound AND rows
 * beyond the row-count bound (keeping the newest `maxRows` by `orderColumn`), atomically. A null policy is a
 * no-op. `nowMs` is caller-supplied (no internal clock). Timestamp columns are UTC ISO-8601 strings, which sort
 * lexicographically in chronological order, so a string comparison against the ISO cutoff selects older rows.
 */
export function pruneLedgerByRetention(db, spec, policy, nowMs) {
    if (!policy)
        return 0;
    for (const identifier of [spec.table, spec.timestampColumn, spec.orderColumn]) {
        if (!SQL_IDENTIFIER.test(identifier))
            throw new Error(`unsafe SQL identifier: ${identifier}`);
    }
    let deleted = 0;
    db.exec("BEGIN");
    try {
        // Both bounds are guarded to be strictly positive as defence in depth: a 0 age would prune everything older
        // than `now`, and a 0 row-cap makes `LIMIT 0` match no rows so `NOT IN (empty)` would delete the whole ledger.
        if (policy.maxAgeMs !== undefined && policy.maxAgeMs > 0) {
            const cutoff = new Date(nowMs - policy.maxAgeMs).toISOString();
            const info = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.timestampColumn} < ?`).run(cutoff);
            deleted += Number(info.changes);
        }
        if (policy.maxRows !== undefined && policy.maxRows >= 1) {
            const info = db
                .prepare(`DELETE FROM ${spec.table} WHERE ${spec.orderColumn} NOT IN ` +
                `(SELECT ${spec.orderColumn} FROM ${spec.table} ORDER BY ${spec.orderColumn} DESC LIMIT ?)`)
                .run(policy.maxRows);
            deleted += Number(info.changes);
        }
        db.exec("COMMIT");
    }
    catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
    return deleted;
}
/**
 * Delete every row for one repo from a store (#5564). Unlike `pruneLedgerByRetention`, this never runs
 * automatically — it exists solely so `purge-cli.js` can give an operator a real right-to-be-forgotten path.
 * `repoFullName` is caller-normalized (owner/repo) before reaching here; this function only guards the SQL
 * identifiers, matching `pruneLedgerByRetention`'s own defence-in-depth discipline.
 */
export function purgeStoreByRepo(db, spec, repoFullName) {
    for (const identifier of [spec.table, spec.repoColumn]) {
        if (!SQL_IDENTIFIER.test(identifier))
            throw new Error(`unsafe SQL identifier: ${identifier}`);
    }
    const info = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.repoColumn} = ?`).run(repoFullName);
    return Number(info.changes);
}
/**
 * Count rows for one repo in a store without deleting anything (#5564) — the read-only counterpart to
 * `purgeStoreByRepo`, used by `purge-cli.js --dry-run` to report what a real purge would remove.
 */
export function countStoreByRepo(db, spec, repoFullName) {
    for (const identifier of [spec.table, spec.repoColumn]) {
        if (!SQL_IDENTIFIER.test(identifier))
            throw new Error(`unsafe SQL identifier: ${identifier}`);
    }
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE ${spec.repoColumn} = ?`).get(repoFullName);
    return Number(row?.count);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmUtbWFpbnRlbmFuY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzdG9yZS1tYWludGVuYW5jZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSx5R0FBeUc7QUFDekcsRUFBRTtBQUNGLGtHQUFrRztBQUNsRywrR0FBK0c7QUFDL0csb0ZBQW9GO0FBQ3BGLDJHQUEyRztBQUMzRyxpSEFBaUg7QUFDakgsaUZBQWlGO0FBQ2pGLDhHQUE4RztBQUM5RywwR0FBMEc7QUFDMUcsK0ZBQStGO0FBQy9GLGlIQUFpSDtBQUNqSCx3RkFBd0Y7QUFDeEYsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNyQyxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzNDLE9BQU8sRUFBRSxnQ0FBZ0MsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBRTdFLHFFQUFxRTtBQUNyRSxNQUFNLENBQUMsTUFBTSx5QkFBeUIsR0FBRyxzQ0FBc0MsQ0FBQztBQUNoRixNQUFNLENBQUMsTUFBTSw2QkFBNkIsR0FBRywwQ0FBMEMsQ0FBQztBQUl4RjswR0FDMEc7QUFDMUcsTUFBTSxDQUFDLE1BQU0sMkJBQTJCLEdBQXdCLEVBQUUsS0FBSyxFQUFFLG9CQUFvQixFQUFFLGVBQWUsRUFBRSxZQUFZLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRSxDQUFDO0FBQ2xKLE1BQU0sQ0FBQyxNQUFNLDhCQUE4QixHQUF3QixFQUFFLEtBQUssRUFBRSxpQkFBaUIsRUFBRSxlQUFlLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRSxJQUFJLEVBQUUsQ0FBQztBQUMxSSxNQUFNLENBQUMsTUFBTSxnQ0FBZ0MsR0FBd0IsRUFBRSxLQUFLLEVBQUUsYUFBYSxFQUFFLGVBQWUsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFLElBQUksRUFBRSxDQUFDO0FBSXhJOzs7K0dBRytHO0FBQy9HLE1BQU0sQ0FBQyxNQUFNLHVCQUF1QixHQUFvQixFQUFFLEtBQUss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