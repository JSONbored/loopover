import { describe, expect, it } from "vitest";
import {
  buildEmptyIssueBodyFinding,
  buildIssueSlopAssessment,
  buildMissingTestEvidenceFinding,
  buildSlopAssessment,
  buildTrivialWhitespaceChurnFinding,
  buildUnfilledIssueTemplateFinding,
  ISSUE_SLOP_WEIGHTS,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
} from "../../src/signals/slop";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

describe("buildSlopAssessment", () => {
  it("exports rubric bands and a deterministic assessment shell", () => {
    expect(SLOP_RUBRIC_MARKDOWN).toContain("clean");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("missing test evidence");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("trivial / whitespace-only churn");

    const clean = buildSlopAssessment({});
    expect(clean).toEqual({ slopRisk: 0, band: "clean", findings: [] });
    expect(buildSlopAssessment({})).toEqual(clean);
  });

  it("raises missing-test-evidence slop for code-only diffs without tests", () => {
    const result = buildSlopAssessment({
      changedFiles: [{ path: "src/registry/sync.ts", additions: 24, deletions: 2 }],
      description: "Add retry-with-backoff to the registry sync client.",
    });

    expect(result.slopRisk).toBe(SLOP_WEIGHTS.missingTestEvidence);
    expect(result.band).toBe("elevated");
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "missing_test_evidence",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("raises trivial-churn slop for high-churn diffs with minimal source lines", () => {
    const result = buildSlopAssessment({
      changedFiles: [
        { path: "README.md", additions: 30, deletions: 20 },
        { path: "docs/guide.md", additions: 25, deletions: 15 },
        { path: "src/widget.ts", additions: 2, deletions: 1 },
        { path: "test/unit/widget.test.ts", additions: 4, deletions: 0 },
      ],
      description: "Documentation refresh plus a tiny widget tweak.",
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

  it("does not raise missing-test-evidence when changed test files are present", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "src/registry/sync.ts", additions: 24, deletions: 2 },
          { path: "test/unit/registry-sync.test.ts", additions: 18, deletions: 0 },
        ],
        description: "Add a retry path with regression coverage.",
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("does not raise missing-test-evidence when external test evidence is supplied", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [{ path: "src/registry/sync.ts", additions: 12, deletions: 0 }],
        testFiles: ["internal/cache_test.go"],
        description: "Add a retry path, covered by cache_test.go.",
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("does not raise trivial-churn when substantive source edits dominate", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "src/registry/sync.ts", additions: 80, deletions: 20 },
          { path: "test/unit/registry-sync.test.ts", additions: 40, deletions: 5 },
        ],
        description: "Substantive sync refactor with tests.",
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

  it("ignores docs-only diffs without code files for missing-test-evidence", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [{ path: "README.md", additions: 10, deletions: 0 }],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("raises trivial-churn for non-code-only high-churn diffs", () => {
    expect(
      buildSlopAssessment({
        // Docs-only churn: no code files, so neither missing-test-evidence nor empty-description fires.
        changedFiles: [
          { path: "README.md", additions: 25, deletions: 20 },
          { path: "docs/guide.md", additions: 20, deletions: 15 },
        ],
      }).findings.map((finding) => finding.code),
    ).toEqual(["trivial_whitespace_churn"]);
  });

  it("raises empty-description slop only for a code change with no description", () => {
    const flagged = buildSlopAssessment({ changedFiles: [{ path: "src/api/routes.ts", additions: 5, deletions: 1 }], description: "", tests: ["ok"], testFiles: ["test/x.test.ts"] });
    expect(flagged.findings.map((finding) => finding.code)).toContain("empty_pr_description");
    expect(flagged.slopRisk).toBe(SLOP_WEIGHTS.emptyDescription);

    // An omitted (undefined) description on a code change also trips it.
    expect(buildSlopAssessment({ changedFiles: [{ path: "src/api/routes.ts", additions: 5, deletions: 1 }], tests: ["ok"], testFiles: ["test/x.test.ts"] }).findings.map((finding) => finding.code)).toContain("empty_pr_description");

    // A non-empty description never trips it; docs-only with no description never trips it.
    expect(buildSlopAssessment({ changedFiles: [{ path: "src/api/routes.ts", additions: 5, deletions: 1 }], description: "Adds a header.", tests: ["ok"], testFiles: ["test/x.test.ts"] }).findings).toEqual([]);
    expect(buildSlopAssessment({ changedFiles: [{ path: "README.md", additions: 5, deletions: 1 }] }).findings).toEqual([]);
  });

  it("reaches the high band when multiple strong signals stack", () => {
    // Code change, no tests, no description: missing-test-evidence (30) + empty-description (15) = elevated.
    const elevated = buildSlopAssessment({ changedFiles: [{ path: "src/x.ts", additions: 10, deletions: 1 }], description: "" });
    expect(elevated.band).toBe("elevated");

    // High-whitespace-churn code change + no tests + no description: 30 + 30 + 15 = 75 -> high (>=60).
    const high = buildSlopAssessment({
      changedFiles: [
        { path: "src/x.ts", additions: 2, deletions: 1 },
        { path: "src/generated.snap", additions: 60, deletions: 40 },
      ],
      description: "",
    });
    expect(high.slopRisk).toBeGreaterThanOrEqual(60);
    expect(high.band).toBe("high");
  });
});

describe("buildMissingTestEvidenceFinding", () => {
  it("keeps public reason strings sanitized", () => {
    const finding = buildMissingTestEvidenceFinding({
      changedFiles: [{ path: "src/api/routes.ts", additions: 3, deletions: 0 }],
    });

    expect(finding).toMatchObject({
      code: "missing_test_evidence",
      publicText: expect.any(String),
    });
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
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

describe("buildIssueSlopAssessment (#533 issue-side triage)", () => {
  it("flags an empty/whitespace body", () => {
    const result = buildIssueSlopAssessment({ title: "It is broken", body: "   \n  " });
    expect(result.findings.map((f) => f.code)).toEqual(["empty_issue_body"]);
    expect(result.slopRisk).toBe(ISSUE_SLOP_WEIGHTS.emptyBody);
    expect(result.band).toBe("elevated");
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("treats an omitted body as empty", () => {
    expect(buildIssueSlopAssessment({ title: "No body at all" }).findings.map((f) => f.code)).toEqual(["empty_issue_body"]);
  });

  it("flags a body that is only an unfilled template (headings + comment placeholders)", () => {
    const body = "### Description\n<!-- describe the bug here -->\n\n### Steps to reproduce\n\n- [ ]\n";
    const result = buildIssueSlopAssessment({ title: "Bug", body });
    expect(result.findings.map((f) => f.code)).toEqual(["unfilled_issue_template"]);
    expect(result.slopRisk).toBe(ISSUE_SLOP_WEIGHTS.unfilledTemplate);
    expect(result.band).toBe("elevated");
  });

  it("does NOT flag a genuine issue, even a terse one (conservative, advisory-only)", () => {
    expect(buildIssueSlopAssessment({ title: "Typo", body: "The README says 'recieve' on line 12; should be 'receive'." })).toEqual({
      slopRisk: 0,
      band: "clean",
      findings: [],
    });
    // A filled template (prose under the headings) is clean.
    expect(buildIssueSlopAssessment({ title: "Bug", body: "### Description\nClicking save throws a 500.\n### Steps\nOpen /save and submit." }).findings).toEqual([]);
  });

  it("empty body and unfilled template are mutually exclusive (never both)", () => {
    // An empty body fires only empty_issue_body; a comment-only body fires only unfilled_issue_template.
    expect(buildIssueSlopAssessment({ body: "" }).findings.map((f) => f.code)).toEqual(["empty_issue_body"]);
    expect(buildIssueSlopAssessment({ body: "<!-- nothing here -->" }).findings.map((f) => f.code)).toEqual(["unfilled_issue_template"]);
  });

  it("finding builders are correct when called directly (the standalone guards)", () => {
    // The unfilled-template builder guards an empty body for direct callers (assessment handles it upstream).
    expect(buildUnfilledIssueTemplateFinding({ body: "" })).toBeNull();
    expect(buildUnfilledIssueTemplateFinding({ body: "Real prose explaining the bug." })).toBeNull();
    expect(buildEmptyIssueBodyFinding({ body: "has content" })).toBeNull();
  });
});
