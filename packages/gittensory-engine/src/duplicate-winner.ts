/**
 * Duplicate-winner adjudication (#dup-winner). Flag-gated by GITTENSORY_DUPLICATE_WINNER.
 *
 * When several OPEN PRs link the same issue (a duplicate cluster), the legacy behavior gate-blocks +
 * auto-closes EVERY sibling as a duplicate — no winner survives. With the flag ON, exactly ONE winner is
 * spared: the earliest claimant. Sparse legacy rows that do not yet have claim timing fail closed so unknown
 * ordering cannot arbitrarily suppress duplicate evidence. Only the LOSERS are blocked/closed; the winner
 * still must pass CI / conflict / gate / linked-issue / slop on its OWN merits.
 *
 * This module is PURE — no IO, no Date, no random — so the same inputs always yield the same verdict and the
 * caller can compute the winner ONCE per review run and thread the result boolean consistently into every
 * surface (advisory finding, close reason, slop, panels), so they agree by construction.
 *
 * ELECTION ORDER: compare `linkedIssueClaimedAt`, the time gittensory first observed the PR claiming
 * the issue. GitHub `pull_request.created_at` is intentionally not an ordering signal here: contributors can
 * edit an old placeholder PR to add a linked issue later, so creation time would let backdated claims steal
 * duplicate-winner credit from the PR that actually claimed the issue first. Sparse legacy rows that lack
 * claim timing keep failing closed so unknown ordering cannot suppress duplicate evidence.
 *
 * INVARIANT (the caller MUST honor it): {@link openSiblingNumbers} carries OPEN-only sibling PR numbers. The
 * existing sources already exclude closed/merged PRs. Once the winner closes (e.g. red CI), it leaves the open
 * set and the next-earliest OPEN claimant becomes the winner on re-eval — no permanently-orphaned cluster.
 *
 * SECOND CONSUMER (#2278): this module is intentionally engine-hosted (not `src/`-only) because its election
 * logic is reusable for the miner's own soft-claim adjudication — deciding which of several miners claiming
 * the same issue proceeds. A future contributor wiring the miner's local claim ledger should import this
 * module rather than reimplementing the election rule, so both the maintainer gate and the miner agree on
 * exactly one winner by construction.
 */

export type DuplicateClaimMember = {
  number: number;
  linkedIssueClaimedAt?: string | null | undefined;
  /** GitHub's true PR creation time. Retained for caller compatibility; not used for winner ordering. */
  createdAt?: string | null | undefined;
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
 * True iff `pr` is the earliest-elected claimant in the open duplicate cluster (see the module doc's
 * "ELECTION ORDER" note). Sparse legacy rows fail closed; ties between equally-ordered members use PR number.
 */
export function isDuplicateClusterWinnerByClaim(pr: DuplicateClaimMember, openSiblings: DuplicateClaimMember[]): boolean {
  if (openSiblings.length === 0) return true;
  for (const sibling of openSiblings) {
    if (!prPrecedesSibling(pr, sibling)) return false;
  }
  return true;
}

/**
 * True iff `pr` is ordered at or ahead of `sibling` for cluster-winner purposes. Only the observed linked-issue
 * claim time participates in the election; `createdAt` is deliberately ignored because an older PR can claim a
 * linked issue later by editing its body.
 */
function prPrecedesSibling(pr: DuplicateClaimMember, sibling: DuplicateClaimMember): boolean {
  const prClaim = claimTimeMs(pr.linkedIssueClaimedAt);
  if (prClaim === null) return false;
  const siblingClaim = claimTimeMs(sibling.linkedIssueClaimedAt);
  if (siblingClaim === null) return false;
  if (siblingClaim < prClaim) return false;
  if (siblingClaim === prClaim && sibling.number < pr.number) return false;
  return true;
}

/**
 * The winning PR number among `pr` and its open duplicate siblings, or `null` when the election is not
 * determinable (mirrors {@link isDuplicateClusterWinnerByClaim}'s fail-closed semantics — this never guesses a
 * specific winner when the ordering data is too sparse/ambiguous to be sure). Used only for DISPLAY (naming the
 * winner in a loser's close comment, #dup-winner-credit) — the close/hold decision for any given PR is still
 * driven directly by {@link isDuplicateClusterWinnerByClaim}, not by this function's return value.
 */
export function resolveDuplicateClusterWinnerNumber(pr: DuplicateClaimMember, openSiblings: DuplicateClaimMember[]): number | null {
  if (isDuplicateClusterWinnerByClaim(pr, openSiblings)) return pr.number;
  for (const sibling of openSiblings) {
    const rest = openSiblings.filter((other) => other.number !== sibling.number);
    if (isDuplicateClusterWinnerByClaim(sibling, [pr, ...rest])) return sibling.number;
  }
  return null;
}

function claimTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
