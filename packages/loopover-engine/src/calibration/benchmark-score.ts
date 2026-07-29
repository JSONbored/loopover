// Benchmark proposal scorer (#9262, harness #9216, epic #8534) — multi-class scoring built ON the existing
// confusion-matrix and Pareto-floor primitives, deliberately NOT beside them.
//
// REUSE, NOT REIMPLEMENTATION. `scoreBacktest` (backtest-score.ts) and `compareBacktestScores`
// (backtest-compare.ts) remain the scoring core; this module is an adapter that reshapes (proposal, ground
// truth) pairs into the exact inputs those functions already take. A second scoring implementation is
// precisely the drift this module exists to prevent, so the anti-drift guarantee is mechanical rather than
// aspirational: an equivalent binary case scored here and scored through the internal backtest path produces
// the identical report, asserted directly in the tests.
//
// The reuse works by borrowing the primitive's positive-class slot per action: for action A, the "positive"
// class is "the realized action was A" and the classifier's answer is "the agent proposed A". The primitive
// names that slot `reversed`/`confirmed` because its first caller scored rule reversals; the name is
// vestigial here and never surfaces in this module's own output. The `ruleId` slot carries the ACTION name,
// which makes each per-action report self-labeling and makes `compareBacktestScores`' rule-mismatch throw
// double as a guard against accidentally comparing two different actions.
//
// AGGREGATION — the recorded decision (#9262 requirement 2). MACRO is the headline; MICRO is published
// alongside. They answer different questions and the difference is not cosmetic here:
//
//   Micro pools the counts across actions. Under single-label multi-class scoring — one prediction per work
//   unit — every decided unit contributes exactly one TP or one FP, so micro precision, micro recall and
//   plain accuracy are all the SAME number. That makes it an honest "how often was it right overall", and
//   also makes it dominated by whichever action is most frequent. In this corpus that is overwhelmingly
//   `merge`, so an agent that answers "merge" to everything scores well on micro while being worthless.
//
//   Macro averages the per-action metrics, so each action counts equally regardless of frequency, and the
//   answer-merge-to-everything agent is immediately exposed by its floor-level `close`/`request_changes`
//   numbers. Since the benchmark's question is "can this agent make MAINTAINER decisions" — including the
//   rare, expensive ones — macro is the number that answers it, and therefore the headline.
//
//   Both are published because a benchmark that reports only its headline invites the reader to reconstruct
//   the other one wrongly. An action with no realized instances has null metrics and is EXCLUDED from the
//   macro mean rather than counted as 0 — a metric nobody could measure must not drag an average down.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestCase } from "./backtest-corpus.js";
import { scoreBacktest, type BacktestScoreReport } from "./backtest-score.js";
import { compareBacktestScores, type BacktestComparison } from "./backtest-compare.js";
import type { BenchmarkActionKind, BenchmarkProposal } from "./benchmark-proposal.js";
import { scoreableGroundTruths, type BenchmarkGroundTruthSet } from "./benchmark-ground-truth.js";

/** Every action scored, in a fixed order so two reports are directly comparable field by field. */
export const SCORED_ACTIONS: readonly BenchmarkActionKind[] = ["merge", "close", "request_changes", "label", "hold"];

export type BenchmarkScoreReport = {
  schemaVersion: 1;
  snapshotRef: string;
  /** WHO was scored — carried through from the proposals, opaque here exactly as in #9215's EvalScoreRecord. */
  subjectId: string;
  /** One-vs-rest report per action, keyed by action, each produced by the shared `scoreBacktest`. */
  perAction: Record<BenchmarkActionKind, BacktestScoreReport>;
  /** The HEADLINE (see the module header's recorded decision). `actionsScored` is how many actions had a
   *  non-null metric and therefore entered the mean — a macro number over 2 of 5 actions is a different
   *  claim than one over 5, and hiding that would be the kind of unexamined average this file argues against. */
  macro: { precision: number | null; recall: number | null; actionsScored: number };
  /** Pooled counts. Under single-label scoring micro precision === micro recall === accuracy; all three are
   *  the same number and it is reported once, honestly labeled, rather than three times as if independent. */
  micro: { precision: number | null; recall: number | null; accuracy: number | null };
  /** #9215's coverage semantics. Abstentions are NEVER folded into errors: they lower coverage, which is a
   *  different (and recoverable) thing than being wrong. */
  coverage: {
    decided: number;
    abstained: number;
    /** `decided / (decided + abstained)`; null when the agent faced nothing at all — never 0, which would
     *  read as "answered nothing it was asked" rather than "was asked nothing". */
    coverage: number | null;
    /** Ground-truth units excluded before scoring began (#9261's `unresolved`) — published so a reader can
     *  see the denominator shrink rather than discovering it in a footnote. */
    unresolvedExcluded: number;
    /** Proposals for work units not in this snapshot's ground truth. Ignored for scoring (a submitter
     *  cannot inflate anything by padding), but COUNTED, because a nonzero value means the agent is
     *  answering a different question than the one asked. */
    unscorableProposals: number;
  };
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;
}

/** Mean of the non-null values, or null when none are — an unmeasurable metric leaves the average rather
 *  than entering it as 0. */
function macroMean(values: ReadonlyArray<number | null>): { mean: number | null; counted: number } {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return { mean: null, counted: 0 };
  return { mean: Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 1000) / 1000, counted: present.length };
}

/**
 * Score one agent's proposals for one snapshot against #9261's realized ground truth.
 *
 * Denominator discipline, in the order it is applied:
 *   1. `unresolved` ground truth leaves entirely (#9261) — never a correct abstention, never an error.
 *   2. A scoreable unit the agent DID NOT answer counts as an abstention, identically to an explicit
 *      `{kind: "abstain"}`. Silence and a declared abstention are the same act; scoring them differently
 *      would reward whichever one an agent's emitter happened to produce.
 *   3. Abstentions lower coverage and are absent from every confusion-matrix count.
 */
