export const MCP_RELEASE_DUE_MARKER: string;

export type McpReleaseCommit = {
  sha?: string;
  subject?: string;
  body?: string;
  files?: string[];
};

export type McpReleaseReport = {
  due: boolean;
  proposedVersion: string;
  latestTag: string | null;
  latestTagVersion: string | null;
  packageVersion: string;
  publishedVersion: string | null;
  releaseType: "major" | "minor" | "patch" | null;
  commits: McpReleaseCommit[];
  changedFiles: string[];
};

export function parseConventionalSubject(subject: string): {
  type: string | null;
  scope: string | null;
  breaking: boolean;
  description: string;
  conventional: boolean;
};
export function compareSemver(leftVersion: string, rightVersion: string): number | null;
export function bumpVersion(version: string, releaseType: "major" | "minor" | "patch"): string;
export function latestSemverTag(tags: string[]): { tag: string; version: string } | null;
export function selectMcpReleaseCommits<T extends McpReleaseCommit>(commits: T[]): T[];
export function isMcpReleaseRelevantCommit(commit: McpReleaseCommit): boolean;
export function renderMcpChangelog(input: { existingChangelog?: string; targetVersion: string; generatedAt: string; commits: McpReleaseCommit[] }): string;
export function renderReleaseSection(input: { tag: string; generatedAt: string; commits: McpReleaseCommit[] }): string;
export function buildMcpReleaseReport(input: {
  latestTag: { tag: string; version: string } | null;
  packageVersion: string;
  publishedVersion: string | null;
  commits: McpReleaseCommit[];
}): McpReleaseReport;
export function buildMcpReleaseIssue(report: McpReleaseReport): { title: string; body: string };
export function normalizeNewlines(value: string): string;
