# LoopOver

_Formerly Gittensory._

<p align="center">
  <a href="https://github.com/JSONbored/loopover/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JSONbored/loopover/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@loopover/mcp"><img alt="MCP package" src="https://img.shields.io/npm/v/@loopover/mcp?label=mcp" /></a>
  <a href="https://github.com/JSONbored/loopover/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/JSONbored/loopover" /></a>
  <a href="https://loopover.ai/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-loopover.ai-0b6bcb" /></a>
</p>

<p align="center">
  <a href="https://gittensor.io/miners/repository?name=JSONbored/loopover"><img alt="Gittensor impact" src="https://api.gittensor.io/repos/JSONbored%2Floopover/badge.svg" /></a>
</p>

LoopOver runs the pull-request loop with agents — on any GitHub repo, on both sides.

- **For maintainers (self-hosted):** an autonomous review agent works the PR queue end-to-end — AI review grounded in finished CI status, full post-change file content, and codebase RAG — then gates, approves, requests changes, merges, or closes on its own, governed by dry-run / pause / freeze / kill-switch controls.
- **For contributors:** the [`@loopover/mcp`](https://www.npmjs.com/package/@loopover/mcp) copilot brings predicted gate verdicts, branch preflight, duplicate detection, and cross-repo opportunity discovery into your own AI harness; the autonomous miner runtime (`@loopover/miner`) runs unattended across a fleet of repos, respecting each target repo's `.loopover-miner.yml` goal spec.
- **With proof:** merge/close decisions are outcome-confirmed (merged / reopened / reverted), published with coverage and confidence intervals on the live [fairness report](https://loopover.ai/fairness), and backed by a certified close-precision guarantee that self-tightens as data grows. The backtest corpus behind the published numbers is checksummed and [replayable by anyone](https://loopover.ai/docs/verify-this-review).
- **Gittensor-native intelligence built in:** for Bittensor SN74 miners the same engine adds scoreability previews, registry economics, and the cross-repo duplicate graph — while keeping wallet, hotkey, and raw trust-score context out of public GitHub output.

Self-hosting the whole stack is the path available today — and it doubles as the trust story: audit the algorithm, run it on your own infra, replay the published numbers yourself. A hosted plane is in open development on the public milestones (ORB Cloud Readiness, Rent-a-Loop): rentable, metered loops you point at a repo — and, further out, at nothing more than an idea.

It is the single converged home of the native review system; the legacy separate reviewbot repo/runtime is not part of the active architecture described here.

It is not a Gittensor explorer, public leaderboard, reward-farming bot, or wallet dashboard.

## Privacy Boundary

LoopOver keeps sensitive context private by default.

- MCP local branch analysis sends metadata, not source contents.
- Public GitHub comments never include wallet, hotkey, reward estimate, private ranking, raw trust score, or reviewability context.
- Optional AI summaries receive compact deterministic signal bundles, not raw source code.
- Maintainer packets and scoring context stay on protected API/MCP surfaces.
- MCP tool-call telemetry is an allowlist of four fields, and is anonymous — see below.

### MCP telemetry

A recorded MCP tool call carries exactly four fields, and there is no fifth: the **tool name**, which **surface**
dispatched it (`remote` or `local`), whether it **succeeded**, and a **coarse duration** in milliseconds. The
allowlist is the event shape itself rather than a filter over a richer one, so there is nowhere to put anything
else.

**Never tracked:** tool arguments, source contents, repository or issue text, and wallet, hotkey, coldkey, reward,
private ranking, or raw trust-score data. Events also carry no per-actor identity — every event shares one
constant, anonymous handle, so there is no per-user profile to accumulate — and IP-based geo enrichment is
disabled.

Each surface is controlled separately, and they differ in who holds the switch:

- **Local CLI** (`@loopover/mcp`) — **opt-in, OFF by default.** Nothing is recorded unless you have run
  `loopover-mcp telemetry enable`; an API key alone is not enough. `loopover-mcp telemetry status` reports the
  current state, and `disable` removes the flag entirely.
- **Hosted / remote MCP** — a **deployment** setting, not a per-user one: it records when the operator configures
  `POSTHOG_API_KEY`, which the hosted service does. A self-hosted deployment that leaves it unset records nothing.

See [Privacy and security](https://loopover.ai/docs/privacy-security) for the full boundary.

## Review Capabilities

LoopOver CI and LoopOver review score, gate, and comment on pull requests. The review algorithm is open-source; operators tune behavior through per-repo settings and the `LOOPOVER_REVIEW_*` feature flags, every one of which ships **OFF** and is opt-in per repo.

- **Safety scan** — defangs untrusted PR title/body/diff (prompt-injection neutralization) before the AI reviewer reads them, and scans the diff for leaked secrets, surfacing a `secret_leak` blocker.
- **CI + full-file grounding** — grounds the AI reviewer with the PR's finished CI status and the full post-change content of the changed files, so claims are verified against reality instead of predicted.
- **Codebase RAG** — retrieval-augmented context that queries the codebase vector index for related callers, modules, and conventions and appends them to the reviewer prompt (additive only; inert until an index exists).
- **Submitter-reputation gating** — an internal-only spend control that downgrades new / burst / low-reputation submitters to a deterministic-only review, never surfaced on any public comment, label, or check.
- **Unified review comment** — renders the public PR feedback as one in-place comment instead of multiple panels. With `.loopover.yml`'s `review.changed_files_summary` also on (off by default), it gains a deterministic, no-AI "Changed files" collapsible: one row per file category (source/test/docs/config/generated), with file counts and +/- totals.
- **Per-repo activation** — capabilities roll forward (and back) one flag and one repo at a time via the `LOOPOVER_REVIEW_REPOS` allowlist.

**Check-run and comment surfaces, disambiguated** (a common point of confusion — these are three independent, separately-configured things, not layers of the same feature):

- **`LoopOver Orb Review Agent`** (`gate.*` / `settings.reviewCheckMode`, off by default) — the authoritative GitHub Check Run carrying the gate's pass/fail verdict. This is the one worth making a required status check.
- **`LoopOver Context`** (`settings.checkRunMode` / `settings.checkRunDetailLevel`, off by default) — a separate, purely advisory Check Run. At its default `checkRunDetailLevel: minimal` it publishes no findings at all; even at `standard`/`deep` it only re-renders content already shown elsewhere. Never make this one required.
- **Inline review comments** (`LOOPOVER_REVIEW_INLINE_COMMENTS` + `.loopover.yml`'s `review.inline_comments`, off by both by default) — real, reply-able line-anchored PR review comment threads (CodeRabbit-style). This is the ONLY one of the three that posts an interactive per-line thread; the two check runs above never do. With `.loopover.yml`'s `review.suggestions` also on, a precise line-anchored fix is additionally rendered as a one-click, committable GitHub suggested-change block. With `review.finding_categories` also on (off by default), each finding is additionally tagged with a category — security/correctness/performance/maintainability/tests/style — in both the inline comment label and the unified comment's "Finding categories" collapsible; a deterministic path/keyword fallback covers whatever the model omits.

See [Tuning your reviews](https://loopover.ai/docs/tuning) for the full flag, setting, and `.loopover.yml` reference.

## Start Here

| Audience                  | Start                                                       | Useful next links                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Miners and contributors   | [Quickstart](https://loopover.ai/docs/quickstart)           | [MCP client setup](https://loopover.ai/docs/mcp-clients), [Miner workflow](https://loopover.ai/docs/miner-workflow), [Scoreability](https://loopover.ai/docs/scoreability)                                    |
| Maintainers               | [GitHub App](https://loopover.ai/docs/github-app)           | [Maintainer workflow](https://loopover.ai/docs/maintainer-workflow), [Self-host reviews](https://loopover.ai/docs/maintainer-self-hosting), [Privacy and security](https://loopover.ai/docs/privacy-security) |
| Repo owners and operators | [Beta onboarding](https://loopover.ai/docs/beta-onboarding) | [Upstream drift](https://loopover.ai/docs/upstream-drift), [Troubleshooting](https://loopover.ai/docs/troubleshooting), [Roadmap](https://loopover.ai/roadmap)                                                |
| Agent authors             | [Agents](https://loopover.ai/agents)                        | [API browser](https://loopover.ai/api), [MCP client setup](https://loopover.ai/docs/mcp-clients)                                                                                                              |

## Surfaces

| Surface        | Link                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Website        | [loopover.ai](https://loopover.ai/)                                                                                  |
| Docs           | [loopover.ai/docs](https://loopover.ai/docs)                                                                         |
| MCP package    | [@loopover/mcp](https://www.npmjs.com/package/@loopover/mcp)                                                         |
| Engine package | [`@loopover/engine`](packages/loopover-engine/README.md) — shared deterministic logic for the review stack and miner |
| Miner package  | [`@loopover/miner`](packages/loopover-miner/README.md) — local foundation CLI for the autonomous miner runtime       |
| API            | [API browser](https://loopover.ai/api) and [OpenAPI JSON](https://api.loopover.ai/openapi.json)                      |
| GitHub App     | [Setup docs](https://loopover.ai/docs/github-app) — self-hosting is the only currently available path                |

## MCP Install

```sh
npm install -g @loopover/mcp@latest
loopover-mcp login
loopover-mcp doctor
loopover-mcp --stdio
```

Print editor/client snippets:

```sh
loopover-mcp init-client --print codex
loopover-mcp init-client --print claude
loopover-mcp init-client --print cursor
```

For full editor setup and stdio configuration, use [MCP client setup](https://loopover.ai/docs/mcp-clients).

Run base-agent commands:

```sh
loopover-mcp agent plan --login jsonbored --json
loopover-mcp agent packet --login jsonbored --json
loopover-mcp agent status <run-id> --json
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

## Gittensor Contributor Impact

<p align="center">
  <a href="https://gittensor.io/miners/repository?name=JSONbored/loopover">
    <img src="https://raw.githubusercontent.com/JSONbored/loopover/gittensor-impact-assets/gittensor-impact-dark.svg" alt="Gittensor contributor impact" width="600">
  </a>
</p>

Refreshed weekly by [`.github/workflows/gittensor-impact.yml`](.github/workflows/gittensor-impact.yml).

## Project Links

| Need         | Link                               |
| ------------ | ---------------------------------- |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security     | [SECURITY.md](SECURITY.md)         |
| Support      | [SUPPORT.md](SUPPORT.md)           |
| Changelog    | [CHANGELOG.md](CHANGELOG.md)       |

Normal feature/fix PRs do not edit changelogs. Changelogs are release-prep artifacts.
