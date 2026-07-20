import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { normalizeGovernorLedgerEvent } from "@loopover/engine";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import {
  GOVERNOR_LEDGER_PURGE_SPEC,
  GOVERNOR_LEDGER_RETENTION_SPEC,
  purgeStoreByRepo,
  pruneLedgerByRetention,
  resolveLedgerRetentionPolicy,
} from "./store-maintenance.js";

// Append-only governor decision ledger (#2328): every allowed/denied/throttled/kill-switch outcome lands in a
// local SQLite table for contributor audit. IMMUTABILITY INVARIANT: `appendGovernorEvent`/`readGovernorEvents`
// only ever issue INSERT and SELECT — never UPDATE/DELETE. Two documented exceptions, both separate maintenance
// operations rather than part of normal ledger operation: opt-in retention pruning (#4834, automatic) and
// `purgeByRepo` (#5564, always explicit and operator-invoked, never automatic).
// This module does not enforce governor policy; it only persists structured events other phases will emit.

export type GovernorLedgerEntry = {
  id: number;
  ts: string;
  eventType: string;
  repoFullName: string | null;
  actionClass: string;
  decision: string;
  reason: string;
  payload: Record<string, unknown>;
};

export type AppendGovernorEventInput = {
  eventType: string;
  repoFullName?: string | null;
  actionClass: string;
  decision: string;
  reason: string;
  payload?: Record<string, unknown>;
};

export type ReadGovernorEventsFilter = {
  repoFullName?: string | null;
};

/** The public decision-log projection (#5159): every {@link GovernorLedgerEntry} field EXCEPT `payload`. */
export type GovernorDecisionEntry = Omit<GovernorLedgerEntry, "payload">;

export type GovernorLedger = {
  dbPath: string;
  appendGovernorEvent(event: AppendGovernorEventInput): GovernorLedgerEntry;
  readGovernorEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[];
  /** Read-only decision-log projection; excludes `payload` by construction (explicit named-column SELECT). */
  readGovernorDecisions(filter?: ReadGovernorEventsFilter): GovernorDecisionEntry[];
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

/** Private shape of a `governor_events` SELECT * row after casting off `Record<string, SQLOutputValue>`. */
type GovernorDbRow = {
  id: number;
  ts: string;
  event_type: string;
  repo_full_name: string | null;
  action_class: string;
  decision: string;
  reason: string;
  payload_json: string;
};

const defaultDbFileName = "governor-ledger.sqlite3";
let defaultGovernorLedger: GovernorLedger | null = null;

export function resolveGovernorLedgerDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_GOVERNOR_LEDGER_DB", env);
}

function normalizeDbPath(dbPath: string): string {
  return normalizeLocalStoreDbPath(dbPath, resolveGovernorLedgerDbPath(), "invalid_governor_ledger_db_path");
}

function normalizeOptionalRepoFullName(repoFullName: string | null | undefined): string | undefined {
  if (repoFullName === undefined || repoFullName === null) return undefined;
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function rowToEntry(row: GovernorDbRow): GovernorLedgerEntry {
  let payload: unknown;
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
    payload: payload as Record<string, unknown>,
  };
}

// Decision-log projection (#5159): the public, MCP-exposed shape. Deliberately omits payload_json (which #5134
// is expanding with reputation/self-plagiarism/budget state). Kept honest by an explicit named-column SELECT
// below — never SELECT * — so the sensitive column cannot leak even by accident.
function rowToDecision(row: GovernorDbRow): GovernorDecisionEntry {
  return {
    id: row.id,
    ts: row.ts,
    eventType: row.event_type,
    repoFullName: row.repo_full_name,
    actionClass: row.action_class,
    decision: row.decision,
    reason: row.reason,
  };
}

