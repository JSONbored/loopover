# LoopOver miner deployment

The full deployment guide — laptop mode, fleet mode (Docker build, Compose scaling, secret files,
bridging into `ams-observability`), and bare-host systemd — has moved to the LoopOver docs website:
**[loopover.ai/docs/ams-deployment](https://loopover.ai/docs/ams-deployment)**.

Both laptop mode and fleet mode are 100% client-side for core operation — the miner never uploads
source and never requires a hosted LoopOver callback to boot. `LOOPOVER_MINER_CONFIG_DIR` selects
where state lives in either mode; supported subcommands include `status`, `doctor`, `init`, `loop`.

Quick links:

- [`Dockerfile`](Dockerfile) — fleet-mode image build, run from the monorepo root
- [`docker-compose.yml`](../../docker-compose.yml) — repo-root self-hosted review stack (not the
  miner CLI); `docker-compose.miner.yml` in this package runs the miner itself
- [`k8s/`](../../k8s/) — isolated horizontal scaling via a per-pod StatefulSet
- [`README.md`](README.md#coding-agent-driver-configuration) — coding-agent provider configuration
- [`docs/operations-runbook.md`](docs/operations-runbook.md) — operational scenarios
- [`docs/sizing.md`](docs/sizing.md) — measured CPU/RAM/disk numbers
