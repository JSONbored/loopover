import { describe, expect, it } from "vitest";

import {
  durationSeconds,
  percentile,
  summarize,
} from "../../scripts/ci-duration-report.js";

// #7456: percentile/summarize/durationSeconds are the non-obvious pure logic in ci-duration-report.ts
// (a specific nearest-rank percentile with a floor clamp; a summarize() that excludes `cancelled` runs from
// both the duration set and the failure-rate denominator, while treating `skipped` as a success). Importing
// the module must not trigger its live-fetch driver -- the entrypoint guard now keeps that behind `main()`,
// so these imports resolve to just the pure functions.

type Run = { conclusion: string; created_at: string; updated_at: string; event?: string };

function run(conclusion: string, durationMinutes: number): Run {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const updated = new Date(created.getTime() + durationMinutes * 60 * 1000);
  return { conclusion, created_at: created.toISOString(), updated_at: updated.toISOString() };
}

describe("percentile (#7456)", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it("returns the nearest-rank p50 and p95 of a known sorted array", () => {
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
  });

  it("returns the sole element for every percentile of a single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("returns null for an empty array", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });
});

describe("durationSeconds (#7456)", () => {
  it("measures wall-clock span as (updated_at - created_at) in seconds", () => {
    expect(durationSeconds(run("success", 10))).toBe(600);
  });
});

describe("summarize (#7456)", () => {
  it("excludes cancelled runs from count and the failure-rate denominator, but reports them as excludedCancelled", () => {
    const summary = summarize([
      run("success", 10),
      run("failure", 20),
      run("skipped", 5),
      run("cancelled", 99),
      run("cancelled", 1),
    ]);

    // cancelled runs are dropped from the counted set entirely...
    expect(summary.count).toBe(3);
    expect(summary.excludedCancelled).toBe(2);
    // ...and from the failure-rate denominator: 1 failure out of the 3 non-cancelled runs.
    expect(summary.failures).toBe(1);
    expect(summary.failureRate).toBe(1 / 3);
    // durations only reflect the 3 non-cancelled runs (5/10/20 min -> 300/600/1200s).
    expect(summary.p50Seconds).toBe(600);
    expect(summary.p95Seconds).toBe(1200);
  });

  it("treats a skipped run as a success, not a failure", () => {
    const summary = summarize([run("success", 10), run("skipped", 5)]);
    expect(summary.count).toBe(2);
    expect(summary.failures).toBe(0);
    expect(summary.failureRate).toBe(0);
  });

  it("returns a null failureRate and null percentiles for an empty run set", () => {
    const summary = summarize([]);
    expect(summary.count).toBe(0);
    expect(summary.excludedCancelled).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.failureRate).toBeNull();
    expect(summary.p50Seconds).toBeNull();
    expect(summary.p95Seconds).toBeNull();
  });
});
