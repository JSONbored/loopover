import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../../src/openapi/spec";

describe("OpenAPI contract", () => {
  it("exports the modern private-beta backend contract only", () => {
    const spec = buildOpenApiSpec();
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/v1/mcp/compatibility"]).toBeDefined();
    expect(spec.paths["/v1/registry/snapshot"]).toBeDefined();
    expect(spec.paths["/v1/registry/changes"]).toBeDefined();
    expect(spec.paths["/v1/readiness"]).toBeDefined();
    expect(spec.paths["/v1/sync/status"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/intelligence"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/issue-quality"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/outcome-patterns"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/registration-readiness"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/gittensor-config-recommendation"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/pulls/{number}/maintainer-packet"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/pulls/{number}/reviewability"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/profile"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/decision-pack"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/open-pr-monitor"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/repos/{owner}/{repo}/decision"]).toBeDefined();
    expect(spec.paths["/v1/preflight/pr"]).toBeDefined();
    expect(spec.paths["/v1/preflight/local-diff"]).toBeDefined();
    expect(spec.paths["/v1/local/branch-analysis"]).toBeDefined();
    expect(spec.paths["/v1/agent/runs"]).toBeDefined();
    expect(spec.paths["/v1/agent/runs/{id}"]).toBeDefined();
    expect(spec.paths["/v1/agent/plan-next-work"]).toBeDefined();
    expect(spec.paths["/v1/agent/preflight-branch"]).toBeDefined();
    expect(spec.paths["/v1/agent/prepare-pr-packet"]).toBeDefined();
    expect(spec.paths["/v1/agent/explain-blockers"]).toBeDefined();
    expect(spec.paths["/v1/scoring/model"]).toBeDefined();
    expect(spec.paths["/v1/scoring/preview"]).toBeDefined();
    expect(spec.paths["/v1/upstream/status"]).toBeDefined();
    expect(spec.paths["/v1/upstream/ruleset"]).toBeDefined();
    expect(spec.paths["/v1/upstream/drift"]).toBeDefined();
    expect(spec.paths["/v1/bounties/{id}/advisory"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/settings-preview"]).toBeDefined();
    expect(spec.paths["/v1/app/overview"]).toBeDefined();
    expect(spec.paths["/v1/app/miner-dashboard"]).toBeDefined();
    expect(spec.paths["/v1/app/maintainer-dashboard"]).toBeDefined();
    expect(spec.paths["/v1/app/operator-dashboard"]).toBeDefined();
    expect(spec.paths["/v1/app/commands"]).toBeDefined();
    expect(spec.paths["/v1/app/commands/preview"]).toBeDefined();
    expect(spec.paths["/v1/app/commands/usefulness"]).toBeDefined();
    expect(spec.paths["/v1/app/commands/feedback"]).toBeDefined();
    expect(spec.paths["/v1/app/digest"]).toBeDefined();
    expect(spec.paths["/v1/app/digest/subscriptions"]).toBeDefined();
    expect(spec.paths["/v1/app/analytics/daily-rollups"]).toBeDefined();
    expect(spec.paths["/v1/auth/github/start"]).toBeDefined();
    expect(spec.paths["/v1/auth/github/callback"]).toBeDefined();
    expect(spec.paths["/v1/auth/extension/session"]).toBeDefined();
    expect(spec.paths["/v1/extension/pull-context"]).toBeDefined();
    expect(spec.paths["/v1/auth/github/device/start"]).toBeDefined();
    expect(spec.paths["/v1/auth/session"]).toBeDefined();
    expect(spec.paths["/v1/internal/jobs/repair-data-fidelity"]).toBeDefined();

    for (const removedPath of [
      "/v1/contributors/{login}/opportunities",
      "/v1/contributors/{login}/fit",
      "/v1/contributors/{login}/strategy",
      "/v1/contributors/{login}/reward-risk-strategy",
      "/v1/contributors/{login}/actions/recommendations",
      "/v1/contributors/{login}/outcome-history",
      "/v1/contributors/{login}/repos/{owner}/{repo}/recommendation",
      "/v1/contributors/{login}/repos/{owner}/{repo}/reward-risk",
      "/v1/repos/{owner}/{repo}/queue-health",
      "/v1/repos/{owner}/{repo}/collisions",
      "/v1/repos/{owner}/{repo}/config-quality",
      "/v1/repos/{owner}/{repo}/labels/audit",
      "/v1/repos/{owner}/{repo}/burden-forecast",
      "/v1/repos/{owner}/{repo}/registry-drift",
      "/v1/repos/{owner}/{repo}/maintainer-lane",
      "/v1/repos/{owner}/{repo}/maintainer-noise",
      "/v1/repos/{owner}/{repo}/pulls/{number}/review-intelligence",
      "/v1/repos/{owner}/{repo}/pulls/{number}/scoring-preview",
      "/v1/internal/jobs/generate-signal-snapshots/run",
    ]) {
      expect(spec.paths[removedPath]).toBeUndefined();
    }

    expect(spec.components?.schemas?.ContributorProfile).toBeDefined();
    expect(spec.components?.schemas?.McpCompatibility).toBeDefined();
    expect(spec.components?.schemas?.ContributorDecisionPack).toBeDefined();
    expect(spec.components?.schemas?.DecisionPackRefreshNeeded).toBeDefined();
    expect(spec.components?.schemas?.RepoDecisionResponse).toBeDefined();
    expect(spec.components?.schemas?.RepoIntelligence).toBeDefined();
    expect(spec.components?.schemas?.RepoOutcomePatterns).toBeDefined();
    expect(spec.components?.schemas?.RegistrationReadiness).toBeDefined();
    expect(spec.components?.schemas?.GittensorConfigRecommendation).toBeDefined();
    expect(spec.components?.schemas?.PullRequestMaintainerPacket).toBeDefined();
    expect(spec.components?.schemas?.PullRequestReviewability).toBeDefined();
    expect(spec.components?.schemas?.LocalBranchAnalysis).toBeDefined();
    expect(spec.components?.schemas?.RepoSettingsPreview).toBeDefined();
    expect(spec.components?.schemas?.CommandPreviewResponse).toBeDefined();
    expect(spec.components?.schemas?.AgentRunBundle).toBeDefined();
    expect(spec.components?.schemas?.AgentAction).toBeDefined();
    expect(spec.components?.schemas?.UpstreamStatus).toBeDefined();
    expect(spec.components?.schemas?.UpstreamRulesetSnapshot).toBeDefined();
    expect(spec.components?.schemas?.UpstreamDriftReport).toBeDefined();
    expect(JSON.stringify(spec.components?.schemas?.ScorePreviewResult)).toContain("scenarioPreviews");
    expect(JSON.stringify(spec.components?.schemas?.RepoIntelligence)).toContain("burdenForecastFreshness");
    expect(JSON.stringify(spec.components?.schemas?.CommandPreviewResponse)).toContain("missing_permission");
    expect(JSON.stringify(spec.components?.schemas?.ContributorOutcomeHistory)).toContain("reconciliation");
    expect(JSON.stringify(spec.components?.schemas?.ContributorDecisionPack)).toContain("recommendationOutcomeFeedback");
    expect(JSON.stringify(spec.components?.schemas?.LocalBranchAnalysis)).toContain("baseFreshness");
    expect(JSON.stringify(spec.components?.schemas?.LocalBranchAnalysis)).toContain("recommendedRerunCondition");
    expect(JSON.stringify(spec.components?.schemas?.Health)).toContain("minMcpVersion");
    expect(JSON.stringify(spec.components?.schemas?.Health)).toContain("latestRecommendedMcpVersion");
    expect(JSON.stringify(spec.components?.schemas?.McpCompatibility)).toContain("minimumSupportedVersion");
    expect(JSON.stringify(spec.components?.schemas?.McpCompatibility)).toContain("compatibilityWarnings");
    expect(spec.components?.securitySchemes?.GittensoryBearer).toBeDefined();
    expect(spec.components?.securitySchemes?.GittensorySessionCookie).toBeDefined();
    expect(spec.paths["/health"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/mcp/compatibility"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/auth/github/start"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/repos"]?.get?.security).toEqual([{ GittensoryBearer: [] }, { GittensorySessionCookie: [] }]);
    expect(spec.paths["/v1/app/overview"]?.get?.security).toEqual([{ GittensoryBearer: [] }, { GittensorySessionCookie: [] }]);
    expect(spec.paths["/v1/auth/session"]?.get?.security).toBeUndefined();
    expect(spec.paths["/v1/auth/logout"]?.post?.security).toBeUndefined();
    expect(spec.paths["/v1/auth/extension/session"]?.post?.security).toEqual([{ GittensoryBearer: [] }, { GittensorySessionCookie: [] }]);
  });
});
