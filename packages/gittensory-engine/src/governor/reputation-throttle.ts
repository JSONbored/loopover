// Governor self-reputation throttle (#2346, pure).
// Deterministic, side-effect-free cadence math for the local Governor. Given the miner's OWN recent terminal
// outcomes on one repo (merged vs. human-closed/gate-rejected) and a threshold config, it decides how much to
// slow that repo's submission cadence: a clean track record runs at full cadence, a rising unfavorable ratio
// degrades cadence toward a floor, and a recovering ratio restores it — never a hard permanent ban. It reads
// only the miner's own local history (never shared/cross-fleet data), computes numbers only, and does NOT store
// state or gate any write; that enforcement wiring is a separate, maintainer-owned chokepoint. The
// outcome-history-driven shape mirrors src/signals/reward-risk.ts, adapted to the miner's own local-only view.
import type { GovernorLedgerEvent } from "../governor-ledger.js";

export type SelfReputationThresholds = {
  /** Terminal outcomes required on a repo before throttling engages; below this it fails OPEN (full cadence). */
  minSampleSize: number;
  /** Unfavorable ratio (unfavorable / decided) at which cadence starts degrading below full. */
  throttleAtRatio: number;
  /** Unfavorable ratio at (or above) which cadence is pinned to its floor. */
  floorAtRatio: number;
  /** Cadence multiplier at/above `floorAtRatio` — the slowest permitted fraction of normal cadence (never 0). */
  minCadenceFactor: number;
};

/** Conservative built-in defaults; a `.gittensory-miner.yml` override is merged over these. */
export const DEFAULT_SELF_REPUTATION_THRESHOLDS: SelfReputationThresholds =
  Object.freeze({
    minSampleSize: 5,
    throttleAtRatio: 0.5,
    floorAtRatio: 0.9,
    minCadenceFactor: 0.1,
  });

/** The miner's own terminal outcomes on one repo over its recent-history window. */
export type RepoOutcomeHistory = {
  /** Submissions with a terminal outcome (merged + closed + rejected). */
  decided: number;
  /** Terminal outcomes that went against the miner (human-closed or gate-rejected). */
  unfavorable: number;
};

export type SelfReputationThrottleReason =
  | "insufficient_history"
  | "clean"
  | "throttled"
  | "floored";

export type SelfReputationThrottleDecision = {
  /** Multiplier on normal submission cadence, in [minCadenceFactor, 1]. 1 = unthrottled. */
  cadenceFactor: number;
  throttled: boolean;
  /** The unfavorable ratio that drove the decision; null when below the sample floor (fail-open). */
  unfavorableRatio: number | null;
  reason: SelfReputationThrottleReason;
};

function finiteNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clampFraction(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Merge a partial (e.g. `.gittensory-miner.yml`-sourced) threshold config over the conservative defaults,
 * normalizing every field so a malformed value can never produce a NaN/negative/out-of-range decision. The
 * throttle band is kept well-formed: `floorAtRatio` is pulled to at least `throttleAtRatio` so the interpolation
 * span is never negative.
 */
export function resolveSelfReputationThresholds(
  overrides: Partial<SelfReputationThresholds> = {},
): SelfReputationThresholds {
  const d = DEFAULT_SELF_REPUTATION_THRESHOLDS;
  const minSampleSize = Math.max(
    1,
    finiteNonNegativeInt(overrides.minSampleSize ?? d.minSampleSize),
  );
  const throttleAtRatio = clampFraction(
    overrides.throttleAtRatio ?? d.throttleAtRatio,
    d.throttleAtRatio,
  );
  const floorAtRatio = Math.max(
    throttleAtRatio,
    clampFraction(overrides.floorAtRatio ?? d.floorAtRatio, d.floorAtRatio),
  );
  const minCadenceFactor = clampFraction(
    overrides.minCadenceFactor ?? d.minCadenceFactor,
    d.minCadenceFactor,
  );
  return { minSampleSize, throttleAtRatio, floorAtRatio, minCadenceFactor };
}

/**
 * Decide the cadence throttle for one repo from the miner's own recent outcome history. Pure: reads the history
 * and thresholds and returns a decision without mutating anything. Fails OPEN on genuinely insufficient history
 * (fewer than `minSampleSize` decided outcomes) — a brand-new miner or a new repo is never falsely throttled.
 * Between `throttleAtRatio` and `floorAtRatio` the cadence factor interpolates linearly from 1 down to
 * `minCadenceFactor`, so an improving ratio measurably restores cadence and a worsening one measurably cuts it.
 */
export function selfReputationThrottle(
  history: RepoOutcomeHistory,
  thresholds: SelfReputationThresholds = DEFAULT_SELF_REPUTATION_THRESHOLDS,
): SelfReputationThrottleDecision {
  const decided = finiteNonNegativeInt(history.decided);
  const unfavorable = Math.min(
    decided,
    finiteNonNegativeInt(history.unfavorable),
  );

  if (decided < thresholds.minSampleSize) {
    return {
      cadenceFactor: 1,
      throttled: false,
      unfavorableRatio: null,
      reason: "insufficient_history",
    };
  }

  const ratio = unfavorable / decided;
  if (ratio < thresholds.throttleAtRatio) {
    return {
      cadenceFactor: 1,
      throttled: false,
      unfavorableRatio: round3(ratio),
      reason: "clean",
    };
  }
  if (ratio >= thresholds.floorAtRatio) {
    return {
      cadenceFactor: thresholds.minCadenceFactor,
      throttled: true,
      unfavorableRatio: round3(ratio),
      reason: "floored",
    };
  }
  // throttleAtRatio <= ratio < floorAtRatio ⇒ floorAtRatio > throttleAtRatio, so the span is strictly positive.
  const t =
    (ratio - thresholds.throttleAtRatio) /
    (thresholds.floorAtRatio - thresholds.throttleAtRatio);
  const cadenceFactor = round3(1 - t * (1 - thresholds.minCadenceFactor));
  return {
    cadenceFactor,
    throttled: true,
    unfavorableRatio: round3(ratio),
    reason: "throttled",
  };
}

/**
 * Shape a throttle decision as a governor-ledger event so the chokepoint can record WHY a submission cadence was
 * scaled, with the outcome ratio that triggered it. An unthrottled decision is an `allowed` event; a throttled
 * one is a `throttled` event.
 */
export function selfReputationThrottleLedgerEvent(
  repoFullName: string,
  actionClass: string,
  decision: SelfReputationThrottleDecision,
): GovernorLedgerEvent {
  return {
    eventType: decision.throttled ? "throttled" : "allowed",
    repoFullName,
    actionClass,
    decision: decision.throttled ? "throttle" : "allow",
    reason: decision.reason,
    payload: {
      cadenceFactor: decision.cadenceFactor,
      unfavorableRatio: decision.unfavorableRatio,
    },
  };
}
