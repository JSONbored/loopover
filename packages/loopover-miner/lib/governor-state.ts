import type {
  GovernorCapUsage,
  OwnSubmissionRecord,
  RepoOutcomeHistory,
  WriteRateLimitBackoffStore,
  WriteRateLimitBucketStore,
} from "@loopover/engine";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import {
  GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC,
  GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC,
  purgeStoreByRepo,
} from "./store-maintenance.js";

// Governor cross-attempt state persistence (#5134, Wave 3.5). Every governor-*.js wrapper
// (governor-chokepoint.js) is a pure in/out transform: it computes and RETURNS
// updated rate-limit buckets/backoff attempts, but nothing writes them to disk, so they reset to zero on
// every process start -- the mutable counters that should gate the NEXT decision never survive past one
// process. governor-ledger.js already persists the DECISION HISTORY (an append-only audit log); this module
// persists the DECISION INPUT state instead -- a second, distinct concern, not a duplicate of that log (see
// its own module doc for the ledger/state split this issue's acceptance criteria requires).
//
// This module does not alter evaluateGovernorChokepoint's precedence ladder or any pure calculator's logic --
// it only gives their existing, already-optional input fields (rateLimitBuckets, rateLimitBackoffAttempts,
// capUsage, reputationHistory, recentOwnSubmissions) a real load-at-start/save-at-end home. Convergence input
// (packages/loopover-engine/src/portfolio/non-convergence.ts's PortfolioConvergenceInput) is NOT persisted
// here: that module's own doc comment says its counters belong on the portfolio-queue table (a pre-existing
// store this issue's boundaries don't touch) once that table grows attempt-history columns -- inventing a
// second, competing store for the same concept here would violate the same non-duplication principle the
// ledger/state split above is built on.

export type GovernorRateLimitState = {
  buckets: WriteRateLimitBucketStore;
  backoffAttempts: WriteRateLimitBackoffStore;
};

export type ListRecentOwnSubmissionsFilter = {
  repoFullName?: string;
  limit?: number;
};

export type GovernorPauseState = {
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
};

export type GovernorPauseInput = {
  paused: boolean;
  reason?: string | null;
};

export type GovernorState = {
  dbPath: string;
  loadRateLimitState(): GovernorRateLimitState;
  saveRateLimitState(rateLimitState: GovernorRateLimitState): void;
  loadCapUsage(): GovernorCapUsage;
  saveCapUsage(capUsage: GovernorCapUsage): void;
  loadPauseState(): GovernorPauseState;
  savePauseState(pauseState: GovernorPauseInput): GovernorPauseState;
  loadReputationHistory(repoFullName: string, apiBaseUrl?: string): RepoOutcomeHistory;
  saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory, apiBaseUrl?: string): RepoOutcomeHistory;
  recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord;
  listRecentOwnSubmissions(filter?: ListRecentOwnSubmissionsFilter): OwnSubmissionRecord[];
  /** Delete every repo-scoped row for one repo across both governor tables (#7091); returns total rows removed. */
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

/** SQLite `governor_scalar_state` row shape (StatementSync returns `Record<string, SQLOutputValue>`). */
type ScalarStateRow = {
  id: number;
  rate_limit_buckets_json: string;
  rate_limit_backoff_json: string;
  cap_usage_json: string;
  paused: number;
  pause_reason: string | null;
  paused_at: string | null;
  updated_at: string;
};

type ReputationHistoryRow = {
  api_base_url: string;
  repo_full_name: string;
  decided: number;
  unfavorable: number;
  updated_at: string;
};

type OwnSubmissionRow = {
  id: number;
  repo_full_name: string;
  fingerprint: string;
  submitted_at: string | null;
  pull_request_number: number | null;
  issue_number: number | null;
};

type TableInfoRow = { name: string };

