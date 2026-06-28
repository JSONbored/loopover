import { describe, expect, it } from "vitest";
import { buildPullRequestAdvisory, evaluateGateCheck } from "../../src/rules/advisory";
import {
  buildDuplicateClusterFinding,
  buildEmptyDescriptionFinding,
  buildEmptyIssueBodyFinding,
  buildIssueSlopAssessment,
  buildLowQualityCommitMessageFinding,
  buildMissingTestEvidenceFinding,
  buildNoLinkedIssueRationaleFinding,
  buildNonSubstantivePaddingFinding,
  buildSlopAssessment,
  buildTitleRestatementIssueFinding,
  buildTrivialWhitespaceChurnFinding,
  buildUnfilledIssueTemplateFinding,
  type SlopAssessmentInput,
  type SlopBand,
  ISSUE_SLOP_WEIGHTS,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
} from "../../src/signals/slop";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

// The gate's default slop block threshold = the `high` band (60), used when a maintainer sets slop: block
// without a minScore (see DEFAULT_SLOP_BLOCK_THRESHOLD in src/rules/advisory.ts).
const DEFAULT_SLOP_BLOCK_THRESHOLD = 60;

// A PR advisory with no app-state findings — overriding findings to [] avoids the `repo_not_registered`
// short-circuit so evaluateGateCheck reaches the slop blocker (mirrors the rules.test.ts pattern).
const cleanAdvisory = () => ({ ...buildPullRequestAdvisory(null, null), findings: [] });

