// Cycle-time analytics card model (#2194). UI-side mirror of the CycleTimeAggregate shape produced by
// computeCycleTimeAggregate (src/review/stats.ts) and surfaced on the operator-dashboard payload. Types +
// pure formatters live here (not in the .tsx) so the component file exports only components
// (react-refresh/only-export-components).

/** PR review cycle-time percentiles (mirror of src/review/stats.ts CycleTimeAggregate). */
export interface CycleTimeAggregate {
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  distribution: number[];
  sampleSize: number;
}

/** Human-readable duration for percentile tiles; null/undefined → em dash. */
export function formatCycleTimeMs(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 60_000) return `${Math.round(v / 1000)}s`;
  if (v < 3_600_000) return `${Math.round(v / 60_000)}m`;
  return `${(v / 3_600_000).toFixed(1)}h`;
}
