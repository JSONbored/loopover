export const MCP_RELEASE_DUE_MARKER = "<!-- gittensory:mcp-release-due -->";

const DIRECT_MCP_PATHS = [
  "packages/gittensory-mcp/",
  ".github/workflows/npm-publish.yml",
  "src/mcp/",
  "src/services/mcp-compatibility.ts",
  "src/signals/local-branch.ts",
  "src/signals/local-workspace-intelligence.ts",
];

const CLIENT_VISIBLE_PATHS = [
  "src/services/agent-orchestrator.ts",
  "src/services/client-telemetry.ts",
  "src/services/contributor-evidence-graph.ts",
  "src/services/decision-pack.ts",
  "src/services/repo-outcome-patterns.ts",
  "src/scoring/pending-pr-scenarios.ts",
  "src/scoring/preview.ts",
  "src/signals/focus-manifest-loader.ts",
  "src/signals/focus-manifest.ts",
];

const SUPPORTING_VISIBLE_PATHS = ["src/openapi/schemas.ts", "src/openapi/spec.ts"];

const GENERATED_OPENAPI_PATHS = ["apps/gittensory-ui/public/openapi.json", "src/openapi/spec.ts"];
const UI_ONLY_PREFIXES = ["apps/gittensory-ui/", "apps/gittensory-extension/"];
const RELEASE_SCOPES = new Set(["release", "changelog"]);
const EXCLUDED_SCOPES = new Set(["pwa", "ui", "extension", "github-agent", "sync", "upstream"]);
const GROUP_ORDER = ["Features", "Fixes", "Security", "CI", "Build", "Docs", "Tests", "Refactors", "Dependencies", "Chores", "Reverts"];

export function parseConventionalSubject(subject) {
  const trimmed = subject.trim();
  const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/.exec(trimmed);
  if (match?.groups) {
    return {
      type: match.groups.type,
      scope: match.groups.scope ?? null,
      breaking: Boolean(match.groups.breaking),
      description: match.groups.description.trim(),
      conventional: true,
    };
  }

  if (/^fix\b/i.test(trimmed)) {
    return {
      type: "fix",
      scope: null,
      breaking: false,
      description: trimmed.replace(/^fix[:\s-]*/i, "").trim() || trimmed,
      conventional: false,
    };
  }

  return {
    type: null,
    scope: null,
    breaking: false,
    description: trimmed,
    conventional: false,
  };
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const prereleaseComparison = left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true, sensitivity: "base" });
  return prereleaseComparison === 0 ? 0 : prereleaseComparison < 0 ? -1 : 1;
}

