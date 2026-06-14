import type { SignalFinding } from "./engine";
import { isCodeFile, isTestFile } from "./local-branch";
import { hasLocalTestEvidence, isTestPath } from "./test-evidence";
import { isFocusManifestPublicSafe } from "./focus-manifest";

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
// never feed this score. Weights sum to 75 so the `high` band (>=60) is reachable from two strong signals.
export const SLOP_WEIGHTS = {
  trivialWhitespaceChurn: 30,
  missingTestEvidence: 30,
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
  "- empty pull request description on a code change",
].join("\n");

const MIN_CHURN_LINES = 40;
const MAX_SOURCE_LINE_SHARE = 0.15;

export function buildSlopAssessment(input: SlopAssessmentInput): SlopAssessment {
  const findings: SignalFinding[] = [];
  const trivialChurnFinding = buildTrivialWhitespaceChurnFinding(input);
  const missingTestEvidenceFinding = buildMissingTestEvidenceFinding(input);
  const emptyDescriptionFinding = buildEmptyDescriptionFinding(input);
  if (trivialChurnFinding) findings.push(trivialChurnFinding);
  if (missingTestEvidenceFinding) findings.push(missingTestEvidenceFinding);
  if (emptyDescriptionFinding) findings.push(emptyDescriptionFinding);

  const slopRisk = clamp(
    (trivialChurnFinding ? SLOP_WEIGHTS.trivialWhitespaceChurn : 0) +
      (missingTestEvidenceFinding ? SLOP_WEIGHTS.missingTestEvidence : 0) +
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
