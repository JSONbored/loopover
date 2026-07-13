import { describe, expect, it } from "vitest";

import { buildQueueHealth, buildCollisionReport } from "../../src/signals/engine";
import {
  buildMaintainerSlopDuplicateTrend,
  slopBandLabelFromRate,
  SLOP_DUPLICATE_TREND_WEEKS,
  trendPointFromQueueHealth,
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
    expect(trend.stale).toBe(false);
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
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: queueHealth.generatedAt,
      nowMs: Date.parse(queueHealth.generatedAt),
      repos: [{ repoFullName: "octo/demo", currentQueueHealth: queueHealth }],
    });
    const latest = trend.weeks.at(-1);
    expect(latest?.slopFlagRatePct).toBeGreaterThan(0);
    expect(latest?.slopBandLabel).not.toBe("clean");
    expect(JSON.stringify(trend)).not.toMatch(/"slopRisk"/);
    expect(queueHealth.signals.slopFlaggedPullRequests).toBe(2);
  });

  it("counts duplicate-flagged PRs only in high-risk clusters with 2+ pull requests", () => {
    const issues = [issue(101)];
    const pullRequests = [
      pr(1, { linkedIssues: [101] }),
      pr(2, { linkedIssues: [101] }),
      pr(3, { linkedIssues: [101] }),
    ];
    const collisions = buildCollisionReport("octo/demo", issues, pullRequests);
    const queueHealth = buildQueueHealth(repo("octo/demo"), issues, pullRequests, collisions);
    expect(queueHealth.signals.duplicateFlaggedPullRequests).toBe(3);
    expect(trendPointFromQueueHealth(queueHealth).duplicateFlaggedPullRequests).toBe(3);
  });

  it("ignores snapshots without generatedAt or signals payload", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            {
              id: "bad",
              signalType: "queue-health",
              targetKey: "octo/demo",
              repoFullName: "octo/demo",
              payload: {},
              generatedAt: "",
            },
            {
              id: "malformed",
              signalType: "queue-health",
              targetKey: "octo/demo",
              repoFullName: "octo/demo",
              payload: { signals: { openPullRequests: "nope" } },
              generatedAt: "2026-06-09T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(trend.weeks.every((week) => week.slopFlagRatePct === null && week.duplicateFlagRatePct === null)).toBe(
      true,
    );
  });

  it("aggregates the latest snapshot per repo within each week bucket", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/alpha",
          queueHealthSnapshots: [
            queueHealthSnapshot("2026-06-09T00:00:00.000Z", {
              openPullRequests: 4,
              slopFlaggedPullRequests: 1,
              duplicateFlaggedPullRequests: 1,
            }),
          ],
        },
        {
          repoFullName: "octo/beta",
          queueHealthSnapshots: [
            queueHealthSnapshot("2026-06-09T12:00:00.000Z", {
              openPullRequests: 6,
              slopFlaggedPullRequests: 3,
              duplicateFlaggedPullRequests: 2,
            }),
          ],
        },
      ],
    });
    const week = trend.weeks.find((entry) => entry.slopFlagRatePct === 40);
    expect(week?.duplicateFlagRatePct).toBe(30);
  });

  it("keeps the newest snapshot per repo when an older point is seen later in the week", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            queueHealthSnapshot("2026-06-09T12:00:00.000Z", {
              openPullRequests: 10,
              slopFlaggedPullRequests: 5,
              duplicateFlaggedPullRequests: 2,
            }),
            queueHealthSnapshot("2026-06-09T06:00:00.000Z", {
              openPullRequests: 2,
              slopFlaggedPullRequests: 0,
              duplicateFlaggedPullRequests: 0,
            }),
          ],
        },
      ],
    });
    const week = trend.weeks.find((entry) => entry.slopFlagRatePct === 50);
    expect(week?.duplicateFlagRatePct).toBe(20);
  });

  it("drops snapshots whose payload lacks a parseable signals object", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      nowMs: Date.parse("2026-06-14T12:00:00.000Z"),
      repos: [
        {
          repoFullName: "octo/demo",
          queueHealthSnapshots: [
            {
              id: "missing-signals",
              signalType: "queue-health",
              targetKey: "octo/demo",
              repoFullName: "octo/demo",
              payload: {},
              generatedAt: "2026-06-09T00:00:00.000Z",
            },
            {
              id: "array-signals",
              signalType: "queue-health",
              targetKey: "octo/demo",
              repoFullName: "octo/demo",
              payload: { signals: [1, 2, 3] },
              generatedAt: "2026-06-09T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(trend.weeks.every((week) => week.slopFlagRatePct === null && week.duplicateFlagRatePct === null)).toBe(
      true,
    );
    expect(trend.summary).toContain("No queue-health snapshot history");
  });

  it("honours explicit stale and custom week windows", () => {
    const trend = buildMaintainerSlopDuplicateTrend({
      generatedAt: "2026-06-14T12:00:00.000Z",
      stale: true,
      weeks: 4,
      repos: [{ repoFullName: "octo/demo", queueHealthSnapshots: [] }],
    });
    expect(trend.stale).toBe(true);
    expect(trend.weeks).toHaveLength(4);
  });
});

describe("slopBandLabelFromRate", () => {
  it("maps aggregate flag rates to public band labels", () => {
    expect(slopBandLabelFromRate(null)).toBeNull();
    expect(slopBandLabelFromRate(0)).toBe("clean");
    expect(slopBandLabelFromRate(10)).toBe("low");
    expect(slopBandLabelFromRate(25)).toBe("elevated");
    expect(slopBandLabelFromRate(40)).toBe("elevated");
    expect(slopBandLabelFromRate(60)).toBe("high");
    expect(slopBandLabelFromRate(75)).toBe("high");
  });
});
