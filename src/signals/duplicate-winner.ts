/**
 * Duplicate-winner adjudication (#dup-winner). Flag-gated by GITTENSORY_DUPLICATE_WINNER.
 *
 * When several OPEN PRs link the same issue (a duplicate cluster), the legacy behavior gate-blocks +
 * auto-closes EVERY sibling as a duplicate — no winner survives. With the flag ON, exactly ONE winner is
 * spared: the EARLIEST opened = the LOWEST PR number among the OPEN siblings. Only the LOSERS are
 * blocked/closed; the winner still must pass CI / conflict / gate / linked-issue / slop on its OWN merits.
 *
 * This module is PURE — no IO, no Date, no random — so the same inputs always yield the same verdict and the
 * caller can compute the winner ONCE per review run and thread the result boolean consistently into every
 * surface (advisory finding, close reason, slop, panels), so they agree by construction.
 *
 * INVARIANT (the caller MUST honor it): {@link openSiblingNumbers} carries OPEN-only sibling PR numbers. The
 * existing sources (advisory `overlappingPrs`, gate `linkedIssueDuplicatePullRequestsForGate`, engine
 * `linkedIssueDuplicatePullRequests`) already exclude closed/merged PRs, so the lowest number is the lowest
 * OPEN number. Once the winner closes (e.g. red CI), it leaves the open set and the next-lowest OPEN sibling
 * becomes the winner on re-eval — no permanently-orphaned cluster.
 */

/**
 * True iff `prNumber` is the cluster winner: the minimum of `{prNumber} ∪ openSiblingNumbers`. An empty
 * sibling list ⇒ the PR is alone in (or out of) the cluster ⇒ winner. A sibling list that happens to contain
 * `prNumber` itself is harmless — the comparison is still min-based.
 */
export function isDuplicateClusterWinner(prNumber: number, openSiblingNumbers: number[]): boolean {
  for (const sibling of openSiblingNumbers) {
    if (sibling < prNumber) return false;
  }
  return true;
}
