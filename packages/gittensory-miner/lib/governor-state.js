import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";

// Governor cross-attempt state persistence (#5134, Wave 3.5). Every governor-*.js wrapper
// (governor-write-rate-limit.js, governor-chokepoint.js) is a pure in/out transform: it computes and RETURNS
// updated rate-limit buckets/backoff attempts, but nothing writes them to disk, so they reset to zero on
// every process start -- the mutable counters that should gate the NEXT decision never survive past one
// process. governor-ledger.js already persists the DECISION HISTORY (an append-only audit log); this module
// persists the DECISION INPUT state instead -- a second, distinct concern, not a duplicate of that log (see
// its own module doc for the ledger/state split this issue's acceptance criteria requires).
//
// This module does not alter evaluateGovernorChokepoint's precedence ladder or any pure calculator's logic --
// it only gives their existing, already-optional input fields (rateLimitBuckets, rateLimitBackoffAttempts,
// capUsage, reputationHistory, recentOwnSubmissions) a real load-at-start/save-at-end home. Convergence input
// (packages/gittensory-engine/src/portfolio/non-convergence.ts's PortfolioConvergenceInput) is NOT persisted
// here: that module's own doc comment says its counters belong on the portfolio-queue table (a pre-existing
// store this issue's boundaries don't touch) once that table grows attempt-history columns -- inventing a
// second, competing store for the same concept here would violate the same non-duplication principle the
// ledger/state split above is built on.

const defaultDbFileName = "governor-state.sqlite3";
const DEFAULT_RATE_LIMIT_BUCKETS = Object.freeze({ global: {}, perRepo: {} });
const DEFAULT_RATE_LIMIT_BACKOFF = Object.freeze({});
const DEFAULT_CAP_USAGE = Object.freeze({ budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 });
const DEFAULT_REPUTATION_HISTORY = Object.freeze({ decided: 0, unfavorable: 0 });
let defaultGovernorState = null;

