// Pure semver/conventional-commit primitives shared by mcp-release-core.ts (MCP's bespoke
// cross-cutting-path release watcher) and package-release-core.ts (the generic engine/miner/ui-kit
// watcher, #8591). Extracted rather than duplicated so a bug fix in, say, prerelease comparison only
// needs to happen once.

export type ParsedConventionalSubject = {
  type: string | null;
  scope: string | null;
  breaking: boolean;
  description: string;
  conventional: boolean;
};

export function parseConventionalSubject(subject: string): ParsedConventionalSubject {
  const trimmed = subject.trim();
  const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/.exec(trimmed);
  if (match?.groups) {
    return {
      type: match.groups.type!,
      scope: match.groups.scope ?? null,
      breaking: Boolean(match.groups.breaking),
      description: match.groups.description!.trim(),
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

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

export function parseSemver(version: string | null | undefined): ParsedSemver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareSemver(leftVersion: string, rightVersion: string): number | null {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const prereleaseComparison = left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true, sensitivity: "base" });
  return prereleaseComparison === 0 ? 0 : prereleaseComparison < 0 ? -1 : 1;
}

export function bumpVersion(version: string, releaseType: "major" | "minor" | "patch"): string {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`Invalid semver version: ${version}`);
  if (releaseType === "major") return `${parsed.major + 1}.0.0`;
  if (releaseType === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function latestSemverTagWithPrefix(tags: readonly string[], prefix: string): { tag: string; version: string } | null {
  return (
    tags
      .filter((tag) => tag.startsWith(prefix))
      .map((tag) => ({ tag, version: tag.slice(prefix.length) }))
      .filter(({ version }) => parseSemver(version))
      .sort((left, right) => compareSemver(right.version, left.version) ?? 0)[0] ?? null
  );
}

export function inferReleaseTypeFromSubjects(subjects: readonly { subject?: string; body?: string }[]): "major" | "minor" | "patch" | null {
  if (subjects.length === 0) return null;
  let type: "major" | "minor" | "patch" = "patch";
  for (const commit of subjects) {
    const parsed = parseConventionalSubject(commit.subject ?? "");
    if (parsed.breaking || /BREAKING CHANGE:/i.test(commit.body ?? "")) return "major";
    if (parsed.type === "feat") type = "minor";
  }
  return type;
}

export function shortSha(sha: string | undefined): string {
  return String(sha ?? "").slice(0, 7);
}

export function escapeIssueMarkdownText(value: string | undefined): string {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1");
}
