// Copycat/plagiarism-assessment shim (#1969). The canonical implementation lives at
// packages/loopover-engine/src/signals/copycat.ts, matching the extraction pattern already used for the
// deterministic slop scorer (src/signals/slop.ts) — imported via relative source path, not the published
// package, to match this repo's existing engine-consumption convention (see e.g. src/signals/test-evidence.ts)
// and to avoid depending on the engine package's built dist/ output, which is not guaranteed to exist yet when
// typecheck/test:coverage run in CI. Keeping this file to nothing but the re-export below is what makes
// scripts/check-engine-parity.ts recognize it as a shim rather than a hand-duplicated twin.
export {
  DEFAULT_COPYCAT_MIN_SCORE,
  assessCopycat,
  codeShingleList,
  codeShingles,
  containmentScore,
  copycatDirection,
  copycatWouldActOnPersistedScore,
  type CopycatAssessment,
  type CopycatAssessmentInput,
  type CopycatDirection,
  type CopycatMatch,
  type CopycatPriorArtCandidate,
} from "../../packages/loopover-engine/src/signals/copycat";
