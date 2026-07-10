import { describe, expect, it } from "vitest";

import { buildPullRequestAdvisory, evaluateGateCheck, gateAdvisoryInternals } from "../../packages/gittensory-engine/src/advisory/gate-advisory";
import { evaluateClaCheck, CLA_CHECK_UNRESOLVED_CODE, CLA_CONSENT_MISSING_CODE } from "../../packages/gittensory-engine/src/review/cla-check";
import { REVIEW_THREAD_BLOCKER_CODE } from "../../packages/gittensory-engine/src/review/review-thread-findings";
import { guardrailPathMatches } from "../../packages/gittensory-engine/src/signals/change-guardrail";
import {
  buildCollisionReport,
  buildLaneAdvice,
  buildPreflightResult,
  buildPublicReadinessScore,
  buildQueueHealth,
  classifyBountyLifecycle,
  predictedGateEngineInternals,
  termOverlap,
} from "../../packages/gittensory-engine/src/signals/predicted-gate-engine";
import type { IssueQualityReport, PullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../packages/gittensory-engine/src/types/predicted-gate-types";

const REPO = repo("acme/widgets");

describe("predicted-gate engine branch coverage (#2283)", () => {
  it("exercises gate-advisory gateMode and blocker policy branches", () => {
    expect(gateAdvisoryInternals.gateMode("off")).toBe("off");
    expect(gateAdvisoryInternals.gateMode("block")).toBe("block");
    expect(gateAdvisoryInternals.gateMode("advisory")).toBe("advisory");
    expect(gateAdvisoryInternals.gateMode(undefined)).toBe("advisory");
    expect(gateAdvisoryInternals.gatePolicyBlocks("advisory", "advisory")).toBe(false);
    expect(gateAdvisoryInternals.gatePolicyBlocks("block", "advisory")).toBe(true);
    expect(gateAdvisoryInternals.gatePolicyBlocks(undefined, "off")).toBe(false);
    expect(gateAdvisoryInternals.buildSizeHoldFinding({})).toBeNull();
    expect(gateAdvisoryInternals.buildSizeHoldFinding({ sizeGateMode: "off", changedFileCount: 99, changedLineCount: 99_999 })).toBeNull();
    expect(gateAdvisoryInternals.buildSizeHoldFinding({ sizeGateMode: "block", changedLineCount: 5000 })?.code).toBe("oversized_pr");
    expect(gateAdvisoryInternals.buildSizeHoldFinding({ sizeGateMode: "block", changedFileCount: 12 })?.code).toBe("oversized_pr");
    expect(gateAdvisoryInternals.buildSizeHoldFinding({ sizeGateMode: "advisory", changedFileCount: 2, changedLineCount: 2 })).toBeNull();
    expect(gateAdvisoryInternals.buildSizeHoldFinding({ sizeGateMode: "advisory", changedFileCount: 2, changedLineCount: 5000 })?.code).toBe("oversized_pr");

    const finding = (code: string) => ({ code, severity: "warning" as const, title: code, detail: code });
    const advisory = {
      linkedIssueGateMode: "advisory" as const,
      duplicatePrGateMode: "advisory" as const,
      aiReviewGateMode: "advisory" as const,
      manifestPolicyGateMode: "advisory" as const,
      selfAuthoredLinkedIssueGateMode: "advisory" as const,
      lockfileIntegrityGateMode: "off" as const,
      claGateMode: "off" as const,
    };
    const block = {
      linkedIssueGateMode: "block" as const,
      duplicatePrGateMode: "block" as const,
      aiReviewGateMode: "block" as const,
      manifestPolicyGateMode: "block" as const,
      selfAuthoredLinkedIssueGateMode: "block" as const,
      lockfileIntegrityGateMode: "block" as const,
      claGateMode: "block" as const,
    };
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("missing_linked_issue"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("missing_linked_issue"), block)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("duplicate_pr_risk"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("duplicate_pr_risk"), block)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("ai_consensus_defect"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("ai_consensus_defect"), block)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("ai_review_split"), advisory)).toBe(false);
    // #4603: aiReviewLowConfidenceDisposition branches — the default ("hold_for_review", exercised by the
    // bare `block` policy above with no confidence set) and "one_shot" both ignore confidence entirely and
    // still block; only "advisory_only" demotes a SUB-floor finding to a non-blocker, and only below the
    // configured floor -- at/above it, "advisory_only" still blocks like every other disposition.
    expect(
      gateAdvisoryInternals.isConfiguredGateBlocker(
        { ...finding("ai_consensus_defect"), confidence: 0.2 },
        { ...block, aiReviewLowConfidenceDisposition: "one_shot" },
      ),
    ).toBe(true);
    expect(
      gateAdvisoryInternals.isConfiguredGateBlocker(
        { ...finding("ai_consensus_defect"), confidence: 0.2 },
        { ...block, aiReviewLowConfidenceDisposition: "advisory_only", aiReviewCloseConfidence: 0.93 },
      ),
    ).toBe(false);
    expect(
      gateAdvisoryInternals.isConfiguredGateBlocker(
        { ...finding("ai_review_split"), confidence: 0.99 },
        { ...block, aiReviewLowConfidenceDisposition: "advisory_only", aiReviewCloseConfidence: 0.93 },
      ),
    ).toBe(true);
    // A finding with no confidence reported at all defaults to fully-confident (?? 1), so it still blocks
    // even under advisory_only regardless of the configured floor.
    expect(
      gateAdvisoryInternals.isConfiguredGateBlocker(finding("ai_consensus_defect"), {
        ...block,
        aiReviewLowConfidenceDisposition: "advisory_only",
      }),
    ).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("manifest_linked_issue_required"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("manifest_linked_issue_required"), block)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("manifest_missing_tests"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("manifest_missing_tests"), block)).toBe(true);
    expect(gateAdvisoryInternals.gatePolicyBlocks("off", "block")).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("self_authored_linked_issue"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("self_authored_linked_issue"), block)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("lockfile_tamper_risk"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("lockfile_tamper_risk"), block)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding(CLA_CONSENT_MISSING_CODE), advisory)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding(CLA_CONSENT_MISSING_CODE), block)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding(REVIEW_THREAD_BLOCKER_CODE), advisory)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("secret_leak"), advisory)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("pre_merge_check_required"), advisory)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("unknown_code"), advisory)).toBe(false);
    expect(gateAdvisoryInternals.buildSlopGateBlocker({ slopGateMode: "block", slopRisk: 90, slopGateMinScore: 60 })?.code).toBe("slop_risk_above_threshold");
    expect(gateAdvisoryInternals.buildSlopGateBlocker({ slopGateMode: "block", slopRisk: 40, slopGateMinScore: 60 })).toBeNull();
    expect(gateAdvisoryInternals.buildSlopGateBlocker({ slopGateMode: "block", slopRisk: 80 })).not.toBeNull();
    expect(gateAdvisoryInternals.buildQualityGateWarning({ qualityGateMode: "off", readinessScore: 1, qualityGateMinScore: 99 })).toBeNull();
  });

  it("exercises cla-check and guardrail branch arms", () => {
    expect(evaluateClaCheck({ consentPhrase: null, checkRunName: "CLA Bot" }, { checkRunConclusion: "failure" })[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    expect(evaluateClaCheck({ consentPhrase: "I agree to the CLA", checkRunName: null }, { body: "no consent here" })[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    expect(evaluateClaCheck({ consentPhrase: "I agree to the CLA", checkRunName: null }, { body: undefined })[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    expect(evaluateClaCheck({ consentPhrase: "I agree", checkRunName: "CLA Bot" }, { body: "nope", checkRunConclusion: undefined })[0]?.code).toBe(
      CLA_CHECK_UNRESOLVED_CODE,
    );
    expect(guardrailPathMatches(["src/a.ts"], ["src/a.ts"])).toEqual([{ path: "src/a.ts", glob: "src/a.ts" }]);
    expect(guardrailPathMatches(["other.ts"], ["src/a.ts"])).toEqual([]);
    const pathological = "src/*-*-*-final.ts";
    expect(guardrailPathMatches(["scripts/x.ts"], [pathological])).toEqual([{ path: "scripts/x.ts", glob: pathological }]);
  });

  it("exercises classifyBountyLifecycle and preflight branch arms", () => {
    const issue = { repoFullName: REPO.fullName, number: 1, title: "Issue", state: "open" as const, labels: [], linkedPrs: [] };
    expect(classifyBountyLifecycle({ id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "cancelled", updatedAt: "2026-01-01T00:00:00.000Z", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, issue)).toBe("cancelled");
    expect(classifyBountyLifecycle({ id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "completed", updatedAt: "2026-01-01T00:00:00.000Z", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, issue)).toBe("completed");
    expect(classifyBountyLifecycle(
      { id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "active funded", discoveredAt: new Date().toISOString(), payload: {} },
      issue,
    )).toBe("active");
    expect(classifyBountyLifecycle(
      { id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "active funded", updatedAt: "2020-01-01T00:00:00.000Z", discoveredAt: "2020-01-01T00:00:00.000Z", payload: {} },
      issue,
    )).toBe("stale");

    const ambiguousOnlyBountyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [9], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
      REPO,
      [{ repoFullName: REPO.fullName, number: 9, title: "Issue", state: "open", labels: [], linkedPrs: [] }],
      [],
      [{ id: "b3", repoFullName: REPO.fullName, issueNumber: 9, status: "mystery bounty", updatedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), payload: {} }],
    );
    expect(ambiguousOnlyBountyPreflight.findings.some((f) => f.code === "linked_issue_bounty_unverified")).toBe(true);

    const activeBountyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [11], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
      REPO,
      [{ repoFullName: REPO.fullName, number: 11, title: "Issue", state: "open", labels: [], linkedPrs: [] }],
      [],
      [{ id: "b4", repoFullName: REPO.fullName, issueNumber: 11, status: "active funded", updatedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), payload: {} }],
    );
    expect(activeBountyPreflight.findings.map((f) => f.code)).not.toContain("linked_issue_bounty_unverified");

    const ambiguousBountyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
      REPO,
      [{ repoFullName: REPO.fullName, number: 7, title: "Issue", state: "closed", labels: [], linkedPrs: [] }],
      [],
      [{ id: "b", repoFullName: REPO.fullName, issueNumber: 7, status: "active funded", updatedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), payload: {} }],
    );
    expect(ambiguousBountyPreflight.findings.some((f) => f.code === "linked_issue_bounty_unverified")).toBe(true);
    expect(classifyBountyLifecycle({ id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "active funded", updatedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), payload: {} }, { ...issue, state: "closed" })).toBe("ambiguous");
    expect(
      classifyBountyLifecycle(
        { id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "active funded", updatedAt: "2020-01-01T00:00:00.000Z", discoveredAt: "2020-01-01T00:00:00.000Z", payload: {} },
        issue,
      ),
    ).toBe("stale");

    const mediumBurden = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], linkedIssues: [7] },
      REPO,
      [],
      [],
    );
    expect(mediumBurden.reviewBurden).toBe("medium");

    const ready = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", changedFiles: ["src/a.ts"], linkedIssues: [7], tests: ["src/a.test.ts"] },
      REPO,
      [{ repoFullName: REPO.fullName, number: 7, title: "Issue", state: "open", labels: [], linkedPrs: [] }],
      [],
    );
    expect(ready.status).toBe("ready");

    const staleBountyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
      REPO,
      [{ repoFullName: REPO.fullName, number: 7, title: "Issue", state: "open", labels: [], linkedPrs: [] }],
      [],
      [{ id: "b", repoFullName: REPO.fullName, issueNumber: 7, status: "active funded", updatedAt: "2020-01-01T00:00:00.000Z", discoveredAt: "2020-01-01T00:00:00.000Z", payload: {} }],
    );
    expect(staleBountyPreflight.findings.some((f) => f.code === "linked_issue_bounty_unverified")).toBe(true);

    const issueQualityNoWarnings: IssueQualityReport = {
      repoFullName: REPO.fullName,
      generatedAt: "2026-01-01T00:00:00.000Z",
      lane: { lane: "direct_pr", repoFullName: REPO.fullName, summary: "s", contributorGuidance: "s", maintainerGuidance: "s" },
      summary: "s",
      issues: [{ number: 8, title: "Issue", status: "needs_proof", score: 40, reasons: [], warnings: [] }],
    };
    expect(
      buildPreflightResult(
        { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [8], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
        REPO,
        [],
        [],
        [],
        issueQualityNoWarnings,
      ).findings.some((f) => f.code === "issue_quality_needs_proof"),
    ).toBe(true);

    const issueQualityReady: IssueQualityReport = {
      repoFullName: REPO.fullName,
      generatedAt: "2026-01-01T00:00:00.000Z",
      lane: { lane: "direct_pr", repoFullName: REPO.fullName, summary: "s", contributorGuidance: "s", maintainerGuidance: "s" },
      summary: "s",
      issues: [{ number: 7, title: "Issue", status: "ready", score: 100, reasons: [], warnings: [] }],
    };
    expect(
      buildPreflightResult(
        { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
        REPO,
        [],
        [],
        [],
        issueQualityReady,
      ).findings.map((f) => f.code),
    ).not.toContain("issue_quality_do_not_use");

    const linkedIssueCollision = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Unrelated title", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
      REPO,
      [],
      [
        { ...pr(REPO.fullName, 20, "Other work"), linkedIssues: [7] },
        { ...pr(REPO.fullName, 21, "More work"), linkedIssues: [7] },
      ],
    );
    expect(linkedIssueCollision.collisions.length).toBeGreaterThan(0);

    const titleOverlapCollision = buildPreflightResult(
      {
        repoFullName: REPO.fullName,
        title: "Resolve login redirect loop OAuth callback handler",
        body: "",
        linkedIssues: [],
        changedFiles: ["src/auth.ts"],
        tests: ["src/auth.test.ts"],
      },
      REPO,
      [{ repoFullName: REPO.fullName, number: 51, title: "Login redirect loop OAuth cleanup", state: "open", labels: [], linkedPrs: [] }],
      [{ ...pr(REPO.fullName, 52, "Login redirect loop OAuth middleware"), changedFiles: ["src/auth.ts"] }],
    );
    expect(titleOverlapCollision.collisions.length).toBeGreaterThan(0);
  });

  it("exercises collision pairwise branch arms", () => {
    expect(
      buildCollisionReport(REPO.fullName, [], [
        { ...pr(REPO.fullName, 1, "alpha upload retry client"), authorLogin: "alice", changedFiles: ["package-lock.json"] },
        { ...pr(REPO.fullName, 2, "beta upload retry service"), authorLogin: "bob", changedFiles: ["package-lock.json"] },
      ]).clusters,
    ).toHaveLength(0);

    const highOverlap = buildCollisionReport(REPO.fullName, [], [
      { ...pr(REPO.fullName, 3, "upload retry client handler service"), authorLogin: "alice", changedFiles: ["src/core/upload.ts"] },
      { ...pr(REPO.fullName, 4, "upload retry service handler client"), authorLogin: "bob", changedFiles: ["src/core/upload.ts"] },
    ]);
    expect(highOverlap.clusters.some((c) => c.risk === "high")).toBe(true);

    const sharedIssuePair = buildCollisionReport(
      REPO.fullName,
      [{ repoFullName: REPO.fullName, number: 7, title: "Issue", state: "open", labels: [], linkedPrs: [], authorLogin: "r" }],
      [
        { ...pr(REPO.fullName, 5, "A"), linkedIssues: [7] },
        { ...pr(REPO.fullName, 6, "B"), linkedIssues: [7] },
      ],
    );
    expect(sharedIssuePair.clusters.length).toBeGreaterThan(0);

    const pairwiseSharedIssue = buildCollisionReport(REPO.fullName, [], [
      { ...pr(REPO.fullName, 8, "First"), linkedIssues: [42] },
      { ...pr(REPO.fullName, 9, "Second"), linkedIssues: [42] },
    ]);
    expect(pairwiseSharedIssue.clusters.some((c) => c.reason.includes("same linked issue"))).toBe(true);

    const recentMergedSharedIssue = buildCollisionReport(
      REPO.fullName,
      [],
      [{ ...pr(REPO.fullName, 10, "Open overlap"), linkedIssues: [55], changedFiles: ["src/auth.ts"] }],
      [{ repoFullName: REPO.fullName, number: 88, title: "Merged overlap", authorLogin: "bob", labels: [], linkedIssues: [55], changedFiles: ["src/auth.ts"] }],
    );
    expect(recentMergedSharedIssue.clusters.some((c) => c.risk === "medium")).toBe(true);

    const recentMergedNoLinks = buildCollisionReport(
      REPO.fullName,
      [],
      [{ ...pr(REPO.fullName, 13, "upload retry client handler"), authorLogin: "alice", changedFiles: ["src/core/upload.ts"] }],
      [{ repoFullName: REPO.fullName, number: 90, title: "upload retry service handler", authorLogin: "bob", labels: [], linkedIssues: [], changedFiles: ["src/core/upload.ts"] }],
    );
    expect(recentMergedNoLinks.clusters.length).toBeGreaterThan(0);

    const selfAuthoredPathOverlap = buildCollisionReport(REPO.fullName, [], [
      { ...pr(REPO.fullName, 14, "qwerty alpha"), authorLogin: "alice", changedFiles: ["src/services/upload/retry.ts"] },
      { ...pr(REPO.fullName, 15, "asdf beta"), authorLogin: "alice", changedFiles: ["src/services/upload/retry.ts"] },
    ]);
    const differentLinkedIssues = buildCollisionReport(REPO.fullName, [], [
      { ...pr(REPO.fullName, 16, "upload retry client handler"), authorLogin: "alice", linkedIssues: [1], changedFiles: ["src/core/upload.ts"] },
      { ...pr(REPO.fullName, 17, "upload retry service handler"), authorLogin: "bob", linkedIssues: [2], changedFiles: ["src/core/upload.ts"] },
    ]);
    expect(differentLinkedIssues.clusters.length).toBeGreaterThan(0);
  });

  it("exercises readiness and queue-pressure component branches", () => {
    const internals = predictedGateEngineInternals;
    expect(internals.reviewLoadComponentScore("low")).toBe(20);
    expect(internals.reviewLoadComponentScore("medium")).toBe(14);
    expect(internals.reviewLoadComponentScore("high")).toBe(8);
    expect(internals.changeScopeEvidence({ ...pr(REPO.fullName, 1, "Fix"), labels: ["size:L"], isDraft: true, linkedIssues: [7] }, "high")).toContain("size label");
    expect(internals.changeScopeEvidence({ ...pr(REPO.fullName, 2, "Fix"), labels: [], linkedIssues: [] }, "low")).toContain("no linked issue");

    const holdPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: [] },
      { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 0 } },
      [],
      [],
      [],
      null,
      false,
    );
    expect(internals.validationComponent({ ...pr(REPO.fullName, 3, "Fix"), body: "npm test passed" }, holdPreflight).score).toBe(5);
    expect(internals.validationComponent({ ...pr(REPO.fullName, 4, "Fix"), body: "npm test passed" }, { ...holdPreflight, status: "needs_work", findings: [{ code: "missing_test_evidence", severity: "warning", title: "t", detail: "d" }] }).score).toBe(12);
    expect(
      internals.validationComponent({ ...pr(REPO.fullName, 31, "Fix"), body: "no validation note" }, {
        ...holdPreflight,
        status: "needs_work",
        findings: [{ code: "missing_test_evidence", severity: "warning", title: "t", detail: "d" }],
      }).score,
    ).toBe(10);

    const emptyQueue = internals.queuePressureComponent({
      repoFullName: REPO.fullName,
      generatedAt: "2026-01-01T00:00:00.000Z",
      burdenScore: 0,
      level: "low",
      summary: "s",
      signals: { openIssues: 0, openPullRequests: 0, unlinkedPullRequests: 0, stalePullRequests: 0, draftPullRequests: 0, maintainerAuthoredPullRequests: 0, collisionClusters: 0, ageBuckets: { under7Days: 0, days7To30: 0, over30Days: 0 }, likelyReviewablePullRequests: 0, cachedOpenPullRequests: 0, likelyReviewablePullRequestsSource: "cache" },
      findings: [],
    });
    expect(emptyQueue.evidence).toContain("0 likely reviewable");

    const sampledQueue = buildQueueHealth(REPO, [], [{ ...pr(REPO.fullName, 8, "Open"), linkedIssues: [7] }], buildCollisionReport(REPO.fullName, [], []), { openPullRequests: 40 });
    expect(internals.queuePressureComponent(sampledQueue).evidence).toContain("sampled");

    expect(
      internals.queuePressureComponent({
        repoFullName: REPO.fullName,
        generatedAt: "2026-01-01T00:00:00.000Z",
        burdenScore: 0,
        level: "low",
        summary: "s",
        signals: {
          openIssues: 0,
          openPullRequests: 12,
          unlinkedPullRequests: 0,
          stalePullRequests: 0,
          draftPullRequests: 0,
          maintainerAuthoredPullRequests: 0,
          collisionClusters: 0,
          ageBuckets: { under7Days: 2, days7To30: 1, over30Days: 0 },
          likelyReviewablePullRequests: 2,
          likelyReviewablePullRequestsSource: undefined,
        },
        findings: [],
      }).evidence,
    ).toContain("sampled");

    expect(
      internals.queuePressureComponent({
        repoFullName: REPO.fullName,
        generatedAt: "2026-01-01T00:00:00.000Z",
        burdenScore: 0,
        level: "low",
        summary: "s",
        signals: {
          openIssues: 0,
          openPullRequests: 5,
          unlinkedPullRequests: 0,
          stalePullRequests: 0,
          draftPullRequests: 0,
          maintainerAuthoredPullRequests: 0,
          collisionClusters: 0,
          ageBuckets: { under7Days: 0, days7To30: 0, over30Days: 0 },
          likelyReviewablePullRequests: 0,
          likelyReviewablePullRequestsSource: "sampled_cache",
        },
        findings: [],
      }).evidence,
    ).toContain("unavailable");

    expect(internals.queuePressureOpenPullRequestScore(0)).toBe(10);
    expect(internals.queuePressureOpenPullRequestScore(6)).toBe(8);
    expect(internals.queuePressureOpenPullRequestScore(10)).toBe(5);
    expect(internals.queuePressureOpenPullRequestScore(20)).toBe(3);

    expect(internals.extractLinkedIssueNumbers("closes other/repo#9", REPO.fullName)).not.toContain(9);
    expect(internals.extractLinkedIssueNumbers(`closes ${REPO.fullName}#9`, REPO.fullName)).toContain(9);

    const issueQuality: IssueQualityReport = {
      repoFullName: REPO.fullName,
      generatedAt: "2026-01-01T00:00:00.000Z",
      lane: { lane: "direct_pr", repoFullName: REPO.fullName, summary: "s", contributorGuidance: "s", maintainerGuidance: "s" },
      summary: "s",
      issues: [{ number: 7, title: "Issue", status: "ready", score: 100, reasons: [], warnings: [] }],
    };
    const overlapPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Resolve login redirect loop OAuth callback handler", body: "", changedFiles: ["src/auth.ts"], linkedIssues: [] },
      REPO,
      [{ repoFullName: REPO.fullName, number: 51, title: "Login redirect loop OAuth cleanup", state: "open", labels: [], linkedPrs: [] }],
      [{ ...pr(REPO.fullName, 52, "Login redirect loop OAuth middleware"), changedFiles: ["src/auth.ts"] }],
    );
    const readiness = buildPublicReadinessScore({
      pr: { ...pr(REPO.fullName, 9, "Fix"), body: "Validation: npm test", labels: ["size:large"], isDraft: true, linkedIssues: [7] },
      preflight: { ...overlapPreflight, status: "ready", reviewBurden: "medium", findings: [] },
      queueHealth: buildQueueHealth(REPO, [], [{ ...pr(REPO.fullName, 10, "Stale"), linkedIssues: [], updatedAt: "2000-01-01T00:00:00.000Z" }], buildCollisionReport(REPO.fullName, [], []), { openPullRequests: 15, likelyReviewablePullRequests: 3 }),
    });
    expect(readiness.total).toBeGreaterThan(0);
    expect(buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] }, REPO, [], [], [], issueQuality).findings.map((f) => f.code)).not.toContain("issue_quality_do_not_use");

    const staleDraftOnlyCreatedAt = buildQueueHealth(
      REPO,
      [],
      [{ ...pr(REPO.fullName, 77, "Draft only createdAt"), isDraft: true, updatedAt: undefined, createdAt: "2000-01-01T00:00:00.000Z" }],
      buildCollisionReport(REPO.fullName, [], []),
    );
    expect(staleDraftOnlyCreatedAt.findings.some((f) => f.code === "inactive_draft_prs")).toBe(true);

    const lowBurdenQueue = buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], []));
    expect(lowBurdenQueue.level).toBe("low");
    const mediumQueue = buildQueueHealth(
      REPO,
      [],
      [1, 2, 3].map((number) => pr(REPO.fullName, number, `Unlinked ${number}`, { linkedIssues: [] })),
      buildCollisionReport(REPO.fullName, [], []),
    );
    expect(mediumQueue.level).toBe("medium");
    const highQueue = buildQueueHealth(
      REPO,
      [],
      [1, 2, 3, 4].map((number) => pr(REPO.fullName, number, `Unlinked ${number}`, { linkedIssues: [] })),
      buildCollisionReport(REPO.fullName, [], []),
    );
    expect(highQueue.level).toBe("high");
    const criticalStale = [44, 45, 46, 47].map((number) =>
      pr(REPO.fullName, number, `Stale ${number}`, { linkedIssues: [], updatedAt: "2000-01-01T00:00:00.000Z" }),
    );
    expect(buildQueueHealth(REPO, [], criticalStale, buildCollisionReport(REPO.fullName, [], criticalStale)).level).toBe("critical");

    const bodyLinkedIssues = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: `closes ${REPO.fullName}#12 and fixes #8`, changedFiles: ["src/a.ts"] },
      REPO,
      [],
      [],
    );
    expect(bodyLinkedIssues.linkedIssues).toEqual([8, 12]);
    const mergedLinkedIssues = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "closes #5", linkedIssues: [3], changedFiles: ["src/a.ts"] },
      REPO,
      [],
      [],
    );
    expect(mergedLinkedIssues.linkedIssues).toEqual([3, 5]);
  });

  it("exercises codecov-critical helper and gate-evaluation branches", () => {
    const finding = (code: string) => ({ code, severity: "warning" as const, title: code, detail: code });
    const advisoryBase = {
      id: "a",
      targetType: "pull_request" as const,
      targetKey: "k",
      repoFullName: REPO.fullName,
      conclusion: "success" as const,
      severity: "info" as const,
      title: "t",
      summary: "s",
      generatedAt: "2026-01-01T00:00:00.000Z",
      findings: [] as Array<{ code: string; severity: "warning" | "critical"; title: string; detail: string; action?: string }>,
    };
    const policyBlockers = evaluateGateCheck(
      {
        ...advisoryBase,
        findings: [
          finding(REVIEW_THREAD_BLOCKER_CODE),
          { code: "secret_leak", severity: "critical", title: "secret", detail: "secret", action: "rotate" },
          finding("ai_review_split"),
        ],
      },
      { aiReviewGateMode: "block" },
    );
    expect(policyBlockers.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([REVIEW_THREAD_BLOCKER_CODE, "secret_leak", "ai_review_split"]),
    );

    expect(termOverlap({ terms: new Set(), size: 0 }, { terms: new Set(["alpha"]), size: 1 }).score).toBe(0);
    expect(termOverlap({ terms: new Set(["alpha"]), size: 1 }, { terms: new Set(), size: 0 }).score).toBe(0);
    expect(predictedGateEngineInternals.truncateText("short", 10)).toBe("short");
    expect(predictedGateEngineInternals.truncateText("x".repeat(20), 10)).toHaveLength(10);
    expect(predictedGateEngineInternals.sharesMeaningfulFile([], ["src/a.ts"])).toBe(false);
    expect(predictedGateEngineInternals.sharesMeaningfulFile(["src/a.ts"], [])).toBe(false);

    const issue = { repoFullName: REPO.fullName, number: 1, title: "Issue", state: "open" as const, labels: [], linkedPrs: [] };
    expect(classifyBountyLifecycle({ id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "  ", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, issue)).toBe("unknown");
    expect(classifyBountyLifecycle({ id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "archived bounty", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, issue)).toBe("historical");
    expect(classifyBountyLifecycle({ id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "mystery", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, issue)).toBe("ambiguous");

    const selfAuthored = buildPullRequestAdvisory(
      REPO,
      {
        ...pr(REPO.fullName, 1, "Fix"),
        authorLogin: "alice",
        linkedIssues: [7],
      },
      { linkedIssueAuthorLogins: ["alice"] },
    );
    expect(selfAuthored.findings.some((f) => f.code === "self_authored_linked_issue")).toBe(true);

    const readiness = buildPublicReadinessScore({
      pr: { ...pr(REPO.fullName, 2, "Fix"), body: "No issue because docs-only typo", linkedIssues: [] },
      preflight: buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "No issue because docs-only typo", linkedIssues: [], changedFiles: ["README.md"] }, REPO, [], []),
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
    });
    expect(readiness.components.find((c) => c.key === "traceability")?.evidence).toContain("no-issue rationale");

    const withIdentifiers = gateAdvisoryInternals.advisory(
      "pull_request",
      "acme/widgets#1",
      REPO.fullName,
      [],
      "summary",
      1,
      7,
      "sha123",
    );
    expect(withIdentifiers.pullNumber).toBe(1);
    expect(withIdentifiers.issueNumber).toBe(7);
    expect(withIdentifiers.headSha).toBe("sha123");

    const overflowGuardrail = gateAdvisoryInternals.buildGuardrailHoldFinding(
      Array.from({ length: 6 }, (_, index) => ({ path: `src/file-${index}.ts`, glob: "src/**" })),
    );
    expect(overflowGuardrail.detail).toContain("and 1 more");

    const issueDiscoveryLane = buildLaneAdvice(
      { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 1, issueDiscoveryShare: 1 } },
      REPO.fullName,
    );
    expect(issueDiscoveryLane.lane).toBe("issue_discovery");

    const openReady = buildPublicReadinessScore({
      pr: { ...pr(REPO.fullName, 3, "Fix"), state: "open", isDraft: false, linkedIssues: [7] },
      preflight: buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"] }, REPO, [], []),
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
    });
    expect(openReady.components.find((c) => c.key === "pr_state")?.score).toBe(10);

    const openDraft = buildPublicReadinessScore({
      pr: { ...pr(REPO.fullName, 4, "Fix"), state: "open", isDraft: true, linkedIssues: [7, 8] },
      preflight: buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7, 8], changedFiles: ["src/a.ts"] }, REPO, [], []),
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
    });
    expect(openDraft.components.find((c) => c.key === "pr_state")?.score).toBe(6);
    expect(openDraft.components.find((c) => c.key === "change_scope")?.evidence).toContain("2 linked issues");

    const closedPr = buildPublicReadinessScore({
      pr: { ...pr(REPO.fullName, 5, "Fix"), state: "closed", isDraft: false, linkedIssues: [7] },
      preflight: buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"] }, REPO, [], []),
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
    });
    expect(closedPr.components.find((c) => c.key === "pr_state")?.score).toBe(3);
    expect(closedPr.components.find((c) => c.key === "change_scope")?.evidence).toContain("1 linked issue");
  });

  it("covers lane_not_recommended maintainer branches and scoped overlap pluralization", () => {
    const inactiveRepo = { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 0 } };
    const maintainerLane = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "Closes #7", linkedIssues: [7], authorAssociation: "OWNER" },
      inactiveRepo,
      [],
      [],
    );
    const contributorLane = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "Closes #7", linkedIssues: [7], authorAssociation: "CONTRIBUTOR" },
      inactiveRepo,
      [],
      [],
    );
    expect(maintainerLane.findings.find((finding) => finding.code === "lane_not_recommended")).toMatchObject({
      severity: "info",
      title: "Repo lane unavailable for contributor scoring",
      detail: expect.stringContaining("Maintainer-authored work is treated as repo stewardship"),
      action: "No action.",
    });
    expect(contributorLane.findings.find((finding) => finding.code === "lane_not_recommended")).toMatchObject({
      severity: "warning",
      title: "Repo lane is not ready for a confident recommendation",
      action: "Refresh registry data or choose a registered active repo.",
    });

    const missingRepo = { ...REPO, isRegistered: false, registryConfig: null };
    const ownerUnknownLane = buildPreflightResult(
      { repoFullName: missingRepo.fullName, title: "Fix", body: "Closes #7", linkedIssues: [7], authorAssociation: "OWNER" },
      missingRepo,
      [],
      [],
      [],
      null,
      true,
    );
    const outsideUnknownLane = buildPreflightResult(
      { repoFullName: missingRepo.fullName, title: "Fix", body: "Closes #7", linkedIssues: [7], authorAssociation: "CONTRIBUTOR" },
      missingRepo,
      [],
      [],
      [],
      null,
      true,
    );
    expect(ownerUnknownLane.findings.find((finding) => finding.code === "lane_not_recommended")?.severity).toBe("info");
    expect(outsideUnknownLane.findings.find((finding) => finding.code === "lane_not_recommended")?.severity).toBe("warning");

    const preflight = buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"] }, REPO, [], []);
    const singularOverlap = buildPublicReadinessScore({
      pr: { ...pr(REPO.fullName, 6, "Fix"), linkedIssues: [7] },
      preflight,
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
      scopedOverlapCount: 1,
      linkedDuplicatePrs: [],
    });
    const pluralOverlap = buildPublicReadinessScore({
      pr: { ...pr(REPO.fullName, 7, "Fix"), linkedIssues: [7] },
      preflight,
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
      scopedOverlapCount: 2,
      linkedDuplicatePrs: [],
    });
    expect(singularOverlap.components.find((component) => component.key === "related_work")?.evidence).toBe("1 scoped overlap found.");
    expect(pluralOverlap.components.find((component) => component.key === "related_work")?.evidence).toBe("2 scoped overlaps found.");
  });
});

function repo(fullName: string, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    registryConfig: {
      repo: fullName,
      emissionShare: 1,
      issueDiscoveryShare: 0,
      labelMultipliers: {},
      maintainerCut: 0,
      raw: {},
      ...overrides,
    },
  };
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "dev",
    labels: [],
    linkedIssues: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
