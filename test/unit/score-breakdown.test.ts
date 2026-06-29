import { describe, expect, it } from "vitest";
import { buildScorePreview } from "../../src/scoring/preview";
import { explainScoreBreakdown } from "../../src/services/score-breakdown";
import type { RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

const FORBIDDEN = /\b(wallet|hotkey|coldkey|mnemonic|farming|payout|raw[-_\s]?trust)\b/i;

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
    TOTAL_TOK_SATURATION_SCALE: 58,
  },
  payload: {},
  programmingLanguages: {},
  warnings: [],
};

const repo: RepositoryRecord = {
  fullName: "octo/demo",
  owner: "octo",
  name: "demo",
  isInstalled: false,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "octo/demo",
    emissionShare: 0.02,
    issueDiscoveryShare: 0.25,
    labelMultipliers: { bug: 1.2 },
    maintainerCut: 0,
    raw: {},
  },
};

describe("explainScoreBreakdown", () => {
  it("explains each multiplier with a concrete improvement lever", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 4,
        existingContributorTokenScore: 100,
        credibility: 0.5,
        changesRequestedCount: 2,
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "raw", source: "github_cache", issueNumbers: [12] },
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    const componentNames = breakdown.components.map((entry) => entry.component);
    expect(componentNames).toEqual(
      expect.arrayContaining([
        "densityMultiplier",
        "contributionBonus",
        "labelMultiplier",
        "issueMultiplier",
        "credibilityMultiplier",
        "reviewPenaltyMultiplier",
        "openPrMultiplier",
        "openIssueMultiplier",
        "mergedHistoryMultiplier",
      ]),
    );
    for (const component of breakdown.components) {
      expect(component.summary.length).toBeGreaterThan(0);
      expect(component.lever.length).toBeGreaterThan(0);
      expect(["full", "reduced", "neutral", "blocked"]).toContain(component.band);
    }
    expect(breakdown.highestLeverageLever.component).toBeTruthy();
    expect(breakdown.highestLeverageLever.lever).toMatch(/merge|close|credibility|open PR|linked issue|density|review/i);
    expect(JSON.stringify(breakdown)).not.toMatch(FORBIDDEN);
    // No open issues → within the allowance → full band on the open-issue gate.
    expect(breakdown.components.find((entry) => entry.component === "openIssueMultiplier")).toMatchObject({ band: "full" });
    // No observed merged-PR history → treated as eligible (full), with an explicit "not yet observed" note.
    const mergedHistory = breakdown.components.find((entry) => entry.component === "mergedHistoryMultiplier");
    expect(mergedHistory).toMatchObject({ band: "full" });
    expect(mergedHistory?.summary).toMatch(/not yet observed/i);
  });

  it("explains the merged-PR history floor: meets the floor when observed, blocks when below", () => {
    const base = { repoFullName: repo.fullName, contributorLogin: "miner", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 80 };
    const eligible = explainScoreBreakdown(buildScorePreview({ repo, snapshot, input: { ...base, mergedPullRequests: 5 } }));
    const below = explainScoreBreakdown(buildScorePreview({ repo, snapshot, input: { ...base, mergedPullRequests: 1 } }));
    const eMerged = eligible.components.find((entry) => entry.component === "mergedHistoryMultiplier");
    const bMerged = below.components.find((entry) => entry.component === "mergedHistoryMultiplier");
    // 5 merged PRs clears the default MIN_VALID_MERGED_PRS (3) floor.
    expect(eMerged).toMatchObject({ band: "full" });
    expect(eMerged?.summary).toMatch(/meets the upstream validity floor/i);
    // 1 merged PR is below the floor → scoring gated to zero.
    expect(bMerged).toMatchObject({ band: "blocked" });
    expect(bMerged?.summary).toMatch(/below the upstream validity floor/i);
    expect(bMerged?.lever).toMatch(/build more merged-PR history/i);
    expect(JSON.stringify(below)).not.toMatch(FORBIDDEN);
  });

  it("explains an over-threshold open-issue count as a blocked open-issue spam gate", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openIssueCount: 50,
        linkedIssueMode: "standard",
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    const openIssue = breakdown.components.find((entry) => entry.component === "openIssueMultiplier");
    expect(openIssue).toMatchObject({ band: "blocked" });
    expect(openIssue?.summary).toMatch(/exceeds the current allowance/i);
    expect(openIssue?.lever).toMatch(/close or resolve/i);
    expect(JSON.stringify(breakdown)).not.toMatch(FORBIDDEN);
  });

  it("prioritizes open PR blocking as the highest leverage lever", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 80,
        totalTokenScore: 100,
        sourceLines: 50,
        openPrCount: 8,
        existingContributorTokenScore: 50,
        credibility: 1,
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.components.find((entry) => entry.component === "openPrMultiplier")).toMatchObject({ band: "blocked" });
    expect(breakdown.highestLeverageLever.component).toBe("openPrMultiplier");
    expect(breakdown.highestLeverageLever.lever).toMatch(/Land, merge, or close/i);
  });

  it("includes gate highlights without leaking forbidden language", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 80,
        sourceLines: 40,
        openPrCount: 3,
        existingContributorTokenScore: 900,
        credibility: 0.6,
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [3], solvedByPullRequests: [44] },
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.gateHighlights.length).toBeGreaterThan(0);
    expect(breakdown.gateHighlights[0]?.explanation).toMatch(/private context|estimated score/i);
    expect(JSON.stringify(breakdown.gateHighlights)).not.toMatch(FORBIDDEN);
  });

  it("covers healthy multiplier branches and contribution bonus density messaging", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 120,
        totalTokenScore: 1600,
        sourceLines: 120,
        openPrCount: 0,
        existingContributorTokenScore: 1200,
        credibility: 1,
        changesRequestedCount: 0,
        labels: ["bug"],
        linkedIssueMode: "none",
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.components.find((entry) => entry.component === "densityMultiplier")?.summary).toMatch(/Contribution bonus is already contributing/i);
    expect(breakdown.components.find((entry) => entry.component === "labelMultiplier")).toMatchObject({ band: "full" });
    expect(breakdown.components.find((entry) => entry.component === "issueMultiplier")).toMatchObject({ band: "neutral" });
    expect(breakdown.components.find((entry) => entry.component === "openPrMultiplier")).toMatchObject({ band: "full" });
    expect(breakdown.components.find((entry) => entry.component === "credibilityMultiplier")).toMatchObject({ band: "full" });
    expect(breakdown.components.find((entry) => entry.component === "reviewPenaltyMultiplier")).toMatchObject({ band: "full" });
  });

  it("marks penalty label multipliers as reduced strength (#994)", () => {
    const penaltyRepo: RepositoryRecord = {
      ...repo,
      registryConfig: { ...repo.registryConfig!, labelMultipliers: { refactor: 0.5, bug: 1.2 } },
    };
    const preview = buildScorePreview({
      repo: penaltyRepo,
      snapshot,
      input: {
        repoFullName: penaltyRepo.fullName,
        sourceTokenScore: 80,
        totalTokenScore: 120,
        sourceLines: 60,
        openPrCount: 0,
        credibility: 1,
        labels: ["refactor"],
        linkedIssueMode: "none",
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.components.find((entry) => entry.component === "labelMultiplier")).toMatchObject({
      band: "reduced",
      summary: expect.stringMatching(/penalty label multiplier/i),
    });
  });

  it("explains failed base-token and invalid linked-issue branches", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 0,
        totalTokenScore: 0,
        sourceLines: 10,
        openPrCount: 0,
        credibility: 1,
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "invalid", source: "github_cache", issueNumbers: [9], reason: "Issue #9 is closed." },
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.components.find((entry) => entry.component === "densityMultiplier")).toMatchObject({ band: "blocked" });
    expect(breakdown.components.find((entry) => entry.component === "issueMultiplier")?.lever).toMatch(/Fix linked issue state/i);
    expect(breakdown.highestLeverageLever.component).toBe("densityMultiplier");
  });

  it("selects a reduced multiplier as highest leverage when nothing is fully blocked", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 80,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 1,
        existingContributorTokenScore: 1200,
        credibility: 0.7,
        changesRequestedCount: 1,
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "plausible", source: "github_cache", issueNumbers: [4] },
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.highestLeverageLever.reason).toMatch(/reducer|optimization lever/i);
    expect(breakdown.highestLeverageLever.component).toMatch(/credibilityMultiplier|issueMultiplier|reviewPenaltyMultiplier/);
  });

  it("marks eligible linked issues with a multiplier boost as full strength", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 80,
        totalTokenScore: 120,
        sourceLines: 60,
        openPrCount: 0,
        existingContributorTokenScore: 1200,
        credibility: 1,
        linkedIssueMode: "maintainer",
        linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [7], solvedByPullRequests: [99] },
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.components.find((entry) => entry.component === "issueMultiplier")).toMatchObject({ band: "full" });
  });

  it("blocks near-zero multipliers that are not quite zero", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 80,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 20,
        existingContributorTokenScore: 50,
        credibility: 0.005,
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.components.find((entry) => entry.component === "credibilityMultiplier")).toMatchObject({ band: "blocked" });
    expect(breakdown.components.find((entry) => entry.component === "openPrMultiplier")).toMatchObject({ band: "blocked" });
  });
});
