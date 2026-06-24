import { describe, expect, it } from "vitest";
import { sanitizePublicComment } from "../../src/github/commands";
import { buildScenarioInput, createScenarioSignalEntry } from "../../src/scenarios/input-model";
import { renderPublicScenarioSummary } from "../../src/scenarios/scenario-summary";
import { deriveEligibilityPlan } from "../../src/services/eligibility-plan";
import { simulateOpenPrPressure } from "../../src/services/open-pr-pressure-scenarios";
import type { PendingPrScenarioDetection } from "../../src/scoring/pending-pr-scenarios";
import { buildScorePreview, type ScoreGateBlocker } from "../../src/scoring/preview";
import type { QueueHealth, RoleContext } from "../../src/signals/engine";
import type { ScoringModelSnapshotRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward[-\s]?estimate|farming|raw trust|trust[-\s]?score|scoreability|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)/i;

const snapshot: ScoringModelSnapshotRecord = {
  id: "scenario-summary-model",
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

function queueHealth(level: QueueHealth["level"]): QueueHealth {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    burdenScore: 10,
    level,
    summary: `Queue is ${level}.`,
    signals: {
      openIssues: 2,
      openPullRequests: 1,
      unlinkedPullRequests: 0,
      stalePullRequests: 0,
      draftPullRequests: 0,
      maintainerAuthoredPullRequests: 0,
      collisionClusters: 0,
      ageBuckets: { under7Days: 1, days7To30: 0, over30Days: 0 },
      likelyReviewablePullRequests: 1,
    },
    findings: [],
  };
}

function roleContext(): RoleContext {
  return {
    login: "miner-a",
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    role: "outside_contributor",
    maintainerLane: false,
    normalContributorEvidenceAllowed: true,
    source: "cache",
    association: "NONE",
    reasons: [],
    guidance: "contributor",
  };
}

function pendingDetection(overrides: Partial<PendingPrScenarioDetection> = {}): PendingPrScenarioDetection {
  return {
    source: "github_observed",
    pendingMergedPrCount: 1,
    pendingClosedPrCount: 1,
    approvedPrCount: 1,
    expectedOpenPrCountAfterMerge: 2,
    scenarioNotes: [
      "GitHub-observed open PR state from cached reviews, checks, and activity timestamps (estimate only).",
      "1 open PR(s) look merge-ready (approved, no changes requested, no failing checks, not draft/stale).",
    ],
    classified: [
      {
        repoFullName: "octo/demo",
        number: 11,
        title: "Ready cleanup",
        classification: "merge_ready",
        reasons: ["Approved review in cache."],
      },
      {
        repoFullName: "octo/demo",
        number: 12,
        title: "Stale cleanup",
        classification: "stale_likely_close",
        reasons: ["No cached update for 30 day(s)."],
      },
      {
        repoFullName: "octo/demo",
        number: 13,
        title: "Draft work",
        classification: "draft",
        reasons: ["Draft PRs are not treated as likely to land."],
      },
      {
        repoFullName: "octo/demo",
        number: 14,
        title: "Blocked work",
        classification: "blocked",
        reasons: ["No approved review in cache."],
      },
      {
        repoFullName: "octo/demo",
        number: 15,
        title: "Maintainer work",
        classification: "maintainer_lane",
        reasons: ["Maintainer-lane context for this repo."],
      },
      {
        repoFullName: "octo/demo",
        number: 16,
        title: "Other work",
        classification: "open_other",
        reasons: ["Open PR still needs triage."],
      },
    ],
    ...overrides,
  };
}

