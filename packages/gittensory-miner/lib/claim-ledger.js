import { DatabaseSync } from "node:sqlite";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { CLAIM_LEDGER_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";

// The miner's local soft-claim ledger (#2314): a 100% client-side record of "I'm working on issue #N in repo X",
// so Phase 2's soft-claim adjudication (sibling issues) has somewhere to persist claims. Schema + CRUD only — no
// adjudication logic, no network calls, no autonomous writes. The database only lives on this machine; this module
// never uploads, syncs, or phones home. Mirrors the package's existing local-store pattern (run-state.js,
// portfolio-queue.js, event-ledger.js) — plain JS + node:sqlite, not the hosted Worker's shared D1 `migrations/`.

export const CLAIM_STATUSES = Object.freeze(["active", "released", "expired"]);

const defaultDbFileName = "claim-ledger.sqlite3";
let defaultClaimLedger = null;

export function resolveClaimLedgerDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "GITTENSORY_MINER_CLAIM_LEDGER_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolveClaimLedgerDbPath(), "invalid_claim_ledger_db_path");
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeIssueNumber(issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("invalid_issue_number");
  return issueNumber;
}

/** Optional free-text note: omitted/nullish → null; a string is kept as-is; anything else is rejected. */
function normalizeNote(note) {
  if (note === undefined || note === null) return null;
  if (typeof note !== "string") throw new Error("invalid_note");
  return note;
}

function rowToClaim(row) {
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    issueNumber: row.issue_number,
    claimedAt: row.claimed_at,
    status: row.status,
    note: row.note,
  };
}

/**
 * Opens the local claim ledger, creating the table on first use. `UNIQUE(repo_full_name, issue_number)` keeps ONE
 * row per claimed issue, and `recordClaim` is a single atomic INSERT…ON CONFLICT statement (no read-then-write), so
 * concurrent claims cannot duplicate a row. (#2314)
 */
export function openClaimLedger(dbPath = resolveClaimLedgerDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  // LOCAL bookkeeping only: this table records which issues this miner instance has soft-claimed on this
  // machine. It does NOT adjudicate contested duplicates — sibling miners claiming the same issue are
  // resolved elsewhere via `isDuplicateClusterWinnerByClaim` from `@jsonbored/gittensory-engine` (#3355).
  db.exec(`
    CREATE TABLE IF NOT EXISTS miner_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      claimed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
      note TEXT,
      UNIQUE (repo_full_name, issue_number)
    )
  `);
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
  applySchemaMigrations(db, []);

  // Idempotent claim in ONE atomic statement: insert a new active claim, or — only if the existing row is NOT
  // already active — re-activate it (a released/expired claim can be re-claimed). The `WHERE status <> 'active'`
  // guard makes re-claiming an already-active issue a true no-op (no row churn), never a duplicate row.
  const recordStatement = db.prepare(`
    INSERT INTO miner_claims (repo_full_name, issue_number, claimed_at, status, note)
    VALUES (?, ?, ?, 'active', ?)
    ON CONFLICT(repo_full_name, issue_number) DO UPDATE SET
      claimed_at = excluded.claimed_at,
      note = excluded.note,
      status = 'active'
    WHERE miner_claims.status <> 'active'
  `);
  const getStatement = db.prepare(
    "SELECT * FROM miner_claims WHERE repo_full_name = ? AND issue_number = ?",
  );
  const releaseStatement = db.prepare(
    "UPDATE miner_claims SET status = 'released' WHERE repo_full_name = ? AND issue_number = ? AND status = 'active'",
  );
  const expireStatement = db.prepare(
    "UPDATE miner_claims SET status = 'expired' WHERE repo_full_name = ? AND issue_number = ? AND status = 'active'",
  );
  const listAllStatement = db.prepare("SELECT * FROM miner_claims ORDER BY id ASC");
  const listRepoStatement = db.prepare(
    "SELECT * FROM miner_claims WHERE repo_full_name = ? ORDER BY id ASC",
  );
  const listStatusStatement = db.prepare(
    "SELECT * FROM miner_claims WHERE status = ? ORDER BY id ASC",
  );
  const listRepoStatusStatement = db.prepare(
    "SELECT * FROM miner_claims WHERE repo_full_name = ? AND status = ? ORDER BY id ASC",
  );

  function normalizeListRepoFilter(repoFullName) {
    if (repoFullName === undefined || repoFullName === null) return undefined;
    return normalizeRepoFullName(repoFullName);
  }

  function normalizeStatusFilter(status) {
    if (status === undefined || status === null) return undefined;
    if (!CLAIM_STATUSES.includes(status)) throw new Error("invalid_status");
    return status;
  }

  const ledger = {
    dbPath: resolvedPath,
    recordClaim(claim) {
      const repoFullName = normalizeRepoFullName(claim?.repoFullName);
      const issueNumber = normalizeIssueNumber(claim?.issueNumber);
      const note = normalizeNote(claim?.note);
      const claimedAt = new Date().toISOString();
      recordStatement.run(repoFullName, issueNumber, claimedAt, note);
      return rowToClaim(getStatement.get(repoFullName, issueNumber));
    },
    releaseClaim(repoFullName, issueNumber) {
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const normalizedIssue = normalizeIssueNumber(issueNumber);
      const result = releaseStatement.run(normalizedRepo, normalizedIssue);
      if (result.changes === 0) return null;
      const row = getStatement.get(normalizedRepo, normalizedIssue);
      return row ? rowToClaim(row) : null;
    },
    expireClaim(repoFullName, issueNumber) {
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const normalizedIssue = normalizeIssueNumber(issueNumber);
      const result = expireStatement.run(normalizedRepo, normalizedIssue);
      if (result.changes === 0) return null;
      const row = getStatement.get(normalizedRepo, normalizedIssue);
      return row ? rowToClaim(row) : null;
    },
    listClaims(filter = {}) {
      const repoFullName = normalizeListRepoFilter(filter.repoFullName);
      const status = normalizeStatusFilter(filter.status);

      let rows;
      if (repoFullName !== undefined && status !== undefined) {
        rows = listRepoStatusStatement.all(repoFullName, status);
      } else if (repoFullName !== undefined) {
        rows = listRepoStatement.all(repoFullName);
      } else if (status !== undefined) {
        rows = listStatusStatement.all(status);
      } else {
        rows = listAllStatement.all();
      }
      return rows.map(rowToClaim);
    },
    claimIssue(repoFullName, issueNumber, note) {
      return ledger.recordClaim({ repoFullName, issueNumber, note });
    },
    listActiveClaims(repoFullName) {
      const filter = { status: "active" };
      if (repoFullName !== undefined) filter.repoFullName = repoFullName;
      return ledger.listClaims(filter);
    },
    // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. Distinct from
    // this store's normal claim/release/expire lifecycle: deletes every row for a repo outright.
    purgeByRepo(repoFullName) {
      return purgeStoreByRepo(db, CLAIM_LEDGER_PURGE_SPEC, normalizeRepoFullName(repoFullName));
    },
    close() {
      db.close();
    },
  };
  return ledger;
}

