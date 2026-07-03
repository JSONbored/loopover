import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

// The miner's local, append-only event ledger (#2290): an immutable audit trail of every significant miner-loop
// event (discovered_issue, plan_built, plan_step_completed, pr_prepared, … — a small fixed vocabulary for this
// foundation phase that grows in later phases), each stamped with a module-maintained monotonic `seq` and a
// timestamp. IMMUTABILITY INVARIANT: this module only ever issues INSERT and SELECT — it NEVER rewrites or removes
// a row, so a contributor auditing the miner's history later can trust it was not retroactively edited. Keep it
// that way: do not add any statement that mutates or removes an existing row. The database is 100% local; this
// module never uploads, syncs, or phones home with its contents. Mirrors the local-store pattern of run-state.js.

const defaultDbFileName = "event-ledger.sqlite3";
let defaultEventLedger = null;

export function resolveEventLedgerDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_EVENT_LEDGER_DB === "string"
    ? env.GITTENSORY_MINER_EVENT_LEDGER_DB.trim()
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
  const path = (dbPath ?? resolveEventLedgerDbPath()).trim();
  if (!path) throw new Error("invalid_event_ledger_db_path");
  return path;
}

function normalizeEventType(type) {
  if (typeof type !== "string") throw new Error("invalid_event_type");
  const trimmed = type.trim();
  if (!trimmed) throw new Error("invalid_event_type");
  return trimmed;
}

/** Optional repo scope: omitted/nullish → null; otherwise a validated `owner/repo`. */
function normalizeOptionalRepoFullName(repoFullName) {
  if (repoFullName === undefined || repoFullName === null) return null;
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
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
  } catch {
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

/**
 * Opens the local append-only event ledger, creating the table on first use. `seq` is a monotonically increasing
 * counter maintained by this module (next = current MAX(seq) + 1) rather than relying on `AUTOINCREMENT`'s
 * reuse-after-vacuum behavior, so consumers get a stable ordering guarantee. Rows read back in `seq ASC` order.
 * (#2290)
 */
export function initEventLedger(dbPath = resolveEventLedgerDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  // Wait (rather than fail) for a concurrent writer's lock so two ledger instances on the same file serialize.
  db.exec("PRAGMA busy_timeout = 5000");
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

  const nextSeqStatement = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM miner_event_ledger");
  const appendStatement = db.prepare(`
    INSERT INTO miner_event_ledger (seq, event_type, repo_full_name, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getByIdStatement = db.prepare("SELECT * FROM miner_event_ledger WHERE id = ?");
  const readAllStatement = db.prepare("SELECT * FROM miner_event_ledger ORDER BY seq ASC");
  const readByRepoStatement = db.prepare(
    "SELECT * FROM miner_event_ledger WHERE repo_full_name = ? ORDER BY seq ASC",
  );
  const readSinceStatement = db.prepare(
    "SELECT * FROM miner_event_ledger WHERE seq > ? ORDER BY seq ASC",
  );
  const readByRepoSinceStatement = db.prepare(
    "SELECT * FROM miner_event_ledger WHERE repo_full_name = ? AND seq > ? ORDER BY seq ASC",
  );

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
      // `since` returns events with a seq STRICTLY greater than it — the "give me everything after the last seq I
      // saw" polling shape.
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
  if (!defaultEventLedger) return;
  defaultEventLedger.close();
  defaultEventLedger = null;
}
