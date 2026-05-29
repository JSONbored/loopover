import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../../src/openapi/spec";

describe("OpenAPI contract", () => {
  it("exports the modern private-beta backend contract only", () => {
    const spec = buildOpenApiSpec();
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/v1/registry/snapshot"]).toBeDefined();
    expect(spec.paths["/v1/registry/changes"]).toBeDefined();
    expect(spec.paths["/v1/readiness"]).toBeDefined();
    expect(spec.paths["/v1/sync/status"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/intelligence"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/issue-quality"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/registration-readiness"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/gittensor-config-recommendation"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/pulls/{number}/maintainer-packet"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/pulls/{number}/reviewability"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/profile"]).toBeDefined();
    expect(spec.paths["/v1/contributors/{login}/decision-pack"]).toBeDefined();
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
    expect(spec.paths["/v1/bounties/{id}/advisory"]).toBeDefined();
    expect(spec.paths["/v1/repos/{owner}/{repo}/settings-preview"]).toBeDefined();
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
    expect(spec.components?.schemas?.ContributorDecisionPack).toBeDefined();
    expect(spec.components?.schemas?.DecisionPackRefreshNeeded).toBeDefined();
    expect(spec.components?.schemas?.RepoDecisionResponse).toBeDefined();
    expect(spec.components?.schemas?.RepoIntelligence).toBeDefined();
    expect(spec.components?.schemas?.RegistrationReadiness).toBeDefined();
    expect(spec.components?.schemas?.GittensorConfigRecommendation).toBeDefined();
    expect(spec.components?.schemas?.PullRequestMaintainerPacket).toBeDefined();
    expect(spec.components?.schemas?.PullRequestReviewability).toBeDefined();
    expect(spec.components?.schemas?.LocalBranchAnalysis).toBeDefined();
    expect(spec.components?.schemas?.RepoSettingsPreview).toBeDefined();
    expect(spec.components?.schemas?.AgentRunBundle).toBeDefined();
    expect(spec.components?.schemas?.AgentAction).toBeDefined();
    expect(JSON.stringify(spec.components?.schemas?.ScorePreviewResult)).toContain("scenarioPreviews");
    expect(JSON.stringify(spec.components?.schemas?.LocalBranchAnalysis)).toContain("baseFreshness");
    expect(JSON.stringify(spec.components?.schemas?.LocalBranchAnalysis)).toContain("recommendedRerunCondition");
  });
});
