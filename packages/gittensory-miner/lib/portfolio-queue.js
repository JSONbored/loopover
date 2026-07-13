import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";

// The miner's local portfolio/queue store (#2292): a 100% client-side, prioritized backlog of candidate work
// items across every repo the miner has been pointed at ("what should I look at next, across everything I'm
// tracking"). The database only lives on this machine; this module never uploads, syncs, or phones home with its
// contents. The `priority` field is a PLACEHOLDER numeric input in this foundation phase — later phases populate
// it from the extracted reward-risk/scoring modules in `gittensory-engine`; it is not invented here.

export const QUEUE_STATUSES = Object.freeze(["queued", "in_progress", "done"]);

const defaultDbFileName = "portfolio-queue.sqlite3";
let defaultPortfolioQueueStore = null;

export function resolvePortfolioQueueDbPath(env = process.env) {
  return resolveLocalStoreDbPath(defaultDbFileName, "GITTENSORY_MINER_PORTFOLIO_QUEUE_DB", env);
}

function normalizeDbPath(dbPath) {
  return normalizeLocalStoreDbPath(dbPath, resolvePortfolioQueueDbPath(), "invalid_portfolio_queue_db_path");
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

/** Priority is a placeholder numeric input; an omitted priority defaults to 0, a non-finite or negative one is rejected. */
function normalizePriority(priority) {
  if (priority === undefined || priority === null) return 0;
  if (typeof priority !== "number" || !Number.isFinite(priority) || priority < 0) {
    throw new Error("invalid_priority");
  }
  return priority;
}

/** Optional forge host, scoping rows so two hosts serving the same owner/repo name never collide (#5563).
 *  Omitted/nullish → the github.com default, so every pre-existing single-forge caller is unaffected. */
function normalizeApiBaseUrl(apiBaseUrl) {
  if (apiBaseUrl === undefined || apiBaseUrl === null) return DEFAULT_FORGE_CONFIG.apiBaseUrl;
  if (typeof apiBaseUrl !== "string" || !apiBaseUrl.trim()) throw new Error("invalid_api_base_url");
  return apiBaseUrl.trim();
}

function rowToEntry(row) {
  return {
    apiBaseUrl: row.api_base_url,
    repoFullName: row.repo_full_name,
    identifier: row.identifier,
    priority: row.priority,
    status: row.status,
    enqueuedAt: row.enqueued_at,
  };
}

/** Lease-annotated projection of an in-flight row (adds `leasedAt`), consumed by the expiry sweep. Kept separate
 *  from `rowToEntry` so the base entry shape every existing caller relies on is unchanged. */
function rowToLeaseEntry(row) {
  return {
    apiBaseUrl: row.api_base_url,
    repoFullName: row.repo_full_name,
    identifier: row.identifier,
    status: row.status,
    leasedAt: row.leased_at ?? null,
  };
}

/**
 * Opens the local portfolio/queue store, creating the table on first use. Rows are ordered highest-priority-first
 * with an insertion-order tie-break: `priority DESC, enqueued_at ASC, rowid ASC` — the implicit `rowid` guarantees
 * FIFO order even when two items share a priority AND an `enqueued_at` timestamp. (#2292)
 */
export function initPortfolioQueueStore(dbPath = resolvePortfolioQueueDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  // openLocalStoreDb skips mkdir/chmod for the special in-memory path (':memory:'), which has no file on disk.
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS miner_portfolio_queue (
      repo_full_name TEXT NOT NULL,
      identifier TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
      enqueued_at TEXT NOT NULL,
      leased_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      reenqueues INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repo_full_name, identifier)
    )
  `);
  // `leased_at` records when an item was flipped to 'in_progress', so a crashed/killed process's stuck lease can be
  // swept back to 'queued' by age (see portfolio-queue-expiry.js) instead of stranding the item forever — the same
  // recovery the claim-ledger and worktree-allocator stores already provide for their own tables (#4827). Additive
  // migration for stores created before this column: CREATE TABLE IF NOT EXISTS never adds a column to a pre-existing
  // table, so add it idempotently. Expressed as the store's first schema migration (#4832): the baseline table is
  // version 1; migration 1→2 adds `leased_at`. The migration stays defensive (checks table_info) so a version-0
  // file that already ran the pre-convention ad-hoc ALTER is not re-altered into a duplicate-column error.
  //
  // v2 -> v3 (#5563): rebuild PRIMARY KEY (repo_full_name, identifier) into PRIMARY KEY (api_base_url,
  // repo_full_name, identifier) -- two forge hosts serving a same-named owner/repo must not collide in this
  // queue. SQLite cannot ALTER a PRIMARY KEY in place, so this rebuilds the table: create the new shape, copy
  // every existing row with the pre-#4784 implicit single-forge default backfilled, drop the old table, rename
  // the new one in.
  //
  // v3 -> v4 (#5654): add the attempt-history counters (attempts/consecutive_failures/reenqueues) the
  // non-convergence detector needs. non-convergence.ts's own header names THIS table as their home ("belongs
  // on the portfolio-queue table once it grows attempt-history columns"); until now buildAttemptGovernorContext
  // could only feed the Governor a zero literal. Additive ALTERs (same defensive table_info guard as leased_at),
  // so a pre-existing v3 file backfills every row to 0 without a rebuild.
  applySchemaMigrations(db, [
    (migrationDb) => {
      const hasLeasedAtColumn = migrationDb
        .prepare("PRAGMA table_info(miner_portfolio_queue)")
        .all()
        .some((column) => column.name === "leased_at");
      if (!hasLeasedAtColumn) migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN leased_at TEXT");
    },
    (migrationDb) => {
      migrationDb.exec(`
        CREATE TABLE miner_portfolio_queue_v3 (
          api_base_url TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          identifier TEXT NOT NULL,
          priority REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'done')),
          enqueued_at TEXT NOT NULL,
          leased_at TEXT,
          PRIMARY KEY (api_base_url, repo_full_name, identifier)
        )
      `);
      // ORDER BY rowid preserves the old table's FIFO insertion order in the new table's freshly-assigned rowids
      // (the composite PRIMARY KEY above is not itself the rowid), so this rebuild doesn't reshuffle queue order.
      // OR IGNORE: a row this store's own read path already treats as unusable garbage (an unrecognized
      // `status`, e.g. from a hand-edited or otherwise corrupted file) would violate the CHECK constraint above
      // and abort the whole migration. Skipping it here is consistent with that same fail-closed posture, rather
      // than turning one bad row into a permanently unmigratable file.
      migrationDb
        .prepare(
          `INSERT OR IGNORE INTO miner_portfolio_queue_v3
             (api_base_url, repo_full_name, identifier, priority, status, enqueued_at, leased_at)
           SELECT ?, repo_full_name, identifier, priority, status, enqueued_at, leased_at
           FROM miner_portfolio_queue ORDER BY rowid`,
        )
        .run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
      migrationDb.exec("DROP TABLE miner_portfolio_queue");
      migrationDb.exec("ALTER TABLE miner_portfolio_queue_v3 RENAME TO miner_portfolio_queue");
    },
    (migrationDb) => {
      const columns = migrationDb
        .prepare("PRAGMA table_info(miner_portfolio_queue)")
        .all()
        .map((column) => column.name);
      // Defensive per-column guard (same posture as the leased_at migration): a file that already ran an
      // ad-hoc ALTER, or a fresh store whose CREATE TABLE above already carries these columns, is not
      // re-altered into a duplicate-column error.
      if (!columns.includes("attempts")) {
        migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.includes("consecutive_failures")) {
        migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.includes("reenqueues")) {
        migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN reenqueues INTEGER NOT NULL DEFAULT 0");
      }
    },
  ]);

  // `rowid` is a stable, unique key assigned once at first insert (re-enqueue updates in place, never re-inserts),
  // so it is a deterministic total-order tie-break: two items sharing a priority AND an `enqueued_at` timestamp
  // still order by insertion.
  const ORDER = "ORDER BY priority DESC, enqueued_at ASC, rowid ASC";
  // Re-enqueueing an already-tracked item re-activates it IN PLACE: refresh its (placeholder) priority and reset it
  // to 'queued', but KEEP the original `enqueued_at` and `rowid` so it holds its existing FIFO position rather than
  // jumping the queue. (Restamping `enqueued_at` would be inconsistent — the fixed `rowid` still pins the old
  // position whenever timestamps collide — so position is deliberately preserved instead.)
  const enqueueStatement = db.prepare(`
    INSERT INTO miner_portfolio_queue (api_base_url, repo_full_name, identifier, priority, status, enqueued_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
    ON CONFLICT(api_base_url, repo_full_name, identifier) DO UPDATE SET
      priority = excluded.priority,
      status = 'queued'
    WHERE miner_portfolio_queue.status <> 'in_progress'
  `);
  const getStatement = db.prepare(
    "SELECT * FROM miner_portfolio_queue WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ?",
  );
  // Claim the highest-priority queued item ATOMICALLY: one UPDATE selects the ordered top row in a subquery and
  // flips it to 'in_progress', RETURNING it — so two processes sharing the file can't both claim the same row (a
  // separate SELECT-then-UPDATE would race). Deliberately global (no api_base_url filter): the queue is a single
  // cross-host priority ordering, not a per-host one.
  // Claiming stamps `leased_at` with the caller-supplied claim time; leaving 'in_progress' (done/failed/reclaim)
  // clears it back to NULL so only genuinely in-flight rows carry a lease.
  // Claiming a row is one attempt on that item (#5654): every queued -> in_progress transition bumps the
  // attempts counter the non-convergence detector reads.
  const dequeueStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'in_progress', leased_at = ?, attempts = attempts + 1
    WHERE rowid = (
      SELECT rowid FROM miner_portfolio_queue WHERE status = 'queued' ${ORDER} LIMIT 1
    )
    RETURNING *
  `);
  // RETURNING (rather than a separate post-UPDATE SELECT) makes the "nothing to mark done" case observable
  // directly from one atomic statement.
  // Reaching 'done' is progress, so it resets the consecutive-failure streak to 0 (#5654) -- the detector's
  // "reset to 0 on any progress" rule. attempts/reenqueues are cumulative and left intact.
  const markDoneStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'done', leased_at = NULL, consecutive_failures = 0
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status <> 'done'
    RETURNING *
  `);
  // An in_progress -> queued transition is a failed-and-re-enqueued attempt (#5654): bump BOTH the reenqueue
  // total and the consecutive-failure streak. markDone resets the streak; nothing else does.
  const markFailedStatement = db.prepare(`
    UPDATE miner_portfolio_queue
      SET status = 'queued', leased_at = NULL, reenqueues = reenqueues + 1, consecutive_failures = consecutive_failures + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'in_progress'
    RETURNING *
  `);
  const listAllStatement = db.prepare(`SELECT * FROM miner_portfolio_queue ${ORDER}`);
  const listRepoStatement = db.prepare(
    `SELECT * FROM miner_portfolio_queue WHERE repo_full_name = ? ${ORDER}`,
  );
  const listActiveStatement = db.prepare(
    `SELECT * FROM miner_portfolio_queue WHERE status IN ('queued', 'in_progress') ${ORDER}`,
  );
  const listInProgressStatement = db.prepare(
    `SELECT * FROM miner_portfolio_queue WHERE status = 'in_progress' ${ORDER}`,
  );
  // Reclaiming a stuck lease is the same in_progress -> queued failure transition as markFailed, so it moves
  // the same two counters (#5654) -- a crashed attempt that stranded its lease still counts as a failed re-enqueue.
  const reclaimStatement = db.prepare(`
    UPDATE miner_portfolio_queue
      SET status = 'queued', leased_at = NULL, reenqueues = reenqueues + 1, consecutive_failures = consecutive_failures + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'in_progress'
    RETURNING *
  `);
  // Requeue only ever targets a COMPLETED ('done') row — an in-flight item is released via reclaimStatement, and
  // an already-'queued' item is a no-op — so a caller's manual requeue can never disturb an active claim. The
  // row keeps its rowid/enqueued_at, so it re-enters the queue at its original FIFO position, not the back.
  const requeueStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'queued', leased_at = NULL
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'done'
    RETURNING *
  `);
  // batchClaim's per-target claim is also a queued -> in_progress attempt, so it bumps attempts too (#5654),
  // keeping the counter consistent across both the single-item (dequeueNext) and batch claim paths.
  const claimTargetStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'in_progress', leased_at = ?, attempts = attempts + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'queued'
    RETURNING *
  `);
  // Read-only projection of one item's attempt-history into the engine's PortfolioConvergenceInput shape.
  const convergenceStatement = db.prepare(
    `SELECT attempts, consecutive_failures, reenqueues, status
       FROM miner_portfolio_queue WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ?`,
  );

  return {
    dbPath: resolvedPath,
    enqueue(item) {
      const apiBaseUrl = normalizeApiBaseUrl(item?.apiBaseUrl);
      const repoFullName = normalizeRepoFullName(item?.repoFullName);
      const identifier = normalizeIdentifier(item?.identifier);
      const priority = normalizePriority(item?.priority);
      const enqueuedAt = new Date().toISOString();
      enqueueStatement.run(apiBaseUrl, repoFullName, identifier, priority, enqueuedAt);
      return rowToEntry(getStatement.get(apiBaseUrl, repoFullName, identifier));
    },
    dequeueNext() {
      const row = dequeueStatement.get(new Date().toISOString());
      return row ? rowToEntry(row) : null;
    },
    /** In-flight ('in_progress') rows with their `leasedAt` claim time, for the expiry sweep (#4827). */
    listInProgress() {
      return listInProgressStatement.all().map(rowToLeaseEntry);
    },
    /** Reclaim a single stuck in-flight item back to 'queued' (clearing its lease), returning it — or null if it is
     *  no longer 'in_progress' (already finished/reclaimed by another sweep). The sweep target of #4827. */
    reclaimStuckItem(repoFullName, identifier, apiBaseUrl) {
      const row = reclaimStatement.get(
        normalizeApiBaseUrl(apiBaseUrl),
        normalizeRepoFullName(repoFullName),
        normalizeIdentifier(identifier),
      );
      return row ? rowToEntry(row) : null;
    },
    /** Requeue a COMPLETED ('done') item back to 'queued' so it is picked up again, keeping its FIFO position
     *  (rowid/enqueued_at unchanged). Returns the entry, or null when there is no 'done' item to requeue — i.e.
     *  it is already 'queued', is currently 'in_progress' (release it via {@link reclaimStuckItem} instead), or
     *  does not exist. The manual counterpart to {@link reclaimStuckItem} for the queue CLI's escape hatch (#4828). */
    requeueItem(repoFullName, identifier, apiBaseUrl) {
      const row = requeueStatement.get(
        normalizeApiBaseUrl(apiBaseUrl),
        normalizeRepoFullName(repoFullName),
        normalizeIdentifier(identifier),
      );
      return row ? rowToEntry(row) : null;
    },
    listQueue(repoFullName) {
      const rows = repoFullName === undefined || repoFullName === null
        ? listAllStatement.all()
        : listRepoStatement.all(normalizeRepoFullName(repoFullName));
      return rows.map(rowToEntry);
    },
    /**
     * One item's attempt-history as the engine's `PortfolioConvergenceInput` (#5654), for feeding
     * classifyPortfolioConvergence / the Governor chokepoint. A never-tracked item (no such row) reads the
     * honest zero literal — `attempts: 0` — which the detector treats as "no attempts yet, converging", the
     * same safe under-estimate buildAttemptGovernorContext used before this became real. `reachedDone` is the
     * item's current terminal status, per the issue's `status === 'done'` definition.
     * @returns {import("@loopover/engine").PortfolioConvergenceInput}
     */
    readConvergenceInput(repoFullName, identifier, apiBaseUrl) {
      const row = convergenceStatement.get(
        normalizeApiBaseUrl(apiBaseUrl),
        normalizeRepoFullName(repoFullName),
        normalizeIdentifier(identifier),
      );
      if (!row) return { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };
      return {
        attempts: row.attempts,
        consecutiveFailures: row.consecutive_failures,
        reenqueues: row.reenqueues,
        reachedDone: row.status === "done",
      };
    },
    markDone(repoFullName, identifier, apiBaseUrl) {
      const row = markDoneStatement.get(
        normalizeApiBaseUrl(apiBaseUrl),
        normalizeRepoFullName(repoFullName),
        normalizeIdentifier(identifier),
      );
      return row ? rowToEntry(row) : null;
    },
    /** Release an in-flight item back to `queued` when a run halts (#2347). */
    markFailed(repoFullName, identifier, apiBaseUrl) {
      const row = markFailedStatement.get(
        normalizeApiBaseUrl(apiBaseUrl),
        normalizeRepoFullName(repoFullName),
        normalizeIdentifier(identifier),
      );
      return row ? rowToEntry(row) : null;
    },
    /**
     * Transactional caps-aware batch claim hook used by portfolio-queue-manager.js: re-read active rows under an
     * exclusive lock, let the caller pick targets, then atomically flip each still-queued row to `in_progress`.
     */
    batchClaim(selectFn) {
      if (typeof selectFn !== "function") throw new Error("invalid_batch_claim_selector");
      db.exec("BEGIN IMMEDIATE");
      try {
        const entries = listActiveStatement.all().map(rowToEntry);
        const targets = selectFn(entries);
        if (!Array.isArray(targets)) throw new Error("invalid_batch_claim_selection");
        const leasedAt = new Date().toISOString();
        const claimed = [];
        for (const target of targets) {
          const apiBaseUrl = normalizeApiBaseUrl(target?.apiBaseUrl);
          const repoFullName = normalizeRepoFullName(target?.repoFullName);
          const identifier = normalizeIdentifier(target?.identifier);
          const row = claimTargetStatement.get(leasedAt, apiBaseUrl, repoFullName, identifier);
          if (row) claimed.push(rowToEntry(row));
        }
        db.exec("COMMIT");
        return claimed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
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

export function markDone(repoFullName, identifier, apiBaseUrl) {
  return getDefaultPortfolioQueueStore().markDone(repoFullName, identifier, apiBaseUrl);
}

export function markFailed(repoFullName, identifier, apiBaseUrl) {
  return getDefaultPortfolioQueueStore().markFailed(repoFullName, identifier, apiBaseUrl);
}

/**
 * Read one issue's convergence input from the default portfolio-queue store, keyed by the miner's
 * `issue:<number>` identifier convention (portfolio-discovery.js). `apiBaseUrl` defaults to the github.com
 * host (the single-forge default); an issue tracked under a different forge that isn't in this store reads the
 * honest zero literal — an under-estimate that fails toward letting the attempt through (see
 * attempt-input-builder.js), never a fabricated "clean" history. The attempt pipeline's read hook (#5654).
 * @returns {import("@loopover/engine").PortfolioConvergenceInput}
 */
export function readConvergenceInputForIssue(repoFullName, issueNumber, apiBaseUrl) {
  return getDefaultPortfolioQueueStore().readConvergenceInput(repoFullName, `issue:${issueNumber}`, apiBaseUrl);
}

export function closeDefaultPortfolioQueueStore() {
  if (!defaultPortfolioQueueStore) return;
  defaultPortfolioQueueStore.close();
  defaultPortfolioQueueStore = null;
}
