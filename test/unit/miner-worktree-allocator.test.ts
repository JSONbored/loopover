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
} from "../../packages/gittensory-miner/lib/worktree-allocator.js";

const roots: string[] = [];
const allocators: Array<{ close(): void }> = [];

function tempAllocator(options: { maxConcurrency?: number; processPid?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-worktree-allocator-"));
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

describe("gittensory-miner worktree allocator scaffolding (#4298)", () => {
  it("resolves DB and worktree base paths from env overrides", () => {
    expect(
      resolveWorktreeAllocatorDbPath({ GITTENSORY_MINER_WORKTREE_ALLOCATOR_DB: "/custom/alloc.sqlite3" }),
    ).toBe("/custom/alloc.sqlite3");
    expect(resolveWorktreeBaseDir({ GITTENSORY_MINER_WORKTREE_DIR: "/custom/worktrees" })).toBe(
      "/custom/worktrees",
    );
    expect(resolveWorktreeAllocatorDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/cfg" })).toBe(
      "/cfg/worktree-allocator.sqlite3",
    );
    expect(resolveWorktreeBaseDir({ GITTENSORY_MINER_CONFIG_DIR: "/cfg" })).toBe("/cfg/worktrees");
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
});
