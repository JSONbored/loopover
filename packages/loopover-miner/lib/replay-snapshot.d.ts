import type { WorktreeExecFn, WorktreeRemoveResult } from "@loopover/engine";
export type ReplaySnapshotCommit = {
    sha: string;
    date: string;
    subject: string;
};
export type ReplaySnapshotTag = {
    name: string;
    date: string;
    targetSha: string;
};
export type ReplaySnapshotReadme = {
    filename: string;
    content: string;
};
export type ReplaySnapshot = {
    repoFullName: string;
    commitSha: string;
    worktreePath: string;
    targetDate: string;
    commits: ReplaySnapshotCommit[];
    tags: ReplaySnapshotTag[];
    readme: ReplaySnapshotReadme | null;
    exportedAt: string;
};
export type ReplaySnapshotStore = {
    dbPath: string;
    getSnapshot(repoFullName: string, commitSha: string): ReplaySnapshot | null;
    saveSnapshot(snapshot: Omit<ReplaySnapshot, "exportedAt">): ReplaySnapshot;
    close(): void;
};
export declare function resolveReplaySnapshotDbPath(env?: Record<string, string | undefined>): string;
/** Worktree exports live under this dir inside the repo, mirroring worktree-allocator.ts's WORKTREE_SUBDIR. */
export declare const REPLAY_SNAPSHOT_SUBDIR = ".loopover-replay-snapshots";
/** PURE: the deterministic on-disk location for a (repo, commit) replay export -- same pair -> same path. */
export declare function planReplaySnapshotPath(input: {
    repoPath: string;
    commitSha: string;
}): string;
/** PURE: fails fast (throws) if any exported commit or tag carries a date LATER than the target commit's own
 *  date. Returns nothing on success. */
export declare function validateSnapshotFreshness(input: {
    targetDate: string;
    commits: ReplaySnapshotCommit[];
    tags: ReplaySnapshotTag[];
}): void;
export declare function openReplaySnapshotStore(dbPath?: string): ReplaySnapshotStore;
export declare function closeDefaultReplaySnapshotStore(): void;
/**
 * Export a frozen, reproducible replay snapshot for (repoFullName, commitSha): a detached working-tree checkout
 * at that commit plus a context bundle (commit history, reachable tags, README-at-commit). Returns the CACHED
 * snapshot without touching git again if one already exists for this exact (repo, commit) pair.
 */
export declare function exportReplaySnapshot(input: {
    repoPath: string;
    repoFullName: string;
    commitSha: string;
}, deps: {
    exec: WorktreeExecFn;
    store?: ReplaySnapshotStore;
}): Promise<ReplaySnapshot>;
/** Tear down a replay snapshot's working-tree export (the cached context-bundle row is left in place -- it is
 *  cheap, commit-keyed, and re-usable even after the on-disk tree is removed; only re-adding the worktree would
 *  require the tree again, which is out of this function's scope). */
export declare function removeReplaySnapshotWorktree(exec: WorktreeExecFn, repoPath: string, worktreePath: string): Promise<WorktreeRemoveResult>;
