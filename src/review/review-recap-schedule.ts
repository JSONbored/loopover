// Scheduled-recap due-check (#1963). Pure predicate: has enough time passed since the last recap ATTEMPT
// for this repo to warrant another one? Mirrors repo-doc-refresh-schedule.ts's isRepoDocRefreshDue — a
// rate-limiting knob on the scheduled sweep only, not a correctness gate.

/** Whether a scheduled maintainer review recap is due. `lastAttemptedAt` is `null` when never attempted — always
 *  due so a newly-enabled repo gets its first recap on the next sweep without waiting a full cadence. */
export function isReviewRecapDue(lastAttemptedAt: string | null, cadenceDays: number, now: string): boolean {
  if (lastAttemptedAt === null) return true;
  const lastAttemptedMs = Date.parse(lastAttemptedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(lastAttemptedMs) || !Number.isFinite(nowMs)) return true;
  const intervalMs = cadenceDays * 24 * 60 * 60 * 1000;
  return nowMs - lastAttemptedMs >= intervalMs;
}
