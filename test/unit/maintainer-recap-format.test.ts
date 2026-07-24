import { describe, expect, it } from "vitest";
import { formatMaintainerRecap } from "../../src/services/maintainer-recap";
import { buildDriftRecapSection } from "../../src/services/maintainer-recap-drift";
import type { RecapReport } from "../../src/types";

const GEN = "2026-07-08T00:00:00.000Z";

/** A zeroed report: no repos, no summary lines, null false-positive rate — the empty-window shape. */
function emptyReport(): RecapReport {
  return {
    generatedAt: GEN,
    windowDays: 7,
    repos: [],
    totals: {
      reviewed: 0,
      merged: 0,
      closed: 0,
      blocked: 0,
      gateFalsePositives: 0,
      gateOverrides: 0,
      reversals: 0,
      gateFalsePositiveRate: null,
    },
    summary: [],
  };
}

describe("formatMaintainerRecap (#2240)", () => {
  it("renders the header and every titled section, with fallback lines and an n/a rate for an empty window", () => {
    const body = formatMaintainerRecap(emptyReport());
    // Header + all three titled section headers render.
    expect(body).toContain("# Maintainer recap");
    expect(body).toContain("## Summary");
    expect(body).toContain("## Totals");
    expect(body).toContain("## Per-repo");
    // #8372: both builders read only totals/windowDays, so their sections are unconditional.
    expect(body).toContain("## Calibration");
    expect(body).toContain("## Gate outcomes");
    // #8214: without a sentinel projection the drift section is entirely absent — the digest stays
    // byte-identical to the pre-drift shape, not a dangling empty header.
    expect(body).not.toContain("## Config drift");
    // Empty sections show a single fallback line instead of dangling under the header.
    expect(body).toContain("_No summary lines for this window._");
    // #8372: the ## Per-repo body now comes from buildPerRepoRecapSection, which emits its own
    // windowed empty-state line, so the section is never empty and the generic fallback never fires.
    expect(body).toContain("No repo activity in the last 7 day(s).");
    expect(body).not.toContain("_No repositories in this window._");
    // Null rate ⇒ the "n/a" arm.
    expect(body).toContain("- Gate false positives: 0/0 (n/a)");
    expect(body).toContain("- Repos: 0");
    // Trailing single newline, no run of >2 blank lines.
    expect(body.endsWith("\n")).toBe(true);
    expect(body).not.toMatch(/\n{3,}/);
  });

  it("appends the #8214 config-drift section as bullet lines when the caller supplies a sentinel projection", () => {
    const configDrift = buildDriftRecapSection({
      generatedAt: GEN,
      sentinelEnabled: false,
      drifting: [],
      cleanKnobs: 0,
    });
    const body = formatMaintainerRecap(emptyReport(), { configDrift });
    expect(body).toContain("## Config drift");
    expect(body).toContain("- drift sentinel disabled — no drift evaluation ran this window.");
    // The appended section keeps the digest's formatting invariants.
    expect(body.endsWith("\n")).toBe(true);
    expect(body).not.toMatch(/\n{3,}/);
  });

  it("renders per-repo rows, a percent rate, and redacts both regex arms (path + economic term)", () => {
    const report: RecapReport = {
      generatedAt: GEN,
      windowDays: 14,
      repos: [
        {
          repoFullName: "acme/widgets",
          reviewed: 5,
          merged: 3,
          closed: 2,
          gateFalsePositives: 1,
          gateOverrides: 1,
          reversals: 0,
        },
      ],
      totals: {
        reviewed: 5,
        merged: 3,
        closed: 2,
        blocked: 4,
        gateFalsePositives: 1,
        gateOverrides: 1,
        reversals: 0,
        gateFalsePositiveRate: 0.25,
      },
      summary: [
        "Normal recap line about resolved reviews.",
        "leaked path /root/secrets/config.json here",
        "payout was 500 tao last window",
      ],
    };
    const body = formatMaintainerRecap(report);

    // Numeric / non-null rate arm.
    expect(body).toContain("- Gate false positives: 1/4 (25%)");
    expect(body).toContain("- Repos: 1");
    // Per-repo row rendered (non-empty section arm), now in buildPerRepoRecapSection's row format (#8372).
    // The gate/override/reversal counts this row used to carry are unchanged in ## Totals above, and are
    // broken out per-dimension by the ## Gate outcomes section this digest now composes.
    expect(body).toContain("acme/widgets: reviewed 5, merged 3, closed 2");
    // Clean summary line survives verbatim (redaction no-op arm).
    expect(body).toContain("- Normal recap line about resolved reviews.");
    // Arm 1: local path scrubbed to the placeholder, raw path gone.
    expect(body).toContain("<redacted-path>");
    expect(body).not.toContain("/root/secrets/config.json");
    // Arm 2: an economic term blanks the whole line.
    expect(body).toContain("- <redacted>");
    expect(body).not.toContain("payout");
  });

  it("omits cohort diagnostics from the public recap even when totals.cohorts is present", () => {
    const report: RecapReport = {
      ...emptyReport(),
      totals: {
        ...emptyReport().totals,
        cohorts: {
          miner: { blocked: 3, gateFalsePositives: 1, gateFalsePositiveRate: 0.333 },
          human: { blocked: 5, gateFalsePositives: 0, gateFalsePositiveRate: 0 },
        },
      },
      summary: ["Miner-originated: 3 blocked", "Human-originated: 5 blocked", "Cohorts diagnostics"],
    };
    const body = formatMaintainerRecap(report);
    expect(body).not.toContain("## Cohorts");
    expect(body).not.toContain("Miner-originated");
    expect(body).not.toContain("Human-originated");
    expect(body).not.toContain("Cohorts diagnostics");
    expect(body.match(/- <redacted>/g)).toHaveLength(3);
    expect(body).not.toMatch(/\n{3,}/);
  });
});
