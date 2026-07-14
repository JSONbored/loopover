# Scoring / rules twin convergence — decision record (#4881)

The gate-decision "scoring/rules" logic has historically existed as hand-maintained **twin files** — one
under the backend's `src/`, one under `@loopover/engine` — kept in sync by hand so the published
`loopover-miner` / `loopover-mcp` CLIs can reach the same logic without importing the whole backend.
This record captures the converge-or-keep-divergent decision for each remaining pair, per #4881. It is a
decision, not a blanket policy: each pair was evaluated on its own.

## Inventory

### Already converged (host is a thin re-export shim over the engine) — keep as-is

These pairs no longer diverge; the `src/` file is a thin shim and the single source of truth lives in the
engine:

| Host (shim) | Engine source of truth |
| --- | --- |
| `src/rules/predicted-gate.ts` | `packages/loopover-engine/src/predicted-gate.ts` |
| `src/scoring/model.ts` | `packages/loopover-engine/src/scoring/model.ts` |
| `src/scoring/preview.ts` | `packages/loopover-engine/src/scoring/preview.ts` |
| `src/scoring/pending-pr-scenarios.ts` | `packages/loopover-engine/src/scoring/pending-pr-scenarios.ts` |

No action: converging these was safe (the shared logic's dependencies were already engine-resident), so
they are single-source with a shim and need no further work.

### Remaining hand-maintained twin — **decision: keep divergent**

| Host | Engine |
| --- | --- |
| `src/rules/advisory.ts` | `packages/loopover-engine/src/advisory/gate-advisory.ts` |

This is the pair registered as `GATE_DECISION_TWIN_PAIR` in `scripts/check-engine-parity.ts`, the one pair
that pair-registry guards with co-edit-or-version-bump enforcement rather than a byte-parity check.

## Why the advisory twin stays divergent

The two copies are deliberately **not** the same implementation, and converging them to one source would
regress the very dependency-graph constraint the split exists to protect.

The host copy (`src/rules/advisory.ts`) is wired into the full backend subsystem — its imports include:

- `../signals/engine` (`CollisionCluster` / `CollisionReport`) — the ~5.8k-line signals-engine file,
- `../signals/local-branch` (`isCodeFile`),
- `../signals/test-evidence` (`isTestPath`),
- `../scoring/preview` (`labelMatchesPattern`),

alongside `duplicate-winner` and `change-guardrail`.

The engine copy (`gate-advisory.ts`) deliberately imports **none** of those heavy modules. It draws its
collision types from the slim `../types/predicted-gate-types`, matches labels through the small
`../scoring/label-match` module instead of `scoring/preview`, and carries its own check-run sanitizer and
default thresholds.

If the engine copy were replaced by an import of the host copy, `@loopover/engine` — and therefore the
published `loopover-miner` and `loopover-mcp` CLIs that depend on it — would transitively pull in
`signals/engine`, `local-branch`, `test-evidence`, and `scoring/preview`. That is exactly the backend
bloat the miner's dependency graph must not carry, and it is the "dependency-graph-size problem" #4881
flags as the blocker to solve *before* converging.

The alternative #4881 raises — a shared **type-only** import — does not resolve it either: the divergence
is in *runtime* dependencies (collision-report building, `isCodeFile` / `isTestPath` classification, label
matching), not just shared types. A type-only boundary would let both sides agree on shapes but would not
let the engine reuse the host's runtime logic without dragging the heavy imports along.

## Consequences and the co-edit obligation

Because this pair stays divergent, contributors who change gate-decision behavior must edit **both** copies
together (or bump the engine version and the `packages/loopover-miner/expected-engine.version` pin). This is
enforced mechanically by `scripts/check-engine-parity.ts` (`GATE_DECISION_TWIN_PAIR` +
`checkGateDecisionVersionBump` + the `GATE_DECISION_CORE_MARKERS` presence check), so a one-sided edit fails
CI rather than silently drifting.

## When to revisit

Converge the advisory twin only once its heavy dependencies are themselves engine-resident as slim modules —
i.e. after the collision-report building, `isCodeFile` / `isTestPath` classification, and label matching that
`advisory.ts` relies on are extracted into `@loopover/engine` without pulling `signals/engine` along. At that
point a single engine-hosted advisory source could serve both the backend and the miner without bloating the
miner's dependency graph, and this decision should be reopened.
