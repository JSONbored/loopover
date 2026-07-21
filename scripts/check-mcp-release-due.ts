import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildMcpReleaseIssue, buildMcpReleaseReport, latestSemverTag, MCP_RELEASE_DUE_MARKER, type McpReleaseCommit, type McpReleaseReport } from "./mcp-release-core.js";

const packageJsonPath = "packages/loopover-mcp/package.json";
// Per-request timeout so a hung api.github.com connection can't block the unattended mcp-release-watch job
// indefinitely, matching the connection guard sibling release/observability scripts already use (#7014).
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

type ParsedArgs = {
  json: boolean;
  output: string | null;
  upsertIssue: boolean;
};

export type GitHubIssueCandidate = {
  pull_request?: unknown;
  title?: unknown;
  body?: unknown;
  user?: {
    login?: unknown;
  } | null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const latestTag = latestSemverTag(
    git(["tag", "--list", "mcp-v*", "--sort=-v:refname"])
      .split("\n")
      .filter(Boolean),
  );
  const packageVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  const publishedVersion = readPublishedPackageVersion();
  const commits = latestTag ? readCommits(`${latestTag.tag}..HEAD`) : readCommits("HEAD");
  const report = buildMcpReleaseReport({ latestTag, packageVersion, publishedVersion, commits });

  if (args.output) writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (args.upsertIssue) {
    if (report.due) {
      await upsertIssue(report);
    } else {
      await closeResolvedIssueIfPresent(report);
    }
  }
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!args.json && !args.output) {
    process.stdout.write(report.due ? `MCP release due: ${report.proposedVersion}\n` : "No MCP release due.\n");
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { json: false, output: null, upsertIssue: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--output") {
      args.output = argv[++index] ?? null;
    } else if (arg === "--upsert-issue") {
      args.upsertIssue = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function readPublishedPackageVersion(): string | null {
  const result = spawnSync("npm", ["view", "@loopover/mcp", "version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return result.stdout.trim() || null;
  }
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

function git(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 });
}

async function upsertIssue(report: McpReleaseReport) {
  const { owner, repo, token } = resolveRepoAndToken();
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

// upsertIssue only ever opens/refreshes the tracking issue while a release is due -- without this,
// the issue it created is never closed once release-please catches up (confirmed live: #6145 stayed
// open and stale after mcp-v3.1.0's release-please PR merged, since no due=false run had ever closed it).
export async function closeResolvedIssueIfPresent(report: McpReleaseReport) {
  const { owner, repo, token } = resolveRepoAndToken();
  const existingIssue = await findExistingIssue({ owner, repo, token });
  if (!existingIssue) return;

  const body = `MCP is caught up: latest tag \`${report.latestTag ?? "none"}\` matches the package version \`${report.packageVersion}\`, and npm's published version is \`${report.publishedVersion ?? "unknown"}\`, with no unreleased MCP-related commits. Closing -- release-please's own Release PR reopens this signal automatically if a new release becomes due.`;
  await githubRequest({
    token,
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${existingIssue.number}/comments`,
    body: { body },
  });
  await githubRequest({
    token,
    method: "PATCH",
    path: `/repos/${owner}/${repo}/issues/${existingIssue.number}`,
    body: { state: "closed", state_reason: "completed" },
  });
  process.stdout.write(`Closed issue #${existingIssue.number}: release caught up.\n`);
}

function resolveRepoAndToken(): { owner: string; repo: string; token: string } {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required for --upsert-issue");
  if (!token) throw new Error("GITHUB_TOKEN is required for --upsert-issue");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  return { owner, repo, token };
}

async function findExistingIssue({ owner, repo, token }: { owner: string; repo: string; token: string }): Promise<GitHubIssueCandidate & { number: number } | null> {
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

export function isReleaseWatchIssue(issue: GitHubIssueCandidate): boolean {
  return (
    !issue.pull_request &&
    issue.user?.login === "github-actions[bot]" &&
    typeof issue.title === "string" &&
    issue.title.startsWith("MCP release due: ") &&
    typeof issue.body === "string" &&
    issue.body.includes(MCP_RELEASE_DUE_MARKER)
  );
}

async function githubRequest({ token, method, path, body }: { token: string; method: string; path: string; body?: unknown }): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "loopover-mcp-release-watch",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message ?? response.statusText;
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${message}`);
  }
  return payload;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
