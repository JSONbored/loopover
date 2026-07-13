/** Type declarations for the dependency-free micro-benchmark harness (#4845). Ships as a sibling `.d.mts` (the
 * same pattern as `generate-env-reference.d.mts`) so the harness's `.mjs` gets types without a build step. */

export type BenchmarkSummary = {
  iterations: number;
  totalMs: number;
  meanMs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  opsPerSec: number;
};

/** The fully-timed result `runBenchmark` produces (always `status: "ok"`). */
export type BenchmarkResult = BenchmarkSummary & {
  name: string;
  group: string;
  status: "ok";
};

/** A loose result/baseline-entry shape accepted by the reporting/comparison helpers: a non-`ok` case may omit the
 * timing fields and instead carry a `reason`, so every metric is optional and `status` is an open string. */
export type BenchmarkResultLike = {
  name: string;
  status: string;
  group?: string;
  iterations?: number;
  totalMs?: number;
  meanMs?: number;
  medianMs?: number;
  minMs?: number;
  maxMs?: number;
  opsPerSec?: number;
  reason?: string | null;
};

export type BenchmarkBaselineDocument = {
  results?: BenchmarkResultLike[];
  note?: string;
  nodeVersion?: string | null;
  generatedAt?: string | null;
};

export type BenchmarkComparison = {
  name: string;
  baseline: number | null;
  current: number | null;
  deltaPct: number | null;
  regressed: boolean;
};

/** A case that cannot be regression-checked, with a human-readable reason (non-`ok` current run or baseline). */
export type UncheckableCase = {
  name: string;
  reason: string;
};

export type RunBenchmarkOptions = {
  iterations?: number;
  warmup?: number;
  now?: () => number;
  group?: string;
};

export type BaselineDocumentMeta = {
  nodeVersion?: string | null;
  generatedAt?: string | null;
};

export declare function roundMetric(value: number): number;

export declare function summarizeDurations(durationsMs: number[]): BenchmarkSummary;

export declare function runBenchmark(
  name: string,
  fn: () => unknown | Promise<unknown>,
  options?: RunBenchmarkOptions,
): Promise<BenchmarkResult>;

export declare function formatBenchmarkReport(results: BenchmarkResultLike[]): string;

export declare function compareToBaseline(
  results: BenchmarkResultLike[],
  baseline: BenchmarkBaselineDocument | null | undefined,
  options?: { tolerance?: number },
): BenchmarkComparison[];

export declare function findUncheckableCases(
  results: BenchmarkResultLike[],
  baseline: BenchmarkBaselineDocument | null | undefined,
): UncheckableCase[];

export declare function renderBaselineDocument(
  results: BenchmarkResultLike[],
  meta?: BaselineDocumentMeta,
): string;
