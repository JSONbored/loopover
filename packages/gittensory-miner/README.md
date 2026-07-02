# @jsonbored/gittensory-miner

Foundation CLI for the local Gittensory miner runtime.

This package is the future home of the autonomous discover → analyze → plan → prepare → create → manage miner workflow. In this foundation phase it provides the package scaffold, a minimal CLI surface for `--help` and `--version`, and a non-blocking npm registry version nudge on startup.

## Status

Current scope is intentionally small:

- workspace package wiring
- CLI entry point
- `--help` and `version` commands
- `init` and `doctor` laptop-mode bootstrap commands
- startup npm version nudge (override with `--no-update-check` or `GITTENSORY_MINER_NO_UPDATE_CHECK=1`)

Real miner commands land in follow-up issues.

## Install

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
gittensory-miner init
gittensory-miner doctor
gittensory-miner doctor --json
```

## Laptop Mode Quickstart

```sh
npm install -g @jsonbored/gittensory-miner
gittensory-miner init
gittensory-miner doctor
```

The CLI uses a local SQLite state file with no Docker/Redis/Postgres requirement:

- config dir: `GITTENSORY_MINER_CONFIG_DIR`, else `XDG_CONFIG_HOME/gittensory-miner`, else `~/.config/gittensory-miner`
- state file: `<config-dir>/state.sqlite3`

## Version check

On every invocation the CLI starts an async npm registry lookup (5s timeout). When the installed package is behind `@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
