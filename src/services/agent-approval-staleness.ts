/**
 * #9032 — the approval queue's own escape hatch.
 *
 * A staged `auto_with_approval` action notifies the maintainer exactly ONCE, on first staging: stageForApproval
 * returns early on `!created`, and the badge delivery is dedup-keyed per (PR, actionClass) forever. A maintainer
 * who misses that single badge gets no further prompt, and the row waits indefinitely — the same absorbing-state
 * shape as a permanently merge-blocked PR (#9012) or a stranded pending-closure flag (#9031): the system stops
 * making progress and nothing says so.
 *
 * This module is the pure decision half. Given when a row was staged and the current clock, it says whether the
 * row is due for a reminder, due to expire, or should be left alone. The reminder is BUCKETED (one per interval)
 * rather than "notify every pass", because the sweep that drives this runs every couple of minutes: the bucket
 * index goes into the notification dedup key, so the existing insert-if-absent dedup turns hundreds of passes
 * into exactly one badge per interval, with no extra state to persist.
 *
 * Reminders are bounded on purpose. An action nobody has accepted after a week is not a notification problem —
 * the PR has almost certainly moved on — so the row expires instead of nagging forever. Expiry is NOT a rejection:
 * it records that consent was never given, so nothing executes, and re-planning the same action on a later pass
 * stages a fresh row with a fresh notification.
 */

/** How long a pending row waits between reminder badges. A maintainer queue is checked in days, not minutes. */
export const APPROVAL_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long a pending row may sit before it expires unexecuted. Six reminders precede it (days 1–6). */
export const APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type ApprovalQueueMaintenance =
  | { kind: "none" }
  /** `bucket` is the reminder's 1-based index (day 1, day 2, …). It goes into the notification dedup key, so the
   *  same bucket re-derived on a later pass within the same interval dedups to a single delivery. */
  | { kind: "remind"; bucket: number }
  | { kind: "expire" };

/**
 * Decide what a pending approval row is due for. Pure.
 *
 * An unparseable or future `createdAt` yields `none`: a bad timestamp must never be the thing that expires a
 * real staged action a maintainer is still expecting to accept. Failing quiet is correct here — the row simply
 * keeps its pre-#9032 "waits forever" behavior rather than being destroyed by a clock artifact.
 */
export function planApprovalQueueMaintenance(createdAt: string, nowMs: number): ApprovalQueueMaintenance {
  const staged = Date.parse(createdAt);
  if (!Number.isFinite(staged)) return { kind: "none" };
  const age = nowMs - staged;
  if (age >= APPROVAL_EXPIRY_MS) return { kind: "expire" };
  const bucket = Math.floor(age / APPROVAL_REMINDER_INTERVAL_MS);
  return bucket >= 1 ? { kind: "remind", bucket } : { kind: "none" };
}
