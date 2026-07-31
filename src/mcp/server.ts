import { createMcpHandler } from "agents/mcp";
import { instrumentToolDispatch, NOOP_DISPATCH_SINK, type DispatchTelemetrySink } from "./dispatch-telemetry";
import { createDispatchTelemetrySink, recordMcpInitialize, recordMcpToolsList } from "./dispatch-telemetry-sink";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
// #9517: the pilot tools' schemas come from the shared contract instead of being declared here, so there
// is one definition per tool rather than one per server.
//
// #9762: registerTool is handed the ZodObject, NOT its `.shape`. The SDK accepts either, but a raw shape is
// re-wrapped in a plain `z.object` that DISCARDS the catchall -- so a `looseObject` input would be advertised
// and enforced as `additionalProperties: false`, and every extra field the payload carries becomes a -32602
// the caller cannot act on. That is #9518's defect class. None of these inputs is loose today, which is
// precisely why the 23 sites that passed `.shape` were indistinguishable from the correct ones by reading;
// test/unit/mcp-register-tool-shape-guard.test.ts is what keeps them that way.
import {
  AdminGetConfigInput,
  AdminGetConfigOutput,
  AdminWriteConfigInput,
  AdminWriteConfigOutput,
  AdminListConfigBackupsInput,
  AdminListConfigBackupsOutput,
  AdminTriggerRedeployInput,
  LocalBranchAnalysisInput,
  RemoteLocalScorePreviewInput,
  MarkNotificationsReadInput,
  WatchIssuesInput,
  AdminRotateSecretInput,
  AdminRotateSecretOutput,
  AdminTriggerRedeployOutput,
  GetMaintainerNoiseInput,
  GetMaintainerNoiseOutput,
  GetAmsMinerCohortInput,
  GetAmsMinerCohortOutput,
  GetRepoFocusManifestInput,
  GetRepoFocusManifestOutput,
  RefreshRepoFocusManifestInput,
  RefreshRepoFocusManifestOutput,
  GetActivationPreviewInput,
  GetActivationPreviewOutput,
  GetLabelAuditInput,
  GetLabelAuditOutput,
  GetMaintainerLaneInput,
  GetMaintainerLaneOutput,
  GetRepoOnboardingPackInput,
  GetRepoOnboardingPackOutput,
  GetRegistrationReadinessInput,
  GetRegistrationReadinessOutput,
  GetConfigRecommendationInput,
  GetConfigRecommendationOutput,
  GetBurdenForecastInput,
  GetBurdenForecastOutput,
  GetRepoOutcomePatternsInput,
  GetRepoOutcomePatternsOutput,
  GetOutcomeCalibrationInput,
  GetOutcomeCalibrationOutput,
  GetGatePrecisionInput,
  GetGatePrecisionOutput,
  GetSelftuneOverrideAuditInput,
  GetSelftuneOverrideAuditOutput,
  ClearSelftuneOverrideInput,
  ClearSelftuneOverrideOutput,
  FileIncidentReportInput,
  FileIncidentReportOutput,
  SkippedPrAuditInput,
  SkippedPrAuditOutput,
  GetFleetAnalyticsInput,
  GetFleetAnalyticsOutput,
  GetRecommendationQualityInput,
  GetRecommendationQualityOutput,
  GetIssueQualityInput,
  GetIssueQualityOutput,
  GetLiveGateThresholdsInput,
  GetLiveGateThresholdsOutput,
  GetGateConfigEffectiveInput,
  GetGateConfigEffectiveOutput,
  GetRepoSettingsInput,
  GetRepoSettingsOutput,
  RefreshRepoDocsInput,
  RefreshRepoDocsOutput,
  GenerateContributorIssueDraftsInput,
  GenerateContributorIssueDraftsOutput,
  PlanRepoIssuesInput,
  PlanRepoIssuesOutput,
  ExplainGateDispositionInput,
  ExplainGateDispositionOutput,
  CheckSlopRiskInput,
  CheckSlopRiskOutput,
  CheckImprovementPotentialInput,
  CheckImprovementPotentialOutput,
  CheckTestEvidenceInput,
  CheckTestEvidenceOutput,
  CheckIssueSlopInput,
  CheckIssueSlopOutput,
  SuggestBoundaryTestsInput,
  SuggestBoundaryTestsOutput,
  PrOutcomeInput,
  PrOutcomeOutput,
  GetPrAiReviewFindingsInput,
  GetPrAiReviewFindingsOutput,
  GetPrMaintainerPacketInput,
  GetPrMaintainerPacketOutput,
  LintPrTextInput,
  LintPrTextOutput,
  ExplainScoreBreakdownOutput,
  ExplainReviewRiskInput,
  ExplainReviewRiskOutput,
  PreflightLocalDiffInput,
  PreflightLocalDiffOutput,
  RunLocalScorerInput,
  RunLocalScorerOutput,
  CompareLocalVariantsInput,
  ComparePrVariantsInput,
  CompareVariantsOutput,
  PreviewLocalPrScoreOutput,
  PreflightCurrentBranchOutput,
  PreviewCurrentBranchScoreOutput,
  RankLocalNextActionsOutput,
  ExplainLocalBlockersOutput,
  RemediationPlanOutput,
  PrepareLocalPrPacketOutput,
  DraftPrBodyOutput,
  AgentRunBundleOutput,
  GetPrReviewabilityInput,
  GetPrReviewabilityOutput,
  GetRepoContextInput,
  GetRepoContextOutput,
  PredictGateInput,
  PredictGateOutput,
  PreflightPrInput,
  PreflightPrOutput,
  SimulateOpenPrPressureOutput,
  GetContributorProfileInput,
  GetContributorProfileOutput,
  GetDecisionPackInput,
  GetDecisionPackOutput,
  MonitorOpenPrsInput,
  MonitorOpenPrsOutput,
  ExplainRepoDecisionInput,
  ExplainRepoDecisionOutput,
  GetBountyAdvisoryInput,
  GetBountyAdvisoryOutput,
  ListBountiesInput,
  ListBountiesOutput,
  GetBountyLifecycleInput,
  GetBountyLifecycleOutput,
  ValidateLinkedIssueInput,
  ValidateLinkedIssueOutput,
  CheckBeforeStartInput,
  CheckBeforeStartOutput,
  FindOpportunitiesInput,
  FindOpportunitiesOutput,
  RetrieveIssueContextInput,
  RetrieveIssueContextOutput,
  GetEligibilityPlanOutput,
  ListNotificationsInput,
  ListNotificationsOutput,
  MarkNotificationsReadOutput,
  WatchIssuesOutput,
  GetRegistryChangesInput,
  GetRegistryChangesOutput,
  GetRegistrySnapshotInput,
  GetRegistrySnapshotOutput,
  GetUpstreamDriftInput,
  GetUpstreamDriftOutput,
  GetUpstreamRulesetInput,
  GetUpstreamRulesetOutput,
  ValidateConfigInput,
  ValidateConfigOutput,
  LocalStatusInput,
  LocalStatusOutput,
  IntakeIdeaInput,
  IntakeIdeaOutput,
  PlanIdeaClaimsOutput,
  BuildResultsPayloadInput,
  BuildResultsPayloadOutput,
  BuildProgressSnapshotInput,
  BuildProgressSnapshotOutput,
  EvaluateEscalationInput,
  EvaluateEscalationOutput,
  LocalWriteActionOutput,
  OpenPrInput,
  FileIssueInput,
  ApplyLabelsInput,
  PostEligibilityCommentInput,
  PostSoftClaimInput,
  CreateBranchInput,
  DeleteBranchInput,
  GenerateTestsInput,
  FileFollowUpIssueInput,
  ClosePrInput,
  BuildPlanInput,
  PlanStatusInput,
  RecordStepResultInput,
  PlanViewOutput,
  GetAutomationStateInput,
  GetAutomationStateOutput,
  SetAgentPausedInput,
  SetAgentPausedOutput,
  SetActionAutonomyInput,
  SetActionAutonomyOutput,
  ProposeActionInput,
  ProposeActionOutput,
  ListPendingActionsInput,
  ListPendingActionsOutput,
  DecidePendingActionInput,
  DecidePendingActionOutput,
  GetAgentAuditFeedInput,
  GetAgentAuditFeedOutput,
  AgentPlanInput,
  AgentPlanNextWorkOutput,
  AgentExplainNextActionOutput,
  AgentStartRunInput,
  AgentGetRunInput,
  TOOL_CONTRACTS,
  getToolDefinition,
} from "@loopover/contract/tools";
import {
  OpsListDeadLetterJobsInput,
  OpsListDeadLetterJobsOutput,
  OpsReplayDeadLetterJobInput,
  OpsReplayDeadLetterJobOutput,
  OpsDeleteDeadLetterJobInput,
  OpsDeleteDeadLetterJobOutput,
  OpsPurgeDeadLetterJobsInput,
  OpsPurgeDeadLetterJobsOutput,
  OpsGetKillSwitchInput,
  OpsGetKillSwitchOutput,
  OpsSetKillSwitchInput,
  OpsSetKillSwitchOutput,
  OpsGetOperatorDashboardInput,
  OpsGetOperatorDashboardOutput,
  FleetListInstancesInput,
  FleetListInstancesOutput,
  FleetRegisterInstanceInput,
  FleetRegisterInstanceOutput,
  FleetListInstallationsInput,
  FleetListInstallationsOutput,
  FleetRegisterInstallationInput,
  FleetRegisterInstallationOutput,
  FleetBackfillInstallationsInput,
  FleetBackfillInstallationsOutput,
  FleetIssueEnrollmentInput,
  FleetRotateEnrollmentInput,
  FleetEnrollmentOutput,
  FleetRevokeEnrollmentInput,
  FleetRevokeEnrollmentOutput,
  AdminGetStatusInput,
  AdminGetStatusOutput,
  AdminDoctorInput,
  AdminDoctorOutput,
  AdminTailLogsInput,
  AdminTailLogsOutput,
  AdminGetBackupStatusInput,
  AdminGetBackupStatusOutput,
  FleetConfigPushInput,
  FleetConfigPushOutput,
  FleetRunJobInput,
  FleetRunJobOutput,
  TenantCreateInput,
  TenantCreateOutput,
  TenantListInput,
  TenantListOutput,
  TenantSetOrbInstallationInput,
  TenantSetOrbInstallationOutput,
  TenantDestroyInput,
  TenantDestroyOutput,
  AmsTenantHealthInput,
  AmsTenantHealthOutput,
  AmsTenantWakeInput,
  AmsTenantWakeOutput,
} from "@loopover/contract/tools";
import { TOOL_CATEGORIES, type McpInitializeTelemetry, type ToolCategory } from "@loopover/contract";
import {
  runFindOpportunities,
  validateFindOpportunitiesInput,
} from "./find-opportunities";
import { loadPrAiReviewFindings, assertContributorOwnsPullRequest } from "./pr-ai-review-findings";
import { sanitizeUntrustedMcpText } from "./untrusted-text";
import {
  runIssueRagRetrieval,
  validateIssueRagInput,
} from "./issue-rag";
import { recordMcpToolCall } from "./telemetry";
import {
  authenticatePrivateToken,
  extractBearerToken,
  isAuthorizedGitHubSessionLogin,
  isMcpActuationRepoAllowed,
  isMcpReadRepoAllowed,
  isMcpReadUnscoped,
  type AuthIdentity,
} from "../auth/security";
import { LATEST_RECOMMENDED_MCP_VERSION } from "../services/mcp-compatibility";
import { canLoginAccessRepo, canWatchRepo, loadControlPanelAccessScope, loadControlPanelRoleSummary, type ControlPanelAccessScope } from "../services/control-panel-roles";
import {
  countOpenIssues,
  countOpenPullRequests,
  createPendingAgentActionIfAbsent,
  getBounty,
  listBounties,
  listBountiesByRepo,
  listBountyLifecycleEvents,
  getContributorEvidence,
  getLatestRepoGithubTotalsSnapshot,
  getIssue,
  getPendingAgentAction,
  getPullRequest,
  getRepository,
  getRepositorySettings,
  getLatestUpstreamRulesetSnapshot,
  getRepoQueueTrendSnapshot,
  listAgentAuditEvents,
  listCheckSummaries,
  listPrVisibilitySkipAuditEvents,
  listPendingAgentActions,
  listContributorRepoStats,
  listContributorIssues,
  listContributorPullRequests,
  listIssueSignalSample,
  listIssues,
  deleteIssueWatchSubscription,
  listIssueWatchSubscriptionsForLogin,
  listNotificationDeliveriesForRecipient,
  upsertIssueWatchSubscription,
  upsertRepositorySettings,
  clearPullRequestsRegatedAtForOpenPrs,
  listOpenPullRequests,
  listPullRequests,
  listPullRequestFiles,
  listPullRequestReviews,
  listRecentMergedPullRequests,
  listSignalSnapshots,
  listRepoSyncSegments,
  listRepoSyncStates,
  listRepositories,
  markNotificationDeliveriesRead,
  recordAuditEvent,
  recordPostMergeIncidentReport,
  recordProductUsageEvent,
} from "../db/repositories";
import { decidePendingAgentAction } from "../services/agent-approval-queue";
import { automationStateSummary, buildAutomationState } from "../services/automation-state";
import { errorMessage, nowIso } from "../utils/json";
import { buildNotificationFeed } from "../notifications/service";
import { fetchGittensorContributorSnapshot } from "../gittensor/api";
import { getRepositoryCollaboratorPermission } from "../github/app";
import { performRepoDocRefresh } from "../github/repo-doc-refresh-runner";
import { generateContributorIssueDrafts } from "../services/contributor-issue-draft";
import { generateIssuePlanDrafts } from "../services/issue-plan-draft";
import { sanitizePublicComment } from "../github/commands";
import { fetchPublicContributorProfile } from "../github/public";
import { listLatestRegistrySnapshots, getLatestRegistrySnapshot } from "../registry/sync";
import { getOrCreateScoringModelSnapshot, isTimeDecayEnabled } from "../scoring/model";
import { buildScorePreview, makeScorePreviewRecord } from "../scoring/preview";
import {
  explainBlockersWithAgent,
  getAgentRunBundle,
  planNextWork,
  preparePrPacketWithAgent,
  startAgentRun,
} from "../services/agent-orchestrator";
import { authoritativeContributorRepoStats, loadContributorDecisionPackForServing, repoDecisionFromPack } from "../services/decision-pack";
import { buildPublicPrBodyDraft } from "../services/pr-body-draft";
import { buildRemediationPlan } from "../services/remediation-plan";
import { deriveEligibilityPlan } from "../services/eligibility-plan";
import { explainScoreBreakdown } from "../services/score-breakdown";
import { loadOrComputeIssueQualityResponse } from "../services/issue-quality";
import { loadCachedBurdenForecastResponse } from "../services/burden-forecast";
import { buildMcpClientTelemetry } from "../services/client-telemetry";
import { loadOrComputeRepoOutcomePatternsResponse } from "../services/repo-outcome-patterns";
import { buildRepoOutcomeCalibration, outcomeCalibrationSummary } from "../services/outcome-calibration";
import { buildRecommendationQualityReport } from "../services/recommendation-quality-report";
import { computeFleetAnalytics } from "../orb/analytics";
import { listFleetInstallations, listFleetInstances, registerFleetInstallation, registerFleetInstance } from "../orb/fleet-admin";
import { backfillOrbInstallations } from "../orb/installations";
import { pushFleetConfig } from "../orb/fleet-config-push";
import { createTenant, destroyTenant, getAmsTenantHealth, isControlPlaneConfigured, listTenants, setTenantOrbInstallation, wakeAmsTenant } from "../orb/control-plane-client";
import { processJob } from "../queue/job-dispatch";
import { backfillContributorGateHistory } from "../review/contributor-gate-history-backfill";
import { refreshInstallationHealth } from "../github/backfill";
import { INTERNAL_JOB_SPEC, type InternalJobName, type InternalJobRunMode } from "@loopover/contract/enums";
import type { JobMessage } from "../types";
import { ORB_SECRET_TYPE_GITHUB_TOKEN, isOrbBrokerEnabled, issueOrbEnrollment, revokeOrbEnrollment } from "../orb/broker";
import { loadMaintainerNoiseReport, maintainerNoiseSummary } from "../services/maintainer-noise";
import { buildAmsMinerCohortComparison } from "../review/ams-miner-cohort";
import { getConfigAdminFunctions } from "./private-config-admin-registry";
import { getRedeployTrigger, getSecretRotator } from "./redeploy-companion-registry";
import {
  getInstanceBackupStatusReader,
  getInstanceDoctorRunner,
  getInstanceLogTailer,
  getInstanceStatusReader,
} from "./instance-diagnostics-registry";
import { getLocalManifestReader } from "../signals/focus-manifest-loader";
import type { ConfigAdminScope } from "../selfhost/private-config";
import { buildMaintainerActivationPreview } from "../services/maintainer-activation";
import { loadLabelAudit, labelAuditSummary } from "../services/label-audit";
import { buildOperatorDashboardPayload, clampOperatorDashboardWindowDays } from "../services/operator-dashboard";
import {
  queueDeadLetterPageFromBinding,
  queueDeleteDeadLetterJobViaBinding,
  queuePurgeDeadLetterJobsViaBinding,
  queueReplayDeadLetterJobViaBinding,
} from "../selfhost/queue-common";
import { getGlobalAgentFrozenState, setGlobalAgentFrozen } from "../db/repositories";
import { loadMaintainerLaneReport, maintainerLaneSummary } from "../services/maintainer-lane";
import { buildRepoOnboardingPackPreviewForRepo } from "../services/repo-onboarding-pack";
import { buildRegistrationReadinessResponse, buildGittensorConfigRecommendationResponse } from "../api/routes";
import { loadGatePrecisionReport } from "../services/gate-precision";
import { buildUnavailableQueueTrendReport } from "../services/queue-trends";
import {
  applyMcpPlanningChoices,
  buildMcpPlanningElicitationAudit,
  buildMcpPlanningElicitationRequest,
  planningChoicesFromElicitationResult,
  validateMcpPlanningElicitationRequest,
  type McpPlanningChoices,
} from "../services/mcp-planning-elicitation";
import {
  buildBountyAdvisory,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildLaneAdvice,
  buildLinkedIssueValidation,
  buildLocalDiffPreflightResult,
  buildPreflightResult,
  buildPreStartCheck,
  buildPrTextLint,
  buildPullRequestMaintainerPacket,
  buildQueueHealth,
  buildRegistryChangeReport,
} from "../signals/engine";
import { skippedPrAuditRemediation, type PublicSurfaceSkipReason } from "../signals/settings-preview";
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildContributorPrOutcomes } from "../signals/contributor-pr-outcomes";
import { buildReviewRiskExplanation } from "../signals/review-risk";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../signals/local-branch";
import { computeLocalScorerTokens } from "../signals/local-scorer";
import { buildPullRequestReviewability, type PullRequestReviewability } from "../signals/reward-risk";
import {
  buildApplyLabelsSpec,
  buildClosePrSpec,
  buildCreateBranchSpec,
  buildDeleteBranchSpec,
  buildFileIssueSpec,
  buildFollowUpIssueSpec,
  buildOpenPrSpec,
  buildPostEligibilityCommentSpec,
  buildTestGenSpec,
  type LocalWriteActionSpec,
} from "./local-write-tools";
// #2315/#9492: buildSoftClaimSpec shipped in #2813 but was never registered as an MCP tool -- the exact
// silently-dead-feature shape this audit's check-dead-source-files.ts now guards against. Wired up here,
// following the identical local-write-tools pattern every sibling in this block already uses.
import { buildSoftClaimSpec } from "../miner/soft-claim";
import { buildTestEvidenceReport, } from "../signals/test-evidence";
import { applyStepResult, buildPlanDag, nextReadySteps, planProgress, validatePlanDag, type PlanDag } from "../services/plan-dag";
import { buildFocusManifestValidation } from "../services/focus-manifest-validation";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { isDuplicateWinnerEnabledGlobally, resolveDuplicateWinnerEnabled } from "../settings/duplicate-winner-mode";
import { compileFocusManifestPolicy } from "../signals/focus-manifest";
import { loadPublicRepoFocusManifest, loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildPredictedGateVerdict, buildGateDispositions, type PredictedGateVerdict } from "../rules/predicted-gate";
export { buildGateDispositions, type GateDisposition } from "../rules/predicted-gate";
import { buildIssueSlopAssessment } from "../signals/issue-slop";
import { buildSlopAssessment } from "../signals/slop";
import { validateIdeaSubmission, buildTaskGraph, buildClaimPlan } from "../idea-intake";
import { buildResultsPayload } from "../results-payload";
import { buildProgressSnapshot } from "../loop-progress";
import { evaluateEscalation } from "../loop-escalation";
import { buildStructuralImprovementAssessment } from "../signals/improvement";
import { buildBoundaryTestGenerationFinding, buildBoundaryTestGenerationSpec } from "../signals/boundary-test-generation";
import { attachDataQuality, buildRepoDataQuality } from "../signals/data-quality";
import { SCENARIO_MAX_REPO_FULL_NAME_CHARS } from "../scenarios/input-model";
import { loadUpstreamStatus } from "../upstream/ruleset";
import {
  authoritativeGateOverride,
  deleteLiveOverride,
  listOverrideAudit,
  loadOverride,
  loadShadowOverride,
  toLiveGateThresholdFields,
  type StorageEnv,
} from "../review/auto-apply";
import { simulateOpenPrPressure, type OpenPrPressureInput } from "../services/open-pr-pressure-scenarios";
import { buildFindingTaxonomyDocument, FINDING_TAXONOMY_URI } from "../review/finding-taxonomy";
import { buildEnrichmentAnalyzersTaxonomyDocument, ENRICHMENT_ANALYZERS_URI } from "../review/enrichment-analyzers-taxonomy";
import { recordPredictedGateCall } from "../review/predicted-gate-calls";
import { computeContributorCalibration } from "../review/predicted-gate-calibration-ledger";

type AppContext = Context<{ Bindings: Env }>;
type ToolPayload = {
  summary: string;
  data: Record<string, unknown>;
};
type McpToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function decisionPackSummary(login: string, freshness: string, rebuildEnqueued: boolean): string {
  if (freshness === "fresh") return `LoopOver decision pack for ${login}.`;
  if (rebuildEnqueued) return `LoopOver decision pack for ${login} (stale; background rebuild enqueued).`;
  return `LoopOver decision pack for ${login} (stale; rebuild not enqueued).`;
}










// #7721 admin tools — self-hosted-instance-only, gated behind LOOPOVER_MCP_ADMIN_ENABLED at
// registration and actor === "mcp-admin" at call time (see the tool descriptions and handlers below).
// Schemas for all four (#9518) come from @loopover/contract/tools -- AdminGetConfigInput,
// AdminWriteConfigInput, AdminListConfigBackupsInput, AdminTriggerRedeployInput.


// GitHub permissions that imply real write access to a repo. Cached PR author_association can report
// MEMBER/COLLABORATOR for users without push permission, so write-capable MCP surfaces must verify live.
const REPO_WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);





// #784 (MCP slice) — the agent audit feed: executed actions + approval decisions for a repo.







function contributorOpenIssueCount(issues: Array<{ repoFullName: string; state: string }>, repoFullName: string): number {
  const targetRepo = repoFullName.toLowerCase();
  return issues.filter((issue) => issue.repoFullName.toLowerCase() === targetRepo && issue.state === "open").length;
}






export const maintainerMeasurementReportOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  windowDays: z.number().nullable().optional(),
  slop: z.unknown().optional(),
  recommendations: z.unknown().optional(),
  signals: z.array(z.string()).optional(),
  status: z.string().optional(),
};

// #2220 - gate-precision measurement surfaced over MCP. Mirrors the
// maintainerMeasurementReportOutputSchema pattern: report fields optional, structured sub-reports as
// z.unknown() (buildGatePrecisionReport is the single source of truth for their shape).
export const gatePrecisionOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  windowDays: z.number().nullable().optional(),
  perGateType: z.array(z.unknown()).optional(),
  overall: z.unknown().optional(),
  signals: z.array(z.string()).optional(),
};



// Idea-intake bridge input (#4798, spec #4779). Fields are loose here so the engine's validateIdeaSubmission
// owns the real bounds/format checks and returns the actionable error list — an empty/malformed submission
// reaches the handler rather than being rejected upstream by the schema. `decomposition` is the optional
// renter-reviewed idea→issues split (the one fuzzy step, supplied in); omit it for the single-issue baseline.


// Claim-plan hand-off (#4799): same idea input, but the output is the loop disposition — which constituent
// issues the claim/code/submit loop can claim now vs. must defer or skip.

// Loop results-delivery input (#4801): a completed iteration's already-computed metadata.


// Loop progress-snapshot input (#4800): a running loop's already-computed state.


// Loop escalation evaluator input (#4806): an already-computed loop outcome + health tier + operator signals.









// #699 path B: a miner's self-scoped issue-watch subscriptions. `action` defaults to `list`; `watch`/`unwatch`
// require repoFullName. `labels` ([]/omitted = any) filters which new issues notify.



const SIMULATE_OPEN_PR_PRESSURE_MAX_COUNT = 1_000_000;
const simulateOpenPrPressureCountSchema = z.number().int().min(0).max(SIMULATE_OPEN_PR_PRESSURE_MAX_COUNT);
const simulateOpenPrPressureQueueHealthSchema = z
  .object({
    repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
    generatedAt: z.string().min(1).max(100),
    burdenScore: z.number().finite(),
    level: z.enum(["low", "medium", "high", "critical"]),
    summary: z.string().max(1_000),
    signals: z
      .object({
        openIssues: simulateOpenPrPressureCountSchema,
        openPullRequests: simulateOpenPrPressureCountSchema,
        unlinkedPullRequests: simulateOpenPrPressureCountSchema,
        stalePullRequests: simulateOpenPrPressureCountSchema,
        draftPullRequests: simulateOpenPrPressureCountSchema,
        maintainerAuthoredPullRequests: simulateOpenPrPressureCountSchema,
        collisionClusters: simulateOpenPrPressureCountSchema,
        ageBuckets: z
          .object({
            under7Days: simulateOpenPrPressureCountSchema,
            days7To30: simulateOpenPrPressureCountSchema,
            over30Days: simulateOpenPrPressureCountSchema,
          })
          .passthrough(),
        likelyReviewablePullRequests: simulateOpenPrPressureCountSchema,
        cachedOpenPullRequests: simulateOpenPrPressureCountSchema.optional(),
        likelyReviewablePullRequestsSource: z.enum(["cache", "sampled_cache", "authoritative"]).optional(),
      })
      .passthrough(),
    findings: z.array(z.unknown()).max(100),
  })
  .passthrough()
  .nullable();

