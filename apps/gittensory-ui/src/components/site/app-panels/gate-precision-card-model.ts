// Gate-precision analytics card model (#2191). UI-side mirror of the GateEvalReport/GateEvalRow shape produced
// by computeGateEval (src/review/parity.ts) and surfaced on the operator-dashboard payload — plus the pure fold
// that turns the per-project rows into a single 2x2 confusion matrix + merge precision for the card. Types +
// pure helper live here (not in the .tsx) so the component file exports only components
// (react-refresh/only-export-components).

/** One project's gate confusion matrix + precisions (mirror of src/review/parity.ts GateEvalRow). */
export interface GateEvalRow {
  project: string;
  wouldMerge: number;
  mergeConfirmed: number; // predicted merge AND human merged (true positive)
  mergeFalse: number; // predicted merge BUT human closed (false positive)
  wouldClose: number;
  closeConfirmed: number; // predicted close AND human closed (true negative)
  closeFalse: number; // predicted close BUT human merged (false negative)
  hold: number;
  decided: number;
  mergePrecision: number | null;
  closePrecision: number | null;
}

/** The gate-eval report as delivered on the operator-dashboard payload (mirror of parity.ts GateEvalReport). */
export interface GateEvalReport {
  rows: GateEvalRow[];
  /** True once at least one project has enough decided samples to read meaningfully (parity.ts's floor). */
  hasSignal: boolean;
}

/** Aggregated 2x2 confusion matrix across every project row, with overall merge precision. */
export interface GateConfusionMatrix {
  truePositive: number; // merge predicted → merged
  falsePositive: number; // merge predicted → closed
  falseNegative: number; // close predicted → merged
  trueNegative: number; // close predicted → closed
  decided: number;
  /** TP / (TP + FP); null when the gate made no merge predictions (empty denominator). */
  mergePrecision: number | null;
}

/** Fold the per-project rows into one confusion matrix. Pure; an empty report yields all-zero counts and a
 *  null precision (no merge predictions ⇒ nothing to be precise about). */
export function aggregateGateEval(report: GateEvalReport): GateConfusionMatrix {
  const totals = report.rows.reduce(
    (acc, row) => ({
      truePositive: acc.truePositive + row.mergeConfirmed,
      falsePositive: acc.falsePositive + row.mergeFalse,
      falseNegative: acc.falseNegative + row.closeFalse,
      trueNegative: acc.trueNegative + row.closeConfirmed,
      decided: acc.decided + row.decided,
    }),
    { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, decided: 0 },
  );
  const mergePredictions = totals.truePositive + totals.falsePositive;
  return {
    ...totals,
    mergePrecision: mergePredictions > 0 ? totals.truePositive / mergePredictions : null,
  };
}
