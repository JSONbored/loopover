# Cross-repo discovery — Phase 1 scope (re-scoped from #1060)

This document is the in-repo paper trail for [#2299](https://github.com/JSONbored/gittensory/issues/2299). It records the metadata-only, client-driven discovery model that supersedes the original [#1060](https://github.com/JSONbored/gittensory/issues/1060) wording (registered-repo aggregation and any retired global data layer). Maintainers should reopen #1060 and point its body at this file so the miner backlog has one canonical entry point.

Part of [#1058](https://github.com/JSONbored/gittensory/issues/1058) (close-the-loop epic). Builds on / supersedes the intent of [#816](https://github.com/JSONbored/gittensory/issues/816).

## Re-scoped discovery model

Cross-repo opportunity discovery in Phase 1 is:

- **Metadata-only** — GitHub search/listing APIs only; never source clone or upload.
- **Client-driven** — the contributor supplies the repo list or search scope; no dependency on a LoopOver-registered-repos table or any retired central global data layer.
- **Deterministic** — reuse existing per-repo signals; no new ML model and no raw reward/score/wallet/hotkey exposure.
- **Read-only (`wave: "1"`)** — every deliverable in this Phase 1 batch performs GET/list/search only; no GitHub writes, no autonomous claiming, no PR submission.

## Existing signal sources the ranker composes

The cross-repo ranker is a **new join over existing signals**, not a new scoring model:

| Source | Role |
|--------|------|
| [`src/services/issue-quality.ts`](../../../src/services/issue-quality.ts) | Loads or computes per-repo `IssueQualityReport` snapshots (actionable / needs-proof / stale / duplicate-prone / solved). |
| [`src/signals/reward-risk.ts`](../../../src/signals/reward-risk.ts) → [`packages/loopover-engine/src/reward-risk.ts`](../../../packages/loopover-engine/src/reward-risk.ts) | Opportunity factors (`competitionFactor`, `freshnessFactor`) for repo-level ranking; backend shim delegates to the engine implementation. |
| [`src/services/decision-pack.ts`](../../../src/services/decision-pack.ts) | Existing per-miner, per-repo opportunity pack (reactive baseline the Phase 1 tools extend). |

Hosted and stdio MCP surfaces expose the composed shortlist: `loopover_find_opportunities` on the hosted server, `loopover_find_opportunities` in the stdio `@loopover/mcp` CLI (renamed by #5648) (#2308 / #2309).

## Phase 1 issue batch

| Issue | Title |
|-------|-------|
| [#2299](https://github.com/JSONbored/gittensory/issues/2299) | Scope correction note (this document) |
| [#2300](https://github.com/JSONbored/gittensory/issues/2300) | `.loopover-miner.yml` MinerGoalSpec schema doc |
| [#2301](https://github.com/JSONbored/gittensory/issues/2301) | MinerGoalSpec parser with safe-default fallback |
| [#2302](https://github.com/JSONbored/gittensory/issues/2302) | Pure ranker — `potential × feasibility × laneFit × freshness × (1 − dupRisk)` |
| [#2303](https://github.com/JSONbored/gittensory/issues/2303) | Ranker invariant test suite |
| [#2304](https://github.com/JSONbored/gittensory/issues/2304) | Goal model — MinerGoalSpec → ranker weights |
| [#2305](https://github.com/JSONbored/gittensory/issues/2305) | Per-repo AI-policy map (CONTRIBUTING / AI-USAGE hard-skip) |
| [#2306](https://github.com/JSONbored/gittensory/issues/2306) | AI-policy fixture corpus + integration test |
| [#2307](https://github.com/JSONbored/gittensory/issues/2307) | Cross-repo GitHub search/listing fan-out (metadata-only) |
| [#2308](https://github.com/JSONbored/gittensory/issues/2308) | Hosted `loopover_find_opportunities` MCP tool |
| [#2309](https://github.com/JSONbored/gittensory/issues/2309) | Stdio `loopover_find_opportunities` in `@loopover/mcp` |
| [#2310](https://github.com/JSONbored/gittensory/issues/2310) | Miner package `test:miner-pack` / `build:miner` parity checks |
| [#2311](https://github.com/JSONbored/gittensory/issues/2311) | End-to-end Phase 1 discovery pipeline fixture test |

## Target feature issue (#1060)

[#1060 — proactive cross-repo opportunity discovery](https://github.com/JSONbored/gittensory/issues/1060) remains the umbrella feature issue. It should be **reopened** with this Phase 1 scope (metadata-only fan-out + deterministic ranker + MCP tool) replacing the older “aggregate across all registered repos” deliverable list. Proactive alerting and notification filters are follow-on work outside this read-only Phase 1 batch.

## Acceptance (Phase 1)

- A miner can ask for a deterministic, metadata-only, cross-repo ranked shortlist via MCP (`loopover_find_opportunities` hosted / `loopover_find_opportunities` stdio).
- AI-PR-banned repos are hard-skipped upstream and never appear in output.
- No raw scores, rewards, hotkeys, wallet data, or source contents cross the public boundary.
- All Phase 1 implementation issues stay read-only on GitHub (GET/search/list only).
