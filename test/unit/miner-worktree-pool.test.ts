import { describe, expect, it } from "vitest";
import {
  EMPTY_WORKTREE_POOL,
  acquireWorktree,
  releaseWorktree,
  reclaimOrphanedWorktrees,
  isWorktreeAllocated,
  availableWorktreeSlots,
  type WorktreePoolState,
} from "../../packages/gittensory-engine/src/index";

const config = { maxConcurrency: 2 };
const REPO = "/home/node/repos/acme";

function acquired(state: WorktreePoolState, attemptId: string): WorktreePoolState {
  const r = acquireWorktree(state, config, { attemptId, repoPath: REPO });
  if (!r.ok) throw new Error(`unexpected acquire failure: ${r.reason}`);
  return r.state;
}

describe("worktree pool allocator (#4297)", () => {
  it("acquires a slot with a deterministic plan derived from the attempt id", () => {
    const r = acquireWorktree(EMPTY_WORKTREE_POOL, config, { attemptId: "attempt-1", repoPath: REPO });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.allocation.attemptId).toBe("attempt-1");
    expect(r.allocation.plan.worktreePath).toContain(".gittensory-worktrees");
    expect(r.allocation.plan.branchName).toContain("gittensory/attempt/");
    expect(r.state.allocations).toHaveLength(1);
    expect(isWorktreeAllocated(r.state, "attempt-1")).toBe(true);
    expect(availableWorktreeSlots(r.state, config)).toBe(1);
  });

  it("refuses a second slot for the same attempt (already_allocated, no mutation)", () => {
    const first = acquired(EMPTY_WORKTREE_POOL, "attempt-1");
    const again = acquireWorktree(first, config, { attemptId: "attempt-1", repoPath: REPO });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("already_allocated");
    expect(again.state).toBe(first); // unchanged reference
  });

  it("enforces the concurrency cap (at_capacity)", () => {
    const full = acquired(acquired(EMPTY_WORKTREE_POOL, "a"), "b");
    expect(availableWorktreeSlots(full, config)).toBe(0);
    const third = acquireWorktree(full, config, { attemptId: "c", repoPath: REPO });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.reason).toBe("at_capacity");
    expect(third.state).toBe(full);
  });

  it("releases a slot, freeing capacity, and is a no-op for an unknown attempt", () => {
    const s = acquired(EMPTY_WORKTREE_POOL, "a");
    const released = releaseWorktree(s, "a");
    expect(isWorktreeAllocated(released, "a")).toBe(false);
    expect(availableWorktreeSlots(released, config)).toBe(2);
    const noop = releaseWorktree(released, "ghost");
    expect(noop).toBe(released); // no matching allocation ⇒ same state reference
  });

  it("reclaims orphaned slots whose attempt is no longer live", () => {
    const s = acquired(acquired(EMPTY_WORKTREE_POOL, "live"), "dead");
    const { state, reclaimed } = reclaimOrphanedWorktrees(s, ["live"]);
    expect(reclaimed.map((a) => a.attemptId)).toEqual(["dead"]);
    expect(isWorktreeAllocated(state, "dead")).toBe(false);
    expect(isWorktreeAllocated(state, "live")).toBe(true);
  });

  it("reclaim is a no-op (same state) when every allocation is still live", () => {
    const s = acquired(EMPTY_WORKTREE_POOL, "live");
    const { state, reclaimed } = reclaimOrphanedWorktrees(s, ["live", "other"]);
    expect(reclaimed).toEqual([]);
    expect(state).toBe(s); // unchanged reference
  });

  it("availableWorktreeSlots clamps at 0 when allocations exceed a shrunk cap", () => {
    const s = acquired(acquired(EMPTY_WORKTREE_POOL, "a"), "b");
    expect(availableWorktreeSlots(s, { maxConcurrency: 1 })).toBe(0);
  });
});
