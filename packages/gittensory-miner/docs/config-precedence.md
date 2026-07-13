# Miner config precedence

AMS does **not** have a single `config.js` resolver. Configuration is layered by concern across several modules under `packages/gittensory-miner/lib/` and `@jsonbored/gittensory-engine`. This document states the order each layer **actually implements today** — not an idealized or corrected order.

## Configuration layers

| Layer | Source | Scope | Typical modules |
| --- | --- | --- | --- |
| **Per-target-repo file** | `.gittensory-miner.yml` (or `.github/gittensory-miner.yml`, JSON variants) | One cloned target repo | `lib/miner-goal-spec.js`, engine `parseMinerGoalSpecContent` |
| **Operator env** | `GITTENSORY_MINER_*` / `MINER_*` | This miner process / fleet container | `lib/local-store.js`, `lib/governor-kill-switch.js`, `lib/attempt-cli.js`, … |
| **CLI flags** | `gittensory-miner <cmd> …` argv | One invocation | `lib/attempt-cli.js`, `lib/discover-cli.js`, `lib/loop-cli.js`, … |
| **Operator file (not goal spec)** | `~/.config/gittensory-miner/.gittensory-ams.yml` | Operator execution policy | `lib/ams-policy.js` |

`.gittensory-miner.yml` is **maintainer-authored in the target repo**. Operator env and CLI flags are **never overridden by a target repo's goal spec** for operator-owned policy (see `lib/ams-policy.js` header).

## `.gittensory-miner.yml` file discovery

First existing file wins (engine `MINER_GOAL_SPEC_FILENAMES`):

1. `.gittensory-miner.yml`
2. `.github/gittensory-miner.yml`
3. `.gittensory-miner.json`
4. `.github/gittensory-miner.json`

## Precedence by concern

### Kill switch (halt miner writes)

**Sources:** `GITTENSORY_MINER_KILL_SWITCH` (operator env) and `.gittensory-miner.yml` → `killSwitch.paused`.

**Order (safest wins, engine `resolveMinerKillSwitch`):**

1. Global env halt → scope `"global"` (always reported even when the repo yml also pauses).
2. Else per-repo yml `killSwitch.paused: true` → scope `"repo"`.
3. Else → scope `"none"`.

There is **no CLI flag** for kill-switch today. `MINER_CODING_AGENT_PAUSED` is a separate axis (coding-agent spawn only) and does not change kill-switch scope.

### Governor live write mode

**Sources:** `GITTENSORY_MINER_LIVE_MODE=live` (operator env) and `.gittensory-miner.yml` → `execution.liveModeOptIn: live`.

**Order (engine `resolveMinerActionMode`):**

1. Kill switch active → `"paused"` (overrides any live opt-in).
2. Else **both** operator env **and** repo yml must equal the exact string `"live"` → `"live"`.
3. Else → `"dry_run"`.

This is an **AND** requirement, not “last writer wins”. Either side missing or malformed → dry-run.

There is **no CLI flag wired to governor live mode** today. `attempt --live` / `loop --live` affect coding-agent spawn mode only (below).

### Coding-agent execution mode (spawn the driver?)

**Sources:** `MINER_CODING_AGENT_PAUSED` (operator env) and `attempt|loop --live` (CLI, per invocation).

**Order (engine `resolveCodingAgentExecutionMode`, wired in `lib/attempt-cli.js`):**

1. Global env pause (`MINER_CODING_AGENT_PAUSED` truthy) → `"paused"`.
2. Else CLI `--live` absent → `agentDryRun: true` → `"dry_run"` (`attempt-cli.js` enforces dry-run default for #2342).
3. Else CLI `--live` present → `"live"`.

There is **no `.gittensory-miner.yml` field** for coding-agent mode today.

### Discover forge credential env var name

**Sources:** `discover --token-env <VAR>` (CLI), programmatic `options.tokenEnv`, forge default (`GITHUB_TOKEN`).

**Order (`lib/discover-cli.js`):**

1. CLI `--token-env`
2. Else programmatic `options.tokenEnv`
3. Else `resolveForgeConfig(...).tokenEnvVar` (default `GITHUB_TOKEN`)

There is **no `.gittensory-miner.yml` forge block** today; `--api-base-url` follows the same CLI → programmatic → default shape for the API host.

### Local SQLite store paths

**Sources:** per-store `GITTENSORY_MINER_*_DB` env var, then `GITTENSORY_MINER_CONFIG_DIR`, then XDG default (`lib/local-store.js`).

Explicit per-store env **wins** over config dir; config dir **wins** over XDG. No CLI or goal-spec override.

## Known gaps / inconsistencies

- **No unified precedence** across yml + env + CLI for a single knob — each concern owns its resolver.
- **Live execution** spans two independent gates: coding-agent `--live` (spawn) vs governor env+yml (writes). Both must allow live for a full live open-pr attempt.
- **Forge tenant overrides** (`--api-base-url`, `--token-env`) are CLI/programmatic only; `.gittensory-miner.yml` cannot set them yet.
- **Operator AMS policy** (`.gittensory-ams.yml`) is separate from per-repo goal spec; goal spec never overrides operator policy.

If a future change adds yml or CLI for a setting documented here as env-only, update this file and extend `test/unit/miner-config-precedence.test.ts`.

## See also

- [`miner-goal-spec.md`](miner-goal-spec.md) — goal-spec field reference
- [`env-reference.md`](env-reference.md) — generated operator env list
- ORB `.loopover.yml` (or legacy `.gittensory.yml`, #4773) precedence (`yml > DB > defaults`) in the main app — analogous documentation style, different runtime
