import { describe, expect, it } from "vitest";
import { persistSignalSnapshot, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { loadIssueQualityReportMap, loadOrComputeIssueQualityResponse } from "../../src/services/issue-quality";
import { createTestEnv } from "../helpers/d1";

describe("issue-quality service", () => {
  it("loads only registered repos with cached issue-quality snapshots", async () => {
    const env = createTestEnv();
    await persistSignalSnapshot(env, {
      id: "quality-cached",
      signalType: "issue-quality",
      targetKey: "owner/cached",
      repoFullName: "owner/cached",
      generatedAt: "2026-05-30T00:00:00.000Z",
      payload: {
        repoFullName: "owner/cached",
        generatedAt: "2026-05-30T00:00:00.000Z",
        lane: { lane: "direct_pr" },
        issues: [],
        summary: "cached",
      },
    });

    const map = await loadIssueQualityReportMap(env, [
      { fullName: "owner/cached", isRegistered: true },
      { fullName: "owner/missing", isRegistered: true },
      { fullName: "owner/unregistered", isRegistered: false },
    ]);

    expect([...map.keys()]).toEqual(["owner/cached"]);
  });

  it("returns cached, computed, or missing issue-quality responses deterministically", async () => {
    const env = createTestEnv();
    await persistSignalSnapshot(env, {
      id: "quality-response",
      signalType: "issue-quality",
      targetKey: "owner/cached",
      repoFullName: "owner/cached",
      generatedAt: "2026-05-30T00:00:00.000Z",
      payload: {
        repoFullName: "owner/cached",
        generatedAt: "2026-05-30T00:00:00.000Z",
        lane: { lane: "direct_pr" },
        issues: [],
        summary: "cached",
      },
    });
    await upsertRepositoryFromGitHub(env, {
      name: "computed",
      full_name: "owner/computed",
      private: false,
      owner: { login: "owner" },
      default_branch: "main",
    });

    await expect(loadOrComputeIssueQualityResponse(env, "owner/cached")).resolves.toMatchObject({ source: "snapshot", generatedAt: "2026-05-30T00:00:00.000Z" });
    await expect(loadOrComputeIssueQualityResponse(env, "owner/computed")).resolves.toMatchObject({ source: "computed", repoFullName: "owner/computed" });
    await expect(loadOrComputeIssueQualityResponse(env, "owner/missing")).resolves.toBeNull();
  });
});
