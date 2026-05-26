# Gittensory

Gittensory is a backend-only intelligence layer for Gittensor registered repositories.

It helps miners and contributors make better decisions before they open work, and it helps maintainers review Gittensor-driven PRs with less noise. The product is the signal: role-aware contributor context, official Gittensor stats, local MCP preflight, queue health, collision risk, reviewability, and repo configuration quality.

Gittensory is not a Gittensor frontend, not a public leaderboard, and not an auto-close or auto-merge bot.

## What It Does

- Builds private contributor decision packs from official Gittensor stats plus cached GitHub context.
- Analyzes local branches through the MCP wrapper without uploading source contents.
- Explains private reward/risk context: score blockers, open PR pressure, lane fit, duplicate risk, credibility assumptions, and maintainer friction.
- Generates public-safe PR packets that help contributors write cleaner submissions.
- Gives maintainers private PR reviewability packets through the API/MCP, while the GitHub App stays public-safe.
- Tracks repository intelligence: lane correctness, registry changes, queue health, label/config quality, collisions, bounties, and sync fidelity.

## Surfaces

- Worker API: Cloudflare Workers + Hono + D1 + Queues.
- MCP package: `@jsonbored/gittensory-mcp`, a local stdio wrapper for coding agents.
- GitHub App: quiet PR inspection, public-safe sticky comments, and maintainer-configured labels only for officially confirmed Gittensor miners.
- Docs site: VitePress under `site/`, deployed at `https://gittensory.aethereal.dev/`.

## MCP Install

Public npm:

```sh
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp login
gittensory-mcp doctor
gittensory-mcp --stdio
```

Local checkout:

```sh
npm install
npm link --workspace @jsonbored/gittensory-mcp
gittensory-mcp --stdio
```

Future MCP package releases are published from protected `mcp-vX.Y.Z` tags through the trusted-publishing workflow.

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

Protected endpoints use `Authorization: Bearer <GITTENSORY_API_TOKEN>` or a Gittensory OAuth session where supported.

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
- `GET /v1/repos/:owner/:repo/registration-readiness`
- `GET /v1/repos/:owner/:repo/gittensor-config-recommendation`
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
- Pull requests: read
- Issues: write

Optional repository permission:

- Checks: write, only when minimal check runs are explicitly enabled.

Required events:

- Pull request
- Issues
- Repository

If GitHub shows `Installation target`, select it. Gittensory should not block install health on event names that GitHub does not show in the app UI.

Default GitHub App behavior is low-noise: non-miner, bot, and maintainer-associated PR authors produce no public output. Confirmed Gittensor miners get one sticky public-safe PR comment and the configured label, defaulting to `gittensor`. Private reviewability, scoring, wallet, hotkey, and reward/risk context never appears in public GitHub comments or checks.

## Docs

```sh
npm run docs:dev
npm run docs:build
npm run docs:preview
```

The Pages workflow builds the docs on `main` for `https://gittensory.aethereal.dev/`, but deploys only when the repository variable `GITTENSORY_DOCS_DEPLOY` is set to `true`.

## Changelog And Releases

```sh
npm run changelog
npm run changelog:check
```

- `CHANGELOG.md` tracks backend/API/GitHub App changes.
- `packages/gittensory-mcp/CHANGELOG.md` tracks npm-visible MCP package changes.
- Root releases use `vX.Y.Z` tags.
- MCP package releases use `mcp-vX.Y.Z` tags and publish through trusted publishing with provenance.

## Validation

```sh
npm run test:ci
```

## Support And Security

- Public support: `SUPPORT.md`
- Security policy: `SECURITY.md`
- Privacy posture: `site/security/privacy.md`
- Terms: `site/security/terms.md`
