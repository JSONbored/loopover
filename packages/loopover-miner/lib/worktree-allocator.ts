// mkdirSync is still needed for the git-worktree CHECKOUT dirs below (resolveWorktreeBaseDir's tree) — that is
// a filesystem directory, not a store DB path, and is deliberately out of this migration's scope. Only the DB
// handle's own mkdir/chmod moved into openLocalStoreDb.
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
import { isValidRepoSegment } from "./repo-clone.js";

// Git-worktree-per-attempt allocator (#4297): durable local bookkeeping for which worktree paths are
// allocated to which fleet attempts. Opens its handle through local-store.js's openLocalStoreDb (#4272), the
// same call run-state.js / claim-ledger.js / portfolio-queue.js use — plain JS + node:sqlite, never phones
// home. Going through openLocalStoreDb is what registers the handle for crash-safe cleanup
// (process-lifecycle.js, #4826), which matters most for exactly this store: a SIGINT/SIGTERM mid-write is what
// leaves a worktree slot leased to a process that no longer exists (#6600). It previously hand-rolled the
// identical mkdirSync/chmodSync/PRAGMA sequence and so was never registered, despite this comment already
// claiming to mirror those three files.

export type WorktreeAllocation = {
  slotIndex: number;
  worktreePath: string;
  attemptId: string | null;
  repoFullName: string | null;
  status: "free" | "active";
  ownerPid: number | null;
  ownerHost: string | null;
  allocatedAt: string | null;
};

