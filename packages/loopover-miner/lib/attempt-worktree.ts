import { spawn } from "node:child_process";
import { addWorktree, removeWorktree, shouldRetainWorktree } from "@loopover/engine";
import type { WorktreeExecFn, WorktreeExecResult } from "@loopover/engine";
import { ensureRepoCloned } from "./repo-clone.js";
import type { RunGitFn } from "./repo-clone.js";

// Real attempt-worktree preparation (#5132, Wave 3.5 follow-up). Composes ensureRepoCloned (repo-clone.js,
// the missing base-clone-management step) with @loopover/engine's already-built, already-tested
// addWorktree/removeWorktree primitives -- which existed but were never called from this package, so
// `workingDirectory` handed to runIterateLoop was always just an empty directory with no real git repo in
// it. This is the caller that finally exercises them for real.

const DEFAULT_TIMEOUT_MS = 120_000;

export type PrepareAttemptWorktreeOptions = {
  baseBranch?: string;
  cloneBaseDir?: string;
  env?: Record<string, string | undefined>;
  exec?: WorktreeExecFn;
  timeoutMs?: number;
  remoteUrl?: string;
  runGit?: RunGitFn;
};

export type PrepareAttemptWorktreeResult =
  | { ok: true; worktreePath: string; branchName: string; repoPath: string }
  | { ok: false; repoPath?: string; error: string };

/**
 * Real child_process-backed implementation of the engine's WorktreeExecFn contract. Resolves (never
 * rejects) on error/timeout, mirroring coding-agent-construction.js's createRealCliSubprocessSpawn -- a
 * failed `git worktree add`'s stderr is the diagnosable signal, not something to lose to an unhandled
 * rejection.
 */
export function createRealWorktreeExec(timeoutMs = DEFAULT_TIMEOUT_MS): WorktreeExecFn {
  return (cmd, args, opts) =>
    new Promise<WorktreeExecResult>((resolve) => {
      const child = spawn(cmd, [...args], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, stdout, stderr: `${stderr}\ntimed_out_after_${timeoutMs}ms`.trim() });
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}

/**
 * Prepare a real, isolated git worktree for one attempt: ensure the target repo's base clone exists and is
 * current, then create a fresh `git worktree` off it on a deterministically-named branch. Fails closed
 * (`ok: false`) on any step's failure rather than handing back a half-prepared directory.
 */
export async function prepareAttemptWorktree(
  repoFullName: string,
  attemptId: string,
  options: PrepareAttemptWorktreeOptions = {},
): Promise<PrepareAttemptWorktreeResult> {
  const cloneResult = await ensureRepoCloned(repoFullName, options);
  if (!cloneResult.ok) return { ok: false, error: cloneResult.error ?? "ensure_repo_cloned_failed" };

  const exec = options.exec ?? createRealWorktreeExec(options.timeoutMs);
  const baseBranch = typeof options.baseBranch === "string" && options.baseBranch.trim() ? options.baseBranch.trim() : "main";
  const added = await addWorktree({ exec, repoPath: cloneResult.repoPath, baseBranch, attemptId });
  if (!added.ok) return { ok: false, repoPath: cloneResult.repoPath, error: added.error ?? "git_worktree_add_failed" };

  return { ok: true, worktreePath: added.plan.worktreePath, branchName: added.plan.branchName, repoPath: cloneResult.repoPath };
}

/**
 * Tear down an attempt's worktree once the attempt concludes, per the engine's own retention policy: a
 * failed attempt's worktree is RETAINED for post-mortem inspection, a succeeded one is removed.
 */
export function cleanupAttemptWorktree(
  repoPath: string,
  worktreePath: string,
  attemptOk: boolean,
  options: { exec?: WorktreeExecFn; timeoutMs?: number } = {},
): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const exec = options.exec ?? createRealWorktreeExec(options.timeoutMs);
  return removeWorktree({ exec, repoPath, worktreePath, retain: shouldRetainWorktree(attemptOk) });
}
