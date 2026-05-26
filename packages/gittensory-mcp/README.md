# @jsonbored/gittensory-mcp

Local stdio MCP wrapper for Gittensory contributor intelligence.

It inspects local git metadata and calls the private Gittensory API for branch preflight, score blockers, reward/risk reasoning, contributor decision packs, and public-safe PR packets. It does not upload source contents in v1.

## Status

The package is restricted during private beta. Public npm install will be enabled only after the launch gate passes.

## Install

Private beta from the repo:

```sh
npm install
npm link --workspace @jsonbored/gittensory-mcp
gittensory-mcp login
```

Public npm path once launched:

```sh
npx @jsonbored/gittensory-mcp login
npm install -g @jsonbored/gittensory-mcp
```

## Commands

```sh
gittensory-mcp login
gittensory-mcp logout
gittensory-mcp whoami
gittensory-mcp status
gittensory-mcp doctor
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
gittensory-mcp analyze-branch --login jsonbored --json
gittensory-mcp preflight --login jsonbored --json
gittensory-mcp --stdio
```

## Auth

`login` uses GitHub Device Flow by default. For non-interactive bootstrap:

```sh
gittensory-mcp login --github-token "$(gh auth token)"
```

The wrapper stores a Gittensory session token, not a GitHub token.

## Environment

- `GITTENSORY_API_URL`
- `GITTENSORY_CONFIG_PATH` or `GITTENSORY_CONFIG_DIR`
- `GITTENSORY_API_TOKEN`, `GITTENSORY_MCP_TOKEN`, or `GITTENSORY_TOKEN`
- `GITHUB_TOKEN` for non-interactive login bootstrap
- `GITTENSOR_SCORE_PREVIEW_CMD`
- `GITTENSOR_ROOT`
- `GITTENSORY_UPLOAD_SOURCE=false`

`GITTENSORY_UPLOAD_SOURCE=true` is not supported and fails closed.
