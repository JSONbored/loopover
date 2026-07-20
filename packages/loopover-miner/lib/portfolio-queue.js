import { DEFAULT_FORGE_CONFIG } from "./forge-config.js";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";
import { PORTFOLIO_QUEUE_PURGE_SPEC, purgeStoreByRepo } from "./store-maintenance.js";
export const QUEUE_STATUSES = Object.freeze(["queued", "in_progress", "done"]);
const defaultDbFileName = "portfolio-queue.sqlite3";
let defaultPortfolioQueueStore = null;
export function resolvePortfolioQueueDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_PORTFOLIO_QUEUE_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolvePortfolioQueueDbPath(), "invalid_portfolio_queue_db_path");
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const trimmed = repoFullName.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeIdentifier(identifier) {
    if (typeof identifier !== "string")
        throw new Error("invalid_identifier");
    const trimmed = identifier.trim();
    if (!trimmed)
        throw new Error("invalid_identifier");
    return trimmed;
}
/** Priority is a placeholder numeric input; an omitted priority defaults to 0, a non-finite or negative one is rejected. */
function normalizePriority(priority) {
    if (priority === undefined || priority === null)
        return 0;
    if (typeof priority !== "number" || !Number.isFinite(priority) || priority < 0) {
        throw new Error("invalid_priority");
    }
    return priority;
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
function asPortfolioQueueDbRow(row) {
    return row;
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
    applySchemaMigrations(db, [
        (migrationDb) => {
            const hasLeasedAtColumn = migrationDb
                .prepare("PRAGMA table_info(miner_portfolio_queue)")
                .all()
                .some((column) => column.name === "leased_at");
            if (!hasLeasedAtColumn)
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN leased_at TEXT");
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
                .prepare(`INSERT OR IGNORE INTO miner_portfolio_queue_v3
             (api_base_url, repo_full_name, identifier, priority, status, enqueued_at, leased_at)
           SELECT ?, repo_full_name, identifier, priority, status, enqueued_at, leased_at
           FROM miner_portfolio_queue ORDER BY rowid`)
                .run(DEFAULT_FORGE_CONFIG.apiBaseUrl);
            migrationDb.exec("DROP TABLE miner_portfolio_queue");
            migrationDb.exec("ALTER TABLE miner_portfolio_queue_v3 RENAME TO miner_portfolio_queue");
        },
        // v3 -> v4 (#5654): three attempt-history counters feeding non-convergence.ts's real
        // PortfolioConvergenceInput (see getAttemptHistory below) -- additive columns, same
        // defensive column-presence guard as the leased_at migration above.
        (migrationDb) => {
            const existingColumns = migrationDb
                .prepare("PRAGMA table_info(miner_portfolio_queue)")
                .all()
                .map((column) => column.name);
            if (!existingColumns.includes("attempts_count")) {
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN attempts_count INTEGER NOT NULL DEFAULT 0");
            }
            if (!existingColumns.includes("consecutive_failures")) {
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
            }
            if (!existingColumns.includes("reenqueue_count")) {
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN reenqueue_count INTEGER NOT NULL DEFAULT 0");
            }
        },
        // v4 -> v5 (#4939): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of this
        // same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing reads
        // or writes it yet (no consumer exists until a future hosted deployment populates it). Same defensive
        // column-presence guard as the v3->v4 migration immediately above.
        (migrationDb) => {
            const hasTenantIdColumn = migrationDb
                .prepare("PRAGMA table_info(miner_portfolio_queue)")
                .all()
                .some((column) => column.name === "tenant_id");
            if (!hasTenantIdColumn)
                migrationDb.exec("ALTER TABLE miner_portfolio_queue ADD COLUMN tenant_id TEXT");
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
    const getStatement = db.prepare("SELECT * FROM miner_portfolio_queue WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ?");
    // Claim the highest-priority queued item ATOMICALLY: one UPDATE selects the ordered top row in a subquery and
    // flips it to 'in_progress', RETURNING it — so two processes sharing the file can't both claim the same row (a
    // separate SELECT-then-UPDATE would race). Deliberately global (no api_base_url filter): the queue is a single
    // cross-host priority ordering, not a per-host one.
    // Claiming stamps `leased_at` with the caller-supplied claim time and increments the attempt-history
    // `attempts_count` (#5654, non-convergence.ts's real PortfolioConvergenceInput.attempts) -- leaving
    // 'in_progress' (done/failed/reclaim) clears leased_at back to NULL so only genuinely in-flight rows carry
    // a lease.
    const dequeueStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'in_progress', leased_at = ?, attempts_count = attempts_count + 1
    WHERE rowid = (
      SELECT rowid FROM miner_portfolio_queue WHERE status = 'queued' ${ORDER} LIMIT 1
    )
    RETURNING *
  `);
    // RETURNING (rather than a separate post-UPDATE SELECT) makes the "nothing to mark done" case observable
    // directly from one atomic statement. consecutive_failures resets to 0 on reaching done (#5654) -- the
    // active failure streak breaks the moment an attempt actually succeeds; reenqueue_count is a lifetime
    // total and deliberately untouched here (see getAttemptHistory's own doc comment).
    const markDoneStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'done', leased_at = NULL, consecutive_failures = 0
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status <> 'done'
    RETURNING *
  `);
    // Releasing an in-flight item back to queued WITHOUT reaching done is exactly non-convergence.ts's own
    // "cycling queued -> in_progress -> queued without ever reaching done" reenqueue trigger (#5654) -- same
    // counters, same increment, as reclaimStuckItem below (both are this same transition, just different
    // callers: a run-halt release here vs. a stale-lease sweep there).
    const markFailedStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'queued', leased_at = NULL,
      consecutive_failures = consecutive_failures + 1, reenqueue_count = reenqueue_count + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'in_progress'
    RETURNING *
  `);
    const listAllStatement = db.prepare(`SELECT * FROM miner_portfolio_queue ${ORDER}`);
    const listRepoStatement = db.prepare(`SELECT * FROM miner_portfolio_queue WHERE repo_full_name = ? ${ORDER}`);
    const listActiveStatement = db.prepare(`SELECT * FROM miner_portfolio_queue WHERE status IN ('queued', 'in_progress') ${ORDER}`);
    const listInProgressStatement = db.prepare(`SELECT * FROM miner_portfolio_queue WHERE status = 'in_progress' ${ORDER}`);
    // A stale-lease sweep release is the SAME "in_progress -> queued without reaching done" event as
    // markFailedStatement above (#5654) -- same counters, same increment.
    const reclaimStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'queued', leased_at = NULL,
      consecutive_failures = consecutive_failures + 1, reenqueue_count = reenqueue_count + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'in_progress'
    RETURNING *
  `);
    // Requeue only ever targets a COMPLETED ('done') row — an in-flight item is released via reclaimStatement, and
    // an already-'queued' item is a no-op — so a caller's manual requeue can never disturb an active claim. The
    // row keeps its rowid/enqueued_at, so it re-enters the queue at its original FIFO position, not the back.
    // Deliberately leaves attempts_count/consecutive_failures/reenqueue_count untouched (#5654): this is a
    // manual reopen of ALREADY-COMPLETED work, not the stuck queued->in_progress->queued cycle those counters
    // track -- reachedDone (derived live from status) simply reads false again once requeued, same as any
    // other non-done row, until the item is claimed and completed again.
    const requeueStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'queued', leased_at = NULL
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'done'
    RETURNING *
  `);
    // Same attempts_count increment as dequeueStatement (#5654) -- batchClaim's per-item claim is just as much
    // a real attempt as the single-item dequeueNext path.
    const claimTargetStatement = db.prepare(`
    UPDATE miner_portfolio_queue SET status = 'in_progress', leased_at = ?, attempts_count = attempts_count + 1
    WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ? AND status = 'queued'
    RETURNING *
  `);
    const attemptHistoryStatement = db.prepare("SELECT attempts_count, consecutive_failures, reenqueue_count, status FROM miner_portfolio_queue WHERE api_base_url = ? AND repo_full_name = ? AND identifier = ?");
    return {
        dbPath: resolvedPath,
        enqueue(item) {
            const apiBaseUrl = normalizeApiBaseUrl(item?.apiBaseUrl);
            const repoFullName = normalizeRepoFullName(item?.repoFullName);
            const identifier = normalizeIdentifier(item?.identifier);
            const priority = normalizePriority(item?.priority);
            const enqueuedAt = new Date().toISOString();
            enqueueStatement.run(apiBaseUrl, repoFullName, identifier, priority, enqueuedAt);
            return rowToEntry(asPortfolioQueueDbRow(getStatement.get(apiBaseUrl, repoFullName, identifier)));
        },
        dequeueNext() {
            const row = dequeueStatement.get(new Date().toISOString());
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /** In-flight ('in_progress') rows with their `leasedAt` claim time, for the expiry sweep (#4827). */
        listInProgress() {
            return listInProgressStatement.all().map((row) => rowToLeaseEntry(asPortfolioQueueDbRow(row)));
        },
        /** Reclaim a single stuck in-flight item back to 'queued' (clearing its lease), returning it — or null if it is
         *  no longer 'in_progress' (already finished/reclaimed by another sweep). The sweep target of #4827. */
        reclaimStuckItem(repoFullName, identifier, apiBaseUrl) {
            const row = reclaimStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /** Requeue a COMPLETED ('done') item back to 'queued' so it is picked up again, keeping its FIFO position
         *  (rowid/enqueued_at unchanged). Returns the entry, or null when there is no 'done' item to requeue — i.e.
         *  it is already 'queued', is currently 'in_progress' (release it via {@link reclaimStuckItem} instead), or
         *  does not exist. The manual counterpart to {@link reclaimStuckItem} for the queue CLI's escape hatch (#4828). */
        requeueItem(repoFullName, identifier, apiBaseUrl) {
            const row = requeueStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        listQueue(repoFullName) {
            const rows = repoFullName === undefined || repoFullName === null
                ? listAllStatement.all()
                : listRepoStatement.all(normalizeRepoFullName(repoFullName));
            return rows.map((row) => rowToEntry(asPortfolioQueueDbRow(row)));
        },
        markDone(repoFullName, identifier, apiBaseUrl) {
            const row = markDoneStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /** Release an in-flight item back to `queued` when a run halts (#2347). */
        markFailed(repoFullName, identifier, apiBaseUrl) {
            const row = markFailedStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            return row ? rowToEntry(asPortfolioQueueDbRow(row)) : null;
        },
        /**
         * Transactional caps-aware batch claim hook used by portfolio-queue-manager.js: re-read active rows under an
         * exclusive lock, let the caller pick targets, then atomically flip each still-queued row to `in_progress`.
         */
        batchClaim(selectFn) {
            if (typeof selectFn !== "function")
                throw new Error("invalid_batch_claim_selector");
            db.exec("BEGIN IMMEDIATE");
            try {
                const entries = listActiveStatement.all().map((row) => rowToEntry(asPortfolioQueueDbRow(row)));
                const targets = selectFn(entries);
                if (!Array.isArray(targets))
                    throw new Error("invalid_batch_claim_selection");
                const leasedAt = new Date().toISOString();
                const claimed = [];
                for (const target of targets) {
                    const apiBaseUrl = normalizeApiBaseUrl(target?.apiBaseUrl);
                    const repoFullName = normalizeRepoFullName(target?.repoFullName);
                    const identifier = normalizeIdentifier(target?.identifier);
                    const row = claimTargetStatement.get(leasedAt, apiBaseUrl, repoFullName, identifier);
                    if (row)
                        claimed.push(rowToEntry(asPortfolioQueueDbRow(row)));
                }
                db.exec("COMMIT");
                return claimed;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        /**
         * A real `PortfolioConvergenceInput` (non-convergence.ts) for one queue item (#5654), replacing the
         * first-attempt-shaped literal attempt-input-builder.js previously hardcoded. An item never enqueued here
         * (not yet tracked at all) reads the same honest zero-state as a genuine first attempt -- absence of
         * history is not evidence of a problem, same rule non-convergence.ts's own header documents. `reachedDone`
         * is derived live from the row's current `status`, not a separate persisted flag (see requeueStatement's
         * comment above for why that's the deliberate choice).
         */
        getAttemptHistory(repoFullName, identifier, apiBaseUrl) {
            const row = attemptHistoryStatement.get(normalizeApiBaseUrl(apiBaseUrl), normalizeRepoFullName(repoFullName), normalizeIdentifier(identifier));
            if (!row)
                return { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };
            const historyRow = asPortfolioQueueDbRow(row);
            return {
                attempts: historyRow.attempts_count,
                consecutiveFailures: historyRow.consecutive_failures,
                reenqueues: historyRow.reenqueue_count,
                reachedDone: historyRow.status === "done",
            };
        },
        // Explicit, operator-invoked right-to-be-forgotten purge (#5564, #6599) — never runs automatically.
        purgeByRepo(repoFullName) {
            return purgeStoreByRepo(db, PORTFOLIO_QUEUE_PURGE_SPEC, normalizeRepoFullName(repoFullName));
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
export function getAttemptHistory(repoFullName, identifier, apiBaseUrl) {
    return getDefaultPortfolioQueueStore().getAttemptHistory(repoFullName, identifier, apiBaseUrl);
}
export function closeDefaultPortfolioQueueStore() {
    if (!defaultPortfolioQueueStore)
        return;
    defaultPortfolioQueueStore.close();
    defaultPortfolioQueueStore = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLXF1ZXVlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicG9ydGZvbGlvLXF1ZXVlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ3pELE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxnQkFBZ0IsRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ3hHLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQzVELE9BQU8sRUFBRSwwQkFBMEIsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBa0Z0RixNQUFNLENBQUMsTUFBTSxjQUFjLEdBQTJCLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxRQUFRLEVBQUUsYUFBYSxFQUFFLE1BQU0sQ0FBVSxDQUFDLENBQUM7QUFFaEgsTUFBTSxpQkFBaUIsR0FBRyx5QkFBeUIsQ0FBQztBQUNwRCxJQUFJLDBCQUEwQixHQUErQixJQUFJLENBQUM7QUFFbEUsTUFBTSxVQUFVLDJCQUEyQixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQy9GLE9BQU8sdUJBQXVCLENBQUMsaUJBQWlCLEVBQUUsbUNBQW1DLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDOUYsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLE1BQWM7SUFDckMsT0FBTyx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsMkJBQTJCLEVBQUUsRUFBRSxpQ0FBaUMsQ0FBQyxDQUFDO0FBQzdHLENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFDLFlBQXFCO0lBQ2xELElBQUksT0FBTyxZQUFZLEtBQUssUUFBUTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUNoRixNQUFNLE9BQU8sR0FBRyxZQUFZLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDcEMsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVB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