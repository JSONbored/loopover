/**
 * Duplicate-winner adjudication (#dup-winner) — thin re-export shim (#4251). This file and
 * `../duplicate-winner.ts` were accidental byte-identical forks living inside the same package (not a
 * `src/`-vs-engine extraction pair; both copies were already inside `gittensory-engine`). The top-level module
 * is the source of truth; see its doc comment for the full election-order rationale (claim-time election,
 * anti-backdating semantics). Kept as a re-export (not deleted) so `advisory/gate-advisory.ts`'s existing
 * `../signals/duplicate-winner.js` import keeps resolving without a call-site change.
 */
export {
  isDuplicateClusterWinner,
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
  type DuplicateClaimMember,
} from "../duplicate-winner.js";