export function resolveGovernorStateDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "GITTENSORY_MINER_GOVERNOR_STATE_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolveGovernorStateDbPath(), "invalid_governor_state_db_path");
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function parseJsonColumn(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Opens the local governor-state store, creating tables on first use. */
export function openGovernorState(dbPath = resolveGovernorStateDbPath()) {
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
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS governor_reputation_history (
      repo_full_name TEXT PRIMARY KEY,
      decided INTEGER NOT NULL,
      unfavorable INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
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
    INSERT INTO governor_scalar_state (id, rate_limit_buckets_json, rate_limit_backoff_json, cap_usage_json, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      rate_limit_buckets_json = excluded.rate_limit_buckets_json,
      rate_limit_backoff_json = excluded.rate_limit_backoff_json,
      cap_usage_json = excluded.cap_usage_json,
      updated_at = excluded.updated_at
  `);
  const getReputationStatement = db.prepare("SELECT * FROM governor_reputation_history WHERE repo_full_name = ?");
  const upsertReputationStatement = db.prepare(`
    INSERT INTO governor_reputation_history (repo_full_name, decided, unfavorable, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repo_full_name) DO UPDATE SET
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

  function rowToSubmission(row) {
    return {
      repoFullName: row.repo_full_name,
      fingerprint: row.fingerprint,
      submittedAt: row.submitted_at,
      pullRequestNumber: row.pull_request_number,
      issueNumber: row.issue_number,
    };
  }

  const state = {
    dbPath: resolvedPath,
    loadRateLimitState() {
      const row = getScalarStatement.get();
      return {
        buckets: parseJsonColumn(row?.rate_limit_buckets_json, DEFAULT_RATE_LIMIT_BUCKETS),
        backoffAttempts: parseJsonColumn(row?.rate_limit_backoff_json, DEFAULT_RATE_LIMIT_BACKOFF),
      };
    },
    saveRateLimitState(rateLimitState) {
      const row = getScalarStatement.get();
      upsertScalarStatement.run(
        JSON.stringify(rateLimitState?.buckets ?? DEFAULT_RATE_LIMIT_BUCKETS),
        JSON.stringify(rateLimitState?.backoffAttempts ?? DEFAULT_RATE_LIMIT_BACKOFF),
        row ? row.cap_usage_json : JSON.stringify(DEFAULT_CAP_USAGE),
        new Date().toISOString(),
      );
    },
    loadCapUsage() {
      const row = getScalarStatement.get();
      return parseJsonColumn(row?.cap_usage_json, DEFAULT_CAP_USAGE);
    },
    saveCapUsage(capUsage) {
      const row = getScalarStatement.get();
      upsertScalarStatement.run(
        row ? row.rate_limit_buckets_json : JSON.stringify(DEFAULT_RATE_LIMIT_BUCKETS),
        row ? row.rate_limit_backoff_json : JSON.stringify(DEFAULT_RATE_LIMIT_BACKOFF),
        JSON.stringify(capUsage ?? DEFAULT_CAP_USAGE),
        new Date().toISOString(),
      );
    },
    loadReputationHistory(repoFullName) {
      const normalized = normalizeRepoFullName(repoFullName);
      const row = getReputationStatement.get(normalized);
      if (!row) return { ...DEFAULT_REPUTATION_HISTORY };
      return { decided: row.decided, unfavorable: row.unfavorable };
    },
    saveReputationHistory(repoFullName, history) {
      const normalized = normalizeRepoFullName(repoFullName);
      const decided = Number.isInteger(history?.decided) ? history.decided : 0;
      const unfavorable = Number.isInteger(history?.unfavorable) ? history.unfavorable : 0;
      upsertReputationStatement.run(normalized, decided, unfavorable, new Date().toISOString());
      return { decided, unfavorable };
    },
    recordOwnSubmission(record) {
      const normalized = normalizeRepoFullName(record?.repoFullName);
      if (typeof record?.fingerprint !== "string" || !record.fingerprint.trim()) {
        throw new Error("invalid_fingerprint");
      }
      const submittedAt = typeof record.submittedAt === "string" ? record.submittedAt : new Date().toISOString();
      const pullRequestNumber = Number.isInteger(record.pullRequestNumber) ? record.pullRequestNumber : null;
      const issueNumber = Number.isInteger(record.issueNumber) ? record.issueNumber : null;
      insertSubmissionStatement.run(normalized, record.fingerprint, submittedAt, pullRequestNumber, issueNumber);
      return { repoFullName: normalized, fingerprint: record.fingerprint, submittedAt, pullRequestNumber, issueNumber };
    },
    listRecentOwnSubmissions(filter = {}) {
      const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200;
      const rows =
        filter.repoFullName === undefined
          ? listSubmissionsAllStatement.all(limit)
          : listSubmissionsByRepoStatement.all(normalizeRepoFullName(filter.repoFullName), limit);
      return rows.map(rowToSubmission);
    },
    close() {
      db.close();
    },
  };
  return state;
}

function getDefaultGovernorState() {
  defaultGovernorState ??= openGovernorState();
  return defaultGovernorState;
}

export function loadRateLimitState() {
  return getDefaultGovernorState().loadRateLimitState();
}

export function saveRateLimitState(rateLimitState) {
  return getDefaultGovernorState().saveRateLimitState(rateLimitState);
}

export function loadCapUsage() {
  return getDefaultGovernorState().loadCapUsage();
}

export function saveCapUsage(capUsage) {
  return getDefaultGovernorState().saveCapUsage(capUsage);
}

export function loadReputationHistory(repoFullName) {
  return getDefaultGovernorState().loadReputationHistory(repoFullName);
}

export function saveReputationHistory(repoFullName, history) {
  return getDefaultGovernorState().saveReputationHistory(repoFullName, history);
}

export function recordOwnSubmission(record) {
  return getDefaultGovernorState().recordOwnSubmission(record);
}

export function listRecentOwnSubmissions(filter) {
  return getDefaultGovernorState().listRecentOwnSubmissions(filter);
}

export function closeDefaultGovernorState() {
  if (!defaultGovernorState) return;
  defaultGovernorState.close();
  defaultGovernorState = null;
}
