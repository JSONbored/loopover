import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";

export const RUN_STATES = Object.freeze(["idle", "discovering", "planning", "preparing"]);

const runStateSet = new Set(RUN_STATES);
const defaultDbFileName = "run-state.sqlite3";
let defaultRunStateStore = null;

export function resolveRunStateDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_RUN_STATE_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolveRunStateDbPath(), "invalid_run_state_db_path");
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const trimmed = repoFullName.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeRunState(state) {
  if (runStateSet.has(state)) return state;
  throw new Error("invalid_run_state");
}

/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
  if (apiBaseUrl === undefined || apiBaseUrl === null) return DEFAULT_FORGE_CONFIG.apiBaseUrl;
  if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim()) throw new Error("invalid_api_base_url");
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
  db.prepare(
    `INSERT OR IGNORE INTO miner_run_state_v2 (api_base_url, repo_full_name, state, updated_at)
     SELECT ?, repo_full_name, state, updated_at FROM miner_run_state`,
  ).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
  db.exec("DROP TABLE miner_run_state");
  db.exec("ALTER TABLE miner_run_state_v2 RENAME TO miner_run_state");
}

/**
 * Opens the 100% local/client-side miner run-state store. The database only lives on this machine;
 * this module never uploads, syncs, or phones home with its contents. (#2289, #5563)
 */
export function initRunStateStore(dbPath = resolveRunStateDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS miner_run_state (
      repo_full_name TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('idle', 'discovering', 'planning', 'preparing')),
      updated_at TEXT NOT NULL
    )
  `);
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
  applySchemaMigrations(db, [addApiBaseUrlScope]);

  const getStatement = db.prepare(
    "SELECT state FROM miner_run_state WHERE api_base_url = ? AND repo_full_name = ?",
  );
  const setStatement = db.prepare(`
    INSERT INTO miner_run_state (api_base_url, repo_full_name, state, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(api_base_url, repo_full_name) DO UPDATE SET
      state = excluded.state,
      updated_at = excluded.updated_at
  `);
  const listStatement = db.prepare(
    "SELECT api_base_url, repo_full_name, state, updated_at FROM miner_run_state ORDER BY repo_full_name",
  );

  return {
    dbPath: resolvedPath,
    getRunState(repoFullName, apiBaseUrl) {
      const row = getStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName));
      return runStateSet.has(row?.state) ? row.state : null;
    },
    setRunState(repoFullName, state, apiBaseUrl) {
      const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const normalizedState = normalizeRunState(state);
      const updatedAt = new Date().toISOString();
      setStatement.run(normalizedForge, normalizedRepo, normalizedState, updatedAt);
      return { apiBaseUrl: normalizedForge, repoFullName: normalizedRepo, state: normalizedState, updatedAt };
    },
    /** Every repo with a recorded run state, across the whole store — the per-repo discover/plan/prepare
     *  signal a "run portfolio" view folds alongside managed PR rows (#4279). */
    listRunStates() {
      return listStatement.all()
        .filter((row) => runStateSet.has(row.state))
        .map((row) => ({
          apiBaseUrl: row.api_base_url,
          repoFullName: row.repo_full_name,
          state: row.state,
          updatedAt: row.updated_at,
        }));
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
  if (!defaultRunStateStore) return;
  defaultRunStateStore.close();
  defaultRunStateStore = null;
}
