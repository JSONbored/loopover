# Miner self-improve — calibration, value-weighting, and the anti-farming boundary

Phase 7's **contributor-safe** half — the drift detector, the calibration dashboard, the prediction ledger, the
metrics exporter, the extension panel, and the confusion-matrix regression tests — is deliberately scoped to
**read-only measurement and detection**. The half that actually *acts* on calibration data (bumps autonomy levels,
tightens gate thresholds, adjusts per-contributor trust) is **maintainer-only** and lives behind a separate
milestone.

This note is for a contributor building against the contributor-safe tools. The single most important thing to
understand is **where the line is and why** — because the natural instinct ("just wire the dashboard's accuracy
number into an autonomy-level bump") is precisely the maintainer-only side of the phase, and a contributor-safe tool
that could do it would defeat the safety it exists to provide.

## What calibration measures

The engine contract is `Phase7CalibrationLoopResult`
([`packages/gittensory-engine/src/phase7-calibration-loop.ts`](../../gittensory-engine/src/phase7-calibration-loop.ts)):
it combines the **historical-replay** composite score with the passive **`pr_outcome`** signal and tracks accuracy
against the documented **`DOCUMENTED_CALIBRATION_BASELINE = 0.62`** (the 62% self-review baseline from the Phase 7
roadmap). The engine owns the deterministic combine / freshness / threshold / hold-reason logic; the miner runtime
owns scheduling replay runs and persisting ledger rows.

The ground truth underneath is `computeGateEval`'s confusion matrix (`src/review/parity.ts`, `GateEvalRow`): per
project, how many predictions were `wouldMerge` vs `wouldClose`, and how each resolved against the human decision —
`mergeConfirmed` (predicted merge, human merged) vs **`mergeFalse` (predicted merge, human *closed* — the dangerous
error)**, and symmetrically for close. `mergePrecision` / `closePrecision` are the headline accuracy numbers a
dashboard renders.

## The runner: wiring the replay scorer into the combine (#4248)

`computePhase7CalibrationLoop` is a **pure combine contract** — by design it cannot schedule replay runs or read
ledgers (the miner depends on the engine, not the reverse), so it waits for an external caller to feed it a real
`historical_replay` composite. #3014 (PR #3225) shipped only that engine side; a 2026-07-08 audit found the closed
issue claimed the two halves were "wired" when in fact **no miner-side runner ever called the replay scorer
(`computeObjectiveAnchor`, #3012) and passed its result into the combine** — two finished pieces, never connected.

[`lib/calibration-run.js`](../lib/calibration-run.js) (#4248) is that missing runner.
`runHistoricalReplayCalibrationCycle` scores a completed replay run with the deterministic objective-anchor scorer,
reduces the per-task scores to one composite `[0, 1]`, folds it into the `HistoricalReplayCalibrationInput` shape the
engine expects, calls `computePhase7CalibrationLoop` with that **plus the existing `pr_outcome` signal**, and
persists the combined snapshot as a `calibration_snapshot` event on the local append-only event ledger (the same
typed-event-over-`event-ledger.js` pattern as `pr-outcome.js`). The persisted metric is queryable with
`loopover-miner ledger list --type calibration_snapshot` and via `readCalibrationSnapshots` /
`latestCalibrationSnapshot`.

Consistent with the boundary below, the runner is **read/measure-only**: it produces and persists the tracked
metric but never acts on it (no autonomy bump, no threshold tune). Acting on the combined accuracy — the
calibration-gated circuit-breaker — remains maintainer-only (#2352).

## Value-weighting: durable correctness, not volume

Raw merge/close precision is not the real objective, and a contributor reading a dashboard number should understand
why. `GateEvalRow` also carries `weightedMergeConfirmed` / `weightedCloseConfirmed`: a prediction's credit is
**discounted by `REVERSAL_DISCOUNT_WEIGHT` (currently `0` — full discount)** when its outcome was later reversed (a
merge a human undid, or a bot-closed PR a contributor reopened). The denominator (`wouldMerge`) is unchanged — only
the *credit* for a call that didn't hold up is removed. So the weighted precision measures **durable** correctness:
a prediction that "won" on the day but was reverted a week later earns nothing. This is maintainer-owned prior work
(#2348) that the contributor-safe tools *display*; they never recompute or re-weight it.

## The maintainer-only line, and why it's drawn there

Three maintainer-only concepts sit just past the boundary. A contributor-safe tool must never read or write any of
them:

- **Personalized tuning (#2349).** Per-actor confidence adjustment based on calibration history. A contributor-facing
  surface that could *see or influence its own personalized-trust score* would defeat the entire point of it — so the
  contributor-safe tools are, by construction, blind to it.
- **Fleet anti-farming (#2350).** The whole phase is designed around gaming vectors from day one: inflating
  merge-precision by only ever opening trivially-safe PRs, or farming duplicate-issue-claim elections. **Every
  contributor-safe tool in this batch is read-only / local-only *because* a write-capable version of any of them
  would be a farming vector** — the restriction is the design, not an arbitrary limitation. (The anonymization posture
  for any telemetry that does leave an instance mirrors `src/selfhost/orb-collector.ts`'s HMAC-with-local-secret
  approach.)
- **Calibration-gated circuit-breaking (#2352).** `src/review/auto-tune.ts` already holds a self-tightening safety
  breaker: when merge precision drops below a floor over a real sample, it **disables its own auto-merge (hold-only)
  and alerts a human — it only ever makes itself MORE cautious, never loosens**, and a human clears it once fixed.
  That breaker is the eventual consumer of miner-sourced calibration signal (via `computeGateEval`'s `source`
  scoping), but the *enforcement* is maintainer-only. The contributor-safe tools only ever **produce read-only signal**
  for that maintainer-owned system to act on.

## What this phase does NOT do

From any contributor-safe tool in this batch:

- **No autonomy-level changes** — measuring accuracy never bumps an autonomy level (that gate is fail-closed and
  maintainer-owned).
- **No gate-threshold changes** — the dashboard/exporter/ledger surface numbers; they never tune the gate.
- **No writes to maintainer-owned calibration or circuit-breaker state** — no touching personalized-trust scores, the
  auto-tune hold-only flag, or any autonomy configuration.
- **No de-anonymizing or write-capable telemetry** — local-only or HMAC-anonymized, read-only.

## The neighborhood

- Contributor-safe (this batch): drift detector, calibration dashboard + extension panel, prediction ledger, metrics
  exporter, confusion-matrix regression tests — all read-only measurement.
- Maintainer-only (cited for context, **not** to be reopened or reimplemented here): #2348 (value-weighted
  calibration, merged), #2349 (personalized tuning), #2350 (fleet anti-farming), #2352 (wiring calibration accuracy
  into the live auto-tune breaker).

## References

- [`packages/gittensory-engine/src/phase7-calibration-loop.ts`](../../gittensory-engine/src/phase7-calibration-loop.ts) — the calibration-loop contract + `DOCUMENTED_CALIBRATION_BASELINE`.
- `src/review/parity.ts` — `GateEvalRow` (the confusion matrix) and `REVERSAL_DISCOUNT_WEIGHT` (value-weighting).
- `src/review/auto-tune.ts` — the existing hold-only accuracy circuit-breaker (#2352's eventual consumer).
- `src/selfhost/orb-collector.ts` — the anonymized HMAC-with-local-secret telemetry pattern.
