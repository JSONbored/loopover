// Bridge (#6160): turns a frozen replay snapshot (replay-snapshot.js, #3010) into a leakage-safe replay task via
// the leakage-safe generator (replay-task-generation.js, #3011), so the historical-replay calibration flow
// (calibration-run.js, #4248) never scores a task built from historical context that still leaks post-T state.
//
// #3011 shipped the leakage-safe generator (scrub/lint/select/classify + generateReplayTask) with ZERO callers:
// nothing turned a #3010 snapshot into a task, so scrubForwardReferences/lintFrozenContext were never actually run
// on real historical-replay data -- the safety harness sat unused. This module is that missing seam. It reads the
// snapshot's own free-text context (README-at-T, commit subjects, reachable tag names -- the fields a forward
// reference can hide in), derives the leakage context the snapshot already knows (every pre-T commit SHA it
// carries), and hands both to generateReplayTask, which LINTS then SCRUBS the frozen context BEFORE returning a
// task -- exactly #3011's original design intent.
//
// REMAINING GAP (noted honestly, per the issue): the snapshot is git-only, so it cannot know issue numbers.
// `knownIssueMax` / `revealedIssueNumbers` -- the calibration harness's issue-history knowledge -- must be supplied
// by the caller. And the replay EXECUTOR that turns these frozen tasks into the `{ replayPlan, revealedHistory }`
// results calibration-run.js scores is still unbuilt (nothing calls exportReplaySnapshot yet either). This bridge
// wires the two halves that DO exist -- snapshot -> leakage-safe task -- and leaves that executor as the next
// connective step. Every function here is pure and deterministic (no clock, no randomness, no IO).

import { generateReplayScoringKey, generateReplayTask } from "./replay-task-generation.js";

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("invalid_replay_snapshot");
  }
  return snapshot;
}

function snapshotCommits(snapshot) {
  return Array.isArray(snapshot.commits) ? snapshot.commits : [];
}

// The snapshot's free-text context, in a fixed order: README-at-T, then each commit subject, then each reachable
// tag name. Unlike the structurally pre-T-validated SHAs/dates, these are author-controlled prose where a forward
// reference can hide, so they are exactly what must be scrubbed/linted before a task is frozen. Empty and
// non-string fields are skipped so they never dilute the frozen context.
export function collectFrozenContextTexts(snapshot) {
  assertSnapshot(snapshot);
  const texts = [];
  const readmeContent = snapshot.readme?.content;
  if (typeof readmeContent === "string" && readmeContent.length > 0) texts.push(readmeContent);
  for (const commit of snapshotCommits(snapshot)) {
    if (typeof commit?.subject === "string" && commit.subject.length > 0) texts.push(commit.subject);
  }
  const tags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
  for (const tag of tags) {
    if (typeof tag?.name === "string" && tag.name.length > 0) texts.push(tag.name);
  }
  return texts;
}

// The leakage context #3011's scrubber needs. The pre-T commit SHAs are DERIVED from the snapshot itself (it
// carries the full ancestry up to T), so a snapshot's own commits are never mistaken for forward references;
// the issue-number knowledge the git snapshot cannot hold is passed through from the caller.
export function buildLeakageContextFromSnapshot(snapshot, issueContext = {}) {
  assertSnapshot(snapshot);
  return {
    knownIssueMax: issueContext.knownIssueMax,
    knownCommitShas: snapshotCommits(snapshot).map((commit) => commit?.sha),
    revealedIssueNumbers: issueContext.revealedIssueNumbers,
  };
}

// The freeze-point candidate #3011's selector/generator expect, mapped from the snapshot plus the revealed post-T
// side (commit count + ground truth) the snapshot deliberately does not hold.
export function buildReplayCandidateFromSnapshot(snapshot, revealed = {}) {
  assertSnapshot(snapshot);
  return {
    repo: typeof snapshot.repoFullName === "string" ? snapshot.repoFullName : null,
    commitT: typeof snapshot.commitSha === "string" ? snapshot.commitSha : null,
    lastActivityAt: typeof snapshot.targetDate === "string" ? snapshot.targetDate : null,
    priorCommitCount: snapshotCommits(snapshot).length,
    revealedCommitCount: revealed.revealedCommitCount,
    revealedGroundTruth: revealed.revealedGroundTruth,
    frozenContextTexts: collectFrozenContextTexts(snapshot),
  };
}

// The wiring. Builds the leakage context + candidate from the snapshot, then runs generateReplayTask, which LINTS
// the frozen context (rejecting on any unscrubbable forward reference) and SCRUBS the surviving text before
// returning the frozen task -- so a replay task is never generated from leaky historical context.
export function generateLeakageSafeReplayTask(snapshot, revealed = {}, issueContext = {}, options = {}) {
  const context = buildLeakageContextFromSnapshot(snapshot, issueContext);
  const candidate = buildReplayCandidateFromSnapshot(snapshot, revealed);
  return generateReplayTask(candidate, context, options);
}

// Scoring-only sibling: the isolated post-execution scorer key for the same snapshot. It shares only selection
// eligibility with the task above and never carries frozen context (mirroring #3011's own generate/scoring split),
// so a caller must check generateLeakageSafeReplayTask's own result before treating the two as a matched pair.
export function generateLeakageSafeScoringKey(snapshot, revealed = {}, options = {}) {
  return generateReplayScoringKey(buildReplayCandidateFromSnapshot(snapshot, revealed), options);
}
