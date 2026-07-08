// Maintainer-recap GATE-OUTCOMES section (#2242, content slice of the #1963 recap digest).
//
// Pure section builder over a RecapReport projection: summarize the gate's window — how many PRs the
// gate blocked, how many maintainers OVERRODE, and the blocked-then-merged FALSE-POSITIVE count + rate —
// straight from the same GatePrecisionReport totals that services/gate-precision.ts aggregates (the source
// src/review/ops-wire.ts reads). No delivery, no scheduling, no new queries.
//
// The false-positive rate is NULLED below MIN_SAMPLE exactly as gate-precision.ts:103 — a 1-of-1 "false
// positive" is noise, not a precision signal. Own file (mirroring maintainer-recap-calibration.ts) so it
// stays decoupled from the foundation builder and sibling sections (zero shared-file conflict surface).
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../signals/redaction";

// Mirror gate-precision.ts:22 — the rate is noise below this many blocks, so it reports as null (n/a).
const MIN_SAMPLE = 5;

/** Mirror gate-precision.ts:41 round() — three decimal places. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Projection of RecapReport used by the gate-outcomes section (window + gate totals only). */
export type GateOutcomesRecapSource = {
  windowDays: number;
  totals: {
    /** Total gate blocks over the window (the rate denominator). */
    blocked: number;
    /** Blocks that later MERGED anyway — a gate FALSE POSITIVE. */
    gateFalsePositives: number;
    /** Blocks a maintainer explicitly OVERRODE. */
    gateOverrides: number;
  };
};

/** One titled digest section: structured fields for consumers + ready-to-emit lines for the formatter. */
export type GateOutcomesRecapSection = {
  title: string;
  blocked: number;
  overridden: number;
  falsePositives: number;
  /** blockedThenMerged / blocked, 3 dp — NULL below MIN_SAMPLE (gate-precision.ts:103). */
  falsePositiveRate: number | null;
  lines: string[];
};

/** Public-safe scrub for free text pulled into the section (defense in depth — counts are the only inputs
 *  today). Mirrors maintainer-recap-calibration.ts. */
function sanitizeRecapText(value: string): string {
  return value.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>").slice(0, 240);
}

/**
 * Pure gate-outcomes section over a RecapReport projection.
 *
 * - `falsePositiveRate` = gateFalsePositives / blocked, rounded to 3 dp — but **null below MIN_SAMPLE**
 *   (and therefore also when nothing was blocked), exactly as gate-precision.ts nulls a low-sample rate.
 * - The rate line reads "n/a" on the null arm so the digest still carries a gate-outcomes section.
 */
export function buildGateOutcomesRecapSection(report: GateOutcomesRecapSource): GateOutcomesRecapSection {
  const { blocked, gateFalsePositives, gateOverrides } = report.totals;
  // Null the rate below MIN_SAMPLE (gate-precision.ts:103) — a 1-of-1 "false positive" is noise. This also
  // covers the divide-by-zero arm (blocked === 0 < MIN_SAMPLE), so the ratio is never evaluated at 0.
  const falsePositiveRate = blocked >= MIN_SAMPLE ? round(gateFalsePositives / blocked) : null;

  const rateLine =
    falsePositiveRate === null
      ? `False-positive rate: n/a (fewer than ${MIN_SAMPLE} blocks in the last ${report.windowDays} day(s))`
      : `False-positive rate: ${Math.round(falsePositiveRate * 100)}% (${gateFalsePositives} of ${blocked} blocks merged anyway)`;

  const title = "Gate outcomes";
  const lines = [
    `Blocked: ${blocked}`,
    `Maintainer overrides: ${gateOverrides}`,
    `False positives (blocked then merged): ${gateFalsePositives}`,
    rateLine,
  ].map(sanitizeRecapText);

  return {
    title,
    blocked,
    overridden: gateOverrides,
    falsePositives: gateFalsePositives,
    falsePositiveRate,
    lines,
  };
}
