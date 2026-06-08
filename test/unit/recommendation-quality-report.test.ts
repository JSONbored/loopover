import { describe, expect, it } from "vitest";
import { createAgentRun, replaceAgentActions, upsertAgentRecommendationOutcome } from "../../src/db/repositories";
import { buildRecommendationQualityReport, buildRecommendationQualityReportFromOutcomes } from "../../src/services/recommendation-quality-report";
import type { AgentRecommendationOutcomeRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

const FORBIDDEN_REPORT_TERMS =
  /wallet|hotkey|raw trust|trust[-\s]?score|payout|reward[-\s]?estimate|farming|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)|private[-\s]?scoreability|github_pat|ghp_/i;

describe("recommendation quality report", () => {
  it("builds role-aware totals, trends, and failure categories without leaking private fields", () => {
    const report = buildRecommendationQualityReportFromOutcomes(
      [
        outcome("miner-merged", "merged", { actionType: "prepare_pr_packet", repo: "owner/good", updatedAt: "2026-05-05T00:00:00.000Z" }),
        outcome("miner-closed", "closed", {
          actionType: "preflight_branch",
          repo: "owner/risky",
          updatedAt: "2026-05-12T00:00:00.000Z",
          reason: "contains wallet and private scoreability context that must never appear",
          metadata: { wallet: "secret-wallet", hotkey: "secret-hotkey", token: "ghp_secret" },
        }),
        outcome("maintainer-stale", "stale", { actionType: "monitor_existing_pr", repo: "owner/watch", updatedAt: "2026-05-19T00:00:00.000Z" }),
        outcome("owner-improved", "improved", { actionType: "explain_repo_fit", repo: "owner/settings", updatedAt: "2026-05-21T00:00:00.000Z", metadata: { role: "owner" } }),
        outcome("operator-ignored", "ignored", { actionType: "choose_next_work", repo: "owner/ops", updatedAt: "2026-05-28T00:00:00.000Z", metadata: { role: "operator" }, confidence: "low" }),
        outcome("maintainer-lane", "merged", { actionType: "choose_next_work", repo: "dev/own", updatedAt: "2026-05-29T00:00:00.000Z", maintainerLane: true }),
      ],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 42 },
    );

    expect(report).toMatchObject({
      visibility: "operator_only",
      empty: false,
      sparse: false,
      totals: { total: 6, positive: 3, negative: 3, positiveRate: 0.5, maintainerLaneTotal: 1, lowConfidence: 1 },
      publicExport: { available: false },
    });
    expect(report.roleSurfaces.map((surface) => surface.role)).toEqual(["miner", "maintainer", "owner", "operator"]);
    expect(report.roleSurfaces.find((surface) => surface.role === "miner")).toMatchObject({ total: 2, positive: 1, negative: 1 });
    expect(report.failureCategories.map((category) => category.category)).toEqual(
      expect.arrayContaining(["closed_without_merge", "stale", "ignored", "low_confidence", "maintainer_lane"]),
    );
    expect(report.trends).toHaveLength(6);
    expect(JSON.stringify(report)).not.toMatch(FORBIDDEN_REPORT_TERMS);
  });

  it("rolls up private quality by role, surface, lane, outcome category, and time bucket", () => {
    const report = buildRecommendationQualityReportFromOutcomes(
      [
        outcome("miner-api-accepted", "accepted", {
          surface: "api",
          metadata: { role: "miner" },
          updatedAt: "2026-05-20T00:00:00.000Z",
        }),
        outcome("miner-mcp-stale", "stale", {
          surface: "mcp",
          metadata: { role: "miner" },
          updatedAt: "2026-05-28T00:00:00.000Z",
        }),
        outcome("miner-maintainer-rejected", "rejected", {
          surface: "github_comment",
          metadata: { role: "miner" },
          maintainerLane: true,
          updatedAt: "2026-05-29T00:00:00.000Z",
        }),
        outcome("outside-window", "merged", {
          surface: "api",
          metadata: { role: "miner" },
          updatedAt: "2026-05-01T00:00:00.000Z",
        }),
      ],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 14 },
    );

    expect(report.rollups).toEqual([
      {
        role: "miner",
        surface: "api",
        lane: "contributor",
        outcomeCategory: "accepted",
        periodStart: "2026-05-18T00:00:00.000Z",
        periodEnd: "2026-05-25T00:00:00.000Z",
        count: 1,
      },
      {
        role: "miner",
        surface: "github_comment",
        lane: "maintainer",
        outcomeCategory: "rejected",
        periodStart: "2026-05-25T00:00:00.000Z",
        periodEnd: "2026-06-01T00:00:00.000Z",
        count: 1,
      },
      {
        role: "miner",
        surface: "mcp",
        lane: "contributor",
        outcomeCategory: "stale",
        periodStart: "2026-05-25T00:00:00.000Z",
        periodEnd: "2026-06-01T00:00:00.000Z",
        count: 1,
      },
    ]);
    expect(report.rollups.filter((rollup) => rollup.role === "miner" && rollup.surface === "github_comment")).toEqual([
      expect.objectContaining({ lane: "maintainer", outcomeCategory: "rejected", count: 1 }),
    ]);
    expect(JSON.stringify(report.rollups)).not.toMatch(FORBIDDEN_REPORT_TERMS);
  });

  it("counts rejected outcomes as negative recommendations", () => {
    const rejectedOnly = buildRecommendationQualityReportFromOutcomes(
      [outcome("rejected", "rejected", { actionType: "monitor_existing_pr", repo: "owner/rejected", updatedAt: "2026-05-30T00:00:00.000Z" })],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 14 },
    );

    expect(rejectedOnly).toMatchObject({
      empty: false,
      sparse: true,
      totals: { total: 1, positive: 0, negative: 1, positiveRate: 0 },
      roleSurfaces: [
        expect.objectContaining({
          role: "maintainer",
          total: 1,
          positive: 0,
          negative: 1,
          topRepos: [expect.objectContaining({ repoFullName: "owner/rejected", signal: "negative" })],
        }),
      ],
      failureCategories: [expect.objectContaining({ category: "rejected", count: 1 })],
    });
    expect(rejectedOnly.trends.some((bucket) => bucket.total === 1 && bucket.negative === 1)).toBe(true);

    const mixed = buildRecommendationQualityReportFromOutcomes(
      [
        outcome("accepted", "accepted", { repo: "owner/mixed", updatedAt: "2026-05-29T00:00:00.000Z" }),
        outcome("mixed-rejected", "rejected", { repo: "owner/mixed", updatedAt: "2026-05-30T00:00:00.000Z" }),
        outcome("closed", "closed", { repo: "owner/mixed", updatedAt: "2026-05-31T00:00:00.000Z" }),
      ],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 14 },
    );

    expect(mixed).toMatchObject({
      totals: { total: 3, positive: 1, negative: 2, positiveRate: 0.333 },
      roleSurfaces: [expect.objectContaining({ role: "miner", total: 3, positive: 1, negative: 2 })],
    });
  });

  it("reports empty and sparse private states deterministically", () => {
    const empty = buildRecommendationQualityReportFromOutcomes([], { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 90 });
    expect(empty).toMatchObject({
      empty: true,
      sparse: false,
      totals: { total: 0, positive: 0, negative: 0, positiveRate: 0 },
      roleSurfaces: [],
      failureCategories: [],
    });
    expect(empty.warnings.join(" ")).toMatch(/No recommendation outcomes/);

    const sparse = buildRecommendationQualityReportFromOutcomes(
      [outcome("one", "accepted", { updatedAt: "2026-05-30T00:00:00.000Z" })],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 14 },
    );
    expect(sparse).toMatchObject({ empty: false, sparse: true, totals: { total: 1, positive: 1, negative: 0 } });
    expect(sparse.warnings.join(" ")).toMatch(/sparse/i);
  });

  it("normalizes role metadata, action fallbacks, repo signals, and timestamp fallbacks", () => {
    const report = buildRecommendationQualityReportFromOutcomes(
      [
        outcome("metadata-array", "accepted", { metadata: { roles: ["unknown", "repo-owner"] }, repo: "owner/mixed" }),
        outcome("metadata-array-negative", "closed", { metadata: { roles: ["owner"] }, repo: "owner/mixed", updatedAt: "2026-05-30T00:00:00.000Z" }),
        outcome("metadata-contributor", "ignored", { metadata: { audience: "contributor" }, repo: "owner/miner", confidence: "medium" }),
        outcome("metadata-unknown", "merged", { metadata: { role: "reviewability" }, repo: "owner/fallback", actionType: "check_duplicate_risk" }),
        outcome("no-repo", "stale", { repo: null, actionType: "explain_repo_fit" }),
      ],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 7 },
    );

    expect(report.roleSurfaces.map((surface) => surface.role)).toEqual(["miner", "maintainer", "owner"]);
    expect(report.roleSurfaces.find((surface) => surface.role === "owner")?.topRepos).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoFullName: "owner/mixed", signal: "mixed" })]),
    );
    expect(report.roleSurfaces.find((surface) => surface.role === "maintainer")).toMatchObject({ positive: 1, negative: 0 });
    expect(report.roleSurfaces.find((surface) => surface.role === "miner")).toMatchObject({ positive: 0, negative: 1, mediumConfidence: 1 });
  });

  it("falls back to action type when metadata has no recognized role", () => {
    const report = buildRecommendationQualityReportFromOutcomes(
      [
        outcome("array-without-role", "merged", {
          actionType: "monitor_existing_pr",
          metadata: { roles: ["reviewability", "unknown"] },
          repo: "owner/fallback-array",
        }),
        outcome("non-string-role", "closed", {
          actionType: "explain_repo_fit",
          metadata: { actorRole: 123 },
          repo: "owner/fallback-number",
        }),
      ],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 7 },
    );

    expect(report.roleSurfaces.map((surface) => surface.role)).toEqual(["maintainer", "owner"]);
    expect(report.roleSurfaces.find((surface) => surface.role === "maintainer")).toMatchObject({ positive: 1, negative: 0 });
    expect(report.roleSurfaces.find((surface) => surface.role === "owner")).toMatchObject({ positive: 0, negative: 1 });
  });

  it("uses metadata role and timestamp fallbacks for report grouping", () => {
    const detectedOnly = {
      ...outcome("detected-only", "accepted", {
        repo: "owner/detected",
        metadata: { actorKind: "maintainer" },
      }),
      updatedAt: null,
      detectedAt: "2026-05-25T00:00:00.000Z",
      createdAt: null,
    };
    const createdOnly = {
      ...outcome("created-only", "closed", {
        repo: "owner/detected",
        metadata: { surface: "repository-owner" },
      }),
      updatedAt: null,
      detectedAt: null,
      createdAt: "2026-05-26T00:00:00.000Z",
    };
    const missingTimestamp = {
      ...outcome("missing-time", "ignored", {
        repo: "owner/no-time",
        metadata: { role: "operator" },
      }),
      updatedAt: null,
      detectedAt: null,
      createdAt: null,
    };

    const report = buildRecommendationQualityReportFromOutcomes(
      [detectedOnly, createdOnly, missingTimestamp],
      { generatedAt: "2026-06-01T00:00:00.000Z", windowDays: 7 },
    );

    expect(report.roleSurfaces.map((surface) => surface.role)).toEqual(["maintainer", "owner", "operator"]);
    expect(report.roleSurfaces.find((surface) => surface.role === "maintainer")).toMatchObject({ positive: 1, negative: 0 });
    expect(report.roleSurfaces.find((surface) => surface.role === "owner")?.topRepos).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoFullName: "owner/detected", signal: "negative" })]),
    );
    expect(report.roleSurfaces.find((surface) => surface.role === "operator")).toMatchObject({ positive: 0, negative: 1 });
    expect(report.trends.some((bucket) => bucket.total > 0)).toBe(true);
  });

  it("loads persisted outcomes for the operator report window", async () => {
    const env = createTestEnv();
    await createAgentRun(env, {
      id: "quality-run",
      objective: "Track quality",
      actorLogin: "quality-user",
      surface: "api",
      mode: "copilot",
      status: "completed",
      dataQualityStatus: "complete",
      payload: {},
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z",
    });
    await replaceAgentActions(env, "quality-run", [
      {
        id: "quality-action",
        runId: "quality-run",
        actionType: "choose_next_work",
        targetRepoFullName: "owner/repo",
        targetPullNumber: null,
        targetIssueNumber: null,
        status: "recommended",
        recommendation: "pursue",
        why: ["Safe aggregate fixture."],
        blockedBy: [],
        publicSafeSummary: "Safe aggregate fixture.",
        approvalRequired: true,
        safetyClass: "private",
        payload: {},
        createdAt: "2026-05-30T00:00:00.000Z",
      },
    ]);
    await upsertAgentRecommendationOutcome(env, {
      ...outcome("persisted", "merged", { repo: "owner/repo", updatedAt: "2026-05-30T00:00:00.000Z" }),
      actionId: "quality-action",
      runId: "quality-run",
      actorLogin: "quality-user",
    });

    await expect(buildRecommendationQualityReport(env, { now: "2026-06-01T00:00:00.000Z", windowDays: 14 })).resolves.toMatchObject({
      totals: { total: 1, positive: 1, negative: 0 },
      roleSurfaces: [expect.objectContaining({ role: "miner", positive: 1 })],
    });
  });

  it("clamps invalid persisted report windows", async () => {
    const env = createTestEnv();

    await expect(buildRecommendationQualityReport(env, { now: "2026-06-01T00:00:00.000Z", windowDays: Number.NaN })).resolves.toMatchObject({
      windowDays: 1,
      totals: { total: 0 },
    });
    await expect(buildRecommendationQualityReport(env, { now: "2026-06-01T00:00:00.000Z" })).resolves.toMatchObject({
      windowDays: 90,
      totals: { total: 0 },
    });
  });
});

