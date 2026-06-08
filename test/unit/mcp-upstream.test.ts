import { describe, expect, it, vi } from "vitest";
import { authenticatePrivateToken, createSessionForGitHubUser } from "../../src/auth/security";
import { persistUpstreamRulesetSnapshot, upsertUpstreamDriftReport } from "../../src/db/repositories";
import { GittensoryMcp } from "../../src/mcp/server";
import type { UpstreamDriftReportRecord, UpstreamRulesetSnapshotRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("MCP contributor access", () => {
  it("blocks session actors from another contributor open-pr monitor", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "attacker" });
    const { token } = await createSessionForGitHubUser(env, { login: "attacker", id: 7 });
    const identity = await authenticatePrivateToken(env, token);
    if (!identity || identity.kind !== "session") throw new Error("expected session identity");
    const mcp = new GittensoryMcp(env, identity);
    await expect((mcp as unknown as { monitorOpenPullRequests(login: string): Promise<unknown> }).monitorOpenPullRequests("victim")).rejects.toThrow(
      /Forbidden: session can only access the authenticated GitHub login/,
    );
  });

  it("returns a monitor payload for the authenticated contributor", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "monitor-user" });
    const { token } = await createSessionForGitHubUser(env, { login: "monitor-user", id: 8 });
    const identity = await authenticatePrivateToken(env, token);
    if (!identity || identity.kind !== "session") throw new Error("expected session identity");
    const mcp = new GittensoryMcp(env, identity);
    const result = await (mcp as unknown as { monitorOpenPullRequests(login: string): Promise<{ summary: string; data: Record<string, unknown> }> }).monitorOpenPullRequests("monitor-user");
    expect(typeof result.summary).toBe("string");
    expect(result.data).toBeDefined();
  });
});

describe("MCP upstream drift tool", () => {
  it("summarizes current, drifted, stale, and unavailable upstream states", async () => {
    const currentEnv = createTestEnv();
    await persistUpstreamRulesetSnapshot(currentEnv, ruleset("current", new Date().toISOString()));
    await expect(getUpstreamDriftSummary(currentEnv)).resolves.toContain("upstream ruleset is current");

    const driftEnv = createTestEnv();
    await persistUpstreamRulesetSnapshot(driftEnv, ruleset("drift", new Date().toISOString()));
    await upsertUpstreamDriftReport(driftEnv, report("drift-report"));
    await expect(getUpstreamDriftSummary(driftEnv)).resolves.toContain("upstream drift detected (high)");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-30T04:00:00.000Z"));
    const staleEnv = createTestEnv();
    await persistUpstreamRulesetSnapshot(staleEnv, ruleset("stale", "2026-05-30T00:00:00.000Z"));
    await expect(getUpstreamDriftSummary(staleEnv)).resolves.toContain("upstream ruleset snapshot is stale");
    vi.useRealTimers();

    await expect(getUpstreamDriftSummary(createTestEnv())).resolves.toContain("upstream ruleset snapshot is unavailable");
  });
});

async function getUpstreamDriftSummary(env: Env): Promise<string> {
  const payload = await (new GittensoryMcp(env) as unknown as { getUpstreamDrift(): Promise<{ summary: string }> }).getUpstreamDrift();
  return payload.summary;
}

function ruleset(id: string, generatedAt: string): UpstreamRulesetSnapshotRecord {
  return {
    id,
    sourceRepo: "entrius/gittensor",
    sourceRef: "test",
    commitSha: `${id}-commit`,
    sourceSnapshotIds: [],
    activeModel: "pending_saturation_model",
    registryRepoCount: 1,
    totalEmissionShare: 0.01,
    semanticHash: `${id}-hash`,
    payload: {
      registry: { repoCount: 1, totalEmissionShare: 0.01, repositories: [] },
      scoring: { activeModel: "pending_saturation_model", constants: {}, semanticFlags: {} },
      issueDiscovery: { branchEligibilityRequired: false },
      mirrorLinkage: { solvedByPrRequired: false },
      languageWeights: { count: 0, weights: {} },
      sourceSnapshots: [],
    },
    warnings: [],
    generatedAt,
  };
}

function report(id: string): UpstreamDriftReportRecord {
  return {
    id,
    fingerprint: id,
    severity: "high",
    status: "open",
    summary: "scoring constants changed",
    affectedAreas: ["scoring_model"],
    previousRulesetId: "previous",
    currentRulesetId: "current",
    payload: {},
    generatedAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
  };
}
