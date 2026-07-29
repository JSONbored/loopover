// PR-side slop-assessment shim (#5133). The canonical implementation now lives at
// packages/loopover-engine/src/signals/slop.ts, extracted so the published loopover-mcp/loopover-miner
// CLIs can run the SAME deterministic self-review scorer the live gate uses (imported via relative source
// path, not the published package, to match this repo's existing engine-consumption convention — see e.g.
// src/signals/test-evidence.ts — and to avoid depending on the engine package's built dist/ output, which is
// not guaranteed to exist yet when typecheck/test:coverage run in CI). Issue-side triage (buildIssueSlopAssessment
// and friends) lives in ./issue-slop.ts instead of here — it is not needed by the miner's self-review path,
// and keeping this file to nothing but the re-export below is what makes scripts/check-engine-parity.ts
// recognize it as a shim rather than a hand-duplicated twin.
export {
  GENERIC_COMMIT_PATTERN,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
  buildDuplicateClusterFinding,
  buildEmptyDescriptionFinding,
  buildLowQualityCommitMessageFinding,
  buildMissingTestEvidenceFinding,
  buildNoLinkedIssueRationaleFinding,
  buildNonSubstantivePaddingFinding,
  buildSlopAssessment,
  buildTrivialWhitespaceChurnFinding,
  clamp,
  hasClearNoIssueRationale,
  isTestableCodePath,
  slopBandFor,
  type SlopAssessment,
  type SlopAssessmentInput,
  type SlopBand,
  type SlopChangedFile,
} from "../../packages/loopover-engine/src/signals/slop";
