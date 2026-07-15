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
 *  historical merged PRs; the remainder of the budget goes to recently-merged candidates. */
export const MAX_COPYCAT_CANDIDATES = 25;

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
  const priorArt: CopycatPriorArtCandidate[] = [];

  const openCandidates = args.otherOpenPullRequests.slice(0, MAX_COPYCAT_CANDIDATES);
  for (const sibling of openCandidates) {
    const files = await listPullRequestFiles(env, args.repoFullName, sibling.number).catch(() => []);
    priorArt.push({ pullNumber: sibling.number, lines: comparableAddedLines(files), submittedAt: sibling.createdAt });
  }

  const remainingBudget = MAX_COPYCAT_CANDIDATES - priorArt.length;
  if (remainingBudget > 0) {
    const changedPathSet = new Set(args.files.map((file) => file.path));
    const recentMerged = await listRecentMergedPullRequests(env, args.repoFullName).catch(() => []);
    const overlapping = recentMerged
      .filter((candidate) => candidate.changedFiles.some((path) => changedPathSet.has(path)))
      .slice(0, remainingBudget);
    for (const candidate of overlapping) {
      const files = await listPullRequestFiles(env, args.repoFullName, candidate.number).catch(() => []);
      priorArt.push({ pullNumber: candidate.number, lines: comparableAddedLines(files), submittedAt: candidate.mergedAt });
    }
  }

  return assessCopycat({
    candidateLines: comparableAddedLines(args.files),
    candidateSubmittedAt: args.pr.createdAt,
    priorArt,
    mode: args.mode ?? "off",
    minScore: args.minScore ?? null,
  });
}
