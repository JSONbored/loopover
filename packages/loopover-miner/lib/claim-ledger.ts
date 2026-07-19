import { DatabaseSync } from "node:sqlite";
import { DEFAULT_MAX_CLAIM_AGE_MS, sweepExpiredClaims } from "./claim-ledger-expiry.js";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";
import { applySchemaMigrations } from "./schema-version.js";
import { CLAIM_LEDGER_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";

// The miner's local soft-claim ledger (#2314): a 100% client-side record of "I'm working on issue #N in repo X",
// so Phase 2's soft-claim adjudication (sibling issues) has somewhere to persist claims. Schema + CRUD only — no
// adjudication logic, no network calls, no autonomous writes. The database only lives on this machine; this module
// never uploads, syncs, or phones home. Mirrors the package's existing local-store pattern (run-state.js,
// portfolio-queue.js, event-ledger.js) — plain JS + node:sqlite, not the hosted Worker's shared D1 `migrations/`.

export type ClaimStatus = "active" | "released" | "expired";

export type ClaimEntry = {
  id: number;
  apiBaseUrl: string;
  repoFullName: string;
  issueNumber: number;
  claimedAt: string;
  status: ClaimStatus;
  note: string | null;
};

export type RecordClaimInput = {
  repoFullName: string;
  issueNumber: number;
  note?: string;
  apiBaseUrl?: string;
};

export type ListClaimsFilter = {
  repoFullName?: string | null;
  status?: ClaimStatus | null;
};

/** Result of an atomic, concurrency-capped claim (#6758). `claimed` discriminates success (a recorded claim)
 *  from a cap rejection (`claim: null`); both carry the pre-insert active count and the resolved cap so a
 *  rejected caller can still log the violation. */
export type ClaimWithinCapResult =
  | { claimed: true; claim: ClaimEntry; activeClaimCount: number; maxConcurrentClaims: number }
  | { claimed: false; claim: null; activeClaimCount: number; maxConcurrentClaims: number };

export type ClaimLedger = {
  dbPath: string;
  recordClaim(claim: RecordClaimInput): ClaimEntry;
  /** Claims the issue, expiring any claim orphaned by a dead process first (#6156). */
  claimIssue(repoFullName: string, issueNumber: number, note?: string, apiBaseUrl?: string): ClaimEntry;
  /** Atomically records the claim only while this repo's active-claim count is under `maxConcurrentClaims`,
   *  counting and inserting in one transaction so racing sibling processes can't exceed the cap (#6758). */
  claimIssueWithinCap(
    repoFullName: string,
    issueNumber: number,
    note: string | undefined,
    apiBaseUrl: string | undefined,
    maxConcurrentClaims: number,
  ): ClaimWithinCapResult;
  /** Expire claims orphaned by a crashed/killed process, returning the transitioned rows (#6156). */
  reclaimExpiredClaims(maxAgeMs?: number): ClaimEntry[];
  releaseClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
  expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
  listClaims(filter?: ListClaimsFilter): ClaimEntry[];
  listActiveClaims(repoFullName?: string): ClaimEntry[];
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

export type ReadOnlyClaimLedger = {
  dbPath: string;
  listActiveClaims(repoFullName: string): ClaimEntry[];
  close(): void;
};

/** SQLite `miner_claims` row shape (StatementSync returns `Record<string, SQLOutputValue>`). */
type ClaimRow = {
  id: number;
  api_base_url: string;
  repo_full_name: string;
  issue_number: number;
  claimed_at: string;
  status: ClaimStatus;
  note: string | null;
};

type CountRow = { count: number };

type TableInfoRow = { name: string };

export const CLAIM_STATUSES = Object.freeze(["active", "released", "expired"]) as readonly ClaimStatus[];

const defaultDbFileName = "claim-ledger.sqlite3";
let defaultClaimLedger: ClaimLedger | null = null;

export function resolveClaimLedgerDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_CLAIM_LEDGER_DB", env);
}

function normalizeDbPath(dbPath: string | null | undefined): string {
  return normalizeLocalStoreDbPath(dbPath, resolveClaimLedgerDbPath(), "invalid_claim_ledger_db_path");
}

function normalizeRepoFullName(repoFullName: unknown): string {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeIssueNumber(issueNumber: unknown): number {
  if (!Number.isInteger(issueNumber) || (issueNumber as number) < 1) throw new Error("invalid_issue_number");
  return issueNumber as number;
}

// The per-repo concurrent-claim cap the atomic count-and-claim gates on (#6758). Always an already-validated
// positive integer from the caller's MinerGoalSpec, but re-checked here because a bad value must fail loudly
// rather than silently disable the cap (a comparison against `undefined` is always false).
function normalizeMaxConcurrentClaims(maxConcurrentClaims: unknown): number {
  if (!Number.isInteger(maxConcurrentClaims) || (maxConcurrentClaims as number) < 1) {
    throw new Error("invalid_max_concurrent_claims");
  }
  return maxConcurrentClaims as number;
}

/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl: unknown): string {
  if (apiBaseUrl === undefined || apiBaseUrl === null) return DEFAULT_FORGE_CONFIG.apiBaseUrl;
  if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim()) throw new Error("invalid_api_base_url");
  return apiBaseUrl.trim();
}

