import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";

export const RUN_STATES = Object.freeze(["idle", "discovering", "planning", "preparing"]);

const runStateSet = new Set(RUN_STATES);
const defaultDbFileName = "run-state.sqlite3";
let defaultRunStateStore = null;

export function resolveRunStateDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "GITTENSORY_MINER_RUN_STATE_DB", env);
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

/**
 * Opens the 100% local/client-side miner run-state store. The database only lives on this machine;
 * this module never uploads, syncs, or phones home with its contents. (#2289)
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

  const getStatement = db.prepare(
    "SELECT state FROM miner_run_state WHERE repo_full_name = ?",
  );
  const setStatement = db.prepare(`
    INSERT INTO miner_run_state (repo_full_name, state, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(repo_full_name) DO UPDATE SET
      state = excluded.state,
      updated_at = excluded.updated_at
  `);
  const listStatement = db.prepare(
    "SELECT repo_full_name, state, updated_at FROM miner_run_state ORDER BY repo_full_name",
  );

  return {
    dbPath: resolvedPath,
    getRunState(repoFullName) {
      const row = getStatement.get(normalizeRepoFullName(repoFullName));
      return runStateSet.has(row?.state) ? row.state : null;
    },
    setRunState(repoFullName, state) {
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const normalizedState = normalizeRunState(state);
      const updatedAt = new Date().toISOString();
      setStatement.run(normalizedRepo, normalizedState, updatedAt);
      return { repoFullName: normalizedRepo, state: normalizedState, updatedAt };
    },
    /** Every repo with a recorded run state, across the whole store — the per-repo discover/plan/prepare
     *  signal a "run portfolio" view folds alongside managed PR rows (#4279). */
    listRunStates() {
      return listStatement.all()
        .filter((row) => runStateSet.has(row.state))
        .map((row) => ({ repoFullName: row.repo_full_name, state: row.state, updatedAt: row.updated_at }));
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

export function getRunState(repoFullName) {
  return getDefaultRunStateStore().getRunState(repoFullName);
}

export function setRunState(repoFullName, state) {
  return getDefaultRunStateStore().setRunState(repoFullName, state);
}

export function listRunStates() {
  return getDefaultRunStateStore().listRunStates();
}

export function closeDefaultRunStateStore() {
  if (!defaultRunStateStore) return;
  defaultRunStateStore.close();
  defaultRunStateStore = null;
}
