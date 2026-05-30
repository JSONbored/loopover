import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestScoringModelSnapshot } from "../../src/db/repositories";
import { detectActiveModel, parsePythonNumberConstants, refreshScoringModelSnapshot } from "../../src/scoring/model";
import { buildScorePreview, makeScorePreviewRecord } from "../../src/scoring/preview";
import type { RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

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

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  isInstalled: false,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.02,
    issueDiscoveryShare: 0.25,
    labelMultipliers: { bug: 1.2, refactor: 0.5 },
    maintainerCut: 0,
    raw: {},
  },
};

describe("scoring model and previews", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses known upstream numeric constants and detects the current density model", () => {
    const parsed = parsePythonNumberConstants(`
OSS_EMISSION_SHARE = 0.90
MAX_CODE_DENSITY_MULTIPLIER = 1.15
MIN_TOKEN_SCORE_FOR_BASE_SCORE = 5
IGNORED = "not numeric"
`);
    expect(parsed).toMatchObject({ OSS_EMISSION_SHARE: 0.9, MAX_CODE_DENSITY_MULTIPLIER: 1.15, MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5 });
    expect(parsed).not.toHaveProperty("IGNORED");
    expect(detectActiveModel(parsed)).toBe("current_density_model");
    expect(detectActiveModel({ SRC_TOK_SATURATION_SCALE: 58 })).toBe("pending_saturation_model");
    expect(detectActiveModel({})).toBe("unknown");
  });

  it("prefers exponential saturation when mixed upstream constants are present", () => {
    const parsed = parsePythonNumberConstants(`
MERGED_PR_BASE_SCORE = 25
MAX_CONTRIBUTION_BONUS = 5
CONTRIBUTION_SCORE_FOR_FULL_BONUS = 1500
SRC_TOK_SATURATION_SCALE = 58.0
MIN_TOKEN_SCORE_FOR_BASE_SCORE = 5
MAX_CODE_DENSITY_MULTIPLIER = 1.15
`);
    expect(parsed).toMatchObject({ SRC_TOK_SATURATION_SCALE: 58, MAX_CONTRIBUTION_BONUS: 5 });
    expect(detectActiveModel(parsed)).toBe("pending_saturation_model");
  });

  it("uses saturation math as the active private preview model", () => {
    const saturationSnapshot: ScoringModelSnapshotRecord = {
      ...snapshot,
      activeModel: "pending_saturation_model",
      constants: {
        ...snapshot.constants,
        MAX_CONTRIBUTION_BONUS: 5,
        SRC_TOK_SATURATION_SCALE: 58,
      },
    };
    const preview = buildScorePreview({
      repo,
      snapshot: saturationSnapshot,
      input: {
        repoFullName: repo.fullName,
        labels: ["bug"],
        linkedIssueMode: "standard",
        sourceTokenScore: 58,
        totalTokenScore: 1500,
        sourceLines: 120,
        openPrCount: 0,
        credibility: 1,
      },
    });

    expect(preview.activeModel).toBe("pending_saturation_model");
    expect(preview.scoreEstimate.baseScore).toBeCloseTo(20.803, 3);
    expect(preview.scoreEstimate.pendingSaturationScore).toBe(preview.scoreEstimate.baseScore);
    expect(preview.scoreEstimate.estimatedMergedScore).toBeCloseTo(33.2016, 3);
    expect(preview.gates.baseTokenGatePassed).toBe(true);
    expect(JSON.stringify(preview.scoreEstimate)).not.toMatch(/reward estimate|wallet|hotkey|farming|payout/i);
  });

  it("keeps lane math tied to the recorded model snapshot and clamps score gates", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        labels: ["bug"],
        linkedIssueMode: "standard",
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 2,
        credibility: 1,
      },
    });
    expect(preview.scoringModelSnapshotId).toBe(snapshot.id);
    expect(preview.laneMath).toMatchObject({
      repoSlice: 0.018,
      directPrSlice: 0.0135,
      issueDiscoverySlice: 0.0045,
    });
    expect(preview.scoreEstimate.labelMultiplier).toBe(1.2);
    expect(preview.scoreEstimate.issueMultiplier).toBe(1.33);
    expect(preview.gates.baseTokenGatePassed).toBe(true);
    expect(preview.privateOnly).toBe(true);
  });

  it("shows conditional scoreability when current open PR pressure zeroes the effective score", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        linkedIssueMode: "standard",
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 3,
        credibility: 1,
        pendingMergedPrCount: 1,
      },
    });
    expect(preview.effectiveEstimatedScore).toBe(0);
    expect(preview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(preview.scoreabilityStatus).toBe("conditionally_scoreable");
    expect(preview.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "open_pr_threshold" })]));
    expect(preview.scenarioPreviews.find((scenario) => scenario.name === "cleanGates")?.scoreEstimate.openPrMultiplier).toBe(1);
    expect(preview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges")?.effectiveEstimatedScore).toBeGreaterThan(0);
    expect(preview.gateDeltas).toEqual(expect.arrayContaining([expect.objectContaining({ gate: "open_pr_threshold" })]));
  });

  it("projects credibility and linked-issue scenarios without claiming guaranteed payouts", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 0,
        credibility: 0,
        approvedPrCount: 3,
        projectedCredibility: 0.8,
        scenarioNotes: ["three approved PRs are expected to merge tonight"],
      },
    });
    const afterPending = preview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
    const linkedIssueFixed = preview.scenarioPreviews.find((scenario) => scenario.name === "linkedIssueFixed");
    expect(preview.effectiveEstimatedScore).toBe(0);
    expect(preview.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "credibility_floor" })]));
    expect(afterPending?.source).toBe("user_supplied");
    expect(afterPending?.gates.credibilityObserved).toBe(0.8);
    expect(afterPending?.effectiveEstimatedScore).toBeGreaterThan(0);
    expect(linkedIssueFixed?.scoreEstimate.issueMultiplier).toBe(1.33);
    expect(JSON.stringify(preview)).not.toMatch(/guaranteed payout|wallet|hotkey|farming/i);
  });

  it("keeps GitHub-observed pending PR scenarios separate from user assumptions", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 5,
        credibility: 0.2,
        pendingMergedPrCount: 1,
        projectedCredibility: 0.5,
        observedApprovedPrCount: 1,
        observedStalePrCount: 1,
        observedDraftPrCount: 1,
        observedBlockedPrCount: 1,
        observedMaintainerPrCount: 1,
      },
    });
    const userSupplied = preview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
    const approved = preview.scenarioPreviews.find((scenario) => scenario.name === "afterApprovedPrsMerge");
    const stale = preview.scenarioPreviews.find((scenario) => scenario.name === "afterStalePrsClose");

    expect(userSupplied).toMatchObject({ source: "user_supplied", gates: { openPrCount: 4, credibilityObserved: 0.5 } });
    expect(approved).toMatchObject({ source: "github_observed", gates: { openPrCount: 4, credibilityObserved: 0.8 } });
    expect(stale).toMatchObject({ source: "github_observed", gates: { openPrCount: 4, credibilityObserved: 0.2 } });
    expect(approved?.assumptions.join(" ")).toMatch(/draft PR.*excluded|blocked PR.*excluded|maintainer-lane PR.*outside-contributor/);
    expect(preview.effectiveEstimatedScore).toBe(0);
    expect(preview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(JSON.stringify(preview)).not.toMatch(/guaranteed payout|wallet|hotkey|farming/i);
  });

  it("warns on metadata-only weak previews without using public reward or wallet language", () => {
    const preview = buildScorePreview({
      repo: null,
      snapshot,
      input: {
        repoFullName: "missing/repo",
        metadataOnly: true,
        sourceTokenScore: 1,
        totalTokenScore: 1,
        openPrCount: 99,
        credibility: 0.2,
        changesRequestedCount: 4,
      },
    });
    expect(preview.recommendation.level).toBe("hold");
    expect(preview.warnings.join(" ")).toMatch(/metadata-only|not registered|base-score|threshold/i);
    expect(JSON.stringify(preview)).not.toMatch(/wallet|farming|raw trust|guaranteed payout/i);
  });

  it("covers maintainer issue multipliers, fixed base scores, and evidence-derived credibility", () => {
    const preview = buildScorePreview({
      repo: { ...repo, registryConfig: { ...repo.registryConfig!, fixedBaseScore: 12, defaultLabelMultiplier: 1.05 } },
      snapshot,
      contributorEvidence: {
        login: "jsonbored",
        generatedAt: "2026-05-23T00:00:00.000Z",
        payload: { mergedPullRequests: 4, stalePullRequests: 0, unlinkedPullRequests: 0 },
      },
      input: {
        repoFullName: repo.fullName,
        labels: ["unknown"],
        linkedIssueMode: "maintainer",
        sourceTokenScore: 100,
        totalTokenScore: 200,
        sourceLines: 10,
        openPrCount: 0,
      },
    });
    expect(preview.scoreEstimate.baseScore).toBe(12);
    expect(preview.scoreEstimate.labelMultiplier).toBe(1.05);
    expect(preview.scoreEstimate.issueMultiplier).toBe(1.66);
    expect(preview.scoreEstimate.credibilityMultiplier).toBe(1);

    const explicitRecord = makeScorePreviewRecord({ repoFullName: repo.fullName, targetType: "pull_request", targetKey: "pr-1" }, snapshot, preview);
    const defaultRecord = makeScorePreviewRecord({ repoFullName: repo.fullName }, snapshot, preview);
    expect(explicitRecord).toMatchObject({ targetType: "pull_request", targetKey: "pr-1" });
    expect(defaultRecord).toMatchObject({ targetType: "planned_pr" });
    expect(defaultRecord.targetKey).toContain("entrius/allways-ui:planned_pr:");

    const fallbackCredibility = buildScorePreview({
      repo,
      snapshot,
      contributorEvidence: {
        login: "riskdev",
        generatedAt: "2026-05-23T00:00:00.000Z",
        payload: { mergedPullRequests: "not-a-number", stalePullRequests: 0, unlinkedPullRequests: 0 },
      },
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: Number.NaN,
        totalTokenScore: Number.NaN,
        sourceLines: Number.NaN,
      },
    });
    expect(fallbackCredibility.gates.credibilityObserved).toBe(0.8);
    expect(fallbackCredibility.gates.baseTokenGatePassed).toBe(false);
  });

  it("refreshes scoring snapshots from upstream fixtures and falls back cleanly", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("constants.py")) {
        return new Response("OSS_EMISSION_SHARE = 0.90\nMERGED_PR_BASE_SCORE = 25\nSRC_TOK_SATURATION_SCALE = 58\nMIN_TOKEN_SCORE_FOR_BASE_SCORE = 5\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n");
      }
      if (url.includes("programming_languages.json")) return Response.json({ TypeScript: 1, Python: 0.8 });
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshScoringModelSnapshot(env);
    expect(refreshed.sourceKind).toBe("raw-github");
    expect(refreshed.activeModel).toBe("pending_saturation_model");
    expect(refreshed.warnings.join(" ")).toMatch(/density-era indicators/i);
    expect(refreshed.programmingLanguages).toMatchObject({ TypeScript: 1 });
    await expect(getLatestScoringModelSnapshot(env)).resolves.toMatchObject({ id: refreshed.id });

    const fallbackEnv = createTestEnv();
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const fallback = await refreshScoringModelSnapshot(fallbackEnv);
    expect(fallback.sourceKind).toBe("fallback");
    expect(fallback.warnings.join(" ")).toMatch(/fetch failed/i);
    expect(fallback.constants.OSS_EMISSION_SHARE).toBe(0.9);

    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const thrownFallback = await refreshScoringModelSnapshot(createTestEnv());
    expect(thrownFallback.sourceKind).toBe("fallback");
  });
});
