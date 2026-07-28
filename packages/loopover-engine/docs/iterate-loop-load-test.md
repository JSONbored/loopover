# iterate-loop load test

A committed load-testing harness for `runIterateLoop` (`src/miner/iterate-loop.ts`), the create->score->
self-review->decide orchestrator AMS runs once per attempt. It reuses the same `CodingAgentDriver`
injection seam `iterate-loop.test.ts` already exercises — the driver never spawns a real subprocess or
spends API budget — but adds a configurable artificial per-iteration delay, so the numbers below measure
iterate-loop's own orchestration/scheduling overhead under concurrent, multi-tenant-like load rather than a
network call's latency. See issue #4913 for the parallel Worker-endpoint load-testing precedent this
mirrors; #5224 is the AMS-side counterpart this harness was built for.

## Running it

```sh
npm run loadtest:iterate-loop
# or, from a workspace checkout, after building the engine:
npm --workspace @loopover/engine run build
node --experimental-strip-types packages/loopover-engine/scripts/load-test-iterate-loop.ts
```

This prints a short text report to stdout and exits `0`. It does not fail the build or a CI job on its own
— it is a signal to read, not a hard gate (there is no fixed pass/fail threshold, since wall-clock timing
on shared CI runners is too noisy to gate on reliably). Run it locally before/after a change to
`iterate-loop.ts`, `iterate-policy.ts`, `attempt-metering.ts`, or `self-review-adapter.ts` to see whether
the change moved the needle under concurrency.

## What it measures

Each concurrency level runs a batch of simulated tenant attempts (a distinct `repoFullName`/
`contributorLogin` per attempt, mirroring how independent tenants share the same AMS infra) through
`runIterateLoop`, `concurrency` attempts in flight at a time via `Promise.all`, until the configured
attempt count for that level completes. Every attempt is scripted to hand off after exactly one iteration
(a passing self-review verdict on the first try), so the wall-clock numbers isolate the loop's own
per-attempt overhead — driver invocation, self-review, policy decision, attempt-log append — from any
variation in how many iterations a real attempt would take.

- **Concurrency levels:** 1, 8, 32, 128 concurrent attempts.
- **Attempts per level:** 32 (script default) / 64 (baseline capture below).
- **Simulated driver latency:** 15ms per iteration — a stand-in for the wall-clock a real coding-agent
  subprocess invocation would take, without actually spending any real API budget or spawning a process.

## Baseline (informational only, machine-dependent)

Captured on a Linux x86_64 dev container, Node.js 22.23.1, 64 attempts per level. Absolute numbers vary by
hardware and by real driver/self-review latency — use this as a rough sense of scale and of how throughput
scales with concurrency, not a target:

```
iterate-loop load test

concurrency=1: 1023.87ms wall for 64 attempts, 63 attempts/sec, 64/64 handed off (simulated driver latency 15ms)
concurrency=8: 151.74ms wall for 64 attempts, 422 attempts/sec, 64/64 handed off (simulated driver latency 15ms)
concurrency=32: 65.20ms wall for 64 attempts, 982 attempts/sec, 64/64 handed off (simulated driver latency 15ms)
concurrency=128: 40.59ms wall for 64 attempts, 1577 attempts/sec, 64/64 handed off (simulated driver latency 15ms)
```

Throughput scales roughly linearly with concurrency up to the point where the batch size matches (or
exceeds) the attempt count per level — at that point every attempt starts in the same tick and the
per-attempt overhead is fully parallelized, bounded only by the simulated driver latency plus the loop's own
synchronous work per attempt. This is execution/measurement only against the existing, already-injectable
driver seam; it does not change `runIterateLoop`'s own concurrency model. These numbers feed the per-tenant
scheduling and queue-fairness design work in the AMS Cloud Readiness milestone — reference them there rather
than re-measuring.
