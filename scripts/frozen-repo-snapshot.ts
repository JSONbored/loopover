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

export const GITHUB_PER_PAGE = 100;
/** Hard stop, so a pathological repo cannot spin forever. 200 pages x 100 = 20k records, comfortably past
 *  any real benchmark repo; exceeding it is REPORTED, never silently accepted (see below). */
export const GITHUB_MAX_PAGES = 200;

/**
 * Read every page of a GitHub list endpoint.
 *
 * A single `per_page=100` read is not merely incomplete on a large repo -- it is NON-REPRODUCIBLE, which is
 * worse for this tool specifically. The snapshot's whole value is that two runs over the same (repo, T)
 * produce the same checksum; a truncated read makes the checksum a function of how many records the repo
 * happened to have, so the same T could yield two different "authoritative" snapshots. And the truncation is
 * silent: the output is a perfectly well-formed snapshot that is simply missing history.
 *
 * So this pages to exhaustion and reports `truncated` when it hits the bound rather than returning a short
 * list as if it were complete. The caller REFUSES to write a truncated snapshot, the same posture as the
 * leak audit -- a snapshot nobody can reproduce is not one worth publishing.
 */
export async function fetchAllPages<T>(
  pageUrl: (page: number) => string,
  readPage: (url: string) => Promise<T[]>,
  maxPages: number = GITHUB_MAX_PAGES,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await readPage(pageUrl(page));
    items.push(...batch);
    // A short page is the last page. An exactly-full final page costs one extra empty request, which is the
    // correct trade against guessing the end from a count the API does not promise.
    if (batch.length < GITHUB_PER_PAGE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/** Label APPLICATION times come from the issue-events timeline — a label object alone carries no timestamp,
 *  so without this every label would be unfilterable and a post-T label would leak into the snapshot.
 *  Paginated for the same reason as the issue list: a long-lived issue can carry well over 100 events, and
 *  dropping the earlier ones would silently omit labels that were genuinely applied before T. */
async function fetchLabelHistory(
  repo: string,
  number: number,
  token: string | undefined,
): Promise<{ labels: TimestampedLabel[]; truncated: boolean }> {
  const { items, truncated } = await fetchAllPages<GitHubIssueEvent>(
    (page) => `https://api.github.com/repos/${repo}/issues/${number}/events?per_page=${GITHUB_PER_PAGE}&page=${page}`,
    (url) => fetchJson<GitHubIssueEvent[]>(url, token),
  );
  return {
    labels: items
      .filter((event) => event.event === "labeled" && typeof event.label?.name === "string" && typeof event.created_at === "string")
      .map((event) => ({ name: String(event.label?.name), appliedAt: String(event.created_at) })),
    truncated,
  };
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
  const issuePages = await fetchAllPages<GitHubIssue>(
    (page) => `https://api.github.com/repos/${repo}/issues?state=all&per_page=${GITHUB_PER_PAGE}&page=${page}`,
    (url) => fetchJson<GitHubIssue[]>(url, token),
  );
  const truncations: string[] = [];
  if (issuePages.truncated) truncations.push(`issue list exceeded ${GITHUB_MAX_PAGES} pages`);

  const workUnits: RawWorkUnitRecord[] = [];
  for (const issue of issuePages.items) {
    // A label-history read that FAILS degrades to no labels (the snapshot loses context but stays honest);
    // one that TRUNCATES is recorded, because missing an early `labeled` event silently omits a label that
    // was genuinely applied before T -- a wrong snapshot rather than a thinner one.
    const history = await fetchLabelHistory(repo, issue.number, token).catch(() => ({ labels: [] as TimestampedLabel[], truncated: false }));
    if (history.truncated) truncations.push(`#${issue.number} label history exceeded ${GITHUB_MAX_PAGES} pages`);
    const labels = history.labels;
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

  // Same posture as the leak refusal: a truncated read produces a well-formed snapshot that is simply
  // missing history, and whose checksum therefore depends on how much the reader happened to see. That is
  // not a snapshot anyone can reproduce, so it is not one worth writing.
  if (truncations.length > 0) {
    console.error(`frozen-repo-snapshot: REFUSING to write a snapshot from a truncated read:\n  ${truncations.join("\n  ")}`);
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
