/**
 * Duplicate-winner adjudication (#dup-winner), extracted to `@jsonbored/gittensory-engine` (#2278) so the
 * maintainer gate and the miner's own soft-claim adjudication (a later Phase-0 issue) import the identical,
 * versioned election logic instead of drifting apart. See the engine module's doc comment for the full
 * election-order rationale (createdAt-vs-claim-time precedence, fail-closed semantics).
 *
 * packages/gittensory-engine/src/duplicate-winner.ts (imported via relative source path, not the published
 * module, matching the #2282 scoring-preview extraction) is the source of truth.
 */
export {
  isDuplicateClusterWinner,
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
  type DuplicateClaimMember,
} from "../../packages/gittensory-engine/src/duplicate-winner";