describe("buildSlopAssessment", () => {
  it("exports rubric bands and a deterministic assessment shell", () => {
    expect(SLOP_RUBRIC_MARKDOWN).toContain("clean");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("missing test evidence");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("trivial / whitespace-only churn");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("generic or empty commit message");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("no linked issue and no rationale");

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

  it("raises no-linked-issue-without-rationale slop when there is no issue and no rationale (#562)", () => {
    const result = buildSlopAssessment({ hasLinkedIssue: false });
    expect(result.slopRisk).toBe(SLOP_WEIGHTS.noLinkedIssueWithoutRationale);
    expect(result.band).toBe("low");
    expect(result.findings).toEqual([expect.objectContaining({ code: "no_linked_issue_without_rationale", severity: "warning" })]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("does not raise no-linked-issue slop when an issue is linked, a rationale is present, the lane is issue-discovery, or no data is supplied (#562)", () => {
    expect(buildSlopAssessment({ hasLinkedIssue: true }).findings).toEqual([]);
    expect(buildSlopAssessment({ hasLinkedIssue: false, description: "Docs only: fix a typo in the README." }).findings).toEqual([]);
    expect(buildSlopAssessment({ hasLinkedIssue: false, description: "No issue: refactor the parser." }).findings).toEqual([]);
    expect(buildSlopAssessment({ hasLinkedIssue: false, description: "No linked issue: internal maintenance." }).findings).toEqual([]);
    expect(buildSlopAssessment({ hasLinkedIssue: false, description: "No ticket: docs cleanup." }).findings).toEqual([]);
    expect(buildSlopAssessment({ hasLinkedIssue: false, issueDiscoveryLane: true }).findings).toEqual([]);
    expect(buildSlopAssessment({}).findings).toEqual([]);
  });

  it("reuses the shared no-issue rationale helper and treats absent linked-issue data as no signal (#562)", () => {
    expect(buildNoLinkedIssueRationaleFinding({ hasLinkedIssue: undefined })).toBeNull();
    // a maintenance/cleanup rationale in the body clears the signal even with no linked issue
    expect(buildNoLinkedIssueRationaleFinding({ hasLinkedIssue: false, description: "Routine maintenance; no issue needed." })).toBeNull();
    expect(buildNoLinkedIssueRationaleFinding({ hasLinkedIssue: false, description: "" })).toMatchObject({ code: "no_linked_issue_without_rationale" });
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

  it("raises missing-test-evidence slop for code-only diffs without tests (weak/corroborating 15 → low band)", () => {
    const result = buildSlopAssessment({
      changedFiles: [{ path: "src/registry/sync.ts", additions: 24, deletions: 2 }],
      description: "Add retry-with-backoff to the registry sync client.",
    });

    // De-weighted to 15: missing-test alone is corroborating, not decisive, and lands in `low` (1-24).
    expect(result.slopRisk).toBe(SLOP_WEIGHTS.missingTestEvidence);
    expect(result.band).toBe("low");
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "missing_test_evidence",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("missing-test paired with one strong-30 signal totals 45 — elevated, NOT blockable at the default 60 (#deweight)", () => {
    // PAIRING delta: the de-weight's real effect. A genuine strong concern (trivial whitespace churn, 30)
    // plus "no tests" (15) reaches 45 — `elevated`, below the default block threshold (60). Pre-change this
    // pairing was 60 and auto-blocked; now a single genuine strong signal + missing-test no longer blocks.
    const result = buildSlopAssessment({
      changedFiles: [
        { path: "src/x.ts", additions: 2, deletions: 1 }, // negligible source share → trivial_whitespace_churn (30)
        { path: "src/state.snap", additions: 60, deletions: 40 }, // non-code churn dominates the diff
      ],
      description: "Reformat the module.", // non-empty → suppresses empty_pr_description
    });
    expect(result.slopRisk).toBe(SLOP_WEIGHTS.trivialWhitespaceChurn + SLOP_WEIGHTS.missingTestEvidence);
    expect(result.slopRisk).toBe(45);
    expect(result.band).toBe("elevated");
    expect(result.slopRisk).toBeLessThan(DEFAULT_SLOP_BLOCK_THRESHOLD); // not blockable at the default high-band threshold
    expect(result.findings.map((finding) => finding.code).sort()).toEqual(["missing_test_evidence", "trivial_whitespace_churn"]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("with slopGateMinScore tuned down to 30, missing-test-only (15) does NOT block — an intended behavior reversal (#deweight)", () => {
    // A repo that explicitly tuned the slop block threshold DOWN to 30 (via .gittensory.yml / the DB column)
    // used to block a missing-test-only PR (old score 30 ≥ 30) and now will not (new score 15 < 30). The gate
    // predicate is `slopRisk >= slopGateMinScore`; we assert the slop score against that tuned threshold.
    const tunedDownThreshold = 30;
    const missingTestOnly = buildSlopAssessment({
      changedFiles: [{ path: "src/svc.ts", additions: 12, deletions: 3 }],
      description: "Add retry logic to the sync client.",
    });
    expect(missingTestOnly.slopRisk).toBe(SLOP_WEIGHTS.missingTestEvidence);
    expect(missingTestOnly.slopRisk).toBeLessThan(tunedDownThreshold); // 15 < 30 → does NOT block
    // The real gate path: a `block` slop gate at minScore 30 produces no slop blocker for this score.
    // Override findings to [] so the bare null/null advisory's app-state finding does not short-circuit the gate.
    const gate = evaluateGateCheck(cleanAdvisory(), {
      slopGateMode: "block",
      slopGateMinScore: tunedDownThreshold,
      slopRisk: missingTestOnly.slopRisk,
    });
    expect(gate.blockers.map((blocker) => blocker.code)).not.toContain("slop_risk_above_threshold");
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

  it("does not raise trivial-churn for a test-only diff above the churn threshold (regression: test lines are substantive)", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "test/unit/sync.test.ts", additions: 30, deletions: 15 },
          { path: "test/integration/api.test.ts", additions: 10, deletions: 5 },
        ],
        description: "Add regression tests for the sync module.",
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("does not raise trivial-churn when test lines dominate a mixed diff", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "src/parser.ts", additions: 3, deletions: 1 },
          { path: "test/unit/parser.test.ts", additions: 25, deletions: 15 },
          { path: "README.md", additions: 5, deletions: 3 },
        ],
        description: "Fix parser edge case and add comprehensive test coverage.",
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
    // Code change, no tests, no description: missing-test-evidence (15) + empty-description (15) = 30 = elevated.
    const elevated = buildSlopAssessment({ changedFiles: [{ path: "src/x.ts", additions: 10, deletions: 1 }], description: "" });
    expect(elevated.band).toBe("elevated");

    // High-whitespace-churn code change + no tests + no description: 30 + 15 + 15 = 60 -> high (>=60).
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

describe("buildEmptyDescriptionFinding — single-pass code-file detection", () => {
  it("ignores empty-path entries and non-code files when counting changed code files", () => {
    // blank path and docs/markdown files must not count toward the code-file total
    expect(buildEmptyDescriptionFinding({ changedFiles: [{ path: "" }, { path: "README.md" }, { path: "docs/guide.mdx" }], description: "" })).toBeNull();
  });

  it("fires for a real code change with an empty description and reports the code-file count", () => {
    const finding = buildEmptyDescriptionFinding({
      changedFiles: [{ path: "" }, { path: "src/a.ts" }, { path: "README.md" }, { path: "src/b.ts" }],
      description: "   ",
    });
    expect(finding).toMatchObject({ code: "empty_pr_description", severity: "warning" });
    expect(finding?.detail).toContain("2 code file(s)");
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("does not fire when the code change has a non-empty description", () => {
    expect(buildEmptyDescriptionFinding({ changedFiles: [{ path: "src/a.ts" }], description: "Real change." })).toBeNull();
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

  it("counts a substantive changed test file as evidence (no finding)", () => {
    expect(
      buildMissingTestEvidenceFinding({
        changedFiles: [
          { path: "src/api/routes.ts", additions: 20, deletions: 0 },
          { path: "test/api/routes.test.ts", additions: 18, deletions: 0 },
        ],
      }),
    ).toBeNull();
  });

  it("does NOT count an empty/no-op test file as evidence — the finding still fires (#audit-3.1)", () => {
    const finding = buildMissingTestEvidenceFinding({
      changedFiles: [
        { path: "src/api/routes.ts", additions: 20, deletions: 0 },
        { path: "test/noop.test.ts", additions: 1, deletions: 0 }, // empty stub: 1 added line
      ],
    });
    expect(finding).toMatchObject({ code: "missing_test_evidence" });
  });

  it("trusts a test path when per-file line counts are unavailable (no regression on metadata-only inputs)", () => {
    expect(
      buildMissingTestEvidenceFinding({
        changedFiles: [
          { path: "src/api/routes.ts", additions: 20, deletions: 0 },
          { path: "test/api/routes.test.ts" }, // additions undefined → trust the path
        ],
      }),
    ).toBeNull();
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

  it("does not fire for a test-only diff above the churn threshold (regression: test lines are substantive)", () => {
    expect(
      buildTrivialWhitespaceChurnFinding({
        changedFiles: [
          { path: "test/unit/sync.test.ts", additions: 30, deletions: 15 },
          { path: "test/integration/api.test.ts", additions: 10, deletions: 5 },
        ],
      }),
    ).toBeNull();
  });

  it("does not fire when test lines push the substantive share above the threshold", () => {
    expect(
      buildTrivialWhitespaceChurnFinding({
        changedFiles: [
          { path: "README.md", additions: 20, deletions: 15 },
          { path: "test/unit/widget.test.ts", additions: 20, deletions: 10 },
        ],
      }),
    ).toBeNull();
  });

  it("still fires for non-code-only high-churn diffs with zero source and zero test lines", () => {
    expect(
      buildTrivialWhitespaceChurnFinding({
        changedFiles: [
          { path: "README.md", additions: 25, deletions: 20 },
          { path: "docs/guide.md", additions: 20, deletions: 15 },
        ],
      }),
    ).toMatchObject({ code: "trivial_whitespace_churn" });
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

    // Pure scaffolding with no real word survives → flagged as unfilled. The 1s budget guards against
    // catastrophic scanning (the word-run check is a linear scan, no backtracking).
    expect(buildUnfilledIssueTemplateFinding({ body: maliciousBody })).toMatchObject({ code: "unfilled_issue_template" });
  }, 1_000);

  it("a single padding character does NOT defeat the unfilled-template check (#audit-§4)", () => {
    // Template scaffolding + one stray char that survives the punctuation strip — must still be flagged.
    expect(buildUnfilledIssueTemplateFinding({ body: "### Description\n<!-- describe -->\n.\n" })).toMatchObject({ code: "unfilled_issue_template" });
    // A genuine (even terse) description survives — a real 3+ letter word is present.
    expect(buildUnfilledIssueTemplateFinding({ body: "### Description\nThe build fails on save.\n" })).toBeNull();
  });

  it("flags a body that only restates the title, ignoring case and punctuation (#533)", () => {
    const result = buildIssueSlopAssessment({ title: "Login is broken", body: "login is broken!!!" });
    expect(result.findings.map((f) => f.code)).toEqual(["title_only_restatement"]);
    expect(result.slopRisk).toBe(ISSUE_SLOP_WEIGHTS.titleRestatement);
    expect(result.band).toBe("elevated");
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("does NOT flag a body that adds any detail beyond the title", () => {
    // The body repeats the title but adds real detail → not a bare restatement.
    expect(buildIssueSlopAssessment({ title: "Login is broken", body: "Login is broken when the session token has expired." }).findings).toEqual([]);
  });

  it("title-restatement is mutually exclusive with the emptier signals", () => {
    // Empty body → empty_issue_body only (never restatement, which needs a real body).
    expect(buildIssueSlopAssessment({ title: "Login is broken", body: "" }).findings.map((f) => f.code)).toEqual(["empty_issue_body"]);
    // Unfilled template → unfilled_issue_template only (no real word to match the title).
    expect(buildIssueSlopAssessment({ title: "Login is broken", body: "<!-- nothing -->" }).findings.map((f) => f.code)).toEqual([
      "unfilled_issue_template",
    ]);
  });

  it("title-restatement builder guards a missing title or body when called directly", () => {
    // Both sides must normalize to real text; an empty/omitted title or body yields no finding.
    expect(buildTitleRestatementIssueFinding({ title: "", body: "anything" })).toBeNull();
    expect(buildTitleRestatementIssueFinding({ body: "no title here" })).toBeNull();
    expect(buildTitleRestatementIssueFinding({ title: "Only a title" })).toBeNull();
    // A title that is pure punctuation normalizes to empty → no finding even against a matching body.
    expect(buildTitleRestatementIssueFinding({ title: "!!!", body: "???" })).toBeNull();
    // A genuine restatement fires.
    expect(buildTitleRestatementIssueFinding({ title: "Build fails", body: "Build fails." })).toMatchObject({ code: "title_only_restatement" });
  });
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

describe("slop golden fixtures & determinism (#565)", () => {
  const goldenFixtures: Array<{ name: string; input: SlopAssessmentInput; slopRisk: number; band: SlopBand; codes: string[] }> = [
    { name: "clean — no metadata", input: {}, slopRisk: 0, band: "clean", codes: [] },
    { name: "low — generic commit subject", input: { commitMessages: ["wip"] }, slopRisk: 15, band: "low", codes: ["low_quality_commit_message"] },
    { name: "low — no linked issue and no rationale", input: { hasLinkedIssue: false }, slopRisk: 15, band: "low", codes: ["no_linked_issue_without_rationale"] },
    {
      name: "low — code change without test evidence",
      input: { changedFiles: [{ path: "src/svc.ts", additions: 12, deletions: 3 }], description: "Add retry logic to the sync client." },
      slopRisk: 15,
      band: "low",
      codes: ["missing_test_evidence"],
    },
    {
      name: "elevated — untested code change inside a duplicate cluster",
      input: { changedFiles: [{ path: "src/svc.ts", additions: 12, deletions: 3 }], description: "Add retry logic to the sync client.", inDuplicateCluster: true },
      slopRisk: 30,
      band: "elevated",
      codes: ["duplicate_cluster_membership", "missing_test_evidence"],
    },
    {
      name: "high — whitespace churn, untested code, and empty description",
      input: { changedFiles: [{ path: "src/x.ts", additions: 2, deletions: 1 }, { path: "src/state.snap", additions: 60, deletions: 40 }], description: "" },
      slopRisk: 60,
      band: "high",
      codes: ["empty_pr_description", "missing_test_evidence", "trivial_whitespace_churn"],
    },
  ];

  it.each(goldenFixtures)("scores the $name fixture to its documented band", (fixture) => {
    const result = buildSlopAssessment(fixture.input);
    expect(result.slopRisk).toBe(fixture.slopRisk);
    expect(result.band).toBe(fixture.band);
    expect(result.findings.map((finding) => finding.code).sort()).toEqual(fixture.codes);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("returns identical slopRisk and findings for identical metadata (determinism)", () => {
    for (const fixture of goldenFixtures) {
      expect(buildSlopAssessment(fixture.input)).toEqual(buildSlopAssessment(fixture.input));
    }
  });

  it("keeps every fixture score within the clamped 0..100 range (invariant)", () => {
    for (const fixture of goldenFixtures) {
      const { slopRisk } = buildSlopAssessment(fixture.input);
      expect(slopRisk).toBeGreaterThanOrEqual(0);
      expect(slopRisk).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the high golden case (strong-30 + missing-test-15 + empty-desc-15 = 60) blockable at the default threshold (#deweight)", () => {
    // The de-weight must NOT make the high golden case unblockable: trivialWhitespaceChurn (30) +
    // missingTestEvidence (15) + emptyDescription (15) = 60 stays `high` and at/above the default 60 threshold.
    const highFixture = goldenFixtures.find((fixture) => fixture.name.startsWith("high"));
    expect(highFixture).toBeDefined();
    const result = buildSlopAssessment(highFixture!.input);
    expect(result.slopRisk).toBe(60);
    expect(result.band).toBe("high");
    expect(result.slopRisk).toBeGreaterThanOrEqual(DEFAULT_SLOP_BLOCK_THRESHOLD);
    const gate = evaluateGateCheck(cleanAdvisory(), { slopGateMode: "block", slopRisk: result.slopRisk });
    expect(gate.blockers.map((blocker) => blocker.code)).toContain("slop_risk_above_threshold");
  });
});
