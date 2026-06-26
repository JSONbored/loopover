import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { upsertBurdenForecast, upsertQueueFederationSnapshot, upsertRepositoryFromGitHub, upsertRepoQueueTrendSnapshot } from "../../src/db/repositories";
import { buildFederatedQueueIndex, FEDERATED_QUEUE_INDEX_DEFAULT_LIMIT, FEDERATED_QUEUE_INDEX_MAX_LIMIT } from "../../src/services/queue-federation";
import { compositeQueuePressureScore } from "../../src/signals/engine";
import type { JsonValue } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("compositeQueuePressureScore", () => {
  it("uses burdenScore when stale rate and growth are both null", () => {
    expect(compositeQueuePressureScore(80, null, null)).toBe(80);
  });

  it("amplifies burden score by stale rate", () => {
    expect(compositeQueuePressureScore(50, 0.5, null)).toBeCloseTo(75);
  });

  it("adds pull request growth to the score", () => {
    expect(compositeQueuePressureScore(50, 0, 10)).toBeCloseTo(60);
  });

  it("combines stale rate and growth correctly", () => {
    expect(compositeQueuePressureScore(40, 0.25, 5)).toBeCloseTo(55);
  });

  it("handles zero burden score", () => {
    expect(compositeQueuePressureScore(0, 0.9, 20)).toBeCloseTo(20);
  });
});

