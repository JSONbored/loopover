import { OpenApiGeneratorV3, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  AdvisorySchema,
  ActionPortfolioSchema,
  AgentActionSchema,
  AgentContextSnapshotSchema,
  AgentRunBundleSchema,
  AgentRunSchema,
  BountyAdvisorySchema,
  BountyLifecycleEventsSchema,
  BountySchema,
  BurdenForecastSchema,
  CollisionReportSchema,
  ConfigQualitySchema,
  CommandPreviewResponseSchema,
  ContributorFitSchema,
  ContributorIntakeHealthSchema,
  ContributorOutcomeHistorySchema,
  ContributorOpportunitiesResponseSchema,
  ContributorOpportunitySchema,
  ContributorPatternReportSchema,
  ContributorDecisionPackSchema,
  ContributorOpenPrMonitorSchema,
  ContributorRewardRiskStrategySchema,
  ContributorProfileSchema,
  ContributorScoringProfileSchema,
  ContributorStrategySchema,
  HealthSchema,
  InstallationHealthSchema,
  InstallationRepairSchema,
  IssueQualityReportSchema,
  IssueQualityResponseSchema,
  LabelAuditSchema,
  LaneAdviceSchema,
  LocalBranchAnalysisSchema,
  LocalDiffPreflightResultSchema,
  MaintainerPacketSchema,
  MaintainerCutReadinessSchema,
  MaintainerLaneReportSchema,
  MaintainerNoiseReportSchema,
  McpCompatibilitySchema,
  PullRequestMaintainerPacketSchema,
  PullRequestReviewIntelligenceSchema,
  PullRequestReviewabilitySchema,
  PreflightResultSchema,
  PublicRepoStatsSchema,
  PublicStatsSchema,
  QueueHealthSchema,
  ReadinessSchema,
  RegistryChangeReportSchema,
  DecisionPackRefreshNeededSchema,
  RepoFitRecommendationSchema,
  RepoDecisionResponseSchema,
  RepoOutcomePatternsSchema,
  RepoOutcomePatternsResponseSchema,
  GittensorConfigRecommendationSchema,
  RegistrationReadinessSchema,
  RepoIntelligenceSchema,
  RepoRewardRiskSchema,
  RegistrySnapshotSchema,
  GitHubRateLimitObservationSchema,
  RepoSyncSegmentSchema,
  RepoSyncStateSchema,
  RepoSettingsPreviewSchema,
  RepositorySchema,
  RepositorySettingsSchema,
  RoleContextSchema,
  RewardRiskActionSchema,
  ScorePreviewSchema,
  ScoringModelSnapshotSchema,
  SignalFidelitySchema,
  SkippedPrAuditExportSchema,
  SyncStatusSchema,
  UpstreamDriftReportSchema,
  UpstreamRulesetSnapshotSchema,
  UpstreamStatusSchema,
  WorkboardItemSchema,
} from "./schemas";

