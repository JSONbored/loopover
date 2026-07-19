import { spawn } from "node:child_process";
import { addWorktree, removeWorktree, shouldRetainWorktree } from "@loopover/engine";
import { ensureRepoCloned } from "./repo-clone.js";
// Real attempt-worktree preparation (#5132, Wave 3.5 follow-up). Composes ensureRepoCloned (repo-clone.js,
// the missing base-clone-management step) with @loopover/engine's already-built, already-tested
// addWorktree/removeWorktree primitives -- which existed but were never called from this package, so
// `workingDirectory` handed to runIterateLoop was always just an empty directory with no real git repo in
// it. This is the caller that finally exercises them for real.
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Real child_process-backed implementation of the engine's WorktreeExecFn contract. Resolves (never
 * rejects) on error/timeout, mirroring coding-agent-construction.js's createRealCliSubprocessSpawn -- a
 * failed `git worktree add`'s stderr is the diagnosable signal, not something to lose to an unhandled
 * rejection.
 */
export function createRealWorktreeExec(timeoutMs = DEFAULT_TIMEOUT_MS) {
    return (cmd, args, opts) => new Promise((resolve) => {
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
export async function prepareAttemptWorktree(repoFullName, attemptId, options = {}) {
    const cloneResult = await ensureRepoCloned(repoFullName, options);
    if (!cloneResult.ok)
        return { ok: false, error: cloneResult.error ?? "ensure_repo_cloned_failed" };
    const exec = options.exec ?? createRealWorktreeExec(options.timeoutMs);
    const baseBranch = typeof options.baseBranch === "string" && options.baseBranch.trim() ? options.baseBranch.trim() : "main";
    const added = await addWorktree({ exec, repoPath: cloneResult.repoPath, baseBranch, attemptId });
    if (!added.ok)
        return { ok: false, repoPath: cloneResult.repoPath, error: added.error ?? "git_worktree_add_failed" };
    return { ok: true, worktreePath: added.plan.worktreePath, branchName: added.plan.branchName, repoPath: cloneResult.repoPath };
}
/**
 * Tear down an attempt's worktree once the attempt concludes, per the engine's own retention policy: a
 * failed attempt's worktree is RETAINED for post-mortem inspection, a succeeded one is removed.
 */
export function cleanupAttemptWorktree(repoPath, worktreePath, attemptOk, options = {}) {
    const exec = options.exec ?? createRealWorktreeExec(options.timeoutMs);
    return removeWorktree({ exec, repoPath, worktreePath, retain: shouldRetainWorktree(attemptOk) });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXR0ZW1wdC13b3JrdHJlZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImF0dGVtcHQtd29ya3RyZWUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQzNDLE9BQU8sRUFBRSxXQUFXLEVBQUUsY0FBYyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFFckYsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFHbkQsMkdBQTJHO0FBQzNHLGdHQUFnRztBQUNoRyxxR0FBcUc7QUFDckcsMEdBQTBHO0FBQzFHLCtEQUErRDtBQUUvRCxNQUFNLGtCQUFrQixHQUFHLE9BQU8sQ0FBQztBQWdCbkM7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUsc0JBQXNCLENBQUMsU0FBUyxHQUFHLGtCQUFrQjtJQUNuRSxPQUFPLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUN6QixJQUFJLE9BQU8sQ0FBcUIsQ0FBQyxPQUFPLEVBQUUsRUFBRTtRQUMxQyxNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsRUFBRSxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxDQUFDLFFBQVEsRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQzFGLElBQUksTUFBTSxHQUFHLEVBQUUsQ0FBQztRQUNoQixJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUM7UUFDaEIsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUM1QixLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ3RCLE9BQU8sQ0FBQyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHLE1BQU0scUJBQXFC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