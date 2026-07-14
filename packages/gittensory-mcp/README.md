# @loopover/mcp

Local stdio MCP wrapper for the LoopOver base-agent layer.

It inspects local git metadata and calls the LoopOver API for branch preflight, score blockers, reward/risk reasoning, contributor decision packs, deterministic next-action planning, and public-safe PR packets. It does not upload source contents in v1.

## Status

The package is public. LoopOver keeps sensitive score, trust, wallet, and maintainer context out of public PR comments.

## Install

Public npm:

```sh
npm install -g @loopover/mcp@latest
loopover-mcp login
```

From a local checkout:

```sh
npm install
npm link --workspace @loopover/mcp
```

## Commands

```sh
loopover-mcp version
loopover-mcp version --json
loopover-mcp tools
loopover-mcp tools --json
loopover-mcp login
loopover-mcp logout
loopover-mcp whoami
loopover-mcp config
loopover-mcp config --json
loopover-mcp status
loopover-mcp changelog
loopover-mcp doctor
loopover-mcp doctor --exit-code
loopover-mcp profile list
loopover-mcp profile create work
loopover-mcp profile switch work
loopover-mcp cache status
loopover-mcp cache list
loopover-mcp cache clear
loopover-mcp init-client --print codex
loopover-mcp init-client --print claude
loopover-mcp init-client --print cursor
loopover-mcp init-client --print vscode
loopover-mcp init-client --print codex --agent-profile miner-planner
loopover-mcp completion bash
loopover-mcp completion zsh
loopover-mcp completion fish
loopover-mcp completion powershell
loopover-mcp decision-pack --login jsonbored --json
loopover-mcp repo-decision --login jsonbored --repo we-promise/sure --json
loopover-mcp analyze-branch --login jsonbored --json
loopover-mcp preflight --login jsonbored --json
loopover-mcp review-pr --login jsonbored --commit "feat(mcp): add doctor grouping" --body "Fixes #160. Validated with npm test." --linked-issue 160 --json
loopover-mcp lint-pr-text --commit "feat(mcp): add doctor grouping" --body "Fixes #160. Validated with npm test." --linked-issue 160 --json
loopover-mcp validate-config --file ./.loopover.yml --json
loopover-mcp slop-risk --changed-file src/widget.ts:80:2 --description "Adds retry handling." --test-file test/unit/widget.test.ts --json
loopover-mcp issue-slop --title "Add retry handling" --body "Widget reconnects fail without bounded retries." --json
loopover-mcp agent plan --login jsonbored --json
loopover-mcp agent packet --login jsonbored --json
loopover-mcp agent status <run-id> --json
loopover-mcp agent explain <run-id> --json
loopover-mcp --stdio
```

`loopover-mcp version` (aliases `--version` and `-v`) prints the installed package version, the targeted API version, and the Node.js runtime version:

```text
@loopover/mcp/0.5.0 (api 0.1.0, node v22.12.0)
```

Add `--json` for machine-readable output:

```json
{
  "name": "@loopover/mcp",
  "version": "0.5.0",
  "apiVersion": "0.1.0",
  "node": "v22.12.0"
}
```

`loopover-mcp tools` lists every stdio MCP tool the local wrapper registers, with its one-line description. Add `--json` for `{ "count": N, "tools": [{ "name", "description" }, ...] }`.

### Shell completion

`loopover-mcp completion <bash|zsh|fish|powershell>` prints a tab-completion script for your shell. It completes top-level commands and the subcommands of `profile`, `cache`, `agent`, and `maintain`. Add `--json` to get `{ "shell": "...", "script": "..." }` for tooling.

```sh
# bash (add to ~/.bashrc)
source <(loopover-mcp completion bash)

# zsh (add to a file on your fpath, or to ~/.zshrc)
source <(loopover-mcp completion zsh)

# fish
loopover-mcp completion fish > ~/.config/fish/completions/loopover-mcp.fish
```

