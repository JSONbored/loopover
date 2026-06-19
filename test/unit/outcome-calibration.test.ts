import { describe, expect, it } from "vitest";
import {
  buildOutcomeCalibrationSignals,
  buildRecommendationOutcomeCalibration,
  buildRepoOutcomeCalibration,
  buildSlopOutcomeCalibration,
} from "../../src/services/outcome-calibration";
import { createAgentRun, replaceAgentActions, updatePullRequestSlopAssessment, upsertAgentRecommendationOutcome, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import type { SlopBand } from "../../src/signals/slop";
import type { AgentActionRecord, AgentRecommendationOutcomeRecord, AgentRecommendationOutcomeState, AgentRunRecord, PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// A resolved PR carrying a slop assessment. `merged` → has a merge timestamp; otherwise closed-unmerged.
function pr(band: SlopBand, merged: boolean, number: number): PullRequestRecord {
  return {
    repoFullName: "owner/repo",
    number,
    title: `PR ${number}`,
    state: "closed",
    mergedAt: merged ? "2026-06-01T00:00:00.000Z" : null,
    labels: [],
    linkedIssues: [],
    slopRisk: band === "clean" ? 0 : band === "low" ? 10 : band === "elevated" ? 40 : 70,
    slopBand: band,
  };
}

// n PRs in a band, `merged` of them merged (the rest closed-unmerged).
function band(b: SlopBand, n: number, merged: number, base: number): PullRequestRecord[] {
  return Array.from({ length: n }, (_, i) => pr(b, i < merged, base + i));
}

describe("buildSlopOutcomeCalibration", () => {
  it("computes per-band merge rates and reports discrimination when higher bands merge less", () => {
    const result = buildSlopOutcomeCalibration([...band("clean", 6, 5, 0), ...band("high", 6, 1, 100)]);
    expect(result.totalResolved).toBe(12);
    const byBand = Object.fromEntries(result.bands.map((b) => [b.band, b]));
    expect(byBand.clean).toMatchObject({ sampleSize: 6, merged: 5, mergeRate: 0.833 });
    expect(byBand.high).toMatchObject({ sampleSize: 6, merged: 1, mergeRate: 0.167 });
    expect(result.overallMergeRate).toBe(0.5);
    expect(result.discriminates).toBe(true); // clean merges more than high → predictive
  });

  it("flags a non-discriminating score when a higher band merges MORE", () => {
    const result = buildSlopOutcomeCalibration([...band("clean", 6, 1, 0), ...band("high", 6, 5, 100)]);
    expect(result.discriminates).toBe(false);
  });

  it("returns null discrimination when there isn't enough per-band sample", () => {
    const result = buildSlopOutcomeCalibration([...band("clean", 2, 2, 0), ...band("high", 2, 0, 100)]);
    expect(result.discriminates).toBeNull(); // each band below the min sample
    expect(result.totalResolved).toBe(4);
  });

  it("excludes open PRs and PRs with no slop assessment", () => {
    const open: PullRequestRecord = { repoFullName: "owner/repo", number: 9, title: "open", state: "open", labels: [], linkedIssues: [], slopRisk: 70, slopBand: "high" };
    const unassessed: PullRequestRecord = { repoFullName: "owner/repo", number: 10, title: "no slop", state: "closed", mergedAt: "2026-06-01T00:00:00.000Z", labels: [], linkedIssues: [] };
    const result = buildSlopOutcomeCalibration([open, unassessed, ...band("clean", 1, 1, 0)]);
    expect(result.totalResolved).toBe(1); // only the one assessed+resolved PR
  });
});

describe("buildRecommendationOutcomeCalibration", () => {
  function outcome(state: AgentRecommendationOutcomeState): AgentRecommendationOutcomeRecord {
    return { actionId: `a-${state}`, runId: "r", actorLogin: "miner", actionType: "choose_next_work", source: "explicit", outcomeState: state, outcomeTargetType: "pull_request", maintainerLane: false, confidence: "high", reason: "x", metadata: {} };
  }
  it("splits positive / negative / pending and computes a positive rate over resolved", () => {
    const result = buildRecommendationOutcomeCalibration([outcome("merged"), outcome("improved"), outcome("accepted"), outcome("closed"), outcome("stale"), outcome("ignored")]);
    expect(result).toMatchObject({ total: 6, positive: 3, negative: 1, pending: 2, positiveRate: 0.75 }); // 3 of 4 resolved
  });
  it("reports a null rate when nothing is resolved", () => {
    expect(buildRecommendationOutcomeCalibration([outcome("stale")]).positiveRate).toBeNull();
    expect(buildRecommendationOutcomeCalibration([]).positiveRate).toBeNull();
  });
  it("scopes to a repo (case-insensitive, by outcome repo then target repo) when repoFullName is given", () => {
    const outcomes: AgentRecommendationOutcomeRecord[] = [
      { ...outcome("merged"), outcomeRepoFullName: "Owner/Repo" }, // in scope (case-insensitive on outcome repo)
      { ...outcome("closed"), outcomeRepoFullName: null, targetRepoFullName: "owner/repo" }, // in scope via target-repo fallback
      { ...outcome("merged"), outcomeRepoFullName: "other/repo" }, // out of scope
      { ...outcome("accepted") }, // no repo at all → excluded by scope
    ];
    expect(buildRecommendationOutcomeCalibration(outcomes, "owner/repo")).toMatchObject({ total: 2, positive: 1, negative: 1, positiveRate: 0.5 });
  });
});

describe("buildOutcomeCalibrationSignals", () => {
  const slop = (discriminates: boolean | null) => ({ totalResolved: 12, bands: [], overallMergeRate: 0.5, discriminates });
  const recs = (positiveRate: number | null) => ({ total: 4, positive: 3, negative: 1, pending: 0, positiveRate });

  it("describes a predictive score + a recommendation positive rate", () => {
    const out = buildOutcomeCalibrationSignals(slop(true), recs(0.75)).join(" ");
    expect(out).toMatch(/predictive/i);
    expect(out).toMatch(/75% positive/);
  });
  it("warns when the score is NOT discriminating", () => {
    expect(buildOutcomeCalibrationSignals(slop(false), recs(0.5)).join(" ")).toMatch(/NOT discriminating/i);
  });
  it("notes insufficient data when discrimination is unknown and no recommendations are resolved", () => {
    const out = buildOutcomeCalibrationSignals(slop(null), recs(null)).join(" ");
    expect(out).toMatch(/Not enough resolved PRs/i);
    expect(out).toMatch(/No resolved recommendation/i);
  });
});

describe("buildRepoOutcomeCalibration (env loader)", () => {
  it("loads a repo's resolved PRs + slop bands and assembles the report", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 1, title: "merged clean", state: "closed", user: { login: "alice" }, merged_at: "2026-06-01T00:00:00.000Z" });
    await updatePullRequestSlopAssessment(env, "owner/repo", 1, { slopRisk: 0, slopBand: "clean" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 2, title: "closed high", state: "closed", user: { login: "bob" } });
    await updatePullRequestSlopAssessment(env, "owner/repo", 2, { slopRisk: 70, slopBand: "high" });

    const report = await buildRepoOutcomeCalibration(env, "owner/repo");
    expect(report.repoFullName).toBe("owner/repo");
    expect(report.slop.totalResolved).toBe(2);
    expect(report.slop.bands.find((b) => b.band === "clean")).toMatchObject({ merged: 1, closed: 0 });
    expect(report.slop.bands.find((b) => b.band === "high")).toMatchObject({ merged: 0, closed: 1 });
    expect(report.recommendations).toMatchObject({ total: 0, positiveRate: null }); // none seeded for this repo
    expect(report.signals.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/reward|payout|trust score|wallet|hotkey/i);
  });

  it("queries recommendation outcomes by repo before applying the default limit", async () => {
    const env = createTestEnv();
    const oldBase = Date.parse("2026-06-01T00:00:00.000Z");
    await createAgentRun(env, runRecord("r-target", "miner", new Date(oldBase).toISOString()));
    await createAgentRun(env, runRecord("r-other", "miner", new Date(oldBase + 10_000).toISOString()));
    await replaceAgentActions(env, "r-target", [actionRecord("target-merged", "r-target"), actionRecord("target-closed", "r-target")]);
    await replaceAgentActions(
      env,
      "r-other",
      Array.from({ length: 500 }, (_, index) => actionRecord(`other-${index}`, "r-other")),
    );
    await upsertAgentRecommendationOutcome(env, {
      actionId: "target-merged",
      runId: "r-target",
      actorLogin: "miner",
      actionType: "choose_next_work",
      targetRepoFullName: "owner/repo",
      source: "explicit",
      outcomeState: "merged",
      outcomeTargetType: "pull_request",
      maintainerLane: false,
      confidence: "high",
      reason: "target positive",
      metadata: {},
      updatedAt: new Date(oldBase).toISOString(),
    });
    await upsertAgentRecommendationOutcome(env, {
      actionId: "target-closed",
      runId: "r-target",
      actorLogin: "miner",
      actionType: "choose_next_work",
      outcomeRepoFullName: "owner/repo",
      source: "explicit",
      outcomeState: "closed",
      outcomeTargetType: "pull_request",
      maintainerLane: false,
      confidence: "high",
      reason: "target negative",
      metadata: {},
      updatedAt: new Date(oldBase + 1000).toISOString(),
    });

    for (let index = 0; index < 500; index += 1) {
      await upsertAgentRecommendationOutcome(env, {
        actionId: `other-${index}`,
        runId: "r-other",
        actorLogin: "miner",
        actionType: "choose_next_work",
        targetRepoFullName: `other/repo-${index}`,
        source: "explicit",
        outcomeState: "accepted",
        outcomeTargetType: "pull_request",
        maintainerLane: false,
        confidence: "high",
        reason: "other repo",
        metadata: {},
        updatedAt: new Date(oldBase + 10_000 + index * 1000).toISOString(),
      });
    }

    const report = await buildRepoOutcomeCalibration(env, "owner/repo", 365);
    expect(report.recommendations).toMatchObject({ total: 2, positive: 1, negative: 1, positiveRate: 0.5 });
  });
});

function runRecord(id: string, actorLogin: string, createdAt: string): AgentRunRecord {
  return {
    id,
    objective: "Plan the next Gittensor OSS contribution action.",
    actorLogin,
    surface: "api",
    mode: "copilot",
    status: "completed",
    dataQualityStatus: "complete",
    payload: { kind: "plan_next_work", login: actorLogin },
    createdAt,
    updatedAt: createdAt,
  };
}

function actionRecord(id: string, runId: string): AgentActionRecord {
  return {
    id,
    runId,
    actionType: "choose_next_work",
    status: "recommended",
    recommendation: "Pick narrow work and validate it.",
    why: ["The repo has cached opportunity signals."],
    blockedBy: [],
    publicSafeSummary: "Use local branch preflight before posting.",
    approvalRequired: true,
    safetyClass: "public_safe",
    payload: {},
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}
