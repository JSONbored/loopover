# @jsonbored/gittensory-mcp

Local stdio MCP wrapper for Gittensory contributor intelligence.

It inspects local git metadata and calls the Gittensory API for branch preflight, score blockers, reward/risk reasoning, contributor decision packs, and public-safe PR packets. It does not upload source contents in v1.

## Status

The package is public. Gittensory keeps sensitive score, trust, wallet, and maintainer context out of public PR comments.

## Install

Public npm:

```sh
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp login
```

From a local checkout:

```sh
npm install
npm link --workspace @jsonbored/gittensory-mcp
```

## Commands

```sh
gittensory-mcp login
gittensory-mcp logout
gittensory-mcp whoami
gittensory-mcp status
gittensory-mcp changelog
gittensory-mcp doctor
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
gittensory-mcp analyze-branch --login jsonbored --json
gittensory-mcp preflight --login jsonbored --json
gittensory-mcp --stdio
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

## Environment

- `GITTENSORY_API_URL`
- `GITTENSORY_CONFIG_PATH` or `GITTENSORY_CONFIG_DIR`
- `GITTENSORY_API_TOKEN`, `GITTENSORY_MCP_TOKEN`, or `GITTENSORY_TOKEN`
- `GITHUB_TOKEN` for non-interactive login bootstrap
- `GITTENSOR_SCORE_PREVIEW_CMD`
- `GITTENSOR_ROOT`
- `GITTENSORY_UPLOAD_SOURCE=false`
- `GITTENSORY_SKIP_NPM_VERSION_CHECK=true`

`GITTENSORY_UPLOAD_SOURCE=true` is not supported and fails closed.

## Release Notes

The package ships with `CHANGELOG.md`. Run:

```sh
gittensory-mcp changelog
```

`gittensory-mcp status` also reports the local package version, latest npm version when reachable, API health, auth state, and source-upload posture.
