# Gittensory

Gittensory is a backend-only intelligence layer for Gittensor registered repositories.

It helps miners and contributors make better decisions before they open work, and it helps maintainers review Gittensor-driven PRs with less noise. The product is the signal: role-aware contributor context, official Gittensor stats, local MCP preflight, queue health, collision risk, reviewability, and repo configuration quality.

Gittensory is not a Gittensor frontend, not a public leaderboard, and not an auto-label/auto-close bot.

## What It Does

- Builds private contributor decision packs from official Gittensor stats plus cached GitHub context.
- Analyzes local branches through the MCP wrapper without uploading source contents.
- Explains private reward/risk context: score blockers, open PR pressure, lane fit, duplicate risk, credibility assumptions, and maintainer friction.
- Generates public-safe PR packets that help contributors write cleaner submissions.
- Gives maintainers private PR reviewability packets and advisory check runs.
- Tracks repository intelligence: lane correctness, registry changes, queue health, label/config quality, collisions, bounties, and sync fidelity.

## Surfaces

- Worker API: Cloudflare Workers + Hono + D1 + Queues.
- MCP package: `@jsonbored/gittensory-mcp`, a local stdio wrapper for coding agents.
- GitHub App: check runs and optional sanitized sticky PR comments.
- Docs site: VitePress under `site/`, deployable by GitHub Pages when the repo is public.

## MCP Install

Private beta:

```sh
npm install
npm link --workspace @jsonbored/gittensory-mcp
gittensory-mcp login
gittensory-mcp doctor
gittensory-mcp --stdio
```

Public npm path, once intentionally launched:

```sh
npx @jsonbored/gittensory-mcp login
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp --stdio
```

The package is restricted until launch. Public release requires changing npm access to `public`, bumping the MCP package version, and publishing through the tag-gated release workflow.

## MCP Client Config

Print client snippets:

```sh
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
```

Generic stdio command:

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

Use an absolute command path if your MCP client does not inherit your shell `PATH`.

## Backend Setup

```sh
npm install
npm run cf-typegen
npm run db:migrate:local
npm run dev
```

Cloudflare secrets:

```sh
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_PUBLIC_TOKEN
wrangler secret put GITHUB_OAUTH_CLIENT_ID
wrangler secret put GITTENSORY_API_TOKEN
wrangler secret put GITTENSORY_MCP_TOKEN
wrangler secret put INTERNAL_JOB_TOKEN
```

`GITHUB_PUBLIC_TOKEN` is a server-side token used to raise public GitHub API rate limits during registered-repo backfill. It is not a contributor token.

## Canonical API

Private beta endpoints use `Authorization: Bearer <GITTENSORY_API_TOKEN>` or a Gittensory OAuth session where supported.

- `GET /health`
- `GET /openapi.json`
- `GET /v1/readiness`
- `GET /v1/sync/status`
- `GET /v1/registry/snapshot`
- `GET /v1/registry/changes`
- `GET /v1/scoring/model`
- `POST /v1/scoring/preview`
- `GET /v1/installations`
- `GET /v1/installations/:id/health`
- `GET /v1/repos`
- `GET /v1/repos/:owner/:repo`
- `GET /v1/repos/:owner/:repo/intelligence`
- `GET /v1/repos/:owner/:repo/pulls/:number/maintainer-packet`
- `GET /v1/repos/:owner/:repo/pulls/:number/reviewability`
- `GET /v1/contributors/:login/profile`
- `GET /v1/contributors/:login/decision-pack`
- `GET /v1/contributors/:login/repos/:owner/:repo/decision`
- `POST /v1/preflight/pr`
- `POST /v1/preflight/local-diff`
- `POST /v1/local/branch-analysis`
- `GET /v1/bounties`
- `GET /v1/bounties/:id/advisory`
- `POST /mcp`
- `POST /v1/github/webhook`

Internal job routes are protected by `INTERNAL_JOB_TOKEN`.

## GitHub App Requirements

Required repository permissions:

- Metadata: read
- Checks: write
- Pull requests: read
- Issues: read

Optional repository permission:

- Issues: write, only when public-safe sticky PR comments are enabled.

Required events:

- Pull request
- Issues
- Repository

If GitHub shows `Installation target`, select it. Gittensory should not block install health on event names that GitHub does not show in the app UI.

## Docs

```sh
npm run docs:dev
npm run docs:build
npm run docs:preview
```

The Pages workflow builds the docs on `main`, but deploys only when the repository variable `GITTENSORY_DOCS_DEPLOY` is set to `true`.

## Validation

```sh
npm run test:ci
```
