// Deterministic PR-improvement signal (#4742, sub-issue E of epic #4737): the positive-axis counterpart to
// src/signals/slop.ts's risk-only score. Where slop.ts asks "does this diff look low-effort or risky", this
// module asks "does this diff show measurable structural improvement" — reduced complexity, resolved
// duplication, higher patch coverage, added test evidence. Deterministic tier ONLY: no LLM call lives here.
// The LLM-tier judgment (`ModelReview.valueAssessment`, src/services/ai-review.ts, #4743/#4754) is a
// genuinely separate axis combined with this score at the SURFACING layer (a later sub-issue, #4744) —
// never blended into `improvementScore` itself.
//
// Activation wiring already exists (#4738/#4753: `isImprovementSignalEnabled` + the `improvementSignal`
// ConvergedFeatureKey) but nothing calls `resolveConvergedFeature` for it yet, and this module is not an
// exception — it is a pure, standalone computation consumed only by its own tests until the panel-surfacing
// sub-issue (#4744) wires a caller. It carries NO gate/blocker power (epic design constraint 2): unlike
// slop.ts's header comment ("the ONLY thing allowed to gate"), `improvementScore` must never appear in
// evaluateGateCheck or any blocker path.
//
// Two of the four inputs (complexityDeltas/duplicationDeltas) are REES (review-enrichment service)
// findings. REES is a separate deployable (its own package.json/tsconfig, not a root workspace member — see
// review-enrichment/), so its types are not directly importable here; the shapes below are a structural
// mirror of REES's ComplexityDeltaFinding/DuplicationDeltaFinding (review-enrichment/src/types.ts). As of
// this PR, no channel threads REES's structured `findings` (as opposed to its rendered prompt text) into the
// main app at all — src/review/enrichment-wire.ts only splices REES's pre-rendered { promptSection,
// systemSuffix } into the AI review prompt and never parses `brief.findings`. Likewise, no part of this
// codebase's signal pipeline currently extracts a structured number from Codecov's codecov/patch check (only
// its human-readable text summary reaches src/review/grounding-wire.ts / src/review/unified-comment.ts, e.g.
// "60% of diff hit (target 97%)", for display, not computation). So today, callers of this module have no
// live source for complexityDeltas, duplicationDeltas, or patchCoverageDeltaPercent — all three are honest
// gaps, not yet wired by design (a later sub-issue's job), and this module must degrade cleanly when they're
// absent (see "insufficient signal" below) rather than fabricate a neutral score.
import { buildMissingTestEvidenceFinding, clamp, type SlopChangedFile } from "./slop";
import { isCodeFile } from "./path-matchers";
import type { SignalFinding } from "./engine";

export type ImprovementBand = "insufficient-signal" | "none" | "minor" | "moderate" | "significant";

/** Structural mirror of REES's `ComplexityDeltaFinding` (review-enrichment/src/types.ts, #4740) — see the
 *  module comment for why this isn't imported directly. A negative `delta` is an improvement (the function
 *  got simpler); a positive `delta` is a regression — both signs can appear in the same array, since REES
 *  reports every function whose body changed, not just the ones that improved. */
export type ComplexityDeltaLike = {
  file: string;
  line: number;
  name: string;
  before: number;
  after: number;
  delta: number;
};

/** Structural mirror of REES's `DuplicationDeltaFinding` (review-enrichment/src/types.ts, #4741) — see the
 *  module comment for why this isn't imported directly. Every entry already represents a RESOLVED duplicate
 *  pair by construction (REES only emits this finding for a pair present pre-PR and no longer both present
 *  after), so array presence alone — no sign or threshold check — is the positive signal. */
export type DuplicationDeltaLike = {
  file: string;
  line: number;
  duplicateOfLine: number;
  lines: number;
};

export type StructuralImprovementInput = {
  /** REES complexity-delta analyzer findings for this PR (#4740). Undefined/empty ⇒ the complexity axis has
   *  nothing to measure for this PR (contributes to "insufficient signal", not to a `none` verdict). */
  complexityDeltas?: ComplexityDeltaLike[] | undefined;
  /** REES duplication-delta analyzer findings for this PR (#4741). Undefined/empty ⇒ the duplication axis
   *  has nothing to measure for this PR. */
  duplicationDeltas?: DuplicationDeltaLike[] | undefined;
  /** (after - before) patch/diff coverage percentage for this PR, reusing Codecov's own `codecov/patch`
   *  number rather than recomputing it — no caller wires a live figure yet (see the module comment).
   *  Undefined ⇒ the coverage axis has nothing to measure for this PR. */
  patchCoverageDeltaPercent?: number | undefined;
  /** Same changed-file/test-evidence inputs slop.ts's own `missingTestEvidence` signal reads, reused
   *  verbatim (not re-derived) so both signals agree on what counts as test evidence. */
  changedFiles?: SlopChangedFile[] | undefined;
  tests?: string[] | undefined;
  testFiles?: string[] | undefined;
};

