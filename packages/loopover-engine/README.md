# @loopover/engine

Shared, deterministic engine logic for the LoopOver review stack and the `loopover-miner`.

This package houses pure, side-effect-free logic (scoring preview/model, predicted-gate types, reward-risk,
slop signals, focus-manifest parse/compile core, duplicate-winner adjudication, and their engine-parity
fixtures) so the exact same code runs identically in the hosted review backend and in a local miner. It is
versioned independently of the app and published to npm as `@loopover/engine`.

The logic is extracted from the app's `src/` in follow-up issues; this skeleton keeps the package buildable in
the meantime. The root `package.json` already globs `packages/*` in its `workspaces` field, so `npm ci`
discovers this package with no additional wiring.

## Version pin

`ENGINE_VERSION` mirrors `package.json`'s `version` field and is exported from the package barrel so consumers can
log or assert which engine build produced a deterministic result.

## Build

```
npm run build --workspace @loopover/engine
```

This runs `tsc -p tsconfig.json`, emitting `dist/` (the only published output alongside `CHANGELOG.md`).

## Test

```
npm test --workspace @loopover/engine
```

Compiles the package and the `test/` suite (`node:test`) to plain JS and runs it — no experimental runtime
flags, so it works on the whole declared `engines` range.

Codecov (`codecov/patch`) only reads the root vitest suite, so modules that need a Codecov-visible mirror also
have a root test under `test/unit/` (e.g. `test/unit/reviewer-consensus-calibration.test.ts` for
`src/reviewer-consensus-calibration.ts` — #8349, or `test/unit/signal-tracking.test.ts` for
`src/calibration/signal-tracking.ts` — #8343). The package-local `node:test` suite remains the package's own
gate; the root mirror is what makes the same scenarios gradeable by Codecov.

## `opportunity-ranker`

The Phase-1 miner-discovery ranker. It composes five already-normalized `[0, 1]` signals into one ordinal score:

```
score = potential * feasibility * laneFit * freshness * (1 - dupRisk)
```

Every field is normalized before use, so a malformed upstream signal always degrades the score toward `0` rather
than inverting or overflowing it — but the two directions are handled asymmetrically:

- The four **positive** factors (`potential`, `feasibility`, `laneFit`, `freshness`) clamp into `[0, 1]`; a
  non-finite value (`NaN`/`±Infinity`) maps to `0`.
- **`dupRisk`** is clamped into `[0, 1]` like the others (below-range → `0`, above-range → `1`), so `-0.1` reads as
  no contention. The one exception: a **non-finite** `dupRisk` (`NaN`/`±Infinity`) can't be clamped, so it **fails
  closed** to `1` (maximum risk) rather than `0` — a broken contention signal must never masquerade as safe.

Any single factor at `0` (or a `dupRisk` of `1`) collapses the whole score to `0`.

```ts
import { rankOpportunities, rankOpportunityScore } from "@loopover/engine";

rankOpportunityScore({ potential: 0.9, feasibility: 0.8, laneFit: 1, freshness: 0.7, dupRisk: 0.1 }); // → 0.4536

rankOpportunities(candidates); // sorted by descending score, each annotated with `rankScore`
```

`rankOpportunities` is a stable sort with an explicit index tie-break: candidates with an equal score keep their
input order.

## Objective-anchor calibration

`scoreObjectiveAnchor()` provides the deterministic half of historical replay calibration. It compares the structural
features of a miner replay against the revealed post-snapshot history without any model call, network call, wall-clock
read, or random input.

The score is intended for replay harnesses that need an auditable floor before a pairwise judge runs. Callers pass
the replayed plan or PR target data and the revealed history target data:

```ts
import { scoreObjectiveAnchor } from "@loopover/engine";

const result = scoreObjectiveAnchor({
  replayed: {
    paths: ["packages/loopover-engine/src/opportunity-ranker.ts"],
    labels: ["feature"],
    titles: ["feat(miner): add deterministic opportunity ranking"],
  },
  revealed: {
    paths: ["packages/loopover-engine/src/objective-anchor.ts"],
    labels: ["feature"],
    titles: ["feat(miner): add objective-anchor calibration scoring"],
  },
});
```

The returned object includes:

- `score`: a composite value in `[0, 1]`.
- `dimensions.paths`: exact/tight path overlap.
- `dimensions.modules`: coarser module overlap, so a replay that targets the right package but the wrong file receives
  visible partial credit.
- `dimensions.changeKinds`: overlap between caller-supplied or inferred change classes.
- `audit`: normalized replayed/revealed feature sets, intersections, misses, and normalized weights.

The default weight split is path-heavy but still gives module-level and kind-level signal:

```ts
{
  paths: 0.45,
  modules: 0.4,
  changeKinds: 0.15
}
```

Custom weights are normalized to sum to `1`. Negative, non-finite, or otherwise invalid weights are treated as `0`;
if every provided weight is unusable, the defaults are restored.

Feature extraction is intentionally conservative:

- Paths are normalized to lowercase slash paths, deduplicated, and sorted.
- Modules are derived only from paths, never guessed from free text.
- Change kinds can come from explicit `changeKinds`, issue/PR labels, titles, notes, and path conventions.
- If no change-kind signal exists, the kind is `unknown` so an opaque replay and opaque revealed history can still be
  compared deterministically.

Given the same inputs, `JSON.stringify(scoreObjectiveAnchor(input))` is byte-stable across runs.

Replay harnesses that already represent the two sides as arrays of plans, PRs, or commits can use the history
helpers instead:

```ts
import { scoreObjectiveAnchorHistory } from "@loopover/engine";

const result = scoreObjectiveAnchorHistory({
  replayed: [
    {
      id: "plan:objective-anchor",
      source: "plan",
      paths: ["packages/loopover-engine/src/objective-anchor.ts"],
      labels: ["feature"],
    },
  ],
  revealed: [
    {
      id: "pr:3142",
      source: "pull_request",
      paths: ["packages/loopover-engine/src/objective-anchor.ts"],
      labels: ["feature"],
    },
  ],
});
```

`result.history.replayed.items` and `result.history.revealed.items` preserve the per-record normalized features, while
`result.audit` shows the aggregate intersections and misses used for the score. Empty histories remain valid inputs:
they produce empty path/module sets and an `unknown` change kind rather than throwing, so a replay batch can record a
low-information calibration row without special casing.

For local replay artifacts, `renderObjectiveAnchorAuditMarkdown(result)` turns either score shape into a deterministic
Markdown report. It includes dimensions, weights, normalized feature sets, intersections, misses, and per-item history
evidence when present. Report values are escaped and collapsed to one line so caller-supplied ids or paths cannot
reshape the artifact.

## Pairwise calibration

`computePairwiseCalibrationScore()` is the deterministic half of the order-swapped pairwise judge layer. The miner
runtime owns the model calls; the engine package owns the stable post-processing contract:

- run a judge attempt in both presentation orders,
- accept only outcomes that agree after inverting the swapped-order verdict,
- discard `incomparable` and order-flipping attempts,
- cap retries,
- track order-instability rate,
- combine the surviving pairwise average with the objective-anchor score.

```ts
import { computePairwiseCalibrationScore } from "@loopover/engine";

const result = computePairwiseCalibrationScore({
  objectiveAnchor: 0.55,
  samples: [
    {
      attempts: [
        {
          replayFirst: "replay_better",
          revealedFirst: "revealed_better",
        },
      ],
    },
  ],
});
```

If every pairwise sample is unstable, the composite falls back to the objective-anchor score and records the failed
samples in `metrics` rather than averaging noise into the calibration signal.

## Structured gate-verdict calibration

`resolveGateVerdictCalibrationConfig()`, `ingestGateVerdictCalibrationSignals()`, and
`computeGateVerdictCompositeCalibrationScore()` provide the pure engine contract for opt-in cross-product calibration.
The hosted review stack remains responsible for loading the repo's current `.loopover.yml` or
private config; the engine contract is deliberately default-off and safe to call at ingestion time.

The preferred config-as-code surface is:

```yaml
miner:
  calibration:
    shareStructuredGateVerdicts: true
    structuredGateVerdictWeight: 0.2
```

Only `shareStructuredGateVerdicts: true` enables ingestion. Missing, malformed, or falsey values all fail closed to no
sharing. The optional weight is non-negative and finite; malformed values fall back to the default.

The accepted signal is intentionally narrow. It contains repo/run ids plus structured dimension outcomes such as
`correctness`, `tests`, `security`, `scope`, `freshness`, `ci`, and `policy`. It has no fields for raw review text,
secrets, trust scores, reward values, private rankings, or maintainer evidence.

```ts
import {
  computeGateVerdictCompositeCalibrationScore,
  ingestGateVerdictCalibrationSignals,
} from "@loopover/engine";

const gateVerdicts = ingestGateVerdictCalibrationSignals([
  {
    repoFullName: "jsonbored/loopover",
    replayRunId: "replay-2026-07-04",
    gateRunId: "gate-123",
    optedIn: true,
    dimensions: [
      { dimension: "correctness", outcome: "pass" },
      { dimension: "tests", outcome: "warn" },
      { dimension: "security", outcome: "pass" },
    ],
  },
]);

const score = computeGateVerdictCompositeCalibrationScore({
  objectiveAnchor: 0.65,
  pairwise: 0.8,
  gateVerdicts,
});
```

The composite scorer renormalizes weights when a signal is absent. For example, if a repo opts out or no valid
structured dimensions remain, the structured gate-verdict weight drops to zero and the objective/pairwise signals are
renormalized. The returned audit trail records which opted-in repos contributed to the replay run and which rows were
rejected because the repo was not opted in, had invalid ids, or exposed no recognized structured dimensions.

`renderGateVerdictCalibrationAuditMarkdown(result)` turns the composite result into a deterministic local artifact with
component scores, effective weights, contributing repos, dimension tables, rejected rows, and a contributing-repo
summary. All caller-supplied ids and repo names are Markdown-escaped and newline-collapsed before rendering.

## Phase 7 calibration loop

`computePhase7CalibrationLoop()` wires the historical-replay composite score into the live Phase 7 calibration loop
alongside the passive pr_outcome signal. The module tracks a combined calibration-accuracy metric against the
documented 62% baseline, records provenance per source, recommends replay-run cadence, and fail-closes autonomy-level
increases when the replay harness is missing, stale, degraded, or below the configured threshold.

The loop is default-off and must be enabled explicitly:

```yaml
miner:
  calibration:
    phase7LoopEnabled: true
    autonomyIncreaseMinAccuracy: 0.70
    replayFreshnessMaxAgeHours: 168
    historicalReplayWeight: 0.5
    prOutcomeWeight: 0.5
```

When enabled, autonomy-level increases require a fresh healthy historical-replay run plus enough live pr_outcome samples.
If the replay harness is degraded or unavailable, the loop sets an explicit hold flag instead of silently falling back
to pr_outcome-only gating.

```ts
import {
  computePhase7CalibrationLoop,
  shouldScheduleHistoricalReplayRun,
} from "@loopover/engine";

const prOutcome = {
  mergeConfirmed: 74,
  mergeFalse: 26,
  closeConfirmed: 0,
  closeFalse: 0,
  observedAt: "2026-07-04T18:00:00Z",
};

const loop = computePhase7CalibrationLoop({
  config: {
    phase7LoopEnabled: true,
    autonomyIncreaseMinAccuracy: 0.7,
    replayFreshnessMaxAgeHours: 168,
    historicalReplayWeight: 0.5,
    prOutcomeWeight: 0.5,
    prOutcomeMinDecided: 10,
    warnings: [],
  },
  prOutcome,
  historicalReplay: {
    compositeScore: 0.82,
    replayRunId: "replay-2026-07-04",
    observedAt: "2026-07-04T12:00:00Z",
    harnessStatus: "healthy",
  },
  now: "2026-07-04T18:00:00Z",
});

const schedule = shouldScheduleHistoricalReplayRun({
  config: {
    phase7LoopEnabled: true,
    autonomyIncreaseMinAccuracy: 0.7,
    replayFreshnessMaxAgeHours: 168,
    historicalReplayWeight: 0.5,
    prOutcomeWeight: 0.5,
    prOutcomeMinDecided: 10,
    warnings: [],
  },
  lastReplayObservedAt: loop.bySource.historical_replay.observedAt,
  harnessStatus: loop.replayHarnessStatus,
  now: "2026-07-04T18:00:00Z",
});
```

`renderPhase7CalibrationAuditMarkdown(loop)` turns the result into a deterministic local artifact with the combined
metric, baseline delta, per-source breakdown, hold reasons, and replay cadence state.

`computePrOutcomeCalibrationAccuracy()` is a read-only helper for inspecting derived accuracy from raw gate-eval
counters; pass the counters themselves into `computePhase7CalibrationLoop()`, not the helper result.

## Track-record summary

`computeTrackRecordSummary()` and `renderTrackRecordSummaryMarkdown()` provide a portable first-contact summary for a
miner identity. The summary is computed client-side from already-public PR outcomes plus public conduct/moderation
records, then rendered as a short Markdown block for a PR body or first comment.

The feature is default-off and must be enabled explicitly:

```yaml
miner:
  trackRecordSummary:
    enabled: true
```

The computation only counts resolved PR outcomes attributable to the requested login. Merged PRs contribute to the
numerator, closed-without-merge PRs contribute to the denominator, and open PRs are reported as ignored so in-flight
work cannot inflate or deflate the public rate. Tenure is derived from the earliest observed public PR timestamp, and a
clean conduct line is emitted only when no active public incident record is present for the login.

```ts
import {
  computeTrackRecordSummary,
  renderTrackRecordSummaryMarkdown,
  resolveTrackRecordSummaryConfig,
} from "@loopover/engine";

const config = resolveTrackRecordSummaryConfig({
  miner: { trackRecordSummary: { enabled: true } },
});

const summary = computeTrackRecordSummary({
  login: "octo-miner",
  config,
  now: "2026-07-04T18:00:00Z",
  outcomes: [
    {
      repoFullName: "JSONbored/loopover",
      authorLogin: "octo-miner",
      state: "merged",
      createdAt: "2026-06-01T00:00:00Z",
      mergedAt: "2026-06-02T00:00:00Z",
    },
  ],
  incidents: [],
});

const markdown = renderTrackRecordSummaryMarkdown(summary);
```

The rendered block is intentionally narrow: login, resolved public PR counts, public merge rate, public tenure, conduct
status, and optional public evidence URLs for active incidents. Caller-provided ids, PR URLs, and arbitrary metadata are
never copied into the Markdown, and the renderer fails closed if a blocked private-field name is introduced.

## Structured finding-severity calibration

`resolveFindingSeverityCalibrationConfig()`, `ingestFindingSeverityCalibrationSignals()`, and
`computeFindingSeverityCompositeCalibrationScore()` provide the pure engine contract for the opt-in finding-severity
calibration signal. It sits in the same family as objective-anchor and pairwise-judge: the hosted review stack decides
whether a repo is opted in from its resolved `.loopover.yml`/private config, and the engine contract is
deliberately default-off and safe to call at ingestion time.

The preferred config-as-code surface is:

```yaml
miner:
  calibration:
    shareStructuredFindingSeverity: true
    structuredFindingSeverityWeight: 0.2
```

Only `shareStructuredFindingSeverity: true` enables ingestion. Missing, malformed, or falsey values all fail closed to
no sharing. `calibration.shareStructuredFindingSeverity` is accepted as a narrow top-level alias. The optional weight is
non-negative and finite; malformed values fall back to the default.

The accepted signal is intentionally narrow: repo/run ids plus, per severity tier (`blocker`, `warning`, `advisory`,
`nit`), how many findings the review raised and how many were subsequently CONFIRMED (true positives). It has no fields
for raw review text, secrets, trust scores, reward values, private rankings, or maintainer evidence.

```ts
import {
  computeFindingSeverityCompositeCalibrationScore,
  ingestFindingSeverityCalibrationSignals,
} from "@loopover/engine";

const findingSeverity = ingestFindingSeverityCalibrationSignals([
  {
    repoFullName: "jsonbored/loopover",
    replayRunId: "replay-2026-07-04",
    reviewRunId: "review-123",
    optedIn: true,
    tiers: [
      { tier: "blocker", total: 2, confirmed: 2 },
      { tier: "warning", total: 5, confirmed: 3 },
      { tier: "nit", total: 9, confirmed: 1 },
    ],
  },
]);

const score = computeFindingSeverityCompositeCalibrationScore({
  objectiveAnchor: 0.65,
  pairwise: 0.8,
  findingSeverity,
});
```

The per-PR score is the severity-and-volume-weighted mean of the per-tier confirmation rates, so a confirmed blocker
moves calibration far more than a confirmed nit, and a review that raises blockers which are then dismissed (false
positives at the most disruptive tier) calibrates poorly. Each tier's `confirmed` count is clamped to its `total` and
discounted by an optional per-tier `confidence`, so an unverified "all confirmed" claim cannot inflate the score.

The composite scorer renormalizes weights when a signal is absent: if a repo opts out or no tier survives
normalization, the structured finding-severity weight drops to zero and the objective/pairwise signals are
renormalized. The returned audit trail records which opted-in repos contributed and which rows were rejected because the
repo was not opted in, had invalid ids, or exposed no recognized non-empty tiers.

`renderFindingSeverityCalibrationAuditMarkdown(result)` turns the composite result into a deterministic local artifact
with component scores, effective weights, contributing repos, per-tier tables, rejected rows, and a contributing-repo
summary. All caller-supplied ids and repo names are Markdown-escaped and newline-collapsed before rendering.

## Structured reviewer-consensus calibration

`resolveReviewerConsensusCalibrationConfig()`, `ingestReviewerConsensusCalibrationSignals()`, and
`computeReviewerConsensusCompositeCalibrationScore()` provide the pure engine contract for the opt-in
reviewer-consensus calibration signal. When a review runs more than one independent reviewer (multiple models, or the
same model sampled multiple times), each reviewer casts a per-dimension verdict; this signal measures how much they
**agree**. It is a companion to the pairwise judge (which measures order-stability of a single judge) at the level of
independent reviewers, and — like the rest of the family — the engine contract is deliberately default-off and safe to
call at ingestion time.

The preferred config-as-code surface is:

```yaml
miner:
  calibration:
    shareStructuredReviewerConsensus: true
    structuredReviewerConsensusWeight: 0.2
```

Only `shareStructuredReviewerConsensus: true` enables ingestion. Missing, malformed, or falsey values all fail closed to
no sharing. `calibration.shareStructuredReviewerConsensus` is accepted as a narrow top-level alias. The optional weight
is non-negative and finite; malformed values fall back to the default.

The accepted signal is intentionally narrow: repo/run ids plus, per dimension (`correctness`, `tests`, `security`,
`maintainability`, `scope`, `freshness`, `ci`, `policy`), the set of independent reviewer votes (`pass`/`warn`/`fail`).
It has no fields for raw review text, secrets, trust scores, reward values, private rankings, or maintainer evidence.

```ts
import {
  computeReviewerConsensusCompositeCalibrationScore,
  ingestReviewerConsensusCalibrationSignals,
} from "@loopover/engine";

const reviewerConsensus = ingestReviewerConsensusCalibrationSignals([
  {
    repoFullName: "jsonbored/loopover",
    replayRunId: "replay-2026-07-05",
    reviewRunId: "review-123",
    optedIn: true,
    dimensions: [
      { dimension: "correctness", votes: ["pass", "pass", "pass"] },
      { dimension: "security", votes: ["fail", "warn", "fail"] },
    ],
  },
]);

const score = computeReviewerConsensusCompositeCalibrationScore({
  objectiveAnchor: 0.65,
  pairwise: 0.8,
  reviewerConsensus,
});
```

Per dimension, unrecognized and abstention votes are dropped, the remaining votes are tallied, the plurality outcome is
chosen (ties broken toward the more severe outcome so a genuine split never rounds a real `fail`/`warn` down to `pass`),
and the **agreement** fraction is the plurality's share of the definite votes. The per-PR score is the
**vote-count-weighted** mean of the per-dimension agreements, so a dimension reviewed by more reviewers carries more
weight than one seen by a single reviewer.

The composite scorer renormalizes weights when a signal is absent: if a repo opts out or no dimension carries a definite
vote, the structured reviewer-consensus weight drops to zero and the objective/pairwise signals are renormalized. The
returned audit trail records which opted-in repos contributed and which rows were rejected because the repo was not
opted in, had invalid ids, or exposed no definite per-dimension votes.

`renderReviewerConsensusCalibrationAuditMarkdown(result)` turns the composite result into a deterministic local artifact
with component scores, effective weights, contributing repos, per-dimension agreement tables, rejected rows, and a
contributing-repo summary. All caller-supplied ids and repo names are Markdown-escaped and newline-collapsed before
rendering.

## Plan templates

`plan-templates.ts` exports one builder per miner lifecycle stage (`analyze`, `plan`, `prepare`, `create`, `manage`).
Each builder returns `RawPlanStep[]` in the shape accepted by `loopover_build_plan`. Templates are pure data — they
describe step ordering via `dependsOn` but never actuate anything.

## Plan DAG status helpers

`plan-export.ts` renders a validated `PlanDag`; the helpers below are pure predicates over that shape for miner and
dashboard progress summaries:

- `countPlanSteps(plan)` — total step count
- `countPlanStepsByStatus(plan, status)` — steps matching a `PlanStepStatus`
- `isPlanEmpty(plan)` — whether the plan has no steps
- `isPlanFullyCompleted(plan)` — every step is `completed` (empty plans are not complete)
- `hasPlanFailedSteps(plan)` — any step is `failed`
- `hasPlanPendingSteps(plan)` — any step is `pending`
- `hasPlanRunningSteps(plan)` — any step is `running`
- `hasPlanSkippedSteps(plan)` — any step is `skipped`
- `hasPlanCompletedSteps(plan)` — any step is `completed`
- `isPlanBlocked(plan)` — pending steps remain but none are runnable (deadlock; mirrors `planProgress`'s `blocked` status)
- `isPlanProgressComplete(plan)` — every step is `completed` or `skipped` (empty plans are not complete; mirrors `planProgress`'s `completed` status)
- `resolvePlanOverallStatus(plan)` — coarse status (`pending` | `running` | `completed` | `failed` | `blocked`); mirrors `planProgress`'s `status`
- `hasPlanReadySteps(plan)` — any step is runnable now (`pending` with satisfied dependencies; mirrors `nextReadySteps(plan).length > 0`)
- `isPlanTerminated(plan)` — plan reached a terminal outcome (`failed` step or every step `completed`/`skipped`; empty plans are not terminated)

## Opportunity competition

`computeOpportunityCompetition(highRiskDuplicateClusters, openPullRequests)` mirrors the hosted
`opportunityCompetitionFactor` in `src/signals/reward-risk.ts`, producing a `[0, 1]` signal suitable for the ranker's
`dupRisk` input.

## Metadata opportunity signals

`opportunity-metadata.ts` turns fan-out issue metadata into the five normalized ranker inputs:

- `computeMetadataPotential` — label-based upside estimate
- `computeMetadataFeasibility` — comment load + issue age + title quality
- `computeMetadataDupRisk` — same-repo title overlap inside a candidate batch
- `computeMetadataLaneFit` — label-only lane fit by default; honors optional `candidatePaths` via `computeLaneFit`
- `buildMetadataRankInput` — composes freshness, competition, lane fit, and the metadata heuristics
- `rankMetadataOpportunities` — sorts candidates with `rankOpportunities`

`computeOpportunityFreshness` and `computeOpportunityCompetition` mirror the hosted reward-risk helpers with pure,
injected-clock semantics for local miners.

`computeLaneFit` (in `goal-model.ts`, composed here through `computeMetadataLaneFit`) has a Codecov-visible root
mirror at `test/unit/goal-model.test.ts` (#8344) — `codecov/patch` only reads the root vitest suite (see
[Test](#test)), so its lane-fit precedence and glob-matcher branches are gradeable there as well as by the
package's own `node:test` suite.

## AI Policy Map

`scanAiPolicyText` and `resolveAiPolicyVerdict` provide the deterministic policy gate used by miner discovery.
They only deny on small, explicit AI-contribution ban phrases in `AI-USAGE.md` or `CONTRIBUTING.md`; ambiguous,
missing, or empty policy text stays allowed so discovery does not invent a ban.

`resolveAiPolicyFatigueVerdict()` adds a softer metadata-only tier for repos that show signs of AI-contribution
fatigue before a formal ban lands. It keeps the hard-ban verdict authoritative and attaches a separate `fatigue`
object instead of changing `allowed`:

```ts
import { resolveAiPolicyFatigueVerdict } from "@loopover/engine";

const verdict = resolveAiPolicyFatigueVerdict({
  now: "2026-07-05T00:00:00Z",
  docs: {
    aiUsage: null,
    contributing: "Please keep pull requests focused.",
  },
  pullRequests: [
    {
      state: "closed",
      title: "AI-assisted parser cleanup",
      labels: ["ai-generated"],
      closedAt: "2026-07-04T00:00:00Z",
      reviewDecision: "changes_requested",
      maintainerResponse: "terse_rejection",
    },
  ],
  docChanges: [
    {
      path: "CONTRIBUTING.md",
      changedAt: "2026-07-04T12:00:00Z",
      addedPhrases: ["Disclose AI or automation assistance."],
    },
  ],
});
```

The fatigue verdict has four levels:

- `none` leaves ranking unchanged and uses a long recheck interval.
- `watch` and `deprioritize` return `priorityAdjustment: "deprioritize"` so miners can rank the repo lower without
  treating it as banned.
- `defer` returns `priorityAdjustment: "defer"` with a short recheck interval for stronger but still reversible
  signals.

Evidence is deliberately metadata-only: AI-attributed closed PR rows, terse/template rejection metadata, and recent
AI/automation language added to policy docs that does not match a formal ban phrase. `renderAiPolicyFatigueMarkdown()`
turns the verdict into a deterministic observability artifact. Fresh cache entries can be passed back through
`cache`; expired entries are recomputed.

Miner ranking/fanout code can pass the verdict to `applyAiPolicyFatigueToRankInput()`. Formal bans still zero the
candidate, but fatigue-only verdicts merely reduce `potential` (`watch` = 0.7x, `deprioritize` = 0.35x, `defer` =
0.05x) and carry a `deferUntilHours` hint when the repo should be revisited later.

`createAiPolicyFatigueCacheEntry()` and `describeAiPolicyFatigueCache()` provide the cache surface for the miner's
shorter fatigue recheck interval. Cache keys normalize repo names to lowercase `owner/name`, record an ISO
`computedAt`, and are considered fresh for 24 hours.

## Governor primitives

`src/governor/` holds nine pure, side-effect-free decision calculators for the local (miner-side) Governor. Each
computes a verdict from injected inputs only — it never stores state, schedules, performs I/O, or calls
`Math.random`; bucket mutation, persistence, and enforcement wiring are the miner-lib wrapper's concern (the same
engine-pure / miner-lib-stateful split every module uses). Open the named source file for the full API.

- **`rate-limit.ts`** — rolling-window rate limiting + jittered exponential backoff from an injected random
  source. `evaluateLocalRateLimit(config, bucket, now)` → `LocalRateLimitDecision`, plus `jitteredBackoffMs`.
  Types: `LocalRateLimitConfig`, `LocalRateBucket`.
- **`budget-cap.ts`** — cumulative spend / turn / termination-time ceilings combined into one verdict. A sibling
  to `rate-limit.ts`, not built on it: these are monotonic counters across a whole run, not a resetting window.
  `evaluateGovernorCaps(limits, usage)` → `GovernorCapReport`. Types: `GovernorCapLimits`, `GovernorCapUsage`,
  `GovernorCapDimension`.
- **`self-plagiarism.ts`** — classifies a prospective PR's diff fingerprint against the miner's own recent
  submissions; sparse or ambiguous timing fails closed (deny), reusing the earliest-wins duplicate-cluster
  election. `fingerprintFromChangedFiles`, `fingerprintSimilarity`, `selfPlagiarismCheck`. Types:
  `SelfPlagiarismConfig`, `OwnSubmissionRecord`, `SelfPlagiarismVerdict`.
- **`reputation-throttle.ts`** — self-reputation cadence math: a repo's own recent merged-vs-rejected ratio
  degrades submission cadence toward a floor and restores it on recovery (never a permanent ban), reading local
  history only. `selfReputationThrottle(...)` → `SelfReputationThrottleDecision`. Types:
  `SelfReputationThresholds`, `RepoOutcomeHistory`.
- **`write-rate-limit.ts`** — composes `evaluateLocalRateLimit` with global + per-repo buckets and jittered retry
  scheduling, returning updated in-memory bucket snapshots. `evaluateWriteRateLimit(...)` → `WriteRateLimitVerdict`
  (blocked reason in `WriteRateLimitBlockedBy`). Types: `WriteRateLimitPolicies`, `WriteRateLimitBucketStore`.
- **`run-halt.ts`** — evaluated at each run-loop iteration boundary: composes a non-convergence detector with the
  budget/turn/termination caps; either signal halts the run until a human clears it (`clearRunLoopHalt`).
  `evaluateRunLoopHalt(...)` → `RunLoopHaltVerdict`, plus `detectNonConvergence`. Types: `RunLoopHaltReason`,
  `NonConvergenceSignal`.
- **`kill-switch.ts`** — the emergency-halt primitive every write-adjacent decision consults FIRST: a GLOBAL env
  switch (`MINER_KILL_SWITCH_ENV_VAR`) halts every repo at once; a PER-REPO switch (`.loopover-miner.yml`'s
  `killSwitch.paused`) halts only that repo's queue while the rest of the fleet runs. `resolveMinerKillSwitch(...)`,
  `isMinerKillSwitchActive`. Types: `MinerKillSwitchScope`.
- **`action-mode.ts`** — resolves the miner's overall action mode with "safest wins" precedence
  (`paused > dry_run > live`); a miner with no explicit opt-in anywhere defaults to `dry_run`, never `live` — the
  deny-by-default floor. `resolveMinerActionMode(...)`, `minerActionModeExecutes(...)`. Types: `MinerActionMode`,
  `MINER_LIVE_MODE_OPT_IN`.
- **`chokepoint.ts`** — the single fail-closed decision point every miner write action passes through before
  executing. `evaluateGovernorChokepoint(input)` composes the other eight into one `GovernorDecision` under a
  **"safest wins" precedence ladder**: `global kill-switch > per-repo pause > dry-run > rate-limit >
  budget/turn/termination cap > non-convergence > self-reputation throttle > self-plagiarism > allow`. The most
  restrictive signal decides, and any stage that throws denies immediately (`stage: "internal_error"`) rather than
  falling through to `allow`. Types: `GovernorChokepointInput`, `GovernorDecisionStage`.

These modules compute the *decisions*; the append-only record of what was decided is the separate *storage* contract
in [Governor ledger](#governor-ledger) below (`allowed` / `denied` / `throttled` / `kill_switch`), which the
chokepoint's returned ledger event feeds.

`action-mode.ts`'s dry-run-by-default precedence (`resolveMinerActionMode` and siblings) has a Codecov-visible
root mirror at `test/unit/miner-governor-action-mode.test.ts` (#8345) — `codecov/patch` only reads the root
vitest suite (see [Test](#test)), so this safety-adjacent write-execution gate is gradeable there as well as by
the package's own `node:test` suite, alongside the existing `test/unit/miner-governor-kill-switch.test.ts` mirror.

## Governor ledger

`normalizeGovernorLedgerEvent` validates append-only governor decision rows before the local miner persists them.
The vocabulary is fixed (`allowed`, `denied`, `throttled`, `kill_switch`) and unknown event types fail closed. This
module defines the storage contract only — it does not wire into live governor enforcement yet. (#2328)

## Tenant quota

`evaluateTenantQuota(usage, quota)` (`tenant-quota.ts`) is the pure per-tenant resource-quota evaluator for
Rent-a-Loop hosting: given a tenant's metered `TenantUsage` and its allocated `TenantQuota`, it decides
whether the tenant may run more work and, if not, which dimension is exhausted and why. Like the governor
modules above it is decision-only — it does not store usage, meter compute, or stop a loop; that enforcement
wiring is separate and maintainer-owned.

- `TenantQuota` — the allocation ceilings: `computeUnits`, `wallClockMs`, `maxConcurrentLoops`.
- `TenantUsage` — the tenant's metered consumption: `computeUnitsUsed`, `wallClockMsUsed`, `activeLoops`.
- `QuotaDimension` — `"compute" | "time" | "concurrency"`.
- `TenantQuotaDecision` — `{ allowed, exceeded, reason, remaining }`, where `exceeded` is the first exhausted
  `QuotaDimension` (or `null`), `reason` is a user-facing message (or `null` when allowed), and `remaining` is
  the per-dimension headroom (`computeUnits` / `wallClockMs` / `concurrentLoops`, never negative).

Dimensions are checked in a fixed precedence — compute, then time, then concurrency — and the FIRST exhausted
one is reported, so the tenant gets a single actionable message. A dimension counts as exhausted at `>=` its
cap (a tenant that has consumed its whole allocation is stopped, not allowed one more over the line), and every
input is normalized to a non-negative integer so a non-finite or negative value can never make a decision
`NaN`, fractional, or negative. It reads only the given tenant's numbers, so one tenant hitting quota never
affects another's decision.

```ts
import { evaluateTenantQuota } from "@loopover/engine";

const quota = { computeUnits: 1000, wallClockMs: 3_600_000, maxConcurrentLoops: 3 };

// Within quota -> allowed
evaluateTenantQuota({ computeUnitsUsed: 200, wallClockMsUsed: 60_000, activeLoops: 1 }, quota);
// { allowed: true, exceeded: null, reason: null,
//   remaining: { computeUnits: 800, wallClockMs: 3_540_000, concurrentLoops: 2 } }

// Compute exhausted -> blocked (compute is reported first, ahead of time and concurrency)
evaluateTenantQuota({ computeUnitsUsed: 1000, wallClockMsUsed: 60_000, activeLoops: 1 }, quota);
// { allowed: false, exceeded: "compute",
//   reason: "Quota exceeded: you have used all 1000 compute units in your current allocation. Increase your allocation or wait for the next period before running more.",
//   remaining: { computeUnits: 0, wallClockMs: 3_540_000, concurrentLoops: 2 } }
```

## MinerGoalSpec

`MinerGoalSpec` is the type surface for a repo's `.loopover-miner.yml` (miner-side analogue of `.loopover.yml`).
`DEFAULT_MINER_GOAL_SPEC` is the safe default a repo with no file behaves as — minable (`minerEnabled: true`, an
explicit opt-out), no path/label preferences, one concurrent claim, `neutral` discovery.

`parseMinerGoalSpec(raw)` and `parseMinerGoalSpecContent(content)` are the tolerant parser pair for that file. They
never throw on malformed JSON/YAML; instead they return `{ present, spec, warnings }`, where `spec` is normalized to
safe defaults and `warnings` explains any dropped or invalid fields.

`discoverMinerGoalSpecPath(exists)` returns the first present file in the documented order (`MINER_GOAL_SPEC_FILENAMES`:
`.loopover-miner.yml` → `.github/loopover-miner.yml` → the `.json` variants). It is IO-free — the caller injects
the existence check — so a caller reads the returned path and feeds its content to `parseMinerGoalSpecContent`. See
`.loopover-miner.yml.example` for the documented fields.

## AmsPolicySpec

`AmsPolicySpec` is the type surface for `.loopover-ams.yml` — the OPERATOR's own execution-risk policy for
their miner (`submissionMode`, `slopThreshold`, `capLimits`, `convergenceThresholds`, `maxIterations`,
`maxTurnsPerIteration`), a deliberate structural sibling to `MinerGoalSpec` but answering a different question: `MinerGoalSpec` is what the target repo wants
from being mined; `AmsPolicySpec` is how aggressive the operator wants their own agent to be. No field on this
type lets a target repo's own file loosen what an operator's agent is willing to do — see the type's own header
comment for why that boundary is load-bearing. `DEFAULT_AMS_POLICY_SPEC` is deny-by-default: `"observe"`
submission mode (computes real decisions but never actually submits) and a `"low"` (strict) slop threshold.

`parseAmsPolicySpec(raw)` / `parseAmsPolicySpecContent(content)` are the same tolerant-parser pair shape as
`MinerGoalSpec`'s — never throw, return `{ present, spec, warnings }`.

Unlike `MinerGoalSpec`, this package does not resolve `.loopover-ams.yml` from the filesystem itself (this
package is IO-free) — `packages/loopover-miner/lib/ams-policy.js`'s `resolveAmsPolicy` is the real caller.
That resolver reads only the operator's local policy and otherwise uses safe defaults; it intentionally does not
fetch a target repo's checked-in AMS policy, because untrusted repo content must not loosen operator-side budget,
turn, slop, or submission controls. See `.loopover-ams.yml.example`.

## Rent-a-Loop pipeline

The customer-facing spine of Rent-a-Loop (epic #4778) is three pure, side-effect-free modules — idea → running
loop → delivered result. Like the rest of this package they do no IO, network, wall-clock, or random reads: each
is a deterministic transform of already-computed inputs.

### `idea-intake.ts` — idea → scored, claimable task-graph

Turns a freeform renter idea into a strict task-graph and dispositions it against the shared feasibility gate.
`validateIdeaSubmission(raw)` returns a discriminated `IdeaValidationResult` (`{ ok: true, idea }` or
`{ ok: false, errors }`), length-capping the freeform text (`IDEA_TITLE_MAX_CHARS` / `IDEA_BODY_MAX_CHARS` /
`IDEA_CONSTRAINT_MAX_CHARS`). `buildTaskGraph(idea, drafts?)` decomposes an accepted `IdeaSubmission` into a
`TaskGraph` of `ConstituentIssue`s (`gittensor:priority` is never emitted — it is maintainer-propagated only).
`scoreTaskGraph(graph)` runs the feasibility gate over every issue (`TaskGraphScore`), and `buildClaimPlan(graph,
targetRepo)` routes the scored graph into a `ClaimPlan` — `go` → `claimable`, `raise` → `deferred`, `avoid` →
`skipped` — in dependency-respecting order.

```ts
import { validateIdeaSubmission, buildTaskGraph, scoreTaskGraph, buildClaimPlan } from "@loopover/engine";

const result = validateIdeaSubmission({
  id: "idea-1",
  title: "Add CSV export to the reports page",
  body: "Users want to download the reports table as CSV so they can pivot it in a spreadsheet.",
  targetRepo: "acme/reports",
  priority: "high",
});
if (result.ok) {
  const graph = buildTaskGraph(result.idea);
  scoreTaskGraph(graph); // { verdict: "go", perIssue: [{ key: "issue-1", verdict: "go", reasons: [] }] }
  buildClaimPlan(graph, "acme/reports");
  // { ideaId: "idea-1", targetRepo: "acme/reports", graphVerdict: "go",
  //   claimable: [{ key: "issue-1", title: "Add CSV export to the reports page", targetRepo: "acme/reports", verdict: "go", reasons: [] }],
  //   deferred: [], skipped: [] }
}
```

### `loop-progress.ts` — running loop → customer progress snapshot

`buildProgressSnapshot(state)` turns already-computed `LoopProgressState` into a `ProgressSnapshot` — the
`LoopPhase` (`queued` → … → `done`), `LoopRunStatus`, iteration budget as `percentComplete` (or `null` when the
budget is unknown), a `recentActivity` tail capped at `MAX_PROGRESS_ACTIVITY`, and a `done` flag. `progressChanged(prev,
next)` decides when a snapshot changed enough to push, so the surface streams on change instead of polling (a `null`
`prev` — the first snapshot — always pushes).

```ts
import { buildProgressSnapshot, progressChanged } from "@loopover/engine";

const snapshot = buildProgressSnapshot({
  iteration: 2,
  maxIterations: 5,
  phase: "coding",
  status: "running",
  recentActivity: [{ step: "claiming" }, { step: "coding", detail: "editing reports.tsx" }],
});
// { phase: "coding", status: "running", iteration: 2, maxIterations: 5, percentComplete: 40,
//   recentActivity: [{ step: "claiming" }, { step: "coding", detail: "editing reports.tsx" }], done: false }
progressChanged(null, snapshot); // true (first snapshot always pushes)
```

### `results-payload.ts` — completed iteration → customer result

`buildResultsPayload(result)` packages a finished `IterationResult` into a customer-facing `ResultsPayload`: the
canonical `prLink` (or `null` when no PR was opened), one plain-language `summary` sentence, a `diffPreview` bounded
to `MAX_DIFF_PREVIEW_FILES` files (while `totals` still reflects the full change), and the `totals` roll-up. It
formats already-fetched metadata only — it does not open, fetch, or deliver anything.

```ts
import { buildResultsPayload } from "@loopover/engine";

buildResultsPayload({
  repoFullName: "acme/reports",
  prNumber: 128,
  title: "Add CSV export",
  changedFiles: [
    { path: "src/reports.tsx", additions: 40, deletions: 3 },
    { path: "src/csv.ts", additions: 22, deletions: 0 },
  ],
  status: "open",
});
// { prLink: "https://github.com/acme/reports/pull/128",
//   summary: "Opened PR #128 in acme/reports: Add CSV export. 2 files changed (+62 / -3). Status: open.",
//   diffPreview: [{ path: "src/reports.tsx", additions: 40, deletions: 3 }, { path: "src/csv.ts", additions: 22, deletions: 0 }],
//   totals: { files: 2, additions: 62, deletions: 3 } }
```

## Repo map builder

`buildRepoMap(files)` gives a coding-agent driver (or the acceptance-criteria/prompt-packet builders upstream of
it) a compact, structural view of a target repository — function/class/method/interface/type signatures — without
paying the token cost of dumping full file contents into a prompt. It parses with `web-tree-sitter` (the WASM
binding, not a native addon, since this package also ships a Cloudflare Workers deployment target) using prebuilt
grammars from `tree-sitter-wasms`. Supported today: JavaScript/TypeScript/TSX. A file with an unsupported extension
or a grammar that fails to load/parse is reported via `skipped` on its `RepoMapFileEntry`, never thrown — this
module's contract is "extract what it safely can," not "block the whole driver invocation." `renderRepoMap(entries)`
renders a bounded plain-text outline, truncating (with a marker) once a configurable char budget is exceeded so it
can't blow out a prompt budget on a large repo. (#4280)
