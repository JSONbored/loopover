export type FreshnessIssue = {
  state: string;
  updatedAt?: string | null;
  createdAt?: string | null;
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickTimestamp(issue: FreshnessIssue): string | null {
  const updated = typeof issue.updatedAt === "string" ? issue.updatedAt.trim() : "";
  if (updated) return updated;
  const created = typeof issue.createdAt === "string" ? issue.createdAt.trim() : "";
  return created || null;
}

const STALE_AGE_DAYS = 9999;

function issueAgeDays(value: string | null, nowMs: number): number {
  if (!value) return STALE_AGE_DAYS;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return STALE_AGE_DAYS;
  return Math.floor((nowMs - parsed) / 86_400_000);
}

/**
 * Compute a [0.05, 1] freshness factor from open issue timestamps, mirroring
 * `opportunityFreshnessFactor` in `src/signals/reward-risk.ts` with an injected clock so the miner engine
 * stays pure and testable.
 */
export function computeOpportunityFreshness(
  issues: readonly FreshnessIssue[],
  nowMs: number,
): number {
  /* v8 ignore next -- Caller supplies a finite epoch; non-finite clocks degrade to zero freshness. */
  if (!Number.isFinite(nowMs)) return 0;
  const openIssues = issues.filter((issue) => issue?.state?.toLowerCase() === "open");
  if (openIssues.length === 0) return 0;
  const mostRecentAgeDays = Math.min(
    ...openIssues.map((issue) => issueAgeDays(pickTimestamp(issue), nowMs)),
  );
  return round4(clamp(Math.exp(-mostRecentAgeDays / 20), 0.05, 1));
}