```powershell
# PowerShell (add to your $PROFILE)
loopover-mcp completion powershell | Out-String | Invoke-Expression
```

For near-term what-if scoreability, pass the situational assumptions explicitly:

```sh
loopover-mcp analyze-branch --login jsonbored \
  --pending-merged-prs 3 \
  --expected-open-prs 0 \
  --projected-credibility 0.8 \
  --scenario-note "approved PRs expected to merge" \
  --json
```

## Review your PR locally before you push

`loopover-mcp review-pr` composes the existing preflight, slop-risk, and PR-text-lint checks into
ONE report, so your own local agent (Claude Code, Codex, etc.) can see everything the gittensory gate
would flag before you ever open a PR. It is a thin composition layer — it calls the same checks
`preflight`, `slop-risk`, and `lint-pr-text` already run and merges their output; it does not
reimplement any of them.

```sh
loopover-mcp review-pr --login jsonbored \
  --commit "feat(mcp): add review-pr" \
  --body "Composes preflight + slop-risk + lint-pr-text. Validated with npm test." \
  --linked-issue 1968 \
  --json
```

The report has an `overallStatus` (`pass`/`warn`/`fail`) and a `sections` array covering
`preflight`, `slop_risk`, and `pr_text_lint`. If one underlying check's API call fails, that section
degrades to `fail` with a public-safe `slopRiskError`/`prTextLintError` reason instead of aborting the
whole report — the other sections still return.

The same composed check is exposed to MCP clients as `loopover_review_pr_before_push`.

## Auth

`login` uses GitHub Device Flow by default. For non-interactive bootstrap:

```sh
loopover-mcp login --github-token "$(gh auth token)"
```

The wrapper stores a LoopOver session token, not a GitHub token.

The default profile keeps normal single-account usage simple. For multiple identities, use named profiles:

```sh
loopover-mcp login --profile personal --github-token "$(gh auth token)"
loopover-mcp login --profile work --github-token "$WORK_GITHUB_TOKEN"
loopover-mcp profile list
loopover-mcp profile switch work
loopover-mcp whoami
loopover-mcp logout --profile work
```

Use `--profile <name>` on `login`, `logout`, `whoami`, `config`, `status`, and `doctor`, or set `GITTENSORY_PROFILE`. `logout` only clears the selected local profile unless `--all` is passed. Profile output redacts session tokens and local config paths.

`loopover-mcp config` prints the resolved effective configuration and the source that supplied each value (`environment`, `profile`, `config`, or `default`): the active API URL and its source, active profile and profile count, whether a config file is present and which environment variable steers its location, the cache-dir source, whether a token is configured and where it came from, and whether `GITTENSORY_UPLOAD_SOURCE` has enabled the unsupported source-upload setting. It never prints token values or local absolute paths. Add `--json` for machine-readable output.

By default `loopover-mcp doctor` always exits 0. Pass `--exit-code` to make it exit non-zero when a diagnostic check fails (`status: "needs_attention"`), so it can gate a CI step or pre-commit hook. Warnings still exit 0.

## Base-Agent Mode

The agent commands are copilot-only. They rank, explain, preflight, and draft public-safe packets, but they do not edit code, open PRs, post comments, close, merge, or label from the local wrapper.

```sh
loopover-mcp agent plan --login jsonbored --repo we-promise/sure --json
loopover-mcp agent packet --login jsonbored --repo we-promise/sure --base origin/main --json
```

The same capabilities are exposed to MCP clients as:

- `loopover_agent_plan_next_work`
- `loopover_agent_start_run`
- `loopover_agent_get_run`
- `loopover_agent_explain_next_action`
- `loopover_agent_prepare_pr_packet`

### Client config

