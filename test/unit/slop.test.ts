import { describe, expect, it } from "vitest";
import {
  buildDuplicateClusterFinding,
  buildEmptyIssueBodyFinding,
  buildIssueSlopAssessment,
  buildLowQualityCommitMessageFinding,
  buildMissingTestEvidenceFinding,
  buildNonSubstantivePaddingFinding,
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
    expect(SLOP_RUBRIC_MARKDOWN).toContain("generic or empty commit message");

    const clean = buildSlopAssessment({});
    expect(clean).toEqual({ slopRisk: 0, band: "clean", findings: [] });
    expect(buildSlopAssessment({})).toEqual(clean);
  });

  it("raises low-quality-commit-message slop for a generic primary commit subject (#564)", () => {
    const result = buildSlopAssessment({ commitMessages: ["wip"] });
    expect(result.slopRisk).toBe(SLOP_WEIGHTS.lowQualityCommitMessage);
    expect(result.band).toBe("low");
    expect(result.findings).toEqual([expect.objectContaining({ code: "low_quality_commit_message", severity: "warning" })]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("raises low-quality-commit-message slop for dot-only commit subjects (#564)", () => {
    for (const message of [".", "..", "..."]) {
      expect(buildLowQualityCommitMessageFinding({ commitMessages: [message] })).toMatchObject({
        code: "low_quality_commit_message",
        severity: "warning",
      });
    }
  });

  it("does not raise commit-message slop for a specific subject or when no commit data is supplied (#564)", () => {
    expect(buildSlopAssessment({ commitMessages: ["feat(api): add cursor pagination to labels endpoint"] }).findings).toEqual([]);
    expect(buildSlopAssessment({ commitMessages: [] }).findings).toEqual([]);
    expect(buildSlopAssessment({}).findings).toEqual([]);
  });

  it("flags supplied-but-all-blank commit messages as empty, and uses the first non-blank as the primary subject (#564)", () => {
    const empty = buildLowQualityCommitMessageFinding({ commitMessages: ["   ", ""] });
    expect(empty).toMatchObject({ code: "low_quality_commit_message" });
    expect(empty?.detail).toMatch(/empty/i);
    // leading blanks are skipped; the first real subject ("update") is what gets judged.
    expect(buildLowQualityCommitMessageFinding({ commitMessages: ["", "update"] })?.detail).toMatch(/generic/i);
  });

  it("raises duplicate-cluster slop when the PR is flagged as in a duplicate cluster (#563)", () => {
    const result = buildSlopAssessment({ inDuplicateCluster: true });
    expect(result.slopRisk).toBe(SLOP_WEIGHTS.duplicateClusterMembership);
    expect(result.band).toBe("low");
    expect(result.findings).toEqual([expect.objectContaining({ code: "duplicate_cluster_membership", severity: "warning" })]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("does not raise duplicate-cluster slop when not flagged (false or omitted) (#563)", () => {
    expect(buildDuplicateClusterFinding({})).toBeNull();
    expect(buildDuplicateClusterFinding({ inDuplicateCluster: false })).toBeNull();
  });

  it("stacks the duplicate-cluster weight with another signal into the expected band (#563)", () => {
    const result = buildSlopAssessment({
      // code file with no test evidence → missing_test_evidence (30); non-empty description suppresses empty_description.
      changedFiles: [{ path: "src/parser.ts", additions: 10, deletions: 1 }],
      description: "Refactor the parser.",
      inDuplicateCluster: true, // → duplicate_cluster_membership (15)
    });
    expect(result.slopRisk).toBe(SLOP_WEIGHTS.missingTestEvidence + SLOP_WEIGHTS.duplicateClusterMembership);
    expect(result.band).toBe("elevated");
    expect(result.findings.map((finding) => finding.code).sort()).toEqual(["duplicate_cluster_membership", "missing_test_evidence"]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
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

  it("handles repeated unterminated HTML comment openers without excessive scanning", () => {
    const maliciousBody = "<!--".repeat(30_000);

    expect(buildUnfilledIssueTemplateFinding({ body: maliciousBody })).toBeNull();
  }, 1_000);
});

describe("buildNonSubstantivePaddingFinding (#561 path-matcher signal)", () => {
  const FORBIDDEN =
    /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

  it("fires when generated/vendored/minified output dominates a high-churn diff with negligible source", () => {
    const finding = buildNonSubstantivePaddingFinding({
      changedFiles: [
        { path: "dist/bundle.min.js", additions: 300, deletions: 100 },
        { path: "vendor/lib.go", additions: 50, deletions: 0 },
        { path: "src/app.ts", additions: 4, deletions: 2 },
        { path: "test/unit/app.test.ts", additions: 6, deletions: 0 },
        { path: "untouched.ts", additions: 0, deletions: 0 }, // zero-line entry is skipped
      ],
    });
    expect(finding).toMatchObject({ code: "non_substantive_padding", severity: "warning" });
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN);
  });

  it("does not fire when substantive source/test work is present", () => {
    // Padding is the minority of the churn.
    expect(
      buildNonSubstantivePaddingFinding({
        changedFiles: [
          { path: "dist/bundle.min.js", additions: 20, deletions: 0 },
          { path: "src/app.ts", additions: 100, deletions: 30 },
          { path: "test/unit/app.test.ts", additions: 40, deletions: 0 },
        ],
      }),
    ).toBeNull();
    // Padding dominates by count, but real source is still a meaningful share of the diff.
    expect(
      buildNonSubstantivePaddingFinding({
        changedFiles: [
          { path: "dist/bundle.min.js", additions: 60, deletions: 0 },
          { path: "src/app.ts", additions: 30, deletions: 10 },
        ],
      }),
    ).toBeNull();
  });

  it("does not fire for dependency bumps or docs-only diffs", () => {
    expect(
      buildNonSubstantivePaddingFinding({
        changedFiles: [
          { path: "package-lock.json", additions: 400, deletions: 200 },
          { path: "package.json", additions: 2, deletions: 2 },
        ],
      }),
    ).toBeNull();
    expect(
      buildNonSubstantivePaddingFinding({
        changedFiles: [{ path: "docs/guide.md", additions: 300, deletions: 100 }],
      }),
    ).toBeNull();
  });

  it("does not fire below the churn threshold or with no padding files", () => {
    expect(
      buildNonSubstantivePaddingFinding({ changedFiles: [{ path: "dist/app.min.js", additions: 20, deletions: 0 }] }),
    ).toBeNull();
    expect(
      buildNonSubstantivePaddingFinding({ changedFiles: [{ path: "src/app.ts", additions: 200, deletions: 50 }] }),
    ).toBeNull();
    expect(buildNonSubstantivePaddingFinding({})).toBeNull();
  });

  it("contributes to the aggregate slop assessment without colliding with trivial-churn", () => {
    const result = buildSlopAssessment({
      changedFiles: [
        { path: "dist/bundle.min.js", additions: 300, deletions: 100 },
        { path: "src/app.ts", additions: 5, deletions: 2 },
        { path: "test/unit/app.test.ts", additions: 8, deletions: 0 },
      ],
      description: "Rebuild the minified bundle.",
    });
    expect(result.findings.map((finding) => finding.code)).toEqual(["non_substantive_padding"]);
    expect(result.slopRisk).toBe(SLOP_WEIGHTS.nonSubstantivePadding);
    expect(result.band).toBe("elevated");
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN);
  });
});
