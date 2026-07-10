import { describe, expect, it } from "vitest";
import {
  addWorktree,
  planWorktree,
  removeWorktree,
  shouldRetainWorktree,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_SUBDIR,
  type WorktreeExecFn,
  type WorktreeExecResult,
} from "../../packages/gittensory-engine/src/index";

/** A fake git exec that records calls and returns a scripted result. */
function fakeExec(result: WorktreeExecResult) {
  const calls: Array<{ cmd: string; args: readonly string[]; cwd: string }> = [];
  const exec: WorktreeExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    return result;
  };
  return { exec, calls };
}

describe("planWorktree (#4269)", () => {
  it("derives a deterministic, attempt-id-keyed path and branch", () => {
    const a = planWorktree({ repoPath: "/repo", attemptId: "attempt-42" });
    expect(a.branchName).toBe(`${WORKTREE_BRANCH_PREFIX}attempt-42`);
    expect(a.worktreePath.replaceAll("\\", "/")).toBe(`/repo/${WORKTREE_SUBDIR}/attempt-42`);
    expect(a.attemptId).toBe("attempt-42");
    // same id → identical plan; different id → different plan (no collision)
    expect(planWorktree({ repoPath: "/repo", attemptId: "attempt-42" })).toEqual(a);
    expect(planWorktree({ repoPath: "/repo", attemptId: "attempt-43" }).worktreePath).not.toBe(a.worktreePath);
  });

  it("sanitizes unsafe characters, trims edge separators, and caps the slug length", () => {
    const plan = planWorktree({ repoPath: "/repo", attemptId: "  Feat/Fix #99!! " });
    expect(plan.branchName).toBe(`${WORKTREE_BRANCH_PREFIX}feat-fix-99`);
    const long = planWorktree({ repoPath: "/repo", attemptId: "x".repeat(200) });
    expect(long.branchName).toBe(`${WORKTREE_BRANCH_PREFIX}${"x".repeat(64)}`);
  });

  it("rejects an attempt id that sanitizes to nothing", () => {
    expect(() => planWorktree({ repoPath: "/repo", attemptId: "  ---  " })).toThrow(/invalid_attempt_id/);
  });
});

describe("addWorktree", () => {
  it("runs `git worktree add -b <branch> <path> <base>` and returns the plan on exit 0", async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const result = await addWorktree({ exec, repoPath: "/repo", baseBranch: "main", attemptId: "attempt-1" });
    expect(result.ok).toBe(true);
    expect(result.plan.branchName).toBe(`${WORKTREE_BRANCH_PREFIX}attempt-1`);
    expect(calls[0]?.cmd).toBe("git");
    expect(calls[0]?.cwd).toBe("/repo");
    expect(calls[0]?.args.slice(0, 4)).toEqual(["worktree", "add", "-b", `${WORKTREE_BRANCH_PREFIX}attempt-1`]);
    expect(calls[0]?.args.at(-1)).toBe("main");
  });

  it("surfaces git's stderr on a non-zero exit, with a fallback when stderr is empty", async () => {
    const withStderr = await addWorktree({
      exec: fakeExec({ code: 128, stderr: "fatal: 'wt' already exists" }).exec,
      repoPath: "/repo",
      baseBranch: "main",
      attemptId: "attempt-1",
    });
    expect(withStderr.ok).toBe(false);
    expect(withStderr.error).toBe("fatal: 'wt' already exists");

    const noStderr = await addWorktree({
      exec: fakeExec({ code: null }).exec,
      repoPath: "/repo",
      baseBranch: "main",
      attemptId: "attempt-1",
    });
    expect(noStderr.error).toBe("git_worktree_add_exit_null");
  });
});

describe("removeWorktree + retention policy", () => {
  it("retains a failed attempt's worktree and removes a succeeded one", () => {
    expect(shouldRetainWorktree(false)).toBe(true);
    expect(shouldRetainWorktree(true)).toBe(false);
  });

  it("skips the git call and reports removed:false when retain is set", async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const result = await removeWorktree({ exec, repoPath: "/repo", worktreePath: "/repo/wt", retain: true });
    expect(result).toEqual({ ok: true, removed: false });
    expect(calls).toHaveLength(0);
  });

  it("runs `git worktree remove --force` and reports success or a redacted-free error", async () => {
    const ok = fakeExec({ code: 0 });
    const removed = await removeWorktree({ exec: ok.exec, repoPath: "/repo", worktreePath: "/repo/wt" });
    expect(removed).toEqual({ ok: true, removed: true });
    expect(ok.calls[0]?.args).toEqual(["worktree", "remove", "--force", "/repo/wt"]);

    const failed = await removeWorktree({
      exec: fakeExec({ code: 1 }).exec,
      repoPath: "/repo",
      worktreePath: "/repo/wt",
    });
    expect(failed.ok).toBe(false);
    expect(failed.removed).toBe(false);
    expect(failed.error).toBe("git_worktree_remove_exit_1");
  });
});
