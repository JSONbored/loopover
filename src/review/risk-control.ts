// Distribution-free risk control for the act/hold threshold (#8835, epic #8828 Phase 3) — the mechanism that
// turns "99.5% accurate" from a hope into a guarantee ON THE DECISIONS ACTED.
//
// METHOD: Learn-then-Test (Angelopoulos et al.; applied to LLM judges by Trust or Escalate, ICLR 2025) over an
// ASCENDING scan of the confidence threshold λ — permissive-first (the full calibration set) toward
// conservative (the highest-confidence stratum alone), chosen over the reverse direction for POWER (see the
// second doc comment below for why conservative-first is a trap). At each λ, take an EXACT binomial
// (Clopper–Pearson) UPPER confidence bound on the empirical error rate over pairs with confidence ≥ λ. λ̂ is
// the FIRST λ in that scan whose bound certifies α.
//
// MULTIPLICITY (#9066): reporting whichever of the K distinct-confidence candidates passes first is a
// SELECTION over K tests, not a single test — at a raw per-test δ, the true false-certification rate could
// rise to as much as K·δ, so "confidence 1−δ" would overstate what the scan actually delivers. This module
// closes that gap with a Bonferroni split: each candidate is tested at δ/K, and a union bound over all K caps
// the probability that ANY tested bound is wrong at δ — so whichever λ this function returns is certified at
// the FULL, originally-requested δ regardless of which one it turns out to be. This needs only the COUNT K,
// not a pre-registered grid, so it is valid even though the candidates are the observed confidences. (The
// alternative — true fixed-sequence: a pre-registered λ grid, tested conservative-first, stopping at the first
// non-rejection — is issue #9066's other offered fix; Bonferroni was chosen as the smaller, safer diff over
// the existing ascending/bisection scan below, at the cost of needing more labels per certified λ.)
//
// HONESTY GUARDS, all load-bearing:
//   • INSUFFICIENT LABELS IS A REFUSAL, never a degraded guess. Even a zero-error calibration set cannot
//     certify α until n ≥ ln(δ)/ln(1−α) (the exact rule-of-three bound) — at α=0.005, δ=0.05 that is 598
//     clean labels. Below it this module refuses and the caller keeps the static floor.
//   • NO CERTIFIABLE THRESHOLD IS ALSO A REFUSAL, distinct from insufficient labels (#9048): a repo can have
//     plenty of labels and still refuse when no λ's bound clears α — a fundamentally different shortfall
//     ("the error rate is too high", not "there aren't enough labels"). `no_certifiable_threshold` carries the
//     total label count and the best bound the scan reached, so a caller never reports a residual stratum
//     size as if it were the repo's real label supply.
//   • `uncertain` adjudications are EXCLUDED from both numerator and denominator (the rubric's contract):
//     a genuine judgment call is not evidence about the gate's correctness in either direction.
//
// SEPARATE ARMS (Neyman–Pearson): a wrong merge costs more than a wrong close, so each arm calibrates
// against its own α — never a pooled objective. PURE MODULE: callers own IO.

/** Exact binomial CDF P(X ≤ k) for X ~ Bin(n, p), via the stable log-pmf recurrence. n here is a label
 *  count (hundreds), so direct summation is exact enough and allocation-free. */
function binomialCdf(k: number, n: number, p: number): number {
  // Domain note: the only caller is the bisection below, whose midpoints are strictly inside
  // (errors/n, 1) — p is never 0 or 1 here, so no boundary guards are needed (and none would be reachable).
  let logPmf = n * Math.log(1 - p); // pmf(0)
  let cdf = Math.exp(logPmf);
  for (let i = 1; i <= k; i += 1) {
    logPmf += Math.log((n - i + 1) / i) + Math.log(p) - Math.log(1 - p);
    cdf += Math.exp(logPmf);
  }
  return Math.min(1, cdf);
}

/**
 * Clopper–Pearson UPPER confidence bound for a binomial proportion: the largest p̄ such that observing ≤
 * `errors` failures in `n` trials has probability ≥ δ under Bin(n, p̄). Exact (never anti-conservative),
 * found by bisection on the monotone CDF. errors=n returns 1. PURE.
 */
