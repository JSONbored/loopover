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
    // Header + every titled section header renders (Per-repo/Calibration/Gate outcomes now via the builders, #8372).
    expect(body).toContain("# Maintainer recap");
    expect(body).toContain("## Summary");
    expect(body).toContain("## Totals");
    expect(body).toContain("## Per-repo");
    expect(body).toContain("## Calibration");
    expect(body).toContain("## Gate outcomes");
    // #8214: without a sentinel projection the drift section is entirely absent — the digest stays
    // byte-identical to the pre-drift shape, not a dangling empty header.
    expect(body).not.toContain("## Config drift");
    // The empty Summary section shows its single italic fallback line instead of dangling under the header.
    expect(body).toContain("_No summary lines for this window._");
    // #8372: an empty window now renders the per-repo BUILDER's no-activity line (not the inline fallback).
    expect(body).toContain("- No repo activity in the last 7 day(s).");
    expect(body).not.toContain("_No repositories in this window._");
    // #8372: Calibration is unconditional — the zero-denominator arm still carries a section.
    expect(body).toContain("- Reversals: 0");
    expect(body).toContain("- Reversal rate: 0%");
    expect(body).toContain("- Nothing auto-acted in the last 7 day(s) (0 merged + 0 closed) — reversal rate is 0 (no denominator).");
    // #8372: Gate outcomes is unconditional — the below-MIN_SAMPLE arm renders the "n/a" rate line.
    expect(body).toContain("- Blocked: 0");
    expect(body).toContain("- Maintainer overrides: 0");
    expect(body).toContain("- False positives (blocked then merged): 0");
    expect(body).toContain("- False-positive rate: n/a (fewer than 5 blocks in the last 7 day(s))");
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
    // #8372: Per-repo row rendered via the BUILDER (non-empty section arm) — the capped/sorted format.
    expect(body).toContain("- acme/widgets: reviewed 5, merged 3, closed 2");
    // #8372: Calibration healthy arm (auto-acted > 0, zero reversals).
    expect(body).toContain("- Calibration healthy: 0 auto-action(s) reverted over 5 merged/closed in the last 14 day(s) (reversal-rate 0%).");
    // #8372: Gate outcomes with blocked below MIN_SAMPLE ⇒ the n/a rate arm, over the window's own day count.
    expect(body).toContain("- Blocked: 4");
    expect(body).toContain("- Maintainer overrides: 1");
    expect(body).toContain("- False positives (blocked then merged): 1");
    expect(body).toContain("- False-positive rate: n/a (fewer than 5 blocks in the last 14 day(s))");
    // Clean summary line survives verbatim (redaction no-op arm).
    expect(body).toContain("- Normal recap line about resolved reviews.");
    // Arm 1: local path scrubbed to the placeholder, raw path gone.
    expect(body).toContain("<redacted-path>");
    expect(body).not.toContain("/root/secrets/config.json");
    // Arm 2: an economic term blanks the whole line.
    expect(body).toContain("- <redacted>");
    expect(body).not.toContain("payout");
  });

  it("renders Per-repo through the capped/sorted builder (the (+N more) remainder the old inline lacked), plus the drift + populated gate-rate arms (#8372)", () => {
    // 10 active repos ⇒ the builder shows its top 8 and notes "(+2 more)" — the cap the old inline never applied.
    const repos = Array.from({ length: 10 }, (_, i) => ({
      repoFullName: `acme/r${i}`,
      reviewed: 100 - i, // strictly descending volume ⇒ deterministic order, r0 first
      merged: 1,
      closed: 0,
      gateFalsePositives: 0,
      gateOverrides: 0,
      reversals: 0,
    }));
    const report: RecapReport = {
      generatedAt: GEN,
      windowDays: 7,
      repos,
      totals: {
        reviewed: 955,
        merged: 10,
        closed: 5,
        blocked: 8, // ≥ MIN_SAMPLE (5) ⇒ the gate rate is reported, not n/a
        gateFalsePositives: 2,
        gateOverrides: 3,
        reversals: 2, // > 0 ⇒ the calibration DRIFT arm
        gateFalsePositiveRate: 0.25,
      },
      summary: [],
    };
    const body = formatMaintainerRecap(report);
    // Per-repo builder cap: top 8 shown, the 9th/10th collapsed into the remainder line.
    expect(body).toContain("- acme/r0: reviewed 100, merged 1, closed 0");
    expect(body).toContain("- acme/r7: reviewed 93, merged 1, closed 0");
    expect(body).not.toContain("acme/r8:");
    expect(body).not.toContain("acme/r9:");
    expect(body).toContain("- (+2 more)");
    // Calibration drift arm (reversals > 0): 2/15 = 0.133 ⇒ 13%.
    expect(body).toContain("- calibration drift: 2 auto-action(s) were human-reverted (reversal-rate 13%) over 15 merged/closed in the last 7 day(s). Consider reviewing confidenceFloor / close-gates for false automations.");
    // Gate outcomes populated-rate arm (blocked ≥ MIN_SAMPLE): 2/8 = 25%.
    expect(body).toContain("- False-positive rate: 25% (2 of 8 blocks merged anyway)");
    expect(body).not.toMatch(/\n{3,}/);
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
