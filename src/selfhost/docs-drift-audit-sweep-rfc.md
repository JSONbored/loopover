# Scheduled docs-drift audit sweep — design doc (#3048)

Part of #1819 (self-host docs accuracy audit). Siblings: the mechanical presence/shape drift lint
(`scripts/check-docs-drift.ts`, "Phase 1") and schema-anchored examples ("Phase 2"). This RFC covers
the catch-all Phase 3: a recurring, low-noise sweep that catches **behavioral/prose** drift — a docs
claim that was true when written and quietly stopped being true — which neither sibling can catch
mechanically. Per the issue's own deliverables, this doc is the first step; the actual scheduled job
lands once the design below is agreed.

## What the two mechanical siblings already catch (and don't)

`scripts/check-docs-drift.ts` cross-checks five enumerable **presence** surfaces against specific docs
pages/examples: `LOOPOVER_REVIEW_*` feature flags (`src/env.d.ts`), `@loopover` command catalogs
(`src/github/commands.ts`), `*GateMode` fields (`src/types.ts`'s `RepositorySettings`), and the full
`RepositorySettings` + `FocusManifest` field surface against `.loopover.yml.example`
(`check-docs-drift.ts:1-11`). It answers "does every flag/command/field that exists in code also appear
somewhere in docs?" — a shape/presence check, anchored on declaration syntax (`extractLoopOverReviewFlags`,
`extractGateModeFields`, etc.), not on whether the *prose describing* that surface is still accurate.

That is precisely the gap this issue targets. The reported motivating case: "blocking is always
confirmed-contributor-gated" was duplicated verbatim across `docs.github-app.tsx`,
`docs.how-reviews-work.tsx`, and `docs.tuning.tsx`, and was wrong — the gate's confirmed-contributor
handling had changed underneath the claim. Every surface the claim touches (a `*GateMode` field, an env
flag) still existed and was still documented *somewhere*; the mechanical lint had nothing to flag,
because presence isn't behavior.

## Proposal: reuse the drift-report → consolidated-issue pipeline `fileUpstreamDriftIssues` already runs

`src/upstream/ruleset.ts`'s `fileUpstreamDriftIssues` (`ruleset.ts:275-331`) is an existing, working,
in-production instance of exactly the shape this sweep needs, already satisfying every hard requirement
below:

- **Kill-switch respecting**: checks `isGlobalAgentPause`/`isGlobalAgentFrozen` before any write
  (`ruleset.ts:283-285`), and the whole mechanism is flag-gated off by default
  (`LOOPOVER_AUTO_FILE_DRIFT_ISSUES`, `ruleset.ts:276-278`).
- **One issue per finding-run, not one per finding**: each open drift *report* maps to exactly one
  GitHub issue, found by a stable content fingerprint (`findGitHubIssueForFingerprint`) and then
  **updated in place** on a later run rather than re-created (`ruleset.ts:296-316`), with a no-op-diff
  short-circuit so an unresolved-but-unchanged report never spuriously re-notifies
  (`driftIssueUnchanged`, `ruleset.ts:302-309`).
- **Audited**: emits a single `upstream.drift_issues_filed` audit event per run with created/updated/
  skipped/unchanged counts (`ruleset.ts:326-330`), the same pattern `audit_events` already uses
  pervasively (`src/queue/processors.ts`).
- **Cron-wired at a deliberately slow cadence**: `refresh-upstream-drift` runs on the hourly tick
  (`src/index.ts:225`), but `file-upstream-drift-issues` itself only fires inside the six-hourly
  **full-sync window** (`src/index.ts:270-275`) — i.e. the detection and the issue-filing steps are
  already split into two differently-paced jobs, which is the same split this proposal needs (see
  below).

The proposal is to add a **new, analogous pair** — `docs-drift-audit-sweep` (detection: reads N docs
pages, re-verifies their behavioral claims, writes drift reports) and `file-docs-drift-issues`
(filing: turns open reports into one consolidated issue, reusing `fileUpstreamDriftIssues`'s
fingerprint/update-not-duplicate logic near-verbatim) — rather than inventing a new
detect-and-file-in-one-step mechanism. This is "reuse the most existing infrastructure" read literally:
the *filing* half needs no new design, only a second table + a second `env.LOOPOVER_AUTO_FILE_*` flag
mirroring the existing one.

## What's actually new: the detection step

