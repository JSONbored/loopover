// Distribution-free risk control for the act/hold threshold (#8835, epic #8828 Phase 3) — the mechanism that
// turns "99.5% accurate" from a hope into a guarantee ON THE DECISIONS ACTED.
//
// METHOD: fixed-sequence testing, the Learn-then-Test special case (Angelopoulos et al.; applied to LLM
// judges by Trust or Escalate, ICLR 2025). Sweep the confidence threshold λ from most conservative (1.0)
// downward; at each λ compute the EMPIRICAL error rate over calibration pairs with confidence ≥ λ and take
// an EXACT binomial (Clopper–Pearson) upper confidence bound on it. λ̂ is the smallest λ (largest coverage)
// whose bound — and every more-conservative λ's bound — stays ≤ α. Then, with probability ≥ 1−δ over the
// calibration draw, P(decision wrong | confidence ≥ λ̂) ≤ α. No distributional assumptions.
//
// HONESTY GUARDS, both load-bearing:
//   • INSUFFICIENT LABELS IS A REFUSAL, never a degraded guess. Even a zero-error calibration set cannot
//     certify α until n ≥ ln(δ)/ln(1−α) (the exact rule-of-three bound) — at α=0.005, δ=0.05 that is 598
//     clean labels. Below it this module refuses and the caller keeps the static floor.
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
    }
  | { status: "insufficient_labels"; needed: number; have: number; alpha: number; delta: number };

/**
 * Fixed-sequence calibration, walked in DESCENDING-coverage order: candidates are the distinct observed
 * confidences ascending, so the FIRST test is the most permissive λ (full calibration set — maximum power,
 * maximum coverage) and each subsequent test drops the lowest-confidence stratum. The sweep stops at the
 * FIRST λ whose Clopper–Pearson bound certifies α — ordered stopping at the first rejection is what keeps
 * the selection valid at level δ without a multiplicity correction (Learn-then-Test, fixed-sequence
 * variant). Walking the other way (conservative-first) is a trap: early candidates fail on sample-size
 * POWER, not on errors, and monotone stopping would kill the sweep before it ever reached a certifiable λ.
 *
 * Refuses (never guesses) when the total set is under the zero-error floor, or when no candidate certifies
 * — whether from real errors or from a passing-but-tiny high-confidence clique that cannot carry α on its
 * own. PURE and deterministic.
 */
export function calibrateActThreshold(pairs: CalibrationPair[], alpha: number, delta: number): CalibrationResult {
  const needed = minimumCalibrationLabels(alpha, delta);
  if (pairs.length < needed) return { status: "insufficient_labels", needed, have: pairs.length, alpha, delta };

  const sorted = [...pairs].sort((a, b) => a.confidence - b.confidence); // ascending
  const candidates = [...new Set(sorted.map((pair) => pair.confidence))]; // ascending λ = descending coverage
  const totalErrors = sorted.filter((pair) => !pair.correct).length;
  let dropped = 0;
  let droppedErrors = 0;
  let index = 0;
  let lastTestedN = sorted.length;
  for (const lambda of candidates) {
    const n = sorted.length - dropped;
    const errors = totalErrors - droppedErrors;
    lastTestedN = n;
    if (n >= needed && clopperPearsonUpperBound(errors, n, delta) <= alpha) {
      return {
        status: "calibrated",
        lambda,
        coverageAtLambda: n / sorted.length,
        nAtLambda: n,
        errorsAtLambda: errors,
        alpha,
        delta,
        totalPairs: sorted.length,
      };
    }
    // Drop this stratum and test the next, more conservative λ.
    while (index < sorted.length && sorted[index]!.confidence <= lambda) {
      dropped += 1;
      if (!sorted[index]!.correct) droppedErrors += 1;
      index += 1;
    }
  }
  return { status: "insufficient_labels", needed, have: lastTestedN, alpha, delta };
}
