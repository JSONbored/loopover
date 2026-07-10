import { describe, expect, it } from "vitest";
import { formatMaintainerRecap } from "../../src/services/maintainer-recap";
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
    // Empty sections show a single fallback line instead of dangling under the header.
    expect(body).toContain("_No summary lines for this window._");
    expect(body).toContain("_No repositories in this window._");
    // Null rate ⇒ the "n/a" arm.
    expect(body).toContain("- Gate false positives: 0/0 (n/a)");
    expect(body).toContain("- Repos: 0");
    // Trailing single newline, no run of >2 blank lines.
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
    // Per-repo row rendered (non-empty section arm).
    expect(body).toContain("acme/widgets — 5 reviewed, 3 merged, 2 closed, 1 gate false-positive(s), 1 override(s), 0 reversal(s)");
    // Clean summary line survives verbatim (redaction no-op arm).
    expect(body).toContain("- Normal recap line about resolved reviews.");
    // Arm 1: local path scrubbed to the placeholder, raw path gone.
    expect(body).toContain("<redacted-path>");
    expect(body).not.toContain("/root/secrets/config.json");
    // Arm 2: an economic term blanks the whole line.
    expect(body).toContain("- <redacted>");
    expect(body).not.toContain("payout");
  });
});
