# Miner config precedence

AMS does **not** have a single `config.js` resolver. Configuration is layered by concern across several modules under `packages/loopover-miner/lib/` and `@loopover/engine`. This document states the order each layer **actually implements today** — not an idealized or corrected order.

## Configuration layers

| Layer | Source | Scope | Typical modules |
| --- | --- | --- | --- |
| **Per-target-repo file** | `.loopover-miner.yml` (or `.github/loopover-miner.yml`, JSON variants) | One cloned target repo | `lib/miner-goal-spec.js`, engine `parseMinerGoalSpecContent` |
| **Operator env** | `LOOPOVER_MINER_*` / `MINER_*` | This miner process / fleet container | `lib/local-store.js`, `lib/governor-kill-switch.js`, `lib/attempt-cli.js`, … |
| **CLI flags** | `loopover-miner <cmd> …` argv | One invocation | `lib/attempt-cli.js`, `lib/discover-cli.js`, `lib/loop-cli.js`, … |
| **Operator file (not goal spec)** | `~/.config/loopover-miner/.loopover-ams.yml` | Operator execution policy | `lib/ams-policy.js` |

`.loopover-miner.yml` is **maintainer-authored in the target repo**. Operator env and CLI flags are **never overridden by a target repo's goal spec** for operator-owned policy (see `lib/ams-policy.js` header).

## `.loopover-miner.yml` file discovery

First existing file wins (engine `MINER_GOAL_SPEC_FILENAMES`):

1. `.loopover-miner.yml`
2. `.github/loopover-miner.yml`
3. `.loopover-miner.json`
4. `.github/loopover-miner.json`

## Precedence by concern

### Kill switch (halt miner writes)

**Sources:** `LOOPOVER_MINER_KILL_SWITCH` (operator env) and `.loopover-miner.yml` → `killSwitch.paused`.

**Order (safest wins, engine `resolveMinerKillSwitch`):**

1. Global env halt → scope `"global"` (always reported even when the repo yml also pauses).
2. Else per-repo yml `killSwitch.paused: true` → scope `"repo"`.
3. Else → scope `"none"`.

There is **no CLI flag** for kill-switch today. `MINER_CODING_AGENT_PAUSED` is a separate axis (coding-agent spawn only) and does not change kill-switch scope.

### Governor live write mode

**Sources:** `LOOPOVER_MINER_LIVE_MODE=live` (operator env) and `.loopover-miner.yml` → `execution.liveModeOptIn: live`.

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

There is **no `.loopover-miner.yml` field** for coding-agent mode today.

### Discover forge credential env var name

**Sources:** `discover --token-env <VAR>` (CLI), programmatic `options.tokenEnv`, forge default (`GITHUB_TOKEN`).

**Order (`lib/discover-cli.js`):**

1. CLI `--token-env`
2. Else programmatic `options.tokenEnv`
3. Else `resolveForgeConfig(...).tokenEnvVar` (default `GITHUB_TOKEN`)

There is **no `.loopover-miner.yml` forge block** today; `--api-base-url` follows the same CLI → programmatic → default shape for the API host.

### GitHub token value (git operations, #6116)

**Sources:** `GITHUB_TOKEN` (operator env), a `loopover-mcp login` session recorded in the `loopover-mcp` config file (`~/.config/loopover/config.json` by default), programmatic `options.githubToken`.

**Order (`lib/github-token-resolution.js`'s `resolveGitHubToken`, called once at the top of each CLI entrypoint — `loop`, `attempt`, `init --verify-token`, `manage poll` — then threaded down explicitly to every real GitHub caller):**

1. Caller-supplied `options.githubToken` (an explicit override passed programmatically) wins outright.
2. Else `GITHUB_TOKEN` env — an existing self-host operator's PAT setup keeps working unchanged, no filesystem or network access.
3. Else a live token fetched from the authenticated `loopover-mcp login` session (`POST /v1/auth/github/token`, cached in memory for the process's lifetime; a failed fetch is not cached, so a later call retries rather than staying stuck).
4. Else `null` — the caller's own existing "no token" failure mode applies (git operations requiring auth fail the same way they did before this feature existed).

This is a distinct concern from "Discover forge credential env var name" above, which resolves the *name* of an env var to read, not the token *value* itself; `discover --token-env` is unaffected by this section.

### Local SQLite store paths

**Sources:** per-store `LOOPOVER_MINER_*_DB` env var, then `LOOPOVER_MINER_CONFIG_DIR`, then XDG default (`lib/local-store.js`).

Explicit per-store env **wins** over config dir; config dir **wins** over XDG. No CLI or goal-spec override.

## Known gaps / inconsistencies

- **No unified precedence** across yml + env + CLI for a single knob — each concern owns its resolver.
- **Live execution** spans two independent gates: coding-agent `--live` (spawn) vs governor env+yml (writes). Both must allow live for a full live open-pr attempt.
- **Forge tenant overrides** (`--api-base-url`, `--token-env`) are CLI/programmatic only; `.loopover-miner.yml` cannot set them yet.
- **Operator AMS policy** (`.loopover-ams.yml`) is separate from per-repo goal spec; goal spec never overrides operator policy.

If a future change adds yml or CLI for a setting documented here as env-only, update this file and extend `test/unit/miner-config-precedence.test.ts`.

## See also

- [`miner-goal-spec.md`](miner-goal-spec.md) — goal-spec field reference
- [`env-reference.md`](env-reference.md) — generated operator env list
- ORB `.loopover.yml` precedence (`yml > DB > defaults`) in the main app — analogous documentation style, different runtime
