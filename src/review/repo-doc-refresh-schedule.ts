// Scheduled-refresh due-check (#3003, part of the repo-doc generation roadmap #2993). A tiny, pure predicate:
// has enough time passed since the last refresh ATTEMPT for this repo to warrant another one? This is purely a
// rate-limiting knob on the SCHEDULED sweep -- it never affects correctness, since openRepoDocPullRequest's own
// no-change short-circuit (#3004) already prevents a redundant PR regardless of how often it's invoked. Keeping
// this separate from the sweep's persistence/enumeration plumbing makes the "due" decision itself trivially
// unit-testable without any D1/queue setup.

/**
 * Whether a scheduled repo-doc refresh is due. `lastAttemptedAt` is `null` when this repo has never been
 * attempted (or the marker was lost) -- always due in that case, so a newly-enabled repo isn't stuck waiting a
 * full interval before its first PR. Otherwise due once `refreshIntervalDays` have elapsed since the last
 * attempt, inclusive of the boundary (exactly `refreshIntervalDays` later counts as due).
 */
export function isRepoDocRefreshDue(lastAttemptedAt: string | null, refreshIntervalDays: number, now: string): boolean {
  if (lastAttemptedAt === null) return true;
  const lastAttemptedMs = Date.parse(lastAttemptedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(lastAttemptedMs) || !Number.isFinite(nowMs)) return true;
  const intervalMs = refreshIntervalDays * 24 * 60 * 60 * 1000;
  return nowMs - lastAttemptedMs >= intervalMs;
}
