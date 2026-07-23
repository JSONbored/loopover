// Per-rule reliability curve + derived threshold suggestion (#8226, epic #8211 track E). Knob evaluation
// (src/services/loosening-knobs.ts) steps down hand-picked candidate ladders; the labeled corpus supports
// something strictly better: bucket a rule's decided cases by their CLAIMED confidence (metadata.confidence,
// the same channel buildConfidenceThresholdClassifier reads, #8138), measure each bucket's EMPIRICAL
// precision against the human verdicts, and let the optimal floor fall out of the curve instead of being
// guessed. This module is the pure math only -- no advisor/registry integration (maintainer follow-on).
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestCase } from "./backtest-corpus.js";

/** One claimed-confidence bucket of a {@link ReliabilityCurve}: its `[floor, ceiling)` confidence range
 *  (the curve's TOP bucket is ceiling-inclusive so a claimed confidence of exactly 1 is bucketable), the
 *  decided cases whose claimed confidence landed in it, their confirmed/reversed verdict split, and the
 *  bucket's empirical precision (`confirmed / cases`) -- null, never 0, when `cases` sits below the curve's
 *  sample floor, the same "unknown stays unknown" discipline as RulePrecisionReport.precision (#8085). */
export type ReliabilityBucket = {
  floor: number;
  ceiling: number;
  cases: number;
  confirmed: number;
  reversed: number;
  precision: number | null;
};

/** A rule's claimed-confidence reliability curve: `buckets` ascending by `floor`, plus the `sampleFloor`
 *  the per-bucket precisions were computed under -- carried so {@link deriveThresholdSuggestion} can apply
 *  the SAME never-on-noise floor to its pooled counts. */
export type ReliabilityCurve = {
  sampleFloor: number;
  buckets: ReliabilityBucket[];
};

/** Default bucket edges: one catch-all below 0.3, then 0.05-wide buckets up to 1 -- the SAME granularity
 *  the loosenable-knob registry's candidate ladders step at (loosening-knobs.ts: [0.45, 0.4, 0.35, 0.3]
 *  and [0.9, 0.85]), so every floor the registry could actually adopt, both hard minimums (0.3, 0.85)
 *  included, is exactly a bucket floor a suggestion can land on. No shipped floor lives below 0.3, hence
 *  the single catch-all there. Sparse corpora keep their honesty either way: a thin bucket reports null
 *  precision, and {@link deriveThresholdSuggestion} pools at-or-above buckets before judging density. */
export const DEFAULT_RELIABILITY_BUCKET_EDGES: readonly number[] = [
  0, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1,
];

/** Minimum decided cases before a bucket (or a pooled suggestion window) reports a real precision --
 *  below it the value is null, never 0. 5 mirrors the registry's smallest never-on-noise floor
 *  (loosening-knobs.ts minHeldOutCases: 5) and MIN_CALIBRATION_SAMPLES (contributor-calibration.ts). */
export const RELIABILITY_BUCKET_SAMPLE_FLOOR = 5;

/** Index of the bucket containing `claimed` under half-open `[floor, ceiling)` edges with a
 *  ceiling-INCLUSIVE top bucket, or -1 when it lands in none (below the first edge, above the last, or
 *  NaN -- the negated first guard makes NaN fail closed into -1 rather than landing in a bucket). */
function bucketIndexFor(claimed: number, bucketEdges: readonly number[]): number {
  if (!(claimed >= bucketEdges[0]!)) return -1;
  for (let i = 1; i < bucketEdges.length; i++) {
    if (claimed < bucketEdges[i]!) return i - 1;
  }
  return claimed === bucketEdges[bucketEdges.length - 1]! ? bucketEdges.length - 2 : -1;
}

/**
 * Bucket `cases` by their CLAIMED confidence (`metadata.confidence`) and report each bucket's empirical
 * precision against the human verdicts. A case with no numeric claimed confidence contributes to no bucket:
 * this deliberately DIVERGES from buildConfidenceThresholdClassifier's degrade-to-1 fallback (#8138) --
 * that function must DECIDE every case, this one MEASURES claim reliability, and fabricating a confidence-1
 * claim would corrupt the top bucket's evidence (same "drop rather than guess" posture as
 * repo-corpus-slice's unparseable-key handling). An out-of-range claim (below the first edge, above the
 * last) is likewise dropped, never clamped into a bucket. A bucket below `sampleFloor` reports null
 * precision, never 0. Throws on malformed `bucketEdges` (fewer than 2, out of [0, 1], or not strictly
 * ascending) or a `sampleFloor` below 1 -- caller bugs, mirroring splitBacktestCorpus's guard; the negated
 * compound forms make NaN fail closed into the throw. Pure and deterministic.
 */
