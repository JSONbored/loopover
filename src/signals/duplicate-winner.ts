/**
 * Duplicate-winner adjudication (#dup-winner). Flag-gated by GITTENSORY_DUPLICATE_WINNER.
 *
 * When several OPEN PRs link the same issue (a duplicate cluster), the legacy behavior gate-blocks +
 * auto-closes EVERY sibling as a duplicate — no winner survives. With the flag ON, exactly ONE winner is
 * spared: the earliest observed linked-issue claimant. Only the LOSERS are blocked/closed; the winner still
 * must pass CI / conflict / gate / linked-issue / slop on its OWN merits.
 *
 * This module is PURE — no IO, no Date, no random — so the same inputs always yield the same verdict and the
 * caller can compute the winner ONCE per review run and thread the result boolean consistently into every
 * surface (advisory finding, close reason, slop, panels), so they agree by construction.
 *
 * INVARIANT (the caller MUST honor it): {@link openSiblingNumbers} carries OPEN-only sibling PR numbers. The
 * existing sources already exclude closed/merged PRs. Once the winner closes (e.g. red CI), it leaves the open
 * set and the next-earliest OPEN claimant becomes the winner on re-eval — no permanently-orphaned cluster.
 */

export type DuplicateClaimMember = {
  number: number;
  linkedIssueClaimedAt?: string | null | undefined;
};

/**
 * True iff `prNumber` is the cluster winner: the minimum of `{prNumber} ∪ openSiblingNumbers`. An empty
 * sibling list ⇒ the PR is alone in (or out of) the cluster ⇒ winner. A sibling list that happens to contain
 * `prNumber` itself is harmless — the comparison is still min-based.
 *
 * @deprecated Use {@link isDuplicateClusterWinnerByClaim}. PR-number election is retained only for legacy
 * compatibility callers that do not have claim timestamps.
 */
export function isDuplicateClusterWinner(prNumber: number, openSiblingNumbers: number[]): boolean {
  for (const sibling of openSiblingNumbers) {
    if (sibling < prNumber) return false;
  }
  return true;
}

/**
 * True iff `pr` is the earliest known linked-issue claimant in the open duplicate cluster. Unknown or invalid
 * claim times fail closed: the caller should keep the duplicate finding/blocker instead of accidentally sparing
 * the wrong PR. Ties fall back to PR number only after the claim time is known for every compared sibling.
 */
export function isDuplicateClusterWinnerByClaim(pr: DuplicateClaimMember, openSiblings: DuplicateClaimMember[]): boolean {
  if (openSiblings.length === 0) return true;
  const prClaim = claimTimeMs(pr.linkedIssueClaimedAt);
  if (prClaim === null) return false;
  for (const sibling of openSiblings) {
    const siblingClaim = claimTimeMs(sibling.linkedIssueClaimedAt);
    if (siblingClaim === null) return false;
    if (siblingClaim < prClaim) return false;
    if (siblingClaim === prClaim && sibling.number < pr.number) return false;
  }
  return true;
}

function claimTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
