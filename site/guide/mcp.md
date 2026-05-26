# MCP

The MCP package is the contributor-facing surface for coding agents. It runs locally over stdio and calls the private Gittensory API with your Gittensory session token.

## Generate Client Config

Print a config snippet:

```sh
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
```

These commands do not edit your files. Use an absolute command path if your client does not inherit your shell `PATH`.

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

## Tools

The local wrapper exposes repo context, contributor decision packs, local branch preflight, score blockers, PR packets, variant comparison, and registry change tools.

Useful tools:

- `gittensory_local_status`
- `gittensory_get_decision_pack`
- `gittensory_explain_repo_decision`
- `gittensory_preflight_current_branch`
- `gittensory_preview_current_branch_score`
- `gittensory_rank_local_next_actions`
- `gittensory_explain_local_blockers`
- `gittensory_prepare_pr_packet`

## Runtime Rules

- Stdio only for the local wrapper.
- No source upload in v1.
- Private score and reward/risk reasoning stay in MCP/API output.
- Public PR packets are sanitized and do not include wallet, hotkey, raw trust score, or public score estimates.
