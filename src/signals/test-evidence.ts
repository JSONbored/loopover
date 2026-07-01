export function isTestPath(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb)$/i.test(file) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file) ||
    /(^|\/)[^/]+\.(cy|e2e)\.(ts|tsx|js|jsx)$/i.test(file) ||
    /(^|\/)__snapshots__\//i.test(file) ||
    /(^|\/)testdata\//i.test(file)
  );
}

export function hasLocalTestEvidence(input: { tests?: string[] | undefined; testFiles?: string[] | undefined }): boolean {
  return (input.tests ?? []).length > 0 || (input.testFiles ?? []).some((file) => isTestPath(file));
}

/**
 * Coarse classification of how much test coverage accompanies a set of changed paths.
 * Used by slop signals to weight diffs that touch source but include no tests differently
 * from those with proportionally strong test changes.
 */
export type TestCoverageClassification = "strong" | "adequate" | "weak" | "absent";

export function classifyTestCoverage(changedPaths: string[]): TestCoverageClassification {
  if (changedPaths.length === 0) return "absent";
  const testCount = changedPaths.filter(isTestPath).length;
  if (testCount === 0) return "absent";
  const ratio = testCount / changedPaths.length;
  if (ratio >= 0.4) return "strong";
  if (ratio >= 0.2) return "adequate";
  return "weak";
}
