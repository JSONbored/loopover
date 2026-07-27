import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  DEFAULT_RATE_LIMIT_HIGH_WATER_MARK,
  DEFAULT_RATE_LIMIT_LOW_WATER_MARK,
  resolveThrottledConcurrency,
} from "../../packages/loopover-miner/lib/discovery-throttle";
import {
  fetchCandidateIssuesWithSummary,
  mapWithConcurrency,
} from "../../packages/loopover-miner/lib/opportunity-fanout";

const instant = async () => {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveThrottledConcurrency (#4844)", () => {
  const LOW = DEFAULT_RATE_LIMIT_LOW_WATER_MARK; // 50
  const HIGH = DEFAULT_RATE_LIMIT_HIGH_WATER_MARK; // 250

  it("runs at full concurrency when the remaining budget is unknown", () => {
    expect(resolveThrottledConcurrency(5, null, LOW, HIGH)).toBe(5);
    expect(resolveThrottledConcurrency(5, Number.NaN, LOW, HIGH)).toBe(5);
  });

  it("serializes to a single request at or below the low-water mark", () => {
    expect(resolveThrottledConcurrency(5, LOW, LOW, HIGH)).toBe(1); // exactly at the mark
    expect(resolveThrottledConcurrency(5, 10, LOW, HIGH)).toBe(1); // well below
  });

  it("runs at full concurrency at or above the high-water mark", () => {
    expect(resolveThrottledConcurrency(5, HIGH, LOW, HIGH)).toBe(5); // exactly at the mark
    expect(resolveThrottledConcurrency(5, 5000, LOW, HIGH)).toBe(5); // well above
  });

  it("scales linearly through the low→high band", () => {
    // midpoint of 50..250 is 150 → fraction 0.5 → ceil(0.5 * 5) = 3
    expect(resolveThrottledConcurrency(5, 150, LOW, HIGH)).toBe(3);
    // just above the low-water mark → the smallest non-serialized step, 1
    expect(resolveThrottledConcurrency(5, 51, LOW, HIGH)).toBe(1);
    // near the high-water mark → close to full
    expect(resolveThrottledConcurrency(5, 240, LOW, HIGH)).toBe(5);
  });

  it("honors custom water marks", () => {
    expect(resolveThrottledConcurrency(4, 100, 100, 200)).toBe(1); // at custom low
    expect(resolveThrottledConcurrency(4, 150, 100, 200)).toBe(2); // custom midpoint → ceil(0.5*4)
  });
});

describe("mapWithConcurrency dynamic in-flight cap (#4844)", () => {
  it("never exceeds the live limit and still processes every item", async () => {
    let active = 0;
    let peak = 0;
    const worker = async (item: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    };
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 5, worker, () => 1, instant);
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(1); // limit of 1 ⇒ fully serialized despite a pool of 5
  });

  it("tapers as the live limit drops mid-run", async () => {
    let active = 0;
    let peak = 0;
    let limit = 4;
    const worker = async (item: number) => {
      active += 1;
      peak = Math.max(peak, active);
      if (item === 0) limit = 1; // the budget craters after the first item completes
      await Promise.resolve();
      active -= 1;
      return item;
    };
    const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 4, worker, () => limit, instant);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("parks on the real timer when no sleep function is injected", async () => {
    let active = 0;
    let peak = 0;
    const worker = async (item: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return item;
    };
    // No sleepFn ⇒ the park falls back to the built-in setTimeout-based delay.
    const results = await mapWithConcurrency([1, 2, 3], 3, worker, () => 1);
    expect(results).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });
});

describe("discovery fanout throttling wiring (#4844)", () => {
  const API = "https://api.test";

  function lowBudgetFetch(remaining: string) {
    return async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) {
        return Response.json({}, { status: 404, headers: { "x-ratelimit-remaining": remaining } });
      }
      if (url.includes("/issues?")) {
        return Response.json([{ number: 1, title: "t", html_url: `${url}#1` }], {
          headers: { "x-ratelimit-remaining": remaining, "x-ratelimit-reset": "1800000000" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
  }

  it("completes a multi-target run under a low remaining budget without erroring", async () => {
    vi.stubGlobal("fetch", lowBudgetFetch("5")); // below the 50 low-water mark ⇒ serialized
    const targets = Array.from({ length: 6 }, (_, i) => ({ owner: "acme", repo: `r${i}` }));
    const result = await fetchCandidateIssuesWithSummary(targets, "", {
      apiBaseUrl: API,
      concurrency: 4,
      sleepFn: instant,
    });
    expect(result.warnings).toEqual([]);
    expect(result.rateLimitRemaining).toBe(5);
    expect(result.issues).toHaveLength(6); // every target still fetched, just throttled
  });
});
