import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreAdapter, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { RUN_STATE_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";
export const RUN_STATES = Object.freeze([
    "idle",
    "discovering",
    "planning",
    "preparing",
]);
const runStateSet = new Set(RUN_STATES);
const defaultDbFileName = "run-state.sqlite3";
let defaultRunStateStore = null;
function isRunState(value) {
    return runStateSet.has(value);
}
export function resolveRunStateDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_RUN_STATE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveRunStateDbPath(), "invalid_run_state_db_path");
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const trimmed = repoFullName.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeRunState(state) {
    if (runStateSet.has(state))
        return state;
    throw new Error("invalid_run_state");
}
/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
    if (apiBaseUrl === undefined || apiBaseUrl === null)
        return DEFAULT_FORGE_CONFIG.apiBaseUrl;
    if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim())
        throw new Error("invalid_api_base_url");
    return apiBaseUrl.trim();
}
// v1 -> v2 (#5563): rebuild the bare `repo_full_name` PRIMARY KEY into a (api_base_url, repo_full_name) composite
// -- two forge hosts serving a same-named owner/repo must not share one "current state" row. SQLite cannot ALTER
// a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy every existing row with the
// pre-#4784 implicit single-forge default backfilled, drop the old table, rename the new one in.
function addApiBaseUrlScope(db) {
    db.exec(`
    CREATE TABLE miner_run_state_v2 (
      api_base_url TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('idle', 'discovering', 'planning', 'preparing')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_base_url, repo_full_name)
    )
  `);
    // OR IGNORE: a row this store's own read path already treats as unusable garbage (an unrecognized `state`,
    // e.g. from a hand-edited or otherwise corrupted file -- getRunState/listRunStates fail closed on it too)
    // would violate the CHECK constraint above and abort the whole migration. Skipping it here is consistent with
    // that same fail-closed posture, rather than turning one bad row into a permanently unmigratable file.
    db.prepare(`INSERT OR IGNORE INTO miner_run_state_v2 (api_base_url, repo_full_name, state, updated_at)
     SELECT ?, repo_full_name, state, updated_at FROM miner_run_state`).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
    db.exec("DROP TABLE miner_run_state");
    db.exec("ALTER TABLE miner_run_state_v2 RENAME TO miner_run_state");
}
// v2 -> v3 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
// same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads or
// writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
// column-presence guard as every other additive migration in this file's siblings (e.g.
// portfolio-queue.js's v3->v4 attempts_count addition).
function addTenantIdColumn(db) {
    const hasTenantIdColumn = db
        .prepare("PRAGMA table_info(miner_run_state)")
        .all()
        .some((column) => column.name === "tenant_id");
    if (!hasTenantIdColumn)
        db.exec("ALTER TABLE miner_run_state ADD COLUMN tenant_id TEXT");
}
/**
 * Opens the 100% local/client-side miner run-state store. The database only lives on this machine;
 * this module never uploads, syncs, or phones home with its contents. (#2289, #5563)
 *
 * Opened through the #7175 SqliteDriver seam (`openLocalStoreAdapter`): CRUD goes through `driver.query`,
 * while schema migrations / purge still use the underlying DatabaseSync until those helpers are migrated.
 * Public API stays synchronous so loop/CLI/MCP callers need no async cascade in this part-1 slice.
 */