export function bumpVersion(version, releaseType) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`Invalid semver version: ${version}`);
  if (releaseType === "major") return `${parsed.major + 1}.0.0`;
  if (releaseType === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function latestSemverTag(tags) {
  return tags
    .map((tag) => ({ tag, version: tag.replace(/^mcp-v/, "") }))
    .filter(({ version }) => parseSemver(version))
    .sort((left, right) => compareSemver(right.version, left.version) ?? 0)[0] ?? null;
}

export function selectMcpReleaseCommits(commits) {
  return commits.filter((commit) => isMcpReleaseRelevantCommit(commit));
}

export function isMcpReleaseRelevantCommit(commit) {
  const subject = commit.subject ?? "";
  const files = uniqueSorted(commit.files ?? []);
  if (!subject.trim()) return false;
  if (/^merge\b/i.test(subject)) return false;
  if (isGeneratedOnlyOpenApiChange(files)) return false;
  if (isUiOnlyChange(files)) return false;

  const parsed = parseConventionalSubject(subject);
  if (parsed.scope && RELEASE_SCOPES.has(parsed.scope)) return false;
  if (parsed.scope && EXCLUDED_SCOPES.has(parsed.scope) && !hasAnyPath(files, DIRECT_MCP_PATHS)) return false;
  if (!parsed.type && !parsed.conventional) return false;

  const hasDirectMcpPath = hasAnyPath(files, DIRECT_MCP_PATHS);
  const hasPackageReleasePath = hasAnyPath(files, ["packages/gittensory-mcp/", ".github/workflows/npm-publish.yml"]);
  const hasClientVisiblePath = hasAnyPath(files, CLIENT_VISIBLE_PATHS);
  const hasOnlySupportingVisiblePath = hasAnyPath(files, SUPPORTING_VISIBLE_PATHS) && !hasDirectMcpPath && !hasClientVisiblePath;

  if (parsed.type === "test" && !hasPackageReleasePath) return false;

  if (hasDirectMcpPath) return true;
  if (hasClientVisiblePath && isClientVisibleChange(parsed, subject)) return true;
  if (hasOnlySupportingVisiblePath && parsed.scope === "mcp") return true;
  return false;
}

export function renderMcpChangelog({ existingChangelog = "", targetVersion, generatedAt, commits }) {
  const targetTag = `mcp-v${targetVersion}`;
  const normalizedExisting = normalizeNewlines(existingChangelog).trimEnd();
  const headerMatch = /^# Changelog\n+/.exec(normalizedExisting);
  const header = "# Changelog\n\n";
  const body = headerMatch ? normalizedExisting.slice(headerMatch[0].length) : normalizedExisting.replace(/^# Changelog\s*/m, "").trimStart();
  const newSection = renderReleaseSection({ tag: targetTag, generatedAt, commits });
  const targetHeaderPattern = new RegExp(`^## ${escapeRegExp(targetTag)} - .+$`, "m");
  const targetHeaderMatch = targetHeaderPattern.exec(body);

  if (targetHeaderMatch && targetHeaderMatch.index === 0) {
    const nextHeaderIndex = body.indexOf("\n## ", targetHeaderMatch[0].length);
    if (nextHeaderIndex === -1) return `${header}${newSection}\n`;
    return `${header}${newSection}\n\n${body.slice(nextHeaderIndex + 1)}\n`;
  }

  const historical = body.trim().length > 0 ? `${body}\n` : "";
  return historical ? `${header}${newSection}\n\n${historical}` : `${header}${newSection}\n`;
}

export function renderReleaseSection({ tag, generatedAt, commits }) {
  const groups = groupCommits(commits);
  const lines = [`## ${tag} - ${generatedAt}`];
  for (const group of GROUP_ORDER) {
    const groupCommits = groups.get(group) ?? [];
    if (groupCommits.length === 0) continue;
    lines.push("", `### ${group}`);
    for (const commit of groupCommits) lines.push(`- ${formatCommitForChangelog(commit)}`);
  }
  if ([...groups.values()].every((entries) => entries.length === 0)) {
    lines.push("", "### Chores", "- Prepare MCP release metadata");
  }
  return lines.join("\n");
}

export function buildMcpReleaseReport({ latestTag, packageVersion, publishedVersion, commits }) {
  const includedCommits = selectMcpReleaseCommits(commits);
  const releaseType = inferReleaseType(includedCommits);
  const latestVersion = latestTag?.version ?? "0.0.0";
  const inferredVersion = releaseType ? bumpVersion(latestVersion, releaseType) : latestVersion;
  const proposedVersion =
    packageVersion && compareSemver(packageVersion, inferredVersion) === 1
      ? packageVersion
      : inferredVersion;
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

export function buildMcpReleaseIssue(report) {
  const title = `MCP release due: ${report.proposedVersion}`;
  const npmVersion = report.publishedVersion ?? "unknown";
  const latestTag = report.latestTag ?? "none";
  const commits = report.commits.length > 0 ? report.commits.map((commit) => `- \`${shortSha(commit.sha)}\` ${commit.subject}`).join("\n") : "- No unreleased MCP-related commits detected.";
  const changedFiles = report.changedFiles.length > 0 ? report.changedFiles.map((file) => `- \`${file}\``).join("\n") : "- No MCP-related changed files detected.";

  const body = `${MCP_RELEASE_DUE_MARKER}

## Summary

An MCP release appears due.

- Proposed version: \`${report.proposedVersion}\`
- Latest MCP tag: \`${latestTag}\`
- npm latest: \`${npmVersion}\`
- MCP package version in repo: \`${report.packageVersion}\`
- Unreleased MCP-related commits: \`${report.commits.length}\`

## Unreleased MCP-Related Commits

${commits}

## Changed Files

${changedFiles}

## Release-Prep Checklist

- [ ] Bump \`packages/gittensory-mcp/package.json\` to \`${report.proposedVersion}\`
- [ ] Bump the CLI \`packageVersion\` constant to \`${report.proposedVersion}\`
- [ ] Update MCP compatibility metadata minimum supported and latest recommended versions to \`${report.proposedVersion}\`
- [ ] Generate \`packages/gittensory-mcp/CHANGELOG.md\` with a \`mcp-v${report.proposedVersion}\` section
- [ ] Run \`npm run build:mcp\`
- [ ] Run \`npm run test:mcp-pack\`
- [ ] Run \`npm run changelog:check:mcp\`
- [ ] Run \`npm run actionlint\`
- [ ] Run \`npm run test:release:mcp\`
- [ ] Merge the release-prep PR
- [ ] Tag \`mcp-v${report.proposedVersion}\`
- [ ] Watch npm trusted publishing and the GitHub Release job
`;

  return { title, body };
}

export function normalizeNewlines(value) {
  return value.replace(/\r\n/g, "\n");
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function isClientVisibleChange(parsed, subject) {
  if (parsed.breaking) return true;
  if (parsed.type === "feat" || parsed.type === "fix" || parsed.type === "refactor") return true;
  if (parsed.type === "docs" && /mcp|local|branch|compat|client|release/i.test(subject)) return true;
  return /^fix\b/i.test(subject);
}

function isGeneratedOnlyOpenApiChange(files) {
  const meaningfulFiles = files.filter((file) => !isTestFile(file));
  return meaningfulFiles.length > 0 && meaningfulFiles.every((file) => GENERATED_OPENAPI_PATHS.includes(file));
}

function isUiOnlyChange(files) {
  const meaningfulFiles = files.filter((file) => !isTestFile(file));
  return meaningfulFiles.length > 0 && meaningfulFiles.every((file) => UI_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function hasAnyPath(files, paths) {
  return files.some((file) => paths.some((path) => matchesPath(file, path)));
}

function matchesPath(file, path) {
  return path.endsWith("/") ? file.startsWith(path) : file === path;
}

function isTestFile(file) {
  return file.startsWith("test/") || file.includes(".test.") || file.includes(".spec.");
}

function groupCommits(commits) {
  const groups = new Map(GROUP_ORDER.map((group) => [group, []]));
  for (const commit of commits) {
    const group = groupForCommit(commit);
    groups.get(group)?.push(commit);
  }
  return groups;
}

function groupForCommit(commit) {
  const parsed = parseConventionalSubject(commit.subject ?? "");
  if (parsed.scope === "security") return "Security";
  if (parsed.type === "feat") return "Features";
  if (parsed.type === "fix") return "Fixes";
  if (parsed.type === "ci") return "CI";
  if (parsed.type === "build") return "Build";
  if (parsed.type === "docs") return "Docs";
  if (parsed.type === "test") return "Tests";
  if (parsed.type === "refactor") return "Refactors";
  if (parsed.type === "chore" && parsed.scope === "deps") return "Dependencies";
  if (parsed.type === "chore") return "Chores";
  if (parsed.type === "revert") return "Reverts";
  return "Chores";
}

function formatCommitForChangelog(commit) {
  const parsed = parseConventionalSubject(commit.subject ?? "");
  const description = parsed.description || commit.subject || shortSha(commit.sha);
  return upperFirst(description);
}

function inferReleaseType(commits) {
  if (commits.length === 0) return null;
  let type = "patch";
  for (const commit of commits) {
    const parsed = parseConventionalSubject(commit.subject ?? "");
    if (parsed.breaking || /BREAKING CHANGE:/i.test(commit.body ?? "")) return "major";
    if (parsed.type === "feat") type = "minor";
  }
  return type;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function shortSha(sha) {
  return String(sha ?? "").slice(0, 7);
}

function upperFirst(value) {
  const trimmed = value.trim();
  return trimmed ? `${trimmed[0].toUpperCase()}${trimmed.slice(1)}` : trimmed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
