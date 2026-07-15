import type {
  ForwardRefContext,
  FreezePointCandidate,
  ReplayScoringKey,
  ReplayScoringKeyRejected,
  ReplayTask,
  ReplayTaskOptions,
  ReplayTaskRejected,
} from "./replay-task-generation.js";

export type ReplaySnapshotCommit = {
  sha?: string;
  date?: string;
  subject?: string;
};

export type ReplaySnapshotTag = {
  name?: string;
  date?: string;
  targetSha?: string;
};

export type ReplaySnapshot = {
  repoFullName?: string;
  commitSha?: string;
  targetDate?: string;
  commits?: ReplaySnapshotCommit[];
  tags?: ReplaySnapshotTag[];
  readme?: { filename?: string; content?: string } | null;
  [key: string]: unknown;
};

export type RevealedReplaySide = {
  revealedCommitCount?: number;
  revealedGroundTruth?: unknown;
};

export type SnapshotIssueContext = {
  knownIssueMax?: number;
  revealedIssueNumbers?: number[];
};

export function collectFrozenContextTexts(snapshot: ReplaySnapshot): string[];

export function buildLeakageContextFromSnapshot(
  snapshot: ReplaySnapshot,
  issueContext?: SnapshotIssueContext,
): ForwardRefContext;

export function buildReplayCandidateFromSnapshot(
  snapshot: ReplaySnapshot,
  revealed?: RevealedReplaySide,
): FreezePointCandidate;

export function generateLeakageSafeReplayTask(
  snapshot: ReplaySnapshot,
  revealed?: RevealedReplaySide,
  issueContext?: SnapshotIssueContext,
  options?: ReplayTaskOptions,
): ReplayTask | ReplayTaskRejected;

export function generateLeakageSafeScoringKey(
  snapshot: ReplaySnapshot,
  revealed?: RevealedReplaySide,
  options?: ReplayTaskOptions,
): ReplayScoringKey | ReplayScoringKeyRejected;
