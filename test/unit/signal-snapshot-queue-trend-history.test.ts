import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRepoQueueTrendSnapshot,
  persistRepoGithubTotalsSnapshot,
  persistSignalSnapshot,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
} from "../../src/db/repositories";
import { generateSignalSnapshots } from "../../src/queue/processors";
import type { QueueTrendReport } from "../../src/services/queue-trends";
import type { RepoGithubTotalsSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/trend-history";
const FIXTURE_NOW_MS = Date.parse("2026-07-31T12:00:00.000Z");

describe("signal-snapshot queue-trend history window (#10020)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXTURE_NOW_MS });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("REGRESSION: time-bounded queue-health history lets the 30-day window resolve duplicate and stale deltas", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(
      env,
      { name: "trend-history", full_name: REPO, private: false, owner: { login: "owner" }, default_branch: "main" },
      801,
    );
    await env.DB.prepare("update repositories set is_registered = 1 where full_name = ?").bind(REPO).run();
    await upsertPullRequestFromGitHub(env, REPO, {
      number: 1,
      title: "Open fix",
      state: "open",
      user: { login: "miner" },
      author_association: "NONE",
      labels: [],
      body: "Fixes #1",
      created_at: atDaysAgo(40),
      updated_at: atDaysAgo(0),
    });

    // 130 queue-health rows across ~33 days at four/day — under the old listSignalSnapshots(limit 100)
    // only ~25 days remained and the 30-day baseline stayed null.
    let id = 0;
    for (let day = 32; day >= 0; day -= 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        if (id >= 130) break;
        const daysAgo = day + slot / 4;
        await persistSignalSnapshot(env, {
          id: `qh-${id}`,
          signalType: "queue-health",
          targetKey: REPO,
          repoFullName: REPO,
          generatedAt: atDaysAgo(daysAgo),
          payload: {
            signals: {
              openPullRequests: 10 + Math.floor(daysAgo),
              stalePullRequests: 1 + Math.floor(daysAgo / 10),
              collisionClusters: 1 + Math.floor((32 - day) / 8),
            },
          },
        });
        id += 1;
      }
    }

    for (const daysAgo of [33, 30, 14, 7, 0]) {
      await persistRepoGithubTotalsSnapshot(env, totals(daysAgo, {
        openIssues: 10 + daysAgo,
        openPrs: 4 + Math.floor(daysAgo / 5),
        merged: 20 - Math.floor(daysAgo / 3),
        closed: 5,
      }));
    }

    await generateSignalSnapshots(env, REPO);

    const snapshot = await getRepoQueueTrendSnapshot(env, REPO);
    const report = snapshot?.payload as unknown as QueueTrendReport;
    const window30 = report?.windows.find((window) => window.windowDays === 30);
    expect(window30).toMatchObject({
      status: "ready",
      duplicateTrend: expect.any(Number),
      stalePullRequestRateDelta: expect.any(Number),
    });
    expect(window30?.duplicateTrend).not.toBeNull();
    expect(window30?.stalePullRequestRateDelta).not.toBeNull();
  });

  it("a repo with no queue-health history still persists a trend (map-miss ?? [] arm) with unavailable windows when totals are missing", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(
      env,
      { name: "empty-history", full_name: "owner/empty-history", private: false, owner: { login: "owner" }, default_branch: "main" },
      802,
    );

    await generateSignalSnapshots(env, "owner/empty-history");

    const snapshot = await getRepoQueueTrendSnapshot(env, "owner/empty-history");
    const report = snapshot?.payload as unknown as QueueTrendReport;
    expect(report).toMatchObject({
      status: "unavailable",
      windows: [
        expect.objectContaining({ windowDays: 7, status: "unavailable" }),
        expect.objectContaining({ windowDays: 14, status: "unavailable" }),
        expect.objectContaining({ windowDays: 30, status: "unavailable" }),
      ],
    });
  });
});

function totals(
  daysAgo: number,
  values: { openIssues: number; openPrs: number; merged: number; closed: number },
): RepoGithubTotalsSnapshotRecord {
  return {
    id: `totals-${daysAgo}-${REPO}`,
    repoFullName: REPO,
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

function atDaysAgo(daysAgo: number): string {
  return new Date(FIXTURE_NOW_MS - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}
