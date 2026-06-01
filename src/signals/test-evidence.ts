export function isTestPath(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb)$/i.test(file) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file)
  );
}

export function hasLocalTestEvidence(input: { tests?: string[] | undefined; testFiles?: string[] | undefined }): boolean {
  return (input.tests ?? []).length > 0 || (input.testFiles ?? []).some((file) => isTestPath(file));
}
