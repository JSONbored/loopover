# @jsonbored/gittensory-mcp

Local stdio MCP wrapper for the Gittensory base-agent layer.

It inspects local git metadata and calls the Gittensory API for branch preflight, score blockers, reward/risk reasoning, contributor decision packs, deterministic next-action planning, and public-safe PR packets. It does not upload source contents in v1.

## Status

The package is public. Gittensory keeps sensitive score, trust, wallet, and maintainer context out of public PR comments.

## Install

Public npm:

```sh
npm install -g @jsonbored/gittensory-mcp@latest
gittensory-mcp login
```

From a local checkout:

```sh
npm install
npm link --workspace @jsonbored/gittensory-mcp
```

## Commands

```sh
gittensory-mcp version
gittensory-mcp version --json
gittensory-mcp login
gittensory-mcp logout
gittensory-mcp whoami
gittensory-mcp config
gittensory-mcp config --json
gittensory-mcp status
gittensory-mcp changelog
gittensory-mcp doctor
gittensory-mcp profile list
gittensory-mcp profile create work
gittensory-mcp profile switch work
gittensory-mcp cache status
gittensory-mcp cache clear
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
gittensory-mcp completion bash
gittensory-mcp completion zsh
gittensory-mcp completion fish
gittensory-mcp decision-pack --login jsonbored --json
gittensory-mcp repo-decision --login jsonbored --repo we-promise/sure --json
gittensory-mcp analyze-branch --login jsonbored --json
gittensory-mcp preflight --login jsonbored --json
gittensory-mcp agent plan --login jsonbored --json
gittensory-mcp agent packet --login jsonbored --json
gittensory-mcp agent status <run-id> --json
gittensory-mcp agent explain <run-id> --json
gittensory-mcp --stdio
```

`gittensory-mcp version` (aliases `--version` and `-v`) prints the installed package version, the targeted API version, and the Node.js runtime version:

```text
@jsonbored/gittensory-mcp/0.4.0 (api 0.1.0, node v22.12.0)
```

Add `--json` for machine-readable output:

```json
{
  "name": "@jsonbored/gittensory-mcp",
  "version": "0.4.0",
  "apiVersion": "0.1.0",
  "node": "v22.12.0"
}
```

### Shell completion

`gittensory-mcp completion <bash|zsh|fish>` prints a tab-completion script for your shell. It completes top-level commands and the subcommands of `profile`, `cache`, and `agent`. Add `--json` to get `{ "shell": "...", "script": "..." }` for tooling.

```sh
# bash (add to ~/.bashrc)
source <(gittensory-mcp completion bash)

# zsh (add to a file on your fpath, or to ~/.zshrc)
source <(gittensory-mcp completion zsh)

# fish
gittensory-mcp completion fish > ~/.config/fish/completions/gittensory-mcp.fish
```

For near-term what-if scoreability, pass the situational assumptions explicitly:

```sh
gittensory-mcp analyze-branch --login jsonbored \
  --pending-merged-prs 3 \
  --expected-open-prs 0 \
  --projected-credibility 0.8 \
  --scenario-note "approved PRs expected to merge" \
  --json
```

## Auth

`login` uses GitHub Device Flow by default. For non-interactive bootstrap:

```sh
gittensory-mcp login --github-token "$(gh auth token)"
```

The wrapper stores a Gittensory session token, not a GitHub token.

The default profile keeps normal single-account usage simple. For multiple identities, use named profiles:

```sh
gittensory-mcp login --profile personal --github-token "$(gh auth token)"
gittensory-mcp login --profile work --github-token "$WORK_GITHUB_TOKEN"
gittensory-mcp profile list
gittensory-mcp profile switch work
gittensory-mcp whoami
gittensory-mcp logout --profile work
```

Use `--profile <name>` on `login`, `logout`, `whoami`, `config`, `status`, and `doctor`, or set `GITTENSORY_PROFILE`. `logout` only clears the selected local profile unless `--all` is passed. Profile output redacts session tokens and local config paths.

`gittensory-mcp config` prints the resolved effective configuration and the source that supplied each value (`environment`, `profile`, `config`, or `default`): the active API URL and its source, active profile and profile count, whether a config file is present and which environment variable steers its location, the cache-dir source, and whether a token is configured and where it came from. It never prints token values or local absolute paths. Add `--json` for machine-readable output.

## Base-Agent Mode

The agent commands are copilot-only. They rank, explain, preflight, and draft public-safe packets, but they do not edit code, open PRs, post comments, close, merge, or label from the local wrapper.

```sh
gittensory-mcp agent plan --login jsonbored --repo we-promise/sure --json
gittensory-mcp agent packet --login jsonbored --repo we-promise/sure --base origin/main --json
```

The same capabilities are exposed to MCP clients as:

- `gittensory_agent_plan_next_work`
- `gittensory_agent_start_run`
- `gittensory_agent_get_run`
- `gittensory_agent_explain_next_action`
- `gittensory_agent_prepare_pr_packet`

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

Branch analysis can call a local scorer command that reads branch metadata JSON from stdin and prints one JSON object to stdout. Gittensory never uploads source contents; the scorer runs on your machine.

Metadata-only fallback is used when the command is missing or fails. Run `gittensory-mcp doctor` for setup diagnostics.

Reference wrappers ship with the package:

```sh
export GITTENSOR_SCORE_PREVIEW_CMD="node $(npm root -g)/@jsonbored/gittensory-mcp/scripts/gittensor-score-preview.mjs"
```

For tree-sitter scoring with a local [entrius/gittensor](https://github.com/entrius/gittensor) checkout:

```sh
export GITTENSOR_ROOT=/path/to/gittensor
export GITTENSOR_SCORE_PREVIEW_CMD="python3 $(npm root -g)/@jsonbored/gittensory-mcp/scripts/gittensor-score-preview.py"
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
gittensory-mcp changelog
```

`gittensory-mcp status` also reports the local package version, latest npm version when reachable, API health, auth state, and source-upload posture.

## Offline decision-pack fallback

Successful `decision-pack` and MCP `gittensory_get_decision_pack` calls store a bounded last-good local cache entry keyed by API version and login. If the API or network is temporarily unavailable, the wrapper can return that last-good guidance as `source: "local_cache"` with `stale: true`, `cachedAt`, and rerun guidance. Auth and permission failures do not use stale fallback data.

The cache excludes source contents and local paths, is bounded, and can be removed with:

```sh
gittensory-mcp cache clear
```
