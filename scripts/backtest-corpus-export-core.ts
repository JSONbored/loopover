// Pure core for the rule-precision backtest corpus export (#8084, part of epic #8082). Transforms an already-
// built BacktestCase[] (from buildBacktestCorpus) into a versioned, checksummed manifest a scorer can reload
// without re-querying D1. No IO here — the CLI (backtest-corpus-export.ts) does the wrangler/D1 reads and the
// file write — so this stays unit-testable. Mirrors scripts/export-d1-core.ts's pure-core / thin-IO split.
import { createHash } from "node:crypto";
import type { BacktestCase } from "@loopover/engine";

export type BacktestCorpusManifest = {
  ruleId: string;
  caseCount: number;
  checksum: string;
  cases: BacktestCase[];
};

/** Canonicalize one case (sort keys) so property-order differences don't change the checksum — same technique
 *  as export-d1-core.ts's canonicalizeRow. */
function canonicalizeCase(backtestCase: BacktestCase): Record<string, unknown> {
  return Object.fromEntries(Object.entries(backtestCase).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Deterministic SHA-256 over the canonicalized cases — mirrors export-d1-core.ts's checksumRows exactly
 *  (canonicalize each entry, JSON-stringify the array, hash). */
export function checksumCases(cases: readonly BacktestCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases.map(canonicalizeCase))).digest("hex");
}

/**
 * Build the export manifest for one rule's labeled corpus. Spreads an optional `meta` bag into the result
 * (the CLI attaches `generatedAt`); this core never reads the clock. Mirrors export-d1-core.ts's
 * {@link buildExportManifest} signature shape.
 */
export function buildBacktestCorpusManifest(
  ruleId: string,
  cases: readonly BacktestCase[],
  meta: Record<string, unknown> = {},
): BacktestCorpusManifest & Record<string, unknown> {
  return {
    ...meta,
    ruleId,
    caseCount: cases.length,
    checksum: checksumCases(cases),
    cases: [...cases],
  };
}
