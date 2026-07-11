// #2349: personalizes buildPredictedGateVerdict's readiness/confidence output using a contributor/miner's OWN
// historical predict-vs-real agreement (predicted_gate_calibration_ledger, written by
// src/review/predicted-gate-calibration-ledger.ts). Pure and D1-free by design -- this package never touches a
// database; the caller (src/mcp/server.ts, src/api/routes.ts) reads and aggregates the ledger for one login,
// then hands this module a plain, already-computed signal.
//
// SAFETY BOUNDARY (mirrors the design note in both src/review/contributor-calibration.ts and
// src/review/predicted-gate-calibration-ledger.ts): buildPredictedGateVerdict calls applyContributorCalibration
// strictly AFTER evaluateGateCheck has already finalized conclusion/blockers/warnings, and threads through
// ONLY the numeric readinessScore. This function never receives blockers or conclusion, so it is structurally
// incapable of flipping a hard blocker off -- not just clamped by convention, but by construction.
//
// PRIVACY: the calibration signal (sampleSize, agreementRate) is consumed here and never echoed back in
// PredictedGateVerdict -- only its clamped, bounded DOWNSTREAM EFFECT (a shifted readinessScore, itself
// already a public-facing concept) is returned. src/signals/redaction.ts's "no raw per-actor trust signal,
// ever public" boundary is preserved because the raw numbers never reach the output at all.

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Below this many historical (prediction, real-decision) pairings, a login's track record is treated as
 *  cold-start (unweighted baseline) -- too few samples to distinguish signal from noise. */
export const MIN_CALIBRATION_SAMPLES = 5;

/** Maximum points (out of the 0-100 readinessScore scale) personalization may add or subtract. Deliberately
 *  small relative to the 100-point scale: this is a confidence nudge, not a re-scoring. */
export const MAX_READINESS_ADJUSTMENT = 10;

/** Agreement rate that maps to a zero adjustment -- a coin-flip predict-vs-real track record earns neither a
 *  bonus nor a penalty. */
const NEUTRAL_AGREEMENT_RATE = 0.5;

export type ContributorCalibrationSignal = {
  /** How many (prediction, real-decision) pairings this login has in predicted_gate_calibration_ledger. */
  sampleSize: number;
  /** Fraction of those pairings where the predicted action matched the real decision. Clamped to [0, 1]
   *  before use, so a malformed upstream aggregate can never push the adjustment past its own clamp. */
  agreementRate: number;
};

/**
 * Adjusts a baseline readinessScore by a login's own predict-vs-real calibration history, clamped to
 * +/-{@link MAX_READINESS_ADJUSTMENT} points and to the score's own [0, 100] range.
 *
 * Cold start -- no calibration signal, or fewer than {@link MIN_CALIBRATION_SAMPLES} pairings -- returns the
 * baseline completely UNCHANGED: a never-seen (or barely-seen) actor gets no penalty and no bonus. A `null`
 * baseline (no readiness score to begin with) stays `null` -- personalization never manufactures a score out
 * of nothing.
 */
export function applyContributorCalibration(
  baselineReadinessScore: number | null,
  calibration: ContributorCalibrationSignal | null | undefined,
): number | null {
  if (baselineReadinessScore === null) return null;
  if (!calibration || calibration.sampleSize < MIN_CALIBRATION_SAMPLES) return baselineReadinessScore;
  const agreementRate = clamp(calibration.agreementRate, 0, 1);
  const rawAdjustment = (agreementRate - NEUTRAL_AGREEMENT_RATE) * 2 * MAX_READINESS_ADJUSTMENT;
  const adjustment = clamp(rawAdjustment, -MAX_READINESS_ADJUSTMENT, MAX_READINESS_ADJUSTMENT);
  return clamp(baselineReadinessScore + adjustment, 0, 100);
}
