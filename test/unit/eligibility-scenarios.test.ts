import { describe, expect, it } from "vitest";
import { sanitizePublicComment } from "../../src/github/commands";
import { buildScorePreview, type ScorePreviewInput } from "../../src/scoring/preview";
import { deriveEligibilityPlan } from "../../src/services/eligibility-plan";
import type { ScoringModelSnapshotRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward estimate|raw trust|trust score|scoreability|private reviewability|estimated score|score estimate|farming/i;

const snapshot: ScoringModelSnapshotRecord = {
  id: "eligibility-test-model",
  sourceKind: "test",
  sourceUrl: "fixture://constants.py",
  fetchedAt: "2026-06-03T00:00:00.000Z",
  activeModel: "current_density_model",
  constants: {
    OSS_EMISSION_SHARE: 0.9,
    MERGED_PR_BASE_SCORE: 25,
    MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
    MAX_CODE_DENSITY_MULTIPLIER: 1.15,
    MAX_CONTRIBUTION_BONUS: 25,
    CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
    STANDARD_ISSUE_MULTIPLIER: 1.33,
    MAINTAINER_ISSUE_MULTIPLIER: 1.66,
    MIN_CREDIBILITY: 0.8,
    REVIEW_PENALTY_RATE: 0.15,
    EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
    OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
    MAX_OPEN_PR_THRESHOLD: 30,
    OPEN_PR_COLLATERAL_PERCENT: 0.2,
    SRC_TOK_SATURATION_SCALE: 58,
  },
  programmingLanguages: {},
  registrySnapshotId: "registry-fixture",
  warnings: [],
  payload: {},
};

const repo = {
  fullName: "octo/demo",
  owner: "octo",
  name: "demo",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, maintainerCut: 0, raw: {} },
};

function preview(input: Partial<ScorePreviewInput> = {}) {
  return buildScorePreview({
    repo,
    snapshot,
    input: {
      repoFullName: "octo/demo",
      sourceTokenScore: 60,
      totalTokenScore: 80,
      sourceLines: 50,
      openPrCount: 1,
      credibility: 1,
      metadataOnly: true,
      ...input,
    },
  });
}

// ── Fixture: linked (validated) ────────────────────────────────────────────