Nothing in this codebase today reads a docs page's prose and re-verifies a specific behavioral claim
against current source — that half genuinely needs new code, gated behind the self-host AI provider
abstraction (`src/selfhost/ai.ts`'s `SelfHostAi`, the same interface `aiReviewMode`/`slopAiAdvisory`
already run their AI passes through, e.g. `src/services/ai-review.ts`). Concretely:

1. **Input**: one docs route file (e.g. `apps/loopover-ui/src/routes/docs.tuning.tsx`) plus a
   maintainer-curated list of the `src/`/`packages/` files it makes behavioral claims about. The 2026-07-04
   manual pass already established this page↔source mapping is tractable — the existing
   `docs.self-hosting-docs-audit.tsx` page (`SELFHOST_DOCS_PAGES` /
   `SELFHOST_SOURCE_OF_TRUTH_ROWS` in `apps/loopover-ui/src/lib/selfhost-docs-audit.ts`) is the
   in-repo precedent for exactly this page→source mapping, already covering the 20 self-hosting pages;
   this sweep's own page list should start from (and extend) that table rather than inventing a second one.
2. **Model**: a single AI pass per page — read the page's prose claims, read the mapped source file(s),
   report ONLY claims it can affirmatively contradict against currently-read source, each with a
   `file:line` citation. No `file:line` ⇒ no finding. This mirrors the issue's own hard requirement
   ("no finding without a real file:line citation, no speculative 'this might be stale'") and the
   existing AI-review call sites' shape: bounded, structured output, never free-form prose fed straight
   to a human.
3. **Output**: one `DocsDriftReportRecord` (new table, mirroring `upstream_drift_reports`' shape —
   `open`/status, a stable fingerprint per distinct claim, the page path, the cited `file:line`, the
   claim text, and the contradiction) per confirmed finding, written the same way
   `buildUpstreamDriftReport` (`ruleset.ts:335`) computes a report and `upsertUpstreamDriftReport`
   (`src/db/repositories.ts:1665`) persists it today.

## Scope-bounding (explicit requirement)

- **N pages per run, rotating**, not all ~35 docs pages from day one. Cron enqueues a fixed-size slice
  (e.g. 3-5 pages) each cycle, advancing a persisted cursor over the page list — the same
  "bounded-batch, cursor-advances-every-run" shape `repo-doc-refresh-sweep` already uses for its own
  per-repo eligibility fan-out (`src/index.ts:250-256`), just walking a static page list instead of a
  dynamic repo list.
- **Cadence**: monthly, per the issue's own suggestion — checked on the existing hourly cron tick with an
  `hour === X && dayOfMonth === Y` guard, mirroring `repo-doc-refresh-sweep`'s `hour === 9` daily guard
  and the maintainer-recap job's day/hour cadence check (`src/index.ts:264-269`). A monthly full lap over
  a 5-page/run, ~35-page corpus completes in ~7 cycles — well within a month at that cadence, so the
  "bounded cost, predictable" requirement holds without needing a larger per-run batch.
- **One consolidated issue per finding-*run***, not per finding: exactly `fileUpstreamDriftIssues`'s own
  shape (one row aggregating that run's findings â†’ one fingerprinted issue, updated on the next run if
  still open, never duplicated).

## Non-goals (explicitly out of scope for this sweep)

- Replacing or duplicating either mechanical sibling — this only covers claims neither can verify
  mechanically.
- Auto-editing docs pages. The sweep only files a findings issue for a human to act on, same as the
  upstream-drift pipeline never auto-edits `.loopover.yml`.
- A new AI-orchestration framework. The detection step is one bounded call per page through the existing
  `SelfHostAi` abstraction, not a new agentic loop.

## Open questions for maintainer sign-off before Phase 3 implementation begins

1. Confirm the page→source mapping seed list (extend `SELFHOST_DOCS_PAGES`'s 20 pages to the full ~35-page
   corpus, or scope this sweep to the self-hosting subset only for its first cut).
2. Confirm N (pages/run) and the monthly cadence, or adjust for cost/time predictability.
3. Confirm the new `docs_drift_reports` table + `LOOPOVER_AUTO_FILE_DOCS_DRIFT_ISSUES` flag naming, to keep
   parity with the `upstream_drift_reports` / `LOOPOVER_AUTO_FILE_DRIFT_ISSUES` precedent this whole design
   leans on.
