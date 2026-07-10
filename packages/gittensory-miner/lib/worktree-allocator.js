import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Git-worktree-per-attempt allocator (#4297): durable local bookkeeping for which worktree paths are
// allocated to which fleet attempts. Mirrors the package's existing local-store pattern (run-state.js,
// claim-ledger.js, portfolio-queue.js) — plain JS + node:sqlite, never phones home.

const defaultDbFileName = "worktree-allocator.sqlite3";
const defaultWorktreeDirName = "worktrees";
const defaultMaxConcurrency = 2;
let defaultWorktreeAllocator = null;

export function resolveWorktreeAllocatorDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_WORKTREE_ALLOCATOR_DB === "string"
    ? env.GITTENSORY_MINER_WORKTREE_ALLOCATOR_DB.trim()
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

export function resolveWorktreeBaseDir(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_WORKTREE_DIR === "string"
    ? env.GITTENSORY_MINER_WORKTREE_DIR.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultWorktreeDirName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultWorktreeDirName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolveWorktreeAllocatorDbPath()).trim();
  if (!path) throw new Error("invalid_worktree_allocator_db_path");
  return path;
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
      allocated_at TEXT
    )
  `);
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

function reclaimOrphanedAllocations(db) {
  const orphans = db
    .prepare("SELECT slot_index, owner_pid FROM worktree_slots WHERE status = 'active'")
    .all();
  const reclaim = db.prepare(`
    UPDATE worktree_slots
    SET status = 'free', attempt_id = NULL, repo_full_name = NULL, owner_pid = NULL, allocated_at = NULL
    WHERE slot_index = ?
  `);
  for (const row of orphans) {
    if (row.owner_pid !== null && isProcessAlive(row.owner_pid)) continue;
    reclaim.run(row.slot_index);
  }
}

/**
 * Opens the local worktree allocator store. Reclaims orphaned active slots from dead owner processes on startup.
 */
export function openWorktreeAllocator(options = {}) {
  const resolvedPath = normalizeDbPath(options.dbPath);
  const worktreeBaseDir = normalizeWorktreeBaseDir(options.worktreeBaseDir);
  const maxConcurrency = normalizeMaxConcurrency(options.maxConcurrency);
  const processPid = Number.isInteger(options.processPid) ? options.processPid : process.pid;

  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  ensureSlotTable(db);
  ensureSlots(db, worktreeBaseDir, maxConcurrency);
  reclaimOrphanedAllocations(db);

  const getByAttempt = db.prepare(
    "SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, allocated_at FROM worktree_slots WHERE attempt_id = ?",
  );
  const countActive = db.prepare("SELECT COUNT(*) AS count FROM worktree_slots WHERE status = 'active'");
  const selectFreeSlot = db.prepare(`
    SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, allocated_at
    FROM worktree_slots
    WHERE status = 'free'
    ORDER BY slot_index
    LIMIT 1
  `);
  const markActive = db.prepare(`
    UPDATE worktree_slots
    SET status = 'active', attempt_id = ?, repo_full_name = ?, owner_pid = ?, allocated_at = ?
    WHERE slot_index = ?
  `);
  const releaseByAttempt = db.prepare(`
    UPDATE worktree_slots
    SET status = 'free', attempt_id = NULL, repo_full_name = NULL, owner_pid = NULL, allocated_at = NULL
    WHERE attempt_id = ? AND status = 'active'
    RETURNING slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, allocated_at
  `);
  const listSlots = db.prepare(
    "SELECT slot_index, worktree_path, attempt_id, repo_full_name, status, owner_pid, allocated_at FROM worktree_slots ORDER BY slot_index",
  );

  const allocator = {
    dbPath: resolvedPath,
    worktreeBaseDir,
    maxConcurrency,
    processPid,
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
        markActive.run(normalizedAttempt, normalizedRepo, processPid, allocatedAt, slot.slot_index);
        db.exec("COMMIT");
        return rowToAllocation({
          ...slot,
          attempt_id: normalizedAttempt,
          repo_full_name: normalizedRepo,
          status: "active",
          owner_pid: processPid,
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
