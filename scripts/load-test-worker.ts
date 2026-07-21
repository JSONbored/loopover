#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

// Load-testing harness for the Worker's key HTTP endpoints (#4913): every existing test under test/workers and
// test/integration is correctness-oriented and drives the Worker in-process (worker.fetch(request, env, ctx)
// directly, per test/workers/worker-runtime.test.ts) -- no real HTTP layer, no real concurrency semantics. This
// harness issues real fetch() requests against a separately-running Worker instance (start one first with
// `npm run dev`, which serves http://127.0.0.1:8787 by default) and reports wall-clock throughput/latency per
// concurrency level. See docs/load-test-worker.md for how to run this and read the numbers, and
// packages/loopover-engine/docs/iterate-loop-load-test.md (#5224) for the AMS-side counterpart this mirrors.
//
// Defaults to GET /health: the one route explicitly exempt from both the RATE_LIMITER Durable Object and the
// CORS-credential gate (src/api/routes.ts's rate-limit middleware short-circuits `c.req.path === "/health"`
// before enforceRateLimit runs), so it can be hammered at any concurrency without every request collapsing into
// 429s from the shared per-IP rate-limit bucket a single-machine local run would otherwise produce against any
// other route. --path can target another public route; non-2xx and errored responses are counted and reported
// per level rather than treated as a hard script failure, since how a route degrades under load is itself part
// of what this tool measures.

// Deliberately not `typeof fetch`: the global fetch type (in a Cloudflare Workers-typed environment) is
// overloaded to accept URL/RequestInfo/CfProperties, which a plain vi.fn() mock typed against a simple
// (url: string, init?) shape can't satisfy under strict function-type checking. requestOnce only ever calls
// fetchImpl with a string URL and a plain {signal, headers} init, so this narrower shape is both what's
// actually used and what test mocks can trivially implement.
export type LoadTestFetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export type RequestOnceOptions = {
  fetchImpl?: LoadTestFetch;
  timeoutMs?: number;
};

export type RequestOnceResult = {
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  error?: string;
};

export type LoadTestOptions = {
  origin?: string;
  path?: string;
  levels?: number[];
  requestCount?: number;
  fetchImpl?: LoadTestFetch;
  timeoutMs?: number;
};

export type LoadTestLevelResult = {
  concurrency: number;
  requestCount: number;
  path: string;
  wallMs: number;
  successCount: number;
  errorCount: number;
  requestsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
};

export const DEFAULT_ORIGIN = "http://127.0.0.1:8787";
export const DEFAULT_PATH = "/health";
export const DEFAULT_CONCURRENCY_LEVELS = [1, 8, 32, 128];
export const DEFAULT_REQUESTS_PER_LEVEL = 64;
export const DEFAULT_TIMEOUT_MS = 20_000;

/** One GET request against `url`, using an injectable `fetchImpl` (defaults to global fetch) so tests can stub
 *  the network entirely. Never throws: a connection error or an aborted timeout is reported in the same shape a
 *  real HTTP response would be (`ok: false`, `status: null`), so one bad request never aborts its batch. */
export async function requestOnce(url: string, options: RequestOnceOptions = {}): Promise<RequestOnceResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "loopover-load-test" },
    });
    return { ok: response.ok, status: response.status, elapsedMs: performance.now() - start };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** The p-th percentile (0-100) of `values` via nearest-rank on a sorted copy. Returns 0 for an empty input so a
 *  level with zero successful requests reports a well-defined (not NaN) latency. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)]!;
}

/**
 * Run `requestCount` GET requests against `${origin}${path}` in batches of `concurrency` in flight at a time
 * (`Promise.all` per batch, batches run sequentially), and report aggregate wall time, throughput, error count,
 * and latency percentiles. Batching (rather than firing all `requestCount` requests in one `Promise.all`) keeps
 * each level's in-flight connection count bounded to `concurrency`, matching what "N concurrent users" means.
 */
export async function runConcurrencyLevel(concurrency: number, options: LoadTestOptions = {}): Promise<LoadTestLevelResult> {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const path = options.path ?? DEFAULT_PATH;
  const requestCount = options.requestCount ?? DEFAULT_REQUESTS_PER_LEVEL;
  const url = `${origin}${path}`;

  const start = performance.now();
  const outcomes: RequestOnceResult[] = [];
  for (let batchStart = 0; batchStart < requestCount; batchStart += concurrency) {
    const batchSize = Math.min(concurrency, requestCount - batchStart);
    const batch = await Promise.all(Array.from({ length: batchSize }, () => requestOnce(url, options)));
    outcomes.push(...batch);
  }
  const wallMs = performance.now() - start;
  const successes = outcomes.filter((o) => o.ok);
  const latencies = successes.map((o) => o.elapsedMs);

  return {
    concurrency,
    requestCount,
    path,
    wallMs,
    successCount: successes.length,
    errorCount: outcomes.length - successes.length,
    requestsPerSecond: requestCount / (wallMs / 1000),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
  };
}

/** Run every concurrency level in `levels` in sequence (never overlapping each other), so one level's connection
 *  contention never bleeds into the next level's measurement. */
export async function runLoadTest(options: LoadTestOptions = {}): Promise<LoadTestLevelResult[]> {
  const levels = options.levels ?? DEFAULT_CONCURRENCY_LEVELS;
  const results: LoadTestLevelResult[] = [];
  for (const concurrency of levels) {
    results.push(await runConcurrencyLevel(concurrency, options));
  }
  return results;
}

/** Render load-test results as a stable, greppable text report (no locale-dependent number formatting). */
export function formatLoadTestReport(results: readonly LoadTestLevelResult[]): string {
  const lines = ["worker load test", ""];
  for (const r of results) {
    lines.push(
      `concurrency=${r.concurrency} path=${r.path}: ${r.wallMs.toFixed(2)}ms wall for ${r.requestCount} requests, ` +
        `${Math.round(r.requestsPerSecond)} req/sec, ${r.successCount}/${r.requestCount} ok ` +
        `(p50 ${r.p50Ms.toFixed(2)}ms, p95 ${r.p95Ms.toFixed(2)}ms)`,
    );
  }
  return lines.join("\n");
}

type ParsedArgs = {
  origin: string;
  path: string;
  levels: number[];
  requestCount: number;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    origin: DEFAULT_ORIGIN,
    path: DEFAULT_PATH,
    levels: DEFAULT_CONCURRENCY_LEVELS,
    requestCount: DEFAULT_REQUESTS_PER_LEVEL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--origin") args.origin = argv[++i]!;
    else if (flag === "--path") args.path = argv[++i]!;
    else if (flag === "--requests-per-level") args.requestCount = Number(argv[++i]);
    else if (flag === "--levels") args.levels = argv[++i]!.split(",").map(Number);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = await runLoadTest({
    origin: args.origin,
    path: args.path,
    levels: args.levels,
    requestCount: args.requestCount,
  });
  console.log(formatLoadTestReport(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