describe("buildFederatedQueueIndex", () => {
  it("returns an empty index when no repos are registered and installed", async () => {
    const env = createTestEnv();
    const index = await buildFederatedQueueIndex(env);
    expect(index.repoCount).toBe(0);
    expect(index.entries).toEqual([]);
    expect(index.limitApplied).toBe(FEDERATED_QUEUE_INDEX_DEFAULT_LIMIT);
    expect(index.source).toBe("computed");
  });

  it("returns source=snapshot and entries from cache when a fresh snapshot exists", async () => {
    const env = createTestEnv();
    await upsertQueueFederationSnapshot(env, {
      id: "current",
      generatedAt: new Date(Date.now() - 30_000).toISOString(),
      repoCount: 1,
      payload: {
        entries: [{ repoFullName: "owner/cached", burdenScore: 55, level: "high", compositeScore: 55, stalePullRequestRate: null, pullRequestGrowth7d: null, freshness: "fresh", summary: "high burden" }],
      } as unknown as Record<string, JsonValue>,
    });
    const index = await buildFederatedQueueIndex(env);
    expect(index.source).toBe("snapshot");
    expect(index.repoCount).toBe(1);
    expect(index.entries[0]?.repoFullName).toBe("owner/cached");
  });

  it("includes a repo with a cached burden forecast", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "alpha", full_name: "owner/alpha", private: false, owner: { login: "owner" }, default_branch: "main" });
    await markInstalled(env, "owner/alpha");
    await markRegistered(env, "owner/alpha");
    await upsertBurdenForecast(env, {
      repoFullName: "owner/alpha",
      payload: { repoFullName: "owner/alpha", level: "high", forecast: { projectedReviewLoad: 70, reviewablePullRequests: 0, stalePullRequests: 0, duplicateTrend: 0, queueGrowthRisk: 0 }, summary: "high burden" } as unknown as Record<string, JsonValue>,
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const index = await buildFederatedQueueIndex(env);
    expect(index.repoCount).toBe(1);
    expect(index.entries[0]?.repoFullName).toBe("owner/alpha");
    expect(index.entries[0]?.level).toBe("high");
    expect(index.entries[0]?.burdenScore).toBe(70);
  });

  it("ranks repos descending by composite score", async () => {
    const env = createTestEnv();
    for (const [name, score, level] of [["low-repo", 20, "low"], ["high-repo", 80, "critical"], ["mid-repo", 50, "high"]] as const) {
      await upsertRepositoryFromGitHub(env, { name, full_name: `owner/${name}`, private: false, owner: { login: "owner" }, default_branch: "main" });
      await markInstalled(env, `owner/${name}`);
      await markRegistered(env, `owner/${name}`);
      await upsertBurdenForecast(env, {
        repoFullName: `owner/${name}`,
        payload: { repoFullName: `owner/${name}`, level, forecast: { projectedReviewLoad: score, reviewablePullRequests: 0, stalePullRequests: 0, duplicateTrend: 0, queueGrowthRisk: 0 }, summary: `${level} burden` } as unknown as Record<string, JsonValue>,
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }
    const index = await buildFederatedQueueIndex(env);
    expect(index.entries.map((e) => e.repoFullName)).toEqual(["owner/high-repo", "owner/mid-repo", "owner/low-repo"]);
  });

  it("sorts critical above high when composite scores are equal", async () => {
    const env = createTestEnv();
    for (const [name, level] of [["repo-high", "high"], ["repo-critical", "critical"]] as const) {
      await upsertRepositoryFromGitHub(env, { name, full_name: `owner/${name}`, private: false, owner: { login: "owner" }, default_branch: "main" });
      await markInstalled(env, `owner/${name}`);
      await markRegistered(env, `owner/${name}`);
      await upsertBurdenForecast(env, {
        repoFullName: `owner/${name}`,
        payload: { repoFullName: `owner/${name}`, level, forecast: { projectedReviewLoad: 60, reviewablePullRequests: 0, stalePullRequests: 0, duplicateTrend: 0, queueGrowthRisk: 0 }, summary: `${level} burden` } as unknown as Record<string, JsonValue>,
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }
    const index = await buildFederatedQueueIndex(env);
    expect(index.entries[0]?.level).toBe("critical");
    expect(index.entries[1]?.level).toBe("high");
  });

  it("omits repos that are registered but not installed", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "uninstalled", full_name: "owner/uninstalled", private: false, owner: { login: "owner" }, default_branch: "main" });
    await markRegistered(env, "owner/uninstalled");
    const index = await buildFederatedQueueIndex(env);
    expect(index.repoCount).toBe(0);
  });

  it("respects the limit parameter and clamps it to the maximum", async () => {
    const env = createTestEnv();
    for (let i = 0; i < 5; i++) {
      const name = `repo-${i}`;
      await upsertRepositoryFromGitHub(env, { name, full_name: `owner/${name}`, private: false, owner: { login: "owner" }, default_branch: "main" });
      await markInstalled(env, `owner/${name}`);
      await markRegistered(env, `owner/${name}`);
      await upsertBurdenForecast(env, {
        repoFullName: `owner/${name}`,
        payload: { repoFullName: `owner/${name}`, level: "low", forecast: { projectedReviewLoad: i * 5, reviewablePullRequests: 0, stalePullRequests: 0, duplicateTrend: 0, queueGrowthRisk: 0 }, summary: "low" } as unknown as Record<string, JsonValue>,
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }
    const limited = await buildFederatedQueueIndex(env, 2);
    expect(limited.entries).toHaveLength(2);
    expect(limited.limitApplied).toBe(2);
    expect(limited.repoCount).toBe(5);

    const clamped = await buildFederatedQueueIndex(env, FEDERATED_QUEUE_INDEX_MAX_LIMIT + 100);
    expect(clamped.limitApplied).toBe(FEDERATED_QUEUE_INDEX_MAX_LIMIT);
  });

  it("still includes a repo with no trend snapshot (pullRequestGrowth7d: null)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "notrend", full_name: "owner/notrend", private: false, owner: { login: "owner" }, default_branch: "main" });
    await markInstalled(env, "owner/notrend");
    await markRegistered(env, "owner/notrend");
    await upsertBurdenForecast(env, {
      repoFullName: "owner/notrend",
      payload: { repoFullName: "owner/notrend", level: "medium", forecast: { projectedReviewLoad: 40, reviewablePullRequests: 0, stalePullRequests: 0, duplicateTrend: 0, queueGrowthRisk: 0 }, summary: "medium" } as unknown as Record<string, JsonValue>,
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const index = await buildFederatedQueueIndex(env);
    expect(index.repoCount).toBe(1);
    expect(index.entries[0]?.pullRequestGrowth7d).toBeNull();
    expect(index.entries[0]?.stalePullRequestRate).toBeNull();
  });

  it("reads stalePullRequestRate and pullRequestGrowth7d from a stored trend snapshot", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "trend", full_name: "owner/trend", private: false, owner: { login: "owner" }, default_branch: "main" });
    await markInstalled(env, "owner/trend");
    await markRegistered(env, "owner/trend");
    await upsertBurdenForecast(env, {
      repoFullName: "owner/trend",
      payload: { repoFullName: "owner/trend", level: "medium", forecast: { projectedReviewLoad: 45, reviewablePullRequests: 2, stalePullRequests: 1, duplicateTrend: 0, queueGrowthRisk: 20 }, summary: "medium" } as unknown as Record<string, JsonValue>,
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await upsertRepoQueueTrendSnapshot(env, {
      repoFullName: "owner/trend",
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
      payload: {
        repoFullName: "owner/trend",
        status: "ready",
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
        source: "snapshot",
        windows: [
          {
            windowDays: 7,
            status: "ready",
            observedDays: 7,
            baselineAt: null,
            latestAt: null,
            pullRequestGrowth: 3,
            issueGrowth: 1,
            mergedPullRequests: 5,
            closedUnmergedPullRequests: 1,
            reviewVelocityPerDay: 0.86,
            stalePullRequestRate: 0.25,
            stalePullRequestRateDelta: 0.05,
            duplicateTrend: 0,
            summary: "7d trend: PR queue +3, review velocity 0.86/day.",
          },
        ],
        warnings: [],
        summary: "1 queue trend window available.",
      } as unknown as Record<string, JsonValue>,
    });
    const index = await buildFederatedQueueIndex(env);
    expect(index.repoCount).toBe(1);
    expect(index.entries[0]?.stalePullRequestRate).toBeCloseTo(0.25);
    expect(index.entries[0]?.pullRequestGrowth7d).toBe(3);
    expect(index.entries[0]?.compositeScore).toBeCloseTo(59.25);
  });

  it("does not include private signal fields (privateTrustEnabled, hotkeys, raw trust scores)", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "safe", full_name: "owner/safe", private: false, owner: { login: "owner" }, default_branch: "main" });
    await markInstalled(env, "owner/safe");
    await markRegistered(env, "owner/safe");
    await upsertBurdenForecast(env, {
      repoFullName: "owner/safe",
      payload: { repoFullName: "owner/safe", level: "low", forecast: { projectedReviewLoad: 10, reviewablePullRequests: 0, stalePullRequests: 0, duplicateTrend: 0, queueGrowthRisk: 0 }, summary: "low" } as unknown as Record<string, JsonValue>,
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const index = await buildFederatedQueueIndex(env);
    const entry = index.entries[0];
    expect(entry).toBeDefined();
    const entryKeys = Object.keys(entry!);
    for (const forbidden of ["privateTrustEnabled", "hotkey", "trustScore", "wallet", "reward", "payout"]) {
      expect(entryKeys).not.toContain(forbidden);
    }
    const serialized = JSON.stringify(entry);
    for (const forbidden of ["wallet", "hotkey", "trust score", "payout", "reward estimate", "farming"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("GET /v1/app/queue-health/federation route", () => {
  function apiHeaders(env: ReturnType<typeof createTestEnv>): Record<string, string> {
    return { authorization: `Bearer ${env.GITTENSORY_API_TOKEN}` };
  }

  it("returns 401 for unauthenticated requests", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/app/queue-health/federation", {}, env);
    expect(response.status).toBe(401);
  });

  it("returns 200 with an empty index when no repos are registered", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/app/queue-health/federation", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repoCount: number; entries: unknown[]; source: string };
    expect(body.repoCount).toBe(0);
    expect(body.entries).toEqual([]);
    expect(body.source).toBe("computed");
  });

  it("returns source=snapshot when a fresh cached index exists", async () => {
    const app = createApp();
    const env = createTestEnv();
    await upsertQueueFederationSnapshot(env, {
      id: "current",
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
      repoCount: 2,
      payload: {
        entries: [
          { repoFullName: "owner/alpha", burdenScore: 70, level: "high", compositeScore: 70, stalePullRequestRate: null, pullRequestGrowth7d: null, freshness: "fresh", summary: "high" },
          { repoFullName: "owner/beta", burdenScore: 40, level: "medium", compositeScore: 40, stalePullRequestRate: null, pullRequestGrowth7d: null, freshness: "fresh", summary: "medium" },
        ],
      } as unknown as Record<string, JsonValue>,
    });
    const response = await app.request("/v1/app/queue-health/federation", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repoCount: number; entries: unknown[]; source: string };
    expect(body.source).toBe("snapshot");
    expect(body.repoCount).toBe(2);
    expect((body.entries as unknown[]).length).toBe(2);
  });

  it("returns 422 for an invalid limit parameter", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/app/queue-health/federation?limit=0", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_limit" });
  });

  it("returns 422 for a non-integer limit parameter", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/app/queue-health/federation?limit=abc", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(422);
  });

  it("returns 200 with a valid limit parameter", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/app/queue-health/federation?limit=5", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { limitApplied: number };
    expect(body.limitApplied).toBe(5);
  });
});

async function markInstalled(env: ReturnType<typeof createTestEnv>, fullName: string): Promise<void> {
  const { getDb } = await import("../../src/db/client");
  const { repositories } = await import("../../src/db/schema");
  const { eq } = await import("drizzle-orm");
  await getDb(env.DB).update(repositories).set({ isInstalled: true }).where(eq(repositories.fullName, fullName));
}

async function markRegistered(env: ReturnType<typeof createTestEnv>, fullName: string): Promise<void> {
  const { getDb } = await import("../../src/db/client");
  const { repositories } = await import("../../src/db/schema");
  const { eq } = await import("drizzle-orm");
  await getDb(env.DB).update(repositories).set({ isRegistered: true }).where(eq(repositories.fullName, fullName));
}