export type StructuralImprovementAssessment = {
  improvementScore: number;
  band: ImprovementBand;
  findings: SignalFinding[];
};

// The two REES structural-delta analyzers (complexity/duplication) are the epic's namesake "structural"
// signals and weigh 35 each — either ALONE reaches `moderate` (31-59) and any two reach `significant`
// (60-100). Coverage-delta and test-evidence are corroborating (weigh 20/10): real signals, but each is a
// proxy for improvement rather than a directly-observed structural change, so neither alone should out-rank
// a single structural signal, and both together (30) still sit below a single structural signal (35).
// `clamp(.,0,100)` keeps the stacked score bounded even though the current weights already sum to exactly 100.
export const IMPROVEMENT_WEIGHTS = {
  reducedComplexity: 35,
  resolvedDuplication: 35,
  increasedPatchCoverage: 20,
  addedTestEvidence: 10,
} as const;

export const IMPROVEMENT_RUBRIC_MARKDOWN = [
  "# LoopOver structural-improvement rubric",
  "",
  "- `insufficient-signal`: none of the four inputs had anything to measure",
  "- `none`: 0",
  "- `minor`: 1-30",
  "- `moderate`: 31-59",
  "- `significant`: 60-100",
  "",
  "Current deterministic signals:",
  "- reduced cyclomatic complexity in an existing function (before/after delta)",
  "- resolved duplication (a pre-PR duplicate pair no longer both present)",
  "- increased patch/diff coverage (Codecov codecov/patch before/after)",
  "- added test evidence alongside a code change",
].join("\n");

export function buildStructuralImprovementAssessment(input: StructuralImprovementInput): StructuralImprovementAssessment {
  const findings: SignalFinding[] = [];
  const reducedComplexityFinding = buildReducedComplexityFinding(input);
  const resolvedDuplicationFinding = buildResolvedDuplicationFinding(input);
  const increasedPatchCoverageFinding = buildIncreasedPatchCoverageFinding(input);
  const addedTestEvidenceFinding = buildAddedTestEvidenceFinding(input);
  if (reducedComplexityFinding) findings.push(reducedComplexityFinding);
  if (resolvedDuplicationFinding) findings.push(resolvedDuplicationFinding);
  if (increasedPatchCoverageFinding) findings.push(increasedPatchCoverageFinding);
  if (addedTestEvidenceFinding) findings.push(addedTestEvidenceFinding);

  const improvementScore = clamp(
    (reducedComplexityFinding ? IMPROVEMENT_WEIGHTS.reducedComplexity : 0) +
      (resolvedDuplicationFinding ? IMPROVEMENT_WEIGHTS.resolvedDuplication : 0) +
      (increasedPatchCoverageFinding ? IMPROVEMENT_WEIGHTS.increasedPatchCoverage : 0) +
      (addedTestEvidenceFinding ? IMPROVEMENT_WEIGHTS.addedTestEvidence : 0),
    0,
    100,
  );

  return {
    improvementScore,
    band: improvementBandFor(improvementScore, hasApplicableSignal(input)),
    findings,
  };
}

// True when at least one of the four axes had ANYTHING to measure for this PR, regardless of whether that
// axis showed improvement — distinguishes a genuine `none` verdict (measured, found no improvement) from
// `insufficient-signal` (nothing measurable at all, e.g. a docs-only PR with nothing for the complexity/
// duplication analyzers to look at, no coverage figure, and no code files to check for test evidence).
function hasApplicableSignal(input: StructuralImprovementInput): boolean {
  return (
    hasEntries(input.complexityDeltas) ||
    hasEntries(input.duplicationDeltas) ||
    finitePatchCoverageDelta(input.patchCoverageDeltaPercent) !== undefined ||
    hasCodeFileToEvaluate(input.changedFiles)
  );
}

function hasEntries<T>(list: T[] | undefined): boolean {
  return (list?.length ?? 0) > 0;
}