const defaultDbFileName = "governor-state.sqlite3";
const DEFAULT_RATE_LIMIT_BUCKETS: Readonly<WriteRateLimitBucketStore> = Object.freeze({ global: {}, perRepo: {} });
const DEFAULT_RATE_LIMIT_BACKOFF: Readonly<WriteRateLimitBackoffStore> = Object.freeze({});
const DEFAULT_CAP_USAGE: Readonly<GovernorCapUsage> = Object.freeze({ budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 });
const DEFAULT_REPUTATION_HISTORY: Readonly<RepoOutcomeHistory> = Object.freeze({ decided: 0, unfavorable: 0 });
let defaultGovernorState: GovernorState | null = null;

export function resolveGovernorStateDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_GOVERNOR_STATE_DB", env);
}

function normalizeDbPath(dbPath: string | null | undefined): string {
  return normalizeLocalStoreDbPath(dbPath, resolveGovernorStateDbPath(), "invalid_governor_state_db_path");
}

function normalizeRepoFullName(repoFullName: unknown): string {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl: unknown): string {
  if (apiBaseUrl === undefined || apiBaseUrl === null) return DEFAULT_FORGE_CONFIG.apiBaseUrl;
  if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim()) throw new Error("invalid_api_base_url");
  return apiBaseUrl.trim();
}

function parseJsonColumn<T extends object>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

