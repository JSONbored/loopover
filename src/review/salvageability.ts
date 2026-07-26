// Salvageability (#8962, epic #8828) — the second axis of the close decision, PURE.
//
// The 2026-07-26 decision audit proved defect-confidence alone cannot push close precision past ~96%: 28
// contributor PRs held on REAL, high-confidence findings (0.55–0.97) later MERGED — the residual close-error
// class is "real defect, salvageable PR". Confidence measures whether the defect is real; salvageability
// measures whether closing is the right ACTION anyway. This module scores the second question from
// deterministic decision-time facts only — no AI call, every point traceable to a named factor.
//
// Consumed by resolveAiReviewSalvageableHold (src/rules/advisory.ts): when an AI-judgment close WOULD fire
// (confidence at/above the floor) but the score clears the repo's `gate.aiReview.salvageabilityMinScore`
// manifest knob, the close is routed into the existing held-for-review path with fix-it guidance instead.
// The knob is manifest-only and ABSENT by default — unset ⇒ this module never changes a disposition.

/** How mechanically fixable the flagged defect class is, judged from the finding's own text. */
export type DefectFixability = "mechanical" | "structural" | "unknown";

/** Textual signatures of defect classes an author routinely fixes in one push — drawn from the audited
 *  held-then-fixed-then-merged cohort (encoding artifacts, dead imports, stale generated artifacts, version
 *  mismatches, missing guards/coverage on otherwise-sound changes). */
const MECHANICAL_PATTERN =
  /\bmojibake\b|\bencoding\b|\bunused import\b|\bdead import\b|\bregenerat|\bstale (?:generated|artifact|bundle|contract)|\bversion (?:bump|mismatch|downgrade)|\bmissing (?:test|branch|unit) coverage\b|\bcodecov\/patch\b|\buncovered\b|\bprettier\b|\bformatting\b|\btrim\(\)|\bnull(?:ish)? (?:guard|check)\b|\bblank[- ](?:cell|netuid|stake)\b/i;

/** Textual signatures of disqualifying-by-shape classes: the PR itself is the problem, not one fixable
 *  defect — fabricated evidence, scope violations, duplication, undisclosed bundling, policy breaches. */
const STRUCTURAL_PATTERN =
  /\bfabricat|\bmanufactur(?:es?|ed) (?:a |the )?(?:payload|state|test)|\bscope (?:creep|violation)\b|\bunrelated (?:change|feature|refactor|file|deletion)\b|\b(?:bundles?|bundled|bundling)\b[^.]{0,60}\bunrelated\b|\bunrelated\b[^.]{0,60}\b(?:bundles?|bundled|bundling)\b|\bundisclosed\b|\bduplicat|\bno (?:linked|eligible)[^.]{0,24}\bissue\b|\bissue-scope\b|\bdeletes? (?:working|existing)\b|\bout of scope\b|\bsingle-file\b|\bappend-only\b|\bspeculat/i;

/** Classify the flagged defect's fixability from the finding text. Structural wins when both match — a
 *  mechanical-sounding detail inside a scope-violation finding does not make the PR salvageable. PURE. */
export function classifyDefectFixability(findingText: string): DefectFixability {
  if (STRUCTURAL_PATTERN.test(findingText)) return "structural";
  if (MECHANICAL_PATTERN.test(findingText)) return "mechanical";
  return "unknown";
}

export type SalvageabilityInput = {
  /** The blocking AI-judgment finding's text (title + detail) — fixability is judged from it. */
  findingText: string;
  /** The author's previously MERGED PRs in this repo (realized outcomes, not open PRs — the #8840 lesson). */
  authorPriorMergedCount: number;
  /** Distinct review cycles this PR has already been through (decision records per head sha): an author who
   *  is iterating has demonstrated responsiveness on THIS change. */
  priorReviewCycles: number;
};

export type SalvageabilityScore = {
  /** 0–100; compare against `gate.aiReview.salvageabilityMinScore`. */
  score: number;
  /** The named factors behind every point — persisted with the decision so the boundary is auditable. */
  factors: string[];
  fixability: DefectFixability;
};

/**
 * Deterministic salvageability score. Weights encode the audit's evidence, not tuning: proven-landing
 * authors fix things (the held-then-merged cohort skewed heavily toward authors with merged history), a
 * mechanical defect class is one push from green, and in-flight iteration is direct evidence of
 * responsiveness. A structural defect class zeroes the fixability contribution BY DESIGN — no author
 * reputation makes a scope violation or fabricated test salvageable-in-place. PURE and total.
 */
export function computeSalvageability(input: SalvageabilityInput): SalvageabilityScore {
  const fixability = classifyDefectFixability(input.findingText);
  const factors: string[] = [];
  let score = 0;
  if (fixability === "mechanical") {
    score += 45;
    factors.push("mechanical defect class (+45)");
  } else if (fixability === "unknown") {
    score += 15;
    factors.push("unclassified defect class (+15)");
  } else {
    factors.push("structural defect class (+0)");
  }
  if (input.authorPriorMergedCount >= 3) {
    score += 40;
    factors.push(`author has ${input.authorPriorMergedCount} merged PRs here (+40)`);
  } else if (input.authorPriorMergedCount >= 1) {
    score += 25;
    factors.push(`author has ${input.authorPriorMergedCount} merged PR(s) here (+25)`);
  } else {
    factors.push("no merged history in this repo (+0)");
  }
  if (input.priorReviewCycles >= 2) {
    score += 15;
    factors.push(`already iterating (${input.priorReviewCycles} review cycles) (+15)`);
  }
  return { score: Math.min(100, score), factors, fixability };
}
