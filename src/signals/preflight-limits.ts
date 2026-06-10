export const PREFLIGHT_LIMITS = {
  repoFullNameChars: 200,
  contributorLoginChars: 100,
  titleChars: 300,
  bodyChars: 20_000,
  labelChars: 100,
  changedFileChars: 300,
  testChars: 300,
  authorAssociationChars: 100,
  labels: 50,
  changedFiles: 200,
  linkedIssues: 100,
  tests: 50,
} as const;
