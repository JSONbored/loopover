import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

const defaultDbFileName = "governor-ledger.sqlite3";
let defaultGovernorLedger = null;

export function resolveGovernorLedgerDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_GOVERNOR_LEDGER_DB === "string"
    ? env.GITTENSORY_MINER_GOVERNOR_LEDGER_DB.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    && env.GITTENSORY_MINER_CONFIG_DIR.trim()
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

const GOVERNOR_EVENT_TYPES = Object.freeze([
  "allowed",
  "denied",
  "throttled",
  "kill_switch_tripped",
]);

function normalizeEventType(type) {
  if (typeof type !== "string") throw new Error("invalid_governor_event_type");
  const trimmed = type.trim();
  if (!trimmed) throw new Error("invalid_governor_event_type");
  if (!GOVERNOR_EVENT_TYPES.includes(trimmed)) throw new Error("invalid_governor_event_type");
  return trimmed;
}

function normalizeDecision(decision) {
  if (decision === undefined || decision === null) return null;
  if (typeof decision !== "string") throw new Error("invalid_decision");
  const trimmed = decision.trim();
  if (!trimmed) throw new Error("invalid_decision");
  if (!GOVERNOR_EVENT_TYPES.includes(trimmed)) throw new Error("invalid_decision");
  return trimmed;
}

function normalizeOptionalString(field) {
  if (field === undefined || field === null) return null;
  if (typeof field !== "string") throw new Error("invalid_string_field");
  const trimmed = field.trim();
  return trimmed || null;
}

function normalizeOptionalRepoFullName(repoFullName) {
  if (repoFullName === undefined || repoFullName === null) return null;
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function serializePayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_payload");
  }
  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new Error("invalid_payload");
  }
  if (!isDeepStrictEqual(JSON.parse(json), payload)) {
    throw new Error("invalid_payload");
  }
  return json;
}

function rowToEntry(row) {
  return {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    type: row.event_type,
    repoFullName: row.repo_full_name,
    actionClass: row.action_class,
    decision: row.decision,
    reason: row.reason,
    payload: JSON.parse(row.payload_json),
  };
}

export function initGovernorLedger(dbPath = resolveGovernorLedgerDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS governor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      repo_full_name TEXT,
      action_class TEXT,
      decision TEXT,
      reason TEXT,
      payload_json TEXT NOT NULL
    )
  `);

  const nextSeqStatement = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM governor_events");
  const appendStatement = db.prepare(`
    INSERT INTO governor_events (seq, ts, event_type, repo_full_name, action_class, decision, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getByIdStatement = db.prepare("SELECT * FROM governor_events WHERE id = ?");
  const readAllStatement = db.prepare("SELECT * FROM governor_events ORDER BY seq ASC");
  const readByRepoStatement = db.prepare(
    "SELECT * FROM governor_events WHERE repo_full_name = ? ORDER BY seq ASC",
  );
  const readSinceStatement = db.prepare(
    "SELECT * FROM governor_events WHERE seq > ? ORDER BY seq ASC",
  );
  const readByRepoSinceStatement = db.prepare(
    "SELECT * FROM governor_events WHERE repo_full_name = ? AND seq > ? ORDER BY seq ASC",
  );

  return {
    dbPath: resolvedPath,
    appendEvent(event) {
      const type = normalizeEventType(event?.type);
      const repoFullName = normalizeOptionalRepoFullName(event?.repoFullName);
      const actionClass = normalizeOptionalString(event?.actionClass);
      const decision = normalizeDecision(event?.decision);
      const reason = normalizeOptionalString(event?.reason);
      const payloadJson = serializePayload(event?.payload);
      const ts = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        const { nextSeq } = nextSeqStatement.get();
        const result = appendStatement.run(nextSeq, ts, type, repoFullName, actionClass, decision, reason, payloadJson);
        const entry = rowToEntry(getByIdStatement.get(Number(result.lastInsertRowid)));
        db.exec("COMMIT");
        return entry;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    readEvents(filter = {}) {
      const repoFullName = filter.repoFullName === undefined
        ? undefined
        : normalizeOptionalRepoFullName(filter.repoFullName);
      const since = typeof filter.since === "number" ? filter.since : undefined;

      let rows;
      if (repoFullName !== undefined && since !== undefined) {
        rows = readByRepoSinceStatement.all(repoFullName, since);
      } else if (repoFullName !== undefined) {
        rows = readByRepoStatement.all(repoFullName);
      } else if (since !== undefined) {
        rows = readSinceStatement.all(since);
      } else {
        rows = readAllStatement.all();
      }
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

export function appendEvent(event) {
  return getDefaultGovernorLedger().appendEvent(event);
}

export function readEvents(filter) {
  return getDefaultGovernorLedger().readEvents(filter);
}

export function closeDefaultGovernorLedger() {
  if (!defaultGovernorLedger) return;
  defaultGovernorLedger.close();
  defaultGovernorLedger = null;
}