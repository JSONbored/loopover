import type { SignalFinding } from "./engine";
import { isCodeFile, isTestFile } from "./local-branch";
import { hasLocalTestEvidence, isTestPath } from "./test-evidence";
import { isFocusManifestPublicSafe } from "./focus-manifest";
import { classifyChangedFile } from "./path-matchers";

export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopChangedFile = {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
};

export type SlopAssessmentInput = {
  changedFiles?: SlopChangedFile[] | undefined;
  tests?: string[] | undefined;
  testFiles?: string[] | undefined;
  /** PR/branch description. An empty/whitespace description on a code change is a weak-effort signal. */
  description?: string | null | undefined;
};

export type SlopAssessment = {
  slopRisk: number;
  band: SlopBand;
  findings: SignalFinding[];
};

// Deterministic, high-precision signals only — this score is the ONLY thing allowed to gate (block), so it
// must be false-positive-averse. Heuristic/AI "this reads low-effort" judgments stay ADVISORY elsewhere and
// never feed this score. Each "strong" signal is weighted 30 so the `high` band (>=60) is reachable from any
// two of them; `clamp(.,0,100)` keeps the stacked score bounded.
export const SLOP_WEIGHTS = {
  trivialWhitespaceChurn: 30,
  missingTestEvidence: 30,
  nonSubstantivePadding: 30,
  emptyDescription: 15,
} as const;

export const SLOP_RUBRIC_MARKDOWN = [
  "# Gittensory slop assessment rubric",
  "",
  "- `clean`: 0",
  "- `low`: 1-24",
  "- `elevated`: 25-59",
  "- `high`: 60-100",
  "",
  "Current deterministic signals:",
  "- trivial / whitespace-only churn",
  "- missing test evidence",
  "- non-substantive padding (generated / vendored / minified output as source)",
  "- empty pull request description on a code change",
].join("\n");

const MIN_CHURN_LINES = 40;
const MAX_SOURCE_LINE_SHARE = 0.15;
// A padded diff is one whose churn is dominated by non-substantive output. Set at half the diff so a PR
// with any meaningful share of real, hand-authored files cannot trip it.
const PADDING_DOMINANCE_SHARE = 0.5;

export function buildSlopAssessment(input: SlopAssessmentInput): SlopAssessment {
  const findings: SignalFinding[] = [];
  const trivialChurnFinding = buildTrivialWhitespaceChurnFinding(input);
  const missingTestEvidenceFinding = buildMissingTestEvidenceFinding(input);
  const nonSubstantivePaddingFinding = buildNonSubstantivePaddingFinding(input);
  const emptyDescriptionFinding = buildEmptyDescriptionFinding(input);
  if (trivialChurnFinding) findings.push(trivialChurnFinding);
  if (missingTestEvidenceFinding) findings.push(missingTestEvidenceFinding);
  if (nonSubstantivePaddingFinding) findings.push(nonSubstantivePaddingFinding);
  if (emptyDescriptionFinding) findings.push(emptyDescriptionFinding);

  const slopRisk = clamp(
    (trivialChurnFinding ? SLOP_WEIGHTS.trivialWhitespaceChurn : 0) +
      (missingTestEvidenceFinding ? SLOP_WEIGHTS.missingTestEvidence : 0) +
      (nonSubstantivePaddingFinding ? SLOP_WEIGHTS.nonSubstantivePadding : 0) +
      (emptyDescriptionFinding ? SLOP_WEIGHTS.emptyDescription : 0),
    0,
    100,
  );

  return {
    slopRisk,
    band: slopBandFor(slopRisk),
    findings,
  };
}

// Fires when a high-churn diff is dominated by generated/vendored/minified output (files that carry code
// extensions and so slip past the source-share check in `trivialWhitespaceChurn`) while genuine source and
// test effort is negligible — i.e. the diff is padded to look substantive. Lockfiles, dependency manifests,
// and docs are legitimate change categories and never count toward the padding share, so dependency bumps
// and docs PRs cannot trip this.
export function buildNonSubstantivePaddingFinding(input: SlopAssessmentInput): SignalFinding | null {
  const totals = summarizePaddingLines(input.changedFiles ?? []);
  if (totals.changedLineCount < MIN_CHURN_LINES) return null;
  if (totals.paddingLineCount === 0) return null;
  if (totals.paddingLineCount / totals.changedLineCount < PADDING_DOMINANCE_SHARE) return null;
  if (totals.substantiveLineCount / totals.changedLineCount > MAX_SOURCE_LINE_SHARE) return null;
  return buildPaddingFinding(totals.changedLineCount, totals.paddingLineCount);
}

