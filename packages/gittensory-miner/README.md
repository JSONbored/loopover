# @jsonbored/gittensory-miner

Foundation CLI for the local Gittensory miner runtime.

This package is the future home of the autonomous discover → analyze → plan → prepare → create → manage miner workflow. In this foundation phase it provides the package scaffold, a minimal CLI surface for `--help` and `--version`, and a non-blocking npm registry version nudge on startup.

## Status

Current scope is intentionally small:

- workspace package wiring
- CLI entry point
- `--help` and `version` commands
- startup npm version nudge (override with `--no-update-check` or `GITTENSORY_MINER_NO_UPDATE_CHECK=1`)

Environment variables read by the miner are documented in [`docs/env-reference.md`](docs/env-reference.md).
Regenerate that file with `npm run miner:env-reference` from the repo root after adding or removing env reads.

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

The package also includes a local soft-claim ledger: `openClaimLedger` / `claimIssue` / `releaseClaim` /
`listActiveClaims` persist which issues this miner instance has claimed on this machine. The table is local
bookkeeping only — duplicate winners are adjudicated elsewhere via `@jsonbored/gittensory-engine`. (#2291)

The package also includes an append-only event ledger: `initEventLedger` / `appendEvent` / `readEvents` persist
immutable miner-loop events in local SQLite for contributor audit. Insert-only — rows are never updated or
deleted. (#2322)

The package also records local PR outcomes: `recordPrOutcomeSnapshot` / `readPrOutcomes` write and reduce the
miner's OWN record of the outcomes of its OWN PRs (merged / closed, with an optional rejection-reason bucket) over
the append-only event ledger above. This is DISTINCT from the gittensory server's `recordPrOutcome`
(`src/review/outcomes-wire.ts`), which writes hosted-backend audit rows from the GitHub App's webhook stream — same
concept name, different codebase layer, no shared code (a laptop-mode miner may have no webhook relay at all). (#4274)

The package also includes an append-only prediction ledger: `initPredictionLedger` / `appendPrediction` /
`readPredictions` persist each predicted-gate verdict (conclusion / pack / readiness score + blocker/warning
codes, plus the producing `ENGINE_VERSION`) in local SQLite, so a later self-improve pass can score predictions
against realized outcomes. Insert-only. (#4263)

`gittensory-miner manage status` now also folds each tracked repo's current discover/plan/prepare run state
(`run-state.js`) alongside its managed PR rows into a "run portfolio" view — `collectRunPortfolio` /
`renderRunPortfolioTable` — so a repo actively being discovered or planned shows up even with zero PRs yet.
Additive only: the existing `rows` JSON key and PR table are unchanged; `runPortfolio` is a new key printed
after the existing table. A real GUI dashboard surface is out of scope here — `apps/gittensory-miner-ui/` is
Phase 6 of the same roadmap tracker and hasn't been scaffolded yet. (#4279)

## Local storage

Four independent local SQLite stores back the commands above. Each keeps its own file, its own table, and its own
env-var override — this is a DRY pass over their shared path-resolution/open boilerplate (`local-store.js`), not a
merge into one database. (#4272)

| Store | File | Table | Module | Env var override |
| --- | --- | --- | --- | --- |
| Run state | `run-state.sqlite3` | `miner_run_state` | `run-state.js` | `GITTENSORY_MINER_RUN_STATE_DB` |
| Claim ledger | `claim-ledger.sqlite3` | `miner_claims` | `claim-ledger.js` | `GITTENSORY_MINER_CLAIM_LEDGER_DB` |
| Portfolio queue | `portfolio-queue.sqlite3` | `miner_portfolio_queue` | `portfolio-queue.js` | `GITTENSORY_MINER_PORTFOLIO_QUEUE_DB` |
| Event ledger | `event-ledger.sqlite3` | `miner_event_ledger` | `event-ledger.js` | `GITTENSORY_MINER_EVENT_LEDGER_DB` |

Every store resolves its file the same way: the store-specific env var above, else `GITTENSORY_MINER_CONFIG_DIR`,
else `XDG_CONFIG_HOME` (falling back to `~/.config`), joined with `gittensory-miner/<file>`. Every store also opens
its file with `0700`/`0600` permissions and a shared `PRAGMA busy_timeout` so two instances on the same file
serialize writes instead of racing.

The "PR portfolio" `manage status` renders is currently a **read-time join**, not a dedicated table:
`collectManageStatus` reads `portfolio-queue.js` rows (via the `pr:{number}` identifier convention) and joins them
against `event-ledger.js`'s free-form `manage_pr_update` JSON events at query time, on every read. Decision: keep
this as a read-time join for now; revisit a dedicated indexed table only if/when PR-portfolio reads become frequent
enough (e.g. a live-polling dashboard) that the per-read linear event-ledger scan becomes a measured bottleneck.

## Install

See [`docs/miner-goal-spec.md`](docs/miner-goal-spec.md) for the `.gittensory-miner.yml` field reference and [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) at the repo root.

See [`docs/cross-repo-discovery-phase1.md`](docs/cross-repo-discovery-phase1.md) for the Phase 1 cross-repo discovery scope (re-scoped from [#1060](https://github.com/JSONbored/gittensory/issues/1060), paper trail for [#2299](https://github.com/JSONbored/gittensory/issues/2299)).

See [`docs/discovery-plane-operator-guide.md`](docs/discovery-plane-operator-guide.md) for the optional hosted discovery-index plane (opt-in default OFF; contrasts with Orb's opt-out-only export — [#4309](https://github.com/JSONbored/gittensory/issues/4309)).

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for laptop vs fleet deployment.

See [`docs/operations-runbook.md`](docs/operations-runbook.md) for SQLite concurrency guarantees, corruption recovery, multi-process collision response, and post-upgrade ledger migration ([#4875](https://github.com/JSONbored/gittensory/issues/4875)).

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
npm link --workspace @jsonbored/gittensory-miner
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
gittensory-miner manage status [--json]
gittensory-miner manage poll <owner/repo> <pr#> [--branch <name>] [--json]
```

## MCP server

The package ships a second bin entry, `gittensory-miner-mcp`, a minimal [Model Context Protocol](https://modelcontextprotocol.io) stdio server that any MCP-compatible client can connect to:

```sh
gittensory-miner-mcp
```

It exposes these read-only tools:

- `gittensory_miner_ping` (#5153) — a health check returning a static `{ "status": "ok", "tool": "gittensory_miner_ping" }` object. Reads no AMS state, takes no arguments.
- `gittensory_miner_get_portfolio_dashboard` (#5155) — the per-repo portfolio-queue backlog dashboard: status counts (queued / in_progress / done), totals, and the oldest-queued age. Wraps `collectPortfolioDashboard()` (no new logic) — the same data `gittensory-miner queue dashboard --json` prints locally. Read-only, takes no arguments.
- `gittensory_miner_list_claims` (#5156) — lists the local claim ledger (repo, issue number, status, claimed-at, note) via `listClaims()`. Optional `repoFullName` / `status` filters pass through to the query. Read-only — exposes no claim/release mutation.
- `gittensory_miner_get_audit_feed` (#5158) — read-only, metadata-only event-ledger audit feed (`eventType`, `repoFullName`, `outcome`, `actor`, `detail`, `createdAt`). Wraps `collectEventLedgerAuditFeed()` with the same filters as `gittensory-miner ledger list` (`--repo`, `--since`, `--type`). Never returns `payload_json` or other raw ledger columns.

- `gittensory_miner_get_run_state` (#5160) — read-only per-repo run-state (`idle` / `discovering` / `planning` / `preparing`) via `getRunState` / `listRunStates`. Pass `repoFullName` for one repo (a null state means none recorded yet), or omit it to list all. The read-only analog of ORB's `gittensory_get_automation_state`; adds no state-set mutation.

- `gittensory_miner_list_plans` / `gittensory_miner_get_plan` (#5161) — read-only access to the persisted plan store (`planId`, plan DAG, status, `updatedAt`) via `listPlans` / `loadPlan`; `list_plans` takes an optional `status` filter, `get_plan` takes a `planId` and returns an explicit `{ planId, found: false }` for an unknown id. These read the store-backed AMS plan store — distinct from ORB's stateless `gittensory_plan_status` tool.

- `gittensory_miner_get_governor_decisions` (#5159) — read-only projection of the governor decision log (`id`, `ts`, `eventType`, `repoFullName`, `actionClass`, `decision`, `reason`), optionally filtered by `repoFullName`. The projection **excludes the sensitive `payload_json` column by construction** — `governor-ledger.js` reads it with an explicit named-column SELECT, never `SELECT *`.

- `gittensory_miner_status` (#5154) — read-only status + doctor diagnostics, returning `{ status, doctor }`: `status` = package/engine versions (and skew), node version, state-dir + config-file paths, and the resolved coding-agent driver (provider name, the model **env-var NAME** never its value, CLI-present boolean); `doctor` = the checks `gittensory-miner doctor` runs (Docker/CLI presence, config validity, …) as `{ name, ok, detail }`. Reuses `collectStatus` / `runDoctorChecks` so it can't drift from the CLI, and returns only names / booleans / paths — never any env-var value, token, or credential.

This completes the read-only AMS MCP tool surface (status, portfolio, claims, event-ledger, governor-ledger, run-state, plan-store).

## Version check

On every invocation the CLI starts an async npm registry lookup (5s timeout). When the installed package is behind `@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
