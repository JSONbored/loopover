import { describe, expect, it } from "vitest";
import {
  buildAddedTestEvidenceFinding,
  buildIncreasedPatchCoverageFinding,
  buildReducedComplexityFinding,
  buildResolvedDuplicationFinding,
  buildStructuralImprovementAssessment,
  IMPROVEMENT_RUBRIC_MARKDOWN,
  IMPROVEMENT_WEIGHTS,
  type ImprovementBand,
  type StructuralImprovementInput,
} from "../../src/signals/improvement";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

describe("buildStructuralImprovementAssessment", () => {
  it("exports a rubric describing every band and signal", () => {
    expect(IMPROVEMENT_RUBRIC_MARKDOWN).toContain("insufficient-signal");
    expect(IMPROVEMENT_RUBRIC_MARKDOWN).toContain("reduced cyclomatic complexity");
    expect(IMPROVEMENT_RUBRIC_MARKDOWN).toContain("resolved duplication");
    expect(IMPROVEMENT_RUBRIC_MARKDOWN).toContain("increased patch/diff coverage");
    expect(IMPROVEMENT_RUBRIC_MARKDOWN).toContain("added test evidence");
  });

  it("degrades to insufficient-signal when none of the four inputs produced anything (#4742)", () => {
    const result = buildStructuralImprovementAssessment({});
    expect(result).toEqual({ improvementScore: 0, band: "insufficient-signal", findings: [] });
  });

  it("degrades to insufficient-signal for a docs-only PR — nothing for any of the four inputs to measure", () => {
    const result = buildStructuralImprovementAssessment({
      changedFiles: [{ path: "docs/guide.md", additions: 40, deletions: 2 }],
    });
    expect(result).toEqual({ improvementScore: 0, band: "insufficient-signal", findings: [] });
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("is NOT insufficient-signal when a code file was there to check for test evidence, even with no findings", () => {
    // Applicable (a code file exists to evaluate) but nothing fired -- a genuine `none`, distinct from
    // insufficient-signal, even though both share improvementScore === 0.
    const result = buildStructuralImprovementAssessment({
      changedFiles: [{ path: "src/widget.ts", additions: 20, deletions: 5 }],
    });
    expect(result).toEqual({ improvementScore: 0, band: "none", findings: [] });
  });

  it("is NOT insufficient-signal when complexity deltas were measured but none improved (all regressions)", () => {
    // The complexity axis had something to look at (the array is non-empty) -- this must read as `none`,
    // never insufficient-signal, even though the aggregate improvementScore is still 0.
    const result = buildStructuralImprovementAssessment({
      complexityDeltas: [{ file: "src/a.ts", line: 12, name: "parse", before: 3, after: 9, delta: 6 }],
    });
    expect(result).toEqual({ improvementScore: 0, band: "none", findings: [] });
  });

  it("is NOT insufficient-signal when a patch-coverage figure is present but zero or negative", () => {
    expect(buildStructuralImprovementAssessment({ patchCoverageDeltaPercent: 0 })).toEqual({
      improvementScore: 0,
      band: "none",
      findings: [],
    });
    expect(buildStructuralImprovementAssessment({ patchCoverageDeltaPercent: -3.5 })).toEqual({
      improvementScore: 0,
      band: "none",
      findings: [],
    });
  });

  it("treats a non-finite patch-coverage figure (NaN/Infinity) as absent, not as a zero/negative applicable figure", () => {
    expect(buildStructuralImprovementAssessment({ patchCoverageDeltaPercent: Number.NaN })).toEqual({
      improvementScore: 0,
      band: "insufficient-signal",
      findings: [],
    });
    expect(buildStructuralImprovementAssessment({ patchCoverageDeltaPercent: Number.POSITIVE_INFINITY })).toEqual({
      improvementScore: 0,
      band: "insufficient-signal",
      findings: [],
    });
  });

  it("reaches `moderate` from a single structural signal (reduced complexity alone)", () => {
    const result = buildStructuralImprovementAssessment({
      complexityDeltas: [{ file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 }],
    });
    expect(result.improvementScore).toBe(IMPROVEMENT_WEIGHTS.reducedComplexity);
    expect(result.band).toBe("moderate");
    expect(result.findings).toEqual([expect.objectContaining({ code: "reduced_complexity", severity: "info" })]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("reaches `moderate` from a single structural signal (resolved duplication alone)", () => {
    const result = buildStructuralImprovementAssessment({
      duplicationDeltas: [{ file: "src/a.ts", line: 10, duplicateOfLine: 40, lines: 12 }],
    });
    expect(result.improvementScore).toBe(IMPROVEMENT_WEIGHTS.resolvedDuplication);
    expect(result.band).toBe("moderate");
    expect(result.findings).toEqual([expect.objectContaining({ code: "resolved_duplication", severity: "info" })]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("reaches `minor` from a single corroborating signal (patch coverage alone)", () => {
    const result = buildStructuralImprovementAssessment({ patchCoverageDeltaPercent: 5 });
    expect(result.improvementScore).toBe(IMPROVEMENT_WEIGHTS.increasedPatchCoverage);
    expect(result.band).toBe("minor");
    expect(result.findings).toEqual([expect.objectContaining({ code: "increased_patch_coverage", severity: "info" })]);
  });

  it("reaches `minor` from a single corroborating signal (test evidence alone)", () => {
    const result = buildStructuralImprovementAssessment({
      changedFiles: [
        { path: "src/widget.ts", additions: 20, deletions: 5 },
        { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
      ],
    });
    expect(result.improvementScore).toBe(IMPROVEMENT_WEIGHTS.addedTestEvidence);
    expect(result.band).toBe("minor");
    expect(result.findings).toEqual([expect.objectContaining({ code: "added_test_evidence", severity: "info" })]);
  });

  it("regression (#9696): a codegen-only diff (no tests) does NOT emit a false added_test_evidence signal", () => {
    // api/service.pb.go passes bare isCodeFile (a `.go` extension) but is generated output nobody hand-tests.
    // Before the fix, hasCodeFileToEvaluate used bare isCodeFile, so buildMissingTestEvidenceFinding's null
    // (no testable code) was read as "test evidence present" and the band became `minor` for a zero-test PR.
    const result = buildStructuralImprovementAssessment({
      changedFiles: [{ path: "api/service.pb.go", additions: 500, deletions: 0 }],
    });
    expect(result.findings.map((finding) => finding.code)).not.toContain("added_test_evidence");
    expect(result.band).toBe("insufficient-signal");
  });

  it("stacks both corroborating signals (30) to a band that still sits below a single structural signal (35)", () => {
    const result = buildStructuralImprovementAssessment({
      patchCoverageDeltaPercent: 5,
      changedFiles: [
        { path: "src/widget.ts", additions: 20, deletions: 5 },
        { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
      ],
    });
    expect(result.improvementScore).toBe(IMPROVEMENT_WEIGHTS.increasedPatchCoverage + IMPROVEMENT_WEIGHTS.addedTestEvidence);
    expect(result.improvementScore).toBe(30);
    expect(result.band).toBe("minor");
    expect(result.findings.map((finding) => finding.code).sort()).toEqual(["added_test_evidence", "increased_patch_coverage"]);
  });

  it("reaches `significant` when both structural signals fire together", () => {
    const result = buildStructuralImprovementAssessment({
      complexityDeltas: [{ file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 }],
      duplicationDeltas: [{ file: "src/b.ts", line: 5, duplicateOfLine: 55, lines: 9 }],
    });
    expect(result.improvementScore).toBe(IMPROVEMENT_WEIGHTS.reducedComplexity + IMPROVEMENT_WEIGHTS.resolvedDuplication);
    expect(result.band).toBe("significant");
    expect(result.findings.map((finding) => finding.code).sort()).toEqual(["reduced_complexity", "resolved_duplication"]);
  });

  it("combines all four inputs into one aggregate score/band with no cross-band leakage", () => {
    const result = buildStructuralImprovementAssessment({
      complexityDeltas: [
        { file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 },
        { file: "src/a.ts", line: 40, name: "bar", before: 2, after: 6, delta: 4 }, // a regression mixed in
      ],
      duplicationDeltas: [{ file: "src/b.ts", line: 5, duplicateOfLine: 55, lines: 9 }],
      patchCoverageDeltaPercent: 5,
      changedFiles: [
        { path: "src/widget.ts", additions: 20, deletions: 5 },
        { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
      ],
    });
    expect(result.improvementScore).toBe(100);
    expect(result.band).toBe("significant");
    expect(result.findings.map((finding) => finding.code).sort()).toEqual([
      "added_test_evidence",
      "increased_patch_coverage",
      "reduced_complexity",
      "resolved_duplication",
    ]);
    // The mixed-sign complexity array still reports only the ONE improved function, proving the finding
    // filters by sign rather than trusting array presence (unlike resolvedDuplication).
    const complexityFinding = result.findings.find((finding) => finding.code === "reduced_complexity");
    expect(complexityFinding?.detail).toContain("1 function(s)");
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("returns identical output for identical input (determinism)", () => {
    const input: StructuralImprovementInput = {
      complexityDeltas: [{ file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 }],
      patchCoverageDeltaPercent: 2.5,
    };
    expect(buildStructuralImprovementAssessment(input)).toEqual(buildStructuralImprovementAssessment(input));
  });

  describe("golden fixtures & band-boundary determinism", () => {
    const goldenFixtures: Array<{
      name: string;
      input: StructuralImprovementInput;
      improvementScore: number;
      band: ImprovementBand;
      codes: string[];
    }> = [
      { name: "insufficient-signal -- no metadata at all", input: {}, improvementScore: 0, band: "insufficient-signal", codes: [] },
      {
        name: "insufficient-signal -- docs-only PR",
        input: { changedFiles: [{ path: "docs/guide.md", additions: 40, deletions: 2 }] },
        improvementScore: 0,
        band: "insufficient-signal",
        codes: [],
      },
      {
        name: "none -- code change with no positive signal",
        input: { changedFiles: [{ path: "src/widget.ts", additions: 20, deletions: 5 }] },
        improvementScore: 0,
        band: "none",
        codes: [],
      },
      {
        name: "minor -- patch coverage increase alone",
        input: { patchCoverageDeltaPercent: 5 },
        improvementScore: IMPROVEMENT_WEIGHTS.increasedPatchCoverage,
        band: "minor",
        codes: ["increased_patch_coverage"],
      },
      {
        name: "minor -- test evidence alone",
        input: {
          changedFiles: [
            { path: "src/widget.ts", additions: 20, deletions: 5 },
            { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
          ],
        },
        improvementScore: IMPROVEMENT_WEIGHTS.addedTestEvidence,
        band: "minor",
        codes: ["added_test_evidence"],
      },
      {
        // Boundary case: both corroborating signals stack to exactly 30 -- still `minor` (1-30), not
        // `moderate` (31-59), proving the corroborating pair never out-ranks a single structural signal.
        name: "minor -- both corroborating signals stack to exactly 30 (boundary)",
        input: {
          patchCoverageDeltaPercent: 5,
          changedFiles: [
            { path: "src/widget.ts", additions: 20, deletions: 5 },
            { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
          ],
        },
        improvementScore: 30,
        band: "minor",
        codes: ["added_test_evidence", "increased_patch_coverage"],
      },
      {
        name: "moderate -- reduced complexity alone",
        input: { complexityDeltas: [{ file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 }] },
        improvementScore: IMPROVEMENT_WEIGHTS.reducedComplexity,
        band: "moderate",
        codes: ["reduced_complexity"],
      },
      {
        name: "moderate -- resolved duplication alone",
        input: { duplicationDeltas: [{ file: "src/b.ts", line: 5, duplicateOfLine: 55, lines: 9 }] },
        improvementScore: IMPROVEMENT_WEIGHTS.resolvedDuplication,
        band: "moderate",
        codes: ["resolved_duplication"],
      },
      {
        name: "significant -- both structural signals",
        input: {
          complexityDeltas: [{ file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 }],
          duplicationDeltas: [{ file: "src/b.ts", line: 5, duplicateOfLine: 55, lines: 9 }],
        },
        improvementScore: 70,
        band: "significant",
        codes: ["reduced_complexity", "resolved_duplication"],
      },
      {
        name: "significant -- all four signals",
        input: {
          complexityDeltas: [{ file: "src/a.ts", line: 10, name: "foo", before: 12, after: 4, delta: -8 }],
          duplicationDeltas: [{ file: "src/b.ts", line: 5, duplicateOfLine: 55, lines: 9 }],
          patchCoverageDeltaPercent: 5,
          changedFiles: [
            { path: "src/widget.ts", additions: 20, deletions: 5 },
            { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
          ],
        },
        improvementScore: 100,
        band: "significant",
        codes: ["added_test_evidence", "increased_patch_coverage", "reduced_complexity", "resolved_duplication"],
      },
    ];

    it.each(goldenFixtures)("scores the $name fixture to its documented band", (fixture) => {
      const result = buildStructuralImprovementAssessment(fixture.input);
      expect(result.improvementScore).toBe(fixture.improvementScore);
      expect(result.band).toBe(fixture.band);
      expect(result.findings.map((finding) => finding.code).sort()).toEqual(fixture.codes);
      expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    });

    it("returns identical improvementScore and findings for identical metadata (determinism)", () => {
      for (const fixture of goldenFixtures) {
        expect(buildStructuralImprovementAssessment(fixture.input)).toEqual(buildStructuralImprovementAssessment(fixture.input));
      }
    });

    it("keeps every fixture score within the clamped 0..100 range (invariant)", () => {
      for (const fixture of goldenFixtures) {
        const { improvementScore } = buildStructuralImprovementAssessment(fixture.input);
        expect(improvementScore).toBeGreaterThanOrEqual(0);
        expect(improvementScore).toBeLessThanOrEqual(100);
      }
    });

    it("never mixes insufficient-signal with a non-zero score, and never mixes `none` with a non-zero score (invariant)", () => {
      for (const fixture of goldenFixtures) {
        const result = buildStructuralImprovementAssessment(fixture.input);
        if (result.band === "insufficient-signal" || result.band === "none") {
          expect(result.improvementScore).toBe(0);
          expect(result.findings).toEqual([]);
        }
      }
    });
  });
});

describe("buildReducedComplexityFinding", () => {
  it("returns null when no complexity deltas are supplied (undefined or empty)", () => {
    expect(buildReducedComplexityFinding({})).toBeNull();
    expect(buildReducedComplexityFinding({ complexityDeltas: [] })).toBeNull();
  });

  it("returns null when every delta is a regression or unchanged (delta >= 0)", () => {
    expect(
      buildReducedComplexityFinding({
        complexityDeltas: [
          { file: "src/a.ts", line: 1, name: "foo", before: 3, after: 3, delta: 0 },
          { file: "src/a.ts", line: 20, name: "bar", before: 2, after: 5, delta: 3 },
        ],
      }),
    ).toBeNull();
  });

  it("fires and counts only the improved (delta < 0) entries out of a mixed-sign array", () => {
    const finding = buildReducedComplexityFinding({
      complexityDeltas: [
        { file: "src/a.ts", line: 1, name: "foo", before: 12, after: 4, delta: -8 },
        { file: "src/a.ts", line: 20, name: "bar", before: 2, after: 9, delta: 7 },
        { file: "src/b.ts", line: 5, name: "baz", before: 20, after: 11, delta: -9 },
      ],
    });
    expect(finding).toMatchObject({ code: "reduced_complexity", severity: "info" });
    expect(finding?.detail).toContain("2 function(s)");
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});

describe("buildResolvedDuplicationFinding", () => {
  it("returns null when no duplication deltas are supplied (undefined or empty)", () => {
    expect(buildResolvedDuplicationFinding({})).toBeNull();
    expect(buildResolvedDuplicationFinding({ duplicationDeltas: [] })).toBeNull();
  });

  it("fires and reports the resolved count when duplication deltas are present", () => {
    const finding = buildResolvedDuplicationFinding({
      duplicationDeltas: [
        { file: "src/a.ts", line: 5, duplicateOfLine: 55, lines: 9 },
        { file: "src/b.ts", line: 12, duplicateOfLine: 88, lines: 6 },
      ],
    });
    expect(finding).toMatchObject({ code: "resolved_duplication", severity: "info" });
    expect(finding?.detail).toContain("2 previously-duplicated");
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});

describe("buildIncreasedPatchCoverageFinding", () => {
  it("returns null when no figure is supplied", () => {
    expect(buildIncreasedPatchCoverageFinding({})).toBeNull();
  });

  it("returns null for a non-finite figure (NaN or Infinity)", () => {
    expect(buildIncreasedPatchCoverageFinding({ patchCoverageDeltaPercent: Number.NaN })).toBeNull();
    expect(buildIncreasedPatchCoverageFinding({ patchCoverageDeltaPercent: Number.POSITIVE_INFINITY })).toBeNull();
    expect(buildIncreasedPatchCoverageFinding({ patchCoverageDeltaPercent: Number.NEGATIVE_INFINITY })).toBeNull();
  });

  it("returns null for a zero or negative figure", () => {
    expect(buildIncreasedPatchCoverageFinding({ patchCoverageDeltaPercent: 0 })).toBeNull();
    expect(buildIncreasedPatchCoverageFinding({ patchCoverageDeltaPercent: -12.5 })).toBeNull();
  });

  it("fires and interpolates the figure for a genuine increase", () => {
    const finding = buildIncreasedPatchCoverageFinding({ patchCoverageDeltaPercent: 4.2 });
    expect(finding).toMatchObject({ code: "increased_patch_coverage", severity: "info" });
    expect(finding?.detail).toContain("4.2");
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});

describe("buildAddedTestEvidenceFinding", () => {
  it("returns null when there are no changed files at all", () => {
    expect(buildAddedTestEvidenceFinding({})).toBeNull();
  });

  it("returns null when changed files exist but none are code files (docs-only)", () => {
    expect(
      buildAddedTestEvidenceFinding({
        changedFiles: [{ path: "docs/guide.md", additions: 40, deletions: 2 }],
      }),
    ).toBeNull();
  });

  it("ignores a changed-file entry with an empty path when checking for a code file to evaluate", () => {
    expect(
      buildAddedTestEvidenceFinding({
        changedFiles: [{ path: "", additions: 40, deletions: 2 }],
      }),
    ).toBeNull();
  });

  it("returns null when a code file changed with no accompanying test evidence", () => {
    expect(
      buildAddedTestEvidenceFinding({
        changedFiles: [{ path: "src/widget.ts", additions: 20, deletions: 5 }],
      }),
    ).toBeNull();
  });

  it("fires when a changed test FILE accompanies the code change", () => {
    const finding = buildAddedTestEvidenceFinding({
      changedFiles: [
        { path: "src/widget.ts", additions: 20, deletions: 5 },
        { path: "test/unit/widget.test.ts", additions: 30, deletions: 0 },
      ],
    });
    expect(finding).toMatchObject({ code: "added_test_evidence", severity: "info" });
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("fires when external testFiles evidence is supplied instead of a changed test file", () => {
    const finding = buildAddedTestEvidenceFinding({
      changedFiles: [{ path: "src/registry/sync.ts", additions: 12, deletions: 0 }],
      testFiles: ["internal/cache_test.go"],
    });
    expect(finding).toMatchObject({ code: "added_test_evidence" });
  });

  it("fires when external tests evidence (test identifiers) is supplied", () => {
    const finding = buildAddedTestEvidenceFinding({
      changedFiles: [{ path: "src/registry/sync.ts", additions: 12, deletions: 0 }],
      tests: ["sync_test.go::TestRetryBackoff"],
    });
    expect(finding).toMatchObject({ code: "added_test_evidence" });
  });
});
