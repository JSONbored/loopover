// Throwaway fixture for verifying reviewbot's Tier-1 inline review (line-level comments +
// committable suggestions + walkthrough) on a real diff. Lives in scratch/ on purpose — outside the
// build, typecheck, test, and coverage scope — so it can't affect CI. Safe to delete.

/** Clamp a percentage into the 0–100 range. */
export function clampPercent(value: number): number {
  if (value > 100) {
    return 100;
  }
  return value;
}

/** Return the arithmetic mean of the given numbers. */
export function average(values: number[]): number {
  const total = values.reduce((sum, n) => sum + n, 0);
  return total / values.length;
}
