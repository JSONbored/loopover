// The backtest corpus freeze point (#8136's reproducibility posture, moved here by #9639).
//
// This lived in scripts/backtest-corpus-export-core.ts, which made it reachable only from the CI-side CLIs.
// The in-Worker threshold backtest (src/services/threshold-backtest-run.ts) needs the SAME function to stamp
// its own runs: a deployment whose only backtest history is in-Worker was publishing no freeze point at all,
// so /v1/public/eval-scores served zero EvalScoreRecords. Two checksum implementations would have been worse
// than none -- a manifest frozen by one and validated by the other would disagree for no visible reason --
// so the function moved rather than being copied.
//
// It is byte-stable by contract, not by accident: existing corpus manifests on disk carry checksums produced
// by the pre-move implementation, and scripts/backtest-logic-check.ts and scripts/attested-backtest-run.ts
// both re-validate a manifest against it before trusting the cases. Any change to the canonicalization or the
// hash input invalidates every manifest ever exported. backtest-checksum.test.ts pins the exact digest of a
// fixed fixture for that reason.
//
// node:crypto rather than Web Crypto: this must be SYNCHRONOUS (checksumCases is called inside pure,
// non-async manifest builders), and the Worker runs with nodejs_compat -- the same basis on which
// attester.ts, attestation-envelope.ts, backtest-split.ts and counterfactual-fixtures.ts in this same
// directory already import createHash.
import { createHash } from "node:crypto";
import type { BacktestCase } from "./backtest-corpus.js";

/** Canonicalize one case (sort keys) so property-order differences don't change the checksum -- same technique
 *  as scripts/export-d1-core.ts's canonicalizeRow. */
function canonicalizeCase(backtestCase: BacktestCase): Record<string, unknown> {
  // Sorted with the DEFAULT comparator over the keys, not a hand-written `a < b ? -1 : a > b ? 1 : 0`. For
  // strings the two give the identical total order -- the pinned digest in this module's two test suites is
  // what proves the output did not move -- but the hand-written form carries an equality arm that
  // Object.keys can never trigger, since it yields each key exactly once. An unreachable branch cannot be
  // tested, so it either sits uncovered or needs an ignore pragma; not writing it beats both. (The pragma
  // was also flag-dependent: vitest's v8 provider honoured it, the engine package's own coverage did not.)
  const source = backtestCase as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, source[key]]));
}

/** Deterministic SHA-256 over the canonicalized cases -- mirrors scripts/export-d1-core.ts's checksumRows
 *  exactly (canonicalize each entry, JSON-stringify the array, hash). */
export function checksumCases(cases: readonly BacktestCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases.map(canonicalizeCase))).digest("hex");
}
