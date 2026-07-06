import { classifyTestCoverage, isTestPath, type TestCoverageClassification } from "../signals/test-evidence";
import { isCodeFile } from "../signals/path-matchers";

export type CheckTestEvidenceInput = {
  changedPaths: string[];
  testPaths?: string[] | undefined;
};

export type CheckTestEvidenceReport = {
  classification: TestCoverageClassification;
  codeFileCount: number;
  testFileCount: number;
  docsOnly: boolean;
  guidance: string[];
  generatedAt: string;
};

const CLASSIFICATION_GUIDANCE: Record<TestCoverageClassification, string> = {
  absent: "Add focused regression tests for the changed code paths, or explain why existing coverage is sufficient.",
  weak: "Some test files are present, but coverage is proportionally light — add more focused tests for the code you changed.",
  adequate: "Test changes are proportionally adequate for the number of code files changed.",
  strong: "Test changes are proportionally strong for the number of code files changed.",
};

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/** Deterministic coverage-gap report for MCP `gittensory_check_test_evidence` (#2235). Pure — paths only. */
export function buildCheckTestEvidenceReport(input: CheckTestEvidenceInput): CheckTestEvidenceReport {
  const changedPaths = uniquePaths(input.changedPaths ?? []);
  const extraTestPaths = uniquePaths(input.testPaths ?? []);
  const pathsForClassification = uniquePaths([...changedPaths, ...extraTestPaths]);
  const codeFileCount = changedPaths.filter(isCodeFile).length;
  const testFileCount = pathsForClassification.filter(isTestPath).length;
  const docsOnly = codeFileCount === 0;
  const classification: TestCoverageClassification = docsOnly ? "absent" : classifyTestCoverage(pathsForClassification);

  const guidance: string[] = [];
  if (docsOnly) {
    guidance.push("No code files changed — dedicated test evidence is not required for docs-only churn.");
  } else {
    guidance.push(CLASSIFICATION_GUIDANCE[classification]);
  }

  return {
    classification,
    codeFileCount,
    testFileCount,
    docsOnly,
    guidance,
    generatedAt: new Date().toISOString(),
  };
}