function summarizePaddingLines(changedFiles: SlopChangedFile[]): {
  changedLineCount: number;
  paddingLineCount: number;
  substantiveLineCount: number;
} {
  let changedLineCount = 0;
  let paddingLineCount = 0;
  let substantiveLineCount = 0;
  for (const file of changedFiles) {
    const lines = nonNegative(file.additions) + nonNegative(file.deletions);
    if (lines === 0) continue;
    changedLineCount += lines;
    const category = classifyChangedFile(file.path);
    if (category === "minified" || category === "generated" || category === "vendored") {
      paddingLineCount += lines;
    } else if (category === "source" || category === "test") {
      substantiveLineCount += lines;
    }
  }
  return { changedLineCount, paddingLineCount, substantiveLineCount };
}

function buildPaddingFinding(changedLineCount: number, paddingLineCount: number): SignalFinding {
  // Only integer counts are interpolated, so the text is public-safe by construction.
  const detail = `${paddingLineCount} of ${changedLineCount} changed line(s) are in generated, vendored, or minified files with little substantive source.`;
  return {
    code: "non_substantive_padding",
    title: "Diff is mostly generated, vendored, or minified output",
    severity: "warning",
    detail,
    action: "Exclude generated, vendored, and minified output and keep the diff focused on substantive changes.",
    publicText: detail,
  };
}

// Fires only when a real code change ships with an empty / whitespace-only description — a high-precision
// weak-effort signal. A non-empty description (even a terse one) never trips it, to avoid false positives.
export function buildEmptyDescriptionFinding(input: SlopAssessmentInput): SignalFinding | null {
  const codePaths = (input.changedFiles ?? []).map((file) => file.path).filter(Boolean).filter(isCodeFile);
  if (codePaths.length === 0) return null;
  if ((input.description ?? "").trim().length > 0) return null;

  const detail = ensurePublicSafeText(
    `${codePaths.length} code file(s) changed with an empty pull request description.`,
    "Code changed with an empty pull request description.",
  );
  return {
    code: "empty_pr_description",
    title: "Code change has no description",
    severity: "warning",
    detail,
    action: "Describe what changed and why so reviewers can evaluate it.",
    publicText: detail,
  };
}

export function buildMissingTestEvidenceFinding(input: SlopAssessmentInput): SignalFinding | null {
  const changedFiles = input.changedFiles ?? [];
  const changedPaths = changedFiles.map((file) => file.path).filter(Boolean);
  const codePaths = changedPaths.filter(isCodeFile);
  if (codePaths.length === 0) return null;

  const hasChangedTestPaths =
    changedPaths.some((path) => isTestFile(path) || isTestPath(path)) ||
    hasLocalTestEvidence({ tests: input.tests, testFiles: input.testFiles });
  if (hasChangedTestPaths) return null;

  const detail = ensurePublicSafeText(
    `Changed paths include ${codePaths.length} code file(s) without accompanying test evidence.`,
    "Code changes were detected without accompanying test evidence.",
  );
  const action = ensurePublicSafeText(
    "Add focused regression tests or explain why existing coverage is sufficient.",
    "Add focused tests or explain why existing coverage is sufficient.",
  );

  return {
    code: "missing_test_evidence",
    title: "Code changes lack test evidence",
    severity: "warning",
    detail,
    action,
    publicText: detail,
  };
}

export function buildTrivialWhitespaceChurnFinding(input: SlopAssessmentInput): SignalFinding | null {
  const changedFiles = input.changedFiles ?? [];
  const lineTotals = summarizeChangedLines(changedFiles);
  if (lineTotals.changedLineCount < MIN_CHURN_LINES) return null;
  if (lineTotals.sourceLineCount === 0) {
    return buildTrivialChurnFinding(lineTotals.changedLineCount, lineTotals.nonCodeLineCount);
  }
  const sourceShare = lineTotals.sourceLineCount / lineTotals.changedLineCount;
  if (sourceShare > MAX_SOURCE_LINE_SHARE) return null;
  return buildTrivialChurnFinding(lineTotals.changedLineCount, lineTotals.nonCodeLineCount);
}

function summarizeChangedLines(changedFiles: SlopChangedFile[]): {
  changedLineCount: number;
  sourceLineCount: number;
  testLineCount: number;
  nonCodeLineCount: number;
} {
  const changedLineCount = changedFiles.reduce(
    (sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions),
    0,
  );
  const sourceLineCount = changedFiles
    .filter((file) => isCodeFile(file.path))
    .reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const testLineCount = changedFiles
    .filter((file) => isTestFile(file.path))
    .reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const nonCodeLineCount = Math.max(0, changedLineCount - sourceLineCount - testLineCount);
  return { changedLineCount, sourceLineCount, testLineCount, nonCodeLineCount };
}

