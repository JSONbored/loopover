import { describe, expect, it } from "vitest";

import { evaluateGateCheck, buildPullRequestAdvisory, gateAdvisoryInternals } from "../../packages/gittensory-engine/src/advisory/gate-advisory";
import { buildFocusManifestGuidance, isFocusManifestPublicSafe, matchesManifestPath } from "../../packages/gittensory-engine/src/focus-manifest/guidance";
import { sanitizePublicComment } from "../../packages/gittensory-engine/src/github/sanitize-public-comment";
import {
  CLA_CHECK_UNRESOLVED_CODE,
  CLA_CONSENT_MISSING_CODE,
  evaluateClaCheck,
  type ClaCheckConfig,
} from "../../packages/gittensory-engine/src/review/cla-check";
import { evaluatePreMergeChecks, PRE_MERGE_CHECK_ADVISORY_CODE, PRE_MERGE_CHECK_BLOCKING_CODE, PRE_MERGE_CHECK_UNRESOLVED_CODE } from "../../packages/gittensory-engine/src/review/pre-merge-checks";
import { REVIEW_THREAD_BLOCKER_CODE } from "../../packages/gittensory-engine/src/review/review-thread-findings";
import { diffFilePriority } from "../../packages/gittensory-engine/src/review/diff-file-priority";
import {
  clearLabelPatternRegExpCacheForTest,
  LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES,
  labelMatchesPattern,
  labelPatternRegExpCacheKeysForTest,
} from "../../packages/gittensory-engine/src/scoring/label-match";
import {
  changedPathsHittingGuardrail,
  globToRegExp,
  guardrailPathMatches,
  isGuardrailHit,
  matchesAny,
} from "../../packages/gittensory-engine/src/signals/change-guardrail";
import { isDuplicateClusterWinner, isDuplicateClusterWinnerByClaim, resolveDuplicateClusterWinnerNumber } from "../../packages/gittensory-engine/src/signals/duplicate-winner";
import { buildCollisionReport, buildPreflightResult, buildPublicReadinessScore, buildQueueHealth, classifyBountyLifecycle, itemSharesPlannedLinkedIssue, predictedGateEngineInternals, termOverlap, unionScopedOverlapClusters } from "../../packages/gittensory-engine/src/signals/predicted-gate-engine";
import type { CollisionItem, FocusManifest, IssueQualityReport, PreMergeCheck, PullRequestRecord, RepositoryRecord } from "../../packages/gittensory-engine/src/types/predicted-gate-types";

const REPO: RepositoryRecord = {
  fullName: "acme/widgets",
  owner: "acme",
  name: "widgets",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "acme/widgets",
    emissionShare: 1,
    issueDiscoveryShare: 0,
    labelMultipliers: { "type:*": 1.2, bug: 1.1 },
    maintainerCut: 0,
    raw: {},
  },
};

const PR: PullRequestRecord = {
  repoFullName: "acme/widgets",
  number: 9,
  title: "Fix upload retries",
  state: "open",
  authorLogin: "miner1",
  labels: ["type:bug-fix", "bug"],
  linkedIssues: [7],
};

const claConfig = (over: Partial<ClaCheckConfig> = {}): ClaCheckConfig => ({
  consentPhrase: null,
  checkRunName: null,
  ...over,
});

const preMergeCheck = (over: Partial<PreMergeCheck> = {}): PreMergeCheck => ({
  name: "Check",
  whenPaths: [],
  titleContains: null,
  descriptionContains: null,
  requireLabel: null,
  enforce: false,
  ...over,
});

