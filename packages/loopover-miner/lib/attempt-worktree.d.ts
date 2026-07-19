import type { WorktreeExecFn } from "@loopover/engine";
import type { RunGitFn } from "./repo-clone.js";
export type PrepareAttemptWorktreeOptions = {
    baseBranch?: string;
    cloneBaseDir?: string;
    env?: Record<string, string | undefined>;
    exec?: WorktreeExecFn;
    timeoutMs?: number;
    remoteUrl?: string;
    runGit?: RunGitFn;
};
export type PrepareAttemptWorktreeResult = {
    ok: true;
    worktreePath: string;
    branchName: string;
    repoPath: string;
} | {
    ok: false;
    repoPath?: string;
    error: string;
};
/**
 * Real child_process-backed implementation of the engine's WorktreeExecFn contract. Resolves (never
 * rejects) on error/timeout, mirroring coding-agent-construction.js's createRealCliSubprocessSpawn -- a
 * failed `git worktree add`'s stderr is the diagnosable signal, not something to lose to an unhandled
 * rejection.
 */
export declare function createRealWorktreeExec(timeoutMs?: number): WorktreeExecFn;
/**
 * Prepare a real, isolated git worktree for one attempt: ensure the target repo's base clone exists and is
 * current, then create a fresh `git worktree` off it on a deterministically-named branch. Fails closed
 * (`ok: false`) on any step's failure rather than handing back a half-prepared directory.
 */
export declare function prepareAttemptWorktree(repoFullName: string, attemptId: string, options?: PrepareAttemptWorktreeOptions): Promise<PrepareAttemptWorktreeResult>;
/**
 * Tear down an attempt's worktree once the attempt concludes, per the engine's own retention policy: a
 * failed attempt's worktree is RETAINED for post-mortem inspection, a succeeded one is removed.
 */
export declare function cleanupAttemptWorktree(repoPath: string, worktreePath: string, attemptOk: boolean, options?: {
    exec?: WorktreeExecFn;
    timeoutMs?: number;
}): Promise<{
    ok: boolean;
    removed: boolean;
    error?: string;
}>;