export function computeReliabilityCurve(
  cases: readonly BacktestCase[],
  bucketEdges: readonly number[] = DEFAULT_RELIABILITY_BUCKET_EDGES,
  sampleFloor: number = RELIABILITY_BUCKET_SAMPLE_FLOOR,
): ReliabilityCurve {
  if (bucketEdges.length < 2) {
    throw new Error(`invalid_bucket_edges: need at least 2 edges, got ${bucketEdges.length}`);
  }
  for (let i = 0; i < bucketEdges.length; i++) {
    if (!(bucketEdges[i]! >= 0 && bucketEdges[i]! <= 1)) {
      throw new Error(`invalid_bucket_edges: edge outside [0, 1]: ${bucketEdges[i]}`);
    }
    if (i > 0 && !(bucketEdges[i]! > bucketEdges[i - 1]!)) {
      throw new Error(`invalid_bucket_edges: edges must be strictly ascending at index ${i}`);
    }
  }
  if (!(sampleFloor >= 1)) {
    throw new Error(`invalid_sample_floor: ${sampleFloor}`);
  }
  const counts = bucketEdges.slice(0, -1).map(() => ({ cases: 0, confirmed: 0, reversed: 0 }));
  for (const backtestCase of cases) {
    const claimed = backtestCase.metadata?.confidence;
    if (typeof claimed !== "number") continue;
    const index = bucketIndexFor(claimed, bucketEdges);
    if (index === -1) continue;
    const bucket = counts[index]!;
    bucket.cases += 1;
    if (backtestCase.label === "confirmed") bucket.confirmed += 1;
    else bucket.reversed += 1;
  }
  return {
    sampleFloor,
    buckets: counts.map((count, i) => ({
      floor: bucketEdges[i]!,
      ceiling: bucketEdges[i + 1]!,
      cases: count.cases,
      confirmed: count.confirmed,
      reversed: count.reversed,
      // sampleFloor >= 1 (validated above), so a passing count.cases is never 0 -- no divide-by-zero arm.
      precision: count.cases >= sampleFloor ? count.confirmed / count.cases : null,
    })),
  };
}

/**
 * Derive the LOOSEST confidence floor the curve's evidence supports: the lowest bucket floor at or above
 * `hardMinimum` whose at-or-above buckets' POOLED precision (pooled confirmed / pooled cases, raw counts --
 * a bucket individually below the sample floor still contributes its cases to the pool) meets
 * `targetPrecision`, with the pool itself subject to the curve's own `sampleFloor` (a pooled window below
 * it is unknown, not 0, so it can never qualify). Null when no candidate floor qualifies -- including when
 * the only precision-meeting floors sit below `hardMinimum` (a suggestion is never clamped UP to a floor
 * whose own pooled evidence was not checked) or when pooled density is insufficient everywhere.
 * Conservative by construction and deterministic: same curve + parameters, same suggestion. Throws when
 * `targetPrecision` or `hardMinimum` is outside [0, 1] (negated compound guards, so NaN fails closed) --
 * caller bugs, mirroring splitBacktestCorpus.
 */
export function deriveThresholdSuggestion(
  curve: ReliabilityCurve,
  targetPrecision: number,
  hardMinimum: number,
): number | null {
  if (!(targetPrecision >= 0 && targetPrecision <= 1)) {
    throw new Error(`invalid_target_precision: ${targetPrecision}`);
  }
  if (!(hardMinimum >= 0 && hardMinimum <= 1)) {
    throw new Error(`invalid_hard_minimum: ${hardMinimum}`);
  }
  const { buckets, sampleFloor } = curve;
  // Suffix-pooled raw counts: pooledCases[i]/pooledConfirmed[i] cover every bucket whose floor is at or
  // above buckets[i].floor (buckets ascend by floor, so the pool for candidate i is the suffix from i).
  const pooledCases: number[] = new Array<number>(buckets.length).fill(0);
  const pooledConfirmed: number[] = new Array<number>(buckets.length).fill(0);
  let cases = 0;
  let confirmed = 0;
  for (let i = buckets.length - 1; i >= 0; i--) {
    cases += buckets[i]!.cases;
    confirmed += buckets[i]!.confirmed;
    pooledCases[i] = cases;
    pooledConfirmed[i] = confirmed;
  }
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i]!.floor < hardMinimum) continue;
    // Suffix pools only shrink as the floor tightens, so once density fails here it fails for every later
    // candidate too -- the uniform guard just lets the loop run out to the null below.
    if (pooledCases[i]! < sampleFloor) continue;
    if (pooledConfirmed[i]! / pooledCases[i]! >= targetPrecision) return buckets[i]!.floor;
  }
  return null;
}
