// Realized-history ground truth for the frozen-repo benchmark (#9261, harness #9216, epic #8534).
//
// For each work unit in a snapshot: what the maintainer ACTUALLY did within the prediction horizon. These
// are the labels every candidate proposal (#9260) is scored against, so they are emitted in that module's
// exact action vocabulary — proposal and outcome are directly comparable, with no translation layer that
// could drift.
//
// Three rules this module exists to enforce, each of which the surrounding system already believes and which
// a benchmark must not quietly contradict:
//
//   REVERSAL-AWARE SETTLEMENT. A merge later reverted is not a clean merge. The realized outcome is the
//   SETTLED state at horizon end, with the reversal recorded alongside — the same treatment that makes
//   `public-rule-precision.ts`'s precision honest (it subtracts reversals from confirmations rather than
//   counting the original decision). The reversal vocabulary is the established one
//   (`reversal_reopened` / `reversal_reverted` / `reversal_superseded`), not a new benchmark-local set, so
//   benchmark ground truth and internal backtest ground truth can never disagree about the same event.
//
//   UNRESOLVED IS EXPLICIT AND EXCLUDED. A work unit with no maintainer action inside the horizon is
//   `unresolved`. It is NOT silently counted as a correct abstention (which would reward an agent for
//   declining exactly the cases nobody decided) nor as an incorrect prediction (which would punish an agent
//   for the horizon being too short). It leaves the scoring denominator entirely, and the unresolved RATE is
//   published so a climbing rate is legible as "the horizon is wrong" rather than as a scoring artifact.
//
//   STABILITY. Ground truth for a given (snapshot, horizon) must not depend on WHEN extraction runs, once
//   the horizon has elapsed. Every decision here is a pure function of events dated inside the window, so a
//   later event — including a later reversal — cannot retroactively change a settled label. That is what
//   makes a leaderboard reproducible instead of drifting under its own scores.
//
// Pure core (this module); the IO wrapper that reads events from D1 lives engine-side of the harness, the
// same split every sibling calibration module uses.

import type { BenchmarkActionKind, BenchmarkCloseReasonClass } from "./benchmark-proposal.js";

/** The established reversal vocabulary — deliberately imported as literals from the same set the audit-event
 *  table and `public-rule-precision.ts` already use, never a benchmark-local re-invention. */
export type RealizedReversalKind = "reversal_reopened" | "reversal_reverted" | "reversal_superseded";

/** One realized maintainer event inside (or outside) a horizon, already normalized by the IO wrapper. */
export type RealizedMaintainerEvent = {
  workUnitId: string;
  /** Same closed vocabulary the agent proposes in — comparison needs no translation. */
  action: BenchmarkActionKind;
  /** ISO-8601. Events at exactly the horizon end are INSIDE the window (inclusive), matching how the
   *  corpus builder's own windowing treats a boundary event as belonging to the window it closes. */
  occurredAt: string;
  /** Present only for a `close`; the class realized history settled on. */
  reasonClass?: BenchmarkCloseReasonClass | undefined;
  /** Present only for a `label`. */
  labels?: readonly string[] | undefined;
};

/** A reversal of a previously-realized action, in the established vocabulary. */
export type RealizedReversalEvent = {
  workUnitId: string;
  kind: RealizedReversalKind;
  occurredAt: string;
};

/** The settled label for ONE work unit. `unresolved` carries no action by construction — the type makes
 *  "unresolved but somehow also a merge" unrepresentable rather than merely untested. */
export type BenchmarkGroundTruth =
  | { workUnitId: string; outcome: "unresolved" }
  | {
      workUnitId: string;
      outcome: "settled";
      action: BenchmarkActionKind;
      reasonClass?: BenchmarkCloseReasonClass | undefined;
      labels?: readonly string[] | undefined;
      settledAt: string;
      /** The reversal that overturned this action inside the horizon, if any. A reversed action is still
       *  the realized action — it is simply not a CONFIRMED one, exactly as `public-rule-precision.ts`
       *  treats a reversed decision: recorded, and subtracted from the confirmed count. */
      reversal: { kind: RealizedReversalKind; occurredAt: string } | null;
    };

