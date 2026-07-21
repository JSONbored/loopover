import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONCURRENCY_LEVELS,
  DEFAULT_ORIGIN,
  DEFAULT_PATH,
  DEFAULT_REQUESTS_PER_LEVEL,
  DEFAULT_TIMEOUT_MS,
  formatLoadTestReport,
  percentile,
  requestOnce,
  runConcurrencyLevel,
  runLoadTest,
} from "../../scripts/load-test-worker.js";

describe("worker load-test script (#4913)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requestOnce reports a successful response's status and a non-negative elapsed time", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const result = await requestOnce("http://127.0.0.1:8787/health", { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/health",
      expect.objectContaining({ headers: { "user-agent": "loopover-load-test" } }),
    );
  });

  it("requestOnce reports a non-2xx response as not ok without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    const result = await requestOnce("http://127.0.0.1:8787/v1/mcp/compatibility", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
  });

  it("requestOnce reports a thrown fetch error (e.g. connection refused) as ok:false with status:null, not a rejection", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await requestOnce("http://127.0.0.1:8787/health", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("requestOnce aborts and reports failure once the timeout elapses", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = await requestOnce("http://127.0.0.1:8787/health", { fetchImpl, timeoutMs: 5 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
  });

  it("percentile returns 0 for an empty array without dividing by zero", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });

  it("percentile picks the nearest-rank value from a sorted copy without mutating the input", () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(50);
    expect(values).toEqual([50, 10, 40, 20, 30]);
  });

  it("runConcurrencyLevel batches requests, aggregates successes/errors, and computes latency percentiles", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // Every third request fails, so successCount/errorCount are both exercised on a single level.
      return new Response(null, { status: call % 3 === 0 ? 500 : 200 });
    });
    const level = await runConcurrencyLevel(4, {
      requestCount: 9,
      path: "/health",
      fetchImpl,
    });
    expect(level.concurrency).toBe(4);
    expect(level.requestCount).toBe(9);
    expect(level.path).toBe("/health");
    expect(level.successCount).toBe(6);
    expect(level.errorCount).toBe(3);
    expect(Number.isFinite(level.wallMs)).toBe(true);
    expect(level.wallMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(level.requestsPerSecond)).toBe(true);
    expect(level.p50Ms).toBeGreaterThanOrEqual(0);
    expect(level.p95Ms).toBeGreaterThanOrEqual(level.p50Ms);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it("runConcurrencyLevel handles a batch size that exceeds the request count in a single batch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const level = await runConcurrencyLevel(128, { requestCount: 3, fetchImpl });
    expect(level.requestCount).toBe(3);
    expect(level.successCount).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("runConcurrencyLevel reports 0/0 p50/p95 when every request errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const level = await runConcurrencyLevel(2, { requestCount: 2, fetchImpl });
    expect(level.successCount).toBe(0);
    expect(level.errorCount).toBe(2);
    expect(level.p50Ms).toBe(0);
    expect(level.p95Ms).toBe(0);
  });

  it("runLoadTest runs every concurrency level supplied via options.levels, in order, against the given origin/path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const results = await runLoadTest({
      levels: [1, 2],
      requestCount: 2,
      origin: "http://example.test",
      path: "/health",
      fetchImpl,
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.concurrency)).toEqual([1, 2]);
    for (const r of results) {
      expect(r.successCount).toBe(2);
      expect(r.path).toBe("/health");
    }
    expect(fetchImpl).toHaveBeenCalledWith("http://example.test/health", expect.anything());
  });

  it("exposes the documented defaults", () => {
    expect(DEFAULT_ORIGIN).toBe("http://127.0.0.1:8787");
    expect(DEFAULT_PATH).toBe("/health");
    expect(DEFAULT_CONCURRENCY_LEVELS).toEqual([1, 8, 32, 128]);
    expect(DEFAULT_REQUESTS_PER_LEVEL).toBe(64);
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
  });

  it("renders a deterministic report with no locale-dependent number formatting", () => {
    expect(
      formatLoadTestReport([
        {
          concurrency: 1,
          requestCount: 10,
          path: "/health",
          wallMs: 160.4,
          successCount: 10,
          errorCount: 0,
          requestsPerSecond: 62.34,
          p50Ms: 12.345,
          p95Ms: 20.5,
        },
        {
          concurrency: 8,
          requestCount: 10,
          path: "/health",
          wallMs: 20.1,
          successCount: 9,
          errorCount: 1,
          requestsPerSecond: 497.5,
          p50Ms: 3.1,
          p95Ms: 6,
        },
      ]),
    ).toBe(
      [
        "worker load test",
        "",
        "concurrency=1 path=/health: 160.40ms wall for 10 requests, 62 req/sec, 10/10 ok (p50 12.35ms, p95 20.50ms)",
        "concurrency=8 path=/health: 20.10ms wall for 10 requests, 498 req/sec, 9/10 ok (p50 3.10ms, p95 6.00ms)",
      ].join("\n"),
    );
  });

  it("runs end-to-end as a CLI script against an unreachable origin, reporting connection failures instead of crashing", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/load-test-worker.ts",
        "--origin",
        "http://127.0.0.1:1",
        "--levels",
        "1",
        "--requests-per-level",
        "1",
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("worker load test");
    expect(result.stdout).toContain("concurrency=1 path=/health:");
    expect(result.stdout).toContain("0/1 ok");
  });
});
