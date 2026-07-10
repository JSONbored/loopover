# Gittensory miner deployment

Two form factors for running `@jsonbored/gittensory-miner`: **laptop mode** (single machine, zero Docker) and **fleet mode** (containerized workers with a shared data volume). Both are 100% client-side for core operation — the miner never uploads source and never requires a hosted Gittensory callback to boot. Credentials (GitHub tokens, etc.) stay on the operator's machine or in their own secret store; nothing is baked into images.

| | Laptop mode | Fleet mode |
|---|---|---|
| **Best for** | One contributor machine, local experimentation | Many parallel miner attempts on a host or small cluster |
| **Dependencies** | Node.js `>=22.13.0` only | Docker (or compatible runtime) + Node image or custom image |
| **State** | SQLite files under `~/.config/gittensory-miner/` (override with `GITTENSORY_MINER_CONFIG_DIR`) | Same SQLite layout on a mounted `/data` (or `GITTENSORY_MINER_CONFIG_DIR`) volume |
| **Setup** | `npm install -g @jsonbored/gittensory-miner` or workspace build | `docker build` + `docker run` with env + volume (see below) |
| **Footprint** | One Node process, local disk for ledgers/queues | One container per worker; scale horizontally by adding containers |

## Laptop mode walkthrough

1. Install Node.js 22.13+ and the package:

   ```sh
   npm install -g @jsonbored/gittensory-miner@latest
   # or from a checkout:
   npm install && npm --workspace @jsonbored/gittensory-miner run build
   ```

2. Inspect what is installed and where local state will live (no network calls):

   ```sh
   gittensory-miner status
   gittensory-miner doctor
   ```

3. Expected layout after first use (default paths):

   ```text
   ~/.config/gittensory-miner/
     claim-ledger.sqlite3      # soft issue claims (#2314)
     plan-store.sqlite3        # persisted MCP plan DAGs (#2318)
     portfolio-queue.sqlite3   # local portfolio queue
     event-ledger.sqlite3      # manage-loop audit trail
     governor-ledger.sqlite3   # governor decisions
   ```

   Override the directory with `GITTENSORY_MINER_CONFIG_DIR` or `XDG_CONFIG_HOME` (same resolution chain as `@jsonbored/gittensory-mcp`).

4. Optional per-repo miner goals: copy [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) to a target repo as `.gittensory-miner.yml`. See [`docs/miner-goal-spec.md`](docs/miner-goal-spec.md).

## Fleet mode walkthrough

Build the fleet image from the **monorepo root** (the Dockerfile needs the full workspace on disk before `npm ci` — see comments in [`Dockerfile`](Dockerfile)):

```sh
docker build -f packages/gittensory-miner/Dockerfile -t gittensory-miner:latest .
```

Run a disposable worker with persistent SQLite state on a mounted volume. Inject secrets at runtime (never bake them into the image):

```sh
docker run --rm -it \
  -e GITTENSORY_MINER_CONFIG_DIR=/data/miner \
  -e GITHUB_TOKEN \
  -v miner-data:/data/miner \
  gittensory-miner:latest \
  doctor
```

The image entrypoint is `gittensory-miner`; pass subcommands after the image name (`status`, `doctor`, `claim`, …).

- **`/data/miner` volume** — holds all SQLite state (`claim-ledger.sqlite3`, `plan-store.sqlite3`, etc.) so containers are disposable. Defaults to `GITTENSORY_MINER_CONFIG_DIR=/data/miner` in the image.
- **`GITHUB_TOKEN`** — supplied by the operator at run time; the image contains no credentials.
- **Scale** — launch additional containers with the same volume (or partitioned config dirs) for parallel attempts.

The repo-root [`docker-compose.yml`](../../docker-compose.yml) documents the **self-hosted review stack** (the `gittensory` API/orb), not the miner CLI. Miners are clients of that stack (or of github.com directly) and do not require it to run locally.

## Invariants

- Core miner bookkeeping (claims, plans, queues, ledgers) works offline after install.
- `gittensory-miner status` and `gittensory-miner doctor` make **no network calls**.
- Discovery/ranking primitives that touch GitHub only run when explicitly invoked and only perform documented GETs unless a future command says otherwise.
- Operators own secret injection; images and packages ship without embedded tokens.

## Optional hosted discovery plane (opt-in)

The Phase 6 **hosted discovery-index** is **off by default** — unlike Orb fleet export (`ORB_AIR_GAP` is the only opt-out). Operators who want cross-fleet metadata queries or soft-claim coordination must opt in explicitly. See [`docs/discovery-plane-operator-guide.md`](docs/discovery-plane-operator-guide.md) ([#4309](https://github.com/JSONbored/gittensory/issues/4309), placeholder until [#4300](https://github.com/JSONbored/gittensory/issues/4300) / [#4301](https://github.com/JSONbored/gittensory/issues/4301) / [#4302](https://github.com/JSONbored/gittensory/issues/4302) ship).
