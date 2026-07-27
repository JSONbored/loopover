import { OpenApiGeneratorV3, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  AdvisorySchema,
  EnrichmentAnalyzersTaxonomyDocumentSchema,
  FindingTaxonomyDocumentSchema,
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
  ContributorPrOutcomesSchema,
  NotificationFeedSchema,
  NotificationsMarkedSchema,
  ContributorRewardRiskStrategySchema,
  ContributorProfileSchema,
  ContributorScoringProfileSchema,
  ContributorStrategySchema,
  HealthSchema,
  InstallationHealthSchema,
  InstallationRepairSchema,
  IssueQualityReportSchema,
  IssueQualityResponseSchema,
  GateConfigEffectiveResponseSchema,
  EligibilityPlanResponseSchema,
  ScoreBreakdownResponseSchema,
  EvaluateEscalationRequestSchema,
  EvaluateEscalationResponseSchema,
  BuildResultsPayloadRequestSchema,
  BuildResultsPayloadResponseSchema,
  BuildProgressSnapshotRequestSchema,
  BuildProgressSnapshotResponseSchema,
  IntakeIdeaRequestSchema,
  IntakeIdeaResponseSchema,
  PlanIdeaClaimsRequestSchema,
  PlanIdeaClaimsResponseSchema,
  LintPrTextRequestSchema,
  LintPrTextResponseSchema,
  CheckSlopRiskRequestSchema,
  CheckSlopRiskResponseSchema,
  CheckImprovementPotentialRequestSchema,
  CheckImprovementPotentialResponseSchema,
  SimulateOpenPrPressureRequestSchema,
  SimulateOpenPrPressureResponseSchema,
  SuggestBoundaryTestsRequestSchema,
  SuggestBoundaryTestsResponseSchema,
  CheckTestEvidenceRequestSchema,
  CheckTestEvidenceResponseSchema,
  CheckIssueSlopRequestSchema,
  CheckIssueSlopResponseSchema,
  ValidateFocusManifestRequestSchema,
  ValidateFocusManifestResponseSchema,
  LabelAuditSchema,
  LaneAdviceSchema,
  LiveGateThresholdsResponseSchema,
  LocalBranchAnalysisSchema,
  LocalDiffPreflightResultSchema,
  MaintainerPacketSchema,
  MaintainerCutReadinessSchema,
  MaintainerLaneReportSchema,
  MaintainerNoiseReportSchema,
  AmsMinerCohortComparisonSchema,
  GatePrecisionResponseSchema,
  OutcomeCalibrationResponseSchema,
  ActivationPreviewResponseSchema,
  McpCompatibilitySchema,
  PullRequestAiReviewFindingsSchema,
  PullRequestMaintainerPacketSchema,
  PullRequestReviewIntelligenceSchema,
  PullRequestReviewabilitySchema,
  PreflightResultSchema,
  PublicRepoStatsSchema,
  PublicQualityMetricsSchema,
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
  AutomationStateSchema,
  RepositorySettingsSchema,
  RepoDocRefreshResultSchema,
  ListPendingActionsResponseSchema,
  ProposeActionRequestSchema,
  ProposeActionResponseSchema,
  DecidePendingActionResponseSchema,
  RoleContextSchema,
  ReviewRiskExplanationSchema,
  RewardRiskActionSchema,
  ScorePreviewSchema,
  ScoringModelSnapshotSchema,
  SelftuneOverrideAuditResponseSchema,
  ClearSelftuneOverrideResponseSchema,
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
  registry.register("PublicQualityMetrics", PublicQualityMetricsSchema);
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
  registry.register("ReviewRiskExplanation", ReviewRiskExplanationSchema);
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
  registry.register("AutomationState", AutomationStateSchema);
  registry.register("RepoDocRefreshResult", RepoDocRefreshResultSchema);
  registry.register("ListPendingActionsResponse", ListPendingActionsResponseSchema);
  registry.register("ProposeActionRequest", ProposeActionRequestSchema);
  registry.register("ProposeActionResponse", ProposeActionResponseSchema);
  registry.register("DecidePendingActionResponse", DecidePendingActionResponseSchema);
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
  registry.register("GateConfigEffectiveResponse", GateConfigEffectiveResponseSchema);
  registry.register("SelftuneOverrideAuditResponse", SelftuneOverrideAuditResponseSchema);
  registry.register("ClearSelftuneOverrideResponse", ClearSelftuneOverrideResponseSchema);
  registry.register("EligibilityPlanResponse", EligibilityPlanResponseSchema);
  registry.register("ScoreBreakdownResponse", ScoreBreakdownResponseSchema);
  registry.register("EvaluateEscalationRequest", EvaluateEscalationRequestSchema);
  registry.register("EvaluateEscalationResponse", EvaluateEscalationResponseSchema);
  registry.register("BuildResultsPayloadRequest", BuildResultsPayloadRequestSchema);
  registry.register("BuildResultsPayloadResponse", BuildResultsPayloadResponseSchema);
  registry.register("BuildProgressSnapshotRequest", BuildProgressSnapshotRequestSchema);
  registry.register("BuildProgressSnapshotResponse", BuildProgressSnapshotResponseSchema);
  registry.register("IntakeIdeaRequest", IntakeIdeaRequestSchema);
  registry.register("IntakeIdeaResponse", IntakeIdeaResponseSchema);
  registry.register("PlanIdeaClaimsRequest", PlanIdeaClaimsRequestSchema);
  registry.register("PlanIdeaClaimsResponse", PlanIdeaClaimsResponseSchema);
  registry.register("LintPrTextRequest", LintPrTextRequestSchema);
  registry.register("LintPrTextResponse", LintPrTextResponseSchema);
  registry.register("CheckSlopRiskRequest", CheckSlopRiskRequestSchema);
  registry.register("CheckSlopRiskResponse", CheckSlopRiskResponseSchema);
  registry.register("CheckImprovementPotentialRequest", CheckImprovementPotentialRequestSchema);
  registry.register("CheckImprovementPotentialResponse", CheckImprovementPotentialResponseSchema);
  registry.register("SimulateOpenPrPressureRequest", SimulateOpenPrPressureRequestSchema);
  registry.register("SimulateOpenPrPressureResponse", SimulateOpenPrPressureResponseSchema);
  registry.register("SuggestBoundaryTestsRequest", SuggestBoundaryTestsRequestSchema);
  registry.register("SuggestBoundaryTestsResponse", SuggestBoundaryTestsResponseSchema);
  registry.register("CheckTestEvidenceRequest", CheckTestEvidenceRequestSchema);
  registry.register("CheckTestEvidenceResponse", CheckTestEvidenceResponseSchema);
  registry.register("CheckIssueSlopRequest", CheckIssueSlopRequestSchema);
  registry.register("CheckIssueSlopResponse", CheckIssueSlopResponseSchema);
  registry.register("ValidateFocusManifestRequest", ValidateFocusManifestRequestSchema);
  registry.register("ValidateFocusManifestResponse", ValidateFocusManifestResponseSchema);
  registry.register("LiveGateThresholdsResponse", LiveGateThresholdsResponseSchema);
  registry.register("BurdenForecast", BurdenForecastSchema);
  registry.register("ContributorScoringProfile", ContributorScoringProfileSchema);
  registry.register("ContributorStrategy", ContributorStrategySchema);
  registry.register("RewardRiskAction", RewardRiskActionSchema);
  registry.register("RepoRewardRisk", RepoRewardRiskSchema);
  registry.register("ContributorRewardRiskStrategy", ContributorRewardRiskStrategySchema);
  registry.register("MaintainerNoiseReport", MaintainerNoiseReportSchema);
  registry.register("AmsMinerCohortComparison", AmsMinerCohortComparisonSchema);
  registry.register("GatePrecisionResponse", GatePrecisionResponseSchema);
  registry.register("OutcomeCalibrationResponse", OutcomeCalibrationResponseSchema);
  registry.register("ActivationPreviewResponse", ActivationPreviewResponseSchema);
  registry.register("PullRequestReviewability", PullRequestReviewabilitySchema);
  registry.register("PullRequestAiReviewFindings", PullRequestAiReviewFindingsSchema);

  registry.registerPath({
    method: "get",
    path: "/health",
    summary: "Service liveness probe",
    responses: {
      200: { description: "Service health", content: { "application/json": { schema: HealthSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/mcp/compatibility",
    summary: "Public-safe API and MCP client compatibility metadata",
    responses: {
      200: { description: "Public-safe API and MCP compatibility metadata", content: { "application/json": { schema: McpCompatibilitySchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/stats",
    summary: "Public homepage aggregate stats",
    responses: {
      200: { description: "Public-safe homepage stats: lifetime PRs handled/merged/closed, gate + slop blocks, and reversal-grounded accuracy. Aggregate counts only.", content: { "application/json": { schema: PublicStatsSchema } } },
      404: { description: "Public stats are disabled (LOOPOVER_PUBLIC_STATS off)" },
      503: { description: "Public stats are temporarily unavailable" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/github/repos/{owner}/{repo}/stats",
    summary: "Public GitHub stars and forks for an allowlisted repository",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Public GitHub repository stars/forks for the website chrome; PUBLIC_REPO_STATS_ALLOWLIST must explicitly include the owner/repo.", content: { "application/json": { schema: PublicRepoStatsSchema } } },
      400: { description: "Invalid or non-allowlisted GitHub repository" },
      503: { description: "GitHub repository stats are unavailable" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/repos/{owner}/{repo}/quality",
    summary: "Public repository quality summary for an opted-in repository",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description:
          "Public per-repo review-quality metrics: gate false-positive rates, merge-vs-close ratio, and weekly trend. Aggregate counts only; opt-in via publicQualityMetrics.",
        content: { "application/json": { schema: PublicQualityMetricsSchema } },
      },
      404: { description: "Repo is unknown/private/uninstalled or has not opted in" },
      503: { description: "Public quality metrics are temporarily unavailable" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/registry/snapshot",
    summary: "Latest Gittensor registry snapshot",
    responses: {
      200: { description: "Latest Gittensor registry snapshot", content: { "application/json": { schema: RegistrySnapshotSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/registry/changes",
    summary: "Diff between the two latest registry snapshots",
    responses: {
      200: { description: "Diff between latest registry snapshots", content: { "application/json": { schema: RegistryChangeReportSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/scoring/model",
    summary: "Latest scoring model snapshot",
    responses: {
      200: { description: "Latest private scoring model snapshot", content: { "application/json": { schema: ScoringModelSnapshotSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/finding-taxonomy",
    summary: "Canonical AI-review finding taxonomy",
    responses: {
      200: { description: "Finding categories and the severity ladder", content: { "application/json": { schema: FindingTaxonomyDocumentSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/enrichment-analyzers",
    summary: "REES enrichment analyzer taxonomy",
    responses: {
      200: { description: "Default profile and the registered enrichment analyzers", content: { "application/json": { schema: EnrichmentAnalyzersTaxonomyDocumentSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/upstream/status",
    summary: "Upstream Gittensor source and ruleset drift status",
    responses: {
      200: { description: "Upstream Gittensor source/ruleset drift status", content: { "application/json": { schema: UpstreamStatusSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/upstream/ruleset",
    summary: "Latest normalized upstream Gittensor ruleset snapshot",
    responses: {
      200: { description: "Latest normalized upstream Gittensor ruleset snapshot", content: { "application/json": { schema: UpstreamRulesetSnapshotSchema } } },
      404: { description: "No upstream ruleset snapshot has been built yet" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/upstream/drift",
    summary: "Open and historical upstream drift reports",
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
    summary: "Generate a scoring preview artifact for a candidate contribution",
    responses: {
      200: { description: "Private scoring preview artifact", content: { "application/json": { schema: ScorePreviewSchema } } },
      400: { description: "Invalid scoring preview input" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/scoring/eligibility-plan",
    summary: "Derive a contributor eligibility plan from a scoring preview — REST mirror of loopover_get_eligibility_plan (#9301)",
    responses: {
      200: {
        description:
          "Structured eligibility plan over a server-built score preview — mirrors the loopover_get_eligibility_plan MCP tool. Advisory only; it explains eligibility, it does not open issues or PRs",
        content: { "application/json": { schema: EligibilityPlanResponseSchema } },
      },
      400: { description: "Invalid scoring preview input" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/scoring/explain-breakdown",
    summary: "Explain a score breakdown from a scoring preview — REST mirror of loopover_explain_score_breakdown (#9301)",
    responses: {
      200: {
        description:
          "Score multiplier breakdown and gate highlights over a server-built score preview — mirrors the loopover_explain_score_breakdown MCP tool. Requires contributorLogin in the request body",
        content: { "application/json": { schema: ScoreBreakdownResponseSchema } },
      },
      400: { description: "Invalid scoring preview input or missing contributorLogin" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/sync/status",
    summary: "Repository and installation sync status",
    responses: {
      200: { description: "Repository and installation sync status", content: { "application/json": { schema: SyncStatusSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/readiness",
    summary: "Operational readiness summary for the hosted API",
    responses: {
      200: { description: "Operational readiness summary for hosted API, signal fidelity, and public-review preparation", content: { "application/json": { schema: ReadinessSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/installations",
    summary: "List GitHub App installations and their health",
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
    summary: "GitHub App installation health detail",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "GitHub App installation health", content: { "application/json": { schema: InstallationHealthSchema } } },
      404: { description: "Installation health not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/installations/{id}/repair",
    summary: "GitHub App installation repair diagnostics",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "GitHub App installation repair diagnostics", content: { "application/json": { schema: InstallationRepairSchema } } },
      404: { description: "Installation health not found" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/installations/{id}/repair/refresh",
    summary: "Recompute GitHub App installation repair diagnostics",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Refreshed GitHub App installation repair diagnostics", content: { "application/json": { schema: InstallationRepairSchema } } },
      404: { description: "Installation not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/notification-model",
    summary: "Opt-in notification model and PWA-readiness metadata",
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
    summary: "List known repositories",
    responses: {
      200: { description: "Known repositories", content: { "application/json": { schema: RepositorySchema.array() } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}",
    summary: "Repository detail",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Repository detail", content: { "application/json": { schema: RepositorySchema } } },
      404: { description: "Repository not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/intelligence",
    summary: "Canonical repository intelligence bundle",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Canonical repository intelligence bundle", content: { "application/json": { schema: RepoIntelligenceSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/issue-quality",
    summary: "Repository issue quality report",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Cached or computed issue quality report for the repo", content: { "application/json": { schema: IssueQualityResponseSchema } } },
      404: { description: "Repo is unknown or has no issue-quality coverage yet" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/gate-config/effective",
    summary: "Current effective self-tuned gate config for a repo (#6247)",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description: "Effective TunableOverride values (confidenceFloor / scopeCap.files / scopeCap.lines) with a shadowPending flag — never the raw override_audit history",
        content: { "application/json": { schema: GateConfigEffectiveResponseSchema } },
      },
      401: { description: "Missing or invalid static protected API token" },
      403: { description: "Static mcp credential is outside MCP_READ_REPO_ALLOWLIST for this repo" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/selftune/overrides/audit",
    summary: "Self-tune gate override audit trail for a repo (#9303)",
    request: {
      params: z.object({ owner: z.string(), repo: z.string() }),
      query: z.object({
        limit: z.string().optional().openapi({
          param: { description: "Optional row cap for the returned audit history (positive integer)." },
          example: "50",
        }),
      }),
    },
    responses: {
      200: {
        description:
          "Newest-first override_audit rows recording why the self-tune loop promoted, shadowed, or cleared a live gate override",
        content: { "application/json": { schema: SelftuneOverrideAuditResponseSchema } },
      },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/v1/repos/{owner}/{repo}/selftune/overrides",
    summary: "Clear the live self-tune gate override for a repo (#9303)",
    request: {
      params: z.object({ owner: z.string(), repo: z.string() }),
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ confirm: z.literal(true) }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Live override cleared; the automatic self-tune promote path is untouched",
        content: { "application/json": { schema: ClearSelftuneOverrideResponseSchema } },
      },
      400: { description: "Malformed confirmation body" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/loop/evaluate-escalation",
    summary: "Evaluate whether a loop outcome should escalate — REST mirror of loopover_evaluate_escalation (#9309)",
    request: {
      body: {
        content: { "application/json": { schema: EvaluateEscalationRequestSchema } },
      },
    },
    responses: {
      200: {
        description:
          "Escalation decision over caller-supplied loop outcome + health signals — mirrors the loopover_evaluate_escalation MCP tool. Pure, source-free evaluator; it decides, the caller wires the action",
        content: { "application/json": { schema: EvaluateEscalationResponseSchema } },
      },
      400: { description: "Invalid evaluate-escalation request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/loop/results-payload",
    summary: "Compose a loop results-delivery payload — REST mirror of loopover_build_results_payload (#9309)",
    request: {
      body: {
        content: { "application/json": { schema: BuildResultsPayloadRequestSchema } },
      },
    },
    responses: {
      200: {
        description:
          "Formatted results payload over caller-supplied iteration metadata — mirrors the loopover_build_results_payload MCP tool. Pure composer; it formats the result, it does not fetch, open, or deliver anything",
        content: { "application/json": { schema: BuildResultsPayloadResponseSchema } },
      },
      400: { description: "Invalid results-payload request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/loop/progress-snapshot",
    summary: "Compose a running-loop progress snapshot — REST mirror of loopover_build_progress_snapshot (#9309)",
    request: {
      body: {
        content: { "application/json": { schema: BuildProgressSnapshotRequestSchema } },
      },
    },
    responses: {
      200: {
        description:
          "Formatted progress snapshot over caller-supplied loop state — mirrors the loopover_build_progress_snapshot MCP tool. Pure composer; it formats the snapshot, it does not fetch or stream anything",
        content: { "application/json": { schema: BuildProgressSnapshotResponseSchema } },
      },
      400: { description: "Invalid progress-snapshot request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/loop/intake-idea",
    summary: "Validate an idea submission and assemble its task-graph — REST mirror of loopover_intake_idea (#9309)",
    request: {
      body: {
        content: { "application/json": { schema: IntakeIdeaRequestSchema } },
      },
    },
    responses: {
      200: {
        description:
          "Idea verdict + assembled task-graph — mirrors the loopover_intake_idea MCP tool. Pure composer over the caller-supplied idea and optional decomposition",
        content: { "application/json": { schema: IntakeIdeaResponseSchema } },
      },
      400: { description: "Invalid intake-idea request body, or an empty/malformed idea submission (actionable error list returned)" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/loop/plan-idea-claims",
    summary: "Disposition an idea's task-graph into a claim plan — REST mirror of loopover_plan_idea_claims (#9309)",
    request: {
      body: {
        content: { "application/json": { schema: PlanIdeaClaimsRequestSchema } },
      },
    },
    responses: {
      200: {
        description:
          "Idea verdict + claim plan (which constituent issues can be claimed now vs. deferred) — mirrors the loopover_plan_idea_claims MCP tool. Pure composer over the caller-supplied idea and optional decomposition",
        content: { "application/json": { schema: PlanIdeaClaimsResponseSchema } },
      },
      400: { description: "Invalid plan-idea-claims request body, or an empty/malformed idea submission (actionable error list returned)" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/lint/pr-text",
    summary: "Lint a PR's commit messages + body — REST mirror of loopover_lint_pr_text (#9308)",
    request: { body: { content: { "application/json": { schema: LintPrTextRequestSchema } } } },
    responses: {
      200: {
        description: "PR-text lint verdict, score, and fix suggestions — mirrors the loopover_lint_pr_text MCP tool",
        content: { "application/json": { schema: LintPrTextResponseSchema } },
      },
      400: { description: "Invalid lint/pr-text request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/lint/slop-risk",
    summary: "Assess a changeset's slop risk — REST mirror of loopover_check_slop_risk (#9308)",
    request: { body: { content: { "application/json": { schema: CheckSlopRiskRequestSchema } } } },
    responses: {
      200: {
        description: "Slop-risk band and findings over the caller-supplied changed files — mirrors the loopover_check_slop_risk MCP tool",
        content: { "application/json": { schema: CheckSlopRiskResponseSchema } },
      },
      400: { description: "Invalid lint/slop-risk request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/lint/improvement-potential",
    summary: "Score a changeset's structural improvement potential — REST mirror of loopover_check_improvement_potential (#9308)",
    request: { body: { content: { "application/json": { schema: CheckImprovementPotentialRequestSchema } } } },
    responses: {
      200: {
        description: "Improvement-potential score, band, and findings — mirrors the loopover_check_improvement_potential MCP tool",
        content: { "application/json": { schema: CheckImprovementPotentialResponseSchema } },
      },
      400: { description: "Invalid lint/improvement-potential request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/lint/open-pr-pressure",
    summary: "Simulate open-PR queue pressure for a repo — REST mirror of loopover_simulate_open_pr_pressure (#9308)",
    request: { body: { content: { "application/json": { schema: SimulateOpenPrPressureRequestSchema } } } },
    responses: {
      200: {
        description: "Queue-pressure scenarios and the recommended option over caller-supplied queue health — mirrors the loopover_simulate_open_pr_pressure MCP tool",
        content: { "application/json": { schema: SimulateOpenPrPressureResponseSchema } },
      },
      400: { description: "Invalid lint/open-pr-pressure request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/lint/boundary-tests",
    summary: "Suggest boundary tests for a changeset — REST mirror of loopover_suggest_boundary_tests (#9308)",
    request: { body: { content: { "application/json": { schema: SuggestBoundaryTestsRequestSchema } } } },
    responses: {
      200: {
        description: "Boundary-test finding and suggested test spec — mirrors the loopover_suggest_boundary_tests MCP tool",
        content: { "application/json": { schema: SuggestBoundaryTestsResponseSchema } },
      },
      400: { description: "Invalid lint/boundary-tests request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/lint/test-evidence",
    summary: "Classify a changeset's test evidence — REST mirror of loopover_check_test_evidence (#9308)",
    request: { body: { content: { "application/json": { schema: CheckTestEvidenceRequestSchema } } } },
    responses: {
      200: {
        description: "Test-evidence classification, file counts, and guidance over caller-supplied changed paths — mirrors the loopover_check_test_evidence MCP tool",
        content: { "application/json": { schema: CheckTestEvidenceResponseSchema } },
      },
      400: { description: "Invalid lint/test-evidence request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/lint/issue-slop",
    summary: "Assess an issue's slop risk from its title/body — REST mirror of loopover_check_issue_slop (#9308)",
    request: { body: { content: { "application/json": { schema: CheckIssueSlopRequestSchema } } } },
    responses: {
      200: {
        description: "Slop-risk band and findings over the caller-supplied issue title/body — mirrors the loopover_check_issue_slop MCP tool",
        content: { "application/json": { schema: CheckIssueSlopResponseSchema } },
      },
      400: { description: "Invalid lint/issue-slop request body" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/validate/focus-manifest",
    summary: "Validate a .loopover focus-manifest config — REST mirror of loopover_validate_config (#9308)",
    request: { body: { content: { "application/json": { schema: ValidateFocusManifestRequestSchema } } } },
    responses: {
      200: {
        description: "Focus-manifest presence, normalized config, warnings, and status — mirrors the loopover_validate_config MCP tool",
        content: { "application/json": { schema: ValidateFocusManifestResponseSchema } },
      },
      400: { description: "Invalid validate/focus-manifest request body" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/live-gate-thresholds",
    summary: "Live self-tuned gate thresholds for AMS probe (#6486)",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description: "Field-limited live (or soaking-shadow) TunableOverride values — confidence_floor / scope_cap_files / scope_cap_lines only",
        content: { "application/json": { schema: LiveGateThresholdsResponseSchema } },
      },
      403: { description: "Static mcp credential is outside MCP_READ_REPO_ALLOWLIST for this repo" },
      404: { description: "No live or shadow gate override is active for this repo" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/maintainer-noise",
    summary: "Maintainer queue-noise triage report for a repository (#9302)",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description:
          "Noise score/level, specific noise sources to clear first, and recommended maintainer actions — mirrors the loopover_get_maintainer_noise MCP tool. Maintainer-authenticated; advisory only",
        content: { "application/json": { schema: MaintainerNoiseReportSchema } },
      },
      401: { description: "Missing or invalid static protected API token" },
      403: { description: "Static mcp credential is outside MCP_READ_REPO_ALLOWLIST for this repo" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/ams-miner-cohort",
    summary: "AMS-vs-human contributor-mix cohort comparison for a repository (#9302)",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description:
          "Submitter counts, PR volume, acceptance rate, review-cycle, and time-to-merge metrics for AMS-tracked vs human submitters — mirrors the loopover_get_ams_miner_cohort MCP tool. Maintainer-authenticated; advisory only",
        content: { "application/json": { schema: AmsMinerCohortComparisonSchema } },
      },
      401: { description: "Missing or invalid static protected API token" },
      403: { description: "Static mcp credential is outside MCP_READ_REPO_ALLOWLIST for this repo" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/gate-precision",
    summary: "Per-gate-type false-positive precision measurement for a repository (#9302)",
    request: {
      params: z.object({ owner: z.string(), repo: z.string() }),
      query: z.object({ windowDays: z.coerce.number().int().positive().optional() }),
    },
    responses: {
      200: {
        description:
          "Blocked / blocked-then-merged / overridden counts and false-positive rates with low-sample guards — mirrors the loopover_get_gate_precision MCP tool. Maintainer-authenticated; measurement only",
        content: { "application/json": { schema: GatePrecisionResponseSchema } },
      },
      401: { description: "Missing or invalid static protected API token" },
      403: { description: "Static mcp credential is outside MCP_READ_REPO_ALLOWLIST for this repo" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/outcome-calibration",
    summary: "Slop-band and recommendation outcome calibration for a repository (#9302)",
    request: {
      params: z.object({ owner: z.string(), repo: z.string() }),
      query: z.object({ windowDays: z.coerce.number().int().positive().optional() }),
    },
    responses: {
      200: {
        description:
          "Whether higher-slop bands merge less often and how agent recommendations are panning out — mirrors the loopover_get_outcome_calibration MCP tool. Maintainer-authenticated; measurement only",
        content: { "application/json": { schema: OutcomeCalibrationResponseSchema } },
      },
      401: { description: "Missing or invalid static protected API token" },
      403: { description: "Static mcp credential is outside MCP_READ_REPO_ALLOWLIST for this repo" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/activation-preview",
    summary: "Deterministic maintainer activation preview for a repository (#9302)",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description:
          "A deterministic \"here's what LoopOver would have surfaced\" run of the advisory engine over recent PRs — mirrors the loopover_get_activation_preview MCP tool. Maintainer-authenticated; advisory only, never runs AI",
        content: { "application/json": { schema: ActivationPreviewResponseSchema } },
      },
      401: { description: "Missing or invalid static protected API token" },
      403: { description: "Static mcp credential is outside MCP_READ_REPO_ALLOWLIST for this repo" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/outcome-patterns",
    summary: "Accepted and rejected pull request outcome patterns for a repository",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Cached or freshly-computed per-repo accepted/rejected PR outcome patterns with freshness envelope and explicit evidence-completeness", content: { "application/json": { schema: RepoOutcomePatternsResponseSchema } } },
      404: { description: "Repo is unknown or has no outcome-pattern coverage yet" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/registration-readiness",
    summary: "Gittensor registration readiness signal for repository owners",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Gittensor registration readiness signal for repo owners", content: { "application/json": { schema: RegistrationReadinessSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/gittensor-config-recommendation",
    summary: "Recommended Gittensor configuration for a repository",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Private Gittensor config recommendation for repo owners", content: { "application/json": { schema: GittensorConfigRecommendationSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/focus-manifest",
    summary: "Repository focus manifest and compiled policy",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Repo focus manifest and compiled policy for maintainers", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/focus-manifest/refresh",
    summary: "Refresh the persisted focus manifest from the repository file",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Refresh the persisted focus manifest cache from the repo file", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/repos/{owner}/{repo}/focus-manifest",
    summary: "Persist an API-backed focus manifest for a repository",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Persist API-backed focus manifest for a repo", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Malformed JSON request body" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/agent/pending-actions",
    summary: "Maintainer-scoped agent approval queue of pending staged actions",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description: "Pending agent actions staged for maintainer approval (#784), mirroring the loopover_list_pending_actions MCP tool.",
        content: { "application/json": { schema: ListPendingActionsResponseSchema } },
      },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/agent/pending-actions",
    summary: "Stage an agent action into the approval queue for maintainer review",
    request: {
      params: z.object({ owner: z.string(), repo: z.string() }),
      body: { content: { "application/json": { schema: ProposeActionRequestSchema } } },
    },
    responses: {
      200: {
        description: "The staged (or already-present) pending action (#6744), mirroring the loopover_propose_action MCP tool VERBATIM.",
        content: { "application/json": { schema: ProposeActionResponseSchema } },
      },
      400: { description: "Malformed propose-action request body" },
      403: { description: "Insufficient role" },
      409: { description: "The LoopOver App is not installed on this repository" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/agent/pending-actions/{id}/{decision}",
    summary: "Accept (execute) or reject a staged agent action in the approval queue",
    request: { params: z.object({ owner: z.string(), repo: z.string(), id: z.string(), decision: z.enum(["accept", "reject"]) }) },
    responses: {
      200: {
        description: "The decided action's outcome (#779): accept executes it live, reject cancels it. Mirrors the loopover_decide_pending_action MCP tool.",
        content: { "application/json": { schema: DecidePendingActionResponseSchema } },
      },
      400: { description: "Decision is not 'accept' or 'reject'" },
      403: { description: "Insufficient role" },
      404: { description: "Pending action not found for this repository" },
      409: { description: "Pending action was already decided" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/agent/audit-feed",
    summary: "Maintainer-scoped agent audit feed of executed actions and approval decisions",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description:
          "Maintainer-scoped agent audit feed (#784): executed actions + approval-queue decisions, newest first, public-safe action posture only. Supports ?since=ISO-8601&limit=1-200. " +
          "?pull=N opts into the unfiltered sibling query: every audit_events row for that one PR's targetKey (no eventType restriction), still maintainer-gated and detail-sanitized the same way.",
        content: {
          "application/json": {
            schema: z.union([
              z.object({
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
              z.object({
                repoFullName: z.string(),
                pullNumber: z.number(),
                events: z.array(
                  z.object({
                    eventType: z.string(),
                    outcome: z.string(),
                    actor: z.string().nullable(),
                    detail: z.string().nullable(),
                    createdAt: z.string(),
                  }),
                ),
              }),
            ]),
          },
        },
      },
      400: { description: "Malformed since (not ISO-8601), limit (not an integer in 1-200), or pull (not a positive integer)" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/pulls/{number}/incident-reports",
    summary: "Record a post-merge incident report for a pull request",
    request: {
      params: z.object({ owner: z.string(), repo: z.string(), number: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              description: z.string().min(1).max(4000),
              severity: z.enum(["low", "medium", "high", "critical"]),
              mergedSha: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Post-merge incident report recorded as an audit_events row (#5672), customer-facing (repo maintainer) side",
        content: { "application/json": { schema: z.object({ ok: z.literal(true), repoFullName: z.string(), pullNumber: z.number(), id: z.string(), createdAt: z.string() }) } },
      },
      400: { description: "Invalid pull number or incident report body" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient role" },
      404: { description: "Pull request not found" },
      409: { description: "Pull request has not been merged" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/app/incident-reports",
    summary: "Record a post-merge incident report from the operator side",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              repoFullName: z.string().min(3).max(200),
              pullNumber: z.number().int().positive(),
              description: z.string().min(1).max(4000),
              severity: z.enum(["low", "medium", "high", "critical"]),
              mergedSha: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Post-merge incident report recorded as an audit_events row (#5672), internal-operator side",
        content: { "application/json": { schema: z.object({ ok: z.literal(true), repoFullName: z.string(), pullNumber: z.number(), id: z.string(), createdAt: z.string() }) } },
      },
      400: { description: "Invalid incident report body" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role (operator only)" },
      404: { description: "Pull request not found" },
      409: { description: "Pull request has not been merged" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/self-dogfood/registration-pack",
    summary: "Self-dogfood registration pack for the LoopOver repository",
    responses: {
      200: { description: "Private self-dogfood registration pack for the LoopOver repo", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role for maintainer-only self-dogfood report" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/self-dogfood-registration-pack",
    summary: "Self-dogfood registration pack when the repository matches the configured target",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Private self-dogfood registration pack when repo matches configured LoopOver target", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role or repo is not the configured self-dogfood target" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/onboarding-pack/preview",
    summary: "Preview the onboarding pack for an accepted repository",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Preview-only repo onboarding pack for accepted repositories", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      403: { description: "Insufficient role" },
      404: { description: "Repository is not accepted or preview unavailable" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/contributor-issue-drafts/generate",
    summary: "Generate maintainer-reviewed contributor issue drafts",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Generate maintainer-reviewed contributor issue drafts from repo policy (dry-run by default)", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Invalid request or explicit create without dryRun false" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/issue-plan-drafts/generate",
    summary: "AI-plan repo issue drafts from a maintainer goal",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "AI-plan a small set of GitHub issue drafts from a maintainer-supplied planning goal (dry-run by default)", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Invalid request or explicit create without dryRun false" },
      403: { description: "Insufficient role" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/settings",
    summary: "Repository automation settings",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "LoopOver repository automation settings", content: { "application/json": { schema: RepositorySettingsSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/automation-state",
    summary: "Derived agent automation state for a repository",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: {
        description:
          "Maintainer-only derived automation view (mode, permission readiness, acting action classes, pending-approval count) that the raw /settings row does not include",
        content: { "application/json": { schema: AutomationStateSchema } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/repo-docs/refresh",
    summary: "Open (or find the already-open) AGENTS.md/CLAUDE.md generation pull request",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "The repo-doc pull request result -- opened (new or reused) or a reason it was not opened", content: { "application/json": { schema: RepoDocRefreshResultSchema } } },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/repos/{owner}/{repo}/settings-preview",
    summary: "Dry-run the public surface decision for a sample pull request",
    request: { params: z.object({ owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Maintainer dry-run preview of the public surface decision for a sample PR (no GitHub mutation)", content: { "application/json": { schema: RepoSettingsPreviewSchema } } },
      400: { description: "Invalid settings preview request" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/pulls/{number}/maintainer-packet",
    summary: "Maintainer review packet for a pull request",
    request: { params: z.object({ owner: z.string(), repo: z.string(), number: z.string() }) },
    responses: {
      200: { description: "PR-specific maintainer review packet", content: { "application/json": { schema: PullRequestMaintainerPacketSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/pulls/{number}/reviewability",
    summary: "Pull request reviewability score and maintainer action",
    request: { params: z.object({ owner: z.string(), repo: z.string(), number: z.string() }) },
    responses: {
      200: { description: "Private PR reviewability score and maintainer action", content: { "application/json": { schema: PullRequestReviewabilitySchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/repos/{owner}/{repo}/pulls/{number}/ai-review-findings",
    summary: "A PR author's own structured, published AI-review findings",
    request: {
      params: z.object({ owner: z.string(), repo: z.string(), number: z.string() }),
      query: z.object({
        login: z.string().min(1).openapi({
          param: { description: "GitHub login of the pull request's author -- the caller must be this same login." },
          example: "jsonbored",
        }),
      }),
    },
    responses: {
      200: { description: "Structured, published AI-review findings for the caller's own pull request", content: { "application/json": { schema: PullRequestAiReviewFindingsSchema } } },
      400: { description: "Missing login" },
      403: { description: "The pull request belongs to a different contributor" },
      404: { description: "Pull request not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/profile",
    summary: "Contributor evidence profile",
    request: { params: z.object({ login: z.string() }) },
    responses: {
      200: { description: "Contributor evidence profile", content: { "application/json": { schema: ContributorProfileSchema } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/decision-pack",
    summary: "Canonical contributor decision pack",
    request: { params: z.object({ login: z.string() }) },
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
    summary: "Contributor open-PR monitor with classifications and next-step packets",
    request: { params: z.object({ login: z.string() }) },
    responses: {
      200: {
        description: "Contributor open-PR monitor with classifications and public-safe next-step packets from cached metadata.",
        content: { "application/json": { schema: ContributorOpenPrMonitorSchema } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/pr-outcomes",
    summary: "Contributor post-merge PR outcome history",
    request: {
      params: z.object({ login: z.string() }),
      query: z.object({ limit: z.coerce.number().int().positive().max(100).optional() }),
    },
    responses: {
      200: {
        description: "Self-scoped post-merge outcome records with public-safe attribution (mirrors loopover_pr_outcome).",
        content: { "application/json": { schema: ContributorPrOutcomesSchema } },
      },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/notifications",
    summary: "Contributor badge notification feed",
    request: { params: z.object({ login: z.string() }) },
    responses: {
      200: {
        description: "The contributor's own badge notification feed (self-scoped), newest first, with an unread count.",
        content: { "application/json": { schema: NotificationFeedSchema } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/contributors/{login}/notifications/read",
    summary: "Mark contributor notifications read",
    request: {
      params: z.object({ login: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ ids: z.array(z.string()).optional() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Marks the contributor's delivered badge notifications read; an absent/empty ids array marks all.",
        content: { "application/json": { schema: NotificationsMarkedSchema } },
      },
      400: { description: "Invalid mark-read body" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/contributors/{login}/repos/{owner}/{repo}/decision",
    summary: "Repository-specific contributor decision",
    request: { params: z.object({ login: z.string(), owner: z.string(), repo: z.string() }) },
    responses: {
      200: { description: "Repo-specific contributor decision from decision pack. May carry freshness 'stale' or 'rebuilding'.", content: { "application/json": { schema: RepoDecisionResponseSchema } } },
      202: { description: "Decision pack snapshot is missing; a background rebuild has been requested", content: { "application/json": { schema: DecisionPackRefreshNeededSchema } } },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/preflight/pr",
    summary: "Run submission preflight for a pull request",
    responses: {
      200: { description: "Submission preflight result", content: { "application/json": { schema: PreflightResultSchema } } },
      400: { description: "Invalid preflight input" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/preflight/review-risk",
    summary: "Explain review risk for a planned pull request",
    responses: {
      200: { description: "Review-risk explanation with preflight, role context, and recommendation", content: { "application/json": { schema: ReviewRiskExplanationSchema } } },
      400: { description: "Invalid preflight input" },
      403: { description: "Forbidden when contributorLogin does not match the authenticated session" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/preflight/local-diff",
    summary: "Run preflight against a local diff",
    responses: {
      200: { description: "Local diff preflight result", content: { "application/json": { schema: LocalDiffPreflightResultSchema } } },
      400: { description: "Invalid local diff preflight input" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/local/branch-analysis",
    summary: "Analyze a local branch for MCP clients",
    responses: {
      200: { description: "Private local branch analysis for MCP clients", content: { "application/json": { schema: LocalBranchAnalysisSchema } } },
      400: { description: "Invalid local branch analysis input" },
      401: { description: "Unauthorized" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/agent/runs",
    summary: "Queue an agent run",
    responses: {
      202: { description: "Copilot-only agent run queued", content: { "application/json": { schema: AgentRunBundleSchema } } },
      400: { description: "Invalid agent run request" },
      401: { description: "Unauthorized" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/agent/runs",
    summary: "List persisted agent runs for an actor",
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
    summary: "Persisted agent run bundle",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Persisted agent run bundle", content: { "application/json": { schema: AgentRunBundleSchema } } },
      404: { description: "Agent run not found" },
    },
  });
  for (const [path, summary] of [
    ["/v1/agent/plan-next-work", "Rank the next work items for an agent run"],
    ["/v1/agent/preflight-branch", "Preflight an agent branch before submission"],
    ["/v1/agent/prepare-pr-packet", "Prepare a pull request packet for an agent run"],
    ["/v1/agent/explain-blockers", "Explain an agent run's current blockers"],
  ] as const) {
    registry.registerPath({
      method: "post",
      path,
      summary,
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
    summary: "List known bounty records",
    responses: {
      200: { description: "Known bounty records", content: { "application/json": { schema: BountySchema.array() } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/bounties/{id}/advisory",
    summary: "Bounty lifecycle advisory",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Bounty lifecycle advisory", content: { "application/json": { schema: BountyAdvisorySchema } } },
      404: { description: "Bounty not found" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/bounties/{id}/lifecycle",
    summary: "Bounty lifecycle transition history",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Bounty lifecycle transition history", content: { "application/json": { schema: BountyLifecycleEventsSchema } } },
      404: { description: "Bounty not found" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/github/webhook",
    summary: "Receive a GitHub webhook delivery",
    responses: {
      202: { description: "Webhook queued" },
      401: { description: "Invalid webhook signature" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/decision-ledger/verify",
    summary: "Verify a window of the hash-chained decision ledger (resumable via afterSeq)",
    responses: {
      200: { description: "Window verified clean; nextAfterSeq is the resume cursor (null at the tip). Every response also carries tipSeq/tipHash/totalCount for third-party checkpointing." },
      409: { description: "First break found: sequence_gap | predecessor_mismatch | row_hash_mismatch | short_tail (a record exists past the verified tip with no chain entry)" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/decision-ledger/row/{seq}",
    summary: "Fetch one decision-ledger row by seq, so an external anchor can be bound back to the live chain",
    request: { params: z.object({ seq: z.string() }) },
    responses: {
      200: { description: "The chain row: seq, recordId, recordDigest, prevHash, rowHash, createdAt. Recompute sha256(prevHash || canonicalJson({seq, recordId, recordDigest, createdAt})) and compare against an anchored rowHash." },
      400: { description: "seq is not a positive integer" },
      404: { description: "No ledger row at that seq (never appended -- distinct from a row with empty fields)" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/decision-ledger/anchor-key",
    summary: "Published anchor-signing public keys with their full rotation history, for verifying an externally-published ledger anchor",
    responses: {
      200: { description: "{ keys: [{ keyId, publicKeySpki, notBefore, notAfter }], currentKeyId } — retired keys are retained so anchors signed under them stay verifiable; currentKeyId is null when unconfigured or the rotation state is ambiguous" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/decision-ledger/anchors",
    summary: "Every external anchoring attempt, success and failure, paginated newest-first — anchoring's own health as a public fact",
    request: { query: z.object({ backend: z.enum(["rekor", "git", "ots"]).optional(), before: z.string().optional(), limit: z.string().optional() }) },
    responses: {
      200: { description: "{ anchors: [{ id, seq, rowHash, keyId, backend, backendRef, status, error, createdAt }], nextBefore } — a failed attempt is returned identically to a successful one, never filtered out or reshaped" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/decision-records/{owner}/{repo}/{pull}",
    summary: "Fetch the latest published decision record for a PR, verbatim, plus its content digest",
    request: { params: z.object({ owner: z.string(), repo: z.string(), pull: z.string() }) },
    responses: {
      200: { description: "The latest DecisionRecord for this PR + its recordDigest" },
      400: { description: "Invalid pull number" },
      404: { description: "No decision record persisted yet for this PR" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/public/eval-scores",
    summary: "Fetch EvalScoreRecords (#9215) -- the objective-eval-provider transport, digest-committed and independently re-derivable",
    request: { query: z.object({ subject: z.string().optional(), since: z.string().optional() }) },
    responses: {
      200: { description: "{ records: EvalScoreRecord[] }, optionally filtered by subject id and/or minimum issuedAt -- degrades to an empty array on an internal read error rather than a non-200 status, matching loadPublicRulePrecision's own fail-safe contract" },
      404: { description: "Public stats disabled (same flag as /v1/public/stats)" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/orb/ingest",
    summary: "Ingest a batch of Orb events",
    responses: {
      200: { description: "Batch accepted; returns { accepted: number }" },
      400: { description: "Malformed JSON or invalid payload shape" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/auth/github/start",
    summary: "Start GitHub web OAuth",
    responses: {
      302: { description: "Redirects to GitHub web OAuth" },
      503: { description: "GitHub OAuth app secret is not configured" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/auth/github/callback",
    summary: "Complete GitHub web OAuth and redirect to the app",
    responses: {
      302: { description: "Completes GitHub web OAuth and redirects to the app" },
    },
  });
  for (const [path, summary] of [
    ["/v1/auth/github/device/start", "Start GitHub device-flow authentication"],
    ["/v1/auth/github/device/poll", "Poll a pending GitHub device-flow authorization"],
    ["/v1/auth/github/session", "Exchange a GitHub token for a LoopOver session"],
    ["/v1/auth/logout", "End the current session"],
  ] as const) {
    registry.registerPath({
      method: "post",
      path,
      summary,
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
    summary: "Current authentication session",
    responses: {
      200: { description: "Current auth session, or signed_out when no app session is present" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/auth/github/token",
    summary: "Fetch the current session's live GitHub token (for AMS git operations)",
    responses: {
      200: { description: "The session's GitHub token", content: { "application/json": { schema: z.object({ token: z.string() }) } } },
      403: { description: "A browser session is required" },
      404: { description: "No GitHub token is available for this session" },
      429: { description: "Rate limited" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/overview",
    summary: "Live app overview assembled from backend data",
    responses: {
      200: { description: "Live app overview assembled from backend data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient role" },
    },
  });
  for (const [path, summary] of [
    ["/v1/app/roles", "App roles granted to the current session"],
    ["/v1/app/miner-dashboard", "Miner dashboard data"],
    ["/v1/app/maintainer-dashboard", "Maintainer dashboard data"],
    ["/v1/app/operator-dashboard", "Operator dashboard data"],
    ["/v1/app/commands", "@loopover command catalog"],
    ["/v1/app/commands/usefulness", "@loopover command usefulness rollup"],
    ["/v1/app/digest", "Maintainer digest content"],
    ["/v1/app/analytics/daily-rollups", "Daily analytics rollups"],
    ["/v1/app/analytics/mcp-compatibility", "MCP client compatibility analytics"],
  ] as const) {
    registry.registerPath({
      method: "get",
      path,
      summary,
      responses: {
        200: { description: "Live app API response", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
        401: { description: "Unauthorized" },
      },
    });
  }
  registry.registerPath({
    method: "post",
    path: "/v1/app/selfhost/queue/dead/{id}/replay",
    summary: "Replay a dead-letter queue job",
    request: {
      params: z.object({
        id: z.string().openapi({ param: { description: "Dead-letter job id." }, example: "812" }),
      }),
    },
    responses: {
      200: { description: "Job replayed", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Invalid job id" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role (operator only)" },
      404: { description: "Dead-letter job not found" },
      501: { description: "This deployment's queue backend does not expose dead-letter admin" },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/v1/app/selfhost/queue/dead/{id}",
    summary: "Delete a dead-letter queue job",
    request: {
      params: z.object({
        id: z.string().openapi({ param: { description: "Dead-letter job id." }, example: "812" }),
      }),
    },
    responses: {
      200: { description: "Job deleted", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      400: { description: "Invalid job id" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role (operator only)" },
      404: { description: "Dead-letter job not found" },
      501: { description: "This deployment's queue backend does not expose dead-letter admin" },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/v1/app/selfhost/queue/dead",
    summary: "Purge all dead-letter queue jobs",
    responses: {
      200: { description: "Dead-letter jobs purged", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role (operator only)" },
      501: { description: "This deployment's queue backend does not expose dead-letter admin" },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/app/selfhost/queue/dead",
    summary: "List dead-letter queue jobs",
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
    summary: "Weekly value report",
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
              example: "# Weekly LoopOver value report\n\n## Adoption metrics\n- Active users: 4\n",
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
    summary: "Audit of pull requests the review agent skipped",
    request: {
      query: z.object({
        limit: z.string().optional().openapi({
          param: { description: "Maximum rows to return, clamped from 1 to 100." },
          example: "50",
        }),
        offset: z.string().optional().openapi({
          param: { description: "Number of parsed skip events to skip before returning rows (non-negative)." },
          example: "0",
        }),
        repoFullName: z.string().optional().openapi({
          param: { description: "Optional repository filter. Browser sessions must have control-panel access to this repo." },
          example: "JSONbored/loopover",
        }),
        reason: z.enum(["surface_off", "missing_author", "bot_author", "ignored_author", "maintainer_author", "miner_detection_unavailable", "not_official_gittensor_miner"]).optional().openapi({
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
    summary: "Dry-run a sanitized @loopover command response",
    responses: {
      200: { description: "Maintainer dry-run preview of a sanitized @loopover command response (no GitHub mutation)", content: { "application/json": { schema: CommandPreviewResponseSchema } } },
      400: { description: "Invalid request" },
      401: { description: "Unauthorized" },
      403: { description: "Insufficient app role" },
      404: { description: "Command not found" },
    },
  });
  for (const [path, summary] of [
    ["/v1/app/commands/feedback", "Submit feedback on an @loopover command response"],
    ["/v1/app/digest/subscriptions", "Manage maintainer digest subscriptions"],
  ] as const) {
    registry.registerPath({
      method: "post",
      path,
      summary,
      responses: {
        200: { description: "Live app mutation or preview response", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
        201: { description: "Created", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
        400: { description: "Invalid request" },
        401: { description: "Unauthorized" },
      },
    });
  }
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/refresh-registry",
    summary: "Queue a registry refresh job",
    responses: {
      202: { description: "Registry refresh queued" },
      401: { description: "Invalid internal token" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/backfill-registered-repos",
    summary: "Queue a registered-repository backfill job",
    responses: {
      202: { description: "Registered repo backfill queued" },
      401: { description: "Invalid internal token" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/backfill-repo-segment",
    summary: "Queue a repository segment backfill job",
    responses: {
      202: { description: "Repository segment backfill queued" },
      400: { description: "Invalid segment request" },
      401: { description: "Invalid internal token" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/backfill-pr-details",
    summary: "Queue an open pull request detail backfill job",
    responses: {
      202: { description: "Open PR detail backfill queued" },
      400: { description: "Invalid PR detail backfill request" },
      401: { description: "Invalid internal token" },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/internal/jobs/generate-review-recap",
    summary: "Queue a maintainer review recap digest job",
    responses: {
      202: { description: "Maintainer review recap digest queued (#1963)" },
      400: { description: "Missing repoFullName" },
      401: { description: "Invalid internal token" },
    },
  });
  for (const [path, summary] of [
    ["/v1/internal/jobs/refresh-scoring-model", "Queue a scoring model refresh job"],
    ["/v1/internal/jobs/refresh-upstream-drift", "Queue an upstream drift refresh job"],
    ["/v1/internal/jobs/file-upstream-drift-issues", "Queue a job that files upstream drift issues"],
    ["/v1/internal/jobs/build-contributor-evidence", "Queue a contributor evidence build job"],
    ["/v1/internal/jobs/build-contributor-decision-packs", "Queue a contributor decision pack build job"],
    ["/v1/internal/jobs/build-burden-forecasts", "Queue a burden forecast build job"],
    ["/v1/internal/jobs/generate-signal-snapshots", "Queue a signal snapshot generation job"],
    ["/v1/internal/jobs/generate-weekly-value-report", "Queue a weekly value report job"],
    ["/v1/internal/jobs/repair-data-fidelity", "Queue a data fidelity repair job"],
  ] as const) {
    registry.registerPath({
      method: "post",
      path,
      summary,
      responses: {
        202: { description: "Internal job queued" },
        401: { description: "Invalid internal token" },
      },
    });
  }
  registry.registerPath({
    method: "post",
    path: "/v1/internal/bounties/import",
    summary: "Import a bounty snapshot",
    responses: {
      200: { description: "Bounty snapshot imported" },
      401: { description: "Invalid internal token" },
    },
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "LoopOver API",
      version: "0.1.0",
      description: "Backend API for LoopOver advisory checks and Gittensor repository context.",
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
      LoopOverBearer: {
        type: "http",
        scheme: "bearer",
        description: "Static API/MCP token or GitHub device-flow LoopOver session token where supported. GitHub personal access tokens are not accepted.",
      },
      LoopOverSessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "loopover_session",
        description: "HttpOnly browser session cookie set by GitHub web OAuth.",
      },
    },
  };
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || !isProtectedPath(path)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = pathItem[method] as GeneratedOperation | undefined;
      if (operation) operation.security = [{ LoopOverBearer: [] }, { LoopOverSessionCookie: [] }];
    }
  }
  return document;
}

function isProtectedPath(path: string): boolean {
  if (path === "/health" || path === "/openapi.json" || path === "/mcp" || path === "/v1/mcp/compatibility" || path === "/v1/public/stats" || path === "/v1/public/github/repos/{owner}/{repo}/stats" || path === "/v1/public/repos/{owner}/{repo}/quality") return false;
  if (path.startsWith("/v1/auth/")) return path === "/v1/auth/github/token";
  if (path === "/v1/github/webhook") return false;
  return path.startsWith("/v1/");
}