/** Optional free-text note: omitted/nullish → null; a string is kept as-is; anything else is rejected. */
function normalizeNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== "string") throw new Error("invalid_note");
  return note;
}

function rowToClaim(row: ClaimRow): ClaimEntry {
  return {
    id: row.id,
    apiBaseUrl: row.api_base_url,
    repoFullName: row.repo_full_name,
    issueNumber: row.issue_number,
    claimedAt: row.claimed_at,
    status: row.status,
    note: row.note,
  };
}

// v1 -> v2 (#5563): scope the UNIQUE constraint by (api_base_url, repo_full_name, issue_number) instead of bare
// (repo_full_name, issue_number) -- two different forge hosts serving a same-named repo/issue must not collide
// in this ledger. SQLite cannot ALTER a UNIQUE constraint in place, so this rebuilds the table: create the new
// shape, copy every existing row with the pre-#4784 implicit single-forge default backfilled, drop the old
// table, rename the new one in. Runs inside applySchemaMigrations' own transaction, so a mid-rebuild failure
// leaves the file at v1 and retries cleanly on next open.
function addApiBaseUrlScope(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE miner_claims_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_base_url TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      claimed_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
      note TEXT,
      UNIQUE (api_base_url, repo_full_name, issue_number)
    )
  `);
  // OR IGNORE: a row this store's own read path already treats as unusable garbage (an unrecognized `status`,
  // e.g. from a hand-edited or otherwise corrupted file) would violate the CHECK constraint above and abort the
  // whole migration. Skipping it here is consistent with that same fail-closed posture, rather than turning one
  // bad row into a permanently unmigratable file.
  db.prepare(
    `INSERT OR IGNORE INTO miner_claims_v2 (id, api_base_url, repo_full_name, issue_number, claimed_at, status, note)
     SELECT id, ?, repo_full_name, issue_number, claimed_at, status, note FROM miner_claims`,
  ).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
  db.exec("DROP TABLE miner_claims");
  db.exec("ALTER TABLE miner_claims_v2 RENAME TO miner_claims");
}

// v2 -> v3 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
// same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads or
// writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
// column-presence guard as this file's own v1->v2 migration's sibling in portfolio-queue.js.
function addTenantIdColumn(db: DatabaseSync): void {
  const hasTenantIdColumn = db
    .prepare("PRAGMA table_info(miner_claims)")
    .all()
    .some((column) => (column as TableInfoRow).name === "tenant_id");
  if (!hasTenantIdColumn) db.exec("ALTER TABLE miner_claims ADD COLUMN tenant_id TEXT");
}

/**
 * Opens the local claim ledger, creating the table on first use. `UNIQUE(api_base_url, repo_full_name,
 * issue_number)` keeps ONE row per claimed issue per forge host, and `recordClaim` is a single atomic
 * INSERT…ON CONFLICT statement (no read-then-write), so concurrent claims cannot duplicate a row. (#2314, #5563)
 */
export function openClaimLedger(dbPath: string = resolveClaimLedgerDbPath()): ClaimLedger {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);
  // LOCAL bookkeeping only: this table records which issues this miner instance has soft-claimed on this
  // machine. It does NOT adjudicate contested duplicates — sibling miners claiming the same issue are
  // resolved elsewhere via `isDuplicateClusterWinnerByClaim` from `@loopover/engine` (#3355).
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
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
  applySchemaMigrations(db, [addApiBaseUrlScope, addTenantIdColumn]);

  // Idempotent claim in ONE atomic statement: insert a new active claim, or — only if the existing row is NOT
  // already active — re-activate it (a released/expired claim can be re-claimed). The `WHERE status <> 'active'`
  // guard makes re-claiming an already-active issue a true no-op (no row churn), never a duplicate row.
  const recordStatement = db.prepare(`
    INSERT INTO miner_claims (api_base_url, repo_full_name, issue_number, claimed_at, status, note)
    VALUES (?, ?, ?, ?, 'active', ?)
    ON CONFLICT(api_base_url, repo_full_name, issue_number) DO UPDATE SET
      claimed_at = excluded.claimed_at,
      note = excluded.note,
      status = 'active'
    WHERE miner_claims.status <> 'active'
  `);
  const getStatement = db.prepare(
    "SELECT * FROM miner_claims WHERE api_base_url = ? AND repo_full_name = ? AND issue_number = ?",
  );
  // RETURNING (matching portfolio-queue.js's own claim/release statements) makes the "nothing to release/expire"
  // case observable directly from ONE atomic statement, rather than a separate post-UPDATE SELECT whose "row
  // went missing" branch would be structurally unreachable (nothing else runs between the UPDATE and a SELECT
  // on the same key within one synchronous call).
  const releaseStatement = db.prepare(
    "UPDATE miner_claims SET status = 'released' WHERE api_base_url = ? AND repo_full_name = ? AND issue_number = ? AND status = 'active' RETURNING *",
  );
  const expireStatement = db.prepare(
    "UPDATE miner_claims SET status = 'expired' WHERE api_base_url = ? AND repo_full_name = ? AND issue_number = ? AND status = 'active' RETURNING *",
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
  // Repo-wide active-claim tally for the atomic concurrency cap (#6758). Scoped by repo_full_name only (not
  // api_base_url), matching the cross-forge counting that listActiveClaims(repoFullName) -- and the prior
  // attempt-cli.js pre-check built on it -- already did, so the cap's MEANING is unchanged; only its atomicity is.
  const countActiveRepoStatement = db.prepare(
    "SELECT COUNT(*) AS count FROM miner_claims WHERE repo_full_name = ? AND status = 'active'",
  );

  function normalizeListRepoFilter(repoFullName: string | null | undefined): string | undefined {
    if (repoFullName === undefined || repoFullName === null) return undefined;
    return normalizeRepoFullName(repoFullName);
  }

  function normalizeStatusFilter(status: ClaimStatus | string | null | undefined): ClaimStatus | undefined {
    if (status === undefined || status === null) return undefined;
    if (!(CLAIM_STATUSES as readonly string[]).includes(status)) throw new Error("invalid_status");
    return status as ClaimStatus;
  }

  const ledger: ClaimLedger = {
    dbPath: resolvedPath,
    recordClaim(claim: RecordClaimInput): ClaimEntry {
      const apiBaseUrl = normalizeApiBaseUrl(claim?.apiBaseUrl);
      const repoFullName = normalizeRepoFullName(claim?.repoFullName);
      const issueNumber = normalizeIssueNumber(claim?.issueNumber);
      const note = normalizeNote(claim?.note);
      const claimedAt = new Date().toISOString();
      recordStatement.run(apiBaseUrl, repoFullName, issueNumber, claimedAt, note);
      return rowToClaim(getStatement.get(apiBaseUrl, repoFullName, issueNumber) as ClaimRow);
    },
    releaseClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null {
      const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const normalizedIssue = normalizeIssueNumber(issueNumber);
      const row = releaseStatement.get(normalizedForge, normalizedRepo, normalizedIssue) as ClaimRow | undefined;
      return row ? rowToClaim(row) : null;
    },
    expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null {
      const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const normalizedIssue = normalizeIssueNumber(issueNumber);
      const row = expireStatement.get(normalizedForge, normalizedRepo, normalizedIssue) as ClaimRow | undefined;
      return row ? rowToClaim(row) : null;
    },
    listClaims(filter: ListClaimsFilter = {}): ClaimEntry[] {
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
      return rows.map((row) => rowToClaim(row as ClaimRow));
    },
    /** Expire claims orphaned by a crashed/killed process, returning the transitioned rows (#6156). The explicit
     *  counterpart to the sweep claimIssue runs on its own, mirroring reclaimStuckItems (portfolio-queue-manager.js). */
    reclaimExpiredClaims(maxAgeMs: number = DEFAULT_MAX_CLAIM_AGE_MS): ClaimEntry[] {
      return sweepExpiredClaims(ledger, Date.now(), maxAgeMs);
    },
    claimIssue(repoFullName: string, issueNumber: number, note?: string, apiBaseUrl?: string): ClaimEntry {
      // Expire orphaned claims first, so an issue stranded 'active' by a dead process becomes claimable again
      // instead of blocking indefinitely (#6156). Without this, recordClaim's `WHERE status <> 'active'` guard
      // makes re-claiming an active row a no-op, so a claim whose owning process died keeps winning forever --
      // there is no other path to expireClaim. Mirrors claimNextBatch's sweep-then-claim
      // (portfolio-queue-manager.js), where a lease stranded by a dead process would otherwise starve the queue.
      sweepExpiredClaims(ledger, Date.now(), DEFAULT_MAX_CLAIM_AGE_MS);
      return ledger.recordClaim({ repoFullName, issueNumber, note, apiBaseUrl } as RecordClaimInput);
    },
    /**
     * Atomic, concurrency-capped claim (#6758). Sweeps orphaned claims, counts this repo's ACTIVE claims, and
     * records the new claim ONLY while still strictly under `maxConcurrentClaims` -- all inside ONE `BEGIN
     * IMMEDIATE` transaction. The prior enforcement split the count (attempt-cli.js's listActiveClaims) from the
     * insert (claimIssue) across two statements with no shared transaction, so two sibling miner processes racing
     * the same repo could both read the same sub-cap count and both claim, exceeding the cap. Fusing count +
     * insert under an IMMEDIATE write lock -- with node:sqlite's shared `busy_timeout`, so the loser WAITS for the
     * winner's commit rather than erroring -- closes that window: the second process sees the committed count and
     * is cleanly rejected with `claimed: false` (never silently dropped), so the caller can log the cap violation.
     * Returns the pre-insert `activeClaimCount` and the resolved `maxConcurrentClaims` on both paths.
     */
    claimIssueWithinCap(
      repoFullName: string,
      issueNumber: number,
      note: string | undefined,
      apiBaseUrl: string | undefined,
      maxConcurrentClaims: number,
    ): ClaimWithinCapResult {
      const cap = normalizeMaxConcurrentClaims(maxConcurrentClaims);
      // Normalize the repo up front: the count query keys on it, and a bad value must throw BEFORE `BEGIN` so it
      // can never strand an open transaction. `issueNumber`/`note`/`apiBaseUrl` are validated by recordClaim
      // INSIDE the transaction -- a bad value there is rolled back whole via the catch below.
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      db.exec("BEGIN IMMEDIATE");
      try {
        sweepExpiredClaims(ledger, Date.now(), DEFAULT_MAX_CLAIM_AGE_MS);
        const activeClaimCount = (countActiveRepoStatement.get(normalizedRepo) as CountRow).count;
        if (activeClaimCount >= cap) {
          // COMMIT, not ROLLBACK: a claim the sweep just expired is a legitimate transition that must persist even
          // though THIS claim is rejected -- rolling back would resurrect a dead process's stale claim.
          db.exec("COMMIT");
          return { claimed: false, claim: null, activeClaimCount, maxConcurrentClaims: cap };
        }
        const claim = ledger.recordClaim({ repoFullName, issueNumber, note, apiBaseUrl } as RecordClaimInput);
        db.exec("COMMIT");
        return { claimed: true, claim, activeClaimCount, maxConcurrentClaims: cap };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listActiveClaims(repoFullName?: string): ClaimEntry[] {
      const filter = {
        status: "active" as const,
        ...(repoFullName !== undefined ? { repoFullName } : {}),
      } satisfies ListClaimsFilter;
      return ledger.listClaims(filter);
    },
    // Explicit, operator-invoked right-to-be-forgotten purge (#5564) — never runs automatically. Distinct from
    // this store's normal claim/release/expire lifecycle: deletes every row for a repo outright.
    purgeByRepo(repoFullName: string): number {
      return purgeStoreByRepo(db, CLAIM_LEDGER_PURGE_SPEC, normalizeRepoFullName(repoFullName));
    },
    close(): void {
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
export function openClaimLedgerReadOnly(dbPath: string): ReadOnlyClaimLedger {
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
    listActiveClaims(repoFullName: string): ClaimEntry[] {
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      return listActiveStatement.all(normalizedRepo).map((row) => rowToClaim(row as ClaimRow));
    },
    close(): void {
      db.close();
    },
  };
}

function getDefaultClaimLedger(): ClaimLedger {
  defaultClaimLedger ??= openClaimLedger();
  return defaultClaimLedger;
}

export function recordClaim(claim: RecordClaimInput): ClaimEntry {
  return getDefaultClaimLedger().recordClaim(claim);
}

export function releaseClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null {
  return getDefaultClaimLedger().releaseClaim(repoFullName, issueNumber, apiBaseUrl);
}

export function expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null {
  return getDefaultClaimLedger().expireClaim(repoFullName, issueNumber, apiBaseUrl);
}

export function listClaims(filter?: ListClaimsFilter): ClaimEntry[] {
  return getDefaultClaimLedger().listClaims(filter);
}

/** Foundation-phase alias for `recordClaim({ repoFullName, issueNumber, note, apiBaseUrl })`. (#3351) */
export function claimIssue(repoFullName: string, issueNumber: number, note?: string, apiBaseUrl?: string): ClaimEntry {
  return getDefaultClaimLedger().claimIssue(repoFullName, issueNumber, note, apiBaseUrl);
}

/** List only `active` claims, optionally scoped to one repo. (#3351) */
export function listActiveClaims(repoFullName?: string): ClaimEntry[] {
  return getDefaultClaimLedger().listActiveClaims(repoFullName);
}

export function closeDefaultClaimLedger(): void {
  if (!defaultClaimLedger) return;
  defaultClaimLedger.close();
  defaultClaimLedger = null;
}
