# MCP Clients

The MCP package is the contributor-facing surface. Your coding agent can ask Gittensory what the current branch means in Gittensor terms before you open or update a PR.

## What Agents Can Ask

- what repo lane applies: direct PR, issue discovery, split, inactive, or unknown
- what blocks scoreability right now
- whether local work looks stale, broad, duplicate-prone, or missing validation evidence
- what to clean up before opening more PRs
- what public-safe PR packet should be included for a maintainer

::: warning Private score/reward-risk only
Scoreability projections and reward/risk reasoning are private MCP/API output. Public GitHub comments stay sanitized.
:::

## Generate Config

```sh
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
```

These commands print config only. They do not mutate your local client files.

## Codex

```toml
[mcp_servers.gittensory]
command = "gittensory-mcp"
args = ["--stdio"]
```

## Claude Desktop

```json
{
  "mcpServers": {
    "gittensory": {
      "command": "gittensory-mcp",
      "args": ["--stdio"]
    }
  }
}
```

## Cursor

```json
{
  "mcpServers": {
    "gittensory": {
      "command": "gittensory-mcp",
      "args": ["--stdio"]
    }
  }
}
```

## Useful Tools

- `gittensory_local_status`
- `gittensory_get_decision_pack`
- `gittensory_explain_repo_decision`
- `gittensory_preflight_current_branch`
- `gittensory_preview_current_branch_score`
- `gittensory_rank_local_next_actions`
- `gittensory_explain_local_blockers`
- `gittensory_prepare_pr_packet`

## Runtime Rules

- local wrapper uses stdio
- source upload is unsupported in v1
- auth uses a Gittensory session token minted through GitHub OAuth
- public PR packets exclude wallets, hotkeys, raw trust scores, and public score estimates
