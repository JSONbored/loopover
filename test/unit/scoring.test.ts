import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestScoringModelSnapshot, listUpstreamDriftReports } from "../../src/db/repositories";
import { DEFAULT_SCORING_CONSTANTS, detectActiveModel, findUnmodeledUpstreamConstants, isTimeDecayEnabled, parsePythonNumberConstants, refreshScoringModelSnapshot } from "../../src/scoring/model";
import { buildScorePreview, calculateTimeDecay, makeScorePreviewRecord, resolveTimeDecay } from "../../src/scoring/preview";
import { unmodeledScoringConstantsFingerprint } from "../../src/upstream/unmodeled-scoring-drift";
import type { ScorePreviewInput } from "../../src/scoring/preview";
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

  it("parses known upstream numeric constants and prefers the saturation model when upstream exposes it", () => {
    const parsed = parsePythonNumberConstants(`
OSS_EMISSION_SHARE = 0.90
MAX_CODE_DENSITY_MULTIPLIER = 1.15
MIN_TOKEN_SCORE_FOR_BASE_SCORE = 5
IGNORED = "not numeric"
`);
    expect(parsed).toMatchObject({ OSS_EMISSION_SHARE: 0.9, MAX_CODE_DENSITY_MULTIPLIER: 1.15, MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5 });
    expect(parsed).not.toHaveProperty("IGNORED");
    expect(detectActiveModel(parsed)).toBe("current_density_model");
    expect(detectActiveModel({ MAX_CODE_DENSITY_MULTIPLIER: 1.15, SRC_TOK_SATURATION_SCALE: 58 })).toBe("pending_saturation_model");
    expect(detectActiveModel({})).toBe("unknown");
  });

  it("parses underscore separators, floats, and scientific notation without truncating (#810)", () => {
    const parsed = parsePythonNumberConstants(`
CONTRIBUTION_SCORE_FOR_FULL_BONUS = 1_500_000
SRC_TOK_SATURATION_SCALE = 5.8e1
MERGED_PR_BASE_SCORE = 1e-9
OSS_EMISSION_SHARE = 0.90
`);
    // The previous /[-+]?\d+(?:\.\d+)?/ regex stopped at `_`/`e`: 1_500_000 -> 1, 5.8e1 -> 5.8, 1e-9 -> 1.
    expect(parsed.CONTRIBUTION_SCORE_FOR_FULL_BONUS).toBe(1500000);
    expect(parsed.SRC_TOK_SATURATION_SCALE).toBe(58);
    expect(parsed.MERGED_PR_BASE_SCORE).toBe(1e-9);
    expect(parsed.OSS_EMISSION_SHARE).toBe(0.9);
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

  it("uses upstream's exact constant names and fallback values (#806, #807)", () => {
    // #807: the fetch-failure fallback for MAX_CONTRIBUTION_BONUS must equal upstream's value (5), never the
    // old 25 that silently 5x-inflated the contribution bonus whenever the upstream fetch failed.
    expect(DEFAULT_SCORING_CONSTANTS.MAX_CONTRIBUTION_BONUS).toBe(5);
    // #806: the treasury share must use upstream's plural spelling (ISSUES_…) so it actually syncs instead of
    // freezing at the local default and showing up as a false "unmodeled" drift warning.
    expect(DEFAULT_SCORING_CONSTANTS).toHaveProperty("ISSUES_TREASURY_EMISSION_SHARE");
    expect(DEFAULT_SCORING_CONSTANTS).not.toHaveProperty("ISSUE_TREASURY_EMISSION_SHARE");
    // When upstream sends the plural name it is recognized, not reported as unmodeled drift.
    expect(
      findUnmodeledUpstreamConstants("ISSUES_TREASURY_EMISSION_SHARE = 0.1\nMAX_CONTRIBUTION_BONUS = 5\n"),
    ).not.toContain("ISSUES_TREASURY_EMISSION_SHARE");
  });

  it("detects the active model from fetched constants before default fallback constants", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "token" });
    const fetchedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      fetchedUrls.push(url);
      if (url.includes("constants.py")) {
        return new Response("MIN_TOKEN_SCORE_FOR_BASE_SCORE = 5\nMAX_CODE_DENSITY_MULTIPLIER = 1.15\n");
      }
      if (url.includes("programming_languages.json")) return Response.json({ TypeScript: 1 });
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshScoringModelSnapshot(env);

    expect(refreshed.activeModel).toBe("current_density_model");
    // Upstream did not send MAX_CONTRIBUTION_BONUS, so it falls back to the local default — which must match
    // upstream's value of 5, not the old inflated 25 (#807).
    expect(refreshed.constants.MAX_CONTRIBUTION_BONUS).toBe(5);
    expect(refreshed.constants.SRC_TOK_SATURATION_SCALE).toBe(58);
    expect(refreshed.warnings).not.toEqual(expect.arrayContaining([expect.stringContaining("density-era indicators")]));
    expect(fetchedUrls).toContain("https://raw.githubusercontent.com/entrius/gittensor/test/gittensor/constants.py");
  });

  it("warns when fetched constants do not identify a known active model", async () => {
    const env = createTestEnv();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("constants.py")) return new Response("MERGED_PR_BASE_SCORE = 25\n");
      if (url.includes("programming_languages.json")) return Response.json({});
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshScoringModelSnapshot(env);

    expect(refreshed.activeModel).toBe("unknown");
    expect(refreshed.warnings.join(" ")).toMatch(/recognized active-model indicator/i);
  });

  it("flags upstream scoring constants gittensory does not model (staleness visibility)", () => {
    // SRC_TOK_SATURATION_SCALE and the TIME_DECAY_* constants are now modeled (#703); a hypothetical new
    // upstream dimension is NOT — so only that surfaces as unmodeled drift.
    const unmodeled = findUnmodeledUpstreamConstants(
      "SRC_TOK_SATURATION_SCALE = 58.0\nTIME_DECAY_GRACE_PERIOD_HOURS = 12\nNOVELTY_BONUS_SCALAR = 3\n",
    );
    expect(unmodeled).toEqual(["NOVELTY_BONUS_SCALAR"]);
    expect(unmodeled).not.toContain("SRC_TOK_SATURATION_SCALE");
    expect(unmodeled).not.toContain("TIME_DECAY_GRACE_PERIOD_HOURS"); // modeled as of #703
  });

  it("warns on the snapshot when upstream defines an unmodeled scoring dimension", async () => {
    const env = createTestEnv({
      GITTENSOR_UPSTREAM_REPO: "custom/upstream",
      GITTENSOR_UPSTREAM_REF: "staging",
    });
    const fetchedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      fetchedUrls.push(url);
      if (url.includes("constants.py")) return new Response("SRC_TOK_SATURATION_SCALE = 58.0\nNOVELTY_BONUS_SCALAR = 3\n");
      if (url.includes("programming_languages.json")) return Response.json({ TypeScript: 1 });
      return new Response("not found", { status: 404 });
    });

    const refreshed = await refreshScoringModelSnapshot(env);

    expect(refreshed.sourceUrl).toBe("https://raw.githubusercontent.com/custom/upstream/staging/gittensor/constants.py");
    expect(fetchedUrls).toContain("https://raw.githubusercontent.com/custom/upstream/staging/gittensor/constants.py");
    expect(refreshed.warnings.join(" ")).toMatch(/does not yet model.*NOVELTY_BONUS_SCALAR/);
    expect(refreshed.payload.constants).toMatchObject({ unmodeledUpstreamConstants: ["NOVELTY_BONUS_SCALAR"] });
    const fingerprint = await unmodeledScoringConstantsFingerprint();
    expect((await listUpstreamDriftReports(env, 10)).find((report) => report.fingerprint === fingerprint)).toMatchObject({
      status: "open",
      affectedAreas: ["scoring_model"],
      payload: expect.objectContaining({
        unmodeledUpstreamConstants: ["NOVELTY_BONUS_SCALAR"],
        source: { repo: "custom/upstream", ref: "staging", commitSha: null },
      }),
    });
  });

  it("uses saturation math as the active private preview model", () => {
    const saturationSnapshot: ScoringModelSnapshotRecord = {
      ...snapshot,
      activeModel: "pending_saturation_model",
      constants: {
        ...snapshot.constants,
        MAX_CONTRIBUTION_BONUS: 25,
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
        linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [7], solvedByPullRequests: [100] },
        branchEligibility: { status: "eligible", source: "github_metadata" },
        sourceTokenScore: 58,
        totalTokenScore: 1500,
        sourceLines: 120,
        openPrCount: 0,
        credibility: 1,
      },
    });

    expect(preview.activeModel).toBe("pending_saturation_model");
    expect(preview.scoreEstimate.baseScore).toBeCloseTo(40.803, 3);
    expect(preview.scoreEstimate.contributionBonus).toBe(25);
    expect(preview.scoreEstimate.pendingSaturationScore).toBe(preview.scoreEstimate.baseScore);
    expect(preview.scoreEstimate.estimatedMergedScore).toBeCloseTo(65.1216, 3);
    expect(preview.gates.baseTokenGatePassed).toBe(true);
    expect(JSON.stringify(preview.scoreEstimate)).not.toMatch(/reward estimate|wallet|hotkey|farming|payout/i);
  });

  it("projects the saturation-model score with the full contribution bonus for density-era snapshots", () => {
    const densitySnapshot: ScoringModelSnapshotRecord = {
      ...snapshot,
      activeModel: "current_density_model",
      constants: {
        ...snapshot.constants,
        MAX_CONTRIBUTION_BONUS: 25,
        SRC_TOK_SATURATION_SCALE: 58,
      },
    };
    const preview = buildScorePreview({
      repo,
      snapshot: densitySnapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 58,
        totalTokenScore: 1500,
        sourceLines: 120,
        openPrCount: 0,
        credibility: 1,
      },
    });

    expect(preview.scoreEstimate.contributionBonus).toBe(25);
    expect(preview.scoreEstimate.pendingSaturationScore).toBeCloseTo(40.803, 3);
    expect(preview.underlyingPotentialScore).toBeCloseTo(40.803, 3);
  });

  it("scores the saturation contribution bonus identically to the density bonus and keeps full-bonus work a strong fit", () => {
    const input = {
      repoFullName: repo.fullName,
      sourceTokenScore: 58,
      totalTokenScore: 1500,
      sourceLines: 120,
      openPrCount: 0,
      credibility: 1,
    };
    const saturationPreview = buildScorePreview({
      repo,
      snapshot: { ...snapshot, activeModel: "pending_saturation_model" as const },
      input,
    });
    const densityPreview = buildScorePreview({
      repo,
      snapshot: { ...snapshot, activeModel: "current_density_model" as const },
      input,
    });

    // Same MAX_CONTRIBUTION_BONUS, same full ramp -> both models must agree on the bonus.
    expect(saturationPreview.scoreEstimate.contributionBonus).toBe(densityPreview.scoreEstimate.contributionBonus);
    expect(saturationPreview.scoreEstimate.contributionBonus).toBe(25);
    // A full-bonus contribution must not fall below the strong_fit threshold (>= 30)
    // because the contribution bonus was clipped.
    expect(saturationPreview.effectiveEstimatedScore).toBeGreaterThanOrEqual(30);
  });

  it("keeps lane math tied to the recorded model snapshot and clamps score gates", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        labels: ["bug"],
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [7], solvedByPullRequests: [100] },
        branchEligibility: { status: "eligible", source: "github_metadata" },
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

  it("falls back to a neutral label multiplier when repo defaults are zeroed", () => {
    const preview = buildScorePreview({
      repo: { ...repo, registryConfig: { ...repo.registryConfig!, defaultLabelMultiplier: 0, labelMultipliers: {} } },
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 0,
        credibility: 1,
      },
    });

    expect(preview.scoreEstimate.labelMultiplier).toBe(1);
  });

  it("gates linked-issue assumptions with branch eligibility evidence", () => {
    const baseInput = {
      repoFullName: repo.fullName,
      labels: ["bug"],
      linkedIssueMode: "standard" as const,
      linkedIssueContext: { status: "validated" as const, source: "official_mirror" as const, issueNumbers: [7], solvedByPullRequests: [100] },
      sourceTokenScore: 60,
      totalTokenScore: 90,
      sourceLines: 50,
      openPrCount: 0,
      credibility: 1,
    };
    const eligible = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, branchEligibility: { status: "eligible", source: "github_metadata", checkedAt: "2026-05-30T00:00:00.000Z" } },
    });
    const ineligible = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, branchEligibility: { status: "ineligible", source: "github_metadata", reason: "head branch is not eligible" } },
    });
    const missing = buildScorePreview({ repo, snapshot, input: baseInput });
    const unknown = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, branchEligibility: { status: "unknown", stale: true } },
    });
    const implicitUnknown = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, branchEligibility: {} as never },
    });
    const notRequired = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueMode: "none", branchEligibility: { status: "eligible" } },
    });

    expect(eligible.branchEligibility).toMatchObject({ required: true, status: "eligible", evidence: "provided" });
    expect(eligible.scoreEstimate.issueMultiplier).toBe(1.33);
    expect(eligible.blockedBy.map((blocker) => blocker.code)).not.toContain("branch_ineligible");
    expect(ineligible.branchEligibility).toMatchObject({ required: true, status: "ineligible", evidence: "provided", reason: "head branch is not eligible" });
    expect(ineligible.scoreEstimate.issueMultiplier).toBe(1);
    expect(ineligible.scoreEstimate.estimatedMergedScore).toBeLessThan(eligible.scoreEstimate.estimatedMergedScore);
    expect(ineligible.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch_ineligible", severity: "reducer" })]));
    expect(ineligible.recommendation.actions).toEqual(expect.arrayContaining([expect.stringMatching(/eligible branch/i)]));
    expect(missing.branchEligibility).toMatchObject({ required: true, status: "unknown", evidence: "missing", source: "missing" });
    expect(missing.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "branch_eligibility_missing", severity: "context" })]));
    expect(missing.scoreEstimate.issueMultiplier).toBe(1);
    expect(unknown.branchEligibility).toMatchObject({ required: true, status: "unknown", evidence: "provided", source: "user_supplied", stale: true });
    expect(unknown.branchEligibility.warnings.join(" ")).toMatch(/unknown.*stale/i);
    expect(unknown.recommendation.actions).toEqual(expect.arrayContaining([expect.stringMatching(/refresh branch\/base eligibility metadata/i)]));
    expect(implicitUnknown.branchEligibility).toMatchObject({ required: true, status: "unknown", evidence: "provided", source: "user_supplied" });
    expect(notRequired.branchEligibility).toMatchObject({ required: false, status: "not_required", evidence: "provided", source: "user_supplied" });
    expect(notRequired.scoreEstimate.issueMultiplier).toBe(1);
    expect(notRequired.blockedBy.map((blocker) => blocker.code)).not.toContain("branch_eligibility_missing");
    expect(JSON.stringify({ eligible, ineligible, missing, unknown, implicitUnknown, notRequired })).not.toMatch(/guaranteed payout|wallet|hotkey|farming/i);
  });

  it("requires solved-by-PR validation before applying the standard linked-issue multiplier", () => {
    const baseInput = {
      repoFullName: repo.fullName,
      linkedIssueMode: "standard" as const,
      sourceTokenScore: 60,
      totalTokenScore: 90,
      sourceLines: 50,
      openPrCount: 0,
      credibility: 1,
    };
    const raw = buildScorePreview({ repo, snapshot, input: { ...baseInput, linkedIssueContext: { status: "raw", source: "github_cache", issueNumbers: [7] } } });
    const validated = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [7], solvedByPullRequests: [101] }, branchEligibility: { status: "eligible", source: "github_metadata" } },
    });
    const invalid = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { status: "invalid", source: "github_cache", issueNumbers: [7], reason: "Issue #7 is closed without solved-by-PR evidence." } },
    });
    const invalidDefaultReason = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { status: "invalid", source: "github_cache", issueNumbers: [8] } },
    });
    const plausible = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { status: "plausible", source: "github_cache", issueNumbers: [9] } },
    });
    const defaultValidated = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { source: "user_supplied", issueNumbers: [10], solvedByPullRequests: [110] }, branchEligibility: { status: "eligible", source: "github_metadata" } },
    });
    const validatedWithoutSolverNumber = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { status: "validated", source: "github_cache", issueNumbers: [11] } },
    });
    const validatedWithoutIssueOrSolver = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { status: "validated", source: "github_cache" } },
    });
    const forgedProjectedValidatedWithoutSolverNumber = buildScorePreview({
      repo,
      snapshot,
      input: {
        ...baseInput,
        linkedIssueContext: { status: "validated", source: "user_supplied", issueNumbers: [14], projectedSolvedByPullRequestValidation: true } as unknown as ScorePreviewInput["linkedIssueContext"],
      },
    });
    const rawByDefault = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { issueNumbers: [12] } },
    });
    const unavailableByDefault = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: {} },
    });
    const malformedNumbers = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, sourceTokenScore: Number.NaN, linkedIssueContext: { status: "validated", source: "github_cache", issueNumbers: [13, 13, -1, 0, 1.5], solvedByPullRequests: [120, 120, 0] } },
    });
    const unavailable = buildScorePreview({
      repo,
      snapshot,
      input: { ...baseInput, linkedIssueContext: { status: "unavailable", source: "missing", issueNumbers: [7] } },
    });
    const missingContext = buildScorePreview({ repo, snapshot, input: baseInput });

    expect(raw.linkedIssueMultiplier).toMatchObject({ status: "raw", eligible: false, appliedMultiplier: 1 });
    expect(raw.scoreEstimate.issueMultiplier).toBe(1);
    expect(raw.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "linked_issue_unvalidated", severity: "context" })]));
    const rawFixedScenario = raw.scenarioPreviews.find((scenario) => scenario.name === "linkedIssueFixed");
    expect(rawFixedScenario?.linkedIssueMultiplier).toMatchObject({ status: "validated", appliedMultiplier: 1 });
    expect(rawFixedScenario?.linkedIssueMultiplier.reason).toMatch(/Branch eligibility evidence is missing/);
    expect(validated.linkedIssueMultiplier).toMatchObject({ status: "validated", eligible: true, solvedByPullRequests: [101], appliedMultiplier: 1.33 });
    expect(validated.scoreEstimate.issueMultiplier).toBe(1.33);
    expect(invalid.linkedIssueMultiplier).toMatchObject({ status: "invalid", eligible: false, appliedMultiplier: 1 });
    expect(invalid.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ code: "linked_issue_invalid", severity: "reducer" })]));
    expect(invalidDefaultReason.linkedIssueMultiplier.reason).toMatch(/invalid.*#8/i);
    expect(plausible.linkedIssueMultiplier).toMatchObject({ status: "plausible", eligible: false, appliedMultiplier: 1 });
    expect(plausible.warnings.join(" ")).toMatch(/plausible.*not solved-by-PR/i);
    expect(defaultValidated.linkedIssueMultiplier).toMatchObject({ status: "validated", source: "user_supplied", solvedByPullRequests: [110], appliedMultiplier: 1.33 });
    expect(validatedWithoutSolverNumber.linkedIssueMultiplier).toMatchObject({ status: "raw", eligible: false, appliedMultiplier: 1 });
    expect(validatedWithoutSolverNumber.linkedIssueMultiplier.reason).toMatch(/no solved-by-PR validation/i);
    expect(validatedWithoutIssueOrSolver.linkedIssueMultiplier).toMatchObject({ status: "unavailable", eligible: false, issueNumbers: [], appliedMultiplier: 1 });
    expect(forgedProjectedValidatedWithoutSolverNumber.linkedIssueMultiplier).toMatchObject({ status: "raw", eligible: false, issueNumbers: [14], appliedMultiplier: 1 });
    expect(rawByDefault.linkedIssueMultiplier).toMatchObject({ status: "raw", source: "user_supplied", issueNumbers: [12], appliedMultiplier: 1 });
    expect(unavailableByDefault.linkedIssueMultiplier).toMatchObject({ status: "unavailable", source: "missing", issueNumbers: [], appliedMultiplier: 1 });
    expect(malformedNumbers.linkedIssueMultiplier).toMatchObject({ issueNumbers: [13], solvedByPullRequests: [120] });
    expect(malformedNumbers.gates.baseTokenGatePassed).toBe(false);
    expect(unavailable.warnings.join(" ")).toMatch(/unavailable/i);
    expect(missingContext.linkedIssueMultiplier).toMatchObject({ status: "unavailable", source: "missing", appliedMultiplier: 1 });
  });

  it("shows conditional scoreability when current open PR pressure zeroes the effective score", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "validated", source: "official_mirror", issueNumbers: [7], solvedByPullRequests: [100] },
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
    expect(linkedIssueFixed?.scoreEstimate.issueMultiplier).toBe(1);
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
        observedClosedPrCount: 1,
        observedDraftPrCount: 1,
        observedBlockedPrCount: 1,
        observedMaintainerPrCount: 1,
      },
    });
    const userSupplied = preview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
    const approved = preview.scenarioPreviews.find((scenario) => scenario.name === "afterApprovedPrsMerge");
    const stale = preview.scenarioPreviews.find((scenario) => scenario.name === "afterStalePrsClose");
    const bestReasonable = preview.scenarioPreviews.find((scenario) => scenario.name === "bestReasonableCase");

    expect(userSupplied).toMatchObject({ source: "user_supplied", gates: { openPrCount: 4, credibilityObserved: 0.5 } });
    expect(approved).toMatchObject({ source: "github_observed", gates: { openPrCount: 4, credibilityObserved: 0.8 } });
    expect(stale).toMatchObject({ source: "github_observed", gates: { openPrCount: 4, credibilityObserved: 0.2 } });
    expect(stale?.assumptions.join(" ")).toMatch(/already-closed PR.*excluded/);
    expect(bestReasonable?.gates.openPrCount).toBe(2);
    expect(approved?.assumptions.join(" ")).toMatch(/draft PR.*excluded|blocked PR.*excluded|maintainer-lane PR.*outside-contributor/);
    expect(preview.effectiveEstimatedScore).toBe(0);
    expect(preview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(JSON.stringify(preview)).not.toMatch(/guaranteed payout|wallet|hotkey|farming/i);
  });

  it("does not double-count merge-ready PRs supplied as both pendingMerged and approved", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 6,
        credibility: 1,
        // The GitHub-observed detector reports the same merge-ready set as both
        // pendingMergedPrCount and approvedPrCount; they must not be added twice.
        pendingMergedPrCount: 3,
        approvedPrCount: 3,
        pendingClosedPrCount: 0,
      },
    });
    const afterPending = preview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
    // 3 merge-ready PRs leave the queue once: 6 - 3 = 3 open (not the buggy 6 - 6 = 0).
    expect(afterPending?.gates.openPrCount).toBe(3);
    // 3 still exceeds openPrThreshold (2 + floor(90/300) = 2) -> gate stays blocked.
    expect(afterPending?.scoreEstimate.openPrMultiplier).toBe(0);
    expect(afterPending?.effectiveEstimatedScore).toBe(0);
    // Scenario note reports the de-duplicated count (3), never the doubled 6.
    const note = afterPending?.assumptions.join(" ") ?? "";
    expect(note).toMatch(/3 pending merged\/closed PR/);
    expect(note).not.toMatch(/6 pending/);

    // GitHub-observed path: same merge-ready set, note must still read 3, not 6.
    const observed = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 6,
        credibility: 1,
        pendingMergedPrCount: 3,
        approvedPrCount: 3,
        pendingClosedPrCount: 0,
        expectedOpenPrCountAfterMerge: 3,
        pendingScenarioObserved: true,
      },
    });
    const observedAfterPending = observed.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
    expect(observedAfterPending?.source).toBe("github_observed");
    const observedNote = observedAfterPending?.assumptions.join(" ") ?? "";
    expect(observedNote).toMatch(/3 pending merged\/closed PR/);
    expect(observedNote).not.toMatch(/6 pending|user-supplied/);
  });

  it("derives the open-PR threshold from established merged history, not the planned PR's own tokens", () => {
    // No merged history, but a large planned PR (totalTokenScore 900) and 3 open PRs.
    const noHistory = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 900,
        sourceLines: 50,
        openPrCount: 3,
        credibility: 1,
        existingContributorTokenScore: 0,
      },
    });
    // The planned PR's own 900 tokens must NOT inflate its own threshold: base 2 + floor(0/300) = 2.
    expect(noHistory.gates.openPrThreshold).toBe(2);
    expect(noHistory.scoreEstimate.openPrMultiplier).toBe(0); // 3 > 2 -> open-PR spam gate blocks

    // Established merged-history token score DOES raise the allowance: 2 + floor(900/300) = 5.
    const withHistory = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        sourceTokenScore: 60,
        totalTokenScore: 900,
        sourceLines: 50,
        openPrCount: 3,
        credibility: 1,
        existingContributorTokenScore: 900,
      },
    });
    expect(withHistory.gates.openPrThreshold).toBe(5);
    expect(withHistory.scoreEstimate.openPrMultiplier).toBe(1); // 3 <= 5 -> passes
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
    expect(fallback.activeModel).toBe("unknown");
    expect(fallback.warnings.join(" ")).toMatch(/fetch failed/i);
    expect(fallback.constants.OSS_EMISSION_SHARE).toBe(0.9);

    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const thrownFallback = await refreshScoringModelSnapshot(createTestEnv());
    expect(thrownFallback.sourceKind).toBe("fallback");
    expect(thrownFallback.activeModel).toBe("unknown");
  });

  describe("issue-discovery scoring constants (#808)", () => {
    it("TEST_FILE_CONTRIBUTION_WEIGHT weights test tokens at 0.05× when totalTokenScore is derived from components", () => {
      const snapshotWith808 = { ...snapshot, constants: { ...snapshot.constants, TEST_FILE_CONTRIBUTION_WEIGHT: 0.05 } };
      const base = buildScorePreview({
        repo,
        snapshot: snapshotWith808,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, sourceLines: 50, openPrCount: 0, credibility: 1 },
      });
      // With testTokenScore=200, the derived total should be 60 + 0.05*200 = 70 (not 260).
      const withTest = buildScorePreview({
        repo,
        snapshot: snapshotWith808,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, testTokenScore: 200, sourceLines: 50, openPrCount: 0, credibility: 1 },
      });
      // Contribution bonus ramp is based on totalTokenScore; 70 vs 60 produces a slightly higher bonus.
      expect(withTest.scoreEstimate.contributionBonus).toBeGreaterThan(base.scoreEstimate.contributionBonus);
      // But an explicit totalTokenScore overrides the weight completely — caller-supplied value is honoured as-is.
      const explicit = buildScorePreview({
        repo,
        snapshot: snapshotWith808,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, testTokenScore: 200, totalTokenScore: 260, sourceLines: 50, openPrCount: 0, credibility: 1 },
      });
      // explicit 260 is LARGER than weighted 70; contribution bonus must be greater.
      expect(explicit.scoreEstimate.contributionBonus).toBeGreaterThan(withTest.scoreEstimate.contributionBonus);
    });

    it("open-issue spam gate blocks scoring when openIssueCount exceeds the threshold", () => {
      const snapshotWith808 = {
        ...snapshot,
        constants: {
          ...snapshot.constants,
          OPEN_ISSUE_SPAM_BASE_THRESHOLD: 2,
          OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT: 300,
          MAX_OPEN_ISSUE_THRESHOLD: 30,
        },
      };
      const baseInput = { repoFullName: repo.fullName, sourceTokenScore: 60, totalTokenScore: 90, sourceLines: 50, openPrCount: 0, credibility: 1, existingContributorTokenScore: 0 };

      // At the threshold (2) — gate passes.
      const atThreshold = buildScorePreview({ repo, snapshot: snapshotWith808, input: { ...baseInput, openIssueCount: 2 } });
      expect(atThreshold.gates.openIssueThreshold).toBe(2);
      expect(atThreshold.gates.openIssueCount).toBe(2);
      expect(atThreshold.scoreEstimate.openIssueMultiplier).toBe(1);
      expect(atThreshold.effectiveEstimatedScore).toBeGreaterThan(0);

      // One over the threshold — gate blocks.
      const overThreshold = buildScorePreview({ repo, snapshot: snapshotWith808, input: { ...baseInput, openIssueCount: 3 } });
      expect(overThreshold.scoreEstimate.openIssueMultiplier).toBe(0);
      expect(overThreshold.effectiveEstimatedScore).toBe(0);
      expect(overThreshold.blockedBy.some((b) => b.code === "open_issue_threshold")).toBe(true);
      expect(overThreshold.blockedBy.find((b) => b.code === "open_issue_threshold")?.severity).toBe("blocker");
    });

    it("open-issue threshold scales with established merged-history token score", () => {
      const snapshotWith808 = {
        ...snapshot,
        constants: { ...snapshot.constants, OPEN_ISSUE_SPAM_BASE_THRESHOLD: 2, OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT: 300, MAX_OPEN_ISSUE_THRESHOLD: 30 },
      };
      // No history: base 2 + floor(0/300) = 2.
      const noHistory = buildScorePreview({
        repo, snapshot: snapshotWith808,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, totalTokenScore: 90, sourceLines: 50, openPrCount: 0, credibility: 1, existingContributorTokenScore: 0, openIssueCount: 3 },
      });
      expect(noHistory.gates.openIssueThreshold).toBe(2);
      expect(noHistory.scoreEstimate.openIssueMultiplier).toBe(0);

      // With 900 tokens of history: 2 + floor(900/300) = 5.
      const withHistory = buildScorePreview({
        repo, snapshot: snapshotWith808,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, totalTokenScore: 90, sourceLines: 50, openPrCount: 0, credibility: 1, existingContributorTokenScore: 900, openIssueCount: 3 },
      });
      expect(withHistory.gates.openIssueThreshold).toBe(5);
      expect(withHistory.scoreEstimate.openIssueMultiplier).toBe(1); // 3 <= 5
    });

    it("open-issue gate defaults to 0 issues when openIssueCount is not supplied (never blocks)", () => {
      const preview = buildScorePreview({
        repo,
        snapshot,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, totalTokenScore: 90, sourceLines: 50, openPrCount: 0, credibility: 1 },
      });
      expect(preview.gates.openIssueCount).toBe(0);
      expect(preview.scoreEstimate.openIssueMultiplier).toBe(1);
    });

    it("MAX_OPEN_ISSUE_THRESHOLD caps the issue allowance even with a very large token history", () => {
      const snapshotWith808 = {
        ...snapshot,
        constants: { ...snapshot.constants, OPEN_ISSUE_SPAM_BASE_THRESHOLD: 2, OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT: 300, MAX_OPEN_ISSUE_THRESHOLD: 5 },
      };
      // Even with a huge token history, the threshold cannot exceed MAX_OPEN_ISSUE_THRESHOLD (5).
      const preview = buildScorePreview({
        repo, snapshot: snapshotWith808,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, totalTokenScore: 90, sourceLines: 50, openPrCount: 0, credibility: 1, existingContributorTokenScore: 90000, openIssueCount: 6 },
      });
      expect(preview.gates.openIssueThreshold).toBe(5);
      expect(preview.scoreEstimate.openIssueMultiplier).toBe(0); // 6 > 5
    });

    it("bestReasonableCase clears the open-issue gate and surfaces an open_issue_threshold gate delta (#808)", () => {
      const snapshotWith808 = {
        ...snapshot,
        constants: { ...snapshot.constants, OPEN_ISSUE_SPAM_BASE_THRESHOLD: 2, OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT: 300, MAX_OPEN_ISSUE_THRESHOLD: 30 },
      };
      // Current state is over the threshold (3 > 2) so the gate blocks the live preview.
      const preview = buildScorePreview({
        repo, snapshot: snapshotWith808,
        input: { repoFullName: repo.fullName, sourceTokenScore: 60, totalTokenScore: 90, sourceLines: 50, openPrCount: 0, credibility: 1, existingContributorTokenScore: 0, openIssueCount: 3 },
      });
      expect(preview.scoreEstimate.openIssueMultiplier).toBe(0);
      expect(preview.effectiveEstimatedScore).toBe(0);
      // The best-reasonable-case scenario projects the open-issue count down to the threshold (2),
      // clearing the gate so the underlying potential is visible there.
      const bestReasonable = preview.scenarioPreviews.find((scenario) => scenario.name === "bestReasonableCase");
      expect(bestReasonable?.gates.openIssueCount).toBe(2);
      expect(bestReasonable?.gates.openIssueThreshold).toBe(2);
      expect(bestReasonable?.scoreEstimate.openIssueMultiplier).toBe(1);
      expect(bestReasonable?.effectiveEstimatedScore).toBeGreaterThan(0);
      // Because the multiplier differs between current and best-reasonable-case, an open_issue_threshold
      // gate delta must be emitted — this is the branch previously missing coverage.
      expect(preview.gateDeltas).toEqual(expect.arrayContaining([expect.objectContaining({ gate: "open_issue_threshold" })]));
      const issueDelta = preview.gateDeltas.find((delta) => delta.gate === "open_issue_threshold");
      expect(issueDelta?.current).toContain("multiplier 0");
      expect(issueDelta?.projected).toContain("multiplier 1");
    });

    it("all nine issue-discovery constants are modeled and do not surface as upstream drift warnings (#808)", () => {
      const upstreamSource = [
        "TEST_FILE_CONTRIBUTION_WEIGHT = 0.05",
        "MIN_VALID_MERGED_PRS = 3",
        "MIN_VALID_SOLVED_ISSUES = 3",
        "MIN_ISSUE_CREDIBILITY = 0.8",
        "MIN_TOKEN_SCORE_FOR_VALID_ISSUE = 5",
        "OPEN_ISSUE_SPAM_BASE_THRESHOLD = 2",
        "OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT = 300",
        "MAX_OPEN_ISSUE_THRESHOLD = 30",
        "PR_LOOKBACK_DAYS = 30",
      ].join("\n");
      const unmodeled = findUnmodeledUpstreamConstants(upstreamSource);
      expect(unmodeled).toEqual([]);
    });
  });

  describe("upstream time-decay (#703)", () => {
    it("calculateTimeDecay matches the upstream sigmoid (grace, 50%-at-midpoint, floor, monotonic)", () => {
      const c = DEFAULT_SCORING_CONSTANTS;
      // Within the 12h grace period → no decay.
      expect(calculateTimeDecay(0, c)).toBe(1);
      expect(calculateTimeDecay(11.9, c)).toBe(1);
      // Non-finite age is treated as fresh (defensive).
      expect(calculateTimeDecay(Number.NaN, c)).toBe(1);
      // Decay begins right after the grace boundary.
      expect(calculateTimeDecay(12, c)).toBeLessThan(1);
      // 50% at the 10-day midpoint (240h).
      expect(calculateTimeDecay(240, c)).toBeCloseTo(0.5, 5);
      // Floored at the 5% minimum for very old PRs (100 days).
      expect(calculateTimeDecay(2400, c)).toBeCloseTo(0.05, 5);
      // Strictly monotonic decreasing past the grace period.
      expect(calculateTimeDecay(120, c)).toBeGreaterThan(calculateTimeDecay(240, c));
      expect(calculateTimeDecay(240, c)).toBeGreaterThan(calculateTimeDecay(480, c));
    });

    it("the constants are modeled (no longer flagged as upstream drift)", () => {
      expect(DEFAULT_SCORING_CONSTANTS.TIME_DECAY_SIGMOID_MIDPOINT).toBe(10);
      expect(findUnmodeledUpstreamConstants("TIME_DECAY_GRACE_PERIOD_HOURS = 12\nTIME_DECAY_MIN_MULTIPLIER = 0.05\n")).toEqual([]);
    });

    it("isTimeDecayEnabled is OFF by default and only on for an explicit truthy flag", () => {
      expect(isTimeDecayEnabled({} as Env)).toBe(false);
      expect(isTimeDecayEnabled({ SCORING_TIME_DECAY_ENABLED: "false" } as unknown as Env)).toBe(false);
      expect(isTimeDecayEnabled({ SCORING_TIME_DECAY_ENABLED: "true" } as unknown as Env)).toBe(true);
      expect(isTimeDecayEnabled({ SCORING_TIME_DECAY_ENABLED: "1" } as unknown as Env)).toBe(true);
    });

    it("does not change the preview unless applied AND the PR is past the grace period", () => {
      const input: ScorePreviewInput = { repoFullName: repo.fullName, sourceTokenScore: 58, totalTokenScore: 600, sourceLines: 60, openPrCount: 0, credibility: 1 };
      const base = buildScorePreview({ repo, snapshot, input }).scoreEstimate;
      expect(base.timeDecayMultiplier).toBe(1);

      // Flag on but a fresh PR (no/zero age) → still 1.0, score unchanged.
      const fresh = buildScorePreview({ repo, snapshot, input: { ...input, applyTimeDecay: true, prAgeHours: 0 } }).scoreEstimate;
      expect(fresh.timeDecayMultiplier).toBe(1);
      expect(fresh.estimatedMergedScore).toBe(base.estimatedMergedScore);

      // Age present but flag OFF → no decay applied.
      const agedOff = buildScorePreview({ repo, snapshot, input: { ...input, prAgeHours: 240 } }).scoreEstimate;
      expect(agedOff.timeDecayMultiplier).toBe(1);
      expect(agedOff.estimatedMergedScore).toBe(base.estimatedMergedScore);
    });

    it("applies the decay multiplier to the estimate when on for an aged PR", () => {
      const input: ScorePreviewInput = { repoFullName: repo.fullName, sourceTokenScore: 58, totalTokenScore: 600, sourceLines: 60, openPrCount: 0, credibility: 1 };
      const base = buildScorePreview({ repo, snapshot, input }).scoreEstimate;
      const aged = buildScorePreview({ repo, snapshot, input: { ...input, applyTimeDecay: true, prAgeHours: 240 } }).scoreEstimate;
      expect(aged.timeDecayMultiplier).toBeCloseTo(0.5, 2);
      // 10-day-old PR scores ~half a fresh one (the before/after the owner reviews before enabling).
      expect(aged.estimatedMergedScore).toBeCloseTo(base.estimatedMergedScore * 0.5, 1);
    });

    it("before/after: the decay trajectory for owner review (default-off; this is what enabling would do)", () => {
      const input: ScorePreviewInput = { repoFullName: repo.fullName, sourceTokenScore: 58, totalTokenScore: 600, sourceLines: 60, openPrCount: 0, credibility: 1 };
      const before = buildScorePreview({ repo, snapshot, input }).scoreEstimate.estimatedMergedScore;
      const trajectory = [0, 120, 240, 720].map((hours) => ({
        ageDays: hours / 24,
        after: buildScorePreview({ repo, snapshot, input: { ...input, applyTimeDecay: true, prAgeHours: hours } }).scoreEstimate.estimatedMergedScore,
      }));
      // Fresh = unchanged; 5d > 10d > 30d; 30d floored well below fresh. Monotonic non-increasing.
      expect(trajectory[0]!.after).toBe(before);
      expect(trajectory[1]!.after).toBeGreaterThan(trajectory[2]!.after);
      expect(trajectory[2]!.after).toBeGreaterThan(trajectory[3]!.after);
      expect(trajectory[3]!.after).toBeLessThan(before);
    });

    it("resolveTimeDecay overlays per-repo overrides on snapshot defaults, per-field (mirrors upstream)", () => {
      const c = DEFAULT_SCORING_CONSTANTS;
      // No overrides → all snapshot defaults.
      expect(resolveTimeDecay(c, null)).toEqual({ gracePeriodHours: 12, sigmoidMidpointDays: 10, sigmoidSteepness: 0.4, minMultiplier: 0.05 });
      // Partial override (JSONbored/gittensory's real config: grace 24, midpoint 10, min 0.05, no steepness)
      // → overridden fields apply, the absent steepness falls back to the default.
      expect(resolveTimeDecay(c, { gracePeriodHours: 24, sigmoidMidpointDays: 10, minMultiplier: 0.05 })).toEqual({
        gracePeriodHours: 24,
        sigmoidMidpointDays: 10,
        sigmoidSteepness: 0.4,
        minMultiplier: 0.05,
      });
      // A non-finite/absent field falls back, not NaN.
      expect(resolveTimeDecay(c, { sigmoidSteepness: Number.NaN }).sigmoidSteepness).toBe(0.4);
    });

    it("calculateTimeDecay honours a repo's per-repo curve (grace + midpoint overrides)", () => {
      const c = DEFAULT_SCORING_CONSTANTS;
      // Default 12h grace would decay at 18h; this repo's 24h grace keeps an 18h-old PR fresh.
      expect(calculateTimeDecay(18, c)).toBeLessThan(1);
      expect(calculateTimeDecay(18, c, { gracePeriodHours: 24 })).toBe(1);
      // A shorter midpoint decays faster: 50% point moves from 10d to 5d (120h).
      expect(calculateTimeDecay(120, c, { sigmoidMidpointDays: 5 })).toBeCloseTo(0.5, 5);
    });

    it("applies each live repo's resolved curve in the preview (per-repo, not global)", () => {
      const input: ScorePreviewInput = { repoFullName: repo.fullName, sourceTokenScore: 58, totalTokenScore: 600, sourceLines: 60, openPrCount: 0, credibility: 1, applyTimeDecay: true, prAgeHours: 18 };
      // Repo with a 24h grace override (like JSONbored/gittensory) → an 18h-old PR is still fresh.
      const repo24: RepositoryRecord = { ...repo, registryConfig: { ...repo.registryConfig!, timeDecay: { gracePeriodHours: 24 } } };
      expect(buildScorePreview({ repo: repo24, snapshot, input }).scoreEstimate.timeDecayMultiplier).toBe(1);
      // Same PR on a repo using the default 12h grace → past grace, so it decays.
      const repoDefault: RepositoryRecord = { ...repo, registryConfig: { ...repo.registryConfig!, timeDecay: null } };
      expect(buildScorePreview({ repo: repoDefault, snapshot, input }).scoreEstimate.timeDecayMultiplier).toBeLessThan(1);
    });
  });
});
