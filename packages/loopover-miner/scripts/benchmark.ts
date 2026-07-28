#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { rankCandidateIssues } from "../dist/lib/opportunity-ranker.js";
import { initPortfolioQueueStore } from "../dist/lib/portfolio-queue.js";

// Committed micro-benchmark for the two hot local paths that have no other way to notice a regression: the
// discovery fan-out ranking pass (opportunity-ranker.js, run once per repo per discovery cycle over every open
// candidate) and the local-store read/write path (portfolio-queue.js, run on every enqueue/claim). Neither is
// covered by the request-latency instrumentation the coding-agent driver already has, since both are purely
// synchronous/local. See BENCHMARKS.md (#4845) for how to run this and read the numbers.

export const DEFAULT_CANDIDATE_COUNT = 500;
export const DEFAULT_QUEUE_OPERATION_COUNT = 500;
export const DEFAULT_ITERATIONS = 5;

const LABEL_POOL = ["good first issue", "help wanted", "bug", "gittensor:feature", "visual"];
const SYNTHETIC_EPOCH_MS = Date.UTC(2024, 0, 1);

/**
 * Deterministic synthetic candidate generator: every field is derived from `i` alone, never `Math.random()` or
 * `Date.now()`, so `buildSyntheticCandidates(n)` returns byte-identical input on every call/machine/run -- the
 * benchmark's numbers are comparable across runs precisely because its input never varies.
 */
export function buildSyntheticCandidates(count) {
  const candidates = [];
  for (let i = 0; i < count; i += 1) {
    const timestamp = new Date(SYNTHETIC_EPOCH_MS + i * 3_600_000).toISOString();
    candidates.push({
      repoFullName: `bench-owner/bench-repo-${i % 7}`,
      issueNumber: i + 1,
      title: `Synthetic benchmark issue #${i + 1}`,
      labels: [LABEL_POOL[i % LABEL_POOL.length]],
      commentsCount: i % 11,
      createdAt: timestamp,
      updatedAt: timestamp,
      htmlUrl: `https://github.com/bench-owner/bench-repo-${i % 7}/issues/${i + 1}`,
      aiPolicyAllowed: i % 5 !== 0,
      aiPolicySource: i % 5 === 0 ? "AI-USAGE.md" : "none",
    });
  }
  return candidates;
}

function timeMs(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Rank the same synthetic candidate set `iterations` times and report the median wall time (#4845). */
export function runRankingBenchmark(options = {}) {
  const candidateCount = options.candidateCount ?? DEFAULT_CANDIDATE_COUNT;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const candidates = buildSyntheticCandidates(candidateCount);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    samples.push(timeMs(() => rankCandidateIssues(candidates, { nowMs: SYNTHETIC_EPOCH_MS })));
  }
  const medianMs = median(samples);
  return {
    name: "discovery-fanout-ranking",
    unitCount: candidateCount,
    iterations,
    medianMs,
    opsPerSecond: candidateCount / (medianMs / 1000),
  };
}

/**
 * Enqueue then dequeue `operationCount` items against a fresh in-memory store, `iterations` times, and report
 * the median wall time -- the same read/write path every real enqueue/claim exercises against the on-disk file,
 * minus filesystem I/O, so the number isolates the query-plan/schema cost this package actually controls.
 */
export function runLocalStoreBenchmark(options = {}) {
  const operationCount = options.operationCount ?? DEFAULT_QUEUE_OPERATION_COUNT;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const store = initPortfolioQueueStore(":memory:");
    try {
      samples.push(
        timeMs(() => {
          for (let n = 0; n < operationCount; n += 1) {
            store.enqueue({
              repoFullName: `bench-owner/bench-repo-${n % 7}`,
              identifier: `issue-${n}`,
              priority: n % 100,
            });
          }
          for (let n = 0; n < operationCount; n += 1) {
            store.dequeueNext();
          }
        }),
      );
    } finally {
      store.close();
    }
  }
  const medianMs = median(samples);
  return {
    name: "local-store-read-write",
    unitCount: operationCount * 2,
    iterations,
    medianMs,
    opsPerSecond: (operationCount * 2) / (medianMs / 1000),
  };
}

/** Render benchmark results as a stable, greppable text report (no locale-dependent number formatting). */
export function formatBenchmarkReport(results) {
  const lines = ["loopover-miner benchmark", ""];
  for (const result of results) {
    lines.push(
      `${result.name}: median ${result.medianMs.toFixed(2)}ms over ${result.iterations} runs, ` +
        `${Math.round(result.opsPerSecond)} ops/sec (n=${result.unitCount})`,
    );
  }
  return lines.join("\n");
}

function main() {
  const results = [runRankingBenchmark(), runLocalStoreBenchmark()];
  console.log(formatBenchmarkReport(results));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
