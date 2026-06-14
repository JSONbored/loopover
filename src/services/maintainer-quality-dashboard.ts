import { buildCollisionReport, buildQueueHealth, type QueueHealth } from "../signals/engine";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../types";

// ─── Maintainer quality dashboard (#557) ─────────────────────────────────────────────────────────
// The non-visual data service behind the maintainer quality dashboard (#539 renders it). Shapes
// ALREADY-cached repo data (issues + PRs) into queue-health bands, duplicate/collision trends, quality
// signals, and top contributors by QUALITY BAND. Public-safe: contributor quality is a BAND, never a
// raw credibility/reward number; only observable counts (open PRs, duplicate clusters) are exposed.

export type MaintainerQualityRepoInput = {
  repo: RepositoryRecord;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
};

export type ContributorQualityBand = "strong" | "developing" | "early";

export type MaintainerRepoQuality = {
  repoFullName: string;
  /** Queue-burden band (low/medium/high/critical) — the raw burden score stays private. */
  queueBand: QueueHealth["level"];
  openPrCount: number;
  duplicateClusters: number;
  highRiskDuplicates: number;
};

export type MaintainerTopContributor = {
  login: string;
  /** Deterministic quality band from the share of the author's open PRs that are "clean" (linked to a
   *  REAL cached issue and not in a high-risk duplicate cluster). A band, never a raw quality/credibility
   *  number. "strong" additionally requires a minimum PR volume so one PR can't game the ranking. */
  band: ContributorQualityBand;
  openPrCount: number;
};

export type MaintainerQualityDashboard = {
  generatedAt: string;
  /** True when the underlying cached data is older than the freshness target. */
  stale: boolean;
  /** Total scoped repos vs how many were actually shaped (the per-load build is capped). `truncated`
   *  flags when the maintainer has more repos than were summarized, so the counts read honestly. */
  repoTotal: number;
  shapedRepoCount: number;
  truncated: boolean;
  repoQuality: MaintainerRepoQuality[];
  topContributors: MaintainerTopContributor[];
  /** Aggregate counts across the SHAPED repos' open PRs — observable facts, not private scores. */
  qualitySignals: { openPrs: number; duplicatePrRisk: number; missingLinkedIssue: number };
  summary: string;
};

const MAX_TOP_CONTRIBUTORS = 10;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
// A single clean PR is not enough signal to call a contributor "strong" — require a minimum volume so the
// band can't be gamed by one PR (and "clean" itself requires a link to a REAL cached issue; see below).
const MIN_PRS_FOR_STRONG = 2;

/** Cheap freshness check: the dashboard shapes cached data, so it's "stale" when the most recent repo
 *  sync among the scoped repos is older than the target (or there is no completed sync at all). With no
 *  scoped repos there is nothing to be stale about. */
export function isMaintainerQualityDataStale(args: { lastCompletedAts: Array<string | null | undefined>; repoCount: number; nowMs: number; maxAgeMs?: number }): boolean {
  if (args.repoCount === 0) return false;
  const newest = args.lastCompletedAts.reduce((best, value) => {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? Math.max(best, parsed) : best;
  }, 0);
  return newest === 0 || args.nowMs - newest > (args.maxAgeMs ?? DEFAULT_STALE_MS);
}

function contributorQualityBand(cleanRatio: number, openPrCount: number): ContributorQualityBand {
  if (cleanRatio >= 0.8 && openPrCount >= MIN_PRS_FOR_STRONG) return "strong";
  if (cleanRatio >= 0.4) return "developing";
  return "early";
}

export function buildMaintainerQualityDashboard(args: { repos: MaintainerQualityRepoInput[]; generatedAt: string; stale?: boolean; repoTotal?: number }): MaintainerQualityDashboard {
  const repoQuality: MaintainerRepoQuality[] = [];
  const contributorTotals = new Map<string, { open: number; clean: number }>();
  let openPrs = 0;
  let duplicatePrRisk = 0;
  let missingLinkedIssue = 0;

  for (const { repo, issues, pullRequests } of args.repos) {
    const openPullRequests = pullRequests.filter((pr) => pr.state === "open");
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
    // "Duplicate PR risk" means a PR overlaps ANOTHER PR — a high-risk cluster with 2+ pull requests.
    // A cluster of an issue + its single correctly-linking PR is NOT a duplicate (that's healthy linkage),
    // so it must not count against the contributor's clean ratio.
    const highRiskPrNumbers = new Set(
      collisions.clusters
        .filter((cluster) => cluster.risk === "high" && cluster.items.filter((item) => item.type === "pull_request").length >= 2)
        .flatMap((cluster) => cluster.items.filter((item) => item.type === "pull_request").map((item) => item.number)),
    );
    // A PR only counts as "linked" for the quality band when it references a REAL cached issue — a body
    // that says "Closes #999999" (nonexistent) must not inflate the contributor's clean ratio.
    const realIssueNumbers = new Set(issues.map((issue) => issue.number));

    repoQuality.push({
      repoFullName: repo.fullName,
      queueBand: queueHealth.level,
      openPrCount: openPullRequests.length,
      duplicateClusters: collisions.summary.clusterCount,
      highRiskDuplicates: collisions.summary.highRiskCount,
    });

    for (const pr of openPullRequests) {
      openPrs += 1;
      const inHighRiskCluster = highRiskPrNumbers.has(pr.number);
      if (pr.linkedIssues.length === 0) missingLinkedIssue += 1;
      if (inHighRiskCluster) duplicatePrRisk += 1;
      const linkedToRealIssue = pr.linkedIssues.some((number) => realIssueNumbers.has(number));
      const author = pr.authorLogin ?? "unknown";
      const tally = contributorTotals.get(author) ?? { open: 0, clean: 0 };
      tally.open += 1;
      if (linkedToRealIssue && !inHighRiskCluster) tally.clean += 1;
      contributorTotals.set(author, tally);
    }
  }

  const topContributors: MaintainerTopContributor[] = [...contributorTotals.entries()]
    // Every tallied contributor has at least one open PR, so `open` is always >= 1 here.
    .map(([login, tally]) => ({ login, band: contributorQualityBand(tally.clean / tally.open, tally.open), openPrCount: tally.open }))
    .sort((left, right) => right.openPrCount - left.openPrCount || left.login.localeCompare(right.login))
    .slice(0, MAX_TOP_CONTRIBUTORS);

  const shapedRepoCount = args.repos.length;
  const repoTotal = Math.max(args.repoTotal ?? shapedRepoCount, shapedRepoCount);
  const truncated = repoTotal > shapedRepoCount;
  const summary = `Shaped ${shapedRepoCount} of ${repoTotal} scoped repo(s); ${openPrs} open PR(s); ${duplicatePrRisk} in a high-risk duplicate cluster; ${missingLinkedIssue} without a linked issue.`;

  return {
    generatedAt: args.generatedAt,
    stale: args.stale ?? false,
    repoTotal,
    shapedRepoCount,
    truncated,
    repoQuality,
    topContributors,
    qualitySignals: { openPrs, duplicatePrRisk, missingLinkedIssue },
    summary,
  };
}
