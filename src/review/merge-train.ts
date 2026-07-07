// FIFO merge-train gate (#selfhost-merge-train). Without this, a PR merges the instant its OWN gate clears,
// with zero awareness of an older sibling PR still open in the same repo -- proven live via a production D1
// query to cause hundreds of out-of-order merges per repo, and the conflicts that follow. This module is the
// pure decision only: a still-viable older sibling (not conflicted, not past the staleness cap) holds the
// newer PR's merge until the older one either merges, closes, or goes stale. Mirrors this codebase's existing
// "advisory, fail-open, defense-in-depth" lock philosophy (see claimTransientLock's own doc comment) rather
// than a hard, unbypassable serialization -- the staleness cap is the deliberate escape hatch so one stuck old
// PR can never block the repo's newer PRs forever.

/** The subset of a sibling PR's fields this gate actually needs -- kept minimal and independent of
 *  `PullRequestRecord`'s full shape so this module has zero import surface beyond plain data. */
export type MergeTrainSibling = {
  number: number;
  createdAt?: string | null | undefined;
  mergeableState?: string | null | undefined;
};

/** How long an older sibling can hold up newer ones before it's excluded from blocking (24 hours, matching
 *  `REGATE_REPAIR_ATTEMPT_LOOKBACK_MS`'s own "genuinely stuck, not just mid-review" cutoff in
 *  src/queue/processors.ts). A normal review cycle (CI, AI review, human review) can easily run for hours; a
 *  genuinely stuck PR (its author vanished, review never completes) must not wedge every newer PR in the repo
 *  indefinitely, so this is the escape hatch, not a tight SLA. */
export const MERGE_TRAIN_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export type MergeTrainDecision = { wait: true; blockingPr: number } | { wait: false };

/** True when an older, still-viable sibling exists and `thisPrNumber` should wait its turn. A sibling never
 *  blocks when it is: the same PR, not older (by createdAt, falling back to PR number when createdAt is
 *  missing on either side -- mirrors the duplicate-winner election's own createdAt-then-number precedent),
 *  git-conflicted (`mergeableState === "dirty"` -- it isn't "about to merge," it's stuck), or past the
 *  staleness cap. Deterministic and total: same inputs always produce the same decision. */
export function shouldWaitForOlderSiblings(
  thisPrNumber: number,
  thisPrCreatedAt: string | null | undefined,
  siblings: readonly MergeTrainSibling[],
  nowMs: number,
): MergeTrainDecision {
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
    .filter((sibling) => isOlder(sibling))
    .filter((sibling) => {
      const siblingCreatedMs = sibling.createdAt ? Date.parse(sibling.createdAt) : Number.NaN;
      if (!Number.isFinite(siblingCreatedMs)) return true; // unknown age -- fail open toward still blocking
      return nowMs - siblingCreatedMs < MERGE_TRAIN_MAX_WAIT_MS;
    })
    .sort((a, b) => a.number - b.number);
  const blocker = viable[0];
  return blocker ? { wait: true, blockingPr: blocker.number } : { wait: false };
}