export function buildOpenApiSpec() {
  const registry = new OpenAPIRegistry();
  registry.register("Health", HealthSchema);
  registry.register("McpCompatibility", McpCompatibilitySchema);
  registry.register("RegistrySnapshot", RegistrySnapshotSchema);
  registry.register("Repository", RepositorySchema);
  registry.register("PublicRepoStats", PublicRepoStatsSchema);
  registry.register("PublicStats", PublicStatsSchema);
  registry.register("Advisory", AdvisorySchema);
  registry.register("ActionPortfolio", ActionPortfolioSchema);
  registry.register("WorkboardItem", WorkboardItemSchema);
  registry.register("QueueHealth", QueueHealthSchema);
  registry.register("CollisionReport", CollisionReportSchema);
  registry.register("ConfigQuality", ConfigQualitySchema);
  registry.register("LabelAudit", LabelAuditSchema);
  registry.register("ContributorProfile", ContributorProfileSchema);
  registry.register("ContributorOpportunity", ContributorOpportunitySchema);
  registry.register("ContributorOpportunitiesResponse", ContributorOpportunitiesResponseSchema);
  registry.register("ContributorFit", ContributorFitSchema);
  registry.register("RoleContext", RoleContextSchema);
  registry.register("ContributorOutcomeHistory", ContributorOutcomeHistorySchema);
  registry.register("ContributorPatternReport", ContributorPatternReportSchema);
  registry.register("ContributorDecisionPack", ContributorDecisionPackSchema);
  registry.register("DecisionPackRefreshNeeded", DecisionPackRefreshNeededSchema);
  registry.register("RepoDecisionResponse", RepoDecisionResponseSchema);
  registry.register("RepoIntelligence", RepoIntelligenceSchema);
  registry.register("RepoOutcomePatterns", RepoOutcomePatternsSchema);
  registry.register("RepoOutcomePatternsResponse", RepoOutcomePatternsResponseSchema);
  registry.register("RegistrationReadiness", RegistrationReadinessSchema);
  registry.register("GittensorConfigRecommendation", GittensorConfigRecommendationSchema);
  registry.register("RepoFitRecommendation", RepoFitRecommendationSchema);
  registry.register("PreflightResult", PreflightResultSchema);
  registry.register("LocalDiffPreflightResult", LocalDiffPreflightResultSchema);
  registry.register("LocalBranchAnalysis", LocalBranchAnalysisSchema);
  registry.register("MaintainerPacket", MaintainerPacketSchema);
  registry.register("MaintainerLaneReport", MaintainerLaneReportSchema);
  registry.register("MaintainerCutReadiness", MaintainerCutReadinessSchema);
  registry.register("ContributorIntakeHealth", ContributorIntakeHealthSchema);
  registry.register("PullRequestMaintainerPacket", PullRequestMaintainerPacketSchema);
  registry.register("PullRequestReviewIntelligence", PullRequestReviewIntelligenceSchema);
  registry.register("Bounty", BountySchema);
  registry.register("BountyAdvisory", BountyAdvisorySchema);
  registry.register("BountyLifecycleEvents", BountyLifecycleEventsSchema);
  registry.register("RepositorySettings", RepositorySettingsSchema);
  registry.register("InstallationRepair", InstallationRepairSchema);
  registry.register("RepoSettingsPreview", RepoSettingsPreviewSchema);
  registry.register("SkippedPrAuditExport", SkippedPrAuditExportSchema);
  registry.register("CommandPreviewResponse", CommandPreviewResponseSchema);
  registry.register("AgentRun", AgentRunSchema);
  registry.register("AgentAction", AgentActionSchema);
  registry.register("AgentContextSnapshot", AgentContextSnapshotSchema);
  registry.register("AgentRunBundle", AgentRunBundleSchema);
  registry.register("RepoSyncState", RepoSyncStateSchema);
  registry.register("RepoSyncSegment", RepoSyncSegmentSchema);
  registry.register("GitHubRateLimitObservation", GitHubRateLimitObservationSchema);
  registry.register("SignalFidelity", SignalFidelitySchema);
  registry.register("InstallationHealth", InstallationHealthSchema);
  registry.register("SyncStatus", SyncStatusSchema);
  registry.register("Readiness", ReadinessSchema);
  registry.register("UpstreamStatus", UpstreamStatusSchema);
  registry.register("UpstreamRulesetSnapshot", UpstreamRulesetSnapshotSchema);
  registry.register("UpstreamDriftReport", UpstreamDriftReportSchema);
  registry.register("RegistryChangeReport", RegistryChangeReportSchema);
  registry.register("LaneAdvice", LaneAdviceSchema);
  registry.register("ScoringModelSnapshot", ScoringModelSnapshotSchema);
  registry.register("ScorePreview", ScorePreviewSchema);
  registry.register("IssueQualityReport", IssueQualityReportSchema);
  registry.register("IssueQualityResponse", IssueQualityResponseSchema);
  registry.register("BurdenForecast", BurdenForecastSchema);
  registry.register("ContributorScoringProfile", ContributorScoringProfileSchema);
  registry.register("ContributorStrategy", ContributorStrategySchema);
  registry.register("RewardRiskAction", RewardRiskActionSchema);
  registry.register("RepoRewardRisk", RepoRewardRiskSchema);
  registry.register("ContributorRewardRiskStrategy", ContributorRewardRiskStrategySchema);
  registry.register("MaintainerNoiseReport", MaintainerNoiseReportSchema);
  registry.register("PullRequestReviewability", PullRequestReviewabilitySchema);

  registry.registerPath({
    method: "get",
    path: "/health",
    responses: {
      200: { description: "Service health", content: { "application/json": { schema: HealthSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/mcp/compatibility",
    responses: {
      200: { description: "Public-safe API and MCP compatibility metadata", content: { "application/json": { schema: McpCompatibilitySchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/stats",
    responses: {
      200: { description: "Public-safe homepage stats: lifetime PRs handled/merged/closed, gate + slop blocks, and reversal-grounded accuracy. Aggregate counts only.", content: { "application/json": { schema: PublicStatsSchema } } },
      404: { description: "Public stats are disabled (GITTENSORY_PUBLIC_STATS off)" },
      503: { description: "Public stats are temporarily unavailable" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/github/repos/{owner}/{repo}/stats",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Public GitHub repository stars/forks for the website chrome; only JSONbored/gittensory is accepted.", content: { "application/json": { schema: PublicRepoStatsSchema } } },
      400: { description: "Invalid or non-allowlisted GitHub repository" },
      503: { description: "GitHub repository stats are unavailable" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/registry/snapshot",
    responses: {
      200: { description: "Latest Gittensor registry snapshot", content: { "application/json": { schema: RegistrySnapshotSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/registry/changes",
    responses: {
      200: { description: "Diff between latest registry snapshots", content: { "application/json": { schema: RegistryChangeReportSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/scoring/model",
    responses: {
      200: { description: "Latest private scoring model snapshot", content: { "application/json": { schema: ScoringModelSnapshotSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/upstream/status",
    responses: {
      200: { description: "Upstream Gittensor source/ruleset drift status", content: { "application/json": { schema: UpstreamStatusSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/upstream/ruleset",
    responses: {
      200: { description: "Latest normalized upstream Gittensor ruleset snapshot", content: { "application/json": { schema: UpstreamRulesetSnapshotSchema } } },
      404: { description: "No upstream ruleset snapshot has been built yet" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/upstream/drift",
    responses: {
      200: {
        description: "Open and historical upstream drift reports",
        content: {
          "application/json": {
            schema: z.object({
              generatedAt: z.string(),
              upstreamDrift: UpstreamStatusSchema,
              reports: z.array(UpstreamDriftReportSchema),
            }),
          },
        },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/scoring/preview",
    responses: {
      200: { description: "Private scoring preview artifact", content: { "application/json": { schema: ScorePreviewSchema } } },
      400: { description: "Invalid scoring preview input" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/sync/status",
    responses: {
      200: { description: "Repository and installation sync status", content: { "application/json": { schema: SyncStatusSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/readiness",
    responses: {
      200: { description: "Operational readiness summary for hosted API, signal fidelity, and public-review preparation", content: { "application/json": { schema: ReadinessSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/installations",
    responses: {
      200: {
        description: "GitHub App installations and health",
        content: {
          "application/json": {
            schema: z.object({
              installations: z.array(z.record(z.string(), z.unknown())),
              health: z.array(InstallationHealthSchema),
            }),
          },
        },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/installations/{id}/health",
    responses: {
      200: { description: "GitHub App installation health", content: { "application/json": { schema: InstallationHealthSchema } } },
      404: { description: "Installation health not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/installations/{id}/repair",
    responses: {
      200: { description: "GitHub App installation repair diagnostics", content: { "application/json": { schema: InstallationRepairSchema } } },
      404: { description: "Installation health not found" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/installations/{id}/repair/refresh",
    responses: {
      200: { description: "Refreshed GitHub App installation repair diagnostics", content: { "application/json": { schema: InstallationRepairSchema } } },
      404: { description: "Installation not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/notification-model",
    responses: {
      200: {
        description: "Opt-in notification model and PWA-readiness metadata for control-panel routes",
        content: {
          "application/json": {
            schema: z.object({
              generatedAt: z.string(),
              notificationModel: z.object({
                mode: z.literal("opt_in"),
                defaultState: z.literal("disabled"),
                channels: z.array(
                  z.object({
                    id: z.string(),
                    transport: z.enum(["in_app", "web_push"]),
                    defaultEnabled: z.boolean(),
                    requiresPermission: z.boolean().optional(),
                    purpose: z.string(),
                  }),
                ),
                privacyGuards: z.array(z.string()),
                fallbackWhenUnavailable: z.literal("in_app_digest_only"),
              }),
              pwa: z.object({
                nativeDependency: z.boolean(),
                manifestPath: z.string(),
                serviceWorkerPath: z.string(),
              }),
              mobileReadyRoutes: z.array(z.string()),
              nativeMobileFuture: z.array(z.string()),
            }),
          },
        },
      },
      403: { description: "Role does not allow control-panel notification model access" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos",
    responses: {
      200: { description: "Known repositories", content: { "application/json": { schema: RepositorySchema.array() } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}",
    responses: {
      200: { description: "Repository detail", content: { "application/json": { schema: RepositorySchema } } },
      404: { description: "Repository not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/intelligence",
    responses: {
      200: { description: "Canonical repository intelligence bundle", content: { "application/json": { schema: RepoIntelligenceSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/issue-quality",
    responses: {
      200: { description: "Cached or computed issue quality report for the repo", content: { "application/json": { schema: IssueQualityResponseSchema } } },
      404: { description: "Repo is unknown or has no issue-quality coverage yet" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/outcome-patterns",
    responses: {
      200: { description: "Cached or freshly-computed per-repo accepted/rejected PR outcome patterns with freshness envelope and explicit evidence-completeness", content: { "application/json": { schema: RepoOutcomePatternsResponseSchema } } },
      404: { description: "Repo is unknown or has no outcome-pattern coverage yet" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/registration-readiness",
    responses: {
      200: { description: "Gittensor registration readiness signal for repo owners", content: { "application/json": { schema: RegistrationReadinessSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/gittensor-config-recommendation",
    responses: {
      200: { description: "Private Gittensor config recommendation for repo owners", content: { "application/json": { schema: GittensorConfigRecommendationSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/focus-manifest",
    responses: {
      200: { description: "Repo focus manifest and compiled policy for maintainers", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/focus-manifest/refresh",
    responses: {
      200: { description: "Refresh the persisted focus manifest cache from the repo file", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/repos/{owner}/{repo}/focus-manifest",
    responses: {
      200: { description: "Persist API-backed focus manifest for a repo", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Malformed JSON request body" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/agent/audit-feed",
    responses: {
      200: {
        description: "Maintainer-scoped agent audit feed (#784): executed actions + approval-queue decisions, newest first, public-safe action posture only. Supports ?since=ISO-8601&limit=1-200.",
        content: {
          "application/json": {
            schema: z.object({
              repoFullName: z.string(),
              events: z.array(
                z.object({
                  eventType: z.string(),
                  pullNumber: z.number().nullable(),
                  outcome: z.string(),
                  actor: z.string().nullable(),
                  detail: z.string().nullable(),
                  createdAt: z.string(),
                }),
              ),
            }),
          },
        },
      },
      400: { description: "Malformed since (not ISO-8601) or limit (not an integer in 1-200)" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/self-dogfood/registration-pack",
    responses: {
      200: { description: "Private self-dogfood registration pack for the Gittensory repo", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role for maintainer-only self-dogfood report" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/self-dogfood-registration-pack",
    responses: {
      200: { description: "Private self-dogfood registration pack when repo matches configured Gittensory target", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role or repo is not the configured self-dogfood target" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/onboarding-pack/preview",
    responses: {
      200: { description: "Preview-only repo onboarding pack for accepted repositories", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role" },
      404: { description: "Repository is not accepted or preview unavailable" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/contributor-issue-drafts/generate",
    responses: {
      200: { description: "Generate maintainer-reviewed contributor issue drafts from repo policy (dry-run by default)", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Invalid request or explicit create without dryRun false" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/settings",
    responses: {
      200: { description: "Gittensory repository automation settings", content: { "application/json": { schema: RepositorySettingsSchema } } },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/settings-preview",
    responses: {
      200: { description: "Maintainer dry-run preview of the public surface decision for a sample PR (no GitHub mutation)", content: { "application/json": { schema: RepoSettingsPreviewSchema } } },
      400: { description: "Invalid settings preview request" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/pulls/{number}/maintainer-packet",
    responses: {
      200: { description: "PR-specific maintainer review packet", content: { "application/json": { schema: PullRequestMaintainerPacketSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/pulls/{number}/reviewability",
    responses: {
      200: { description: "Private PR reviewability score and maintainer action", content: { "application/json": { schema: PullRequestReviewabilitySchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/profile",
    responses: {
      200: { description: "Contributor evidence profile", content: { "application/json": { schema: ContributorProfileSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/decision-pack",
    responses: {
      200: {
        description: "Canonical private contributor decision pack. May carry freshness 'stale' or 'rebuilding' when a background rebuild is in progress.",
        content: { "application/json": { schema: ContributorDecisionPackSchema } },
      },
      202: { description: "Decision pack snapshot is missing; a background rebuild has been requested", content: { "application/json": { schema: DecisionPackRefreshNeededSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/open-pr-monitor",
    responses: {
      200: {
        description: "Contributor open-PR monitor with classifications and public-safe next-step packets from cached metadata.",
        content: { "application/json": { schema: ContributorOpenPrMonitorSchema } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/repos/{owner}/{repo}/decision",
    responses: {
      200: { description: "Repo-specific contributor decision from decision pack. May carry freshness 'stale' or 'rebuilding'.", content: { "application/json": { schema: RepoDecisionResponseSchema } } },
      202: { description: "Decision pack snapshot is missing; a background rebuild has been requested", content: { "application/json": { schema: DecisionPackRefreshNeededSchema } } },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/preflight/pr",
    responses: {
      200: { description: "Submission preflight result", content: { "application/json": { schema: PreflightResultSchema } } },
      400: { description: "Invalid preflight input" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/preflight/local-diff",
    responses: {
      200: { description: "Local diff preflight result", content: { "application/json": { schema: LocalDiffPreflightResultSchema } } },
      400: { description: "Invalid local diff preflight input" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/local/branch-analysis",
    responses: {
      200: { description: "Private local branch analysis for MCP clients", content: { "application/json": { schema: LocalBranchAnalysisSchema } } },
      400: { description: "Invalid local branch analysis input" },
      401: { description: "Unauthorized" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/agent/runs",
    responses: {
      202: { description: "Copilot-only agent run queued", content: { "application/json": { schema: AgentRunBundleSchema } } },
      400: { description: "Invalid agent run request" },
      401: { description: "Unauthorized" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/agent/runs",
    request: {
      query: z.object({
        actorLogin: z.string().min(1).openapi({
          param: { description: "GitHub login that owns the agent runs." },
          example: "jsonbored",
        }),
        limit: z
          .string()
          .optional()
          .openapi({
            param: { description: "Maximum run bundles to return, clamped from 1 to 100." },
            example: "50",
          }),
      }),
    },
    responses: {
      200: {
        description: "Recent agent run bundles for an authenticated actor",
        content: {
          "application/json": {
            schema: z.object({ runs: z.array(AgentRunBundleSchema) }),
          },
        },
      },
      400: { description: "Missing actor login" },
      401: { description: "Unauthorized" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/agent/runs/{id}",
    responses: {
      200: { description: "Persisted agent run bundle", content: { "application/json": { schema: AgentRunBundleSchema } } },
      404: { description: "Agent run not found" },
    },
  });
  for (const path of ["/v1/agent/plan-next-work", "/v1/agent/preflight-branch", "/v1/agent/prepare-pr-packet", "/v1/agent/explain-blockers"]) {
    registry.registerPath({
      method: "post",
      path,
      responses: {
        200: { description: "Agent run completed with deterministic ranked actions", content: { "application/json": { schema: AgentRunBundleSchema } } },
        202: { description: "Agent run needs snapshot refresh", content: { "application/json": { schema: AgentRunBundleSchema } } },
        400: { description: "Invalid agent request" },
        401: { description: "Unauthorized" },
      },
    });
  }
  registry.registerPath({
    method: "get",
    path: "/v1/bounties",
    responses: {
      200: { description: "Known bounty records", content: { "application/json": { schema: BountySchema.array() } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/bounties/{id}/advisory",
    responses: {
      200: { description: "Bounty lifecycle advisory", content: { "application/json": { schema: BountyAdvisorySchema } } },
      404: { description: "Bounty not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/bounties/{id}/lifecycle",
    responses: {
      200: { description: "Bounty lifecycle transition history", content: { "application/json": { schema: BountyLifecycleEventsSchema } } },
      404: { description: "Bounty not found" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/github/webhook",
    responses: {
      202: { description: "Webhook queued" },
      401: { description: "Invalid webhook signature" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/orb/ingest",
    responses: {
      200: { description: "Batch accepted; returns { accepted: number }" },
      400: { description: "Malformed JSON or invalid payload shape" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/auth/github/start",
    responses: {
      302: { description: "Redirects to GitHub web OAuth" },
      503: { description: "GitHub OAuth app secret is not configured" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/auth/github/callback",
    responses: {
      302: { description: "Completes GitHub web OAuth and redirects to the app" },
    },
  });
  for (const path of ["/v1/auth/github/device/start", "/v1/auth/github/device/poll", "/v1/auth/github/session", "/v1/auth/logout", "/v1/auth/extension/session"]) {
    registry.registerPath({
      method: "post",
      path,
      responses: {
        200: { description: "Auth request completed" },
        201: { description: "Auth session created" },
        400: { description: "Invalid auth request" },
        401: { description: "Unauthorized" },
        429: { description: "Rate limited" },
      },
    });
  }
  registry.registerPath({
    method: "get",
    path: "/v1/auth/session",
    responses: {
      200: { description: "Current auth session, or signed_out when no app session is present" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/overview",
    responses: {
      200: { description: "Live app overview assembled from backend data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      401: { description: "Unauthorized" },
    },
  });
  for (const path of [
    "/v1/app/roles",
    "/v1/app/miner-dashboard",
    "/v1/app/maintainer-dashboard",
    "/v1/app/operator-dashboard",
    "/v1/app/commands",
    "/v1/app/commands/usefulness",
    "/v1/app/digest",
    "/v1/app/analytics/daily-rollups",
    "/v1/app/analytics/mcp-compatibility",
  ]) {
    registry.registerPath({
      method: "get",
      path,
      responses: {
        200: { description: "Live app API response", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
        401: { description: "Unauthorized" },
      },
    });
  }
  registry.registerPath({
    method: "get",
    path: "/v1/app/selfhost/queue/dead",
    request: {
      query: z.object({
        limit: z.string().optional().openapi({
          param: { description: "Maximum rows to return, clamped from 1 to 100." },
          example: "25",
        }),
        offset: z.string().optional().openapi({
          param: { description: "Pagination offset, floored to 0." },
          example: "0",
        }),
      }),
    },
    responses: {
      200: { description: "Paginated dead-letter jobs for the self-host queue backend", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Invalid query" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role (operator only)" },
      501: { description: "This deployment's queue backend does not expose dead-letter admin (e.g. Cloudflare)" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/analytics/weekly-value-report",
    request: {
      query: z.object({
        variant: z.enum(["public", "operator"]).optional().openapi({
          param: {
            description: "Report variant. Operator reports require the operator app role.",
          },
          example: "public",
        }),
        days: z.string().optional().openapi({
          param: { description: "Report window in days, clamped from 1 to 31." },
          example: "7",
        }),
        format: z.enum(["json", "markdown"]).optional().openapi({
          param: {
            description: "Response format. Omit or use json for the structured report; use markdown for copy-ready text.",
          },
          example: "markdown",
        }),
      }),
    },
    responses: {
      200: {
        description: "Weekly value report as structured JSON or copy-ready Markdown",
        content: {
          "application/json": { schema: z.record(z.string(), z.unknown()) },
          "text/markdown": {
            schema: z.string().openapi({
              example: "# Weekly Gittensory value report\n\n## Adoption metrics\n- Active users: 4\n",
            }),
          },
        },
      },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role for requested report variant" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/skipped-pr-audit",
    request: {
      query: z.object({
        limit: z.string().optional().openapi({
          param: { description: "Maximum rows to return, clamped from 1 to 100." },
          example: "50",
        }),
        repoFullName: z.string().optional().openapi({
          param: { description: "Optional repository filter. Browser sessions must have control-panel access to this repo." },
          example: "JSONbored/gittensory",
        }),
        reason: z.enum(["surface_off", "missing_author", "bot_author", "maintainer_author", "miner_detection_unavailable", "not_official_gittensor_miner"]).optional().openapi({
          param: { description: "Optional PR skip reason filter." },
          example: "not_official_gittensor_miner",
        }),
        since: z.string().optional().openapi({
          param: { description: "Optional lower timestamp bound." },
          example: "2026-05-30T00:00:00.000Z",
        }),
      }),
    },
    responses: {
      200: { description: "Private bounded audit export for skipped PR public-surface decisions", content: { "application/json": { schema: SkippedPrAuditExportSchema } } },
      400: { description: "Invalid query" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role or repository scope" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/app/commands/preview",
    responses: {
      200: { description: "Maintainer dry-run preview of a sanitized @gittensory command response (no GitHub mutation)", content: { "application/json": { schema: CommandPreviewResponseSchema } } },
      400: { description: "Invalid request" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role" },
      404: { description: "Command not found" },
    },
  });
  for (const path of ["/v1/app/commands/feedback", "/v1/app/digest/subscriptions"]) {
    registry.registerPath({
      method: "post",
      path,
      responses: {
        200: { description: "Live app mutation or preview response", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
        201: { description: "Created", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
        400: { description: "Invalid request" },
        401: { description: "Unauthorized" },
      },
    });
  }
  registry.registerPath({
    method: "get",
    path: "/v1/extension/pull-context",
    request: {
      query: z.object({
        owner: z.string().min(1).openapi({ param: { description: "Repository owner" }, example: "JSONbored" }),
        repo: z.string().min(1).openapi({ param: { description: "Repository name" }, example: "gittensory" }),
        pullNumber: z.string().min(1).openapi({ param: { description: "Pull request number" }, example: "120" }),
      }),
    },
    responses: {
      200: { description: "Browser extension PR context overlay payload", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Invalid pull context query" },
      401: { description: "Unauthorized" },
      403: { description: "Extension-scoped session required" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/refresh-registry",
    responses: {
      202: { description: "Registry refresh queued" },
      401: { description: "Invalid internal token" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/backfill-registered-repos",
    responses: {
      202: { description: "Registered repo backfill queued" },
      401: { description: "Invalid internal token" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/backfill-repo-segment",
    responses: {
      202: { description: "Repository segment backfill queued" },
      400: { description: "Invalid segment request" },
      401: { description: "Invalid internal token" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/backfill-pr-details",
    responses: {
      202: { description: "Open PR detail backfill queued" },
      400: { description: "Invalid PR detail backfill request" },
      401: { description: "Invalid internal token" },
    },
  });
  for (const path of [
    "/v1/internal/jobs/refresh-scoring-model",
    "/v1/internal/jobs/refresh-upstream-drift",
    "/v1/internal/jobs/file-upstream-drift-issues",
    "/v1/internal/jobs/build-contributor-evidence",
    "/v1/internal/jobs/build-contributor-decision-packs",
    "/v1/internal/jobs/build-burden-forecasts",
    "/v1/internal/jobs/generate-signal-snapshots",
    "/v1/internal/jobs/generate-weekly-value-report",
    "/v1/internal/jobs/repair-data-fidelity",
  ]) {
    registry.registerPath({
      method: "post",
      path,
      responses: {
        202: { description: "Internal job queued" },
        401: { description: "Invalid internal token" },
      },
    });
  }
  registry.registerPath({
    method: "post",
    path: "/v1/internal/bounties/import",
    responses: {
      200: { description: "Bounty snapshot imported" },
      401: { description: "Invalid internal token" },
    },
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Gittensory API",
      version: "0.1.0",
      description: "Backend API for Gittensory advisory checks and Gittensor repository context.",
    },
  });
  return applySecurityMetadata(document);
}

type GeneratedOpenApiDocument = ReturnType<OpenApiGeneratorV3["generateDocument"]>;
type GeneratedOperation = NonNullable<GeneratedOpenApiDocument["paths"][string]>[keyof NonNullable<GeneratedOpenApiDocument["paths"][string]>] & {
  security?: Array<Record<string, string[]>>;
};

function applySecurityMetadata(document: GeneratedOpenApiDocument): GeneratedOpenApiDocument {
  document.components = {
    ...(document.components ?? {}),
    securitySchemes: {
      ...(document.components?.securitySchemes ?? {}),
      GittensoryBearer: {
        type: "http",
        scheme: "bearer",
        description: "Static API/MCP token, GitHub device-flow Gittensory session token, or extension-scoped Gittensory session token where supported. GitHub personal access tokens are not accepted.",
      },
      GittensorySessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "gittensory_session",
        description: "HttpOnly browser session cookie set by GitHub web OAuth.",
      },
    },
  };
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || !isProtectedPath(path)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = pathItem[method] as GeneratedOperation | undefined;
      if (operation) operation.security = [{ GittensoryBearer: [] }, { GittensorySessionCookie: [] }];
    }
  }
  return document;
}

function isProtectedPath(path: string): boolean {
  if (path === "/health" || path === "/openapi.json" || path === "/mcp" || path === "/v1/mcp/compatibility" || path === "/v1/public/stats" || path === "/v1/public/github/repos/{owner}/{repo}/stats") return false;
  if (path.startsWith("/v1/auth/")) return path === "/v1/auth/extension/session";
  if (path === "/v1/github/webhook") return false;
  return path.startsWith("/v1/");
}
