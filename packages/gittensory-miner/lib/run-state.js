import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RUN_STATES = Object.freeze(["idle", "discovering", "planning", "preparing"]);

const runStateSet = new Set(RUN_STATES);
const defaultDbFileName = "run-state.sqlite3";
let defaultRunStateStore = null;

export function resolveRunStateDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_RUN_STATE_DB === "string"
    ? env.GITTENSORY_MINER_RUN_STATE_DB.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolveRunStateDbPath()).trim();
  if (!path) throw new Error("invalid_run_state_db_path");
  return path;
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
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
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

export function closeDefaultRunStateStore() {
  if (!defaultRunStateStore) return;
  defaultRunStateStore.close();
  defaultRunStateStore = null;
}
