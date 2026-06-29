# Gittensory

<p align="center">
  <a href="https://github.com/JSONbored/gittensory/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JSONbored/gittensory/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@jsonbored/gittensory-mcp"><img alt="MCP package" src="https://img.shields.io/npm/v/@jsonbored/gittensory-mcp?label=mcp" /></a>
  <a href="https://github.com/JSONbored/gittensory/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/JSONbored/gittensory" /></a>
  <a href="https://gittensory.aethereal.dev/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-gittensory.aethereal.dev-0b6bcb" /></a>
</p>

Gittensory is a deterministic control plane for Gittensor OSS contribution work.

It helps contributors plan cleaner work, helps maintainers review with less public noise, and keeps private scoring, wallet, hotkey, and reviewability context out of public GitHub output.

It is also the single converged home of the native review system; the legacy separate reviewbot repo/runtime is not part of the active architecture described here.

It is not a Gittensor explorer, public leaderboard, reward-farming bot, wallet dashboard, or autonomous PR agent.

## Privacy Boundary

Gittensory keeps sensitive context private by default.

- MCP local branch analysis sends metadata, not source contents.
- Public GitHub comments never include wallet, hotkey, reward estimate, private ranking, raw trust score, or reviewability context.
- Optional AI summaries receive compact deterministic signal bundles, not raw source code.
- Maintainer packets and scoring context stay on protected API/MCP surfaces.

See [Privacy and security](https://gittensory.aethereal.dev/docs/privacy-security) for the full boundary.

## Review Capabilities

Gittensory CI and gittensory review score, gate, and comment on pull requests. The review algorithm is open-source; operators tune behavior through per-repo settings and the `GITTENSORY_REVIEW_*` feature flags, every one of which ships **OFF** and is opt-in per repo.

- **Safety scan** — defangs untrusted PR title/body/diff (prompt-injection neutralization) before the AI reviewer reads them, and scans the diff for leaked secrets, surfacing a `secret_leak` blocker.
- **CI + full-file grounding** — grounds the AI reviewer with the PR's finished CI status and the full post-change content of the changed files, so claims are verified against reality instead of predicted.
- **Codebase RAG** — retrieval-augmented context that queries the codebase vector index for related callers, modules, and conventions and appends them to the reviewer prompt (additive only; inert until an index exists).
- **Submitter-reputation gating** — an internal-only spend control that downgrades new / burst / low-reputation submitters to a deterministic-only review, never surfaced on any public comment, label, or check.
- **Unified review comment** — renders the public PR feedback as one in-place comment instead of multiple panels.
- **Per-repo activation** — capabilities roll forward (and back) one flag and one repo at a time via the `GITTENSORY_REVIEW_REPOS` allowlist.

See [Tuning your reviews](https://gittensory.aethereal.dev/docs/tuning) for the full flag, setting, and `.gittensory.yml` reference.

## Start Here

| Audience                  | Start                                                                    | Useful next links                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miners and contributors   | [Quickstart](https://gittensory.aethereal.dev/docs/quickstart)           | [MCP client setup](https://gittensory.aethereal.dev/docs/mcp-clients), [Miner workflow](https://gittensory.aethereal.dev/docs/miner-workflow), [Scoreability](https://gittensory.aethereal.dev/docs/scoreability) |
| Maintainers               | [GitHub App](https://gittensory.aethereal.dev/docs/github-app)           | [Maintainer workflow](https://gittensory.aethereal.dev/docs/maintainer-workflow), [Self-host reviews](https://gittensory.aethereal.dev/docs/maintainer-self-hosting), [Privacy and security](https://gittensory.aethereal.dev/docs/privacy-security)                         |
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
