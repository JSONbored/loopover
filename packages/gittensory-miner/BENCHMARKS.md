# loopover-miner benchmarks

A small, committed micro-benchmark for the two purely local, synchronous hot paths that have no other signal
for a future regression: the discovery fan-out ranking pass and the local-store (SQLite) read/write path.
Neither makes a network call or touches a real GitHub repo — both run against deterministic synthetic input,
so the numbers are comparable across runs on the same machine.

## Running it

```sh
npm run benchmark:miner
# or, from a workspace checkout:
npm --workspace @loopover/miner run benchmark
```

This prints a short text report to stdout and exits `0`. It does not fail the build or a CI job on its own —
it is a signal to read, not a hard gate (there is no fixed pass/fail threshold, since wall-clock timing on
shared CI runners is too noisy to gate on reliably). Run it locally before/after a change to `opportunity-ranker.js`,
`opportunity-fanout.js`, or the SQLite store layer (`local-store.js`, `portfolio-queue.js`, and friends) to see
whether the change moved the needle.

## What it measures

- **`discovery-fanout-ranking`** — `rankCandidateIssues()` (`lib/opportunity-ranker.js`) over 500 synthetic
  candidates, the pure ranking pass discovery runs once per repo per cycle over every open candidate.
- **`local-store-read-write`** — 500 `enqueue()` calls followed by 500 `dequeueNext()` calls against a fresh
  in-memory (`:memory:`) `portfolio-queue.js` store, the same prepared-statement read/write path every real
  enqueue/claim exercises on disk, minus filesystem I/O — isolating the query-plan/schema cost this package
  actually controls.

Each benchmark repeats its work 5 times and reports the **median** wall time, to smooth over GC pauses and
other one-off scheduling noise rather than reporting a single potentially-unlucky sample.

## Baseline (informational only, machine-dependent)

Captured on a Linux x86_64 dev container, Node.js 22.21.0. Absolute numbers vary by hardware — use this as a
rough sense of scale, not a target:

```
loopover-miner benchmark

discovery-fanout-ranking: median ~42ms over 5 runs, ~11,800 ops/sec (n=500)
local-store-read-write: median ~38ms over 5 runs, ~26,400 ops/sec (n=1000)
```
