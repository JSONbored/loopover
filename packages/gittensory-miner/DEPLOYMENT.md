# Gittensory miner deployment

Two form factors for running `@loopover/miner`: **laptop mode** (single machine, zero Docker) and **fleet mode** (containerized workers with a shared data volume). Both are 100% client-side for core operation — the miner never uploads source and never requires a hosted Gittensory callback to boot. Credentials (GitHub tokens, etc.) stay on the operator's machine or in their own secret store; nothing is baked into images.

|                  | Laptop mode                                                                                    | Fleet mode                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Best for**     | One contributor machine, local experimentation                                                 | Many parallel miner attempts on a host or small cluster                           |
| **Dependencies** | Node.js `>=22.13.0` only                                                                       | Docker (or compatible runtime) + Node image or custom image                       |
| **State**        | SQLite files under `~/.config/loopover-miner/` (override with `LOOPOVER_MINER_CONFIG_DIR`) | Same SQLite layout on a mounted `/data` (or `LOOPOVER_MINER_CONFIG_DIR`) volume |
| **Setup**        | `npm install -g @loopover/miner` or workspace build                                | `docker build` + `docker run` with env + volume (see below)                       |
| **Footprint**    | One Node process, local disk for ledgers/queues                                                | One container per worker; scale horizontally by adding containers                 |

## Coding-agent provider configuration

For provider selection and the CLI-specific model/timeout overrides, see
[`README.md`](README.md) and the interface-level contract in
[`docs/coding-agent-driver.md`](docs/coding-agent-driver.md).

## Laptop mode walkthrough

1. Install Node.js 22.13+ and the package:

   ```sh
   npm install -g @loopover/miner@latest
   # or from a checkout:
   npm install && npm --workspace @loopover/miner run build
   ```

2. Inspect what is installed and where local state will live. `status` and `doctor` stay offline; `init --verify-token` is optional and makes one authenticated GitHub call up front:

   ```sh
   loopover-miner status
   loopover-miner doctor
   loopover-miner init --verify-token   # optional: validate GITHUB_TOKEN once before attempts
   loopover-miner init --interactive    # optional: guided prompt for GITHUB_TOKEN + provider, writes a starter .env, then reruns doctor
   ```

   `init --interactive` offers "Authorize with GitHub" (device flow -- visit a URL, enter a short code, no
   token to copy or paste) as its first option once `LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID` is configured for the
   centrally-held `loopover-ams` GitHub App; the original pasted-PAT prompt stays available as option 2, and is
   what the wizard falls back to automatically on any device-flow failure. Unconfigured, the wizard is
   byte-identical to the pasted-token-only prompt. Either way, the resulting `GITHUB_TOKEN` acts as your own
   GitHub account -- there is no separate bot identity; see [`README.md`](README.md) for the credential model.

3. Expected layout after first use (default paths):

   ```text
   ~/.config/loopover-miner/
     laptop-state.sqlite3          # laptop-mode setup state, created by `init`
     portfolio-queue.sqlite3       # prioritized work backlog across tracked repos (#2292)
     claim-ledger.sqlite3          # soft issue claims (#2314)
     plan-store.sqlite3            # persisted MCP plan DAGs (#2318)
     run-state.sqlite3             # per-repo run state (idle/discovering/planning/preparing)
     event-ledger.sqlite3          # append-only miner-loop event audit trail (#2290)
     governor-ledger.sqlite3       # append-only governor allow/deny/throttle decisions (#2328)
     governor-state.sqlite3        # governor cross-attempt counters/state (#5134)
     attempt-log.sqlite3           # per-attempt coding-agent driver event trace (#4294)
     worktree-allocator.sqlite3    # git-worktree-per-attempt allocation bookkeeping (#4297)
     prediction-ledger.sqlite3     # predicted-gate verdicts, for later self-improve scoring (#4263)
     replay-snapshot.sqlite3       # frozen historical-replay target snapshots (#3010)
     policy-doc-cache.sqlite3      # ETag cache for discovery's policy-doc fetches (#4842)
     policy-verdict-cache.sqlite3  # cache of resolved AI-usage-policy verdicts (#4843)
     deny-hook-synthesis.sqlite3   # synthesized PreToolUse deny-hook proposals (#4522)
     orb-export.sqlite3            # opt-in anonymized Orb telemetry export state (#4277)
   ```

   Not every file appears immediately: `laptop-state` is written by `init`, and each of the others is created
   the first time its subsystem actually runs (an attempt, a discovery pass, a replay, an Orb export, …), so a
   fresh install that has only run `status`/`doctor` will show a subset. All sixteen default into this one
   directory. Override the directory for every store at once with `LOOPOVER_MINER_CONFIG_DIR` or
   `XDG_CONFIG_HOME` (same resolution chain as `@loopover/mcp`); every store except `laptop-state.sqlite3`
   (directory only) also honors its own `LOOPOVER_MINER_<NAME>_DB` path override — e.g.
   `LOOPOVER_MINER_PORTFOLIO_QUEUE_DB` — to relocate an individual file. `doctor`'s `store-integrity:*` checks
   report the persistent stores, so it is the quickest way to confirm what exists and is readable on disk.

