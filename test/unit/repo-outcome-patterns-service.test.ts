import { describe, expect, it, vi } from "vitest";
import { persistSignalSnapshot, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import {
  REPO_OUTCOME_PATTERNS_MAX_AGE_MS,
  REPO_OUTCOME_PATTERNS_SIGNAL,
  computeRepoOutcomePatterns,
  loadOrComputeRepoOutcomePatternsResponse,
  loadRepoOutcomePatternsMap,
} from "../../src/services/repo-outcome-patterns";
import type { SignalSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function snapshotPayload(repoFullName: string, summary: string) {
  return {
    repoFullName,
    generatedAt: new Date().toISOString(),
    lane: "direct_pr",
    primaryLanguage: "TypeScript",
    sampleSize: 0,
    totals: { analyzed: 0, merged: 0, closedUnmerged: 0, openActive: 0, openStale: 0, maintainerLanePullRequests: 0, outsideContributorPullRequests: 0 },
    outsideContributorMergeRate: 0,
    maintainerLaneMergeRate: 0,
    dimensions: [],
    successPatterns: [],
    riskPatterns: [],
    evidenceCompleteness: { pullRequestsAnalyzed: 0, withFileDetail: 0, withReviewDetail: 0, withCheckDetail: 0, filesCompletenessRatio: 0, reviewsCompletenessRatio: 0, checksCompletenessRatio: 0, fullyDecidedWithDetail: 0, status: "missing" },
    findings: [],
    summary,
  };
}

describe("loadOrComputeRepoOutcomePatternsResponse", () => {
  it("returns null when the repo is unknown and has no snapshot", async () => {
    const env = createTestEnv();
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "ghost/missing");
    expect(response).toBeNull();
  });

  it("serves a snapshot envelope with freshness:fresh when recently persisted", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "fresh", full_name: "owner/fresh", private: false, owner: { login: "owner" }, default_branch: "main" });
    const generatedAt = new Date(Date.now() - 60_000).toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/fresh",
      repoFullName: "owner/fresh",
      payload: { ...snapshotPayload("owner/fresh", "cached fixture"), generatedAt } as unknown as Record<string, never>,
      generatedAt,
    });
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/fresh");
    expect(response).toMatchObject({ status: "ready", source: "snapshot", freshness: "fresh", patterns: { summary: "cached fixture" } });
    expect(response?.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("flags freshness:stale once the snapshot is older than the max age", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "old", full_name: "owner/old", private: false, owner: { login: "owner" }, default_branch: "main" });
    const generatedAt = new Date(Date.now() - REPO_OUTCOME_PATTERNS_MAX_AGE_MS - 60_000).toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/old",
      repoFullName: "owner/old",
      payload: { ...snapshotPayload("owner/old", "stale fixture"), generatedAt } as unknown as Record<string, never>,
      generatedAt,
    });
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/old");
    expect(response).toMatchObject({ status: "ready", source: "snapshot", freshness: "stale" });
  });

  it("falls back to a computed envelope when a known repo has no snapshot yet", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "uncached", full_name: "owner/uncached", private: false, owner: { login: "owner" }, default_branch: "main" });
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/uncached");
    expect(response).toMatchObject({ status: "ready", source: "computed", freshness: "fresh", patterns: { repoFullName: "owner/uncached" } });
  });

  it("uses the payload timestamp when the snapshot column carries no generatedAt", async () => {
    const env = createTestEnv();
    const generatedAt = new Date(Date.now() - 120_000).toISOString();
    const repositoriesModule = await import("../../src/db/repositories");
    const snapshot: SignalSnapshotRecord = {
      id: "snap-payload-ts",
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/payload-ts",
      repoFullName: "owner/payload-ts",
      generatedAt: null,
      payload: { ...snapshotPayload("owner/payload-ts", "payload ts"), generatedAt } as unknown as SignalSnapshotRecord["payload"],
    };
    const spy = vi.spyOn(repositoriesModule, "listSignalSnapshots").mockResolvedValue([snapshot]);
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/payload-ts");
    spy.mockRestore();
    expect(response).toMatchObject({ source: "snapshot", freshness: "fresh", generatedAt });
  });

  it("defaults to the current time when neither the column nor the payload carry a timestamp", async () => {
    const env = createTestEnv();
    const payload = snapshotPayload("owner/no-ts", "no ts") as Record<string, unknown>;
    delete payload.generatedAt;
    const repositoriesModule = await import("../../src/db/repositories");
    const snapshot: SignalSnapshotRecord = {
      id: "snap-no-ts",
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/no-ts",
      repoFullName: "owner/no-ts",
      generatedAt: null,
      payload: payload as unknown as SignalSnapshotRecord["payload"],
    };
    const spy = vi.spyOn(repositoriesModule, "listSignalSnapshots").mockResolvedValue([snapshot]);
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/no-ts");
    spy.mockRestore();
    expect(response).toMatchObject({ source: "snapshot", freshness: "fresh" });
    expect(typeof response?.generatedAt).toBe("string");
    expect(response?.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("treats an unparseable snapshot timestamp as stale rather than fresh", async () => {
    const env = createTestEnv();
    const repositoriesModule = await import("../../src/db/repositories");
    const snapshot: SignalSnapshotRecord = {
      id: "snap-bad-ts",
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/bad-ts",
      repoFullName: "owner/bad-ts",
      generatedAt: "not-a-real-timestamp",
      payload: snapshotPayload("owner/bad-ts", "bad ts") as unknown as SignalSnapshotRecord["payload"],
    };
    const spy = vi.spyOn(repositoriesModule, "listSignalSnapshots").mockResolvedValue([snapshot]);
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/bad-ts");
    spy.mockRestore();
    expect(response).toMatchObject({ source: "snapshot", freshness: "stale" });
  });

  it("does not call broad request-time PR listers when a cached snapshot exists", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "perf", full_name: "owner/perf", private: false, owner: { login: "owner" }, default_branch: "main" });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/perf",
      repoFullName: "owner/perf",
      payload: snapshotPayload("owner/perf", "cached fixture") as unknown as Record<string, never>,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const repositoriesModule = await import("../../src/db/repositories");
    const spies = [
      vi.spyOn(repositoriesModule, "listPullRequests"),
      vi.spyOn(repositoriesModule, "listRecentMergedPullRequests"),
      vi.spyOn(repositoriesModule, "listRepoPullRequestFiles"),
      vi.spyOn(repositoriesModule, "listRepoPullRequestReviews"),
      vi.spyOn(repositoriesModule, "listPullRequestDetailSyncStates"),
    ];
    await loadOrComputeRepoOutcomePatternsResponse(env, "owner/perf");
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("computeRepoOutcomePatterns", () => {
  it("resolves the repository itself when no repo record is supplied", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "direct", full_name: "owner/direct", private: false, owner: { login: "owner" }, default_branch: "main" });
    const patterns = await computeRepoOutcomePatterns(env, "owner/direct");
    expect(patterns.repoFullName).toBe("owner/direct");
    expect(patterns.totals.analyzed).toBe(0);
  });
});

describe("loadRepoOutcomePatternsMap", () => {
  it("bulk-loads cached snapshots for registered repos only", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "a", full_name: "owner/a", private: false, owner: { login: "owner" }, default_branch: "main" });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/a",
      repoFullName: "owner/a",
      payload: snapshotPayload("owner/a", "cached") as unknown as Record<string, never>,
      generatedAt: new Date().toISOString(),
    });
    const map = await loadRepoOutcomePatternsMap(env, [
      { fullName: "owner/a", isRegistered: true },
      { fullName: "owner/b", isRegistered: true },
      { fullName: "owner/c", isRegistered: false }, // skipped
    ]);
    expect([...map.keys()]).toEqual(["owner/a"]);
  });
});
