// Soft-claim adjudication (#4291). Decides which of several miners claiming the same issue proceeds, by REUSING the
// maintainer-side duplicate-cluster election (`isDuplicateClusterWinnerByClaim` from @jsonbored/gittensory-engine)
// rather than reimplementing it — so the miner and the maintainer gate agree on exactly one winner by construction.
//
// The local claim ledger is 100% client-side and cannot see other miners' claims, so the competing-claim signal
// must come from something publicly observable: the OPEN PRs that link the same issue (an issue with several open
// PRs linking it IS the public signal of a contested claim). The caller assembles that set — exactly like the
// maintainer-side callers in src/ do — and passes it here.
import { isDuplicateClusterWinnerByClaim, resolveDuplicateClusterWinnerNumber } from "@jsonbored/gittensory-engine";

/**
 * Map an observed claim record to the engine's `DuplicateClaimMember`. The field names deliberately DIFFER — the
 * local ledger / observed data expose `claimedAt`, the engine election reads `linkedIssueClaimedAt` — so the bridge
 * is explicit (they are not interchangeable by accident of naming). `createdAt` is intentionally omitted: the
 * election ignores it (an older PR can claim a linked issue later by editing its body). Pure.
 */
export function toClaimMember(claim) {
  return { number: claim.number, linkedIssueClaimedAt: claim.claimedAt ?? null };
}

/**
 * Adjudicate whether THIS miner's soft-claim wins a contested issue. `self` is this miner's claim and `competing`
 * is the publicly-observable set of OTHER open PRs linking the same issue; each entry is `{ number, claimedAt }`.
 * Returns the go/no-go `isWinner` (driven ONLY by `isDuplicateClusterWinnerByClaim`) plus a DISPLAY-only
 * `winnerNumber` (from `resolveDuplicateClusterWinnerNumber`, for surfacing "you lost this claim to PR #N" to the
 * operator — never for the decision). Pure — no IO. Fail-closed: a missing/sparse claim time loses; the winner is
 * `null` when the ordering is too sparse to be sure (it never guesses). An empty `competing` list ⇒ trivial winner.
 */
export function adjudicateSoftClaim(self, competing = []) {
  const selfMember = toClaimMember(self);
  const siblings = competing.map(toClaimMember);
  return {
    isWinner: isDuplicateClusterWinnerByClaim(selfMember, siblings),
    winnerNumber: resolveDuplicateClusterWinnerNumber(selfMember, siblings),
  };
}
