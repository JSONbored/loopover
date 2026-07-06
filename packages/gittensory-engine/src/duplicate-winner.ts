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
 * ELECTION ORDER (#dup-winner true-creation-time): prefer each PR's true GitHub `pull_request.created_at` —
 * the real order contributors opened their PRs in — over `linkedIssueClaimedAt` (gittensory's own sync-time,
 * i.e. whenever a webhook/sweep/backfill pass happened to OBSERVE the linked issue). Sync order and creation
 * order diverge whenever processing isn't strictly FIFO (a stalled sweep catching up on a backlog, backfill
 * reordering, webhook delivery delay), under the old claim-time-only rule, that divergence could crown a
 * LATER contributor the winner and close the PR of whoever actually opened first. `createdAt` is compared
 * only when BOTH sides of a given comparison have a valid one; otherwise this falls back to the legacy
 * claim-time comparison unchanged, so sparse/legacy rows keep their existing fail-closed behavior exactly.
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
  /** GitHub's true PR creation time. See the module doc's "ELECTION ORDER" note. */
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
 * "ELECTION ORDER" note for the createdAt-vs-claim-time precedence). Sparse legacy rows fail closed; ties
 * between equally-ordered members use PR number.
 */
export function isDuplicateClusterWinnerByClaim(pr: DuplicateClaimMember, openSiblings: DuplicateClaimMember[]): boolean {
  if (openSiblings.length === 0) return true;
  for (const sibling of openSiblings) {
    if (!prPrecedesSibling(pr, sibling)) return false;
  }
  return true;
}

/**
 * True iff `pr` is ordered at or ahead of `sibling` for cluster-winner purposes. Prefers `createdAt` when BOTH
 * sides have a valid one (the true creation-time order); otherwise falls back to the legacy `linkedIssueClaimedAt`
 * comparison unchanged (including its fail-closed-on-missing/invalid-timestamp behavior), so a mixed
 * legacy/modern cluster never silently guesses using two different clocks for the two sides of one comparison.
 */
function prPrecedesSibling(pr: DuplicateClaimMember, sibling: DuplicateClaimMember): boolean {
  const prCreated = claimTimeMs(pr.createdAt);
  const siblingCreated = claimTimeMs(sibling.createdAt);
  if (prCreated !== null && siblingCreated !== null) {
    if (prCreated !== siblingCreated) return prCreated < siblingCreated;
    return pr.number <= sibling.number;
  }
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
