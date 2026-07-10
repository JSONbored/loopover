// Self-reputation throttle (#2346): pure. Given the miner's OWN recent PR outcomes on ONE repo, compute a
// cadence multiplier (1.0 = normal, → floor when the miner's own close/reject ratio is bad) — a self-correcting
// slowdown distinct from the fixed global/per-repo rate limit and driven by the miner's own local merge/close
// history (never shared/cross-fleet data). NOT a permanent ban: an improving ratio recovers cadence next call.
// FAILS OPEN on insufficient sample — a new miner or a new repo is never falsely throttled.
//
// No IO. The Governor chokepoint consults this before an open_pr/file_issue action and records the returned
// verdict (with the triggering ratio) to the append-only governor ledger — that consultation + ledger write is
// separate, maintainer-owned enforcement wiring. Shape stays consistent with the outcome-history-driven risk
// vocabulary in src/signals/reward-risk.ts, adapted to the miner's own local-only counts.

/** The miner's own terminal PR outcomes on one repo over the recent window. */
export type OwnRepoOutcomes = {
  /** PRs merged. */
  merged: number;
  /** PRs closed WITHOUT a merge (rejected). */
  closed: number;
};

export type SelfReputationThresholds = {
  /** Minimum terminal outcomes before the throttle engages at all; below this it fails open (full cadence). */
  minSample: number;
  /** Close ratio at or below which cadence stays full (1.0). */
  healthyCloseRatio: number;
  /** Close ratio at or above which cadence hits its floor. */
  criticalCloseRatio: number;
  /** The lowest cadence multiplier the throttle drops to — never 0 (a permanent ban is out of scope). */
  minCadenceMultiplier: number;
};

/** Conservative built-in defaults (a `.gittensory-miner.yml` may override). */
export const DEFAULT_SELF_REPUTATION_THRESHOLDS: SelfReputationThresholds = {
  minSample: 4,
  healthyCloseRatio: 0.2,
  criticalCloseRatio: 0.6,
  minCadenceMultiplier: 0.1,
};

export type SelfReputationThrottleReason =
  | "insufficient_sample"
  | "healthy"
  | "degrading"
  | "critical";

export type SelfReputationThrottleVerdict = {
  /** 1.0 = normal cadence; < 1 = throttled; never below the configured floor, never 0. */
  cadenceMultiplier: number;
  /** closed / (merged + closed) over the window; null when the sample is insufficient. */
  closeRatio: number | null;
  /** merged + closed. */
  sample: number;
  reason: SelfReputationThrottleReason;
};

function nonNegativeInt(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}: expected a finite count >= 0`);
  return value;
}

function ratio01(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid ${label}: expected 0..1`);
  return value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Compute the self-reputation cadence multiplier from the miner's own recent outcomes on a repo. Pure and
 * deterministic. Validates inputs (rejects negative / non-finite counts and out-of-range thresholds) rather
 * than silently coercing them.
 *
 * - `sample < minSample` ⇒ `1.0` (fail open — insufficient evidence to throttle).
 * - `closeRatio <= healthyCloseRatio` ⇒ `1.0`.
 * - `closeRatio >= criticalCloseRatio` ⇒ `minCadenceMultiplier` (the floor).
 * - Between the two ⇒ linear interpolation from `1.0` down to the floor.
 */
export function selfReputationThrottle(
  outcomes: OwnRepoOutcomes,
  thresholds: SelfReputationThresholds = DEFAULT_SELF_REPUTATION_THRESHOLDS,
): SelfReputationThrottleVerdict {
  const merged = nonNegativeInt(outcomes.merged, "outcomes.merged");
  const closed = nonNegativeInt(outcomes.closed, "outcomes.closed");
  const minSample = nonNegativeInt(thresholds.minSample, "thresholds.minSample");
  const healthy = ratio01(thresholds.healthyCloseRatio, "thresholds.healthyCloseRatio");
  const critical = ratio01(thresholds.criticalCloseRatio, "thresholds.criticalCloseRatio");
  const floor = ratio01(thresholds.minCadenceMultiplier, "thresholds.minCadenceMultiplier");
  if (critical <= healthy) throw new Error("invalid thresholds: criticalCloseRatio must exceed healthyCloseRatio");

  const sample = merged + closed;
  if (sample < minSample) {
    return { cadenceMultiplier: 1, closeRatio: null, sample, reason: "insufficient_sample" };
  }

  const closeRatio = round(closed / sample);
  if (closeRatio <= healthy) {
    return { cadenceMultiplier: 1, closeRatio, sample, reason: "healthy" };
  }
  if (closeRatio >= critical) {
    return { cadenceMultiplier: floor, closeRatio, sample, reason: "critical" };
  }
  // Linear interpolation: healthy ⇒ 1.0, critical ⇒ floor.
  const fraction = (closeRatio - healthy) / (critical - healthy);
  const cadenceMultiplier = round(1 - fraction * (1 - floor));
  return { cadenceMultiplier, closeRatio, sample, reason: "degrading" };
}
