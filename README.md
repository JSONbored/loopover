# Gittensory

<p align="center">
  <a href="https://github.com/JSONbored/gittensory/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JSONbored/gittensory/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@jsonbored/gittensory-mcp"><img alt="MCP package" src="https://img.shields.io/npm/v/@jsonbored/gittensory-mcp?label=mcp" /></a>
  <a href="https://github.com/JSONbored/gittensory/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/JSONbored/gittensory" /></a>
  <a href="https://gittensory.aethereal.dev/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-gittensory.aethereal.dev-0b6bcb" /></a>
</p>

Gittensory is a deterministic control plane for Gittensor OSS contribution work.

It gives contributors and maintainers structured signals before work turns into noisy PRs: official Gittensor context, repo queue health, collision risk, branch preflight, scoreability, maintainer packet context, and public-safe PR guidance.

It is not a Gittensor explorer, public leaderboard, reward-farming bot, or autonomous PR agent.

## Product Map

| Surface | What it is | Start here |
| --- | --- | --- |
| MCP package | Local stdio tools for Codex, Claude Desktop, Cursor, and other MCP clients. | [MCP client setup](https://gittensory.aethereal.dev/docs/mcp-clients) |
| Web app | Operator UI, docs, API browser, roadmap, and workflow views. | [gittensory.aethereal.dev](https://gittensory.aethereal.dev/) |
| Worker API | Protected Cloudflare Worker API with OpenAPI metadata. | [OpenAPI JSON](https://gittensory-api.aethereal.dev/openapi.json) |
| GitHub App | Quiet maintainer automation for installed repos. | [Install](https://github.com/apps/gittensory/installations/new) and [setup docs](https://gittensory.aethereal.dev/docs/github-app) |

## Install MCP

```sh
npm install -g @jsonbored/gittensory-mcp@latest
gittensory-mcp login
gittensory-mcp doctor
gittensory-mcp --stdio
```

Print editor/client snippets:

```sh
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
```

Run base-agent commands:

```sh
gittensory-mcp agent plan --login jsonbored --json
gittensory-mcp agent packet --login jsonbored --json
gittensory-mcp agent status <run-id> --json
```

## What It Helps With

| For contributors | For maintainers |
| --- | --- |
| Pick cleaner repos and issues before opening work. | See private reviewability and queue context without public noise. |
| Preflight local branches without uploading source contents. | Keep GitHub App output public-safe and low-volume. |
| Understand score blockers, collision risk, and PR cleanup order. | Detect lane, label, config, sync, and maintainer-friction problems. |
| Draft better public PR packets from deterministic signals. | Separate useful Gittensor work from review-load churn. |

## Privacy Boundary

Gittensory keeps sensitive context private by default.

- MCP local branch analysis sends metadata, not source contents.
- Public GitHub comments never include wallet, hotkey, reward estimate, private ranking, raw trust score, or reviewability context.
- Optional AI summaries receive compact deterministic signal bundles, not raw source code.
- Maintainer packets and scoring context are protected API/MCP surfaces.

See [Privacy and security](https://gittensory.aethereal.dev/docs/privacy-security) for the full boundary.

## Local Development

```sh
npm install
npm run cf-typegen
npm run db:migrate:local
npm run dev
```

Frontend:

```sh
npm run ui:dev
npm run ui:build
```

Normal validation:

```sh
npm run test:ci
```

Release-only validation:

```sh
npm run test:release
npm run test:release:mcp
```

## Links

| Need | Link |
| --- | --- |
| Docs | [gittensory.aethereal.dev/docs](https://gittensory.aethereal.dev/docs) |
| Quickstart | [docs/quickstart](https://gittensory.aethereal.dev/docs/quickstart) |
| Branch analysis | [docs/branch-analysis](https://gittensory.aethereal.dev/docs/branch-analysis) |
| Scoreability | [docs/scoreability](https://gittensory.aethereal.dev/docs/scoreability) |
| Troubleshooting | [docs/troubleshooting](https://gittensory.aethereal.dev/docs/troubleshooting) |
| API | [openapi.json](https://gittensory-api.aethereal.dev/openapi.json) |
| npm | [@jsonbored/gittensory-mcp](https://www.npmjs.com/package/@jsonbored/gittensory-mcp) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security | [SECURITY.md](SECURITY.md) |
| Support | [SUPPORT.md](SUPPORT.md) |

Normal feature/fix PRs do not edit changelogs. Changelogs are release-prep artifacts.
