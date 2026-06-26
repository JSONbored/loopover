import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SCENARIO_MAX_BRANCH_REF_CHARS, SCENARIO_MAX_LINKED_ISSUE_NUMBERS } from "../../src/scenarios/input-model";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../../src/signals/local-branch";
import { MAX_LOCAL_SCORER_WARNING_CHARS, MAX_LOCAL_SCORER_WARNING_COUNT } from "../../src/signals/local-scorer-diagnostics";
import type { ContributorOutcomeHistory, ContributorProfile, ContributorScoringProfile, IssueQualityReport } from "../../src/signals/engine";
import type { RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

describe("local branch analysis", () => {
  it("combines local preflight, private score preview, reward/risk, and a public-safe PR packet", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
        baseRef: "origin/main",
        headRef: "fix-cache",
        branchName: "fix-cache-reconnect",
        title: "Fix dashboard cache refresh after reconnect",
        body: "Fixes #7",
        labels: ["bug"],
        changedFiles: [
          { path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" },
          { path: "test/cache.test.ts", additions: 30, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed", summary: "cache regression passed" }],
        localScorer: {
          mode: "external_command",
          sourceTokenScore: 48,
          totalTokenScore: 80,
          sourceLines: 46,
          testTokenScore: 30,
        },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Dashboard cache refresh fails after reconnect", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.preflight.status).toBe("ready");
    expect(analysis.preflight.localDiff).toMatchObject({ changedFileCount: 2, codeFileCount: 1, testFileCount: 1, inferredLinkedIssues: [7] });
    expect(analysis.scorePreview.privateOnly).toBe(true);
    expect(analysis.scorePreview.linkedIssueMultiplier).toMatchObject({ status: "unavailable", source: "missing", issueNumbers: [7], appliedMultiplier: 1 });
    expect(analysis.scorePreview.warnings.join(" ")).toMatch(/mirror.*unavailable/i);
    expect(analysis.rewardRisk.rewardUpside.relevantLane).toBe("direct_pr");
    expect(analysis.nextActions.map((action) => action.actionKind)).toContain("open_new_direct_pr");
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source_upload_disabled" })]));
    expect(analysis.workspaceIntelligence.version).toBe(2);
    expect(analysis.workspaceIntelligence.sourceUpload.enabled).toBe(false);
    expect(analysis.workspaceIntelligence.testEvidence.level).toBe("both");
    expect(analysis.workspaceIntelligence.blockers.branchQuality).toEqual(analysis.branchQualityBlockers);
    expect(analysis.workspaceIntelligence.blockers.accountState).toEqual(analysis.accountStateBlockers);
    expect(analysis.prPacket.markdown).toContain("## Branch Freshness");
    expect(analysis.prPacket.markdown).toContain("## Overlap/WIP Check");
    expect(analysis.prPacket.markdown).toContain("- Closes #7");
    expect(analysis.prPacket.markdown).toContain("- passed: npm test -- cache");
    expect(analysis.prPacket.markdown).toContain("metadata only");
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("surfaces a duplicate_risk reducer when the branch collides with a high-risk overlap cluster", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        title: "Fix dashboard cache refresh after reconnect",
        body: "Fixes #7",
        labels: ["bug"],
        changedFiles: [{ path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 48, totalTokenScore: 80, sourceLines: 46 },
      },
      repo,
      // Issue #7 already has two open PRs targeting it -> a high-risk overlap cluster that
      // also overlaps the branch (same dashboard-cache-refresh terms).
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Dashboard cache refresh fails after reconnect", state: "open", labels: ["bug"], linkedPrs: [21, 22] }],
      pullRequests: [
        { repoFullName: repo.fullName, number: 21, title: "Dashboard cache refresh fix after reconnect", state: "open", authorLogin: "other1", authorAssociation: "NONE", labels: ["bug"], linkedIssues: [7], body: "Fixes #7", updatedAt: "2026-05-20T00:00:00.000Z" },
        { repoFullName: repo.fullName, number: 22, title: "Dashboard cache reconnect refresh fix", state: "open", authorLogin: "other2", authorAssociation: "NONE", labels: ["bug"], linkedIssues: [7], body: "Fixes #7", updatedAt: "2026-05-21T00:00:00.000Z" },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    // The duplicate_risk reducer was dead before this fix: duplicateRiskCount had no producer.
    expect(analysis.scorePreview.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "duplicate_risk" })]));
  });

  it("applies the open-issue spam gate from trusted outcome history", () => {
    const issueHeavyHistory: ContributorOutcomeHistory = {
      ...outcomeHistory,
      totals: { ...outcomeHistory.totals, issues: 99, openIssues: 99 },
      repoOutcomes: [{ ...outcomeHistory.repoOutcomes[0]!, issues: 99, openIssues: 99 }],
    };
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        labels: ["enhancement"],
        changedFiles: [{ path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 48, totalTokenScore: 80, sourceLines: 46 },
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory: issueHeavyHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.scorePreview.gates.openIssueCount).toBe(99);
    expect(analysis.scorePreview.scoreEstimate.openIssueMultiplier).toBe(0);
    expect(analysis.scorePreview.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "open_issue_threshold" })]));
  });

  it("threads contributor-history validity gates from outcome history (#808)", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [{ path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 48, totalTokenScore: 80, sourceLines: 46 },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(analysis.scorePreview.gates.mergedPullRequests).toBe(5);
    expect(analysis.scorePreview.gates.validSolvedIssues).toBe(3);
    expect(analysis.scorePreview.gates.issueCredibility).toBe(1);
    expect(analysis.scorePreview.scoreEstimate.mergedHistoryMultiplier).toBe(1);
    expect(analysis.scorePreview.scoreEstimate.issueDiscoveryHistoryMultiplier).toBe(1);
  });

  it("prefers repo-scoped outcome counts over global totals when both are present (#808)", () => {
    const repoScopedHistory: ContributorOutcomeHistory = {
      ...outcomeHistory,
      totals: {
        ...outcomeHistory.totals,
        mergedPullRequests: 5,
        validSolvedIssues: 3,
        issueCredibility: 1,
      },
      repoOutcomes: [
        {
          ...outcomeHistory.repoOutcomes[0]!,
          mergedPullRequests: 1,
          validSolvedIssues: 0,
          issueCredibility: 0.4,
        },
      ],
    };
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [{ path: "src/cache.ts", additions: 42, deletions: 4, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 48, totalTokenScore: 80, sourceLines: 46 },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory: repoScopedHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(analysis.scorePreview.gates.mergedPullRequests).toBe(1);
    expect(analysis.scorePreview.gates.validSolvedIssues).toBe(0);
    expect(analysis.scorePreview.gates.issueCredibility).toBe(0.4);
    expect(analysis.scorePreview.scoreEstimate.mergedHistoryMultiplier).toBe(0);
    expect(analysis.scorePreview.scoreEstimate.issueDiscoveryHistoryMultiplier).toBe(0);
    expect(analysis.accountStateBlockers.join(" ")).toMatch(/Merged PR count|Issue-discovery history/i);
  });

  it("bounds local scorer warnings before adding local findings", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "src/scorer.ts", additions: 10, deletions: 0, status: "modified" }],
        localScorer: {
          mode: "metadata_only",
          warnings: Array.from({ length: MAX_LOCAL_SCORER_WARNING_COUNT + 5 }, (_, index) => `${index}: ${"w".repeat(MAX_LOCAL_SCORER_WARNING_CHARS + 25)}`),
        },
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    const finding = analysis.localFindings.find((entry) => entry.code === "local_scorer_warning");
    expect(finding?.detail.length).toBeLessThanOrEqual(MAX_LOCAL_SCORER_WARNING_COUNT * MAX_LOCAL_SCORER_WARNING_CHARS + (MAX_LOCAL_SCORER_WARNING_COUNT - 1));
    expect(analysis.workspaceIntelligence.localScorerDiagnostics?.warnings).toHaveLength(MAX_LOCAL_SCORER_WARNING_COUNT);
  });

  it("projects a blocked local branch into a useful after-pending-merge scenario", () => {
    const pressuredHistory: ContributorOutcomeHistory = {
      ...outcomeHistory,
      totals: { ...outcomeHistory.totals, openPullRequests: 3, credibility: 0 },
      repoOutcomes: [
        {
          ...outcomeHistory.repoOutcomes[0]!,
          openPullRequests: 3,
          credibility: 0,
          closedPullRequestRate: 0,
          closedPullRequests: 0,
        },
      ],
    };
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "upstream/main",
        branchName: "fix-15233-entity-model",
        body: "Fixes #15233",
        changedFiles: [
          { path: "internal/entity/model.go", additions: 30, deletions: 4, status: "modified" },
          { path: "internal/entity/model_test.go", additions: 44, deletions: 0, status: "modified" },
          { path: "internal/service/entity.go", additions: 12, deletions: 2, status: "modified" },
          { path: "docs/entity.md", additions: 8, deletions: 1, status: "modified" },
        ],
        validation: [{ command: "go test ./internal/entity ./internal/service", status: "passed", summary: "focused Go tests passed" }],
        pendingMergedPrCount: 3,
        projectedCredibility: 0.8,
        scenarioNotes: ["three approved PRs are expected to merge"],
        localScorer: {
          mode: "external_command",
          sourceTokenScore: 60,
          totalTokenScore: 100,
          sourceLines: 80,
          testTokenScore: 44,
        },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 15233, title: "Entity model edge case", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory: pressuredHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.preflight.localDiff).toMatchObject({ changedFileCount: 4, testFileCount: 1, codeFileCount: 2, inferredLinkedIssues: [15233] });
    expect(analysis.scorePreview.effectiveEstimatedScore).toBe(0);
    expect(analysis.scorePreview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(analysis.scenarioScorePreview.afterPendingMerges?.source).toBe("user_supplied");
    expect(analysis.scenarioScorePreview.afterPendingMerges?.effectiveEstimatedScore).toBeGreaterThan(0);
    expect(analysis.accountStateBlockers.join(" ")).toMatch(/Open PR count|Credibility/i);
    expect(analysis.branchQualityBlockers.join(" ")).not.toMatch(/test/i);
    expect(analysis.recommendedRerunCondition).toMatch(/pending PRs merge\/close|open PR count/i);
    expect(analysis.nextActions[0]?.whyThisHelps.join(" ")).toMatch(/waiting for pending PRs/i);
  });

  it("threads issue-quality warnings into local preflight and public-safe next steps", () => {
    const issueQuality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: new Date().toISOString(),
      lane: { repoFullName: repo.fullName, lane: "direct_pr", issueDiscoveryShare: 0, directPrShare: 0.04, summary: "Direct PR lane", contributorGuidance: "", maintainerGuidance: "" },
      issues: [
        {
          number: 7,
          title: "Cache refresh fails",
          lifecycle: "valid_solved",
          status: "do_not_use",
          score: 0,
          reasons: [],
          warnings: ["1 merged PR(s) already reference this issue."],
        },
      ],
      summary: "1 open issue evaluated.",
    };
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" },
          { path: "src/cache.test.ts", additions: 20, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
      issueQuality,
    });

    expect(analysis.preflight.status).toBe("needs_work");
    expect(analysis.preflight.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "issue_quality_do_not_use" })]));
    expect(analysis.scorePreview.linkedIssueMultiplier).toMatchObject({ status: "invalid", source: "github_cache", eligible: false, appliedMultiplier: 1 });
    expect(analysis.branchQualityBlockers).toEqual(expect.arrayContaining(["Linked issue is already covered or duplicate-prone"]));
    expect(analysis.prPacket.markdown).toContain("Confirm the linked issue is still actionable");
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("prefers official mirror solved_by_pr linkage for private score previews without leaking multiplier language publicly", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
        localScorer: { mode: "external_command", sourceTokenScore: 42, totalTokenScore: 70, sourceLines: 42 },
        branchEligibility: { status: "eligible", source: "github_metadata" },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
      issueQuality: {
        repoFullName: repo.fullName,
        generatedAt: new Date().toISOString(),
        lane: { repoFullName: repo.fullName, lane: "direct_pr", issueDiscoveryShare: 0, directPrShare: 0.04, summary: "Direct PR lane", contributorGuidance: "", maintainerGuidance: "" },
        issues: [{ number: 7, title: "Cache refresh fails", linkage: { status: "raw", source: "github_cache", solvedByPullRequests: [], reason: "raw", warnings: [] }, status: "ready", score: 80, reasons: [], warnings: [] }],
        summary: "1 issue evaluated.",
      },
      gittensorSnapshot: {
        issueMirrorAvailable: true,
        issues: [{ repoFullName: repo.fullName, number: 7, state: "closed", solvedByPullRequest: 144, labels: ["bug"] }],
      } as never,
    });

    expect(analysis.scorePreview.linkedIssueMultiplier).toMatchObject({ status: "validated", source: "official_mirror", solvedByPullRequests: [144], appliedMultiplier: 1.33 });
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/multiplier|reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("separates branch eligibility from account blockers in local branch analysis", () => {
    const commonInput = {
      login: "oktofeesh1",
      repoFullName: repo.fullName,
      body: "Fixes #7",
      changedFiles: [
        { path: "src/cache.ts", additions: 24, deletions: 2, status: "modified" as const },
        { path: "src/cache.test.ts", additions: 18, deletions: 0, status: "added" as const },
      ],
      validation: [{ command: "npm test -- cache", status: "passed" as const }],
      localScorer: { mode: "external_command" as const, sourceTokenScore: 40, totalTokenScore: 70, sourceLines: 38, testTokenScore: 18 },
    };
    const commonArgs = {
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open" as const, labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
      gittensorSnapshot: {
        issueMirrorAvailable: true,
        issues: [{ repoFullName: repo.fullName, number: 7, state: "closed", solvedByPullRequest: 144, labels: ["bug"] }],
      } as never,
    };
    const eligible = buildLocalBranchAnalysis({
      input: {
        ...commonInput,
        branchEligibility: { status: "eligible", source: "github_metadata", checkedAt: "2026-05-30T00:00:00.000Z" },
      },
      ...commonArgs,
    });
    const ineligible = buildLocalBranchAnalysis({
      input: {
        ...commonInput,
        branchEligibility: { status: "ineligible", source: "github_metadata", reason: "base branch is not eligible" },
      },
      ...commonArgs,
    });
    const missing = buildLocalBranchAnalysis({
      input: commonInput,
      ...commonArgs,
    });
    const stale = buildLocalBranchAnalysis({
      input: {
        ...commonInput,
        branchEligibility: { status: "eligible", source: "local_metadata", stale: true, checkedAt: "2026-05-01T00:00:00.000Z" },
      },
      ...commonArgs,
    });

    expect(eligible.branchEligibility).toMatchObject({ status: "eligible", evidence: "provided" });
    expect(eligible.scorePreview.scoreEstimate.issueMultiplier).toBe(1.33);
    expect(eligible.branchQualityBlockers.join(" ")).not.toMatch(/eligibility/i);
    expect(eligible.prPacket.markdown).toContain("Linked issue context was checked");
    expect(ineligible.scorePreview.scoreEstimate.issueMultiplier).toBe(1);
    expect(ineligible.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch_eligibility_ineligible" })]));
    expect(ineligible.branchQualityBlockers).toEqual(expect.arrayContaining(["Branch eligibility blocks linked-issue assumptions"]));
    expect(ineligible.accountStateBlockers.join(" ")).not.toMatch(/eligibility/i);
    expect(ineligible.recommendedRerunCondition).toMatch(/eligibility/i);
    expect(ineligible.prPacket.markdown).toContain("Linked issue context needs cleanup");
    expect(missing.branchEligibility).toMatchObject({ status: "unknown", evidence: "missing" });
    expect(missing.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch_eligibility_missing", severity: "info" })]));
    expect(missing.branchQualityBlockers.join(" ")).not.toMatch(/Branch eligibility evidence missing/i);
    expect(stale.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch_eligibility_stale", severity: "warning" })]));
    expect(stale.recommendedRerunCondition).toMatch(/branch\/base eligibility metadata/i);
    expect(stale.prPacket.markdown).toContain("Reconfirm linked issue and base branch metadata");
    expect(stale.prPacket.markdown).not.toMatch(/eligibility|issue multiplier|scoreability/i);
    expect(JSON.stringify({ eligible: eligible.prPacket, ineligible: ineligible.prPacket, missing: missing.prPacket, stale: stale.prPacket })).not.toMatch(
      /eligibility|issue multiplier|scoreability|reward|score|wallet|hotkey|farming|payout|ranking|trust score/i,
    );
  });

  it("surfaces mirror raw, invalid, and unavailable linkage fallbacks privately", () => {
    const baseInput = {
      login: "oktofeesh1",
      repoFullName: repo.fullName,
      linkedIssues: [7, 8],
      changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" as const }],
      validation: [{ command: "npm test -- cache", status: "passed" as const }],
      localScorer: { mode: "external_command" as const, sourceTokenScore: 42, totalTokenScore: 70, sourceLines: 42 },
    };
    const baseArgs = {
      repo,
      issues: [
        { repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] },
        { repoFullName: repo.fullName, number: 8, title: "Cache refresh also fails", state: "open", labels: ["bug"], linkedPrs: [] },
      ],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    };

    const mirrorRaw = buildLocalBranchAnalysis({
      input: baseInput,
      ...baseArgs,
      gittensorSnapshot: {
        issueMirrorAvailable: true,
        issues: [{ repoFullName: repo.fullName, number: 7, state: "open", solvedByPullRequest: null, labels: ["bug"] }],
      } as never,
    });
    const mirrorInvalid = buildLocalBranchAnalysis({
      input: { ...baseInput, linkedIssues: [7] },
      ...baseArgs,
      gittensorSnapshot: {
        issueMirrorAvailable: true,
        issues: [{ repoFullName: repo.fullName, number: 7, state: "closed", solvedByPullRequest: null, labels: ["bug"] }],
      } as never,
    });
    const mirrorUnavailableWithPlausibleCache = buildLocalBranchAnalysis({
      input: { ...baseInput, linkedIssues: [7, 8] },
      ...baseArgs,
      issueQuality: {
        repoFullName: repo.fullName,
        generatedAt: new Date().toISOString(),
        lane: { repoFullName: repo.fullName, lane: "direct_pr", issueDiscoveryShare: 0, directPrShare: 0.04, summary: "Direct PR lane", contributorGuidance: "", maintainerGuidance: "" },
        issues: [
          {
            number: 7,
            title: "Cache refresh fails",
            linkage: { status: "plausible", source: "github_cache", solvedByPullRequests: [], reason: "active PR context", warnings: ["not solved yet"] },
            status: "ready",
            score: 80,
            reasons: [],
            warnings: [],
          },
        ],
        summary: "1 issue evaluated.",
      },
      gittensorSnapshot: { issueMirrorAvailable: false, issues: [] } as never,
    });

    expect(mirrorRaw.scorePreview.linkedIssueMultiplier).toMatchObject({ status: "raw", source: "official_mirror", issueNumbers: [7, 8], appliedMultiplier: 1 });
    expect(mirrorRaw.scorePreview.linkedIssueMultiplier.warnings.join(" ")).toMatch(/did not include linked issue.*#8/i);
    expect(mirrorInvalid.scorePreview.linkedIssueMultiplier).toMatchObject({ status: "invalid", source: "official_mirror", appliedMultiplier: 1 });
    expect(mirrorInvalid.scorePreview.linkedIssueMultiplier.reason).toMatch(/closed linked issue/i);
    expect(mirrorUnavailableWithPlausibleCache.scorePreview.linkedIssueMultiplier).toMatchObject({ status: "plausible", source: "github_cache", appliedMultiplier: 1 });
    expect(mirrorUnavailableWithPlausibleCache.scorePreview.linkedIssueMultiplier.warnings.join(" ")).toMatch(/mirror issue data is unavailable.*did not include linked issue.*#8/i);
  });

  it("derives observed pending PR scenarios from cached GitHub PR state", () => {
    const otherRepo: RepositoryRecord = { ...repo, fullName: "we-promise/sure", owner: "we-promise", name: "sure" };
    const pressuredHistory: ContributorOutcomeHistory = {
      ...outcomeHistory,
      totals: { ...outcomeHistory.totals, openPullRequests: 6, credibility: 0.2 },
      repoOutcomes: [{ ...outcomeHistory.repoOutcomes[0]!, openPullRequests: 6, credibility: 0.2, closedPullRequestRate: 0 }],
    };
    const basePr = {
      authorLogin: "oktofeesh1",
      authorAssociation: "CONTRIBUTOR",
      labels: ["bug"],
      linkedIssues: [7],
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2999-01-01T00:00:00.000Z",
    };
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" },
          { path: "src/cache.test.ts", additions: 20, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
        localScorer: { mode: "external_command", sourceTokenScore: 42, totalTokenScore: 70, sourceLines: 42, testTokenScore: 20 },
      },
      repo,
      repositories: [repo, otherRepo],
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache edge", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      contributorPullRequests: [
        { ...basePr, repoFullName: repo.fullName, number: 1, title: "Approved cache fix", state: "open", reviewDecision: "APPROVED" },
        { ...basePr, repoFullName: otherRepo.fullName, number: 2, title: "Draft branch", state: "open", isDraft: true },
        { ...basePr, repoFullName: otherRepo.fullName, number: 3, title: "Needs changes", state: "open", reviewDecision: "CHANGES_REQUESTED" },
        { ...basePr, repoFullName: otherRepo.fullName, number: 4, title: "Stale branch", state: "open", updatedAt: "2020-01-01T00:00:00.000Z" },
        { ...basePr, repoFullName: otherRepo.fullName, number: 5, title: "Closed branch", state: "closed" },
        { ...basePr, repoFullName: otherRepo.fullName, number: 8, title: "Already merged branch", state: "closed", mergedAt: "2026-05-20T00:00:00.000Z" },
        { ...basePr, repoFullName: repo.fullName, number: 6, title: "Maintainer lane", state: "open", authorAssociation: "OWNER" },
        { ...basePr, repoFullName: repo.fullName, number: 7, title: "Someone else's approved PR", state: "open", authorLogin: "someone-else", reviewDecision: "APPROVED" },
        // Both changes-requested AND stale: an actionable block takes precedence over age, so this
        // must count as blocked (open-PR pressure stays), not stale (subtracted from projections).
        { ...basePr, repoFullName: otherRepo.fullName, number: 9, title: "Blocked and stale", state: "open", reviewDecision: "CHANGES_REQUESTED", updatedAt: "2020-01-01T00:00:00.000Z" },
      ],
      profile,
      outcomeHistory: pressuredHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.observedPullRequestScenarios).toMatchObject({ approvedOrMergeable: 1, stale: 1, closed: 1, draft: 1, blocked: 2, maintainerLane: 1 });
    expect(analysis.scenarioScorePreview.afterApprovedPrsMerge).toMatchObject({ source: "github_observed", gates: { openPrCount: 5, credibilityObserved: 0.8 } });
    expect(analysis.scenarioScorePreview.afterStalePrsClose).toMatchObject({ source: "github_observed", gates: { openPrCount: 5, credibilityObserved: 0.2 } });
    expect(analysis.scenarioScorePreview.afterStalePrsClose?.assumptions.join(" ")).toMatch(/already-closed PR.*excluded/);
    expect(analysis.scenarioScorePreview.afterApprovedPrsMerge?.assumptions.join(" ")).toMatch(/draft PR.*excluded|blocked PR.*excluded|maintainer-lane PR.*outside-contributor/);
    expect(analysis.scorePreview.effectiveEstimatedScore).toBe(0);
    expect(analysis.scorePreview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("falls back to same-repo observed PR scenarios when the registered repo list is unavailable", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
        localScorer: { mode: "external_command", sourceTokenScore: 42, totalTokenScore: 60, sourceLines: 42 },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache edge", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      contributorPullRequests: [
        {
          repoFullName: repo.fullName,
          number: 1,
          title: "Mergeable same-repo branch",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          mergeableState: "CLEAN",
          labels: [],
          linkedIssues: [],
        },
        {
          repoFullName: "we-promise/sure",
          number: 2,
          title: "Out-of-scope branch",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          reviewDecision: "APPROVED",
          labels: [],
          linkedIssues: [],
        },
      ],
      profile,
      outcomeHistory: { ...outcomeHistory, totals: { ...outcomeHistory.totals, openPullRequests: 2 } },
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.observedPullRequestScenarios.approvedOrMergeable).toBe(1);
    expect(analysis.scenarioScorePreview.afterApprovedPrsMerge?.gates.openPrCount).toBe(1);
  });

  it("binds cached GitHub PR status to the current branch", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "fix-cache",
        headSha: "head-sha",
        body: "Fixes #7",
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" },
          { path: "src/cache.test.ts", additions: 20, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache edge", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [
        {
          repoFullName: repo.fullName,
          number: 14,
          title: "Cache branch",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          headSha: "head-sha",
          headRef: "fix-cache",
          mergeableState: "UNSTABLE",
          labels: ["bug"],
          linkedIssues: [7],
        },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.githubBranchStatus).toMatchObject({ status: "failing_checks", pullNumber: 14 });
    expect(analysis.branchQualityBlockers).toContain("GitHub checks need attention");
    expect(analysis.prPacket.markdown).toContain("## GitHub Status");
    expect(analysis.prPacket.markdown).toContain("PR #14");
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("feeds approved current-branch PRs into private pending scenarios", () => {
    const approvedPr = {
      repoFullName: repo.fullName,
      number: 15,
      title: "Approved cache branch",
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "CONTRIBUTOR",
      headRef: "fix-cache-approved",
      reviewDecision: "APPROVED",
      labels: ["bug"],
      linkedIssues: [7],
    };
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "fix-cache-approved",
        body: "Fixes #7",
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" },
          { path: "src/cache.test.ts", additions: 20, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache edge", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [approvedPr],
      contributorPullRequests: [approvedPr],
      profile,
      outcomeHistory: { ...outcomeHistory, totals: { ...outcomeHistory.totals, openPullRequests: 1, credibility: 0.2 } },
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.githubBranchStatus).toMatchObject({ status: "approved", pullNumber: 15 });
    expect(analysis.observedPullRequestScenarios.approvedOrMergeable).toBe(1);
    expect(analysis.scenarioScorePreview.afterApprovedPrsMerge).toMatchObject({ source: "github_observed", gates: { openPrCount: 0 } });
    expect(analysis.scenarioScorePreview.afterApprovedPrsMerge?.gates.credibilityObserved).toBeGreaterThanOrEqual(0.8);
  });

  it("prioritizes requested changes, draft state, and contributor ownership for current-branch status", () => {
    const basePr = {
      repoFullName: repo.fullName,
      state: "open",
      authorAssociation: "CONTRIBUTOR",
      headRef: "fix-cache",
      labels: ["bug"],
      linkedIssues: [7],
    };
    const changesRequested = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "fix-cache",
        headSha: "shared-sha",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [],
      pullRequests: [
        { ...basePr, number: 19, title: "Wrong contributor same SHA", authorLogin: "other", headSha: "shared-sha", reviewDecision: "APPROVED", mergeableState: "CLEAN" },
        { ...basePr, number: 20, title: "Wrong contributor same branch", authorLogin: "other", reviewDecision: "APPROVED", mergeableState: "CLEAN" },
        { ...basePr, number: 21, title: "Needs author", authorLogin: "oktofeesh1", headSha: "shared-sha", reviewDecision: "CHANGES_REQUESTED", mergeableState: "CLEAN" },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(changesRequested.githubBranchStatus).toMatchObject({ status: "needs_author", pullNumber: 21 });
    expect(changesRequested.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "github_status_needs_work" })]));

    const draft = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "draft-cache",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [],
      pullRequests: [{ ...basePr, number: 22, title: "Draft clean branch", authorLogin: "oktofeesh1", headRef: "draft-cache", reviewDecision: "APPROVED", mergeableState: "CLEAN", isDraft: true }],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(draft.githubBranchStatus).toMatchObject({ status: "pending_review", pullNumber: 22 });
    expect(draft.githubBranchStatus.notes.join(" ")).toMatch(/draft/i);
  });

  it("requires base-ref matches and check summaries before approving current-branch status", () => {
    const basePr = {
      repoFullName: repo.fullName,
      state: "open",
      authorLogin: "oktofeesh1",
      authorAssociation: "CONTRIBUTOR",
      headSha: "shared-sha",
      headRef: "fix-cache",
      reviewDecision: "APPROVED",
      mergeableState: "CLEAN",
      labels: ["bug"],
      linkedIssues: [7],
    };
    const failingChecks = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        branchName: "fix-cache",
        headSha: "shared-sha",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [],
      pullRequests: [
        { ...basePr, number: 23, title: "Release branch status", baseRef: "release/1.0" },
        { ...basePr, number: 24, title: "Main branch status", baseRef: "main" },
      ],
      checkSummaries: [
        {
          id: "check-24",
          repoFullName: repo.fullName,
          pullNumber: 24,
          headSha: "shared-sha",
          name: "validate",
          status: "completed",
          conclusion: "failure",
          payload: {},
        },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(failingChecks.githubBranchStatus).toMatchObject({ status: "failing_checks", pullNumber: 24 });
    expect(failingChecks.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "github_status_needs_work" })]));

    const pendingChecks = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        branchName: "fix-cache",
        headSha: "shared-sha",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [],
      pullRequests: [{ ...basePr, number: 26, title: "Main branch status", baseRef: "main" }],
      checkSummaries: [
        {
          id: "check-26",
          repoFullName: repo.fullName,
          pullNumber: 26,
          headSha: "shared-sha",
          name: "validate",
          status: "in_progress",
          payload: {},
        },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(pendingChecks.githubBranchStatus).toMatchObject({ status: "pending_review", pullNumber: 26 });

    const behind = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "refs/remotes/origin/main",
        branchName: "fix-cache",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [],
      pullRequests: [{ ...basePr, number: 25, title: "Behind branch", baseRef: "refs/heads/main", headSha: undefined, mergeableState: "BEHIND" }],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(behind.githubBranchStatus).toMatchObject({ status: "needs_author", pullNumber: 25 });
    expect(behind.githubBranchStatus.notes.join(" ")).toMatch(/behind/i);
  });

  it("does not apply another open PR's check summary just because the head SHA matches", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "main",
        branchName: "shared-head",
        headSha: "shared-sha",
        changedFiles: [{ path: "src/checks.ts", additions: 10, deletions: 0, status: "modified" }],
      },
      repo,
      issues: [],
      pullRequests: [
        {
          repoFullName: repo.fullName,
          number: 31,
          title: "Current branch",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          headSha: "shared-sha",
          headRef: "shared-head",
          baseRef: "main",
          reviewDecision: "APPROVED",
          mergeableState: "CLEAN",
          labels: [],
          linkedIssues: [],
        },
        {
          repoFullName: repo.fullName,
          number: 32,
          title: "Other base with same SHA",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          headSha: "shared-sha",
          headRef: "shared-head",
          baseRef: "release/1.0",
          reviewDecision: "APPROVED",
          mergeableState: "CLEAN",
          labels: [],
          linkedIssues: [],
        },
      ],
      checkSummaries: [
        {
          id: "check-32",
          repoFullName: repo.fullName,
          pullNumber: 32,
          headSha: "shared-sha",
          name: "validate",
          status: "completed",
          conclusion: "failure",
          payload: {},
        },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.githubBranchStatus).toMatchObject({ status: "approved", pullNumber: 31 });
  });

  it("matches current-branch checks by head SHA when GitHub omits pull numbers", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "shared-head",
        headSha: "head-only-sha",
        changedFiles: [{ path: "src/checks.ts", additions: 10, deletions: 0, status: "modified" }],
      },
      repo,
      issues: [],
      pullRequests: [
        {
          repoFullName: repo.fullName,
          number: 44,
          title: "Current branch",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          headSha: "head-only-sha",
          headRef: "shared-head",
          labels: [],
          linkedIssues: [],
        },
      ],
      checkSummaries: [
        {
          id: "check-head-only",
          repoFullName: repo.fullName,
          headSha: "head-only-sha",
          name: "validate",
          status: "completed",
          conclusion: "failure",
          payload: {},
        },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.githubBranchStatus).toMatchObject({ status: "failing_checks", pullNumber: 44 });
  });

  it("selects only the current branch PR before status checks are loaded", () => {
    const pullRequests = [
      {
        repoFullName: repo.fullName,
        number: 40,
        title: "Closed old branch",
        state: "closed",
        authorLogin: "oktofeesh1",
        headRef: "fix-cache",
        baseRef: "main",
        labels: [],
        linkedIssues: [],
      },
      {
        repoFullName: repo.fullName,
        number: 41,
        title: "Wrong contributor",
        state: "open",
        authorLogin: "other",
        headRef: "fix-cache",
        baseRef: "main",
        labels: [],
        linkedIssues: [],
      },
      {
        repoFullName: repo.fullName,
        number: 42,
        title: "Current branch",
        state: "open",
        authorLogin: "oktofeesh1",
        headRef: "fix-cache",
        baseRef: "main",
        labels: [],
        linkedIssues: [],
      },
      {
        repoFullName: repo.fullName,
        number: 43,
        title: "Other base",
        state: "open",
        authorLogin: "oktofeesh1",
        headRef: "fix-cache",
        baseRef: "release/1.0",
        labels: [],
        linkedIssues: [],
      },
    ];

    expect(
      findCurrentBranchPullRequest(
        {
          login: "oktofeesh1",
          repoFullName: repo.fullName,
          baseRef: "refs/remotes/origin/main",
          branchName: "fix-cache",
        },
        pullRequests,
      ),
    ).toMatchObject({ number: 42 });
    expect(
      findCurrentBranchPullRequest(
        {
          login: "oktofeesh1",
          repoFullName: repo.fullName,
          baseRef: "main",
          branchName: "missing-branch",
        },
        pullRequests,
      ),
    ).toBeUndefined();
  });

  it("falls back cleanly when no current-branch PR or complete status is cached", () => {
    const noPr = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "local-only",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(noPr.githubBranchStatus.status).toBe("no_pr");
    expect(noPr.branchQualityBlockers.join(" ")).not.toMatch(/GitHub/i);

    const unknown = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "unknown-status",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [],
      pullRequests: [
        {
          repoFullName: repo.fullName,
          number: 16,
          title: "Unknown status",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          headRef: "unknown-status",
          mergeableState: "UNKNOWN",
          labels: [],
          linkedIssues: [],
        },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(unknown.githubBranchStatus).toMatchObject({ status: "unknown", pullNumber: 16 });
    expect(unknown.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "github_status_unknown" })]));
  });

  it("classifies stale base state and treats passed validation as test evidence", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        baseSha: "old-base",
        headSha: "head",
        mergeBaseSha: "old-base",
        remoteTrackingSha: "new-base",
        body: "Fixes #7",
        changedFiles: [{ path: "internal/entity/model.go", additions: 10, deletions: 2, status: "modified" }],
        validation: [{ command: "go test ./internal/entity", status: "passed", summary: "focused regression passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Entity model edge case", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.baseFreshness.status).toBe("stale");
    expect(analysis.baseFreshness.warnings.join(" ")).toMatch(/behind remote tracking SHA/i);
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "stale_base_ref" })]));
    expect(analysis.prPacket.markdown).toContain("## Branch Freshness");
    expect(analysis.prPacket.markdown).toMatch(/Base freshness: stale|git fetch origin/i);
    expect(analysis.preflight.findings.map((finding) => finding.code)).not.toContain("missing_test_evidence");
    expect(analysis.preflight.findings.map((finding) => finding.code)).not.toContain("local_diff_missing_tests");
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "validation_as_test_evidence" })]));
    expect(analysis.workspaceIntelligence.testEvidence.level).toBe("validation_commands");
    expect(analysis.recommendedRerunCondition).toMatch(/git fetch origin/i);
  });

  it("treats focused validation as evidence and failed validation as actionable", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [{ path: "internal/entity/model.go", additions: 10, deletions: 2, status: "modified" }],
        validation: [
          { command: "go test ./internal/entity", status: "focused", durationMs: 1240, exitCode: 0, summary: "focused regression passed" },
          { command: "npm run lint", status: "failed", durationMs: 2000, exitCode: 1, summary: "raw_trust=0.4 /Users/example/log.txt" },
          { command: "npm run e2e", status: "skipped", summary: "not relevant for this fixture" },
        ],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Entity model edge case", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.validationSummary).toMatchObject({ passed: 1, failed: 1, notRun: 1 });
    expect(analysis.preflight.findings.map((finding) => finding.code)).not.toContain("missing_test_evidence");
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "failed_local_validation" })]));
    expect(analysis.prPacket.markdown).toContain("- focused: go test ./internal/entity [1240ms] (focused regression passed)");
    expect(analysis.prPacket.markdown).not.toMatch(/raw_trust|\/Users\/example/i);
  });

  it("includes public-safe overlap caution and hides local absolute paths", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [
          { path: "/Users/example/work/src/cache.ts", previousPath: "src/cache-old.ts", additions: 12, deletions: 2, status: "renamed" },
          { path: "test/cache.test.ts", additions: 20, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [12] }],
      pullRequests: [
        {
          repoFullName: repo.fullName,
          number: 12,
          title: "Fix cache refresh",
          state: "open",
          authorLogin: "someone-else",
          authorAssociation: "CONTRIBUTOR",
          labels: ["bug"],
          linkedIssues: [7],
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.preflight.status).toBe("needs_work");
    expect(analysis.prPacket.markdown).toContain("Possible overlap or WIP");
    expect(analysis.prPacket.markdown).toContain("PR #12");
    expect(analysis.prPacket.markdown).toContain("[local path hidden]");
    expect(analysis.prPacket.markdown).not.toContain("/Users/example");
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score|\/Users\/example/i);
  });

  it("removes Windows home paths from public PR packet title and validation lines", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        title: "Fix cache failure from C:\\Users\\alice\\workspace",
        body: "Fixes #7",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 2, status: "modified" }],
        validation: [
          { command: "npm test C:\\Users\\alice\\workspace\\cache.log", status: "passed", summary: "log at C:\\Users\\alice\\workspace\\cache.log" },
        ],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.markdown).toContain("## Validation");
    expect(analysis.prPacket.markdown).not.toMatch(/C:\\Users\\alice/i);
  });

  it("hides root-user home paths from public PR packet changed paths", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [{ path: "/root/work/src/cache.ts", additions: 12, deletions: 2, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.markdown).toContain("## Changed Paths");
    expect(analysis.prPacket.markdown).toContain("[local path hidden]");
    expect(analysis.prPacket.markdown).not.toContain("/root/work");
  });

  it("removes snake_case private signals from public PR packet markdown", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [{ path: "src/cache.ts", additions: 12, deletions: 2, status: "modified" }],
        validation: [{ command: "npm test", status: "passed", summary: "raw_trust=0.72 private_reviewability=ready trust_score=0.40" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh fails", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.markdown).toContain("## Validation");
    expect(analysis.prPacket.markdown).not.toMatch(/raw_trust|private_reviewability|trust_score/i);
  });

  it("distinguishes fresh, merge-base-stale, and large unverified base states", () => {
    const fresh = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        baseSha: "base",
        remoteTrackingSha: "base",
        branchName: "docs-polish",
        body: "Fixes #7",
        changedFiles: [{ path: "README.md", additions: 1, deletions: 0, status: "modified" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Docs polish", state: "open", labels: [], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(fresh.baseFreshness.status).toBe("fresh");
    expect(fresh.recommendedRerunCondition).toBe("Rerun after any branch, base, or PR state changes before opening/submitting.");

    const mergeBaseStale = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        baseRef: "origin/main",
        baseSha: "base",
        mergeBaseSha: "older-base",
        remoteTrackingSha: "base",
        changedFiles: [{ path: "src/cache.ts", additions: 2, deletions: 1, status: "modified" }],
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(mergeBaseStale.baseFreshness.status).toBe("stale");
    expect(mergeBaseStale.baseFreshness.warnings.join(" ")).toMatch(/Merge-base does not match/i);

    const largeUnverified = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: Array.from({ length: 50 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: Number.NaN, deletions: undefined, status: "modified" as const })),
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });
    expect(largeUnverified.baseFreshness.status).toBe("possibly_stale");
    expect(largeUnverified.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "stale_base_ref" })]));
    expect(largeUnverified.preflight.localDiff.changedLineCount).toBe(0);
  });

  it("keeps unregistered gittensory work in product/maintainer context instead of miner target context", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "jsonbored",
        repoFullName: "JSONbored/gittensory",
        branchName: "miner-mcp-upgrade",
        changedFiles: [{ path: "src/api/routes.ts", additions: 90, deletions: 2, status: "modified" }],
        validation: [{ command: "npm run test:ci", status: "not_run" }],
      },
      repo: null,
      issues: [],
      pullRequests: [],
      profile: { ...profile, login: "jsonbored" },
      outcomeHistory: { ...outcomeHistory, login: "jsonbored", repoOutcomes: [] },
      scoringSnapshot,
    });

    expect(analysis.lane.lane).toBe("unknown");
    expect(analysis.scoreBlockers).toEqual(expect.arrayContaining(["Repository is not registered in the local snapshot."]));
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "gittensory_not_registered" })]));
    expect(analysis.rewardRisk.rewardUpside.relevantLane).toBe("maintainer_lane");
    expect(analysis.rewardRisk.scoreBlockers).toEqual(expect.arrayContaining(["Maintainer-lane work is not normal outside-contributor reward evidence."]));
  });

  it("separates account maturity blockers from clean branch metadata when no pending scenario is supplied", () => {
    const pressuredHistory: ContributorOutcomeHistory = {
      ...outcomeHistory,
      totals: { ...outcomeHistory.totals, openPullRequests: 4, credibility: 0.2 },
      repoOutcomes: [{ ...outcomeHistory.repoOutcomes[0]!, openPullRequests: 4, credibility: 0.2, closedPullRequestRate: 0 }],
    };

    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        body: "Fixes #7",
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" },
          { path: "src/cache.test.ts", additions: 20, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache edge", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory: pressuredHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.branchQualityBlockers).toEqual([]);
    expect(analysis.accountStateBlockers.join(" ")).toMatch(/Open PR count|Credibility/i);
    expect(analysis.workspaceIntelligence.blockers.branchQuality).toEqual([]);
    expect(analysis.workspaceIntelligence.blockers.accountState.length).toBeGreaterThan(0);
    expect(analysis.recommendedRerunCondition).toBe("Rerun after account/queue maturity blockers clear.");
    expect(analysis.prPacket.markdown).not.toMatch(/account\/queue maturity|account-state|score|credibility|Open PR count/i);
    expect(analysis.prPacket.bodySections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: "Next Steps",
          lines: expect.arrayContaining(["- Rerun after any branch, base, or PR state changes before opening/submitting."]),
        }),
      ]),
    );
    expect(analysis.nextActions[0]?.actionKind).not.toBe("land_existing_prs");
  });

  it("handles sparse metadata, failed validation, binary changes, and commit-title fallback", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
        commitMessages: ["Fix reconnect binary asset handling\n\nNo public scoring text."],
        changedFiles: [{ path: "assets/cache.bin", additions: 0, deletions: 0, binary: true, status: "modified" }],
        validation: [{ command: "npm test -- cache", status: "failed", summary: "regression failed" }],
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.titleSuggestion).toBe("Fix reconnect binary asset handling");
    expect(analysis.localFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "failed_local_validation" }),
        expect.objectContaining({ code: "binary_diff_present" }),
      ]),
    );
    expect(analysis.workspaceIntelligence.changedFiles.binary).toBe(1);
    expect(analysis.prPacket.bodySections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: "Linked Context", lines: ["- No linked issue detected; explain why this is a no-issue PR."] }),
        expect.objectContaining({ heading: "Validation", lines: [expect.stringContaining("failed: npm test -- cache")] }),
      ]),
    );
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("uses safe defaults when local metadata has no title, files, or validation", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.prPacket.titleSuggestion).toBe("Local branch preflight");
    expect(analysis.prPacket.bodySections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ heading: "Changed Paths", lines: ["- No changed paths were detected from local metadata."] }),
        expect.objectContaining({ heading: "Validation", lines: ["- Not supplied yet."] }),
        expect.objectContaining({ heading: "Next Steps", lines: expect.arrayContaining([expect.stringContaining("metadata only")]) }),
      ]),
    );
    expect(analysis.summary).toContain("is the top private next action");
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("applies a maintainer focus manifest: preferred path, label, and a public-safe focus section", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
        branchName: "fix-cache",
        body: "Fixes #7",
        labels: ["bug"],
        changedFiles: [
          { path: "src/cache.ts", additions: 12, deletions: 1, status: "modified" },
          { path: "test/cache.test.ts", additions: 8, deletions: 0, status: "added" },
        ],
        validation: [{ command: "npm test -- cache", status: "passed" }],
        focusManifest: {
          source: "repo_file",
          wantedPaths: ["src/"],
          preferredLabels: ["bug"],
          linkedIssuePolicy: "required",
          maintainerNotes: ["Internal: ping @owner before touching the cache layer."],
          publicNotes: ["Prefer small, focused PRs."],
        },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh", state: "open", labels: ["bug"], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.manifestGuidance.present).toBe(true);
    expect(analysis.manifestGuidance.matchedWantedPaths).toContain("src/");
    expect(analysis.manifestGuidance.preferredLabelHits).toContain("bug");
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "manifest_preferred_path" })]));
    expect(analysis.prPacket.markdown).toContain("## Maintainer Focus");
    expect(analysis.prPacket.markdown).toContain("Prefer small, focused PRs.");
    expect(analysis.prPacket.markdown).not.toMatch(/ping @owner/);
    expect(JSON.stringify(analysis.manifestGuidance)).not.toMatch(/ping @owner/);
    expect(JSON.stringify(analysis)).not.toMatch(/ping @owner/);
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/ping @owner/);
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("treats a maintainer-blocked path as a branch-quality blocker", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
        branchName: "touch-migrations",
        body: "Fixes #7",
        changedFiles: [{ path: "migrations/0099_change.sql", additions: 20, deletions: 0, status: "added" }],
        focusManifest: { blockedPaths: ["migrations/"] },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 7, title: "Cache refresh", state: "open", labels: [], linkedPrs: [] }],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.manifestGuidance.matchedBlockedPaths).toEqual(["migrations/"]);
    expect(analysis.localFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "manifest_blocked_path", severity: "critical" })]));
    expect(analysis.branchQualityBlockers).toEqual(expect.arrayContaining([expect.stringContaining("maintainer-blocked area")]));
    expect(JSON.stringify(analysis.prPacket)).not.toMatch(/reward|score|wallet|hotkey|farming|payout|ranking|trust score/i);
  });

  it("ignores a malformed focus manifest without breaking analysis", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "entrius/allways-ui",
        branchName: "fix-cache",
        changedFiles: [{ path: "src/cache.ts", additions: 4, deletions: 0, status: "modified" }],
        focusManifest: { wantedPaths: "src/", linkedIssuePolicy: "sometimes" },
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.manifestGuidance.present).toBe(false);
    expect(analysis.manifestGuidance.warnings.length).toBeGreaterThan(0);
    expect(analysis.prPacket.bodySections.some((section) => section.heading === "Maintainer Focus")).toBe(false);
  });
});