function buildTrivialChurnFinding(changedLineCount: number, nonCodeLineCount: number): SignalFinding {
  const detail = ensurePublicSafeText(
    `The diff churns ${changedLineCount} line(s) with only ${Math.max(0, changedLineCount - nonCodeLineCount)} substantive source line(s) touched.`,
    "The diff shows high churn with minimal substantive source changes.",
  );
  const action = ensurePublicSafeText(
    "Reduce whitespace-only or formatting-only churn and keep the diff focused on substantive changes.",
    "Reduce formatting-only churn and keep the diff focused on substantive changes.",
  );

  return {
    code: "trivial_whitespace_churn",
    title: "Diff looks like trivial or whitespace-only churn",
    severity: "warning",
    detail,
    action,
    publicText: detail,
  };
}

// ─── Issue-side slop triage (#533) ──────────────────────────────────────────────────────────────────
// Advisory-only maintainer triage signal for low-effort issues — there is no issue gate, so these never
// block. High-precision signals only (an empty issue body is sometimes legitimate, so the bar is set at
// "clearly low-effort": empty body, or a template opened and submitted without being filled in).

export type IssueSlopAssessmentInput = {
  title?: string | null | undefined;
  body?: string | null | undefined;
};

export const ISSUE_SLOP_WEIGHTS = {
  unfilledTemplate: 50,
  emptyBody: 40,
} as const;

export const ISSUE_SLOP_RUBRIC_MARKDOWN = [
  "# Gittensory issue slop triage rubric",
  "",
  "- `clean`: 0",
  "- `low`: 1-24",
  "- `elevated`: 25-59",
  "- `high`: 60-100",
  "",
  "Advisory-only (issues never block). Current deterministic signals:",
  "- empty issue body",
  "- issue template opened but left unfilled",
].join("\n");

export function buildIssueSlopAssessment(input: IssueSlopAssessmentInput): SlopAssessment {
  const findings: SignalFinding[] = [];
  const emptyBodyFinding = buildEmptyIssueBodyFinding(input);
  // An empty body and an unfilled template are mutually exclusive (the latter needs a non-empty body), so
  // only probe for the template when there IS a body to inspect.
  const unfilledTemplateFinding = emptyBodyFinding ? null : buildUnfilledIssueTemplateFinding(input);
  if (unfilledTemplateFinding) findings.push(unfilledTemplateFinding);
  if (emptyBodyFinding) findings.push(emptyBodyFinding);

  const slopRisk = clamp(
    (emptyBodyFinding ? ISSUE_SLOP_WEIGHTS.emptyBody : 0) + (unfilledTemplateFinding ? ISSUE_SLOP_WEIGHTS.unfilledTemplate : 0),
    0,
    100,
  );
  return { slopRisk, band: slopBandFor(slopRisk), findings };
}

export function buildEmptyIssueBodyFinding(input: IssueSlopAssessmentInput): SignalFinding | null {
  if ((input.body ?? "").trim().length > 0) return null;
  // Static, public-safe text (no interpolation) — no sanitizer guard needed, unlike the PR findings.
  const detail = "This issue was opened with an empty body.";
  return {
    code: "empty_issue_body",
    title: "Issue has no description",
    severity: "warning",
    detail,
    action: "Add a clear description: what is wrong, where, and why it matters.",
    publicText: detail,
  };
}

// Fires when a non-empty body reduces to NOTHING substantive after stripping template scaffolding (HTML
// comments, markdown headings, empty bullets/checkboxes, residual punctuation) — i.e. the submitter opened
// the issue template and submitted it without filling anything in. Any real prose survives the strip → no fire.
export function buildUnfilledIssueTemplateFinding(input: IssueSlopAssessmentInput): SignalFinding | null {
  const body = (input.body ?? "").trim();
  if (body.length === 0) return null;
  const substantive = body
    .replace(/<!--[\s\S]*?-->/g, "") // HTML comment placeholders
    .replace(/^#{1,6}\s.*$/gm, "") // markdown heading lines
    .replace(/^\s*[-*]\s*(\[[ xX]\])?\s*$/gm, "") // empty bullets / checkboxes
    .replace(/[\s>#*_`+-]/g, "") // residual markdown punctuation + whitespace
    .trim();
  if (substantive.length > 0) return null;
  // Static, public-safe text (no interpolation) — no sanitizer guard needed.
  const detail = "The issue body contains only an unfilled template (headings or comment placeholders, no details).";
  return {
    code: "unfilled_issue_template",
    title: "Issue template left unfilled",
    severity: "warning",
    detail,
    action: "Fill in the template sections with the actual problem details.",
    publicText: detail,
  };
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.trunc(value as number) : 0;
}

function ensurePublicSafeText(text: string, fallback: string): string {
  return isFocusManifestPublicSafe(text) ? text : fallback;
}

function slopBandFor(slopRisk: number): SlopBand {
  if (slopRisk <= 0) return "clean";
  if (slopRisk < 25) return "low";
  if (slopRisk < 60) return "elevated";
  return "high";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