describe("eligible branch with validated linked issue", () => {
  const result = preview({
    linkedIssueMode: "standard",
    linkedIssueContext: {
      status: "validated",
      source: "official_mirror",
      issueNumbers: [42],
      solvedByPullRequests: [101],
    },
    branchEligibility: { status: "eligible", source: "github_metadata" },
  });

  it("derives eligible:true when linked issue is validated and branch is eligible", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(true);
    expect(plan.linkedIssueStatus).toBe("validated");
    expect(plan.branchEligibilityStatus).toBe("eligible");
    expect(plan.blockers).toHaveLength(0);
    expect(plan.publicSummary).toMatch(/eligible/i);
  });

  it("emits no eligibility blockers in the underlying score preview result", () => {
    const codes = result.blockedBy.map((b) => b.code);
    expect(codes).not.toContain("linked_issue_invalid");
    expect(codes).not.toContain("linked_issue_unvalidated");
    expect(codes).not.toContain("branch_ineligible");
    expect(codes).not.toContain("branch_eligibility_missing");
  });

  it("plan is free of forbidden public language", () => {
    const plan = deriveEligibilityPlan(result);
    expect(JSON.stringify(plan)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});

// ── Fixture: unlinked (mode:none) ─────────────────────────────────────────

describe("unlinked — no linked issue configured", () => {
  const result = preview({ linkedIssueMode: "none" });

  it("derives eligible:false and not_required status when mode is none", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(false);
    expect(plan.linkedIssueStatus).toBe("not_required");
    expect(plan.branchEligibilityStatus).toBe("not_required");
    expect(plan.blockers).toHaveLength(0);
    expect(plan.cleanupPaths).toHaveLength(0);
    expect(plan.linkedIssueProjection).toBeNull();
  });

  it("public summary reflects unconstrained eligibility without exposing private context", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.publicSummary).toMatch(/not required|not gated|eligibility/i);
    expect(plan.publicSummary).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});

// ── Fixture: closed-link (invalid) ────────────────────────────────────────

describe("closed-link — linked issue is invalid (closed by another PR)", () => {
  const result = preview({
    linkedIssueMode: "standard",
    linkedIssueContext: {
      status: "invalid",
      source: "official_mirror",
      issueNumbers: [99],
      reason: "Issue #99 is already solved by PR #101 from another contributor.",
    },
    branchEligibility: { status: "eligible", source: "github_metadata" },
  });

  it("derives eligible:false and exposes linked_issue_invalid blocker publicly", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(false);
    expect(plan.linkedIssueStatus).toBe("invalid");
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/invalid|already solved|no longer open/i)]),
    );
  });

  it("cleanup path advises checking issue state without exposing private context", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.cleanupPaths.length).toBeGreaterThan(0);
    expect(plan.cleanupPaths.join(" ")).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(plan.cleanupPaths.join(" ")).toMatch(/check|verify|open|closed/i);
  });

  it("underlying score preview emits linked_issue_invalid blocker", () => {
    const codes = result.blockedBy.map((b) => b.code);
    expect(codes).toContain("linked_issue_invalid");
  });

  it("linkedIssueFixed scenario projects what happens if the link is corrected", () => {
    const fixed = result.scenarioPreviews.find((s) => s.name === "linkedIssueFixed");
    expect(fixed).toBeDefined();
    expect(fixed?.linkedIssueMultiplier.eligible).toBe(true);
  });

  it("plan is free of forbidden public language", () => {
    const plan = deriveEligibilityPlan(result);
    expect(JSON.stringify(plan)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});

// ── Fixture: raw/reopened link ─────────────────────────────────────────────

describe("reopened-link — linked issue is raw (unvalidated, needs evidence)", () => {
  const result = preview({
    linkedIssueMode: "standard",
    linkedIssueContext: {
      status: "raw",
      source: "user_supplied",
      issueNumbers: [77],
    },
    branchEligibility: { status: "eligible", source: "github_metadata" },
  });

  it("derives eligible:false and unvalidated status", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(false);
    expect(plan.linkedIssueStatus).toBe("raw");
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/not yet validated|solved-by-PR|validation/i)]),
    );
  });

  it("plan includes a projection when linkedIssueFixed scenario improves eligibility", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.linkedIssueProjection).toBeTruthy();
    expect(plan.linkedIssueProjection).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("underlying score preview emits linked_issue_unvalidated blocker", () => {
    const codes = result.blockedBy.map((b) => b.code);
    expect(codes).toContain("linked_issue_unvalidated");
  });

  it("cleanup path covers unvalidated linked-issue sync guidance", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.cleanupPaths.join(" ")).toMatch(/solved-by-PR evidence|official mirror to sync/i);
  });
});

// ── Fixture: plausible and unavailable link statuses ───────────────────────

describe("plausible link — mirror sees the issue but solved-by-PR is not confirmed", () => {
  const result = preview({
    linkedIssueMode: "standard",
    linkedIssueContext: { status: "plausible", source: "issue_quality", issueNumbers: [88] },
    branchEligibility: { status: "eligible", source: "github_metadata" },
  });

  it("derives eligible:false with unvalidated status and summary", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(false);
    expect(plan.linkedIssueStatus).toBe("plausible");
    expect(plan.publicSummary).toMatch(/not yet validated|validation is needed/i);
  });

  it("plan is free of forbidden public language", () => {
    const plan = deriveEligibilityPlan(result);
    expect(JSON.stringify(plan)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});

describe("unavailable link — mirror/cache data cannot confirm the linked issue", () => {
  const result = preview({
    linkedIssueMode: "standard",
    linkedIssueContext: { status: "unavailable", source: "missing", issueNumbers: [90] },
    branchEligibility: { status: "eligible", source: "github_metadata" },
  });

  it("derives eligible:false with unvalidated status and a blocker", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(false);
    expect(plan.linkedIssueStatus).toBe("unavailable");
    expect(plan.publicSummary).toMatch(/not yet validated|validation is needed/i);
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/not yet validated|solved-by-PR|validation/i)]),
    );
  });
});

// ── Fixture: branch-ineligible ────────────────────────────────────────────