describe("local MCP git metadata collection", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    delete process.env.GITTENSORY_UPLOAD_SOURCE;
  });

  it("counts pending commits, emits CI hints, and tracks deleted or renamed paths", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { collectCiStatusHints, collectLocalBranchMetadata, collectPendingCommitCount } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-local-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:entrius/allways-ui.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    writeFileSync(join(tempDir, "keep.ts"), "keep\n");
    git(tempDir, "add", "keep.ts");
    git(tempDir, "commit", "-m", "add keep file");
    git(tempDir, "checkout", "-b", "rename-delete");
    writeFileSync(join(tempDir, "old.ts"), "old\n");
    git(tempDir, "add", "old.ts");
    git(tempDir, "commit", "-m", "add old file");
    git(tempDir, "mv", "old.ts", "new.ts");
    git(tempDir, "add", "new.ts");
    git(tempDir, "commit", "-m", "rename old to new");
    const renameMetadata = collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD~1", login: "oktofeesh1" });
    expect(renameMetadata.changedFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "new.ts", previousPath: "old.ts", status: "renamed" })]),
    );
    git(tempDir, "rm", "keep.ts");
    git(tempDir, "commit", "-m", "delete keep file");

    expect(collectPendingCommitCount(tempDir, "HEAD~2")).toBe(2);
    const deleteMetadata = collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD~1", login: "oktofeesh1" });
    expect(deleteMetadata.changedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "keep.ts", status: "deleted" })]));
    expect(collectCiStatusHints(tempDir, "HEAD~2", deleteMetadata.changedFiles).join(" ")).toMatch(/local commit/i);
    expect(JSON.stringify(renameMetadata)).not.toMatch(/export const old/);
  });

  it("counts additions and deletions for cross-directory renames that share no prefix or suffix", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { collectLocalBranchMetadata } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-local-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:entrius/allways-ui.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    git(tempDir, "checkout", "-b", "cross-dir-rename");
    mkdirSync(join(tempDir, "src/alpha"), { recursive: true });
    // A large body keeps rename similarity high so git reports a rename, not add + delete.
    const body = Array.from({ length: 20 }, (_, line) => `line ${line}`).join("\n");
    writeFileSync(join(tempDir, "src/alpha/foo.js"), `${body}\n`);
    // A binary blob exercises numstat's "-\t-" path (additions/deletions 0, binary true).
    writeFileSync(join(tempDir, "logo.bin"), Buffer.from([0, 1, 2, 0, 255, 254]));
    git(tempDir, "add", "-A");
    git(tempDir, "commit", "-m", "add foo");
    // With no shared prefix or suffix git renders this rename as a bare "src/alpha/foo.js =>
    // docs/beta/bar.js" in --numstat, which the previous brace-only parser never matched -> the
    // renamed file fell back to +0/-0 and undercounted changedLineCount.
    mkdirSync(join(tempDir, "docs/beta"), { recursive: true });
    git(tempDir, "mv", "src/alpha/foo.js", "docs/beta/bar.js");
    writeFileSync(join(tempDir, "docs/beta/bar.js"), `${body}\nadded one\nadded two\n`);
    writeFileSync(join(tempDir, "logo.bin"), Buffer.from([3, 0, 4, 0, 5, 0, 6]));
    git(tempDir, "add", "-A");
    git(tempDir, "commit", "-m", "rename foo across directories");

    const renameMetadata = collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD~1", login: "oktofeesh1" });
    expect(renameMetadata.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/beta/bar.js", previousPath: "src/alpha/foo.js", status: "renamed", additions: 2, deletions: 0 }),
        expect.objectContaining({ path: "logo.bin", status: "modified", additions: 0, deletions: 0, binary: true }),
      ]),
    );
  });

  it("returns no lines when the git command fails", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { gitLines } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    expect(gitLines(join(tmpdir(), "gittensory-no-such-repo-d8f3"), ["rev-parse", "HEAD"])).toEqual([]);
  });

  it("counts stats and keeps verbatim paths for non-ASCII filenames at the default core.quotePath", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { collectLocalBranchMetadata } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-local-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    // Deliberately leave core.quotePath at its default (on): git's human --name-status then quotes
    // accented paths, which would diverge from the verbatim --numstat -z key and zero out the stats.
    git(tempDir, "remote", "add", "origin", "git@github.com:entrius/allways-ui.git");
    writeFileSync(join(tempDir, "über.txt"), "a\nb\nc\n");
    const renameBody = Array.from({ length: 20 }, (_, line) => `line ${line}`).join("\n");
    mkdirSync(join(tempDir, "café"));
    writeFileSync(join(tempDir, "café/old.txt"), `${renameBody}\n`);
    git(tempDir, "add", "-A");
    git(tempDir, "commit", "-m", "seed non-ascii files");
    git(tempDir, "checkout", "-b", "non-ascii");
    writeFileSync(join(tempDir, "über.txt"), "a\nb\nc\nd\ne\n");
    writeFileSync(join(tempDir, "naïve.txt"), "x\ny\nz\n");
    mkdirSync(join(tempDir, "docs"));
    git(tempDir, "mv", "café/old.txt", "docs/résumé.txt");
    writeFileSync(join(tempDir, "docs/résumé.txt"), `${renameBody}\nextra\n`);
    git(tempDir, "add", "-A");
    git(tempDir, "commit", "-m", "edit non-ascii files");

    const metadata = collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD~1", login: "oktofeesh1" });
    expect(metadata.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "über.txt", status: "modified", additions: 2, deletions: 0 }),
        expect.objectContaining({ path: "naïve.txt", status: "added", additions: 3, deletions: 0 }),
        expect.objectContaining({ path: "docs/résumé.txt", previousPath: "café/old.txt", status: "renamed", additions: 1, deletions: 0 }),
      ]),
    );
  });

  it("parses remotes, changed-file stats, linked issues, and refuses source upload mode", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { collectLocalBranchMetadata, parseGitRemote } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    expect(parseGitRemote("git@github.com:entrius/allways-ui.git")).toBe("entrius/allways-ui");
    expect(parseGitRemote("https://github.com/JSONbored/gittensory.git")).toBe("JSONbored/gittensory");

    tempDir = mkdtempSync(join(tmpdir(), "gittensory-local-"));
    git(tempDir, "init");
    git(tempDir, "config", "user.email", "test@example.com");
    git(tempDir, "config", "user.name", "Gittensory Test");
    git(tempDir, "config", "commit.gpgsign", "false");
    git(tempDir, "remote", "add", "origin", "git@github.com:entrius/allways-ui.git");
    writeFileSync(join(tempDir, "README.md"), "fixture\n");
    git(tempDir, "add", "README.md");
    git(tempDir, "commit", "-m", "initial commit");
    git(tempDir, "checkout", "-b", "fix-cache-7");
    mkdirSync(join(tempDir, "src"));
    mkdirSync(join(tempDir, "test"));
    writeFileSync(join(tempDir, "src/cache.ts"), "export const cache = 1;\n");
    writeFileSync(join(tempDir, "test/cache.test.ts"), "expect(1).toBe(1);\n");
    git(tempDir, "add", "src/cache.ts", "test/cache.test.ts");

    const metadata = collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD", login: "oktofeesh1", body: "Fixes #7" });
    expect(metadata).toMatchObject({
      login: "oktofeesh1",
      repoFullName: "entrius/allways-ui",
      branchName: "fix-cache-7",
      linkedIssues: [7],
    });
    expect(metadata.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/cache.ts", additions: 1, status: "added" }),
        expect.objectContaining({ path: "test/cache.test.ts", additions: 1, status: "added" }),
      ]),
    );
    expect(JSON.stringify(metadata)).not.toMatch(/export const cache/);

    process.env.GITTENSORY_UPLOAD_SOURCE = "true";
    expect(() => collectLocalBranchMetadata({ cwd: tempDir, baseRef: "HEAD", login: "oktofeesh1" })).toThrow(/not supported/);
  });

  it("selects and validates cwd from MCP roots without leaking local paths", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { collectLocalBranchMetadata, normalizeMcpWorkspaceRoots, resolveWorkspaceCwd } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-local-"));
    const workspace = join(tempDir, "workspace");
    const outside = join(tempDir, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    git(workspace, "init");
    git(workspace, "config", "user.email", "test@example.com");
    git(workspace, "config", "user.name", "Gittensory Test");
    git(workspace, "config", "commit.gpgsign", "false");
    git(workspace, "remote", "add", "origin", "git@github.com:entrius/allways-ui.git");
    writeFileSync(join(workspace, "README.md"), "fixture\n");
    git(workspace, "add", "README.md");
    git(workspace, "commit", "-m", "initial commit");
    git(workspace, "checkout", "-b", "fix-roots-7");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src/rooted.ts"), "export const rooted = true;\n");
    git(workspace, "add", "src/rooted.ts");

    const roots = [{ uri: pathToFileURL(workspace).href, name: `${workspace}/private-name` }];
    expect(normalizeMcpWorkspaceRoots([{ uri: "https://example.com/not-local" }, ...roots])).toHaveLength(1);
    expect(resolveWorkspaceCwd({ workspaceRoots: roots })).toMatchObject({ rootsAvailable: true, rootCount: 1 });

    const metadata = collectLocalBranchMetadata({ workspaceRoots: roots, baseRef: "HEAD", login: "oktofeesh1", body: "Fixes #7" });
    expect(metadata).toMatchObject({
      repoFullName: "entrius/allways-ui",
      branchName: "fix-roots-7",
      linkedIssues: [7],
    });
    expect(metadata.changedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/rooted.ts" })]));
    expect(JSON.stringify(metadata)).not.toContain(workspace);

    expect(() => collectLocalBranchMetadata({ cwd: outside, workspaceRoots: roots, baseRef: "HEAD", login: "oktofeesh1" })).toThrow(/outside the MCP roots/);
    try {
      collectLocalBranchMetadata({ cwd: outside, workspaceRoots: roots, baseRef: "HEAD", login: "oktofeesh1" });
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(tempDir);
    }
  });

  it("emits scenarioSummary with advisory flags set and no forbidden public language", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "src/util.ts", additions: 30, deletions: 2, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 38 },
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.scenarioSummary.advisoryOnly).toBe(true);
    expect(analysis.scenarioSummary.notAutonomousPrBot).toBe(true);
    expect(analysis.scenarioSummary.notPublicScoring).toBe(true);
    expect(analysis.scenarioSummary.headline.length).toBeGreaterThan(0);
    expect(JSON.stringify(analysis.scenarioSummary)).not.toMatch(
      /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward[-\s]?estimate|farming|raw trust|trust[-\s]?score|scoreability|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)/i,
    );
  });

  it("does not throw when branch analysis identifiers contain protocol terms", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: "wallet-tools/api",
        branchName: "feature/wallet-ui",
        baseRef: "hotkey-fix",
        changedFiles: [{ path: "src/util.ts", additions: 20, deletions: 1, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 35, totalTokenScore: 55, sourceLines: 30 },
      },
      repo: { ...repo, fullName: "wallet-tools/api", owner: "wallet-tools", name: "api" },
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.scenarioSummary.repoFullName).toBe("wallet-tools/api");
    expect(analysis.scenarioSummary.dataClassification.facts).toEqual(expect.arrayContaining(["Contributor", "Repository", "Branch"]));
  });

  it("ignores contributor open PRs from other repos when ranking pressure options", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "src/util.ts", additions: 30, deletions: 2, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 38 },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 9, title: "Improve util", state: "open", labels: [], linkedPrs: [] }],
      pullRequests: [],
      contributorPullRequests: [
        { repoFullName: "someone-else/other-repo", number: 4, title: "Cross-repo WIP", state: "open", authorLogin: "oktofeesh1", labels: [], linkedIssues: [] },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    const options = analysis.scenarioSummary.options;
    expect(options[0]).toMatchObject({ label: "Open another PR now", recommended: true });
    expect(options[0]?.rationale).toContain("Repo queue pressure is low.");
    expect(options[0]?.obstacles).toEqual([]);
  });

  it("counts same-repo contributor open PRs case-insensitively when ranking pressure options", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "Oktofeesh1",
        repoFullName: "EnTrius/AllWays-UI",
        changedFiles: [{ path: "src/util.ts", additions: 30, deletions: 2, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 38 },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 9, title: "Improve util", state: "open", labels: [], linkedPrs: [] }],
      pullRequests: [],
      contributorPullRequests: [
        { repoFullName: repo.fullName, number: 4, title: "WIP util", state: "open", authorLogin: "oktofeesh1", labels: [], linkedIssues: [] },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    const options = analysis.scenarioSummary.options;
    expect(options[0]).toMatchObject({ label: "Clean up existing work first", recommended: true });
    expect(options.find((option) => option.label === "Open another PR now")?.obstacles.join(" ")).toMatch(/already have open PR/i);
  });

  it("wires open-PR pressure strategy options into scenarioSummary.options (#348)", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "src/util.ts", additions: 30, deletions: 2, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 38 },
      },
      repo,
      issues: [{ repoFullName: repo.fullName, number: 9, title: "Improve util", state: "open", labels: [], linkedPrs: [] }],
      pullRequests: [
        { repoFullName: repo.fullName, number: 4, title: "WIP util", state: "open", authorLogin: "oktofeesh1", labels: [], linkedIssues: [] },
      ],
      // contributorPullRequests is preferred when present; the authorless PR exercises the null-author
      // guard in the own-open-PR count and must not be miscounted as this contributor's work.
      contributorPullRequests: [
        { repoFullName: repo.fullName, number: 4, title: "WIP util", state: "open", authorLogin: "oktofeesh1", labels: [], linkedIssues: [] },
        { repoFullName: repo.fullName, number: 5, title: "Authorless", state: "open", authorLogin: null, labels: [], linkedIssues: [] },
      ],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    // Before this fix the renderer never received the pressure simulation, so options was always [].
    const options = analysis.scenarioSummary.options;
    expect(options.length).toBe(3);
    expect(options.map((option) => option.rank)).toEqual([1, 2, 3]);
    expect(options.filter((option) => option.recommended)).toHaveLength(1);
    expect(options[0]?.recommended).toBe(true);
    for (const option of options) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.nextStep.length).toBeGreaterThan(0);
    }
  });

  it("populates scenarioSummary.dataClassification with contributor and repo facts from branch metadata", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "feat-util-refactor",
        changedFiles: [{ path: "src/util.ts", additions: 20, deletions: 1, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 35, totalTokenScore: 55, sourceLines: 30 },
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.scenarioSummary.dataClassification.facts).toContain("Contributor");
    expect(analysis.scenarioSummary.dataClassification.facts).toContain("Repository");
    expect(analysis.scenarioSummary.dataClassification.facts).toContain("Branch");
  });

  it("does not throw while summarizing oversized local branch metadata", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        branchName: "b".repeat(SCENARIO_MAX_BRANCH_REF_CHARS + 1),
        baseRef: "m".repeat(SCENARIO_MAX_BRANCH_REF_CHARS + 1),
        linkedIssues: Array.from({ length: SCENARIO_MAX_LINKED_ISSUE_NUMBERS + 1 }, (_, index) => index + 1),
        changedFiles: [{ path: "src/util.ts", additions: 20, deletions: 1, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 35, totalTokenScore: 55, sourceLines: 30 },
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.scenarioSummary.dataClassification.facts).toContain("Branch");
    expect(analysis.branchName).toHaveLength(SCENARIO_MAX_BRANCH_REF_CHARS + 1);
  });

  it("populates scenarioSummary.eligibilityNotes from the derived eligibility plan", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "src/cache.ts", additions: 30, deletions: 2, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 38 },
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.scenarioSummary.eligibilityNotes.length).toBeGreaterThan(0);
  });

  it("populates scenarioSummary.blockerNotes when the score preview has metadata-only signals", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        // No localScorer — falls back to metadata-only mode, triggering the metadata_only blocker
        changedFiles: [{ path: "src/cache.ts", additions: 5, deletions: 0, status: "modified" }],
      },
      repo,
      issues: [],
      pullRequests: [],
      profile,
      outcomeHistory,
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.scenarioSummary.blockerNotes.join(" ")).toMatch(/metadata signals are available/i);
  });

  it("populates scenarioSummary.pendingScenarioNotes when approved open PRs are observed from cached GitHub state", () => {
    const analysis = buildLocalBranchAnalysis({
      input: {
        login: "oktofeesh1",
        repoFullName: repo.fullName,
        changedFiles: [{ path: "src/cache.ts", additions: 30, deletions: 2, status: "modified" }],
        localScorer: { mode: "external_command", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 38 },
      },
      repo,
      issues: [],
      pullRequests: [],
      contributorPullRequests: [
        {
          repoFullName: repo.fullName,
          number: 21,
          title: "Approved cache fix",
          state: "open",
          authorLogin: "oktofeesh1",
          authorAssociation: "CONTRIBUTOR",
          reviewDecision: "APPROVED",
          labels: [],
          linkedIssues: [],
        },
      ],
      profile,
      outcomeHistory: { ...outcomeHistory, totals: { ...outcomeHistory.totals, openPullRequests: 1 } },
      scoringSnapshot,
      scoringProfile,
    });

    expect(analysis.observedPullRequestScenarios.approvedOrMergeable).toBeGreaterThan(0);
    expect(analysis.scenarioSummary.pendingScenarioNotes.length).toBeGreaterThan(0);
    expect(analysis.scenarioSummary.pendingScenarioNotes.join(" ")).toMatch(/cached GitHub reviews, checks, and activity/i);
  });
});

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  defaultBranch: "test",
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.01107,
    issueDiscoveryShare: 0,
    labelMultipliers: { bug: 1.1 },
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

