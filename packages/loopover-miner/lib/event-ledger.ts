import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import {
  EVENT_LEDGER_PURGE_SPEC,
  EVENT_LEDGER_RETENTION_SPEC,
  purgeStoreByRepo,
  pruneLedgerByRetention,
  resolveLedgerRetentionPolicy,
} from "./store-maintenance.js";

// The miner's local, append-only event ledger (#2290): an immutable audit trail of every significant miner-loop
// event (discovered_issue, plan_built, plan_step_completed, pr_prepared, … — a small fixed vocabulary for this
// foundation phase that grows in later phases), each stamped with a module-maintained monotonic `seq` and a
// timestamp. IMMUTABILITY INVARIANT: `appendEvent`/`readEvents` only ever issue INSERT and SELECT — they NEVER
// rewrite or remove a row, so a contributor auditing the miner's history later can trust it was not retroactively
// edited. Keep it that way: do not add mutation to the day-to-day append/read path. The two documented exceptions
// are opt-in retention pruning (#4834, automatic, age/size-bounded) and `purgeByRepo` (#5564, always explicit and
// operator-invoked, never automatic) — both are separate, clearly-labeled maintenance operations, not part of the
// ledger's normal operation. The database is 100% local; this module never uploads, syncs, or phones home with
// its contents. Mirrors the local-store pattern of run-state.js.