// Add the pause/resume columns (#4851) to an on-disk file created before they existed. `CREATE TABLE IF NOT
// EXISTS` above is a no-op against an already-existing table, so a pre-#4851 file needs this explicit ALTER --
// guarded by a per-column presence check (rather than a single `paused`-only check) so a file that somehow
// has `paused` but not `pause_reason`/`paused_at` still gets the columns it's missing, same technique as
// portfolio-queue.js's own post-creation column migration.
function ensurePauseColumns(db: DatabaseSync): void {
  const existingColumns = new Set(
    db
      .prepare("PRAGMA table_info(governor_scalar_state)")
      .all()
      .map((column) => (column as TableInfoRow).name),
  );
  if (!existingColumns.has("paused")) {
    db.exec("ALTER TABLE governor_scalar_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
  }
  if (!existingColumns.has("pause_reason")) {
    db.exec("ALTER TABLE governor_scalar_state ADD COLUMN pause_reason TEXT");
  }
  if (!existingColumns.has("paused_at")) {
    db.exec("ALTER TABLE governor_scalar_state ADD COLUMN paused_at TEXT");
  }
}

// Rebuild governor_reputation_history's bare `repo_full_name` PRIMARY KEY into a (api_base_url, repo_full_name)
// composite (#5563) -- two forge hosts serving a same-named owner/repo must not share one reputation row.
// SQLite cannot ALTER a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy every
// existing row with the pre-#4784 implicit single-forge default backfilled, drop the old table, rename the new
// one in. Guarded by a column-presence check (matching ensurePauseColumns' idempotence) so this only runs once
// per file, same technique as portfolio-queue.js's own post-creation migration.
function ensureReputationHistoryForgeScope(db: DatabaseSync): void {
  const hasApiBaseUrlColumn = db
    .prepare("PRAGMA table_info(governor_reputation_history)")
    .all()
    .some((column) => (column as TableInfoRow).name === "api_base_url");
  if (hasApiBaseUrlColumn) return;
  db.exec(`
    CREATE TABLE governor_reputation_history_v2 (
      api_base_url TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      decided INTEGER NOT NULL,
      unfavorable INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (api_base_url, repo_full_name)
    )
  `);
  // OR IGNORE: a source row that somehow violates the rebuilt table's NOT NULL columns (a hand-edited or
  // otherwise corrupted file) is skipped rather than aborting the whole migration -- same fail-closed posture
  // as run-state.js's own #5563 migration.
  db.prepare(
    `INSERT OR IGNORE INTO governor_reputation_history_v2 (api_base_url, repo_full_name, decided, unfavorable, updated_at)
     SELECT ?, repo_full_name, decided, unfavorable, updated_at FROM governor_reputation_history`,
  ).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
  db.exec("DROP TABLE governor_reputation_history");
  db.exec("ALTER TABLE governor_reputation_history_v2 RENAME TO governor_reputation_history");
}

/** Opens the local governor-state store, creating tables on first use. */
export function openGovernorState(dbPath: string = resolveGovernorStateDbPath()): GovernorState {
  const resolvedPath = normalizeDbPath(dbPath);
  const db = openLocalStoreDb(resolvedPath);

  // ONE row (id=1) holding the whole-run scalar state: rate-limit buckets/backoff and budget/turn/termination
  // usage have no natural per-repo key of their own beyond what's already encoded inside the JSON blob
  // (WriteRateLimitBucketStore.perRepo is itself keyed by `${actionClass}:${repoFullName}`), so a single
  // UPSERTed row is simpler and more honest than inventing a relational key that doesn't exist upstream.
  db.exec(`
    CREATE TABLE IF NOT EXISTS governor_scalar_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rate_limit_buckets_json TEXT NOT NULL,
      rate_limit_backoff_json TEXT NOT NULL,
      cap_usage_json TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT,
      paused_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  ensurePauseColumns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS governor_reputation_history (
      repo_full_name TEXT PRIMARY KEY,
      decided INTEGER NOT NULL,
      unfavorable INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  ensureReputationHistoryForgeScope(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS governor_own_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_full_name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      submitted_at TEXT,
      pull_request_number INTEGER,
      issue_number INTEGER
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_governor_own_submissions_repo ON governor_own_submissions (repo_full_name, id)");

  const getScalarStatement = db.prepare("SELECT * FROM governor_scalar_state WHERE id = 1");
  const upsertScalarStatement = db.prepare(`
    INSERT INTO governor_scalar_state
      (id, rate_limit_buckets_json, rate_limit_backoff_json, cap_usage_json, paused, pause_reason, paused_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      rate_limit_buckets_json = excluded.rate_limit_buckets_json,
      rate_limit_backoff_json = excluded.rate_limit_backoff_json,
      cap_usage_json = excluded.cap_usage_json,
      paused = excluded.paused,
      pause_reason = excluded.pause_reason,
      paused_at = excluded.paused_at,
      updated_at = excluded.updated_at
  `);
  const getReputationStatement = db.prepare(
    "SELECT * FROM governor_reputation_history WHERE api_base_url = ? AND repo_full_name = ?",
  );
  const upsertReputationStatement = db.prepare(`
    INSERT INTO governor_reputation_history (api_base_url, repo_full_name, decided, unfavorable, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(api_base_url, repo_full_name) DO UPDATE SET
      decided = excluded.decided,
      unfavorable = excluded.unfavorable,
      updated_at = excluded.updated_at
  `);
  const insertSubmissionStatement = db.prepare(`
    INSERT INTO governor_own_submissions (repo_full_name, fingerprint, submitted_at, pull_request_number, issue_number)
    VALUES (?, ?, ?, ?, ?)
  `);
  const listSubmissionsAllStatement = db.prepare(
    "SELECT * FROM governor_own_submissions ORDER BY id DESC LIMIT ?",
  );
  const listSubmissionsByRepoStatement = db.prepare(
    "SELECT * FROM governor_own_submissions WHERE repo_full_name = ? ORDER BY id DESC LIMIT ?",
  );

  function rowToSubmission(row: OwnSubmissionRow): OwnSubmissionRecord {
    return {
      repoFullName: row.repo_full_name,
      fingerprint: row.fingerprint,
      submittedAt: row.submitted_at,
      pullRequestNumber: row.pull_request_number,
      issueNumber: row.issue_number,
    };
  }

  // BEGIN IMMEDIATE takes the write lock BEFORE `fn`'s read, so two processes on the same file (the loop daemon
  // saving rate-limit/cap-usage state on every gated write, and an operator's `governor pause`/`resume` CLI
  // invocation racing it) cannot interleave a stale read with each other's write and silently clobber the
  // scalar-state column-group they don't own -- same fix shape as event-ledger.js's appendEvent (#7221). Shared
  // by all three governor_scalar_state save methods below, since they all read-then-write across the same row.
  function withTransaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const state: GovernorState = {
    dbPath: resolvedPath,
    loadRateLimitState(): GovernorRateLimitState {
      const row = getScalarStatement.get() as ScalarStateRow | undefined;
      return {
        buckets: parseJsonColumn(row?.rate_limit_buckets_json, DEFAULT_RATE_LIMIT_BUCKETS),
        backoffAttempts: parseJsonColumn(row?.rate_limit_backoff_json, DEFAULT_RATE_LIMIT_BACKOFF),
      };
    },
    saveRateLimitState(rateLimitState: GovernorRateLimitState): void {
      withTransaction(() => {
        const row = getScalarStatement.get() as ScalarStateRow | undefined;
        upsertScalarStatement.run(
          JSON.stringify(rateLimitState?.buckets ?? DEFAULT_RATE_LIMIT_BUCKETS),
          JSON.stringify(rateLimitState?.backoffAttempts ?? DEFAULT_RATE_LIMIT_BACKOFF),
          row ? row.cap_usage_json : JSON.stringify(DEFAULT_CAP_USAGE),
          row ? row.paused : 0,
          row ? row.pause_reason : null,
          row ? row.paused_at : null,
          new Date().toISOString(),
        );
      });
    },
    loadCapUsage(): GovernorCapUsage {
      const row = getScalarStatement.get() as ScalarStateRow | undefined;
      return parseJsonColumn(row?.cap_usage_json, DEFAULT_CAP_USAGE);
    },
    saveCapUsage(capUsage: GovernorCapUsage): void {
      withTransaction(() => {
        const row = getScalarStatement.get() as ScalarStateRow | undefined;
        upsertScalarStatement.run(
          row ? row.rate_limit_buckets_json : JSON.stringify(DEFAULT_RATE_LIMIT_BUCKETS),
          row ? row.rate_limit_backoff_json : JSON.stringify(DEFAULT_RATE_LIMIT_BACKOFF),
          JSON.stringify(capUsage ?? DEFAULT_CAP_USAGE),
          row ? row.paused : 0,
          row ? row.pause_reason : null,
          row ? row.paused_at : null,
          new Date().toISOString(),
        );
      });
    },
    // The governor pause/resume control surface (#4851): a real, persisted, operator/governor-writable flag the
    // loop checks before each cycle -- distinct from governor-kill-switch.js (a read-only resolver over env/YAML
    // inputs the miner does not itself write) and governor-run-halt.js (a one-way, run-scoped terminal breaker).
    // `pausedAt` is stamped fresh on every transition INTO paused, and cleared on resume, so a status query can
    // report how long a pause has been in effect without needing a separate history table.
    loadPauseState(): GovernorPauseState {
      const row = getScalarStatement.get() as ScalarStateRow | undefined;
      return {
        paused: row ? Boolean(row.paused) : false,
        reason: row?.pause_reason ?? null,
        pausedAt: row?.paused_at ?? null,
      };
    },
    savePauseState(pauseState: GovernorPauseInput): GovernorPauseState {
      const paused = Boolean(pauseState?.paused);
      const reason =
        typeof pauseState?.reason === "string" && pauseState.reason.trim() ? pauseState.reason.trim() : null;
      const pausedAt = paused ? new Date().toISOString() : null;
      withTransaction(() => {
        const row = getScalarStatement.get() as ScalarStateRow | undefined;
        upsertScalarStatement.run(
          row ? row.rate_limit_buckets_json : JSON.stringify(DEFAULT_RATE_LIMIT_BUCKETS),
          row ? row.rate_limit_backoff_json : JSON.stringify(DEFAULT_RATE_LIMIT_BACKOFF),
          row ? row.cap_usage_json : JSON.stringify(DEFAULT_CAP_USAGE),
          paused ? 1 : 0,
          reason,
          pausedAt,
          new Date().toISOString(),
        );
      });
      return { paused, reason, pausedAt };
    },
    loadReputationHistory(repoFullName: string, apiBaseUrl?: string): RepoOutcomeHistory {
      const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const row = getReputationStatement.get(normalizedForge, normalizedRepo) as ReputationHistoryRow | undefined;
      if (!row) return { ...DEFAULT_REPUTATION_HISTORY };
      return { decided: row.decided, unfavorable: row.unfavorable };
    },
    saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory, apiBaseUrl?: string): RepoOutcomeHistory {
      const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const decided = Number.isInteger(history?.decided) ? history.decided : 0;
      const unfavorable = Number.isInteger(history?.unfavorable) ? history.unfavorable : 0;
      upsertReputationStatement.run(normalizedForge, normalizedRepo, decided, unfavorable, new Date().toISOString());
      return { decided, unfavorable };
    },
    recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord {
      const normalized = normalizeRepoFullName(record?.repoFullName);
      if (typeof record?.fingerprint !== "string" || !record.fingerprint.trim()) {
        throw new Error("invalid_fingerprint");
      }
      const submittedAt = typeof record.submittedAt === "string" ? record.submittedAt : new Date().toISOString();
      const pullRequestNumber: number | null = Number.isInteger(record.pullRequestNumber) ? (record.pullRequestNumber as number) : null;
      const issueNumber: number | null = Number.isInteger(record.issueNumber) ? (record.issueNumber as number) : null;
      insertSubmissionStatement.run(normalized, record.fingerprint, submittedAt, pullRequestNumber, issueNumber);
      return { repoFullName: normalized, fingerprint: record.fingerprint, submittedAt, pullRequestNumber, issueNumber };
    },
    listRecentOwnSubmissions(filter: ListRecentOwnSubmissionsFilter = {}): OwnSubmissionRecord[] {
      const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? (filter.limit as number) : 200;
      const rows =
        filter.repoFullName === undefined
          ? listSubmissionsAllStatement.all(limit)
          : listSubmissionsByRepoStatement.all(normalizeRepoFullName(filter.repoFullName), limit);
      return rows.map((row) => rowToSubmission(row as OwnSubmissionRow));
    },
    /**
     * Delete every repo-scoped row for one repo across BOTH governor tables against this single open handle
     * (#7091) — the right-to-be-forgotten path `loopover-miner purge` invokes. `governor_reputation_history` is
     * purged on `repo_full_name` alone (its key is composite with `api_base_url`), so nothing survives on any
     * forge host. `governor_scalar_state` is deliberately untouched — it has no repo dimension. Returns the
     * total rows removed across both tables.
     */
    purgeByRepo(repoFullName: string): number {
      const normalized = normalizeRepoFullName(repoFullName);
      return (
        purgeStoreByRepo(db, GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, normalized) +
        purgeStoreByRepo(db, GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC, normalized)
      );
    },
    close(): void {
      db.close();
    },
  };
  return state;
}

function getDefaultGovernorState(): GovernorState {
  defaultGovernorState ??= openGovernorState();
  return defaultGovernorState;
}

export function loadRateLimitState(): GovernorRateLimitState {
  return getDefaultGovernorState().loadRateLimitState();
}

export function saveRateLimitState(rateLimitState: GovernorRateLimitState): void {
  return getDefaultGovernorState().saveRateLimitState(rateLimitState);
}

export function loadCapUsage(): GovernorCapUsage {
  return getDefaultGovernorState().loadCapUsage();
}

export function saveCapUsage(capUsage: GovernorCapUsage): void {
  return getDefaultGovernorState().saveCapUsage(capUsage);
}

export function loadPauseState(): GovernorPauseState {
  return getDefaultGovernorState().loadPauseState();
}

export function savePauseState(pauseState: GovernorPauseInput): GovernorPauseState {
  return getDefaultGovernorState().savePauseState(pauseState);
}

export function loadReputationHistory(repoFullName: string, apiBaseUrl?: string): RepoOutcomeHistory {
  return getDefaultGovernorState().loadReputationHistory(repoFullName, apiBaseUrl);
}

export function saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory, apiBaseUrl?: string): RepoOutcomeHistory {
  return getDefaultGovernorState().saveReputationHistory(repoFullName, history, apiBaseUrl);
}

export function recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord {
  return getDefaultGovernorState().recordOwnSubmission(record);
}

export function listRecentOwnSubmissions(filter?: ListRecentOwnSubmissionsFilter): OwnSubmissionRecord[] {
  return getDefaultGovernorState().listRecentOwnSubmissions(filter);
}

export function closeDefaultGovernorState(): void {
  if (!defaultGovernorState) return;
  defaultGovernorState.close();
  defaultGovernorState = null;
}
