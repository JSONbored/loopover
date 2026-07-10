// Git-worktree POOL allocator (#4297): the pure, in-memory scheduling logic for a POOL of per-attempt git
// worktrees across concurrent fleet attempts — acquire/release under a concurrency cap, plus orphan
// reclamation. Complementary to the isolation PRIMITIVE (worktree-allocator.ts, #4269), which plans/creates/
// tears down ONE worktree; this manages the SET of them so two concurrent attempts never collide and a crash
// can't leak worktree slots forever.
//
// Per #4297, the pure allocation logic lives here in gittensory-engine so it is unit-testable WITHOUT touching
// a real filesystem or database. The thin bookkeeping wrapper that PERSISTS this state (local SQLite, the same
// way claim-ledger.js / run-state.js do) is a separate miner-package layer — it holds a WorktreePoolState,
// calls these pure transitions, and writes the result back. No IO here: every function takes state in and
// returns new state out.

import { planWorktree, type WorktreePlan } from "./worktree-allocator.js";

/** One live allocation: which attempt holds which planned worktree. */
export type WorktreeAllocation = {
  attemptId: string;
  repoPath: string;
  plan: WorktreePlan;
};

/** The pool's whole allocation state — a serializable snapshot the persistence wrapper stores. */
export type WorktreePoolState = {
  allocations: readonly WorktreeAllocation[];
};

export type WorktreePoolConfig = {
  /** Maximum concurrent worktrees. A non-positive cap allocates nothing. */
  maxConcurrency: number;
};

/** The empty pool — nothing allocated. */
export const EMPTY_WORKTREE_POOL: WorktreePoolState = { allocations: [] };

export type AcquireWorktreeResult =
  | { ok: true; state: WorktreePoolState; allocation: WorktreeAllocation }
  | { ok: false; reason: "already_allocated" | "at_capacity"; state: WorktreePoolState };

/** True when `attemptId` currently holds an allocation. Pure. */
export function isWorktreeAllocated(state: WorktreePoolState, attemptId: string): boolean {
  return state.allocations.some((allocation) => allocation.attemptId === attemptId);
}

/** Slots still available before the concurrency cap (never negative). Pure. */
export function availableWorktreeSlots(state: WorktreePoolState, config: WorktreePoolConfig): number {
  return Math.max(0, config.maxConcurrency - state.allocations.length);
}

/**
 * Acquire a worktree slot for an attempt. The slot's path/branch is derived deterministically from the
 * attempt id via {@link planWorktree}. Fails WITHOUT mutating when the attempt already holds a slot
 * (`already_allocated`, idempotency guard) or the pool is at its concurrency cap (`at_capacity`). Pure —
 * returns a new state on success.
 */
export function acquireWorktree(
  state: WorktreePoolState,
  config: WorktreePoolConfig,
  input: { attemptId: string; repoPath: string },
): AcquireWorktreeResult {
  if (isWorktreeAllocated(state, input.attemptId)) {
    return { ok: false, reason: "already_allocated", state };
  }
  if (state.allocations.length >= config.maxConcurrency) {
    return { ok: false, reason: "at_capacity", state };
  }
  const allocation: WorktreeAllocation = {
    attemptId: input.attemptId,
    repoPath: input.repoPath,
    plan: planWorktree({ repoPath: input.repoPath, attemptId: input.attemptId }),
  };
  return { ok: true, state: { allocations: [...state.allocations, allocation] }, allocation };
}

/**
 * Release an attempt's slot, freeing it for reuse. Pure and idempotent — releasing an attempt that holds no
 * slot returns an equivalent state. The caller tears down the actual worktree (via the primitive) separately.
 */
export function releaseWorktree(state: WorktreePoolState, attemptId: string): WorktreePoolState {
  const allocations = state.allocations.filter((allocation) => allocation.attemptId !== attemptId);
  return allocations.length === state.allocations.length ? state : { allocations };
}

/**
 * Reclaim orphaned slots: free every allocation whose attempt is no longer in the live set (e.g. after a crash
 * left the bookkeeping ahead of reality). Returns the surviving state plus the reclaimed allocations so the
 * caller can tear down their leaked worktrees (or flag them for manual cleanup) rather than leaking forever.
 * Pure.
 */
export function reclaimOrphanedWorktrees(
  state: WorktreePoolState,
  liveAttemptIds: Iterable<string>,
): { state: WorktreePoolState; reclaimed: WorktreeAllocation[] } {
  const live = new Set(liveAttemptIds);
  const reclaimed: WorktreeAllocation[] = [];
  const remaining: WorktreeAllocation[] = [];
  for (const allocation of state.allocations) {
    (live.has(allocation.attemptId) ? remaining : reclaimed).push(allocation);
  }
  return { state: reclaimed.length === 0 ? state : { allocations: remaining }, reclaimed };
}
