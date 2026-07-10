import { join } from "node:path";

// Git-worktree-per-attempt isolation primitive (#4269). Each coding-agent attempt runs in its OWN `git worktree`,
// so concurrent attempts (same or different issues) never collide on a shared working directory. This module is
// split into a PURE planning layer (deterministic path/branch naming) and thin injected-exec wrappers around the
// actual `git worktree add`/`git worktree remove` — the exec is injected (mirroring cli-subprocess-driver's SpawnFn
// convention, #4266), so all naming/collision/lifecycle logic is unit-testable without shelling out to git in CI.
//
// COLLISION: naming is deterministic and keyed on the attempt id (never a random suffix), so two concurrent
// attempts on the same repo can never be handed the same worktree path or branch, AND a crashed attempt's worktree
// stays identifiable and cleanable after the fact.
//
// RETENTION POLICY (see shouldRetainWorktree): a SUCCEEDED attempt's worktree is removed once it concludes; a
// FAILED attempt's worktree is RETAINED for post-mortem inspection (its deterministic name makes it findable).

export type WorktreeExecResult = { code: number | null; stdout?: string; stderr?: string };

/** The injected git exec — a real `child_process` spawn in prod, a fake in tests. */
export type WorktreeExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string },
) => Promise<WorktreeExecResult>;

/** The deterministic worktree location + branch for one attempt. */
export type WorktreePlan = {
  attemptId: string;
  worktreePath: string;
  branchName: string;
};

/** Worktrees live under this dir inside the repo; the branch carries this prefix. */
export const WORKTREE_SUBDIR = ".gittensory-worktrees";
export const WORKTREE_BRANCH_PREFIX = "gittensory/attempt/";
const MAX_SLUG_LENGTH = 64;

/** Deterministically slugify an attempt id into a filesystem- and git-ref-safe token (same id → same slug). */
function slugifyAttemptId(attemptId: string): string {
  const slug = attemptId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!slug) throw new Error("invalid_attempt_id");
  return slug.slice(0, MAX_SLUG_LENGTH);
}

/**
 * Compute the deterministic worktree path + branch name for an attempt — keyed on the attempt id, never a random
 * suffix. Pure. Two concurrent attempts with distinct ids get distinct paths/branches; the same id always maps to
 * the same location (so a crashed attempt's worktree is identifiable and cleanable).
 */
export function planWorktree(input: { repoPath: string; attemptId: string }): WorktreePlan {
  const slug = slugifyAttemptId(input.attemptId);
  return {
    attemptId: input.attemptId,
    worktreePath: join(input.repoPath, WORKTREE_SUBDIR, slug),
    branchName: `${WORKTREE_BRANCH_PREFIX}${slug}`,
  };
}

export type WorktreeAddResult = { ok: boolean; plan: WorktreePlan; error?: string };

/**
 * Create the attempt's isolated worktree via `git worktree add -b <branch> <path> <baseBranch>`, run through the
 * injected exec. Returns the plan (so the caller knows the path/branch) and, on failure, git's stderr.
 */
export async function addWorktree(input: {
  exec: WorktreeExecFn;
  repoPath: string;
  baseBranch: string;
  attemptId: string;
}): Promise<WorktreeAddResult> {
  const plan = planWorktree({ repoPath: input.repoPath, attemptId: input.attemptId });
  const result = await input.exec(
    "git",
    ["worktree", "add", "-b", plan.branchName, plan.worktreePath, input.baseBranch],
    { cwd: input.repoPath },
  );
  if (result.code === 0) return { ok: true, plan };
  const detail = (result.stderr ?? "").trim() || `git_worktree_add_exit_${result.code}`;
  return { ok: false, plan, error: detail };
}

export type WorktreeRemoveResult = { ok: boolean; removed: boolean; error?: string };

/** Retention policy: retain a FAILED attempt's worktree for post-mortem, remove a SUCCEEDED attempt's. */
export function shouldRetainWorktree(attemptOk: boolean): boolean {
  return !attemptOk;
}

/**
 * Tear down the attempt's worktree via `git worktree remove --force <path>`, through the injected exec. When
 * `retain` is set the worktree is KEPT (no exec, `removed: false`) for post-mortem — pass `shouldRetainWorktree(ok)`.
 */
export async function removeWorktree(input: {
  exec: WorktreeExecFn;
  repoPath: string;
  worktreePath: string;
  retain?: boolean;
}): Promise<WorktreeRemoveResult> {
  if (input.retain) return { ok: true, removed: false };
  const result = await input.exec("git", ["worktree", "remove", "--force", input.worktreePath], {
    cwd: input.repoPath,
  });
  if (result.code === 0) return { ok: true, removed: true };
  const detail = (result.stderr ?? "").trim() || `git_worktree_remove_exit_${result.code}`;
  return { ok: false, removed: false, error: detail };
}
