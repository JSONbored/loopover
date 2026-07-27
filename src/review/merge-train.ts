// FIFO merge-train gate (#selfhost-merge-train). Without this, a PR merges the instant its OWN gate clears,
// with zero awareness of an older sibling PR still open in the same repo -- proven live via a production D1
// query to cause hundreds of out-of-order merges per repo, and the conflicts that follow. This module is the
// pure decision only: a still-viable, OVERLAPPING older sibling (not conflicted, not past the staleness cap)
// holds the newer PR's merge until the older one either merges, closes, or goes stale. Mirrors this codebase's
// existing "advisory, fail-open, defense-in-depth" lock philosophy (see claimTransientLock's own doc comment)
// rather than a hard, unbypassable serialization -- the staleness cap is the deliberate escape hatch so one
// stuck old PR can never block the repo's newer PRs forever.
//
// Overlap-scoped by design (#selfhost-merge-train-overlap), not blanket FIFO: the actual problem this gate
// exists to prevent is a merge CONFLICT (or duplicated issue-closing effort) from two PRs touching the same
// area merging out of order -- not "any newer PR must wait for any older PR, related or not." A newer PR whose
// files/linked-issues share nothing with an older sibling creates no conflict risk by merging first, so it
// never waits, REGARDLESS of that sibling's review state (this is also what keeps a PR stuck in manual review
// from silently wedging the ENTIRE queue -- it can only ever hold up a PR that actually overlaps it).
//
// #9039: an overlapping older sibling held for manual review is NOT still counted as a blocker, unlike an
// ordinary in-review PR. The confirmed production incident (#8735: 57 denials, 5 PRs blocked, 4 hours) was an
// overlapping sibling wearing the manual-review label -- overlap-scoping worked exactly as designed (those 5
// PRs genuinely shared files/issues with #8735), but a manual-review hold is administratively frozen, not
// "still in progress": nothing about the label self-clears on any timer, unlike CI/AI-review/human-review,
// which are all still making forward progress toward a natural resolution. Waiting for a PR that is not
// currently trying to reach merge or close buys nothing the 24h staleness cap doesn't already bound far worse
// -- it just multiplies a stuck PR's cost by however many newer, overlapping PRs happen to queue behind it. So
// a manual-review-held sibling is evicted from blocking entirely (same treatment as a "dirty" git conflict
// below), not merely subject to the same staleness cap as an actively-reviewing sibling.

import { isLockfile } from "../signals/path-matchers";

/** The subset of a sibling PR's fields this gate actually needs -- kept minimal and independent of
 *  `PullRequestRecord`'s full shape so this module has zero import surface beyond plain data. */
export type MergeTrainSibling = {
  number: number;
  createdAt?: string | null | undefined;
  mergeableState?: string | null | undefined;
  /** Issue numbers this PR closes, for overlap detection -- always populated on a real PullRequestRecord
   *  (empty array, never undefined, when the PR closes no issue). */
  linkedIssues?: readonly number[] | undefined;
  /** Changed file paths, when the caller has resolved them (e.g. from the `pull_request_files` cache).
   *  Absent/undefined degrades to issue-only overlap detection for this sibling, never to "no overlap
   *  possible" -- a sibling with unresolved files can still overlap via a shared linked issue. */
  changedFiles?: readonly string[] | undefined;
  /** True when this sibling currently carries the repo's configured manual-review label (#9039 -- the
   *  confirmed #8735 incident). A hold that does NOT self-clear on any timer, unlike an ordinary in-review PR
   *  still making forward progress toward merge/close on its own -- so it never blocks (see the module header
   *  for the full incident writeup). Resolved by the CALLER (same "kept minimal, zero import surface beyond
   *  plain data" shape as this whole type): mirror however "does this PR carry the manual-review label" is
   *  already resolved elsewhere in this codebase (agent-action-executor.ts's own live approve/merge guard,
   *  processors.ts) rather than inventing a second, possibly-drifting definition here. Absent/undefined ⇒ not
   *  held (unchanged from before this field existed). */
  heldForManualReview?: boolean | undefined;
};

/** How long an older, OVERLAPPING sibling can hold up a newer one before it's excluded from blocking (24
 *  hours, matching `REGATE_REPAIR_ATTEMPT_LOOKBACK_MS`'s own "genuinely stuck, not just mid-review" cutoff in
 *  src/queue/processors.ts). A normal review cycle (CI, AI review, human review) can easily run for hours; a
 *  genuinely stuck PR (its author vanished, review never completes) must not wedge a related newer PR
 *  indefinitely, so this is the escape hatch, not a tight SLA. */
export const MERGE_TRAIN_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export type MergeTrainDecision = { wait: true; blockingPr: number } | { wait: false };

/** Low-priority path buckets (lockfiles, generated/build output, vendored third-party trees) that overlapping
 *  alone never counts as real conflict risk. Lockfile-NAME matching delegates to the canonical `isLockfile`
 *  helper -- a dependency-free leaf utility in path-matchers.ts, the same delegation `review-diff.ts` and
 *  `review-grounding.ts` already use -- so this classification never drifts behind the 24+ canonical lockfile
 *  formats the way the hand-rolled 4-name regex did (a shared `poetry.lock`, `go.sum`, or `npm-shrinkwrap.json`
 *  was wrongly treated as real overlap; #8647). The directory bucket mirrors the same canonical generated/
 *  vendored set: build output (`dist`/`build`/`out`/`coverage`) and installed/vendored dependency trees
 *  (`node_modules` and the `vendor`/`third_party` family). A shared `package-lock.json` or `third_party/x`
 *  touch is routine noise, not the same-area conflict risk this gate exists to catch. */
