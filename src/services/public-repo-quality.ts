import type { PullRequestRecord } from "../types";

// Public-safe repository quality metrics for the unauthenticated README badge (#541).
//
// HARD whitelist: this module derives ONLY three coarse, repo-level, public-safe metrics from cached
// pull-request records — median time-to-merge, the share of non-slop merged contributions, and a coarse
// queue-health level. It never reads or exposes contributor-level data, reward/trust values, or private
// scoreability context. Pure and deterministic (clock injected) so the badge surface stays auditable.

export type QueueHealthLevel = "low" | "medium" | "high" | "critical";

export type PublicRepoQuality = {
  /** Median hours from PR open to merge across known merged PRs. `null` when none are known. */
  medianTimeToMergeHours: number | null;
  /** Share (0-100) of *assessed* merged PRs whose slop band is clean/low. `null` when none assessed. */
  realContributionPct: number | null;
  queueHealthLevel: QueueHealthLevel;
  /** Counts only — included for transparency, never contributor-level detail. */
  mergedSampleSize: number;
  assessedSampleSize: number;
};

const STALE_OPEN_PR_DAYS = 14;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const NON_SLOP_BANDS: ReadonlySet<string> = new Set(["clean", "low"]);

export function buildPublicRepoQuality(pullRequests: PullRequestRecord[], now: number = Date.now()): PublicRepoQuality {
  const merged = pullRequests.filter(isMergedPullRequest);
  const mergeDurations = merged
    .map(mergeDurationHours)
    .filter((hours): hours is number => hours !== null);
  const assessed = merged.filter((pr) => typeof pr.slopBand === "string" && pr.slopBand.trim().length > 0);
  const nonSlop = assessed.filter((pr) => NON_SLOP_BANDS.has((pr.slopBand as string).toLowerCase()));

  return {
    medianTimeToMergeHours: mergeDurations.length > 0 ? Math.round(median(mergeDurations)) : null,
    realContributionPct: assessed.length > 0 ? Math.round((nonSlop.length / assessed.length) * 100) : null,
    queueHealthLevel: resolveQueueHealthLevel(pullRequests, now),
    mergedSampleSize: merged.length,
    assessedSampleSize: assessed.length,
  };
}

function isMergedPullRequest(pr: PullRequestRecord): boolean {
  return Boolean(pr.mergedAt) || pr.state.toLowerCase() === "merged";
}

function mergeDurationHours(pr: PullRequestRecord): number | null {
  if (!pr.mergedAt || !pr.createdAt) return null;
  const merged = Date.parse(pr.mergedAt);
  const created = Date.parse(pr.createdAt);
  if (!Number.isFinite(merged) || !Number.isFinite(created) || merged < created) return null;
  return (merged - created) / MS_PER_HOUR;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return sorted[mid] as number;
}

// Coarse, public-safe queue level derived only from open-PR volume and staleness — deliberately simpler
// than the internal QueueHealth signal so no private-derived value reaches this unauthenticated surface.
function resolveQueueHealthLevel(pullRequests: PullRequestRecord[], now: number): QueueHealthLevel {
  const open = pullRequests.filter((pr) => pr.state.toLowerCase() === "open");
  const openCount = open.length;
  const staleCount = open.filter((pr) => {
    const stamp = Date.parse(pr.updatedAt ?? pr.createdAt ?? "");
    return Number.isFinite(stamp) && (now - stamp) / MS_PER_DAY >= STALE_OPEN_PR_DAYS;
  }).length;

  if (openCount >= 50 || staleCount >= 20) return "critical";
  if (openCount >= 20 || staleCount >= 8) return "high";
  if (openCount >= 5 || staleCount >= 2) return "medium";
  return "low";
}