const profile: ContributorProfile = {
  login: "oktofeesh1",
  generatedAt: "2026-05-25T00:00:00.000Z",
  github: { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
  source: "gittensor_api",
  registeredRepoActivity: {
    pullRequests: 6,
    mergedPullRequests: 5,
    issues: 0,
    reposTouched: [repo.fullName],
    dominantLabels: ["bug"],
  },
  trustSignals: {
    evidenceScore: 80,
    level: "emerging",
    unlinkedOpenPullRequests: 0,
    maintainerAssociatedPullRequests: 0,
  },
};

const outcomeHistory: ContributorOutcomeHistory = {
  login: "oktofeesh1",
  generatedAt: "2026-05-25T00:00:00.000Z",
  source: "gittensor_api",
  totals: {
    pullRequests: 6,
    mergedPullRequests: 5,
    openPullRequests: 0,
    closedPullRequests: 1,
    closedPullRequestRate: 0.5,
    issues: 0,
    openIssues: 0,
    closedIssues: 0,
    solvedIssues: 3,
    validSolvedIssues: 3,
    credibility: 0.92,
    issueCredibility: 1,
  },
  repoOutcomes: [
    {
      repoFullName: repo.fullName,
      role: "outside_contributor",
      lane: "direct_pr",
      maintainerLane: false,
      pullRequests: 6,
      mergedPullRequests: 5,
      openPullRequests: 0,
      closedPullRequests: 1,
      closedPullRequestRate: 0.5,
      issues: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 3,
      validSolvedIssues: 3,
      credibility: 0.92,
      issueCredibility: 1,
      isEligible: true,
      successLevel: "emerging",
      strengths: ["Merged prior PRs."],
      risks: ["Closed PR risk exists."],
    },
  ],
  successPatterns: [],
  failurePatterns: [],
  summary: "fixture history",
};

const scoringSnapshot: ScoringModelSnapshotRecord = {
  id: "scoring-test",
  sourceKind: "test",
  sourceUrl: "fixture://scoring",
  fetchedAt: "2026-05-25T00:00:00.000Z",
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
  programmingLanguages: { TypeScript: 1 },
  warnings: [],
  payload: {},
};

const scoringProfile: ContributorScoringProfile = {
  login: "oktofeesh1",
  generatedAt: "2026-05-25T00:00:00.000Z",
  scoringModelSnapshotId: "scoring-test",
  evidence: {
    registeredRepoPullRequests: 6,
    mergedPullRequests: 5,
    openPullRequests: 0,
    stalePullRequests: 0,
    unlinkedPullRequests: 0,
    issueDiscoveryReports: 0,
    languageMatches: 1,
    credibilityAssumption: 0.92,
  },
  privateSignals: ["fixture scoring profile"],
};

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
