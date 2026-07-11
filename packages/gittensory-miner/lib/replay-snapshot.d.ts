import type { WorktreeExecFn, WorktreeRemoveResult } from "@jsonbored/gittensory-engine";

export const REPLAY_SNAPSHOT_SUBDIR: ".gittensory-replay-snapshots";

export type ReplaySnapshotCommit = { sha: string; date: string; subject: string };
export type ReplaySnapshotTag = { name: string; date: string; targetSha: string };
export type ReplaySnapshotReadme = { filename: string; content: string };

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

export function resolveReplaySnapshotDbPath(env?: NodeJS.ProcessEnv): string;

export function planReplaySnapshotPath(input: { repoPath: string; commitSha: string }): string;

export function validateSnapshotFreshness(input: { targetDate: string; commits: ReplaySnapshotCommit[]; tags: ReplaySnapshotTag[] }): void;

export type ReplaySnapshotStore = {
  dbPath: string;
  getSnapshot(repoFullName: string, commitSha: string): ReplaySnapshot | null;
  saveSnapshot(snapshot: Omit<ReplaySnapshot, "exportedAt">): ReplaySnapshot;
  close(): void;
};

export function openReplaySnapshotStore(dbPath?: string): ReplaySnapshotStore;
export function closeDefaultReplaySnapshotStore(): void;

export function exportReplaySnapshot(
  input: { repoPath: string; repoFullName: string; commitSha: string },
  deps: { exec: WorktreeExecFn; store?: ReplaySnapshotStore },
): Promise<ReplaySnapshot>;

export function removeReplaySnapshotWorktree(exec: WorktreeExecFn, repoPath: string, worktreePath: string): Promise<WorktreeRemoveResult>;
