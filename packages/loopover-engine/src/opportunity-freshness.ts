export type FreshnessIssue = {
  state: string;
  updatedAt?: string | null | undefined;
  createdAt?: string | null | undefined;
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isParseableTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function pickTimestamp(issue: FreshnessIssue): string | null {
  const updated = typeof issue.updatedAt === "string" ? issue.updatedAt.trim() : "";
  if (updated && isParseableTimestamp(updated)) return updated;

  const created = typeof issue.createdAt === "string" ? issue.createdAt.trim() : "";
  if (created && isParseableTimestamp(created)) return created;

  return null;
}

function issueAgeDays(value: string | null, nowMs: number): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.floor((nowMs - parsed) / 86_400_000);
}

function isOpenIssue(issue: FreshnessIssue): boolean {
  return typeof issue?.state === "string" && issue.state.trim().toLowerCase() === "open";
}

/* v8 ignore start -- Test-only export surface for branch coverage. */
export const opportunityFreshnessInternals = {
  pickTimestamp,
  issueAgeDays,
};
/* v8 ignore stop */

/**
 * Compute an open-issue freshness factor from issue timestamps, with an injected clock so the miner engine
 * stays pure and testable. Returns `0` as a sentinel for "no measurable freshness signal" — either there are
 * no open issues, or `nowMs` is non-finite — and otherwise a value in `[0.05, 1]`. `0` is meaningfully distinct
 * from `0.05` (measured but maximally stale): in the multiplicative ranker score they differ 20x, so a caller
 * must not treat a `0` as merely "very stale". `opportunityFreshnessFactor` in
 * `packages/loopover-engine/src/reward-risk.ts` delegates to this function (#8011) — this module is the
 * canonical implementation, not a mirror of it.
 */
export function computeOpportunityFreshness(
  issues: readonly FreshnessIssue[],
  nowMs: number,
): number {
  if (!Number.isFinite(nowMs)) return 0;
  const openIssues = issues.filter(isOpenIssue);
  if (openIssues.length === 0) return 0;

  let mostRecentAgeDays = Number.POSITIVE_INFINITY;
  for (const issue of openIssues) {
    const ageDays = issueAgeDays(pickTimestamp(issue), nowMs);
    if (ageDays < mostRecentAgeDays) mostRecentAgeDays = ageDays;
  }

  return round4(clamp(Math.exp(-mostRecentAgeDays / 20), 0.05, 1));
}
