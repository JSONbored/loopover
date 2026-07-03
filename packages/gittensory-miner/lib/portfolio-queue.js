import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The miner's local portfolio/queue store (#2292): a 100% client-side, prioritized backlog of candidate work
// items across every repo the miner has been pointed at ("what should I look at next, across everything I'm
// tracking"). The database only lives on this machine; this module never uploads, syncs, or phones home with its
// contents. The `priority` field is a PLACEHOLDER numeric input in this foundation phase — later phases populate
// it from the extracted reward-risk/scoring modules in `gittensory-engine`; it is not invented here.

export const QUEUE_STATUSES = Object.freeze(["queued", "in_progress", "done"]);

const defaultDbFileName = "portfolio-queue.sqlite3";
let defaultPortfolioQueueStore = null;

export function resolvePortfolioQueueDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_PORTFOLIO_QUEUE_DB === "string"
    ? env.GITTENSORY_MINER_PORTFOLIO_QUEUE_DB.trim()
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
  const raw = dbPath ?? resolvePortfolioQueueDbPath();
  if (typeof raw !== "string" || !raw.trim()) throw new Error("invalid_portfolio_queue_db_path");
  return raw.trim();
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const trimmed = repoFullName.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeIdentifier(identifier) {
  if (typeof identifier !== "string") throw new Error("invalid_identifier");
  const trimmed = identifier.trim();
  if (!trimmed) throw new Error("invalid_identifier");
  return trimmed;
}

/** Priority is a placeholder numeric input; an omitted priority defaults to 0, a non-finite one is rejected. */
function normalizePriority(priority) {
  if (priority === undefined) return 0;
  if (typeof priority !== "number" || !Number.isFinite(priority)) throw new Error("invalid_priority");
  return priority;
}

function rowToEntry(row) {
  return {
    repoFullName: row.repo_full_name,
    identifier: row.identifier,
    priority: row.priority,
    status: row.status,
    enqueuedAt: row.enqueued_at,
  };
}

/**
 * Opens the local portfolio/queue store, creating the table on first use. Rows are ordered highest-priority-first
 * with an insertion-order tie-break: `priority DESC, enqueued_at ASC, rowid ASC` — the implicit `rowid` guarantees
 * FIFO order even when two items share a priority AND an `enqueued_at` timestamp. (#2292)
 */
export function initPortfolioQueueStore(dbPath = resolvePortfolioQueueDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  // The store is a persistent local file; the special in-memory path (':memory:') has no file to create or chmod.
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(resolvedPath);
  if (resolvedPath !== ":memory:") chmodSync(resolvedPath, 0o600);
  // Wait (rather than fail) for a concurrent writer's lock so two queue instances on the same file serialize.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS miner_portfolio_queue (
      repo_full_name TEXT NOT NULL,
      identifier TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
      enqueued_at TEXT NOT NULL,
      PRIMARY KEY (repo_full_name, identifier)
    )
  `);

  // `rowid` is a stable, unique key assigned once at first insert (re-enqueue updates in place, never re-inserts),
  // so it is a deterministic total-order tie-break: two items sharing a priority AND an `enqueued_at` timestamp
  // still order by insertion.
  const ORDER = "ORDER BY priority DESC, enqueued_at ASC, rowid ASC";
  // Re-enqueueing an already-tracked item re-activates it IN PLACE: refresh its (placeholder) priority and reset it
  // to 'queued', but KEEP the original `enqueued_at` and `rowid` so it holds its existing FIFO position rather than
  // jumping the queue. (Restamping `enqueued_at` would be inconsistent — the fixed `rowid` still pins the old
  // position whenever timestamps collide — so position is deliberately preserved instead.)
  const enqueueStatement = db.prepare(`
    INSERT INTO miner_portfolio_queue (repo_full_name, identifier, priority, status, enqueued_at)
    VALUES (?, ?, ?, 'queued', ?)
    ON CONFLICT(repo_full_name, identifier) DO UPDATE SET
      priority = excluded.priority,
      status = 'queued'
  `);
  const getStatement = db.prepare(
    "SELECT * FROM miner_portfolio_queue WHERE repo_full_name = ? AND identifier = ?",
  );
  // Claim the highest-priority queued item ATOMICALLY: one UPDATE selects the ordered top row in a subquery and
  // flips it to 'in_progress', RETURNING it — so two processes sharing the file can't both claim the same row (a
  // separate SELECT-then-UPDATE would race).
  const dequeueStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'in_progress'
    WHERE rowid = (
      SELECT rowid FROM miner_portfolio_queue WHERE status = 'queued' ${ORDER} LIMIT 1
    )
    RETURNING *
  `);
  const setStatusStatement = db.prepare(
    "UPDATE miner_portfolio_queue SET status = ? WHERE repo_full_name = ? AND identifier = ?",
  );
  const listAllStatement = db.prepare(`SELECT * FROM miner_portfolio_queue ${ORDER}`);
  const listRepoStatement = db.prepare(
    `SELECT * FROM miner_portfolio_queue WHERE repo_full_name = ? ${ORDER}`,
  );

  return {
    dbPath: resolvedPath,
    enqueue(item) {
      const repoFullName = normalizeRepoFullName(item?.repoFullName);
      const identifier = normalizeIdentifier(item?.identifier);
      const priority = normalizePriority(item?.priority);
      const enqueuedAt = new Date().toISOString();
      enqueueStatement.run(repoFullName, identifier, priority, enqueuedAt);
      return rowToEntry(getStatement.get(repoFullName, identifier));
    },
    dequeueNext() {
      const row = dequeueStatement.get();
      return row ? rowToEntry(row) : null;
    },
    listQueue(repoFullName) {
      const rows = repoFullName === undefined
        ? listAllStatement.all()
        : listRepoStatement.all(normalizeRepoFullName(repoFullName));
      return rows.map(rowToEntry);
    },
    markDone(repoFullName, identifier) {
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const normalizedIdentifier = normalizeIdentifier(identifier);
      setStatusStatement.run("done", normalizedRepo, normalizedIdentifier);
      const row = getStatement.get(normalizedRepo, normalizedIdentifier);
      return row ? rowToEntry(row) : null;
    },
    close() {
      db.close();
    },
  };
}

function getDefaultPortfolioQueueStore() {
  defaultPortfolioQueueStore ??= initPortfolioQueueStore();
  return defaultPortfolioQueueStore;
}

export function enqueue(item) {
  return getDefaultPortfolioQueueStore().enqueue(item);
}

export function dequeueNext() {
  return getDefaultPortfolioQueueStore().dequeueNext();
}

export function listQueue(repoFullName) {
  return getDefaultPortfolioQueueStore().listQueue(repoFullName);
}

export function markDone(repoFullName, identifier) {
  return getDefaultPortfolioQueueStore().markDone(repoFullName, identifier);
}

export function closeDefaultPortfolioQueueStore() {
  if (!defaultPortfolioQueueStore) return;
  defaultPortfolioQueueStore.close();
  defaultPortfolioQueueStore = null;
}