4. Optional per-repo miner goals: copy [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) to a target repo as `.gittensory-miner.yml`. See [`docs/miner-goal-spec.md`](docs/miner-goal-spec.md).

## Fleet mode walkthrough

Build the fleet image from the **monorepo root** (the Dockerfile needs the full workspace on disk before `npm ci` — see comments in [`Dockerfile`](Dockerfile)):

```sh
docker build -f packages/gittensory-miner/Dockerfile -t loopover-miner:latest .
```

Run a disposable worker with persistent SQLite state on a mounted volume. Inject secrets at runtime (never bake them into the image):

```sh
docker run --rm -it \
  -e LOOPOVER_MINER_CONFIG_DIR=/data/miner \
  -e GITHUB_TOKEN \
  -v miner-data:/data/miner \
  loopover-miner:latest \
  doctor
```

The image entrypoint is `loopover-miner`; pass subcommands after the image name (`status`, `doctor`, `claim`, …).

- **`/data/miner` volume** — holds all SQLite state (`claim-ledger.sqlite3`, `plan-store.sqlite3`, etc.) so containers are disposable. Defaults to `LOOPOVER_MINER_CONFIG_DIR=/data/miner` in the image.
- **`GITHUB_TOKEN`** — supplied by the operator at run time; the image contains no credentials.
- **Scale** — launch additional containers with the same volume (or partitioned config dirs) for parallel attempts.

**Secret-file alternative (`GITHUB_TOKEN_FILE`).** A plain `-e GITHUB_TOKEN` value is visible in plaintext
via `docker inspect`/`docker compose config` and any full-env dump of the running container. For Docker
Swarm/Kubernetes-managed secrets (mounted as a file, e.g. at `/run/secrets/github_token`), set
`GITHUB_TOKEN_FILE` to that mount path instead — the miner reads and trims the file's contents at startup and
uses it exactly as if `GITHUB_TOKEN` had been set directly:

```sh
docker run --rm -it \
  -e LOOPOVER_MINER_CONFIG_DIR=/data/miner \
  -e GITHUB_TOKEN_FILE=/run/secrets/github_token \
  -v miner-data:/data/miner \
  -v /path/to/your/secret:/run/secrets/github_token:ro \
  loopover-miner:latest \
  doctor
```