describe("predicted-gate engine module coverage (#2283)", () => {
  it("mirrors scoring label matcher semantics through the engine copy", () => {
    expect(labelMatchesPattern("type:bug-fix", "type:*")).toBe(true);
    expect(labelMatchesPattern("kind:chore", "type:*")).toBe(false);
    expect(labelMatchesPattern("Priority:1", "priority:?")).toBe(true);
    expect(labelMatchesPattern("priority:10", "priority:?")).toBe(false);
    expect(labelMatchesPattern("kind/bug", "kind/[bc]ug")).toBe(true);
    expect(labelMatchesPattern("kind/dug", "kind/[!bc]ug")).toBe(true);
    expect(labelMatchesPattern("^ug", "[^x]ug")).toBe(true);
    expect(labelMatchesPattern("bug", "[^x]ug")).toBe(false);
    expect(labelMatchesPattern("x", "[z-a]")).toBe(false);
    expect(labelMatchesPattern("[bug", "[bug")).toBe(true);
    expect(labelMatchesPattern("m", "[a-z-9]")).toBe(true);
    expect(labelMatchesPattern("5", "[!a-z-9]")).toBe(true);
    expect(labelMatchesPattern("type-bug-fix", "type-*-*")).toBe(true);
    expect(labelMatchesPattern("a-b-c-final", "*-*-*-final")).toBe(false);
    expect(labelMatchesPattern("x", "[!]")).toBe(false);
    expect(labelMatchesPattern("a.b", "a.b")).toBe(true);
  });

  it("bounds the memoized label pattern cache and evicts least-recently-used entries", () => {
    clearLabelPatternRegExpCacheForTest();
    for (let i = 0; i < LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES; i += 1) {
      expect(labelMatchesPattern(`kind:${i}`, `kind:${i}`)).toBe(true);
    }
    expect(labelPatternRegExpCacheKeysForTest()).toHaveLength(LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES);
    expect(labelMatchesPattern("kind:0", "kind:0")).toBe(true);
    expect(labelMatchesPattern("kind:overflow", "kind:overflow")).toBe(true);
    expect(labelPatternRegExpCacheKeysForTest()).toContain("kind:0");
    expect(labelPatternRegExpCacheKeysForTest()).not.toContain("kind:1");
    clearLabelPatternRegExpCacheForTest();
  });

  it("exercises duplicate-winner election helpers", () => {
    expect(isDuplicateClusterWinnerByClaim({ number: 1, createdAt: "2026-01-01T00:00:00.000Z" }, [{ number: 2, createdAt: "2026-01-02T00:00:00.000Z" }])).toBe(true);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 2, linkedIssueClaimedAt: "2026-01-02T00:00:00.000Z" },
        [{ number: 1, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" }],
      ),
    ).toBe(false);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 3, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" },
        [{ number: 2, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" }],
      ),
    ).toBe(false);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
        [{ number: 2, createdAt: "2026-01-01T00:00:00.000Z" }],
      ),
    ).toBe(true);
    expect(resolveDuplicateClusterWinnerNumber({ number: 2, createdAt: "2026-01-02T00:00:00.000Z" }, [{ number: 1, createdAt: "2026-01-01T00:00:00.000Z" }])).toBe(1);
    expect(resolveDuplicateClusterWinnerNumber({ number: 1, createdAt: null }, [{ number: 2, createdAt: null }])).toBeNull();
  });

  it("exercises diff-file priority tiers and guardrail glob helpers", () => {
    expect(diffFilePriority("src/app.ts")).toBe(0);
    expect(diffFilePriority("src/app.test.ts")).toBe(1);
    expect(diffFilePriority("README.md")).toBe(2);
    expect(diffFilePriority("package-lock.json")).toBe(4);
    expect(diffFilePriority("dist/bundle.js")).toBe(4);
    expect(globToRegExp("src/**/model.ts").test("src/a/deep/model.ts")).toBe(true);
    expect(globToRegExp("public/**/*.json").test("public/release/config.json")).toBe(true);
    expect(matchesAny("completely/unrelated.md", ["*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*"])).toBe(true);
    expect(changedPathsHittingGuardrail(["src/a.ts"], [])).toEqual([]);
    expect(isGuardrailHit(["docs/readme.md"], ["scripts/**"])).toBe(false);
    expect(matchesManifestPath("", "src/**")).toBe(false);
    expect(matchesManifestPath("src/a.ts", "")).toBe(false);
    expect(matchesManifestPath("src/nested/a.ts", "src/")).toBe(true);
    expect(isFocusManifestPublicSafe("wallet hotkey farming")).toBe(false);
    expect(isFocusManifestPublicSafe("Keep changes focused.")).toBe(true);
  });

  it("exercises guardrail path matching", () => {
    expect(isGuardrailHit([".github/workflows/ci.yml"], [".github/workflows/*"])).toBe(true);
    expect(guardrailPathMatches([".github/workflows/ci.yml"], [".github/workflows/*"])).toEqual([
      { path: ".github/workflows/ci.yml", glob: ".github/workflows/*" },
    ]);
  });

  it("exercises sanitizePublicComment redaction paths", () => {
    expect(sanitizePublicComment("score estimate 12.5 -> 41.2")).toContain("private context");
    expect(sanitizePublicComment("reviewability internals")).toContain("private context");
    expect(sanitizePublicComment("@gittensory reviewability score")).toContain("reviewability");
    expect(sanitizePublicComment("likely_duplicate overlap")).toContain("possible overlap");
    expect(sanitizePublicComment("open pr count 12 exceeds threshold 10")).toContain("private context");
  });

  it("exercises focus-manifest guidance branches", () => {
    const manifest: FocusManifest = {
      present: true,
      source: "repo_file",
      wantedPaths: ["src/"],
      preferredLabels: ["bug"],
      linkedIssuePolicy: "required",
      testExpectations: ["npm test"],
      issueDiscoveryPolicy: "discouraged",
      maintainerNotes: [],
      publicNotes: ["Keep changes focused."],
      gate: { present: true } as FocusManifest["gate"],
      settings: {},
      review: { present: true, preMergeChecks: [] },
      warnings: [],
    };
    const offFocus = buildFocusManifestGuidance({ manifest, changedPaths: ["docs/readme.md"], labels: [], linkedIssueCount: 0, testFileCount: 0 });
    expect(offFocus.findings.some((f) => f.code === "manifest_off_focus")).toBe(true);
    expect(offFocus.findings.some((f) => f.code === "manifest_linked_issue_required")).toBe(true);
    expect(offFocus.findings.some((f) => f.code === "manifest_issue_discovery_discouraged")).toBe(true);
    const aligned = buildFocusManifestGuidance({ manifest, changedPaths: ["src/a.ts"], labels: ["bug"], linkedIssueCount: 1, testFileCount: 1 });
    expect(aligned.findings.some((f) => f.code === "manifest_preferred_path")).toBe(true);
  });

  it("exercises pre-merge unresolved path-gated checks", () => {
    const findings = evaluatePreMergeChecks(
      [{ name: "migrations", whenPaths: ["migrations/**"], titleContains: null, descriptionContains: null, requireLabel: null, enforce: true }],
      { title: "x", body: "y", labels: [], changedPaths: [], filesResolved: false },
    );
    expect(findings[0]?.code).toBe(PRE_MERGE_CHECK_UNRESOLVED_CODE);
  });

  it("exercises preflight bounty and issue-quality branches", () => {
    const issueQuality: IssueQualityReport = {
      repoFullName: "acme/widgets",
      generatedAt: "2026-01-01T00:00:00.000Z",
      lane: { lane: "direct_pr", repoFullName: "acme/widgets", summary: "ok", contributorGuidance: "ok", maintainerGuidance: "ok" },
      issues: [{ number: 7, title: "Issue", status: "do_not_use", score: 0, reasons: [], warnings: ["already solved"] }],
      summary: "hold",
    };
    const preflight = buildPreflightResult(
      { repoFullName: "acme/widgets", title: "Fix", body: "Closes #7", linkedIssues: [7], changedFiles: ["src/a.ts"] },
      REPO,
      [],
      [],
      [{ id: "b1", repoFullName: "acme/widgets", issueNumber: 7, status: "completed", payload: {} }],
      issueQuality,
    );
    expect(preflight.findings.some((f) => f.code === "issue_quality_do_not_use")).toBe(true);
    expect(preflight.findings.some((f) => f.code === "linked_issue_bounty_historical")).toBe(true);
  });

  it("exercises advisory label context and dry-run displayConclusion", () => {
    const advisory = buildPullRequestAdvisory(REPO, PR);
    expect(advisory.findings.some((f) => f.code === "label_context_found")).toBe(true);
    const dry = evaluateGateCheck(advisory, { dryRun: true, duplicatePrGateMode: "advisory", linkedIssueGateMode: "advisory", aiReviewGateMode: "advisory" });
    expect(dry.displayConclusion).toBeDefined();
  });

  it("exercises advisory edge cases and gate failures", () => {
    const missingRepo = buildPullRequestAdvisory(null, PR);
    expect(missingRepo.findings.some((f) => f.code === "repo_not_registered")).toBe(true);
    const missingPr = buildPullRequestAdvisory(REPO, null);
    expect(missingPr.findings.some((f) => f.code === "pr_not_cached")).toBe(true);
    const blocked = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "duplicate_pr_risk", severity: "warning", title: "dup", detail: "dup" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { duplicatePrGateMode: "block" },
    );
    expect(blocked.conclusion).toBe("failure");
  });

  it("exercises deprecated duplicate winner helper and lane advice branches", () => {
    expect(isDuplicateClusterWinner(1, [2, 3])).toBe(true);
    expect(isDuplicateClusterWinner(3, [1, 2])).toBe(false);
    const inactive = buildPreflightResult(
      { repoFullName: "acme/widgets", title: "Fix", body: "Closes #7", linkedIssues: [7] },
      { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 0 } },
      [],
      [],
    );
    expect(inactive.lane.lane).toBe("inactive");
  });

  it("exercises manifest globstar path matching", () => {
    const manifest: FocusManifest = {
      present: true,
      source: "repo_file",
      wantedPaths: ["**/safe.ts"],
      preferredLabels: [],
      linkedIssuePolicy: "optional",
      testExpectations: [],
      issueDiscoveryPolicy: "neutral",
      maintainerNotes: [],
      publicNotes: [],
      gate: { present: true } as FocusManifest["gate"],
      settings: {},
      review: { present: true, preMergeChecks: [] },
      warnings: [],
    };
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["safe.ts", "nested/safe.ts"], linkedIssueCount: 1, testFileCount: 1 });
    expect(guidance.matchedWantedPaths.length).toBeGreaterThan(0);
  });

  it("exercises lane, collision, queue, and preflight edge branches", () => {
    const issueDiscoveryRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 1, emissionShare: 1 },
    };
    const splitRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 0.5, emissionShare: 1 },
    };
    const discoveryPreflight = buildPreflightResult({ repoFullName: REPO.fullName, title: "Report issue", body: "", linkedIssues: [] }, issueDiscoveryRepo, [], []);
    expect(discoveryPreflight.lane.lane).toBe("issue_discovery");
    const splitPreflight = buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "Closes #7", linkedIssues: [7] }, splitRepo, [], []);
    expect(splitPreflight.lane.lane).toBe("split");

    const collisions = buildCollisionReport(
      REPO.fullName,
      [],
      [
        { ...PR, number: 1, authorLogin: "alice", title: "retry upload client", changedFiles: ["src/upload.ts"] },
        { ...PR, number: 2, authorLogin: "alice", title: "retry upload service", changedFiles: ["src/upload.ts"] },
        { ...PR, number: 3, authorLogin: "bob", title: "totally different", changedFiles: ["src/upload.ts"] },
        { ...PR, number: 4, authorLogin: "carol", title: "totally different too", changedFiles: ["src/upload.ts"] },
      ],
    );
    expect(collisions.clusters.length).toBeGreaterThan(0);

    const queue = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Big change", body: "", linkedIssues: [7, 8], changedFiles: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`) },
      REPO,
      [],
      [
        { ...PR, number: 11, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true },
        { ...PR, number: 12, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z" },
      ],
      [{ id: "b2", repoFullName: REPO.fullName, issueNumber: 7, status: "stale bounty", payload: {} }],
      {
        repoFullName: REPO.fullName,
        generatedAt: "2026-01-01T00:00:00.000Z",
        lane: splitPreflight.lane,
        issues: [
          { number: 7, title: "Issue", status: "needs_proof", score: 0, reasons: [], warnings: ["needs proof"] },
          { number: 8, title: "Issue2", status: "hold", score: 0, reasons: [], warnings: ["hold"] },
        ],
        summary: "x",
      },
    );
    expect(queue.findings.some((f) => f.code === "missing_test_evidence")).toBe(true);
    expect(queue.findings.some((f) => f.code === "linked_issue_bounty_unverified")).toBe(true);
    expect(queue.findings.some((f) => f.code === "issue_quality_needs_proof")).toBe(true);
    expect(queue.findings.some((f) => f.code === "issue_quality_hold")).toBe(true);

    const collisionsForQueue = buildCollisionReport(REPO.fullName, [], [{ ...PR, number: 11, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true }]);
    const queueHealth = buildQueueHealth(REPO, [], [{ ...PR, number: 11, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true }], collisionsForQueue);
    expect(queueHealth.findings.some((f) => f.code === "unlinked_prs")).toBe(true);
    expect(queueHealth.findings.some((f) => f.code === "inactive_draft_prs")).toBe(true);
  });

  it("exercises gate holds, readiness score branches, and linked-issue advisory paths", () => {
    const advisory = buildPullRequestAdvisory(REPO, PR, { requireLinkedIssue: true, confirmedNoOpenLinkedIssue: true, linkedIssueAuthorLogins: ["miner1"] });
    expect(advisory.findings.some((f) => f.code === "missing_linked_issue")).toBe(true);
    expect(advisory.findings.some((f) => f.code === "self_authored_linked_issue")).toBe(true);
    const guardrailHold = evaluateGateCheck(
      { id: "a", targetType: "pull_request", targetKey: "k", repoFullName: REPO.fullName, conclusion: "success", severity: "info", title: "t", summary: "s", findings: [], generatedAt: "2026-01-01T00:00:00.000Z" },
      { guardrailHit: true, guardrailMatches: [{ path: "src/a.ts", glob: "src/*" }], sizeGateMode: "advisory", changedFileCount: 20, changedLineCount: 2000 },
    );
    expect(guardrailHold.conclusion).toBe("neutral");
    const preflight = buildPreflightResult({ repoFullName: REPO.fullName, title: "No issue docs only", body: "docs-only change", linkedIssues: [] }, REPO, [], []);
    const readiness = buildPublicReadinessScore({
      pr: { ...PR, isDraft: true, body: "docs-only change", linkedIssues: [] },
      preflight,
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
      scopedOverlapCount: 2,
      linkedDuplicatePrs: [42],
    });
    expect(readiness.total).toBeGreaterThan(0);
    const slopBlocked = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "slop_risk_above_threshold", severity: "warning", title: "slop", detail: "slop" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { slopGateMode: "block", slopRisk: 90, slopGateMinScore: 60 },
    );
    expect(slopBlocked.blockers.some((b) => b.code === "slop_risk_above_threshold")).toBe(true);
  });

  it("exercises remaining advisory, duplicate-winner, and manifest branches", () => {
    const discoveryOnlyRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 1, maintainerCut: 1 },
    };
    const directOnlyRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 0, maintainerCut: 0 },
    };
    expect(buildPullRequestAdvisory(discoveryOnlyRepo, PR).findings.some((f) => f.code === "direct_pr_pool_disabled")).toBe(true);
    expect(buildPullRequestAdvisory(directOnlyRepo, PR).findings.some((f) => f.code === "issue_discovery_disabled")).toBe(true);
    expect(buildPullRequestAdvisory(directOnlyRepo, PR).findings.some((f) => f.code === "maintainer_cut_enabled")).toBe(false);
    expect(buildPullRequestAdvisory(discoveryOnlyRepo, PR).findings.some((f) => f.code === "maintainer_cut_enabled")).toBe(true);

    const busy = buildPullRequestAdvisory(
      REPO,
      PR,
      { otherOpenPullRequests: Array.from({ length: 10 }, (_, i) => ({ ...PR, number: i + 20 })) },
    );
    expect(busy.findings.some((f) => f.code === "busy_pr_queue")).toBe(true);
    expect(buildPullRequestAdvisory(REPO, { ...PR, authorAssociation: "OWNER" }).findings.some((f) => f.code === "maintainer_authored_pr")).toBe(true);

    const aiBlocked = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "ai_consensus_defect", severity: "warning", title: "ai", detail: "ai" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { aiReviewGateMode: "block", aiReviewCloseConfidence: 0.5 },
    );
    expect(aiBlocked.conclusion).toBe("failure");

    const aiHold = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "success",
        severity: "info",
        title: "t",
        summary: "s",
        findings: [{ code: "ai_review_inconclusive", severity: "warning", title: "ai", detail: "ai" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      {},
    );
    expect(aiHold.conclusion).toBe("neutral");

    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 1, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" },
        [{ number: 2, linkedIssueClaimedAt: "2026-01-02T00:00:00.000Z" }],
      ),
    ).toBe(true);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 2, createdAt: "2026-01-02T00:00:00.000Z" },
        [{ number: 1, createdAt: "2026-01-02T00:00:00.000Z" }],
      ),
    ).toBe(false);

    const preferredMissing = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: [],
        preferredLabels: ["bug"],
        linkedIssuePolicy: "preferred",
        testExpectations: [],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["src/a.ts"],
      labels: [],
      linkedIssueCount: 0,
      passedValidationCount: 1,
    });
    expect(preferredMissing.findings.some((f) => f.code === "manifest_linked_issue_preferred")).toBe(true);
    expect(preferredMissing.findings.some((f) => f.code === "manifest_missing_preferred_label")).toBe(true);
  });

  it("exercises collision, bounty, readiness, and queue branches", () => {
    const selfAuthoredSkip = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 1, linkedIssues: [], labels: [], authorLogin: "alice", title: "foo bar", changedFiles: ["src/services/upload/retry.ts"] },
      { ...PR, number: 2, linkedIssues: [], labels: [], authorLogin: "alice", title: "baz qux", changedFiles: ["src/services/upload/retry.ts"] },
    ]);
    expect(selfAuthoredSkip.clusters).toHaveLength(0);

    const lockfileOnly = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 3, linkedIssues: [], labels: [], authorLogin: "bob", title: "foo bar", changedFiles: ["package-lock.json"] },
      { ...PR, number: 4, linkedIssues: [], labels: [], authorLogin: "carol", title: "baz qux", changedFiles: ["package-lock.json"] },
    ]);
    expect(lockfileOnly.clusters).toHaveLength(0);

    const mergedCollisions = buildCollisionReport(
      REPO.fullName,
      [],
      [],
      [{ repoFullName: REPO.fullName, number: 99, title: "Merged fix", authorLogin: "miner1", labels: [], linkedIssues: [7], changedFiles: ["src/a.ts"] }],
    );
    expect(mergedCollisions.summary.itemsReviewed).toBeGreaterThan(0);

    expect(classifyBountyLifecycle({ id: "b1", repoFullName: REPO.fullName, issueNumber: 7, status: "open", updatedAt: "2020-01-01T00:00:00.000Z", discoveredAt: "2020-01-01T00:00:00.000Z", payload: {} }, { repoFullName: REPO.fullName, number: 7, title: "Issue", state: "open", labels: [], linkedPrs: [] })).toBe("stale");
    expect(classifyBountyLifecycle({ id: "b3", repoFullName: REPO.fullName, issueNumber: 9, status: "open", updatedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), payload: {} }, { repoFullName: REPO.fullName, number: 9, title: "Issue", state: "open", labels: [], linkedPrs: [] })).toBe("active");
    expect(classifyBountyLifecycle({ id: "b2", repoFullName: REPO.fullName, issueNumber: 8, status: "active funded", updatedAt: "2026-01-01T00:00:00.000Z", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, { repoFullName: REPO.fullName, number: 8, title: "Issue", state: "closed", labels: [], linkedPrs: [] })).toBe("ambiguous");

    const mergedSelfAuthored = buildCollisionReport(
      REPO.fullName,
      [],
      [{ ...PR, number: 5, linkedIssues: [], labels: [], authorLogin: "alice", title: "foo bar", changedFiles: ["src/services/upload/retry.ts"] }],
      [{ repoFullName: REPO.fullName, number: 50, title: "baz qux", authorLogin: "alice", labels: [], linkedIssues: [], changedFiles: ["src/services/upload/retry.ts"] }],
    );
    expect(mergedSelfAuthored.clusters).toHaveLength(0);

    const linkedBodyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "Closes acme/widgets#77", linkedIssues: [] },
      REPO,
      [],
      [],
    );
    expect(linkedBodyPreflight.linkedIssues).toContain(77);

    const holdPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7] },
      { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 0 } },
      [],
      [],
      [],
      null,
      false,
    );
    const readyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
      REPO,
      [],
      [],
    );
    const missingTestPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "tested locally", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: [] },
      REPO,
      [],
      [],
    );
    const collisionReport = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 11, title: "overlap upload retry client", changedFiles: ["src/upload.ts"] },
      { ...PR, number: 12, title: "overlap upload retry service", changedFiles: ["src/upload.ts"] },
    ]);
    expect(collisionReport.summary.clusterCount).toBeGreaterThan(0);
    const queueHealth = buildQueueHealth(
      REPO,
      [],
      Array.from({ length: 14 }, (_, i) => ({ ...PR, number: i + 20, linkedIssues: [7], updatedAt: i === 0 ? "2020-01-01T00:00:00.000Z" : "2026-06-01T00:00:00.000Z" })),
      collisionReport,
    );
    expect(queueHealth.findings.some((f) => f.code === "stale_prs")).toBe(true);
    expect(queueHealth.findings.some((f) => f.code === "collision_clusters")).toBe(true);

    expect(buildPublicReadinessScore({ pr: { ...PR, labels: ["size:large"], isDraft: true }, preflight: holdPreflight, queueHealth }).total).toBeGreaterThan(0);
    expect(buildPublicReadinessScore({ pr: { ...PR, body: "tested locally" }, preflight: missingTestPreflight, queueHealth }).components.find((c) => c.key === "validation")?.score).toBe(12);
    expect(buildPublicReadinessScore({ pr: { ...PR, body: "npm test passed" }, preflight: readyPreflight, queueHealth }).components.find((c) => c.key === "validation")?.score).toBe(25);
    expect(buildPublicReadinessScore({ pr: PR, preflight: readyPreflight, queueHealth }).components.find((c) => c.key === "validation")?.score).toBe(20);

    const union = unionScopedOverlapClusters(collisionReport, PR, collisionReport.clusters);
    expect(union.length).toBeGreaterThanOrEqual(0);

    const malformed = buildFocusManifestGuidance({
      manifest: {
        present: false,
        source: "repo_file",
        wantedPaths: [],
        preferredLabels: [],
        linkedIssuePolicy: "optional",
        testExpectations: ["run npm test"],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: false } as FocusManifest["gate"],
        settings: {},
        review: { present: false, preMergeChecks: [] },
        warnings: ["invalid yaml"],
      },
      changedPaths: ["src/a.ts"],
      linkedIssueCount: 0,
      testFileCount: 0,
      passedValidationCount: 0,
    });
    expect(malformed.findings.some((f) => f.code === "manifest_malformed")).toBe(true);

    const middleGlob = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: ["src/*util*core.ts"],
        preferredLabels: [],
        linkedIssuePolicy: "optional",
        testExpectations: [],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["src/foo/util/bar/core.ts"],
      linkedIssueCount: 1,
      testFileCount: 1,
    });
    expect(middleGlob.matchedWantedPaths.length).toBeGreaterThan(0);

    expect(buildPullRequestAdvisory(REPO, { ...PR, state: "closed" }).findings.some((f) => f.code === "pr_not_open")).toBe(true);
    const sizeHold = evaluateGateCheck(
      { id: "a", targetType: "pull_request", targetKey: "k", repoFullName: REPO.fullName, conclusion: "success", severity: "info", title: "t", summary: "s", findings: [], generatedAt: "2026-01-01T00:00:00.000Z" },
      { sizeGateMode: "advisory", changedFileCount: 20, changedLineCount: 2000 },
    );
    expect(sizeHold.conclusion).toBe("neutral");
    expect(sizeHold.warnings.some((w) => w.code === "oversized_pr")).toBe(true);
  });

  it("mirrors engine cla-check and pre-merge-check branches", () => {
    expect(evaluateClaCheck(claConfig(), { body: "no consent" })).toEqual([]);
    expect(evaluateClaCheck(claConfig({ consentPhrase: "agree to the CLA" }), { body: "I agree to the CLA." })).toEqual([]);
    expect(evaluateClaCheck(claConfig({ consentPhrase: "agree to the CLA" }), { body: "missing" })[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    expect(evaluateClaCheck(claConfig({ checkRunName: "CLA Assistant Lite" }), { checkRunConclusion: "success" })).toEqual([]);
    expect(evaluateClaCheck(claConfig({ checkRunName: "CLA Assistant Lite" }), { checkRunConclusion: undefined })[0]?.code).toBe(CLA_CHECK_UNRESOLVED_CODE);
    expect(evaluateClaCheck(claConfig({ consentPhrase: "agree", checkRunName: "CLA Assistant Lite" }), { body: "no", checkRunConclusion: "failure" })[0]?.code).toBe(
      CLA_CONSENT_MISSING_CODE,
    );

    expect(evaluatePreMergeChecks([], { title: "t", body: "b", labels: [], changedPaths: [] })).toEqual([]);
    expect(
      evaluatePreMergeChecks([preMergeCheck({ name: "All", titleContains: "FEAT", descriptionContains: "Migration", requireLabel: "Ship" })], {
        title: "feat: add",
        body: "includes a migration",
        labels: ["ship"],
        changedPaths: [],
      }),
    ).toEqual([]);
    const advisoryFail = evaluatePreMergeChecks([preMergeCheck({ name: "Needs all", titleContains: "feat", descriptionContains: "why", requireLabel: "ready" })], {
      title: "chore: x",
      body: "no rationale",
      labels: [],
      changedPaths: [],
    });
    expect(advisoryFail[0]?.code).toBe(PRE_MERGE_CHECK_ADVISORY_CODE);
    const blockingFail = evaluatePreMergeChecks([preMergeCheck({ name: "Required", requireLabel: "approved", enforce: true })], {
      title: "t",
      body: "b",
      labels: ["other"],
      changedPaths: [],
    });
    expect(blockingFail[0]?.code).toBe(PRE_MERGE_CHECK_BLOCKING_CODE);
    const pathGated = evaluatePreMergeChecks(
      [preMergeCheck({ name: "Migrations documented", whenPaths: ["migrations/**"], descriptionContains: "migration", enforce: true })],
      { title: "t", body: "no note", labels: [], changedPaths: ["migrations/0099_x.sql"] },
    );
    expect(pathGated[0]?.code).toBe(PRE_MERGE_CHECK_BLOCKING_CODE);
    const unresolved = evaluatePreMergeChecks(
      [
        preMergeCheck({ name: "Migrations documented", whenPaths: ["migrations/**"], descriptionContains: "migration", enforce: true }),
        preMergeCheck({ name: "advisory path check", whenPaths: ["migrations/**"], descriptionContains: "migration", enforce: false }),
        preMergeCheck({ name: "JIRA in title", titleContains: "JIRA-", enforce: true }),
      ],
      { title: "no ref", body: "", labels: [], changedPaths: [], filesResolved: false },
    );
    expect(unresolved.find((f) => f.title.includes("Migrations documented"))?.code).toBe(PRE_MERGE_CHECK_UNRESOLVED_CODE);
    expect(unresolved.find((f) => f.title.includes("JIRA in title"))?.code).toBe(PRE_MERGE_CHECK_BLOCKING_CODE);
    expect(evaluatePreMergeChecks([preMergeCheck({ name: "T", titleContains: "feat" })], { changedPaths: [] })).toHaveLength(1);
  });

  it("exercises collision, duplicate-winner, and gate-evaluation edge branches", () => {
    const sharedIssueCollision = buildCollisionReport(
      REPO.fullName,
      [{ repoFullName: REPO.fullName, number: 7, title: "Issue", state: "open", labels: [], linkedPrs: [], authorLogin: "other" }],
      [
        { ...PR, number: 1, linkedIssues: [7] },
        { ...PR, number: 2, linkedIssues: [7] },
      ],
    );
    expect(sharedIssueCollision.clusters.length).toBeGreaterThan(0);

    const pathOverlap = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 1, authorLogin: "alice", title: "alpha widget refactor", changedFiles: ["src/core/upload.ts"] },
      { ...PR, number: 2, authorLogin: "bob", title: "beta service cleanup", changedFiles: ["src/core/upload.ts"] },
    ]);
    expect(pathOverlap.clusters.length).toBeGreaterThan(0);

    expect(
      isDuplicateClusterWinnerByClaim({ number: 1, linkedIssueClaimedAt: "invalid" }, [{ number: 2, linkedIssueClaimedAt: "2026-01-02T00:00:00.000Z" }]),
    ).toBe(false);
    expect(resolveDuplicateClusterWinnerNumber({ number: 1, createdAt: null }, [{ number: 2, createdAt: null }])).toBeNull();

    const unregistered = buildPullRequestAdvisory({ ...REPO, isRegistered: false, registryConfig: null }, PR);
    expect(unregistered.findings.some((f) => f.code === "repo_unregistered")).toBe(true);
    const missingConfig = buildPullRequestAdvisory({ ...REPO, registryConfig: null }, PR);
    expect(missingConfig.findings.some((f) => f.code === "repo_config_missing")).toBe(true);

    const duplicateWinner = buildPullRequestAdvisory(
      REPO,
      { ...PR, number: 20, linkedIssues: [7], linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" },
      {
        otherOpenPullRequests: [{ ...PR, number: 21, linkedIssues: [7], linkedIssueClaimedAt: "2026-01-02T00:00:00.000Z" }],
        duplicateWinnerEnabled: true,
      },
    );
    expect(duplicateWinner.findings.some((f) => f.code === "duplicate_pr_risk")).toBe(false);

    const held = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "repo_not_registered", severity: "warning", title: "hold", detail: "hold" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      {},
    );
    expect(held.conclusion).toBe("neutral");

    const claHeld = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: CLA_CHECK_UNRESOLVED_CODE, severity: "warning", title: "cla", detail: "cla" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { claGateMode: "block" },
    );
    expect(claHeld.conclusion).toBe("neutral");

    const manifestBlocked = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "manifest_missing_tests", severity: "warning", title: "tests", detail: "tests", action: "add tests" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { manifestPolicyGateMode: "block" },
    );
    expect(manifestBlocked.conclusion).toBe("failure");

    const mergeReady = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "missing_linked_issue", severity: "warning", title: "issue", detail: "issue" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { mergeReadinessGateMode: "block" },
    );
    expect(mergeReady.conclusion).toBe("failure");

    const guardrailOnly = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "success",
        severity: "info",
        title: "t",
        summary: "s",
        findings: [],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { guardrailHit: true, sizeGateMode: "off" },
    );
    expect(guardrailOnly.conclusion).toBe("neutral");
    expect(guardrailOnly.warnings.some((w) => w.code === "guardrail_hold")).toBe(true);

    const criticalBlocker = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "pre_merge_check_required", severity: "critical", title: "required", detail: "required", action: "fix it" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      {},
    );
    expect(criticalBlocker.conclusion).toBe("failure");
    expect(criticalBlocker.summary).toContain("fix it");

    const missingTests = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: [],
        preferredLabels: [],
        linkedIssuePolicy: "optional",
        testExpectations: ["paste your wallet hotkey here"],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["src/a.ts"],
      linkedIssueCount: 1,
      testFileCount: 0,
      passedValidationCount: 0,
    });
    expect(missingTests.findings.some((f) => f.code === "manifest_missing_tests")).toBe(true);
    expect(missingTests.findings.find((f) => f.code === "manifest_missing_tests")?.detail).not.toContain("wallet");
  });

  it("covers remaining codecov patch branch arms in ported engine modules", () => {
    const splitRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 0.5 },
    };
    expect(buildPullRequestAdvisory(splitRepo, PR).findings.some((f) => f.code === "issue_discovery_disabled")).toBe(false);
    expect(buildPullRequestAdvisory(splitRepo, PR).findings.some((f) => f.code === "direct_pr_pool_disabled")).toBe(false);
    expect(buildPullRequestAdvisory(null, null).findings.some((f) => f.code === "repo_not_registered")).toBe(true);

    expect(evaluateClaCheck(claConfig({ checkRunName: "CLA Bot" }), { checkRunConclusion: "failure" })[0]?.detail).toContain("CLA Bot");
    expect(evaluateClaCheck(claConfig({ consentPhrase: "agree" }), { body: "nope" })[0]?.detail).toContain("agree");

    expect(isDuplicateClusterWinnerByClaim({ number: 1 }, [])).toBe(true);
    expect(resolveDuplicateClusterWinnerNumber({ number: 1, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" }, [])).toBe(1);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
        [{ number: 2, linkedIssueClaimedAt: "2026-01-02T00:00:00.000Z" }],
      ),
    ).toBe(false);

    const pathological = "src/*-*-*-final.ts";
    expect(globToRegExp(pathological).test("src/a-b-c-final.ts")).toBe(false);
    expect(guardrailPathMatches(["", "src/a.ts"], ["src/**"])).toEqual([{ path: "src/a.ts", glob: "src/**" }]);
    expect(guardrailPathMatches(["scripts/x.ts"], [pathological])).toEqual([{ path: "scripts/x.ts", glob: pathological }]);

    expect(sanitizePublicComment("public reviewability score without prefix")).toContain("private context");

    const prItem: CollisionItem = { type: "pull_request", number: 42, title: "Unrelated", linkedIssues: [9] };
    expect(itemSharesPlannedLinkedIssue(prItem, [9])).toBe(true);
    expect(itemSharesPlannedLinkedIssue({ type: "pull_request", number: 9, title: "No links" }, [9])).toBe(false);
    expect(termOverlap({ terms: new Set(), size: 0 }, { terms: new Set(["alpha"]), size: 1 }).score).toBe(0);

    const sharedIssueMedium = buildCollisionReport(
      REPO.fullName,
      [],
      [{ ...PR, number: 1, linkedIssues: [7] }],
      [{ repoFullName: REPO.fullName, number: 88, title: "Merged overlap", authorLogin: "bob", labels: [], linkedIssues: [7], changedFiles: ["src/a.ts"] }],
    );
    expect(sharedIssueMedium.clusters.some((c) => c.risk === "medium")).toBe(true);

    const pathCollision = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 10, authorLogin: "alice", title: "upload retry client handler", labels: [], linkedIssues: [], changedFiles: ["src/core/upload.ts"] },
      { ...PR, number: 11, authorLogin: "carol", title: "upload retry service layer", labels: [], linkedIssues: [], changedFiles: ["src/core/upload.ts"] },
    ]);
    expect(pathCollision.clusters.length).toBeGreaterThan(0);

    const mediumOnlyCollisions = buildCollisionReport(
      REPO.fullName,
      [],
      [{ ...PR, number: 1, linkedIssues: [7] }],
      [{ repoFullName: REPO.fullName, number: 88, title: "Merged overlap", authorLogin: "bob", labels: [], linkedIssues: [7], changedFiles: ["src/a.ts"] }],
    );
    expect(mediumOnlyCollisions.summary.highRiskCount).toBe(0);
    expect(mediumOnlyCollisions.summary.clusterCount).toBeGreaterThan(0);

    const queueInfoCollision = buildQueueHealth(
      null,
      [],
      [{ ...PR, number: 14, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true }],
      mediumOnlyCollisions,
      { openPullRequests: 20, likelyReviewablePullRequests: 5 },
    );
    expect(queueInfoCollision.repoFullName).toBe(REPO.fullName);
    expect(queueInfoCollision.findings.find((f) => f.code === "collision_clusters")?.severity).toBe("info");
    expect(queueInfoCollision.findings.some((f) => f.code === "inactive_draft_prs")).toBe(true);

    const issueQuality: IssueQualityReport = {
      repoFullName: REPO.fullName,
      generatedAt: "2026-01-01T00:00:00.000Z",
      lane: { lane: "direct_pr", repoFullName: REPO.fullName, summary: "direct", contributorGuidance: "direct", maintainerGuidance: "direct" },
      summary: "quality",
      issues: [
        { number: 7, title: "Issue 7", status: "needs_proof", score: 40, reasons: [], warnings: ["needs more detail"] },
        { number: 8, title: "Issue 8", status: "do_not_use", score: 10, reasons: [], warnings: ["duplicate prone"] },
      ],
    };
    const bountyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: `Closes ${REPO.fullName}#77`, changedFiles: ["src/a.ts"], linkedIssues: [7, 8] },
      REPO,
      [{ repoFullName: REPO.fullName, number: 7, title: "Issue", state: "open", labels: [], linkedPrs: [] }],
      [],
      [
        { id: "b1", repoFullName: REPO.fullName, issueNumber: 7, status: "closed", updatedAt: "2020-01-01T00:00:00.000Z", discoveredAt: "2020-01-01T00:00:00.000Z", payload: {} },
        { id: "b2", repoFullName: REPO.fullName, issueNumber: 8, status: "open", updatedAt: "2020-01-01T00:00:00.000Z", discoveredAt: "2020-01-01T00:00:00.000Z", payload: {} },
      ],
      issueQuality,
    );
    expect(bountyPreflight.linkedIssues).toContain(77);
    expect(bountyPreflight.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["linked_issue_bounty_historical", "linked_issue_bounty_unverified", "issue_quality_do_not_use", "issue_quality_needs_proof", "missing_test_evidence"]),
    );

    const mediumBurdenPreflight = buildPreflightResult(
      {
        repoFullName: REPO.fullName,
        title: "Add pagination export endpoint",
        body: "",
        changedFiles: Array.from({ length: 12 }, (_, i) => `src/file-${i}.ts`),
        linkedIssues: [7],
      },
      REPO,
      [{ repoFullName: REPO.fullName, number: 7, title: "Token refresh race", state: "open", labels: [], linkedPrs: [] }],
      [{ ...PR, number: 50, linkedIssues: [7] }],
    );
    expect(mediumBurdenPreflight.reviewBurden).toBe("high");
    expect(mediumBurdenPreflight.findings.some((f) => f.code === "possible_duplicate_work")).toBe(true);

    const globOverflowPattern = "**/".repeat(8) + "safe.ts";
    expect(matchesManifestPath("deep/nested/safe.ts", globOverflowPattern)).toBe(true);

    const middleMiss = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: ["src/foo/missing/bar/core.ts"],
        preferredLabels: [],
        linkedIssuePolicy: "optional",
        testExpectations: [],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["src/foo/wrong/bar/core.ts"],
      linkedIssueCount: 1,
      testFileCount: 1,
    });
    expect(middleMiss.matchedWantedPaths).toHaveLength(0);

    const defaultLabelsGuidance = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: ["src/**"],
        preferredLabels: ["bug"],
        linkedIssuePolicy: "optional",
        testExpectations: [],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["", "src/a.ts"],
      linkedIssueCount: 1,
      testFileCount: 1,
    });
    expect(defaultLabelsGuidance.preferredLabelHits).toEqual([]);

    const advisoryBase = {
      id: "a",
      targetType: "pull_request" as const,
      targetKey: "k",
      repoFullName: REPO.fullName,
      conclusion: "neutral" as const,
      severity: "warning" as const,
      title: "t",
      summary: "s",
      generatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(
      evaluateGateCheck(
        { ...advisoryBase, findings: [{ code: "repo_not_seen", severity: "warning", title: "hold", detail: "hold" }] },
        {},
      ).conclusion,
    ).toBe("neutral");

    const dryRun = evaluateGateCheck(
      { ...advisoryBase, conclusion: "success", severity: "info", findings: [] },
      { dryRun: true, aiReviewGateMode: "advisory" },
    );
    expect(dryRun.displayConclusion).toBeDefined();

    const multiBlocker = evaluateGateCheck(
      {
        ...advisoryBase,
        findings: [
          { code: "missing_linked_issue", severity: "warning", title: "issue", detail: "issue", action: "link one" },
          { code: "duplicate_pr_risk", severity: "warning", title: "dup", detail: "dup" },
        ],
      },
      { linkedIssueGateMode: "block", duplicatePrGateMode: "block" },
    );
    expect(multiBlocker.conclusion).toBe("failure");
    expect(multiBlocker.title).toContain("2 blockers");

    const policyBlockers = evaluateGateCheck(
      {
        ...advisoryBase,
        findings: [
          { code: REVIEW_THREAD_BLOCKER_CODE, severity: "warning", title: "thread", detail: "thread" },
          { code: "secret_leak", severity: "critical", title: "secret", detail: "secret", action: "rotate" },
          { code: "self_authored_linked_issue", severity: "warning", title: "self", detail: "self" },
          { code: "lockfile_tamper_risk", severity: "warning", title: "lock", detail: "lock" },
          { code: CLA_CONSENT_MISSING_CODE, severity: "warning", title: "cla", detail: "cla" },
          { code: "ai_review_split", severity: "warning", title: "split", detail: "split" },
        ],
      },
      {
        selfAuthoredLinkedIssueGateMode: "block",
        lockfileIntegrityGateMode: "block",
        claGateMode: "block",
        aiReviewGateMode: "block",
      },
    );
    expect(policyBlockers.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([REVIEW_THREAD_BLOCKER_CODE, "secret_leak", "self_authored_linked_issue", "lockfile_tamper_risk", CLA_CONSENT_MISSING_CODE, "ai_review_split"]),
    );

    const advisoryDuplicate = evaluateGateCheck(
      { ...advisoryBase, findings: [{ code: "duplicate_pr_risk", severity: "warning", title: "dup", detail: "dup" }] },
      { duplicatePrGateMode: "advisory" },
    );
    expect(advisoryDuplicate.conclusion).toBe("success");

    const qualityWarn = evaluateGateCheck(
      { ...advisoryBase, conclusion: "success", severity: "info", findings: [] },
      { qualityGateMode: "advisory", readinessScore: 40, qualityGateMinScore: 70 },
    );
    expect(qualityWarn.warnings.some((w) => w.code === "readiness_score_below_threshold")).toBe(true);

    const slopBelow = evaluateGateCheck(
      { ...advisoryBase, conclusion: "success", severity: "info", findings: [] },
      { slopGateMode: "block", slopRisk: 10, slopGateMinScore: 60 },
    );
    expect(slopBelow.conclusion).toBe("success");

    expect(gateAdvisoryInternals.highestSeverity([{ code: "x", severity: "critical", title: "c", detail: "c" }])).toBe("critical");
    expect(
      gateAdvisoryInternals.conclusionForSeverity("critical", [{ code: "x", severity: "critical", title: "c", detail: "c" }]),
    ).toBe("action_required");
    expect(gateAdvisoryInternals.buildSizeHoldFinding({ sizeGateMode: "advisory", changedFileCount: 1, changedLineCount: 1 })).toBeNull();
    expect(gateAdvisoryInternals.promoteAdvisoryToBlock({ aiReviewGateMode: "advisory" }).aiReviewGateMode).toBe("block");

    const dryRunAi = evaluateGateCheck(
      {
        ...advisoryBase,
        conclusion: "success",
        severity: "info",
        findings: [{ code: "ai_consensus_defect", severity: "warning", title: "ai", detail: "ai" }],
      },
      { dryRun: true, aiReviewGateMode: "advisory" },
    );
    expect(dryRunAi.displayConclusion).toBe("failure");

    const sampledQueue = buildQueueHealth(REPO, [], [{ ...PR, number: 1, linkedIssues: [7], updatedAt: "2026-06-01T00:00:00.000Z" }], buildCollisionReport(REPO.fullName, [], []), {
      openPullRequests: 25,
    });
    expect(sampledQueue.signals.likelyReviewablePullRequestsSource).toBe("sampled_cache");
    expect(
      buildPublicReadinessScore({
        pr: PR,
        preflight: buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7] }, REPO, [], []),
        queueHealth: sampledQueue,
      }).components.find((c) => c.key === "queue_pressure")?.evidence,
    ).toContain("sampled");

    const selfAuthoredSkip = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 1, linkedIssues: [], labels: [], authorLogin: "alice", title: "alpha upload retry", changedFiles: ["src/core/upload.ts"] },
      { ...PR, number: 2, linkedIssues: [], labels: [], authorLogin: "alice", title: "beta service layer", changedFiles: ["src/core/upload.ts"] },
    ]);
    expect(selfAuthoredSkip.clusters).toHaveLength(0);

    const existingCluster = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 1, linkedIssues: [7] },
      { ...PR, number: 2, linkedIssues: [7] },
      { ...PR, number: 3, linkedIssues: [7] },
    ]);
    expect(existingCluster.clusters.length).toBeGreaterThan(0);

    expect(
      isDuplicateClusterWinnerByClaim({ number: 1, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" }, [{ number: 2, linkedIssueClaimedAt: undefined }]),
    ).toBe(false);

    expect(evaluateClaCheck({ consentPhrase: "agree", checkRunName: null }, { body: "nope" })[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    expect(guardrailPathMatches(["src/a.ts"], ["src/a.ts"])).toEqual([{ path: "src/a.ts", glob: "src/a.ts" }]);

    const noLinkedCountGuidance = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: ["src/**"],
        preferredLabels: [],
        linkedIssuePolicy: "optional",
        testExpectations: [],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["src/a.ts"],
      testFileCount: 1,
    });
    expect(noLinkedCountGuidance.findings).toBeDefined();

    expect(classifyBountyLifecycle({ id: "b", repoFullName: REPO.fullName, issueNumber: 1, status: "  ", updatedAt: "2026-01-01T00:00:00.000Z", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, null)).toBe("unknown");

    const overlapPreflight = buildPreflightResult(
      {
        repoFullName: REPO.fullName,
        title: "Resolve login redirect loop OAuth callback handler",
        body: "",
        changedFiles: ["src/auth.ts"],
        linkedIssues: [],
      },
      REPO,
      [{ repoFullName: REPO.fullName, number: 51, title: "Login redirect loop OAuth cleanup", state: "open", labels: [], linkedPrs: [] }],
      [{ ...PR, number: 52, title: "Login redirect loop OAuth middleware", linkedIssues: [], changedFiles: ["src/auth.ts"] }],
    );
    expect(overlapPreflight.findings.some((f) => f.code === "possible_duplicate_work")).toBe(true);

    const holdQualityPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [9], changedFiles: ["src/a.ts"], tests: [] },
      REPO,
      [],
      [],
      [],
      {
        repoFullName: REPO.fullName,
        generatedAt: "2026-01-01T00:00:00.000Z",
        lane: { lane: "direct_pr", repoFullName: REPO.fullName, summary: "direct", contributorGuidance: "direct", maintainerGuidance: "direct" },
        summary: "quality",
        issues: [{ number: 9, title: "Hold", status: "hold", score: 50, reasons: [], warnings: ["on hold"] }],
      },
    );
    expect(holdQualityPreflight.findings.some((f) => f.code === "issue_quality_hold")).toBe(true);

    const inactiveDraftQueue = buildQueueHealth(
      REPO,
      [],
      [{ ...PR, number: 99, isDraft: true, updatedAt: "2000-01-01T00:00:00.000Z", linkedIssues: [] }],
      buildCollisionReport(REPO.fullName, [], []),
    );
    expect(inactiveDraftQueue.findings.some((f) => f.code === "inactive_draft_prs")).toBe(true);

    const nonBlockers = evaluateGateCheck(
      {
        ...advisoryBase,
        findings: [
          { code: "missing_linked_issue", severity: "warning", title: "issue", detail: "issue" },
          { code: "ai_consensus_defect", severity: "warning", title: "ai", detail: "ai" },
          { code: "manifest_missing_tests", severity: "warning", title: "tests", detail: "tests" },
          { code: "self_authored_linked_issue", severity: "warning", title: "self", detail: "self" },
          { code: "lockfile_tamper_risk", severity: "warning", title: "lock", detail: "lock" },
          { code: CLA_CONSENT_MISSING_CODE, severity: "warning", title: "cla", detail: "cla" },
        ],
      },
      {
        linkedIssueGateMode: "advisory",
        aiReviewGateMode: "advisory",
        manifestPolicyGateMode: "off",
        selfAuthoredLinkedIssueGateMode: "advisory",
        lockfileIntegrityGateMode: "off",
        claGateMode: "off",
        qualityGateMode: "advisory",
        readinessScore: 30,
        qualityGateMinScore: 70,
      },
    );
    expect(nonBlockers.conclusion).toBe("success");
    expect(nonBlockers.warnings.some((w) => w.code === "readiness_score_below_threshold")).toBe(true);

    const sizeHoldLines = evaluateGateCheck(
      { ...advisoryBase, conclusion: "success", severity: "info", findings: [] },
      { sizeGateMode: "advisory", changedFileCount: 12, changedLineCount: 50 },
    );
    expect(sizeHoldLines.warnings.some((w) => w.code === "oversized_pr")).toBe(true);

    const policy = { linkedIssueGateMode: "advisory" as const, duplicatePrGateMode: "advisory" as const, aiReviewGateMode: "advisory" as const, manifestPolicyGateMode: "off" as const, selfAuthoredLinkedIssueGateMode: "advisory" as const, lockfileIntegrityGateMode: "off" as const, claGateMode: "off" as const };
    const blockPolicy = { linkedIssueGateMode: "block" as const, duplicatePrGateMode: "block" as const, aiReviewGateMode: "block" as const, manifestPolicyGateMode: "block" as const, selfAuthoredLinkedIssueGateMode: "block" as const, lockfileIntegrityGateMode: "block" as const, claGateMode: "block" as const };
    const finding = (code: string) => ({ code, severity: "warning" as const, title: code, detail: code });
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("missing_linked_issue"), policy)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("missing_linked_issue"), blockPolicy)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("duplicate_pr_risk"), policy)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("duplicate_pr_risk"), blockPolicy)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("ai_consensus_defect"), policy)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("ai_consensus_defect"), blockPolicy)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("manifest_missing_tests"), policy)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("manifest_missing_tests"), blockPolicy)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("self_authored_linked_issue"), policy)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("self_authored_linked_issue"), blockPolicy)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("lockfile_tamper_risk"), policy)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding("lockfile_tamper_risk"), blockPolicy)).toBe(true);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding(CLA_CONSENT_MISSING_CODE), policy)).toBe(false);
    expect(gateAdvisoryInternals.isConfiguredGateBlocker(finding(CLA_CONSENT_MISSING_CODE), blockPolicy)).toBe(true);
    expect(gateAdvisoryInternals.buildSlopGateBlocker({ slopGateMode: "block", slopRisk: null })).toBeNull();
    expect(gateAdvisoryInternals.buildSlopGateBlocker({ slopGateMode: "block", slopRisk: 80, slopGateMinScore: 60 })?.code).toBe("slop_risk_above_threshold");
    expect(gateAdvisoryInternals.buildSizeHoldFinding({ sizeGateMode: "advisory", changedFileCount: 5, changedLineCount: 2000 })?.code).toBe("oversized_pr");
    expect(gateAdvisoryInternals.promoteAdvisoryToBlock({ aiReviewGateMode: "block" }).aiReviewGateMode).toBe("block");

    expect(evaluateClaCheck({ consentPhrase: "agree", checkRunName: null }, { body: "nope" })[0]?.code).toBe(CLA_CONSENT_MISSING_CODE);
    expect(matchesAny("src/a.ts", ["src/a.ts"])).toBe(true);

    expect(predictedGateEngineInternals.sharesMeaningfulFile(["src/a.ts"], ["src/a.ts"])).toBe(true);
    expect(predictedGateEngineInternals.sharesMeaningfulFile(undefined, ["src/a.ts"])).toBe(false);
    expect(predictedGateEngineInternals.truncateText("short", 10)).toBe("short");
    expect(predictedGateEngineInternals.truncateText("x".repeat(20), 10)).toHaveLength(10);
    expect(predictedGateEngineInternals.extractLinkedIssueNumbers(`closes ${REPO.fullName}#42`, REPO.fullName)).toContain(42);

    const failureWithQuality = evaluateGateCheck(
      { ...advisoryBase, findings: [{ code: "missing_linked_issue", severity: "warning", title: "issue", detail: "issue", action: "link it" }] },
      { linkedIssueGateMode: "block", qualityGateMode: "advisory", readinessScore: 10, qualityGateMinScore: 50 },
    );
    expect(failureWithQuality.conclusion).toBe("failure");
    expect(failureWithQuality.warnings.some((w) => w.code === "readiness_score_below_threshold")).toBe(true);

    const readinessHold = buildPublicReadinessScore({
      pr: { ...PR, labels: ["size:large"], isDraft: true, body: "tested locally" },
      preflight: buildPreflightResult(
        { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: [] },
        { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 0 } },
        [],
        [],
        [],
        null,
        false,
      ),
      queueHealth: buildQueueHealth(REPO, [], [{ ...PR, number: 30, linkedIssues: [7], updatedAt: "2026-06-01T00:00:00.000Z" }], buildCollisionReport(REPO.fullName, [], []), { openPullRequests: 30 }),
    });
    expect(readinessHold.components.find((c) => c.key === "change_scope")?.score).toBe(20);
    expect(readinessHold.components.find((c) => c.key === "validation")?.score).toBe(5);
  });
});
