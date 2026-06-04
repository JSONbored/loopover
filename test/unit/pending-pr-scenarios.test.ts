import { describe, expect, it, vi } from "vitest";
import * as repositories from "../../src/db/repositories";
import { sanitizePublicComment } from "../../src/github/commands";
import {
  applyPendingPrDetectionToScoreInput,
  classifyOpenPullRequest,
  detectPendingPrScenario,
  loadContributorRepoOpenPrSignalRecords,
} from "../../src/scoring/pending-pr-scenarios";
import { buildScorePreview } from "../../src/scoring/preview";
import type { PullRequestRecord, PullRequestReviewRecord, ScoringModelSnapshotRecord } from "../../src/types";
import type { RoleContext } from "../../src/signals/engine";

const outsideContributorRole: RoleContext = {
  login: "miner-a",
  repoFullName: "entrius/allways-ui",
  generatedAt: "2026-05-28T00:00:00.000Z",
  role: "outside_contributor",
  maintainerLane: false,
  normalContributorEvidenceAllowed: true,
  source: "cache",
  association: "NONE",
  reasons: [],
  guidance: "contributor",
};

const maintainerRole: RoleContext = {
  ...outsideContributorRole,
  login: "repo-owner",
  role: "owner",
  maintainerLane: true,
  normalContributorEvidenceAllowed: false,
  source: "repo_owner_match",
  guidance: "maintainer",
};

