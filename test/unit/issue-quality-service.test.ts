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

  it("falls back to payload or current timestamps for sparse cached snapshots", async () => {
    const payloadGenerated = "2026-05-29T00:00:00.000Z";
    const env = createTestEnv();
    await env.DB.prepare(
      `insert into signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at)
       values ('quality-payload-generated', 'issue-quality', 'owner/payload', 'owner/payload', ?, '')`,
    )
      .bind(JSON.stringify({ repoFullName: "owner/payload", generatedAt: payloadGenerated, lane: { lane: "direct_pr" }, issues: [], summary: "payload" }))
      .run();
    await env.DB.prepare(
      `insert into signal_snapshots (id, signal_type, target_key, repo_full_name, payload_json, generated_at)
       values ('quality-current-generated', 'issue-quality', 'owner/current', 'owner/current', ?, '')`,
    )
      .bind(JSON.stringify({ repoFullName: "owner/current", lane: { lane: "direct_pr" }, issues: [], summary: "current" }))
      .run();

    await expect(loadOrComputeIssueQualityResponse(env, "owner/payload")).resolves.toMatchObject({ source: "snapshot", generatedAt: payloadGenerated });
    const current = await loadOrComputeIssueQualityResponse(env, "owner/current");
    expect(current?.source).toBe("snapshot");
    expect(Date.parse(current?.generatedAt ?? "")).not.toBeNaN();
  });
});
