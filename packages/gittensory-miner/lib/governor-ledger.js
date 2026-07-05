import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeGovernorLedgerEvent } from "@jsonbored/gittensory-engine";

// Append-only governor decision ledger (#2328): every allowed/denied/throttled/kill-switch outcome lands in a
// local SQLite table for contributor audit. IMMUTABILITY INVARIANT: INSERT + SELECT only — never UPDATE/DELETE.
// This module does not enforce governor policy; it only persists structured events other phases will emit.

const defaultDbFileName = "governor-ledger.sqlite3";
let defaultGovernorLedger = null;

export function resolveGovernorLedgerDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_GOVERNOR_LEDGER_DB === "string"
    ? env.GITTENSORY_MINER_GOVERNOR_LEDGER_DB.trim()
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
  const path = (dbPath ?? resolveGovernorLedgerDbPath()).trim();
  if (!path) throw new Error("invalid_governor_ledger_db_path");
  return path;
}

function normalizeOptionalRepoFullName(repoFullName) {
  if (repoFullName === undefined || repoFullName === null) return undefined;
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function rowToEntry(row) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("corrupted_governor_row");
    }
  } catch {
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
    payload,
  };
}

/**
 * Opens the append-only governor ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#2328)
 */
export function initGovernorLedger(dbPath = resolveGovernorLedgerDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
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

  const appendStatement = db.prepare(`
    INSERT INTO governor_events (ts, event_type, repo_full_name, action_class, decision, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getByIdStatement = db.prepare("SELECT * FROM governor_events WHERE id = ?");
  const readAllStatement = db.prepare("SELECT * FROM governor_events ORDER BY id ASC");
  const readByRepoStatement = db.prepare(
    "SELECT * FROM governor_events WHERE repo_full_name = ? ORDER BY id ASC",
  );

  return {
    dbPath: resolvedPath,
    appendGovernorEvent(event) {
      const normalized = normalizeGovernorLedgerEvent(event);
      const ts = new Date().toISOString();
      const result = appendStatement.run(
        ts,
        normalized.eventType,
        normalized.repoFullName,
        normalized.actionClass,
        normalized.decision,
        normalized.reason,
        normalized.payloadJson,
      );
      return rowToEntry(getByIdStatement.get(Number(result.lastInsertRowid)));
    },
    readGovernorEvents(filter = {}) {
      const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
      const rows =
        repoFullName === undefined
          ? readAllStatement.all()
          : readByRepoStatement.all(repoFullName);
      return rows.map(rowToEntry);
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
  if (!defaultGovernorLedger) return;
  defaultGovernorLedger.close();
  defaultGovernorLedger = null;
}
