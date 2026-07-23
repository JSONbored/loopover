// Per-rule reliability curves (#8226, epic #8211 track E): claimed-confidence bucket → empirical precision
// over decided cases, from which an optimal floor FALLS OUT of the labeled corpus instead of being guessed
// from a hand-picked candidate ladder. Pure math beside the backtest primitives — no IO, no randomness, no
// wall-clock reads — with the #8085 scorer's N/A-over-zero discipline everywhere: a bucket (or a pooled
// candidate) with no decided cases reports null precision, never 0.

import type { BacktestCase } from "./backtest-corpus.js";

/** Default bucket edges: one collapsed sub-0.5 bucket (verdicts down there are rare and uninformative —
 *  every live floor sits far above), then 0.1-wide steps through the mid-band and 0.05-wide steps across
 *  the 0.8–1.0 band where the shipped floors (0.85/0.9/0.93/0.95) actually live — matching the granularity
 *  of the knob ladders this curve is meant to replace. Each edge starts a bucket reaching to the next edge
 *  (exclusive); the last bucket reaches 1 inclusive. */
export const DEFAULT_RELIABILITY_BUCKET_EDGES: readonly number[] = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];

export type ReliabilityBucket = {
  /** Inclusive lower edge. */
  from: number;
  /** Exclusive upper edge — except the final bucket, which includes 1. */
  to: number;
  cases: number;
  confirmed: number;
  reversed: number;
  /** confirmed / decided over this bucket, or null when the bucket decided nothing — never coerced to 0. */
  precision: number | null;
};

/** The claimed confidence a case's firing carried, or null when it carried none (or a non-numeric /
 *  out-of-range value) — such cases cannot be bucketed and are excluded from the curve, never guessed. */
function claimedConfidence(backtestCase: BacktestCase): number | null {
  const confidence = backtestCase.metadata?.confidence;
  return typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? confidence : null;
}

/**
 * Compute the reliability curve for a labeled corpus: for each claimed-confidence bucket, how many decided
 * cases landed there and how precise the rule empirically was ("confirmed" is the correct-firing class, so
 * bucket precision = confirmed / (confirmed + reversed) — the same numerator discipline as
 * `computeRulePrecision`). Cases without a usable claimed confidence are excluded. Deterministic: same
 * corpus + edges ⇒ same curve, buckets in ascending edge order.
 */
export function computeReliabilityCurve(
  cases: readonly BacktestCase[],
  bucketEdges: readonly number[] = DEFAULT_RELIABILITY_BUCKET_EDGES,
): ReliabilityBucket[] {
  const buckets: ReliabilityBucket[] = bucketEdges.map((from, index) => ({
    from,
    to: index + 1 < bucketEdges.length ? bucketEdges[index + 1]! : 1,
    cases: 0,
    confirmed: 0,
    reversed: 0,
    precision: null,
  }));
  for (const backtestCase of cases) {
    const confidence = claimedConfidence(backtestCase);
    if (confidence === null) continue;
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
      const bucket = buckets[index]!;
      if (confidence >= bucket.from) {
        bucket.cases += 1;
        if (backtestCase.label === "confirmed") bucket.confirmed += 1;
        else bucket.reversed += 1;
        break;
      }
    }
  }
  for (const bucket of buckets) {
    const decided = bucket.confirmed + bucket.reversed;
    bucket.precision = decided > 0 ? bucket.confirmed / decided : null;
  }
  return buckets;
}

/**
 * Derive the LOOSEST confidence floor whose at-or-above buckets' pooled precision meets `targetPrecision`
 * (#8226) — candidates are the curve's own bucket edges, tried ascending so the first qualifying edge is the
 * loosest; an edge below `hardMinimum` is never suggested, however good its evidence (the same
 * no-evidence-crosses-the-floor rule as the knob evaluators). Null — deterministic and conservative, never a
 * guess — when a candidate's pooled slice decided nothing (insufficient density) or no candidate's pooled
 * precision reaches the target.
 */
export function deriveThresholdSuggestion(
  curve: readonly ReliabilityBucket[],
  targetPrecision: number,
  hardMinimum: number,
): number | null {
  for (let index = 0; index < curve.length; index += 1) {
    const floor = curve[index]!.from;
    if (floor < hardMinimum) continue;
    let confirmed = 0;
    let decided = 0;
    for (const bucket of curve.slice(index)) {
      confirmed += bucket.confirmed;
      decided += bucket.confirmed + bucket.reversed;
    }
    if (decided === 0) continue;
    if (confirmed / decided >= targetPrecision) return floor;
  }
  return null;
}