// #2224 - pure, read-only open-PR pressure simulator surfaced over MCP. The simulator only reads
// bounded queue counts and maintainer-lane state, so validate those fields at the MCP boundary.
// #6751: exported so POST /v1/lint/open-pr-pressure parses with this EXACT shape rather than a second,
// drifting copy — the REST mirror and this tool can never diverge on what they accept.
export const simulateOpenPrPressureShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  generatedAt: z.string().min(1).max(100),
  queueHealth: simulateOpenPrPressureQueueHealthSchema,
  roleContext: z.object({ maintainerLane: z.boolean() }).passthrough(),
  contributorOpenPrCount: simulateOpenPrPressureCountSchema.optional(),
};

/**
 * The same shape as a schema, built ONCE (#9750).
 *
 * `POST /v1/lint/open-pr-pressure` used to call `z.object(simulateOpenPrPressureShape)` inside its handler,
 * so an identical schema was constructed on every request. Exported next to the shape it wraps, which also
 * leaves routes.ts with no request-schema literal of its own.
 */
export const simulateOpenPrPressureSchema = z.object(simulateOpenPrPressureShape);

export async function handleMcpRequest(c: AppContext): Promise<Response> {
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
  const identity = await authenticateMcpRequest(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);

  const telemetry = buildMcpClientTelemetry(c.req.raw.headers, { defaultClientName: "mcp" })!;
  // ONE clone-and-parse of the JSON-RPC body, here, BEFORE createMcpHandler below consumes it (#10190).
  // A second `request.clone()` after that point throws `TypeError: unusable` -- the Fetch spec forbids
  // cloning a request whose body is already disturbed -- which is why the post-response handshake read this
  // replaces turned every `initialize` into an unhandled 500.
  const envelope = await readMcpRequestEnvelope(c.req.raw);
  const usageMetadata = describeMcpUsageRequest(envelope, c.req.raw.method, telemetry.metadata);
  const startedAt = Date.now();
  const executionCtx = getExecutionContext(c);
  // #9525: the dispatch chokepoint's sink is built per request so its deferred work rides this
  // request's waitUntil. No OTel span on the Worker path -- the collector is a self-host concern, and
  // importing src/selfhost/otel.ts here would pull it into the Worker bundle.
  // #10175: session/server/client identity for PostHog's canonical $mcp_* events. `Mcp-Session-Id` is
  // what ties one client's handshake, tools/list, and subsequent tool calls into a single analyzable
  // session -- without it each event is an isolated row and no cross-event funnel works.
  const analyticsContext = {
    sessionId: trimmedHeader(c.req.raw.headers.get("mcp-session-id")),
    serverName: MCP_SERVER_NAME,
    serverVersion: LATEST_RECOMMENDED_MCP_VERSION,
    clientName: telemetry.clientName,
    clientVersion: telemetry.clientVersion,
  };
  const defer = (work: Promise<unknown>) => executionCtx.waitUntil(work);
  const mcp = new LoopoverMcp(c.env, identity, createDispatchTelemetrySink(c.env, defer, undefined, analyticsContext));
  const server = mcp.createServer();
  try {
    const response = await createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(c.req.raw, c.env, executionCtx);
    if (typeof usageMetadata.toolName === "string") {
      executionCtx.waitUntil(recordMcpToolTelemetry(c.env, usageMetadata.toolName, response.status < 400, Date.now() - startedAt));
    }
    // #10175: PostHog's canonical protocol-level events. Only on a request that actually succeeded, so
    // a rejected handshake never inflates the session/client counts.
    if (response.status < 400) {
      if (usageMetadata.rpcMethod === "initialize") {
        recordMcpInitialize(c.env, defer, readInitializeHandshake(envelope), analyticsContext);
      } else if (usageMetadata.rpcMethod === "tools/list") {
        // Names come from this server's own registration chokepoint, not the cross-server contract
        // registry, so the event reports what was actually advertised to THIS client.
        recordMcpToolsList(c.env, defer, mcp.registeredToolNames, analyticsContext);
      }
    }
    await recordProductUsageEvent(c.env, {
      surface: "mcp",
      role: "miner",
      eventName: typeof usageMetadata.toolName === "string" ? "mcp_tool_called" : "mcp_request",
      route: "/mcp",
      actor: identity.actor,
      sessionId: identity.kind === "session" ? identity.session.id : undefined,
      outcome: response.status >= 400 ? "error" : "success",
      latencyMs: Date.now() - startedAt,
      clientName: telemetry.clientName,
      clientVersion: telemetry.clientVersion,
      metadata: usageMetadata,
    }).catch(() => undefined);
    return response;
  } catch (error) {
    if (typeof usageMetadata.toolName === "string") {
      executionCtx.waitUntil(recordMcpToolTelemetry(c.env, usageMetadata.toolName, false, Date.now() - startedAt));
    }
    await recordProductUsageEvent(c.env, {
      surface: "mcp",
      role: "miner",
      eventName: typeof usageMetadata.toolName === "string" ? "mcp_tool_called" : "mcp_request",
      route: "/mcp",
      actor: identity.actor,
      sessionId: identity.kind === "session" ? identity.session.id : undefined,
      outcome: "error",
      latencyMs: Date.now() - startedAt,
      clientName: telemetry.clientName,
      clientVersion: telemetry.clientVersion,
      metadata: usageMetadata,
    }).catch(() => undefined);
    throw error;
  }
}

// Single chokepoint for the #6228 PostHog tool-call telemetry (#6237): every `tools/call` request that
// reaches handleMcpRequest routes through here exactly once, whether it succeeds or throws. Pure
// observability -- never lets a telemetry failure reach the caller, matching recordMcpToolCall's own
// no-op guarantee (#6235) with a second, defensive layer at the actual call site. Called sites pass the
// returned promise to `waitUntil` (#7233) rather than awaiting it inline, so a slow PostHog flush can't
// delay the MCP tool response.
async function recordMcpToolTelemetry(env: Env, tool: string, ok: boolean, durationMs: number): Promise<void> {
  try {
    await recordMcpToolCall(env, { tool, callerType: "remote", ok, durationMs });
  } catch {
    // Telemetry must never affect the tool response (#6237).
  }
}

function trimmedHeader(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Read the `clientInfo` an `initialize` request introduced itself with (#10175).
 *
 * Deliberately reads the JSON-RPC params rather than reusing the `x-loopover-mcp-*` headers
 * buildMcpClientTelemetry already parses: those are LoopOver's own convention, so only our published
 * client sets them and every third-party MCP client (Claude Code, Cursor, a raw SDK script) would
 * fall back to the "mcp" default and collapse into one indistinguishable bucket -- defeating the
 * whole point of the event. `clientInfo` is the MCP spec's own field, sent by every conformant
 * client. Returns an empty handshake for a malformed or absent body: the fields are optional by
 * contract, and a session that connected is still worth counting.
 */
function readInitializeHandshake(envelope: McpRequestEnvelope | null): McpInitializeTelemetry {
  const clientInfo = envelope?.params?.clientInfo;
  return {
    clientName: typeof clientInfo?.name === "string" ? clientInfo.name : undefined,
    clientVersion: typeof clientInfo?.version === "string" ? clientInfo.version : undefined,
  };
}

/** The JSON-RPC envelope fields the telemetry paths read. Deliberately structural and permissive: this is an
 *  unvalidated client body, and every consumer below re-checks the type of the field it uses. */
type McpRequestEnvelope = {
  method?: unknown;
  params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown } };
};

/** Clone-and-parse the request body exactly once, at the top of {@link handleMcpRequest} (#10190). Returns
 *  null for an absent or malformed body -- the telemetry fields are all optional by contract, and a request
 *  that is still worth counting must never be failed over its own instrumentation. */
async function readMcpRequestEnvelope(request: Request): Promise<McpRequestEnvelope | null> {
  const body = await request.clone().json().catch(() => null);
  return body && typeof body === "object" ? (body as McpRequestEnvelope) : null;
}

function describeMcpUsageRequest(
  envelope: McpRequestEnvelope | null,
  method: string,
  telemetryMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!envelope) return { transport: "http", method, ...telemetryMetadata };
  const rpcMethod = typeof envelope.method === "string" ? envelope.method : undefined;
  const toolName = envelope.params && typeof envelope.params.name === "string" ? envelope.params.name : undefined;
  return {
    transport: "http",
    rpcMethod,
    toolName,
    ...telemetryMetadata,
  };
}

// #6301 — coarse tool categories so tools/list clients and the `loopover-mcp tools` CLI can group this
// server's tool surface by the repo's own conceptual groupings instead of reading one flat list. Attached
// to each tool as MCP `_meta.category` at registration (see createServer).
//
// #9522: DERIVED from the contract registry, which already carries `category` on every entry. This was a
// hand-maintained 112-line name→category map next to a registry that said the same thing; the two happened
// to agree on every entry, but nothing made them, and the map had already fallen one tool behind
// (loopover_admin_rotate_secret, which #9518's migration missed and this issue brought into the registry).
//
// "admin" remains the one category whose tools are conditionally REGISTERED at all -- only when
// LOOPOVER_MCP_ADMIN_ENABLED is truthy (see isMcpAdminEnabled) -- where every other category's tools always
// exist and are gated purely by identity at call time.
export type McpToolCategory = ToolCategory;

// Canonical category order for grouped rendering (contributor-facing surfaces first, operator ones last),
// owned by the contract so no display consumer invents its own order.
export const MCP_TOOL_CATEGORY_IDS: readonly McpToolCategory[] = TOOL_CATEGORIES;

// An INDEX over the whole registry, not a list of what this server registers. It covers all three servers'
// tools because `locality` describes where a tool's work happens, not which server exposes it -- a dozen
// "local-git" tools are registered here as well as in the stdio CLI, so filtering on locality would drop
// their categories. Looking up a name this server never registers simply yields that tool's category.
export const MCP_TOOL_CATEGORIES: Record<string, McpToolCategory> = Object.fromEntries(
  TOOL_CONTRACTS.map((contract) => [contract.name, contract.category]),
);

/**
 * Every queue message `loopover_fleet_run_job` can send IS a real JobMessage type (#9522).
 *
 * The contract package cannot import src/, so INTERNAL_JOB_SPEC's messageType values are a transcription --
 * and a transcription of a message-type union is only safe if something on this side checks it. This
 * assignment is that check: a messageType that is not a JobMessage["type"] fails the build rather than
 * enqueuing a message the dispatcher silently drops. `null` is allowed and means the job is run-only.
 */
const _INTERNAL_JOB_MESSAGE_TYPES_ARE_REAL: readonly (JobMessage["type"] | null)[] = Object.values(INTERNAL_JOB_SPEC).map(
  (spec) => spec.messageType,
);
void _INTERNAL_JOB_MESSAGE_TYPES_ARE_REAL;

/** Master opt-in for the "admin" tool category (#7721), default OFF. Same truthy-string convention as every
 *  other LOOPOVER_* flag in this repo. Gates tool REGISTRATION in createServer() below; each admin tool
 *  handler additionally requires actor === "mcp-admin" at call time regardless of this flag. Exported so the
 *  `.well-known` discovery routes (#10039) can mirror this exact registration gate instead of growing a
 *  second copy of the truthy-string regex. */
export function isMcpAdminEnabled(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_MCP_ADMIN_ENABLED ?? "").trim());
}

/** The MCP `serverInfo.name` this server reports, and the `$mcp_server_name` its analytics carry.
 *  One constant so the handshake a client sees and the dashboards an operator reads can never
 *  disagree about what this server is called. Module-local: both readers (the handshake's serverInfo and
 *  the analytics property builder) live in this file, and #10177 exported it without a consumer outside it. */
const MCP_SERVER_NAME = "loopover";

export class LoopoverMcp {
  private accessScopePromise: Promise<ControlPanelAccessScope> | null = null;

  constructor(
    private readonly env: Env,
    private readonly identity: AuthIdentity = { kind: "static", actor: "mcp" },
    // #9525: injected rather than constructed here so the Worker bundle never pulls the self-host
    // OTel module in, and so a test can drive the chokepoint without a PostHog client.
    private readonly telemetrySink?: DispatchTelemetrySink,
  ) {}

  /** Tool names this server actually advertised, in registration order (#10175). Populated by the
   *  `register` wrapper below so `$mcp_tools_list` reports what THIS server exposes rather than the
   *  whole cross-server contract registry. */
  readonly registeredToolNames: string[] = [];

