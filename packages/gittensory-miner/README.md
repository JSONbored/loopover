# @jsonbored/gittensory-miner

Foundation CLI for the local Gittensory miner runtime.

This package is the future home of the autonomous discover → analyze → plan → prepare → create → manage miner workflow. In this foundation phase it provides the package scaffold, a local laptop-mode bootstrap (`init` + `doctor`), and a non-blocking npm registry version nudge on startup.

## Status

Current scope is intentionally small:

- workspace package wiring
- CLI entry point
- laptop-mode bootstrap for a zero-infra local config dir + SQLite state file
- `--help` and `version` commands
- startup npm version nudge (override with `--no-update-check` or `GITTENSORY_MINER_NO_UPDATE_CHECK=1`)

Real miner commands land in follow-up issues.

The package also includes the first metadata-only discovery primitive: `fetchCandidateIssues` lists open issue
metadata across target repos, and `searchCandidateIssues` does the same from a GitHub issue-search query. Both
paths hard-skip repos whose `AI-USAGE.md` or `CONTRIBUTING.md` explicitly bans AI-generated PRs. They perform
GitHub GET requests only, never clone source, never upload source, and never write to GitHub.

The package also includes a metadata-only ranker: `rankCandidateIssues` composes deterministic engine signals
(potential, feasibility, lane fit, freshness, dup risk) and returns fan-out candidates sorted by `rankScore`.
It never clones source and never writes to GitHub.

The package also includes an append-only governor decision ledger: `initGovernorLedger` / `appendGovernorEvent`
persist structured allow/deny/throttle/kill-switch outcomes in local SQLite for contributor audit. Insert-only —
no enforcement wiring yet. (#2328)

## Install

From a local checkout:

```sh
npm install
npm --workspace @jsonbored/gittensory-miner run build
```

Laptop mode from npm:

```sh
npm install -g @jsonbored/gittensory-miner
gittensory-miner init
gittensory-miner doctor
```

`init` bootstraps the local config directory and the SQLite-backed `run-state.sqlite3` file. Path
resolution mirrors the package's other local stores: `GITTENSORY_MINER_CONFIG_DIR`, then
`XDG_CONFIG_HOME`, then `~/.config/gittensory-miner/`. If you need the SQLite file elsewhere, set
`GITTENSORY_MINER_RUN_STATE_DB`; that overrides the DB path only, not the config-dir chain, and
`init` still creates the configured laptop-mode config directory.

## Commands

```sh
gittensory-miner --help
gittensory-miner help
gittensory-miner --version
gittensory-miner version
gittensory-miner init
gittensory-miner doctor
```

`doctor` always reports Docker as informational only and times out quickly if `docker --version`
hangs. Laptop mode never requires Docker, Redis, or Postgres to initialize.

## Version check

On every invocation the CLI starts an async npm registry lookup (5s timeout). When the installed package is behind `@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
