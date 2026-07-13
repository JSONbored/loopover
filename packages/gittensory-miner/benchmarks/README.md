# gittensory-miner benchmarks (#4845)

A small, committed micro-benchmark suite so a future change to the miner has a baseline to compare against — is
discovery/claiming getting faster or slower? It covers the two hot paths the issue names: the **discovery fanout**
and the **local-store read/write** path.

## Run it

```sh
npm run miner:bench                     # human table, compared to the committed baseline
npm run miner:bench -- --json           # machine-readable results
npm run miner:bench -- --iterations 500 # more samples for a steadier number
npm run miner:bench -- --update-baseline# regenerate benchmarks/baseline.json on THIS machine
npm run miner:bench -- --check          # exit non-zero if any case regressed > tolerance (default 25%) or is uncheckable
```

The script itself lives at [`../scripts/benchmark.mjs`](../scripts/benchmark.mjs); the pure timing/stats/report
helpers are in [`../scripts/benchmark-harness.mjs`](../scripts/benchmark-harness.mjs) (unit-tested in
`test/unit/miner-benchmark-harness.test.ts`).

## Cases

| Case | Group | What it measures |
| --- | --- | --- |
| `discovery_throttle_resolve` | discovery-fanout | the rate-limit-aware concurrency decision the fanout re-evaluates every worker iteration (#4844) |
| `forge_config_resolve` | discovery-fanout | per-fanout forge-config resolution (#4784) |
| `http_retry_passthrough` | discovery-fanout | the per-request retry wrapper every fanout fetch goes through (#4829) |
| `discovery_fanout_scheduler` | discovery-fanout | the real bounded-concurrency scheduler that drives the fanout over many repos |
| `local_store_write` | local-store | one `appendEvent` per iteration against a temp SQLite event ledger |
| `local_store_read` | local-store | `readEvents` over a 500-row temp SQLite event ledger |

The last three exercise library code that needs the package's own runtime (**Node >= 22.13** — `node:sqlite` for the
stores, and the engine's JSON import attributes that the fanout pulls in). On an older Node they are recorded as
`unavailable` rather than crashing the run, and the lighter fanout-internal cases still produce real numbers.

## The baseline

[`baseline.json`](baseline.json) is a committed snapshot. **The numbers are only comparable within the same
runtime** (Node version, CPU) — they are a relative regression signal, not an absolute spec. Regenerate it on your
own machine/CI with `--update-baseline` before relying on `--check`. Because timing is inherently machine-dependent,
`--check` is intended for on-demand/local use and is deliberately **not** wired into the required CI gate.

**Known gap — committed baseline is Node-18-generated.** The committed `baseline.json` was captured on Node
v18.19.1, below the package's own **Node >= 22.13** requirement, so the three runtime-dependent cases
(`discovery_fanout_scheduler`, `local_store_write`, `local_store_read`) are recorded as `unavailable` rather than
real numbers. A non-`ok` baseline case carries no regression signal, so `--check` now **fails loudly** on any such
case (rather than silently passing it) and tells you to regenerate. Run `npm run miner:bench -- --update-baseline`
on Node >= 22.13 to capture all six cases as `ok` and commit the refreshed snapshot.
