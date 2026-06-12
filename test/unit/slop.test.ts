import { describe, expect, it } from "vitest";
import {
  buildSlopAssessment,
  buildTrivialWhitespaceChurnFinding,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
} from "../../src/signals/slop";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

describe("buildSlopAssessment", () => {
  it("exports rubric bands and a deterministic assessment shell", () => {
    expect(SLOP_RUBRIC_MARKDOWN).toContain("trivial / whitespace-only churn");

    const clean = buildSlopAssessment({});
    expect(clean).toEqual({ slopRisk: 0, band: "clean", findings: [] });
    expect(buildSlopAssessment({})).toEqual(clean);
  });

  it("raises trivial-churn slop for high-churn diffs with minimal source lines", () => {
    const result = buildSlopAssessment({
      changedFiles: [
        { path: "README.md", additions: 30, deletions: 20 },
        { path: "docs/guide.md", additions: 25, deletions: 15 },
        { path: "src/widget.ts", additions: 2, deletions: 1 },
      ],
    });

    expect(result.slopRisk).toBe(SLOP_WEIGHTS.trivialWhitespaceChurn);
    expect(result.band).toBe("elevated");
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "trivial_whitespace_churn",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("does not raise trivial-churn when substantive source edits dominate", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "src/registry/sync.ts", additions: 80, deletions: 20 },
          { path: "test/unit/registry-sync.test.ts", additions: 40, deletions: 5 },
        ],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("does not raise trivial-churn for small diffs below the churn threshold", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [{ path: "README.md", additions: 10, deletions: 8 }],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("raises trivial-churn for non-code-only high-churn diffs", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "README.md", additions: 25, deletions: 20 },
          { path: "docs/guide.md", additions: 20, deletions: 15 },
        ],
      }).findings.map((finding) => finding.code),
    ).toEqual(["trivial_whitespace_churn"]);
  });
});

describe("buildTrivialWhitespaceChurnFinding", () => {
  it("keeps public reason strings sanitized", () => {
    const finding = buildTrivialWhitespaceChurnFinding({
      changedFiles: [
        { path: "README.md", additions: 30, deletions: 20 },
        { path: "docs/guide.md", additions: 25, deletions: 15 },
      ],
    });

    expect(finding).toMatchObject({
      code: "trivial_whitespace_churn",
      publicText: expect.any(String),
    });
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});
