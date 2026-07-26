/**
 * Convergence: the hard-guardrail path check for the auto-maintain layer (#778), extracted to
 * `@loopover/engine` so the maintainer gate and the miner's own gate-prediction share the identical,
 * versioned matching logic instead of drifting apart (#6202/#6204). See the engine module's doc
 * comment for the full incident-prevention rationale (the awesome-claude #4196 class).
 *
 * packages/loopover-engine/src/signals/change-guardrail.ts (imported via relative source path, not
 * the published module, matching this directory's existing duplicate-winner.ts shim) is the source
 * of truth.
 */
export {
  canonicalize,
  hasUnsafeWildcardCount,
  globToRegExp,
  matchesAny,
  changedPathsHittingGuardrail,
  type GuardrailPathMatch,
  guardrailPathMatches,
  isGuardrailHit,
  GUARDRAIL_UNVERIFIABLE_FILE_COUNT,
} from "../../packages/loopover-engine/src/signals/change-guardrail";