/**
 * Strictly read-only ledger access for advisory-only callers (#5157) that must never write anything --
 * not even the schema-creation DDL and schema-version stamp {@link openClaimLedger} always runs on open.
 * Opens the DB file in SQLite's own `readonly` mode (driver-enforced: an attempted write throws, this isn't
 * just a by-convention guarantee) and touches the filesystem in no other way -- no `mkdirSync`/`chmodSync`,
 * no `CREATE TABLE IF NOT EXISTS`, no migrations. The caller MUST only call this against a path it has
 * already confirmed exists (e.g. via `existsSync`); a read-only connection to a nonexistent file throws.
 * Throws if the expected table is missing too (a file exists at this path but isn't a real claim ledger) --
 * callers should treat that identically to any other open/query failure.
 */
export function openClaimLedgerReadOnly(dbPath) {
  const resolvedPath = normalizeDbPath(dbPath);
  // `readOnly` (camelCase) -- node:sqlite silently IGNORES `readonly` (lowercase) as an unrecognized option
  // and opens read-write anyway, defeating the entire point of this function. Verified empirically: a write
  // via a `{ readonly: true }` connection succeeds with no error.
  const db = new DatabaseSync(resolvedPath, { readOnly: true });
  let listActiveStatement;
  try {
    listActiveStatement = db.prepare(
      "SELECT * FROM miner_claims WHERE repo_full_name = ? AND status = 'active' ORDER BY id ASC",
    );
  } catch (error) {
    // The table doesn't exist (a file exists at this path but isn't a real claim ledger) -- close the
    // connection we already opened before rethrowing, so this never leaks a file handle.
    db.close();
    throw error;
  }
  return {
    dbPath: resolvedPath,
    listActiveClaims(repoFullName) {
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      return listActiveStatement.all(normalizedRepo).map(rowToClaim);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultClaimLedger() {
  defaultClaimLedger ??= openClaimLedger();
  return defaultClaimLedger;
}

export function recordClaim(claim) {
  return getDefaultClaimLedger().recordClaim(claim);
}

export function releaseClaim(repoFullName, issueNumber) {
  return getDefaultClaimLedger().releaseClaim(repoFullName, issueNumber);
}

export function expireClaim(repoFullName, issueNumber) {
  return getDefaultClaimLedger().expireClaim(repoFullName, issueNumber);
}

export function listClaims(filter) {
  return getDefaultClaimLedger().listClaims(filter);
}

/** Foundation-phase alias for `recordClaim({ repoFullName, issueNumber, note })`. (#3351) */
export function claimIssue(repoFullName, issueNumber, note) {
  return getDefaultClaimLedger().claimIssue(repoFullName, issueNumber, note);
}

/** List only `active` claims, optionally scoped to one repo. (#3351) */
export function listActiveClaims(repoFullName) {
  return getDefaultClaimLedger().listActiveClaims(repoFullName);
}

export function closeDefaultClaimLedger() {
  if (!defaultClaimLedger) return;
  defaultClaimLedger.close();
  defaultClaimLedger = null;
}
