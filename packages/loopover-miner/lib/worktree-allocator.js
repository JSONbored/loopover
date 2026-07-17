// mkdirSync is still needed for the git-worktree CHECKOUT dirs below (resolveWorktreeBaseDir's tree) — that is
// a filesystem directory, not a store DB path, and is deliberately out of this migration's scope. Only the DB
// handle's own mkdir/chmod moved into openLocalStoreDb.
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";

// Git-worktree-per-attempt allocator (#4297): durable local bookkeeping for which worktree paths are
// allocated to which fleet attempts. Opens its handle through local-store.js's openLocalStoreDb (#4272), the
// same call run-state.js / claim-ledger.js / portfolio-queue.js use — plain JS + node:sqlite, never phones
// home. Going through openLocalStoreDb is what registers the handle for crash-safe cleanup
// (process-lifecycle.js, #4826), which matters most for exactly this store: a SIGINT/SIGTERM mid-write is what
// leaves a worktree slot leased to a process that no longer exists (#6600). It previously hand-rolled the
// identical mkdirSync/chmodSync/PRAGMA sequence and so was never registered, despite this comment already
// claiming to mirror those three files.

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
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
    ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultWorktreeDirName);

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
  if (!path) throw new Error("invalid_worktree_base_dir");
  return path;
}

function normalizeMaxConcurrency(value) {
  if (value === undefined || value === null) return defaultMaxConcurrency;
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid_max_concurrency");
  return value;
}

function normalizeMaxLeaseMs(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_LEASE_MS;
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_max_lease_ms");
  return value;
}

function normalizeHostId(value) {
  if (value === undefined || value === null) return hostname();
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_host_id");
  return value.trim();
}

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeAttemptId(attemptId) {
  if (typeof attemptId !== "string") throw new Error("invalid_attempt_id");
  const trimmed = attemptId.trim();
  if (!trimmed) throw new Error("invalid_attempt_id");
  return trimmed;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
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
  if (!hasOwnerHost) db.exec("ALTER TABLE worktree_slots ADD COLUMN owner_host TEXT");
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
  if (!Number.isFinite(allocatedMs)) return null;
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
  if (ageMs !== null && ageMs > maxLeaseMs) return true;
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
    if (isSlotOrphaned(row, nowMs, maxLeaseMs, hostId)) reclaim.run(row.slot_index);
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

  const getByAttempt = db.prepare(
    "SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at FROM worktree_slots WHERE attempt_id = ?",
  );
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
  const listSlots = db.prepare(
    "SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, owner_host, allocated_at FROM worktree_slots ORDER BY slot_index",
  );

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
      if (existing?.status === "active") return rowToAllocation(existing);

      db.exec("BEGIN IMMEDIATE");
      try {
        const raced = getByAttempt.get(normalizedAttempt);
        if (raced?.status === "active") {
          db.exec("COMMIT");
          return rowToAllocation(raced);
        }
        const activeCount = countActive.get().count;
        if (activeCount >= maxConcurrency) throw new Error("worktree_capacity_exceeded");
        const slot = selectFreeSlot.get();
        if (!slot) throw new Error("worktree_capacity_exceeded");
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
      } catch (error) {
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
  if (!defaultWorktreeAllocator) return;
  defaultWorktreeAllocator.close();
  defaultWorktreeAllocator = null;
}
