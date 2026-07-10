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

import { getRepository } from "../db/repositories";
import { isConfirmedOfficialMiner } from "../gittensor/miner-detection-cache";
import {
  getSubmitterCadence,
  getSubmitterReputation,
  getSubmitterReputationAcrossInstall,
  isMachinePacedCadence,
  recordSubmissionOutcome,
  type ReputationConfig,
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
const REPUTATION_BURST_SUBMISSION_FLOOR = 8;
const REPUTATION_BURST_MAX_MERGED = 1;

/**
 * Decide whether this submitter's reputation should DOWNGRADE the review to deterministic-only (skip the AI
 * neurons). Pure + total over the {@link SubmitterStats} the ported module returns:
 *   • `signal === "low"` — the windowed, quality-weighted reputation signal (genuine recent abuse / serial
 *     quality-failure). Live once the review_targets source lands; "neutral" until then (fail-safe).
 *   • a BURST pattern — many recent submissions, almost none merged (the #submitter-burst anti-abuse signal).
 * A submitter with little history, an established merge record, or a non-low windowed signal outside the
 * burst shape is NEVER downgraded (returns false).
 */
export function shouldDowngradeToDeterministic(stats: SubmitterStats): boolean {
  if (stats.signal === "low") return true;
  const burst = stats.submissions >= REPUTATION_BURST_SUBMISSION_FLOOR && stats.merged < REPUTATION_BURST_MAX_MERGED;
  if (burst) return true;
  // `submitter_stats` is operator/statistics data and can be influenced by ordinary PR closes, so the
  // all-time close-rate aggregate must not independently skip AI review for established submitters.
  return false;
}

/**
 * Resolve the EFFECTIVE reputation signal for a submitter (#4513): the per-repo signal from
 * {@link getSubmitterReputation}, additionally widened to an install-wide view for a CONFIRMED official
 * Gittensor miner — but ONLY when the per-repo signal alone doesn't already justify caution, so an ordinary
 * (non-miner) submitter or one already flagged per-repo pays no extra lookup. Closes a real blind spot: a
 * fleet identity spreading thin across many repos in one install never accumulates same-repo sample density,
 * so the per-repo-only signal stays permanently "neutral" for it even while it burns full AI-review spend on
 * every submission. Fail-safe throughout: an identity-check or install-wide-read failure just keeps the
 * per-repo result, never throws, never upgrades a signal the per-repo read didn't already produce.
 */
export async function getEffectiveSubmitterReputation(
  env: Env,
  args: { repoFullName: string; submitter: string | null | undefined },
  cfg?: ReputationConfig,
): Promise<SubmitterStats> {
  const perRepo = await getSubmitterReputation(env, args.repoFullName, args.submitter ?? undefined, cfg);
  if (shouldDowngradeToDeterministic(perRepo)) return perRepo;
  const submitter = args.submitter?.trim();
  if (!submitter) return perRepo;
  const isMiner = await isConfirmedOfficialMiner(env, submitter).catch(() => false);
  if (!isMiner) return perRepo;
  const repo = await getRepository(env, args.repoFullName).catch(() => null);
  if (!repo?.installationId) return perRepo;
  // getSubmitterReputationAcrossInstall already degrades to neutral internally on any read failure (mirrors
  // getSubmitterReputation) -- nothing to catch here.
  const acrossInstall = await getSubmitterReputationAcrossInstall(env, repo.installationId, submitter, cfg);
  return shouldDowngradeToDeterministic(acrossInstall) ? acrossInstall : perRepo;
}

/**
 * Flag-gated, fail-safe: read the submitter's INTERNAL reputation (install-wide-aware for a confirmed miner,
 * see {@link getEffectiveSubmitterReputation}) and report whether the AI-spend gate should downgrade to a
 * deterministic-only review. When the flag is OFF this returns false IMMEDIATELY — no DB read — so the
 * AI-spend gate is byte-identical to today. `project` namespaces the per-(project, submitter) rows
 * (gittensory uses the repo full name). NEVER throws: the ported module already degrades to neutral on error.
 *
 * Also checks submission CADENCE (#4514): every quality-based signal above only tells you whether a
 * submitter's outcomes were good or bad, never how FAST they arrived -- a fast, well-formed, strategically
 * low-value submitter clears every quality bar while still being invisible to those signals. A cadence read
 * this tight, sustained across this many consecutive submissions, is not a pattern any human contributor
 * plausibly sustains, independent of whether the submissions themselves look fine.
 */
export async function shouldSkipAiForReputation(
  env: Env,
  args: { project: string; submitter: string | null | undefined },
): Promise<boolean> {
  if (!isReputationEnabled(env)) return false;
  // Combines both extensions to the base per-repo signal: install-wide widening for a confirmed miner
  // (#4513, getEffectiveSubmitterReputation) first, then the cadence check (#4514) as an independent
  // second signal -- neither subsumes the other, so both must run, not just whichever merged more recently.
  const stats = await getEffectiveSubmitterReputation(env, { repoFullName: args.project, submitter: args.submitter });
  if (shouldDowngradeToDeterministic(stats)) return true;
  const cadence = await getSubmitterCadence(env, args.project, args.submitter ?? undefined);
  return isMachinePacedCadence(cadence);
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