If both `GITHUB_TOKEN` and `GITHUB_TOKEN_FILE` are set, the plain `GITHUB_TOKEN` value always wins (same
precedence rule as ORB's own `src/selfhost/load-file-secrets.ts`). A missing or unreadable `GITHUB_TOKEN_FILE`
fails the container fast with a clear error naming the file path, rather than silently proceeding with no
credential. The same `<NAME>_FILE` convention works for any credential the miner reads from a plain env var —
not only `GITHUB_TOKEN`.

The repo-root [`docker-compose.yml`](../../docker-compose.yml) documents the **self-hosted review stack** (the `gittensory` API/orb), not the miner CLI. Miners are clients of that stack (or of github.com directly) and do not require it to run locally.

### Docker Compose (fleet mode)

Instead of a hand-assembled `docker run`, [`docker-compose.miner.yml`](docker-compose.miner.yml) defines a long-lived `miner` service (built from this package's Dockerfile, `restart: unless-stopped`, state on a named `miner-data` volume). Credentials come from an env file, never inlined:

```sh
cp .gittensory-miner.env.example .gittensory-miner.env   # fill in GITHUB_TOKEN (+ optional provider keys)
docker compose -f docker-compose.miner.yml up -d --build
```

**Scaling to N parallel workers.** `docker compose -f docker-compose.miner.yml up -d --scale miner=N` gives every replica the **same** `miner-data` volume — and the miner's SQLite ledgers are **not** safe for concurrent access, so N replicas on one volume will contend/corrupt. To run N **isolated** workers, give each its own state: run N separate compose projects (`docker compose -p miner-1 …`, `-p miner-2 …` — `-p` namespaces the volume) or point each at a distinct `LOOPOVER_MINER_CONFIG_DIR` on its own mount. For built-in isolated horizontal scaling, use the Kubernetes StatefulSet in [`k8s/`](../../k8s/) (per-pod volumes).

## Bare-host (systemd, no Docker)

To run the miner continuously on a plain Linux host without Docker, supervise `loopover-miner loop` — the autonomous discover → attempt → manage daemon (#5135) — with systemd. [`systemd/gittensory-miner.service.example`](../../systemd/gittensory-miner.service.example) is a ready-to-adapt persistent unit; its header carries the full install steps:

```sh
npm install -g @loopover/miner
loopover-miner init --verify-token   # optional: validate GITHUB_TOKEN before discovery/attempt runs
sudo cp systemd/gittensory-miner.service.example /etc/systemd/system/gittensory-miner.service
sudo $EDITOR /etc/systemd/system/gittensory-miner.service   # set User / WorkingDirectory / ExecStart / secrets
sudo systemctl daemon-reload
sudo systemctl enable --now loopover-miner.service
```

Because `loop` is a **long-running daemon that schedules its own cycles**, it is a persistent `Type=simple` service (with `Restart=on-failure`) — **not** a oneshot unit driven by a `.timer`, unlike the periodic `loopover-docker-prune.*.example` hygiene job in [`systemd/`](../../systemd/). Keep `GITHUB_TOKEN` (and any coding-agent credentials) in a root-owned `0600` `EnvironmentFile`, never in the unit file. Follow the loop with `journalctl -u loopover-miner -f`; `systemctl stop` sends SIGTERM, which the loop handles cleanly at its next kill-switch check.

Want the dashboard too? [`systemd/gittensory-miner-ui.service.example`](../../systemd/gittensory-miner-ui.service.example) is a companion unit that serves `apps/gittensory-miner-ui` persistently over the same local state — see that app's [README](../../apps/gittensory-miner-ui/README.md#running-as-a-persistent-service).

## Invariants

- Core miner bookkeeping (claims, plans, queues, ledgers) works offline after install.
- `loopover-miner status` and `loopover-miner doctor` make **no network calls**.
- Discovery/ranking primitives that touch GitHub only run when explicitly invoked and only perform documented GETs unless a future command says otherwise.
- Operators own secret injection; images and packages ship without embedded tokens.

See [`docs/operations-runbook.md`](docs/operations-runbook.md) for operational scenarios: ledger corruption, two miners on one state dir, and post-upgrade schema migration ([#4875](https://github.com/JSONbored/gittensory/issues/4875)).

See [`docs/sizing.md`](docs/sizing.md) for measured CPU/RAM/disk numbers for laptop mode vs. fleet mode at
different worker counts, with the exact commands used to reproduce them.

## Optional hosted discovery plane (opt-in)

The Phase 6 **hosted discovery-index** is **off by default** — unlike Orb fleet export (`ORB_AIR_GAP` is the only opt-out). Operators who want cross-fleet metadata queries or soft-claim coordination must opt in explicitly. See [`docs/discovery-plane-operator-guide.md`](docs/discovery-plane-operator-guide.md) ([#4309](https://github.com/JSONbored/gittensory/issues/4309), placeholder until [#4300](https://github.com/JSONbored/gittensory/issues/4300) / [#4301](https://github.com/JSONbored/gittensory/issues/4301) / [#4302](https://github.com/JSONbored/gittensory/issues/4302) ship).