export type LedgerEntry = {
  id: number;
  seq: number;
  type: string;
  repoFullName: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AppendEventInput = {
  type: string;
  repoFullName?: string;
  payload: Record<string, unknown>;
};

export type ReadEventsFilter = {
  repoFullName?: string | null;
  since?: number | null;
};

export type EventLedger = {
  dbPath: string;
  appendEvent(event: AppendEventInput): LedgerEntry;
  readEvents(filter?: ReadEventsFilter): LedgerEntry[];
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

/** Private shape of a `miner_event_ledger` SELECT * row after casting off `Record<string, SQLOutputValue>`. */
type EventDbRow = {
  id: number;
  seq: number;
  event_type: string;
  repo_full_name: string | null;
  payload_json: string;
  created_at: string;
};

const defaultDbFileName = "event-ledger.sqlite3";
let defaultEventLedger: EventLedger | null = null;

export function resolveEventLedgerDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_EVENT_LEDGER_DB", env);
}

function normalizeDbPath(dbPath: string | null | undefined): string {
  return normalizeLocalStoreDbPath(dbPath, resolveEventLedgerDbPath(), "invalid_event_ledger_db_path");
}

function normalizeEventType(type: unknown): string {
  if (typeof type !== "string") throw new Error("invalid_event_type");
  const trimmed = type.trim();
  if (!trimmed) throw new Error("invalid_event_type");
  return trimmed;
}

/** Optional repo scope: omitted/nullish → null; otherwise a validated `owner/repo`. */
function normalizeOptionalRepoFullName(repoFullName: unknown): string | null {
  if (repoFullName === undefined || repoFullName === null) return null;
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

/** Optional seq cursor for polling: omitted → undefined; otherwise a non-negative integer last-seen seq. */
function normalizeOptionalSince(since: unknown): number | undefined {
  if (since === undefined || since === null) return undefined;
  if (typeof since !== "number" || !Number.isInteger(since) || since < 0) {
    throw new Error("invalid_since");
  }
  return since;
}

/** Read-filter repo scope: omitted/nullish → unscoped (all events); otherwise a validated `owner/repo`. */
function normalizeReadRepoFilter(repoFullName: unknown): string | null | undefined {
  if (repoFullName === undefined || repoFullName === null) return undefined;
  return normalizeOptionalRepoFullName(repoFullName);
}

// Serialize an audit payload, enforcing that it round-trips through JSON VERBATIM. A plain JSON.stringify would
// silently drop `undefined`/function/symbol values and coerce `NaN`/`Infinity` to `null` (and throw on BigInt or a
// cycle), so a read-back would not equal the appended event. We reject any such lossy payload outright — an audit
// ledger must return exactly what was recorded.
function serializePayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_payload");
  }
  let json: string;
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

function rowToEntry(row: EventDbRow): LedgerEntry {
  return {
    id: row.id,
    seq: row.seq,
    type: row.event_type,
    repoFullName: row.repo_full_name,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

function asEventDbRow(row: Record<string, SQLOutputValue>): EventDbRow {
  return row as unknown as EventDbRow;
}

// v1 -> v2 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
// same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads or
// writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
// column-presence guard as this file's sibling stores' own additive migrations (e.g. portfolio-queue.js's
// leased_at addition).
function addTenantIdColumn(db: DatabaseSync): void {
  const hasTenantIdColumn = db
    .prepare("PRAGMA table_info(miner_event_ledger)")
    .all()
    .some((column) => column.name === "tenant_id");
  if (!hasTenantIdColumn) db.exec("ALTER TABLE miner_event_ledger ADD COLUMN tenant_id TEXT");
}

/**
 * Opens the local append-only event ledger, creating the table on first use. `seq` is a monotonically increasing
 * counter maintained by this module (next = current MAX(seq) + 1) rather than relying on `AUTOINCREMENT`'s
 * reuse-after-vacuum behavior, so consumers get a stable ordering guarantee. Rows read back in `seq ASC` order.
 * (#2290)
 */
export function initEventLedger(dbPath: string = resolveEventLedgerDbPath()): EventLedger {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
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
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
  applySchemaMigrations(db, [addTenantIdColumn]);
  // Opt-in retention (#4834): prune aged/excess rows when an operator has enabled it; a no-op by default.
  pruneLedgerByRetention(db, EVENT_LEDGER_RETENTION_SPEC, resolveLedgerRetentionPolicy(), Date.now());

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
        const { nextSeq } = nextSeqStatement.get() as unknown as { nextSeq: number };
        const result = appendStatement.run(nextSeq, type, repoFullName, payloadJson, createdAt);
        const entry = rowToEntry(asEventDbRow(getByIdStatement.get(Number(result.lastInsertRowid))!));
        db.exec("COMMIT");
        return entry;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    readEvents(filter = {}) {
      const repoFullName = normalizeReadRepoFilter(filter.repoFullName);
      // `since` returns events with a seq STRICTLY greater than it — the "give me everything after the last seq I
      // saw" polling shape.
      const since = normalizeOptionalSince(filter.since);

      let rows: Record<string, SQLOutputValue>[];
      if (repoFullName !== undefined && since !== undefined) {
        rows = readByRepoSinceStatement.all(repoFullName, since);
      } else if (repoFullName !== undefined) {
        rows = readByRepoStatement.all(repoFullName);
      } else if (since !== undefined) {
        rows = readSinceStatement.all(since);
      } else {
        rows = readAllStatement.all();
      }
      return rows.map((row) => rowToEntry(asEventDbRow(row)));
    },
    // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. See the
    // IMMUTABILITY INVARIANT note above: this is a deliberate, separate exception, not a normal ledger write.
    // Requires a real repoFullName (unlike the optional filter above): a purge must never silently no-op on a
    // missing/blank argument.
    purgeByRepo(repoFullName) {
      const normalized = normalizeOptionalRepoFullName(repoFullName);
      if (normalized === null) throw new Error("invalid_repo_full_name");
      return purgeStoreByRepo(db, EVENT_LEDGER_PURGE_SPEC, normalized);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultEventLedger(): EventLedger {
  defaultEventLedger ??= initEventLedger();
  return defaultEventLedger;
}

export function appendEvent(event: AppendEventInput): LedgerEntry {
  return getDefaultEventLedger().appendEvent(event);
}

export function readEvents(filter?: ReadEventsFilter): LedgerEntry[] {
  return getDefaultEventLedger().readEvents(filter);
}

export function closeDefaultEventLedger(): void {
  if (!defaultEventLedger) return;
  defaultEventLedger.close();
  defaultEventLedger = null;
}
