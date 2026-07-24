#!/usr/bin/env node
// Detects when /roadmap still presents phase epics as active/upcoming ("shipping-soon" / "planned")
// while the linked GitHub issues are already closed as completed. That drift silently persisted on the
// public page after phases #233-#238 shipped (#8390). Local/manual (or future scheduled) check only —
// needs live GitHub API access, so it is deliberately NOT wired into `test:ci`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_ROADMAP_SOURCE = "apps/loopover-ui/src/routes/roadmap.tsx";
export const DEFAULT_OWNER = "JSONbored";
export const DEFAULT_REPO = "loopover";

/** Statuses that visually present the item as still-active / upcoming work on /roadmap. */
export const ACTIVE_ROADMAP_STATUSES = new Set<string>(["shipping-soon", "planned"]);

export type RoadmapItemStatus = "shipping-soon" | "planned" | "exploring";

export type RoadmapItemRef = {
  status: RoadmapItemStatus;
  issue: number;
};

export type GithubIssueState = {
  state: string;
  stateReason: string | null;
};

// Deliberately `any`-shaped like check-stuck-required-checks: callers read issue fields off the
// resolved JSON without a runtime schema, and typing this `unknown` would only force casts.
export type GithubApi = (path: string, options?: { method?: string; headers?: Record<string, string> }) => Promise<any>;

export function makeGithubApi(token: string): GithubApi {
  return async function githubApi(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status} on ${path}: ${await response.text()}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

/** Parse `ROADMAP_ITEMS` object literals from `roadmap.tsx` source text (status + issue only). */
export function parseRoadmapItems(sourceText: string): RoadmapItemRef[] {
  const catalogMatch = /const\s+ROADMAP_ITEMS[^=]*=\s*\[([\s\S]*?)\];/.exec(sourceText);
  if (!catalogMatch) throw new Error("ROADMAP_ITEMS array not found in roadmap source");
  const body = catalogMatch[1]!;
  const items: RoadmapItemRef[] = [];
  for (const objectMatch of body.matchAll(/\{([^{}]+)\}/g)) {
    const objectBody = objectMatch[1]!;
    const status = /status:\s*"(shipping-soon|planned|exploring)"/.exec(objectBody)?.[1] as RoadmapItemStatus | undefined;
    const issueRaw = /issue:\s*(\d+)/.exec(objectBody)?.[1];
    if (!status || !issueRaw) continue;
    items.push({ status, issue: Number(issueRaw) });
  }
  if (items.length === 0) throw new Error("ROADMAP_ITEMS contained no parseable { status, issue } entries");
  return items;
}

/**
 * Pure drift rule (#8390): fail only when the page presents the item as active/upcoming
 * (`shipping-soon` / `planned`) but GitHub says the issue is closed as completed.
 * `exploring` items are never flagged here — abandoned "later" ideas (e.g. NOT_PLANNED) and
 * finished exploring work are both content judgment calls outside this mechanical check.
 */
export function isStaleActiveRoadmapPresentation(input: {
  status: string;
  issueState: string;
  issueStateReason: string | null | undefined;
}): boolean {
  if (!ACTIVE_ROADMAP_STATUSES.has(input.status)) return false;
  if (input.issueState.toLowerCase() !== "closed") return false;
  return (input.issueStateReason ?? "").toUpperCase() === "COMPLETED";
}

export type StaleRoadmapItem = RoadmapItemRef & GithubIssueState;

export async function findStaleRoadmapItems({
  items,
  githubApi,
  owner,
  repo,
}: {
  items: RoadmapItemRef[];
  githubApi: GithubApi;
  owner: string;
  repo: string;
}): Promise<StaleRoadmapItem[]> {
  const stale: StaleRoadmapItem[] = [];
  for (const item of items) {
    const issue = await githubApi(`/repos/${owner}/${repo}/issues/${item.issue}`);
    const state = String(issue.state ?? "");
    const stateReason = issue.state_reason == null ? null : String(issue.state_reason);
    if (isStaleActiveRoadmapPresentation({ status: item.status, issueState: state, issueStateReason: stateReason })) {
      stale.push({ ...item, state, stateReason });
    }
  }
  return stale;
}

export function formatStaleRoadmapFailures(stale: StaleRoadmapItem[]): string[] {
  return stale.map(
    (item) =>
      `#${item.issue} (status=${item.status}): GitHub state=${item.state} stateReason=${item.stateReason ?? "null"} — still presented as active/upcoming on /roadmap while closed as completed`,
  );
}

export async function checkRoadmapIssueDrift({
  roadmapSourceText,
  githubApi,
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
}: {
  roadmapSourceText: string;
  githubApi: GithubApi;
  owner?: string;
  repo?: string;
}): Promise<string[]> {
  const items = parseRoadmapItems(roadmapSourceText);
  const stale = await findStaleRoadmapItems({ items, githubApi, owner, repo });
  return formatStaleRoadmapFailures(stale);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const sourcePath = join(root, DEFAULT_ROADMAP_SOURCE);
  const roadmapSourceText = readFileSync(sourcePath, "utf8");

  const repoEnv = process.env.GITHUB_REPOSITORY;
  const [owner, repo] = repoEnv?.includes("/") ? repoEnv.split("/") : [DEFAULT_OWNER, DEFAULT_REPO];
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN (or GH_TOKEN) is required for roadmap:drift-check");

  const failures = await checkRoadmapIssueDrift({
    roadmapSourceText,
    githubApi: makeGithubApi(token),
    owner: owner!,
    repo: repo!,
  });

  if (failures.length > 0) {
    console.error(`Roadmap issue-drift check found ${failures.length} stale active/upcoming item(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "Update ROADMAP_ITEMS in apps/loopover-ui/src/routes/roadmap.tsx so active columns only reference open (or not-yet-done) phase issues.",
    );
    process.exit(1);
  }

  console.log("Roadmap issue-drift check ok: no active/upcoming ROADMAP_ITEMS reference a completed closed issue.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