describe("branch-ineligible — branch does not qualify for linked-issue assumptions", () => {
  const result = preview({
    linkedIssueMode: "standard",
    linkedIssueContext: {
      status: "validated",
      source: "official_mirror",
      issueNumbers: [55],
      solvedByPullRequests: [56],
    },
    branchEligibility: { status: "ineligible", source: "github_metadata", reason: "Base branch is not a registered registry branch." },
  });

  it("derives eligible:false even when linked issue is validated", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(false);
    expect(plan.branchEligibilityStatus).toBe("ineligible");
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/branch.*(not eligible|ineligible|eligible branch)/i)]),
    );
  });

  it("cleanup path advises switching to an eligible branch", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.cleanupPaths.join(" ")).toMatch(/eligible branch|linked-issue/i);
  });

  it("underlying score preview emits branch_ineligible blocker", () => {
    const codes = result.blockedBy.map((b) => b.code);
    expect(codes).toContain("branch_ineligible");
  });

  it("plan is free of forbidden public language", () => {
    const plan = deriveEligibilityPlan(result);
    expect(JSON.stringify(plan)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});

// ── Fixture: missing branch eligibility metadata ───────────────────────────

describe("branch-eligibility-missing — metadata not provided", () => {
  const result = preview({
    linkedIssueMode: "standard",
    linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [10], solvedByPullRequests: [] },
    // No branchEligibility supplied → evidence is missing
  });

  it("derives eligible:false and unknown branch status when metadata is absent", () => {
    const plan = deriveEligibilityPlan(result);
    expect(plan.eligible).toBe(false);
    expect(plan.branchEligibilityStatus).toBe("unknown");
    expect(plan.blockers).toEqual(
      expect.arrayContaining([expect.stringMatching(/metadata.*missing|refresh/i)]),
    );
  });

  it("underlying score preview emits branch_eligibility_missing blocker", () => {
    const codes = result.blockedBy.map((b) => b.code);
    expect(codes).toContain("branch_eligibility_missing");
  });

  it("keeps eligibility unconfirmed when the link is validated but branch metadata is missing", () => {
    const validatedLinkMissingBranch = preview({
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [10], solvedByPullRequests: [11] },
    });
    const plan = deriveEligibilityPlan(validatedLinkMissingBranch);
    expect(plan).toMatchObject({
      eligible: false,
      linkedIssueStatus: "validated",
      branchEligibilityStatus: "unknown",
    });
    expect(plan.publicSummary).toMatch(/not yet validated|validation is needed/i);
  });
});

// ── Public/private sanitizer tests ────────────────────────────────────────

describe("public sanitizer tests for eligibility evidence summaries", () => {
  it("all public fields across all fixture cases pass the sanitizePublicComment check", () => {
    const cases = [
      preview({ linkedIssueMode: "none" }),
      preview({ linkedIssueMode: "standard", linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [1] }, branchEligibility: { status: "eligible", source: "github_metadata" } }),
      preview({ linkedIssueMode: "standard", linkedIssueContext: { status: "invalid", source: "official_mirror", issueNumbers: [2] }, branchEligibility: { status: "eligible", source: "github_metadata" } }),
      preview({ linkedIssueMode: "standard", linkedIssueContext: { status: "raw", source: "user_supplied", issueNumbers: [3] }, branchEligibility: { status: "eligible", source: "github_metadata" } }),
      preview({ linkedIssueMode: "standard", linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [4] }, branchEligibility: { status: "ineligible", source: "github_metadata" } }),
    ];
    for (const result of cases) {
      const plan = deriveEligibilityPlan(result);
      const publicText = [...plan.blockers, ...plan.cleanupPaths, plan.publicSummary, plan.linkedIssueProjection ?? ""].join(" ");
      expect(publicText).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
      expect(publicText).toBe(sanitizePublicComment(publicText));
    }
  });

  it("keeps local branch signals fail-closed — no local path or source content leaks", () => {
    const result = preview({
      linkedIssueMode: "standard",
      linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [5] },
      branchEligibility: { status: "eligible", source: "local_metadata", reason: "/Users/dev/.git HEAD ref" },
    });
    const plan = deriveEligibilityPlan(result);
    expect(JSON.stringify(plan)).not.toMatch(/\/Users|\/home|\/tmp|[A-Z]:\\Users/);
  });
});
