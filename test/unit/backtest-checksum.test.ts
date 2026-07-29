import { describe, expect, it } from "vitest";
// Imported by RELATIVE SOURCE path, not by the "@loopover/engine" specifier: that specifier resolves through
// the package's exports map to the compiled dist/, and v8 coverage would attribute every hit to the gitignored
// built file instead of this source -- the same misattribution vitest.config.ts's contractSourceAliases()
// exists to prevent for @loopover/contract, and the shape every other engine unit test here already uses.
import { checksumCases } from "../../packages/loopover-engine/src/calibration/backtest-checksum";
import { checksumCases as checksumCasesViaBarrel } from "@loopover/engine";
import type { BacktestCase } from "@loopover/engine/calibration/backtest-corpus";
import { checksumCases as checksumCasesViaExportCore } from "../../scripts/backtest-corpus-export-core";

// #9639: checksumCases moved from scripts/backtest-corpus-export-core.ts into the engine so the in-Worker
// threshold backtest can stamp its runs with the SAME freeze point the CI-side manifests use.
//
// The move is only safe if the output is byte-identical. Corpus manifests already on disk carry checksums
// produced by the pre-move implementation, and scripts/backtest-logic-check.ts and
// scripts/attested-backtest-run.ts both re-validate a manifest against this function before trusting its
// cases -- so a drifted implementation does not fail loudly, it rejects every previously-exported corpus.

// A fixed fixture, written out literally rather than generated: the digest below is only meaningful if the
// input can never change. Keys are deliberately NOT in sorted order, so the test also exercises the
// canonicalization rather than just the hash.
const FIXTURE: BacktestCase[] = [
  { targetKey: "acme/widgets#2", ruleId: "ai_consensus_defect", outcome: "close", label: "reversed", decidedAt: "2026-01-03T00:00:00.000Z", firedAt: "2026-01-02T00:00:00.000Z", metadata: { confidence: 0.91 } },
  { ruleId: "ai_consensus_defect", firedAt: "2026-01-01T00:00:00.000Z", decidedAt: "2026-01-02T00:00:00.000Z", targetKey: "acme/widgets#1", label: "confirmed", outcome: "merge", metadata: { confidence: 0.42 } },
];

// Produced by the pre-move implementation in scripts/backtest-corpus-export-core.ts. If this constant has to
// be edited to make the test pass, the freeze point has drifted and every exported manifest is invalidated.
const FIXTURE_DIGEST = "bba3c7db2e1ff0b6943802416ebf94c789f37ac5ed962cc7167c2dd33a33a861";

describe("checksumCases byte-stability across the #9639 move", () => {
  it("produces the pinned digest for the fixed fixture", () => {
    expect(checksumCases(FIXTURE)).toBe(FIXTURE_DIGEST);
  });

  it("agrees byte-for-byte through the engine barrel and through scripts/backtest-corpus-export-core", () => {
    // Behavioral sameness, not reference identity: the three paths resolve through different module
    // instances (source here, dist via the package specifier), and it is the DIGEST that must not fork --
    // a manifest frozen through one path and validated through another has to agree.
    expect(checksumCasesViaBarrel(FIXTURE)).toBe(FIXTURE_DIGEST);
    expect(checksumCasesViaExportCore(FIXTURE)).toBe(FIXTURE_DIGEST);
  });

  it("ignores property order, so a reordered case set freezes to the same digest", () => {
    const reordered = FIXTURE.map((c) => Object.fromEntries(Object.entries(c).reverse()) as unknown as BacktestCase);
    expect(checksumCases(reordered)).toBe(FIXTURE_DIGEST);
  });

  it("does NOT ignore case order -- the corpus is a sequence, and a reordered export is a different freeze point", () => {
    expect(checksumCases([...FIXTURE].reverse())).not.toBe(FIXTURE_DIGEST);
  });

  it("distinguishes a changed value, so the checksum actually commits to the cases", () => {
    const mutated = FIXTURE.map((c, i) => (i === 0 ? { ...c, reversed: false } : c));
    expect(checksumCases(mutated)).not.toBe(FIXTURE_DIGEST);
  });

  it("hashes the empty corpus to a stable, rule-independent digest", () => {
    // This is the value EMPTY_CORPUS_CHECKSUM exists to recognise: identical for every rule and every
    // deployment, which is why eval-score-records.ts refuses to publish a record against it.
    expect(checksumCases([])).toBe(checksumCases([]));
    expect(checksumCases([])).toHaveLength(64);
  });
});