export type WorktreeAllocator = {
  dbPath: string;
  worktreeBaseDir: string;
  maxConcurrency: number;
  maxLeaseMs: number;
  processPid: number;
  hostId: string;
  acquire(attemptId: string, repoFullName: string): WorktreeAllocation;
  release(attemptId: string): WorktreeAllocation | null;
  listSlots(): WorktreeAllocation[];
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

/** SQLite `worktree_slots` row shape (StatementSync returns `Record<string, SQLOutputValue>`). */
type WorktreeSlotRow = {
  slot_index: number;
  worktree_path: string;
  attempt_id: string | null;
  repo_full_name: string | null;
  status: "free" | "active";
  owner_pid: number | null;
  owner_host: string | null;
  allocated_at: string | null;
};

type OrphanProbeRow = {
  slot_index: number;
  owner_pid: number | null;
  owner_host: string | null;
  allocated_at: string | null;
};

type CountRow = { count: number };

type TableInfoRow = { name: string };

const defaultDbFileName = "worktree-allocator.sqlite3";
const defaultWorktreeDirName = "worktrees";
const defaultMaxConcurrency = 2;
let defaultWorktreeAllocator: WorktreeAllocator | null = null;

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

export function resolveWorktreeAllocatorDbPath(env: Record<string, string | undefined> = process.env): string {
  return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB", env);
}

export function resolveWorktreeBaseDir(env: Record<string, string | undefined> = process.env): string {
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

function normalizeDbPath(dbPath: string | null | undefined): string {
  return normalizeLocalStoreDbPath(dbPath, resolveWorktreeAllocatorDbPath(), "invalid_worktree_allocator_db_path");
}

function normalizeWorktreeBaseDir(worktreeBaseDir: string | null | undefined): string {
  const path = (worktreeBaseDir ?? resolveWorktreeBaseDir()).trim();
  if (!path) throw new Error("invalid_worktree_base_dir");
  return path;
}

function normalizeMaxConcurrency(value: number | null | undefined): number {
  if (value === undefined || value === null) return defaultMaxConcurrency;
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid_max_concurrency");
  return value;
}

function normalizeMaxLeaseMs(value: number | null | undefined): number {
  if (value === undefined || value === null) return DEFAULT_MAX_LEASE_MS;
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_max_lease_ms");
  return value;
}

function normalizeHostId(value: unknown): string {
  if (value === undefined || value === null) return hostname();
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_host_id");
  return value.trim();
}

function normalizeRepoFullName(repoFullName: unknown): string {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.trim().split("/");
  if (!owner || !repo || extra !== undefined) throw new Error("invalid_repo_full_name");
  // #7525: extend #5831's path-safety guard here too — reject a `.`/`..`/control-char segment before it can
  // be persisted into SQLite (or echoed back through the CLI), matching claim-ledger.ts's sibling parser.
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) throw new Error("invalid_repo_full_name");
  return `${owner}/${repo}`;
}

function normalizeAttemptId(attemptId: unknown): string {
  if (typeof attemptId !== "string") throw new Error("invalid_attempt_id");
  const trimmed = attemptId.trim();
  if (!trimmed) throw new Error("invalid_attempt_id");
  return trimmed;
}

export function isProcessAlive(pid: number): boolean {
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

function rowToAllocation(row: WorktreeSlotRow): WorktreeAllocation {
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

function ensureSlotTable(db: DatabaseSync): void {
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
function ensureOwnerHostColumn(db: DatabaseSync): void {
  const hasOwnerHost = db
    .prepare("PRAGMA table_info(worktree_slots)")
    .all()
    .some((column) => (column as TableInfoRow).name === "owner_host");
  if (!hasOwnerHost) db.exec("ALTER TABLE worktree_slots ADD COLUMN owner_host TEXT");
}

function ensureSlots(db: DatabaseSync, worktreeBaseDir: string, maxConcurrency: number): void {
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

function allocationAgeMs(allocatedAt: string | null, nowMs: number): number | null {
  const allocatedMs = Date.parse(allocatedAt as string);
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
function isSlotOrphaned(row: OrphanProbeRow, nowMs: number, maxLeaseMs: number, hostId: string): boolean {
  const ageMs = allocationAgeMs(row.allocated_at, nowMs);
  if (ageMs !== null && ageMs > maxLeaseMs) return true;
  if (row.owner_host !== null && row.owner_host === hostId) {
    return row.owner_pid === null || !isProcessAlive(row.owner_pid);
  }
  return false;
}

function reclaimOrphanedAllocations(db: DatabaseSync, nowMs: number, maxLeaseMs: number, hostId: string): void {
  const orphans = db
    .prepare("SELECT slot_index, owner_pid, owner_host, allocated_at FROM worktree_slots WHERE status = 'active'")
    .all() as OrphanProbeRow[];
  const reclaim = db.prepare(`
    UPDATE worktree_slots
    SET status = 'free', attempt_id = NULL, repo_full_name = NULL, owner_pid = NULL, owner_host = NULL, allocated_at = NULL
    WHERE slot_index = ?
  `);
  for (const row of orphans) {
    if (isSlotOrphaned(row, nowMs, maxLeaseMs, hostId)) reclaim.run(row.slot_index);
  }
}

// Right-to-be-forgotten purge (#8320). `worktree_slots` is a FIXED pool of pre-allocated slot rows (every index
// 0..maxConcurrency-1 always exists), NOT an append-only ledger, so the generic DELETE-based `purgeStoreByRepo`
// would shrink the pool and break ensureSlots/selectFreeSlot's invariant. Instead, purge-by-repo clears the repo
// only from slots that are already `free` — mirroring release()/reclaimOrphanedAllocations()'s own blanking of
// repo_full_name/attempt_id/owner_pid/owner_host/allocated_at. An `active` slot is NEVER matched: its
// repo_full_name reflects a live, in-flight attempt's real worktree checkout on disk, and clearing it while
// active would desync the allocator from that checkout. This match condition is shared verbatim by the real
// UPDATE (below) and the read-only --dry-run counter (countPurgeableWorktreeSlotsByRepo) so the two can never
// diverge. It is expected to match 0 rows on the overwhelming majority of real calls, by design: every normal
// release/reclaim path already blanks these fields on free, so only a row predating this fix or stranded by an
// unexpected crash path can ever match — the clear is a defensive backstop, not a routine deletion.
const PURGEABLE_FREE_SLOT_MATCH = "status = 'free' AND repo_full_name = ?";

/**
 * Read-only count of the rows `purgeByRepo` would clear for one repo (#8320) — the `--dry-run` counterpart used
 * by purge-cli.js against a driver-enforced read-only handle. Uses the exact same `PURGEABLE_FREE_SLOT_MATCH`
 * condition the real purge does, so an `active` slot is never reported as purgeable in dry-run either. Mirrors
 * store-maintenance.js's `countStoreByRepo` for the generic repoColumn stores.
 */
export function countPurgeableWorktreeSlotsByRepo(db: DatabaseSync, repoFullName: string): number {
  const countRow = db
    .prepare(`SELECT COUNT(*) AS count FROM worktree_slots WHERE ${PURGEABLE_FREE_SLOT_MATCH}`)
    .get(repoFullName) as CountRow;
  return countRow.count;
}

/**
 * Opens the local worktree allocator store. On startup reclaims orphaned active slots — any slot past its
 * `maxLeaseMs` age (the container-agnostic guarantee for fleet mode's shared store), plus, as a same-host fast
 * path, any slot whose owner pid is confirmed dead in THIS host's PID namespace.
 */
export function openWorktreeAllocator(options: {
  dbPath?: string;
  worktreeBaseDir?: string;
  maxConcurrency?: number;
  maxLeaseMs?: number;
  processPid?: number;
  hostId?: string;
  nowMs?: number;
} = {}): WorktreeAllocator {
  const resolvedPath = normalizeDbPath(options.dbPath);
  const worktreeBaseDir = normalizeWorktreeBaseDir(options.worktreeBaseDir);
  const maxConcurrency = normalizeMaxConcurrency(options.maxConcurrency);
  const maxLeaseMs = normalizeMaxLeaseMs(options.maxLeaseMs);
  const hostId = normalizeHostId(options.hostId);
  const processPid = Number.isInteger(options.processPid) ? options.processPid as number : process.pid;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs as number : Date.now();

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
  const purgeFreeByRepo = db.prepare(`
    UPDATE worktree_slots
    SET repo_full_name = NULL, attempt_id = NULL, owner_pid = NULL, owner_host = NULL, allocated_at = NULL
    WHERE ${PURGEABLE_FREE_SLOT_MATCH}
  `);

  const allocator: WorktreeAllocator = {
    dbPath: resolvedPath,
    worktreeBaseDir,
    maxConcurrency,
    maxLeaseMs,
    processPid,
    hostId,
    acquire(attemptId, repoFullName) {
      const normalizedAttempt = normalizeAttemptId(attemptId);
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      const existing = getByAttempt.get(normalizedAttempt) as WorktreeSlotRow | undefined;
      if (existing?.status === "active") return rowToAllocation(existing);

      db.exec("BEGIN IMMEDIATE");
      try {
        const raced = getByAttempt.get(normalizedAttempt) as WorktreeSlotRow | undefined;
        // In-transaction re-check: only reachable when another process activates the same attempt_id
        // between the pre-BEGIN read and this transaction (covered by miner-worktree-allocator-collisions
        // via child processes; those runs cannot attribute coverage back into this process).
        /* v8 ignore next 4 -- multi-process race; see miner-worktree-allocator-collisions.test.ts */
        if (raced?.status === "active") {
          db.exec("COMMIT");
          return rowToAllocation(raced);
        }
        const activeCount = (countActive.get() as CountRow).count;
        if (activeCount >= maxConcurrency) throw new Error("worktree_capacity_exceeded");
        const slot = selectFreeSlot.get() as WorktreeSlotRow | undefined;
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
      const row = releaseByAttempt.get(normalizedAttempt) as WorktreeSlotRow | undefined;
      return row ? rowToAllocation(row) : null;
    },
    listSlots() {
      return (listSlots.all() as WorktreeSlotRow[]).map(rowToAllocation);
    },
    purgeByRepo(repoFullName) {
      // Right-to-be-forgotten sweep (#8320): clear the repo only from FREE slots (see PURGEABLE_FREE_SLOT_MATCH).
      // Never deletes a pooled slot row and never touches an `active` slot's live in-flight checkout. Returns the
      // number of rows cleared — expected to be 0 on the overwhelming majority of real calls, by design, since
      // every normal release/reclaim path already blanks these fields on free.
      const normalizedRepo = normalizeRepoFullName(repoFullName);
      return Number(purgeFreeByRepo.run(normalizedRepo).changes);
    },
    close() {
      db.close();
    },
  };

  return allocator;
}

function getDefaultWorktreeAllocator(): WorktreeAllocator {
  defaultWorktreeAllocator ??= openWorktreeAllocator();
  return defaultWorktreeAllocator;
}

export function acquireWorktree(attemptId: string, repoFullName: string): WorktreeAllocation {
  return getDefaultWorktreeAllocator().acquire(attemptId, repoFullName);
}

export function releaseWorktree(attemptId: string): WorktreeAllocation | null {
  return getDefaultWorktreeAllocator().release(attemptId);
}

export function closeDefaultWorktreeAllocator(): void {
  if (!defaultWorktreeAllocator) return;
  defaultWorktreeAllocator.close();
  defaultWorktreeAllocator = null;
}
