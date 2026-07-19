import { describe, expect, it, vi } from "vitest";

// prepareAttemptWorktree fails closed with a generic marker when its own dependencies report failure WITHOUT a
// specific error string (the `?? "ensure_repo_cloned_failed"` / `?? "git_worktree_add_failed"` fallbacks). The
// real ensureRepoCloned/addWorktree always attach an error on failure, so these defensive fallbacks are only
// reachable by injecting an error-less failure -- hence the module mocks here, kept in their own file so the
// real-git integration coverage in miner-attempt-worktree.test.ts stays unmocked.
vi.mock("../../packages/loopover-miner/lib/repo-clone.js", () => ({
  ensureRepoCloned: vi.fn(),
}));
vi.mock("@loopover/engine", () => ({
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  shouldRetainWorktree: vi.fn(),
}));

import { addWorktree } from "@loopover/engine";
import { prepareAttemptWorktree } from "../../packages/loopover-miner/lib/attempt-worktree.js";
import { ensureRepoCloned } from "../../packages/loopover-miner/lib/repo-clone.js";

describe("prepareAttemptWorktree defensive fallbacks (#5132)", () => {
  it("falls back to ensure_repo_cloned_failed when the clone fails without a specific error", async () => {
    vi.mocked(ensureRepoCloned).mockResolvedValue({ ok: false, repoPath: "" } as never);

    const result = await prepareAttemptWorktree("acme/widgets", "attempt-1", {});

    expect(result).toEqual({ ok: false, error: "ensure_repo_cloned_failed" });
    expect(addWorktree).not.toHaveBeenCalled();
  });

  it("falls back to git_worktree_add_failed when the worktree add fails without a specific error", async () => {
    vi.mocked(ensureRepoCloned).mockResolvedValue({ ok: true, repoPath: "/tmp/repo" } as never);
    vi.mocked(addWorktree).mockResolvedValue({
      ok: false,
      plan: { attemptId: "attempt-1", worktreePath: "", branchName: "" },
    } as never);

    const result = await prepareAttemptWorktree("acme/widgets", "attempt-1", { exec: vi.fn() });

    expect(result).toEqual({ ok: false, repoPath: "/tmp/repo", error: "git_worktree_add_failed" });
  });
});
