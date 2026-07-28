// AI-review verdict-flip escalation (#9016, security) — PURE state machine.
//
// The AI reviewer is non-deterministic even at temperature 0. Without a bound, a contributor can force
// fresh re-rolls (a no-op recommit that invalidates the head-SHA cache key, or a same-head retry once the
// non-cacheable-result cooldown lapses) until a lucky CLEAN roll auto-merges a PR other rolls flagged as
// blocked — verdict-shopping against a randomized judge. This tracks the last FRESH (non-cache-hit)
// verdict's defect/clean state per PR and counts how many times it has FLIPPED; once flips clear a
// threshold, the caller holds the gate for a human instead of trusting the newest roll.
import { AI_JUDGMENT_BLOCKER_CODES } from "../rules/advisory";

/** Flips this large signal a genuine, sustained oscillation rather than reviewer noise on the first retry
 *  — the exploit needs several rolls to land a lucky one, so the bound should not fire on ordinary review
 *  churn (one legitimate re-review after a real fix is not abuse). */
export const VERDICT_FLIP_ESCALATION_THRESHOLD = 3;

export type VerdictFlipState = {
  lastHadDefect: boolean;
  flipCount: number;
  /** #9483: the content fingerprint the prior fresh verdict was produced against. Null for rows written
   *  before this was tracked (migration 0196) — a null can never match, so the first verdict after the
   *  migration resets rather than escalating, which is the fail-open direction. */
  lastFingerprint?: string | null | undefined;
};
export type VerdictFlipResult = VerdictFlipState & { escalate: boolean };

/**
 * Advance the flip state with one FRESH verdict (never call this for a cache-hit reuse of a prior verdict —
 * reusing a result is not a new independent roll). PURE. A first observation for a PR never escalates
 * (there is nothing to flip against yet). A flip is a CHANGE from the immediately prior fresh verdict;
 * repeating the same verdict does not add to the count — a PR that is consistently blocked, or
 * consistently clean, across many honest re-reviews is not the abuse pattern this guards against, only
 * genuine oscillation is.
 */
export function nextVerdictFlipState(
  prior: VerdictFlipState | null,
  hadDefect: boolean,
  fingerprint?: string | null | undefined,
): VerdictFlipResult {
  if (prior === null) return { lastHadDefect: hadDefect, flipCount: 0, lastFingerprint: fingerprint ?? null, escalate: false };
  // #9483: only a re-roll against UNCHANGED content is the abuse pattern this guards against. The exploit is
  // re-rolling a non-deterministic reviewer over the same diff until a lucky clean roll lands; an honest
  // contributor iterating on real feedback produced an identical signal, so defect -> fix -> clean -> new
  // issue -> fixed (two honest cycles) hit the threshold. Worse, flipCount never decreased, so the PR then
  // escalated on every later fresh verdict forever -- an absorbing state whose own advice to the contributor
  // ("push a substantive fix so the next review reflects real content change") could not clear it, because a
  // substantive fix produced a fresh verdict that re-escalated. A changed fingerprint resets the count.
  const sameContent = fingerprint != null && prior.lastFingerprint != null && prior.lastFingerprint === fingerprint;
  if (!sameContent) return { lastHadDefect: hadDefect, flipCount: 0, lastFingerprint: fingerprint ?? null, escalate: false };
  const flipCount = prior.lastHadDefect === hadDefect ? prior.flipCount : prior.flipCount + 1;
  return {
    lastHadDefect: hadDefect,
    flipCount,
    lastFingerprint: fingerprint ?? null,
    escalate: flipCount >= VERDICT_FLIP_ESCALATION_THRESHOLD,
  };
}

/** Whether a fresh review's findings carry a blocking AI-judgment defect (ai_consensus_defect /
 *  ai_review_split) — the boolean this guard tracks flips of. PURE. */
export function findingsHadAiDefect(findings: ReadonlyArray<{ code: string }>): boolean {
  return findings.some((finding) => AI_JUDGMENT_BLOCKER_CODES.has(finding.code));
}
