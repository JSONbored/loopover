// Opportunity ranker (#2302). The core Phase-1 miner-discovery ranker: it composes five already-normalized,
// deterministic signals into a single ordinal score used to sort a cross-repo candidate-issue list, so the
// find-opportunities MCP tool (hosted `loopover_find_opportunities` / stdio `loopover_find_opportunities`)
// has something deterministic to sort by.
//
// This module is PURE — no IO, no Date, no random — so identical inputs always produce identical order, matching
// the house convention in src/signals/duplicate-winner.ts. Every input is clamped to [0, 1] before use; the sole
// exception is a NON-finite `dupRisk` (NaN/±Infinity), which can't be clamped and fails closed to max risk so a
// broken contention signal never looks safe. Either way a malformed signal degrades the score toward 0 rather than
// inverting or blowing up the product.

/** The five 0-1 normalized signals for one candidate opportunity. */
export type OpportunityRankInput = {
  /** Expected reward if the work is won (score / label-multiplier potential). */
  potential: number;
  /** How achievable the issue is for the miner. */
  feasibility: number;
  /** Fit with the miner's preferred lanes. */
  laneFit: number;
  /** How recently actionable the opportunity is (decays as it ages). */
  freshness: number;
  /** Risk the work is already claimed / contested; higher means more likely a wasted attempt. */
  dupRisk: number;
};

/** Clamp a positive factor to [0, 1]; a non-finite value (NaN/±Infinity from a broken upstream) degrades to 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalize the contention/risk signal to [0, 1]. A FINITE value is clamped like every other field — below-range
 * → 0, above-range → 1 — so `dupRisk = -0.1` reads as no contention and `dupRisk = 1.4` as full contention. A
 * NON-finite value (`NaN`/`±Infinity`) cannot be clamped and signals a broken upstream, so it FAILS CLOSED to
 * maximum risk (1), never 0: a broken contention signal must not masquerade as a safe, uncontested opportunity
 * (mirroring the fail-closed convention in `src/signals/duplicate-winner.ts`, where sparse rows fail closed).
 */
function clampRisk(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * The ordinal opportunity score: `potential * feasibility * laneFit * freshness * (1 - dupRisk)`, with every field
 * clamped to [0, 1] first. Because it is a product, ANY single factor at 0 — or a `dupRisk` of exactly 1 — collapses
 * the whole score to 0: a candidate that fails any one dimension is not an opportunity. Malformed input never passes
 * through raw and always degrades the score toward 0: the four positive factors clamp a non-finite value to 0, and a
 * non-finite `dupRisk` fails closed to 1 (max risk). So a bad signal can neither invert the sign nor overflow the
 * product. Pure.
 *
 * Signal-source map for the composing caller (a later issue): `feasibility` ← the per-repo report in
 * `src/services/issue-quality.ts`; `laneFit` ← `MinerGoalSpec.preferredLanes` (the goal-model issue); `freshness`
 * ← `src/signals/reward-risk.ts`'s `freshnessFactor`; `dupRisk` ← `src/signals/reward-risk.ts`'s
 * `competitionFactor` combined with `src/signals/duplicate-winner.ts`'s claim adjudication.
 */
export function rankOpportunityScore(input: OpportunityRankInput): number {
  return (
    clamp01(input.potential) *
    clamp01(input.feasibility) *
    clamp01(input.laneFit) *
    clamp01(input.freshness) *
    (1 - clampRisk(input.dupRisk))
  );
}

/**
 * Rank a candidate list by descending {@link rankOpportunityScore}, annotating each candidate with its `rankScore`.
 * Equal scores keep their input order: the tie-break is made EXPLICIT via a carried index (`rankScore` desc, then
 * `index` asc) rather than relying on `Array.prototype.sort` stability, so the contract holds on any engine and is
 * enforced by this function. Mirrors the tie-break intent of `isDuplicateClusterWinnerByClaim` in
 * src/signals/duplicate-winner.ts, where an earlier entry wins a tie. Pure — returns a new array; the input array
 * and its elements are not mutated. The computed `rankScore` REPLACES any `rankScore` already on an input element
 * (`Omit<T, "rankScore">` in the result), so a caller carrying its own field can't collide with the annotation.
 */
export function rankOpportunities<T>(
  candidates: Array<T & OpportunityRankInput>,
): Array<Omit<T, "rankScore"> & OpportunityRankInput & { rankScore: number }> {
  return candidates
    .map((candidate, index) => ({ candidate, rankScore: rankOpportunityScore(candidate), index }))
    .sort((a, b) => b.rankScore - a.rankScore || a.index - b.index)
    .map(({ candidate, rankScore }) => ({ ...candidate, rankScore }));
}

/**
 * Rank candidates and return the top `limit` entries. Non-finite or negative limits return an empty list.
 * Pure — delegates to {@link rankOpportunities} for ordering and tie-breaking.
 */
export function pickTopRankedOpportunities<T>(
  candidates: Array<T & OpportunityRankInput>,
  limit: number,
): Array<Omit<T, "rankScore"> & OpportunityRankInput & { rankScore: number }> {
  if (!Number.isFinite(limit)) return [];
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (safeLimit === 0 || candidates.length === 0) return [];
  return rankOpportunities(candidates).slice(0, safeLimit);
}
