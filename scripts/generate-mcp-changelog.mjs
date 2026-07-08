#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { latestSemverTag, renderMcpChangelog, selectMcpReleaseCommits } from "./mcp-release-core.mjs";

const defaultOutput = "packages/gittensory-mcp/CHANGELOG.md";
const defaultPackageJson = "packages/gittensory-mcp/package.json";

export function generateMcpChangelog({ output = defaultOutput, version, generatedAt, baseTag, dryRun = false } = {}) {
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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      args.output = argv[++index];
    } else if (arg === "--version") {
      args.version = argv[++index];
    } else if (arg === "--date") {
      args.generatedAt = argv[++index];
    } else if (arg === "--base-tag") {
      args.baseTag = argv[++index];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function latestTagBeforeVersion(version) {
  const tags = git(["tag", "--list", "mcp-v*", "--sort=-v:refname"]).split("\n").filter(Boolean);
  return latestSemverTag(tags.filter((tag) => tag.replace(/^mcp-v/, "") !== version));
}

function readCommits(revisionRange) {
  const format = "%x1e%H%x1f%s%x1f%B";
  const logOutput = git(["log", "--reverse", "--no-merges", `--format=${format}`, revisionRange]);
  return logOutput
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, ...bodyParts] = entry.split("\x1f");
      return {
        sha,
        subject: subject?.split("\n")[0] ?? "",
        body: bodyParts.join("\x1f"),
        files: readCommitFiles(sha),
      };
    });
}

function readCommitFiles(sha) {
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split("\n").filter(Boolean);
}

function readPackageVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function readReleasePrepEntries({ baseTag, targetVersion }) {
  if (!baseTag) return [];
  const entries = [];
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
      files: ["package.json", "packages/gittensory-mcp/package.json", "package-lock.json"],
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

function dependencyChange(name, previousDependencies = {}, currentDependencies = {}) {
  const previousVersion = previousDependencies?.[name];
  const currentVersion = currentDependencies?.[name];
  if (!previousVersion || !currentVersion || previousVersion === currentVersion) return null;
  return `${name} ${previousVersion} -> ${currentVersion}`;
}

function readConstant(source, constantName) {
  return new RegExp(`export const ${constantName} = "([^"]+)"`).exec(source)?.[1] ?? null;
}

function readJsonAt(ref, path) {
  const source = readFileAt(ref, path);
  return source ? JSON.parse(source) : null;
}

function readFileAt(ref, path) {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function existingReleaseDate(changelog, version) {
  const match = new RegExp(`^## mcp-v${escapeRegExp(version)} - (\\d{4}-\\d{2}-\\d{2})$`, "m").exec(changelog);
  return match?.[1] ?? null;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(entrypointPath).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
