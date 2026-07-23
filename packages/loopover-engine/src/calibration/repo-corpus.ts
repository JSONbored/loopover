// Per-repo corpus slicing + labeled-density stats (#8215, epic #8211 track B). Every BacktestCase carries
// its repo inside `targetKey` (`owner/repo#N` — host-defined by signal-tracking's own convention), but the
// calibration primitives only ever evaluate globally; per-repo autonomy needs these two pure building blocks
// first: slice a corpus by repo, and know which repos have enough labeled density to evaluate AT ALL under
// the same split + sample-minimum discipline the knob evaluators already apply globally.
//
// Aggregates only in every returned shape (repo names + numbers) — no target keys, no metadata — so a
// consumer can surface these results without re-auditing the public/private boundary. Same purity contract
// as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestCase } from "./backtest-corpus.js";
import { splitBacktestCorpus } from "./backtest-split.js";

/**
 * Slice a corpus by repo: the repo is everything before `targetKey`'s LAST `#` (an issue/PR key like
 * `owner/repo#123` — the last-`#` parse keeps a `#` inside an owner/repo name from truncating the repo).
 * A key with no `#`, or nothing before it, is dropped — never guessed into a slice. Deterministic:
 * insertion order follows each repo's first appearance, and case order is preserved within each slice.
 */
export function sliceCorpusByRepo(cases: readonly BacktestCase[]): Map<string, BacktestCase[]> {
  const slices = new Map<string, BacktestCase[]>();
  for (const backtestCase of cases) {
    const hashIndex = backtestCase.targetKey.lastIndexOf("#");
    if (hashIndex <= 0) continue; // unparseable target key — drop, never guess
    const repoFullName = backtestCase.targetKey.slice(0, hashIndex);
    let slice = slices.get(repoFullName);
    if (slice === undefined) {
      slice = [];
      slices.set(repoFullName, slice);
    }
    slice.push(backtestCase);
  }
  return slices;
}

/** Aggregate-only labeled-density stats for one repo's slice. `eligible` applies the SAME seeded-split +
 *  sample-minimum discipline the knob evaluators use: a repo is evaluable only if ITS OWN slice still clears
 *  both floors after splitting. */
export type RepoCorpusDensity = {
  cases: number;
  confirmed: number;
  reversed: number;
  eligible: boolean;
};

/**
 * Compute per-repo labeled density over `cases`, keyed by repo (via {@link sliceCorpusByRepo}, so
 * unparseable keys are dropped here too). Each repo's `eligible` flag re-runs the deterministic split on
 * that repo's OWN slice with the caller's seed/fraction and requires both the visible and held-out sides to
 * clear their floors — the exact never-on-noise bar `evaluateKnobLoosening`/`evaluateKnobDrift` apply to the
 * global corpus. Pure and deterministic: same corpus + parameters ⇒ same map, in first-appearance order.
 */
export function computeRepoCorpusDensity(
  cases: readonly BacktestCase[],
  minVisible: number,
  minHeldOut: number,
  heldOutFraction: number,
  splitSeed: string,
): Map<string, RepoCorpusDensity> {
  const densities = new Map<string, RepoCorpusDensity>();
  for (const [repoFullName, slice] of sliceCorpusByRepo(cases)) {
    let confirmed = 0;
    for (const backtestCase of slice) {
      if (backtestCase.label === "confirmed") confirmed += 1;
    }
    const { visible, heldOut } = splitBacktestCorpus(slice, heldOutFraction, splitSeed);
    densities.set(repoFullName, {
      cases: slice.length,
      confirmed,
      reversed: slice.length - confirmed,
      eligible: visible.length >= minVisible && heldOut.length >= minHeldOut,
    });
  }
  return densities;
}
