import { bumpPullRequestLowConfidenceHold, recordAuditEvent } from "../db/repositories";

/**
 * #9034 — the bound on AI-review confidence parking.
 *
 * `resolveAiReviewLowConfidenceHold` (src/rules/advisory.ts) converts a would-be one-shot close into an OPEN
 * hold when the blocking AI finding sits below the repo's close-confidence floor. That is the right call while
 * the verdict is genuinely uncertain: an uncertain close is the expensive kind of mistake, and a human should
 * see it. What was missing is any notion of "again": nothing counted how many times the SAME PR re-entered the
 * hold, so a PR shaped to keep drawing sub-floor blockers survived indefinitely, cost a maintainer on every
 * roll, and could be walked toward a clean merge from there. It was an absorbing state with no escape, the same
 * shape as a permanently merge-blocked PR (#9012) or an unattended approval row (#9032).
 *
 * Deliberately its own module rather than a constant in advisory.ts: advisory.ts is one half of the
 * hand-maintained gate-decision twin pair enforced by scripts/check-engine-parity.ts, and this cap has no engine
 * counterpart to mirror — the engine's gate-advisory.ts carries no low-confidence hold resolver at all. Putting
 * it here keeps the twin untouched instead of forcing a no-op engine release to satisfy the parity guard, and
 * matches how MERGE_RETRY_CAP already lives beside its own policy (src/services/merge-failure.ts) rather than in
 * the shared advisory module.
 */

/**
 * How many times one PR may be parked in the low-confidence hold before the hold stops applying and the close it
 * was suppressing fires.
 *
 * Past the cap the sub-floor finding has been reproduced by several independent passes, which is itself the
 * corroboration a single pass's confidence number lacked — so the close is no longer the uncertain call the hold
 * exists to protect against. Three is deliberately generous next to MERGE_RETRY_CAP: this budget is spent by
 * human-visible holds a maintainer could resolve at any point, not by silent retries.
 */
export const AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP = 3;

/** Whether a PR has exhausted its low-confidence hold budget. `holds` is the running per-PR count from
 *  bumpPullRequestLowConfidenceHold, which advances once per distinct head — so this counts ROLLS, not the
 *  several re-gate passes a single commit attracts. Pure. */
export function isLowConfidenceHoldCapped(holds: number): boolean {
  return holds > AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP;
}

/**
 * Apply the cap to a low-confidence hold the gate just resolved (#9034). Returns the hold unchanged while the
 * PR still has budget, or `undefined` once it does not — which lets the close the hold was suppressing fire.
 *
 * The counting lives here rather than at the re-gate call site so the "how many rolls has this PR spent"
 * question has exactly one answer in the codebase, and so the capped path is directly testable: reaching that
 * point through the pipeline needs a live gate evaluation, settings, GitHub state and a planner run — far too
 * much machinery to stand up just to observe one boolean.
 *
 * Generic in the hold's shape because it neither reads nor changes it beyond quoting the reason into the audit
 * trail — the hold is advisory.ts's to define.
 */
export async function applyLowConfidenceHoldCap<T extends { reason: string }>(
  env: Env,
  target: { repoFullName: string; pullNumber: number; headSha: string | null | undefined },
  hold: T | undefined,
): Promise<T | undefined> {
  if (hold === undefined) return undefined;
  const holds = await bumpPullRequestLowConfidenceHold(env, target.repoFullName, target.pullNumber, target.headSha);
  if (!isLowConfidenceHoldCapped(holds)) return hold;
  await recordAuditEvent(env, {
    eventType: "agent.low_confidence_hold.capped",
    actor: "loopover",
    targetKey: `${target.repoFullName}#${target.pullNumber}`,
    outcome: "denied",
    detail: `low-confidence hold cap reached (${holds} > ${AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP}) — the suppressed close now proceeds`,
    metadata: { repoFullName: target.repoFullName, pullNumber: target.pullNumber, holds, cap: AI_REVIEW_LOW_CONFIDENCE_HOLD_CAP, reason: hold.reason },
  }).catch(
    /* v8 ignore next -- best-effort: losing the audit row must never resurrect the hold the cap just lifted. */
    () => undefined,
  );
  return undefined;
}
