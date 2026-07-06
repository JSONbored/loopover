/**
 * Duplicate-winner adjudication (#dup-winner) — re-exported from `@jsonbored/gittensory-engine` (#2278) so
 * the maintainer gate and the miner's own soft-claim adjudication (a later Phase-0 issue) import the
 * identical, versioned election logic instead of drifting apart. See the engine module's doc comment for
 * the full election-order rationale (createdAt-vs-claim-time precedence, fail-closed semantics).
 */
export {
  isDuplicateClusterWinner,
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
  type DuplicateClaimMember,
} from "@jsonbored/gittensory-engine";
