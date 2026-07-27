// Copycat/plagiarism-detection evidence collection (#1969) -- extracted alongside slop-detection.ts, the
// duplicate-cluster/AI-slop sibling this mirrors. shouldCollectCopycatEvidence gates on settings the same way
// shouldCollectSlopEvidence does; runCopycatAssessment fetches a BOUNDED candidate set of earlier open siblings
// + recently-merged PRs on the same repo, extracts each candidate's added-line content, and hands the whole
// thing to the pure containment engine (src/signals/copycat.ts).

import { listPullRequestFiles, listRecentMergedPullRequests } from "../db/repositories";
import { diffFilePriority, extractAddedLines } from "../review/review-diff";
import { assessCopycat, type CopycatAssessment, type CopycatPriorArtCandidate } from "../signals/copycat";
import type { PullRequestRecord, RepositorySettings } from "../types";

export function shouldCollectCopycatEvidence(settings: Pick<RepositorySettings, "copycatGateMode">): boolean {
  return (settings.copycatGateMode ?? "off") !== "off";
}

/** Bound on how many prior-art candidates get their full patch content fetched and scored — keeps a single
 *  gate evaluation's extra DB reads bounded regardless of repo activity, per #1969's own "bounded, fail-safe,
 *  precision-first" requirement. Open siblings (a live "someone raced my PR" case) are prioritized over
 *  historical merged PRs; the remainder of the budget goes to recently-merged candidates.
 *
 *  #9033: raised from 25 to 50 — on an active reward-eligible repo, a copycat's actual match could be candidate
 *  #26+ and never get compared at all, the exact gap that let a cross-issue reward-farming duplicate evade
 *  detection. 50 doubles the headroom (worst case: up to 50 concurrent `listPullRequestFiles` reads per phase,
 *  a single-repo-scoped indexed D1 read each, not an external API call, so this stays cheap and bounded) while
 *  the recently-merged phase ALSO now spends its share of the budget on the candidates most likely to actually
 *  match (see `runCopycatAssessment`'s own doc comment on the overlap-count-sorted pre-filter) rather than
 *  merely the most recent ones that happen to touch an overlapping path at all. */
export const MAX_COPYCAT_CANDIDATES = 50;

/** Drop generated/lockfile/vendored files from a copycat comparison, reusing review-diff.ts's own
 *  `diffFilePriority` classification (tier 4 = lockfiles/dist/build/out/coverage/vendor/node_modules) rather
 *  than inventing a second exclusion list — the same content that AI-review budgeting already treats as
 *  least-signal is exactly what #1969 asks to drop from the comparison ("reuse review.exclude_paths to drop
 *  generated/lockfile/boilerplate lines"). */
function isComparableSourcePath(path: string): boolean {
  return diffFilePriority(path) !== 4;
}

/** Extract one PR's comparable added-line content from its already-fetched file records: lockfile/generated/
 *  vendored files excluded, added lines from every remaining file concatenated in file order. Pure. */
export function comparableAddedLines(
  files: readonly { path: string; payload?: Record<string, unknown> | null | undefined }[],
): string[] {
  const lines: string[] = [];
  for (const file of files) {
    if (!isComparableSourcePath(file.path)) continue;
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : undefined;
    lines.push(...extractAddedLines(patch));
  }
  return lines;
}

