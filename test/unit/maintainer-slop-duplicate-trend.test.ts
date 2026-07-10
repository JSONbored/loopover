import { describe, expect, it } from "vitest";

import { buildQueueHealth, buildCollisionReport } from "../../src/signals/engine";
import {
  buildMaintainerSlopDuplicateTrend,
  slopBandLabelFromRate,
  trendPointFromQueueHealth,
  SLOP_DUPLICATE_TREND_WEEKS,
} from "../../src/services/maintainer-slop-duplicate-trend";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|credibility|private ranking|slopRisk/i;

function repo(fullName: string): RepositoryRecord {
  return {
    fullName,
    owner: fullName.split("/")[0]!,
    name: fullName.split("/")[1]!,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 0,
      labelMultipliers: {},
      maintainerCut: 0,
      raw: {},
    },
  };
}

function pr(number: number, over: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName: "octo/demo",
    number,
    title: `PR ${number}`,
    state: "open",
    authorLogin: "alice",
    authorAssociation: "NONE",
    headSha: `sha${number}`,
    labels: [],
    linkedIssues: [number + 100],
    ...over,
  };
}

function issue(number: number): IssueRecord {
  return {
    repoFullName: "octo/demo",
    number,
    title: `Issue ${number}`,
    state: "open",
    authorLogin: "maintainer",
    authorAssociation: "OWNER",
    labels: [],
    linkedPrs: [],
  };
}

function queueHealthSnapshot(generatedAt: string, signals: Record<string, number>) {
  return {
    id: crypto.randomUUID(),
    signalType: "queue-health",
    targetKey: "octo/demo",
    repoFullName: "octo/demo",
    payload: { signals },
    generatedAt,
  };
}

describe("buildMaintainerSlopDuplicateTrend", () => {
  it("builds both weekly series with band labels and no forbidden public terms", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      stale: false,
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            queueHealthSnapshot("2026-06-02T00:00:00.000Z", {
              openPullRequests: 10,
              collisionClusters: 1,
              slopFlaggedPullRequests: 1,
              duplicateFlaggedPullRequests: 2,
            }),
            queueHealthSnapshot("2026-06-09T00:00:00.000Z", {
              openPullRequests: 8,
              collisionClusters: 2,
              slopFlaggedPullRequests: 4,
              duplicateFlaggedPullRequests: 3,
            }),
          ],
        },
      ],
    });
    expect(trend.generatedAt).toBe("2026-06-14T12:00:00.000Z");
    expect(trend.stale).toBe(false);
    expect(trend.weeks).toHaveLength(SLOP_DUPLICATE_TREND_WEEKS);
    const populated = trend.weeks.filter(
      (week) => week.slopFlagRatePct !== null || week.duplicateFlagRatePct !== null,
    );
    expect(populated.length).toBeGreaterThan(0);
    expect(populated.some((week) => week.slopFlagRatePct !== null)).toBe(true);
    expect(populated.some((week) => week.duplicateFlagRatePct !== null)).toBe(true);
    for (const week of populated) {
      if (week.slopBandLabel) {
        expect(["clean", "low", "elevated", "high"]).toContain(week.slopBandLabel);
      }
    }
    expect(JSON.stringify(trend)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("returns null slop series when snapshots lack slop counts but still shapes duplicate series", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            queueHealthSnapshot("2026-06-09T00:00:00.000Z", {
              openPullRequests: 4,
              collisionClusters: 1,
            }),
          ],
        },
      ],
    });
    const week = trend.weeks.find((entry) => entry.duplicateFlagRatePct !== null);
    expect(week?.duplicateFlagRatePct).toBeGreaterThan(0);
    expect(week?.slopFlagRatePct).toBe(0);
    expect(week?.slopBandLabel).toBe("clean");
  });

  it("returns an all-null series when there is no snapshot history", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      repos: [{ repoFullName: "octo/demo", queueHealthSnapshots: [] }],
    });
    expect(trend.weeks.every((week) => week.slopFlagRatePct === null && week.duplicateFlagRatePct === null)).toBe(
      true,
    );
    expect(trend.summary).toContain("No queue-health snapshot history");
  });

  it("uses explicit duplicate counts and ignores invalid snapshot points", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      stale: true,
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            { ...queueHealthSnapshot("2026-06-09T00:00:00.000Z", { openPullRequests: 5, duplicateFlaggedPullRequests: 2 }), generatedAt: "" },
            queueHealthSnapshot("2026-06-09T00:00:00.000Z", {
              openPullRequests: 5,
              slopFlaggedPullRequests: 0,
              duplicateFlaggedPullRequests: 2,
            }),
            queueHealthSnapshot("invalid-date", { openPullRequests: 99 }),
          ],
        },
      ],
    });
    expect(trend.stale).toBe(true);
    const week = trend.weeks.find((entry) => entry.duplicateFlagRatePct !== null);
    expect(week?.duplicateFlagRatePct).toBe(40);
  });

  it("aggregates the latest snapshot per repo within a week", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            queueHealthSnapshot("2026-06-09T08:00:00.000Z", { openPullRequests: 4, slopFlaggedPullRequests: 1 }),
            queueHealthSnapshot("2026-06-09T18:00:00.000Z", { openPullRequests: 8, slopFlaggedPullRequests: 4 }),
          ],
        },
        {
          repoFullName: "octo/other",
          queueHealthSnapshots: [
            queueHealthSnapshot("2026-06-09T12:00:00.000Z", { openPullRequests: 2, slopFlaggedPullRequests: 1 }),
          ],
        },
      ],
    });
    const week = trend.weeks.find((entry) => entry.slopFlagRatePct !== null);
    expect(week?.slopFlagRatePct).toBe(50);
  });

  it("returns null rates for legacy snapshots with no open PR sample", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [queueHealthSnapshot("2026-06-09T00:00:00.000Z", { openPullRequests: 0, collisionClusters: 3 })],
        },
      ],
    });
    expect(trend.weeks.every((week) => week.duplicateFlagRatePct === null)).toBe(true);
  });

  it("skips snapshots without queue-health signals", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            {
              id: crypto.randomUUID(),
              signalType: "queue-health",
              targetKey: "octo/demo",
              repoFullName: "octo/demo",
              payload: {},
              generatedAt: "2026-06-09T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(trend.summary).toContain("No queue-health snapshot history");
  });

  it("uses live queue-health for the current week when provided", () => {
    const issues = [issue(101), issue(102)];
    const pullRequests = [
      pr(1, { linkedIssues: [101], slopBand: "high", slopRisk: 80 }),
      pr(2, { linkedIssues: [102], slopBand: "clean", slopRisk: 0 }),
      pr(3, { linkedIssues: [101], slopBand: "elevated", slopRisk: 40 }),
    ];
    const collisions = buildCollisionReport("octo/demo", issues, pullRequests);
    const queueHealth = buildQueueHealth(repo("octo/demo"), issues, pullRequests, collisions);
    expect(trendPointFromQueueHealth(queueHealth)).toMatchObject({
      openPullRequests: queueHealth.signals.openPullRequests,
      slopFlaggedPullRequests: queueHealth.signals.slopFlaggedPullRequests,
      duplicateFlaggedPullRequests: queueHealth.signals.duplicateFlaggedPullRequests,
    });
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: queueHealth.generatedAt,
      nowMs: Date.parse(queueHealth.generatedAt),
      repos: [{ repoFullName: "octo/demo", currentQueueHealth: queueHealth }],
    });
    const latest = trend.weeks.at(-1);
    expect(latest?.slopFlagRatePct).toBeGreaterThan(0);
    expect(latest?.slopBandLabel).not.toBe("clean");
    expect(JSON.stringify(trend)).not.toMatch(/"slopRisk"/);
  });
});

