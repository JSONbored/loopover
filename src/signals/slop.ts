import type { SignalFinding } from "./engine";
import { isCodeFile, isTestFile } from "./local-branch";
import { isFocusManifestPublicSafe } from "./focus-manifest";

export type SlopBand = "clean" | "low" | "elevated" | "high";

export type SlopChangedFile = {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
};

export type SlopAssessmentInput = {
  changedFiles?: SlopChangedFile[] | undefined;
};

export type SlopAssessment = {
  slopRisk: number;
  band: SlopBand;
  findings: SignalFinding[];
};

export const SLOP_WEIGHTS = {
  trivialWhitespaceChurn: 25,
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
].join("\n");

const MIN_CHURN_LINES = 40;
const MAX_SOURCE_LINE_SHARE = 0.15;

export function buildSlopAssessment(input: SlopAssessmentInput): SlopAssessment {
  const findings: SignalFinding[] = [];
  const trivialChurnFinding = buildTrivialWhitespaceChurnFinding(input);
  if (trivialChurnFinding) findings.push(trivialChurnFinding);

  const slopRisk = clamp(trivialChurnFinding ? SLOP_WEIGHTS.trivialWhitespaceChurn : 0, 0, 100);

  return {
    slopRisk,
    band: slopBandFor(slopRisk),
    findings,
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
