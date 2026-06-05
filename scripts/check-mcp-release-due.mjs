import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMcpReleaseIssue, buildMcpReleaseReport, latestSemverTag, MCP_RELEASE_DUE_MARKER } from "./mcp-release-core.mjs";

const packageJsonPath = "packages/gittensory-mcp/package.json";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const latestTag = latestSemverTag(git(["tag", "--list", "mcp-v*", "--sort=-v:refname"]).split("\n").filter(Boolean));
  const packageVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  const publishedVersion = readPublishedPackageVersion();
  const commits = latestTag ? readCommits(`${latestTag.tag}..HEAD`) : readCommits("HEAD");
  const report = buildMcpReleaseReport({ latestTag, packageVersion, publishedVersion, commits });

  if (args.output) writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (args.upsertIssue && report.due) await upsertIssue(report);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!args.json && !args.output) {
    process.stdout.write(report.due ? `MCP release due: ${report.proposedVersion}\n` : "No MCP release due.\n");
  }
}

function parseArgs(argv) {
  const args = { json: false, output: null, upsertIssue: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--output") {
      args.output = argv[++index];
    } else if (arg === "--upsert-issue") {
      args.upsertIssue = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function readPublishedPackageVersion() {
  const result = spawnSync("npm", ["view", "@jsonbored/gittensory-mcp", "version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return result.stdout.trim() || null;
  }
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

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

async function upsertIssue(report) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required for --upsert-issue");
  if (!token) throw new Error("GITHUB_TOKEN is required for --upsert-issue");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);

  const issue = buildMcpReleaseIssue(report);
  const existingIssue = await findExistingIssue({ owner, repo, token });
  if (existingIssue) {
    await githubRequest({
      token,
      method: "PATCH",
      path: `/repos/${owner}/${repo}/issues/${existingIssue.number}`,
      body: { title: issue.title, body: issue.body },
    });
    process.stdout.write(`Updated issue #${existingIssue.number}: ${issue.title}\n`);
    return;
  }

  const created = await githubRequest({
    token,
    method: "POST",
    path: `/repos/${owner}/${repo}/issues`,
    body: issue,
  });
  process.stdout.write(`Opened issue #${created.number}: ${issue.title}\n`);
}

async function findExistingIssue({ owner, repo, token }) {
  let page = 1;
  while (page <= 10) {
    const issues = await githubRequest({
      token,
      method: "GET",
      path: `/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`,
    });
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const match = issues.find(isReleaseWatchIssue);
    if (match) return match;
    page += 1;
  }
  return null;
}

export function isReleaseWatchIssue(issue) {
  return (
    !issue.pull_request &&
    issue.user?.login === "github-actions[bot]" &&
    typeof issue.title === "string" &&
    issue.title.startsWith("MCP release due: ") &&
    typeof issue.body === "string" &&
    issue.body.includes(MCP_RELEASE_DUE_MARKER)
  );
}

async function githubRequest({ token, method, path, body }) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "gittensory-mcp-release-watch",
      "x-github-api-version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message ?? response.statusText;
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${message}`);
  }
  return payload;
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(entrypointPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
