# @jsonbored/gittensory-miner

Foundation CLI for the local Gittensory miner runtime.

This package is the future home of the autonomous discover → analyze → plan → prepare → create → manage miner workflow. In this foundation phase it provides the package scaffold, a minimal CLI surface for `--help` and `--version`, and a non-blocking npm registry version nudge on startup.

## Status

Current scope is intentionally small:

- workspace package wiring
- CLI entry point
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

See [`docs/miner-goal-spec.md`](docs/miner-goal-spec.md) for the `.gittensory-miner.yml` field reference and [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) at the repo root.

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for laptop vs fleet deployment.

### Laptop-mode quickstart

Zero-infra local install — no Docker, Redis, or Postgres required:

```sh
npm install -g @jsonbored/gittensory-miner
gittensory-miner init
gittensory-miner doctor
gittensory-miner status
```

`init` creates `~/.config/gittensory-miner/` (or `GITTENSORY_MINER_CONFIG_DIR` / `XDG_CONFIG_HOME` overrides) and a local `laptop-state.sqlite3` bootstrap file. Re-running `init` is idempotent. `doctor` reports Node, the state directory, SQLite readiness, and whether Docker is installed (informational only).

From a local checkout:

```sh
npm install
npm --workspace @jsonbored/gittensory-miner run build
```

## Commands

```sh
gittensory-miner --help
gittensory-miner help
gittensory-miner --version
gittensory-miner version
gittensory-miner init [--json]
gittensory-miner status [--json]
gittensory-miner doctor [--json]
```

## Version check

On every invocation the CLI starts an async npm registry lookup (5s timeout). When the installed package is behind `@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