`init-client --print <host>` prints the stdio MCP config for a host: `codex` (TOML), `claude`, `cursor`, and `mcp` (the shared `mcpServers` JSON shape), and `vscode` (VS Code's native `servers` map with `"type": "stdio"`, for `.vscode/mcp.json`). It prints config only; it never edits client files.

### Agent profiles

`init-client` can print optional agent-profile instructions next to the MCP client config:

```sh
loopover-mcp init-client --print codex --agent-profile miner-planner
loopover-mcp init-client --print claude --agent-profile maintainer-triage
loopover-mcp init-client --print cursor --agent-profile repo-owner-intake
```

Profiles are prompt instructions for the coding-agent environment, not autonomous GitHub actors:

- `miner-planner` uses planner, preflight, cleanup-first, and PR-packet MCP prompts for contributor work selection.
- `maintainer-triage` uses queue triage, review prep, and public-guidance prompts for maintainer review preparation.
- `repo-owner-intake` uses intake-readiness, focus-manifest, and onboarding-pack prompts for repository owner setup planning.

Use them when an agent should plan, explain, draft, or prepare packets from LoopOver MCP outputs. Do not use them to open PRs, post comments, label, close, merge, publish public GitHub output, ask for wallets/hotkeys/coldkeys/private keys/tokens, or upload local source contents. Public snippets must stay separated from authenticated private context.

## Environment

- `GITTENSORY_API_URL`
- `GITTENSORY_PROFILE`
- `GITTENSORY_CONFIG_PATH` or `GITTENSORY_CONFIG_DIR`
- `GITTENSORY_API_TOKEN`, `GITTENSORY_MCP_TOKEN`, or `GITTENSORY_TOKEN`
- `GITHUB_TOKEN` for non-interactive login bootstrap
- `GITTENSOR_SCORE_PREVIEW_CMD`
- `GITTENSOR_ROOT`
- `GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS` (default `15000`)
- `GITTENSORY_UPLOAD_SOURCE=false`
- `GITTENSORY_SKIP_NPM_VERSION_CHECK=true`

`GITTENSORY_UPLOAD_SOURCE=true` is not supported and fails closed.

### Local score preview adapter

Branch analysis can call a local scorer command that reads branch metadata JSON from stdin and prints one JSON object to stdout. LoopOver never uploads source contents; the scorer runs on your machine.

Metadata-only fallback is used when the command is missing or fails. Run `loopover-mcp doctor` for setup diagnostics.

Reference wrappers ship with the package:

```sh
export GITTENSOR_SCORE_PREVIEW_CMD="node $(npm root -g)/@loopover/mcp/scripts/gittensor-score-preview.mjs"
```

For tree-sitter scoring with a local [entrius/gittensor](https://github.com/entrius/gittensor) checkout:

```sh
export GITTENSOR_ROOT=/path/to/gittensor
export GITTENSOR_SCORE_PREVIEW_CMD="python3 $(npm root -g)/@loopover/mcp/scripts/gittensor-score-preview.py"
```

Expected stdout shape:

```json
{
  "sourceTokenScore": 42,
  "totalTokenScore": 58,
  "sourceLines": 40,
  "testTokenScore": 16,
  "nonCodeTokenScore": 0,
  "warnings": []
}
```

Snake_case aliases such as `source_token_score` are also accepted.

## Release Notes

The package ships with `CHANGELOG.md`. Run:

```sh
loopover-mcp changelog
```

`loopover-mcp status` also reports the local package version, latest npm version when reachable, API health, auth state, and source-upload posture.

## Offline decision-pack fallback

Successful `decision-pack` and MCP `loopover_get_decision_pack` calls store a bounded last-good local cache entry keyed by API version and login. If the API or network is temporarily unavailable, the wrapper can return that last-good guidance as `source: "local_cache"` with `stale: true`, `cachedAt`, and rerun guidance. Auth and permission failures do not use stale fallback data.

The cache excludes source contents and local paths, is bounded, and can be removed with:

```sh
loopover-mcp cache clear
```

`loopover-mcp cache list` shows the cached entries (newest first) with the login, when each was cached, and its API/package version and size — never the cached payload or the auth-cache key. `loopover-mcp cache status` reports the aggregate entry count.
