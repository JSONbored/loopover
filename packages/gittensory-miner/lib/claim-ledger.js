import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The miner's local soft-claim ledger (#2314): a 100% client-side record of "I'm working on issue #N in repo X",
// so Phase 2's soft-claim adjudication (sibling issues) has somewhere to persist claims. Schema + CRUD only — no
// adjudication logic, no network calls, no autonomous writes. The database only lives on this machine; this module
// never uploads, syncs, or phones home. Mirrors the package's existing local-store pattern (run-state.js,
// portfolio-queue.js, event-ledger.js) — plain JS + node:sqlite, not the hosted Worker's shared D1 `migrations/`.

export const CLAIM_STATUSES = Object.freeze(["active", "released", "expired"]);

const defaultDbFileName = "claim-ledger.sqlite3";
let defaultClaimLedger = null;

export function resolveClaimLedgerDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_CLAIM_LEDGER_DB === "string"
    ? env.GITTENSORY_MINER_CLAIM_LEDGER_DB.trim()
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
  const path = (dbPath ?? resolveClaimLedgerDbPath()).trim();
  if (!path) throw new Error("invalid_claim_ledger_db_path");
  return path;
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
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
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
    close() {
      db.close();
    },
  };
  return ledger;
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
