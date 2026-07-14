# loopover-miner resource sizing

Real, measured CPU/RAM/disk numbers for laptop mode and fleet mode, so an operator can size a host or
cluster from data instead of guessing. Neither the operational-runbook issue nor the local-stores
documentation commits to this — this doc is scoped strictly to the numbers and how they were captured.

## Measurement environment

- Linux x86_64 sandbox, 4 vCPU, 9.5 GiB RAM.
- Node.js 24 (the version the [`Dockerfile`](../Dockerfile) builds on; the host running the laptop-mode
  measurements below used the repo's own pinned Node 22.13+ requirement).
- Absolute numbers are host-dependent — treat these as a rough sense of scale, not a hard target. Re-run the
  exact commands below on your own hardware for numbers specific to it.

## Workload measured

Both modes measure `loopover-miner init` (laptop mode only) followed by `loopover-miner discover
<owner/repo> [<owner/repo>...] --json` against real, small public repositories (`octocat/Hello-World`,
`octocat/Spoon-Knife`) with **no `GITHUB_TOKEN`** — real, unauthenticated GitHub GET requests, metadata
fan-out + deterministic ranking, no writes.

**Deliberately excluded: a live `attempt` cycle.** Sizing a real coding-agent attempt would need an
operator-supplied `GITHUB_TOKEN` and coding-agent CLI credentials, and creates a real branch/PR against a real
target repository — not something to spend for a resource-sizing exercise, and not reproducible by a reviewer
without supplying their own credentials. `discover` is measured instead because it is the dominant,
always-run, network- and CPU-bound phase every mode exercises identically; `attempt`'s resource profile is
dominated by the operator's chosen coding-agent CLI process, not by anything this package controls.

## Methodology

- **Laptop mode CPU/RAM**: GNU `/usr/bin/time -v` around the CLI process directly (no container).
- **Laptop mode disk**: `du -sh`/`du -ah` on the resolved `LOOPOVER_MINER_CONFIG_DIR` after the run.
- **Fleet mode CPU/RAM**: `docker stats --no-stream` polled once per second per container while each worker
  ran `discover` followed by a `sleep` tail (so short-lived containers stay observable long enough to sample);
  the reported number is the peak observed sample per container.
- **Fleet mode disk**: `du -sh`/`du -ah` on each worker's mounted `/data/miner` volume after the run, via a
  disposable `alpine` container mounting the same named volume.
- **N=4 isolation**: per `docker-compose.miner.yml`'s own documented warning, N replicas sharing one volume
  corrupt/contend on the SQLite ledgers — so N=4 here means **four separate named volumes** (`docker run -d -v
  miner-n<i>:/data/miner ...` per worker), the same isolation pattern the compose file itself recommends, not
  a single shared-volume `--scale`.

### Exact commands (laptop mode)

```sh
LOOPOVER_MINER_CONFIG_DIR=/tmp/sizing-laptop /usr/bin/time -v \
  node packages/gittensory-miner/bin/loopover-miner.js init --json

LOOPOVER_MINER_CONFIG_DIR=/tmp/sizing-laptop /usr/bin/time -v \
  node packages/gittensory-miner/bin/loopover-miner.js discover octocat/Hello-World --dry-run --json

du -sh /tmp/sizing-laptop
```

### Exact commands (fleet mode, N=1 shown; N=4 repeats the `docker run` with 4 distinct names/volumes)

```sh
docker build -f packages/gittensory-miner/Dockerfile -t loopover-miner:sizing .

docker volume create miner-sizing-1
docker run -d --name miner-sizing-1 -v miner-sizing-1:/data/miner --entrypoint sh loopover-miner:sizing \
  -c "loopover-miner discover octocat/Hello-World octocat/Spoon-Knife --json > /tmp/out.json 2>&1; sleep 20"

for i in $(seq 1 20); do
  docker stats --no-stream --format '{{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}' miner-sizing-1
done

docker run --rm -v miner-sizing-1:/data alpine du -ah /data
```

## Results

| Mode | Workers | Peak CPU | Peak RAM | Disk (per worker) | Environment |
| --- | --- | --- | --- | --- | --- |
| Laptop (`init`) | 1 | 125% (short burst, Node startup) | 74 MB | — | Sandbox above |
| Laptop (`discover`, 1 repo, 90 issues) | 1 | 16% (network-bound) | 98 MB | 100 KB (5 SQLite files after `init` + `discover`) | Sandbox above |
| Fleet (Docker, `discover`, 2 repos) | 1 | 54% (short burst) | 46 MB | 92 KB (4 SQLite files) | Sandbox above, `loopover-miner:sizing` image (333 MB) |
| Fleet (Docker, `discover`, 2 repos) | 4 (isolated volumes) | 5–38% per worker (bursts did not line up across workers) | 34–45 MB per worker | 92 KB per worker (368 KB total across 4 isolated volumes) | Sandbox above |

**Takeaways:**

- `discover`'s CPU cost is dominated by waiting on GitHub's API, not local computation — laptop mode measured
  16% CPU utilization over a 5.6s wall-clock run.
- Per-worker memory (46 MB for fleet mode, 74–98 MB for the laptop-mode CLI process) did not measurably change
  between N=1 and N=4 — each worker is an independent Node process with no shared heap, so four isolated
  workers cost roughly 4× one worker's footprint, not more.
- Local SQLite disk usage is small (under 100 KB per worker for this workload) and grows with the number of
  distinct stores a command touches, not with fan-out volume — `discover` alone never touches the larger
  per-attempt stores (`attempt-log.sqlite3`, `worktree-allocator.sqlite3`, etc.), which only grow once real
  attempts run.
- The 333 MB fleet image is dominated by the Node 24 base image and `node_modules`; `npm prune --omit=dev` in
  the Dockerfile already strips dev dependencies from the runtime stage.

See [`DEPLOYMENT.md`](../DEPLOYMENT.md) for the laptop-mode and fleet-mode setup walkthroughs these numbers
apply to, and [`docs/operations-runbook.md`](operations-runbook.md) for operational scenarios beyond initial
sizing.
