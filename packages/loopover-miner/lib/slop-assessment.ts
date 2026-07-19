import { buildSlopAssessment } from "@loopover/engine";
import type { SlopAssessment, SlopAssessmentInput } from "@loopover/engine";

// Production runSlopAssessment binding (#5133, Wave 3.5 follow-up to #2334). `attempt-runner.js`'s
// `deps.runSlopAssessment` (via #2333's iterate-loop -> self-review-adapter's `SelfReviewAdapterDeps`) had
// no production implementation anywhere in this package -- only the test double in
// `test/unit/miner-attempt-runner.test.ts` existed. `packages/loopover-engine/src/miner/self-review-adapter.ts`'s
// own header comment already anticipated this exact binding: `SelfReviewSlopInput`/`SelfReviewSlopAssessment`
// are a deliberate, hand-kept STRUCTURAL MIRROR of `buildSlopAssessment`'s own `SlopAssessmentInput`/
// `SlopAssessment` (down to reusing the SAME canonical `AdvisoryFinding` type for `findings`), specifically so
// a real binding could be a direct pass-through with no mapping logic once the deterministic scorer itself
// became portable -- which #5133 did (`src/signals/slop.ts`'s PR-side scorer is now extracted to
// `packages/loopover-engine/src/signals/slop.ts`, byte-parity-verified against the live gate's own copy).

export function runSlopAssessment(input: SlopAssessmentInput): SlopAssessment {
  return buildSlopAssessment(input);
}
