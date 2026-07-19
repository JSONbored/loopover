import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC, GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, purgeStoreByRepo, } from "./store-maintenance.js";
const defaultDbFileName = "governor-state.sqlite3";
const DEFAULT_RATE_LIMIT_BUCKETS = Object.freeze({ global: {}, perRepo: {} });
const DEFAULT_RATE_LIMIT_BACKOFF = Object.freeze({});
const DEFAULT_CAP_USAGE = Object.freeze({ budgetSpent: 0, turnsTaken: 0, elapsedMs: 0 });
const DEFAULT_REPUTATION_HISTORY = Object.freeze({ decided: 0, unfavorable: 0 });
let defaultGovernorState = null;
export function resolveGovernorStateDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_GOVERNOR_STATE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveGovernorStateDbPath(), "invalid_governor_state_db_path");
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
    if (apiBaseUrl === undefined || apiBaseUrl === null)
        return DEFAULT_FORGE_CONFIG.apiBaseUrl;
    if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim())
        throw new Error("invalid_api_base_url");
    return apiBaseUrl.trim();
}
function parseJsonColumn(value, fallback) {
    if (typeof value !== "string")
        return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
// Add the pause/resume columns (#4851) to an on-disk file created before they existed. `CREATE TABLE IF NOT
// EXISTS` above is a no-op against an already-existing table, so a pre-#4851 file needs this explicit ALTER --
// guarded by a per-column presence check (rather than a single `paused`-only check) so a file that somehow
// has `paused` but not `pause_reason`/`paused_at` still gets the columns it's missing, same technique as
// portfolio-queue.js's own post-creation column migration.
function ensurePauseColumns(db) {
    const existingColumns = new Set(db
        .prepare("PRAGMA table_info(governor_scalar_state)")
        .all()
        .map((column) => column.name));
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
function ensureReputationHistoryForgeScope(db) {
    const hasApiBaseUrlColumn = db
        .prepare("PRAGMA table_info(governor_reputation_history)")
        .all()
        .some((column) => column.name === "api_base_url");
    if (hasApiBaseUrlColumn)
        return;
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
    db.prepare(`INSERT OR IGNORE INTO governor_reputation_history_v2 (api_base_url, repo_full_name, decided, unfavorable, updated_at)
     SELECT ?, repo_full_name, decided, unfavorable, updated_at FROM governor_reputation_history`).run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
    db.exec("DROP TABLE governor_reputation_history");
    db.exec("ALTER TABLE governor_reputation_history_v2 RENAME TO governor_reputation_history");
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
    const getReputationStatement = db.prepare("SELECT * FROM governor_reputation_history WHERE api_base_url = ? AND repo_full_name = ?");
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
    const listSubmissionsAllStatement = db.prepare("SELECT * FROM governor_own_submissions ORDER BY id DESC LIMIT ?");
    const listSubmissionsByRepoStatement = db.prepare("SELECT * FROM governor_own_submissions WHERE repo_full_name = ? ORDER BY id DESC LIMIT ?");
    function rowToSubmission(row) {
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
    function withTransaction(fn) {
        db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            db.exec("COMMIT");
            return result;
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
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
            withTransaction(() => {
                const row = getScalarStatement.get();
                upsertScalarStatement.run(JSON.stringify(rateLimitState?.buckets ?? DEFAULT_RATE_LIMIT_BUCKETS), JSON.stringify(rateLimitState?.backoffAttempts ?? DEFAULT_RATE_LIMIT_BACKOFF), row ? row.cap_usage_json : JSON.stringify(DEFAULT_CAP_USAGE), row ? row.paused : 0, row ? row.pause_reason : null, row ? row.paused_at : null, new Date().toISOString());
            });
        },
        loadCapUsage() {
            const row = getScalarStatement.get();
            return parseJsonColumn(row?.cap_usage_json, DEFAULT_CAP_USAGE);
        },
        saveCapUsage(capUsage) {
            withTransaction(() => {
                const row = getScalarStatement.get();
                upsertScalarStatement.run(row ? row.rate_limit_buckets_json : JSON.stringify(DEFAULT_RATE_LIMIT_BUCKETS), row ? row.rate_limit_backoff_json : JSON.stringify(DEFAULT_RATE_LIMIT_BACKOFF), JSON.stringify(capUsage ?? DEFAULT_CAP_USAGE), row ? row.paused : 0, row ? row.pause_reason : null, row ? row.paused_at : null, new Date().toISOString());
            });
        },
        // The governor pause/resume control surface (#4851): a real, persisted, operator/governor-writable flag the
        // loop checks before each cycle -- distinct from governor-kill-switch.js (a read-only resolver over env/YAML
        // inputs the miner does not itself write) and governor-run-halt.js (a one-way, run-scoped terminal breaker).
        // `pausedAt` is stamped fresh on every transition INTO paused, and cleared on resume, so a status query can
        // report how long a pause has been in effect without needing a separate history table.
        loadPauseState() {
            const row = getScalarStatement.get();
            return {
                paused: row ? Boolean(row.paused) : false,
                reason: row?.pause_reason ?? null,
                pausedAt: row?.paused_at ?? null,
            };
        },
        savePauseState(pauseState) {
            const paused = Boolean(pauseState?.paused);
            const reason = typeof pauseState?.reason === "string" && pauseState.reason.trim() ? pauseState.reason.trim() : null;
            const pausedAt = paused ? new Date().toISOString() : null;
            withTransaction(() => {
                const row = getScalarStatement.get();
                upsertScalarStatement.run(row ? row.rate_limit_buckets_json : JSON.stringify(DEFAULT_RATE_LIMIT_BUCKETS), row ? row.rate_limit_backoff_json : JSON.stringify(DEFAULT_RATE_LIMIT_BACKOFF), row ? row.cap_usage_json : JSON.stringify(DEFAULT_CAP_USAGE), paused ? 1 : 0, reason, pausedAt, new Date().toISOString());
            });
            return { paused, reason, pausedAt };
        },
        loadReputationHistory(repoFullName, apiBaseUrl) {
            const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
            const normalizedRepo = normalizeRepoFullName(repoFullName);
            const row = getReputationStatement.get(normalizedForge, normalizedRepo);
            if (!row)
                return { ...DEFAULT_REPUTATION_HISTORY };
            return { decided: row.decided, unfavorable: row.unfavorable };
        },
        saveReputationHistory(repoFullName, history, apiBaseUrl) {
            const normalizedForge = normalizeApiBaseUrl(apiBaseUrl);
            const normalizedRepo = normalizeRepoFullName(repoFullName);
            const decided = Number.isInteger(history?.decided) ? history.decided : 0;
            const unfavorable = Number.isInteger(history?.unfavorable) ? history.unfavorable : 0;
            upsertReputationStatement.run(normalizedForge, normalizedRepo, decided, unfavorable, new Date().toISOString());
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
            const rows = filter.repoFullName === undefined
                ? listSubmissionsAllStatement.all(limit)
                : listSubmissionsByRepoStatement.all(normalizeRepoFullName(filter.repoFullName), limit);
            return rows.map((row) => rowToSubmission(row));
        },
        /**
         * Delete every repo-scoped row for one repo across BOTH governor tables against this single open handle
         * (#7091) — the right-to-be-forgotten path `loopover-miner purge` invokes. `governor_reputation_history` is
         * purged on `repo_full_name` alone (its key is composite with `api_base_url`), so nothing survives on any
         * forge host. `governor_scalar_state` is deliberately untouched — it has no repo dimension. Returns the
         * total rows removed across both tables.
         */
        purgeByRepo(repoFullName) {
            const normalized = normalizeRepoFullName(repoFullName);
            return (purgeStoreByRepo(db, GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, normalized) +
                purgeStoreByRepo(db, GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC, normalized));
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
export function loadPauseState() {
    return getDefaultGovernorState().loadPauseState();
}
export function savePauseState(pauseState) {
    return getDefaultGovernorState().savePauseState(pauseState);
}
export function loadReputationHistory(repoFullName, apiBaseUrl) {
    return getDefaultGovernorState().loadReputationHistory(repoFullName, apiBaseUrl);
}
export function saveReputationHistory(repoFullName, history, apiBaseUrl) {
    return getDefaultGovernorState().saveReputationHistory(repoFullName, history, apiBaseUrl);
}
export function recordOwnSubmission(record) {
    return getDefaultGovernorState().recordOwnSubmission(record);
}
export function listRecentOwnSubmissions(filter) {
    return getDefaultGovernorState().listRecentOwnSubmissions(filter);
}
export function closeDefaultGovernorState() {
    if (!defaultGovernorState)
        return;
    defaultGovernorState.close();
    defaultGovernorState = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3Itc3RhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1zdGF0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFRQSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUN6RCxPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUN4RyxPQUFPLEVBQ0wsbUNBQW1DLEVBQ25DLHNDQUFzQyxFQUN0QyxnQkFBZ0IsR0FDakIsTUFBTSx3QkFBd0IsQ0FBQztBQXdGaEMsTUFBTSxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztBQUNuRCxNQUFNLDBCQUEwQixHQUF3QyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNuSCxNQUFNLDBCQUEwQixHQUF5QyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQzNGLE1BQU0saUJBQWlCLEdBQStCLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRSxXQUFXLEVBQUUsQ0FBQyxFQUFFLFVBQVUsRUFBRSxDQUFDLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDckgsTUFBTSwwQkFBMEIsR0FBaUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLE9BQU8sRUFBRSxDQUFDLEVBQUUsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDL0csSUFBSSxvQkFBb0IsR0FBeUIsSUFBSSxDQUFDO0FBRXRELE1BQU0sVUFBVSwwQkFBMEIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUM5RixPQUFPLHVCQUF1QixDQUFDLGlCQUFpQixFQUFFLGtDQUFrQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQzdGLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxNQUFpQztJQUN4RCxPQUFP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