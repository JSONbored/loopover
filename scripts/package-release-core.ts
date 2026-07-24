// Generic "release due" watcher core for engine/miner/ui-kit (#8591), the simpler siblings of MCP's
// bespoke mcp-release-core.ts. Unlike MCP, none of these three packages have commits that need
// attributing from OUTSIDE their own packages/loopover-<name>/ directory (no cross-cutting src/**
// dependency the way MCP wraps app-side Worker logic), and all three already have release-please
// maintaining their CHANGELOG.md natively (release-please-config.json's "packages" list) -- so this
// core only needs due-detection + issue-tracking, no bespoke changelog renderer.
import { bumpVersion, compareSemver, escapeIssueMarkdownText, inferReleaseTypeFromSubjects, parseConventionalSubject, shortSha } from "./release-semver-utils.js";

export type PackageReleaseCommit = {
  sha?: string;
  subject?: string;
  body?: string;
  files?: string[];
};

export type PackageReleaseReport = {
  due: boolean;
  proposedVersion: string;
  latestTag: string | null;
  latestTagVersion: string | null;
  packageVersion: string;
  publishedVersion: string | null;
  releaseType: "major" | "minor" | "patch" | null;
  commits: PackageReleaseCommit[];
  changedFiles: string[];
};

/** Static identity for one of the three simple packages -- the package name, its npm name, tag prefix,
 *  the path its commits must touch to count, and the marker/checklist text for its tracking issue. */
export type PackageReleaseConfig = {
  /** Human-readable name used in issue titles/bodies, e.g. "engine". */
  displayName: string;
  /** The workspace package name, e.g. "@loopover/engine". */
  npmPackage: string;
  /** The package.json to read the current committed version from. */
  packageJsonPath: string;
  /** The path prefix a commit's files must fall under to count toward this package's release, e.g. "packages/loopover-engine/". */
  packagePathPrefix: string;
  /** Git tag prefix, e.g. "engine-v". */
  tagPrefix: string;
  /** The npm test script that dry-run-validates the published tarball, e.g. "test:engine-pack". */
  packCheckScript: string;
  /** HTML comment marker embedded in the tracking issue body, unique per package so findExistingIssue never cross-matches. */
  marker: string;
};

function markerFor(displayName: string): string {
  return `<!-- loopover:${displayName}-release-due -->`;
}

export const PACKAGE_RELEASE_CONFIGS: Record<"engine" | "miner" | "ui-kit", PackageReleaseConfig> = {
  engine: {
    displayName: "engine",
    npmPackage: "@loopover/engine",
    packageJsonPath: "packages/loopover-engine/package.json",
    packagePathPrefix: "packages/loopover-engine/",
    tagPrefix: "engine-v",
    packCheckScript: "test:engine-pack",
    marker: markerFor("engine"),
  },
  miner: {
    displayName: "miner",
    npmPackage: "@loopover/miner",
    packageJsonPath: "packages/loopover-miner/package.json",
    packagePathPrefix: "packages/loopover-miner/",
    tagPrefix: "miner-v",
    packCheckScript: "test:miner-pack",
    marker: markerFor("miner"),
  },
  "ui-kit": {
    displayName: "ui-kit",
    npmPackage: "@loopover/ui-kit",
    packageJsonPath: "packages/loopover-ui-kit/package.json",
    packagePathPrefix: "packages/loopover-ui-kit/",
    tagPrefix: "ui-kit-v",
    packCheckScript: "test:ui-kit-pack",
    marker: markerFor("ui-kit"),
  },
};

/** A commit counts toward this package's release if it's non-empty, not a merge commit, and touches
 *  at least one file under the package's own directory -- no cross-cutting-path/scope-exclusion
 *  machinery, unlike MCP's isMcpReleaseRelevantCommit (see this file's header for why). */