// Guards against a non-finite caller-supplied figure (NaN/±Infinity) so it is treated identically to
// "no figure supplied" everywhere it is read, rather than silently producing a nonsensical finding or an
// inconsistency between hasApplicableSignal and buildIncreasedPatchCoverageFinding.
function finitePatchCoverageDelta(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasCodeFileToEvaluate(changedFiles: SlopChangedFile[] | undefined): boolean {
  return (changedFiles ?? []).some((file) => Boolean(file.path) && isCodeFile(file.path));
}

// Fires when at least one function's complexity genuinely dropped (a negative delta) after this PR. Mixed
// signs are expected in the SAME array (REES reports every function whose body changed, not just the ones
// that improved), so this counts strictly `delta < 0` entries rather than trusting array presence alone —
// unlike resolvedDuplication, where presence alone is already the positive fact (see DuplicationDeltaLike).
export function buildReducedComplexityFinding(input: StructuralImprovementInput): SignalFinding | null {
  const deltas = input.complexityDeltas ?? [];
  if (deltas.length === 0) return null;
  const improvedCount = deltas.filter((finding) => finding.delta < 0).length;
  if (improvedCount === 0) return null;
  // Only an integer count is interpolated, so the text is public-safe by construction (mirrors slop.ts).
  const detail = `${improvedCount} function(s) have lower cyclomatic complexity after this pull request.`;
  return {
    code: "reduced_complexity",
    title: "Complexity went down",
    severity: "info",
    detail,
    action: "No action needed — this is a positive signal.",
    publicText: detail,
  };
}

// Every DuplicationDeltaLike entry already IS a resolved pair by construction (see the type's doc comment),
// so array presence alone — no sign or threshold check — is the positive fact.
export function buildResolvedDuplicationFinding(input: StructuralImprovementInput): SignalFinding | null {
  const deltas = input.duplicationDeltas ?? [];
  if (deltas.length === 0) return null;
  const detail = `${deltas.length} previously-duplicated code block(s) were consolidated or removed by this pull request.`;
  return {
    code: "resolved_duplication",
    title: "Duplication went down",
    severity: "info",
    detail,
    action: "No action needed — this is a positive signal.",
    publicText: detail,
  };
}

// Fires only when the caller-supplied figure is a genuine, finite increase (> 0) — an absent, zero, or
// negative figure never fires. The number is interpolated verbatim (never file/diff content), so this stays
// public-safe; rounding/precision is the caller's responsibility.
export function buildIncreasedPatchCoverageFinding(input: StructuralImprovementInput): SignalFinding | null {
  const delta = finitePatchCoverageDelta(input.patchCoverageDeltaPercent);
  if (delta === undefined || delta <= 0) return null;
  const detail = `Patch coverage increased by ${delta} percentage point(s) compared to the base branch.`;
  return {
    code: "increased_patch_coverage",
    title: "Patch coverage went up",
    severity: "info",
    detail,
    action: "No action needed — this is a positive signal.",
    publicText: detail,
  };
}

// Reuses slop.ts's own missingTestEvidence computation (rather than re-deriving isCodeFile/isTestFile
// heuristics here) so the two signals can never disagree about what counts as test evidence. A null result
// from that function is ambiguous by itself (it also returns null when there is no code to test at all), so
// this only treats it as a POSITIVE finding when there was in fact a code file to evaluate.
export function buildAddedTestEvidenceFinding(input: StructuralImprovementInput): SignalFinding | null {
  if (!hasCodeFileToEvaluate(input.changedFiles)) return null;
  const missingTestEvidence = buildMissingTestEvidenceFinding({
    changedFiles: input.changedFiles,
    tests: input.tests,
    testFiles: input.testFiles,
  });
  if (missingTestEvidence) return null;
  const detail = "Code changes are accompanied by test evidence.";
  return {
    code: "added_test_evidence",
    title: "Change carries test evidence",
    severity: "info",
    detail,
    action: "No action needed — this is a positive signal.",
    publicText: detail,
  };
}

// Bands mirror slop.ts's slopBandFor shape (clean/low/elevated/high), renamed for the positive axis and
// extended with a fifth value: `insufficient-signal` fires whenever NONE of the four inputs had anything to
// measure, so a docs-only PR is never misread as "measured, found no improvement" — a raw score of 0 alone
// cannot distinguish those two cases (see hasApplicableSignal), which is exactly why the band is a separate,
// explicit axis rather than a percentage presented as fact.
function improvementBandFor(improvementScore: number, hasSignal: boolean): ImprovementBand {
  if (!hasSignal) return "insufficient-signal";
  if (improvementScore <= 0) return "none";
  if (improvementScore < 31) return "minor";
  if (improvementScore < 60) return "moderate";
  return "significant";
}
