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

Config precedence (`.gittensory-miner.yml` vs operator env vs CLI flags) is documented in
[`docs/config-precedence.md`](docs/config-precedence.md).

Real miner commands land in follow-up issues.

The package also includes the first metadata-only discovery primitive: `fetchCandidateIssues` lists open issue
metadata across target repos, and `searchCandidateIssues` does the same from a GitHub issue-search query. Both
paths hard-skip repos whose `AI-USAGE.md` or `CONTRIBUTING.md` explicitly bans AI-generated PRs. They perform
GitHub GET requests only, never clone source, never upload source, and never write to GitHub.

The package also includes a metadata-only ranker: `rankCandidateIssues` composes deterministic engine signals
(potential, feasibility, lane fit, freshness, dup risk) and returns fan-out candidates sorted by `rankScore`.
It never clones source and never writes to GitHub.

Discovery is per-tenant, not github.com-specific (#4784): `lib/forge-config.js` (`resolveForgeConfig`) holds the
forge base URL, API version, request headers, repo path, search endpoint/qualifiers, user-agent, and credential env
var behind one resolver with gittensory's github.com values as the only defaults, so the fan-out targets another
forge unchanged. `gittensory-miner discover` surfaces `--api-base-url <url>` and `--token-env <VAR>` and forwards a
tenant goal spec to the ranker, printing `usedDefaultGoalSpec` so a fall-back to the built-in rubric is explicit
rather than silent. See [`docs/repo-agnostic-capability-audit.md`](docs/repo-agnostic-capability-audit.md) for the
#4780 audit this executes.

The package also includes repo stack auto-detection: `detectRepoStack` (`lib/stack-detection.js`) inspects an
already-cloned target repo's manifest / lockfile / config files and returns a structured description — language,
package manager, and the build / test / lint / format commands — for Node (npm/yarn/pnpm/bun), Python
(pip/poetry/pipenv/uv), Rust, Go, Maven, and Gradle. It is pure (injectable `existsSync` / `readFileSync`), never
throws, and per its acceptance criteria **fails closed** — a repo with no recognized manifest returns
`{ detected: false, reason }` and a command that can't be inferred without guessing stays `null`, rather than being
assumed. Detection only; wiring the description into the attempt prompt is the follow-up ([#4786](https://github.com/JSONbored/gittensory/issues/4786)). (#4785)

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

The package also includes the Phase 7 calibration runner: `runHistoricalReplayCalibrationCycle`
(`lib/calibration-run.js`) scores a completed historical-replay run with the deterministic objective-anchor scorer,
folds the composite into the engine's `computePhase7CalibrationLoop` combine alongside the existing `pr_outcome`
signal, and persists the combined snapshot as a `calibration_snapshot` event — queryable with
`gittensory-miner ledger list --type calibration_snapshot` or `readCalibrationSnapshots` /
`latestCalibrationSnapshot`. It measures and records only; acting on the metric (autonomy bumps, threshold tuning)
stays maintainer-only. See [`docs/miner-selfimprove-calibration.md`](docs/miner-selfimprove-calibration.md). (#4248)

`gittensory-miner manage status` now also folds each tracked repo's current discover/plan/prepare run state
(`run-state.js`) alongside its managed PR rows into a "run portfolio" view — `collectRunPortfolio` /
`renderRunPortfolioTable` — so a repo actively being discovered or planned shows up even with zero PRs yet.
Additive only: the existing `rows` JSON key and PR table are unchanged; `runPortfolio` is a new key printed
after the existing table. A real GUI dashboard surface is out of scope here — `apps/gittensory-miner-ui/` is
Phase 6 of the same roadmap tracker and hasn't been scaffolded yet. (#4279)

## Local storage

Independent local SQLite stores back the commands above. Each keeps its own file, its own table(s), and (for most stores) its own env-var override — this is a DRY pass over their shared path-resolution/open boilerplate (`local-store.js`), not a merge into one database. (#4272)

See [`docs/env-reference.md`](docs/env-reference.md) for the full `GITTENSORY_MINER_*` / `MINER_*` env-var list.

| Store | File | Primary table(s) | Module | Env var override |
| --- | --- | --- | --- | --- |
| Laptop bootstrap | `laptop-state.sqlite3` | `laptop_meta` | `laptop-init.js` | `GITTENSORY_MINER_CONFIG_DIR` (path only) |
| Run state | `run-state.sqlite3` | `miner_run_state` | `run-state.js` | `GITTENSORY_MINER_RUN_STATE_DB` |
| Claim ledger | `claim-ledger.sqlite3` | `miner_claims` | `claim-ledger.js` | `GITTENSORY_MINER_CLAIM_LEDGER_DB` |
| Portfolio queue | `portfolio-queue.sqlite3` | `miner_portfolio_queue` | `portfolio-queue.js` | `GITTENSORY_MINER_PORTFOLIO_QUEUE_DB` |
| Event ledger | `event-ledger.sqlite3` | `miner_event_ledger` | `event-ledger.js` | `GITTENSORY_MINER_EVENT_LEDGER_DB` |
| Plan store | `plan-store.sqlite3` | `miner_plans` | `plan-store.js` | `GITTENSORY_MINER_PLAN_STORE_DB` |
| Governor ledger | `governor-ledger.sqlite3` | `governor_events` | `governor-ledger.js` | `GITTENSORY_MINER_GOVERNOR_LEDGER_DB` |
| Governor state | `governor-state.sqlite3` | `governor_scalar_state`, `governor_reputation_history`, `governor_own_submissions` | `governor-state.js` | `GITTENSORY_MINER_GOVERNOR_STATE_DB` |
| Attempt log | `attempt-log.sqlite3` | `attempt_log_events` | `attempt-log.js` | `GITTENSORY_MINER_ATTEMPT_LOG_DB` |
| Prediction ledger | `prediction-ledger.sqlite3` | `predictions` | `prediction-ledger.js` | `GITTENSORY_MINER_PREDICTION_LEDGER_DB` |
| Replay snapshot | `replay-snapshot.sqlite3` | `replay_snapshots` | `replay-snapshot.js` | `GITTENSORY_MINER_REPLAY_SNAPSHOT_DB` |
| Deny-hook synthesis | `deny-hook-synthesis.sqlite3` | `deny_rule_proposals` | `deny-hook-synthesis.js` | `GITTENSORY_MINER_DENY_HOOK_SYNTHESIS_DB` |
| Worktree allocator | `worktree-allocator.sqlite3` | `worktree_slots` | `worktree-allocator.js` | `GITTENSORY_MINER_WORKTREE_ALLOCATOR_DB` |
| Orb export | `orb-export.sqlite3` | `orb_export_meta` | `orb-export.js` | `GITTENSORY_MINER_ORB_EXPORT_DB` |
| Policy-doc cache | `policy-doc-cache.sqlite3` | `policy_doc_cache` | `policy-doc-cache.js` | `GITTENSORY_MINER_POLICY_DOC_CACHE_DB` |
| Policy-verdict cache | `policy-verdict-cache.sqlite3` | `policy_verdict_cache` | `policy-verdict-cache.js` | `GITTENSORY_MINER_POLICY_VERDICT_CACHE_DB` |

The policy-doc and policy-verdict caches are the only stores above that hold no miner state of their own — both are
pure optimization, and deleting either file only forces the next run to redo the work it would have skipped. The
policy-doc cache caches the last-known ETag + body of each target repo's fetched policy docs
(AI-USAGE.md/CONTRIBUTING.md) so a repeated `discover` revalidates them with a conditional GET (`If-None-Match`)
instead of re-downloading static content, spending no extra rate-limit budget when GitHub answers
`304 Not Modified` (#4842). The policy-verdict cache goes one step further: once a repo's deciding doc's ETag is
confirmed unchanged, it reuses the already-resolved AI-usage-policy verdict instead of re-resolving it from the
(identical) doc text (#4843).

Every store resolves its file the same way: the store-specific env var above, else `GITTENSORY_MINER_CONFIG_DIR`,
else `XDG_CONFIG_HOME` (falling back to `~/.config`), joined with `gittensory-miner/<file>`. Every store also opens
its file with `0700`/`0600` permissions and a shared `PRAGMA busy_timeout` so two instances on the same file
serialize writes instead of racing.

Opening a store through `local-store.js` also registers it with the CLI's crash-safety chokepoint
(`process-lifecycle.js`): the entrypoint calls `installCliSignalHandlers()` once at startup, so a `SIGINT`/`SIGTERM`
mid-run — or an uncaught exception / unhandled rejection — closes every still-open ledger cleanly and exits with a
conventional code (130/143 for signals, non-zero for a crash) instead of dying mid-write. A store's normal `close()`
unregisters itself first, so the happy path never double-closes and a long-running `loop` never accumulates stale
handles. Cleanup only — no command business logic is affected. (#4826)

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

`init` creates `~/.config/gittensory-miner/` (or `GITTENSORY_MINER_CONFIG_DIR` / `XDG_CONFIG_HOME` overrides) and a local `laptop-state.sqlite3` bootstrap file. Re-running `init` is idempotent. Pass `--verify-token` to make one authenticated GitHub API call up front and fail fast if `GITHUB_TOKEN` is invalid or missing repository access scopes. `doctor` reports Node, the state directory, SQLite readiness, and whether Docker is installed (informational only).

From a local checkout:

```sh
npm install
npm --workspace @jsonbored/gittensory-miner run build
npm link --workspace @jsonbored/gittensory-miner
```

### Coding-agent driver configuration

The production driver is selected by `MINER_CODING_AGENT_PROVIDER`. The value is a comma-separated preference list:
the first configured name wins, unknown names are skipped, and an empty/unset list leaves production driver
construction fail-closed. See [`docs/coding-agent-driver.md`](docs/coding-agent-driver.md) for the interface-level
contract and provider behavior.

| Env var | Accepted values | Default / behavior |
| --- | --- | --- |
| `MINER_CODING_AGENT_PROVIDER` | `noop`, `claude-cli`, `codex-cli`, `agent-sdk` | Unset / empty means no provider is configured; the miner fails closed until a valid provider name is supplied. |
| `MINER_CODING_AGENT_CLAUDE_MODEL` | Any Claude model string accepted by the local `claude` CLI | Unset means `claude-cli` uses the CLI's own default model. Ignored by `noop`, `codex-cli`, and `agent-sdk`. |
| `MINER_CODING_AGENT_CODEX_MODEL` | Any Codex model string accepted by the local `codex` CLI | Unset means `codex-cli` uses the CLI's own default model. Ignored by `noop`, `claude-cli`, and `agent-sdk`. |
| `MINER_CODING_AGENT_TIMEOUT_MS` | Positive integer milliseconds | Unset or invalid falls back to the CLI driver's default wall-clock timeout of `120000` ms. Ignored by `noop` and `agent-sdk`. |

### Recognizing a stale or missing coding-agent credential

When an attempt fails on a `claude-cli` / `codex-cli` provider, the CLI-subprocess driver folds the CLI's own output into a machine-readable `error` string on the attempt result. The credential/auth failure modes below map that exact string to a symptom and a concrete remediation — mirroring ORB's hosted-side [Recognizing a stale or missing credential](../../apps/gittensory-ui/src/routes/docs.self-hosting-ai-providers.tsx) table. Every string is emitted by [`cli-subprocess-driver.ts`](../gittensory-engine/src/miner/cli-subprocess-driver.ts); nothing here is speculative.

| Error string / pattern | Symptom | Remediation |
| --- | --- | --- |
| `claude_code_error_<status>` | The `claude` CLI ran but its `--output-format json` envelope reported `is_error: true` (e.g. `claude_code_error_invalid_api_key`) — the OAuth token is missing, rejected, or expired. `gittensory-miner doctor` reports the same condition up front as `not authenticated: set CLAUDE_CODE_OAUTH_TOKEN`. | Regenerate a long-lived token with `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`, then retry. |
| `codex_no_auth` | `codex exec` exited non-zero with no structured error in its JSONL stdout and only the `Reading prompt from stdin...` banner on stderr — its `auth.json` credential is missing or expired. The driver appends its own remediation hint (`... auth.json missing or expired -- run codex auth to authenticate`). | Run `codex auth` to re-authenticate; the next attempt reads the refreshed `auth.json` with no further restart. |
| `<command>_exit_<code>` | Generic non-zero-exit fallback when neither structured parser matched (e.g. `codex_exit_1: ...`, `claude_exit_1: ...`). The driver appends the redacted stderr slice — an auth failure that neither parser recognized still surfaces here. | Read the appended detail; if it points at authentication, re-run `claude setup-token` or `codex auth` for the failing provider, otherwise address the reported error directly. |

## Commands

```sh
gittensory-miner --help
gittensory-miner help
gittensory-miner --version
gittensory-miner version
gittensory-miner init [--json] [--verify-token]
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

### Client config

`gittensory-mcp` (ORB's hosted contributor-workflow tools) and `gittensory-miner-mcp` (AMS's own local state-visibility tools above) can run as two separate stdio servers in the same MCP client session — useful for a dual-role operator running both ORB and AMS on the same box. Generate ORB's half with `gittensory-mcp init-client --print claude` (see the [`@jsonbored/gittensory-mcp` README](../gittensory-mcp/README.md#client-config)); `gittensory-miner-mcp` takes no flags, so its entry is just the bin name. Combined, a Claude Desktop / Claude Code style config looks like:

```json
{
  "mcpServers": {
    "gittensory": {
      "command": "gittensory-mcp",
      "args": ["--stdio"]
    },
    "gittensory-miner": {
      "command": "gittensory-miner-mcp",
      "args": []
    }
  }
}
```

`gittensory` exposes ORB's hosted contributor-workflow tools (issue ranking, PR packet prep, decision packs). `gittensory-miner` exposes AMS's own local state-visibility tools listed above (portfolio dashboard, claims, audit feed, run state, plans) — a fully separate, 100% local tool surface with no shared code or network calls between the two. Both follow the same `gittensory_*` tool-naming convention (`gittensory_...` vs. `gittensory_miner_...`), but back onto different stores: ORB's tools read the hosted gittensory backend, AMS's tools read this machine's own local SQLite files (see [Local storage](#local-storage)) — a handful of AMS tools even name the ORB tool they mirror (e.g. `gittensory_miner_get_run_state` is the read-only analog of `gittensory_get_automation_state`) so the relationship is explicit at the point of use, not just here.

## Version check

On every invocation the CLI starts an async npm registry lookup (5s timeout). When the installed package is behind `@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
