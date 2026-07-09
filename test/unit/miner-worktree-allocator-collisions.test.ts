import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDefaultWorktreeAllocator,
  openWorktreeAllocator,
} from "../../packages/gittensory-miner/lib/worktree-allocator.js";

const roots: string[] = [];
const allocators: Array<{ close(): void }> = [];

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-worktree-collisions-"));
  roots.push(root);
  return {
    root,
    dbPath: join(root, "worktree-allocator.sqlite3"),
    worktreeBaseDir: join(root, "worktrees"),
  };
}

function openAllocator(
  paths: ReturnType<typeof tempPaths>,
  options: { maxConcurrency?: number; processPid?: number } = {},
) {
  const allocator = openWorktreeAllocator({
    dbPath: paths.dbPath,
    worktreeBaseDir: paths.worktreeBaseDir,
    maxConcurrency: options.maxConcurrency ?? 4,
    processPid: options.processPid,
  });
  allocators.push(allocator);
  return allocator;
}

afterEach(() => {
  for (const allocator of allocators.splice(0)) allocator.close();
  closeDefaultWorktreeAllocator();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner worktree allocator collisions (#4298)", () => {
  it("returns distinct worktree paths for simultaneous acquire calls", async () => {
    const paths = tempPaths();
    const allocator = openAllocator(paths, { maxConcurrency: 5 });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        Promise.resolve().then(() => allocator.acquire(`attempt-${index}`, "acme/widgets")),
      ),
    );
    const worktreePaths = results.map((allocation) => allocation.worktreePath);
    expect(new Set(worktreePaths).size).toBe(5);
  });

  it("rejects simultaneous acquire calls beyond the configured concurrency cap", async () => {
    const paths = tempPaths();
    const allocator = openAllocator(paths, { maxConcurrency: 2 });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => allocator.acquire("attempt-1", "acme/widgets")),
      Promise.resolve().then(() => allocator.acquire("attempt-2", "acme/widgets")),
      Promise.resolve().then(() => allocator.acquire("attempt-3", "acme/widgets")),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: "worktree_capacity_exceeded",
    });
  });

  it("reuses a worktree path after release", () => {
    const paths = tempPaths();
    const allocator = openAllocator(paths, { maxConcurrency: 1 });
    const first = allocator.acquire("attempt-a", "acme/widgets");
    allocator.release("attempt-a");
    const second = allocator.acquire("attempt-b", "acme/widgets");
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.status).toBe("active");
  });

  it("reclaims orphaned active allocations after a simulated crash on reopen", () => {
    const paths = tempPaths();
    const crashedPid = 40_001;
    const restartedPid = 40_002;

    const crashed = openAllocator(paths, { maxConcurrency: 1, processPid: crashedPid });
    const allocation = crashed.acquire("attempt-dead", "acme/widgets");
    crashed.close();
    allocators.pop();

    const restarted = openAllocator(paths, { maxConcurrency: 1, processPid: restartedPid });
    expect(restarted.listSlots().find((slot) => slot.status === "active")).toBeUndefined();

    const reclaimed = restarted.acquire("attempt-new", "acme/other");
    expect(reclaimed.worktreePath).toBe(allocation.worktreePath);
    expect(reclaimed.attemptId).toBe("attempt-new");
  });

  it("reclaims a manually seeded active row with no live owner", () => {
    const paths = tempPaths();
    mkdirSeed(paths, 50_001);

    const restarted = openAllocator(paths, { maxConcurrency: 2, processPid: 50_002 });
    expect(restarted.acquire("attempt-live", "acme/widgets").status).toBe("active");
    expect(restarted.listSlots().filter((slot) => slot.status === "active")).toHaveLength(1);
  });
});

function mkdirSeed(paths: ReturnType<typeof tempPaths>, ownerPid: number) {
  const bootstrap = openWorktreeAllocator({
    dbPath: paths.dbPath,
    worktreeBaseDir: paths.worktreeBaseDir,
    maxConcurrency: 2,
    processPid: ownerPid,
  });
  bootstrap.close();

  const db = new DatabaseSync(paths.dbPath);
  try {
    db.prepare(`
      UPDATE worktree_slots
      SET status = 'active',
          attempt_id = 'orphan-attempt',
          repo_full_name = 'acme/widgets',
          owner_pid = ?,
          allocated_at = '2026-07-08T12:00:00.000Z'
      WHERE slot_index = 0
    `).run(ownerPid);
    db.prepare(`
      UPDATE worktree_slots
      SET status = 'active',
          attempt_id = 'orphan-attempt-2',
          repo_full_name = 'acme/other',
          owner_pid = ?,
          allocated_at = '2026-07-08T12:00:00.000Z'
      WHERE slot_index = 1
    `).run(ownerPid);
  } finally {
    db.close();
  }
}
