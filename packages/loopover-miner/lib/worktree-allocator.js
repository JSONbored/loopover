// mkdirSync is still needed for the git-worktree CHECKOUT dirs below (resolveWorktreeBaseDir's tree) — that is
// a filesystem directory, not a store DB path, and is deliberately out of this migration's scope. Only the DB
// handle's own mkdir/chmod moved into openLocalStoreDb.
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";
const defaultDbFileName = "worktree-allocator.sqlite3";
const defaultWorktreeDirName = "worktrees";
const defaultMaxConcurrency = 2;
let defaultWorktreeAllocator = null;
// Age-based orphan reclaim (#7085). Fleet mode (see DEPLOYMENT.md) runs multiple separate CONTAINERS over one
// shared data volume, each with its own PID namespace, so a stored `owner_pid` is meaningless the moment a
// different container opens this store — `isProcessAlive` checks the CALLING process's own namespace, not the
// one that recorded the pid. So we mirror the age-based convention every sibling shared-lease store already uses
// (portfolio-queue-expiry.js's DEFAULT_MAX_LEASE_MS / sweepStuckItems, claim-ledger's DEFAULT_MAX_CLAIM_AGE_MS):
// reclaim any `active` slot older than this regardless of what the pid check reports. Kept well above
// portfolio-queue-expiry's 30-minute floor because a single worktree lease spans a whole coding attempt (clone +
// agent run + push), which can legitimately run for hours; the same-host `isProcessAlive` fast path still frees a
// crashed local owner immediately, so this age fallback only ever governs the cross-container case.
export const DEFAULT_MAX_LEASE_MS = 6 * 60 * 60 * 1000;
export function resolveWorktreeAllocatorDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB", env);
}
export function resolveWorktreeBaseDir(env = process.env) {
    const explicitPath = typeof env.LOOPOVER_MINER_WORKTREE_DIR === "string"
        ? env.LOOPOVER_MINER_WORKTREE_DIR.trim()
        : "";
    if (explicitPath)
        return explicitPath;
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return join(explicitConfigDir, defaultWorktreeDirName);
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner", defaultWorktreeDirName);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveWorktreeAllocatorDbPath(), "invalid_worktree_allocator_db_path");
}
function normalizeWorktreeBaseDir(worktreeBaseDir) {
    const path = (worktreeBaseDir ?? resolveWorktreeBaseDir()).trim();
    if (!path)
        throw new Error("invalid_worktree_base_dir");
    return path;
}
function normalizeMaxConcurrency(value) {
    if (value === undefined || value === null)
        return defaultMaxConcurrency;
    if (!Number.isInteger(value) || value < 1)
        throw new Error("invalid_max_concurrency");
    return value;
}
function normalizeMaxLeaseMs(value) {
    if (value === undefined || value === null)
        return DEFAULT_MAX_LEASE_MS;
    if (!Number.isFinite(value) || value < 0)
        throw new Error("invalid_max_lease_ms");
    return value;
}
function normalizeHostId(value) {
    if (value === undefined || value === null)
        return hostname();
    if (typeof value !== "string" || !value.trim())
        throw new Error("invalid_host_id");
    return value.trim();
}
function normalizeRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.trim().split("/");
    if (!owner || !repo || extra !== undefined)
        throw new Error("invalid_repo_full_name");
    // #7525: extend #5831's path-safety guard here too — reject a `.`/`..`/control-char segment before it can
    // be persisted into SQLite (or echoed back through the CLI), matching claim-ledger.ts's sibling parser.
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo))
        throw new Error("invalid_repo_full_name");
    return `${owner}/${repo}`;
}
function normalizeAttemptId(attemptId) {
    if (typeof attemptId !== "string")
        throw new Error("invalid_attempt_id");
    const trimmed = attemptId.trim();
    if (!trimmed)
        throw new Error("invalid_attempt_id");
    return trimmed;
}
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // ESRCH = no such process; EPERM (or similar) means the process exists but we lack signal rights.
        return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
            ? false
            : true;
    }
}
function rowToAllocation(row) {
    return {
        slotIndex: row.slot_index,
        worktreePath: row.worktree_path,
        attemptId: row.attempt_id,
        repoFullName: row.repo_full_name,
        status: row.status,
        ownerPid: row.owner_pid,
        ownerHost: row.owner_host ?? null,
        allocatedAt: row.allocated_at,
    };
}
function ensureSlotTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS worktree_slots (
      slot_index INTEGER PRIMARY KEY,
      worktree_path TEXT NOT NULL UNIQUE,
      attempt_id TEXT UNIQUE,
      repo_full_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('free', 'active')),
      owner_pid INTEGER,
      owner_host TEXT,
      allocated_at TEXT
    )
  `);
    ensureOwnerHostColumn(db);
}
// Add the owner_host column (#7085) to an on-disk file created before it existed. `CREATE TABLE IF NOT EXISTS`
// above is a no-op against an already-existing table, so a pre-#7085 file needs this explicit ALTER — guarded by
// a presence check (same technique as attempt-log.js's ensureOutcomeColumns). A migrated row keeps owner_host
// NULL until its owner re-acquires, so the age-based reclaim (not the same-host pid fast path) governs it.
function ensureOwnerHostColumn(db) {
    const hasOwnerHost = db
        .prepare("PRAGMA table_info(worktree_slots)")
        .all()
        .some((column) => column.name === "owner_host");
    if (!hasOwnerHost)
        db.exec("ALTER TABLE worktree_slots ADD COLUMN owner_host TEXT");
}
function ensureSlots(db, worktreeBaseDir, maxConcurrency) {
    mkdirSync(worktreeBaseDir, { recursive: true, mode: 0o700 });
    const insert = db.prepare(`
    INSERT OR IGNORE INTO worktree_slots (slot_index, worktree_path, status)
    VALUES (?, ?, 'free')
  `);
    for (let slotIndex = 0; slotIndex < maxConcurrency; slotIndex += 1) {
        const worktreePath = join(worktreeBaseDir, `slot-${slotIndex}`);
        insert.run(slotIndex, worktreePath);
        mkdirSync(worktreePath, { recursive: true, mode: 0o700 });
    }
}
function allocationAgeMs(allocatedAt, nowMs) {
    const allocatedMs = Date.parse(allocatedAt);
    if (!Number.isFinite(allocatedMs))
        return null;
    return nowMs - allocatedMs;
}
/**
 * Decide whether an `active` slot is orphaned and should be reclaimed. Two independent signals:
 * - Age (container-agnostic): a slot whose `allocated_at` is older than `maxLeaseMs` is reclaimed regardless of
 *   what `isProcessAlive` reports, guaranteeing eventual reclaim even when a cross-container caller observes the
 *   owner's pid in the wrong PID namespace. This is the only signal that is sound across fleet mode's separate
 *   containers, so it must never be gated behind the pid check.
 * - Same-host pid liveness (fast path): only when the slot was leased by a process on THIS host (`owner_host`
 *   matches) is `isProcessAlive` a meaningful signal — a confirmed-dead (or missing) local owner frees its slot
 *   immediately without waiting out the lease. A foreign `owner_host` is never trusted for the pid check.
 */
function isSlotOrphaned(row, nowMs, maxLeaseMs, hostId) {
    const ageMs = allocationAgeMs(row.allocated_at, nowMs);
    if (ageMs !== null && ageMs > maxLeaseMs)
        return true;
    if (row.owner_host !== null && row.owner_host === hostId) {
        return row.owner_pid === null || !isProcessAlive(row.owner_pid);
    }
    return false;
}
function reclaimOrphanedAllocations(db, nowMs, maxLeaseMs, hostId) {
    const orphans = db
        .prepare("SELECT slot_index, owner_pid, owner_host, allocated_at FROM worktree_slots WHERE status = 'active'")
        .all();
    const reclaim = db.prepare(`
    UPDATE worktree_slots
    SET status = 'free', attempt_id = NULL, repo_full_name = NULL, owner_pid = NULL, owner_host = NULL, allocated_at = NULL
    WHERE slot_index = ?
  `);
    for (const row of orphans) {
        if (isSlotOrphaned(row, nowMs, maxLeaseMs, hostId))
            reclaim.run(row.slot_index);
    }
}
/**
 * Opens the local worktree allocator store. On startup reclaims orphaned active slots — any slot past its
 * `maxLeaseMs` age (the container-agnostic guarantee for fleet mode's shared store), plus, as a same-host fast
 * path, any slot whose owner pid is confirmed dead in THIS host's PID namespace.
 */
export function openWorktreeAllocator(options = {}) {
    const resolvedPath = normalizeDbPath(options.dbPath);
    const worktreeBaseDir = normalizeWorktreeBaseDir(options.worktreeBaseDir);
    const maxConcurrency = normalizeMaxConcurrency(options.maxConcurrency);
    const maxLeaseMs = normalizeMaxLeaseMs(options.maxLeaseMs);
    const hostId = normalizeHostId(options.hostId);
    const processPid = Number.isInteger(options.processPid) ? options.processPid : process.pid;
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const db = openLocalStoreDb(resolvedPath);
    ensureSlotTable(db);
    ensureSlots(db, worktreeBaseDir, maxConcurrency);
    reclaimOrphanedAllocations(db, nowMs, maxLeaseMs, hostId);
    const getByAttempt = db.prepare("SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at FROM worktree_slots WHERE attempt_id = ?");
    const countActive = db.prepare("SELECT COUNT(*) AS count FROM worktree_slots WHERE status = 'active'");
    const selectFreeSlot = db.prepare(`
    SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at
    FROM worktree_slots
    WHERE status = 'free'
    ORDER BY slot_index
    LIMIT 1
  `);
    const markActive = db.prepare(`
    UPDATE worktree_slots
    SET status = 'active', attempt_id = ?, repo_full_name = ?, owner_pid = ?, owner_host = ?, allocated_at = ?
    WHERE slot_index = ?
  `);
    const releaseByAttempt = db.prepare(`
    UPDATE worktree_slots
    SET status = 'free', attempt_id = NULL, repo_full_name = NULL, owner_pid = NULL, owner_host = NULL, allocated_at = NULL
    WHERE attempt_id = ? AND status = 'active'
    RETURNING slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at
  `);
    const listSlots = db.prepare("SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at FROM worktree_slots ORDER BY slot_index");
    const allocator = {
        dbPath: resolvedPath,
        worktreeBaseDir,
        maxConcurrency,
        maxLeaseMs,
        processPid,
        hostId,
        acquire(attemptId, repoFullName) {
            const normalizedAttempt = normalizeAttemptId(attemptId);
            const normalizedRepo = normalizeRepoFullName(repoFullName);
            const existing = getByAttempt.get(normalizedAttempt);
            if (existing?.status === "active")
                return rowToAllocation(existing);
            db.exec("BEGIN IMMEDIATE");
            try {
                const raced = getByAttempt.get(normalizedAttempt);
                // In-transaction re-check: only reachable when another process activates the same attempt_id
                // between the pre-BEGIN read and this transaction (covered by miner-worktree-allocator-collisions
                // via child processes; those runs cannot attribute coverage back into this process).
                /* v8 ignore next 4 -- multi-process race; see miner-worktree-allocator-collisions.test.ts */
                if (raced?.status === "active") {
                    db.exec("COMMIT");
                    return rowToAllocation(raced);
                }
                const activeCount = countActive.get().count;
                if (activeCount >= maxConcurrency)
                    throw new Error("worktree_capacity_exceeded");
                const slot = selectFreeSlot.get();
                if (!slot)
                    throw new Error("worktree_capacity_exceeded");
                const allocatedAt = new Date().toISOString();
                markActive.run(normalizedAttempt, normalizedRepo, processPid, hostId, allocatedAt, slot.slot_index);
                db.exec("COMMIT");
                return rowToAllocation({
                    ...slot,
                    attempt_id: normalizedAttempt,
                    repo_full_name: normalizedRepo,
                    status: "active",
                    owner_pid: processPid,
                    owner_host: hostId,
                    allocated_at: allocatedAt,
                });
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        release(attemptId) {
            const normalizedAttempt = normalizeAttemptId(attemptId);
            const row = releaseByAttempt.get(normalizedAttempt);
            return row ? rowToAllocation(row) : null;
        },
        listSlots() {
            return listSlots.all().map(rowToAllocation);
        },
        close() {
            db.close();
        },
    };
    return allocator;
}
function getDefaultWorktreeAllocator() {
    defaultWorktreeAllocator ??= openWorktreeAllocator();
    return defaultWorktreeAllocator;
}
export function acquireWorktree(attemptId, repoFullName) {
    return getDefaultWorktreeAllocator().acquire(attemptId, repoFullName);
}
export function releaseWorktree(attemptId) {
    return getDefaultWorktreeAllocator().release(attemptId);
}
export function closeDefaultWorktreeAllocator() {
    if (!defaultWorktreeAllocator)
        return;
    defaultWorktreeAllocator.close();
    defaultWorktreeAllocator = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya3RyZWUtYWxsb2NhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsid29ya3RyZWUtYWxsb2NhdG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRyw4R0FBOEc7QUFDOUcsd0RBQXdEO0FBQ3hELE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDcEMsT0FBTyxFQUFFLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDNUMsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUVqQyxPQUFPLEVBQUUseUJBQXlCLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUN4RyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQTBEckQsTUFBTSxpQkFBaUIsR0FBRyw0QkFBNEIsQ0FBQztBQUN2RCxNQUFNLHNCQUFzQixHQUFHLFdBQVcsQ0FBQztBQUMzQyxNQUFNLHFCQUFxQixHQUFHLENBQUMsQ0FBQztBQUNoQyxJQUFJLHdCQUF3QixHQUE2QixJQUFJLENBQUM7QUFFOUQsOEdBQThHO0FBQzlHLDJHQUEyRztBQUMzRyw4R0FBOEc7QUFDOUcsaUhBQWlIO0FBQ2pILGlIQUFpSDtBQUNqSCxzR0FBc0c7QUFDdEcsaUhBQWlIO0FBQ2pILGtIQUFrSDtBQUNsSCxvR0FBb0c7QUFDcEcsTUFBTSxDQUFDLE1BQU0sb0JBQW9CLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDO0FBRXZELE1BQU0sVUFBVSw4QkFBOEIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUNsRyxPQUFPLHVCQUF1QixDQUFDLGlCQUFpQixFQUFFLHNDQUFzQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ2pHLENBQUM7QUFFRCxNQUFNLFVBQVUsc0JBQXNCLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7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