// Counterfactual replay CONTRACT (#8219, sub-epic #8218, epic #8211 track C). This module is the design
// deliverable the later sub-issues implement against: the fixture shape, the sampling rule, the spend
// contract, and the scoring mapping — types + constants only, no logic (the pure assembler and the harness
// are their own issues and MUST cite these shapes rather than invent parallels).
//
// THE THREE CONTRACTS, decided here:
//
// 1) FIXTURES. A corpus case is replayable iff it carries bounded raw context (`metadata.diff`, the field
//    the live #8130 capture and the #8170 re-fetch both write) AND a human label. Fixtures carry
//    provenance (live-captured vs backfilled raw context) so results can be segmented by capture era —
//    a prompt that only improves on backfilled-era cases is a red flag, not a win. When the eligible set
//    exceeds a run's budget, sampling is SEEDED and deterministic (same seed + set ⇒ same sample; the
//    splitBacktestCorpus hashing discipline) — never "the first N", which would bias toward old cases.
//
// 2) SPEND. Budgets are expressed in the same neuron-estimate terms the live AI budgeting uses
//    (estimateNeurons in linked-issue-satisfaction-run.ts), with a hard per-run cap; a run that exhausts
//    mid-set persists partial scores + a cursor and resumes (the #8170 budget/cursor discipline). Provider
//    order: local ollama first for smoke runs, BYOK providers only behind explicit flags. The harness
//    NEVER posts to GitHub and never touches live reviews.
//
// 3) SCORING. A replayed variant is just another classifier over BacktestCase inputs: its output maps to
//    a binary would-flag verdict, so `scoreBacktest`/`compareBacktestScores` apply UNCHANGED. Unparseable
//    output is an ABSTENTION: skipped and counted, never coerced to either verdict — coercion would let a
//    degenerate prompt farm precision by being unparseable on hard cases.

import type { BacktestCase } from "./backtest-corpus.js";

/** Deterministic sampling seed namespace — one seed string per evaluation campaign, recorded in every
 *  result artifact so a re-run reproduces the exact fixture subset. */
export const COUNTERFACTUAL_SAMPLE_SEED_PREFIX = "counterfactual-replay-v1";

/** Default per-run spend cap in neuron-estimate units. Chosen to bound a full 460-fixture campaign on the
 *  current corpus to roughly the cost ceiling of ONE day's live-review budget — a replay campaign must
 *  never outspend the production feature it evaluates. The harness treats this as a default, not a limit:
 *  operators override per run, but never implicitly. */
export const COUNTERFACTUAL_DEFAULT_NEURON_BUDGET = 250_000;

/** One replayable historical judgment: the bounded inputs a judge variant sees, and the label it is
 *  scored against. `boundedInputs.diff` is already capped at capture time (RAW_CONTEXT_MAX_DIFF_CHARS). */
export type CounterfactualFixture = {
  /** Stable fixture id — the corpus targetKey. Stays in ARTIFACTS ONLY; never in public surfaces. */
  fixtureId: string;
  label: "confirmed" | "reversed";
  boundedInputs: {
    diff: string;
  };
  /** Which capture era produced the raw context: the live writers or the #8170 re-fetch. */
  provenance: "live_capture" | "raw_context_refetch";
};

/** The deterministic selection contract the assembler (#8220) implements. */
export type CounterfactualSamplingContract = {
  /** Campaign seed, prefixed with {@link COUNTERFACTUAL_SAMPLE_SEED_PREFIX}. */
  seed: string;
  /** Hard cap on fixtures per run; the seeded sample applies only when the eligible set exceeds it. */
  maxFixtures: number;
};

/** Why a corpus case was excluded from the fixture set — skip accounting is part of the contract so a
 *  fixture set's composition is always explainable (mirrors the #8139 skipped-case discipline). */
export type CounterfactualSkipReason = "no_raw_context" | "sampled_out";

/** A judge variant under evaluation. `promptVersion` and `modelSpec` are opaque identifiers recorded in
 *  artifacts; the harness maps them to real providers/config. */
export type CounterfactualVariant = {
  promptVersion: string;
  modelSpec: string;
};

/** The scoring mapping: what a variant's raw output must reduce to per fixture. `abstained` fixtures are
 *  excluded from the confusion matrix and reported as their own count — never coerced. */
export type CounterfactualVerdict = "would_flag" | "would_not_flag" | "abstained";

/** The per-run result envelope the harness persists (artifacts dir, never committed, never posted).
 *  `scored`/`abstained`/`skipped` must sum to the campaign's fixture universe for the run to be valid. */
export type CounterfactualRunSummary = {
  variant: CounterfactualVariant;
  sampling: CounterfactualSamplingContract;
  scored: number;
  abstained: number;
  skipped: Record<CounterfactualSkipReason, number>;
  neuronsSpent: number;
  /** Present when the run exhausted its budget mid-set — the resume point (fixtureId ordering). */
  resumeFrom: string | null;
};

/** Narrowing helper the assembler and harness share: a case is replayable iff it carries the bounded
 *  diff AND a label (every BacktestCase has a label by construction; the diff is the variable part). */
export function isReplayableCase(backtestCase: BacktestCase): boolean {
  return typeof backtestCase.metadata?.diff === "string" && backtestCase.metadata.diff !== "";
}
