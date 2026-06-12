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
};

export type SlopAssessment = {
  slopRisk: number;
  band: SlopBand;
  findings: SignalFinding[];
};

export const SLOP_WEIGHTS = {
  missingTestEvidence: 30,
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
  "- missing test evidence",
].join("\n");

export function buildSlopAssessment(input: SlopAssessmentInput): SlopAssessment {
  const findings: SignalFinding[] = [];
  const missingTestEvidenceFinding = buildMissingTestEvidenceFinding(input);
  if (missingTestEvidenceFinding) findings.push(missingTestEvidenceFinding);

  const slopRisk = clamp(missingTestEvidenceFinding ? SLOP_WEIGHTS.missingTestEvidence : 0, 0, 100);

  return {
    slopRisk,
    band: slopBandFor(slopRisk),
    findings,
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
