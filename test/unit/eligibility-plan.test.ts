// Direct unit coverage for deriveEligibilityPlan (#2092). The scenario tests exercise it end-to-end via
// buildScorePreview; this file builds one real ScorePreviewResult base and overrides the specific nested
// fields to hit every eligibilityStatusKey branch, the eligible computation, blocker filtering, cleanup
// paths, and the linked-issue projection directly and deterministically.
import { describe, expect, it } from "vitest";
import {
  buildScorePreview,
  type ScoreGateBlocker,
  type ScorePreviewInput,
  type ScorePreviewResult,
} from "../../src/scoring/preview";
import { deriveEligibilityPlan } from "../../src/services/eligibility-plan";
import type { ScoringModelSnapshotRecord } from "../../src/types";

const snapshot: ScoringModelSnapshotRecord = {
  id: "eligibility-plan-test-model",
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

function preview(input: Partial<ScorePreviewInput> = {}): ScorePreviewResult {
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

// A real, valid base result (validated linked issue + eligible branch); individual tests override only the
// nested fields deriveEligibilityPlan reads, keeping every fixture type-safe with no casts.
const base = preview({
  linkedIssueMode: "standard",
  linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [42], solvedByPullRequests: [101] },
  branchEligibility: { status: "eligible", source: "github_metadata" },
});

function planFor(o: {
  liStatus: ScorePreviewResult["linkedIssueMultiplier"]["status"];
  liEligible?: boolean;
  brStatus: ScorePreviewResult["branchEligibility"]["status"];
  blockedBy?: ScoreGateBlocker[];
  scenarioPreviews?: ScorePreviewResult["scenarioPreviews"];
}) {
  const result: ScorePreviewResult = {
    ...base,
    linkedIssueMultiplier: { ...base.linkedIssueMultiplier, status: o.liStatus, eligible: o.liEligible ?? false },
    branchEligibility: { ...base.branchEligibility, status: o.brStatus },
    blockedBy: o.blockedBy ?? [],
    scenarioPreviews: o.scenarioPreviews ?? base.scenarioPreviews,
  };
  return deriveEligibilityPlan(result);
}

describe("deriveEligibilityPlan (#2092)", () => {
  it("ineligible branch short-circuits to the ineligible_branch summary, eligible:false", () => {
    const plan = planFor({ liStatus: "validated", liEligible: true, brStatus: "ineligible" });
    expect(plan.eligible).toBe(false);
    expect(plan.branchEligibilityStatus).toBe("ineligible");
    expect(plan.publicSummary).toContain("resolve the branch blocker");
  });

  it("invalid linked issue → invalid_link summary", () => {
    const plan = planFor({ liStatus: "invalid", brStatus: "eligible" });
    expect(plan.eligible).toBe(false);
    expect(plan.publicSummary).toContain("linked issue is invalid");
  });

  for (const status of ["raw", "plausible", "unavailable"] as const) {
    it(`unvalidated linked issue (${status}) → unvalidated_link summary`, () => {
      const plan = planFor({ liStatus: status, brStatus: "eligible" });
      expect(plan.eligible).toBe(false);
      expect(plan.linkedIssueStatus).toBe(status);
      expect(plan.publicSummary).toContain("not yet validated");
    });
  }

  it("no linked issue + non-required branch → not_required summary, no projection", () => {
    const plan = planFor({ liStatus: "not_required", brStatus: "not_required" });
    expect(plan.publicSummary).toContain("not required for this contribution type");
    expect(plan.linkedIssueProjection).toBeNull();
  });

  it("validated link + eligible branch → eligible summary, eligible:true", () => {
    const plan = planFor({ liStatus: "validated", liEligible: true, brStatus: "eligible" });
    expect(plan.eligible).toBe(true);
    expect(plan.publicSummary).toContain("eligible to pursue");
  });

  it("validated link + not_required branch is still eligible (branchConfirmed via not_required)", () => {
    const plan = planFor({ liStatus: "validated", liEligible: true, brStatus: "not_required" });
    expect(plan.eligible).toBe(true);
    expect(plan.publicSummary).toContain("eligible to pursue");
  });

  it("validated link but unknown branch metadata → not eligible, falls through to unvalidated_link", () => {
    const plan = planFor({ liStatus: "validated", liEligible: true, brStatus: "unknown" });
    expect(plan.eligible).toBe(false);
    expect(plan.publicSummary).toContain("not yet validated");
  });

  it("surfaces only the four eligibility blocker codes as public text + cleanup paths, filtering unrelated codes", () => {
    const plan = planFor({
      liStatus: "validated",
      liEligible: true,
      brStatus: "eligible",
      blockedBy: [
        { code: "branch_ineligible", severity: "blocker", detail: "raw branch detail" },
        { code: "branch_eligibility_missing", severity: "blocker", detail: "raw missing detail" },
        { code: "linked_issue_invalid", severity: "blocker", detail: "raw invalid detail" },
        { code: "linked_issue_unvalidated", severity: "blocker", detail: "raw unvalidated detail" },
        { code: "review_penalty", severity: "reducer", detail: "unrelated non-eligibility detail" },
      ],
    });
    expect(plan.blockers).toHaveLength(4);
    const blockers = plan.blockers.join(" | ");
    expect(blockers).toContain("switch to an eligible branch");
    expect(blockers).toContain("eligibility metadata is missing");
    expect(blockers).toContain("verify the issue is open");
    expect(blockers).toContain("solved-by-PR evidence");
    expect(blockers).not.toContain("unrelated");
    const cleanup = plan.cleanupPaths.join(" | ");
    expect(cleanup).toContain("Switch to an eligible branch");
    expect(cleanup).toContain("Refresh branch/base eligibility metadata");
    expect(cleanup).toContain("linked issue is still open");
    expect(cleanup).toContain("wait for the official mirror to sync");
  });

  it("projects the linked-issue benefit when validating the link would enable the multiplier", () => {
    const scenarioPreviews = base.scenarioPreviews.map((s) =>
      s.name === "current"
        ? { ...s, linkedIssueMultiplier: { ...s.linkedIssueMultiplier, eligible: false } }
        : s.name === "linkedIssueFixed"
          ? { ...s, linkedIssueMultiplier: { ...s.linkedIssueMultiplier, eligible: true } }
          : s,
    );
    const plan = planFor({ liStatus: "raw", brStatus: "eligible", scenarioPreviews });
    expect(plan.linkedIssueProjection).toBe(
      "Validating the linked issue would enable the standard linked-issue contribution consideration.",
    );
  });
});
