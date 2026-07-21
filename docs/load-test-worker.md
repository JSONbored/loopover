# worker load test

A committed load-testing harness for the root Cloudflare Worker's HTTP endpoints (`src/api/routes.ts`).
Every existing test under `test/workers/` and `test/integration/` is correctness-oriented and drives the
Worker in-process (`worker.fetch(request, env, ctx)` directly, per `test/workers/worker-runtime.test.ts`)
— no real HTTP layer, no real concurrency semantics. This harness issues real `fetch()` requests against
a separately-running Worker instance and reports wall-clock throughput/latency per concurrency level. See
issue #4913; `packages/loopover-engine/docs/iterate-loop-load-test.md` (#5224) is the AMS-side counterpart
this mirrors.

## Running it

Start the Worker in one terminal:

```sh
npm run dev
# Ready on http://127.0.0.1:8787
```

Then, in another terminal:

```sh
npm run loadtest:worker
# or with explicit flags:
node --experimental-strip-types scripts/load-test-worker.ts --origin http://127.0.0.1:8787 --path /health --levels 1,8,32,128 --requests-per-level 64
```

This prints a short text report to stdout and exits `0`. It does not fail the build or a CI job on its
own — it is a signal to read, not a hard gate (there is no fixed pass/fail threshold, since wall-clock
timing on a shared machine is too noisy to gate on reliably). Run it locally before/after a change to
`src/api/routes.ts` or its middleware (`src/auth/rate-limit.ts`, CORS/auth gating) to see whether the
change moved the needle under concurrency.

## What it measures

Each concurrency level issues a configured number of real HTTP `GET` requests against `${origin}${path}`,
`concurrency` requests in flight at a time (batched via `Promise.all`, batches run sequentially so one
level's connection contention never bleeds into the next), and reports wall-clock throughput plus p50/p95
latency across the successful requests. Non-2xx responses and connection errors/timeouts are counted
separately (`errorCount`) rather than aborting the batch — how a route degrades under load is itself part
of what this tool measures.

- **Concurrency levels:** 1, 8, 32, 128 concurrent requests.
- **Requests per level:** 64.
- **Default target:** `GET /health` — the one route explicitly exempt from both the `RATE_LIMITER`
  Durable Object and the CORS-credential gate (`src/api/routes.ts`'s rate-limit middleware short-circuits
  `c.req.path === "/health"` before `enforceRateLimit` runs), so it can be hammered at any concurrency
  without every request collapsing into `429`s from the shared per-IP rate-limit bucket a single-machine
  local run would otherwise produce against any other route. Point `--path` at another public,
  unauthenticated route (e.g. `/openapi.json`, `/v1/mcp/compatibility`) to measure a CPU-bound handler
  instead — expect `errorCount` to climb well before `/health`'s does, since those routes are rate-limited
  at 120 requests/60s per IP.

## Baseline (informational only, machine-dependent)

Captured on a Linux x86_64 dev container, Node.js 22.21.0, against a local `npm run dev` instance
(`GET /health`, 64 requests per level). Absolute numbers vary by hardware and by what else is running on
the machine — use this as a rough sense of scale, not a target:

```
worker load test

concurrency=1 path=/health: 354.69ms wall for 64 requests, 180 req/sec, 64/64 ok (p50 4.13ms, p95 7.60ms)
concurrency=8 path=/health: 419.84ms wall for 64 requests, 152 req/sec, 64/64 ok (p50 16.45ms, p95 131.20ms)
concurrency=32 path=/health: 139.87ms wall for 64 requests, 458 req/sec, 64/64 ok (p50 47.71ms, p95 72.89ms)
concurrency=128 path=/health: 248.75ms wall for 64 requests, 257 req/sec, 64/64 ok (p50 212.24ms, p95 238.08ms)
```

A second run against the same local instance immediately after produced comparable numbers (same order of
magnitude, 64/64 ok at every level, latency growing with concurrency as expected):

```
worker load test

concurrency=1 path=/health: 517.57ms wall for 64 requests, 124 req/sec, 64/64 ok (p50 4.92ms, p95 21.45ms)
concurrency=8 path=/health: 212.28ms wall for 64 requests, 301 req/sec, 64/64 ok (p50 16.46ms, p95 45.48ms)
concurrency=32 path=/health: 212.10ms wall for 64 requests, 302 req/sec, 64/64 ok (p50 73.91ms, p95 121.00ms)
concurrency=128 path=/health: 144.74ms wall for 64 requests, 442 req/sec, 64/64 ok (p50 82.06ms, p95 132.22ms)
```

`/health` never returned a non-2xx or errored response at any concurrency level in either run, confirming
the rate-limit exemption holds under load. Latency grows with concurrency (local single-process `wrangler
dev` has one event loop and one Durable Object namespace serving every request; a real deployed edge
Worker distributes concurrent requests across many isolates and points of presence, so production latency
under equivalent concurrency is expected to scale differently than this single-instance local measurement).
