import assert from "node:assert/strict";
import { test } from "node:test";

import { checksumCases } from "../dist/index.js";
import type { BacktestCase } from "../dist/calibration/backtest-corpus.js";

// #9639: checksumCases moved here from scripts/backtest-corpus-export-core.ts so the in-Worker threshold
// backtest can stamp its runs with the same freeze point the CI-side manifests are frozen and validated by.
//
// The root test/unit/backtest-checksum.test.ts covers this from the host side; this is its coverage in its
// OWN package, where the `engine` flag measures it. More than a flag exercise, though: this suite runs
// against dist/, so it is the only place the moved function is checked through the exact artifact published
// consumers import.

// A fixed fixture with deliberately unsorted keys, so canonicalization is exercised and not just the hash.
const FIXTURE: BacktestCase[] = [
  { targetKey: "acme/widgets#2", ruleId: "ai_consensus_defect", outcome: "close", label: "reversed", decidedAt: "2026-01-03T00:00:00.000Z", firedAt: "2026-01-02T00:00:00.000Z", metadata: { confidence: 0.91 } },
  { ruleId: "ai_consensus_defect", firedAt: "2026-01-01T00:00:00.000Z", decidedAt: "2026-01-02T00:00:00.000Z", targetKey: "acme/widgets#1", label: "confirmed", outcome: "merge", metadata: { confidence: 0.42 } },
];

// Produced by the PRE-MOVE implementation. Corpus manifests already on disk carry checksums from it, and
// scripts/backtest-logic-check.ts and scripts/attested-backtest-run.ts both re-validate a manifest against
// this function before trusting its cases -- so drift here does not fail loudly, it silently rejects every
// corpus ever exported. If this constant has to be edited to make the test pass, that has happened.
const FIXTURE_DIGEST = "bba3c7db2e1ff0b6943802416ebf94c789f37ac5ed962cc7167c2dd33a33a861";

test("checksumCases produces the pinned pre-move digest", () => {
  assert.equal(checksumCases(FIXTURE), FIXTURE_DIGEST);
});

test("checksumCases ignores property order", () => {
  const reordered = FIXTURE.map((c) => Object.fromEntries(Object.entries(c).reverse()) as unknown as BacktestCase);
  assert.equal(checksumCases(reordered), FIXTURE_DIGEST);
});

test("checksumCases does NOT ignore case order -- the corpus is a sequence", () => {
  assert.notEqual(checksumCases([...FIXTURE].reverse()), FIXTURE_DIGEST);
});

test("checksumCases distinguishes a changed value, so it genuinely commits to the cases", () => {
  const mutated = FIXTURE.map((c, i) => (i === 0 ? { ...c, reversed: false } : c));
  assert.notEqual(checksumCases(mutated), FIXTURE_DIGEST);
});

test("checksumCases is deterministic and 64 hex chars for the empty corpus", () => {
  // The value EMPTY_CORPUS_CHECKSUM recognises: identical for every rule, window and deployment, which is
  // why eval-score-records.ts refuses to publish a record against it.
  assert.equal(checksumCases([]), checksumCases([]));
  assert.match(checksumCases([]), /^[0-9a-f]{64}$/);
});
