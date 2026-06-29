import { describe, expect, it } from "vitest";
import { getRepoQueueTrendSnapshot, persistRepoGithubTotalsSnapshot, persistSignalSnapshot, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { generateSignalSnapshots } from "../../src/queue/processors";
import { buildQueueTrendReport, buildUnavailableQueueTrendReport, computeReviewVelocityPerDay, type QueueTrendReport } from "../../src/services/queue-trends";
import type { RepoGithubTotalsSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("queue trend windows", () => {
  it("builds deterministic 7/14/30-day queue pressure and review velocity windows", () => {
    const report = buildQueueTrendReport({
      repoFullName: "owner/repo",
      generatedAt: atDaysAgo(0),
      totalsSnapshots: [
        totals(30, { openIssues: 30, openPrs: 6, merged: 10, closed: 4 }),
        totals(14, { openIssues: 34, openPrs: 7, merged: 14, closed: 6 }),
        totals(7, { openIssues: 37, openPrs: 9, merged: 18, closed: 8 }),
        totals(0, { openIssues: 40, openPrs: 12, merged: 25, closed: 11 }),
      ],
      queueHealthSnapshots: [
        queueHealthSnapshot("qh-30", 30, { openPrs: 6, stalePrs: 1, clusters: 1 }),
        queueHealthSnapshot("qh-7", 7, { openPrs: 9, stalePrs: 3, clusters: 2 }),
      ],
      currentQueueHealth: {
        repoFullName: "owner/repo",
        generatedAt: atDaysAgo(0),
        burdenScore: 70,
        level: "high",
        summary: "busy queue",
        signals: {
          openIssues: 40,
          openPullRequests: 12,
          unlinkedPullRequests: 2,
          stalePullRequests: 5,
          draftPullRequests: 0,
          maintainerAuthoredPullRequests: 1,
          collisionClusters: 4,
          ageBuckets: { under7Days: 2, days7To30: 6, over30Days: 4 },
          likelyReviewablePullRequests: 3,
        },
        findings: [],
      },
    });

    expect(report.status).toBe("ready");
    expect(report.windows.map((window) => window.status)).toEqual(["ready", "ready", "ready"]);
    expect(report.windows[0]).toMatchObject({
      windowDays: 7,
      pullRequestGrowth: 3,
      issueGrowth: 3,
      mergedPullRequests: 7,
      closedUnmergedPullRequests: 3,
      reviewVelocityPerDay: expect.any(Number),
      duplicateTrend: 2,
    });
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("stale PR rate"), expect.stringContaining("duplicate cluster")]));
  });

  it("returns null review velocity when observedDays is zero", () => {
    expect(computeReviewVelocityPerDay(7, 3, 0)).toBeNull();
    expect(computeReviewVelocityPerDay(7, 3, 7)).toBe(1.43);
  });

  it("returns clear unavailable windows when history is missing", () => {
    const report = buildQueueTrendReport({ repoFullName: "owner/repo", totalsSnapshots: [totals(0, { openIssues: 1, openPrs: 1, merged: 0, closed: 0 })] });
    expect(report).toMatchObject({
      status: "unavailable",
      windows: [
        expect.objectContaining({ windowDays: 7, status: "unavailable", summary: expect.stringContaining("Need at least 7 days") }),
        expect.objectContaining({ windowDays: 14, status: "unavailable" }),
        expect.objectContaining({ windowDays: 30, status: "unavailable" }),
      ],
    });
    expect(buildUnavailableQueueTrendReport("owner/repo").warnings[0]).toContain("snapshot is missing");

    const empty = buildQueueTrendReport({ repoFullName: "owner/repo", totalsSnapshots: [] });
    expect(empty.windows[0]).toMatchObject({ status: "unavailable", summary: "Missing GitHub totals snapshots." });
  });

  it("handles quiet trends, malformed queue-health snapshots, and zero-open stale rates", () => {
    const report = buildQueueTrendReport({
      repoFullName: "owner/repo",
      totalsSnapshots: [
        totals(7, { openIssues: 10, openPrs: 5, merged: 10, closed: 4 }),
        totals(0, { openIssues: 8, openPrs: 3, merged: 11, closed: 4 }),
      ],
      queueHealthSnapshots: [
        { ...queueHealthSnapshot("qh-zero", 7, { openPrs: 0, stalePrs: 0, clusters: 0 }) },
        { ...queueHealthSnapshot("qh-malformed", 0, { openPrs: 3, stalePrs: 1, clusters: 0 }), generatedAt: undefined, payload: {} },
      ],
    });

    expect(report.status).toBe("ready");
    expect(report.summary).toContain("No major queue trend warning detected.");
    expect(report.warnings).toEqual([]);
    expect(report.windows[0]).toMatchObject({
      windowDays: 7,
      pullRequestGrowth: -2,
      stalePullRequestRate: 0,
      duplicateTrend: null,
      summary: expect.stringContaining("PR queue -2"),
    });
  });

  it("keeps ready totals windows when queue-health trend details are absent or malformed", () => {
    const noQueuePoints = buildQueueTrendReport({
      repoFullName: "owner/repo",
      totalsSnapshots: [
        totals(30, { openIssues: 20, openPrs: 4, merged: 2, closed: 1 }),
        totals(0, { openIssues: 21, openPrs: 4, merged: 4, closed: 2 }),
      ],
    });
    expect(noQueuePoints.windows[2]).toMatchObject({ status: "ready", stalePullRequestRate: null, duplicateTrend: null });

    const malformedSignals = buildQueueTrendReport({
      repoFullName: "owner/repo",
      totalsSnapshots: [
        totals(30, { openIssues: 20, openPrs: 4, merged: 2, closed: 1 }),
        totals(0, { openIssues: 21, openPrs: 4, merged: 4, closed: 2 }),
      ],
      queueHealthSnapshots: [
        {
          id: "qh-invalid-values",
          signalType: "queue-health",
          targetKey: "owner/repo",
          repoFullName: "owner/repo",
          generatedAt: atDaysAgo(0),
          payload: { signals: { openPullRequests: "4", stalePullRequests: null, collisionClusters: "many" } },
        },
      ],
    });
    expect(malformedSignals.windows[2]).toMatchObject({ status: "ready", stalePullRequestRate: 0, duplicateTrend: null });
  });

  it("persists a compact trend snapshot during signal generation", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" }, default_branch: "main" });
    await env.DB.prepare("update repositories set is_registered = 1 where full_name = ?").bind("owner/repo").run();
    await persistRepoGithubTotalsSnapshot(env, totals(30, { openIssues: 10, openPrs: 2, merged: 5, closed: 1 }));
    await persistRepoGithubTotalsSnapshot(env, totals(0, { openIssues: 16, openPrs: 8, merged: 9, closed: 3 }));
    await persistSignalSnapshot(env, queueHealthSnapshot("qh-history", 30, { openPrs: 2, stalePrs: 0, clusters: 1 }));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 1,
      title: "Open fix",
      state: "open",
      user: { login: "miner" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #1",
    });

    await generateSignalSnapshots(env, "owner/repo");

    const snapshot = await getRepoQueueTrendSnapshot(env, "owner/repo");
    const report = snapshot?.payload as unknown as QueueTrendReport;
    expect(report).toMatchObject({
      repoFullName: "owner/repo",
      status: "ready",
      source: "snapshot",
      windows: expect.arrayContaining([expect.objectContaining({ windowDays: 30, status: "ready", pullRequestGrowth: 6 })]),
    });
  });
});

function totals(daysAgo: number, values: { openIssues: number; openPrs: number; merged: number; closed: number }): RepoGithubTotalsSnapshotRecord {
  return {
    id: `totals-${daysAgo}`,
    repoFullName: "owner/repo",
    openIssuesTotal: values.openIssues,
    openPullRequestsTotal: values.openPrs,
    mergedPullRequestsTotal: values.merged,
    closedUnmergedPullRequestsTotal: values.closed,
    labelsTotal: 0,
    sourceKind: "test",
    fetchedAt: atDaysAgo(daysAgo),
    payload: {},
  };
}

function queueHealthSnapshot(id: string, daysAgo: number, values: { openPrs: number; stalePrs: number; clusters: number }) {
  return {
    id,
    signalType: "queue-health",
    targetKey: "owner/repo",
    repoFullName: "owner/repo",
    generatedAt: atDaysAgo(daysAgo),
    payload: {
      signals: {
        openPullRequests: values.openPrs,
        stalePullRequests: values.stalePrs,
        collisionClusters: values.clusters,
      },
    },
  };
}

function atDaysAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}
