import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDefaultWorktreeAllocator,
  isProcessAlive,
  openWorktreeAllocator,
  resolveWorktreeAllocatorDbPath,
  resolveWorktreeBaseDir,
} from "../../packages/loopover-miner/lib/worktree-allocator.js";
import {
  cleanupResourceCount,
  closeAllCleanupResources,
  resetProcessLifecycleForTesting,
} from "../../packages/loopover-miner/lib/process-lifecycle.js";

const roots: string[] = [];
const allocators: Array<{ close(): void }> = [];

/** Opt an allocator out of the shared afterEach close, for a test that closes the handle itself. `close()` is
 *  not idempotent (node:sqlite throws "database is not open"), so a test asserting the close path must own the
 *  handle's lifetime outright rather than be closed a second time on the way out. */
function ownClose<T extends { close(): void }>(allocator: T): T {
  const index = allocators.indexOf(allocator);
  if (index >= 0) allocators.splice(index, 1);
  return allocator;
}

function tempAllocator(options: { maxConcurrency?: number; processPid?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-worktree-allocator-"));
  roots.push(root);
  const allocator = openWorktreeAllocator({
    dbPath: join(root, "worktree-allocator.sqlite3"),
    worktreeBaseDir: join(root, "worktrees"),
    maxConcurrency: options.maxConcurrency ?? 2,
    ...(options.processPid === undefined ? {} : { processPid: options.processPid }),
  });
  allocators.push(allocator);
  return allocator;
}

afterEach(() => {
  for (const allocator of allocators.splice(0)) allocator.close();
  closeDefaultWorktreeAllocator();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loopover-miner worktree allocator scaffolding (#4298)", () => {
  it("resolves DB and worktree base paths from env overrides", () => {
    expect(
      resolveWorktreeAllocatorDbPath({ LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB: "/custom/alloc.sqlite3" }),
    ).toBe("/custom/alloc.sqlite3");
    expect(resolveWorktreeBaseDir({ LOOPOVER_MINER_WORKTREE_DIR: "/custom/worktrees" })).toBe(
      "/custom/worktrees",
    );
    expect(resolveWorktreeAllocatorDbPath({ LOOPOVER_MINER_CONFIG_DIR: "/cfg" })).toBe(
      "/cfg/worktree-allocator.sqlite3",
    );
    expect(resolveWorktreeBaseDir({ LOOPOVER_MINER_CONFIG_DIR: "/cfg" })).toBe("/cfg/worktrees");
  });

  it("creates a permissioned SQLite store and allocates distinct worktree paths", () => {
    const allocator = tempAllocator({ maxConcurrency: 2 });
    expect(statSync(allocator.dbPath).mode & 0o077).toBe(0);
    expect(existsSync(join(allocator.worktreeBaseDir, "slot-0"))).toBe(true);

    const first = allocator.acquire("attempt-a", "acme/widgets");
    const second = allocator.acquire("attempt-b", "acme/other");
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.status).toBe("active");
    expect(allocator.listSlots().filter((slot) => slot.status === "active")).toHaveLength(2);
  });

  it("release frees a slot for reuse and rejects invalid input", () => {
    const allocator = tempAllocator({ maxConcurrency: 1 });
    const first = allocator.acquire("attempt-a", "acme/widgets");
    expect(allocator.release("attempt-a")?.worktreePath).toBe(first.worktreePath);
    const second = allocator.acquire("attempt-b", "acme/widgets");
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(() => allocator.acquire("", "acme/widgets")).toThrow("invalid_attempt_id");
    expect(() => allocator.acquire("attempt-c", "bad")).toThrow("invalid_repo_full_name");
    expect(allocator.release("missing")).toBeNull();
  });

  it("isProcessAlive returns false for invalid or dead pids", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(9_999_999)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive treats EPERM from process.kill as alive", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    expect(isProcessAlive(42_424)).toBe(true);
    kill.mockRestore();
  });

  it("rejects invalid store configuration", () => {
    expect(() => openWorktreeAllocator({ maxConcurrency: 0 })).toThrow("invalid_max_concurrency");
    expect(() => openWorktreeAllocator({ dbPath: "  " })).toThrow("invalid_worktree_allocator_db_path");
    expect(() => openWorktreeAllocator({ worktreeBaseDir: "  " })).toThrow("invalid_worktree_base_dir");
  });

  it("returns the same allocation for repeated acquire on one attempt id", () => {
    const allocator = tempAllocator({ maxConcurrency: 1 });
    const first = allocator.acquire("attempt-a", "acme/widgets");
    const second = allocator.acquire("attempt-a", "acme/widgets");
    expect(second.worktreePath).toBe(first.worktreePath);
  });

  it("registers the store for crash-safe cleanup and unregisters it on close (#6600)", () => {
    // The whole point of routing through openLocalStoreDb: a SIGINT/SIGTERM mid-write is what leaves a worktree
    // slot leased to a dead process, so this store must be closed by the signal handlers like its 3 siblings.
    // Hand-rolling `new DatabaseSync(...)` registered nothing, so this count stayed at 0.
    resetProcessLifecycleForTesting();
    expect(cleanupResourceCount()).toBe(0);
    const allocator = ownClose(tempAllocator({ maxConcurrency: 1 }));
    expect(cleanupResourceCount()).toBe(1);
    allocator.close();
    // The normal close() unregisters, so a long-running loop doesn't accumulate stale handles or double-close.
    expect(cleanupResourceCount()).toBe(0);
  });

  it("is closed by closeAllCleanupResources when the process dies mid-write (#6600)", () => {
    resetProcessLifecycleForTesting();
    const allocator = ownClose(tempAllocator({ maxConcurrency: 1 }));
    allocator.acquire("attempt-a", "acme/widgets");
    expect(cleanupResourceCount()).toBe(1);

    closeAllCleanupResources(); // what installCliSignalHandlers invokes on SIGINT/SIGTERM
    expect(cleanupResourceCount()).toBe(0);
  });
});
