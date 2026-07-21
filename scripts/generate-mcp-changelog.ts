#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { latestSemverTag, renderMcpChangelog, selectMcpReleaseCommits, type McpReleaseCommit } from "./mcp-release-core.js";

const defaultOutput = "packages/loopover-mcp/CHANGELOG.md";
const defaultPackageJson = "packages/loopover-mcp/package.json";

type GenerateMcpChangelogOptions = {
  output?: string;
  version?: string;
  generatedAt?: string;
  baseTag?: string | null;
  dryRun?: boolean;
};

export function generateMcpChangelog({ output = defaultOutput, version, generatedAt, baseTag, dryRun = false }: GenerateMcpChangelogOptions = {}): {
  output: string;
  version: string;
  baseTag: string | null;
  commits: McpReleaseCommit[];
  changelog: string;
} {
  const targetVersion = version ?? readPackageVersion(defaultPackageJson);
  const resolvedBaseTag = baseTag ?? latestTagBeforeVersion(targetVersion)?.tag ?? null;
  const commits = resolvedBaseTag ? readCommits(`${resolvedBaseTag}..HEAD`) : readCommits("HEAD");
  const selectedCommits = [...selectMcpReleaseCommits(commits), ...readReleasePrepEntries({ baseTag: resolvedBaseTag, targetVersion })];
  const existingChangelog = existsSync(output) ? readFileSync(output, "utf8") : "";
  const releaseDate = generatedAt ?? existingReleaseDate(existingChangelog, targetVersion) ?? todayIsoDate();
  const changelog = renderMcpChangelog({
    existingChangelog,
    targetVersion,
    generatedAt: releaseDate,
    commits: selectedCommits,
  });

  if (!dryRun) writeFileSync(output, changelog);
  return { output, version: targetVersion, baseTag: resolvedBaseTag, commits: selectedCommits, changelog };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = generateMcpChangelog(args);
  if (args.dryRun) {
    process.stdout.write(result.changelog);
  } else {
    process.stdout.write(`Generated ${result.output} for mcp-v${result.version} from ${result.baseTag ?? "repository root"} (${result.commits.length} commits)\n`);
  }
}

function parseArgs(argv: readonly string[]): GenerateMcpChangelogOptions {
  const args: GenerateMcpChangelogOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      args.output = argv[++index]!;
    } else if (arg === "--version") {
      args.version = argv[++index]!;
    } else if (arg === "--date") {
      args.generatedAt = argv[++index]!;
    } else if (arg === "--base-tag") {
      args.baseTag = argv[++index]!;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function latestTagBeforeVersion(version: string) {
  const tags = git(["tag", "--list", "mcp-v*", "--sort=-v:refname"])
    .split("\n")
    .filter(Boolean);
  return latestSemverTag(tags.filter((tag) => tag.replace(/^mcp-v/, "") !== version));
}

function readCommits(revisionRange: string): McpReleaseCommit[] {
  const format = "%x1e%H%x1f%s%x1f%B";
  const logOutput = git(["log", "--reverse", "--no-merges", `--format=${format}`, revisionRange]);
  return logOutput
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, ...bodyParts] = entry.split("\x1f");
      return {
        sha: sha!,
        subject: subject?.split("\n")[0] ?? "",
        body: bodyParts.join("\x1f"),
        files: readCommitFiles(sha!),
      };
    });
}

function readCommitFiles(sha: string): string[] {
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
    .split("\n")
    .filter(Boolean);
}

function readPackageVersion(path: string): string {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

export function readReleasePrepEntries({ baseTag, targetVersion }: { baseTag: string | null; targetVersion: string }): McpReleaseCommit[] {
  if (!baseTag) return [];
  const entries: McpReleaseCommit[] = [];
  const previousMcpPackage = readJsonAt(baseTag, defaultPackageJson);
  const currentMcpPackage = JSON.parse(readFileSync(defaultPackageJson, "utf8"));
  const previousRootPackage = readJsonAt(baseTag, "package.json");
  const currentRootPackage = JSON.parse(readFileSync("package.json", "utf8"));
  const previousCompatibility = readFileAt(baseTag, "src/services/mcp-compatibility.ts");
  const currentCompatibility = readFileSync("src/services/mcp-compatibility.ts", "utf8");

  const dependencyChanges = [
    dependencyChange("@modelcontextprotocol/sdk", previousMcpPackage?.dependencies, currentMcpPackage.dependencies),
    dependencyChange("zod", previousMcpPackage?.dependencies, currentMcpPackage.dependencies),
    dependencyChange("@asteasolutions/zod-to-openapi", previousRootPackage?.dependencies, currentRootPackage.dependencies),
    dependencyChange("agents", previousRootPackage?.dependencies, currentRootPackage.dependencies),
  ].filter(Boolean);

  if (dependencyChanges.length > 0) {
    entries.push({
      sha: "release-prep-deps",
      subject: `chore(deps): update MCP release dependency stack (${dependencyChanges.join(", ")})`,
      files: ["package.json", "packages/loopover-mcp/package.json", "package-lock.json"],
    });
  }

  const previousMinimum = readConstant(previousCompatibility, "MINIMUM_SUPPORTED_MCP_VERSION");
  const currentMinimum = readConstant(currentCompatibility, "MINIMUM_SUPPORTED_MCP_VERSION");
  const previousLatest = readConstant(previousCompatibility, "LATEST_RECOMMENDED_MCP_VERSION");
  const currentLatest = readConstant(currentCompatibility, "LATEST_RECOMMENDED_MCP_VERSION");
  if ((previousMinimum !== currentMinimum || previousLatest !== currentLatest) && currentMinimum === targetVersion && currentLatest === targetVersion) {
    entries.push({
      sha: "release-prep-compat",
      subject: `feat(mcp): require ${targetVersion} as the current supported client`,
      files: ["src/services/mcp-compatibility.ts"],
    });
  }

  return entries;
}

export function dependencyChange(name: string, previousDependencies: Record<string, string> | undefined = {}, currentDependencies: Record<string, string> | undefined = {}): string | null {
  const previousVersion = previousDependencies?.[name];
  const currentVersion = currentDependencies?.[name];
  if (!previousVersion || !currentVersion || previousVersion === currentVersion) return null;
  return `${name} ${previousVersion} -> ${currentVersion}`;
}

export function readConstant(source: string | null, constantName: string): string | null {
  return new RegExp(`export const ${constantName} = "([^"]+)"`).exec(source ?? "")?.[1] ?? null;
}

function readJsonAt(ref: string, path: string): any {
  const source = readFileAt(ref, path);
  return source ? JSON.parse(source) : null;
}

function readFileAt(ref: string, path: string): string | null {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function existingReleaseDate(changelog: string, version: string): string | null {
  const match = new RegExp(`^## mcp-v${escapeRegExp(version)} - (\\d{4}-\\d{2}-\\d{2})$`, "m").exec(changelog);
  return match?.[1] ?? null;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