export function scoreBenchmarkProposals(input: {
  subjectId: string;
  groundTruth: BenchmarkGroundTruthSet;
  proposals: readonly BenchmarkProposal[];
}): BenchmarkScoreReport {
  const scoreable = scoreableGroundTruths(input.groundTruth);
  const scoreableIds = new Set(scoreable.map((truth) => truth.workUnitId));

  // Last proposal per work unit wins, so a resubmission is a correction rather than a double entry.
  const proposalByUnit = new Map<string, BenchmarkProposal>();
  let unscorableProposals = 0;
  for (const proposal of input.proposals) {
    if (!scoreableIds.has(proposal.workUnitId)) {
      unscorableProposals += 1;
      continue;
    }
    proposalByUnit.set(proposal.workUnitId, proposal);
  }

  // The decided set: scoreable units the agent actually answered with an action.
  const decided: Array<{ realized: BenchmarkActionKind; predicted: BenchmarkActionKind }> = [];
  let abstained = 0;
  for (const truth of scoreable) {
    const proposal = proposalByUnit.get(truth.workUnitId);
    if (!proposal || proposal.prediction.kind === "abstain") {
      abstained += 1;
      continue;
    }
    decided.push({ realized: truth.action, predicted: proposal.prediction.action.kind });
  }

  // One-vs-rest through the SHARED primitive. The synthetic cases carry the action in the `ruleId` slot so
  // each report is self-labeling and a cross-action comparison throws rather than silently succeeding.
  const perAction = {} as Record<BenchmarkActionKind, BacktestScoreReport>;
  for (const action of SCORED_ACTIONS) {
    const cases: BacktestCase[] = decided.map((pair, index) => ({
      ruleId: action,
      targetKey: String(index),
      outcome: pair.realized,
      label: pair.realized === action ? "reversed" : "confirmed",
      firedAt: input.groundTruth.frozenAt,
      decidedAt: input.groundTruth.horizonEnd,
      metadata: { predicted: pair.predicted },
    }));
    perAction[action] = scoreBacktest(action, cases, (backtestCase) =>
      (backtestCase.metadata as { predicted: BenchmarkActionKind }).predicted === action ? "reversed" : "confirmed",
    );
  }

  const macroPrecision = macroMean(SCORED_ACTIONS.map((action) => perAction[action].precision));
  const macroRecall = macroMean(SCORED_ACTIONS.map((action) => perAction[action].recall));
  // Pooled: exactly one TP or FP per decided unit, so this single number IS precision, recall and accuracy.
  const correct = decided.filter((pair) => pair.predicted === pair.realized).length;
  const micro = ratio(correct, decided.length);

  return {
    schemaVersion: 1,
    snapshotRef: input.groundTruth.snapshotRef,
    subjectId: input.subjectId,
    perAction,
    macro: {
      precision: macroPrecision.mean,
      recall: macroRecall.mean,
      // The two means are taken over the same actions whenever both are defined; report the precision
      // side's count, which is the one the headline precision is an average of.
      actionsScored: macroPrecision.counted,
    },
    micro: { precision: micro, recall: micro, accuracy: micro },
    coverage: {
      decided: decided.length,
      abstained,
      coverage: ratio(decided.length, decided.length + abstained),
      unresolvedExcluded: input.groundTruth.coverage.unresolved,
      unscorableProposals,
    },
  };
}

export type BenchmarkComparison = {
  subjectId: string;
  perAction: Record<BenchmarkActionKind, BacktestComparison>;
  regressedActions: BenchmarkActionKind[];
  improvedActions: BenchmarkActionKind[];
  /** The Pareto floor, extended to the multi-class case (#9262 requirement 4): ANY regressed action decides
   *  the verdict, even alongside improvements elsewhere. Gaining on `merge` while losing on `close` is a
   *  trade, and the floor's entire purpose is that a trade is not a win. */
  verdict: "improved" | "regressed" | "unchanged";
};

/**
 * Compare two benchmark score reports under the Pareto floor, per action, via the SHARED comparator.
 *
 * Every per-action verdict comes from `compareBacktestScores`, so the null-handling ("unknown stays
 * unknown": an axis with a null on either side is excluded from both lists) is inherited rather than
 * re-derived. Throws on a subject mismatch — comparing two different agents' reports as if they were one
 * agent's before/after is a caller bug, the same posture the primitive takes on a rule mismatch.
 */
export function compareBenchmarkScores(baseline: BenchmarkScoreReport, candidate: BenchmarkScoreReport): BenchmarkComparison {
  if (baseline.subjectId !== candidate.subjectId) {
    throw new Error(`cannot compare benchmark scores for different subjects: ${baseline.subjectId} vs ${candidate.subjectId}`);
  }
  const perAction = {} as Record<BenchmarkActionKind, BacktestComparison>;
  const regressedActions: BenchmarkActionKind[] = [];
  const improvedActions: BenchmarkActionKind[] = [];
  for (const action of SCORED_ACTIONS) {
    const comparison = compareBacktestScores(baseline.perAction[action], candidate.perAction[action]);
    perAction[action] = comparison;
    if (comparison.verdict === "regressed") regressedActions.push(action);
    else if (comparison.verdict === "improved") improvedActions.push(action);
  }
  return {
    subjectId: baseline.subjectId,
    perAction,
    regressedActions,
    improvedActions,
    verdict: regressedActions.length > 0 ? "regressed" : improvedActions.length > 0 ? "improved" : "unchanged",
  };
}
