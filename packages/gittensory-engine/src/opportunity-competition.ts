function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function finiteClusterPressure(value: number): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, value);
}

/**
 * Compute a [0, 1] competition factor from duplicate-cluster pressure and open PR volume, mirroring
 * `opportunityCompetitionFactor` in `src/signals/reward-risk.ts` so the miner engine can derive `dupRisk`
 * inputs without importing hosted signal code.
 */
export function computeOpportunityCompetition(
  highRiskDuplicateClusters: number,
  openPullRequests: number,
): number {
  const clusters = finiteClusterPressure(highRiskDuplicateClusters);
  const openPrs = finiteNonNegative(openPullRequests);
  return round4(clamp(clusters / Math.max(1, openPrs), 0, 1));
}
