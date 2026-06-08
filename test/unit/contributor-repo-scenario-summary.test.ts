import { describe, expect, it } from "vitest";
import {
  buildContributorRepoScenarioSummaryFromContext,
  type ContributorRepoScenarioSummaryContext,
} from "../../src/services/contributor-repo-scenario-summary";
import type { PendingPrScenarioDetection } from "../../src/scoring/pending-pr-scenarios";
import type { ContributorOutcomeHistory, ContributorProfile } from "../../src/signals/engine";
import type { PullRequestRecord, ScoringModelSnapshotRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward[-\s]?estimate|farming|raw trust|trust[-\s]?score|scoreability|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)/i;

const snapshot: ScoringModelSnapshotRecord = {
  id: "contributor-scenario-summary-model",
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
  registryConfig: { repo: "octo/demo", emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: { bug: 1.1 }, maintainerCut: 0, raw: {} },
};

const profile: ContributorProfile = {
  login: "miner-a",
  generatedAt: "2026-06-03T00:00:00.000Z",
  github: { login: "miner-a", topLanguages: ["TypeScript"], source: "github" },
  source: "github_cache",
  registeredRepoActivity: {
    pullRequests: 2,
    mergedPullRequests: 1,
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
  login: "miner-a",
  generatedAt: "2026-06-03T00:00:00.000Z",
  source: "github_cache",
  totals: {
    pullRequests: 2,
    mergedPullRequests: 1,
    openPullRequests: 1,
    closedPullRequests: 0,
    closedPullRequestRate: 0,
    issues: 0,
    openIssues: 0,
    closedIssues: 0,
    solvedIssues: 0,
    validSolvedIssues: 0,
    credibility: 0.9,
    issueCredibility: 1,
  },
  repoOutcomes: [
    {
      repoFullName: "octo/demo",
      role: "outside_contributor",
      lane: "direct_pr",
      maintainerLane: false,
      pullRequests: 2,
      mergedPullRequests: 1,
      openPullRequests: 1,
      closedPullRequests: 0,
      closedPullRequestRate: 0,
      issues: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
      credibility: 0.9,
      issueCredibility: 1,
      isEligible: true,
      successLevel: "emerging",
      strengths: ["Merged prior PRs."],
      risks: [],
    },
  ],
  successPatterns: [],
  failurePatterns: [],
  summary: "fixture history",
};

const contributorPullRequests: PullRequestRecord[] = [
  {
    repoFullName: "octo/demo",
    number: 11,
    title: "Ready cleanup",
    state: "open",
    authorLogin: "miner-a",
    authorAssociation: "NONE",
    labels: [],
    linkedIssues: [],
    updatedAt: "2026-05-20T00:00:00.000Z",
  },
];

const pendingDetection: PendingPrScenarioDetection = {
  source: "github_observed",
  pendingMergedPrCount: 1,
  pendingClosedPrCount: 0,
  approvedPrCount: 1,
  expectedOpenPrCountAfterMerge: 0,
  scenarioNotes: ["1 open PR(s) look merge-ready (approved, no changes requested, no failing checks, not draft/stale)."],
  classified: [
    {
      repoFullName: "octo/demo",
      number: 11,
      title: "Ready cleanup",
      classification: "merge_ready",
      reasons: ["Approved review in cache."],
    },
  ],
};

type BuildContext = ContributorRepoScenarioSummaryContext & {
  issues: [];
  pullRequests: PullRequestRecord[];
  recentMergedPullRequests: [];
  scoringSnapshot: ScoringModelSnapshotRecord;
  pendingDetection: PendingPrScenarioDetection | null;
  generatedAt?: string;
};

function baseContext(): BuildContext {
  return {
    login: "miner-a",
    repoFullName: "octo/demo",
    repo,
    profile,
    outcomeHistory,
    contributorPullRequests,
    issues: [],
    pullRequests: contributorPullRequests,
    recentMergedPullRequests: [],
    scoringSnapshot: snapshot,
    pendingDetection,
    generatedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("buildContributorRepoScenarioSummaryFromContext", () => {
  it("composes pressure, eligibility, pending, and public-safe summary fields", () => {
    const response = buildContributorRepoScenarioSummaryFromContext(baseContext());
    expect(response).toMatchObject({
      status: "ready",
      login: "miner-a",
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      summary: {
        advisoryOnly: true,
        notAutonomousPrBot: true,
        notPublicScoring: true,
        repoFullName: "octo/demo",
      },
    });
    expect(response.summary.options.length).toBe(3);
    expect(response.summary.eligibilityNotes.length).toBeGreaterThan(0);
    expect(response.summary.pendingScenarioNotes.length).toBeGreaterThan(0);
    expect(response.summary.pendingPullRequests).toEqual([
      expect.objectContaining({ pullNumber: 11, classification: expect.stringMatching(/merge-ready/i) }),
    ]);
    expect(response.summary.dataClassification.facts.join(" ")).toMatch(/Queue pressure|Open PRs/i);
    expect(JSON.stringify(response.summary)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("still returns ranked options when pending detection is absent", () => {
    const response = buildContributorRepoScenarioSummaryFromContext({
      ...baseContext(),
      pendingDetection: null,
    });
    expect(response.summary.options.length).toBe(3);
    expect(response.summary.pendingScenarioNotes).toEqual([]);
    expect(response.summary.pendingPullRequests).toEqual([]);
  });
});