describe("buildQueueHealth slop + duplicate counts", () => {
  it("counts slop-flagged and duplicate-flagged open PRs", () => {
    const issues = [issue(101), issue(102)];
    const pullRequests = [
      pr(1, { linkedIssues: [101], slopBand: "high" }),
      pr(2, { linkedIssues: [102], slopBand: "clean" }),
      pr(3, { linkedIssues: [101], slopBand: "elevated" }),
    ];
    const collisions = buildCollisionReport("octo/demo", issues, pullRequests);
    const health = buildQueueHealth(repo("octo/demo"), issues, pullRequests, collisions);
    expect(health.signals.slopFlaggedPullRequests).toBe(2);
    expect(health.signals.duplicateFlaggedPullRequests).toBeGreaterThanOrEqual(0);
  });

  it("counts open PRs in high-risk duplicate collision clusters", () => {
    const sharedIssue = issue(10);
    const pullRequests = [
      pr(11, {
        linkedIssues: [10],
        title: "Add cursor pagination to the labels endpoint",
        authorLogin: "alice",
      }),
      pr(12, {
        linkedIssues: [10],
        title: "Add cursor pagination to the labels endpoint",
        authorLogin: "bob",
      }),
    ];
    const collisions = buildCollisionReport("octo/demo", [sharedIssue], pullRequests);
    const health = buildQueueHealth(repo("octo/demo"), [sharedIssue], pullRequests, collisions);
    expect(health.signals.duplicateFlaggedPullRequests).toBe(2);
  });

  it("treats a collision report without clusters as zero duplicate flags", () => {
    const health = buildQueueHealth(
      repo("octo/demo"),
      [],
      [pr(1, { slopBand: "high" })],
      { repoFullName: "octo/demo", generatedAt: "2026-01-01T00:00:00.000Z", summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 } } as never,
    );
    expect(health.signals.slopFlaggedPullRequests).toBe(1);
    expect(health.signals.duplicateFlaggedPullRequests).toBe(0);
  });
});

describe("slopBandLabelFromRate", () => {
  it("maps aggregate flag rates to public band labels", () => {
    expect(slopBandLabelFromRate(null)).toBeNull();
    expect(slopBandLabelFromRate(0)).toBe("clean");
    expect(slopBandLabelFromRate(10)).toBe("low");
    expect(slopBandLabelFromRate(40)).toBe("elevated");
    expect(slopBandLabelFromRate(75)).toBe("high");
  });
});
