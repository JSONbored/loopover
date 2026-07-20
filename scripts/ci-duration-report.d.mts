export type WorkflowRun = {
  conclusion: string;
  created_at: string;
  updated_at: string;
};

export type CiDurationSummary = {
  count: number;
  excludedCancelled: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
  failureRate: number | null;
  failures: number;
};

export declare function durationSeconds(run: WorkflowRun): number;
export declare function percentile(sortedValues: number[], p: number): number | null;
export declare function summarize(allRuns: WorkflowRun[]): CiDurationSummary;