export function isPackageReleaseRelevantCommit(commit: PackageReleaseCommit, config: PackageReleaseConfig): boolean {
  const subject = commit.subject ?? "";
  if (!subject.trim()) return false;
  if (/^merge\b/i.test(subject)) return false;
  const files = commit.files ?? [];
  if (!files.some((file) => file.startsWith(config.packagePathPrefix))) return false;
  const parsed = parseConventionalSubject(subject);
  if (!parsed.type && !parsed.conventional) return false;
  if (parsed.scope === "release" || parsed.scope === "changelog") return false;
  return true;
}

export function selectPackageReleaseCommits<T extends PackageReleaseCommit>(commits: readonly T[], config: PackageReleaseConfig): T[] {
  return commits.filter((commit) => isPackageReleaseRelevantCommit(commit, config));
}

export function buildPackageReleaseReport({
  config,
  latestTag,
  packageVersion,
  publishedVersion,
  commits,
}: {
  config: PackageReleaseConfig;
  latestTag: { tag: string; version: string } | null;
  packageVersion: string;
  publishedVersion: string | null;
  commits: PackageReleaseCommit[];
}): PackageReleaseReport {
  const includedCommits = selectPackageReleaseCommits(commits, config);
  const releaseType = inferReleaseTypeFromSubjects(includedCommits);
  const latestVersion = latestTag?.version ?? "0.0.0";
  const inferredVersion = releaseType ? bumpVersion(latestVersion, releaseType) : latestVersion;
  const proposedVersion = packageVersion && compareSemver(packageVersion, inferredVersion) === 1 ? packageVersion : inferredVersion;
  const tagMatchesPackage = latestTag?.version === packageVersion;
  const npmMatchesPackage = publishedVersion === packageVersion;
  const due = includedCommits.length > 0 || !tagMatchesPackage || !npmMatchesPackage;

  return {
    due,
    proposedVersion,
    latestTag: latestTag?.tag ?? null,
    latestTagVersion: latestTag?.version ?? null,
    packageVersion,
    publishedVersion,
    releaseType,
    commits: includedCommits,
    changedFiles: uniqueSorted(includedCommits.flatMap((commit) => commit.files ?? [])),
  };
}

export function buildPackageReleaseIssue(report: PackageReleaseReport, config: PackageReleaseConfig): { title: string; body: string } {
  const title = `${capitalize(config.displayName)} release due: ${report.proposedVersion}`;
  const npmVersion = report.publishedVersion ?? "unknown";
  const latestTag = report.latestTag ?? "none";
  const commits =
    report.commits.length > 0
      ? report.commits.map((commit) => `- \`${shortSha(commit.sha)}\` ${escapeIssueMarkdownText(commit.subject)}`).join("\n")
      : `- No unreleased ${config.displayName}-related commits detected.`;
  const changedFiles = report.changedFiles.length > 0 ? report.changedFiles.map((file) => `- \`${file}\``).join("\n") : "- No changed files detected.";
  const tag = `${config.tagPrefix}${report.proposedVersion}`;

  const body = `${config.marker}

## Summary

A ${config.npmPackage} release appears due.

- Proposed version: \`${report.proposedVersion}\`
- Latest tag: \`${latestTag}\`
- npm latest: \`${npmVersion}\`
- Package version in repo: \`${report.packageVersion}\`
- Unreleased ${config.displayName}-related commits: \`${report.commits.length}\`

## Unreleased Commits

${commits}

## Changed Files

${changedFiles}

## Release-Prep Checklist

- [ ] Bump \`${config.packageJsonPath}\` to \`${report.proposedVersion}\`
- [ ] Run \`npm run build --workspace ${config.npmPackage}\`
- [ ] Run \`npm run ${config.packCheckScript}\`
- [ ] Run \`npm run actionlint\`
- [ ] Merge the release-please PR (it maintains this package's CHANGELOG.md natively)
- [ ] Tag \`${tag}\`
- [ ] Watch npm trusted publishing and the GitHub Release job
`;

  return { title, body };
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