  createServer(): McpServer {
    const server = new McpServer({
      name: MCP_SERVER_NAME,
      // #9526: derived, not a hand-bumped constant. LATEST_RECOMMENDED_MCP_VERSION already reads
      // @loopover/mcp's package.json, which the release automation owns -- so serverInfo, the compatibility
      // metadata, the server card, and server.json all report the one version that actually shipped.
      version: LATEST_RECOMMENDED_MCP_VERSION,
    });

    // #6301 — register every tool through this thin wrapper so its category rides along as MCP
    // `_meta.category`, exposed in tools/list for clients (and mirrored by the CLI `tools` command).
    // #9525: and through the dispatch-telemetry chokepoint, so all ~116 handlers are instrumented
    // in one place rather than individually. `instrumentToolDispatch` is a safe passthrough when
    // nothing is configured, which is every deployment that has not opted in.
    const baseRegister = server.registerTool.bind(server);
    const telemetrySink = this.telemetrySink ?? NOOP_DISPATCH_SINK;
    // #9655/#9656: everything ADVERTISED comes from the contract's projection, spread AFTER the call
    // site's config so a stray literal cannot win. Descriptions used to be written out per call site
    // and 35 had drifted from the contract's -- which is what `listToolDefinitions()` serves to the
    // agent-spec builders and the `.well-known` catalogs, so one tool was described two different ways
    // depending on which LoopOver surface you asked. Annotations were absent entirely, so a client that
    // gates confirmation on `destructiveHint` saw nothing for `loopover_delete_branch`.
    const register: McpServer["registerTool"] = (name, config, cb) => {
      this.registeredToolNames.push(name);
      const advertised = getToolDefinition(name);
      /* v8 ignore next 2 -- unreachable while validate-mcp's "nothing registers without a contract
         entry" assertion holds; this throw is what keeps it unreachable. */
      if (!advertised) throw new Error(`No @loopover/contract entry for remote tool: ${name}`);
      return baseRegister(
        name,
        {
          ...config,
          title: advertised.title,
          description: advertised.description,
          annotations: advertised.annotations,
          _meta: { category: advertised.category },
        },
        instrumentToolDispatch(name, telemetrySink, cb as (...args: unknown[]) => Promise<{ isError?: boolean; structuredContent?: unknown }>) as typeof cb,
      );
    };

    register(
      "loopover_get_repo_context",
      {
        inputSchema: GetRepoContextInput,
        outputSchema: GetRepoContextOutput,
      },
      async (input) => this.toolResult(await this.getRepoContext(input)),
    );

    register(
      "loopover_get_maintainer_noise",
      {
        inputSchema: GetMaintainerNoiseInput,
        outputSchema: GetMaintainerNoiseOutput,
      },
      async (input) => this.toolResult(await this.getMaintainerNoise(input)),
    );

    register(
      "loopover_get_ams_miner_cohort",
      {
        inputSchema: GetAmsMinerCohortInput,
        outputSchema: GetAmsMinerCohortOutput,
      },
      async (input) => this.toolResult(await this.getAmsMinerCohort(input)),
    );

    register(
      "loopover_get_repo_focus_manifest",
      {
        inputSchema: GetRepoFocusManifestInput,
        outputSchema: GetRepoFocusManifestOutput,
      },
      async (input) => this.toolResult(await this.getRepoFocusManifest(input)),
    );

    register(
      "loopover_refresh_repo_focus_manifest",
      {
        inputSchema: RefreshRepoFocusManifestInput,
        outputSchema: RefreshRepoFocusManifestOutput,
      },
      async (input) => this.toolResult(await this.refreshRepoFocusManifest(input)),
    );

    register(
      "loopover_get_activation_preview",
      {
        inputSchema: GetActivationPreviewInput,
        outputSchema: GetActivationPreviewOutput,
      },
      async (input) => this.toolResult(await this.getActivationPreview(input)),
    );

    register(
      "loopover_get_label_audit",
      {
        inputSchema: GetLabelAuditInput,
        outputSchema: GetLabelAuditOutput,
      },
      async (input) => this.toolResult(await this.getLabelAudit(input)),
    );

    register(
      "loopover_get_maintainer_lane",
      {
        inputSchema: GetMaintainerLaneInput,
        outputSchema: GetMaintainerLaneOutput,
      },
      async (input) => this.toolResult(await this.getMaintainerLane(input)),
    );

    register(
      "loopover_get_repo_onboarding_pack",
      {
        inputSchema: GetRepoOnboardingPackInput,
        outputSchema: GetRepoOnboardingPackOutput,
      },
      async (input) => this.toolResult(await this.getRepoOnboardingPack(input)),
    );

    register(
      "loopover_get_registration_readiness",
      {
        inputSchema: GetRegistrationReadinessInput,
        outputSchema: GetRegistrationReadinessOutput,
      },
      async (input) => this.toolResult(await this.getRegistrationReadiness(input)),
    );

    register(
      "loopover_get_config_recommendation",
      {
        inputSchema: GetConfigRecommendationInput,
        outputSchema: GetConfigRecommendationOutput,
      },
      async (input) => this.toolResult(await this.getConfigRecommendation(input)),
    );

    register(
      "loopover_get_burden_forecast",
      {
        inputSchema: GetBurdenForecastInput,
        outputSchema: GetBurdenForecastOutput,
      },
      async (input) => this.toolResult(await this.getBurdenForecast(input)),
    );

    register(
      "loopover_get_repo_outcome_patterns",
      {
        inputSchema: GetRepoOutcomePatternsInput,
        outputSchema: GetRepoOutcomePatternsOutput,
      },
      async (input) => this.toolResult(await this.getRepoOutcomePatterns(input)),
    );

    register(
      "loopover_get_outcome_calibration",
      {
        inputSchema: GetOutcomeCalibrationInput,
        outputSchema: GetOutcomeCalibrationOutput,
      },
      async (input) => this.toolResult(await this.getOutcomeCalibration(input)),
    );

    register(
      "loopover_get_gate_precision",
      {
        inputSchema: GetGatePrecisionInput,
        outputSchema: GetGatePrecisionOutput,
      },
      async (input) => this.toolResult(await this.getGatePrecision(input)),
    );

    register(
      "loopover_get_selftune_override_audit",
      {
        inputSchema: GetSelftuneOverrideAuditInput,
        outputSchema: GetSelftuneOverrideAuditOutput,
      },
      async (input) => this.toolResult(await this.getSelftuneOverrideAudit(input)),
    );

    // (#8660) write-side counterpart to loopover_get_selftune_override_audit: the missing MCP mirror of
    // DELETE /v1/repos/:owner/:repo/selftune/overrides. Maintainer-manage access required, same as the other
    // maintainer-mutation tools (loopover_set_agent_paused/loopover_set_action_autonomy/loopover_decide_pending_action).
    register(
      "loopover_clear_selftune_override",
      {
        inputSchema: ClearSelftuneOverrideInput,
        outputSchema: ClearSelftuneOverrideOutput,
      },
      async (input) => this.toolResult(await this.clearSelftuneOverride(input)),
    );

    // (#9298) MCP mirror of POST /v1/repos/:owner/:repo/pulls/:number/incident-reports (#5672): the missing
    // write tool next to the already-wrapped PR read surfaces (maintainer-packet, reviewability). Same
    // maintainer-manage boundary and recordPostMergeIncidentReport persistence path as the REST route.
    register(
      "loopover_file_incident_report",
      {
        inputSchema: FileIncidentReportInput,
        outputSchema: FileIncidentReportOutput,
      },
      async (input) => this.toolResult(await this.fileIncidentReport(input)),
    );

    register(
      "loopover_get_skipped_pr_audit",
      {
        inputSchema: SkippedPrAuditInput,
        outputSchema: SkippedPrAuditOutput,
      },
      async (input) => this.toolResult(await this.getSkippedPrAudit(input)),
    );

    register(
      "loopover_get_fleet_analytics",
      {
        inputSchema: GetFleetAnalyticsInput,
        outputSchema: GetFleetAnalyticsOutput,
      },
      async (input) => this.toolResult(await this.getFleetAnalytics(input)),
    );

    register(
      "loopover_get_recommendation_quality",
      {
        inputSchema: GetRecommendationQualityInput,
        outputSchema: GetRecommendationQualityOutput,
      },
      async (input) => this.toolResult(await this.getRecommendationQuality(input)),
    );

    register(
      "loopover_simulate_open_pr_pressure",
      {
        inputSchema: simulateOpenPrPressureShape,
        outputSchema: SimulateOpenPrPressureOutput,
      },
      async (input) => this.toolResult(this.simulateOpenPrPressureTool(input)),
    );

    register(
      "loopover_get_contributor_profile",
      {
        inputSchema: GetContributorProfileInput,
        outputSchema: GetContributorProfileOutput,
      },
      async (input) => this.toolResult(await this.getContributorProfile(input.login)),
    );

    register(
      "loopover_get_decision_pack",
      {
        inputSchema: GetDecisionPackInput,
        outputSchema: GetDecisionPackOutput,
      },
      async (input) => this.toolResult(await this.getDecisionPack(input.login)),
    );

    register(
      "loopover_monitor_open_prs",
      {
        inputSchema: MonitorOpenPrsInput,
        outputSchema: MonitorOpenPrsOutput,
      },
      async (input) => this.toolResult(await this.monitorOpenPullRequests(input.login)),
    );

    register(
      "loopover_predict_gate",
      {
        inputSchema: PredictGateInput,
        outputSchema: PredictGateOutput,
      },
      async (input) => this.toolResult(await this.predictGate(input)),
    );

    register(
      "loopover_explain_gate_disposition",
      {
        inputSchema: ExplainGateDispositionInput,
        outputSchema: ExplainGateDispositionOutput,
      },
      async (input) => this.toolResult(await this.explainGateDisposition(input)),
    );

    register(
      "loopover_intake_idea",
      {
        inputSchema: IntakeIdeaInput,
        outputSchema: IntakeIdeaOutput,
      },
      async (input) => this.toolResult(await this.intakeIdea(input)),
    );

    register(
      "loopover_plan_idea_claims",
      {
        inputSchema: IntakeIdeaInput,
        outputSchema: PlanIdeaClaimsOutput,
      },
      async (input) => this.toolResult(await this.planIdeaClaims(input)),
    );

    register(
      "loopover_build_results_payload",
      {
        inputSchema: BuildResultsPayloadInput,
        outputSchema: BuildResultsPayloadOutput,
      },
      async (input) => this.toolResult(await this.buildLoopResults(input)),
    );

    register(
      "loopover_build_progress_snapshot",
      {
        inputSchema: BuildProgressSnapshotInput,
        outputSchema: BuildProgressSnapshotOutput,
      },
      async (input) => this.toolResult(await this.buildLoopProgress(input)),
    );

    register(
      "loopover_evaluate_escalation",
      {
        inputSchema: EvaluateEscalationInput,
        outputSchema: EvaluateEscalationOutput,
      },
      async (input) => this.toolResult(await this.evalEscalation(input)),
    );

    register(
      "loopover_check_slop_risk",
      {
        inputSchema: CheckSlopRiskInput,
        outputSchema: CheckSlopRiskOutput,
      },
      async (input) => this.toolResult(await this.checkSlopRisk(input)),
    );

    register(
      "loopover_check_improvement_potential",
      {
        inputSchema: CheckImprovementPotentialInput,
        outputSchema: CheckImprovementPotentialOutput,
      },
      async (input) => this.toolResult(await this.checkImprovementPotential(input)),
    );

    register(
      "loopover_check_test_evidence",
      {
        inputSchema: CheckTestEvidenceInput,
        outputSchema: CheckTestEvidenceOutput,
      },
      async (input) => this.toolResult(await this.checkTestEvidence(input)),
    );

    register(
      "loopover_check_issue_slop",
      {
        inputSchema: CheckIssueSlopInput,
        outputSchema: CheckIssueSlopOutput,
      },
      async (input) => this.toolResult(await this.checkIssueSlop(input)),
    );

    register(
      "loopover_suggest_boundary_tests",
      {
        inputSchema: SuggestBoundaryTestsInput,
        outputSchema: SuggestBoundaryTestsOutput,
      },
      async (input) => this.toolResult(this.suggestBoundaryTests(input)),
    );

    register(
      "loopover_pr_outcome",
      {
        inputSchema: PrOutcomeInput,
        outputSchema: PrOutcomeOutput,
      },
      async (input) => this.toolResult(await this.prOutcomes(input.login, input.limit)),
    );

    register(
      "loopover_get_pr_ai_review_findings",
      {
        inputSchema: GetPrAiReviewFindingsInput,
        outputSchema: GetPrAiReviewFindingsOutput,
      },
      async (input) => this.toolResult(await this.getPrAiReviewFindings(input)),
    );

    register(
      "loopover_list_notifications",
      {
        inputSchema: ListNotificationsInput,
        outputSchema: ListNotificationsOutput,
      },
      async (input) => this.toolResult(await this.listNotifications(input.login)),
    );

    register(
      "loopover_mark_notifications_read",
      {
        inputSchema: MarkNotificationsReadInput,
        outputSchema: MarkNotificationsReadOutput,
      },
      async (input) => this.toolResult(await this.markNotificationsRead(input.login, input.ids)),
    );

    register(
      "loopover_watch_issues",
      {
        inputSchema: WatchIssuesInput,
        outputSchema: WatchIssuesOutput,
      },
      async (input) => this.toolResult(await this.watchIssues(input)),
    );

    register(
      "loopover_explain_repo_decision",
      {
        inputSchema: ExplainRepoDecisionInput,
        outputSchema: ExplainRepoDecisionOutput,
      },
      async (input) => this.toolResult(await this.explainRepoDecision(input)),
    );

    register(
      "loopover_preflight_pr",
      {
        inputSchema: PreflightPrInput,
        outputSchema: PreflightPrOutput,
      },
      async (input) => this.toolResult(await this.preflightPr(input)),
    );

    register(
      "loopover_get_bounty_advisory",
      {
        inputSchema: GetBountyAdvisoryInput,
        outputSchema: GetBountyAdvisoryOutput,
      },
      async (input) => this.toolResult(await this.getBountyAdvisory(input.id)),
    );

    register(
      "loopover_list_bounties",
      {
        inputSchema: ListBountiesInput,
        outputSchema: ListBountiesOutput,
      },
      async () => this.toolResult(await this.getBountyList()),
    );

    register(
      "loopover_get_bounty_lifecycle",
      {
        inputSchema: GetBountyLifecycleInput,
        outputSchema: GetBountyLifecycleOutput,
      },
      async (input) => this.toolResult(await this.getBountyLifecycle(input.id)),
    );

    register(
      "loopover_get_registry_changes",
      {
        inputSchema: GetRegistryChangesInput,
        outputSchema: GetRegistryChangesOutput,
      },
      async () => this.toolResult(await this.getRegistryChanges()),
    );

    register(
      "loopover_get_registry_snapshot",
      {
        inputSchema: GetRegistrySnapshotInput,
        outputSchema: GetRegistrySnapshotOutput,
      },
      async () => this.toolResult(await this.getRegistrySnapshot()),
    );

    register(
      "loopover_get_upstream_drift",
      {
        inputSchema: GetUpstreamDriftInput,
        outputSchema: GetUpstreamDriftOutput,
      },
      async () => this.toolResult(await this.getUpstreamDrift()),
    );

    register(
      "loopover_get_upstream_ruleset",
      {
        inputSchema: GetUpstreamRulesetInput,
        outputSchema: GetUpstreamRulesetOutput,
      },
      async () => this.toolResult(await this.getUpstreamRuleset()),
    );

    register(
      "loopover_get_issue_quality",
      {
        inputSchema: GetIssueQualityInput,
        outputSchema: GetIssueQualityOutput,
      },
      async (input) => this.toolResult(await this.getIssueQuality(input)),
    );

    register(
      "loopover_get_pr_reviewability",
      {
        inputSchema: GetPrReviewabilityInput,
        outputSchema: GetPrReviewabilityOutput,
      },
      async (input) => this.toolResult(await this.getPrReviewability(input)),
    );

    register(
      "loopover_get_pr_maintainer_packet",
      {
        inputSchema: GetPrMaintainerPacketInput,
        outputSchema: GetPrMaintainerPacketOutput,
      },
      async (input) => this.toolResult(await this.getPrMaintainerPacket(input)),
    );

    register(
      "loopover_get_live_gate_thresholds",
      {
        inputSchema: GetLiveGateThresholdsInput,
        outputSchema: GetLiveGateThresholdsOutput,
      },
      async (input) => this.toolResult(await this.getLiveGateThresholds(input)),
    );

    register(
      "loopover_get_gate_config_effective",
      {
        inputSchema: GetGateConfigEffectiveInput,
        outputSchema: GetGateConfigEffectiveOutput,
      },
      async (input) => this.toolResult(await this.getGateConfigEffective(input)),
    );

    // #9297: the last unmirrored read in the settings/automation-state/gate-config-effective trio. Mirrors
    // GET /v1/repos/:owner/:repo/settings -- the RAW effective settings row those two derived views compute
    // from, which /settings deliberately returns on its own. Maintainer-only, same shape as
    // loopover_get_automation_state.
    register(
      "loopover_get_repo_settings",
      {
        inputSchema: GetRepoSettingsInput,
        outputSchema: GetRepoSettingsOutput,
      },
      async (input) => this.toolResult(await this.getRepoSettings(input)),
    );

    register(
      "loopover_validate_linked_issue",
      {
        inputSchema: ValidateLinkedIssueInput,
        outputSchema: ValidateLinkedIssueOutput,
      },
      async (input) => this.toolResult(await this.validateLinkedIssue(input)),
    );

    register(
      "loopover_check_before_start",
      {
        inputSchema: CheckBeforeStartInput,
        outputSchema: CheckBeforeStartOutput,
      },
      async (input) => this.toolResult(await this.checkBeforeStart(input)),
    );

    register(
      "loopover_find_opportunities",
      {
        inputSchema: FindOpportunitiesInput,
        outputSchema: FindOpportunitiesOutput,
      },
      async (input) => this.toolResult(await this.findOpportunities(input)),
    );

    register(
      "loopover_retrieve_issue_context",
      {
        inputSchema: RetrieveIssueContextInput,
        outputSchema: RetrieveIssueContextOutput,
      },
      async (input) => this.toolResult(await this.retrieveIssueContext(input)),
    );

    register(
      "loopover_lint_pr_text",
      {
        inputSchema: LintPrTextInput,
        outputSchema: LintPrTextOutput,
      },
      async (input) => this.toolResult(this.lintPrText(input)),
    );

    register(
      "loopover_validate_config",
      {
        inputSchema: ValidateConfigInput,
        outputSchema: ValidateConfigOutput,
      },
      async (input) => this.toolResult(this.validateConfig(input)),
    );

    register(
      "loopover_preflight_local_diff",
      {
        inputSchema: PreflightLocalDiffInput,
        outputSchema: PreflightLocalDiffOutput,
      },
      async (input) => this.toolResult(await this.preflightLocalDiff(input)),
    );

    register(
      "loopover_preview_local_pr_score",
      {
        inputSchema: RemoteLocalScorePreviewInput,
        outputSchema: PreviewLocalPrScoreOutput,
      },
      async (input) => this.toolResult(await this.previewScore(input)),
    );

    register(
      "loopover_get_eligibility_plan",
      {
        inputSchema: RemoteLocalScorePreviewInput,
        outputSchema: GetEligibilityPlanOutput,
      },
      async (input) => this.toolResult(await this.getEligibilityPlan(input)),
    );

    register(
      "loopover_run_local_scorer",
      {
        inputSchema: RunLocalScorerInput,
        outputSchema: RunLocalScorerOutput,
      },
      async (input) => this.toolResult(this.runLocalScorer(input)),
    );

    // #780 miner write-tools — each returns a LOCAL-execution action spec; loopover never performs the write.
    register(
      "loopover_open_pr",
      { inputSchema: OpenPrInput, outputSchema: LocalWriteActionOutput },
      async (input) => this.toolResult(this.localWriteSpec(buildOpenPrSpec(input))),
    );
    register(
      "loopover_file_issue",
      { inputSchema: FileIssueInput, outputSchema: LocalWriteActionOutput },
      async (input) => this.toolResult(this.localWriteSpec(buildFileIssueSpec(input))),
    );
    register(
      "loopover_apply_labels",
      { inputSchema: ApplyLabelsInput, outputSchema: LocalWriteActionOutput },
      async (input) => this.toolResult(this.localWriteSpec(buildApplyLabelsSpec(input))),
    );
    register(
      "loopover_post_eligibility_comment",
      { inputSchema: PostEligibilityCommentInput, outputSchema: LocalWriteActionOutput },
      async (input) => this.toolResult(this.localWriteSpec(buildPostEligibilityCommentSpec(input))),
    );
    register(
      "loopover_post_soft_claim",
      {
        inputSchema: PostSoftClaimInput,
        outputSchema: LocalWriteActionOutput,
      },
      async (input) => this.toolResult(this.localWriteSpec(buildSoftClaimSpec(input))),
    );
    register(
      "loopover_create_branch",
      { inputSchema: CreateBranchInput, outputSchema: LocalWriteActionOutput },
      async (input) => this.toolResult(this.localWriteSpec(buildCreateBranchSpec(input))),
    );
    register(
      "loopover_delete_branch",
      { inputSchema: DeleteBranchInput, outputSchema: LocalWriteActionOutput },
      async (input) => this.toolResult(this.localWriteSpec(buildDeleteBranchSpec(input))),
    );
    register(
      "loopover_generate_tests",
      {
        inputSchema: GenerateTestsInput,
        outputSchema: LocalWriteActionOutput,
      },
      async (input) => this.toolResult(this.localWriteSpec(buildTestGenSpec(input))),
    );
    register(
      "loopover_file_follow_up_issue",
      {
        inputSchema: FileFollowUpIssueInput,
        outputSchema: LocalWriteActionOutput,
      },
      async (input) => this.toolResult(this.localWriteSpec(buildFollowUpIssueSpec(input))),
    );
    register(
      "loopover_close_pr",
      { inputSchema: ClosePrInput, outputSchema: LocalWriteActionOutput },
      async (input) => this.toolResult(this.localWriteSpec(buildClosePrSpec(input))),
    );

    // #783 multi-step plan DAG — stateless: pass the plan back each call.
    register(
      "loopover_build_plan",
      { inputSchema: BuildPlanInput, outputSchema: PlanViewOutput },
      async (input) => this.toolResult(this.buildPlan(input)),
    );
    register(
      "loopover_plan_status",
      { inputSchema: PlanStatusInput, outputSchema: PlanViewOutput },
      async (input) => this.toolResult(this.planStatusTool(input)),
    );
    register(
      "loopover_record_step_result",
      { inputSchema: RecordStepResultInput, outputSchema: PlanViewOutput },
      async (input) => this.toolResult(this.recordStepResult(input)),
    );

    // #784 (MCP control surface, read side): a repo's agent automation posture — autonomy dial, kill-switch /
    // dry-run mode, write-permission readiness, and the pending-approval count. Repo-access scoped.
    register(
      "loopover_get_automation_state",
      {
        inputSchema: GetAutomationStateInput,
        outputSchema: GetAutomationStateOutput,
      },
      async (input) => this.toolResult(await this.getAutomationState(input)),
    );

    // #6087 (MCP control surface, write side): the missing MCP counterpart to `maintain pause`/`resume`
    // (loopover-mcp.js:1783). Maintainer-manage access required, same as loopover_propose_action.
    register(
      "loopover_set_agent_paused",
      {
        inputSchema: SetAgentPausedInput,
        outputSchema: SetAgentPausedOutput,
      },
      async (input) => this.toolResult(await this.setAgentPaused(input)),
    );

    // #6087 (MCP control surface, write side): the missing MCP counterpart to `maintain set-level`
    // (loopover-mcp.js:1789). Maintainer-manage access required, same as loopover_propose_action.
    register(
      "loopover_set_action_autonomy",
      {
        inputSchema: SetActionAutonomyInput,
        outputSchema: SetActionAutonomyOutput,
      },
      async (input) => this.toolResult(await this.setActionAutonomy(input)),
    );

    register(
      "loopover_propose_action",
      {
        inputSchema: ProposeActionInput,
        outputSchema: ProposeActionOutput,
      },
      async (input) => this.toolResult(await this.proposeAction(input)),
    );

    register(
      "loopover_list_pending_actions",
      {
        inputSchema: ListPendingActionsInput,
        outputSchema: ListPendingActionsOutput,
      },
      async (input) => this.toolResult(await this.listPendingActions(input)),
    );

    register(
      "loopover_decide_pending_action",
      {
        inputSchema: DecidePendingActionInput,
        outputSchema: DecidePendingActionOutput,
      },
      async (input) => this.toolResult(await this.decidePendingAction(input)),
    );

    register(
      "loopover_refresh_repo_docs",
      {
        inputSchema: RefreshRepoDocsInput,
        outputSchema: RefreshRepoDocsOutput,
      },
      async (input) => this.toolResult(await this.refreshRepoDocs(input)),
    );

    register(
      "loopover_generate_contributor_issue_drafts",
      {
        inputSchema: GenerateContributorIssueDraftsInput,
        outputSchema: GenerateContributorIssueDraftsOutput,
      },
      async (input) => this.toolResult(await this.generateContributorIssueDrafts(input)),
    );

    register(
      "loopover_plan_repo_issues",
      {
        inputSchema: PlanRepoIssuesInput,
        outputSchema: PlanRepoIssuesOutput,
      },
      async (input) => this.toolResult(await this.planRepoIssues(input)),
    );

    register(
      "loopover_get_agent_audit_feed",
      {
        inputSchema: GetAgentAuditFeedInput,
        outputSchema: GetAgentAuditFeedOutput,
      },
      async (input) => this.toolResult(await this.getAgentAuditFeed(input)),
    );

    register(
      "loopover_explain_score_breakdown",
      {
        // #9518: the OUTPUT schema is the contract's, but the input keeps this server's own
        // scorePreviewShape rather than ExplainScoreBreakdownInput.shape. The difference is
        // callerBranchEligibilitySchema's `.transform()`, which downgrades a caller-claimed
        // "eligible" to "unknown" and forces source:"user_supplied" -- a caller must not be able to
        // assert its own eligibility into the score. A transform is a runtime coercion, so it
        // cannot live in a shared contract whose whole job is to describe the wire shape a caller
        // may send; relocating the input would have silently dropped that downgrade. The contract's
        // ExplainScoreBreakdownInput documents the pre-transform wire shape, which is what the
        // advertised inputSchema should say.
        inputSchema: RemoteLocalScorePreviewInput,
        outputSchema: ExplainScoreBreakdownOutput,
      },
      async (input) => this.toolResult(await this.explainScoreBreakdown(input)),
    );

    register(
      "loopover_explain_review_risk",
      {
        inputSchema: ExplainReviewRiskInput,
        outputSchema: ExplainReviewRiskOutput,
      },
      async (input) => this.toolResult(await this.explainReviewRisk(input)),
    );

    register(
      "loopover_compare_pr_variants",
      {
        inputSchema: ComparePrVariantsInput,
        outputSchema: CompareVariantsOutput,
      },
      async (input) => this.toolResult(await this.comparePrVariants(input.variants)),
    );

    register(
      "loopover_local_status",
      {
        inputSchema: LocalStatusInput,
        outputSchema: LocalStatusOutput,
      },
      async () =>
        this.toolResult({
          summary: "LoopOver local MCP status.",
          data: {
            apiAvailable: true,
            sourceUploadDefault: false,
            supportedEndpoint: "/v1/local/branch-analysis",
            supportedTools: [
              "loopover_get_decision_pack",
              "loopover_explain_repo_decision",
              "loopover_get_upstream_drift",
              "loopover_preflight_current_branch",
              "loopover_preview_current_branch_score",
              "loopover_rank_local_next_actions",
              "loopover_compare_local_variants",
              "loopover_explain_local_blockers",
              "loopover_prepare_pr_packet",
            ],
          },
        }),
    );

    register(
      "loopover_preflight_current_branch",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: PreflightCurrentBranchOutput,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "preflight")),
    );

    register(
      "loopover_preview_current_branch_score",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: PreviewCurrentBranchScoreOutput,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scorePreview")),
    );

    register(
      "loopover_rank_local_next_actions",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: RankLocalNextActionsOutput,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "nextActions")),
    );

    register(
      "loopover_explain_local_blockers",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: ExplainLocalBlockersOutput,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scoreBlockers")),
    );

    register(
      "loopover_remediation_plan",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: RemediationPlanOutput,
      },
      async (input) => this.toolResult(await this.remediationPlan(input)),
    );

    register(
      "loopover_prepare_pr_packet",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: PrepareLocalPrPacketOutput,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "prPacket")),
    );

    register(
      "loopover_draft_pr_body",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: DraftPrBodyOutput,
      },
      async (input) => this.toolResult(await this.draftPrBody(input)),
    );

    register(
      "loopover_compare_local_variants",
      {
        inputSchema: CompareLocalVariantsInput,
        outputSchema: CompareVariantsOutput,
      },
      async (input) => this.toolResult(await this.compareLocalVariants(input.variants)),
    );

    register(
      "loopover_agent_plan_next_work",
      {
        inputSchema: AgentPlanInput,
        outputSchema: AgentPlanNextWorkOutput,
      },
      async (input, extra) => this.toolResult(await this.agentPlanNextWork(input, extra, server)),
    );

    register(
      "loopover_agent_start_run",
      {
        inputSchema: AgentStartRunInput,
        outputSchema: AgentRunBundleOutput,
      },
      async (input) => this.toolResult(await this.agentStartRun(input)),
    );

    register(
      "loopover_agent_get_run",
      {
        inputSchema: AgentGetRunInput,
        outputSchema: AgentRunBundleOutput,
      },
      async (input) => this.toolResult(await this.agentGetRun(input.runId)),
    );

    register(
      "loopover_agent_explain_next_action",
      {
        inputSchema: AgentPlanInput,
        outputSchema: AgentExplainNextActionOutput,
      },
      async (input) => this.toolResult(await this.agentExplainNextAction(input)),
    );

    register(
      "loopover_agent_prepare_pr_packet",
      {
        inputSchema: LocalBranchAnalysisInput,
        outputSchema: AgentRunBundleOutput,
      },
      async (input) => this.toolResult(await this.agentPreparePrPacket(input)),
    );

    // ── Admin tools (#7721) ──────────────────────────────────────────────
    // Registered only when LOOPOVER_MCP_ADMIN_ENABLED is truthy -- "not just gated at call time" per the
    // issue, matching this repo's "truly inert when off, tool not even registered" convention (contrast
    // every OTHER category above, whose tools always exist and are gated purely by identity/allowlist
    // inside their handlers). Each handler ALSO independently requires actor === "mcp-admin"
    // (requireMcpAdmin) -- defense in depth, so enabling this flag alone never grants anything to a caller
    // still using the ordinary LOOPOVER_MCP_TOKEN.
    if (isMcpAdminEnabled(this.env)) {
      register(
        "loopover_admin_get_config",
        {
          inputSchema: AdminGetConfigInput,
          outputSchema: AdminGetConfigOutput,
        },
        async (input) => this.toolResult(await this.adminGetConfig(input)),
      );
      register(
        "loopover_admin_write_config",
        {
          inputSchema: AdminWriteConfigInput,
          outputSchema: AdminWriteConfigOutput,
        },
        async (input) => this.toolResult(await this.adminWriteConfig(input)),
      );
      register(
        "loopover_admin_list_config_backups",
        {
          inputSchema: AdminListConfigBackupsInput,
          outputSchema: AdminListConfigBackupsOutput,
        },
        async (input) => this.toolResult(await this.adminListConfigBackups(input)),
      );
      register(
        "loopover_admin_trigger_redeploy",
        {
          inputSchema: AdminTriggerRedeployInput,
          outputSchema: AdminTriggerRedeployOutput,
        },
        async (input) => this.toolResult(await this.adminTriggerRedeploy(input)),
      );
      register(
        "loopover_admin_get_status",
        { inputSchema: AdminGetStatusInput, outputSchema: AdminGetStatusOutput, },
        async () => this.toolResult(await this.adminGetStatus()),
      );
      register(
        "loopover_admin_doctor",
        { inputSchema: AdminDoctorInput, outputSchema: AdminDoctorOutput, },
        async () => this.toolResult(await this.adminDoctor()),
      );
      register(
        "loopover_admin_tail_logs",
        { inputSchema: AdminTailLogsInput, outputSchema: AdminTailLogsOutput, },
        async (input) => this.toolResult(await this.adminTailLogs(input)),
      );
      register(
        "loopover_admin_get_backup_status",
        { inputSchema: AdminGetBackupStatusInput, outputSchema: AdminGetBackupStatusOutput, },
        async () => this.toolResult(await this.adminGetBackupStatus()),
      );
      register(
        "loopover_admin_rotate_secret",
        {
          inputSchema: AdminRotateSecretInput,
          outputSchema: AdminRotateSecretOutput,
        },
        async (input) => this.toolResult(await this.adminRotateSecret(input)),
      );
    }

    // ── Miner planning prompts ───────────────────────────────────────────
    server.registerPrompt(
      "loopover_select_contribution_issue",
      {
        title: "Select contribution issue",
        description: "Identify the best open issue for a contributor to work on based on lane fit, issue quality, and queue signals. Advisory only — no GitHub writes.",
        argsSchema: { ...GetAutomationStateInput.shape, login: z.string().min(1) },
      },
      ({ owner, repo, login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use loopover_get_issue_quality and loopover_explain_repo_decision for ${login} on ${owner}/${repo} to identify which open issues are the best fit. Rank candidates by actionability, lane alignment, and queue pressure. Present a short ranked list with a brief rationale for each. Do not create issues, file comments, or take any GitHub action — this is a planning aid for the contributor to decide from.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "loopover_draft_contribution_pr_packet",
      {
        title: "Draft contribution PR packet",
        description: "Draft a public-safe PR submission packet for a planned contribution without uploading source code. Advisory only — no GitHub writes.",
        argsSchema: { ...GetAutomationStateInput.shape, login: z.string().min(1) },
      },
      ({ owner, repo, login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use loopover_get_repo_context and loopover_get_decision_pack for ${login} to prepare a public-safe PR packet for work on ${owner}/${repo}. The packet should include lane fit, recommended next steps, and any preflight considerations the contributor should address before opening the PR. Do not open a PR, post any comment, or take any GitHub action — present the packet for the contributor to review and submit manually.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "loopover_preflight_contribution_branch",
      {
        title: "Preflight contribution branch",
        description: "Assess branch readiness before opening a PR using cached lane and preflight signals. Advisory only — no GitHub writes.",
        argsSchema: { ...GetAutomationStateInput.shape, login: z.string().min(1) },
      },
      ({ owner, repo, login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use loopover_get_repo_context and loopover_explain_repo_decision for ${login} on ${owner}/${repo} to assess whether the planned branch is ready to be submitted as a PR. Check lane fit, duplicate risk, linked issue coverage, and any signals that suggest the branch needs more work. Present a preflight summary the contributor can act on before opening the PR. Do not open a PR, push any branch, or take any GitHub action.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "loopover_plan_cleanup_first",
      {
        title: "Plan cleanup-first work",
        description: "Identify open PRs to address before starting new work to reduce queue pressure and improve lane fit. Advisory only — no GitHub writes.",
        argsSchema: { login: z.string().min(1) },
      },
      ({ login }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use loopover_monitor_open_prs and loopover_get_decision_pack for ${login} to identify which open PRs to address before starting new contribution work. Surface PRs with failing checks, pending review comments, stale queue pressure, or duplicate risk. Recommend an ordered cleanup list with a brief rationale for each item. Do not close PRs, post comments, or take any GitHub action — present the plan for the contributor to execute manually.`,
            },
          },
        ],
      }),
    );

    // ── #9522 operator queue + safety tools ────────────────────────────
    //
    // Registered on BOTH deployments (availability "both"): the dead-letter tools answer
    // `unavailable: true` where the queue backend has no dead-letter admin, which is a real answer rather
    // than a reason to hide the tool. Every handler enforces `auth: "operator"` itself at call time --
    // registration is not the gate, identity is.
    register(
      "loopover_ops_list_dead_letter_jobs",
      {
        inputSchema: OpsListDeadLetterJobsInput,
        outputSchema: OpsListDeadLetterJobsOutput,
      },
      async (input) => this.toolResult(await this.opsListDeadLetterJobs(input)),
    );
    register(
      "loopover_ops_replay_dead_letter_job",
      {
        inputSchema: OpsReplayDeadLetterJobInput,
        outputSchema: OpsReplayDeadLetterJobOutput,
      },
      async (input) => this.toolResult(await this.opsReplayDeadLetterJob(input)),
    );
    register(
      "loopover_ops_delete_dead_letter_job",
      {
        inputSchema: OpsDeleteDeadLetterJobInput,
        outputSchema: OpsDeleteDeadLetterJobOutput,
      },
      async (input, extra) => this.toolResult(await this.opsDeleteDeadLetterJob(input, extra, server)),
    );
    register(
      "loopover_ops_purge_dead_letter_jobs",
      {
        inputSchema: OpsPurgeDeadLetterJobsInput,
        outputSchema: OpsPurgeDeadLetterJobsOutput,
      },
      async (input, extra) => this.toolResult(await this.opsPurgeDeadLetterJobs(input, extra, server)),
    );
    register(
      "loopover_ops_get_kill_switch",
      {
        inputSchema: OpsGetKillSwitchInput,
        outputSchema: OpsGetKillSwitchOutput,
      },
      async () => this.toolResult(await this.opsGetKillSwitch()),
    );
    register(
      "loopover_ops_set_kill_switch",
      {
        inputSchema: OpsSetKillSwitchInput,
        outputSchema: OpsSetKillSwitchOutput,
      },
      async (input, extra) => this.toolResult(await this.opsSetKillSwitch(input, extra, server)),
    );
    register(
      "loopover_ops_get_operator_dashboard",
      {
        inputSchema: OpsGetOperatorDashboardInput,
        outputSchema: OpsGetOperatorDashboardOutput,
      },
      async (input) => this.toolResult(await this.opsGetOperatorDashboard(input)),
    );

    // ── #9522 fleet tools ──────────────────────────────────────────────
    //
    // availability "cloud": these administer FLEET state a single self-hosted instance does not have. Every
    // handler enforces auth "internal" itself -- the same INTERNAL_JOB_TOKEN bearer the routes' middleware
    // checks -- so registration is never the gate.
    register(
      "loopover_fleet_list_instances",
      { inputSchema: FleetListInstancesInput, outputSchema: FleetListInstancesOutput, },
      async () => this.toolResult(await this.fleetListInstances()),
    );
    register(
      "loopover_fleet_register_instance",
      { inputSchema: FleetRegisterInstanceInput, outputSchema: FleetRegisterInstanceOutput, },
      async (input) => this.toolResult(await this.fleetRegisterInstance(input)),
    );
    register(
      "loopover_fleet_list_installations",
      { inputSchema: FleetListInstallationsInput, outputSchema: FleetListInstallationsOutput, },
      async () => this.toolResult(await this.fleetListInstallations()),
    );
    register(
      "loopover_fleet_register_installation",
      { inputSchema: FleetRegisterInstallationInput, outputSchema: FleetRegisterInstallationOutput, },
      async (input) => this.toolResult(await this.fleetRegisterInstallation(input)),
    );
    register(
      "loopover_fleet_backfill_installations",
      { inputSchema: FleetBackfillInstallationsInput, outputSchema: FleetBackfillInstallationsOutput, },
      async () => this.toolResult(await this.fleetBackfillInstallations()),
    );
    register(
      "loopover_fleet_issue_enrollment",
      { inputSchema: FleetIssueEnrollmentInput, outputSchema: FleetEnrollmentOutput, },
      async (input) => this.toolResult(await this.fleetIssueEnrollment(input)),
    );
    register(
      "loopover_fleet_rotate_enrollment",
      { inputSchema: FleetRotateEnrollmentInput, outputSchema: FleetEnrollmentOutput, },
      // Rotation IS issuance with rotate forced on -- one implementation, so the two can never diverge on
      // what "replace the live enrollment" means.
      async (input) => this.toolResult(await this.fleetIssueEnrollment({ ...input, rotate: true })),
    );
    register(
      "loopover_fleet_revoke_enrollment",
      { inputSchema: FleetRevokeEnrollmentInput, outputSchema: FleetRevokeEnrollmentOutput, },
      async (input, extra) => this.toolResult(await this.fleetRevokeEnrollment(input, extra, server)),
    );

    register(
      "loopover_fleet_config_push",
      { inputSchema: FleetConfigPushInput, outputSchema: FleetConfigPushOutput, },
      async (input, extra) => this.toolResult(await this.fleetConfigPush(input, extra, server)),
    );
    register(
      "loopover_fleet_run_job",
      { inputSchema: FleetRunJobInput, outputSchema: FleetRunJobOutput, },
      async (input) => this.toolResult(await this.fleetRunJob(input)),
    );

    // ── #9522 hosted-tenant tools ──────────────────────────────────────
    register(
      "loopover_tenant_create",
      { inputSchema: TenantCreateInput, outputSchema: TenantCreateOutput, },
      async (input) => this.toolResult(await this.tenantCreate(input)),
    );
    register(
      "loopover_tenant_list",
      { inputSchema: TenantListInput, outputSchema: TenantListOutput, },
      async () => this.toolResult(await this.tenantList()),
    );
    register(
      "loopover_tenant_set_orb_installation",
      { inputSchema: TenantSetOrbInstallationInput, outputSchema: TenantSetOrbInstallationOutput, },
      async (input) => this.toolResult(await this.tenantSetOrbInstallation(input)),
    );
    register(
      "loopover_tenant_destroy",
      { inputSchema: TenantDestroyInput, outputSchema: TenantDestroyOutput, },
      async (input, extra) => this.toolResult(await this.tenantDestroy(input, extra, server)),
    );

    register(
      "loopover_ams_tenant_health",
      { inputSchema: AmsTenantHealthInput, outputSchema: AmsTenantHealthOutput, },
      async (input) => this.toolResult(await this.amsTenantHealth(input)),
    );
    register(
      "loopover_ams_tenant_wake",
      { inputSchema: AmsTenantWakeInput, outputSchema: AmsTenantWakeOutput, },
      async (input) => this.toolResult(await this.amsTenantWake(input)),
    );

    // #2225 — read-only taxonomy discovery for AI review finding categories + severity ladder.
    server.registerResource(
      "loopover_finding_taxonomy",
      FINDING_TAXONOMY_URI,
      {
        title: "LoopOver Finding Taxonomy",
        description: "Canonical AI review finding categories and severity levels for discovery without hard-coding.",
        mimeType: "application/json",
      },
      async () => ({
        contents: [
          {
            uri: FINDING_TAXONOMY_URI,
            mimeType: "application/json",
            text: JSON.stringify(buildFindingTaxonomyDocument(), null, 2),
          },
        ],
      }),
    );

    // #2226 — read-only REES enrichment analyzer taxonomy for MCP discovery.
    server.registerResource(
      "loopover_enrichment_analyzers",
      ENRICHMENT_ANALYZERS_URI,
      {
        title: "LoopOver Enrichment Analyzers",
        description: "REES enrichment analyzer taxonomy: names, categories, cost classes, and default profiles.",
        mimeType: "application/json",
      },
      async () => ({
        contents: [
          {
            uri: ENRICHMENT_ANALYZERS_URI,
            mimeType: "application/json",
            text: JSON.stringify(buildEnrichmentAnalyzersTaxonomyDocument(), null, 2),
          },
        ],
      }),
    );

    return server;
  }

  private requireContributorAccess(login: string): void {
    if (this.identity.kind === "session" && this.identity.actor.toLowerCase() !== login.toLowerCase()) {
      throw new Error("Forbidden: session can only access the authenticated GitHub login.");
    }
    // The static `mcp` identity must not read an ARBITRARY other contributor's private decision pack, profile,
    // or notifications by default — LOOPOVER_MCP_TOKEN is a shared, end-user-obtainable CLI credential, not an
    // operator-only secret (see requireRepoManageAccess). There is no per-login allowlist, so only the full
    // MCP_READ_REPO_ALLOWLIST wildcard opt-in unlocks this, matching requireOperatorAccess below. (#2455)
    if (this.identity.kind === "static" && this.identity.actor === "mcp" && !isMcpReadUnscoped(this.env.MCP_READ_REPO_ALLOWLIST)) {
      throw new Error("Forbidden: this MCP token is not authorized to read another contributor's data.");
    }
  }

  private async requireRepoAccess(repoFullName: string): Promise<void> {
    if (await this.canAccessRepo(repoFullName)) return;
    throw new Error("Forbidden: session cannot access this repository.");
  }

  // Onboarding-pack previews are maintainer/operator-scoped like the HTTP preview route: they can derive
  // guidance from private policy, so the shared static MCP token must not satisfy this gate via the read allowlist.
  private async requireRepoOnboardingPackAccess(repoFullName: string): Promise<void> {
    if (this.identity.kind === "static" && this.identity.actor === "mcp") {
      throw new Error("Forbidden: onboarding-pack previews require a maintainer, owner, or operator session.");
    }
    await this.requireRepoAccess(repoFullName);
  }

  // #7808 - mirror GET /v1/repos/:owner/:repo/focus-manifest auth: requireAppRole([maintainer,owner,operator])
  // plus session requireSessionRepoAccess. Static `mcp` is never trusted (insufficient_role); api/internal are.
  private async requireFocusManifestReadAccess(repoFullName: string): Promise<void> {
    if (this.identity.kind === "static") {
      if (this.identity.actor === "mcp") {
        throw new Error("Forbidden: focus-manifest requires a maintainer, owner, or operator session (insufficient_role).");
      }
      return;
    }
    const summary = await loadControlPanelRoleSummary(this.env, this.identity.actor, this.identity.session?.githubUserId);
    if (!summary.roles.some((role) => role === "maintainer" || role === "owner" || role === "operator")) {
      throw new Error("Forbidden: maintainer, owner, or operator role is required for focus-manifest (insufficient_role).");
    }
    await this.requireRepoAccess(repoFullName);
  }

  // Stricter than requireRepoAccess (read): a maintainer-MANAGE gate for write actions (#784 propose-action).
  // A session must own/maintain the repo (or be an operator); api/internal static identities are trusted (they
  // are operator-only Worker secrets, never handed to end users). The static `mcp` identity is NOT trusted here:
  // LOOPOVER_MCP_TOKEN is a shared, end-user-obtainable CLI credential, so it is scoped to an explicit
  // operator-configured allowlist instead (#2253).
  private async requireRepoManageAccess(repoFullName: string): Promise<void> {
    if (this.identity.kind === "static" && this.identity.actor === "mcp") {
      if (isMcpActuationRepoAllowed(this.env.MCP_ACTUATION_REPO_ALLOWLIST, repoFullName)) return;
      throw new Error("Forbidden: this repository is not in the operator's MCP_ACTUATION_REPO_ALLOWLIST.");
    }
    if (this.identity.kind !== "session") return;
    const scope = await this.loadSessionAccessScope();
    if (scope.operator) return;

    const repo = await getRepository(this.env, repoFullName);
    const installationId = repo?.installationId ?? null;
    let permission: string | null = null;
    if (installationId !== null) {
      try {
        permission = await getRepositoryCollaboratorPermission(this.env, installationId, repoFullName, this.identity.actor);
      } catch {
        permission = null;
      }
    }
    if (permission && REPO_WRITE_PERMISSIONS.has(permission)) return;
    throw new Error("Forbidden: write access is required to propose an action on this repository.");
  }

  // Approval-queue list/decide mirrors the HTTP requireRepoWriteAccess gate:
  // first require repo-scoped LoopOver maintainer/owner/operator authority, then verify live GitHub write.
  // See requireRepoManageAccess above: api/internal static identities are trusted; the static `mcp` identity is
  // scoped to MCP_ACTUATION_REPO_ALLOWLIST instead, since LOOPOVER_MCP_TOKEN is a shared end-user credential (#2253).
  private async requireRepoApprovalQueueAccess(repoFullName: string): Promise<void> {
    if (this.identity.kind === "static" && this.identity.actor === "mcp") {
      if (isMcpActuationRepoAllowed(this.env.MCP_ACTUATION_REPO_ALLOWLIST, repoFullName)) return;
      throw new Error("Forbidden: this repository is not in the operator's MCP_ACTUATION_REPO_ALLOWLIST.");
    }
    if (this.identity.kind !== "session") return;
    const scope = await this.loadSessionAccessScope();
    if (scope.operator) return;

    const repo = await getRepository(this.env, repoFullName);
    const requestedRepo = repoFullName.toLowerCase();
    const repoScoped = scope.repositoryFullNames.some((name) => name.toLowerCase() === requestedRepo);
    const accountScoped = Boolean(repo && scope.accountLogins.some((login) => login.toLowerCase() === repo.owner.toLowerCase()));
    if (!repoScoped && !accountScoped) {
      throw new Error("Forbidden: maintainer access is required for this repository.");
    }

    const installationId = repo?.installationId ?? null;
    let permission: string | null = null;
    if (installationId !== null) {
      try {
        permission = await getRepositoryCollaboratorPermission(this.env, installationId, repoFullName, this.identity.actor);
      } catch {
        permission = null;
      }
    }
    if (permission && REPO_WRITE_PERMISSIONS.has(permission)) return;
    throw new Error("Forbidden: write access is required to manage this repository's approval queue.");
  }

  // Issue-watch gate (#699 path B). Sessions may only watch repos they can SEE: any loopover-tracked PUBLIC
  // repo (the miner use case) or a PRIVATE repo they can access — never an arbitrary/private repo they cannot,
  // so private-repo issues never fan out to them. Non-session (private-token) identities are trusted.
  // Its only caller (watchIssues) already gates the static `mcp` identity via requireContributorAccess's
  // unscoped-MCP_READ_REPO_ALLOWLIST-wildcard-only check first, which is strictly stronger than any repo-scoped
  // check this function could add — a static mcp caller can only ever reach here already fully trusted. (#2455)
  private async requireWatchableRepo(login: string, repoFullName: string): Promise<void> {
    if (this.identity.kind !== "session") return;
    if (await canWatchRepo(this.env, login, repoFullName, this.identity.session?.githubUserId)) return;
    throw new Error("Forbidden: session cannot watch this repository.");
  }

  private loadSessionAccessScope(): Promise<ControlPanelAccessScope> {
    if (this.identity.kind !== "session") throw new Error("Session access scope is only available for session identities.");
    this.accessScopePromise ??= loadControlPanelAccessScope(this.env, this.identity.actor, this.identity.session?.githubUserId);
    return this.accessScopePromise;
  }

  private async getRepoContext(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const [repo, issues, pullRequests, recentMergedPullRequests, queueCounts, queueTrends] = await Promise.all([
      getRepository(this.env, fullName),
      listIssueSignalSample(this.env, fullName),
      listOpenPullRequests(this.env, fullName),
      listRecentMergedPullRequests(this.env, fullName),
      this.loadOpenQueueCounts(fullName),
      getRepoQueueTrendSnapshot(this.env, fullName),
    ]);
    const collisions = buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
    return {
      summary: `LoopOver repo context for ${fullName}.`,
      data: {
        repoFullName: fullName,
        repo,
        lane: buildLaneAdvice(repo, fullName),
        queueHealth: buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts),
        queueTrends: queueTrends?.payload ?? buildUnavailableQueueTrendReport(fullName),
        collisions,
        configQuality: buildConfigQuality(repo, issues, pullRequests, fullName),
        dataQuality: await this.loadRepoDataQuality(fullName),
      },
    };
  }

  private async getMaintainerNoise(input: { owner: string; repo: string }): Promise<ToolPayload> {
    // (#8338) Mirrors GET /v1/repos/:owner/:repo/maintainer-noise: same requireRepoAccess gate as sibling
    // read-only maintainer reports (and REST requireRepoMaintainer) — not the live-write approval-queue gate.
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await loadMaintainerNoiseReport(this.env, fullName);
    return {
      summary: maintainerNoiseSummary(report),
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getAmsMinerCohort(input: { owner: string; repo: string }): Promise<ToolPayload> {
    // (#8338) Mirrors GET /v1/repos/:owner/:repo/ams-miner-cohort: same requireRepoAccess gate as
    // getMaintainerNoise / other read-only maintainer reports, and the same buildAmsMinerCohortComparison
    // service the REST route uses.
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await buildAmsMinerCohortComparison(this.env, fullName);
    // Single summary template (no present-branch) so patch coverage stays complete under the 99% gate; the
    // structured payload still carries `present` for clients that need the empty vs populated distinction.
    return {
      summary: `LoopOver AMS miner cohort for ${fullName} (present=${String(report.present)}; AMS=${report.amsCohort.submitterCount}; human=${report.humanCohort.submitterCount}; checked ${report.checkedSubmitterCount}/${report.totalSubmitterCount}).`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  // #7808 - thin MCP surface over GET /v1/repos/:owner/:repo/focus-manifest. Same requireAppRole +
  // session-repo-access boundary as the REST route; same loadRepoFocusManifest + compileFocusManifestPolicy pair.
  private async getRepoFocusManifest(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireFocusManifestReadAccess(fullName);
    const manifest = await loadRepoFocusManifest(this.env, fullName);
    const policy = compileFocusManifestPolicy(manifest);
    return {
      summary: `LoopOver focus manifest for ${fullName}.`,
      data: { repoFullName: fullName, manifest, policy } as unknown as Record<string, unknown>,
    };
  }

  // #9299 - thin MCP surface over POST /v1/repos/:owner/:repo/focus-manifest/refresh, the refresh COUNTERPART to
  // getRepoFocusManifest above (#7808). Forces a live reload of the cached .loopover.yml manifest from GitHub via the
  // SAME loadRepoFocusManifest(..., { refresh: true }) + compileFocusManifestPolicy pair the REST route uses, returning
  // the identical { repoFullName, manifest, policy } shape. Because it forces a live refresh it takes the write-access
  // boundary (requireRepoManageAccess, mirroring the route's requireRepoWriteAccess) -- stricter than the read tool's
  // requireFocusManifestReadAccess, matching loopover_refresh_repo_docs's refresh-action auth.
  private async refreshRepoFocusManifest(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const manifest = await loadRepoFocusManifest(this.env, fullName, { refresh: true });
    const policy = compileFocusManifestPolicy(manifest);
    return {
      summary: `Refreshed the LoopOver focus manifest for ${fullName} from GitHub.`,
      data: { repoFullName: fullName, manifest, policy } as unknown as Record<string, unknown>,
    };
  }

  // (#7799/#8338) MCP surface for GET /v1/repos/:owner/:repo/activation-preview. Same requireRepoAccess gate
  // as sibling read-only maintainer reports (REST requireRepoMaintainer). Assembles the same inputs the REST
  // route does (getRepository + resolveRepositorySettings + listPullRequests) and defers to the guarded
  // buildMaintainerActivationPreview service. Deterministic and advisory-only -- never runs AI.
  private async getActivationPreview(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const [repo, settings, pullRequests] = await Promise.all([
      getRepository(this.env, fullName),
      resolveRepositorySettings(this.env, fullName),
      listPullRequests(this.env, fullName),
    ]);
    const report = buildMaintainerActivationPreview({
      repoFullName: fullName,
      repo,
      settings,
      pullRequests,
      generatedAt: nowIso(),
      duplicateWinnerEnabled: resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(this.env), settings.duplicateWinnerMode),
    });
    return {
      summary: report.summary,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getLabelAudit(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await loadLabelAudit(this.env, fullName);
    return {
      summary: labelAuditSummary(report),
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getMaintainerLane(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await loadMaintainerLaneReport(this.env, fullName);
    return {
      summary: maintainerLaneSummary(report),
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getRepoOnboardingPack(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoOnboardingPackAccess(fullName);
    const response = await buildRepoOnboardingPackPreviewForRepo(this.env, fullName);
    if ("error" in response) {
      return {
        summary: `Onboarding pack preview unavailable for ${fullName}: repository is not accepted.`,
        data: response as unknown as Record<string, unknown>,
      };
    }
    return {
      summary: `LoopOver onboarding pack preview for ${fullName} (preview-only, not published).`,
      data: response as unknown as Record<string, unknown>,
    };
  }

  private async getRegistrationReadiness(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await buildRegistrationReadinessResponse(this.env, fullName);
    return {
      summary: report.ready
        ? `LoopOver registration readiness for ${fullName}: ready (preview-only, not a registration action).`
        : `LoopOver registration readiness for ${fullName}: not ready — ${report.blockers.length} blocker(s) (preview-only, not a registration action).`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getConfigRecommendation(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await buildGittensorConfigRecommendationResponse(this.env, fullName);
    return {
      summary:
        report.warnings.length > 0
          ? `LoopOver .loopover.yml recommendation for ${fullName}: ${report.warnings.length} warning(s) to review alongside the recommendation (advisory only, not a write action).`
          : `LoopOver .loopover.yml recommendation for ${fullName}: recommendation generated with no outstanding warnings (advisory only, not a write action).`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getBurdenForecast(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const response = await loadCachedBurdenForecastResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `LoopOver has no cached burden forecast for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary: `LoopOver burden forecast for ${fullName} (cached, ${response.freshness}).`,
      data: response as unknown as Record<string, unknown>,
    };
  }

  private async getIssueQuality(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access issue quality for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    const response = await loadOrComputeIssueQualityResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `LoopOver has no cached issue quality for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary:
        response.source === "snapshot"
          ? `LoopOver issue quality for ${fullName} (cached).`
          : `LoopOver issue quality for ${fullName} (computed from cached metadata).`,
      data: response as unknown as Record<string, unknown>,
    };
  }

  private async getPrReviewability(input: { owner: string; repo: string; number: number }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access PR reviewability for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    // Prefer the persisted snapshot the /reviewability route writes (signal type "pr-reviewability", keyed by
    // `${fullName}#${number}`), mirroring how getIssueQuality serves the cached snapshot before recomputing.
    const cached = (await listSignalSnapshots(this.env, "pr-reviewability", `${fullName}#${input.number}`))[0];
    if (cached) {
      const payload = cached.payload as unknown as PullRequestReviewability;
      return {
        summary: `LoopOver PR reviewability for ${fullName}#${input.number} (cached).`,
        data: {
          status: "ready",
          source: "snapshot",
          repoFullName: fullName,
          generatedAt: cached.generatedAt || payload.generatedAt || new Date().toISOString(),
          report: payload,
        } as unknown as Record<string, unknown>,
      };
    }
    const [repo, pullRequest] = await Promise.all([getRepository(this.env, fullName), getPullRequest(this.env, fullName, input.number)]);
    if (!repo || !pullRequest) {
      return {
        summary: `LoopOver has no cached PR reviewability for ${fullName}#${input.number}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    const [issues, pullRequests, files, reviews, checks, recentMergedPullRequests] = await Promise.all([
      listIssues(this.env, fullName),
      listPullRequests(this.env, fullName),
      listPullRequestFiles(this.env, fullName, input.number),
      listPullRequestReviews(this.env, fullName, input.number),
      listCheckSummaries(this.env, fullName, input.number),
      listRecentMergedPullRequests(this.env, fullName),
    ]);
    const contributor = pullRequest.authorLogin;
    const contributorContext = contributor ? await this.loadContributorFastContext(contributor) : null;
    const report = buildPullRequestReviewability({
      repo,
      pullRequest,
      issues,
      pullRequests,
      files,
      reviews,
      checks,
      recentMergedPullRequests,
      repoFullName: fullName,
      pullNumber: input.number,
      profile: contributorContext?.profile,
      outcomeHistory: contributorContext?.outcomeHistory,
    });
    return {
      summary: `LoopOver PR reviewability for ${fullName}#${input.number} (computed from cached metadata).`,
      data: {
        status: "ready",
        source: "computed",
        repoFullName: fullName,
        generatedAt: report.generatedAt,
        report,
      } as unknown as Record<string, unknown>,
    };
  }

  private async getPrMaintainerPacket(input: { owner: string; repo: string; number: number }): Promise<ToolPayload> {
    // Mirrors GET /v1/repos/:owner/:repo/pulls/:number/maintainer-packet: same data-assembly path as the REST
    // route (buildPullRequestMaintainerPacket → attachDataQuality), with the reviewability-style mcp allowlist
    // gate so the shared static mcp token stays repo-scoped.
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access PR maintainer packet for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    const [repo, pullRequest, issues, pullRequests, files, reviews, checks, recentMergedPullRequests] = await Promise.all([
      getRepository(this.env, fullName),
      getPullRequest(this.env, fullName, input.number),
      listIssues(this.env, fullName),
      listPullRequests(this.env, fullName),
      listPullRequestFiles(this.env, fullName, input.number),
      listPullRequestReviews(this.env, fullName, input.number),
      listCheckSummaries(this.env, fullName, input.number),
      listRecentMergedPullRequests(this.env, fullName),
    ]);
    const packet = attachDataQuality(
      buildPullRequestMaintainerPacket({
        repo,
        pullRequest,
        issues,
        pullRequests,
        files,
        reviews,
        checks,
        recentMergedPullRequests,
        repoFullName: fullName,
        pullNumber: input.number,
      }) as unknown as Record<string, unknown>,
      await this.loadRepoDataQuality(fullName),
    );
    return {
      summary: `LoopOver PR maintainer packet for ${fullName}#${input.number}.`,
      data: packet as unknown as Record<string, unknown>,
    };
  }

  private async getLiveGateThresholds(input: { owner: string; repo: string }): Promise<ToolPayload> {
    // Mirrors GET /v1/repos/:owner/:repo/live-gate-thresholds: same mcp allowlist gate as reviewability,
    // same authoritative live/shadow projection, and a normal not-found result (never throw) when neither
    // override is active — same error code the REST route uses.
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access live gate thresholds for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    const storageEnv = this.env as unknown as StorageEnv;
    const [live, shadow] = await Promise.all([loadOverride(storageEnv, fullName), loadShadowOverride(storageEnv, fullName)]);
    const fields = toLiveGateThresholdFields(authoritativeGateOverride(live, shadow));
    if (!fields) {
      return {
        summary: `No live gate thresholds are active for ${fullName}.`,
        data: { error: "live_gate_thresholds_not_found", repoFullName: fullName },
      };
    }
    return {
      summary: `Live gate thresholds for ${fullName}.`,
      data: { repoFullName: fullName, ...fields } as unknown as Record<string, unknown>,
    };
  }

  private async getGateConfigEffective(input: { owner: string; repo: string }): Promise<ToolPayload> {
    // Mirrors GET /v1/repos/:owner/:repo/gate-config/effective: same mcp allowlist gate as reviewability,
    // same loadOverride/loadShadowOverride projection, always returning the effective + shadowPending shape
    // (nulls when no live override — never a not-found throw).
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access effective gate config for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    const storageEnv = this.env as unknown as StorageEnv;
    const [override, shadow] = await Promise.all([loadOverride(storageEnv, fullName), loadShadowOverride(storageEnv, fullName)]);
    return {
      summary: `Effective gate config for ${fullName}.`,
      data: {
        repoFullName: fullName,
        effective: {
          confidenceFloor: override?.confidenceFloor ?? null,
          scopeCap: {
            files: override?.scopeCap?.files ?? null,
            lines: override?.scopeCap?.lines ?? null,
          },
        },
        shadowPending: shadow !== null,
      },
    };
  }

  private async getRepoSettings(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    // Shared with GET /v1/repos/:owner/:repo/settings so the two surfaces cannot drift: return the resolved
    // EFFECTIVE settings row unmodified (spread into a plain Record for ToolPayload.data), no derived fields.
    const settings = await resolveRepositorySettings(this.env, fullName);
    return { summary: `Effective settings for ${fullName}.`, data: { ...settings } };
  }

  private async validateLinkedIssue(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    plannedChange?: { title?: string | undefined; changedFiles?: string[] | undefined; contributorLogin?: string | undefined } | undefined;
  }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access linked-issue validation for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    const [repo, issues, pullRequests, recentMergedPullRequests] = await Promise.all([
      getRepository(this.env, fullName),
      listIssueSignalSample(this.env, fullName),
      listOpenPullRequests(this.env, fullName),
      listRecentMergedPullRequests(this.env, fullName),
    ]);
    const report = buildLinkedIssueValidation(repo, issues, pullRequests, recentMergedPullRequests, fullName, input.issueNumber, input.plannedChange ?? {});
    return {
      summary: `LoopOver linked-issue validation for ${fullName}#${input.issueNumber}: multiplier ${report.multiplierWouldApply ? "would apply" : "would not apply"}.`,
      data: {
        status: "ok",
        repoFullName: fullName,
        issueNumber: report.issueNumber,
        found: report.found,
        multiplierStatus: report.multiplierStatus,
        multiplierWouldApply: report.multiplierWouldApply,
        ...(report.blockingReason === undefined ? {} : { blockingReason: report.blockingReason }),
        reasons: report.reasons,
        report: report as unknown as Record<string, unknown>,
      },
    };
  }

  private async checkBeforeStart(input: { owner: string; repo: string; issueNumber?: number | undefined; title?: string | undefined; plannedPaths?: string[] | undefined }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    if (!(await this.canAccessRepo(fullName))) {
      return {
        summary: `Forbidden: session cannot access pre-start checks for ${fullName}.`,
        data: { status: "forbidden", repoFullName: fullName },
      };
    }
    const [repo, issues, pullRequests, recentMergedPullRequests] = await Promise.all([
      getRepository(this.env, fullName),
      listIssueSignalSample(this.env, fullName),
      listOpenPullRequests(this.env, fullName),
      listRecentMergedPullRequests(this.env, fullName),
    ]);
    const report = sanitizePreStartCheckReportTitles(
      buildPreStartCheck(repo, issues, pullRequests, recentMergedPullRequests, fullName, {
        issueNumber: input.issueNumber,
        title: input.title,
        plannedPaths: input.plannedPaths,
      }),
    );
    return {
      summary: `LoopOver pre-start check for ${fullName}: ${report.recommendation.toUpperCase()}.`,
      data: {
        status: "ok",
        repoFullName: fullName,
        found: report.found,
        claimStatus: report.claimStatus,
        duplicateClusterRisk: report.duplicateClusterRisk,
        recommendation: report.recommendation,
        reasons: report.reasons,
        blockers: report.blockers,
        report: report as unknown as Record<string, unknown>,
      },
    };
  }

  private async findOpportunities(input: z.infer<typeof FindOpportunitiesInput>): Promise<ToolPayload> {
    const validated = validateFindOpportunitiesInput(input);
    if (!validated.ok) {
      return {
        summary: "Invalid find-opportunities request.",
        data: { status: "invalid_request", ranked: [], totalCandidates: 0, reason: validated.reason },
      };
    }
    if (validated.value.searchQuery) {
      await this.requireDiscoveryAccess();
    } else {
      for (const target of validated.value.targets ?? []) {
        await this.requireRepoAccess(`${target.owner}/${target.repo}`);
      }
    }
    const result = await runFindOpportunities(this.env, validated.value, {
      canAccessRepo: (repoFullName) => this.canAccessRepo(repoFullName),
    });
    const count = result.ranked.length;
    return {
      summary:
        result.status === "ok"
          ? `LoopOver ranked ${count} metadata-only opportunit${count === 1 ? "y" : "ies"}.`
          : "LoopOver could not rank opportunities for this request.",
      data: result as unknown as Record<string, unknown>,
    };
  }

  private async retrieveIssueContext(input: z.infer<typeof RetrieveIssueContextInput>): Promise<ToolPayload> {
    const validated = validateIssueRagInput(input);
    if (!validated.ok) {
      return {
        summary: "Invalid issue-context retrieval request.",
        data: { status: "invalid_request", repoFullName: "", reason: validated.reason, telemetry: { attempted: false, injected: false, retrievedPaths: [] } },
      };
    }
    await this.requireRepoAccess(validated.value.repoFullName);
    const result = await runIssueRagRetrieval(this.env, validated.value);
    const pathCount = result.telemetry.retrievedPathCount;
    return {
      summary:
        result.status === "query_too_short"
          ? "Issue query is below the retrieval floor; no RAG context was fetched."
          : result.telemetry.injected
            ? `LoopOver retrieved metadata-only context for ${pathCount} related path${pathCount === 1 ? "" : "s"}.`
            : "LoopOver found no issue-centric RAG context for this request.",
      data: result as unknown as Record<string, unknown>,
    };
  }

  /** Cross-repo search requires unscoped MCP read (wildcard allowlist) or operator/session authority. */
  private async requireDiscoveryAccess(): Promise<void> {
    if (this.identity.kind === "session") {
      if (isAuthorizedGitHubSessionLogin(this.env, this.identity.actor, this.identity.session?.githubUserId)) return;
      const scope = await this.loadSessionAccessScope();
      if (scope.operator) return;
      throw new Error("Forbidden: cross-repo opportunity search requires operator or unscoped MCP read access.");
    }
    if (this.identity.kind === "static" && this.identity.actor === "mcp" && !isMcpReadUnscoped(this.env.MCP_READ_REPO_ALLOWLIST)) {
      throw new Error("Forbidden: cross-repo opportunity search requires unscoped MCP read access.");
    }
  }

  private lintPrText(input: { commitMessages?: string[] | undefined; prBody?: string | undefined; linkedIssue?: number | undefined }): ToolPayload {
    const report = buildPrTextLint(input);
    return {
      summary: `LoopOver PR-text lint verdict: ${report.verdict}.`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private validateConfig(input: { content: string; source?: "repo_file" | "api_record" | "none" | undefined }): ToolPayload {
    const report = buildFocusManifestValidation(input);
    return {
      summary: `LoopOver manifest validation: ${report.status}.`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  /** actor === "mcp-admin" only -- a distinct, higher-privilege credential (LOOPOVER_MCP_ADMIN_TOKEN, #7721)
   *  from the ordinary shared `mcp` identity, so a leaked LOOPOVER_MCP_TOKEN can never reach these tools even
   *  though LOOPOVER_MCP_ADMIN_ENABLED already gates whether they're registered at all. Session identities
   *  (browser login) are never admin either -- this is a self-hosted-operator CLI/automation credential, not
   *  something a dashboard session inherits. */
  // ── #9522 operator queue + safety handlers ─────────────────────────────
  //
  // Each calls the SAME service function its HTTP route calls (src/api/routes.ts's /v1/app/* handlers), so
  // the two transports cannot drift into two behaviors, and each keeps the route's own audit event. The
  // `null` return from every queue-common helper means "this deployment's queue backend exposes no
  // dead-letter admin" -- the routes answer 501 there; these answer `unavailable: true`, because over MCP
  // that is an answer to the question rather than a transport failure.
  private static readonly DEAD_LETTER_UNAVAILABLE = {
    unavailable: true,
    message: "This deployment's queue backend does not expose dead-letter admin.",
  };

  private async opsListDeadLetterJobs(input: { limit?: number | undefined; offset?: number | undefined }): Promise<ToolPayload> {
    await this.requireOperator();
    const limit = input.limit ?? 25;
    const offset = input.offset ?? 0;
    const page = await queueDeadLetterPageFromBinding(this.env.JOBS, limit, offset);
    if (!page) return { summary: "LoopOver dead-letter admin is unavailable on this deployment.", data: { ...LoopoverMcp.DEAD_LETTER_UNAVAILABLE } };
    return {
      summary: `LoopOver dead-letter queue: ${page.total} job(s) parked, showing ${page.items.length}.`,
      data: { generatedAt: new Date().toISOString(), limit, offset, total: page.total, items: page.items as unknown as Record<string, unknown>[] },
    };
  }

  private async opsReplayDeadLetterJob(input: { id: number }): Promise<ToolPayload> {
    await this.requireOperator();
    const result = await queueReplayDeadLetterJobViaBinding(this.env.JOBS, input.id);
    if (result === null) return { summary: "LoopOver dead-letter admin is unavailable on this deployment.", data: { ...LoopoverMcp.DEAD_LETTER_UNAVAILABLE } };
    if (result === false) return { summary: `LoopOver dead-letter job ${input.id} was not found.`, data: { notFound: true, id: input.id } };
    await recordAuditEvent(this.env, {
      eventType: "operator.dlq_job_replayed",
      actor: this.identity.actor,
      targetKey: `selfhost_jobs#${input.id}`,
      outcome: "completed",
      metadata: { id: input.id, surface: "mcp" },
    });
    return { summary: `LoopOver replayed dead-letter job ${input.id}.`, data: { ok: true, id: input.id } };
  }

  private async opsDeleteDeadLetterJob(input: { id: number }, extra?: McpToolExtra, mcpServer?: McpServer): Promise<ToolPayload> {
    await this.requireOperator();
    const confirmation = await this.confirmDestructive(
      `Delete dead-letter job ${input.id}?`,
      "The job is discarded, not re-enqueued. Its payload cannot be recovered.",
      extra,
      mcpServer,
    );
    if (confirmation.declined) return { summary: `LoopOver left dead-letter job ${input.id} in place (declined).`, data: { declined: true, id: input.id } };
    const result = await queueDeleteDeadLetterJobViaBinding(this.env.JOBS, input.id);
    if (result === null) return { summary: "LoopOver dead-letter admin is unavailable on this deployment.", data: { ...LoopoverMcp.DEAD_LETTER_UNAVAILABLE } };
    if (result === false) return { summary: `LoopOver dead-letter job ${input.id} was not found.`, data: { notFound: true, id: input.id } };
    await recordAuditEvent(this.env, {
      eventType: "operator.dlq_job_deleted",
      actor: this.identity.actor,
      targetKey: `selfhost_jobs#${input.id}`,
      outcome: "completed",
      metadata: { id: input.id, surface: "mcp" },
    });
    return { summary: `LoopOver deleted dead-letter job ${input.id}.`, data: { ok: true, id: input.id } };
  }

  private async opsPurgeDeadLetterJobs(_input: unknown, extra?: McpToolExtra, mcpServer?: McpServer): Promise<ToolPayload> {
    await this.requireOperator();
    const confirmation = await this.confirmDestructive(
      "Purge EVERY dead-letter job?",
      "All parked jobs are discarded at once. This is unbounded and cannot be recovered.",
      extra,
      mcpServer,
    );
    if (confirmation.declined) return { summary: "LoopOver left the dead-letter queue intact (declined).", data: { declined: true } };
    const purged = await queuePurgeDeadLetterJobsViaBinding(this.env.JOBS);
    if (purged === null) return { summary: "LoopOver dead-letter admin is unavailable on this deployment.", data: { ...LoopoverMcp.DEAD_LETTER_UNAVAILABLE } };
    await recordAuditEvent(this.env, {
      eventType: "operator.dlq_purged",
      actor: this.identity.actor,
      targetKey: "selfhost_jobs#all",
      outcome: "completed",
      metadata: { purged, surface: "mcp" },
    });
    return { summary: `LoopOver purged ${purged} dead-letter job(s).`, data: { ok: true, purged } };
  }

  private async opsGetKillSwitch(): Promise<ToolPayload> {
    await this.requireOperator();
    const state = await getGlobalAgentFrozenState(this.env);
    return {
      summary: state.frozen ? "LoopOver global agent kill switch is ENGAGED — every agent action is halted." : "LoopOver global agent kill switch is released.",
      data: { ...state, generatedAt: new Date().toISOString() },
    };
  }

  private async opsSetKillSwitch(input: { frozen: boolean; confirm?: true | undefined }, extra?: McpToolExtra, mcpServer?: McpServer): Promise<ToolPayload> {
    await this.requireOperator();
    // Only RELEASING needs the ceremony: freezing is the fail-safe direction, and an operator reaching for
    // the kill switch in an incident must not be slowed down by a confirmation prompt.
    if (!input.frozen) {
      if (input.confirm !== true) {
        throw new Error("Releasing the kill switch re-arms automation fleet-wide; pass confirm: true to proceed.");
      }
      const confirmation = await this.confirmDestructive(
        "Release the global agent kill switch?",
        "Every agent action across the deployment resumes immediately.",
        extra,
        mcpServer,
      );
      if (confirmation.declined) {
        const current = await getGlobalAgentFrozenState(this.env);
        return { summary: "LoopOver left the kill switch engaged (declined).", data: { ...current, declined: true, generatedAt: new Date().toISOString() } };
      }
    }
    await setGlobalAgentFrozen(this.env, input.frozen, this.identity.actor);
    await recordAuditEvent(this.env, {
      eventType: input.frozen ? "operator.kill_switch_engaged" : "operator.kill_switch_released",
      actor: this.identity.actor,
      targetKey: "global_agent_kill_switch",
      outcome: "completed",
      metadata: { frozen: input.frozen, surface: "mcp" },
    });
    const state = await getGlobalAgentFrozenState(this.env);
    return {
      summary: input.frozen ? "LoopOver ENGAGED the global agent kill switch — every agent action is halted." : "LoopOver released the global agent kill switch.",
      data: { ...state, generatedAt: new Date().toISOString() },
    };
  }

  private async opsGetOperatorDashboard(input: { days?: number | undefined }): Promise<ToolPayload> {
    await this.requireOperator();
    const windowDays = clampOperatorDashboardWindowDays(Number(input.days));
    const payload = await buildOperatorDashboardPayload(this.env, { windowDays });
    return { summary: `LoopOver operator dashboard over the trailing ${windowDays} day(s).`, data: payload as unknown as Record<string, unknown> };
  }

  // ── #9522 fleet handlers ──────────────────────────────────────────────
  //
  // Each calls the same extracted service function its `/v1/internal/*` route calls (src/orb/fleet-admin.ts,
  // src/orb/broker.ts, src/orb/installations.ts). auth "internal" is enforced by requireInternal, mirroring
  // the middleware's own INTERNAL_JOB_TOKEN bearer check.
  private async fleetListInstances(): Promise<ToolPayload> {
    this.requireInternal();
    const result = await listFleetInstances(this.env);
    return { summary: `LoopOver fleet: ${result.instances.length} instance(s).`, data: result as unknown as Record<string, unknown> };
  }

  private async fleetRegisterInstance(input: { instanceId: string; registered?: boolean | undefined }): Promise<ToolPayload> {
    this.requireInternal();
    const result = await registerFleetInstance(this.env, { instanceId: input.instanceId, ...(input.registered === false ? { registered: false } : {}) });
    await recordAuditEvent(this.env, {
      eventType: "operator.fleet_instance_registered",
      actor: this.identity.actor,
      targetKey: `orb_instances#${input.instanceId}`,
      outcome: "completed",
      metadata: { instanceId: input.instanceId, registered: result.registered, surface: "mcp" },
    });
    return {
      summary: result.instanceSecret
        ? `LoopOver registered fleet instance ${input.instanceId}. Copy its ingest secret now — it is shown only once.`
        : `LoopOver set fleet instance ${input.instanceId} registered=${result.registered}.`,
      data: result as unknown as Record<string, unknown>,
    };
  }

  private async fleetListInstallations(): Promise<ToolPayload> {
    this.requireInternal();
    const result = await listFleetInstallations(this.env);
    return { summary: `LoopOver fleet: ${result.installations.length} installation(s).`, data: result as unknown as Record<string, unknown> };
  }

  private async fleetRegisterInstallation(input: { installationId: number; registered?: boolean | undefined }): Promise<ToolPayload> {
    this.requireInternal();
    const result = await registerFleetInstallation(this.env, { installationId: input.installationId, ...(input.registered === false ? { registered: false } : {}) });
    if ("error" in result) return { summary: `LoopOver has no record of installation ${input.installationId} — it must arrive via the webhook first.`, data: { ...result } };
    await recordAuditEvent(this.env, {
      eventType: "operator.fleet_installation_registered",
      actor: this.identity.actor,
      targetKey: `orb_github_installations#${input.installationId}`,
      outcome: "completed",
      metadata: { installationId: input.installationId, registered: result.registered, surface: "mcp" },
    });
    return { summary: `LoopOver set installation ${input.installationId} registered=${result.registered}.`, data: { ...result } };
  }

  private async fleetBackfillInstallations(): Promise<ToolPayload> {
    this.requireInternal();
    const result = await backfillOrbInstallations(this.env);
    return { summary: `LoopOver backfilled ${result.backfilled} installation(s) from GitHub.`, data: { ...result } };
  }

  private async fleetIssueEnrollment(input: { installationId: number; rotate?: boolean | undefined }): Promise<ToolPayload> {
    this.requireInternal();
    if (!isOrbBrokerEnabled(this.env)) return { summary: "LoopOver token broker is not enabled on this deployment.", data: { error: "not_found" } };
    const result = await issueOrbEnrollment(this.env, input.installationId, undefined, ORB_SECRET_TYPE_GITHUB_TOKEN, { rotate: input.rotate === true });
    if ("error" in result) return { summary: `LoopOver could not issue an enrollment: ${result.error}.`, data: { ...result } };
    await recordAuditEvent(this.env, {
      eventType: "operator.fleet_enrollment_issued",
      actor: this.identity.actor,
      targetKey: `orb_enrollments#${result.enrollId}`,
      outcome: "completed",
      metadata: { installationId: input.installationId, rotate: input.rotate === true, surface: "mcp" },
    });
    return { summary: `LoopOver issued enrollment ${result.enrollId}. The secret is shown only once — copy it now.`, data: result as unknown as Record<string, unknown> };
  }

  private async fleetRevokeEnrollment(input: { enrollId: string }, extra?: McpToolExtra, mcpServer?: McpServer): Promise<ToolPayload> {
    this.requireInternal();
    if (!isOrbBrokerEnabled(this.env)) return { summary: "LoopOver token broker is not enabled on this deployment.", data: { error: "not_found" } };
    const confirmation = await this.confirmDestructive(
      `Revoke enrollment ${input.enrollId}?`,
      "That container immediately loses its ability to broker GitHub tokens and must be re-enrolled.",
      extra,
      mcpServer,
    );
    if (confirmation.declined) return { summary: `LoopOver left enrollment ${input.enrollId} active (declined).`, data: { declined: true, enrollId: input.enrollId } };
    const result = await revokeOrbEnrollment(this.env, input.enrollId);
    if ("error" in result) return { summary: `LoopOver has no enrollment ${input.enrollId}.`, data: { ...result } };
    await recordAuditEvent(this.env, {
      eventType: "operator.fleet_enrollment_revoked",
      actor: this.identity.actor,
      targetKey: `orb_enrollments#${input.enrollId}`,
      outcome: "completed",
      metadata: { enrollId: input.enrollId, surface: "mcp" },
    });
    return { summary: `LoopOver revoked enrollment ${input.enrollId}.`, data: result as unknown as Record<string, unknown> };
  }

  // ── #9522 self-host instance diagnostics ──────────────────────────────
  //
  // Each reaches its capability through the nullable registry only src/server.ts fills, so the Workers
  // bundle never pulls a node builtin in and an unwired deployment answers `configured: false` instead of
  // throwing -- the same shape the config-admin and redeploy tools already use.
  private async adminGetStatus(): Promise<ToolPayload> {
    this.requireMcpAdmin();
    const reader = getInstanceStatusReader();
    if (!reader) return { summary: "LoopOver instance status: not configured on this instance.", data: { configured: false } };
    try {
      const status = await reader();
      const version = typeof status.appVersion === "string" ? status.appVersion : "unknown";
      const behind = status.upToDate === false ? " (a redeploy is due)" : "";
      return { summary: `LoopOver instance is running ${version}${behind}.`, data: { configured: true, ...status } };
    } catch (error) {
      return { summary: "LoopOver instance status could not be read.", data: { configured: true, error: errorMessage(error) } };
    }
  }

  private async adminDoctor(): Promise<ToolPayload> {
    this.requireMcpAdmin();
    const runner = getInstanceDoctorRunner();
    if (!runner) return { summary: "LoopOver instance doctor: not configured on this instance.", data: { configured: false } };
    try {
      const report = await runner();
      const failed = report.checks.filter((check) => check.status === "fail").length;
      const warned = report.checks.filter((check) => check.status === "warn").length;
      return {
        // Every check runs, so the summary reports the whole picture rather than the first failure.
        summary: `LoopOver instance doctor: ${report.checks.length} check(s), ${failed} failing, ${warned} warning.`,
        data: { configured: true, ok: report.ok, checks: report.checks as unknown as Record<string, unknown>[] },
      };
    } catch (error) {
      return { summary: "LoopOver instance doctor could not run.", data: { configured: true, error: errorMessage(error) } };
    }
  }

  private async adminTailLogs(input: { lines?: number | undefined; since?: string | undefined }): Promise<ToolPayload> {
    this.requireMcpAdmin();
    const tailer = getInstanceLogTailer();
    if (!tailer) return { summary: "LoopOver log tail: not configured on this instance.", data: { configured: false } };
    try {
      // The cap is enforced HERE as well as in the implementation: a caller cannot widen it past the
      // schema's own max, and the default stays modest so an unqualified call cannot dump the buffer.
      const result = await tailer({ lines: Math.min(input.lines ?? 200, 1000), ...(input.since !== undefined ? { since: input.since } : {}) });
      return {
        summary: `LoopOver returned ${result.lines.length} log line(s)${result.truncated ? " (truncated by the byte cap)" : ""}.`,
        data: { configured: true, lines: result.lines, truncated: result.truncated },
      };
    } catch (error) {
      return { summary: "LoopOver log tail could not be read.", data: { configured: true, error: errorMessage(error) } };
    }
  }

  private async adminGetBackupStatus(): Promise<ToolPayload> {
    this.requireMcpAdmin();
    const reader = getInstanceBackupStatusReader();
    if (!reader) return { summary: "LoopOver backup status: not configured on this instance.", data: { configured: false } };
    try {
      const status = await reader();
      const last = typeof status.lastBackupAt === "string" ? status.lastBackupAt : "never";
      return { summary: `LoopOver last backup: ${last}.`, data: { configured: true, ...status } };
    } catch (error) {
      return { summary: "LoopOver backup status could not be read.", data: { configured: true, error: errorMessage(error) } };
    }
  }

  // ── #9522 fleet config push + maintenance jobs ────────────────────────
  private async fleetConfigPush(
    input: { installationIds: number[]; pushId: string; message: string; capability?: string | undefined; deprecatesAt?: string | undefined },
    extra?: McpToolExtra,
    mcpServer?: McpServer,
  ): Promise<ToolPayload> {
    await this.requireOperator();
    const confirmation = await this.confirmDestructive(
      `Push config "${input.pushId}" to ${input.installationIds.length} installation(s)?`,
      "Every listed installation receives it.",
      extra,
      mcpServer,
    );
    if (confirmation.declined) return { summary: `LoopOver did not push config "${input.pushId}" (declined).`, data: { declined: true, pushId: input.pushId } };
    const result = await pushFleetConfig(this.env, this.identity.actor, input);
    return {
      summary: `LoopOver pushed config "${result.pushId}" to ${result.succeededCount}/${result.installationCount} installation(s).`,
      data: result as unknown as Record<string, unknown>,
    };
  }

  /**
   * The run-only jobs: no queue message exists for them, so `run` dispatches to the SAME function each
   * one's own `/run` route calls. Keyed by job name and exhaustive over the spec's `messageType: null`
   * entries -- a new run-only job that is not wired here fails the fleet-job parity test.
   */
  private static readonly RUN_ONLY_JOBS: Record<string, (env: Env, payload: Record<string, unknown>) => Promise<unknown>> = {
    "backfill-contributor-gate-history": (env, payload) =>
      backfillContributorGateHistory(env, typeof payload.limit === "number" ? { limit: payload.limit } : {}),
    "refresh-installation-health": (env) => refreshInstallationHealth(env),
  };

  private async fleetRunJob(input: { job: InternalJobName; mode: InternalJobRunMode; payload?: Record<string, unknown> | undefined }): Promise<ToolPayload> {
    this.requireInternal();
    const spec = INTERNAL_JOB_SPEC[input.job];
    const supportedModes: readonly InternalJobRunMode[] = spec.modes;
    if (!supportedModes.includes(input.mode)) {
      // Answered, not thrown: "this job has no inline runner" is information the caller can act on, and
      // the supported list is what it needs to retry correctly.
      return {
        summary: `LoopOver job ${input.job} does not support mode "${input.mode}" (supports: ${supportedModes.join(", ")}).`,
        data: { job: input.job, mode: input.mode, unsupportedMode: true, supportedModes: [...supportedModes] },
      };
    }
    const payload = input.payload ?? {};
    if (spec.messageType === null) {
      const runner = LoopoverMcp.RUN_ONLY_JOBS[input.job]!;
      const result = await runner(this.env, payload);
      await this.auditFleetJob(input.job, "operator.fleet_job_ran", { mode: "run" });
      return { summary: `LoopOver ran job ${input.job} inline.`, data: { job: input.job, mode: input.mode, result: result as unknown } };
    }
    // The route path is not always the queue message type (rag-index -> rag-index-repo,
    // regate-pr -> agent-regate-pr), so the message is built from the spec, never from the job name.
    const message = { ...payload, type: spec.messageType, requestedBy: "mcp" } as unknown as JobMessage;
    if (input.mode === "enqueue") {
      await this.env.JOBS.send(message);
      await this.auditFleetJob(input.job, "operator.fleet_job_enqueued", { mode: "enqueue", messageType: spec.messageType });
      return { summary: `LoopOver queued job ${input.job}.`, data: { job: input.job, mode: input.mode, result: { status: "queued" } } };
    }
    // Inline: the SAME dispatcher the queue consumer runs, so an inline run and a queued run cannot diverge.
    await processJob(this.env, message);
    await this.auditFleetJob(input.job, "operator.fleet_job_ran", { mode: "run", messageType: spec.messageType });
    return { summary: `LoopOver ran job ${input.job} inline.`, data: { job: input.job, mode: input.mode, result: { status: "completed" } } };
  }

  private async auditFleetJob(job: string, eventType: string, metadata: Record<string, unknown>): Promise<void> {
    await recordAuditEvent(this.env, {
      eventType,
      actor: this.identity.actor,
      targetKey: `job#${job}`,
      outcome: "completed",
      metadata: { job, surface: "mcp", ...metadata },
    });
  }

  // ── #9522 hosted-tenant handlers ──────────────────────────────────────
  //
  // These reach the control plane, a separate Worker with its own admin credential. A deployment without
  // one answers `configured: false` -- the same structured "this capability is not wired here" shape the
  // self-host tools use -- rather than erroring, because not administering hosted tenants is a normal
  // state for every deployment except one.
  private controlPlaneUnavailable(action: string): ToolPayload {
    return { summary: `LoopOver cannot ${action}: the hosted control plane is not configured on this deployment.`, data: { configured: false } };
  }

  private async tenantCreate(input: { name: string; product: "ams" | "orb"; schedule?: string | undefined; orbInstallationId?: number | undefined }): Promise<ToolPayload> {
    this.requireInternal();
    if (!isControlPlaneConfigured(this.env)) return this.controlPlaneUnavailable("create a tenant");
    const record = await createTenant(this.env, input);
    await recordAuditEvent(this.env, {
      eventType: "operator.tenant_created",
      actor: this.identity.actor,
      targetKey: `tenant#${input.product}:${input.name}`,
      outcome: "completed",
      metadata: { name: input.name, product: input.product, surface: "mcp" },
    });
    return { summary: `LoopOver created ${input.product} tenant ${input.name}.`, data: { configured: true, ...record } };
  }

  private async tenantList(): Promise<ToolPayload> {
    this.requireInternal();
    if (!isControlPlaneConfigured(this.env)) return this.controlPlaneUnavailable("list tenants");
    const payload = await listTenants(this.env);
    const tenants = Array.isArray(payload.tenants) ? payload.tenants : [];
    return { summary: `LoopOver hosted tenants: ${tenants.length}.`, data: { configured: true, ...payload } };
  }

  private async tenantSetOrbInstallation(input: { name: string; orbInstallationId: number }): Promise<ToolPayload> {
    this.requireInternal();
    if (!isControlPlaneConfigured(this.env)) return this.controlPlaneUnavailable("set a tenant's installation");
    const record = await setTenantOrbInstallation(this.env, input);
    await recordAuditEvent(this.env, {
      eventType: "operator.tenant_orb_installation_set",
      actor: this.identity.actor,
      targetKey: `tenant#orb:${input.name}`,
      outcome: "completed",
      metadata: { name: input.name, orbInstallationId: input.orbInstallationId, surface: "mcp" },
    });
    return { summary: `LoopOver pointed tenant ${input.name} at installation ${input.orbInstallationId}.`, data: { configured: true, ...record } };
  }

  private async tenantDestroy(input: { name: string; product: "ams" | "orb" }, extra?: McpToolExtra, mcpServer?: McpServer): Promise<ToolPayload> {
    this.requireInternal();
    if (!isControlPlaneConfigured(this.env)) return this.controlPlaneUnavailable("destroy a tenant");
    const confirmation = await this.confirmDestructive(
      `Destroy ${input.product} tenant ${input.name}?`,
      "Its container, database, and secrets are torn down. The tenant's data does not survive.",
      extra,
      mcpServer,
    );
    if (confirmation.declined) return { summary: `LoopOver left tenant ${input.name} standing (declined).`, data: { declined: true, name: input.name } };
    const record = await destroyTenant(this.env, input);
    await recordAuditEvent(this.env, {
      eventType: "operator.tenant_destroyed",
      actor: this.identity.actor,
      targetKey: `tenant#${input.product}:${input.name}`,
      outcome: "completed",
      metadata: { name: input.name, product: input.product, surface: "mcp" },
    });
    return { summary: `LoopOver destroyed ${input.product} tenant ${input.name}.`, data: { configured: true, ...record } };
  }

  // ── #9523 hosted AMS tenant handlers ──────────────────────────────────
  //
  // AMS tenant CREATE/LIST/DESTROY are not here: #9522's loopover_tenant_* tools are product-parameterized
  // and already serve product "ams", because the control plane's own routes are. These two are the pair with
  // no ORB counterpart -- an AMS tenant's wake schedule, and triggering a cycle now.
  private async amsTenantHealth(input: { name: string }): Promise<ToolPayload> {
    this.requireInternal();
    if (!isControlPlaneConfigured(this.env)) return this.controlPlaneUnavailable("read a tenant's health");
    const record = await getAmsTenantHealth(this.env, input);
    return { summary: `LoopOver AMS tenant ${input.name}: ${String(record.state ?? "unknown")}.`, data: { configured: true, ...record } };
  }

  private async amsTenantWake(input: { name: string }): Promise<ToolPayload> {
    this.requireInternal();
    if (!isControlPlaneConfigured(this.env)) return this.controlPlaneUnavailable("wake a tenant");
    const record = await wakeAmsTenant(this.env, input);
    // A throttled wake is an ANSWER -- the schedule guard did its job -- so it is not audited as a cycle.
    if (record.throttled !== true) {
      await recordAuditEvent(this.env, {
        eventType: "operator.ams_tenant_woken",
        actor: this.identity.actor,
        targetKey: `tenant#ams:${input.name}`,
        outcome: "completed",
        metadata: { name: input.name, surface: "mcp" },
      });
    }
    return {
      summary: record.throttled === true ? `LoopOver did not wake ${input.name}: its schedule guard refused a wake this soon.` : `LoopOver woke AMS tenant ${input.name}.`,
      data: { configured: true, ...record },
    };
  }

  private requireMcpAdmin(): void {
    if (this.identity.kind === "static" && this.identity.actor === "mcp-admin") return;
    throw new Error("Forbidden: this tool requires the LOOPOVER_MCP_ADMIN_TOKEN credential.");
  }

  /**
   * The `auth: "operator"` gate (#9522), mirroring the HTTP routes' own `requireAppRole(["operator"])`.
   *
   * The shared static `mcp` token is explicitly NOT enough: LOOPOVER_MCP_TOKEN is an end-user-obtainable CLI
   * credential, so treating it as operator would hand the kill switch and the dead-letter queue to anyone
   * who can run the CLI. `api`/`internal` static identities ARE trusted -- they are operator-only Worker
   * secrets that are never handed out -- and a session must actually hold the operator role.
   */
  private async requireOperator(): Promise<void> {
    if (this.identity.kind === "static") {
      if (this.identity.actor === "mcp" || this.identity.actor === "mcp-admin") {
        throw new Error("Forbidden: this tool requires an operator session (insufficient_role).");
      }
      return;
    }
    const summary = await loadControlPanelRoleSummary(this.env, this.identity.actor, this.identity.session?.githubUserId);
    if (!summary.roles.some((role) => role === "operator")) {
      throw new Error("Forbidden: this tool requires the operator role (insufficient_role).");
    }
  }

  /**
   * The `auth: "internal"` gate (#9522): fleet and tenant administration, mirroring the `/v1/internal/*`
   * middleware's INTERNAL_JOB_TOKEN bearer check. Only the owner-held static credentials satisfy it -- no
   * session role grants it, because there is no per-repo scoping that could bound fleet-wide authority.
   */
  private requireInternal(): void {
    if (this.identity.kind === "static" && (this.identity.actor === "internal" || this.identity.actor === "api")) return;
    throw new Error("Forbidden: this tool requires the INTERNAL_JOB_TOKEN credential.");
  }

  /**
   * The confirmation gate every destructive tool shares (#9522 requirement 2).
   *
   * The schema already demands `confirm: true`, so this is the second half: where the client supports
   * elicitation, ASK before doing the irreversible thing, and treat a decline as a structured non-error
   * result rather than a failure -- declining is a valid answer, not a broken call. A client without
   * elicitation support falls through on the schema-level confirm alone, which is the same posture the
   * planning elicitation already takes.
   */
  private async confirmDestructive(
    action: string,
    detail: string,
    extra?: McpToolExtra,
    mcpServer?: McpServer,
  ): Promise<{ declined: boolean }> {
    const elicitationCapabilities = mcpServer?.server.getClientCapabilities()?.elicitation;
    const supported = Boolean(extra && elicitationCapabilities);
    if (!extra || !supported) return { declined: false };
    try {
      const result = await extra.sendRequest(
        {
          method: "elicitation/create",
          params: { message: `${action}\n\n${detail}\n\nThis cannot be undone. Proceed?`, requestedSchema: { type: "object", properties: {} } },
        },
        ElicitResultSchema,
        { timeout: 60_000 },
      );
      return { declined: result.action !== "accept" };
    } catch {
      // A client that advertises elicitation but fails to answer must not silently become an implicit yes
      // for an irreversible action -- treat the failure as a decline.
      return { declined: true };
    }
  }

  private adminScopeRepoFullName(scope: string, repoFullName: string | undefined): string {
    if (scope !== "repo" && scope !== "effective") return "";
    if (!repoFullName) throw new Error(`repoFullName is required when scope is "${scope}".`);
    return repoFullName;
  }

  private async adminGetConfig(input: { scope: "effective" | "global" | "repo"; repoFullName?: string | undefined }): Promise<ToolPayload> {
    this.requireMcpAdmin();
    const functions = getConfigAdminFunctions();
    if (!functions) {
      return {
        summary: "LoopOver admin config tools: not configured (LOOPOVER_REPO_CONFIG_DIR is unset on this instance).",
        data: { configured: false },
      };
    }
    if (input.scope === "effective") {
      const repoFullName = this.adminScopeRepoFullName(input.scope, input.repoFullName);
      const reader = getLocalManifestReader();
      const loaded = reader ? await reader(repoFullName) : null;
      const content = typeof loaded === "string" ? loaded : (loaded?.content ?? null);
      // #9065: previously extracted ONLY `.content`, discarding `.warnings` entirely -- an operator could ask
      // this exact tool "what's effectively loaded for this repo" and see a clean-looking config even when a
      // layer (shared/global/per-repo) had been silently dropped as malformed, or when the merged content
      // itself carries unknown-key warnings. `loaded` is a plain string (no warnings field) on the LEGACY
      // reader shape some tests/older readers still return -- only a LocalManifestLoadResult object carries
      // `.warnings`.
      const warnings = typeof loaded === "string" || loaded === null ? [] : loaded.warnings;
      return {
        summary: content === null ? `LoopOver admin config: no effective config found for ${repoFullName}.` : `LoopOver admin config: effective config loaded for ${repoFullName}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}.`,
        data: { configured: true, found: content !== null, path: null, content, warnings },
      };
    }
    const hit =
      input.scope === "global"
        ? await functions.readGlobal()
        : await functions.readRepo(this.adminScopeRepoFullName(input.scope, input.repoFullName));
    return {
      summary: hit ? `LoopOver admin config: ${input.scope} config loaded from ${hit.path}.` : `LoopOver admin config: no ${input.scope} config found.`,
      data: { configured: true, found: hit !== null, path: hit?.path ?? null, content: hit?.content ?? null },
    };
  }

  private async adminWriteConfig(input: {
    scope: "global" | "repo";
    repoFullName?: string | undefined;
    content: string;
    dryRun?: boolean | undefined;
  }): Promise<ToolPayload> {
    this.requireMcpAdmin();
    if (input.scope === "repo" && !input.repoFullName) {
      throw new Error('repoFullName is required when scope is "repo".');
    }
    if (input.dryRun) {
      // Reuses the richer, schema-aware validator loopover_validate_config already exposes (unknown-field
      // warnings, not just "is this valid YAML/JSON") -- a dry run is meant to preview what a real write
      // would accept, so it should apply the SAME bar an operator would otherwise only discover by writing
      // for real. The actual write path below still runs its own independent structural check
      // (validateConfigWriteContent in private-config.ts) before touching disk regardless.
      const report = buildFocusManifestValidation({ content: input.content, source: "repo_file" });
      return {
        summary: `LoopOver admin config dry run: ${report.status}.`,
        data: { configured: true, dryRun: true, ...report } as unknown as Record<string, unknown>,
      };
    }
    const functions = getConfigAdminFunctions();
    if (!functions) {
      return {
        summary: "LoopOver admin config tools: not configured (LOOPOVER_REPO_CONFIG_DIR is unset on this instance).",
        data: { configured: false },
      };
    }
    const result =
      input.scope === "global" ? await functions.writeGlobal(input.content) : await functions.writeRepo(input.repoFullName!, input.content);
    // #9137: rewrites the instance's private .loopover.yml FLEET-WIDE (global scope) or per-repo -- the
    // sharpest unaudited write this issue calls out (previously left only a `.bak-<timestamp>` file on disk).
    // A dedicated event type, not repo.settings_updated: this is the raw config FILE the focus-manifest
    // loader reads, not the DB-backed RepositorySettings row. Audited on failure too, so "who attempted a
    // write, and when" is answerable even when the write itself was rejected.
    await recordAuditEvent(this.env, {
      eventType: "config.private_write",
      actor: this.identity.actor,
      targetKey: input.scope === "global" ? "global" : input.repoFullName!,
      outcome: result.ok ? "success" : "error",
      detail: result.ok
        ? `Wrote ${input.scope} config to ${result.path}${result.backupPath ? ` (backed up to ${result.backupPath})` : ""}.`
        : `Failed to write ${input.scope} config: ${result.error}`,
      metadata: { scope: input.scope, ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}), ok: result.ok },
    });
    if (!result.ok) {
      return {
        summary: `LoopOver admin config write failed: ${result.error}`,
        data: { configured: true, ok: false, error: result.error },
      };
    }
    return {
      summary: `LoopOver admin config written to ${result.path}${result.backupPath ? ` (backed up to ${result.backupPath})` : ""}.`,
      data: { configured: true, ok: true, path: result.path, backupPath: result.backupPath },
    };
  }

  private async adminListConfigBackups(input: { scope: "global" | "repo"; repoFullName?: string | undefined }): Promise<ToolPayload> {
    this.requireMcpAdmin();
    if (input.scope === "repo" && !input.repoFullName) {
      throw new Error('repoFullName is required when scope is "repo".');
    }
    const functions = getConfigAdminFunctions();
    if (!functions) {
      return {
        summary: "LoopOver admin config tools: not configured (LOOPOVER_REPO_CONFIG_DIR is unset on this instance).",
        data: { configured: false },
      };
    }
    const scope: ConfigAdminScope = input.scope === "global" ? { kind: "global" } : { kind: "repo", repoFullName: input.repoFullName! };
    const backups = await functions.listBackups(scope);
    return {
      summary: `LoopOver admin config: ${backups.length} backup(s) for ${input.scope === "global" ? "the global config" : input.repoFullName}.`,
      data: { configured: true, backups: backups as unknown as Array<Record<string, unknown>> },
    };
  }

  private async adminTriggerRedeploy(input: { image?: string | undefined }): Promise<ToolPayload> {
    this.requireMcpAdmin();
    const trigger = getRedeployTrigger();
    if (!trigger) {
      return {
        summary: "LoopOver redeploy trigger: not configured (REDEPLOY_COMPANION_TOKEN is unset on this instance, or the companion isn't installed).",
        data: { configured: false },
      };
    }
    try {
      const result = await trigger(input.image);
      // #9137: redeploys the instance -- audited regardless of outcome so "who triggered a redeploy, and
      // when" is answerable even when the companion itself reports a failed run.
      await recordAuditEvent(this.env, {
        eventType: "instance.redeploy_triggered",
        actor: this.identity.actor,
        targetKey: input.image ?? "default",
        outcome: result.ok ? "success" : "error",
        detail: result.ok
          ? `Redeploy completed successfully${input.image ? ` (${input.image})` : ""}.`
          : `Redeploy failed (exit ${result.exitCode ?? "unknown"}): ${result.error ?? "see log"}.`,
        metadata: { image: input.image ?? null, ok: result.ok, exitCode: result.exitCode ?? null },
      });
      return {
        summary: result.ok
          ? `LoopOver redeploy: completed successfully${input.image ? ` (${input.image})` : ""}.`
          : `LoopOver redeploy failed (exit ${result.exitCode ?? "unknown"}): ${result.error ?? "see log"}.`,
        data: { configured: true, ok: result.ok, exitCode: result.exitCode, log: result.log, ...(result.error !== undefined ? { error: result.error } : {}) },
      };
    } catch (error) {
      // A connection/protocol failure to the companion itself (socket missing, timeout, unauthorized) --
      // distinct from a redeploy that ran and failed (handled above via result.ok === false).
      const message = error instanceof Error ? error.message : String(error);
      await recordAuditEvent(this.env, {
        eventType: "instance.redeploy_triggered",
        actor: this.identity.actor,
        targetKey: input.image ?? "default",
        outcome: "error",
        detail: `Could not reach the host companion: ${message}`,
        metadata: { image: input.image ?? null, ok: false, exitCode: null },
      });
      return {
        summary: `LoopOver redeploy trigger: could not reach the host companion: ${message}`,
        data: { configured: true, ok: false, exitCode: null, error: message },
      };
    }
  }

  private async adminRotateSecret(input: { secret: string; value: string }): Promise<ToolPayload> {
    this.requireMcpAdmin();
    const rotator = getSecretRotator();
    if (!rotator) {
      return {
        summary: "LoopOver secret rotation: not configured (REDEPLOY_COMPANION_TOKEN is unset on this instance, or the companion isn't installed).",
        data: { configured: false },
      };
    }
    // Everything below is deliberately secret-free: the audit row, the summary, and the tool result carry
    // only WHICH secret was rotated, never the value or any prefix/suffix of it.
    try {
      const result = await rotator(input.secret, input.value);
      await recordAuditEvent(this.env, {
        eventType: "instance.secret_rotated",
        actor: this.identity.actor,
        targetKey: input.secret,
        outcome: result.ok ? "success" : "error",
        detail: result.ok ? `Rotated ${input.secret} on the host.` : `Rotation of ${input.secret} failed: ${result.error ?? "unknown error"}.`,
        metadata: { secret: input.secret, ok: result.ok },
      });
      return {
        summary: result.ok
          ? `LoopOver secret rotation: ${input.secret} rotated on the host.${input.secret === "claude_code_oauth_token" ? " No restart needed -- the token is re-read per AI call." : " Restart the loopover service for this to take effect."}`
          : `LoopOver secret rotation failed for ${input.secret}: ${result.error ?? "unknown error"}.`,
        data: {
          configured: true,
          ok: result.ok,
          secret: input.secret,
          ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      };
    } catch (error) {
      // A connection/protocol failure to the companion itself -- distinct from a rotation that ran and
      // was refused (handled above via result.ok === false).
      const message = error instanceof Error ? error.message : String(error);
      await recordAuditEvent(this.env, {
        eventType: "instance.secret_rotated",
        actor: this.identity.actor,
        targetKey: input.secret,
        outcome: "error",
        detail: `Could not reach the host companion: ${message}`,
        metadata: { secret: input.secret, ok: false },
      });
      return {
        summary: `LoopOver secret rotation: could not reach the host companion: ${message}`,
        data: { configured: true, ok: false, secret: input.secret, error: message },
      };
    }
  }

  private async canAccessRepo(fullName: string): Promise<boolean> {
    if (this.identity.kind === "session") return canLoginAccessRepo(this.env, this.identity.actor, fullName, this.identity.session?.githubUserId);
    // The static `mcp` identity is a shared, end-user-obtainable CLI credential — scope it to the operator's
    // MCP_READ_REPO_ALLOWLIST instead of trusting it for every installed repo, mirroring requireRepoManageAccess's
    // MCP_ACTUATION_REPO_ALLOWLIST scoping for writes. api/internal static identities remain trusted (operator-only
    // Worker secrets, never handed to end users). (#2455)
    if (this.identity.kind === "static" && this.identity.actor === "mcp") {
      return isMcpReadRepoAllowed(this.env.MCP_READ_REPO_ALLOWLIST, fullName);
    }
    return true;
  }

  private async getRepoOutcomePatterns(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const response = await loadOrComputeRepoOutcomePatternsResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `LoopOver has no cached repo outcome patterns for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary:
        response.source === "snapshot"
          ? `LoopOver repo outcome patterns for ${fullName} (cached, ${response.freshness}).`
          : `LoopOver repo outcome patterns for ${fullName} (computed from cached metadata).`,
      data: response as unknown as Record<string, unknown>,
    };
  }

  private async getOutcomeCalibration(input: { owner: string; repo: string; windowDays?: number | undefined }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await buildRepoOutcomeCalibration(this.env, fullName, input.windowDays);
    return {
      summary: outcomeCalibrationSummary(fullName, report.slop),
      data: report as unknown as Record<string, unknown>,
    };
  }

  // #2220 - surface the existing gate-precision measurement over MCP. Same per-repo read gate as
  // getOutcomeCalibration (requireRepoAccess); loadGatePrecisionReport is measurement-only and already
  // scoped to the single repo, so nothing cross-repo is revealed. The options object is spread-omitted
  // when windowDays is absent to satisfy exactOptionalPropertyTypes.
  private async getGatePrecision(input: { owner: string; repo: string; windowDays?: number | undefined }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const report = await loadGatePrecisionReport(this.env, fullName, input.windowDays === undefined ? {} : { windowDays: input.windowDays });
    return {
      summary: `LoopOver gate precision for ${fullName}: ${report.overall.blocked} gate blocks, overall false-positive rate ${report.overall.falsePositiveRate ?? "n/a (below sample threshold)"}.`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  // (#7798) MCP surface for GET /v1/repos/:owner/:repo/selftune/overrides/audit. Same per-repo read gate as
  // getGatePrecision (requireRepoAccess); listOverrideAudit is read-only, already repo-scoped, and returns []
  // on any storage error, so the tool mirrors the route's { repoFullName, audit } shape exactly. The summary is
  // deliberately branch-free.
  private async getSelftuneOverrideAudit(input: { owner: string; repo: string; limit?: number | undefined }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const audit = await listOverrideAudit(this.env as unknown as StorageEnv, fullName, input.limit);
    return {
      summary: `LoopOver self-tune override audit for ${fullName}: ${audit.length} event(s).`,
      data: { repoFullName: fullName, audit },
    };
  }

  // (#8660) MCP surface for DELETE /v1/repos/:owner/:repo/selftune/overrides. Uses the same maintainer-MANAGE
  // gate as the sibling write tools (loopover_set_agent_paused/loopover_set_action_autonomy) — stricter than the
  // audit tool's read gate — and calls the exact deleteLiveOverride the REST route already uses, returning the
  // route's { repoFullName, cleared: true } shape. Branch-free: `confirm` is enforced by the input schema.
  private async clearSelftuneOverride(input: z.infer<typeof ClearSelftuneOverrideInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    await deleteLiveOverride(this.env as unknown as StorageEnv, fullName);
    return {
      summary: `Cleared the live self-tune gate override for ${fullName}.`,
      data: { repoFullName: fullName, cleared: true },
    };
  }

  // (#9298) Mirrors POST /v1/repos/:owner/:repo/pulls/:number/incident-reports (#5672): maintainer-manage
  // gate, then the REST route's exact PR-must-exist-and-be-merged validation, then the same
  // recordPostMergeIncidentReport persistence (reporterKind "customer", the calling actor) and response shape.
  // Missing/unmerged PRs return the route's 404/409 error codes as a normal `{ ok: false, error }` tool result.
  private async fileIncidentReport(input: z.infer<typeof FileIncidentReportInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const pullRequest = await getPullRequest(this.env, fullName, input.number);
    if (!pullRequest) {
      return {
        summary: `No pull request ${fullName}#${input.number} to file a post-merge incident report against.`,
        data: { ok: false, error: "pull_request_not_found", repoFullName: fullName, pullNumber: input.number },
      };
    }
    if (!pullRequest.mergedAt) {
      return {
        summary: `Pull request ${fullName}#${input.number} is not merged; a post-merge incident report cannot be filed.`,
        data: { ok: false, error: "pull_request_not_merged", repoFullName: fullName, pullNumber: input.number },
      };
    }
    const actor = this.identity.kind === "session" ? this.identity.actor : "mcp";
    const report = await recordPostMergeIncidentReport(this.env, {
      repoFullName: fullName,
      pullNumber: input.number,
      description: input.description,
      severity: input.severity,
      mergedSha: input.mergedSha,
      reporterKind: "customer",
      actor,
      route: `/v1/repos/${input.owner}/${input.repo}/pulls/${input.number}/incident-reports`,
    });
    return {
      summary: `Filed a post-merge incident report on ${fullName}#${input.number} (severity ${input.severity}).`,
      data: { ok: true, repoFullName: fullName, pullNumber: input.number, ...report },
    };
  }

  // #5825 - repo-scope resolution for the skipped-PR audit tool. Mirrors skippedPrAuditRepoScope in
  // src/api/routes.ts (same underlying loadControlPanelRoleSummary/loadControlPanelAccessScope calls,
  // same maintainer/owner/operator role gate, same "no filter -> caller's own scoped repos" fallback),
  // adapted to this file's MCP identity/throw conventions since that route helper is bound to a Hono
  // ProtectedRouteContext and returns a Response, neither of which fits an MCP tool method. The shared
  // static `mcp` CLI token is NOT trusted implicitly for this cross-repo maintainer report (unlike the
  // route's own static identities, which are operator-only Worker secrets) -- it must opt in via the
  // unscoped MCP_READ_REPO_ALLOWLIST wildcard, matching requireOperatorAccess/requireDiscoveryAccess above.
  private async requireSkippedPrAuditAccess(requestedRepo: string | undefined): Promise<string[] | undefined> {
    if (this.identity.kind === "session") {
      const [summary, scope] = await Promise.all([loadControlPanelRoleSummary(this.env, this.identity.actor, this.identity.session?.githubUserId), this.loadSessionAccessScope()]);
      if (!summary.roles.some((role) => role === "maintainer" || role === "owner" || role === "operator")) {
        throw new Error("Forbidden: maintainer, owner, or operator role is required for the skipped-PR audit.");
      }
      if (scope.operator) return requestedRepo ? [requestedRepo] : undefined;
      if (!requestedRepo) return scope.repositoryFullNames;
      if (!scope.repositoryFullNames.some((name) => name.toLowerCase() === requestedRepo.toLowerCase())) {
        throw new Error("Forbidden: session cannot access this repository's skipped-PR audit.");
      }
      return [requestedRepo];
    }
    if (this.identity.kind === "static" && this.identity.actor === "mcp" && !isMcpReadUnscoped(this.env.MCP_READ_REPO_ALLOWLIST)) {
      throw new Error("Forbidden: this MCP token is not authorized for the skipped-PR audit.");
    }
    return requestedRepo ? [requestedRepo] : undefined;
  }

  private async getSkippedPrAudit(input: {
    repoFullName?: string | undefined;
    reason?: PublicSurfaceSkipReason | undefined;
    since?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }): Promise<ToolPayload> {
    const repoFullNames = await this.requireSkippedPrAuditAccess(input.repoFullName);
    let sinceIso: string | undefined;
    if (input.since !== undefined) {
      const timestamp = Date.parse(input.since);
      if (!Number.isFinite(timestamp)) throw new Error(`Invalid since: "${input.since}" is not a parseable date.`);
      sinceIso = new Date(timestamp).toISOString();
    }
    const page = await listPrVisibilitySkipAuditEvents(this.env, {
      limit: input.limit,
      offset: input.offset,
      repoFullNames,
      reason: input.reason,
      sinceIso,
    });
    return {
      summary: `LoopOver skipped-PR audit: ${page.items.length} event(s) (limit ${page.limit}, offset ${page.offset}${page.hasMore ? ", more available" : ""}).`,
      data: {
        generatedAt: nowIso(),
        limit: page.limit,
        offset: page.offset,
        hasMore: page.hasMore,
        filters: {
          repoFullName: input.repoFullName ?? null,
          reason: input.reason ?? null,
          since: sinceIso ?? null,
        },
        items: page.items.map((item) => ({
          repoFullName: item.repoFullName,
          pullNumber: item.pullNumber,
          reason: item.reason,
          timestamp: item.createdAt,
          remediation: skippedPrAuditRemediation(item.reason),
        })),
      },
    };
  }

  // #2224 - surface the deterministic open-PR pressure simulator over MCP. Pure and read-only: the caller
  // supplies all queue/role context, so nothing beyond a computation on that input is revealed and no repo
  // access is required (mirrors loopover_run_local_scorer). Output is already public-safe - every scenario
  // line is scrubbed through sanitizePublicComment inside simulateOpenPrPressure.
  private simulateOpenPrPressureTool(input: z.infer<z.ZodObject<typeof simulateOpenPrPressureShape>>): ToolPayload {
    const simulation = simulateOpenPrPressure(input as unknown as OpenPrPressureInput);
    return {
      summary: simulation.summary,
      data: simulation as unknown as Record<string, unknown>,
    };
  }

  // Operator-only gate, shared by every cross-repo tool (fleet analytics, recommendation quality, ...): those
  // reports aggregate ALL self-hosters'/repos' data, so a session must be an operator. api/internal static
  // identities are trusted (operator-only Worker secrets). The static `mcp` identity is NOT trusted by default
  // — it is a shared, end-user-obtainable CLI credential, and these operator-only reports have no single repo
  // to scope a MCP_READ_REPO_ALLOWLIST entry against, so only the full wildcard opt-in (mirroring
  // requireContributorAccess) unlocks them. (#2455)
  private async requireOperatorAccess(): Promise<void> {
    if (this.identity.kind === "session") {
      const scope = await this.loadSessionAccessScope();
      if (scope.operator) return;
      throw new Error("Forbidden: operator authority is required for this operator-only tool.");
    }
    if (this.identity.kind === "static" && this.identity.actor === "mcp" && !isMcpReadUnscoped(this.env.MCP_READ_REPO_ALLOWLIST)) {
      throw new Error("Forbidden: this MCP token is not authorized for operator-only cross-repo tools.");
    }
  }

  private async getFleetAnalytics(input: { windowDays?: number | undefined }): Promise<ToolPayload> {
    await this.requireOperatorAccess();
    const report = await computeFleetAnalytics(this.env, input.windowDays !== undefined ? { windowDays: input.windowDays } : {});
    const merge = report.fleet.mergePrecision !== null ? `${Math.round(report.fleet.mergePrecision * 100)}%` : "n/a";
    return {
      summary: `Fleet calibration over ${report.windowDays}d: ${report.instanceCount} instance(s), median merge precision ${merge}, ${report.outliers.length} outlier(s), ${report.gamingPatternFlags.length} gaming-pattern flag(s).`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getRecommendationQuality(input: { windowDays?: number | undefined }): Promise<ToolPayload> {
    await this.requireOperatorAccess();
    const report = await buildRecommendationQualityReport(this.env, input.windowDays !== undefined ? { windowDays: input.windowDays } : {});
    return {
      summary: report.privateSummary,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async loadOpenQueueCounts(fullName: string): Promise<{ openIssues: number; openPullRequests: number }> {
    const [totals, openIssues, openPullRequests] = await Promise.all([
      getLatestRepoGithubTotalsSnapshot(this.env, fullName),
      countOpenIssues(this.env, fullName),
      countOpenPullRequests(this.env, fullName),
    ]);
    return {
      openIssues: totals?.openIssuesTotal ?? openIssues,
      openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
    };
  }

  private async getContributorProfile(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const [github, pullRequests, issues, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(login, this.env),
      listContributorPullRequests(this.env, login),
      listContributorIssues(this.env, login),
      listContributorRepoStats(this.env, login),
      fetchGittensorContributorSnapshot(login),
    ]);
    const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
    return {
      summary: `LoopOver contributor profile for ${login}.`,
      data: buildContributorProfile(login, github, pullRequests, issues, repoStats, gittensorSnapshot) as unknown as Record<string, unknown>,
    };
  }

  private async getDecisionPack(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const serving = await loadContributorDecisionPackForServing(this.env, login);
    if (serving.kind === "ready") {
      return {
        summary: decisionPackSummary(login, serving.pack.freshness, serving.pack.rebuildEnqueued),
        data: serving.pack as unknown as Record<string, unknown>,
      };
    }
    return {
      summary: `LoopOver decision pack for ${login} needs a snapshot refresh.`,
      data: serving.refresh as unknown as Record<string, unknown>,
    };
  }

  private async monitorOpenPullRequests(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const monitor = await buildContributorOpenPrMonitor(this.env, login);
    return {
      summary: monitor.summary,
      data: monitor as unknown as Record<string, unknown>,
    };
  }

  // Per-actor rate-limit for slop-check tools: 20 calls per 5 min prevents systematic weight enumeration
  // via controlled inputs. Skips gracefully when RATE_LIMITER is unavailable (test / local environments).
  private async enforceToolRateLimit(toolName: string): Promise<void> {
    if (!this.env.RATE_LIMITER) return;
    const key = `mcp-tool:${toolName}:${this.identity.actor}`;
    const id = this.env.RATE_LIMITER.idFromName(key);
    const response = await this.env.RATE_LIMITER.get(id).fetch("https://rate-limit/check", {
      method: "POST",
      body: JSON.stringify({ key, limit: 20, windowSeconds: 300 }),
    });
    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { retryAfterSeconds?: number };
      throw new Error(`Rate limit exceeded. Retry after ${body.retryAfterSeconds ?? 60}s.`);
    }
  }

  private async intakeIdea(input: z.infer<typeof IntakeIdeaInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_intake_idea");
    const validated = validateIdeaSubmission(input);
    if (!validated.ok) {
      return {
        summary: `Invalid idea submission: ${validated.errors.join(", ")}.`,
        data: { ok: false, errors: validated.errors } as unknown as Record<string, unknown>,
      };
    }
    const taskGraph = buildTaskGraph(validated.idea, input.decomposition);
    return {
      summary: `Task-graph verdict: ${taskGraph.rubric.verdict} across ${taskGraph.issues.length} issue(s).`,
      data: { ok: true, verdict: taskGraph.rubric.verdict, taskGraph } as unknown as Record<string, unknown>,
    };
  }

  private async planIdeaClaims(input: z.infer<typeof IntakeIdeaInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_plan_idea_claims");
    const validated = validateIdeaSubmission(input);
    if (!validated.ok) {
      return {
        summary: `Invalid idea submission: ${validated.errors.join(", ")}.`,
        data: { ok: false, errors: validated.errors } as unknown as Record<string, unknown>,
      };
    }
    const graph = buildTaskGraph(validated.idea, input.decomposition);
    const claimPlan = buildClaimPlan(graph, validated.idea.targetRepo);
    return {
      summary: `Claim plan: ${claimPlan.claimable.length} claimable, ${claimPlan.deferred.length} deferred, ${claimPlan.skipped.length} skipped.`,
      data: { ok: true, verdict: claimPlan.graphVerdict, claimPlan } as unknown as Record<string, unknown>,
    };
  }

  private async buildLoopResults(input: z.infer<typeof BuildResultsPayloadInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_build_results_payload");
    const payload = buildResultsPayload(input);
    return {
      summary: payload.summary,
      data: payload as unknown as Record<string, unknown>,
    };
  }

  private async evalEscalation(input: z.infer<typeof EvaluateEscalationInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_evaluate_escalation");
    const decision = evaluateEscalation(input);
    return {
      summary: `Escalation: ${decision.action} (severity ${decision.severity}), ${decision.reasons.length} reason(s).`,
      data: decision as unknown as Record<string, unknown>,
    };
  }

  private async buildLoopProgress(input: z.infer<typeof BuildProgressSnapshotInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_build_progress_snapshot");
    const snapshot = buildProgressSnapshot(input);
    return {
      summary: `Loop progress: ${snapshot.phase} (${snapshot.status}), iteration ${snapshot.iteration}.`,
      data: snapshot as unknown as Record<string, unknown>,
    };
  }

  private async checkSlopRisk(input: z.infer<typeof CheckSlopRiskInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_check_slop_risk");
    const assessment = buildSlopAssessment(input);
    // Return band + findings only — omit the exact numeric score and rubric thresholds to prevent
    // weight reverse-engineering via controlled inputs (#mcp-slop-blunt).
    return {
      summary: `Slop risk: ${assessment.band}.`,
      data: { band: assessment.band, findings: assessment.findings } as unknown as Record<string, unknown>,
    };
  }

  private async checkImprovementPotential(
    input: z.infer<typeof CheckImprovementPotentialInput>,
  ): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_check_improvement_potential");
    const assessment = buildStructuralImprovementAssessment(input);
    return {
      summary: `Improvement potential: ${assessment.band}.`,
      data: {
        improvementScore: assessment.improvementScore,
        band: assessment.band,
        findings: assessment.findings,
      } as unknown as Record<string, unknown>,
    };
  }

  private async checkTestEvidence(input: z.infer<typeof CheckTestEvidenceInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_check_test_evidence");
    // #6749: the classification/guidance logic now lives in the engine's buildTestEvidenceReport, shared with
    // POST /v1/lint/test-evidence and the local CLI mirror so all three surfaces agree by construction.
    const report = buildTestEvidenceReport(input);
    return {
      summary: `Test evidence: ${report.classification}.`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async checkIssueSlop(input: z.infer<typeof CheckIssueSlopInput>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_check_issue_slop");
    const assessment = buildIssueSlopAssessment(input);
    return {
      summary: `Issue slop risk: ${assessment.band}.`,
      data: { band: assessment.band, findings: assessment.findings } as unknown as Record<string, unknown>,
    };
  }

  private suggestBoundaryTests(input: z.infer<typeof SuggestBoundaryTestsInput>): ToolPayload {
    const changedPaths = new Set(input.changedFiles.map((file) => file.path));
    const touches = (input.boundaryTouches ?? []).filter((touch) => changedPaths.has(touch.path));
    const finding = buildBoundaryTestGenerationFinding({ touches, tests: input.tests, testFiles: input.testFiles });
    const spec = finding ? buildBoundaryTestGenerationSpec(touches) : null;
    return {
      summary: finding ? "Boundary-condition code changed without test evidence." : "No boundary-condition gap detected.",
      data: { finding, spec } as unknown as Record<string, unknown>,
    };
  }

  /** Shared resolution + prediction behind BOTH loopover_predict_gate and loopover_explain_gate_disposition
   *  (#2234): resolves the repo's public data + config and runs the SAME deterministic predictor, so the two tools
   *  can never diverge (one returns the top-line verdict, the other the itemized per-rule dispositions). */
  private async computePredictedGateVerdict(
    input: z.infer<typeof PredictGateInput>,
  ): Promise<{ repoFullName: string; verdict: PredictedGateVerdict }> {
    // #9138: shared by both loopover_predict_gate and loopover_explain_gate_disposition -- neither previously
    // called enforceToolRateLimit, so the only ceiling was the shared /mcp route class (120/min), well above
    // what's needed to flood predicted_gate_calls and drive the agreement metric toward 100%.
    await this.enforceToolRateLimit("loopover_predict_gate");
    this.requireContributorAccess(input.login);
    const repoFullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(repoFullName);
    const [repo, issues, pullRequests, bounties, issueQuality, manifest] = await Promise.all([
      getRepository(this.env, repoFullName),
      listIssues(this.env, repoFullName),
      listPullRequests(this.env, repoFullName),
      listBountiesByRepo(this.env, repoFullName),
      loadOrComputeIssueQualityResponse(this.env, repoFullName),
      loadPublicRepoFocusManifest(this.env, repoFullName),
    ]);
    // Resolve the caller's own confirmed-Gittensor status the same way the maintainer pipeline does (official
    // Gittensor API → confirmed). It is surfaced in the verdict for transparency but no longer changes the
    // predicted conclusion — every author is gated identically, so a blocker predicts `failure` regardless of
    // confirmed status (parity with the new real gate). The oss-anti-slop pack carries no contributor field at
    // all, so skip the lookup there (keeps the prediction account-free for non-Gittensor adopters).
    const pack = manifest.gate.pack ?? "gittensor";
    const confirmedContributor = pack === "oss-anti-slop" ? undefined : (await fetchGittensorContributorSnapshot(input.login)) !== null;
    // #2349: this login's own predict-vs-real track record, personalizing ONLY the returned readinessScore
    // (see buildPredictedGateVerdict's contributorCalibration doc comment for the safety boundary).
    const contributorCalibration = await computeContributorCalibration(this.env, input.login);
    const verdict = buildPredictedGateVerdict({
      input: {
        repoFullName,
        contributorLogin: input.login,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.linkedIssues === undefined ? {} : { linkedIssues: input.linkedIssues }),
      },
      manifest,
      repo,
      issues,
      pullRequests,
      bounties,
      issueQuality: issueQuality?.report,
      confirmedContributor,
      ...(input.changedPaths === undefined ? {} : { changedPaths: input.changedPaths }),
      contributorCalibration,
    });
    // #predicted-live-gate-agreement: record this call so a later real gate decision for the same
    // (repo, login) can be paired against it (src/review/predicted-gate-agreement.ts). Shared by BOTH
    // predictGate and explainGateDisposition (this function backs both tools) -- a caller that invokes both
    // for what is really one logical check records two rows, a small, acceptable volume over-count rather
    // than threading a request-scoped dedup key through a read-only prediction path. Best-effort; never
    // blocks or fails the tool response.
    await recordPredictedGateCall(this.env, { login: input.login, project: repoFullName, verdict });
    return { repoFullName, verdict };
  }

  private async predictGate(input: z.infer<typeof PredictGateInput>): Promise<ToolPayload> {
    const { repoFullName, verdict } = await this.computePredictedGateVerdict(input);
    return {
      summary: `Predicted LoopOver gate for ${repoFullName} under the ${verdict.pack} pack: ${verdict.conclusion}.`,
      data: verdict as unknown as Record<string, unknown>,
    };
  }

  /** #2234: the itemized per-rule dispositions behind predict_gate's verdict — which specific gate rules would
   *  block vs advise, and why. Reuses computePredictedGateVerdict (identical prediction), then reshapes it via the
   *  pure buildGateDispositions. Read-only reasoning surface — no merge/close decision. */
  private async explainGateDisposition(input: z.infer<typeof PredictGateInput>): Promise<ToolPayload> {
    const { repoFullName, verdict } = await this.computePredictedGateVerdict(input);
    const dispositions = buildGateDispositions(verdict);
    const blocking = dispositions.filter((disposition) => disposition.status === "block").length;
    return {
      summary: `Gate disposition for ${repoFullName} under the ${verdict.pack} pack: ${verdict.conclusion} — ${blocking} blocking rule(s), ${dispositions.length - blocking} advisory.`,
      data: { conclusion: verdict.conclusion, pack: verdict.pack, dispositions } as unknown as Record<string, unknown>,
    };
  }

  private async prOutcomes(login: string, limit?: number): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const payload = await buildContributorPrOutcomes(this.env, login, limit);
    return {
      summary: payload.summary,
      data: payload as unknown as Record<string, unknown>,
    };
  }

  private async getPrAiReviewFindings(input: z.infer<typeof GetPrAiReviewFindingsInput>): Promise<ToolPayload> {
    // #9537: `number` is canonical and `pullNumber` the compatibility alias -- the two servers
    // disagreed on the field name, and both are accepted so neither side's live callers break.
    const pullNumber = input.number ?? input.pullNumber;
    // Both fields are optional in the contract so the two servers can share one input; exactly one
    // of each pair is genuinely required, and a missing one is a caller error with a clear message
    // rather than a schema rejection naming a field the caller did not use.
    if (pullNumber === undefined) throw new Error("A pull-request number is required: pass `number`.");
    if (!input.login) throw new Error("A contributor login is required: pass `login`.");
    const login = input.login;
    this.requireContributorAccess(login);
    const repoFullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(repoFullName);
    const pullRequest = await getPullRequest(this.env, repoFullName, pullNumber);
    if (!pullRequest) {
      return {
        summary: `No pull request ${repoFullName}#${pullNumber}.`,
        data: {
          status: "not_found",
          repoFullName,
          pullNumber: pullNumber,
          login: login.toLowerCase(),
          findings: [],
          categoryCounts: {},
        },
      };
    }
    assertContributorOwnsPullRequest(pullRequest.authorLogin, login);
    const payload = await loadPrAiReviewFindings(this.env, {
      repoFullName,
      pullNumber: pullNumber,
      login: login,
    });
    const findingCount = payload.status === "ready" ? payload.findings.length : 0;
    const summary =
      payload.status === "ready"
        ? `${findingCount} AI-review finding(s) on ${repoFullName}#${pullNumber}.`
        : payload.status === "ai_review_off"
          ? `AI review is off for ${repoFullName}; no findings to return for #${pullNumber}.`
          : `No published AI review findings for ${repoFullName}#${pullNumber}.`;
    return {
      summary,
      data: payload as unknown as Record<string, unknown>,
    };
  }

  private async listNotifications(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const deliveries = await listNotificationDeliveriesForRecipient(this.env, login, { channel: "badge", limit: 50 });
    const feed = buildNotificationFeed(login, deliveries);
    return {
      summary: `LoopOver notifications for ${login}: ${feed.unreadCount} unread.`,
      data: feed as unknown as Record<string, unknown>,
    };
  }

  // #699 path B: manage a miner's issue-watch subscriptions. Self-scoped; watch/unwatch need repoFullName.
  private async watchIssues(input: z.infer<typeof WatchIssuesInput>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    let changed: string | undefined;
    if (input.action === "watch" || input.action === "unwatch") {
      if (!input.repoFullName) return { summary: `${input.action} requires repoFullName.`, data: {} };
      await this.requireWatchableRepo(input.login, input.repoFullName);
      if (input.action === "watch") {
        await upsertIssueWatchSubscription(this.env, { login: input.login, repoFullName: input.repoFullName, labels: input.labels });
        changed = `watching ${input.repoFullName}${input.labels && input.labels.length > 0 ? ` (labels: ${input.labels.join(", ")})` : ""}`;
      } else {
        const removed = await deleteIssueWatchSubscription(this.env, input.login, input.repoFullName);
        changed = removed ? `unwatched ${input.repoFullName}` : `was not watching ${input.repoFullName}`;
      }
    }
    const watching = (await listIssueWatchSubscriptionsForLogin(this.env, input.login)).map((sub) => ({ repoFullName: sub.repoFullName, labels: sub.labels }));
    return {
      summary: `Watching ${watching.length} repo(s) for new grabbable issues${changed ? ` (${changed})` : ""}.`,
      data: { watching, ...(changed ? { changed } : {}) } as unknown as Record<string, unknown>,
    };
  }

  private async markNotificationsRead(login: string, ids?: string[]): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const marked = await markNotificationDeliveriesRead(this.env, login, ids);
    return {
      summary: `Marked ${marked} LoopOver notification(s) read for ${login}.`,
      data: { login: login.toLowerCase(), marked },
    };
  }

  private async explainRepoDecision(input: { login: string; owner: string; repo: string }): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const serving = await loadContributorDecisionPackForServing(this.env, input.login);
    if (serving.kind === "needs_refresh") {
      return {
        summary: `LoopOver repo decision for ${input.login} in ${fullName} needs a snapshot refresh.`,
        data: { ...serving.refresh, repoFullName: fullName } as unknown as Record<string, unknown>,
      };
    }
    const pack = serving.pack;
    const decision = repoDecisionFromPack(pack, fullName);
    return {
      summary: `LoopOver repo decision for ${input.login} in ${fullName}.`,
      data: {
        status: decision ? "ready" : "not_found",
        login: input.login,
        repoFullName: fullName,
        generatedAt: pack.generatedAt,
        source: pack.source,
        freshness: pack.freshness,
        rebuildEnqueued: pack.rebuildEnqueued,
        decision,
        dataQuality: pack.dataQuality,
      },
    };
  }

  private async getRegistryChanges(): Promise<ToolPayload> {
    const report = buildRegistryChangeReport(await listLatestRegistrySnapshots(this.env, 2));
    return {
      summary: "LoopOver registry changes from latest cached snapshots.",
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async getRegistrySnapshot(): Promise<ToolPayload> {
    // Mirrors GET /v1/registry/snapshot: return the raw latest snapshot, or a normal not-found result
    // (never throw) when nothing has been synced yet — same error code the REST route uses.
    const snapshot = await getLatestRegistrySnapshot(this.env);
    if (!snapshot) {
      return {
        summary: "No registry snapshot has been synced yet.",
        data: { error: "registry_snapshot_not_found" },
      };
    }
    return {
      summary: `Latest registry snapshot (${snapshot.repoCount} repos).`,
      data: snapshot as unknown as Record<string, unknown>,
    };
  }

  private async getUpstreamDrift(): Promise<ToolPayload> {
    const status = await loadUpstreamStatus(this.env);
    const detail =
      status.status === "current"
        ? "upstream ruleset is current"
        : status.status === "drift_detected"
          ? `upstream drift detected (${status.highestSeverity ?? "unknown"})`
          : status.status === "stale"
            ? "upstream ruleset snapshot is stale"
            : "upstream ruleset snapshot is unavailable";
    return {
      summary: `LoopOver upstream drift status: ${detail}.`,
      data: status as unknown as Record<string, unknown>,
    };
  }

  private async getUpstreamRuleset(): Promise<ToolPayload> {
    // Mirrors GET /v1/upstream/ruleset: return the raw latest ruleset snapshot, or a normal not-found
    // result (never throw) when nothing has been synced yet — same error code the REST route uses.
    const ruleset = await getLatestUpstreamRulesetSnapshot(this.env);
    if (!ruleset) {
      return {
        summary: "No upstream ruleset snapshot has been synced yet.",
        data: { error: "upstream_ruleset_not_found" },
      };
    }
    return {
      summary: `Latest upstream ruleset snapshot (${ruleset.activeModel}, ${ruleset.registryRepoCount} repos).`,
      data: ruleset as unknown as Record<string, unknown>,
    };
  }

  private async preflightPr(input: z.infer<typeof PreflightPrInput>): Promise<ToolPayload> {
    await this.requireRepoAccess(input.repoFullName);
    const [repo, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
      loadOrComputeIssueQualityResponse(this.env, input.repoFullName),
    ]);
    return {
      summary: `LoopOver PR preflight for ${input.repoFullName}.`,
      data: buildPreflightResult(input, repo, issues, pullRequests, bounties, issueQuality?.report) as unknown as Record<string, unknown>,
    };
  }

  private async preflightLocalDiff(input: z.infer<typeof PreflightLocalDiffInput>): Promise<ToolPayload> {
    await this.requireRepoAccess(input.repoFullName);
    const [repo, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
      loadOrComputeIssueQualityResponse(this.env, input.repoFullName),
    ]);
    return {
      summary: `LoopOver local diff preflight for ${input.repoFullName}.`,
      data: buildLocalDiffPreflightResult(input, repo, issues, pullRequests, bounties, issueQuality?.report) as unknown as Record<string, unknown>,
    };
  }

  private async previewScore(input: z.infer<typeof RemoteLocalScorePreviewInput>): Promise<ToolPayload> {
    if (input.contributorLogin) this.requireContributorAccess(input.contributorLogin);
    await this.requireRepoAccess(input.repoFullName);
    const [repo, snapshot, evidence, contributorIssues] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      getOrCreateScoringModelSnapshot(this.env),
      input.contributorLogin ? getContributorEvidence(this.env, input.contributorLogin) : Promise.resolve(null),
      input.contributorLogin ? listContributorIssues(this.env, input.contributorLogin) : Promise.resolve([]),
    ]);
    const openIssueCount = contributorOpenIssueCount(contributorIssues, input.repoFullName);
    // Time-decay (#703) is an owner-gated global, injected server-side (not caller-controllable).
    const scoreInput = { ...input, openIssueCount, applyTimeDecay: isTimeDecayEnabled(this.env) };
    const result = buildScorePreview({ input: scoreInput, repo, snapshot, contributorEvidence: evidence });
    return {
      summary: `Private LoopOver scoring preview for ${input.repoFullName}.`,
      data: makeScorePreviewRecord(scoreInput, snapshot, result) as unknown as Record<string, unknown>,
    };
  }

  private async getEligibilityPlan(input: z.infer<typeof RemoteLocalScorePreviewInput>): Promise<ToolPayload> {
    if (input.contributorLogin) this.requireContributorAccess(input.contributorLogin);
    await this.requireRepoAccess(input.repoFullName);
    const [repo, snapshot, evidence, contributorIssues] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      getOrCreateScoringModelSnapshot(this.env),
      input.contributorLogin ? getContributorEvidence(this.env, input.contributorLogin) : Promise.resolve(null),
      input.contributorLogin ? listContributorIssues(this.env, input.contributorLogin) : Promise.resolve([]),
    ]);
    const openIssueCount = contributorOpenIssueCount(contributorIssues, input.repoFullName);
    const scoreInput = { ...input, openIssueCount, applyTimeDecay: isTimeDecayEnabled(this.env) };
    const preview = buildScorePreview({ input: scoreInput, repo, snapshot, contributorEvidence: evidence });
    const plan = deriveEligibilityPlan(preview);
    return {
      summary: plan.publicSummary,
      data: plan as unknown as Record<string, unknown>,
    };
  }

  // #782 — pure deterministic token scorer over caller-supplied changed-file metadata. No repo/contributor
  // access required: it reveals nothing beyond a computation on the caller's own diff stats.
  private runLocalScorer(input: z.infer<typeof RunLocalScorerInput>): ToolPayload {
    const tokenScores = computeLocalScorerTokens({ changedFiles: input.changedFiles, validation: input.validation });
    return {
      summary: `Local token scores — ${tokenScores.sourceTokenScore} source / ${tokenScores.testTokenScore} test / ${tokenScores.nonCodeTokenScore} non-code (total ${tokenScores.totalTokenScore}).`,
      data: {
        tokenScores: tokenScores as unknown as Record<string, unknown>,
        usage: "Pass `tokenScores` as the `localScorer` field of loopover_preview_local_pr_score or the analyze tools to score this branch in external_command mode (off metadata-only).",
      },
    };
  }

  // #780 — wrap a local write-action spec for return. loopover never executes it; the harness runs `command`
  // (or reconstructs from `inputs`) with the miner's own credentials.
  private localWriteSpec(spec: LocalWriteActionSpec): ToolPayload {
    return { summary: `${spec.action}: ${spec.description} ${spec.boundary}`, data: spec as unknown as Record<string, unknown> };
  }

  // #783 plan DAG — pure, stateless transforms over the caller's plan.
  private planView(plan: PlanDag): Record<string, unknown> {
    return {
      plan: plan as unknown as Record<string, unknown>,
      progress: planProgress(plan),
      readySteps: nextReadySteps(plan).map((step) => ({ id: step.id, title: step.title })),
      validation: validatePlanDag(plan),
    };
  }

  private buildPlan(input: z.infer<typeof BuildPlanInput>): ToolPayload {
    const plan = buildPlanDag(input.steps);
    const validation = validatePlanDag(plan);
    return { summary: `Built a ${plan.steps.length}-step plan (${validation.valid ? "valid DAG" : `INVALID: ${validation.errors.join("; ")}`}).`, data: this.planView(plan) };
  }

  private planStatusTool(input: z.infer<typeof PlanStatusInput>): ToolPayload {
    const plan = input.plan as PlanDag;
    return { summary: `Plan status: ${planProgress(plan).status}.`, data: this.planView(plan) };
  }

  private recordStepResult(input: z.infer<typeof RecordStepResultInput>): ToolPayload {
    const plan = applyStepResult(input.plan as PlanDag, input.stepId, { outcome: input.outcome, ...(input.error !== undefined ? { error: input.error } : {}) });
    return { summary: `Recorded ${input.outcome} for step ${input.stepId}; plan is now ${planProgress(plan).status}.`, data: this.planView(plan) };
  }

  // #784 — read the agent automation state for a repo. Repo-access scoped; surfaces the count (not the
  // details) of the approval queue — the full queue + accept/reject stay behind the maintainer-authed REST API.
  private async getAutomationState(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    // Shared with GET /v1/repos/:owner/:repo/automation-state (#6742) so the two surfaces cannot drift.
    const state = await buildAutomationState(this.env, fullName);
    // Spread into a plain object: ToolPayload.data is a Record, and a typed interface has no implicit index sig.
    return { summary: automationStateSummary(state), data: { ...state } };
  }

  // #6087 — pause/resume: the write-side kill-switch counterpart to loopover_get_automation_state's read-only
  // mode/agentPaused fields. Reads the RAW settings row (not resolveRepositorySettings's yaml-merged view --
  // writing back a yaml-only override would wrongly persist it into the DB row) and writes the whole row back,
  // mirroring the PUT /settings route's own read-merge-write so unrelated settings groups are preserved.
  private async setAgentPaused(input: z.infer<typeof SetAgentPausedInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const current = await getRepositorySettings(this.env, fullName);
    const updated = await upsertRepositorySettings(this.env, { ...current, agentPaused: input.paused });
    // #9137: mirror PUT /v1/repos/:owner/:repo/settings' own audit (src/api/routes.ts) -- this is the kill
    // switch, and was previously the only mutating write in this file with no audit_events row at all.
    await recordAuditEvent(this.env, {
      eventType: "repo.settings_updated",
      actor: this.identity.actor,
      targetKey: fullName,
      outcome: "success",
      detail: `Agent actions ${input.paused ? "paused" : "resumed"} for ${fullName} via MCP.`,
      // input.paused (never undefined, per the Zod-validated shape), not updated.agentPaused (typed
      // boolean | undefined for other RepositorySettings read paths) -- upsertRepositorySettings persists
      // exactly this value, so recording the request avoids an always-false `?? fallback` for TS alone.
      metadata: { repoFullName: fullName, fields: ["agentPaused"], agentPaused: input.paused },
    });
    // #9018: a paused->live transition performs no catch-up by default. A PR that went GREEN during the pause
    // window (CI-completion passes plan-and-suppress the whole time) can be permanently stranded: if it was
    // ALSO already regated once before the pause, agent-sweep.ts's #never-endless-reregate rule excludes it
    // from sweep candidacy forever, and the only other wake (a sibling merge) may never fire in a quiet repo.
    // Clearing lastRegatedAt for every open PR restores one-shot candidacy so the sweep re-evaluates and
    // dispositions it without a human or a new commit.
    if (current.agentPaused === true && input.paused === false) {
      await clearPullRequestsRegatedAtForOpenPrs(this.env, fullName);
    }
    return {
      summary: `Agent actions ${input.paused ? "paused" : "resumed"} for ${fullName}.`,
      data: { repoFullName: fullName, agentPaused: updated.agentPaused },
    };
  }

  // #6087 — set-level: the write-side per-action-class autonomy dial. Read-merge-write over the autonomy map
  // (mirrors the CLI's own read-merge-write, loopover-mcp.js:1789-1796) so setting one action class's level
  // never clobbers the others.
  private async setActionAutonomy(input: z.infer<typeof SetActionAutonomyInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const current = await getRepositorySettings(this.env, fullName);
    const autonomy = { ...current.autonomy, [input.action]: input.level };
    const updated = await upsertRepositorySettings(this.env, { ...current, autonomy });
    // #9137: same audit gap as setAgentPaused above -- the autonomy dial (e.g. merge: auto) is the other half
    // of the kill-switch/autonomy pair this issue calls out by name.
    await recordAuditEvent(this.env, {
      eventType: "repo.settings_updated",
      actor: this.identity.actor,
      targetKey: fullName,
      outcome: "success",
      detail: `Set ${input.action} autonomy to ${input.level} for ${fullName} via MCP.`,
      metadata: { repoFullName: fullName, fields: ["autonomy"], action: input.action, level: input.level },
    });
    return {
      summary: `Set ${input.action} autonomy to ${input.level} for ${fullName}.`,
      data: { repoFullName: fullName, action: input.action, level: input.level, autonomy: updated.autonomy },
    };
  }

  // #784 — stage a proposed PR action into the approval queue (#779) for a maintainer to accept/reject. The
  // action is auto_with_approval (never auto-executes); maintainer-manage access required.
  private async proposeAction(input: z.infer<typeof ProposeActionInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const repo = await getRepository(this.env, fullName);
    if (!repo?.installationId) throw new Error("Cannot propose an action: the LoopOver App is not installed on this repository.");
    // Pin the staged action to the head the proposer actually saw. Without this, the approval-queue accept
    // path's force-push freshness guard (stagedHead && stagedHead !== pr.headSha) is a silent no-op for every
    // MCP-staged action, since a falsy stagedHead never triggers it — an unreviewed force-push between
    // proposal and accept would then merge/close/approve undetected. (#2255)
    const pr = await getPullRequest(this.env, fullName, input.pullNumber);
    const params = {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.reviewBody !== undefined ? { reviewBody: input.reviewBody } : {}),
      ...(input.mergeMethod !== undefined ? { mergeMethod: input.mergeMethod } : {}),
      ...(input.closeComment !== undefined ? { closeComment: input.closeComment } : {}),
      ...(pr?.headSha ? { expectedHeadSha: pr.headSha } : {}),
    };
    const { action, created } = await createPendingAgentActionIfAbsent(this.env, {
      repoFullName: fullName,
      pullNumber: input.pullNumber,
      installationId: repo.installationId,
      actionClass: input.actionClass,
      autonomyLevel: "auto_with_approval",
      params,
      reason: input.reason ?? null,
    });
    return {
      summary: `${created ? "Staged" : "Already staged"} a ${input.actionClass} on ${fullName}#${input.pullNumber} for maintainer approval.`,
      data: { created, action: { id: action.id, actionClass: action.actionClass, pullNumber: action.pullNumber, status: action.status, reason: action.reason } },
    };
  }

  // #784 — surface the approval queue an MCP client can already propose into. Maintainer-manage scoped
  // (the full queue with reasons is more sensitive than the bare count in get_automation_state).
  private async listPendingActions(input: z.infer<typeof ListPendingActionsInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoApprovalQueueAccess(fullName);
    const status = input.status ?? "pending";
    const actions = await listPendingAgentActions(this.env, { repoFullName: fullName, status });
    return {
      summary: `${actions.length} ${status} action(s) in the ${fullName} approval queue.`,
      data: {
        repoFullName: fullName,
        status,
        pendingActions: actions.map((action) => ({
          id: action.id,
          actionClass: action.actionClass,
          pullNumber: action.pullNumber,
          status: action.status,
          autonomyLevel: action.autonomyLevel,
          reason: action.reason,
          decidedBy: action.decidedBy,
          decidedAt: action.decidedAt,
          createdAt: action.createdAt,
        })),
      },
    };
  }

  // #784 — accept (execute) or reject a staged action. Mirrors the HTTP decision route: maintainer-manage
  // access, repo-scoped (a guessed id from another repo's queue cannot be decided), idempotent.
  private async decidePendingAction(input: z.infer<typeof DecidePendingActionInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoApprovalQueueAccess(fullName);
    const pending = await getPendingAgentAction(this.env, input.id);
    // Scope to THIS repo so a maintainer cannot decide another repo's queue via a guessed id.
    if (!pending || pending.repoFullName !== fullName) {
      return { summary: `No pending action ${input.id} on ${fullName}.`, data: { status: "not_found" } };
    }
    const result = await decidePendingAgentAction(this.env, { id: pending.id, decision: input.decision, decidedBy: this.identity.actor });
    const action = result.action;
    /* v8 ignore next 2 -- not_found is returned above; accepted/rejected/already_decided always carry the action. */
    if (!action) return { summary: `Action ${input.id} was already decided.`, data: { status: result.status } };
    return {
      summary:
        result.status === "accepted"
          ? `Accepted ${pending.actionClass} on ${fullName}#${pending.pullNumber} (execution: ${result.executionOutcome}).`
          : result.status === "errored"
            ? `Accepted ${pending.actionClass} on ${fullName}#${pending.pullNumber}, but execution errored: ${result.executionOutcome}.`
            : result.status === "rejected"
              ? `Rejected ${pending.actionClass} on ${fullName}#${pending.pullNumber}.`
              : `Action ${input.id} was already decided.`,
      data: {
        status: result.status,
        ...(result.executionOutcome !== undefined ? { executionOutcome: result.executionOutcome } : {}),
        action: {
          id: action.id,
          actionClass: action.actionClass,
          pullNumber: action.pullNumber,
          status: action.status,
          autonomyLevel: action.autonomyLevel,
          reason: action.reason,
          decidedBy: action.decidedBy,
          decidedAt: action.decidedAt,
          createdAt: action.createdAt,
        },
      },
    };
  }

  // #3003 — on-demand repo-doc refresh. This action only ever OPENS A PULL REQUEST (never merges/closes/commits
  // directly), so -- unlike propose/decide's stage-then-accept pattern for genuinely destructive actions --
  // executing it synchronously in one call is appropriately safe. requireRepoManageAccess is checked FIRST,
  // before performRepoDocRefresh touches anything.
  private async refreshRepoDocs(input: z.infer<typeof RefreshRepoDocsInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const result = await performRepoDocRefresh(this.env, fullName);
    if (!result.opened) {
      return { summary: `No repo-doc pull request opened for ${fullName}: ${result.reason}`, data: { opened: false, reason: result.reason } };
    }
    return {
      summary: `${result.reused ? "Found the already-open" : "Opened a new"} repo-doc pull request for ${fullName}: ${result.url}`,
      data: { opened: true, reused: result.reused, pullNumber: result.pullNumber, url: result.url },
    };
  }

  // #6757: MCP mirror of POST /v1/repos/:owner/:repo/contributor-issue-drafts/generate. requireRepoManageAccess
  // is checked FIRST (before touching anything), then the route's own explicit_create_requires_dry_run_false
  // guard is re-applied here so this surface has IDENTICAL create-safety: `create` alone is rejected; only an
  // explicit {create:true, dryRun:false} reaches the service, which itself still overlays the global agent
  // kill-switch. The result strips the per-draft `drafts[]` (title/body text) from the public-safe tool data,
  // surfacing only the counts + posture, like getAgentAuditFeed's scrub.
  private async generateContributorIssueDrafts(
    input: z.infer<typeof GenerateContributorIssueDraftsInput>,
  ): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    if (input.create && input.dryRun !== false) {
      throw new Error("explicit_create_requires_dry_run_false: pass create:true together with dryRun:false to open issues.");
    }
    const result = await generateContributorIssueDrafts(this.env, fullName, {
      dryRun: input.dryRun,
      create: input.create,
      limit: input.limit,
      requestedBy: this.identity.kind === "session" ? this.identity.actor : "mcp",
    });
    return {
      summary: `Contributor issue drafts for ${fullName} (dryRun=${result.dryRun}): ${result.proposed} proposed, ${result.created} created, ${result.skippedDuplicate} duplicate, ${result.skippedDeclined} declined, ${result.skippedUnsafe} unsafe.`,
      data: {
        repoFullName: result.repoFullName,
        generatedAt: result.generatedAt,
        dryRun: result.dryRun,
        createRequested: result.createRequested,
        proposed: result.proposed,
        skippedDuplicate: result.skippedDuplicate,
        skippedDeclined: result.skippedDeclined,
        skippedUnsafe: result.skippedUnsafe,
        created: result.created,
        skippedCreateFailed: result.skippedCreateFailed,
      },
    };
  }

  // #7426: repo-agnostic counterpart to generateContributorIssueDrafts above. requireRepoManageAccess is checked
  // FIRST, then the SAME explicit_create_requires_dry_run_false guard is re-applied here (the service itself
  // still overlays the global agent kill-switch on top). Unlike generateContributorIssueDrafts, the response
  // includes each draft's full title/body/labels -- see planRepoIssuesOutputSchema's doc comment for why that's
  // safe here (no loopover-internal signal to scrub).
  private async planRepoIssues(input: z.infer<typeof PlanRepoIssuesInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    if (input.create && input.dryRun !== false) {
      throw new Error("explicit_create_requires_dry_run_false: pass create:true together with dryRun:false to open issues.");
    }
    const result = await generateIssuePlanDrafts(this.env, fullName, input.goal, {
      dryRun: input.dryRun,
      create: input.create,
      limit: input.limit,
      requestedBy: this.identity.kind === "session" ? this.identity.actor : "mcp",
      milestone: input.milestone,
    });
    return {
      summary: `Issue plan for ${fullName} (status=${result.status}, dryRun=${result.dryRun}): ${result.proposed} proposed, ${result.created} created, ${result.skippedDuplicate} duplicate, ${result.skippedDeclined} declined, ${result.skippedUnsafe} unsafe.`,
      data: {
        repoFullName: result.repoFullName,
        generatedAt: result.generatedAt,
        status: result.status,
        dryRun: result.dryRun,
        createRequested: result.createRequested,
        proposed: result.proposed,
        skippedDuplicate: result.skippedDuplicate,
        skippedDeclined: result.skippedDeclined,
        skippedUnsafe: result.skippedUnsafe,
        created: result.created,
        ...(result.milestoneNumber !== undefined ? { milestoneNumber: result.milestoneNumber } : {}),
        skippedCreateFailed: result.skippedCreateFailed,
        drafts: result.drafts.map((draft) => ({
          title: draft.title,
          body: draft.body,
          labels: draft.labels,
          status: draft.status,
          ...(draft.issue?.number !== undefined ? { issueNumber: draft.issue.number } : {}),
          ...(draft.issue?.url !== undefined ? { issueUrl: draft.issue.url } : {}),
        })),
      },
    };
  }

  // #784 — the agent audit feed: executed actions + approval decisions for a repo, newest first.
  // Maintainer-manage scoped; read-only and public-safe (action posture only — no trust/score metadata).
  private async getAgentAuditFeed(input: z.infer<typeof GetAgentAuditFeedInput>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const events = await listAgentAuditEvents(this.env, {
      repoFullName: fullName,
      ...(input.since !== undefined ? { sinceIso: input.since } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return {
      summary: `${events.length} recent agent audit event(s) for ${fullName}.`,
      // Defense-in-depth: scrub the only free-form field (`detail`) before it leaves on a public-safe tool result.
      data: { repoFullName: fullName, events: events.map((event) => ({ ...event, detail: event.detail === null ? null : sanitizePublicComment(event.detail) })) },
    };
  }

  private async explainScoreBreakdown(input: z.infer<typeof RemoteLocalScorePreviewInput>): Promise<ToolPayload> {
    if (!input.contributorLogin) throw new Error("contributorLogin is required for score breakdown.");
    this.requireContributorAccess(input.contributorLogin);
    await this.requireRepoAccess(input.repoFullName);
    const [repo, snapshot, evidence, contributorIssues] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      getOrCreateScoringModelSnapshot(this.env),
      getContributorEvidence(this.env, input.contributorLogin),
      listContributorIssues(this.env, input.contributorLogin),
    ]);
    const openIssueCount = contributorOpenIssueCount(contributorIssues, input.repoFullName);
    // Time-decay (#703) is an owner-gated global, injected server-side (not caller-controllable).
    const scoreInput = { ...input, openIssueCount, applyTimeDecay: isTimeDecayEnabled(this.env) };
    const preview = buildScorePreview({ input: scoreInput, repo, snapshot, contributorEvidence: evidence });
    const breakdown = explainScoreBreakdown(preview);
    return {
      summary: `Private LoopOver score breakdown for ${input.contributorLogin} in ${input.repoFullName}. Highest leverage: ${breakdown.highestLeverageLever.component}.`,
      data: breakdown as unknown as Record<string, unknown>,
    };
  }

  private async explainReviewRisk(input: z.infer<typeof PreflightPrInput>): Promise<ToolPayload> {
    if (input.contributorLogin) this.requireContributorAccess(input.contributorLogin);
    await this.requireRepoAccess(input.repoFullName);
    const [repo, issues, pullRequests, bounties] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
    ]);
    const explanation = buildReviewRiskExplanation({ input, repo, issues, pullRequests, bounties });
    return {
      summary: explanation.summary,
      data: {
        preflight: explanation.preflight,
        roleContext: explanation.roleContext,
        recommendation: explanation.recommendation,
      },
    };
  }

  private async comparePrVariants(variants: Array<z.infer<typeof RemoteLocalScorePreviewInput>>): Promise<ToolPayload> {
    const previews = [];
    for (const variant of variants) previews.push((await this.previewScore({ ...variant, targetType: "variant" })).data);
    previews.sort((left, right) => {
      const leftScore = Number((left as { result: { scoreEstimate: { estimatedMergedScore: number } } }).result.scoreEstimate.estimatedMergedScore);
      const rightScore = Number((right as { result: { scoreEstimate: { estimatedMergedScore: number } } }).result.scoreEstimate.estimatedMergedScore);
      return rightScore - leftScore;
    });
    return {
      summary: "Private LoopOver PR variant comparison.",
      data: { variants: previews },
    };
  }

  private async localBranchSlice(input: z.infer<typeof LocalBranchAnalysisInput>, slice: "preflight" | "scorePreview" | "nextActions" | "scoreBlockers" | "prPacket"): Promise<ToolPayload> {
    const analysis = await this.analyzeLocalBranch(input);
    return {
      summary: `${analysis.summary} (${slice}).`,
      data: {
        login: analysis.login,
        repoFullName: analysis.repoFullName,
        generatedAt: analysis.generatedAt,
        [slice]: analysis[slice],
        scenarioScorePreview: slice === "scorePreview" || slice === "scoreBlockers" ? analysis.scenarioScorePreview : undefined,
        branchQualityBlockers: slice === "scoreBlockers" ? analysis.branchQualityBlockers : undefined,
        accountStateBlockers: slice === "scoreBlockers" ? analysis.accountStateBlockers : undefined,
        recommendedRerunCondition: slice === "scoreBlockers" || slice === "nextActions" ? analysis.recommendedRerunCondition : undefined,
        dataQuality: analysis.dataQuality,
      } as Record<string, unknown>,
    };
  }

  private async compareLocalVariants(variants: Array<z.infer<typeof LocalBranchAnalysisInput>>): Promise<ToolPayload> {
    const analyses = [];
    for (const variant of variants) analyses.push(await this.analyzeLocalBranch(variant));
    analyses.sort(
      (left, right) =>
        (right.nextActions[0]?.priorityScore ?? 0) - (left.nextActions[0]?.priorityScore ?? 0) ||
        right.scorePreview.effectiveEstimatedScore - left.scorePreview.effectiveEstimatedScore ||
        left.repoFullName.localeCompare(right.repoFullName),
    );
    return {
      summary: "LoopOver local branch variant comparison.",
      data: {
        variants: analyses.map((analysis) => ({
          repoFullName: analysis.repoFullName,
          branchName: analysis.branchName,
          preflightStatus: analysis.preflight.status,
          scoreBlockers: analysis.scoreBlockers,
          scorePreview: analysis.scorePreview,
          topAction: analysis.nextActions[0] ?? null,
          prPacket: analysis.prPacket,
          dataQuality: analysis.dataQuality,
        })),
      },
    };
  }

  private async agentPlanNextWork(
    input: z.infer<typeof AgentPlanInput>,
    extra?: McpToolExtra,
    mcpServer?: McpServer,
  ): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const elicitation = await this.collectPlanningChoices(input, extra, mcpServer);
    const planInput = applyMcpPlanningChoices(input, elicitation.choices);
    const bundle = await planNextWork(this.env, { ...planInput, surface: "mcp" });
    return {
      summary: `LoopOver base-agent plan for ${input.login}.`,
      data: {
        ...bundle,
        planningElicitation: buildMcpPlanningElicitationAudit(elicitation, elicitation.choices),
        planningChoices: elicitation.choices,
      } as unknown as Record<string, unknown>,
    };
  }

  private async collectPlanningChoices(
    input: z.infer<typeof AgentPlanInput>,
    extra?: McpToolExtra,
    mcpServer?: McpServer,
  ): Promise<{ supported: boolean; requested: boolean; accepted: boolean; choices: McpPlanningChoices }> {
    const elicitationCapabilities = mcpServer?.server.getClientCapabilities()?.elicitation;
    const supportsFormElicitation = Boolean(
      extra && elicitationCapabilities && (elicitationCapabilities.form || Object.keys(elicitationCapabilities).length === 0),
    );
    if (!extra || !supportsFormElicitation) return { supported: false, requested: false, accepted: false, choices: {} };
    if (input.objective && input.repoFullName) return { supported: true, requested: false, accepted: false, choices: {} };
    const request = buildMcpPlanningElicitationRequest();
    validateMcpPlanningElicitationRequest(request);
    try {
      const result = await extra.sendRequest({ method: "elicitation/create", params: request }, ElicitResultSchema, { timeout: 1000 });
      const choices = planningChoicesFromElicitationResult(result);
      return { supported: true, requested: true, accepted: result.action === "accept", choices };
    } catch {
      return { supported: true, requested: true, accepted: false, choices: {} };
    }
  }

  private async agentStartRun(input: z.infer<typeof AgentStartRunInput>): Promise<ToolPayload> {
    this.requireContributorAccess(input.actorLogin);
    const bundle = await startAgentRun(this.env, {
      objective: input.objective,
      actorLogin: input.actorLogin,
      surface: "mcp",
      target: {
        repoFullName: input.targetRepoFullName,
        pullNumber: input.targetPullNumber,
        issueNumber: input.targetIssueNumber,
      },
    });
    return {
      summary: `Queued LoopOver base-agent run for ${input.actorLogin}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async agentGetRun(runId: string): Promise<ToolPayload> {
    const bundle = await getAgentRunBundle(this.env, runId);
    if (!bundle) throw new Error("Agent run not found.");
    this.requireContributorAccess(bundle.run.actorLogin);
    return {
      summary: `LoopOver base-agent run ${runId}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async agentExplainNextAction(input: z.infer<typeof AgentPlanInput>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const bundle = await explainBlockersWithAgent(this.env, { ...input, surface: "mcp" });
    return {
      summary: `LoopOver base-agent next-action explanation for ${input.login}.`,
      data: {
        ...bundle,
        topAction: bundle.actions[0] ?? null,
      } as unknown as Record<string, unknown>,
    };
  }

  private async agentPreparePrPacket(input: z.infer<typeof LocalBranchAnalysisInput>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const bundle = await preparePrPacketWithAgent(this.env, input, "mcp");
    return {
      summary: `LoopOver base-agent public-safe PR packet for ${input.repoFullName}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async remediationPlan(input: z.infer<typeof LocalBranchAnalysisInput>): Promise<ToolPayload> {
    const analysis = await this.analyzeLocalBranch(input);
    const plan = buildRemediationPlan({
      login: analysis.login,
      repoFullName: analysis.repoFullName,
      branchQualityBlockers: analysis.branchQualityBlockers,
      accountStateBlockers: analysis.accountStateBlockers,
      scoreBlockers: analysis.scoreBlockers,
      recommendedRerunCondition: analysis.recommendedRerunCondition,
      localFindings: analysis.localFindings,
    });
    return {
      summary: `LoopOver remediation plan for ${analysis.login} in ${analysis.repoFullName}.`,
      data: plan as unknown as Record<string, unknown>,
    };
  }

  private async draftPrBody(input: z.infer<typeof LocalBranchAnalysisInput>): Promise<ToolPayload> {
    const analysis = await this.analyzeLocalBranch(input);
    const draft = buildPublicPrBodyDraft(analysis);
    // Human-readable summary carries the rendered markdown body; structured draft is returned as JSON.
    return {
      summary: `Public-safe PR body draft for ${analysis.repoFullName} (metadata only; internal analysis context omitted).\n\n${draft.markdown}`,
      data: draft as unknown as Record<string, unknown>,
    };
  }

  private async analyzeLocalBranch(input: z.infer<typeof LocalBranchAnalysisInput>) {
    this.requireContributorAccess(input.login);
    await this.requireRepoAccess(input.repoFullName);
    const [context, repo, issues, pullRequests, recentMergedPullRequests, bounties, snapshot, issueQuality, repoManifest] = await Promise.all([
      this.loadContributorFastContext(input.login),
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listRecentMergedPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
      getOrCreateScoringModelSnapshot(this.env),
      loadOrComputeIssueQualityResponse(this.env, input.repoFullName),
      loadPublicRepoFocusManifest(this.env, input.repoFullName),
    ]);
    const fit = buildContributorFit(context.profile, context.repositories, [], [], context.syncStates, context.repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: input.login, fit, scoringSnapshot: snapshot });
    const checkSummaries = await this.loadCheckSummariesForPullRequests(input.repoFullName, input, pullRequests);
    // Caller-supplied focusManifest wins; otherwise fall back to the repo-owned manifest when present.
    const analysisInput = input.focusManifest !== undefined || !repoManifest.present
      ? input
      : { ...input, focusManifest: repoManifest as unknown };
    return {
      ...buildLocalBranchAnalysis({
        input: analysisInput,
        repo,
        issues,
        pullRequests,
        contributorPullRequests: context.contributorPullRequests,
        recentMergedPullRequests,
        bounties,
        repositories: context.repositories,
        checkSummaries,
        profile: context.profile,
        outcomeHistory: context.outcomeHistory,
        scoringSnapshot: snapshot,
        scoringProfile,
        issueQuality: issueQuality?.report,
        gittensorSnapshot: context.gittensorSnapshot,
      }),
      dataQuality: await this.loadRepoDataQuality(input.repoFullName),
    };
  }

  private async loadCheckSummariesForPullRequests(repoFullName: string, input: Parameters<typeof findCurrentBranchPullRequest>[0], pullRequests: Parameters<typeof findCurrentBranchPullRequest>[1]) {
    const currentPullRequest = findCurrentBranchPullRequest(input, pullRequests);
    return currentPullRequest ? listCheckSummaries(this.env, repoFullName, currentPullRequest.number) : [];
  }

  private async getBountyAdvisory(id: string): Promise<ToolPayload> {
    const bounty = await getBounty(this.env, id);
    if (!bounty) throw new Error("Bounty not found.");
    if (!(await this.canAccessRepo(bounty.repoFullName))) throw new Error("Bounty not found.");
    const [repo, issue, pullRequests] = await Promise.all([
      getRepository(this.env, bounty.repoFullName),
      getIssue(this.env, bounty.repoFullName, bounty.issueNumber),
      listPullRequests(this.env, bounty.repoFullName),
    ]);
    return {
      summary: `LoopOver bounty advisory for ${id}.`,
      data: buildBountyAdvisory(bounty, repo, issue, pullRequests) as unknown as Record<string, unknown>,
    };
  }

  // #9296 — mirror the public GET /v1/bounties route: list every cached bounty, no repo/owner scoping.
  private async getBountyList(): Promise<ToolPayload> {
    const bounties = await listBounties(this.env);
    return {
      summary: `LoopOver bounties: ${bounties.length} cached.`,
      data: { bounties } as unknown as Record<string, unknown>,
    };
  }

  // #9296 — mirror GET /v1/bounties/:id/lifecycle: the bounty's event history, 404 when the id is unknown.
  private async getBountyLifecycle(id: string): Promise<ToolPayload> {
    const bounty = await getBounty(this.env, id);
    if (!bounty) throw new Error("Bounty not found.");
    const events = await listBountyLifecycleEvents(this.env, id);
    return {
      summary: `LoopOver bounty lifecycle for ${id}: ${events.length} event(s).`,
      data: { bountyId: id, events } as unknown as Record<string, unknown>,
    };
  }

  private async loadContributorFastContext(login: string) {
    const [github, contributorPullRequests, contributorIssues, repositories, syncStates, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(login, this.env),
      listContributorPullRequests(this.env, login),
      listContributorIssues(this.env, login),
      listRepositories(this.env),
      listRepoSyncStates(this.env),
      listContributorRepoStats(this.env, login),
      fetchGittensorContributorSnapshot(login),
    ]);
    const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
    const profile = buildContributorProfile(login, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
    const outcomeHistory = buildContributorOutcomeHistory({
      login,
      profile,
      repositories,
      pullRequests: contributorPullRequests,
      issues: contributorIssues,
      repoStats,
      cachedRepoStats,
    });
    return {
      profile,
      contributorPullRequests,
      repositories,
      syncStates,
      repoStats,
      gittensorSnapshot,
      outcomeHistory,
    };
  }

  private async loadRepoDataQuality(fullName: string) {
    const [syncStates, syncSegments] = await Promise.all([listRepoSyncStates(this.env), listRepoSyncSegments(this.env, fullName)]);
    return buildRepoDataQuality(
      fullName,
      syncStates.find((state) => state.repoFullName === fullName),
      syncSegments,
    );
  }

  private toolResult(payload: ToolPayload) {
    const data = redactSensitiveForMcp(payload.data) as Record<string, unknown>;
    return {
      content: [
        {
          type: "text" as const,
          text: `${payload.summary}\n\n${JSON.stringify(data, null, 2)}`,
        },
      ],
      structuredContent: data,
    };
  }
}

/** Scrub the two upstream-issue-title fields `buildPreStartCheck` (packages/loopover-engine) surfaces on its
 *  report (#9163): `target.resolvedIssueTitle` is a real GitHub issue's title pulled from cached metadata,
 *  and `target.requested.title` echoes the caller-supplied title back -- both are free-form text that must
 *  route through the shared {@link sanitizeUntrustedMcpText} scrub before this report leaves as an MCP tool
 *  result, the same way `loopover_find_opportunities` scrubs `title` in find-opportunities.ts. Every other
 *  field on the report (reasons/blockers/summary) is already routed through `sanitizePublicComment` inside
 *  the engine itself, so this only needs to cover the two fields that carry a raw upstream title. */
function sanitizePreStartCheckReportTitles<T extends ReturnType<typeof buildPreStartCheck>>(report: T): T {
  return {
    ...report,
    target: {
      ...report.target,
      requested: {
        ...report.target.requested,
        ...(report.target.requested.title !== undefined
          ? { title: sanitizeUntrustedMcpText(report.target.requested.title) }
          : {}),
      },
      ...(report.target.resolvedIssueTitle !== undefined
        ? { resolvedIssueTitle: sanitizeUntrustedMcpText(report.target.resolvedIssueTitle) }
        : {}),
    },
  };
}

function redactSensitiveForMcp(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveForMcp(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/hotkey|coldkey|wallet|private_key|privateKey|mnemonic|alphaPerDay|taoPerDay|usdPerDay/i.test(key))
      .map(([key, entry]) => [key, redactSensitiveForMcp(entry)]),
  );
}

async function authenticateMcpRequest(c: AppContext): Promise<AuthIdentity | null> {
  const identity = await authenticatePrivateToken(c.env, extractBearerToken(c.req.header("authorization")));
  if (!identity || identity.kind !== "session") return identity;
  const summary = await loadControlPanelRoleSummary(c.env, identity.actor, identity.session?.githubUserId);
  return summary.roles.length > 0 ? identity : null;
}

function getExecutionContext(c: AppContext): ExecutionContext<unknown> {
  try {
    return c.executionCtx as unknown as ExecutionContext<unknown>;
  } catch {
    return {
      waitUntil: () => {},
      passThroughOnException: () => {},
      exports: {},
      props: {},
    } as unknown as ExecutionContext<unknown>;
  }
}