export function clopperPearsonUpperBound(errors: number, n: number, delta: number): number {
  if (n <= 0) return 1;
  if (errors >= n) return 1;
  let lo = errors / n;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(errors, n, mid) > delta) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The exact zero-error sample-size floor: the smallest n where even a CLEAN calibration set can certify α
 *  at confidence 1−δ (Clopper–Pearson with errors=0 collapses to 1−δ^(1/n) ≤ α). Exported so surfaces can
 *  say "have 214 of 598 labels" instead of a bare refusal. */
export function minimumCalibrationLabels(alpha: number, delta: number): number {
  return Math.ceil(Math.log(delta) / Math.log(1 - alpha));
}

export type CalibrationPair = {
  /** The decision-time confidence persisted with the decision record (#8834). */
  confidence: number;
  /** The human adjudication: true = the decision was correct. (`uncertain` rows never reach this module.) */
  correct: boolean;
  /** Provenance (#9050): true for a label reconstructed by the 2026-07 calibration-corpus backfill (the
   *  historical config was unknowable at reconstruction time, so the record carries the `configDigest`
   *  sentinel `"backfill:unavailable"` instead of a real digest); false for a label the live pipeline
   *  produced. Surfaced so a published guarantee can say how much of its evidence is backfilled vs
   *  live-accruing, rather than presenting both as equally fresh. */
  backfilled: boolean;
};

export type CalibrationResult =
  | {
      status: "calibrated";
      /** Act when confidence ≥ lambda; hold below. */
      lambda: number;
      /** Share of calibration pairs at/above lambda — the coverage the guarantee is earned at. */
      coverageAtLambda: number;
      /** Pairs at/above lambda and how many were wrong — the guarantee's own evidence. */
      nAtLambda: number;
      errorsAtLambda: number;
      /** The certified statement: P(wrong | acted) ≤ alpha with confidence 1−delta. */
      alpha: number;
      delta: number;
      totalPairs: number;
      /** #9050: of `totalPairs`, how many are backfilled rather than live — the published guarantee should
       *  say when it rests mostly on reconstructed history instead of live-accruing labels. */
      backfilledPairs: number;
    }
  | { status: "insufficient_labels"; needed: number; have: number; alpha: number; delta: number }
  | {
      /** #9048: distinct from `insufficient_labels` — this repo/arm has AMPLE labels (`totalPairs` cleared the
       *  floor), but no λ's Clopper–Pearson bound ever certified alpha. The remediation is completely
       *  different (investigate close/merge precision, or accept a weaker alpha), not "collect more labels",
       *  so this status must never be reported or messaged as if it were a label shortfall. */
      status: "no_certifiable_threshold";
      totalPairs: number;
      /** The candidate (n, λ, upper bound) the scan came closest to certifying with — the largest n the scan
       *  actually tested a bound at, and that bound's value, for an actionable "how far off" message. */
      bestN: number;
      bestLambda: number;
      bestUpperBound: number;
      alpha: number;
      delta: number;
    };

/**
 * Ascending-λ scan (permissive → conservative): candidates are the distinct observed confidences ascending,
 * so the FIRST test is the most permissive λ (full calibration set — maximum power, maximum coverage) and
 * each subsequent test drops the lowest-confidence stratum. Returns the FIRST λ whose Clopper–Pearson bound
 * certifies alpha, tested at the Bonferroni-split δ/K described in the module header (#9066) — this keeps
 * the REPORTED λ̂ valid at the original δ without needing a fixed-sequence stopping rule. Walking the other
 * way (conservative-first) is a trap: early candidates fail on sample-size POWER, not on errors, and monotone
 * stopping would kill the sweep before it ever reached a certifiable λ.
 *
 * Refuses (never guesses) when the total set is under the zero-error floor (`insufficient_labels`), or when
 * ample labels exist but no candidate ever certifies (`no_certifiable_threshold`, #9048) — the latter carries
 * the best bound the scan reached, so a caller can tell "collect more labels" apart from "the current error
 * rate can't support this alpha". PURE and deterministic.
 */