/**
 * Fetch and score this PR's added code against a bounded candidate set of earlier open siblings + recently
 * merged PRs on the same repo (#1969). `otherOpenPullRequests` is reused as-is (already fetched by the caller
 * for other gate purposes — no extra query); recently-merged candidates are pre-filtered by changed-file-path
 * overlap with the current PR (cheap — `RecentMergedPullRequestRecord.changedFiles` is already loaded) BEFORE
 * their more expensive patch content is fetched at all, so a candidate that could not possibly overlap never
 * costs an extra `listPullRequestFiles` read.
 *
 * #9033: `listRecentMergedPullRequests` can return up to 200 rows, and MAX_COPYCAT_CANDIDATES (the fetch budget)
 * is smaller than that on an active repo — so which of the path-overlapping candidates get the expensive fetch
 * matters. Rather than merely taking the `remainingBudget` MOST-RECENT overlapping candidates (the previous
 * `mergedAt`-desc order, inherited from `listRecentMergedPullRequests`'s own query), they are re-sorted by
 * OVERLAP COUNT (how many changed-file paths they actually share with this PR) descending first — more shared
 * paths is a stronger prior signal of a real match than mere recency, and this is still a cheap in-memory sort
 * over already-loaded `changedFiles` data, not an extra fetch. `Array.prototype.sort` is stable, so candidates
 * tied on overlap count keep their original recency order.
 */
export async function runCopycatAssessment(
  env: Env,
  args: {
    repoFullName: string;
    pr: { number: number; createdAt?: string | null | undefined };
    files: Awaited<ReturnType<typeof listPullRequestFiles>>;
    otherOpenPullRequests: readonly PullRequestRecord[];
    mode: RepositorySettings["copycatGateMode"];
    minScore: RepositorySettings["copycatGateMinScore"];
  },
): Promise<CopycatAssessment> {
  // Each phase's candidate list is already bounded by MAX_COPYCAT_CANDIDATES before any fetch starts, so
  // fetching every candidate's files CONCURRENTLY within a phase (rather than one listPullRequestFiles round-
  // trip at a time, up to 2x MAX_COPYCAT_CANDIDATES sequential DB reads total across both phases) does not raise
  // the worst-case fan-out -- it only removes the artificial serialization between independent reads.
  // Promise.all preserves each phase's original candidate order in its result array regardless of resolution
  // order, so priorArt's ordering (open siblings first, then merged) is unchanged.
  const openCandidates = args.otherOpenPullRequests.slice(0, MAX_COPYCAT_CANDIDATES);
  const openPriorArt: CopycatPriorArtCandidate[] = await Promise.all(
    openCandidates.map(async (sibling) => {
      const files = await listPullRequestFiles(env, args.repoFullName, sibling.number).catch(() => []);
      return { pullNumber: sibling.number, lines: comparableAddedLines(files), submittedAt: sibling.createdAt };
    }),
  );

  let mergedPriorArt: CopycatPriorArtCandidate[] = [];
  const remainingBudget = MAX_COPYCAT_CANDIDATES - openPriorArt.length;
  if (remainingBudget > 0) {
    const changedPathSet = new Set(args.files.map((file) => file.path));
    const recentMerged = await listRecentMergedPullRequests(env, args.repoFullName).catch(() => []);
    // #9033: rank path-overlapping candidates by OVERLAP COUNT (descending) before spending the bounded budget --
    // more shared changed-file paths is a stronger prior signal of a genuine match than mere merge recency. A
    // stable sort keeps candidates tied on overlap count in their original (mergedAt-desc) order.
    const overlapping = recentMerged
      .map((candidate) => ({ candidate, overlapCount: candidate.changedFiles.filter((path) => changedPathSet.has(path)).length }))
      .filter((entry) => entry.overlapCount > 0)
      .sort((left, right) => right.overlapCount - left.overlapCount)
      .slice(0, remainingBudget)
      .map((entry) => entry.candidate);
    mergedPriorArt = await Promise.all(
      overlapping.map(async (candidate) => {
        const files = await listPullRequestFiles(env, args.repoFullName, candidate.number).catch(() => []);
        return { pullNumber: candidate.number, lines: comparableAddedLines(files), submittedAt: candidate.mergedAt };
      }),
    );
  }
  const priorArt = [...openPriorArt, ...mergedPriorArt];

  return assessCopycat({
    candidateLines: comparableAddedLines(args.files),
    candidateSubmittedAt: args.pr.createdAt,
    priorArt,
    mode: args.mode ?? "off",
    minScore: args.minScore ?? null,
  });
}