// v1 -> v2 (#4939/#6597): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of
// this same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing
// reads or writes it yet. Same defensive column-presence guard as this file's sibling stores' own additive
// migrations (e.g. event-ledger.js's addTenantIdColumn).
function addTenantIdColumn(db: DatabaseSync): void {
  const hasTenantIdColumn = db
    .prepare("PRAGMA table_info(governor_events)")
    .all()
    .some((column) => column.name === "tenant_id");
  if (!hasTenantIdColumn) db.exec("ALTER TABLE governor_events ADD COLUMN tenant_id TEXT");
}

function asGovernorDbRow(row: Record<string, SQLOutputValue>): GovernorDbRow {
  return row as unknown as GovernorDbRow;
}

/**
 * Opens the append-only governor ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#2328)
 */
export function initGovernorLedger(dbPath: string = resolveGovernorLedgerDbPath()): GovernorLedger {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
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
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
  applySchemaMigrations(db, [addTenantIdColumn]);
  // Opt-in retention (#4834): prune aged/excess rows when an operator has enabled it; a no-op by default.
  pruneLedgerByRetention(db, GOVERNOR_LEDGER_RETENTION_SPEC, resolveLedgerRetentionPolicy(), Date.now());

  const appendStatement = db.prepare(`
    INSERT INTO governor_events (ts, event_type, repo_full_name, action_class, decision, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getByIdStatement = db.prepare("SELECT * FROM governor_events WHERE id = ?");
  const readAllStatement = db.prepare("SELECT * FROM governor_events ORDER BY id ASC");
  const readByRepoStatement = db.prepare(
    "SELECT * FROM governor_events WHERE repo_full_name = ? ORDER BY id ASC",
  );
  // Explicit named-column projection for the read-only decision log (#5159) — payload_json is intentionally
  // NOT in this list, so widening it would be a deliberate edit that the redaction test guards against.
  const decisionColumns = "id, ts, event_type, repo_full_name, action_class, decision, reason";
  const readDecisionsAllStatement = db.prepare(
    `SELECT ${decisionColumns} FROM governor_events ORDER BY id ASC`,
  );
  const readDecisionsByRepoStatement = db.prepare(
    `SELECT ${decisionColumns} FROM governor_events WHERE repo_full_name = ? ORDER BY id ASC`,
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
      return rowToEntry(asGovernorDbRow(getByIdStatement.get(Number(result.lastInsertRowid))!));
    },
    readGovernorEvents(filter = {}) {
      const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
      const rows =
        repoFullName === undefined
          ? readAllStatement.all()
          : readByRepoStatement.all(repoFullName);
      return rows.map((row) => rowToEntry(asGovernorDbRow(row)));
    },
    readGovernorDecisions(filter = {}) {
      const repoFullName = normalizeOptionalRepoFullName(filter.repoFullName);
      const rows =
        repoFullName === undefined
          ? readDecisionsAllStatement.all()
          : readDecisionsByRepoStatement.all(repoFullName);
      return rows.map((row) => rowToDecision(asGovernorDbRow(row)));
    },
    // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. See the
    // IMMUTABILITY INVARIANT note above: this is a deliberate, separate exception, not a normal ledger write.
    // Requires a real repoFullName (unlike the optional filters above): a purge must never silently no-op.
    purgeByRepo(repoFullName) {
      const normalized = normalizeOptionalRepoFullName(repoFullName);
      if (normalized === undefined) throw new Error("invalid_repo_full_name");
      return purgeStoreByRepo(db, GOVERNOR_LEDGER_PURGE_SPEC, normalized);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultGovernorLedger(): GovernorLedger {
  defaultGovernorLedger ??= initGovernorLedger();
  return defaultGovernorLedger;
}

export function appendGovernorEvent(event: AppendGovernorEventInput): GovernorLedgerEntry {
  return getDefaultGovernorLedger().appendGovernorEvent(event);
}

export function readGovernorEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[] {
  return getDefaultGovernorLedger().readGovernorEvents(filter);
}

export function closeDefaultGovernorLedger(): void {
  if (!defaultGovernorLedger) return;
  defaultGovernorLedger.close();
  defaultGovernorLedger = null;
}
