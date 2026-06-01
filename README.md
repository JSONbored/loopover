# Gittensory

Gittensory is the deterministic base-agent layer for Gittensor OSS contribution mining.

It helps miners and contributors make better decisions before they open work, and it helps maintainers review Gittensor-driven PRs with less noise. The product is the signal: role-aware contributor context, official Gittensor stats, local MCP preflight, queue health, collision risk, reviewability, repo configuration quality, and copilot-only next-action planning.

Gittensory is not a Gittensor frontend, not a public leaderboard, and not an autonomous PR bot. V1 ranks, explains, preflights, and drafts public-safe packets; it does not edit code, open PRs, post comments, close, merge, or label without an explicit user or maintainer-triggered flow.

## What It Does

- Builds private contributor decision packs from official Gittensor stats plus cached GitHub context.
- Analyzes local branches through the MCP wrapper without uploading source contents.
- Explains private reward/risk context: score blockers, open PR pressure, lane fit, duplicate risk, credibility assumptions, and maintainer friction.
- Generates public-safe PR packets that help contributors write cleaner submissions.
- Gives maintainers private PR reviewability packets through the API/MCP, while the GitHub App stays public-safe.
- Tracks repository intelligence: lane correctness, registry changes, queue health, label/config quality, collisions, bounties, and sync fidelity.
- Runs deterministic base-agent plans that rank next actions, explain blockers, prepare PR packets, and record auditable run/action snapshots.

## Surfaces

- Worker API: Cloudflare Workers + Hono + D1 + Queues.
- Frontend Worker: Lovable/TanStack Start app under `apps/gittensory-ui`, deployed at `https://gittensory.aethereal.dev/`.
- MCP package: `@jsonbored/gittensory-mcp`, a local stdio wrapper for coding agents and the first-class base-agent surface.
- GitHub App: quiet PR inspection, public-safe sticky comments, maintainer-configured labels, and explicit `@gittensory` commands on installed repos.

## AI Posture

Gittensory's core decisions are deterministic. MCP users normally bring their own AI harness through Codex, Claude, Cursor, or another MCP client, while Gittensory supplies the structured Gittensor context those agents need.

Cloudflare Workers AI is optional and disabled by default. When enabled, it can rewrite compact deterministic signal bundles into clearer prose, but it never receives source contents and all public output still passes through Gittensory's sanitizer.

## MCP Install

Public npm:

```sh
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp login
gittensory-mcp doctor
gittensory-mcp --stdio
```

Base-agent CLI commands:

```sh
gittensory-mcp agent plan --login jsonbored --json
gittensory-mcp agent packet --login jsonbored --json
gittensory-mcp agent status <run-id> --json
gittensory-mcp agent explain <run-id> --json
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
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
wrangler secret put GITTENSORY_API_TOKEN
wrangler secret put GITTENSORY_MCP_TOKEN
wrangler secret put INTERNAL_JOB_TOKEN
```

`GITHUB_PUBLIC_TOKEN` is a server-side token used to raise public GitHub API rate limits during registered-repo backfill. It is not a contributor token.

`GITHUB_OAUTH_CLIENT_ID`, `ADMIN_GITHUB_LOGINS`, `PUBLIC_API_ORIGIN`, and `PUBLIC_SITE_ORIGIN` are API Worker runtime vars in `wrangler.jsonc`. `GITHUB_OAUTH_CLIENT_SECRET` is an API Worker runtime secret. Do not put the OAuth client secret on the UI Worker.

`ADMIN_GITHUB_LOGINS` is a comma- or whitespace-separated allowlist of GitHub logins that may exchange GitHub OAuth/device-flow credentials for Gittensory API sessions. Leave it unset to disable OAuth session issuance.

The production API origin is `https://gittensory-api.aethereal.dev`. The `workers.dev` deployment URL is treated as an internal fallback, not the public integration target.

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
- `POST /v1/agent/runs`
- `GET /v1/agent/runs/:id`
- `POST /v1/agent/plan-next-work`
- `POST /v1/agent/preflight-branch`
- `POST /v1/agent/prepare-pr-packet`
- `POST /v1/agent/explain-blockers`
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
- Issue comment
- Repository

If GitHub shows `Installation target`, select it. Gittensory should not block install health on event names that GitHub does not show in the app UI.

Default GitHub App behavior is low-noise: non-miner, bot, and maintainer-associated PR authors produce no public output. Confirmed Gittensor miners get one sticky public-safe PR comment and the configured label, defaulting to `gittensor`. Maintainers and authorized PR authors can explicitly invoke public-safe `@gittensory` commands. Private reviewability, scoring, wallet, hotkey, and reward/risk context never appears in public GitHub comments or checks.

## Frontend

```sh
npm run ui:dev
npm run ui:build
npm run ui:preview
```

The frontend is a TanStack Start app imported from the Lovable `gittensory-docs` project. It is deployed as the separate `gittensory-ui` Cloudflare Worker on `https://gittensory.aethereal.dev/`. The backend remains the `gittensory-api` Worker on `https://gittensory-api.aethereal.dev`.

Cloudflare Workers Builds owns automatic frontend deployments from GitHub. The `.github/workflows/ui-deploy.yml` workflow is a manual validation fallback only.

GitHub Pages and VitePress are retired. Do not add `site/`, `.vitepress`, `CNAME`, `gh-pages`, or Pages deployment workflows back to this repository.

## Contributing

Read `CONTRIBUTING.md` before opening an issue or PR. The contribution policy defines accepted areas, out-of-scope work, required PR contents, and the full validation gate.

The normal PR gate is:

```sh
npm run test:ci
```

Coverage must stay at or above 97% for statements, branches, functions, and lines. Production smoke is available for release/maintainer validation:

```sh
npm run test:smoke:production
```

## Changelog And Releases

Normal feature/fix PRs do not edit changelogs. Keep PR titles Conventional Commit
friendly, then update changelogs during release prep.

```sh
npm run changelog
npm run changelog:check
npm run changelog:check:mcp
```

- `CHANGELOG.md` tracks backend/API/GitHub App changes.
- `packages/gittensory-mcp/CHANGELOG.md` tracks npm-visible MCP package changes.
- Root releases use `vX.Y.Z` tags.
- MCP package releases use `mcp-vX.Y.Z` tags and publish through trusted publishing with provenance.
- MCP release validation runs `npm run test:release:mcp`, which includes the normal CI gate plus the MCP changelog freshness check.

## Validation

```sh
npm run test:ci
```

## Support And Security

- Contribution policy: `CONTRIBUTING.md`
- Code of Conduct: `CODE_OF_CONDUCT.md`
- Public support: `SUPPORT.md`
- Security policy: `SECURITY.md`
- Privacy and terms: `apps/gittensory-ui/src/routes/docs.privacy-security.tsx`