export type BenchmarkGroundTruthSet = {
  schemaVersion: 1;
  snapshotRef: string;
  horizonDays: number;
  frozenAt: string;
  /** The horizon's inclusive end — `frozenAt + horizonDays`, computed once and published so a consumer
   *  never has to re-derive (and possibly re-derive differently) the window a label was settled in. */
  horizonEnd: string;
  truths: BenchmarkGroundTruth[];
  /** Denominator discipline, published rather than left implicit: `scoreable` is what a scorer divides by;
   *  `unresolved` is excluded from it, and a climbing `unresolvedRate` is the signal the horizon is wrong. */
  coverage: {
    workUnits: number;
    scoreable: number;
    unresolved: number;
    /** `unresolved / workUnits`, 3dp. `null` for an empty work-unit set — never 0, which would read as
     *  "a fully resolved benchmark" (the same null-not-zero discipline as PublicRulePrecisionRow). */
    unresolvedRate: number | null;
  };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The inclusive horizon end for a snapshot. Exported so the harness, the scorer, and any third-party
 *  verifier compute the SAME instant rather than three slightly different ones. */
export function benchmarkHorizonEnd(frozenAt: string, horizonDays: number): string {
  return new Date(Date.parse(frozenAt) + horizonDays * MS_PER_DAY).toISOString();
}

function withinHorizon(occurredAt: string, frozenAtMs: number, horizonEndMs: number): boolean {
  const at = Date.parse(occurredAt);
  return Number.isFinite(at) && at >= frozenAtMs && at <= horizonEndMs;
}

/**
 * Derive the settled, reversal-aware ground-truth set for one snapshot's work units.
 *
 * PURE: no clock, no IO, no randomness. Everything is decided from events dated inside the window, which is
 * what makes the result stable regardless of when extraction runs (asserted as an invariant in the tests).
 *
 * `workUnitIds` is the authoritative roster from the snapshot — a work unit with no qualifying event is
 * emitted as `unresolved` rather than omitted, so the unresolved rate has an honest denominator and a
 * consumer can tell "nobody acted" apart from "the extractor forgot about it".
 */
export function deriveBenchmarkGroundTruth(input: {
  snapshotRef: string;
  frozenAt: string;
  horizonDays: number;
  workUnitIds: readonly string[];
  events: readonly RealizedMaintainerEvent[];
  reversals?: readonly RealizedReversalEvent[] | undefined;
}): BenchmarkGroundTruthSet {
  const frozenAtMs = Date.parse(input.frozenAt);
  const horizonEnd = benchmarkHorizonEnd(input.frozenAt, input.horizonDays);
  const horizonEndMs = Date.parse(horizonEnd);

  // The SETTLED state is the LAST qualifying action in the window, not the first: a maintainer who labels,
  // then requests changes, then merges has settled on the merge. Ties on identical timestamps keep the
  // earlier-listed event, so a caller's stable input order yields a stable label.
  const settled = new Map<string, RealizedMaintainerEvent>();
  for (const event of input.events) {
    if (!withinHorizon(event.occurredAt, frozenAtMs, horizonEndMs)) continue;
    const current = settled.get(event.workUnitId);
    if (!current || Date.parse(event.occurredAt) > Date.parse(current.occurredAt)) settled.set(event.workUnitId, event);
  }

  // A reversal counts only when it lands inside the same horizon AND strictly after the action it overturns
  // — a reversal predating the settled action reversed something else, and counting it would mislabel an
  // action nobody has yet overturned. The EARLIEST such reversal is recorded: the first overturning is the
  // one that makes the action non-confirmed.
  const reversalFor = (workUnitId: string, settledAt: string): { kind: RealizedReversalKind; occurredAt: string } | null => {
    let best: RealizedReversalEvent | undefined;
    for (const reversal of input.reversals ?? []) {
      if (reversal.workUnitId !== workUnitId) continue;
      if (!withinHorizon(reversal.occurredAt, frozenAtMs, horizonEndMs)) continue;
      if (Date.parse(reversal.occurredAt) <= Date.parse(settledAt)) continue;
      if (!best || Date.parse(reversal.occurredAt) < Date.parse(best.occurredAt)) best = reversal;
    }
    return best ? { kind: best.kind, occurredAt: best.occurredAt } : null;
  };

  const truths: BenchmarkGroundTruth[] = [];
  let unresolved = 0;
  for (const workUnitId of input.workUnitIds) {
    const event = settled.get(workUnitId);
    if (!event) {
      unresolved += 1;
      truths.push({ workUnitId, outcome: "unresolved" });
      continue;
    }
    truths.push({
      workUnitId,
      outcome: "settled",
      action: event.action,
      // Spreads, not literal `undefined` values: an absent parameter must be OMITTED (the same
      // exactOptionalPropertyTypes discipline every sibling module follows), so a `merge` truth cannot
      // carry a present-but-undefined `reasonClass` that a strict comparison would trip over.
      ...(event.action === "close" && event.reasonClass !== undefined ? { reasonClass: event.reasonClass } : {}),
      ...(event.action === "label" && event.labels !== undefined ? { labels: [...event.labels] } : {}),
      settledAt: event.occurredAt,
      reversal: reversalFor(workUnitId, event.occurredAt),
    });
  }

  const workUnits = input.workUnitIds.length;
  return {
    schemaVersion: 1,
    snapshotRef: input.snapshotRef,
    horizonDays: input.horizonDays,
    frozenAt: input.frozenAt,
    horizonEnd,
    truths,
    coverage: {
      workUnits,
      scoreable: workUnits - unresolved,
      unresolved,
      unresolvedRate: workUnits === 0 ? null : Math.round((unresolved / workUnits) * 1000) / 1000,
    },
  };
}

/** The work units a scorer may divide by — `unresolved` never enters the denominator (#9261 requirement 4).
 *  Exported as the single definition of that rule so no scorer can re-implement it slightly differently. */
export function scoreableGroundTruths(
  set: BenchmarkGroundTruthSet,
): Array<Extract<BenchmarkGroundTruth, { outcome: "settled" }>> {
  return set.truths.filter((truth): truth is Extract<BenchmarkGroundTruth, { outcome: "settled" }> => truth.outcome === "settled");
}