function outcome(
  id: string,
  outcomeState: AgentRecommendationOutcomeRecord["outcomeState"],
  options: {
    actionType?: AgentRecommendationOutcomeRecord["actionType"];
    surface?: AgentRecommendationOutcomeRecord["surface"];
    repo?: string | null;
    updatedAt?: string;
    reason?: string;
    metadata?: AgentRecommendationOutcomeRecord["metadata"];
    maintainerLane?: boolean;
    confidence?: AgentRecommendationOutcomeRecord["confidence"];
  } = {},
): AgentRecommendationOutcomeRecord {
  return {
    id: `outcome:${id}`,
    actionId: `action:${id}`,
    runId: `run:${id}`,
    actorLogin: "dev",
    actionType: options.actionType ?? "choose_next_work",
    surface: options.surface ?? null,
    targetRepoFullName: options.repo === null ? null : options.repo ?? "owner/repo",
    targetPullNumber: null,
    targetIssueNumber: null,
    outcomeState,
    outcomeTargetType: "repository",
    outcomeRepoFullName: options.repo === null ? null : options.repo ?? "owner/repo",
    outcomePullNumber: null,
    outcomeIssueNumber: null,
    maintainerLane: options.maintainerLane ?? false,
    confidence: options.confidence ?? "high",
    reason: options.reason ?? "safe aggregate fixture",
    sourceUpdatedAt: options.updatedAt ?? "2026-05-30T00:00:00.000Z",
    detectedAt: options.updatedAt ?? "2026-05-30T00:00:00.000Z",
    metadata: options.metadata ?? {},
    createdAt: options.updatedAt ?? "2026-05-30T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-05-30T00:00:00.000Z",
  };
}
