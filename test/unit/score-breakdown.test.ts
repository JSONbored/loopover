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
    MAX_CONTRIBUTION_BONUS: 5,
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
        "baseScore",
        "densityMultiplier",
        "contributionBonus",
        "labelMultiplier",
        "issueMultiplier",
        "credibilityMultiplier",
        "reviewPenaltyMultiplier",
        "reviewCollateralMultiplier",
        "openPrMultiplier",
        "openIssueMultiplier",
        "mergedHistoryMultiplier",
        "timeDecayMultiplier",
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
  });

  it("explains the merged-PR history floor as neutral (unobserved), full (meets floor), and blocked (below floor)", () => {
    // Unobserved history -> floor not enforced -> neutral.
    const unobserved = explainScoreBreakdown(
      buildScorePreview({ repo, snapshot, input: { repoFullName: repo.fullName, contributorLogin: "miner", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 80, openPrCount: 1, credibility: 0.9, linkedIssueMode: "none" } }),
    );
    expect(unobserved.components.find((entry) => entry.component === "mergedHistoryMultiplier")).toMatchObject({ band: "neutral" });

    // Observed >= upstream floor (MIN_VALID_MERGED_PRS = 3) -> full.
    const meets = explainScoreBreakdown(
      buildScorePreview({ repo, snapshot, input: { repoFullName: repo.fullName, contributorLogin: "miner", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 80, openPrCount: 1, credibility: 0.9, linkedIssueMode: "none", mergedPullRequests: 5 } }),
    );
    expect(meets.components.find((entry) => entry.component === "mergedHistoryMultiplier")).toMatchObject({ band: "full" });

    // Observed < floor -> blocked, and the merged-PR lever is the top-leverage one.
    const blocked = explainScoreBreakdown(
      buildScorePreview({ repo, snapshot, input: { repoFullName: repo.fullName, contributorLogin: "miner", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 80, openPrCount: 1, credibility: 0.9, linkedIssueMode: "none", mergedPullRequests: 1 } }),
    );
    expect(blocked.components.find((entry) => entry.component === "mergedHistoryMultiplier")).toMatchObject({ band: "blocked", leverageScore: 100 });
    expect(blocked.highestLeverageLever.lever).toMatch(/merge/i);
    expect(JSON.stringify(blocked)).not.toMatch(FORBIDDEN);
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

  it("explains the time-decay multiplier as neutral (fresh / disabled) and reduced (aged with decay on)", () => {
    // Default preview: applyTimeDecay is off / PR is fresh => multiplier is 1 => breakdown neutral, surface
    // the decay-disable context so a contributor understands why there is no age penalty here.
    const fresh = explainScoreBreakdown(
      buildScorePreview({ repo, snapshot, input: { repoFullName: repo.fullName, contributorLogin: "miner", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 80, openPrCount: 1, credibility: 0.9, linkedIssueMode: "none" } }),
    );
    expect(fresh.components.find((entry) => entry.component === "timeDecayMultiplier")).toMatchObject({ band: "neutral" });

    // Opt-in + aged PR => upstream sigmoid reduces the multiplier => breakdown reduced with the aged-PR lever.
    const aged = buildScorePreview({
      repo,
      snapshot,
      input: { repoFullName: repo.fullName, contributorLogin: "miner", sourceTokenScore: 40, totalTokenScore: 60, sourceLines: 80, openPrCount: 1, credibility: 0.9, linkedIssueMode: "none", applyTimeDecay: true, prAgeHours: 480 },
    });
    const agedBreakdown = explainScoreBreakdown(aged);
    const decayed = agedBreakdown.components.find((entry) => entry.component === "timeDecayMultiplier")!;
    expect(decayed.band).not.toBe("neutral");
    expect(decayed.band).not.toBe("full");
    expect(decayed.summary).toMatch(/time-decayed|decay/i);
    expect(decayed.lever).toMatch(/fresh|time-decay curve|sigmoid/i);
    expect(JSON.stringify(agedBreakdown)).not.toMatch(FORBIDDEN);
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
    expect(breakdown.components.find((entry) => entry.component === "reviewCollateralMultiplier")).toMatchObject({ band: "neutral" });
  });

  it("explains elevated open-PR review collateral as reduced strength and baseline as neutral", () => {
    const baseline = explainScoreBreakdown(
      buildScorePreview({
        repo,
        snapshot,
        input: {
          repoFullName: repo.fullName,
          sourceTokenScore: 80,
          totalTokenScore: 100,
          sourceLines: 50,
          openPrCount: 1,
          credibility: 1,
          changesRequestedCount: 0,
        },
      }),
    );
    expect(baseline.components.find((entry) => entry.component === "reviewCollateralMultiplier")).toMatchObject({
      band: "neutral",
      summary: expect.stringMatching(/baseline fraction/i),
    });

    const elevated = explainScoreBreakdown(
      buildScorePreview({
        repo,
        snapshot: {
          ...snapshot,
          constants: { ...snapshot.constants, MAX_OPEN_PR_REVIEW_COLLATERAL_MULTIPLIER: 2.0 },
        },
        input: {
          repoFullName: repo.fullName,
          sourceTokenScore: 80,
          totalTokenScore: 100,
          sourceLines: 50,
          openPrCount: 1,
          credibility: 1,
          changesRequestedCount: 4,
        },
      }),
    );
    const collateral = elevated.components.find((entry) => entry.component === "reviewCollateralMultiplier");
    expect(collateral).toMatchObject({ band: "reduced" });
    expect(collateral?.summary).toMatch(/elevated|CHANGES_REQUESTED/i);
    expect(collateral?.summary).toMatch(/0\.32/);
    expect(collateral?.lever).toMatch(/change requests/i);
    expect(JSON.stringify(elevated)).not.toMatch(FORBIDDEN);

    const capped = explainScoreBreakdown(
      buildScorePreview({
        repo,
        snapshot: {
          ...snapshot,
          constants: { ...snapshot.constants, MAX_OPEN_PR_REVIEW_COLLATERAL_MULTIPLIER: 2.0 },
        },
        input: {
          repoFullName: repo.fullName,
          sourceTokenScore: 80,
          totalTokenScore: 100,
          sourceLines: 50,
          openPrCount: 1,
          credibility: 1,
          changesRequestedCount: 10,
        },
      }),
    );
    expect(capped.components.find((entry) => entry.component === "reviewCollateralMultiplier")).toMatchObject({
      band: "reduced",
      summary: expect.stringMatching(/0\.4/),
    });
  });

  it("prioritizes open PR blocking above elevated review collateral", () => {
    const preview = buildScorePreview({
      repo,
      snapshot: {
        ...snapshot,
        constants: { ...snapshot.constants, MAX_OPEN_PR_REVIEW_COLLATERAL_MULTIPLIER: 2.0 },
      },
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 80,
        totalTokenScore: 100,
        sourceLines: 50,
        openPrCount: 8,
        existingContributorTokenScore: 50,
        credibility: 1,
        changesRequestedCount: 4,
      },
    });

    const breakdown = explainScoreBreakdown(preview);
    expect(breakdown.components.find((entry) => entry.component === "reviewCollateralMultiplier")).toMatchObject({ band: "reduced" });
    expect(breakdown.highestLeverageLever.component).toBe("openPrMultiplier");
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
    // baseScore and densityMultiplier tie at leverageScore 75 when the gate is not passed;
    // baseScore wins alphabetically as the root-cause lever.
    expect(breakdown.highestLeverageLever.component).toBe("baseScore");
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

  it("blocks base-score projection when the source-token gate has not passed", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 0,
        totalTokenScore: 0,
        sourceLines: 4,
        openPrCount: 0,
        credibility: 1,
      },
    });
    const entry = explainScoreBreakdown(preview).components.find((c) => c.component === "baseScore")!;
    expect(entry).toMatchObject({ band: "blocked", leverageScore: 75 });
    expect(entry.summary).toMatch(/not yet in the score pipeline|minimum meaningful source-change/);
  });

  it("surfaces a neutral (sub-cap) base score with the contribution bonus present", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 25,
        totalTokenScore: 800,
        sourceLines: 120,
        openPrCount: 0,
        credibility: 1,
      },
    });
    const entry = explainScoreBreakdown(preview).components.find((c) => c.component === "baseScore")!;
    expect(entry).toMatchObject({ band: "neutral" });
    expect(entry.summary).toMatch(/contributing toward|base \d|contribution bonus/);
  });

  it("surfaces a neutral base-score branch when gate passed but no contribution bonus earned", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 10,
        totalTokenScore: 0,
        sourceLines: 40,
        openPrCount: 0,
        credibility: 1,
      },
    });
    const entry = explainScoreBreakdown(preview).components.find((c) => c.component === "baseScore")!;
    expect(entry).toMatchObject({ band: "neutral" });
    expect(entry.leverageScore).toBe(12);
    expect(entry.summary).toMatch(/contributing toward|base \d|contribution bonus not contributing/);
  });

  it("surfaces the base score as saturated (full) near the score cap", () => {
    // Density model: baseScoreCap = MERGED_PR_BASE_SCORE × MAX_CODE_DENSITY_MULTIPLIER +
    // MAX_CONTRIBUTION_BONUS = 25 × 1.15 + 5 = 33.75. Need baseScore / baseScoreCap ≥ 0.95 (≈ 32.06).
    // With densityMultiplier = 1.15 and totalTokenScore ≥ 993 (full bonus 5), baseScore = 28.75 + 5 = 33.75.
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 200,
        totalTokenScore: 1500,
        sourceLines: 170,
        openPrCount: 0,
        credibility: 1,
      },
    });
    const entry = explainScoreBreakdown(preview).components.find((c) => c.component === "baseScore")!;
    expect(entry).toMatchObject({ band: "full" });
    expect(entry.summary).toMatch(/saturated near the score cap/);
    expect(JSON.stringify(explainScoreBreakdown(preview))).not.toMatch(FORBIDDEN);
  });

  it("adapts the saturation threshold to non-default snapshot constants (regression)", () => {
    // Use a snapshot with different constants to prove the threshold is not hardcoded to 29.5.
    // If MERGED_PR_BASE_SCORE=50 and MAX_CONTRIBUTION_BONUS=10, cap = 50 × 1.15 + 10 = 67.5.
    // 95% saturation ≈ 64.13. Inputs that would give baseScore=32 (well below 64) must NOT read as full.
    const altSnapshot: ScoringModelSnapshotRecord = {
      ...snapshot,
      id: "score-model-alt-cap",
      constants: {
        ...snapshot.constants,
        MERGED_PR_BASE_SCORE: 50,
        MAX_CONTRIBUTION_BONUS: 10,
      },
    };
    const altCap = 50 * 1.15 + 10; // 67.5
    const saturationRatio = 0.95;
    // With source 200 / lines 170 → density 1.15 → baseDensity = 50 × 1.15 = 57.5.
    // totalTokenScore 0 → contributionBonus 0 → baseScore = 57.5 < 64.13 → NOT saturated.
    const subCap = buildScorePreview({
      repo,
      snapshot: altSnapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 200,
        totalTokenScore: 0,
        sourceLines: 170,
        openPrCount: 0,
        credibility: 1,
      },
    });
    const notSaturated = explainScoreBreakdown(subCap).components.find((c) => c.component === "baseScore")!;
    expect(notSaturated).toMatchObject({ band: "neutral" });
    // Full bonus (totalTokenScore >= 1500) → baseScore = 57.5 + 10 = 67.5, which IS ≥ 95% of 67.5.
    const saturated = buildScorePreview({
      repo,
      snapshot: altSnapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 200,
        totalTokenScore: 1500,
        sourceLines: 170,
        openPrCount: 0,
        credibility: 1,
      },
    });
    const isSaturated = explainScoreBreakdown(saturated).components.find((c) => c.component === "baseScore")!;
    expect(isSaturated).toMatchObject({ band: "full" });
    expect(isSaturated.summary).toMatch(/saturated near the score cap/);
    expect(JSON.stringify(explainScoreBreakdown(saturated))).not.toMatch(FORBIDDEN);
  });
});
