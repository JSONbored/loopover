import type { WorktreeExecFn } from "@jsonbored/gittensory-engine";
import type { RunGitFn } from "./repo-clone.js";

export function createRealWorktreeExec(timeoutMs?: number): WorktreeExecFn;

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

export function prepareAttemptWorktree(
  repoFullName: string,
  attemptId: string,
  options?: PrepareAttemptWorktreeOptions,
): Promise<PrepareAttemptWorktreeResult>;

export function cleanupAttemptWorktree(
  repoPath: string,
  worktreePath: string,
  attemptOk: boolean,
  options?: { exec?: WorktreeExecFn; timeoutMs?: number },
): Promise<{ ok: boolean; removed: boolean; error?: string }>;