export function initRunStateStore(dbPath = resolveRunStateDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const { db, driver } = openLocalStoreAdapter(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS miner_run_state (
      repo_full_name TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('idle', 'discovering', 'planning', 'preparing')),
      updated_at TEXT NOT NULL
    )
  `);
    // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
    applySchemaMigrations(db, [addApiBaseUrlScope, addTenantIdColumn]);
    const getSql = "SELECT state FROM miner_run_state WHERE api_base_url = ? AND repo_full_name = ?";
    const setSql = `
    INSERT INTO miner_run_state (api_base_url, repo_full_name, state, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(api_base_url, repo_full_name) DO UPDATE SET
      state = excluded.state,
      updated_at = excluded.updated_at
  `;
    const listSql = "SELECT api_base_url, repo_full_name, state, updated_at FROM miner_run_state ORDER BY repo_full_name";
    return {
        dbPath: resolvedPath,
        getRunState(repoFullName, apiBaseUrl) {
            const { rows } = driver.query(getSql, [
                normalizeApiBaseUrl(apiBaseUrl),
                normalizeRepoFullName(repoFullName),
            ]);
            const row = rows[0];
            const state = row?.state;
            return isRunState(state) ? state : null;
        },
        setRunState(repoFullName, state, apiBaseUrl) {
            const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
            const normalizedRepo = normalizeRepoFullName(repoFullName);
            const normalizedState = normalizeRunState(state);
            const updatedAt = new Date().toISOString();
            driver.query(setSql, [normalizedForge, normalizedRepo, normalizedState, updatedAt]);
            return { apiBaseUrl: normalizedForge, repoFullName: normalizedRepo, state: normalizedState, updatedAt };
        },
        /** Every repo with a recorded run state, across the whole store — the per-repo discover/plan/prepare
         *  signal a "run portfolio" view folds alongside managed PR rows (#4279). */
        listRunStates() {
            const { rows } = driver.query(listSql, []);
            return rows
                .filter((row) => isRunState(row.state))
                .map((row) => ({
                apiBaseUrl: row.api_base_url,
                repoFullName: row.repo_full_name,
                state: row.state,
                updatedAt: row.updated_at,
            }));
        },
        // Explicit, operator-invoked right-to-be-forgotten purge (#5564, #6599) — never runs automatically.
        purgeByRepo(repoFullName) {
            return purgeStoreByRepo(db, RUN_STATE_PURGE_SPEC, normalizeRepoFullName(repoFullName));
        },
        close() {
            db.close();
        },
    };
}
function getDefaultRunStateStore() {
    defaultRunStateStore ??= initRunStateStore();
    return defaultRunStateStore;
}
export function getRunState(repoFullName, apiBaseUrl) {
    return getDefaultRunStateStore().getRunState(repoFullName, apiBaseUrl);
}
export function setRunState(repoFullName, state, apiBaseUrl) {
    return getDefaultRunStateStore().setRunState(repoFullName, state, apiBaseUrl);
}
export function listRunStates() {
    return getDefaultRunStateStore().listRunStates();
}
export function closeDefaultRunStateStore() {
    if (!defaultRunStateStore)
        return;
    defaultRunStateStore.close();
    defaultRunStateStore = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnVuLXN0YXRlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicnVuLXN0YXRlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ3pELE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxxQkFBcUIsRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQzdHLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQzVELE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBMkJoRixNQUFNLENBQUMsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUN0QyxNQUFNO0lBQ04sYUFBYTtJQUNiLFVBQVU7SUFDVixXQUFXO0NBQ1osQ0FBd0IsQ0FBQztBQUUxQixNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsQ0FBUyxVQUFVLENBQUMsQ0FBQztBQUNoRCxNQUFNLGlCQUFpQixHQUFHLG1CQUFtQixDQUFDO0FBQzlDLElBQUksb0JBQW9CLEdBQXlCLElBQUksQ0FBQztBQUV0RCxTQUFTLFVBQVUsQ0FBQyxLQUFjO0lBQ2hDLE9BQU8sV0FBVyxDQUFDLEdBQUcsQ0FBQyxLQUFlLENBQUMsQ0FBQztBQUMxQyxDQUFDO0FBRUQsTUFBTSxVQUFVLHFCQUFxQixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQ3pGLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsNkJBQTZCLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDeEYsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUscUJBQXFCLEVBQUUsRUFBRSwyQkFBMkIsQ0FBQyxDQUFDO0FBQ2pHLENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFDLFlBQW9CO0lBQ2pELElBQUksT0FBTyxZQUFZ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