function pr(overrides: Partial<PullRequestRecord> & Pick<PullRequestRecord, "number">): PullRequestRecord {
  return {
    repoFullName: "entrius/allways-ui",
    title: `PR #${overrides.number}`,
    state: "open",
    authorLogin: "miner-a",
    labels: [],
    linkedIssues: [1],
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

function approvedReview(pullNumber: number): PullRequestReviewRecord {
  return {
    id: `review-${pullNumber}`,
    repoFullName: "entrius/allways-ui",
    pullNumber,
    state: "APPROVED",
    payload: {},
  };
}

describe("pending PR scenario detection", () => {
  it("treats approved-but-unmerged PRs as merge-ready pending work", () => {
    const detection = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 11 }), pr({ number: 12, title: "blocked work" })],
      roleContext: outsideContributorRole,
      openPrCount: 3,
      reviewsByPullNumber: new Map([
        [11, [approvedReview(11)]],
        [12, [{ ...approvedReview(12), state: "CHANGES_REQUESTED" }]],
      ]),
      checksByPullNumber: new Map([
        [11, []],
        [12, []],
      ]),
    });
    expect(detection).toMatchObject({
      source: "github_observed",
      pendingMergedPrCount: 1,
      pendingClosedPrCount: 0,
      expectedOpenPrCountAfterMerge: 2,
    });
    expect(detection?.classified.find((entry) => entry.number === 12)?.classification).toBe("blocked");
  });

  it("treats timed-out checks as failing work that blocks merge readiness", () => {
    const classified = classifyOpenPullRequest({
      pr: pr({ number: 77 }),
      roleContext: outsideContributorRole,
      reviews: [approvedReview(77)],
      checks: [{ id: "c77", repoFullName: "entrius/allways-ui", pullNumber: 77, name: "ci", status: "completed", conclusion: "timed_out", payload: {} }],
    });
    expect(classified.classification).toBe("blocked");
    expect(classified.reasons.join(" ")).toMatch(/failing or cancelled check/i);
  });

  it("counts stale approved PRs as pending closes and projects the post-cleanup open count", () => {
    const staleDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const detection = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 21, updatedAt: staleDate, createdAt: staleDate })],
      roleContext: outsideContributorRole,
      openPrCount: 2,
      reviewsByPullNumber: new Map([[21, [approvedReview(21)]]]),
      checksByPullNumber: new Map([[21, []]]),
    });
    expect(detection?.pendingMergedPrCount).toBe(0);
    expect(detection?.pendingClosedPrCount).toBe(1);
    expect(detection?.expectedOpenPrCountAfterMerge).toBe(1);
  });

  it("does not treat draft, stale, or maintainer-lane PRs as likely-to-land", () => {
    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const classified = [
      classifyOpenPullRequest({
        pr: pr({ number: 1, title: "Draft: experiment", labels: ["draft"] }),
        roleContext: outsideContributorRole,
        reviews: [approvedReview(1)],
        checks: [],
      }),
      classifyOpenPullRequest({
        pr: pr({ number: 2, updatedAt: staleDate, createdAt: staleDate }),
        roleContext: outsideContributorRole,
        reviews: [approvedReview(2)],
        checks: [],
      }),
      classifyOpenPullRequest({
        pr: pr({ number: 3, authorAssociation: "MEMBER" }),
        roleContext: outsideContributorRole,
        reviews: [approvedReview(3)],
        checks: [],
      }),
      classifyOpenPullRequest({
        pr: pr({ number: 4 }),
        roleContext: maintainerRole,
        reviews: [approvedReview(4)],
        checks: [],
      }),
    ];
    expect(classified.map((entry) => entry.classification)).toEqual(["draft", "stale_likely_close", "maintainer_lane", "maintainer_lane"]);
  });

  it("labels user-supplied assumptions separately from GitHub-observed state", () => {
    const user = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 9 })],
      roleContext: outsideContributorRole,
      userSupplied: { pendingMergedPrCount: 2, scenarioNotes: ["manual assumption"] },
    });
    expect(user?.source).toBe("user_supplied");

    const observed = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 10 })],
      roleContext: outsideContributorRole,
      reviewsByPullNumber: new Map([[10, [approvedReview(10)]]]),
      checksByPullNumber: new Map([[10, []]]),
    });
    expect(observed?.source).toBe("github_observed");
    expect(observed?.scenarioNotes[0]).toMatch(/GitHub-observed/i);
  });

  it("keeps effective score distinct from underlying potential in observed after-pending scenario", () => {
    const snapshot: ScoringModelSnapshotRecord = {
      id: "score-model-fixture",
      sourceKind: "test",
      sourceUrl: "fixture://constants.py",
      fetchedAt: "2026-05-23T00:00:00.000Z",
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
    const preview = buildScorePreview({
      repo: {
        fullName: "entrius/allways-ui",
        owner: "entrius",
        name: "allways-ui",
        isInstalled: false,
        isRegistered: true,
        isPrivate: false,
        registryConfig: { repo: "entrius/allways-ui", emissionShare: 0.02, issueDiscoveryShare: 0.25, labelMultipliers: {}, maintainerCut: 0, raw: {} },
      },
      snapshot,
      input: {
        repoFullName: "entrius/allways-ui",
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 3,
        credibility: 1,
        pendingMergedPrCount: 1,
        pendingScenarioObserved: true,
      },
    });
    const afterPending = preview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
    expect(preview.effectiveEstimatedScore).toBe(0);
    expect(preview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(afterPending?.source).toBe("github_observed");
    expect(afterPending?.effectiveEstimatedScore).toBeGreaterThan(0);
  });

  it("sanitizes public comment text that mentions score, reward, wallet, or hotkey language", () => {
    const dirty =
      "Estimated score 42, reward estimate, wallet abc, hotkey xyz, payout farming, reviewability ranking, raw trust score.";
    expect(sanitizePublicComment(dirty)).not.toMatch(/estimated score|reward estimate|wallet|hotkey|payout|farming|reviewability|raw trust score/i);
    expect(sanitizePublicComment(dirty)).toContain("private context");
  });

  it("returns null when there is nothing to project and handles closed-only queues", () => {
    expect(
      detectPendingPrScenario({
        login: "miner-a",
        repoFullName: "entrius/allways-ui",
        pullRequests: [pr({ number: 1, state: "closed" })],
        roleContext: outsideContributorRole,
      }),
    ).toBeNull();

    expect(
      detectPendingPrScenario({
        login: "miner-a",
        repoFullName: "entrius/allways-ui",
        pullRequests: [pr({ number: 2, title: "Draft only", labels: ["draft"] })],
        roleContext: outsideContributorRole,
        reviewsByPullNumber: new Map([[2, [approvedReview(2)]]]),
        checksByPullNumber: new Map([[2, []]]),
      }),
    ).toBeNull();
  });

  it("projects stale-close pressure without merge-ready PRs", () => {
    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const detection = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 30, updatedAt: staleDate, createdAt: staleDate })],
      roleContext: outsideContributorRole,
      reviewsByPullNumber: new Map([[30, [approvedReview(30)]]]),
      checksByPullNumber: new Map([[30, []]]),
    });
    expect(detection).toMatchObject({ pendingMergedPrCount: 0, pendingClosedPrCount: 1, expectedOpenPrCountAfterMerge: 0 });
    expect(detection?.scenarioNotes.join(" ")).toMatch(/stale/i);
  });

  it("classifies blocked PRs from failing checks and missing approvals", () => {
    const blockedByChecks = classifyOpenPullRequest({
      pr: pr({ number: 40 }),
      roleContext: outsideContributorRole,
      reviews: [approvedReview(40)],
      checks: [{ id: "c1", repoFullName: "entrius/allways-ui", pullNumber: 40, name: "ci", status: "completed", conclusion: "timed_out", payload: {} }],
    });
    const blockedByCancelled = classifyOpenPullRequest({
      pr: pr({ number: 42 }),
      roleContext: outsideContributorRole,
      reviews: [approvedReview(42)],
      checks: [{ id: "c2", repoFullName: "entrius/allways-ui", pullNumber: 42, name: "ci", status: "completed", conclusion: "cancelled", payload: {} }],
    });
    const blockedByApproval = classifyOpenPullRequest({
      pr: pr({ number: 41 }),
      roleContext: outsideContributorRole,
      reviews: [],
      checks: [],
    });
    const withOverlapFlags = classifyOpenPullRequest({
      pr: pr({ number: 43 }),
      roleContext: outsideContributorRole,
      reviews: [],
      checks: [],
      duplicateProne: true,
      missingTests: true,
    });
    expect(blockedByChecks.classification).toBe("blocked");
    expect(blockedByCancelled.classification).toBe("blocked");
    expect(blockedByApproval.classification).toBe("blocked");
    expect(withOverlapFlags.reasons.join(" ")).toMatch(/duplicate|test files/i);
  });

  it("recognizes draft heuristics and excludes pull numbers from detection", () => {
    expect(
      classifyOpenPullRequest({
        pr: pr({ number: 50, title: "[Draft] spike", labels: [] }),
        roleContext: outsideContributorRole,
        reviews: [],
        checks: [],
      }).classification,
    ).toBe("draft");
    expect(
      classifyOpenPullRequest({
        pr: pr({ number: 51, title: "WIP change", labels: ["wip"] }),
        roleContext: outsideContributorRole,
        reviews: [],
        checks: [],
      }).classification,
    ).toBe("draft");

    const detection = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 52 }), pr({ number: 53 })],
      roleContext: outsideContributorRole,
      excludePullNumbers: [52],
      reviewsByPullNumber: new Map([
        [52, [approvedReview(52)]],
        [53, [approvedReview(53)]],
      ]),
      checksByPullNumber: new Map([
        [52, []],
        [53, []],
      ]),
    });
    expect(detection?.pendingMergedPrCount).toBe(1);
    expect(detection?.classified.some((entry) => entry.number === 52)).toBe(false);
  });

  it("preserves user-supplied expected open PR counts and skips observed score input merges", () => {
    const user = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [],
      roleContext: outsideContributorRole,
      userSupplied: { expectedOpenPrCountAfterMerge: 1, approvedPrCount: 2 },
    });
    expect(user).toMatchObject({ source: "user_supplied", expectedOpenPrCountAfterMerge: 1, approvedPrCount: 2 });

    const base = { repoFullName: "entrius/allways-ui", openPrCount: 3 };
    expect(applyPendingPrDetectionToScoreInput(base, null)).toBe(base);
    expect(
      applyPendingPrDetectionToScoreInput(base, {
        source: "user_supplied",
        pendingMergedPrCount: 1,
        pendingClosedPrCount: 0,
        approvedPrCount: 0,
        scenarioNotes: [],
        classified: [],
      }),
    ).toBe(base);
    expect(
      applyPendingPrDetectionToScoreInput(base, {
        source: "github_observed",
        pendingMergedPrCount: 1,
        pendingClosedPrCount: 0,
        approvedPrCount: 0,
        expectedOpenPrCountAfterMerge: 2,
        scenarioNotes: ["observed"],
        classified: [],
      }),
    ).toMatchObject({ pendingMergedPrCount: 1, pendingScenarioObserved: true, scenarioNotes: ["observed"] });
  });

  it("loads cached reviews and checks for contributor open PRs", async () => {
    const env = {} as Env;
    vi.spyOn(repositories, "listPullRequestReviews").mockResolvedValue([approvedReview(70)]);
    vi.spyOn(repositories, "listCheckSummaries").mockResolvedValue([]);
    const records = await loadContributorRepoOpenPrSignalRecords(env, "entrius/allways-ui", "miner-a", [
      pr({ number: 70 }),
      pr({ number: 71, authorLogin: "other-user" }),
      pr({ number: 72, state: "closed" }),
    ]);
    expect(records.pullRequestReviews).toHaveLength(1);
    expect(records.pullRequestChecks).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
