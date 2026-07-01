// Convergence (reputation) wiring: feeds the ported, INTERNAL-only submitter-reputation signal
// (`./submitter-reputation`) into gittensory's review path as an anti-abuse extension of the existing
// AI-spend gate. A new / burst / low-reputation submitter is downgraded to a DETERMINISTIC-ONLY review
// (the AI neurons are skipped); a good-reputation submitter proceeds normally. After the gate decides, the
// terminal outcome is recorded so the signal stays current.
//
// Single env switch: GITTENSORY_REVIEW_REPUTATION. Default OFF (unset/"false") — when OFF every helper here is an
// immediate no-op: no reputation is read, nothing is recorded, and the AI-spend gate takes no new branch, so
// the path is byte-identical to today. Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same
// as isSafetyEnabled / isGroundingEnabled / isEnabled).
//
// STRICTLY INTERNAL: the reputation NEVER appears in any public comment, label, or check-run. It only routes
// the AI-spend decision (private, server-side) and writes the private submitter_stats table. Fully fail-safe:
// the ported module degrades to "neutral" / no-op on any DB error, so this never throws into the gate.

import {
  getSubmitterReputation,
  recordSubmissionOutcome,
  type SubmissionOutcome,
  type SubmitterStats,
} from "./submitter-reputation";

/** True when the reputation signal is enabled. Flag-OFF (default) → every helper below is a no-op. */
export function isReputationEnabled(env: { GITTENSORY_REVIEW_REPUTATION?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_REPUTATION ?? "");
}

// ── Anti-abuse thresholds. GENERIC mechanism (not the gameable secret — they don't reveal any review
// DIRECTION), so the defaults are committed. A submitter with a clean / sparse history is NEVER downgraded;
// only a CLEAR low-reputation or burst pattern skips the (paid) AI neurons. ──
//
// burstFloor: a submitter who has flooded the project with at least this many submissions while landing
//   almost none of them is treated as a burst abuser (the #submitter-burst anti-abuse pattern).
// burstMaxMerged: …and has merged fewer than this many (so a high-volume GOOD contributor is never caught).
// closeRateFloor: an established submitter (>= burstFloor submissions) whose close-rate is at/above this is
//   low-reputation regardless of the windowed signal (the all-time aggregate backstop).
const REPUTATION_BURST_SUBMISSION_FLOOR = 8;
const REPUTATION_BURST_MAX_MERGED = 1;
const REPUTATION_CLOSE_RATE_FLOOR = 0.85;

/**
 * Decide whether this submitter's reputation should DOWNGRADE the review to deterministic-only (skip the AI
 * neurons). Pure + total over the {@link SubmitterStats} the ported module returns:
 *   • `signal === "low"` — the windowed, quality-weighted reputation signal (genuine recent abuse / serial
 *     quality-failure). Live once the review_targets source lands; "neutral" until then (fail-safe).
 *   • a BURST pattern — many recent submissions, almost none merged (the #submitter-burst anti-abuse signal).
 *   • a high all-time close-rate on an established submitter — the aggregate backstop.
 * A submitter with little history, or a healthy merge record, is NEVER downgraded (returns false).
 */
export function shouldDowngradeToDeterministic(stats: SubmitterStats): boolean {
  if (stats.signal === "low") return true;
  const burst = stats.submissions >= REPUTATION_BURST_SUBMISSION_FLOOR && stats.merged < REPUTATION_BURST_MAX_MERGED;
  if (burst) return true;
  // The all-time close-rate backstop is INDEPENDENT of the burst pattern (see closeRateFloor above): an
  // established submitter whose close-rate is at/above the floor is low-reputation regardless of a few merges.
  // The prior extra `&& merged < REPUTATION_BURST_MAX_MERGED` made this a strict subset of the burst check
  // above (dead code), so an established submitter with a high close-rate but ≥1 merge was never downgraded.
  // `closeRate = closed/(merged+closed)`, so `closeRate >= floor` already means the merge record is not
  // healthy — consistent with "a healthy merge record is NEVER downgraded".
  if (stats.submissions >= REPUTATION_BURST_SUBMISSION_FLOOR && stats.closeRate >= REPUTATION_CLOSE_RATE_FLOOR) return true;
  return false;
}

/**
 * Flag-gated, fail-safe: read the submitter's INTERNAL reputation and report whether the AI-spend gate should
 * downgrade to a deterministic-only review. When the flag is OFF this returns false IMMEDIATELY — no DB read —
 * so the AI-spend gate is byte-identical to today. `project` namespaces the per-(project, submitter) rows
 * (gittensory uses the repo full name). NEVER throws: the ported module already degrades to neutral on error.
 */
export async function shouldSkipAiForReputation(
  env: Env,
  args: { project: string; submitter: string | null | undefined },
): Promise<boolean> {
  if (!isReputationEnabled(env)) return false;
  const stats = await getSubmitterReputation(env, args.project, args.submitter ?? undefined);
  return shouldDowngradeToDeterministic(stats);
}

/**
 * Flag-gated, fail-safe: record this submitter's terminal review outcome so the reputation stays current.
 * Flag-OFF (default) → an immediate no-op (nothing is recorded). The ported `recordSubmissionOutcome` is
 * itself a no-op on a missing submitter and swallows any DB error, so this never throws into the caller.
 */
export async function recordReputationOutcome(
  env: Env,
  args: { project: string; submitter: string | null | undefined; outcome: SubmissionOutcome },
): Promise<void> {
  if (!isReputationEnabled(env)) return;
  await recordSubmissionOutcome(env, args.project, args.submitter ?? undefined, args.outcome);
}