describe("renderPublicScenarioSummary", () => {
  it("renders default headline and empty sections when only repo metadata is present", () => {
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
    });
    expect(summary.headline).toMatch(/Advisory scenario summary generated from available repo signals/i);
    expect(summary.options).toEqual([]);
    expect(summary.eligibilityNotes).toEqual([]);
    expect(summary.blockerNotes).toEqual([]);
    expect(summary.pendingScenarioNotes).toEqual([]);
    expect(summary.pendingPullRequests).toEqual([]);
    expect(summary.dataClassification).toEqual({ facts: [], assumptions: [], unavailableSignals: [] });
    expect(summary.advisoryOnly).toBe(true);
  });

  it("renders for a repo whose name contains a forbidden term without throwing", () => {
    // "hotkey"/"wallet" are Bittensor protocol terms; a legitimately named repo must not fail the guard.
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/hotkey-wallet",
      generatedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(summary.repoFullName).toBe("octo/hotkey-wallet");
    expect(summary.headline).toMatch(/Advisory scenario summary generated from available repo signals/i);
  });

  it("renders pressure options, eligibility notes, blockers, and data classification", () => {
    const pressureSimulation = simulateOpenPrPressure({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      queueHealth: queueHealth("low"),
      roleContext: roleContext(),
      contributorOpenPrCount: 0,
    });
    const preview = buildScorePreview({
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
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "raw", source: "user_supplied", issueNumbers: [77] },
        branchEligibility: { status: "eligible", source: "github_metadata" },
      },
    });
    const eligibilityPlan = deriveEligibilityPlan(preview);
    const scenarioInput = buildScenarioInput({
      scenarioType: "open_pr_pressure",
      repoFullName: "octo/demo",
      facts: [
        createScenarioSignalEntry({
          id: "queue",
          kind: "fact",
          label: "Queue",
          detail: "Repo has one open PR in cached metadata.",
          source: "github_observed",
        }),
      ],
    });

    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      pressureSimulation,
      eligibilityPlan,
      publicBlockers: [
        ...preview.blockedBy,
        { code: "repo_not_registered", severity: "blocker", detail: "Repo is not registered." },
        { code: "inactive_allocation", severity: "blocker", detail: "Allocation inactive." },
        {
          code: "future_blocker" as ScoreGateBlocker["code"],
          severity: "context",
          detail: "Custom public blocker detail.",
        },
      ],
      scenarioInput,
    });

    expect(summary.headline).toBe(sanitizePublicComment(pressureSimulation.summary));
    expect(summary.options.length).toBe(3);
    expect(summary.options[0]?.recommended).toBe(true);
    expect(summary.eligibilityNotes.length).toBeGreaterThan(0);
    expect(summary.blockerNotes.join(" ")).toMatch(/linked issue context is present but not yet validated|Custom public blocker detail/i);
    expect(summary.blockerNotes.join(" ")).not.toMatch(/Repo is not registered|Allocation inactive/i);
    expect(summary.dataClassification.facts).toContain("Queue");
  });

  it("renders sanitized pending scenario notes and classified open PR summaries", () => {
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      pendingDetection: pendingDetection(),
    });

    expect(summary.headline).toMatch(/Pending open PR resolution scenarios are available from cached GitHub metadata/i);
    expect(summary.pendingScenarioNotes.join(" ")).toMatch(/cached GitHub reviews, checks, and activity/i);
    expect(summary.pendingScenarioNotes.join(" ")).toMatch(/merge-ready|Projected open PR count after pending cleanup: 2/i);
    expect(summary.pendingPullRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pullNumber: 11, classification: "merge-ready pending resolution" }),
        expect.objectContaining({ pullNumber: 12, classification: "stale open work likely to close" }),
        expect.objectContaining({ pullNumber: 13, classification: "draft open PR" }),
        expect.objectContaining({ pullNumber: 14, classification: "blocked open PR" }),
        expect.objectContaining({ pullNumber: 15, classification: "maintainer-lane open PR" }),
        expect.objectContaining({ pullNumber: 16, classification: "open PR" }),
      ]),
    );
    expect(JSON.stringify(summary)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("renders user-supplied pending scenario assumptions without classified PR rows", () => {
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      pendingDetection: pendingDetection({
        source: "user_supplied",
        pendingMergedPrCount: 2,
        pendingClosedPrCount: 0,
        approvedPrCount: 2,
        expectedOpenPrCountAfterMerge: 1,
        scenarioNotes: ["Caller assumes two approved PRs will land soon."],
        classified: [],
      }),
    });

    expect(summary.headline).toMatch(/Pending open PR scenario assumptions were supplied/i);
    expect(summary.pendingScenarioNotes.join(" ")).toMatch(/supplied by the caller as assumptions/i);
    expect(summary.pendingScenarioNotes.join(" ")).toContain("Caller assumes two approved PRs will land soon.");
    expect(summary.pendingPullRequests).toEqual([]);
  });

  it("uses eligibility headline and linked-issue projection notes when pressure simulation is absent", () => {
    const preview = buildScorePreview({
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
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "raw", source: "user_supplied", issueNumbers: [77] },
        branchEligibility: { status: "eligible", source: "github_metadata" },
      },
    });
    const eligibilityPlan = deriveEligibilityPlan(preview);
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      eligibilityPlan,
    });

    expect(summary.headline).toBe(sanitizePublicComment(eligibilityPlan.publicSummary));
    expect(summary.eligibilityNotes.join(" ")).toMatch(/not yet validated|Validating the linked issue would enable/i);
  });

  it("falls back to generic option next steps for unknown strategy options", () => {
    const pressureSimulation = simulateOpenPrPressure({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      queueHealth: queueHealth("low"),
      roleContext: roleContext(),
      contributorOpenPrCount: 0,
    });
    pressureSimulation.scenarios[0] = {
      ...pressureSimulation.scenarios[0]!,
      option: "unexpected_option" as typeof pressureSimulation.scenarios[0]["option"],
    };

    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      pressureSimulation,
    });

    expect(summary.options[0]?.nextStep).toMatch(/Review available signals before acting/i);
  });

  it("omits linked-issue projection notes when the eligibility plan has no projection", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: "octo/demo",
        sourceTokenScore: 60,
        totalTokenScore: 80,
        sourceLines: 50,
        openPrCount: 0,
        credibility: 1,
        metadataOnly: true,
        linkedIssueMode: "none",
      },
    });
    const eligibilityPlan = deriveEligibilityPlan(preview);
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      eligibilityPlan,
    });

    expect(eligibilityPlan.linkedIssueProjection).toBeNull();
    expect(summary.eligibilityNotes.join(" ")).not.toMatch(/Validating the linked issue would enable/i);
  });

  it("omits projected open-count notes when pending detection has no after-cleanup projection", () => {
    const summary = renderPublicScenarioSummary({
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      pendingDetection: pendingDetection({
        expectedOpenPrCountAfterMerge: undefined,
        classified: [
          {
            repoFullName: "octo/demo",
            number: 99,
            title: "Unknown classification",
            classification: "custom_pending_class" as PendingPrScenarioDetection["classified"][number]["classification"],
            reasons: ["Custom pending classification reason."],
          },
        ],
      }),
    });

    expect(summary.pendingScenarioNotes.join(" ")).not.toMatch(/Projected open PR count after pending cleanup/i);
    expect(summary.pendingPullRequests[0]?.classification).toBe("custom pending class");
  });
});
