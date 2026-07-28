import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTEMPTS_PER_LEVEL,
  DEFAULT_CONCURRENCY_LEVELS,
  DEFAULT_SIMULATED_DRIVER_LATENCY_MS,
  buildFakeLoadTestDriver,
  formatLoadTestReport,
  runConcurrencyLevel,
  runLoadTest,
} from "../../packages/loopover-engine/scripts/load-test-iterate-loop";

describe("iterate-loop load-test script (#5224)", () => {
  it("the fake driver never spawns a real subprocess and resolves a scripted ok result after the configured latency", async () => {
    const driver = buildFakeLoadTestDriver(5);
    const start = performance.now();
    const result = await driver.run({
      attemptId: "attempt-0",
      workingDirectory: "/tmp/attempt-0",
      acceptanceCriteriaPath: "/tmp/attempt-0/acceptance-criteria.json",
      instructions: "synthetic",
      maxTurns: 1,
    });
    expect(performance.now() - start).toBeGreaterThanOrEqual(4);
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(["src/attempt-0.ts"]);
    expect(result.turnsUsed).toBe(1);
  });

  it("runs a small concurrency level end-to-end and every attempt hands off on its first iteration", async () => {
    const level = await runConcurrencyLevel(4, { attemptCount: 8, latencyMs: 1 });
    expect(level.concurrency).toBe(4);
    expect(level.attemptCount).toBe(8);
    expect(level.latencyMs).toBe(1);
    expect(level.handoffCount).toBe(8);
    expect(Number.isFinite(level.wallMs)).toBe(true);
    expect(level.wallMs).toBeGreaterThan(0);
    expect(Number.isFinite(level.attemptsPerSecond)).toBe(true);
    expect(level.attemptsPerSecond).toBeGreaterThan(0);
  });

  it("runs a concurrency level where the batch size exceeds the attempt count in a single batch", async () => {
    const level = await runConcurrencyLevel(128, { attemptCount: 3, latencyMs: 1 });
    expect(level.attemptCount).toBe(3);
    expect(level.handoffCount).toBe(3);
  });

  it("runs every concurrency level supplied via options.levels, in order", async () => {
    const results = await runLoadTest({ levels: [1, 2], attemptCount: 2, latencyMs: 1 });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.concurrency)).toEqual([1, 2]);
    for (const r of results) expect(r.handoffCount).toBe(2);
  });

  it("exposes the documented default concurrency levels, attempt count, and simulated latency", () => {
    expect(DEFAULT_CONCURRENCY_LEVELS).toEqual([1, 8, 32, 128]);
    expect(DEFAULT_ATTEMPTS_PER_LEVEL).toBe(32);
    expect(DEFAULT_SIMULATED_DRIVER_LATENCY_MS).toBe(15);
  });

  it("renders a deterministic report with no locale-dependent number formatting", () => {
    expect(
      formatLoadTestReport([
        { concurrency: 1, attemptCount: 10, latencyMs: 15, wallMs: 160.4, handoffCount: 10, attemptsPerSecond: 62.34 },
        { concurrency: 8, attemptCount: 10, latencyMs: 15, wallMs: 20.1, handoffCount: 9, attemptsPerSecond: 497.5 },
      ]),
    ).toBe(
      [
        "iterate-loop load test",
        "",
        "concurrency=1: 160.40ms wall for 10 attempts, 62 attempts/sec, 10/10 handed off (simulated driver latency 15ms)",
        "concurrency=8: 20.10ms wall for 10 attempts, 498 attempts/sec, 9/10 handed off (simulated driver latency 15ms)",
      ].join("\n"),
    );
  });

  it("runs end-to-end as a CLI script and prints the report header plus every default concurrency level", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "packages/loopover-engine/scripts/load-test-iterate-loop.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("iterate-loop load test");
    for (const level of DEFAULT_CONCURRENCY_LEVELS) {
      expect(result.stdout).toContain(`concurrency=${level}:`);
    }
  });
});
