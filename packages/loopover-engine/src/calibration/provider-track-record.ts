// Per-provider reviewer track records (#8228, epic #8211 track F). Dual-reviewer consensus events exist
// (reviewer-consensus-calibration.ts) and reversal labels now say which calls were RIGHT; this module joins
// the two: measured precision per reviewer identity, per repo and overall, over decided cases. Providers are
// opaque ids — no provider names hardcoded, no config coupling. Mirrors the consensus module's ingestion
// discipline (typed inputs, explicit vote vocabulary) and the #8085 scorer's null-below-the-sample-floor
// rule: a slice that decided nothing reports null, never 0.
//
// JOIN SEMANTICS (documented once, tested as invariants):
//   • A provider signal joins a labeled BacktestCase by exact `targetKey`. A signal whose target carries no
//     decided label is counted (`signals`) but contributes to no rate — undecided is not evidence.
//   • A provider "supported the firing" when it voted `fail` (the defect-flagging vote in the consensus
//     vocabulary). `precision` = P(label "confirmed" | this provider voted fail) — the same
//     correct-firing-as-numerator discipline as computeRulePrecision, at reviewer grain.
//   • `agreementRate` = share of this provider's decided votes that MATCHED the human label (fail↔confirmed,
//     pass/warn↔reversed) — a symmetric accuracy measure precision alone can't give a rarely-failing provider.
//   • `consensusRate` = share of this provider's signals on targets that another provider ALSO reviewed
//     where the two votes agreed (both-fail or both-non-fail); `splitRate` is its complement. Null when the
//     provider shares no targets — one-provider corpora have no consensus to measure.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestCase } from "./backtest-corpus.js";
import type { ReviewerConsensusVote } from "../reviewer-consensus-calibration.js";

export type ProviderReviewSignal = {
  /** Opaque reviewer identity — an id, never a hardcoded provider name. */
  provider: string;
  repoFullName: string;
  /** Joins to {@link BacktestCase.targetKey} (`owner/repo#N`). */
  targetKey: string;
  vote: ReviewerConsensusVote;
};

export type ProviderTrackRecord = {
  provider: string;
  /** The repo this row aggregates, or null for the provider's overall rollup across every repo. */
  repoFullName: string | null;
  signals: number;
  decided: number;
  confirmed: number;
  reversed: number;
  precision: number | null;
  agreementRate: number | null;
  consensusRate: number | null;
  splitRate: number | null;
};

type MutableStats = {
  signals: number;
  decided: number;
  confirmed: number;
  reversed: number;
  failDecided: number;
  failConfirmed: number;
  agreed: number;
  shared: number;
  consensus: number;
};

function emptyStats(): MutableStats {
  return { signals: 0, decided: 0, confirmed: 0, reversed: 0, failDecided: 0, failConfirmed: 0, agreed: 0, shared: 0, consensus: 0 };
}

function toRecord(provider: string, repoFullName: string | null, stats: MutableStats): ProviderTrackRecord {
  return {
    provider,
    repoFullName,
    signals: stats.signals,
    decided: stats.decided,
    confirmed: stats.confirmed,
    reversed: stats.reversed,
    precision: stats.failDecided > 0 ? stats.failConfirmed / stats.failDecided : null,
    agreementRate: stats.decided > 0 ? stats.agreed / stats.decided : null,
    consensusRate: stats.shared > 0 ? stats.consensus / stats.shared : null,
    splitRate: stats.shared > 0 ? (stats.shared - stats.consensus) / stats.shared : null,
  };
}

/**
 * Compute per-(provider, repo) and per-provider-overall track records from reviewer signals joined against
 * a labeled corpus, per the join semantics documented in this module's header. Deterministic ordering:
 * providers ascending, and within each provider the overall rollup (repoFullName null) first, then repos
 * ascending. Aggregates only — provider ids, repo names, and numbers; never target keys or vote payloads.
 */
export function computeProviderTrackRecords(
  signals: readonly ProviderReviewSignal[],
  cases: readonly BacktestCase[],
): ProviderTrackRecord[] {
  const labelByTarget = new Map<string, BacktestCase["label"]>();
  for (const backtestCase of cases) labelByTarget.set(backtestCase.targetKey, backtestCase.label);

  // Which providers reviewed each target, with their fail/non-fail stance — the consensus/split join.
  const stancesByTarget = new Map<string, Map<string, boolean>>();
  for (const signal of signals) {
    let stances = stancesByTarget.get(signal.targetKey);
    if (stances === undefined) {
      stances = new Map();
      stancesByTarget.set(signal.targetKey, stances);
    }
    stances.set(signal.provider, signal.vote === "fail");
  }

  // Dedupe to one signal per (provider, targetKey) pair, latest-vote-wins — matching stancesByTarget's
  // last-write semantics above. loadLiveProviderTrackRecords reads raw audit rows with no dedup, so a provider
  // re-reviewing the same PR (e.g. after a new push) would otherwise inflate its signals/decided/shared/consensus
  // counters proportionally to its revote count while its stance reflects only the last vote (#8876).
  const dedupedByProviderTarget = new Map<string, ProviderReviewSignal>();
  for (const signal of signals) dedupedByProviderTarget.set(`${signal.provider} ${signal.targetKey}`, signal);

  const perRepo = new Map<string, Map<string, MutableStats>>(); // provider → repo → stats
  const overall = new Map<string, MutableStats>();
  for (const signal of dedupedByProviderTarget.values()) {
    let repos = perRepo.get(signal.provider);
    if (repos === undefined) {
      repos = new Map();
      perRepo.set(signal.provider, repos);
    }
    let repoStats = repos.get(signal.repoFullName);
    if (repoStats === undefined) {
      repoStats = emptyStats();
      repos.set(signal.repoFullName, repoStats);
    }
    let overallStats = overall.get(signal.provider);
    if (overallStats === undefined) {
      overallStats = emptyStats();
      overall.set(signal.provider, overallStats);
    }

    const label = labelByTarget.get(signal.targetKey);
    const votedFail = signal.vote === "fail";
    const stances = stancesByTarget.get(signal.targetKey)!;
    for (const stats of [repoStats, overallStats]) {
      stats.signals += 1;
      if (label !== undefined) {
        stats.decided += 1;
        if (label === "confirmed") stats.confirmed += 1;
        else stats.reversed += 1;
        if (votedFail) {
          stats.failDecided += 1;
          if (label === "confirmed") stats.failConfirmed += 1;
        }
        // Matched the human: a fail vote on a confirmed firing, or a non-fail vote on a reversed one.
        if (votedFail === (label === "confirmed")) stats.agreed += 1;
      }
      if (stances.size > 1) {
        stats.shared += 1;
        let agreeingOthers = 0;
        let others = 0;
        for (const [otherProvider, otherFail] of stances) {
          if (otherProvider === signal.provider) continue;
          others += 1;
          if (otherFail === votedFail) agreeingOthers += 1;
        }
        if (agreeingOthers === others) stats.consensus += 1;
      }
    }
  }

  const records: ProviderTrackRecord[] = [];
  for (const provider of [...overall.keys()].sort()) {
    records.push(toRecord(provider, null, overall.get(provider)!));
    const repos = perRepo.get(provider)!;
    for (const repoFullName of [...repos.keys()].sort()) {
      records.push(toRecord(provider, repoFullName, repos.get(repoFullName)!));
    }
  }
  return records;
}
