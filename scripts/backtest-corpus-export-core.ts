// Pure core for the rule-precision backtest corpus export (#8084, part of epic #8082). Transforms an already-
// built BacktestCase[] (from buildBacktestCorpus) into a versioned, checksummed manifest a scorer can reload
// without re-querying D1. No IO here — the CLI (backtest-corpus-export.ts) does the wrangler/D1 reads and the
// file write — so this stays unit-testable. Mirrors scripts/export-d1-core.ts's pure-core / thin-IO split.
import { checksumCases } from "@loopover/engine";
import type { BacktestCase } from "@loopover/engine/calibration/backtest-corpus";

// #9639: checksumCases moved into the engine so the in-Worker threshold backtest can use it too. Re-exported
// here because this module's own consumers (and its test) have always imported it from this path, and the
// checksum must stay ONE function -- a manifest frozen by one copy and validated by another would disagree
// for no visible reason.
export { checksumCases };

export type BacktestCorpusManifest = {
  ruleId: string;
  caseCount: number;
  checksum: string;
  cases: BacktestCase[];
};

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