export function calibrateActThreshold(pairs: CalibrationPair[], alpha: number, delta: number): CalibrationResult {
  const needed = minimumCalibrationLabels(alpha, delta);
  if (pairs.length < needed) return { status: "insufficient_labels", needed, have: pairs.length, alpha, delta };

  const sorted = [...pairs].sort((a, b) => a.confidence - b.confidence); // ascending
  const candidates = [...new Set(sorted.map((pair) => pair.confidence))]; // ascending λ = descending coverage
  const totalErrors = sorted.filter((pair) => !pair.correct).length;
  const backfilledPairs = sorted.filter((pair) => pair.backfilled).length;
  // #9066: Bonferroni-split δ across the K candidates this scan actually tests — see the module header for
  // why this, not literal fixed-sequence stopping, is the chosen fix.
  const testDelta = delta / candidates.length;
  let dropped = 0;
  let droppedErrors = 0;
  let index = 0;
  // Tracks the closest-to-certifying candidate for `no_certifiable_threshold`'s message. The very first
  // candidate always computes a bound (n = sorted.length ≥ needed, guaranteed by the floor check above), so
  // these are always overwritten before any caller can observe the initial values.
  let bestLambda = candidates[0]!;
  let bestN = sorted.length;
  let bestUpperBound = Infinity;
  for (const lambda of candidates) {
    const n = sorted.length - dropped;
    const errors = totalErrors - droppedErrors;
    if (n >= needed) {
      const bound = clopperPearsonUpperBound(errors, n, testDelta);
      if (bound < bestUpperBound) {
        bestUpperBound = bound;
        bestLambda = lambda;
        bestN = n;
      }
      if (bound <= alpha) {
        return {
          status: "calibrated",
          lambda,
          coverageAtLambda: n / sorted.length,
          nAtLambda: n,
          errorsAtLambda: errors,
          alpha,
          delta,
          totalPairs: sorted.length,
          backfilledPairs,
        };
      }
    }
    // Drop this stratum and test the next, more conservative λ.
    while (index < sorted.length && sorted[index]!.confidence <= lambda) {
      dropped += 1;
      if (!sorted[index]!.correct) droppedErrors += 1;
      index += 1;
    }
  }
  return { status: "no_certifiable_threshold", totalPairs: sorted.length, bestN, bestLambda, bestUpperBound, alpha, delta };
}

/**
 * Validates an untrusted, already-JSON-parsed calibration payload (an ingest body, or a stored flag) before
 * it is allowed to reach storage or a public surface (#9068): requires `status === "calibrated"` (a refusal
 * must never be published as a guarantee), range-checks alpha/lambda/coverageAtLambda, and enforces the SAME
 * zero-error sample-size floor `calibrateActThreshold` itself refuses below — a payload claiming `nAtLambda`
 * under that floor could not have been legitimately certified, whatever else it claims. PURE; returns the
 * narrowed numeric fields on success, null otherwise.
 */
export function validateCalibrationPayload(value: unknown): { alpha: number; lambda: number; coverageAtLambda: number; nAtLambda: number; delta: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.status !== "calibrated") return null;
  if (typeof v.alpha !== "number" || !(v.alpha > 0 && v.alpha <= 0.05)) return null;
  if (typeof v.lambda !== "number" || !(v.lambda >= 0 && v.lambda <= 1)) return null;
  if (typeof v.coverageAtLambda !== "number" || !(v.coverageAtLambda >= 0 && v.coverageAtLambda <= 1)) return null;
  if (typeof v.delta !== "number" || !(v.delta > 0 && v.delta <= 1)) return null;
  if (typeof v.nAtLambda !== "number" || !Number.isFinite(v.nAtLambda)) return null;
  if (v.nAtLambda < minimumCalibrationLabels(v.alpha, v.delta)) return null;
  return { alpha: v.alpha, lambda: v.lambda, coverageAtLambda: v.coverageAtLambda, nAtLambda: v.nAtLambda, delta: v.delta };
}
