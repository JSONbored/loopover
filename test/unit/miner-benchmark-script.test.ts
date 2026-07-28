import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANDIDATE_COUNT,
  DEFAULT_QUEUE_OPERATION_COUNT,
  buildSyntheticCandidates,
  formatBenchmarkReport,
  runLocalStoreBenchmark,
  runRankingBenchmark,
} from "../../packages/loopover-miner/scripts/benchmark";

describe("loopover-miner benchmark script (#4845)", () => {
  it("REGRESSION: synthetic candidate generation is byte-for-byte deterministic across calls", () => {
    expect(buildSyntheticCandidates(50)).toEqual(buildSyntheticCandidates(50));
  });

  it("generates exactly the requested candidate count with valid ranker input shape", () => {
    const candidates = buildSyntheticCandidates(12);
    expect(candidates).toHaveLength(12);
    for (const candidate of candidates) {
      expect(candidate.repoFullName).toMatch(/^bench-owner\/bench-repo-\d$/);
      expect(Number.isInteger(candidate.issueNumber)).toBe(true);
      expect(candidate.issueNumber).toBeGreaterThan(0);
      expect(typeof candidate.title).toBe("string");
      expect(Array.isArray(candidate.labels)).toBe(true);
    }
  });

  it("runs the discovery fan-out ranking benchmark and reports a positive, finite result", () => {
    const result = runRankingBenchmark({ candidateCount: 20, iterations: 2 });
    expect(result.name).toBe("discovery-fanout-ranking");
    expect(result.unitCount).toBe(20);
    expect(result.iterations).toBe(2);
    expect(Number.isFinite(result.medianMs)).toBe(true);
    expect(result.medianMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.opsPerSecond)).toBe(true);
    expect(result.opsPerSecond).toBeGreaterThan(0);
  });

  it("runs the local-store read/write benchmark and reports a positive, finite result", () => {
    const result = runLocalStoreBenchmark({ operationCount: 20, iterations: 2 });
    expect(result.name).toBe("local-store-read-write");
    expect(result.unitCount).toBe(40);
    expect(result.iterations).toBe(2);
    expect(Number.isFinite(result.medianMs)).toBe(true);
    expect(result.medianMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.opsPerSecond)).toBe(true);
    expect(result.opsPerSecond).toBeGreaterThan(0);
  });

  it("falls back to the documented default counts when no options are passed", () => {
    const ranking = runRankingBenchmark();
    const localStore = runLocalStoreBenchmark();
    expect(ranking.unitCount).toBe(DEFAULT_CANDIDATE_COUNT);
    expect(localStore.unitCount).toBe(DEFAULT_QUEUE_OPERATION_COUNT * 2);
  });

  it("renders a deterministic report with no locale-dependent number formatting", () => {
    expect(
      formatBenchmarkReport([
        { name: "discovery-fanout-ranking", unitCount: 500, iterations: 5, medianMs: 12.345, opsPerSecond: 40501.6 },
        { name: "local-store-read-write", unitCount: 1000, iterations: 5, medianMs: 8, opsPerSecond: 125000 },
      ]),
    ).toBe(
      [
        "loopover-miner benchmark",
        "",
        "discovery-fanout-ranking: median 12.35ms over 5 runs, 40502 ops/sec (n=500)",
        "local-store-read-write: median 8.00ms over 5 runs, 125000 ops/sec (n=1000)",
      ].join("\n"),
    );
  });

  it("runs end-to-end as a CLI script and prints both benchmark lines", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "packages/loopover-miner/scripts/benchmark.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("loopover-miner benchmark");
    expect(result.stdout).toContain("discovery-fanout-ranking:");
    expect(result.stdout).toContain("local-store-read-write:");
  });
});