const LOW_SIGNAL_DIR_RE = /(?:^|\/)(?:dist|build|out|coverage|node_modules|vendor|vendored|third_party|third-party|bower_components|jspm_packages)\//i;

function isMeaningfulPath(path: string): boolean {
  return !isLockfile(path) && !LOW_SIGNAL_DIR_RE.test(path);
}

/** True when `thisPr` and `sibling` overlap enough to carry real conflict/duplicate-effort risk: a shared
 *  linked issue, OR a shared meaningful (non-lockfile, non-generated) changed file path. A sibling with no
 *  resolved `changedFiles` can still match via linked issues -- it is never treated as "definitely no overlap"
 *  purely for missing file data. */
function overlaps(thisPrLinkedIssues: readonly number[], thisPrChangedFiles: readonly string[] | undefined, sibling: MergeTrainSibling): boolean {
  const siblingIssues = sibling.linkedIssues ?? [];
  if (thisPrLinkedIssues.some((issue) => siblingIssues.includes(issue))) return true;
  if (!thisPrChangedFiles || !sibling.changedFiles) return false;
  const siblingFiles = new Set(sibling.changedFiles);
  return thisPrChangedFiles.some((path) => siblingFiles.has(path) && isMeaningfulPath(path));
}

export type ShouldWaitForOlderSiblingsInput = {
  thisPrNumber: number;
  thisPrCreatedAt: string | null | undefined;
  /** This PR's own linked issues (always available -- `PullRequestRecord.linkedIssues` is never optional). */
  thisPrLinkedIssues: readonly number[];
  /** This PR's own changed file paths, when the caller has resolved them. Absent degrades overlap detection
   *  to linked-issue-only for every sibling (never fails closed into "nothing can overlap"). */
  thisPrChangedFiles?: readonly string[] | undefined;
  siblings: readonly MergeTrainSibling[];
  nowMs: number;
};

/** True when an OVERLAPPING, older, still-viable sibling exists and `thisPrNumber` should wait its turn. A
 *  sibling never blocks when it is: the same PR, not older (by createdAt, falling back to PR number when
 *  createdAt is missing on either side -- mirrors the duplicate-winner election's own createdAt-then-number
 *  precedent), git-conflicted (`mergeableState === "dirty"` -- it isn't "about to merge," it's stuck), held
 *  for manual review (#9039 -- an administratively frozen hold that does not self-clear on any timer, unlike
 *  an ordinary in-review PR; see the module header for the confirmed #8735 incident), past the staleness cap,
 *  or simply UNRELATED (shares no linked issue and no meaningful changed file with this PR -- see the module
 *  header for why overlap-scoping, not blanket FIFO, is the actual fix here). Deterministic and total: same
 *  inputs always produce the same decision. */
export function shouldWaitForOlderSiblings(input: ShouldWaitForOlderSiblingsInput): MergeTrainDecision {
  const { thisPrNumber, thisPrCreatedAt, thisPrLinkedIssues, thisPrChangedFiles, siblings, nowMs } = input;
  const thisCreatedMs = thisPrCreatedAt ? Date.parse(thisPrCreatedAt) : Number.NaN;
  const isOlder = (sibling: MergeTrainSibling): boolean => {
    const siblingCreatedMs = sibling.createdAt ? Date.parse(sibling.createdAt) : Number.NaN;
    // Both sides need a real, distinct createdAt to compare by date -- if either is missing (or they tie
    // exactly), fall back to the lower PR number as "older" (matches the duplicate-winner election's own
    // tie-break precedent elsewhere in this codebase; PR numbers are assigned sequentially at creation, so
    // this fallback is a safe, always-available proxy for open order).
    if (Number.isFinite(siblingCreatedMs) && Number.isFinite(thisCreatedMs) && siblingCreatedMs !== thisCreatedMs) {
      return siblingCreatedMs < thisCreatedMs;
    }
    return sibling.number < thisPrNumber;
  };
  const viable = siblings
    .filter((sibling) => sibling.number !== thisPrNumber)
    .filter((sibling) => sibling.mergeableState !== "dirty")
    .filter((sibling) => !sibling.heldForManualReview)
    .filter((sibling) => isOlder(sibling))
    .filter((sibling) => overlaps(thisPrLinkedIssues, thisPrChangedFiles, sibling))
    .filter((sibling) => {
      const siblingCreatedMs = sibling.createdAt ? Date.parse(sibling.createdAt) : Number.NaN;
      if (!Number.isFinite(siblingCreatedMs)) return true; // unknown age -- fail open toward still blocking
      return nowMs - siblingCreatedMs < MERGE_TRAIN_MAX_WAIT_MS;
    })
    .sort((a, b) => a.number - b.number);
  const blocker = viable[0];
  return blocker ? { wait: true, blockingPr: blocker.number } : { wait: false };
}
