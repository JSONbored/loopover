# Gittensory

<p align="center">
  <a href="https://github.com/JSONbored/gittensory/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JSONbored/gittensory/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@jsonbored/gittensory-mcp"><img alt="MCP package" src="https://img.shields.io/npm/v/@jsonbored/gittensory-mcp?label=mcp" /></a>
  <a href="https://github.com/JSONbored/gittensory/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/JSONbored/gittensory" /></a>
  <a href="https://gittensory.aethereal.dev/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-gittensory.aethereal.dev-0b6bcb" /></a>
</p>

Gittensory is a deterministic control plane for Gittensor OSS contribution work.

It helps contributors plan cleaner work, helps maintainers review with less public noise, and keeps private scoring, wallet, hotkey, and reviewability context out of public GitHub output.

It is not a Gittensor explorer, public leaderboard, reward-farming bot, wallet dashboard, or autonomous PR agent.

## Privacy Boundary

Gittensory keeps sensitive context private by default.

- MCP local branch analysis sends metadata, not source contents.
- Public GitHub comments never include wallet, hotkey, reward estimate, private ranking, raw trust score, or reviewability context.
- Optional AI summaries receive compact deterministic signal bundles, not raw source code.
- Maintainer packets and scoring context stay on protected API/MCP surfaces.

See [Privacy and security](https://gittensory.aethereal.dev/docs/privacy-security) for the full boundary.

## Start Here

| Audience                  | Start                                                                    | Useful next links                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miners and contributors   | [Quickstart](https://gittensory.aethereal.dev/docs/quickstart)           | [MCP client setup](https://gittensory.aethereal.dev/docs/mcp-clients), [Miner workflow](https://gittensory.aethereal.dev/docs/miner-workflow), [Scoreability](https://gittensory.aethereal.dev/docs/scoreability) |
| Maintainers               | [GitHub App](https://gittensory.aethereal.dev/docs/github-app)           | [Maintainer workflow](https://gittensory.aethereal.dev/docs/maintainer-workflow), [Privacy and security](https://gittensory.aethereal.dev/docs/privacy-security)                                                  |
| Repo owners and operators | [Beta onboarding](https://gittensory.aethereal.dev/docs/beta-onboarding) | [Upstream drift](https://gittensory.aethereal.dev/docs/upstream-drift), [Troubleshooting](https://gittensory.aethereal.dev/docs/troubleshooting), [Roadmap](https://gittensory.aethereal.dev/roadmap)             |
| Agent authors             | [Agents](https://gittensory.aethereal.dev/agents)                        | [API browser](https://gittensory.aethereal.dev/api), [MCP client setup](https://gittensory.aethereal.dev/docs/mcp-clients)                                                                                        |

## Surfaces

| Surface           | Link                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Website           | [gittensory.aethereal.dev](https://gittensory.aethereal.dev/)                                                                      |
| Docs              | [gittensory.aethereal.dev/docs](https://gittensory.aethereal.dev/docs)                                                             |
| MCP package       | [@jsonbored/gittensory-mcp](https://www.npmjs.com/package/@jsonbored/gittensory-mcp)                                               |
| API               | [API browser](https://gittensory.aethereal.dev/api) and [OpenAPI JSON](https://gittensory-api.aethereal.dev/openapi.json)          |
| GitHub App        | [Install](https://github.com/apps/gittensory/installations/new) and [setup docs](https://gittensory.aethereal.dev/docs/github-app) |
| Browser extension | [Extension page](https://gittensory.aethereal.dev/extension)                                                                       |

## MCP Install

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

For full editor setup and stdio configuration, use [MCP client setup](https://gittensory.aethereal.dev/docs/mcp-clients).

Run base-agent commands:

```sh
gittensory-mcp agent plan --login jsonbored --json
gittensory-mcp agent packet --login jsonbored --json
gittensory-mcp agent status <run-id> --json
```

## Local Development

```sh
npm install
npm run cf-typegen
npm run db:migrate:local
npm run dev
```

```sh
npm run test:ci
```

Release-only validation:

```sh
npm run test:release
npm run test:release:mcp
```

Frontend:

```sh
npm run ui:dev
npm run ui:build
```

## Project Links

| Need         | Link                               |
| ------------ | ---------------------------------- |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security     | [SECURITY.md](SECURITY.md)         |
| Support      | [SUPPORT.md](SUPPORT.md)           |
| Changelog    | [CHANGELOG.md](CHANGELOG.md)       |

Normal feature/fix PRs do not edit changelogs. Changelogs are release-prep artifacts.
