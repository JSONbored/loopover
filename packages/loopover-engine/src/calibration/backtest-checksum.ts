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
  /* v8 ignore next -- the comparator's `0` arm is unreachable: Object.entries yields each key once, so the
   * two keys handed to a sort comparator are never equal. Kept anyway because a comparator that cannot
   * return 0 is not a total order, and rewriting it to drop the arm would be a worse function for a branch
   * counter's benefit. Every reachable arm (a < b, a > b) is exercised by the property-order test. */
  return Object.fromEntries(Object.entries(backtestCase).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Deterministic SHA-256 over the canonicalized cases -- mirrors scripts/export-d1-core.ts's checksumRows
 *  exactly (canonicalize each entry, JSON-stringify the array, hash). */
export function checksumCases(cases: readonly BacktestCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases.map(canonicalizeCase))).digest("hex");
}
