# @jsonbored/gittensory-engine

Shared, deterministic engine logic for the Gittensory review stack and the `gittensory-miner`.

This package houses pure, side-effect-free logic (scoring preview/model, predicted-gate types, reward-risk,
slop signals, focus-manifest parse/compile core, duplicate-winner adjudication, and their engine-parity
fixtures) so the exact same code runs identically in the hosted review backend and in a local miner. It is
versioned independently of the app and published to npm as `@jsonbored/gittensory-engine`.

The logic is extracted from the app's `src/` in follow-up issues; this skeleton keeps the package buildable in
the meantime. The root `package.json` already globs `packages/*` in its `workspaces` field, so `npm ci`
discovers this package with no additional wiring.

## Build

```
npm run build --workspace @jsonbored/gittensory-engine
```

This runs `tsc -p tsconfig.json`, emitting `dist/` (the only published output alongside `CHANGELOG.md`).

## Test

```
npm test --workspace @jsonbored/gittensory-engine
```

Compiles the package and the `test/` suite (`node:test`) to plain JS and runs it — no experimental runtime
flags, so it works on the whole declared `engines` range.

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
import { rankOpportunities, rankOpportunityScore } from "@jsonbored/gittensory-engine";

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
import { scoreObjectiveAnchor } from "@jsonbored/gittensory-engine";

const result = scoreObjectiveAnchor({
  replayed: {
    paths: ["packages/gittensory-engine/src/opportunity-ranker.ts"],
    labels: ["feature"],
    titles: ["feat(miner): add deterministic opportunity ranking"],
  },
  revealed: {
    paths: ["packages/gittensory-engine/src/objective-anchor.ts"],
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
import { scoreObjectiveAnchorHistory } from "@jsonbored/gittensory-engine";

const result = scoreObjectiveAnchorHistory({
  replayed: [
    {
      id: "plan:objective-anchor",
      source: "plan",
      paths: ["packages/gittensory-engine/src/objective-anchor.ts"],
      labels: ["feature"],
    },
  ],
  revealed: [
    {
      id: "pr:3142",
      source: "pull_request",
      paths: ["packages/gittensory-engine/src/objective-anchor.ts"],
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
import { computePairwiseCalibrationScore } from "@jsonbored/gittensory-engine";

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
The hosted review stack remains responsible for loading the repo's current `.gittensory.yml` or private config; the
engine contract is deliberately default-off and safe to call at ingestion time.

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
} from "@jsonbored/gittensory-engine";

const gateVerdicts = ingestGateVerdictCalibrationSignals([
  {
    repoFullName: "jsonbored/gittensory",
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
} from "@jsonbored/gittensory-engine";

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
} from "@jsonbored/gittensory-engine";

const config = resolveTrackRecordSummaryConfig({
  miner: { trackRecordSummary: { enabled: true } },
});

const summary = computeTrackRecordSummary({
  login: "octo-miner",
  config,
  now: "2026-07-04T18:00:00Z",
  outcomes: [
    {
      repoFullName: "JSONbored/gittensory",
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

## Plan templates

`plan-templates.ts` exports one builder per miner lifecycle stage (`analyze`, `plan`, `prepare`, `create`, `manage`).
Each builder returns `RawPlanStep[]` in the shape accepted by `gittensory_build_plan`. Templates are pure data — they
describe step ordering via `dependsOn` but never actuate anything.

## Opportunity competition

`computeOpportunityCompetition(highRiskDuplicateClusters, openPullRequests)` mirrors the hosted
`opportunityCompetitionFactor` in `src/signals/reward-risk.ts`, producing a `[0, 1]` signal suitable for the ranker's
`dupRisk` input.

## Metadata opportunity signals

`opportunity-metadata.ts` turns fan-out issue metadata into the five normalized ranker inputs:

- `computeMetadataPotential` — label-based upside estimate
- `computeMetadataFeasibility` — comment load + issue age + title quality
- `computeMetadataDupRisk` — same-repo title overlap inside a candidate batch
- `buildMetadataRankInput` — composes freshness, competition, lane fit, and the metadata heuristics
- `rankMetadataOpportunities` — sorts candidates with `rankOpportunities`

`computeOpportunityFreshness` and `computeOpportunityCompetition` mirror the hosted reward-risk helpers with pure,
injected-clock semantics for local miners.

## AI Policy Map

`scanAiPolicyText` and `resolveAiPolicyVerdict` provide the deterministic policy gate used by miner discovery.
They only deny on small, explicit AI-contribution ban phrases in `AI-USAGE.md` or `CONTRIBUTING.md`; ambiguous,
missing, or empty policy text stays allowed so discovery does not invent a ban.

## Governor ledger

`normalizeGovernorLedgerEvent` validates append-only governor decision rows before the local miner persists them.
The vocabulary is fixed (`allowed`, `denied`, `throttled`, `kill_switch`) and unknown event types fail closed. This
module defines the storage contract only — it does not wire into live governor enforcement yet. (#2328)

## MinerGoalSpec

`MinerGoalSpec` is the type surface for a repo's `.gittensory-miner.yml` (miner-side analogue of `.gittensory.yml`).
`DEFAULT_MINER_GOAL_SPEC` is the safe default a repo with no file behaves as — minable (`minerEnabled: true`, an
explicit opt-out), no path/label preferences, one concurrent claim, `neutral` discovery.

`parseMinerGoalSpec(raw)` and `parseMinerGoalSpecContent(content)` are the tolerant parser pair for that file. They
never throw on malformed JSON/YAML; instead they return `{ present, spec, warnings }`, where `spec` is normalized to
safe defaults and `warnings` explains any dropped or invalid fields.

`discoverMinerGoalSpecPath(exists)` returns the first present file in the documented order (`MINER_GOAL_SPEC_FILENAMES`:
`.gittensory-miner.yml` → `.github/gittensory-miner.yml` → the `.json` variants). It is IO-free — the caller injects
the existence check — so a caller reads the returned path and feeds its content to `parseMinerGoalSpecContent`. See
`.gittensory-miner.yml.example` for the documented fields.
