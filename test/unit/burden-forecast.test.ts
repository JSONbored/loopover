import { describe, expect, it, vi } from "vitest";
import { getBurdenForecast, upsertBurdenForecast, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { BURDEN_FORECAST_MAX_AGE_MS, loadOrComputeBurdenForecastResponse } from "../../src/services/burden-forecast";
import { buildBurdenForecast, buildCollisionReport } from "../../src/signals/engine";
import type { IssueRecord, JsonValue, PullRequestRecord, RepositoryRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("burden forecast builder", () => {
  it("classifies a small clean queue as low burden with no findings", () => {
    const repo = repoFixture("owner/small");
    const forecast = buildBurdenForecast(repo, [], [], buildCollisionReport(repo.fullName, [], []), 7);
    expect(forecast.level).toBe("low");
    expect(forecast.findings).toEqual([]);
  });

  it("stays bounded on a ragflow/sure-style large queue and emits critical findings", () => {
    const repo = repoFixture("ragflow/ragflow");
    const stalePr = pr(repo.fullName, 999, "stale", { updatedAt: daysAgo(31) });
    const open = Array.from({ length: 120 }, (_, index) => pr(repo.fullName, index + 1, `open ${index}`, { linkedIssues: [], updatedAt: new Date().toISOString() }));
    const forecast = buildBurdenForecast(repo, [], [stalePr, ...open], buildCollisionReport(repo.fullName, [], [stalePr, ...open]), 30);
    expect(forecast.level).toBe("critical");
    expect(forecast.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["queue_growth_risk", "stale_review_load"]));
    expect(forecast.forecast.stalePullRequests).toBeGreaterThan(0);
  });

  it("counts the duplicate cluster trend when multiple PRs reference the same issue", () => {
    const repo = repoFixture("owner/duplicates");
    const issueRecord = issue(repo.fullName, 42, "Auth failure after reconnect");
    const a = pr(repo.fullName, 1, "Token refresh", { linkedIssues: [42] });
    const b = pr(repo.fullName, 2, "Session restore", { linkedIssues: [42] });
    const collisions = buildCollisionReport(repo.fullName, [issueRecord], [a, b]);
    const forecast = buildBurdenForecast(repo, [issueRecord], [a, b], collisions, 7);
    expect(collisions.summary.clusterCount).toBe(4);
    expect(collisions.clusters.some((cluster) => cluster.items.map((item) => `${item.type}:${item.number}`).sort().join("|") === "issue:42|pull_request:1|pull_request:2")).toBe(true);
    expect(forecast.forecast.duplicateTrend).toBe(4);
  });

  it("classifies a small unreviewable queue as medium burden via queue-growth risk", () => {
    const repo = repoFixture("owner/growth");
    // 5 open PRs with no linked issues, updated 10 days ago: not recent (> horizon 7) and not stale (< 30).
    // Low projectedReviewLoad, but queueGrowthRisk is driven up by the unreviewable count.
    const open = Array.from({ length: 5 }, (_, index) => pr(repo.fullName, index + 1, `open ${index}`, { linkedIssues: [], updatedAt: daysAgo(10) }));
    const forecast = buildBurdenForecast(repo, [], open, buildCollisionReport(repo.fullName, [], open), 7);
    expect(forecast.forecast.projectedReviewLoad).toBeLessThan(25);
    expect(forecast.forecast.queueGrowthRisk).toBeGreaterThanOrEqual(25);
    expect(forecast.forecast.queueGrowthRisk).toBeLessThan(55);
    // queueGrowthRisk must drive the medium tier even when projectedReviewLoad is low.
    expect(forecast.level).toBe("medium");
  });

  it("surfaces a stale PR trend in the forecast findings", () => {
    const repo = repoFixture("owner/stale");
    const stalePrs = Array.from({ length: 4 }, (_, index) => pr(repo.fullName, index + 1, `stale ${index}`, { updatedAt: daysAgo(31), linkedIssues: [] }));
    const forecast = buildBurdenForecast(repo, [], stalePrs, buildCollisionReport(repo.fullName, [], stalePrs), 30);
    expect(forecast.forecast.stalePullRequests).toBe(4);
    expect(forecast.findings.find((f) => f.code === "stale_review_load")?.detail).toContain("4 open PR(s)");
  });
});

describe("loadOrComputeBurdenForecastResponse", () => {
  it("returns null when the repo is unknown", async () => {
    const env = createTestEnv();
    const response = await loadOrComputeBurdenForecastResponse(env, "ghost/missing");
    expect(response).toBeNull();
  });

  it("returns a snapshot envelope with freshness:fresh for a recently persisted forecast", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "fresh", full_name: "owner/fresh", private: false, owner: { login: "owner" }, default_branch: "main" });
    await upsertBurdenForecast(env, {
      repoFullName: "owner/fresh",
      payload: { repoFullName: "owner/fresh", level: "low", summary: "fresh fixture" } as unknown as Record<string, JsonValue>,
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const response = await loadOrComputeBurdenForecastResponse(env, "owner/fresh");
    expect(response).toMatchObject({
      status: "ready",
      source: "snapshot",
      repoFullName: "owner/fresh",
      freshness: "fresh",
      report: { level: "low" },
    });
    expect(response?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(response?.ageSeconds).toBeLessThan(BURDEN_FORECAST_MAX_AGE_MS / 1000);
  });

  it("surfaces freshness:stale when the cached forecast is older than the max age", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "old", full_name: "owner/old", private: false, owner: { login: "owner" }, default_branch: "main" });
    const generatedAt = new Date(Date.now() - BURDEN_FORECAST_MAX_AGE_MS - 60_000).toISOString();
    await upsertBurdenForecast(env, {
      repoFullName: "owner/old",
      payload: { repoFullName: "owner/old", level: "high", summary: "stale fixture" } as unknown as Record<string, JsonValue>,
      generatedAt,
    });
    const response = await loadOrComputeBurdenForecastResponse(env, "owner/old");
    expect(response).toMatchObject({
      status: "ready",
      source: "snapshot",
      freshness: "stale",
    });
    expect(response?.ageSeconds).toBeGreaterThanOrEqual(Math.floor((BURDEN_FORECAST_MAX_AGE_MS + 50_000) / 1000));
    expect(response?.ageSeconds).toBeLessThan(Math.floor((BURDEN_FORECAST_MAX_AGE_MS + 120_000) / 1000));
  });

  it("treats malformed cached forecast timestamps as stale", async () => {
    const env = createTestEnv();
    await upsertBurdenForecast(env, {
      repoFullName: "owner/malformed-time",
      payload: { repoFullName: "owner/malformed-time", level: "medium", summary: "bad timestamp fixture" } as unknown as Record<string, JsonValue>,
      generatedAt: "not-a-date",
    });

    const response = await loadOrComputeBurdenForecastResponse(env, "owner/malformed-time");

    expect(response).toMatchObject({
      status: "ready",
      source: "snapshot",
      repoFullName: "owner/malformed-time",
      freshness: "stale",
    });
    expect(response?.ageSeconds).toBe(Number.POSITIVE_INFINITY);
  });

  it("falls back to a computed forecast when no snapshot exists but the repo is known", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "uncached", full_name: "owner/uncached", private: false, owner: { login: "owner" }, default_branch: "main" });
    const response = await loadOrComputeBurdenForecastResponse(env, "owner/uncached");
    expect(response).toMatchObject({
      status: "ready",
      source: "computed",
      freshness: "fresh",
      ageSeconds: 0,
    });
    expect(response?.report).toMatchObject({ repoFullName: "owner/uncached", level: "low" });
  });

  it("does not call broad request-time listers when a cached forecast exists", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "perf", full_name: "owner/perf", private: false, owner: { login: "owner" }, default_branch: "main" });
    await upsertBurdenForecast(env, {
      repoFullName: "owner/perf",
      payload: { repoFullName: "owner/perf", level: "low", summary: "fixture" } as unknown as Record<string, JsonValue>,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const repositoriesModule = await import("../../src/db/repositories");
    const spies = [
      vi.spyOn(repositoriesModule, "listIssueSignalSample"),
      vi.spyOn(repositoriesModule, "listOpenPullRequests"),
      vi.spyOn(repositoriesModule, "listRecentMergedPullRequests"),
    ];
    await loadOrComputeBurdenForecastResponse(env, "owner/perf");
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("uses only the bounded per-repo listers when computing a missing forecast", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "computed-perf", full_name: "owner/computed-perf", private: false, owner: { login: "owner" }, default_branch: "main" });
    const repositoriesModule = await import("../../src/db/repositories");
    const spies = [
      vi.spyOn(repositoriesModule, "listIssueSignalSample"),
      vi.spyOn(repositoriesModule, "listOpenPullRequests"),
      vi.spyOn(repositoriesModule, "listRecentMergedPullRequests"),
    ];

    const response = await loadOrComputeBurdenForecastResponse(env, "owner/computed-perf");

    expect(response).toMatchObject({ source: "computed", report: { repoFullName: "owner/computed-perf" } });
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(env, "owner/computed-perf");
      spy.mockRestore();
    }
  });

  it("getBurdenForecast round-trips through upsert", async () => {
    const env = createTestEnv();
    await upsertBurdenForecast(env, {
      repoFullName: "owner/round-trip",
      payload: { level: "medium", summary: "round-trip" } as unknown as Record<string, JsonValue>,
      generatedAt: "2026-05-25T00:00:00.000Z",
    });
    const row = await getBurdenForecast(env, "owner/round-trip");
    expect(row).toMatchObject({ repoFullName: "owner/round-trip", generatedAt: "2026-05-25T00:00:00.000Z" });
    expect(row?.payload).toMatchObject({ level: "medium", summary: "round-trip" });
  });
});

function repoFixture(fullName: string): RepositoryRecord {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 0,
      maintainerCut: 0,
      labelMultipliers: {},
      raw: {},
    },
  } as RepositoryRecord;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function issue(repoFullName: string, number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "Detailed body for collision testing with enough content to be useful.",
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as IssueRecord;
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "NONE",
    labels: [],
    linkedIssues: [],
    body: "",
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as PullRequestRecord;
}
