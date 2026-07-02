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

## AI Policy Map

`scanAiPolicyText` and `resolveAiPolicyVerdict` provide the deterministic policy gate used by miner discovery.
They only deny on small, explicit AI-contribution ban phrases in `AI-USAGE.md` or `CONTRIBUTING.md`; ambiguous,
missing, or empty policy text stays allowed so discovery does not invent a ban.

## MinerGoalSpec

`MinerGoalSpec` is the type surface for a repo's `.gittensory-miner.yml` (miner-side analogue of `.gittensory.yml`).
`DEFAULT_MINER_GOAL_SPEC` is the safe default a repo with no file behaves as — minable (`minerEnabled: true`, an
explicit opt-out), no path/label preferences, one concurrent claim, `neutral` discovery. Parsing is a separate module.
