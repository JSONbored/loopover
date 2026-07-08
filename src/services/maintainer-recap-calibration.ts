// Maintainer-recap CALIBRATION section (#2243, content slice of the #1963 recap digest).
//
// Pure section builder over a RecapReport projection: surface the ground-truth accuracy signal — how many
// auto-actions humans reversed, and the reversal rate — without any raw score/reward internals. Reuses the
// AgentHealth.reversalRate contract from src/review/alerts.ts:56 (reversals / (merged + closed), 0 when
// nothing auto-acted) and mirrors detectAnomalies' calibration-drift plain-English phrasing at
// src/review/alerts.ts:175 for the drift-present note.
//
// Compatible with the full RecapReport (#2239 / maintainer-recap.ts) once it lands — this file only needs the
// window + totals.{merged,closed,reversals} projection so it can ship independently of the foundation builder.
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../signals/redaction";

/** Projection of RecapReport used by the calibration section. Structurally compatible with RecapReport.totals. */
export type CalibrationRecapSource = {
  windowDays: number;
  totals: {
    merged: number;
    closed: number;
    /** Auto-actions a human overrode in the window (AgentHealth.reversals / RecapReport.totals.reversals). */
    reversals: number;
  };
};

/** One titled digest section: structured fields for consumers + ready-to-emit lines for the formatter. */
export type CalibrationRecapSection = {
  title: string;
  reversals: number;
  /** reversals / (merged + closed) — 0 when nothing auto-acted (alerts.ts AgentHealth.reversalRate). */
  reversalRate: number;
  /** Plain-English status line (drift / healthy / nothing-auto-acted). */
  note: string;
  lines: string[];
};

/** Public-safe scrub for free text pulled into the section (defense in depth — counts are the only inputs
 *  today). Mirrors review-recap.ts / weekly-value-report.ts. */
function sanitizeRecapText(value: string): string {
  return value.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>").slice(0, 240);
}

/**
 * Pure calibration section over a RecapReport projection.
 *
 * - `reversalRate` = reversals / (merged + closed), **0 when the denominator is 0** (nothing auto-acted).
 * - Note arms: drift-present (reversals > 0), healthy (auto-acted + zero reversals), zero-denominator.
 */
export function buildCalibrationRecapSection(report: CalibrationRecapSource): CalibrationRecapSection {
  const reversals = report.totals.reversals;
  const autoActed = report.totals.merged + report.totals.closed;
  // Mirror ops.ts AgentHealth.reversalRate + alerts.ts:56 — zero-denominator stays 0 (not NaN/null).
  const reversalRate = autoActed > 0 ? Number((reversals / autoActed).toFixed(3)) : 0;
  const ratePct = Math.round(reversalRate * 100);

  let note: string;
  if (autoActed === 0) {
    // Nothing auto-acted branch — explicit so the digest still carries a calibration section.
    note = `Nothing auto-acted in the last ${report.windowDays} day(s) (0 merged + 0 closed) — reversal rate is 0 (no denominator).`;
  } else if (reversals > 0) {
    // Mirror detectAnomalies calibration-drift phrasing (alerts.ts:175) without floor internals — RecapReport
    // does not carry recommendedFloor / revertedMaxConfidence; the rate IS the calibration signal here.
    note = `calibration drift: ${reversals} auto-action(s) were human-reverted (reversal-rate ${ratePct}%) over ${autoActed} merged/closed in the last ${report.windowDays} day(s). Consider reviewing confidenceFloor / close-gates for false automations.`;
  } else {
    note = `Calibration healthy: 0 auto-action(s) reverted over ${autoActed} merged/closed in the last ${report.windowDays} day(s) (reversal-rate 0%).`;
  }

  const title = "Calibration";
  const lines = [
    `Reversals: ${reversals}`,
    `Reversal rate: ${ratePct}%`,
    note,
  ].map(sanitizeRecapText);

  return {
    title,
    reversals,
    reversalRate,
    note: sanitizeRecapText(note),
    lines,
  };
}
