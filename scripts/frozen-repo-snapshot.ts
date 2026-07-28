#!/usr/bin/env node
// Frozen-repo snapshot CLI (#9259, harness #9216, epic #8534) — the thin IO wrapper around
// frozen-repo-snapshot-core.ts, mirroring backtest-corpus-export.ts's shape exactly (pure transform in a
// -core module, this file does the reads and the write).
//
//   tsx scripts/frozen-repo-snapshot.ts --repo owner/name --sha <commit> --frozen-at <iso> --output <file.json>
//
// Reads PRs/issues from the GitHub REST API (read-only; GITHUB_TOKEN for private repos or rate limits) and
// past gate decisions from the local/remote D1 via `wrangler d1 execute --json`, then hands EVERYTHING to
// buildFrozenRepoSnapshot, which does all filtering. This file deliberately performs NO date filtering of
// its own beyond what the API needs for paging: one filtering implementation, in the tested pure core, is
// what keeps a leak from hiding in an untested CLI branch.
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  buildFrozenRepoSnapshot,
  auditSnapshotForLeaks,
  type RawDecisionRecord,
  type RawWorkUnitRecord,
  type TimestampedLabel,
} from "./frozen-repo-snapshot-core";

type Args = { repo: string | undefined; sha: string | undefined; frozenAt: string | undefined; output: string | undefined; remote: boolean; db: string };

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { repo: undefined, sha: undefined, frozenAt: undefined, output: undefined, remote: false, db: "loopover" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--repo") args.repo = value;
    else if (flag === "--sha") args.sha = value;
    else if (flag === "--frozen-at") args.frozenAt = value;
    else if (flag === "--output") args.output = value;
    else if (flag === "--remote") args.remote = true;
    else if (flag === "--db" && value) args.db = value;
  }
  return args;
}

/** Every required flag, named individually so a user fixes all of them in one pass rather than one per run. */
export function missingArgs(args: Args): string[] {
  const missing: string[] = [];
  if (!args.repo) missing.push("--repo");
  if (!args.sha) missing.push("--sha");
  if (!args.frozenAt) missing.push("--frozen-at");
  if (!args.output) missing.push("--output");
  return missing;
}

type GitHubIssue = {
  number: number;
  title: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
  labels?: Array<{ name?: string }> | null;
};

type GitHubIssueEvent = { event?: string; created_at?: string; label?: { name?: string } };

async function fetchJson<T>(url: string, token: string | undefined): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "loopover-frozen-repo-snapshot",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${url}`);
  return (await response.json()) as T;
}

/** Label APPLICATION times come from the issue-events timeline — a label object alone carries no timestamp,
 *  so without this every label would be unfilterable and a post-T label would leak into the snapshot. */
async function fetchLabelHistory(repo: string, number: number, token: string | undefined): Promise<TimestampedLabel[]> {
  const events = await fetchJson<GitHubIssueEvent[]>(`https://api.github.com/repos/${repo}/issues/${number}/events?per_page=100`, token);
  return events
    .filter((event) => event.event === "labeled" && typeof event.label?.name === "string" && typeof event.created_at === "string")
    .map((event) => ({ name: String(event.label?.name), appliedAt: String(event.created_at) }));
}

function d1Query(sql: string, remote: boolean, db: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", db, ...(remote ? ["--remote"] : ["--local"]), "--json", "--command", sql],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`wrangler d1 execute failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout) as Array<{ results?: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const missing = missingArgs(args);
  if (missing.length > 0) {
    console.error(`frozen-repo-snapshot: missing required flag(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  const repo = String(args.repo);
  const token = process.env.GITHUB_TOKEN;

  // `state=all` deliberately: whether a unit was OPEN at T is decided by the pure core from createdAt and
  // closedAt, not by GitHub's CURRENT state -- asking for open-only would silently drop every PR that has
  // closed since T, which is most of them for any historical snapshot.
  const issues = await fetchJson<GitHubIssue[]>(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100`, token);

  const workUnits: RawWorkUnitRecord[] = [];
  for (const issue of issues) {
    const labels = await fetchLabelHistory(repo, issue.number, token).catch(() => [] as TimestampedLabel[]);
    workUnits.push({
      workUnitId: `${repo}#${issue.number}`,
      number: issue.number,
      kind: issue.pull_request ? "pull_request" : "issue",
      title: issue.title,
      body: issue.body ?? "",
      authorLogin: issue.user?.login ?? "",
      createdAt: issue.created_at,
      closedAt: issue.closed_at ?? null,
      labels,
    });
  }

  const decisionRows = d1Query(
    `SELECT repo_full_name, pull_number, action, reason_code, created_at FROM decision_records WHERE repo_full_name = '${repo.replace(/'/g, "''")}'`,
    args.remote,
    args.db,
  );
  const decisions: RawDecisionRecord[] = decisionRows.map((row) => ({
    workUnitId: `${String(row["repo_full_name"])}#${String(row["pull_number"])}`,
    action: String(row["action"]),
    reasonCode: String(row["reason_code"]),
    decidedAt: String(row["created_at"]),
  }));

  const snapshot = buildFrozenRepoSnapshot({
    repoFullName: repo,
    commitSha: String(args.sha),
    frozenAt: String(args.frozenAt),
    workUnits,
    decisions,
  });

  // Fail LOUD rather than writing a snapshot that leaks: an inflated benchmark is worse than no benchmark,
  // because its numbers look fine. The audit re-derives the property independently of the builder.
  const leaks = auditSnapshotForLeaks(snapshot);
  if (leaks.length > 0) {
    console.error(`frozen-repo-snapshot: REFUSING to write a snapshot with future information:\n  ${leaks.join("\n  ")}`);
    process.exit(1);
  }

  writeFileSync(String(args.output), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `frozen-repo-snapshot: wrote ${args.output} — ${snapshot.openPullRequests.length} open PR(s), ${snapshot.openIssues.length} open issue(s), ${snapshot.recentDecisions.length} prior decision(s), checksum ${snapshot.snapshotChecksum.slice(0, 12)}…`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  await main();
}
