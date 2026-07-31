import { Hono, type Context } from "hono";
import { requiresApiToken } from "../auth/route-auth";
import { handleAppError, nonErrorBoundary } from "./error-handler";
import { createWorkerPostHogErrorMiddleware } from "./worker-posthog";
import { z } from "zod";
import { parsePositiveInt } from "../utils/json";
import { analyzePRQueue } from "../queue-intelligence";
import { completeGitHubWebOAuth, createSessionFromGitHubToken, getLiveSessionGitHubToken, pollGitHubDeviceFlow, startGitHubDeviceFlow, startGitHubWebOAuth } from "../auth/github-oauth";
import { enforceRateLimit, enforceShotRenderGlobalCeiling, routeClassForPath } from "../auth/rate-limit";
import { handleShot } from "../review/visual/shot";
import { verifyShotRenderToken } from "../review/visual/shot-render-token";
import { isScreenshotsEnabled } from "../review/visual-wire";
import { buildFindingTaxonomyDocument } from "../review/finding-taxonomy";
import { buildEnrichmentAnalyzersTaxonomyDocument } from "../review/enrichment-analyzers-taxonomy";
import { deliveryIdFor } from "../queue/delivery-id";
import { loadReviewParityRollups } from "../review/review-parity-rollups";
import { loadAutomationRateSeries } from "../review/automation-rate";
import {
  GITHUB_OAUTH_STATE_COOKIE,
  authenticateInternalToken,
  authenticatePrivateToken,
  authenticateSessionToken,
  buildBrowserSessionCookie,
  buildClearedBrowserSessionCookie,
  buildClearedGitHubOAuthStateCookie,
  buildGitHubOAuthStateCookie,
  extractBearerToken,
  extractBrowserSessionToken,
  extractCookieValue,
  isAuthorizedGitHubSessionLogin,
  isMcpReadRepoAllowed,
  isMcpReadUnscoped,
  revokeSession,
  timingSafeEqual,
  type AuthIdentity,
} from "../auth/security";
import { normalizeGittBountySnapshot } from "../bounties/ingest";
import { DEFAULT_COMMAND_AUTHORIZATION_POLICY, normalizeCommandAuthorizationPolicy } from "../settings/command-authorization";
import { isDuplicateWinnerEnabledGlobally, resolveDuplicateWinnerEnabled } from "../settings/duplicate-winner-mode";
import {
  countOpenIssues,
  countOpenPullRequests,
  countRecentAuditEventsForActorAndTarget,
  getBounty,
  getAgentCommandAnswer,
  getCommandUsefulnessSummary,
  getIssue,
  getInstallation,
  getInstallationHealth,
  getLatestRepoGithubTotalsSnapshot,
  getLatestScoringModelSnapshot,
  getPullRequest,
  getRepository,
  getRepoQueueTrendSnapshot,
  getRepositorySettings,
  getPendingAgentAction,
  createPendingAgentActionIfAbsent,
  listAgentAuditEvents,
  listAuditEventsForTarget,
  listNotificationDeliveriesForRecipient,
  markNotificationDeliveriesRead,
  listPendingAgentActions,
  recordAuditEvent,
  recordPostMergeIncidentReport,
  getContributorEvidence,
  getProductUsageRollupStatus,
  listAllPullRequestDetailSyncStates,
  listCheckSummaries,
  listBounties,
  listBountiesByRepo,
  listBountyLifecycleEvents,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listLatestGitHubRateLimitObservations,
  listLatestRepoGithubTotalsSnapshots,
  listInstallationHealth,
  listInstallations,
  listInstalledRepoFullNamesForInstallation,
  listIssues,
  listGateOutcomeAuditEventRollups,
  listIssueSignalSample,
  listAgentRunsForActor,
  listDigestSubscriptionsForLogin,
  listProductUsageDailyRollups,
  listOpenPullRequests,
  listPrVisibilitySkipAuditEvents,
  listPullRequestFiles,
  listPullRequestReviews,
  listRecentMergedPullRequests,
  listLatestSignalSnapshotsByTarget,
  listRepoLabels,
  listRepoSyncSegments,
  listRepoSyncStates,
  summarizeRepoSyncOpenPullRequests,
  listSignalSnapshots,
  listRecentSignalSnapshotsForTargets,
  listPullRequests,
  listRepositories,
  getLatestUpstreamRulesetSnapshot,
  listUpstreamDriftReports,
  persistBountyLifecycleEvent,
  persistScorePreview,
  persistSignalSnapshot,
  recordAgentCommandFeedback,
  recordProductUsageEvent,
  rollupProductUsageDaily,
  summarizeMcpCompatibilityAdoption,
  upsertDigestSubscription,
  upsertBounty,
  upsertRepositorySettings,
  clearPullRequestsRegatedAtForOpenPrs,
  getProviderCredentialStatus,
  upsertProviderCredential,
  deleteProviderCredential,
  getRepositoryAiKeyStatus,
  upsertRepositoryAiKey,
  deleteRepositoryAiKey,
  getRepositoryLinearKeyStatus,
  upsertRepositoryLinearKey,
  deleteRepositoryLinearKey,
  getGlobalAgentFrozenState,
  setGlobalAgentFrozen,
  upsertIssueWatchSubscription,
  listIssueWatchSubscriptionsForLogin,
  deleteIssueWatchSubscription,
} from "../db/repositories";
import { dedupeSignalSnapshots, pruneExpiredRecords, RETENTION_POLICY } from "../db/retention";
import {
  backfillOpenPullRequestDetails,
  backfillRegisteredRepositories,
  backfillRepositorySegment,
  buildInstallationRepairDiagnostics,
  enrichInstallationHealth,
  refreshContributorActivity,
  refreshInstallationHealth,
  refreshInstallationHealthForInstallation,
} from "../github/backfill";
import { getRepositoryCollaboratorPermission } from "../github/app";
import { performRepoDocRefresh } from "../github/repo-doc-refresh-runner";
import type { LoopOverFooterEnv } from "../github/footer";
import { fetchGittensorContributorSnapshot } from "../gittensor/api";
import { fetchPublicContributorProfile, fetchPublicRepoStats } from "../github/public";
import {
  buildPublicAgentCommandComment,
  buildMaintainerQueueDigest,
  LOOPOVER_MENTION_COMMAND_CATALOG,
  isAuthorizedCommandActor,
  isMaintainerOnlyCommand,
  sanitizePublicComment,
  type LoopOverMentionCommandName,
} from "../github/commands";
import { handleGitHubWebhook, handleOrbRelay } from "../github/webhook";
import { requestAprRepoTransfer } from "../orb/apr-repo-transfer";
import { handleOrbIngest, readOrbIngestBody } from "../orb/ingest";
import { handleAmsIngest } from "../ams/ingest";
import { handleOrbWebhook } from "../orb/webhook";
import { listFleetInstallations, listFleetInstances, registerFleetInstallation, registerFleetInstance } from "../orb/fleet-admin";
import { pushFleetConfig } from "../orb/fleet-config-push";
import { backfillOrbInstallations } from "../orb/installations";
import { handleOrbOAuthCallback } from "../orb/oauth";
import {
  brokerOrbToken,
  isOrbBrokerEnabled,
  issueOrbEnrollment,
  issueOrbStoredSecret,
  ORB_SECRET_TYPE_GITHUB_TOKEN,
  ORB_SECRET_TYPE_TENANT_DB_CREDENTIAL,
  revokeOrbEnrollment,
} from "../orb/broker";
import {
  MAX_ORB_RELAY_REGISTER_BODY_BYTES,
  pullRelayPending,
  readOrbRelayRegisterBody,
  registerValidatedOrbRelay,
  validateOrbRelayEnrollment,
} from "../orb/relay";
import { computeFleetAnalytics } from "../orb/analytics";
import { handleMcpRequest, isMcpAdminEnabled } from "../mcp/server";
import { simulateOpenPrPressureSchema } from "../mcp/server";
import { simulateOpenPrPressure, type OpenPrPressureInput } from "../services/open-pr-pressure-scenarios";
import { DISCOVERY_PATHS, discoveryDocumentsFor, respondWithDocument, toolsForDeployment } from "../mcp/discovery-routes";
import { isSelfHostedReviewRuntime } from "../selfhost/review-runtime";
import { buildOpenApiSpec } from "../openapi/spec";
import { COMMAND_RATE_LIMIT_EVENT_TYPE, generateSignalSnapshots } from "../queue/processors";
import { generateChatQaAnswer } from "../services/ai-chat-qa";
import { isRepoChatQaEnabled, resolveChatQaActor, resolveChatQaGroundingLogin, resolveChatQaRateLimit } from "./maintainer-chat-qa";
import { getLatestRegistrySnapshot, listLatestRegistrySnapshots, refreshRegistry } from "../registry/sync";
import { getOrCreateScoringModelSnapshot, isTimeDecayEnabled, refreshScoringModelSnapshot } from "../scoring/model";
import { buildScorePreview, makeScorePreviewRecord } from "../scoring/preview";
import {
  explainBlockersWithAgent,
  getAgentRunBundle,
  planNextWork,
  preparePrPacketWithAgent,
  preflightBranchWithAgent,
  startAgentRun,
} from "../services/agent-orchestrator";
import { buildRemediationPlan } from "../services/remediation-plan";
import { handleDraftCreate, handleDraftOAuthCallback, handleDraftStatus } from "../services/draft";
import { decidePendingAgentAction } from "../services/agent-approval-queue";
import { explainScoreBreakdown } from "../services/score-breakdown";
import { deriveEligibilityPlan } from "../services/eligibility-plan";
import { buildMcpClientTelemetry } from "../services/client-telemetry";
import {
  authoritativeContributorRepoStats,
  buildAndPersistContributorDecisionPack,
  CONTRIBUTOR_DECISION_PACK_SIGNAL,
  loadContributorDecisionPackForServing,
  repoDecisionFromPack,
  tryEnqueueDecisionPackRebuild,
} from "../services/decision-pack";
import {
  buildMinerDashboardNextActions,
  buildMinerDashboardRepoFit,
  previousDecisionPackFromSnapshots,
} from "../services/miner-dashboard-recommendations";
import {
  buildStaticControlPanelRoleSummary,
  canLoginAccessRepo,
  canWatchRepo,
  type ControlPanelAccessScope,
  loadControlPanelAccessScope,
  loadControlPanelRoleSummary,
} from "../services/control-panel-roles";
import { runFindOpportunities, validateFindOpportunitiesInput, type FindOpportunitiesInput } from "../mcp/find-opportunities";
import { runIssueRagRetrieval, validateIssueRagInput, type IssueRagInput } from "../mcp/issue-rag";
import { FindOpportunitiesRequestSchema, IssueRagRetrieveRequestSchema } from "../openapi/schemas";
import { buildBoundaryTestGenerationFinding, buildBoundaryTestGenerationSpec } from "../signals/boundary-test-generation";
import { buildTestEvidenceReport } from "../signals/test-evidence";
import { buildStructuralImprovementAssessment } from "../signals/improvement";
import { evaluateEscalation } from "../loop-escalation";
import { buildResultsPayload } from "../results-payload";
import { buildProgressSnapshot } from "../loop-progress";
import { validateIdeaSubmission, buildTaskGraph, buildClaimPlan } from "../idea-intake";
import { loadPrAiReviewFindings, assertContributorOwnsPullRequest } from "../mcp/pr-ai-review-findings";
import {
  buildMcpCompatibilityMetadata,
  LATEST_RECOMMENDED_MCP_VERSION,
  MINIMUM_SUPPORTED_MCP_VERSION,
} from "../services/mcp-compatibility";
import { buildOperatorDashboardPayload, clampOperatorDashboardWindowDays } from "../services/operator-dashboard";
import { buildSelfDogfoodRegistrationPack, resolveSelfDogfoodRepoFullName } from "../services/self-dogfood-registration-pack";
import { buildSubnetInterfaceDescriptor } from "../services/subnet-interface";
import { buildPublicRepoQuality, type PublicRepoQuality } from "../services/public-repo-quality";
import { loadPublicQualityMetrics } from "../services/public-quality-metrics";
import { buildShieldsBadge, LABEL as PUBLIC_BADGE_LABEL, renderBadgeSvg, renderUnavailableBadgeSvg } from "./badge";
import {
  formatWeeklyValueReportMarkdown,
  generateWeeklyValueReport,
  loadWeeklyValueReport,
} from "../services/weekly-value-report";
import { generateAndSendReviewRecap } from "../services/review-recap";
import { loadOrComputeIssueQualityResponse } from "../services/issue-quality";
import { loadMaintainerNoiseReport } from "../services/maintainer-noise";
import { buildAmsMinerCohortComparison } from "../review/ams-miner-cohort";
import { loadCachedBurdenForecastResponse } from "../services/burden-forecast";
import { buildUnavailableQueueTrendReport } from "../services/queue-trends";
import { loadOrComputeRepoOutcomePatternsResponse } from "../services/repo-outcome-patterns";
import {
  buildBountyAdvisory,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorIntakeHealth,
  buildLabelAudit,
  buildLaneAdvice,
  buildLinkedIssueValidation,
  buildLocalDiffPreflightResult,
  buildPrTextLint,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildPullRequestMaintainerPacket,
  buildPreStartCheck,
  buildPreflightResult,
  buildQueueHealth,
  buildRegistryChangeReport,
} from "../signals/engine";
import { attachDataQuality, buildCoreSignalFidelity, buildFreshnessSloReport, buildRepoDataQuality, buildSignalFidelity } from "../signals/data-quality";
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildContributorPrOutcomes } from "../signals/contributor-pr-outcomes";
import { buildReviewRiskExplanation } from "../signals/review-risk";
import { buildNotificationFeed, evaluateAndEnqueueNotificationDeliveries } from "../notifications/service";
import { normalizeAmsNotificationEventInput } from "../notifications/ams-events";
import { buildPullRequestReviewability, } from "../signals/reward-risk";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../signals/local-branch";
import { buildIssueSlopAssessment } from "../signals/issue-slop";
import { buildSlopAssessment } from "../signals/slop";
import { buildPredictedGateVerdict } from "../rules/predicted-gate";
import { computeContributorCalibration } from "../review/predicted-gate-calibration-ledger";
import { buildFocusManifestValidation } from "../services/focus-manifest-validation";
import { buildMaintainerActivationPreview } from "../services/maintainer-activation";
import { buildRepoOutcomeCalibration } from "../services/outcome-calibration";
import { buildAutomationState } from "../services/automation-state";
import { loadGatePrecisionReport } from "../services/gate-precision";
import { computeOpsStats, isOpsEnabled, resolveOpsManifestOverride } from "../review/ops-wire";
  import { deleteLiveOverride, listOverrideAudit, loadOverride, loadShadowOverride, sanitizeOverridePayload, authoritativeGateOverride, toLiveGateThresholdFields, type StorageEnv } from "../review/auto-apply";
import { handleInternalCalibration, handleInternalDecision, handleInternalStatus, type OpsAgentConfig } from "../review/ops";
import { computeParityReadiness, isParityAuditEnabled } from "../review/parity-wire";
import { computePredictedGateAgreement } from "../review/predicted-gate-agreement";
import { computeContributorGateEval, contributorFairnessFlags, computeBlendedContributorGateEval, contributorGlobalFairnessFlags } from "../review/contributor-gate-eval";
import { getContributorTrustProfile } from "../review/contributor-trust-profile";
import { backfillContributorGateHistory } from "../review/contributor-gate-history-backfill";
import { isFairnessAnalyticsEnabled, resolveFairnessAnalyticsManifestOverride } from "../review/contributor-trust-profile-wire";
import { isRagEnabled } from "../review/rag-wire";
import { loadDecisionLedgerTip, loadPublicDecisionRecord, loadPublicLedgerRow, verifyDecisionLedger } from "../review/decision-record";
import { buildEvalScoreRecordsFromRulePrecision, filterEvalScoreRecords } from "../review/eval-score-records";
import { buildPublicCorpusCommitments } from "../review/public-eval-corpus";
import { isServiceStatusEnabled, loadServiceStatus } from "../selfhost/service-status";
import { buildComponentHistory, loadServiceStatusSamples } from "../selfhost/service-status-history";
import { anchorSigningInput, buildLedgerAnchorPayload, currentAnchorKey, diagnoseAnchorPublicKeys, parseAnchorPublicKeys, publicAnchorStatus, signLedgerAnchorPayload } from "../review/ledger-anchor";
import { resolveProofPage } from "../review/proof-summary";
import { renderProofBadgeSvg } from "./proof-badge";
import { ingestBittensorAnchorReport, parseBittensorAnchorReport } from "../review/ledger-anchor-bittensor";
import { loadPublicLedgerAnchors } from "../review/ledger-anchor-persistence";
import { getPublicStats, isPublicStatsEnabled, resolvePublicStatsManifestOverride } from "../review/public-stats";
import { loadPublicAccuracyTrend } from "../services/public-accuracy-trend";
import { loadPublicFleetAccuracyTrend } from "../services/public-fleet-accuracy-trend";
import { loadPublicRulePrecision } from "../review/public-rule-precision";
import { loadPublicEvalCorpus } from "../review/public-eval-corpus";
import { loadCalibrationTrend } from "../services/rule-calibration-trend";
import { isSatisfactionFloorAutotuneEnabled, loadSatisfactionFloorStatus, runSatisfactionFloorLoosening } from "../services/satisfaction-floor-loosening-run";
import { loadAllKnobStatuses } from "../services/knob-loosening-run";
import { loadPublicReuseRateTrend } from "../services/public-reuse-rate-trend";
import { loadPublicReviewVolumeTrend } from "../services/public-review-volume-trend";
import { buildMaintainerQualityDashboard, isMaintainerQualityDataStale } from "../services/maintainer-quality-dashboard";
import { buildMaintainerSlopDuplicateTrend, SLOP_DUPLICATE_TREND_SNAPSHOT_LIMIT, SLOP_DUPLICATE_TREND_WEEKS } from "../services/maintainer-slop-duplicate-trend";
import { buildFederatedBenchmark } from "../orb/federated-benchmark";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import { buildGateOutcomeBreakdown, GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS } from "../services/gate-outcome-breakdown";
import { compileFocusManifestPolicy, resolveEffectiveSettings } from "../signals/focus-manifest";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadPublicRepoFocusManifest, loadRepoFocusManifest, upsertRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildRepoOnboardingPackPreviewForRepo } from "../services/repo-onboarding-pack";
import { generateContributorIssueDrafts } from "../services/contributor-issue-draft";
import { generateIssuePlanDrafts } from "../services/issue-plan-draft";
import { buildRepoSettingsPreview, skippedPrAuditRemediation } from "../signals/settings-preview";
import {
  buildGittensorConfigRecommendation,
  buildRegistrationReadiness,
  type InstallationHealthSummary,
  type RegistrationReadinessReport,
} from "../signals/registration-readiness";
import { fileUpstreamDriftIssues, loadUpstreamStatus, refreshUpstreamDrift, registryHyperparameterDriftWarningsForRepo, resolveAutoFileDriftIssuesManifestOverride } from "../upstream/ruleset";
import type {
  ControlPanelRoleName,
  DataQuality,
  InstallationHealthRecord,
  JobMessage,
  JsonValue,
  ProductUsageOutcome,
  ProductUsageRole,
  ProductUsageSurface,
  PullRequestRecord,
  RepoSyncSegmentRecord,
  RepositoryRecord,
  RepositorySettings,
} from "../types";
import { errorMessage, nowIso } from "../utils/json";
import {
  queueDeadLetterPageFromBinding,
  queueDeleteDeadLetterJobViaBinding,
  queuePurgeDeadLetterJobsViaBinding,
  queueReplayDeadLetterJobViaBinding,
} from "../selfhost/queue-common";

type AppBindings = { Bindings: Env };
type AppContext = Context<AppBindings>;

// Resolves the public README badge metrics for a repo, enforcing the public-safety gates in one place:
// the repo must be public, installed, and opted in via `badgeEnabled`. Returns null (→ a benign
// "unavailable" badge) for any repo that is unknown, private, uninstalled, or has not opted in — so no
// metrics are ever served otherwise.
async function loadPublicRepoBadge(env: Env, owner: string, repo: string): Promise<PublicRepoQuality | null> {
  const repository = await getRepository(env, `${owner}/${repo}`);
  if (!repository || repository.isPrivate || !repository.isInstalled) return null;
  // badgeEnabled has no DB column anymore (Batch A follow-up, loopover#6442) -- config-as-code only, so
  // this must read the resolved (manifest-overlaid) settings instead of the old raw-DB-row shortcut. An
  // accepted perf tradeoff (a manifest-cache lookup, occasionally a cold-cache GitHub fetch, on this
  // unauthenticated high-frequency README-badge route) in exchange for `.loopover.yml` being honored here.
  const settings = await resolveRepositorySettings(env, repository.fullName);
  if (!settings.badgeEnabled) return null;
  const pullRequests = await listPullRequests(env, repository.fullName);
  return buildPublicRepoQuality(pullRequests);
}

// Resolves the public per-repo review-quality metrics (#2568), enforcing the same public-safety gates as the
// README badge: public, installed, and opted in via `publicQualityMetrics`. Returns null otherwise.
async function loadPublicRepoQualityMetrics(env: Env, owner: string, repo: string) {
  const repository = await getRepository(env, `${owner}/${repo}`);
  if (!repository || repository.isPrivate || !repository.isInstalled) return null;
  const settings = await resolveRepositorySettings(env, repository.fullName);
  if (!settings.publicQualityMetrics) return null;
  return loadPublicQualityMetrics(env, repository.fullName);
}

async function recordRouteProductUsage(
  c: AppContext,
  event: {
    surface: ProductUsageSurface;
    eventName: string;
    role?: ProductUsageRole | string | null | undefined;
    outcome?: ProductUsageOutcome;
    identity?: AuthIdentity | null | undefined;
    actor?: string | null | undefined;
    sessionId?: string | null | undefined;
    repoFullName?: string | null | undefined;
    targetKey?: string | null | undefined;
    latencyMs?: number | null | undefined;
    clientName?: string | null | undefined;
    clientVersion?: string | null | undefined;
    metadata?: Record<string, unknown> | null | undefined;
  },
): Promise<void> {
  const telemetry = buildMcpClientTelemetry(c.req.raw.headers, { requireLoopOverHeader: true });
  await recordProductUsageEvent(c.env, {
    surface: event.surface,
    eventName: event.eventName,
    role: event.role,
    route: c.req.path,
    actor: event.actor ?? event.identity?.actor,
    sessionId: event.sessionId ?? (event.identity?.kind === "session" ? event.identity.session.id : undefined),
    repoFullName: event.repoFullName,
    targetKey: event.targetKey,
    outcome: event.outcome,
    latencyMs: event.latencyMs,
    clientName: event.clientName ?? telemetry?.clientName,
    clientVersion: event.clientVersion ?? telemetry?.clientVersion,
    metadata: telemetry ? Object.assign({}, event.metadata, telemetry.metadata) : event.metadata,
  }).catch(() => undefined);
}

const LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES = 1024 * 1024;

async function readRequestBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

// #9750: every request schema this file used to declare inline now lives in @loopover/contract, so an MCP
// tool wrapping one of these routes references the SAME object rather than a copy of the shape. The one
// exception is the settings write schema, whose `commandAuthorization` default is a twenty-key policy owned
// by the engine -- the contract exports the shape as a factory and the engine's value is applied here, once.
import {
  markNotificationsReadBodySchema,
  amsNotificationsBodySchema,
  watchSubscriptionBodySchema,
  preflightSchema,
  localDiffPreflightSchema,
  validateLinkedIssueSchema,
  checkBeforeStartSchema,
  lintPrTextSchema,
  validateFocusManifestSchema,
  evaluateEscalationSchema,
  requestAprTransferSchema,
  proposePendingActionSchema,
  intakeIdeaSchema,
  resultsPayloadSchema,
  progressSnapshotSchema,
  testEvidenceSchema,
  boundaryTestsSchema,
  slopRiskSchema,
  improvementPotentialSchema,
  issueSlopSchema,
  selfhostDeadLetterQueueQuerySchema,
  skippedPrAuditQuerySchema,
  localBranchAnalysisSchema,
  scorePreviewSchema,
  agentRunSchema,
  agentPlanSchema,
  agentExplainBlockersSchema,
  maintainerSettingsSchema,
  installationBulkAgentSettingsSchema,
  repositoryAiKeySchema,
  rotatableProviderSchema,
  providerCredentialSchema,
  repositoryLinearKeySchema,
  repositoryAiReviewSchema,
  contributorIssueDraftGenerateSchema,
  issuePlanDraftGenerateSchema,
  settingsPreviewSchema,
  chatQaRequestSchema,
  commandPreviewSchema,
  commandFeedbackSchema,
  killSwitchUpdateSchema,
  configPushSchema,
  digestSubscriptionSchema,
  postMergeIncidentReportSchema,
  operatorPostMergeIncidentReportSchema,
  buildRepositorySettingsSchema,
  QUEUE_INTELLIGENCE_LIMITS,
  QueueIntelligencePullRequestSchema,
  QueueIntelligenceRepoContextSchema,
} from "@loopover/contract/api-requests";

const repositorySettingsSchema = buildRepositorySettingsSchema(DEFAULT_COMMAND_AUTHORIZATION_POLICY);

function contributorOpenIssueCount(issues: Array<{ repoFullName: string; state: string }>, repoFullName: string): number {
  const targetRepo = repoFullName.toLowerCase();
  return issues.filter((issue) => issue.repoFullName.toLowerCase() === targetRepo && issue.state === "open").length;
}

/** True only inside a genuine Cloudflare Workers isolate (the `global_navigator` compat flag, on by default
 *  for this project's compatibility_date, sets `navigator.userAgent` to this exact literal -- Cloudflare's own
 *  documented idiom for this check). Self-host's server.ts calls the SAME exported `worker.fetch` this app
 *  produces (it synthesizes a Worker-shaped `env` by spreading `process.env` specifically so it can reuse this
 *  handler byte-for-byte) -- gating the Cloudflare-only PostHog error middleware on this, rather than on env
 *  var presence alone, is what keeps it from ever activating inside a self-hoster's own Node process. */
export function isCloudflareWorkerRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

/** The {@link OpsAgentConfig} the `/v1/internal/decision` + `/v1/internal/calibration` operator read endpoints
 *  run under: the app slug (the `project` namespace the review agent records its `review_targets`/`review_audit`
 *  rows under — the same `GITHUB_APP_SLUG` fallback operator-dashboard's config uses) plus the
 *  `INTERNAL_JOB_TOKEN` secret name. The handlers' own `requireInternalAuth` re-checks that bearer, so they gate
 *  on the SAME `INTERNAL_JOB_TOKEN` the `/v1/internal/*` middleware already enforces — one logical gate. */
function internalOpsAgentConfig(env: Env): OpsAgentConfig {
  const slug = env.GITHUB_APP_SLUG?.trim() || "loopover";
  return { slug, secrets: { internalSecret: "INTERNAL_JOB_TOKEN" } };
}

export function createApp() {
  const app = new Hono<AppBindings>();
  // The global error boundary. Hono installs its own default regardless, so this REPLACES a handler that
  // returned a text/plain body from a JSON API and logged a raw Error the forwarder cannot classify --
  // see error-handler.ts for what it preserves (HTTPException status) and what it refuses to leak.
  app.onError(handleAppError);
  // Registered OUTERMOST: Hono routes only `instanceof Error` to onError and RE-THROWS anything else, so a
  // thrown non-Error would otherwise escape the boundary entirely -- no response, no log, no c.error.
  app.use("*", nonErrorBoundary());
  // Registered FIRST/outermost so it wraps every other middleware and route below, including a thrown
  // exception from the CORS/rate-limit middleware right after this. REPLACES the old Sentry middleware
  // entirely (2026-07-25 epic #8286 correction: full replacement, not a parallel-run). No-ops completely
  // outside a real Workers isolate (see isCloudflareWorkerRuntime) and when WORKER_POSTHOG_API_KEY is unset.
  /* v8 ignore start -- the TRUE branch only genuinely exercises inside a real Workers isolate (this vitest
   * run is Node); covered instead by test/workers/worker-runtime.test.ts, which runs under
   * @cloudflare/vitest-pool-workers and is NOT part of this coverage-instrumented run. isCloudflareWorkerRuntime
   * itself has its own direct Node-side (false) and real-isolate (true) tests. */
  if (isCloudflareWorkerRuntime()) {
    app.use(createWorkerPostHogErrorMiddleware());
  }
  /* v8 ignore stop */
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && isPublicNoCredentialRoute(c.req.path)) {
      // These specific routes are unauthenticated, cookie-free, aggregate-only public data (health check,
      // homepage stats counter, per-repo badge stats) -- open to ANY origin, including a fresh
      // <alias>-loopover-ui.<sub>.workers.dev preview build (ui-preview-deploy.yml), which a static
      // exact-match allowlist can never enumerate since the hostname is random per deploy. Deliberately
      // NEVER sets Access-Control-Allow-Credentials here (mirrors src/review/stats.ts's handleStats, the
      // same "*" + no-credentials pattern already used for this exact class of endpoint) -- browsers reject
      // a credentialed response against a wildcard origin anyway, but the real safety property is that this
      // branch never reaches the credentialed allowlist path below at all, so it can't accidentally grant a
      // third-party *.workers.dev/*.pages.dev site cookie-riding access to anything session-gated.
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Allow-Headers", "authorization, content-type");
      c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
      c.header("Access-Control-Max-Age", "600");
      // The response varies by Origin (this branch fires only when the request carried one), so a shared cache
      // must not serve this Origin-specific response to a no-Origin request or vice versa — append Vary the same
      // way the credentialed branch does at the else-arm below (#9712).
      c.header("Vary", "Origin", { append: true });
    } else {
      const allowedOrigin = allowedCorsOrigin(c.env, origin);
      if (allowedOrigin) {
        c.header("Access-Control-Allow-Origin", allowedOrigin);
        c.header("Access-Control-Allow-Credentials", "true");
        c.header("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
        c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        c.header("Access-Control-Expose-Headers", "x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after");
        c.header("Access-Control-Max-Age", "600");
        c.header("Vary", "Origin", { append: true });
      }
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    return next();
  });
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/health") return next();
    const limited = await enforceRateLimit(c, routeClassForPath(c.req.path));
    if (limited) return limited;
    return next();
  });
  app.use("/v1/internal/*", async (c, next) => {
    const identity = await authenticateInternalToken(c.env, extractBearerToken(c.req.header("authorization")));
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    return next();
  });
  app.use("*", async (c, next) => {
    /* v8 ignore next -- Hono CORS middleware handles OPTIONS before protected-route auth middleware reaches this guard. */
    if (c.req.method === "OPTIONS") return next();
    if (!requiresApiToken(c.req.path)) return next();
    const identity = await authenticateRequestIdentity(c);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    if (identity.kind === "session" && !canSessionAccessPath(c.env, identity, c.req.path)) return c.json({ error: "insufficient_role" }, 403);
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "loopover-api",
      time: nowIso(),
      minMcpVersion: MINIMUM_SUPPORTED_MCP_VERSION,
      latestRecommendedMcpVersion: LATEST_RECOMMENDED_MCP_VERSION,
    }),
  );
  app.get("/v1/mcp/compatibility", (c) => c.json(buildMcpCompatibilityMetadata(nowIso())));
  // #6620: unauthenticated static-document routes mirroring the two remote MCP resources, so the local CLI
  // can proxy them the same way it proxies /v1/mcp/compatibility. Both documents carry only committed public
  // enums/analyzer metadata (no DB/env/private data); excluded from requiresApiToken below.
  app.get("/v1/mcp/finding-taxonomy", (c) => c.json(buildFindingTaxonomyDocument()));
  app.get("/v1/mcp/enrichment-analyzers", (c) => c.json(buildEnrichmentAnalyzersTaxonomyDocument()));
  // #9526: the MCP discovery surfaces, computed at request time from the contract registry (never a
  // committed artifact -- a committed card is what made every concurrent tool PR conflict in metagraphed).
  // Unauthenticated public metadata: tool names, descriptions, and schemas are already public, so these are
  // excluded from requiresApiToken alongside the other unauthenticated document routes.
  for (const path of DISCOVERY_PATHS) {
    app.get(path, (c) => {
      // The SAME routes on both deployments, scoped to what each actually serves. A self-host card that
      // advertised the cloud's tool set would be a list of calls that 404 -- and this app IS the self-host
      // app (src/server.ts serves this very Hono instance), so the deployment has to be read at request
      // time rather than assumed.
      const deployment = isSelfHostedReviewRuntime(c.env) ? "selfhost" : "cloud";
      // #10039: same request-time read `createServer()` uses to gate admin-tool REGISTRATION, so a
      // self-host card never advertises the five admin tools when the flag that would register them is off.
      const adminEnabled = isMcpAdminEnabled(c.env);
      const documents = discoveryDocumentsFor({
        version: LATEST_RECOMMENDED_MCP_VERSION,
        deployment,
        adminEnabled,
        baseUrl: c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin,
        tools: toolsForDeployment(deployment, adminEnabled),
      });
      return respondWithDocument(documents[path]!, c.req.header("if-none-match") ?? null);
    });
  }

  app.get("/openapi.json", (c) => c.json(buildOpenApiSpec()));
  app.all("/mcp", handleMcpRequest);

  // Public SN74 contribution-interface descriptor (#695): metagraphed (and any agent) fetches this to route
  // gittensor discovery → LoopOver. Unauthenticated product metadata; excluded from requiresApiToken below.
  app.get("/v1/public/subnet-interface", (c) => {
    const origin = c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin;
    c.header("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");
    return c.json(buildSubnetInterfaceDescriptor({ origin, generatedAt: nowIso(), upstreamRepo: c.env.GITTENSOR_UPSTREAM_REPO }));
  });

  // Proof of Power (#1059): unauthenticated homepage stats counter — lifetime PRs handled / merged / closed,
  // gate + slop blocks, and a reversal-grounded accuracy %. Aggregate counts only (no PR content, authors,
  // scores, or reward internals). Flag-gated: 404s when disabled so the worker is byte-identical to today.
  // Enable can ALSO be set as code via the loopover self-repo's `.loopover.yml publicStats:` block
  // (config-as-code parity, #6275) -- a present manifest block wins over LOOPOVER_PUBLIC_STATS; absent, the
  // env var decides exactly as before. Excluded from requiresApiToken below.
  app.get("/v1/public/stats", async (c) => {
    const publicStatsManifestOverride = await resolvePublicStatsManifestOverride(c.env);
    if (!isPublicStatsEnabled(c.env, publicStatsManifestOverride)) return c.json({ error: "not_found" }, 404);
    try {
      const [stats, accuracyTrend, fleetAccuracyTrend, reuseRateTrend, reviewVolumeTrend, rulePrecision, reviewParity, automationRate] = await Promise.all([
        getPublicStats(c.env),
        loadPublicAccuracyTrend(c.env),
        // #9676: the fleet-population sibling of the series above. Deliberately a SECOND series rather than a
        // merged one -- see public-fleet-accuracy-trend.ts's header for why the two populations cannot be
        // joined, and why this one matches the headline's estimand instead of the table's.
        loadPublicFleetAccuracyTrend(c.env),
        loadPublicReuseRateTrend(c.env),
        loadPublicReviewVolumeTrend(c.env),
        // #8230: measured per-rule precision + the reproducibility freeze point. Same flag, same cache,
        // same one-surface posture as the sibling trends.
        loadPublicRulePrecision(c.env),
        // #9743: re-evaluation counts by declared reason, and the per-author-class parity rollups. Computed
        // from `decision_records` alone so an outsider holding the ledger export can recompute every figure
        // -- the definitions live beside the code in review-parity-rollups.ts.
        loadReviewParityRollups(c.env),
        // #9727: the weekly automation rate -- share of PRs decided with no human in the path. Same ledger,
        // same reproducibility contract; definitions live beside the code in review/automation-rate.ts.
        loadAutomationRateSeries(c.env),
      ]);
      c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return c.json({ ...stats, accuracyTrend, fleetAccuracyTrend, reuseRateTrend, reviewVolumeTrend, rulePrecision, reviewParity, automationRate });
    } catch {
      return c.json({ error: "public_stats_unavailable" }, 503);
    }
  });

  // #8837: public chain-verification for the decision ledger. Hashes/ids only — no record contents — so it is
  // unauthenticated by design (fixed in #9120: this route was missing from the requiresApiToken exemption
  // list below and 401'd in prod despite this comment always having claimed otherwise). #9122 correction: this
  // only proves SELF-consistency (no reorder/rewrite/gap WITHIN what verify examined) plus — since this
  // route's own fix — that no decision_records row exists past the verified tip with no chain entry over it
  // (catches a truncated tail, see verifyDecisionLedger's own doc comment). It does NOT prove the operator
  // never deleted the chain wholesale and started fresh from genesis; that needs an external anchor the
  // operator does not control, which is tracked but not yet built (decision-record.ts's module header has the
  // full honest-limit paragraph). Resumable: pass afterSeq from the previous response's nextAfterSeq until it
  // returns null; every response also carries the CURRENT tipSeq/tipHash/totalCount so a third party can keep
  // its own checkpoint independent of pagination position.
  app.get("/v1/public/decision-ledger/verify", async (c) => {
    const afterSeq = Math.max(0, Number(c.req.query("afterSeq")) || 0);
    const limit = Number(c.req.query("limit")) || 500;
    const result = await verifyDecisionLedger(c.env, afterSeq, limit);
    return c.json(result, result.ok ? 200 : 409);
  });

  // #9269 (epic #9267): fetch ONE chain row by seq. The verify route above walks the chain's internal
  // self-consistency; this one is what lets an EXTERNAL anchor be checked against the live chain. An anchor
  // published to a transparency log or a public git repo commits to a (seq, rowHash) pair -- without this
  // route that only proves some hash existed somewhere, not that it is still this chain's hash at that seq.
  // A verifier fetches the row, recomputes sha256(prevHash || canonicalJson({seq, recordId, recordDigest,
  // createdAt})), and compares against what was anchored. Unauthenticated, same posture and same public-safety
  // argument as its two siblings above (hashes, a seq, a timestamp, and the already-public record id --
  // never record contents); excluded from requiresApiToken below in this same PR, so it cannot repeat #9120's
  // "doc comment claimed unauthenticated but the exemption list disagreed" drift.
  app.get("/v1/public/decision-ledger/row/:seq", async (c) => {
    const seq = Number(c.req.param("seq"));
    if (!Number.isInteger(seq) || seq <= 0) return c.json({ error: "invalid_seq" }, 400);
    const row = await loadPublicLedgerRow(c.env, seq);
    if (!row) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json(row);
  });

  // #9270 (epic #9267): the anchor-signing public keys, with their rotation history. A verifier holding an
  // anchor published elsewhere (transparency log, public git repo) fetches this to check that anchor's
  // signature. The FULL history is served, not just the current key, because an anchor signed in 2026 must
  // stay verifiable after a 2027 rotation -- retired keys are published forever rather than replaced.
  // Unauthenticated by design, like every /v1/public/* sibling: a public key is public, and a verifier who had
  // to authenticate to US in order to check OUR anchors would not be independently verifying anything.
  // Unconfigured yields an empty list + null currentKeyId rather than an error -- "nothing is claimed to be
  // verifiable yet" is the honest answer before the signing key is provisioned, and a verifier can tell that
  // apart from a key that exists.
  app.get("/v1/public/decision-ledger/anchor-key", (c) => {
    // #9834: `status`/`droppedEntries` alongside the keys, because `{"keys":[],"currentKeyId":null}` was the
    // response to SIX different causes -- unset, unparseable, non-array, every-entry-invalid, all-expired,
    // and an ambiguous rotation -- and read as a healthy empty state for all of them. Same reasoning
    // PublicAnchorStatus already applies to the sibling anchors listing. `keys` and `currentKeyId` keep their
    // exact shape and meaning; this is purely additive for existing consumers.
    const diagnosis = diagnoseAnchorPublicKeys(c.env.LOOPOVER_LEDGER_ANCHOR_KEYS);
    c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    return c.json(diagnosis);
  });

  // #9271 (epic #9267): every anchoring attempt, success AND failure, paginated newest-first. This is what
  // makes anchoring's own health a publicly checkable fact -- a failure is recorded and served exactly like a
  // success (same shape, same listing), so "anchoring has been failing for a week" is something anyone can
  // observe rather than only visible in the operator's own logs. Unauthenticated by design, same posture as
  // every /v1/public/* sibling above.
  app.get("/v1/public/decision-ledger/anchors", async (c) => {
    // Built with spreads, not literal undefined-valued keys: exactOptionalPropertyTypes means an optional
    // filter field must be OMITTED to mean "no filter", not present-with-value-undefined.
    const backendParam = c.req.query("backend");
    const backend = backendParam === "rekor" || backendParam === "git" || backendParam === "ots" || backendParam === "bittensor" ? backendParam : undefined;
    const before = c.req.query("before");
    const limit = Number(c.req.query("limit")) || undefined;
    const result = await loadPublicLedgerAnchors(c.env, {
      ...(backend !== undefined && { backend }),
      ...(before !== undefined && { before }),
      ...(limit !== undefined && { limit }),
    });
    // An empty list is ambiguous on its own -- say WHY, so "not configured" can never be mistaken for
    // "healthy, nothing to report". Only computed for an unfiltered first page: with a backend/before filter an
    // empty page means "none matched", which is a different question than "is anchoring running at all".
    const unfiltered = backend === undefined && before === undefined;
    const [tip, keys] = unfiltered
      ? await Promise.all([loadDecisionLedgerTip(c.env), Promise.resolve(parseAnchorPublicKeys(c.env.LOOPOVER_LEDGER_ANCHOR_KEYS))])
      : [null, []];
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({
      ...result,
      ...(tip !== null && {
        status: publicAnchorStatus({
          anchorCount: result.anchors.length,
          tipSeq: tip.seq,
          hasSigningKey: currentAnchorKey(keys) !== null && Boolean(c.env.LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY),
        }),
      }),
    });
  });

  // #9569: the public proof page's data, and its README badge. Read-only over the SAME public sources the
  // standalone endpoints already serve -- no new verification mechanism and no new SQL surface.
  //
  // Both handlers are thin renderers over ONE resolver (resolveProofPage): the gate, the read and the
  // failure outcome are decided there, so the page and the badge cannot disagree about whether a repo is
  // published. That is not a stylistic preference -- the gate previously lived inline in both bodies and
  // exactly one of them was wired to the per-repo opt-out.
  const proofPageDeps = {
    loadManifest: loadRepoFocusManifest,
    verifyLedger: (env: Env) => verifyDecisionLedger(env),
    loadAnchors: (env: Env) => loadPublicLedgerAnchors(env, { limit: 20 }),
  };

  app.get("/v1/public/repos/:owner/:repo/proof", async (c) => {
    const result = await resolveProofPage(c.env, `${c.req.param("owner")}/${c.req.param("repo")}`, proofPageDeps);
    if (result.status === "disabled") return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json(result.summary);
  });

  // The badge deliberately reports the LEDGER's state rather than an accuracy percentage: a badge is a
  // one-glance claim, and an accuracy number without the interval that makes it honest (which does not fit
  // in a badge) is exactly the bare scalar the proof summary refuses to publish. A disabled repo renders
  // the neutral badge rather than an error -- a broken image in a README is worse than an honest one.
  app.get("/v1/public/repos/:owner/:repo/proof-badge.svg", async (c) => {
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    const result = await resolveProofPage(c.env, `${c.req.param("owner")}/${c.req.param("repo")}`, proofPageDeps);
    if (result.status === "disabled") {
      c.header("Cache-Control", "public, max-age=300");
      return c.body(renderProofBadgeSvg(null), 404);
    }
    c.header("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");
    return c.body(renderProofBadgeSvg(result.summary));
  });

  // #9277 (epic #9267): the current tip's SIGNED checkpoint, for the operator's off-Worker Bittensor
  // commitment submitter to fetch and commit on-chain (sha256 of `signingInput` is the exact 32 bytes
  // `Data::Sha256` holds). Unauthenticated like every /v1/public/* sibling: it is the same payload the
  // Rekor/git backends already publish externally on every checkpoint — hashes, a seq, a timestamp and a
  // key id, nothing else. `no-store`: `at` is minted per call, so a cached copy would just make two
  // submitters commit two different payload hashes for the same tip for no reason.
  app.get("/v1/public/decision-ledger/anchor-payload", async (c) => {
    const keys = parseAnchorPublicKeys(c.env.LOOPOVER_LEDGER_ANCHOR_KEYS);
    const current = currentAnchorKey(keys);
    if (!current || !c.env.LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY) return c.json({ error: "anchor_signing_unconfigured" }, 404);
    const tip = await loadDecisionLedgerTip(c.env);
    if (tip.seq === 0) return c.json({ error: "empty_ledger" }, 404);
    const payload = buildLedgerAnchorPayload(tip, nowIso());
    const signed = await signLedgerAnchorPayload(payload, c.env.LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY, current.keyId);
    c.header("Cache-Control", "no-store");
    return c.json({ signed, signingInput: anchorSigningInput(payload) });
  });

  // #9277 (epic #9267): the operator's off-Worker Bittensor submitter reports each on-chain anchor attempt
  // (success AND failure) back into #9271's public attempt log. Bearer-gated, FAILS CLOSED when the token is
  // unset (isAuthorizedIngest, same posture as /v1/orb/ingest). Authentication alone is deliberately not
  // enough for an `ok` row: the report's signed payload must verify against a PUBLISHED anchor key and its
  // (seq, rowHash) must match the LIVE chain row — the public log asserting on-chain corroboration that a
  // buggy submitter never actually anchored would be worse than no log at all. A `failed` report skips those
  // checks: "the submitter is broken" is exactly what the attempt log exists to make publicly visible.
  app.post("/v1/decision-ledger/anchor-attempts", async (c) => {
    if (!(await isAuthorizedIngest(c.env.LOOPOVER_LEDGER_ANCHOR_REPORT_TOKEN, extractBearerToken(c.req.header("authorization"))))) return c.json({ error: "unauthorized" }, 401);
    const body = await readOrbIngestBody(c.req.raw, c.req.header("content-length"));
    if (body === null) return c.json({ error: "payload_too_large" }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(body || "");
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = parseBittensorAnchorReport(raw);
    if ("error" in parsed) return c.json({ error: "invalid_report", detail: parsed.error }, 400);
    const outcome = await ingestBittensorAnchorReport(c.env, parsed.report);
    if (!outcome.recorded) return c.json({ error: outcome.reason }, 422);
    return c.json({ recorded: true, status: outcome.status }, 200);
  });

  // #9123: the decision record itself was persisted (decision_records) but never published anywhere a
  // contributor or a third party could fetch the full body — the only prior public surface was
  // renderDecisionRecordSection's bounded review-comment summary (12-char digest prefixes, and it omits
  // decidedAt/baseSha/salvageability/repoFullName/pullNumber entirely). DecisionRecord is public-safe BY
  // CONSTRUCTION (its own type doc: counts/digests/enums only, no diffs, no private config contents, no
  // wallet/hotkey/trust-score/reward fields) — no field-level redaction needed before exposing it verbatim,
  // unlike a route touching a type that carries any of those. Unauthenticated by design, mirroring the
  // ledger-verify route immediately above; excluded from requiresApiToken below.
  app.get("/v1/public/decision-records/:owner/:repo/:pull", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const pullNumber = Number(c.req.param("pull"));
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) return c.json({ error: "invalid_pull_number" }, 400);
    const published = await loadPublicDecisionRecord(c.env, `${owner}/${repo}`, pullNumber);
    if (!published) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ record: published.record, recordDigest: published.recordDigest });
  });

  // #9266 (epic #8534, spec #9215): the v1 transport for EvalScoreRecords -- the shape a validator (or
  // anyone) fetches and independently re-derives rather than trusts. Same flag/cache/error posture as
  // /v1/public/stats deliberately (this reshapes the SAME already-computed rule-precision data into a
  // per-record, digest-committed form; it is not a new scoring surface). Wired for the
  // outcome_confirmed_precision source only today -- a future benchmark_run source (#9265) feeds the same
  // endpoint, never a second response format.
  // #9636: the corpus behind the published per-rule precision, redacted and downloadable WITHOUT
  // credentials -- the read path that makes the verifiability walkthrough's step 1 true for a stranger
  // instead of only for an operator holding this deployment's Cloudflare keys. See
  // public-eval-corpus.ts's header for why `targetKey` is dropped rather than hashed, and why
  // `metadata.confidence` stays nested exactly where the shipped classifier reads it.
  app.get("/v1/public/eval-corpus", async (c) => {
    const publicStatsManifestOverride = await resolvePublicStatsManifestOverride(c.env);
    if (!isPublicStatsEnabled(c.env, publicStatsManifestOverride)) return c.json({ error: "not_found" }, 404);
    // `ruleId` is canonical (it is what the OpenAPI spec, the verifiability walkthrough and every other query
    // parameter on this API use). `rule_id` is accepted as an ALIAS because #9962: every published
    // `@loopover/mcp` verifier up to and including 3.x asks for `?rule_id=`, got a 400 back, and reported
    // "no corresponding corpus is downloadable" -- a commitment that looked broken while the bytes were sitting
    // one spelling away. Fixing only the client would leave every already-installed copy reporting that same
    // false negative against production forever, so the SERVER meets them. The alias is read second, so a
    // caller passing both gets the canonical spelling rather than a coin flip.
    const ruleId = c.req.query("ruleId") ?? c.req.query("rule_id");
    // Required, not defaulted: a corpus is only meaningful for one rule, and silently picking one would
    // publish a checksum for a rule the caller never asked about.
    if (!ruleId) return c.json({ error: "rule_id_required" }, 400);
    const corpus = await loadPublicEvalCorpus(c.env, ruleId);
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json(corpus);
  });

  // #9983 (slice of #9747): the public status board, sourced from THIS deployment's own alerting stack --
  // the same Grafana-managed rules that page the on-call rotation through Alertmanager. Reusing that source
  // rather than adding a status-page-only probe means the page cannot disagree with what actually pages a
  // human. 404s where no alerting source is configured (the hosted Worker) instead of publishing a board that
  // reads "unknown" forever. Reachable publicly on the Orb through the existing Cloudflare Tunnel, which
  // already routes /v1/public/* -- no tunnel change was needed to ship this.
  app.get("/v1/public/service-status", async (c) => {
    if (!isServiceStatusEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const status = await loadServiceStatus(c.env);
    // #9985: the past tense, derived from persisted samples rather than posted by hand. Attached per
    // component so a reader never has to correlate two lists, and computed from the SAME status vocabulary
    // the live board publishes.
    const now = new Date();
    const components = await Promise.all(
      status.components.map(async (entry) => ({ ...entry, ...buildComponentHistory(await loadServiceStatusSamples(c.env, entry.component, now), now.getTime()) })),
    );
    // Shorter than the sibling public surfaces on purpose: this is the endpoint people refresh DURING an
    // incident, and a 60s cache would keep serving "operational" for a minute after an outage started.
    c.header("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
    return c.json({ ...status, components });
  });

  app.get("/v1/public/eval-scores", async (c) => {
    const publicStatsManifestOverride = await resolvePublicStatsManifestOverride(c.env);
    if (!isPublicStatsEnabled(c.env, publicStatsManifestOverride)) return c.json({ error: "not_found" }, 404);
    // No try/catch: loadPublicRulePrecision is fail-safe internally (safeAll swallows every read error into
    // an empty section, per its own doc comment), and buildEvalScoreRecordsFromRulePrecision/
    // filterEvalScoreRecords are pure -- there is no reachable throw path in this composition today. A future
    // IO-touching source (the benchmark_run records from #9265) is exactly where real error handling belongs,
    // added when that source actually exists, not as untestable defensive code here.
    const precision = await loadPublicRulePrecision(c.env);
    // #9805: the per-rule fallback commitment, when no backtest run is persisted. Loaded HERE rather than
    // inside the record builder so that module stays pure -- and loaded through the same
    // loadPublicEvalCorpus the /v1/public/eval-corpus route serves, so the checksum a record commits to is by
    // construction the one a reader re-derives from the bytes they downloaded, not a parallel computation
    // that could drift from it.
    const corpusChecksumByRuleId = await buildPublicCorpusCommitments(c.env, precision.rules.map((rule) => rule.ruleId));
    const records = await buildEvalScoreRecordsFromRulePrecision(precision, new Date().toISOString(), corpusChecksumByRuleId);
    const filtered = filterEvalScoreRecords(records, {
      subject: c.req.query("subject"),
      since: c.req.query("since"),
    });
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return c.json({ records: filtered });
  });

  app.get("/v1/public/github/repos/:owner/:repo/stats", async (c) => {
    try {
      const stats = await fetchPublicRepoStats(c.env, c.req.param("owner"), c.req.param("repo"));
      c.header("Cache-Control", stats.stale ? "public, max-age=60, stale-while-revalidate=3600" : "public, max-age=600, stale-while-revalidate=86400");
      return c.json(stats);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_github_repo") return c.json({ error: "invalid_github_repo" }, 400);
      return c.json({ error: "github_repo_stats_unavailable" }, 503);
    }
  });

  // Public-safe README status badge (#541). Unauthenticated and embeddable: it serves ONLY whitelisted,
  // repo-level metrics, and ONLY for installed repos that opted in via the `badgeEnabled` setting. Excluded
  // from requiresApiToken above; aggressively cached + stale-while-revalidate like the public stats route.
  // #8377: loadPublicRepoBadge is NOT fail-safe (D1 reads plus a possible cold-cache GitHub manifest fetch),
  // so a transient blip used to escape as Hono's bare 500 — unusually visible here, since these badges are
  // embedded in third-party READMEs behind GitHub's camo proxy. Same route-level try/catch the sibling
  // /quality route and the #4995 relay fix already use (the loader itself is untouched). 503, never 404:
  // 404 stays reserved for the real "no public badge for this repo" case so a monitor can tell the two
  // apart, and the 503 branch uses the SHORT cache so a transient failure is never cached for the long
  // stale-while-revalidate window.
  app.get("/v1/public/repos/:owner/:repo/badge.svg", async (c) => {
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    try {
      const quality = await loadPublicRepoBadge(c.env, c.req.param("owner"), c.req.param("repo"));
      if (!quality) {
        c.header("Cache-Control", "public, max-age=300");
        return c.body(renderUnavailableBadgeSvg(), 404);
      }
      c.header("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");
      return c.body(renderBadgeSvg(quality));
    } catch {
      c.header("Cache-Control", "public, max-age=300");
      return c.body(renderUnavailableBadgeSvg(), 503);
    }
  });

  app.get("/v1/public/repos/:owner/:repo/badge.json", async (c) => {
    try {
      const quality = await loadPublicRepoBadge(c.env, c.req.param("owner"), c.req.param("repo"));
      if (!quality) {
        c.header("Cache-Control", "public, max-age=300");
        return c.json({ schemaVersion: 1, label: PUBLIC_BADGE_LABEL, message: "unavailable", color: "#9e9e9e", cacheSeconds: 300 }, 404);
      }
      c.header("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");
      return c.json(buildShieldsBadge(quality, 600));
    } catch {
      c.header("Cache-Control", "public, max-age=300");
      return c.json({ schemaVersion: 1, label: PUBLIC_BADGE_LABEL, message: "unavailable", color: "#9e9e9e", cacheSeconds: 300 }, 503);
    }
  });

  // Public per-repo review-quality metrics (#2568). Unauthenticated; aggregate counts/rates only; opt-in via
  // `publicQualityMetrics`. 404 when the repo is unknown/private/uninstalled or has not opted in.
  app.get("/v1/public/repos/:owner/:repo/quality", async (c) => {
    try {
      const metrics = await loadPublicRepoQualityMetrics(c.env, c.req.param("owner"), c.req.param("repo"));
      if (!metrics) {
        c.header("Cache-Control", "public, max-age=300");
        return c.json({ error: "not_found" }, 404);
      }
      c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
      return c.json(metrics);
    } catch {
      return c.json({ error: "public_quality_metrics_unavailable" }, 503);
    }
  });

  // Visual before/after screenshot endpoint (visual-capture port). PUBLIC + UNAUTHENTICATED by design: it
  // lives OUTSIDE the /v1/ prefix, so requiresApiToken (which only gates path.startsWith('/v1/')) never
  // touches it — GitHub's camo image proxy must fetch it without a bearer token. The handler itself enforces
  // every security choke-point: ?key= validates the R2 prefix + rejects '..'; ?url= keeps the host allowlist
  // (*.workers.dev / *.pages.dev / PUBLIC_SITE_ORIGIN) AND the isSafeHttpUrl SSRF guard. Inert flag-OFF: with
  // LOOPOVER_REVIEW_SCREENSHOTS off nothing ever writes shots to R2, so ?key= 404s and ?url= still requires
  // an allowlisted public host. The route's own Cache-Control headers (per mode) are set inside handleShot;
  // the rate-limit middleware classifies it as 'expensive' (20 req/300s, the same class as every other
  // headless-render/heavy-compute route) via routeClassForPath — it is the single most expensive
  // unauthenticated operation this deployment exposes (a full headless-Chromium render per request), not a
  // sane-default 'normal' route.
  // Flag-OFF = TRULY inert: when LOOPOVER_REVIEW_SCREENSHOTS is off nothing references this route (no comment
  // carries a /loopover/shot URL), so 404 it outright — that removes the on-demand `?url=` render surface
  // entirely until the feature is deliberately enabled, rather than relying on the host allowlist alone.
  //
  // TWO additional layers gate the render (`?url=`) mode specifically, on top of the per-identity rate limit
  // above (#9044): (1) a signed, expiring token (shot-render-token.ts) that ORB itself mints when it embeds a
  // `?url=` link in a review comment — a render only ever happens for a url ORB asked for, never an arbitrary
  // caller-supplied one, checked BEFORE the render path so an invalid token never reaches handleShot's own
  // host-allowlist/SSRF checks (which still apply underneath, defense-in-depth); and (2) a fixed-key GLOBAL
  // render ceiling (enforceShotRenderGlobalCeiling), independent of caller identity, so rotating
  // Cf-Connecting-Ip (the bypass this deployment's Node/tunnel topology made possible — see clientIp's own
  // doc comment in auth/rate-limit.ts) can never manufacture more than the one shared bucket. Neither layer
  // touches the `?key=`/placeholder modes, which never drive a render.
  app.get("/loopover/shot", async (c) => {
    if (!isScreenshotsEnabled(c.env)) return c.notFound();
    const params = new URL(c.req.url).searchParams;
    const isRenderMode = !params.get("placeholder") && !params.get("key") && Boolean(params.get("url"));
    if (isRenderMode) {
      const target = params.get("url")!;
      if (!(await verifyShotRenderToken(c.env, target, params))) {
        return c.json({ error: "missing_or_invalid_shot_token" }, 403);
      }
      const limited = await enforceShotRenderGlobalCeiling(c);
      if (limited) return limited;
    }
    return handleShot(c.req.raw, c.env, {
      ...(c.env.PUBLIC_SITE_ORIGIN ? { productionUrl: c.env.PUBLIC_SITE_ORIGIN } : {}),
    });
  });

  app.get("/v1/auth/github/start", async (c) => {
    try {
      const start = await startGitHubWebOAuth(c.env, c.req.url, c.req.query("returnTo"));
      c.header("Set-Cookie", buildGitHubOAuthStateCookie(start.state, c.req.url));
      await recordAuditEvent(c.env, { eventType: "auth.github_web_start", route: c.req.path, outcome: "success" });
      return c.redirect(start.authorizationUrl, 302);
    } catch (error) {
      const message = errorMessage(error, "github_oauth_start_failed");
      return c.json({ error: message }, message === "github_oauth_not_configured" ? 503 : 502);
    }
  });

  app.get("/v1/auth/github/callback", async (c) => {
    const denied = c.req.query("error");
    if (denied) {
      c.header("Set-Cookie", buildClearedGitHubOAuthStateCookie(c.req.url));
      await recordAuditEvent(c.env, {
        eventType: "auth.github_web_callback",
        route: c.req.path,
        outcome: "denied",
        detail: denied,
      });
      return c.redirect(authRedirectWithError(c.env, denied), 302);
    }
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    if (!code || !state) {
      c.header("Set-Cookie", buildClearedGitHubOAuthStateCookie(c.req.url));
      return c.redirect(authRedirectWithError(c.env, "github_oauth_callback_invalid"), 302);
    }
    try {
      const session = await completeGitHubWebOAuth(c.env, c.req.url, {
        code,
        state,
        cookieState: extractCookieValue(c.req.header("cookie"), GITHUB_OAUTH_STATE_COOKIE),
      });
      c.header("Set-Cookie", buildClearedGitHubOAuthStateCookie(c.req.url));
      c.header("Set-Cookie", buildBrowserSessionCookie(session.token, c.req.url), { append: true });
      return c.redirect(session.returnTo, 302);
    } catch (error) {
      const message = errorMessage(error, "github_oauth_callback_failed");
      c.header("Set-Cookie", buildClearedGitHubOAuthStateCookie(c.req.url));
      await recordAuditEvent(c.env, {
        eventType: "auth.github_web_callback",
        route: c.req.path,
        outcome: "error",
        detail: message,
      });
      return c.redirect(authRedirectWithError(c.env, message), 302);
    }
  });

  // Public OAuth draft-submission flow (LOOPOVER_REVIEW_DRAFT), ported from reviewbot. When the flag is OFF
  // every handler returns 404, so the endpoints are effectively absent (the router still registers them
  // but they short-circuit). The static `/auth/callback` route is registered before the `:id` param
  // route so it is not captured as a draft id. These are public (unauthenticated) by design — submission
  // is the unauthenticated entry point; the OAuth state hash + token exchange are the trust boundary.
  app.post("/v1/drafts", (c) => handleDraftCreate(c.req.raw, c.env));
  app.get("/v1/drafts/auth/callback", (c) => handleDraftOAuthCallback(c.req.raw, c.env));
  app.get("/v1/drafts/:id", (c) => handleDraftStatus(c.req.raw, c.env, c.req.param("id")));

  app.post("/v1/auth/github/device/start", async (c) => {
    try {
      const device = await startGitHubDeviceFlow(c.env);
      await recordAuditEvent(c.env, { eventType: "auth.github_device_start", route: c.req.path, outcome: "success" });
      return c.json(
        {
          status: "pending",
          deviceCode: device.device_code,
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          expiresIn: device.expires_in,
          interval: device.interval ?? 5,
        },
        201,
      );
    } catch (error) {
      const message = errorMessage(error, "github_device_flow_start_failed");
      return c.json({ error: message }, message === "github_oauth_not_configured" ? 503 : 502);
    }
  });

  app.post("/v1/auth/github/device/poll", async (c) => {
    const body = await c.req.json().catch(() => null);
    const deviceCode = typeof body?.deviceCode === "string" ? body.deviceCode : "";
    if (!deviceCode) return c.json({ error: "device_code_required" }, 400);
    try {
      return c.json(await pollGitHubDeviceFlow(c.env, deviceCode));
    } catch (error) {
      const message = errorMessage(error, "github_device_flow_poll_failed");
      return c.json({ error: message }, message === "github_oauth_not_configured" ? 503 : 502);
    }
  });

  app.post("/v1/auth/github/session", async (c) => {
    const body = await c.req.json().catch(() => null);
    const githubToken = typeof body?.githubToken === "string" ? body.githubToken : "";
    if (!githubToken) return c.json({ error: "github_token_required" }, 400);
    try {
      const session = await createSessionFromGitHubToken(c.env, githubToken, { source: "github_token_exchange" }, { verifyAppAudience: true });
      await recordRouteProductUsage(c, {
        surface: "api",
        eventName: "auth_session_created",
        actor: session.login,
        outcome: "success",
        metadata: { source: "github_token_exchange", scopeCount: session.scopes.length },
      });
      return c.json(session, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error, "github_session_create_failed") }, 401);
    }
  });

  app.get("/v1/auth/session", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity || identity.kind !== "session") return c.json({ status: "signed_out" });
    return c.json(await buildSessionResponse(c.env, identity));
  });

  // #6114/#6115: fetch the calling session's live GitHub token (persisted at login, transparently refreshed
  // near/past its 8h expiry via getLiveSessionGitHubToken) so a CLI/AMS process can authenticate git
  // operations without a separately-configured GITHUB_TOKEN PAT. Session-only -- the static "mcp"/"api"
  // shared-secret identities never reach this, since they don't represent one logged-in GitHub user's own
  // credential. Never cached
  // (this is live credential material) and never included in product-usage metadata or audit events.
  app.post("/v1/auth/github/token", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity || identity.kind !== "session") return c.json({ error: "browser_session_required" }, 403);
    const token = await getLiveSessionGitHubToken(c.env, identity.session.id);
    c.header("Cache-Control", "no-store");
    if (!token) return c.json({ error: "github_token_unavailable" }, 404);
    await recordRouteProductUsage(c, { surface: "api", eventName: "github_token_fetched", actor: identity.actor, outcome: "success" });
    return c.json({ token });
  });

  app.post("/v1/auth/logout", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    const revoked = await revokeSession(c.env, identity);
    c.header("Set-Cookie", buildClearedBrowserSessionCookie(c.req.url));
    return c.json({ ok: true, revoked });
  });

  app.get("/v1/app/overview", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    const login = identity?.kind === "session" ? identity.actor : undefined;
    const [repositories, installations, health, registry, scoring, upstreamDrift, rateLimits, runs, roleSummary] = await Promise.all([
      listRepositories(c.env),
      listInstallations(c.env),
      listInstallationHealth(c.env),
      getLatestRegistrySnapshot(c.env),
      getLatestScoringModelSnapshot(c.env),
      loadUpstreamStatus(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
      login ? listAgentRunsForActor(c.env, login, 8) : Promise.resolve([]),
      identity ? getRoleSummaryForIdentity(c.env, identity) : Promise.resolve(null),
    ]);
    const runBundles = await Promise.all(runs.map((run) => getAgentRunBundle(c.env, run.id)));
    const installedRepos = repositories.filter((repo) => repo.isInstalled).length;
    const registeredRepos = repositories.filter((repo) => repo.isRegistered).length;
    const unhealthyInstallations = health.filter((record) => record.status !== "healthy").length;
    return c.json({
      generatedAt: nowIso(),
      actor: identity ? { kind: identity.kind, login: login ?? identity.actor } : null,
      roleSummary,
      metrics: [
        {
          label: "Registered repos",
          total: registeredRepos,
          delta: `${repositories.length} known`,
          values: sparklineFromCounts(registeredRepos, repositories.length),
        },
        {
          label: "Installed repos",
          total: installedRepos,
          delta: `${installations.length} installations`,
          values: sparklineFromCounts(installedRepos, repositories.length),
        },
        {
          label: "Agent runs",
          total: runs.length,
          delta: login ? `latest for ${login}` : "no session actor",
          values: sparklineFromCounts(runs.filter((run) => run.status === "completed").length, runs.length),
        },
        {
          label: "Install issues",
          total: unhealthyInstallations,
          delta: unhealthyInstallations === 0 ? "healthy" : "needs attention",
          values: sparklineFromCounts(Math.max(health.length - unhealthyInstallations, 0), health.length),
        },
      ],
      registry: registry
        ? { repoCount: registry.repoCount, totalEmissionShare: registry.totalEmissionShare, fetchedAt: registry.fetchedAt, warningCount: registry.warnings.length }
        : null,
      scoringModel: scoring
        ? { snapshotId: scoring.id, activeModel: scoring.activeModel, sourceKind: scoring.sourceKind, fetchedAt: scoring.fetchedAt, warningCount: scoring.warnings.length }
        : null,
      upstreamDrift,
      rateLimits,
      recentRuns: runBundles.filter((bundle): bundle is NonNullable<typeof bundle> => Boolean(bundle)),
    });
  });

  app.get("/v1/app/roles", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    return c.json(await getRoleSummaryForIdentity(c.env, identity));
  });

  app.get("/v1/app/miner-dashboard", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    const login = c.req.query("login") ?? (identity?.kind === "session" ? identity.actor : "");
    if (!login) return c.json({ error: "login_required" }, 400);
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const [serving, scoring, upstreamDrift, runs, decisionPackSnapshots] = await Promise.all([
      loadContributorDecisionPackForServing(c.env, login),
      getLatestScoringModelSnapshot(c.env),
      loadUpstreamStatus(c.env),
      listAgentRunsForActor(c.env, login, 5),
      listSignalSnapshots(c.env, CONTRIBUTOR_DECISION_PACK_SIGNAL, login),
    ]);
    if (serving.kind === "needs_refresh") {
      return c.json({
        status: "needs_refresh",
        login,
        generatedAt: nowIso(),
        nextActions: [],
        blockers: [{ group: "decision-pack", items: [{ code: "decision_pack_missing", title: "Decision pack is not ready", howToClear: "Run the contributor decision-pack job." }] }],
        projections: [],
        repoFit: [],
        mcp: { snapshot: scoring?.id ?? null, drift: upstreamDrift.status, lastRun: runs[0]?.updatedAt ?? null },
        refresh: serving.refresh,
      });
    }
    const pack = serving.pack;
    const previousPack = previousDecisionPackFromSnapshots(pack, decisionPackSnapshots);
    return c.json({
      status: "ready",
      login,
      generatedAt: pack.generatedAt,
      source: pack.source,
      freshness: pack.freshness,
      nextActions: buildMinerDashboardNextActions(pack, previousPack),
      blockers: groupDecisionPackBlockers(pack.scoreBlockers ?? []),
      projections: buildProjectionRows(pack),
      repoFit: buildMinerDashboardRepoFit(pack, previousPack),
      dataQuality: pack.dataQuality,
      mcp: { snapshot: scoring?.id ?? null, drift: upstreamDrift.status, lastRun: runs[0]?.updatedAt ?? null },
    });
  });

  // #129 in-UI "refresh decision pack" — enqueues the same contributor decision-pack rebuild the MCP job
  // runs, so a miner can refresh from the web app instead of running MCP locally. Contributor-authed
  // (same gate as the dashboard read); the rebuild is async, so the panel re-fetches after it lands.
  app.post("/v1/app/miner-dashboard/refresh", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- the write-protection middleware rejects unauthenticated POSTs before this handler. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const login = c.req.query("login") ?? (identity.kind === "session" ? identity.actor : "");
    if (!login) return c.json({ error: "login_required" }, 400);
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const queued = await tryEnqueueDecisionPackRebuild(c.env, login);
    if (!queued) return c.json({ error: "refresh_enqueue_failed", login }, 503);
    return c.json({ status: "queued", login }, 202);
  });

  app.get("/v1/app/maintainer-dashboard", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const summary = await getRoleSummaryForIdentity(c.env, identity);
    if (!summary.roles.some((role) => ["maintainer", "owner", "operator"].includes(role))) return c.json({ error: "insufficient_role" }, 403);

    const [allRepositories, allInstallations, allHealth, allRateLimits] = await Promise.all([
      listRepositories(c.env),
      listInstallations(c.env),
      listInstallationHealth(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
    ]);
    const scope = identity.kind === "session" && !summary.roles.includes("operator") ? await loadControlPanelAccessScope(c.env, identity.actor, identity.session?.githubUserId) : null;
    const scopedRepoNames = new Set(scope?.repositoryFullNames.map((repo) => repo.toLowerCase()) ?? []);
    const scopedInstallationIds = new Set(scope?.installationIds ?? []);
    const scopedAccountLogins = new Set(scope?.accountLogins.map((login) => login.toLowerCase()) ?? []);
    const repositories = scope ? allRepositories.filter((repo) => scopedRepoNames.has(repo.fullName.toLowerCase())) : allRepositories;
    const installations = scope
      ? allInstallations.filter((installation) => scopedInstallationIds.has(installation.id) || scopedAccountLogins.has(installation.accountLogin.toLowerCase()))
      : allInstallations;
    const health = scope
      ? allHealth.filter((record) => scopedInstallationIds.has(record.installationId) || scopedAccountLogins.has(record.accountLogin.toLowerCase()))
      : allHealth;
    const rateLimits = scope ? allRateLimits.filter((record) => record.repoFullName !== undefined && record.repoFullName !== null && scopedRepoNames.has(record.repoFullName.toLowerCase())) : allRateLimits;
    // Cached open-PR count is aggregated across ALL in-scope repos from sync state without using the
    // capped sync-state listing that powers previews elsewhere. The per-repo PR fetch below is capped at
    // 12 only to bound the `reviewability` preview list, not the metric.
    const { totalOpenPullRequestsCached, reposWithOpenPullRequests } = await summarizeRepoSyncOpenPullRequests(c.env, repositories.map((repo) => repo.fullName));
    const previewRepositories = repositories.slice(0, 12);
    const [openPullRequests, previewRepositorySettings, previewChatQaEnabled] = await Promise.all([
      Promise.all(previewRepositories.map((repo) => listOpenPullRequests(c.env, repo.fullName).then((rows) => rows.map((pull) => ({ repoFullName: repo.fullName, pull }))))).then((rows) => rows.flat()),
      Promise.all(previewRepositories.map((repo) => getRepositorySettings(c.env, repo.fullName).then((settings) => [repo.fullName, settings] as const))),
      // advisoryAiRouting is config-as-code only (never DB-writable, resolved from the repo's .loopover.yml
      // manifest, #6489) -- unlike every other field on previewSettingsByRepo above, so it needs the FULL
      // resolveRepositorySettings merge, not the raw getRepositorySettings row.
      Promise.all(previewRepositories.map((repo) => resolveRepositorySettings(c.env, repo.fullName).then((settings) => [repo.fullName, isRepoChatQaEnabled(settings)] as const))),
    ]);
    const previewSettingsByRepo = new Map(previewRepositorySettings);
    const previewChatQaEnabledByRepo = new Map(previewChatQaEnabled);
    // Quality dashboard (#557): shape cached repo data into queue-health bands, duplicate trends, and
    // top contributors by quality band — scoped to this maintainer's repos. Reads CACHED issue/PR data
    // (no GitHub fetch), but does derive the collision/queue signals per load; the build is capped to
    // QUALITY_DASHBOARD_REPO_CAP repos and `truncated` discloses when there are more. The `stale` flag
    // reflects how fresh the underlying repo sync is.
    const QUALITY_DASHBOARD_REPO_CAP = 12;
    const qualityRepos = repositories.slice(0, QUALITY_DASHBOARD_REPO_CAP);
    const [qualityRepoInputs, allSyncStates] = await Promise.all([
      Promise.all(
        qualityRepos.map(async (repo) => {
          const [issues, pullRequests] = await Promise.all([listIssues(c.env, repo.fullName), listPullRequests(c.env, repo.fullName)]);
          return { repo, issues, pullRequests };
        }),
      ),
      listRepoSyncStates(c.env),
    ]);
    const qualityRepoNames = new Set(qualityRepos.map((repo) => repo.fullName.toLowerCase()));
    const scopedSyncCompletions = allSyncStates.filter((state) => qualityRepoNames.has(state.repoFullName.toLowerCase())).map((state) => state.lastCompletedAt);
    const generatedAt = nowIso();
    const qualityStale = isMaintainerQualityDataStale({ lastCompletedAts: scopedSyncCompletions, repoCount: qualityRepos.length, nowMs: Date.parse(generatedAt) });
    // Bound the read to the trend card's own 8-week window (#9699) so the row-count cap is a backstop, not the
    // primary limit — otherwise the ranking kept only the most recent few days and the card covered ~4 days.
    const slopTrendSinceIso = new Date(Date.parse(generatedAt) - SLOP_DUPLICATE_TREND_WEEKS * 7 * 86_400_000).toISOString();
    const queueHealthHistoriesByRepo = await listRecentSignalSnapshotsForTargets(
      c.env,
      "queue-health",
      qualityRepos.map((repo) => repo.fullName),
      SLOP_DUPLICATE_TREND_SNAPSHOT_LIMIT,
      slopTrendSinceIso,
    );
    const slopDuplicateTrend = buildMaintainerSlopDuplicateTrend({
      repos: qualityRepoInputs.map((input) => {
        const collisions = buildCollisionReport(input.repo.fullName, input.issues, input.pullRequests);
        const currentQueueHealth = buildQueueHealth(input.repo, input.issues, input.pullRequests, collisions);
        return {
          repoFullName: input.repo.fullName,
          queueHealthSnapshots: queueHealthHistoriesByRepo.get(input.repo.fullName) ?? [],
          currentQueueHealth,
        };
      }),
      generatedAt,
      stale: qualityStale,
      nowMs: Date.parse(generatedAt),
    });
    // Federated benchmark (#6481): "your gate precision vs peer median". Reads the opt-in from the loopover
    // self-repo's manifest (mirrors prReconciliation/publicStats/etc.'s fleet-wide override lookup) rather
    // than any of the maintainer's own repos — federatedIntelligence is operator-level, not per-repo.
    // #9148: buildFederatedBenchmark no longer pulls a peer collector on this request path at all — the
    // local half is a single fast DB query, and the peer half is read from a cache the "federated-peer-sync"
    // background queue job refreshes on its own cadence. This used to be a live, rate-limited network call
    // on every dashboard load (N maintainers hitting refresh was N requests/second at the peer collector);
    // now a slow/unreachable collector can only make the CACHE stale, never hold up this request.
    const federatedIntelligenceManifest = await loadRepoFocusManifest(c.env, resolveLoopOverSelfRepoFullName(c.env));
    const federatedBenchmark = await buildFederatedBenchmark(federatedIntelligenceManifest, c.env.DB, {
      now: Date.parse(generatedAt),
    });
    const qualityDashboard = {
      ...buildMaintainerQualityDashboard({
        repos: qualityRepoInputs,
        generatedAt,
        stale: qualityStale,
        repoTotal: repositories.length,
      }),
      slopDuplicateTrend,
      federatedBenchmark,
    };
    const gateOutcomeSinceIso = new Date(Date.parse(generatedAt) - GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const gateOutcomeRollups = await listGateOutcomeAuditEventRollups(c.env, {
      repoFullNames: repositories.map((repo) => repo.fullName),
      sinceIso: gateOutcomeSinceIso,
    });
    const gateOutcomeBreakdown = buildGateOutcomeBreakdown({
      rollups: gateOutcomeRollups,
      windowDays: GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS,
      generatedAt,
    });
    return c.json({
      generatedAt,
      installations,
      health: health.map(enrichInstallationHealth),
      metrics: [
        { label: "Installations", value: installations.length, spark: sparklineFromCounts(installations.length, Math.max(installations.length, 1)) },
        { label: "Open PRs cached", value: totalOpenPullRequestsCached, spark: sparklineFromCounts(reposWithOpenPullRequests, Math.max(repositories.length, 1)) },
        { label: "Install issues", value: health.filter((record) => record.status !== "healthy").length, spark: sparklineFromCounts(health.filter((record) => record.status === "healthy").length, Math.max(health.length, 1)) },
        { label: "Rate-limit events", value: rateLimits.length, spark: sparklineFromCounts(rateLimits.filter((record) => (record.remaining ?? 0) > 0).length, Math.max(rateLimits.length, 1)) },
      ],
      reviewability: openPullRequests.slice(0, 20).map(({ repoFullName, pull }) => ({
        pr: `${repoFullName}#${pull.number}`,
        title: pull.title,
        author: pull.authorLogin ?? "unknown",
        bucket: pull.state === "open" ? "review-now" : "watch",
        reason: pull.linkedIssues.length > 0 ? `linked issue #${pull.linkedIssues[0]}` : "cached open PR without linked issue",
        // Latest deterministic slop assessment for this PR (null unless the repo opted into slop). Lets the
        // maintainer panel render a per-PR slop band; never a private/scoreability signal.
        slop: previewSettingsByRepo.get(repoFullName)?.slopGateMode !== "off" && typeof pull.slopRisk === "number" && pull.slopBand ? { risk: pull.slopRisk, band: pull.slopBand } : null,
        // Whether this PR's repo has opted into the grounded @loopover chat Q&A surface (#6489) --
        // gates the maintainer panel's Chat Q&A section per PR so an instance that hasn't enabled it
        // sees no new UI for that PR, rather than a disabled-looking version of it.
        chatQaEnabled: previewChatQaEnabledByRepo.get(repoFullName)!,
      })),
      settingsPreview: buildMaintainerSettingsPreview(),
      qualityDashboard: { ...qualityDashboard, gateOutcomeBreakdown },
    });
  });

  app.get("/v1/app/skipped-pr-audit", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const summary = await getRoleSummaryForIdentity(c.env, identity);
    if (!summary.roles.some((role) => ["maintainer", "owner", "operator"].includes(role))) return c.json({ error: "insufficient_role" }, 403);

    const parsed = skippedPrAuditQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_skipped_pr_audit_query", issues: parsed.error.issues }, 400);
    const sinceIso = parsed.data.since ? toIsoQueryDate(parsed.data.since) : undefined;
    if (parsed.data.since && !sinceIso) return c.json({ error: "invalid_since" }, 400);
    const requestedRepo = parsed.data.repoFullName;
    const repoFullNames = await skippedPrAuditRepoScope(c, identity, summary.roles, requestedRepo);
    if (repoFullNames instanceof Response) return repoFullNames;
    const page = await listPrVisibilitySkipAuditEvents(c.env, {
      limit: clampInteger(parsed.data.limit ?? 50, 1, 100),
      offset: Math.max(0, parsed.data.offset ?? 0),
      repoFullNames,
      reason: parsed.data.reason,
      sinceIso,
    });
    return c.json({
      generatedAt: nowIso(),
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore,
      filters: {
        repoFullName: requestedRepo ?? null,
        reason: parsed.data.reason ?? null,
        since: sinceIso ?? null,
      },
      items: page.items.map((item) => ({
        repoFullName: item.repoFullName,
        pullNumber: item.pullNumber,
        reason: item.reason,
        timestamp: item.createdAt,
        remediation: skippedPrAuditRemediation(item.reason),
      })),
    });
  });

  app.get("/v1/app/operator-dashboard", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const days = clampOperatorDashboardWindowDays(Number(c.req.query("days")));
    return c.json(await buildOperatorDashboardPayload(c.env, { windowDays: days }));
  });

  // Dead-letter-queue table view (#2214), read-only: the self-host queue backend's admin surface is mirrored
  // onto `env.JOBS` (see queueDeadLetterPageFromBinding) rather than a new Env field -- absent entirely on
  // Cloudflare, where the plain Queue binding has neither method.
  app.get("/v1/app/selfhost/queue/dead", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const parsed = selfhostDeadLetterQueueQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    const limit = clampInteger(parsed.data.limit ?? 25, 1, 100);
    const offset = Math.max(0, parsed.data.offset ?? 0);
    const page = await queueDeadLetterPageFromBinding(c.env.JOBS, limit, offset);
    if (!page) {
      return c.json(
        { error: "dead_letter_admin_unavailable", message: "This deployment's queue backend does not expose dead-letter admin." },
        501,
      );
    }
    return c.json({ generatedAt: nowIso(), limit, offset, total: page.total, items: page.items });
  });

  // Dead-letter-queue admin actions (#2215): replay/delete a single dead job, or purge all of them. Same
  // env.JOBS-binding mirror and null/501 "admin unavailable" contract as the read-only GET route above --
  // absent entirely on Cloudflare, where the plain Queue binding exposes none of these methods.
  app.post("/v1/app/selfhost/queue/dead/:id/replay", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_job_id" }, 400);
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireAppRole already rejects an unauthenticated caller before this handler runs. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const result = await queueReplayDeadLetterJobViaBinding(c.env.JOBS, id);
    if (result === null) {
      return c.json(
        { error: "dead_letter_admin_unavailable", message: "This deployment's queue backend does not expose dead-letter admin." },
        501,
      );
    }
    if (result === false) return c.json({ error: "dead_letter_job_not_found" }, 404);
    await recordAuditEvent(c.env, {
      eventType: "operator.dlq_job_replayed",
      actor: identity.actor,
      targetKey: `selfhost_jobs#${id}`,
      outcome: "completed",
      metadata: { id },
    });
    return c.json({ ok: true, id });
  });

  app.delete("/v1/app/selfhost/queue/dead/:id", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_job_id" }, 400);
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireAppRole already rejects an unauthenticated caller before this handler runs. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const result = await queueDeleteDeadLetterJobViaBinding(c.env.JOBS, id);
    if (result === null) {
      return c.json(
        { error: "dead_letter_admin_unavailable", message: "This deployment's queue backend does not expose dead-letter admin." },
        501,
      );
    }
    if (result === false) return c.json({ error: "dead_letter_job_not_found" }, 404);
    await recordAuditEvent(c.env, {
      eventType: "operator.dlq_job_deleted",
      actor: identity.actor,
      targetKey: `selfhost_jobs#${id}`,
      outcome: "completed",
      metadata: { id },
    });
    return c.json({ ok: true, id });
  });

  app.delete("/v1/app/selfhost/queue/dead", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireAppRole already rejects an unauthenticated caller before this handler runs. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const purged = await queuePurgeDeadLetterJobsViaBinding(c.env.JOBS);
    if (purged === null) {
      return c.json(
        { error: "dead_letter_admin_unavailable", message: "This deployment's queue backend does not expose dead-letter admin." },
        501,
      );
    }
    await recordAuditEvent(c.env, {
      eventType: "operator.dlq_purged",
      actor: identity.actor,
      targetKey: "selfhost_jobs#all",
      outcome: "completed",
      metadata: { purged },
    });
    return c.json({ ok: true, purged });
  });

  // Global agent kill-switch (#2359): the write side (setGlobalAgentFrozen) previously had zero callers — the
  // only way to flip it was raw SQL. isGlobalAgentFrozen's fail-open read is right for the enforcement hot path,
  // but wrong here: getGlobalAgentFrozenState throws instead, so a read failure surfaces as a clear error rather
  // than a falsely reassuring "unfrozen".
  app.get("/v1/app/kill-switch", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    try {
      const state = await getGlobalAgentFrozenState(c.env);
      return c.json({ ...state, generatedAt: nowIso() });
    } catch (error) {
      return c.json({ error: "kill_switch_read_failed", message: errorMessage(error) }, 503);
    }
  });

  app.post("/v1/app/kill-switch", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireAppRole already rejects an unauthenticated caller before this handler runs. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = killSwitchUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_kill_switch_update", issues: parsed.error.issues }, 400);
    const actorLogin = identity.actor;
    await setGlobalAgentFrozen(c.env, parsed.data.frozen, actorLogin);
    // Read-after-write verification (#2359): confirm the write actually landed before telling the caller it
    // succeeded, rather than trusting the INSERT/UPDATE call not to have silently no-opped under a degraded D1.
    let verified: { frozen: boolean; updatedAt: string | null; updatedBy: string | null };
    try {
      verified = await getGlobalAgentFrozenState(c.env);
    } catch (error) {
      return c.json({ error: "kill_switch_verify_failed", message: errorMessage(error) }, 503);
    }
    if (verified.frozen !== parsed.data.frozen) {
      return c.json({ error: "kill_switch_write_unconfirmed", requested: parsed.data.frozen, observed: verified.frozen }, 502);
    }
    await recordAuditEvent(c.env, {
      eventType: "operator.kill_switch_set",
      actor: actorLogin,
      targetKey: "global_agent_controls#singleton",
      outcome: "completed",
      metadata: { frozen: verified.frozen, identityKind: identity.kind },
    });
    return c.json({ ok: true, ...verified });
  });

  // Config-push write path (#7522, piece 1 of #4902's 3-piece design): an operator pushes a typed, addressed
  // Orb-operational notice (capability announcement, deprecation notice, enrollment lifecycle) to an explicit
  // list of installations, landing in the SAME orb_relay_pending queue the GitHub-webhook relay already uses
  // (kind = 'config_push' -- see enqueueConfigPushRelay, src/orb/relay.ts). Write side only; the companion
  // dispatch-side issue (#7523) is how a self-host container's drain loop tells this apart from a webhook row
  // before touching raw_body. Scope boundary: Orb's own operational state ONLY -- never auto-applies anything
  // that overrides an operator's own .loopover.yml/DB settings.
  //
  // Deliberately under /v1/app/*, NOT /v1/internal/* despite that being this issue's illustrative example path:
  // the /v1/internal/* prefix's own middleware requires a bearer INTERNAL_JOB_TOKEN and (per requiresApiToken's
  // explicit `/v1/internal/` exclusion) never even resolves a session identity for it -- canSessionAccessPath is
  // never consulted -- which would make requireAppRole's session-role branch unreachable dead code for a
  // control-panel caller. /v1/app/* is where requireAppRole's session-based gate is actually meaningful,
  // matching the kill-switch endpoint above exactly (a bearer INTERNAL_JOB_TOKEN/api-token caller still passes
  // requireAppRole's own non-session branch either way).
  app.post("/v1/app/fleet/config-push", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireAppRole already rejects an unauthenticated caller before this handler runs. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = configPushSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_config_push", issues: parsed.error.issues }, 400);
    return c.json(await pushFleetConfig(c.env, identity.actor, parsed.data));
  });

  // #5672 post-merge incident report, internal-operator side: same reporting path as the repo-scoped customer
  // route (POST /v1/repos/:owner/:repo/pulls/:number/incident-reports), for an operator filing on a customer's
  // behalf. Not scoped to one repo's session, so repoFullName/pullNumber travel in the body instead of the path.
  app.post("/v1/app/incident-reports", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireAppRole already rejects an unauthenticated caller before this handler runs. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = operatorPostMergeIncidentReportSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_incident_report", issues: parsed.error.issues }, 400);
    const pullRequest = await getPullRequest(c.env, parsed.data.repoFullName, parsed.data.pullNumber);
    if (!pullRequest) return c.json({ error: "pull_request_not_found" }, 404);
    if (!pullRequest.mergedAt) return c.json({ error: "pull_request_not_merged" }, 409);
    const report = await recordPostMergeIncidentReport(c.env, {
      repoFullName: parsed.data.repoFullName,
      pullNumber: parsed.data.pullNumber,
      description: parsed.data.description,
      severity: parsed.data.severity,
      mergedSha: parsed.data.mergedSha,
      reporterKind: "operator",
      actor: identity.actor,
      route: c.req.path,
    });
    return c.json({ ok: true, repoFullName: parsed.data.repoFullName, pullNumber: parsed.data.pullNumber, ...report });
  });

  app.get("/v1/app/notification-model", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    return c.json({
      generatedAt: nowIso(),
      notificationModel: {
        mode: "opt_in",
        defaultState: "disabled",
        channels: [
          {
            id: "in_app_digest",
            transport: "in_app",
            defaultEnabled: true,
            purpose: "Show control-panel digest and attention items after authenticated sign-in.",
          },
          {
            id: "browser_push",
            transport: "web_push",
            defaultEnabled: false,
            requiresPermission: true,
            purpose: "Optional browser push alerts for install health and drift warnings.",
          },
        ],
        privacyGuards: [
          "Never include wallets, hotkeys, payout/reward estimates, raw trust scores, or farming language.",
          "Require authenticated browser session before showing private maintainer/operator notification details.",
          "Keep delivery opt-in and user-controlled on each device.",
        ],
        fallbackWhenUnavailable: "in_app_digest_only",
      },
      pwa: {
        nativeDependency: false,
        manifestPath: "/manifest.webmanifest",
        serviceWorkerPath: "/sw.js",
      },
      mobileReadyRoutes: ["/app", "/app/runs", "/app/repos", "/app/maintainer", "/app/operator"],
      nativeMobileFuture: [
        "OS-level background sync for alerts when browser is closed.",
        "Per-device biometric re-auth and secure lock-screen notification handling.",
      ],
    });
  });

  app.get("/v1/app/analytics/mcp-compatibility", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const days = Math.max(1, Math.min(90, Number(c.req.query("days") ?? 7) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return c.json({ generatedAt: nowIso(), days, adoption: await summarizeMcpCompatibilityAdoption(c.env, since) });
  });

  app.get("/v1/app/analytics/daily-rollups", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const limit = Math.max(1, Math.min(90, Number(c.req.query("limit") ?? 14) || 14));
    const [rollups, status] = await Promise.all([listProductUsageDailyRollups(c.env, { limit }), getProductUsageRollupStatus(c.env)]);
    return c.json({ generatedAt: nowIso(), status, rollups });
  });

  app.get("/v1/app/analytics/weekly-value-report", async (c) => {
    const variant = c.req.query("variant") === "operator" ? "operator" : "public";
    const allowedRoles: ControlPanelRoleName[] =
      variant === "operator" ? ["operator"] : ["miner", "maintainer", "owner", "operator"];
    const forbidden = await requireAppRole(c, allowedRoles);
    if (forbidden) return forbidden;
    const days = Math.max(1, Math.min(31, Number(c.req.query("days") ?? 7) || 7));
    const report = await loadWeeklyValueReport(c.env, { variant, days });
    if (c.req.query("format") === "markdown") {
      return c.text(formatWeeklyValueReportMarkdown(report), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
      });
    }
    return c.json(report);
  });

  app.get("/v1/app/commands", async (c) =>
    c.json({
      generatedAt: nowIso(),
      commands: APP_COMMANDS,
    }),
  );

  app.post("/v1/app/commands/preview", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const body = await c.req.json().catch(() => null);
    const parsed = commandPreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_command_preview_request", issues: parsed.error.issues }, 400);
    const command = APP_COMMANDS.find((candidate) => candidate.command === parsed.data.command || candidate.id === parsed.data.command.replace(/^@loopover\s+/, ""));
    if (!command) return c.json({ error: "command_not_found" }, 404);
    const identity = await authenticateRequestIdentity(c);
    const [repo, pullRequest] = await Promise.all([
      parsed.data.repoFullName ? getRepository(c.env, parsed.data.repoFullName) : Promise.resolve(null),
      parsed.data.repoFullName && parsed.data.pullNumber ? getPullRequest(c.env, parsed.data.repoFullName, parsed.data.pullNumber) : Promise.resolve(null),
    ]);
    const repoForbidden = await requireCommandPreviewRepoAccess(c, identity, parsed.data.repoFullName, repo);
    if (repoForbidden) return repoForbidden;
    const installationId = repo?.installationId ?? null;
    const installation = installationId !== null ? await getInstallationHealth(c.env, installationId) : null;
    const preview = buildCommandPreview(command, parsed.data, { repo, installation, pullRequest, env: c.env });
    await recordRouteProductUsage(c, {
      surface: "control_panel",
      eventName: "command_previewed",
      identity,
      repoFullName: parsed.data.repoFullName,
      targetKey: parsed.data.pullNumber ? `${parsed.data.repoFullName ?? "unknown"}#${parsed.data.pullNumber}` : parsed.data.repoFullName,
      outcome: "success",
      metadata: { command: command.id, audience: command.audience, boundary: command.boundary },
    });
    return c.json({
      generatedAt: nowIso(),
      command,
      request: parsed.data,
      preview,
    });
  });

  app.get("/v1/app/commands/usefulness", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const days = Number(c.req.query("days") ?? 30);
    return c.json(await getCommandUsefulnessSummary(c.env, { windowDays: clampInteger(days, 1, 180) }));
  });

  app.post("/v1/app/commands/feedback", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = commandFeedbackSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_command_feedback", issues: parsed.error.issues }, 400);
    const answer = await getAgentCommandAnswer(c.env, parsed.data.answerId);
    if (!answer) return c.json({ error: "command_answer_not_found" }, 404);
    const repo = await getRepository(c.env, answer.repoFullName);
    if (identity.kind === "session") {
      const repoForbidden = await requireSessionRepoAccess(c, identity, answer.repoFullName, repo);
      if (repoForbidden) return repoForbidden;
    }
    const actorLogin = identity.actor;
    await recordAgentCommandFeedback(c.env, {
      answerId: answer.id,
      repoFullName: answer.repoFullName,
      issueNumber: answer.issueNumber,
      command: answer.command,
      actorLogin,
      vote: parsed.data.vote,
      source: "app",
      actorKind: "maintainer",
      metadata: { surface: "app", identityKind: identity.kind },
    });
    await recordAuditEvent(c.env, {
      eventType: "github_app.agent_command_feedback_recorded",
      actor: actorLogin,
      targetKey: `${answer.repoFullName}#${answer.issueNumber}`,
      outcome: "completed",
      metadata: { answerId: answer.id, command: answer.command, vote: parsed.data.vote, source: "app", identityKind: identity.kind },
    });
    return c.json({
      ok: true,
      generatedAt: nowIso(),
      answer: {
        id: answer.id,
        repoFullName: answer.repoFullName,
        issueNumber: answer.issueNumber,
        command: answer.command,
      },
      vote: parsed.data.vote,
    });
  });

  app.get("/v1/app/digest", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const summary = await getRoleSummaryForIdentity(c.env, identity);
    if (!summary.roles.some((role) => ["maintainer", "owner", "operator"].includes(role))) return c.json({ error: "insufficient_role" }, 403);
    const login = identity.kind === "session" ? identity.actor : null;
    const [allRepositories, allHealth, upstreamDrift, allRateLimits, subscriptions] = await Promise.all([
      listRepositories(c.env),
      listInstallationHealth(c.env),
      loadUpstreamStatus(c.env),
      listLatestGitHubRateLimitObservations(c.env, 10),
      login ? listDigestSubscriptionsForLogin(c.env, login) : Promise.resolve([]),
    ]);
    // Tenant-scoped identically to /v1/app/maintainer-dashboard (#7659) -- a non-operator session must
    // only ever see their own repositories/installations/rate-limit telemetry, never the full fleet.
    const scope = identity.kind === "session" && !summary.roles.includes("operator") ? await loadControlPanelAccessScope(c.env, identity.actor, identity.session?.githubUserId) : null;
    const scopedRepoNames = new Set(scope?.repositoryFullNames.map((repo) => repo.toLowerCase()) ?? []);
    const scopedInstallationIds = new Set(scope?.installationIds ?? []);
    const scopedAccountLogins = new Set(scope?.accountLogins.map((accountLogin) => accountLogin.toLowerCase()) ?? []);
    const repositories = scope ? allRepositories.filter((repo) => scopedRepoNames.has(repo.fullName.toLowerCase())) : allRepositories;
    const health = scope
      ? allHealth.filter((record) => scopedInstallationIds.has(record.installationId) || scopedAccountLogins.has(record.accountLogin.toLowerCase()))
      : allHealth;
    const rateLimits = scope
      ? allRateLimits.filter((record) => record.repoFullName !== undefined && record.repoFullName !== null && scopedRepoNames.has(record.repoFullName.toLowerCase()))
      : allRateLimits;
    const items = buildDigestItems({ repositories, health, upstreamDrift, rateLimits });
    return c.json({
      generatedAt: nowIso(),
      date: nowIso().slice(0, 10),
      signal: items.some((item) => item.kind === "drift" || item.kind === "install") ? "warn" : "ready",
      items,
      subscriptions,
      delivery: { mode: "store_only", emailDeliveryEnabled: false },
    });
  });

  app.post("/v1/app/digest/subscriptions", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    if (!identity || identity.kind !== "session") return c.json({ error: "browser_session_required" }, 403);
    const body = await c.req.json().catch(() => null);
    const parsed = digestSubscriptionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_digest_subscription_request", issues: parsed.error.issues }, 400);
    const subscription = await upsertDigestSubscription(c.env, { login: identity.actor, email: parsed.data.email, source: "app" });
    await recordRouteProductUsage(c, {
      surface: "control_panel",
      eventName: "digest_subscription_stored",
      identity,
      outcome: "success",
      metadata: { source: "app", deliveryMode: "store_only" },
    });
    return c.json({ status: "stored", subscription, delivery: { mode: "store_only", emailDeliveryEnabled: false } }, 201);
  });

  app.get("/v1/registry/snapshot", async (c) => {
    const snapshot = await getLatestRegistrySnapshot(c.env);
    if (!snapshot) return c.json({ error: "registry_snapshot_not_found" }, 404);
    return c.json(snapshot);
  });

  app.get("/v1/registry/changes", async (c) => c.json(buildRegistryChangeReport(await listLatestRegistrySnapshots(c.env, 2))));

  app.get("/v1/scoring/model", async (c) => c.json(await getOrCreateScoringModelSnapshot(c.env)));

  // #6593: REST mirrors of the `loopover://finding-taxonomy` / `loopover://enrichment-analyzers` MCP
  // resources, so a plain HTTP client (a dashboard, a non-MCP integration) can discover the same static
  // documents. Both builders are pure, argument-free, and return no PR/user/private data — the same class of
  // public static discovery data as /v1/scoring/model and /v1/upstream/ruleset alongside them, so they carry no
  // extra auth. The MCP resource registrations stay exactly as they are; this is additive, not a replacement.
  app.get("/v1/finding-taxonomy", (c) => c.json(buildFindingTaxonomyDocument()));

  app.get("/v1/enrichment-analyzers", (c) => c.json(buildEnrichmentAnalyzersTaxonomyDocument()));

  app.get("/v1/upstream/status", async (c) => c.json(await loadUpstreamStatus(c.env)));

  app.get("/v1/upstream/ruleset", async (c) => {
    const ruleset = await getLatestUpstreamRulesetSnapshot(c.env);
    if (!ruleset) return c.json({ error: "upstream_ruleset_not_found" }, 404);
    return c.json(ruleset);
  });

  app.get("/v1/upstream/drift", async (c) =>
    c.json({
      generatedAt: nowIso(),
      upstreamDrift: await loadUpstreamStatus(c.env),
      reports: await listUpstreamDriftReports(c.env, 50),
    }),
  );

  app.post("/v1/scoring/preview", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = scorePreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_scoring_preview_request", issues: parsed.error.issues }, 400);
    if (parsed.data.contributorLogin) {
      const unauthorized = await requireContributorAccess(c, parsed.data.contributorLogin);
      if (unauthorized) return unauthorized;
    }
    const [repo, snapshot, evidence, contributorIssues] = await Promise.all([
      getRepository(c.env, parsed.data.repoFullName),
      getOrCreateScoringModelSnapshot(c.env),
      parsed.data.contributorLogin ? getContributorEvidence(c.env, parsed.data.contributorLogin) : Promise.resolve(null),
      parsed.data.contributorLogin ? listContributorIssues(c.env, parsed.data.contributorLogin) : Promise.resolve([]),
    ]);
    const openIssueCount = contributorOpenIssueCount(contributorIssues, parsed.data.repoFullName);
    // Time-decay (#703) is an owner-gated global, injected server-side (not caller-controllable).
    const input = { ...parsed.data, openIssueCount, applyTimeDecay: isTimeDecayEnabled(c.env) };
    const result = buildScorePreview({ input, repo, snapshot, contributorEvidence: evidence });
    const record = makeScorePreviewRecord(input, snapshot, result);
    await persistScorePreview(c.env, record);
    return c.json(record);
  });

  app.post("/v1/scoring/explain-breakdown", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = scorePreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_scoring_preview_request", issues: parsed.error.issues }, 400);
    if (!parsed.data.contributorLogin) return c.json({ error: "contributor_login_required" }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.contributorLogin);
    if (unauthorized) return unauthorized;
    const [repo, snapshot, evidence, contributorIssues] = await Promise.all([
      getRepository(c.env, parsed.data.repoFullName),
      getOrCreateScoringModelSnapshot(c.env),
      getContributorEvidence(c.env, parsed.data.contributorLogin),
      listContributorIssues(c.env, parsed.data.contributorLogin),
    ]);
    const openIssueCount = contributorOpenIssueCount(contributorIssues, parsed.data.repoFullName);
    // Time-decay (#703) is an owner-gated global, injected server-side (not caller-controllable).
    const input = { ...parsed.data, openIssueCount, applyTimeDecay: isTimeDecayEnabled(c.env) };
    const preview = buildScorePreview({ input, repo, snapshot, contributorEvidence: evidence });
    return c.json(explainScoreBreakdown(preview));
  });

  app.post("/v1/scoring/eligibility-plan", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = scorePreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_scoring_preview_request", issues: parsed.error.issues }, 400);
    // Like /v1/scoring/preview (and loopover_get_eligibility_plan's own MCP handler), the contributor gate is
    // conditional on contributorLogin being supplied — not unconditionally required as in explain-breakdown.
    if (parsed.data.contributorLogin) {
      const unauthorized = await requireContributorAccess(c, parsed.data.contributorLogin);
      if (unauthorized) return unauthorized;
    }
    const [repo, snapshot, evidence, contributorIssues] = await Promise.all([
      getRepository(c.env, parsed.data.repoFullName),
      getOrCreateScoringModelSnapshot(c.env),
      parsed.data.contributorLogin ? getContributorEvidence(c.env, parsed.data.contributorLogin) : Promise.resolve(null),
      parsed.data.contributorLogin ? listContributorIssues(c.env, parsed.data.contributorLogin) : Promise.resolve([]),
    ]);
    const openIssueCount = contributorOpenIssueCount(contributorIssues, parsed.data.repoFullName);
    // Time-decay (#703) is an owner-gated global, injected server-side (not caller-controllable).
    const input = { ...parsed.data, openIssueCount, applyTimeDecay: isTimeDecayEnabled(c.env) };
    const preview = buildScorePreview({ input, repo, snapshot, contributorEvidence: evidence });
    return c.json(deriveEligibilityPlan(preview));
  });

  app.get("/v1/sync/status", async (c) => {
    const [snapshot, scoringSnapshot, repositories, segments, totals, detailStates, installations, rateLimits, signalSnapshots, bounties, upstreamDrift] = await Promise.all([
      getLatestRegistrySnapshot(c.env),
      getLatestScoringModelSnapshot(c.env),
      listRepoSyncStates(c.env),
      listRepoSyncSegments(c.env),
      listLatestRepoGithubTotalsSnapshots(c.env),
      listAllPullRequestDetailSyncStates(c.env),
      listInstallationHealth(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
      listLatestSignalSnapshotsByTarget(c.env),
      listBounties(c.env),
      loadUpstreamStatus(c.env),
    ]);
    const repoCount = snapshot?.repoCount ?? repositories.length;
    const coreSignalFidelity = buildCoreSignalFidelity(repoCount, repositories, segments, totals, detailStates);
    const freshnessSlo = buildFreshnessSloReport({ registrySnapshot: snapshot, scoringSnapshot, repoCount, syncStates: repositories, totals, segments, signalSnapshots, bounties });
    return c.json({
      generatedAt: nowIso(),
      signalFidelity: buildSignalFidelity(repoCount, repositories, segments),
      freshnessSlo,
      coreSignalFidelity,
      upstreamDrift,
      historyCoverage: coreSignalFidelity.historyCoverage,
      refreshingRepos: coreSignalFidelity.refreshingRepos,
      waitingForRateLimitRepos: coreSignalFidelity.waitingForRateLimitRepos,
      repositories,
      segments: segments.map(enrichSyncSegment),
      githubTotals: totals,
      pullRequestDetailSync: detailStates,
      installations,
      rateLimits,
    });
  });

  app.get("/v1/readiness", async (c) => {
    const [snapshot, scoringSnapshot, syncStates, syncSegments, totals, detailStates, installations, installationHealth, rateLimits, signalSnapshots, bounties, upstreamDrift] = await Promise.all([
      getLatestRegistrySnapshot(c.env),
      getLatestScoringModelSnapshot(c.env),
      listRepoSyncStates(c.env),
      listRepoSyncSegments(c.env),
      listLatestRepoGithubTotalsSnapshots(c.env),
      listAllPullRequestDetailSyncStates(c.env),
      listInstallations(c.env),
      listInstallationHealth(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
      listLatestSignalSnapshotsByTarget(c.env),
      listBounties(c.env),
      loadUpstreamStatus(c.env),
    ]);
    const repoCount = snapshot?.repoCount ?? syncStates.length;
    const signalFidelity = buildSignalFidelity(repoCount, syncStates, syncSegments);
    const coreSignalFidelity = buildCoreSignalFidelity(repoCount, syncStates, syncSegments, totals, detailStates);
    const freshnessSlo = buildFreshnessSloReport({ registrySnapshot: snapshot, scoringSnapshot, repoCount, syncStates, totals, segments: syncSegments, signalSnapshots, bounties });
    const statusCounts = syncStates.reduce<Record<string, number>>((counts, state) => {
      counts[state.status] = (counts[state.status] ?? 0) + 1;
      return counts;
    }, {});
    const failingSyncs = syncStates.filter((state) => state.status === "error").slice(0, 10);
    const incompleteSyncs = syncStates.filter((state) => state.status === "never_synced" || state.status === "running" || state.status === "skipped").slice(0, 10);
    const missingSyncCount = snapshot ? Math.max(snapshot.repoCount - syncStates.length, 0) : 0;
    const warnings = [
      ...(!snapshot ? ["Registry snapshot is missing."] : []),
      ...(!scoringSnapshot ? ["Scoring model snapshot is missing. Run refresh-scoring-model before public review."] : []),
      ...(missingSyncCount > 0 ? [`${missingSyncCount} registered repo(s) do not have GitHub backfill state yet.`] : []),
      ...(!c.env.GITHUB_PUBLIC_TOKEN ? ["GITHUB_PUBLIC_TOKEN is not configured; public registered-repo backfill may hit GitHub rate limits."] : []),
      ...(failingSyncs.length > 0 ? [`${failingSyncs.length} recent repo sync error(s) are visible in the readiness sample.`] : []),
      ...(incompleteSyncs.length > 0 ? [`${incompleteSyncs.length} repo sync(s) are incomplete or skipped in the readiness sample.`] : []),
      ...(coreSignalFidelity.status !== "complete" ? [`Core open-data fidelity is ${coreSignalFidelity.status}; required open queue data is not complete.`] : []),
      ...(coreSignalFidelity.refreshingRepos.length > 0 ? [`${coreSignalFidelity.refreshingRepos.length} repo(s) are refreshing while preserving prior usable data.`] : []),
      ...(coreSignalFidelity.waitingForRateLimitRepos.length > 0 ? [`${coreSignalFidelity.waitingForRateLimitRepos.length} repo(s) are waiting for GitHub rate-limit recovery.`] : []),
      ...(signalFidelity.cappedRepos.length > 0 ? [`${signalFidelity.cappedRepos.length} repo sync(s) hit local pagination caps; signal fidelity is degraded.`] : []),
      ...(signalFidelity.rateLimitedRepos.length > 0 ? [`${signalFidelity.rateLimitedRepos.length} repo sync(s) encountered GitHub rate limiting.`] : []),
      ...(signalFidelity.staleRepos.length > 0 ? [`${signalFidelity.staleRepos.length} repo sync(s) are stale.`] : []),
      ...(freshnessSlo.status !== "fresh" ? [`Freshness SLO is ${freshnessSlo.status}; ${freshnessSlo.warnings.length} stale, missing, or blocked signal source(s) need repair.`] : []),
      ...(upstreamDrift.status === "drift_detected"
        ? [`Upstream Gittensor ruleset drift detected (${upstreamDrift.highestSeverity ?? "unknown"}): ${Array.isArray(upstreamDrift.affectedAreas) ? upstreamDrift.affectedAreas.join(", ") : "unknown"}.`]
        : []),
      ...(upstreamDrift.registryHyperparameterDrift.highImpactCount > 0
        ? [
            `High-impact registry hyperparameter drift detected (${upstreamDrift.registryHyperparameterDrift.highImpactCount} event(s) across ${upstreamDrift.registryHyperparameterDrift.affectedRepoCount} repo(s)): ${upstreamDrift.registryHyperparameterDrift.affectedFields.join(", ")}.`,
          ]
        : []),
      ...(upstreamDrift.status === "stale" ? ["Upstream Gittensor ruleset snapshot is stale."] : []),
      ...(upstreamDrift.status === "unavailable" ? ["Upstream Gittensor ruleset snapshot is unavailable."] : []),
      ...(installationHealth.some((health) => health.status !== "healthy") ? ["One or more GitHub App installations need attention."] : []),
    ];
    const upstreamLaunchBlocking = upstreamDrift.status === "unavailable" || upstreamDrift.highestSeverity === "high" || upstreamDrift.highestSeverity === "blocking";
    const ready = Boolean(snapshot) && Boolean(c.env.INTERNAL_JOB_TOKEN) && Boolean(c.env.LOOPOVER_API_TOKEN);
    const readyForPublicReview = snapshot
      ? snapshot.repoCount > 0 &&
        ready &&
        Boolean(scoringSnapshot) &&
        Boolean(c.env.GITHUB_PUBLIC_TOKEN) &&
        missingSyncCount === 0 &&
        failingSyncs.length === 0 &&
        coreSignalFidelity.status === "complete" &&
        freshnessSlo.launchBlockingCount === 0 &&
        !upstreamLaunchBlocking
      : false;
    return c.json({
      status: ready ? "ready" : "needs_attention",
      generatedAt: nowIso(),
      ready,
      readyForPublicReview,
      signalFidelity,
      freshnessSlo,
      coreSignalFidelity,
      upstreamDrift,
      historyCoverage: coreSignalFidelity.historyCoverage,
      partialRepos: signalFidelity.partialRepos,
      cappedRepos: signalFidelity.cappedRepos,
      staleRepos: signalFidelity.staleRepos,
      rateLimitedRepos: signalFidelity.rateLimitedRepos,
      refreshingRepos: coreSignalFidelity.refreshingRepos,
      waitingForRateLimitRepos: coreSignalFidelity.waitingForRateLimitRepos,
      nextRecoverableAt: signalFidelity.nextRecoverableAt,
      registry: snapshot
        ? { snapshotId: snapshot.id, repoCount: snapshot.repoCount, totalEmissionShare: snapshot.totalEmissionShare, source: snapshot.source, warningCount: snapshot.warnings.length }
        : null,
      scoringModel: scoringSnapshot
        ? {
            snapshotId: scoringSnapshot.id,
            activeModel: scoringSnapshot.activeModel,
            sourceKind: scoringSnapshot.sourceKind,
            fetchedAt: scoringSnapshot.fetchedAt,
            warningCount: scoringSnapshot.warnings.length,
          }
        : null,
      githubBackfill: {
        repoSyncCount: syncStates.length,
        statusCounts,
        failingSyncs: failingSyncs.map((state) => ({ repoFullName: state.repoFullName, errorSummary: state.errorSummary, lastCompletedAt: state.lastCompletedAt })),
        incompleteSyncs: incompleteSyncs.map((state) => ({ repoFullName: state.repoFullName, status: state.status, lastCompletedAt: state.lastCompletedAt })),
        segmentCount: syncSegments.length,
        segments: syncSegments.map(enrichSyncSegment),
        githubTotals: totals,
        pullRequestDetailSyncCount: detailStates.length,
        cappedSegments: syncSegments.filter((segment) => segment.status === "capped").map((segment) => ({ repoFullName: segment.repoFullName, segment: segment.segment, nextCursor: segment.nextCursor })),
        rateLimitedSegments: syncSegments
          .filter((segment) => segment.status === "rate_limited" || segment.status === "waiting_rate_limit")
          .map((segment) => ({ repoFullName: segment.repoFullName, segment: segment.segment, rateLimitResetAt: segment.rateLimitResetAt })),
        latestRateLimits: rateLimits,
      },
      installations: {
        count: installations.length,
        healthCount: installationHealth.length,
        unhealthyCount: installationHealth.filter((health) => health.status !== "healthy").length,
      },
      secrets: {
        githubAppPrivateKey: Boolean(c.env.GITHUB_APP_PRIVATE_KEY),
        githubWebhookSecret: Boolean(c.env.GITHUB_WEBHOOK_SECRET),
        githubPublicToken: Boolean(c.env.GITHUB_PUBLIC_TOKEN),
        apiToken: Boolean(c.env.LOOPOVER_API_TOKEN),
        mcpToken: Boolean(c.env.LOOPOVER_MCP_TOKEN),
        internalJobToken: Boolean(c.env.INTERNAL_JOB_TOKEN),
      },
      warnings,
    });
  });

  app.get("/v1/installations", async (c) =>
    c.json({
      installations: await listInstallations(c.env),
      health: (await listInstallationHealth(c.env)).map(enrichInstallationHealth),
    }),
  );

  app.get("/v1/installations/:id/health", async (c) => {
    const installationId = Number(c.req.param("id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "invalid_installation_id" }, 400);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    return c.json(enrichInstallationHealth(health));
  });

  app.get("/v1/installations/:id/repair", async (c) => {
    const installationId = Number(c.req.param("id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "invalid_installation_id" }, 400);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    return c.json(await buildInstallationRepairDiagnostics(c.env, health));
  });

  app.post("/v1/installations/:id/repair/refresh", async (c) => {
    const installationId = Number(c.req.param("id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "invalid_installation_id" }, 400);
    const refreshed = await refreshInstallationHealthForInstallation(c.env, installationId);
    if (!refreshed) return c.json({ error: "installation_not_found" }, 404);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    return c.json({ ...(await buildInstallationRepairDiagnostics(c.env, health)), refreshed: true });
  });

  // Tenant self-service for installation health/repair (#7661). The operator-only `/v1/installations*` routes
  // above expose the ENTIRE fleet, so a hosted tenant currently depends on the fleet operator to see or repair
  // even their own installation. These `/v1/app/installations*` siblings reuse `/v1/app/maintainer-dashboard`'s
  // exact scoping (`loadControlPanelAccessScope`, via `resolveAppInstallationScope`): an operator (or static
  // service identity) still sees everything (scope === null), while a non-operator session is limited to
  // installations under their own account or maintained repos — tenant A can never read or repair tenant B's.
  app.get("/v1/app/installations", async (c) => {
    const resolved = await resolveAppInstallationScope(c);
    if (resolved instanceof Response) return resolved;
    const { scope } = resolved;
    const [allInstallations, allHealth] = await Promise.all([listInstallations(c.env), listInstallationHealth(c.env)]);
    const installations = allInstallations.filter((installation) =>
      installationRecordInScope(scope, { installationId: installation.id, accountLogin: installation.accountLogin }),
    );
    const health = allHealth.filter((record) => installationRecordInScope(scope, record));
    return c.json({ installations, health: health.map(enrichInstallationHealth) });
  });

  app.get("/v1/app/installations/:id/health", async (c) => {
    const resolved = await resolveAppInstallationScope(c);
    if (resolved instanceof Response) return resolved;
    const installationId = Number(c.req.param("id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "invalid_installation_id" }, 400);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    if (!installationRecordInScope(resolved.scope, health)) return c.json({ error: "forbidden_installation" }, 403);
    return c.json(enrichInstallationHealth(health));
  });

  app.get("/v1/app/installations/:id/repair", async (c) => {
    const resolved = await resolveAppInstallationScope(c);
    if (resolved instanceof Response) return resolved;
    const installationId = Number(c.req.param("id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "invalid_installation_id" }, 400);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    if (!installationRecordInScope(resolved.scope, health)) return c.json({ error: "forbidden_installation" }, 403);
    return c.json(await buildInstallationRepairDiagnostics(c.env, health));
  });

  app.post("/v1/app/installations/:id/repair/refresh", async (c) => {
    const resolved = await resolveAppInstallationScope(c);
    if (resolved instanceof Response) return resolved;
    const installationId = Number(c.req.param("id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "invalid_installation_id" }, 400);
    // Ownership is enforced BEFORE the refresh side effect so a tenant can never trigger repair on an
    // installation they don't own; the existing health record supplies the account the scope is checked against.
    const existing = await getInstallationHealth(c.env, installationId);
    if (!existing) return c.json({ error: "installation_health_not_found" }, 404);
    if (!installationRecordInScope(resolved.scope, existing)) return c.json({ error: "forbidden_installation" }, 403);
    const refreshed = await refreshInstallationHealthForInstallation(c.env, installationId);
    if (!refreshed) return c.json({ error: "installation_not_found" }, 404);
    return c.json({ ...(await buildInstallationRepairDiagnostics(c.env, refreshed)), refreshed: true });
  });

  // #7676: a hosted tenant with multiple repos under one installation had no way to pause/dry-run all of
  // them at once -- only the strictly-per-repo PUT /v1/repos/:owner/:repo/settings existed. Layers on top
  // of it: applies the same agentPaused/agentDryRun flags across every currently-installed repo in the
  // installation in one call. Distinct from the global operator kill-switch (getGlobalAgentFrozenState),
  // which stays a deliberately separate singleton this never touches. Same tenant-vs-tenant isolation as
  // this route family's siblings above (resolveAppInstallationScope / installationRecordInScope) -- an
  // operator sees/writes any installation, a non-operator session only their own.
  app.put("/v1/app/installations/:id/agent/bulk-settings", async (c) => {
    const resolved = await resolveAppInstallationScope(c);
    if (resolved instanceof Response) return resolved;
    const installationId = Number(c.req.param("id"));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "invalid_installation_id" }, 400);
    const installation = await getInstallation(c.env, installationId);
    if (!installation) return c.json({ error: "installation_not_found" }, 404);
    if (!installationRecordInScope(resolved.scope, { installationId: installation.id, accountLogin: installation.accountLogin })) {
      return c.json({ error: "forbidden_installation" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = installationBulkAgentSettingsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_bulk_agent_settings", issues: parsed.error.issues }, 400);
    const changes = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as Partial<RepositorySettings>;
    const repoFullNames = await listInstalledRepoFullNamesForInstallation(c.env, installationId);
    await Promise.all(
      repoFullNames.map(async (repoFullName) => {
        const current = await getRepositorySettings(c.env, repoFullName);
        await upsertRepositorySettings(c.env, { ...current, ...changes, repoFullName });
        // #9018: mirrors the single-repo pause/resume tool's own catch-up (mcp/server.ts setAgentPaused) --
        // a paused->live transition performs no re-evaluation by default, so a PR that went green during the
        // pause window can be permanently stranded once #never-endless-reregate excludes it from future sweep
        // candidacy. Restores one-shot candidacy for every open PR in this repo.
        if (current.agentPaused === true && changes.agentPaused === false) {
          await clearPullRequestsRegatedAtForOpenPrs(c.env, repoFullName);
        }
      }),
    );
    await recordAuditEvent(c.env, {
      eventType: "installation.agent_bulk_settings_updated",
      actor: resolved.identity.actor,
      targetKey: `installation#${installationId}`,
      outcome: "completed",
      detail: `Applied bulk agent settings across ${repoFullNames.length} repo(s).`,
      metadata: { installationId, repoCount: repoFullNames.length, fields: Object.keys(changes) },
    });
    return c.json({ ok: true, installationId, repoCount: repoFullNames.length, repoFullNames, applied: changes });
  });

  app.get("/v1/repos", async (c) => c.json(await listRepositories(c.env)));

  app.get("/v1/repos/:owner/:repo", async (c) => {
    const repo = await getRepository(c.env, `${c.req.param("owner")}/${c.req.param("repo")}`);
    if (!repo) return c.json({ error: "repo_not_found" }, 404);
    return c.json(repo);
  });

  app.get("/v1/repos/:owner/:repo/intelligence", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const identity = await authenticateRequestIdentity(c);
    if (identity?.kind === "static" && identity.actor === "mcp" && !(await import("../auth/security")).isMcpReadRepoAllowed(c.env.MCP_READ_REPO_ALLOWLIST, fullName)) return c.json({ error: "forbidden_repo" }, 403);
    return c.json(await buildRepoIntelligenceResponse(c.env, fullName));
  });

  app.get("/v1/repos/:owner/:repo/issue-quality", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before route-specific repo guards. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const repo = identity.kind === "session" ? await getRepository(c.env, fullName) : null;
    if (identity.kind === "session") {
      const forbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (forbidden) return forbidden;
    }
    if (identity.kind === "static" && identity.actor === "mcp" && !(await import("../auth/security")).isMcpReadRepoAllowed(c.env.MCP_READ_REPO_ALLOWLIST, fullName)) return c.json({ error: "forbidden_repo" }, 403);
    const response = await buildIssueQualityResponse(c.env, fullName);
    if (!response) return c.json({ error: "issue_quality_not_found", repoFullName: fullName }, 404);
    return c.json(response);
  });

  app.post("/v1/repos/:owner/:repo/validate-linked-issue", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before route-specific repo guards. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const parsed = validateLinkedIssueSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_validate_linked_issue_request", issues: parsed.error.issues }, 400);
    const [repo, issues, pullRequests, recentMergedPullRequests] = await Promise.all([
      getRepository(c.env, fullName),
      listIssueSignalSample(c.env, fullName),
      listOpenPullRequests(c.env, fullName),
      listRecentMergedPullRequests(c.env, fullName),
    ]);
    if (identity.kind === "session") {
      const forbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (forbidden) return forbidden;
    }
    return c.json(buildLinkedIssueValidation(repo, issues, pullRequests, recentMergedPullRequests, fullName, parsed.data.issueNumber, parsed.data.plannedChange ?? {}));
  });

  app.post("/v1/repos/:owner/:repo/check-before-start", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before route-specific repo guards. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const parsed = checkBeforeStartSchema.safeParse(body ?? {});
    if (!parsed.success) return c.json({ error: "invalid_check_before_start_request", issues: parsed.error.issues }, 400);
    const [repo, issues, pullRequests, recentMergedPullRequests] = await Promise.all([
      getRepository(c.env, fullName),
      listIssueSignalSample(c.env, fullName),
      listOpenPullRequests(c.env, fullName),
      listRecentMergedPullRequests(c.env, fullName),
    ]);
    if (identity.kind === "session") {
      const forbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (forbidden) return forbidden;
    }
    return c.json(buildPreStartCheck(repo, issues, pullRequests, recentMergedPullRequests, fullName, parsed.data));
  });

  app.get("/v1/repos/:owner/:repo/registration-readiness", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await buildRegistrationReadinessResponse(c.env, fullName));
  });

  app.get("/v1/repos/:owner/:repo/gittensor-config-recommendation", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await buildGittensorConfigRecommendationResponse(c.env, fullName));
  });

  app.get("/v1/repos/:owner/:repo/focus-manifest", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    const repo = await getRepository(c.env, fullName);
    if (identity?.kind === "session") {
      const repoForbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (repoForbidden) return repoForbidden;
    }
    const manifest = await loadRepoFocusManifest(c.env, fullName);
    return c.json({ repoFullName: fullName, manifest, policy: compileFocusManifestPolicy(manifest) });
  });

  app.post("/v1/repos/:owner/:repo/focus-manifest/refresh", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const manifest = await loadRepoFocusManifest(c.env, fullName, { refresh: true });
    return c.json({ repoFullName: fullName, manifest, policy: compileFocusManifestPolicy(manifest) });
  });

  app.put("/v1/repos/:owner/:repo/focus-manifest", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: "invalid_json" }, 400);
    const manifest = await upsertRepoFocusManifest(c.env, fullName, body, "api_record");
    return c.json({ repoFullName: fullName, manifest, policy: compileFocusManifestPolicy(manifest) });
  });

  app.get("/v1/app/self-dogfood/registration-pack", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    const fullName = resolveSelfDogfoodRepoFullName(c.env);
    const repo = await getRepository(c.env, fullName);
    if (identity?.kind === "session") {
      const repoForbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (repoForbidden) return repoForbidden;
    }
    return c.json(await buildSelfDogfoodRegistrationPackResponse(c.env));
  });

  app.get("/v1/repos/:owner/:repo/self-dogfood-registration-pack", async (c) => {
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    if (fullName.toLowerCase() !== resolveSelfDogfoodRepoFullName(c.env).toLowerCase()) {
      return c.json({ error: "self_dogfood_repo_only", repoFullName: resolveSelfDogfoodRepoFullName(c.env) }, 403);
    }
    return c.json(await buildSelfDogfoodRegistrationPackResponse(c.env));
  });

  app.get("/v1/repos/:owner/:repo/onboarding-pack/preview", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    const repo = await getRepository(c.env, fullName);
    if (identity?.kind === "session") {
      const repoForbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (repoForbidden) return repoForbidden;
    }
    const response = await buildRepoOnboardingPackPreviewForRepo(c.env, fullName, {
      refreshManifest: c.req.query("refresh") === "true",
    });
    if ("error" in response) {
      return c.json(response, 404);
    }
    return c.json(response);
  });

  app.post("/v1/repos/:owner/:repo/contributor-issue-drafts/generate", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    const repo = await getRepository(c.env, fullName);
    if (identity?.kind === "session") {
      const repoForbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (repoForbidden) return repoForbidden;
    }
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: "invalid_json" }, 400);
    const parsed = contributorIssueDraftGenerateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_contributor_issue_draft_request", issues: parsed.error.issues }, 400);
    if (parsed.data.create && parsed.data.dryRun !== false) {
      return c.json({ error: "explicit_create_requires_dry_run_false" }, 400);
    }
    if (parsed.data.create && parsed.data.dryRun === false) {
      const writeForbidden = await requireRepoWriteAccess(c, fullName);
      if (writeForbidden instanceof Response) return writeForbidden;
    }
    return c.json(
      await generateContributorIssueDrafts(c.env, fullName, {
        dryRun: parsed.data.dryRun,
        create: parsed.data.create,
        limit: parsed.data.limit,
        requestedBy: identity?.kind === "session" ? identity.actor : "api",
      }),
    );
  });

  // #7764: REST mirror of the loopover_plan_repo_issues MCP tool (src/mcp/server.ts) and the
  // `maintain plan-issues` CLI. Gated EXACTLY like the sibling contributor-issue-drafts route above
  // (requireAppRole maintainer/owner/operator, then per-repo requireSessionRepoAccess for sessions), and it
  // preserves the same create-safety: dry-run by default, and the write path is entered only when the caller
  // passes BOTH create:true and dryRun:false -- which additionally requires live repo write access. The
  // required `goal` is a maintainer-supplied free-form planning goal the service turns into issue drafts.
  app.post("/v1/repos/:owner/:repo/issue-plan-drafts/generate", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    const repo = await getRepository(c.env, fullName);
    if (identity?.kind === "session") {
      const repoForbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (repoForbidden) return repoForbidden;
    }
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: "invalid_json" }, 400);
    const parsed = issuePlanDraftGenerateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_issue_plan_draft_request", issues: parsed.error.issues }, 400);
    if (parsed.data.create && parsed.data.dryRun !== false) {
      return c.json({ error: "explicit_create_requires_dry_run_false" }, 400);
    }
    if (parsed.data.create && parsed.data.dryRun === false) {
      const writeForbidden = await requireRepoWriteAccess(c, fullName);
      if (writeForbidden instanceof Response) return writeForbidden;
    }
    return c.json(
      await generateIssuePlanDrafts(c.env, fullName, parsed.data.goal, {
        dryRun: parsed.data.dryRun,
        create: parsed.data.create,
        limit: parsed.data.limit,
        requestedBy: identity?.kind === "session" ? identity.actor : "api",
      }),
    );
  });

  // Repo loopover settings (gate config, AI-review mode/provider/model — NON-secret; the BYOK key is
  // never here). Maintainer DATA: session callers must be a verified maintainer of THIS repo (per-repo
  // scope), so a maintainer of repo A cannot read repo B's config. Server-to-server tokens are exempt.
  app.get("/v1/repos/:owner/:repo/settings", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    if (gate instanceof Response) return gate;
    // resolveRepositorySettings (not the raw getRepositorySettings row), so this reflects the true EFFECTIVE
    // value -- a config-as-code-only field (Batch A, loopover#6442) would otherwise always show its hardcoded
    // default here regardless of what the repo's .loopover.yml actually configures.
    return c.json(await resolveRepositorySettings(c.env, fullName));
  });

  // #6742 read-side automation state: the DERIVED view (mode / permissionReadiness / pendingActionCount /
  // acting classes) that /settings deliberately does not return -- symmetric with the write-side PUT /settings
  // and the CLI's maintain pause/resume/set-level. Maintainer-gated like /settings; shares buildAutomationState
  // with the loopover_get_automation_state MCP tool so the two surfaces cannot drift.
  app.get("/v1/repos/:owner/:repo/automation-state", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    return c.json(await buildAutomationState(c.env, fullName));
  });

  // #130 maintainer settings editor: PATCH-style save of the gate / slop / label / surface / command-auth
  // settings. Write-access gated + audited because these repo-visible settings include agent autonomy
  // controls. upsertRepositorySettings defaults any absent field, so we merge the sent keys onto the
  // current settings rather than overwriting unrelated groups. The secret
  // aiReview key + the operator-only scoring internals are deliberately not settable here.
  app.put("/v1/repos/:owner/:repo/settings", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const body = await c.req.json().catch(() => null);
    const parsed = maintainerSettingsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_repository_settings", issues: parsed.error.issues }, 400);
    const current = await getRepositorySettings(c.env, fullName);
    const changes = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as Partial<RepositorySettings>;
    const updated = await upsertRepositorySettings(c.env, { ...current, ...changes, repoFullName: fullName });
    await recordAuditEvent(c.env, {
      eventType: "repo.settings_updated",
      actor: gate.identity?.kind === "session" ? gate.identity.actor : null,
      targetKey: fullName,
      outcome: "success",
      detail: `Updated ${Object.keys(changes).length} maintainer setting(s).`,
      metadata: { repoFullName: fullName, fields: Object.keys(changes) },
    });
    return c.json(updated);
  });

  // #779 approval queue: the auto_with_approval actions the agent staged on this repo, awaiting a maintainer
  // decision. Maintainer-scoped + per-repo.
  app.get("/v1/repos/:owner/:repo/agent/pending-actions", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    const pending = await listPendingAgentActions(c.env, { repoFullName: fullName, status: "pending" });
    return c.json({ repoFullName: fullName, pendingActions: pending });
  });

  // #779 one-tap decision: accept → execute the staged action live; reject → cancel. Both feed the trust loop.
  app.post("/v1/repos/:owner/:repo/agent/pending-actions/:id/:decision", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const decision = c.req.param("decision");
    if (decision !== "accept" && decision !== "reject") return c.json({ error: "invalid_decision", detail: "decision must be 'accept' or 'reject'" }, 400);
    const gate = await requireRepoWriteAccess(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    const pending = await getPendingAgentAction(c.env, c.req.param("id"));
    // Scope the action to THIS repo so a maintainer cannot decide another repo's queue via a guessed id.
    if (!pending || pending.repoFullName !== fullName) return c.json({ error: "pending_action_not_found" }, 404);
    const decidedBy = gate.identity?.kind === "session" ? gate.identity.actor : "maintainer";
    const result = await decidePendingAgentAction(c.env, { id: pending.id, decision, decidedBy });
    if (result.status === "already_decided") return c.json({ error: "already_decided", action: result.action }, 409);
    return c.json(result);
  });

  // #6743 — REST mirror of the loopover_refresh_repo_docs MCP tool (src/mcp/server.ts's refreshRepoDocs):
  // opens (or finds the already-open) AGENTS.md/CLAUDE.md generation PR. Only ever opens a PR (never merges,
  // closes, or commits directly), so — like the decision route above — it's safe to run synchronously in one
  // call rather than needing the propose/decide staging pattern. Trims the runner's internal `claudeMode`
  // field the same way the MCP tool's own response does, so both mirrors expose the identical public shape.
  app.post("/v1/repos/:owner/:repo/repo-docs/refresh", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    const result = await performRepoDocRefresh(c.env, fullName);
    if (!result.opened) return c.json(result);
    return c.json({ opened: true, reused: result.reused, pullNumber: result.pullNumber, url: result.url });
  });

  // #6744 propose: the CREATE side of the approval queue the list (GET) + decision (POST /:id/:decision) routes
  // already cover. Stages an auto_with_approval action for a maintainer to later accept/reject; it never executes
  // one. Mirrors the loopover_propose_action MCP tool (src/mcp/server.ts:proposeAction) VERBATIM — same
  // requireRepoWriteAccess gate as the decision route, same head-SHA pinning (#2255), same { created, action } shape.
  app.post("/v1/repos/:owner/:repo/agent/pending-actions", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    const body = await c.req.json().catch(() => null);
    const parsed = proposePendingActionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_propose_action_request", issues: parsed.error.issues }, 400);
    const repo = await getRepository(c.env, fullName);
    if (!repo?.installationId) return c.json({ error: "app_not_installed", detail: "The LoopOver App is not installed on this repository." }, 409);
    // Pin the staged action to the head the proposer saw, so the accept path's force-push freshness guard can
    // catch an unreviewed force-push between proposal and accept (matches proposeAction, #2255).
    const pr = await getPullRequest(c.env, fullName, parsed.data.pullNumber);
    const params = {
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      ...(parsed.data.reviewBody !== undefined ? { reviewBody: parsed.data.reviewBody } : {}),
      ...(parsed.data.mergeMethod !== undefined ? { mergeMethod: parsed.data.mergeMethod } : {}),
      ...(parsed.data.closeComment !== undefined ? { closeComment: parsed.data.closeComment } : {}),
      ...(pr?.headSha ? { expectedHeadSha: pr.headSha } : {}),
    };
    const { action, created } = await createPendingAgentActionIfAbsent(c.env, {
      repoFullName: fullName,
      pullNumber: parsed.data.pullNumber,
      installationId: repo.installationId,
      actionClass: parsed.data.actionClass,
      autonomyLevel: "auto_with_approval",
      params,
      reason: parsed.data.reason ?? null,
    });
    return c.json({ created, action: { id: action.id, actionClass: action.actionClass, pullNumber: action.pullNumber, status: action.status, reason: action.reason } });
  });

  // #784 audit feed: the agent's executed actions + approval-queue decisions for this repo. Maintainer-scoped,
  // read-only, public-safe (action posture only — no trust/score metadata). `?since=ISO&limit=N` (max 200).
  // `?pull=N` opts into the unfiltered sibling query (listAuditEventsForTarget): every audit_events row for
  // that one PR's targetKey, not just the agent.action.%/agent.pending_action.% subset — still maintainer-gated
  // by the same requireRepoMaintainer check above, just scoped to a single PR instead of the whole repo.
  app.get("/v1/repos/:owner/:repo/agent/audit-feed", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    const since = c.req.query("since");
    if (since !== undefined && Number.isNaN(Date.parse(since))) return c.json({ error: "invalid_since", detail: "since must be an ISO-8601 timestamp" }, 400);
    const limitParam = c.req.query("limit");
    let limit: number | undefined;
    if (limitParam !== undefined) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return c.json({ error: "invalid_limit", detail: "limit must be an integer between 1 and 200" }, 400);
      limit = parsed;
    }
    const pullParam = c.req.query("pull");
    if (pullParam !== undefined) {
      const pullNumber = Number(pullParam);
      if (!Number.isInteger(pullNumber) || pullNumber <= 0) return c.json({ error: "invalid_pull", detail: "pull must be a positive integer" }, 400);
      const targetEvents = await listAuditEventsForTarget(c.env, {
        repoFullName: fullName,
        pullNumber,
        ...(since !== undefined ? { sinceIso: since } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return c.json({
        repoFullName: fullName,
        pullNumber,
        events: targetEvents.map((event) => ({ ...event, detail: event.detail === null ? null : sanitizePublicComment(event.detail) })),
      });
    }
    const events = await listAgentAuditEvents(c.env, {
      repoFullName: fullName,
      ...(since !== undefined ? { sinceIso: since } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    // Defense-in-depth: the free-form `detail` is the only unbounded string — scrub it before it leaves on a public surface.
    return c.json({ repoFullName: fullName, events: events.map((event) => ({ ...event, detail: event.detail === null ? null : sanitizePublicComment(event.detail) })) });
  });

  // #5672 post-merge incident report, customer-facing side: a repo maintainer reports that an already-merged
  // rented-loop PR was found harmful. Persists as an audit_events row keyed to this PR (same targetKey the
  // audit-feed route above reads back via ?pull=N), so no separate incident table/read-route is needed here.
  app.post("/v1/repos/:owner/:repo/pulls/:number/incident-reports", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    const pullNumber = Number(c.req.param("number"));
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) return c.json({ error: "invalid_pull_number" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = postMergeIncidentReportSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_incident_report", issues: parsed.error.issues }, 400);
    const pullRequest = await getPullRequest(c.env, fullName, pullNumber);
    if (!pullRequest) return c.json({ error: "pull_request_not_found" }, 404);
    if (!pullRequest.mergedAt) return c.json({ error: "pull_request_not_merged" }, 409);
    const actor = gate.identity?.kind === "session" ? gate.identity.actor : "maintainer";
    const report = await recordPostMergeIncidentReport(c.env, {
      repoFullName: fullName,
      pullNumber,
      description: parsed.data.description,
      severity: parsed.data.severity,
      mergedSha: parsed.data.mergedSha,
      reporterKind: "customer",
      actor,
      route: c.req.path,
    });
    return c.json({ ok: true, repoFullName: fullName, pullNumber, ...report });
  });

  // Maintainer activation demo (#701): a repo-specific "here's what LoopOver would have surfaced" preview
  // over recent PRs. Maintainer-scoped + per-repo. Deterministic (no AI run).
  app.get("/v1/repos/:owner/:repo/activation-preview", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    if (gate instanceof Response) return gate;
    // resolveRepositorySettings (not the raw getRepositorySettings row), so reviewCheckMode/aiReviewMode --
    // both config-as-code only now (Batch C, loopover#6444) -- reflect a repo's real .loopover.yml-driven
    // state instead of always reporting the hardcoded DB default (#6444 follow-up to the #6557-class bug).
    const [repo, settings, pullRequests] = await Promise.all([
      getRepository(c.env, fullName),
      resolveRepositorySettings(c.env, fullName),
      listPullRequests(c.env, fullName),
    ]);
    return c.json(
      buildMaintainerActivationPreview({
        repoFullName: fullName,
        repo,
        settings,
        pullRequests,
        generatedAt: nowIso(),
        duplicateWinnerEnabled: resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(c.env), settings.duplicateWinnerMode),
      }),
    );
  });

  // #543 outcome-learning loop: is the slop score predictive, and are recommendations panning out? Read-only
  // measurement over resolved PRs (slop band -> merge/close) + the recommendation-outcome ledger. Optional
  // ?windowDays bounds the recommendation window.
  app.get("/v1/repos/:owner/:repo/outcome-calibration", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    if (gate instanceof Response) return gate;
    // A positive number opts into a bounded recommendation window; anything else (absent/0/NaN) → full
    // history. The repository layer clamps + floors the value, so one comparison covers every input.
    const windowDaysRaw = Number(c.req.query("windowDays"));
    const windowDays = windowDaysRaw > 0 ? windowDaysRaw : undefined;
    return c.json(await buildRepoOutcomeCalibration(c.env, fullName, windowDays));
  });

  // #554 gate false-positive telemetry: is the gate PRECISE? Read-only measurement of blocked-then-merged
  // (and overridden) per gate type — the evidence a maintainer needs before promoting a gate to block. NEVER
  // adjusts a gate. Maintainer-authenticated, repo-scoped; no public route. Optional ?windowDays bounds the
  // block ledger window. Optional ?includeCohorts=true (#4520) adds an additive miner-vs-human split — an
  // extra Gittensor API call, so it's opt-in rather than always computed.
  app.get("/v1/repos/:owner/:repo/gate-precision", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    if (gate instanceof Response) return gate;
    const windowDaysRaw = Number(c.req.query("windowDays"));
    const windowDays = windowDaysRaw > 0 ? windowDaysRaw : undefined;
    const includeCohorts = c.req.query("includeCohorts") === "true";
    return c.json(
      await loadGatePrecisionReport(c.env, fullName, {
        ...(windowDays !== undefined ? { windowDays } : {}),
        ...(includeCohorts ? { includeCohorts } : {}),
      }),
    );
  });

  // #2228 maintainer queue-noise triage: read-only report for MCP stdio proxy + maintainer tooling.
  // Maintainer-authenticated, repo-scoped; replaces the removed legacy public route with the same path shape.
  app.get("/v1/repos/:owner/:repo/maintainer-noise", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    if (gate instanceof Response) return gate;
    return c.json(await loadMaintainerNoiseReport(c.env, fullName));
  });

  // #6488 (per #6210's decided design): AMS-vs-human contributor-mix dashboard comparison. Maintainer-scoped,
  // mirrors maintainer-noise above. `present: false` (never a 404/error) when the AMS reputation bridge is off,
  // unconfigured, or the repo has no submitter activity in the window -- the panel's own required empty state.
  app.get("/v1/repos/:owner/:repo/ams-miner-cohort", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    /* v8 ignore next -- unauthorized requests are rejected by the auth middleware before reaching the handler. */
    if (gate instanceof Response) return gate;
    return c.json(await buildAmsMinerCohortComparison(c.env, fullName));
  });

  // #6168 self-tune override admin: the operator-facing read side of the self-tune override store. The
  // LOOPOVER_REVIEW_SELFTUNE loop only ever writes override_audit rows automatically (via the cron's promote
  // path); this exposes the audit trail so a self-host operator can inspect it without direct D1 access.
  // Maintainer-scoped + read-only, mirroring the gate-precision route above.
  app.get("/v1/repos/:owner/:repo/selftune/overrides/audit", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    if (gate instanceof Response) return gate;
    const limitRaw = Number(c.req.query("limit"));
    const limit = limitRaw > 0 ? limitRaw : undefined;
    const audit = await listOverrideAudit(c.env as unknown as StorageEnv, fullName, limit);
    return c.json({ repoFullName: fullName, audit });
  });

  // #6168 self-tune override admin: clear the LIVE override for a repo (the operator's "reset to config base"
  // control). An optional JSON body is treated as a confirmation of the override being cleared and is run
  // through the same sanitizer the apply path uses — a malformed payload is rejected (400) rather than
  // silently ignored. Maintainer-scoped; the automatic promote path is untouched.
  app.delete("/v1/repos/:owner/:repo/selftune/overrides", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    if (gate instanceof Response) return gate;
    const body = await c.req.json().catch(() => null);
    if (body !== null && sanitizeOverridePayload(body) === null) {
      return c.json({ error: "invalid_override_payload" }, 400);
    }
    await deleteLiveOverride(c.env as unknown as StorageEnv, fullName);
    return c.json({ repoFullName: fullName, cleared: true });
  });

  // Maintainer self-serve AI-review config. mode/byok/provider/model/allAuthors are config-as-code only now
  // (Batch C, loopover#6444) -- set via a repo's own .loopover.yml gate.aiReview.* block; this route can
  // only still persist closeOwnerAuthors/lowConfidenceDisposition. Session-authenticated + scoped to repos
  // the maintainer has live GitHub write access to. The secret provider key goes through the ai-key route.
  // Merges onto current settings so unrelated settings are preserved.
  app.put("/v1/repos/:owner/:repo/ai-review", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const parsed = repositoryAiReviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_ai_review_config", issues: parsed.error.issues }, 400);
    const current = await getRepositorySettings(c.env, fullName);
    const updated = await upsertRepositorySettings(c.env, {
      ...current,
      aiReviewLowConfidenceDisposition: parsed.data.lowConfidenceDisposition ?? current.aiReviewLowConfidenceDisposition,
      closeOwnerAuthors: parsed.data.closeOwnerAuthors ?? current.closeOwnerAuthors,
    });
    // mode/byok/provider/model/allAuthors read from the manifest-resolved settings (not `updated`, which is
    // always the hardcoded default for these five now) so the response reflects a repo's real
    // .loopover.yml-driven state instead of silently reporting the same constant on every save.
    const manifest = await loadRepoFocusManifest(c.env, fullName);
    const resolved = resolveEffectiveSettings(updated, manifest);
    return c.json({
      aiReviewMode: resolved.aiReviewMode,
      aiReviewByok: resolved.aiReviewByok,
      aiReviewProvider: resolved.aiReviewProvider ?? null,
      aiReviewModel: resolved.aiReviewModel ?? null,
      aiReviewAllAuthors: resolved.aiReviewAllAuthors,
      // parseAiReviewLowConfidenceDisposition's return type is non-nullable and already falls back to the
      // literal "hold_for_review" itself, so this side of the `??` can never actually run.
      /* v8 ignore next */
      aiReviewLowConfidenceDisposition: updated.aiReviewLowConfidenceDisposition ?? "hold_for_review",
      closeOwnerAuthors: updated.closeOwnerAuthors,
      // Tells the dashboard these five fields are read-only now and where to configure them instead --
      // see apps/loopover-ui's AiReviewSettings component, which stops rendering them as editable inputs.
      aiReviewConfigAsCode: true,
    });
  });

  // Maintainer self-serve BYOK provider key. Write-only + live GitHub write-access scoped. GET returns only
  // {configured, provider, last4, model}; the key is never returned, logged, or surfaced.
  app.get("/v1/repos/:owner/:repo/ai-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    return c.json(await getRepositoryAiKeyStatus(c.env, fullName));
  });

  app.post("/v1/repos/:owner/:repo/ai-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const parsed = repositoryAiKeySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_ai_key", issues: parsed.error.issues }, 400);
    const createdBy = gate.identity?.kind === "session" ? gate.identity.actor : null;
    try {
      return c.json(await upsertRepositoryAiKey(c.env, { repoFullName: fullName, provider: parsed.data.provider, key: parsed.data.key, model: parsed.data.model ?? null, createdBy }));
    } catch (error) {
      if (error instanceof Error && error.message === "missing_encryption_secret") {
        return c.json({ error: "encryption_unavailable", detail: "Key storage is not configured on the server." }, 503);
      }
      throw error;
    }
  });

  app.delete("/v1/repos/:owner/:repo/ai-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const actor = gate.identity?.kind === "session" ? gate.identity.actor : null;
    await deleteRepositoryAiKey(c.env, fullName, actor);
    return c.json({ configured: false });
  });

  // Maintainer self-serve Linear API key (#3186). Write-only + live GitHub write-access scoped, mirroring the
  // ai-key routes above. GET returns only {configured, last4}; the key is never returned, logged, or surfaced.
  app.get("/v1/repos/:owner/:repo/linear-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    return c.json(await getRepositoryLinearKeyStatus(c.env, fullName));
  });

  app.post("/v1/repos/:owner/:repo/linear-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const parsed = repositoryLinearKeySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_linear_key", issues: parsed.error.issues }, 400);
    const createdBy = gate.identity?.kind === "session" ? gate.identity.actor : null;
    try {
      return c.json(await upsertRepositoryLinearKey(c.env, { repoFullName: fullName, key: parsed.data.key, createdBy }));
    } catch (error) {
      if (error instanceof Error && error.message === "missing_encryption_secret") {
        return c.json({ error: "encryption_unavailable", detail: "Key storage is not configured on the server." }, 503);
      }
      throw error;
    }
  });

  app.delete("/v1/repos/:owner/:repo/linear-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoWriteAccess(c, fullName);
    if (gate instanceof Response) return gate;
    const actor = gate.identity?.kind === "session" ? gate.identity.actor : null;
    await deleteRepositoryLinearKey(c.env, fullName, actor);
    return c.json({ configured: false });
  });

  app.post("/v1/repos/:owner/:repo/settings-preview", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const body = (await c.req.json().catch(() => null)) ?? {};
    const parsed = settingsPreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_settings_preview_request", issues: parsed.error.issues }, 400);
    const repo = await getRepository(c.env, fullName);
    if (identity?.kind === "session") {
      const unauthorized = await requireSessionRepoAccess(c, identity, fullName, repo);
      if (unauthorized) return unauthorized;
    }
    const [settings, issues, pullRequests] = await Promise.all([
      resolveRepositorySettings(c.env, fullName),
      listIssues(c.env, fullName),
      listPullRequests(c.env, fullName),
    ]);
    const installationId = repo?.installationId ?? null;
    const healthRecord = installationId !== null ? await getInstallationHealth(c.env, installationId) : null;
    const enriched = healthRecord ? enrichInstallationHealth(healthRecord) : null;
    const installation = enriched
      ? {
          installationId: enriched.installationId,
          status: enriched.status,
          missingPermissions: enriched.missingPermissions,
          missingEvents: enriched.missingEvents,
          permissionRemediation: enriched.permissionRemediation,
        }
      : null;
    return c.json(
      buildRepoSettingsPreview({
        repoFullName: fullName,
        repo,
        settings,
        installation,
        issues,
        pullRequests,
        sample: parsed.data.sample ?? {},
        env: c.env,
      }),
    );
  });

  // Maintainer dashboard chat Q&A (#6489, per #6230's scope decision): exposes the EXISTING
  // `@loopover chat <question>` service (generateChatQaAnswer, #4595) to apps/loopover-ui's maintainer
  // panel -- read-only, no new LLM-routing path, no write/action capability. Builds the SAME grounding
  // bundle the PR-comment command builds (planNextWork, already exposed via /v1/agent/plan-next-work),
  // then hands it to the unmodified chat service unchanged.
  //
  // Per-command rate limiting reuses the EXACT SAME counter the PR-comment `@loopover chat` command uses
  // (COMMAND_RATE_LIMIT_EVENT_TYPE, keyed by actor+targetKey) rather than a second budget, so a
  // maintainer's dashboard questions and their own PR-comment usage on the same PR share one limit.
  app.post("/v1/repos/:owner/:repo/pulls/:number/chat-qa", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const gate = await requireRepoMaintainer(c, fullName);
    /* v8 ignore next -- auth middleware already 401s unauthenticated callers; requireRepoMaintainer Response arm is still type-required. */
    if (gate instanceof Response) return gate;
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number <= 0) return c.json({ error: "invalid_pull_number" }, 400);
    /* v8 ignore next 2 -- malformed JSON is covered by unit test; codecov still marks .catch patch-partial across shards. */
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: "invalid_chat_qa_request" }, 400);
    const parsed = chatQaRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_chat_qa_request", issues: parsed.error.issues }, 400);

    const [settings, pullRequest] = await Promise.all([resolveRepositorySettings(c.env, fullName), getPullRequest(c.env, fullName, number)]);
    if (!pullRequest) return c.json({ error: "pull_request_not_found" }, 404);

    // When chat Q&A is disabled for the repo, generateChatQaAnswer is guaranteed to return `disabled` -- but only
    // after this route has already spent a slot in the shared @loopover-chat rate-limit budget AND paid for the
    // planNextWork grounding bundle (#9714). Gate on the SAME predicate the maintainer dashboard reads
    // (isRepoChatQaEnabled at the capability map above), so the two can never disagree, and return
    // generateChatQaAnswer's own disabled result (bundle unused on that path) rather than a second copy of it.
    if (!isRepoChatQaEnabled(settings)) {
      return c.json(
        await generateChatQaAnswer(c.env, {
          bundle: null,
          question: parsed.data.question,
          advisoryAiRouting: settings.advisoryAiRouting,
          repoFullName: fullName,
          issueNumber: number,
          actor: resolveChatQaActor(gate.identity),
          route: "app.maintainer_dashboard.chat_qa",
        }),
      );
    }

    const actor = resolveChatQaActor(gate.identity);
    const targetKey = `${fullName}#${number}#chat`;
    const { policy, maxPerWindow, windowHours } = resolveChatQaRateLimit(settings);
    if (policy !== "off") {
      const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
      const priorInvocations = await countRecentAuditEventsForActorAndTarget(c.env, actor, COMMAND_RATE_LIMIT_EVENT_TYPE, targetKey, sinceIso);
      const invocationCount = priorInvocations + 1;
      // Always record the invocation first so the running count reflects reality even on the throttled
      // path below, mirroring maybeThrottleLoopOverCommand's own ordering (queue/processors.ts).
      await recordAuditEvent(c.env, {
        eventType: COMMAND_RATE_LIMIT_EVENT_TYPE,
        actor,
        targetKey,
        outcome: "completed",
        detail: `invocation ${invocationCount}/${maxPerWindow} within ${windowHours}h window`,
        metadata: { repoFullName: fullName, issueNumber: number, command: "chat", aiCostBearing: true, source: "dashboard" },
      });
      if (invocationCount > maxPerWindow) {
        return c.json({
          status: "rate_limited",
          reason: `The chat command has reached its rate limit (${maxPerWindow} within ${windowHours}h), shared with the @loopover chat PR-comment command. Please wait for the window to pass before trying again.`,
        });
      }
    }

    const bundle = await planNextWork(c.env, {
      login: resolveChatQaGroundingLogin(pullRequest.authorLogin, actor),
      repoFullName: fullName,
      surface: "api",
      objective: `Respond to @loopover chat for ${fullName}#${number}. Question: ${parsed.data.question.slice(0, 280)}`,
    });
    const result = await generateChatQaAnswer(c.env, {
      bundle,
      question: parsed.data.question,
      advisoryAiRouting: settings.advisoryAiRouting,
      repoFullName: fullName,
      issueNumber: number,
      actor,
      route: "app.maintainer_dashboard.chat_qa",
    });
    return c.json(result);
  });

  app.get("/v1/repos/:owner/:repo/pulls/:number/maintainer-packet", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    // #9045: repo-scoped — this route was the one sibling that never checked the MCP read allowlist.
    const unauthorized = await requireStaticProtectedApiToken(c, fullName);
    if (unauthorized) return unauthorized;
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number <= 0) return c.json({ error: "invalid_pull_number" }, 400);
    const [repo, pullRequest, issues, pullRequests, files, reviews, checks, recentMergedPullRequests] = await Promise.all([
      getRepository(c.env, fullName),
      getPullRequest(c.env, fullName, number),
      listIssues(c.env, fullName),
      listPullRequests(c.env, fullName),
      listPullRequestFiles(c.env, fullName, number),
      listPullRequestReviews(c.env, fullName, number),
      listCheckSummaries(c.env, fullName, number),
      listRecentMergedPullRequests(c.env, fullName),
    ]);
    return c.json(
      attachDataQuality(
        buildPullRequestMaintainerPacket({ repo, pullRequest, issues, pullRequests, files, reviews, checks, recentMergedPullRequests, repoFullName: fullName, pullNumber: number }) as unknown as Record<string, unknown>,
        await loadRepoDataQuality(c.env, fullName),
      ),
    );
  });

  app.get("/v1/repos/:owner/:repo/pulls/:number/reviewability", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const unauthorized = await requireStaticProtectedApiToken(c, fullName);
    if (unauthorized) return unauthorized;
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number <= 0) return c.json({ error: "invalid_pull_number" }, 400);
    const [repo, pullRequest, issues, pullRequests, files, reviews, checks, recentMergedPullRequests] = await Promise.all([
      getRepository(c.env, fullName),
      getPullRequest(c.env, fullName, number),
      listIssues(c.env, fullName),
      listPullRequests(c.env, fullName),
      listPullRequestFiles(c.env, fullName, number),
      listPullRequestReviews(c.env, fullName, number),
      listCheckSummaries(c.env, fullName, number),
      listRecentMergedPullRequests(c.env, fullName),
    ]);
    const contributor = pullRequest?.authorLogin;
    const contributorContext = contributor ? await loadContributorFastContext(c.env, contributor) : null;
    const reviewability = buildPullRequestReviewability({
      repo,
      pullRequest,
      issues,
      pullRequests,
      files,
      reviews,
      checks,
      recentMergedPullRequests,
      repoFullName: fullName,
      pullNumber: number,
      profile: contributorContext?.profile,
      outcomeHistory: contributorContext?.outcomeHistory,
    });
    await persistSignal(c.env, "pr-reviewability", `${fullName}#${number}`, fullName, reviewability as unknown as Record<string, JsonValue>, reviewability.generatedAt);
    return c.json(reviewability);
  });

  // A PR author's own structured, published AI-review findings (#6619). REST mirror of the
  // `loopover_get_pr_ai_review_findings` MCP tool so the local `@loopover/mcp` CLI can reach the same data the
  // remote MCP server already serves — the established pattern every comparable per-contributor, DB-backed tool
  // follows (decision-pack, repo-decision, reviewability). `loadPrAiReviewFindings` stays the single source of
  // truth for both surfaces; this route only validates, gates, and delegates. Contributor-owned data, so it is
  // gated by `requireContributorAccess` (the same guard the decision-pack route uses) BEFORE any data is read.
  app.get("/v1/repos/:owner/:repo/pulls/:number/ai-review-findings", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const number = Number(c.req.param("number"));
    if (!Number.isInteger(number) || number <= 0) return c.json({ error: "invalid_pull_number" }, 400);
    const login = c.req.query("login") ?? "";
    if (!login) return c.json({ error: "login_required" }, 400);
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    // requireContributorAccess only proves the caller IS `login`; it does not prove `login` authored this PR.
    // Mirror the MCP tool's guard order (server.ts getPrAiReviewFindings) so the REST surface can't leak another
    // contributor's AI-review findings: 404 when the PR doesn't exist, 403 when it exists but belongs to someone
    // else (#8659).
    const pullRequest = await getPullRequest(c.env, fullName, number);
    if (!pullRequest) return c.json({ error: "not_found" }, 404);
    try {
      assertContributorOwnsPullRequest(pullRequest.authorLogin, login);
    } catch {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json(await loadPrAiReviewFindings(c.env, { repoFullName: fullName, pullNumber: number, login }));
  });

  // Read-only view of a repo's CURRENT effective self-tuned gate thresholds (#6247, groundwork for #6209).
  // Returns only the resolved effective values from auto-apply.ts's live override — never the raw
  // override_audit history or the shadow's queued recommendation, just a flag that a shadow is soaking.
  // Gated behind the same most-conservative repo-scoped read precedent the reviewability route (#6154) uses.
  app.get("/v1/repos/:owner/:repo/gate-config/effective", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    // #9045: the MCP read-allowlist check now lives in requireStaticProtectedApiToken itself.
    const unauthorized = await requireStaticProtectedApiToken(c, fullName);
    if (unauthorized) return unauthorized;
    const storageEnv = c.env as unknown as StorageEnv;
    const [override, shadow] = await Promise.all([loadOverride(storageEnv, fullName), loadShadowOverride(storageEnv, fullName)]);
    return c.json({
      repoFullName: fullName,
      effective: {
        confidenceFloor: override?.confidenceFloor ?? null,
        scopeCap: {
          files: override?.scopeCap?.files ?? null,
          lines: override?.scopeCap?.lines ?? null,
        },
      },
      shadowPending: shadow !== null,
    });
  });

  // AMS probe surface for live gate thresholds (#6486 / #6209). Field-limited snake_case payload (no audit /
  // applied_at / clear_at). Live row wins; soaking shadow fills in only when live is absent. 404 when neither
  // is active — same not-found convention as issue-quality. Auth matches gate-config/effective above.
  app.get("/v1/repos/:owner/:repo/live-gate-thresholds", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    // #9045: the MCP read-allowlist check now lives in requireStaticProtectedApiToken itself.
    const unauthorized = await requireStaticProtectedApiToken(c, fullName);
    if (unauthorized) return unauthorized;
    const storageEnv = c.env as unknown as StorageEnv;
    const [live, shadow] = await Promise.all([loadOverride(storageEnv, fullName), loadShadowOverride(storageEnv, fullName)]);
    const fields = toLiveGateThresholdFields(authoritativeGateOverride(live, shadow));
    if (!fields) return c.json({ error: "live_gate_thresholds_not_found", repoFullName: fullName }, 404);
    return c.json({ repoFullName: fullName, ...fields });
  });

  app.get("/v1/repos/:owner/:repo/outcome-patterns", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const response = await buildRepoOutcomePatternsResponse(c.env, fullName);
    if (!response) return c.json({ error: "repo_outcome_patterns_not_found", repoFullName: fullName }, 404);
    return c.json(response);
  });

  app.get("/v1/contributors/:login/profile", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const [github, pullRequests, issues, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(login, c.env),
      listContributorPullRequests(c.env, login),
      listContributorIssues(c.env, login),
      listContributorRepoStats(c.env, login),
      fetchGittensorContributorSnapshot(login),
    ]);
    const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
    return c.json(buildContributorProfile(login, github, pullRequests, issues, repoStats, gittensorSnapshot));
  });

  app.get("/v1/contributors/:login/decision-pack", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const serving = await loadContributorDecisionPackForServing(c.env, login);
    if (serving.kind === "ready") return c.json(serving.pack);
    return c.json(serving.refresh, 202);
  });

  app.get("/v1/contributors/:login/open-pr-monitor", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    return c.json(await buildContributorOpenPrMonitor(c.env, login));
  });

  // #6747: REST mirror of loopover_pr_outcome — same requireContributorAccess gate + notification-delivery source.
  app.get("/v1/contributors/:login/pr-outcomes", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const limitParam = c.req.query("limit");
    let limit: number | undefined;
    if (limitParam !== undefined) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return c.json({ error: "invalid_limit", detail: "limit must be an integer between 1 and 100" }, 400);
      }
      limit = parsed;
    }
    return c.json(await buildContributorPrOutcomes(c.env, login, limit));
  });

  // REST mirror of the `loopover_list_notifications` MCP tool (LoopoverMcp.listNotifications) — a contributor's
  // own badge notification feed, self-scoped via requireContributorAccess. (#6745)
  app.get("/v1/contributors/:login/notifications", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const deliveries = await listNotificationDeliveriesForRecipient(c.env, login, { channel: "badge", limit: 50 });
    return c.json(buildNotificationFeed(login, deliveries));
  });

  // REST mirror of the `loopover_mark_notifications_read` MCP tool (LoopoverMcp.markNotificationsRead) — marks the
  // contributor's own delivered badge notifications read; an absent/empty body marks all of them. (#6745)
  app.post("/v1/contributors/:login/notifications/read", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const parsed = markNotificationsReadBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_mark_read", issues: parsed.error.issues }, 400);
    const marked = await markNotificationDeliveriesRead(c.env, login, parsed.data.ids);
    return c.json({ login: login.toLowerCase(), marked });
  });

  // #7657: AMS miner (or any self-scoped session) posts AMS-relevant notification events. Events are forced onto
  // the path login and evaluated through evaluateAndEnqueueNotificationDeliveries — the same
  // evaluateNotificationEvent → notify-deliver handoff job-dispatch.ts uses for webhook kinds.
  app.post("/v1/contributors/:login/ams-notifications", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const parsed = amsNotificationsBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_ams_notifications", issues: parsed.error.issues }, 400);
    const events = parsed.data.events
      .map((raw) => normalizeAmsNotificationEventInput(raw, login))
      .filter((event): event is NonNullable<typeof event> => event !== null);
    if (events.length === 0) return c.json({ error: "invalid_ams_notifications", detail: "no_valid_events" }, 400);
    const deliveries = await evaluateAndEnqueueNotificationDeliveries(c.env, events);
    return c.json({
      login: login.toLowerCase(),
      accepted: events.length,
      enqueued: deliveries.length,
    });
  });

  // #6746: REST mirror of the `loopover_watch_issues` MCP tool (LoopoverMcp.watchIssues) — manage a contributor's
  // own issue-watch subscriptions. The MCP tool's `action` enum splits across the HTTP verbs: GET=list, POST=watch,
  // DELETE=unwatch. Every verb is self-scoped via requireContributorAccess (a session may only touch its own
  // login), and the mutating verbs reuse canWatchRepo — the same gate requireWatchableRepo applies in the MCP tool.
  const listWatches = async (env: Env, login: string) =>
    (await listIssueWatchSubscriptionsForLogin(env, login)).map((sub) => ({ repoFullName: sub.repoFullName, labels: sub.labels }));

  app.get("/v1/contributors/:login/watches", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    return c.json({ watching: await listWatches(c.env, login) });
  });

  app.post("/v1/contributors/:login/watches", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const parsed = watchSubscriptionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_watch_request", issues: parsed.error.issues }, 400);
    if (!(await canWatchRepo(c.env, login, parsed.data.repoFullName))) return c.json({ error: "forbidden_repo" }, 403);
    await upsertIssueWatchSubscription(c.env, { login, repoFullName: parsed.data.repoFullName, labels: parsed.data.labels });
    const labelSuffix = parsed.data.labels && parsed.data.labels.length > 0 ? ` (labels: ${parsed.data.labels.join(", ")})` : "";
    return c.json({ watching: await listWatches(c.env, login), changed: `watching ${parsed.data.repoFullName}${labelSuffix}` });
  });

  app.delete("/v1/contributors/:login/watches", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const parsed = watchSubscriptionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_watch_request", issues: parsed.error.issues }, 400);
    if (!(await canWatchRepo(c.env, login, parsed.data.repoFullName))) return c.json({ error: "forbidden_repo" }, 403);
    const removed = await deleteIssueWatchSubscription(c.env, login, parsed.data.repoFullName);
    const changed = removed ? `unwatched ${parsed.data.repoFullName}` : `was not watching ${parsed.data.repoFullName}`;
    return c.json({ watching: await listWatches(c.env, login), changed });
  });

  app.get("/v1/contributors/:login/repos/:owner/:repo/decision", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const serving = await loadContributorDecisionPackForServing(c.env, login);
    if (serving.kind === "needs_refresh") {
      return c.json({ ...serving.refresh, repoFullName: fullName }, 202);
    }
    const pack = serving.pack;
    const decision = repoDecisionFromPack(pack, fullName);
    if (!decision) return c.json({ error: "repo_decision_not_found", login, repoFullName: fullName }, 404);
    return c.json({
      status: "ready",
      login,
      repoFullName: fullName,
      generatedAt: pack.generatedAt,
      source: pack.source,
      freshness: pack.freshness,
      rebuildEnqueued: pack.rebuildEnqueued,
      decision,
      dataQuality: pack.dataQuality,
    });
  });

  app.post("/v1/lint/pr-text", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = lintPrTextSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_lint_pr_text_request", issues: parsed.error.issues }, 400);
    return c.json(buildPrTextLint(parsed.data));
  });

  app.post("/v1/validate/focus-manifest", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = validateFocusManifestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_validate_focus_manifest_request", issues: parsed.error.issues }, 400);
    return c.json(buildFocusManifestValidation(parsed.data));
  });

  // Agent-native slop self-checks (#530/#533): pure local-metadata, mirroring the MCP tools of the same name.
  app.post("/v1/lint/slop-risk", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = slopRiskSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_slop_risk_request", issues: parsed.error.issues }, 400);
    // #6990: return band + findings only — withhold the numeric score and rubric thresholds exactly as the
    // loopover_check_slop_risk MCP tool blunts them, so the REST surface can't reverse-engineer the weights.
    const assessment = buildSlopAssessment(parsed.data);
    return c.json({ band: assessment.band, findings: assessment.findings });
  });

  // #6748: REST mirror of the loopover_check_improvement_potential MCP tool, bringing it to the same parity its
  // same-tier sibling /v1/lint/slop-risk (directly above) already has. Both are pure, source-free evaluators over
  // caller-supplied local-diff metadata, so this route delegates to the same buildStructuralImprovementAssessment
  // the tool calls and adds no logic of its own. Advisory-only — improvementScore never gates.
  app.post("/v1/lint/improvement-potential", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = improvementPotentialSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_improvement_potential_request", issues: parsed.error.issues }, 400);
    return c.json(buildStructuralImprovementAssessment(parsed.data));
  });

  // #6751: REST mirror of the loopover_simulate_open_pr_pressure MCP tool — deterministic, public-safe, and
  // read-only (no repo access, no GitHub writes), the same tier as the lint routes it sits with. Parses with the
  // tool's OWN exported simulateOpenPrPressureShape so the two surfaces cannot diverge on accepted input, then
  // delegates to the same pure simulateOpenPrPressure. No logic of its own.
  app.post("/v1/lint/open-pr-pressure", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = simulateOpenPrPressureSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_open_pr_pressure_request", issues: parsed.error.issues }, 400);
    return c.json(simulateOpenPrPressure(parsed.data as unknown as OpenPrPressureInput));
  });

  // #6750: REST mirror of the loopover_suggest_boundary_tests MCP tool, bringing it to the same parity its
  // same-tier advisory-lint sibling /v1/lint/slop-risk (directly above) already has. Reproduces the tool's
  // handler exactly: keep only touches whose path is actually in the changed set, build the finding, and build
  // the spec only when the finding fired. Advisory-only -- never blocks, never writes, and returns criteria/
  // hints only (never generated test code), so the review/execution boundary stays intact.
  app.post("/v1/lint/boundary-tests", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = boundaryTestsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_boundary_tests_request", issues: parsed.error.issues }, 400);
    const changedPaths = new Set(parsed.data.changedFiles.map((file) => file.path));
    const touches = (parsed.data.boundaryTouches ?? []).filter((touch) => changedPaths.has(touch.path));
    const finding = buildBoundaryTestGenerationFinding({ touches, tests: parsed.data.tests, testFiles: parsed.data.testFiles });
    return c.json({ finding, spec: finding ? buildBoundaryTestGenerationSpec(touches) : null });
  });

  // #6749: REST mirror of the loopover_check_test_evidence MCP tool, bringing it to the same parity its
  // same-tier deterministic-lint sibling /v1/lint/slop-risk (directly above) already has. Delegates to the
  // engine's buildTestEvidenceReport -- the same function the MCP tool and the CLI mirror call.
  app.post("/v1/lint/test-evidence", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = testEvidenceSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_test_evidence_request", issues: parsed.error.issues }, 400);
    return c.json(buildTestEvidenceReport(parsed.data));
  });

  // #6754: REST mirror of the loopover_evaluate_escalation MCP tool, bringing it to the same REST/CLI parity
  // its same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk, directly above) already has. Both are
  // pure, source-free evaluators over caller-supplied data, so this route delegates to the same
  // `evaluateEscalation` the tool calls and adds no logic of its own -- it decides; the caller wires the action.
  app.post("/v1/loop/evaluate-escalation", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = evaluateEscalationSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_evaluate_escalation_request", issues: parsed.error.issues }, 400);
    return c.json(evaluateEscalation(parsed.data));
  });

  // #7742: customer-facing "request transfer" for an APR repo. Request-only (nothing auto-offers). Completion is
  // resolved SERVER-SIDE by requestAprRepoTransfer → loadAprIdeaCompletion (fail-closed until #7591/#7664 persist
  // a record) — the body must NOT carry ideaComplete (`.strict()` schema rejects smuggling attempts; that was
  // the #8000 Superagent P1). Rejected gate → 409 without touching GitHub; initiation is still pending-acceptance
  // (202), never "transfer done".
  app.post("/v1/loop/request-apr-transfer", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = requestAprTransferSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_request_apr_transfer_request", issues: parsed.error.issues }, 400);
    const result = await requestAprRepoTransfer(c.env, parsed.data);
    if (result.status === "rejected") return c.json(result, 409);
    if (result.status === "failed") return c.json(result, 502);
    return c.json(result, 202);
  });

  // #6752: REST mirror of the loopover_build_results_payload MCP tool, bringing it to the same REST/CLI parity
  // its same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. Both are pure, source-free
  // composers over caller-supplied, already-computed iteration metadata, so this route delegates to the same
  // buildResultsPayload the tool calls and adds no logic of its own -- it formats the result, it does not fetch,
  // open, or deliver anything.
  app.post("/v1/loop/results-payload", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = resultsPayloadSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_results_payload_request", issues: parsed.error.issues }, 400);
    return c.json(buildResultsPayload(parsed.data));
  });

  // #6753: REST mirror of the loopover_build_progress_snapshot MCP tool, bringing it to the same REST/CLI parity
  // its same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. Both are pure, source-free
  // composers over caller-supplied, already-computed loop state, so this route delegates to the same
  // buildProgressSnapshot the tool calls and adds no logic of its own -- it formats the snapshot, it does not
  // fetch or stream anything.
  app.post("/v1/loop/progress-snapshot", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = progressSnapshotSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_progress_snapshot_request", issues: parsed.error.issues }, 400);
    return c.json(buildProgressSnapshot(parsed.data));
  });

  // #6755: REST mirror of the loopover_intake_idea MCP tool, bringing it to the same REST/CLI parity its
  // same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. Reproduces the tool's handler
  // exactly -- validate, then assemble the task-graph from the optional caller-supplied decomposition (else the
  // single-issue baseline) -- delegating to the same pure functions and adding no logic of its own. A malformed
  // or empty submission returns the engine's actionable error list (mirroring the find-opportunities route's
  // semantic-validation shape: the payload, with 400), never a silent failure.
  app.post("/v1/loop/intake-idea", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = intakeIdeaSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_intake_idea_request", issues: parsed.error.issues }, 400);
    const validated = validateIdeaSubmission(parsed.data);
    if (!validated.ok) return c.json({ ok: false, errors: validated.errors }, 400);
    const taskGraph = buildTaskGraph(validated.idea, parsed.data.decomposition);
    return c.json({ ok: true, verdict: taskGraph.rubric.verdict, taskGraph });
  });

  // #6756: REST mirror of the loopover_plan_idea_claims MCP tool, bringing it to the same REST/CLI parity its
  // same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. Reproduces the tool's handler
  // exactly -- validate, assemble the task-graph, then disposition it via buildClaimPlan -- delegating to the
  // same pure functions and adding no logic of its own. A malformed or empty submission returns the engine's
  // actionable error list (same shape as /v1/loop/intake-idea: the payload, with 400), never a silent failure.
  app.post("/v1/loop/plan-idea-claims", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = intakeIdeaSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_plan_idea_claims_request", issues: parsed.error.issues }, 400);
    const validated = validateIdeaSubmission(parsed.data);
    if (!validated.ok) return c.json({ ok: false, errors: validated.errors }, 400);
    const graph = buildTaskGraph(validated.idea, parsed.data.decomposition);
    const claimPlan = buildClaimPlan(graph, validated.idea.targetRepo);
    return c.json({ ok: true, verdict: claimPlan.graphVerdict, claimPlan });
  });

  app.post("/v1/lint/issue-slop", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = issueSlopSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_issue_slop_request", issues: parsed.error.issues }, 400);
    // #6990: band + findings only — same blunting as the loopover_check_issue_slop MCP tool (no score/rubric).
    const assessment = buildIssueSlopAssessment(parsed.data);
    return c.json({ band: assessment.band, findings: assessment.findings });
  });

  app.post(OPPORTUNITIES_FIND_PATH, async (c) => {
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before route-specific guards. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    // #10040: same zod object the OpenAPI document publishes — refuse before the hand-rolled
    // cross-field / normalisation pass, and keep the existing invalid_request body shape.
    const schemaParsed = FindOpportunitiesRequestSchema.safeParse(body ?? {});
    if (!schemaParsed.success) {
      return c.json({ status: "invalid_request", ranked: [], totalCandidates: 0, reason: "invalid_body" }, 400);
    }
    const parsed = validateFindOpportunitiesInput(schemaParsed.data as FindOpportunitiesInput);
    if (!parsed.ok) {
      return c.json({ status: "invalid_request", ranked: [], totalCandidates: 0, reason: parsed.reason }, 400);
    }
    if (parsed.value.searchQuery) {
      const forbidden = await requireDiscoveryAccessForApi(c, identity);
      if (forbidden) return forbidden;
    } else {
      for (const target of parsed.value.targets ?? []) {
        const fullName = `${target.owner}/${target.repo}`;
        const forbidden = await requireApiRepoReadAccess(c, identity, fullName);
        if (forbidden) return forbidden;
      }
    }
    const result = await runFindOpportunities(c.env, parsed.value, {
      canAccessRepo: (repoFullName) => canApiAccessRepo(c.env, identity, repoFullName),
    });
    return c.json(result);
  });

  app.post(ISSUE_RAG_RETRIEVE_PATH, async (c) => {
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before route-specific guards. */
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    // #10040: same zod object the OpenAPI document publishes — refuse before the hand-rolled pass.
    const schemaParsed = IssueRagRetrieveRequestSchema.safeParse(body ?? {});
    if (!schemaParsed.success) {
      return c.json(
        { status: "invalid_request", repoFullName: "", reason: "invalid_body", telemetry: { attempted: false, injected: false, retrievedPaths: [] } },
        400,
      );
    }
    const parsed = validateIssueRagInput(schemaParsed.data as IssueRagInput);
    if (!parsed.ok) {
      return c.json({ status: "invalid_request", repoFullName: "", reason: parsed.reason, telemetry: { attempted: false, injected: false, retrievedPaths: [] } }, 400);
    }
    const forbidden = await requireApiRepoReadAccess(c, identity, parsed.value.repoFullName);
    if (forbidden) return forbidden;
    const result = await runIssueRagRetrieval(c.env, parsed.value);
    return c.json(result);
  });

  app.post("/v1/preflight/pr", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = preflightSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_preflight_request", issues: parsed.error.issues }, 400);
    const [repo, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      getRepository(c.env, parsed.data.repoFullName),
      listIssues(c.env, parsed.data.repoFullName),
      listPullRequests(c.env, parsed.data.repoFullName),
      listBountiesByRepo(c.env, parsed.data.repoFullName),
      loadOrComputeIssueQualityResponse(c.env, parsed.data.repoFullName),
    ]);
    return c.json(buildPreflightResult(parsed.data, repo, issues, pullRequests, bounties, issueQuality?.report));
  });

  // #6980: REST mirror of loopover_explain_review_risk — same preflightSchema as /v1/preflight/pr, richer
  // payload (preflight + optional roleContext + recommendation + summary). Does NOT pass issueQuality.
  app.post("/v1/preflight/review-risk", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = preflightSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_preflight_request", issues: parsed.error.issues }, 400);
    if (parsed.data.contributorLogin) {
      const unauthorized = await requireContributorAccess(c, parsed.data.contributorLogin);
      if (unauthorized) return unauthorized;
    }
    const [repo, issues, pullRequests, bounties] = await Promise.all([
      getRepository(c.env, parsed.data.repoFullName),
      listIssues(c.env, parsed.data.repoFullName),
      listPullRequests(c.env, parsed.data.repoFullName),
      listBountiesByRepo(c.env, parsed.data.repoFullName),
    ]);
    return c.json(buildReviewRiskExplanation({ input: parsed.data, repo, issues, pullRequests, bounties }));
  });

  app.post("/v1/preflight/local-diff", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = localDiffPreflightSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_local_diff_preflight_request", issues: parsed.error.issues }, 400);
    const [repo, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      getRepository(c.env, parsed.data.repoFullName),
      listIssues(c.env, parsed.data.repoFullName),
      listPullRequests(c.env, parsed.data.repoFullName),
      listBountiesByRepo(c.env, parsed.data.repoFullName),
      loadOrComputeIssueQualityResponse(c.env, parsed.data.repoFullName),
    ]);
    return c.json(buildLocalDiffPreflightResult(parsed.data, repo, issues, pullRequests, bounties, issueQuality?.report));
  });

  app.post("/v1/local/branch-analysis", async (c) => {
    const contentLength = parsePositiveInt(c.req.header("content-length"));
    if (contentLength !== null && contentLength > LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES) {
      return c.json({ error: "payload_too_large", maxBytes: LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES }, 413);
    }
    const rawBody = await readRequestBodyWithLimit(c.req.raw, LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES);
    if (rawBody === null) return c.json({ error: "payload_too_large", maxBytes: LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES }, 413);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
    const parsed = localBranchAnalysisSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_local_branch_analysis_request", issues: parsed.error.issues }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.login);
    if (unauthorized) return unauthorized;
    const [context, repo, issues, pullRequests, recentMergedPullRequests, bounties, snapshot, issueQuality, repoManifest] = await Promise.all([
      loadContributorFastContext(c.env, parsed.data.login),
      getRepository(c.env, parsed.data.repoFullName),
      listIssues(c.env, parsed.data.repoFullName),
      listPullRequests(c.env, parsed.data.repoFullName),
      listRecentMergedPullRequests(c.env, parsed.data.repoFullName),
      listBountiesByRepo(c.env, parsed.data.repoFullName),
      getOrCreateScoringModelSnapshot(c.env),
      loadOrComputeIssueQualityResponse(c.env, parsed.data.repoFullName),
      loadPublicRepoFocusManifest(c.env, parsed.data.repoFullName),
    ]);
    const fit = buildContributorFit(context.profile, context.repositories, [], [], context.syncStates, context.repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: parsed.data.login, fit, scoringSnapshot: snapshot });
    const checkSummaries = await loadCheckSummariesForPullRequests(c.env, parsed.data.repoFullName, parsed.data, pullRequests);
    // Caller-supplied focusManifest wins; otherwise fall back to the repo-owned manifest when present.
    const analysisInput = parsed.data.focusManifest !== undefined || !repoManifest.present
      ? parsed.data
      : { ...parsed.data, focusManifest: repoManifest as unknown };
    const analysis = buildLocalBranchAnalysis({
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
    });
    // Pre-submission gate prediction: the SAME advisory + evaluateGateCheck the maintainer PR pipeline
    // runs, over a synthetic PR from this local branch, using ONLY the repo's PUBLIC .loopover.yml gate
    // policy (never the maintainer's private DB settings). Self-scoped (requireContributorAccess above).
    // #2349: this login's own predict-vs-real track record, personalizing ONLY the returned readinessScore
    // (see buildPredictedGateVerdict's contributorCalibration doc comment for the safety boundary).
    const contributorCalibration = await computeContributorCalibration(c.env, parsed.data.login);
    const predictedGate = buildPredictedGateVerdict({
      input: {
        repoFullName: parsed.data.repoFullName,
        contributorLogin: parsed.data.login,
        title: parsed.data.title ?? analysis.prPacket.titleSuggestion,
        body: parsed.data.body,
        labels: parsed.data.labels,
        linkedIssues: parsed.data.linkedIssues,
      },
      manifest: repoManifest,
      repo,
      issues,
      pullRequests,
      bounties,
      issueQuality: issueQuality?.report,
      confirmedContributor: Boolean(context.gittensorSnapshot),
      // #11-13/#18: thread the local branch's changed PATHS (already in the request) so the predictor also
      // evaluates the focus-manifest path policy + path-gated pre-merge checks, matching the live gate.
      ...(parsed.data.changedFiles ? { changedPaths: parsed.data.changedFiles.map((file) => file.path) } : {}),
      contributorCalibration,
    });
    const response = { ...analysis, predictedGate, dataQuality: await loadRepoDataQuality(c.env, parsed.data.repoFullName) };
    await persistSignal(c.env, "local-branch-analysis", `${parsed.data.login}:${parsed.data.repoFullName}:${parsed.data.branchName ?? parsed.data.headRef ?? "local"}`, parsed.data.repoFullName, response as unknown as Record<string, JsonValue>, analysis.generatedAt);
    await recordRouteProductUsage(c, {
      surface: "api",
      eventName: "local_branch_analysis_completed",
      actor: parsed.data.login,
      repoFullName: parsed.data.repoFullName,
      targetKey: `${parsed.data.login}:${parsed.data.repoFullName}:${parsed.data.branchName ?? parsed.data.headRef ?? "local"}`,
      outcome: "success",
      metadata: { hasLocalScorer: Boolean(parsed.data.localScorer), changedFileCount: parsed.data.changedFiles?.length ?? 0, linkedIssueCount: parsed.data.linkedIssues?.length ?? 0 },
    });
    return c.json(response);
  });

  app.post("/v1/local/remediation-plan", async (c) => {
    const contentLength = parsePositiveInt(c.req.header("content-length"));
    if (contentLength !== null && contentLength > LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES) {
      return c.json({ error: "payload_too_large", maxBytes: LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES }, 413);
    }
    const rawBody = await readRequestBodyWithLimit(c.req.raw, LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES);
    if (rawBody === null) return c.json({ error: "payload_too_large", maxBytes: LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES }, 413);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
    const parsed = localBranchAnalysisSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_local_branch_analysis_request", issues: parsed.error.issues }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.login);
    if (unauthorized) return unauthorized;
    const [context, repo, issues, pullRequests, recentMergedPullRequests, bounties, snapshot, issueQuality, repoManifest] = await Promise.all([
      loadContributorFastContext(c.env, parsed.data.login),
      getRepository(c.env, parsed.data.repoFullName),
      listIssues(c.env, parsed.data.repoFullName),
      listPullRequests(c.env, parsed.data.repoFullName),
      listRecentMergedPullRequests(c.env, parsed.data.repoFullName),
      listBountiesByRepo(c.env, parsed.data.repoFullName),
      getOrCreateScoringModelSnapshot(c.env),
      loadOrComputeIssueQualityResponse(c.env, parsed.data.repoFullName),
      loadPublicRepoFocusManifest(c.env, parsed.data.repoFullName),
    ]);
    const fit = buildContributorFit(context.profile, context.repositories, [], [], context.syncStates, context.repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: parsed.data.login, fit, scoringSnapshot: snapshot });
    const checkSummaries = await loadCheckSummariesForPullRequests(c.env, parsed.data.repoFullName, parsed.data, pullRequests);
    const analysisInput = parsed.data.focusManifest !== undefined || !repoManifest.present
      ? parsed.data
      : { ...parsed.data, focusManifest: repoManifest as unknown };
    const analysis = buildLocalBranchAnalysis({
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
    });
    return c.json(
      buildRemediationPlan({
        login: analysis.login,
        repoFullName: analysis.repoFullName,
        branchQualityBlockers: analysis.branchQualityBlockers,
        accountStateBlockers: analysis.accountStateBlockers,
        scoreBlockers: analysis.scoreBlockers,
        recommendedRerunCondition: analysis.recommendedRerunCondition,
        localFindings: analysis.localFindings,
      }),
    );
  });

  app.post("/v1/agent/runs", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = agentRunSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_agent_run_request", issues: parsed.error.issues }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.actorLogin);
    if (unauthorized) return unauthorized;
    const bundle = await startAgentRun(c.env, parsed.data);
    await recordRouteProductUsage(c, {
      surface: "api",
      eventName: "agent_run_started",
      actor: parsed.data.actorLogin,
      repoFullName: parsed.data.target?.repoFullName,
      targetKey: parsed.data.target?.repoFullName
        ? `${parsed.data.target.repoFullName}${parsed.data.target.pullNumber ? `#${parsed.data.target.pullNumber}` : parsed.data.target.issueNumber ? `#${parsed.data.target.issueNumber}` : ""}`
        : undefined,
      outcome: "queued",
      metadata: { surface: parsed.data.surface ?? "api", status: bundle.run.status },
    });
    return c.json(bundle, 202);
  });

  app.get("/v1/agent/runs", async (c) => {
    const actorLogin = c.req.query("actorLogin") ?? "";
    if (!actorLogin) return c.json({ error: "actor_login_required" }, 400);
    const unauthorized = await requireContributorAccess(c, actorLogin);
    if (unauthorized) return unauthorized;
    const rawLimit = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
    const runs = await listAgentRunsForActor(c.env, actorLogin, limit);
    const bundles = await Promise.all(runs.map((run) => getAgentRunBundle(c.env, run.id)));
    return c.json({ runs: bundles.filter((bundle): bundle is NonNullable<typeof bundle> => Boolean(bundle)) });
  });

  app.get("/v1/agent/runs/:id", async (c) => {
    const bundle = await getAgentRunBundle(c.env, c.req.param("id"));
    if (!bundle) return c.json({ error: "agent_run_not_found" }, 404);
    const unauthorized = await requireContributorAccess(c, bundle.run.actorLogin);
    if (unauthorized) return unauthorized;
    return c.json(bundle);
  });

  app.post("/v1/agent/plan-next-work", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = agentPlanSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_agent_plan_request", issues: parsed.error.issues }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.login);
    if (unauthorized) return unauthorized;
    const bundle = await planNextWork(c.env, parsed.data);
    await recordRouteProductUsage(c, {
      surface: "api",
      eventName: "agent_plan_next_work_completed",
      actor: parsed.data.login,
      repoFullName: parsed.data.repoFullName,
      targetKey: parsed.data.repoFullName,
      outcome: bundle.run.status === "needs_snapshot_refresh" ? "queued" : "success",
      metadata: { requestedSurface: parsed.data.surface ?? "api", status: bundle.run.status },
    });
    return c.json(bundle, bundle.run.status === "needs_snapshot_refresh" ? 202 : 200);
  });

  app.post("/v1/agent/preflight-branch", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = localBranchAnalysisSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_agent_preflight_branch_request", issues: parsed.error.issues }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.login);
    if (unauthorized) return unauthorized;
    const bundle = await preflightBranchWithAgent(c.env, parsed.data);
    await recordRouteProductUsage(c, {
      surface: "api",
      eventName: "agent_preflight_branch_completed",
      actor: parsed.data.login,
      repoFullName: parsed.data.repoFullName,
      targetKey: `${parsed.data.login}:${parsed.data.repoFullName}:${parsed.data.branchName ?? parsed.data.headRef ?? "local"}`,
      outcome: bundle.run.status === "needs_snapshot_refresh" ? "queued" : "success",
      metadata: { status: bundle.run.status },
    });
    return c.json(bundle);
  });

  app.post("/v1/agent/prepare-pr-packet", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = localBranchAnalysisSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_agent_prepare_pr_packet_request", issues: parsed.error.issues }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.login);
    if (unauthorized) return unauthorized;
    const bundle = await preparePrPacketWithAgent(c.env, parsed.data);
    await recordRouteProductUsage(c, {
      surface: "api",
      eventName: "agent_pr_packet_completed",
      actor: parsed.data.login,
      repoFullName: parsed.data.repoFullName,
      targetKey: `${parsed.data.login}:${parsed.data.repoFullName}:${parsed.data.branchName ?? parsed.data.headRef ?? "local"}`,
      outcome: bundle.run.status === "needs_snapshot_refresh" ? "queued" : "success",
      metadata: { status: bundle.run.status },
    });
    return c.json(bundle);
  });

  app.post("/v1/agent/explain-blockers", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = agentExplainBlockersSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_agent_explain_blockers_request", issues: parsed.error.issues }, 400);
    const unauthorized = await requireContributorAccess(c, parsed.data.login);
    if (unauthorized) return unauthorized;
    const bundle = await explainBlockersWithAgent(c.env, parsed.data);
    await recordRouteProductUsage(c, {
      surface: "api",
      eventName: "agent_blockers_completed",
      actor: parsed.data.login,
      repoFullName: "repoFullName" in parsed.data ? parsed.data.repoFullName : undefined,
      targetKey: "repoFullName" in parsed.data ? parsed.data.repoFullName : undefined,
      outcome: bundle.run.status === "needs_snapshot_refresh" ? "queued" : "success",
      metadata: { requestedSurface: "surface" in parsed.data ? (parsed.data.surface ?? "api") : "api", status: bundle.run.status },
    });
    return c.json(bundle, bundle.run.status === "needs_snapshot_refresh" ? 202 : 200);
  });

  app.get("/v1/bounties", async (c) => c.json(await listBounties(c.env)));

  app.get("/v1/bounties/:id/advisory", async (c) => {
    const bounty = await getBounty(c.env, c.req.param("id"));
    if (!bounty) return c.json({ error: "bounty_not_found" }, 404);
    const [repo, issue, pullRequests] = await Promise.all([
      getRepository(c.env, bounty.repoFullName),
      getIssue(c.env, bounty.repoFullName, bounty.issueNumber),
      listPullRequests(c.env, bounty.repoFullName),
    ]);
    return c.json(buildBountyAdvisory(bounty, repo, issue, pullRequests));
  });

  app.get("/v1/bounties/:id/lifecycle", async (c) => {
    const id = c.req.param("id");
    const bounty = await getBounty(c.env, id);
    if (!bounty) return c.json({ error: "bounty_not_found" }, 404);
    return c.json({ bountyId: id, events: await listBountyLifecycleEvents(c.env, id) });
  });

  app.post("/v1/github/webhook", handleGitHubWebhook);

  // Brokered self-host relay RECEIVER (#1255) — the central Orb forwards this container's repos' events here,
  // HMAC-signed with the container's enrollment secret. Verified against ORB_ENROLLMENT_SECRET, then enqueued
  // like a GitHub webhook. Auth IS the relay signature (token-exempt); 404 when not a brokered self-host.
  app.post("/v1/orb/relay", handleOrbRelay);

  // LoopOver Orb central GitHub App (#1255) — inbound webhook for the ONE shared Orb App maintainers install.
  // Verifies the Orb App's OWN webhook secret, dedups, and records install + PR/review events (the homepage
  // fleet-metrics data spine). Separate App + secret from the review-app /v1/github/webhook above.
  app.post("/v1/orb/webhook", handleOrbWebhook);
  // Post-install / OAuth landing — the App's Callback URL. Token-exempt; GitHub drives the redirect after a
  // maintainer installs or updates the Orb App. Lands on a real page instead of a 401.
  app.get("/v1/orb/oauth/callback", handleOrbOAuthCallback);
  // Token-broker exchange: a self-hosted container presents its enrollment secret (Bearer) → a short-lived
  // GitHub installation token for the BOUND install. Token-exempt (the enrollment secret IS the auth); flag-gated
  // (404 until ORB_BROKER_ENABLED); the installation_id is read server-side from the enrollment, never the request.
  app.post("/v1/orb/token", async (c) => {
    if (!isOrbBrokerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const auth = c.req.header("authorization") ?? "";
    const secret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!secret) return c.json({ error: "missing_enrollment_secret" }, 401);
    const rawBody = await readOrbRelayRegisterBody(c.req.raw, c.req.header("content-length"));
    if (rawBody === null) return c.json({ error: "payload_too_large", maxBytes: MAX_ORB_RELAY_REGISTER_BODY_BYTES }, 413);
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        body = null;
      }
    }
    const forceRefresh = typeof body === "object" && body !== null && (body as { forceRefresh?: unknown }).forceRefresh === true;
    let result: Awaited<ReturnType<typeof brokerOrbToken>>;
    try {
      result = await brokerOrbToken(c.env, secret, { forceRefresh });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", event: "orb_broker_mint_failed", message: message.slice(0, 200) }));
      return c.json({ error: "broker_error" }, 503);
    }
    if ("error" in result)
      return c.json(result, result.error === "invalid_enrollment" ? 401 : result.error === "broker_misconfigured" ? 503 : result.error === "unsupported_secret_type" ? 500 : 403);
    return c.json(result);
  });

  // Orb event relay (#1255) — a brokered self-host registers its public relay URL so the Orb can forward its
  // repos' events to it. Auth: the container's own enrollment secret (Bearer). Flag-gated (404 until enabled).
  app.post("/v1/orb/relay/register", async (c) => {
    if (!isOrbBrokerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const auth = c.req.header("authorization") ?? "";
    const secret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!secret) return c.json({ error: "missing_enrollment_secret" }, 401);
    // #4995: validateOrbRelayEnrollment/registerValidatedOrbRelay both touch the DB directly (no error handling
    // of their own) — an unhandled D1/Postgres error here previously escaped as a bare framework 500 instead of
    // a clean 503, the same class of gap #orb-broker-500 already fixed for /v1/orb/token's own DB-touching call.
    // `.catch(...)` on just the two DB-touching calls (rather than wrapping the whole handler in try/catch) so a
    // genuine broker_error is reported without disturbing every other line's indentation/coverage.
    const dbBrokerError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", event: "orb_relay_register_failed", message: message.slice(0, 200) }));
      return null;
    };
    const enrollment = await validateOrbRelayEnrollment(c.env, secret).catch(dbBrokerError);
    if (enrollment === null) return c.json({ error: "broker_error" }, 503);
    if ("error" in enrollment) return c.json(enrollment, enrollment.error === "invalid_enrollment" ? 401 : 403);
    const rawBody = await readOrbRelayRegisterBody(c.req.raw, c.req.header("content-length"));
    if (rawBody === null) return c.json({ error: "payload_too_large" }, 413);
    let body: { relayUrl?: unknown; mode?: unknown } | null;
    try {
      body = JSON.parse(rawBody) as { relayUrl?: unknown; mode?: unknown };
    } catch {
      body = null;
    }
    // Pull mode (#16): a tailnet container registers to PULL events (no relay_url to push to). Default 'push'.
    const mode = body?.mode === "pull" ? "pull" : body?.mode === "push" || body?.mode === undefined ? "push" : null;
    if (mode === null) return c.json({ error: "invalid_mode" }, 400);
    const relayUrl = typeof body?.relayUrl === "string" ? body.relayUrl.trim() : "";
    if (mode === "push" && !relayUrl) return c.json({ error: "missing_relay_url" }, 400);
    const result = await registerValidatedOrbRelay(c.env, enrollment, secret, relayUrl, mode).catch(dbBrokerError);
    if (result === null) return c.json({ error: "broker_error" }, 503);
    if ("error" in result) {
      const status = result.error === "invalid_enrollment" ? 401 : result.error === "installation_not_eligible" ? 403 : result.error === "encryption_unavailable" ? 500 : 400;
      return c.json(result, status);
    }
    return c.json(result);
  });

  // Pull-mode relay drain (#16) — a brokered self-host behind NAT/tailnet can't be PUSHED events, so it PULLS its
  // queued events here (the engine drives this outbound). Auth: the container's own enrollment secret (Bearer).
  // Body (optional) `{ ack: string[] }` acks the delivery_ids it durably accepted on its previous pull (deleted
  // before the next batch is returned). Flag-gated (404 until enabled).
  app.post("/v1/orb/relay/pull", async (c) => {
    if (!isOrbBrokerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const auth = c.req.header("authorization") ?? "";
    const secret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!secret) return c.json({ error: "missing_enrollment_secret" }, 401);
    // #4995 (GITTENSORY-1C, orb_relay_drain_http_500): validateOrbRelayEnrollment/pullRelayPending both touch
    // the DB directly (prune/delete/select, no error handling of their own) — an unhandled D1/Postgres error
    // here previously escaped as a bare framework 500, which is exactly what the drain client saw repeatedly in
    // production. The drain client's own in-flight guard and matched poll/request timeout (src/server.ts) were
    // already correct; the gap was entirely server-side. Same `.catch(...)`-on-the-DB-call shape as the sibling
    // /v1/orb/relay/register fix above, for the same reason.
    const dbBrokerError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", event: "orb_relay_pull_failed", message: message.slice(0, 200) }));
      return null;
    };
    const enrollment = await validateOrbRelayEnrollment(c.env, secret).catch(dbBrokerError);
    if (enrollment === null) return c.json({ error: "broker_error" }, 503);
    if ("error" in enrollment) return c.json(enrollment, enrollment.error === "invalid_enrollment" ? 401 : 403);
    const rawBody = await readOrbRelayRegisterBody(c.req.raw, c.req.header("content-length"));
    if (rawBody === null) return c.json({ error: "payload_too_large" }, 413);
    let ack: string[] | undefined;
    try {
      const body = rawBody ? (JSON.parse(rawBody) as { ack?: unknown }) : null;
      if (Array.isArray(body?.ack)) ack = body.ack.filter((id): id is string => typeof id === "string");
    } catch {
      ack = undefined; // tolerate an empty/invalid body — just no ack this round
    }
    // #9150: scope the drain to THIS enrollment (or untagged/legacy rows) — not merely the installation — so a
    // second live enrollment for the same install can never steal and destructively-ack this one's events.
    const events = await pullRelayPending(c.env, enrollment.installationId, { ack, enrollId: enrollment.enrollId }).catch(dbBrokerError);
    if (events === null) return c.json({ error: "broker_error" }, 503);
    return c.json({ events }, 200);
  });

  // LoopOver Orb (#1255) — central fleet-calibration collector. Receives anonymized, reversal-aware outcome
  // batches from self-hosted instances. Sender-side HMAC anonymization is for privacy, not authentication.
  // #9046/#9166: FAILS CLOSED when ORB_INGEST_TOKEN is unset — isAuthorizedIngest (below, shared with
  // /v1/ams/ingest) requires an exact bearer match against the configured token; an unconfigured collector
  // rejects rather than accepting anonymous writes. Bounded by a hard body ceiling, and dedup'd via
  // UNIQUE(instance_id, repo_hash, pr_hash).
  app.post("/v1/orb/ingest", async (c) => {
    if (!(await isAuthorizedIngest(c.env.ORB_INGEST_TOKEN, extractBearerToken(c.req.header("authorization"))))) return c.json({ error: "unauthorized" }, 401);
    const body = await readOrbIngestBody(c.req.raw, c.req.header("content-length"));
    if (body === null) return c.json({ error: "payload_too_large" }, 413);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    // #9121: the per-instance credential proving THIS sender is the registered instance it claims to be in
    // the body — distinct from the shared fleet-wide bearer token checked above, which proves only "some
    // fleet member". Absent for an unregistered instance or one that hasn't (re-)registered since #9121.
    const result = await handleOrbIngest(body, c.env.DB, c.req.header("x-orb-instance-secret"));
    if ("error" in result) return c.json(result, result.error === "instance_unauthenticated" ? 403 : 400);
    return c.json(result, 200);
  });

  // LoopOver AMS (#5681) — central telemetry collector for the miner product, mirroring the Orb ingest
  // route above (same optional bearer-token gate, same hard body ceiling — readOrbIngestBody is generic over
  // request bytes despite the name, so it's reused as-is rather than duplicated).
  app.post("/v1/ams/ingest", async (c) => {
    if (!(await isAuthorizedIngest(c.env.AMS_INGEST_TOKEN, extractBearerToken(c.req.header("authorization"))))) return c.json({ error: "unauthorized" }, 401);
    const body = await readOrbIngestBody(c.req.raw, c.req.header("content-length"));
    if (body === null) return c.json({ error: "payload_too_large" }, 413);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const result = await handleAmsIngest(body, c.env.DB);
    if ("error" in result) return c.json(result, 400);
    return c.json(result, 200);
  });

  // Fleet calibration analytics over the collected orb_signals — gate accuracy (precision / FP / reversal /
  // cycle-time) aggregated median-robustly across the self-host fleet. Owner-only: bearer-gated by the
  // `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN). `?days=` windows the lookback (default 90).
  app.get("/v1/internal/fleet/analytics", async (c) => {
    const days = parsePositiveInt(c.req.query("days")) ?? 90;
    return c.json(await computeFleetAnalytics(c.env, { windowDays: days }));
  });

  // Orb instance registry — the fleet trust gate. Every self-host instance that ingests is recorded here,
  // but only REGISTERED ones count toward fleet calibration (computeFleetAnalytics). Bearer-gated by the
  // `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN). List shows pending + registered instances with their
  // stored-signal counts so an operator knows what they're opting in before they register it.
  // Decision-audit adjudication (#8830, epic #8828): the operator surface for the weekly stratified sample.
  // Bearer-gated by the /v1/internal/* middleware (INTERNAL_JOB_TOKEN). List is filterable by status; the
  // adjudicate write is idempotent-hostile on purpose — a second adjudication 409s rather than silently
  // rewriting a label (labels are calibration data; rewrites must be deliberate, via a fresh rubric version).
  app.get("/v1/internal/audit-labels", async (c) => {
    const status = c.req.query("status");
    const where = status === "pending" || status === "adjudicated" ? "WHERE status = ?" : "";
    const stmt = c.env.DB.prepare(
      `SELECT id, project, target_id AS targetId, verdict, outcome, stratum, rubric_version AS rubricVersion,
              sampled_at AS sampledAt, status, adjudication, reason_category AS reasonCategory, adjudicated_at AS adjudicatedAt
         FROM decision_audit_labels ${where} ORDER BY sampled_at DESC, target_id ASC LIMIT 500`,
    );
    const rows = await (where ? stmt.bind(status) : stmt).all();
    return c.json({ labels: rows.results });
  });

  app.post("/v1/internal/audit-labels/adjudicate", async (c) => {
    const payload = (await c.req.json().catch(() => null)) as { id?: unknown; adjudication?: unknown; reasonCategory?: unknown } | null;
    const id = typeof payload?.id === "string" ? payload.id : "";
    const adjudication = payload?.adjudication;
    if (!id || (adjudication !== "correct" && adjudication !== "incorrect" && adjudication !== "uncertain")) {
      return c.json({ error: "id and adjudication (correct|incorrect|uncertain) required" }, 400);
    }
    const reasonCategory = typeof payload?.reasonCategory === "string" ? payload.reasonCategory.slice(0, 100) : null;
    // Atomic claim: the status predicate rides the UPDATE itself, so two concurrent adjudications can never
    // both win — a select-then-update here would let both pass the pending check and silently violate the
    // one-adjudication-per-label guarantee (labels are calibration data; rewrites must be impossible, not
    // merely discouraged). meta.changes disambiguates afterwards: 0 changes is either "no such label" (404)
    // or "someone else already adjudicated it" (409), resolved by one read that no longer guards anything.
    const result = await c.env.DB.prepare(
      `UPDATE decision_audit_labels SET status = 'adjudicated', adjudication = ?, reason_category = ?, adjudicated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
      .bind(adjudication, reasonCategory, new Date().toISOString(), id)
      .run();
    if (result.meta.changes === 0) {
      const existing = await c.env.DB.prepare("SELECT status FROM decision_audit_labels WHERE id = ?").bind(id).first<{ status: string }>();
      if (!existing) return c.json({ error: "label_not_found" }, 404);
      return c.json({ error: "already_adjudicated" }, 409);
    }
    return c.json({ id, adjudication, reasonCategory });
  });

  app.get("/v1/internal/orb/instances", async (c) => {
    return c.json(await listFleetInstances(c.env));
  });

  // Opt an instance into (or out of) fleet calibration. Body: { instanceId, registered? } (registered
  // defaults true). Upserts so an operator can register an instance that has ingested but isn't recorded yet.
  //
  // #9121: registering ALSO mints a fresh per-instance ingest credential — the only way "registered" can
  // mean anything on the risk-control write path is if the identity it trusts is proven by a secret only
  // the real instance holds, not merely claimed in the request body. Returned ONCE, in plaintext, here;
  // only its hash is ever persisted, so the operator must copy it into the instance's config now (as
  // ORB_COLLECTOR_INSTANCE_SECRET) — a repeat register call rotates it, invalidating the previous value.
  app.post("/v1/internal/orb/instances/register", async (c) => {
    const payload = (await c.req.json().catch(() => null)) as { instanceId?: unknown; registered?: unknown } | null;
    const instanceId = typeof payload?.instanceId === "string" ? payload.instanceId : "";
    if (!instanceId) return c.json({ error: "instanceId required" }, 400);
    return c.json(await registerFleetInstance(c.env, { instanceId, ...(payload?.registered === false ? { registered: false } : {}) }));
  });

  // Central Orb GitHub App installation registry — the onboarding gate. Every installation the Orb App webhook
  // records lands at registered=0; only REGISTERED ones count toward the global public counter (getOrbGlobalStats)
  // and are eligible for token brokering. Bearer-gated by the `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN). The
  // list shows pending + registered installs so an operator knows what they're opting in.
  //
  // liveEnrollmentCount (#9149): how many enrollment secrets are currently live ('enrolled', not revoked) for
  // this install — an operator previously had no way to see that a re-enrollment (issueOrbEnrollment was a bare
  // INSERT, never revoking) had accumulated a second standing credential. A correlated subquery rather than a
  // JOIN: each installation has at most a handful of enrollment rows, so this stays cheap without reshaping the
  // one-row-per-installation result set a GROUP BY would require.
  app.get("/v1/internal/orb/installations", async (c) => {
    return c.json(await listFleetInstallations(c.env));
  });

  // Opt an installation into (or out of) the registry. Body: { installationId, registered? } (registered defaults
  // true). Opting out also blocks OAuth self-enrollment until an operator opts back in. 404 when the installation
  // isn't recorded yet — an install MUST arrive via the webhook first (unlike the fleet instances there's no account
  // context to upsert a never-seen installation from).
  app.post("/v1/internal/orb/installations/register", async (c) => {
    const payload = (await c.req.json().catch(() => null)) as { installationId?: unknown; registered?: unknown } | null;
    const installationId = Number(payload?.installationId);
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "installationId required" }, 400);
    const result = await registerFleetInstallation(c.env, { installationId, ...(payload?.registered === false ? { registered: false } : {}) });
    if ("error" in result) return c.json(result, 404);
    return c.json(result);
  });

  // Operator-triggered reconciliation of the installation registry against GitHub's authoritative install list —
  // recovers installs whose `installation` webhook fired before the receiver's secret was configured (so they were
  // never recorded). Upserts each install WITHOUT touching `registered`, so a re-run never re-trusts an opted-out
  // install and new rows land at registered=0 (the manual-onboarding gate). Bearer-gated by the `/v1/internal/*`
  // middleware (INTERNAL_JOB_TOKEN). Returns { backfilled } — the count of installs GitHub reported.
  app.post("/v1/internal/orb/installations/backfill", async (c) => {
    return c.json(await backfillOrbInstallations(c.env));
  });

  // Operator-only: issue a one-time token-broker enrollment secret for a REGISTERED install, to hand to that
  // maintainer's self-hosted container. The secret is returned ONCE (stored only hashed). Bearer-gated by the
  // /v1/internal/* middleware (INTERNAL_JOB_TOKEN); flag-gated (404 until ORB_BROKER_ENABLED).
  //
  // Also accepts an optional `{ secretType: "tenant_db_credential", secretValue }` body (#8064) -- the STORED-
  // secret issuance path control-plane's hosted provisioning core (#7180/#8066) calls instead, for a credential
  // that already exists (a tenant's Postgres connection string) rather than a GitHub installation to bind.
  // `installationId` is irrelevant to that path (see issueOrbStoredSecret's own header comment for why).
  //
  // Also accepts an optional `{ rotate: true }` (#9149): when set, every PRIOR live enrollment for this
  // installation is revoked before the new one is minted, mirroring the OAuth landing page's `state=<id>:rotate`
  // flow (oauth.ts) for the operator-issued path. Defaults to false (append, not replace) -- unchanged behavior
  // for every existing caller, since a blue/green container swap legitimately relies on two live enrollments
  // briefly overlapping (see #9150's sibling fix, which makes that overlap safe rather than assuming away).
  app.post("/v1/internal/orb/enrollments", async (c) => {
    if (!isOrbBrokerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const payload = (await c.req.json().catch(() => null)) as { installationId?: unknown; secretType?: unknown; secretValue?: unknown; rotate?: unknown } | null;
    if (payload?.secretType === ORB_SECRET_TYPE_TENANT_DB_CREDENTIAL) {
      const secretValue = typeof payload.secretValue === "string" ? payload.secretValue : "";
      const result = await issueOrbStoredSecret(c.env, ORB_SECRET_TYPE_TENANT_DB_CREDENTIAL, secretValue);
      if ("error" in result) return c.json(result, result.error === "secret_value_required" ? 400 : 503);
      return c.json(result); // { enrollId, secret } — secret shown exactly once
    }
    const installationId = Number(payload?.installationId);
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "installationId required" }, 400);
    const result = await issueOrbEnrollment(c.env, installationId, undefined, ORB_SECRET_TYPE_GITHUB_TOKEN, { rotate: payload?.rotate === true });
    if ("error" in result) return c.json(result, result.error === "installation_not_found" ? 404 : 409);
    return c.json(result); // { enrollId, secret } — secret shown exactly once
  });

  // Operator-only: revoke a token-broker enrollment (#8064) -- works for ANY secret type (GitHub-token or
  // stored), since brokerOrbToken's own revoked_at check (unchanged, #7174) already refuses any revoked row on
  // its very next exchange attempt. Idempotent: revoking an already-revoked enrollment still reports success.
  app.post("/v1/internal/orb/enrollments/:enrollId/revoke", async (c) => {
    if (!isOrbBrokerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const result = await revokeOrbEnrollment(c.env, c.req.param("enrollId"));
    if ("error" in result) return c.json(result, 404);
    return c.json(result);
  });

  // Convergence (ops / observability, flag LOOPOVER_REVIEW_OPS). Cross-repo review-OUTCOME aggregate (gate-block
  // ledger + recommendation/slop calibration) for an operator dashboard. Bearer-gated by the `/v1/internal/*`
  // middleware above (INTERNAL_JOB_TOKEN). Flag-OFF (default) → 404, so the endpoint does not exist and the
  // worker is byte-identical to today. Enable can ALSO be set as code via the loopover self-repo's
  // `.loopover.yml ops:` block (config-as-code parity, #6275), the SAME override the cron gate honors — so this
  // dashboard endpoint can never disagree with whether the scan itself is actually running. Aggregate counts
  // only — no PR content / actor logins.
  app.get("/v1/internal/ops/stats", async (c) => {
    const opsManifestOverride = await resolveOpsManifestOverride(c.env);
    if (!isOpsEnabled(c.env, opsManifestOverride)) return c.json({ error: "not_found" }, 404);
    return c.json(await computeOpsStats(c.env));
  });

  // Convergence prep (#preconv-parity, flag LOOPOVER_REVIEW_PARITY_AUDIT). The pre-cutover shadow-parity READINESS
  // report: runs computeGateParity / isParityCutoverReady over the recorded review_audit rows and returns the
  // per-project agreement rate + cutover-ready verdict (floor 0.98, min 30 paired samples, zero unsafe
  // disagreements — all from parity.ts). Bearer-gated by the `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN).
  // Flag-OFF (default) → 404, so the endpoint does not exist and the worker is byte-identical to today. Reads
  // WHATEVER is recorded: with only gittensory-native rows (no reviewbot dual-run yet) there are no pairs, so it
  // honestly reports no signal. The comparison becomes meaningful once reviewbot's authoritative rows land via
  // the deploy-time dual-run shadow step. Aggregate counts only — no PR content / actor logins.
  app.get("/v1/internal/parity", async (c) => {
    if (!isParityAuditEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    return c.json(await computeParityReadiness(c.env));
  });

  // #predicted-live-gate-agreement (maintainer review-stack x AMS integration audit, 2026-07-09): how often the
  // MCP predict_gate/explain_gate_disposition verdict agrees with the REAL gate decision a contributor's PR
  // later receives -- a DIFFERENT question than /v1/internal/parity's reviewbot-vs-loopover migration parity
  // (see src/review/predicted-gate-agreement.ts's module header). Same gate/auth contract as /v1/internal/parity:
  // bearer-gated by the `/v1/internal/*` middleware, 404 when LOOPOVER_REVIEW_PARITY_AUDIT is off so the
  // endpoint does not exist on a deploy not running this telemetry family. Aggregate counts only — no PR
  // content / actor logins (see that module's privacy note on why a per-login breakdown never belongs here).
  app.get("/v1/internal/predicted-agreement", async (c) => {
    if (!isParityAuditEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    return c.json(await computePredictedGateAgreement(c.env, { days: 90, nowMs: Date.now() }));
  });

  // Contributor trust profiles (#fairness-analytics): per-repo submission counts (submitter_stats), moderation
  // violation history (adverse actions/warnings, audit_events), and gate-decision accuracy
  // (contributor_gate_history), composed per contributor. Bearer-gated by the `/v1/internal/*` middleware, 404
  // when LOOPOVER_FAIRNESS_ANALYTICS is off. NEVER exposed publicly -- see contributor-trust-profile.ts's design
  // note. The fleet-wide fairness flags need every contributor's rows to compute each project's median, so this
  // computes the full report and filters to :login rather than re-deriving a login-scoped median in isolation.
  // Same reasoning applies to globalFairnessFlags (#global-contributor-trust) against the blended report.
  app.get("/v1/internal/fairness/contributors/:login", async (c) => {
    if (!isFairnessAnalyticsEnabled(c.env, await resolveFairnessAnalyticsManifestOverride(c.env))) return c.json({ error: "not_found" }, 404);
    const login = c.req.param("login");
    const nowMs = Date.now();
    const [profile, evalReport, blendedEvalReport] = await Promise.all([
      getContributorTrustProfile(c.env, login, { nowMs }),
      computeContributorGateEval(c.env, { days: 90, nowMs }),
      computeBlendedContributorGateEval(c.env, { days: 90, nowMs }),
    ]);
    const flags = contributorFairnessFlags(evalReport.rows).filter((f) => f.login === login);
    const globalFlags = contributorGlobalFairnessFlags(blendedEvalReport.rows).filter((f) => f.login === login);
    return c.json({ profile, fairnessFlags: flags, globalFairnessFlags: globalFlags });
  });

  // Fleet-wide fairness summary (#fairness-analytics): counts only, never individual contributor rows -- the
  // per-login detail lives behind the :login route above. Intended for the operator dashboard tile.
  // globalFlaggedCount/contributorsEvaluatedGlobally (#global-contributor-trust) are the blended,
  // pooled-across-every-repo counterparts to flaggedCount/contributorsEvaluated -- one row per LOGIN rather
  // than one row per (login, project), so the two counts intentionally diverge for any login active on more
  // than one repo.
  app.get("/v1/internal/fairness/contributors", async (c) => {
    if (!isFairnessAnalyticsEnabled(c.env, await resolveFairnessAnalyticsManifestOverride(c.env))) return c.json({ error: "not_found" }, 404);
    const nowMs = Date.now();
    const [evalReport, blendedEvalReport] = await Promise.all([
      computeContributorGateEval(c.env, { days: 90, nowMs }),
      computeBlendedContributorGateEval(c.env, { days: 90, nowMs }),
    ]);
    const flags = contributorFairnessFlags(evalReport.rows);
    const globalFlags = contributorGlobalFairnessFlags(blendedEvalReport.rows);
    return c.json({
      contributorsEvaluated: evalReport.rows.length,
      hasSignal: evalReport.hasSignal,
      flaggedCount: flags.length,
      contributorsEvaluatedGlobally: blendedEvalReport.rows.length,
      globalHasSignal: blendedEvalReport.hasSignal,
      globalFlaggedCount: globalFlags.length,
    });
  });

  // Backfill (#fairness-analytics): reconstructs historical contributor_gate_history rows predating migration
  // 0126 -- see contributor-gate-history-backfill.ts's header. Synchronous + idempotent + bounded by `limit`
  // (default 500); an operator re-POSTs until `hasMore` is false. Bearer-gated, 404 when the flag is off.
  app.post("/v1/internal/jobs/backfill-contributor-gate-history/run", async (c) => {
    if (!isFairnessAnalyticsEnabled(c.env, await resolveFairnessAnalyticsManifestOverride(c.env))) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const limit = typeof body?.limit === "number" ? body.limit : undefined;
    return c.json(await backfillContributorGateHistory(c.env, { limit }));
  });

  // Operator decision-trail: the full state + cached terminal decision + audit log for ONE review target, so any
  // gate verdict is explainable on demand (?repo=<owner/repo>&number=<n>[&kind=pull_request|issue]). Bearer-gated
  // by the `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN); handleInternalDecision re-checks that same token and
  // 400s a missing/invalid repo+number, 404s an unknown target. Aggregate review state only — no PR content.
  app.get("/v1/internal/decision", (c) => handleInternalDecision(c.req.raw, c.env, internalOpsAgentConfig(c.env)));

  // Operator calibration: confidence-vs-outcome curve + a recommended confidence floor for the review agent.
  // Bearer-gated by the `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN); handleInternalCalibration re-checks it.
  // Fails safe to an empty-but-shaped report when there is no review signal yet. Aggregate counts only.
  app.get("/v1/internal/calibration", (c) => handleInternalCalibration(c.req.raw, c.env, internalOpsAgentConfig(c.env)));

  // Operator per-agent health/verdict breakdown, manual-rate, stuck targets, config-invariant violations, and
  // recent decisions (#8904 — the handler existed and was unit-tested but its route was never registered, unlike
  // its two siblings above). Bearer-gated by the `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN);
  // handleInternalStatus re-checks that same token. Aggregate review state only — no PR content.
  app.get("/v1/internal/status", (c) => handleInternalStatus(c.req.raw, c.env, internalOpsAgentConfig(c.env)));

  // Operator calibration trend (#8113): weekly per-rule fired/decided/precision plus backtest-run verdict
  // counts, re-bucketed live from audit_events (no cron rollup — see rule-calibration-trend.ts's header). Sibling
  // of /v1/internal/calibration above, same INTERNAL_JOB_TOKEN gate via the /v1/internal/* middleware.
  // Aggregate counts and rule ids only — no PR content, no raw context.
  app.get("/v1/internal/calibration-trend", async (c) => c.json(await loadCalibrationTrend(c.env)));

  // #8121 (approved narrow start): manually trigger one backtest-gated loosening evaluation of the
  // linked-issue satisfaction confidence floor. 404 when the autotune flag is off (the endpoint doesn't
  // exist on a deploy that hasn't opted in, mirroring the rag-index route's flag-gate). Bearer-gated by the
  // /v1/internal/* middleware (INTERNAL_JOB_TOKEN). Applying is idempotent per candidate step: repeat calls
  // re-evaluate from the CURRENT (possibly already-loosened) floor and step at most one candidate at a time.
  app.post("/v1/internal/calibration/loosen-satisfaction-floor", async (c) => {
    if (!isSatisfactionFloorAutotuneEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const result = await runSatisfactionFloorLoosening(c.env);
    return c.json(result);
  });

  // Operator visibility for the loosening loop (#8161): flag state, shipped vs live floor, the stored
  // override row, and the applied-loosening history with both split verdicts. Deliberately NOT flag-gated
  // (unlike the trigger above): an operator must be able to see a lingering override row while the flag is
  // off. Same INTERNAL_JOB_TOKEN gate via the /v1/internal/* middleware; aggregate numbers/verdicts only.
  app.get("/v1/internal/calibration/satisfaction-floor", async (c) => c.json(await loadSatisfactionFloorStatus(c.env)));

  // The #8161 surface generalized across EVERY live registry knob (#8176): one endpoint, one projector,
  // per-knob flag state + shipped/live/override values + applied history (both split verdicts). Same
  // deliberate non-flag-gating and INTERNAL_JOB_TOKEN posture as the satisfaction-floor read above.
  app.get("/v1/internal/calibration/knobs", async (c) => c.json({ knobs: await loadAllKnobStatuses(c.env) }));

  app.post("/v1/internal/jobs/refresh-registry", async (c) => {
    const message: JobMessage = { type: "refresh-registry", requestedBy: "api" };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued" }, 202);
  });

  // Operator-facing RAG (re)index trigger for a self-host maintainer. Bearer-gated by the `/v1/internal/*`
  // middleware (INTERNAL_JOB_TOKEN). With NO body it enqueues the fan-out (re-indexes every RAG-active configured +
  // registered repo); with `{ "repoFullName": "owner/repo" }` it indexes just that repo. Either way the job is
  // gated downstream by convergedFeatureActive, so a repo where RAG is off is a no-op. 404 when RAG is globally off
  // so the endpoint doesn't exist on a deploy that isn't running RAG. This is how an operator adds/indexes a new
  // repo on demand instead of waiting for the 6-hourly cron.
  app.post("/v1/internal/jobs/rag-index", async (c) => {
    if (!isRagEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { repoFullName?: unknown };
    const repoFullName = typeof body?.repoFullName === "string" && body.repoFullName.trim().length > 0 ? body.repoFullName.trim() : undefined;
    const repo = repoFullName ? await getRepository(c.env, repoFullName) : null;
    const message: JobMessage = {
      type: "rag-index-repo",
      requestedBy: "api",
      ...(repoFullName ? { repoFullName } : {}),
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
    };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", scope: repoFullName ?? "all-configured-repos" }, 202);
  });

  app.post("/v1/internal/jobs/refresh-registry/run", async (c) => {
    return c.json(await refreshRegistry(c.env));
  });

  // Operator-only manual re-gate trigger (#8898): enqueue an `agent-regate-pr` job with `force: true` for one
  // repo+PR. This is the FIRST production producer of that job's `force` field (threaded through
  // src/queue/job-dispatch.ts into regatePullRequest) -- every scheduled/webhook producer leaves it unset, so
  // the force plumbing (a fresh AI opinion that bypasses the durable review cache and the non-cacheable-reuse
  // cooldown) was built and tested but unreachable from any real caller until now. Bearer-gated by the
  // `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN). 400s a missing/blank repo or a non-positive-integer PR
  // number; 404s a repo with no known installation (nothing to authenticate the re-gate against).
  app.post("/v1/internal/jobs/regate-pr", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { repoFullName?: unknown; prNumber?: unknown };
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName.trim() : "";
    if (!repoFullName) return c.json({ error: "repoFullName required" }, 400);
    const prNumber = Number(body?.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return c.json({ error: "prNumber required" }, 400);
    const repo = await getRepository(c.env, repoFullName);
    if (typeof repo?.installationId !== "number") return c.json({ error: "repo not installed" }, 404);
    const message: JobMessage = {
      type: "agent-regate-pr",
      deliveryId: deliveryIdFor("manualRegate", crypto.randomUUID()),
      repoFullName: repo.fullName,
      prNumber,
      installationId: repo.installationId,
      force: true,
    };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", repoFullName: repo.fullName, prNumber, force: true }, 202);
  });

  app.post("/v1/internal/jobs/backfill-registered-repos", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    const force = body?.force === true;
    const mode = body?.mode === "full" || body?.mode === "resume" ? body.mode : "light";
    const message: JobMessage = { type: "backfill-registered-repos", requestedBy: "api", repoFullName, force, mode };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", repoFullName, force, mode }, 202);
  });

  app.post("/v1/internal/jobs/backfill-registered-repos/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    const force = body?.force === true;
    const mode = body?.mode === "full" || body?.mode === "resume" ? body.mode : "light";
    return c.json(await backfillRegisteredRepositories(c.env, { repoFullName, requestedBy: "api", force, mode }));
  });

  app.post("/v1/internal/jobs/backfill-repo-segment", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.repoFullName !== "string" || body.repoFullName.length === 0) return c.json({ error: "repo_full_name_required" }, 400);
    const segment = parseBackfillSegment(body?.segment);
    if (!segment) return c.json({ error: "valid_segment_required" }, 400);
    const mode = body?.mode === "full" || body?.mode === "resume" ? body.mode : "light";
    const repo = await getRepository(c.env, body.repoFullName);
    const message: JobMessage = {
      type: "backfill-repo-segment",
      requestedBy: "api",
      repoFullName: body.repoFullName,
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
      segment,
      mode,
      force: body?.force === true,
      ...(typeof body?.cursor === "string" ? { cursor: body.cursor } : {}),
    };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", repoFullName: body.repoFullName, segment, mode }, 202);
  });

  app.post("/v1/internal/jobs/backfill-repo-segment/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.repoFullName !== "string" || body.repoFullName.length === 0) return c.json({ error: "repo_full_name_required" }, 400);
    const segment = parseBackfillSegment(body?.segment);
    if (!segment) return c.json({ error: "valid_segment_required" }, 400);
    const mode = body?.mode === "full" || body?.mode === "resume" ? body.mode : "light";
    return c.json(
      await backfillRepositorySegment(c.env, {
        repoFullName: body.repoFullName,
        segment,
        requestedBy: "api",
        mode,
        ...(typeof body?.cursor === "string" ? { cursor: body.cursor } : {}),
        force: body?.force === true,
      }),
    );
  });

  app.post("/v1/internal/jobs/backfill-pr-details", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.repoFullName !== "string" || body.repoFullName.length === 0) return c.json({ error: "repo_full_name_required" }, 400);
    const mode = body?.mode === "full" || body?.mode === "resume" ? body.mode : "light";
    const repo = await getRepository(c.env, body.repoFullName);
    const message: JobMessage = {
      type: "backfill-pr-details",
      requestedBy: "api",
      repoFullName: body.repoFullName,
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
      mode,
      ...(Number.isFinite(Number(body?.cursor)) ? { cursor: Number(body.cursor) } : {}),
    };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", repoFullName: body.repoFullName, mode }, 202);
  });

  app.post("/v1/internal/jobs/backfill-pr-details/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.repoFullName !== "string" || body.repoFullName.length === 0) return c.json({ error: "repo_full_name_required" }, 400);
    const mode = body?.mode === "full" || body?.mode === "resume" ? body.mode : "light";
    return c.json(await backfillOpenPullRequestDetails(c.env, { repoFullName: body.repoFullName, mode, ...(Number.isFinite(Number(body?.cursor)) ? { cursor: Number(body.cursor) } : {}) }));
  });

  app.post("/v1/internal/jobs/refresh-scoring-model", async (c) => {
    const message: JobMessage = { type: "refresh-scoring-model", requestedBy: "api" };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued" }, 202);
  });

  app.post("/v1/internal/jobs/refresh-scoring-model/run", async (c) => {
    return c.json(await refreshScoringModelSnapshot(c.env));
  });

  app.post("/v1/internal/jobs/refresh-upstream-drift", async (c) => {
    const message: JobMessage = { type: "refresh-upstream-drift", requestedBy: "api" };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued" }, 202);
  });

  app.post("/v1/internal/jobs/refresh-upstream-drift/run", async (c) => c.json(await refreshUpstreamDrift(c.env)));

  app.post("/v1/internal/jobs/file-upstream-drift-issues", async (c) => {
    const message: JobMessage = { type: "file-upstream-drift-issues", requestedBy: "api" };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued" }, 202);
  });

  app.post("/v1/internal/jobs/file-upstream-drift-issues/run", async (c) => {
    // Config-as-code override (#6275): resolve the loopover self-repo's `upstreamDriftIssues` manifest block
    // (if any) and thread it through so a present override actually takes effect, matching the cron dispatch
    // gate in job-dispatch.ts.
    const driftIssuesOverride = await resolveAutoFileDriftIssuesManifestOverride(c.env);
    return c.json(await fileUpstreamDriftIssues(c.env, driftIssuesOverride));
  });

  app.post("/v1/internal/jobs/build-contributor-evidence", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const login = typeof body?.login === "string" ? body.login : undefined;
    const message: JobMessage = { type: "build-contributor-evidence", requestedBy: "api", login };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", login }, 202);
  });

  app.post("/v1/internal/jobs/build-contributor-decision-packs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const login = typeof body?.login === "string" ? body.login : undefined;
    const message: JobMessage = { type: "build-contributor-decision-packs", requestedBy: "api", login };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", login }, 202);
  });

  app.post("/v1/internal/jobs/build-contributor-decision-packs/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.login !== "string" || body.login.length === 0) return c.json({ error: "login_required" }, 400);
    return c.json(await buildAndPersistContributorDecisionPack(c.env, body.login));
  });

  app.post("/v1/internal/jobs/refresh-contributor-activity", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.login !== "string" || body.login.length === 0) return c.json({ error: "login_required" }, 400);
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    const message: JobMessage = { type: "refresh-contributor-activity", requestedBy: "api", login: body.login, repoFullName };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", login: body.login, repoFullName }, 202);
  });

  app.post("/v1/internal/jobs/refresh-contributor-activity/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.login !== "string" || body.login.length === 0) return c.json({ error: "login_required" }, 400);
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    return c.json(await refreshContributorActivity(c.env, body.login, { repoFullName }));
  });

  app.post("/v1/internal/jobs/build-burden-forecasts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    const message: JobMessage = { type: "build-burden-forecasts", requestedBy: "api", repoFullName };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", repoFullName }, 202);
  });

  app.post("/v1/internal/jobs/generate-signal-snapshots", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    const message: JobMessage = { type: "generate-signal-snapshots", requestedBy: "api", repoFullName };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", repoFullName }, 202);
  });

  app.post("/v1/internal/jobs/rollup-product-usage", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const day = typeof body?.day === "string" ? body.day : undefined;
    const days = Number.isFinite(Number(body?.days)) ? Math.max(1, Math.min(31, Math.round(Number(body.days)))) : undefined;
    const message: JobMessage = { type: "rollup-product-usage", requestedBy: "api", ...(day ? { day } : {}), ...(days === undefined ? {} : { days }) };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", day, days }, 202);
  });

  app.post("/v1/internal/jobs/generate-weekly-value-report", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const days = Number.isFinite(Number(body?.days)) ? Math.max(1, Math.min(31, Math.round(Number(body.days)))) : undefined;
    const variant = body?.variant === "public" ? "public" : "operator";
    const message: JobMessage = { type: "generate-weekly-value-report", requestedBy: "api", variant, ...(days === undefined ? {} : { days }) };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", variant, days }, 202);
  });

  // Maintainer review recap digest (#1963): manually-triggerable only in this PR (no scheduled cron trigger
  // yet -- see the queue processor's "generate-review-recap" case). Config-gated on reviewRecap.enabled at
  // the processor, so queuing a job for a repo that hasn't opted in is a documented no-op, not an error.
  app.post("/v1/internal/jobs/generate-review-recap", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    if (!repoFullName) return c.json({ ok: false, error: "repoFullName is required" }, 400);
    const windowDays = Number.isFinite(Number(body?.windowDays)) ? Math.max(1, Math.min(90, Math.round(Number(body.windowDays)))) : undefined;
    const message: JobMessage = { type: "generate-review-recap", requestedBy: "api", repoFullName, ...(windowDays === undefined ? {} : { windowDays }) };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued", repoFullName, windowDays }, 202);
  });

  app.post("/v1/internal/jobs/repair-data-fidelity", async (c) => {
    const message: JobMessage = { type: "repair-data-fidelity", requestedBy: "api" };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued" }, 202);
  });

  app.post("/v1/internal/jobs/generate-signal-snapshots/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    await generateSignalSnapshots(c.env, repoFullName);
    return c.json({ ok: true, status: "completed", repoFullName });
  });

  app.post("/v1/internal/jobs/rollup-product-usage/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const day = typeof body?.day === "string" ? body.day : undefined;
    const days = Number.isFinite(Number(body?.days)) ? Math.max(1, Math.min(31, Math.round(Number(body.days)))) : undefined;
    return c.json(await rollupProductUsageDaily(c.env, { ...(day ? { day } : {}), ...(days === undefined ? {} : { days }) }));
  });

  app.post("/v1/internal/jobs/generate-weekly-value-report/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const days = Number.isFinite(Number(body?.days)) ? Math.max(1, Math.min(31, Math.round(Number(body.days)))) : undefined;
    const variant = body?.variant === "public" ? "public" : "operator";
    return c.json(await generateWeeklyValueReport(c.env, { variant, ...(days === undefined ? {} : { days }) }));
  });

  // Same reviewRecap.enabled gate as the queued path above (#1963) -- an immediate "/run" still respects the
  // per-repo opt-in, since (unlike generate-weekly-value-report/run) this has a real side effect: posting to
  // the repo's configured Discord channel.
  app.post("/v1/internal/jobs/generate-review-recap/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repoFullName = typeof body?.repoFullName === "string" ? body.repoFullName : undefined;
    if (!repoFullName) return c.json({ ok: false, error: "repoFullName is required" }, 400);
    const windowDays = Number.isFinite(Number(body?.windowDays)) ? Math.max(1, Math.min(90, Math.round(Number(body.windowDays)))) : undefined;
    const manifest = await loadRepoFocusManifest(c.env, repoFullName).catch(() => null);
    if (!manifest?.reviewRecap.enabled) {
      return c.json({ ok: false, status: "skipped", reason: "reviewRecap is not enabled for this repository (.loopover.yml reviewRecap.enabled)" }, 200);
    }
    const { recap, delivery } = await generateAndSendReviewRecap(c.env, repoFullName, { windowDays: windowDays ?? manifest.reviewRecap.cadenceDays });
    return c.json({ ok: true, recap, delivery });
  });

  app.post("/v1/internal/jobs/refresh-installation-health/run", async (c) => {
    return c.json(await refreshInstallationHealth(c.env));
  });

  app.post("/v1/internal/bounties/import", async (c) => {
    const body = await c.req.json().catch(() => null);
    const bounties = normalizeGittBountySnapshot(body);
    let imported = 0;
    let lifecycleEvents = 0;
    for (const bounty of bounties) {
      // #9080: the lifecycle event for THIS bounty is now written in the SAME step as its own upsert, and
      // each item is individually try/caught -- previously every event was collected into one array and
      // persisted only AFTER the whole loop finished, so a mid-loop failure (a bad row further down the
      // batch) left every bounty upserted so far already advanced in `bounties` with ZERO lifecycle rows
      // recorded for any of them, and the transition is unrecoverable once the next import's diff runs
      // against the now-already-updated row (the same "state advanced, audit trail didn't" shape as #8997).
      // A single bad item can no longer take the rest of the batch down with it, either.
      try {
        const existing = await getBounty(c.env, bounty.id);
        await upsertBounty(c.env, bounty);
        imported += 1;
        if (!existing || existing.status !== bounty.status) {
          await persistBountyLifecycleEvent(c.env, {
            id: crypto.randomUUID(),
            bountyId: bounty.id,
            repoFullName: bounty.repoFullName,
            issueNumber: bounty.issueNumber,
            status: bounty.status,
            payload: { previousStatus: existing?.status ?? null, source: "gitt_import" },
            generatedAt: nowIso(),
          });
          lifecycleEvents += 1;
        }
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "bounty_import_item_failed",
            bountyId: bounty.id,
            repoFullName: bounty.repoFullName,
            issueNumber: bounty.issueNumber,
            message: errorMessage(error).slice(0, 160),
          }),
        );
      }
    }
    return c.json({ ok: true, imported, lifecycleEvents });
  });

  app.post("/v1/internal/queue-intelligence", async (c) => {
    const contentLength = parsePositiveInt(c.req.header("content-length"));
    if (contentLength !== null && contentLength > QUEUE_INTELLIGENCE_LIMITS.bodyBytes) {
      return c.json({ error: "payload_too_large", maxBytes: QUEUE_INTELLIGENCE_LIMITS.bodyBytes }, 413);
    }

    const rawBody = await readRequestBodyWithLimit(c.req.raw, QUEUE_INTELLIGENCE_LIMITS.bodyBytes);
    if (rawBody === null) {
      return c.json({ error: "payload_too_large", maxBytes: QUEUE_INTELLIGENCE_LIMITS.bodyBytes }, 413);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || !Array.isArray((body as { pullRequests?: unknown }).pullRequests)) {
      return c.json({ error: "invalid_request", detail: "pullRequests array required" }, 400);
    }
    const queueBody = body as { pullRequests: unknown[]; repoContext?: unknown };
    const prsResult = z.array(QueueIntelligencePullRequestSchema).max(QUEUE_INTELLIGENCE_LIMITS.pullRequests).safeParse(queueBody.pullRequests);
    if (!prsResult.success) return c.json({ error: "invalid_request", issues: prsResult.error.issues }, 400);
    const parsedRepoContext = QueueIntelligenceRepoContextSchema.safeParse(queueBody.repoContext);
    const repoContext = parsedRepoContext.success ? parsedRepoContext.data : { totalOpenPRs: 0, avgReviewTimeDays: 0, maintainerWorkload: 0 };
    const result = await analyzePRQueue(prsResult.data, repoContext);
    const recommendations: Record<number, string> = {};
    for (const [num, rec] of result.recommendations) recommendations[num] = rec;
    return c.json({ rankedPRs: result.rankedPRs, recommendations });
  });

  app.post("/v1/internal/repos/:owner/:repo/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = repositorySettingsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_repository_settings", issues: parsed.error.issues }, 400);
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(
      await upsertRepositorySettings(c.env, {
        repoFullName: fullName,
        gatePack: parsed.data.gatePack,
        aiReviewLowConfidenceDisposition: parsed.data.aiReviewLowConfidenceDisposition,
        closeOwnerAuthors: parsed.data.closeOwnerAuthors,
        autoLabelEnabled: parsed.data.autoLabelEnabled,
        requireLinkedIssue: parsed.data.requireLinkedIssue,
        commandAuthorization: normalizeCommandAuthorizationPolicy(parsed.data.commandAuthorization).policy,
      }),
    );
  });

  // Maintainer BYOK provider key. GET returns secret-free status only; POST stores it encrypted at rest;
  // DELETE removes it. The plaintext key is never logged and never returned.
  app.get("/v1/internal/repos/:owner/:repo/ai-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await getRepositoryAiKeyStatus(c.env, fullName));
  });

  // Read-only retention preview: counts the rows the daily prune cron would delete, per table, plus the
  // duplicate signal_snapshots rows the dedup pass would remove. Does NOT delete anything (dry-run); the
  // actual prune + dedup runs on the schedule via the prune-retention job.
  app.get("/v1/internal/retention/preview", async (c) => {
    const results = await pruneExpiredRecords(c.env, { dryRun: true });
    const dedupeResults = await dedupeSignalSnapshots(c.env, { dryRun: true });
    return c.json({
      policy: RETENTION_POLICY,
      eligible: results,
      totalEligible: results.reduce((sum, r) => sum + r.deleted, 0),
      signalSnapshotDuplicates: dedupeResults,
      totalSignalSnapshotDuplicates: dedupeResults.reduce((sum, r) => sum + r.deleted, 0),
    });
  });

  app.post("/v1/internal/repos/:owner/:repo/ai-key", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = repositoryAiKeySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_ai_key", issues: parsed.error.issues }, 400);
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    try {
      const status = await upsertRepositoryAiKey(c.env, {
        repoFullName: fullName,
        provider: parsed.data.provider,
        key: parsed.data.key,
        model: parsed.data.model ?? null,
      });
      return c.json(status);
    } catch (error) {
      // The only expected throw is a missing encryption secret — never echo key material in the error.
      if (error instanceof Error && error.message === "missing_encryption_secret") {
        return c.json({ error: "encryption_unavailable", detail: "TOKEN_ENCRYPTION_SECRET is not configured." }, 503);
      }
      throw error;
    }
  });

  app.delete("/v1/internal/repos/:owner/:repo/ai-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    await deleteRepositoryAiKey(c.env, fullName);
    return c.json({ configured: false });
  });

  // Instance subscription-CLI credentials (#9543) -- the FLEET rotation path. A single self-hosted box can
  // rotate its credential in place on disk (scripts/rotate-secret.sh, or the companion's rotate-secret
  // verb), but a multi-instance deployment has no shared filesystem, so the value lives encrypted in the DB
  // and every instance resolves it fresh at AI-call time. Stored here, a rotation takes effect on the very
  // next review on every instance, with no restart anywhere.
  //
  // GET returns secret-free status ONLY (configured/last4/updatedAt) -- never the credential, matching the
  // BYOK ai-key surface above. DELETE clears it, so resolution falls back to the secret file / boot env.
  app.get("/v1/internal/provider-credentials/:provider", async (c) => {
    const parsed = rotatableProviderSchema.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json({ error: "unknown_provider" }, 400);
    return c.json(await getProviderCredentialStatus(c.env, parsed.data));
  });

  app.post("/v1/internal/provider-credentials/:provider", async (c) => {
    const parsedProvider = rotatableProviderSchema.safeParse(c.req.param("provider"));
    if (!parsedProvider.success) return c.json({ error: "unknown_provider" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = providerCredentialSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_credential", issues: parsed.error.issues }, 400);
    try {
      return c.json(await upsertProviderCredential(c.env, { provider: parsedProvider.data, credential: parsed.data.credential }));
    } catch (error) {
      // The only expected throw here is a missing encryption secret -- never echo credential material in
      // the error. upsertProviderCredential's own `empty_credential` guard is deliberately NOT handled:
      // providerCredentialSchema above already rejects an empty or whitespace-only credential with a 400,
      // so that throw is unreachable through this route and a branch for it would be dead code (it still
      // guards direct callers of the repository function).
      if (error instanceof Error && error.message === "missing_encryption_secret") {
        return c.json({ error: "encryption_unavailable", detail: "TOKEN_ENCRYPTION_SECRET is not configured." }, 503);
      }
      throw error;
    }
  });

  app.delete("/v1/internal/provider-credentials/:provider", async (c) => {
    const parsed = rotatableProviderSchema.safeParse(c.req.param("provider"));
    if (!parsed.success) return c.json({ error: "unknown_provider" }, 400);
    await deleteProviderCredential(c.env, parsed.data);
    return c.json({ configured: false });
  });

  // Linear API key (#3186). GET returns secret-free status only; POST stores it encrypted at rest;
  // DELETE removes it. The plaintext key is never logged and never returned.
  app.get("/v1/internal/repos/:owner/:repo/linear-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await getRepositoryLinearKeyStatus(c.env, fullName));
  });

  app.post("/v1/internal/repos/:owner/:repo/linear-key", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = repositoryLinearKeySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_linear_key", issues: parsed.error.issues }, 400);
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    try {
      const status = await upsertRepositoryLinearKey(c.env, { repoFullName: fullName, key: parsed.data.key });
      return c.json(status);
    } catch (error) {
      if (error instanceof Error && error.message === "missing_encryption_secret") {
        return c.json({ error: "encryption_unavailable", detail: "TOKEN_ENCRYPTION_SECRET is not configured." }, 503);
      }
      throw error;
    }
  });

  app.delete("/v1/internal/repos/:owner/:repo/linear-key", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    await deleteRepositoryLinearKey(c.env, fullName);
    return c.json({ configured: false });
  });

  app.get("/v1/internal/repos/:owner/:repo/contribution-policy", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const focusManifest = await loadRepoFocusManifest(c.env, fullName, { fetcher: async () => null });
    const generatedAt = nowIso();
    return c.json({
      repoFullName: fullName,
      generatedAt,
      focusManifest,
      policy: compileFocusManifestPolicy(fullName, focusManifest, { generatedAt }),
    });
  });

  app.post("/v1/internal/repos/:owner/:repo/contribution-policy", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: "invalid_contribution_policy_json" }, 400);
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const focusManifest = await upsertRepoFocusManifest(c.env, fullName, body, "api_record");
    const generatedAt = nowIso();
    return c.json({
      repoFullName: fullName,
      generatedAt,
      focusManifest,
      policy: compileFocusManifestPolicy(fullName, focusManifest, { generatedAt }),
    });
  });

  return app;
}

const APP_COMMANDS = [
  {
    id: "plan-next-work",
    command: "@loopover plan",
    audience: "private",
    boundary: "private-api",
    description: "Rank the next contributor-safe work from the current decision pack.",
    endpoint: "/v1/agent/plan-next-work",
  },
  {
    id: "blockers",
    command: "@loopover blockers",
    audience: "private",
    boundary: "private-api",
    description: "Explain scoreability blockers without leaking private scoring context.",
    endpoint: "/v1/agent/explain-blockers",
  },
  {
    id: "preflight",
    command: "@loopover preflight",
    audience: "private",
    boundary: "private-api",
    description: "Run branch preflight against cached repo, PR, issue, and scorer context.",
    endpoint: "/v1/agent/preflight-branch",
  },
  {
    id: "packet",
    command: "@loopover packet",
    audience: "maintainer",
    boundary: "private-api",
    description: "Prepare a maintainer review packet from private and public evidence.",
    endpoint: "/v1/agent/prepare-pr-packet",
  },
  {
    id: "public-summary",
    command: "@loopover public-summary",
    audience: "public-safe",
    boundary: "public",
    description: "Preview the public-safe summary that may be posted to a PR thread.",
    endpoint: "/v1/app/commands/preview",
  },
  ...LOOPOVER_MENTION_COMMAND_CATALOG.filter(
    (command) =>
      ![
        "preflight",
        "blockers",
        "packet",
        "queue-summary",
        "review-now",
        "needs-author",
        "confirmed-miners",
        "duplicate-clusters",
        "burden-forecast",
        "intake-health",
        "outcome-patterns",
        "noise-report",
      ].includes(command.id),
  ).map((command) => ({
    id: command.id,
    command: `@loopover ${command.id}`,
    audience: "public-safe",
    boundary: "public",
    description: command.description,
    endpoint: "GitHub issue comment",
  })),
  {
    id: "queue-summary",
    command: "@loopover queue-summary",
    audience: "maintainer",
    boundary: "public-safe",
    description: "Post a maintainer-only queue digest from cached GitHub metadata.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "review-now",
    command: "@loopover review-now",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List cached PRs that look ready for maintainer review.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "needs-author",
    command: "@loopover needs-author",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List cached PRs that need author cleanup before detailed review.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "confirmed-miners",
    command: "@loopover confirmed-miners",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List open PRs whose authors are confirmed in the official-miner cache.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "duplicate-clusters",
    command: "@loopover duplicate-clusters",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List duplicate or WIP clusters visible from cached GitHub metadata.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "burden-forecast",
    command: "@loopover burden-forecast",
    audience: "maintainer",
    boundary: "public-safe",
    description: "Project maintainer review load and queue-growth risk from cached metadata.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "intake-health",
    command: "@loopover intake-health",
    audience: "maintainer",
    boundary: "public-safe",
    description: "Summarize contributor-intake health from cached queue and config signals.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "outcome-patterns",
    command: "@loopover outcome-patterns",
    audience: "maintainer",
    boundary: "public-safe",
    description: "Summarize what this repo actually merges vs closes from cached PR outcomes.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "noise-report",
    command: "@loopover noise-report",
    audience: "maintainer",
    boundary: "public-safe",
    description: "Highlight queue noise sources maintainers should triage first.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
] as const;

function authRedirectWithError(env: Env, reason: string): string {
  const siteOrigin = env.PUBLIC_SITE_ORIGIN ?? "https://loopover.ai";
  const url = new URL("/app", siteOrigin);
  url.searchParams.set("auth", "error");
  url.searchParams.set("reason", reason);
  return url.toString();
}

async function buildSessionResponse(env: Env, identity: Extract<AuthIdentity, { kind: "session" }>) {
  const roleSummary = await loadControlPanelRoleSummary(env, identity.actor, identity.session?.githubUserId);
  return {
    status: "authenticated",
    login: identity.session.login,
    githubId: identity.session?.githubUserId ?? null,
    github_id: identity.session?.githubUserId ?? null,
    roles: roleSummary.roles,
    roleSummary,
    confirmedMiner: roleSummary.confirmedMiner,
    confirmed_miner: roleSummary.confirmedMiner,
    expiresAt: identity.session.expiresAt,
    scopes: identity.session.scopes,
    createdAt: identity.session.createdAt,
    lastSeenAt: identity.session.lastSeenAt,
  };
}

function sparklineFromCounts(value: number, total: number): number[] {
  const safeTotal = Math.max(total, 1);
  const ratio = Math.max(0, Math.min(1, value / safeTotal));
  return [0.25, 0.35, 0.5, 0.62, 0.74, ratio].map((point, index) => Math.max(1, Math.round((point * ratio + index / 10) * 100)));
}

function groupDecisionPackBlockers(blockers: Array<string | { code?: string; title?: string; detail?: string; howToClear?: string }>): Array<{ group: string; items: Array<{ code: string; title: string; howToClear: string }> }> {
  /* v8 ignore start -- Decision-pack response fallback formatting is exercised through app dashboard route tests. */
  if (blockers.length === 0) return [];
  return [
    {
      group: "scoreability",
      items: blockers.map((blocker, index) => {
        const structured = typeof blocker === "string" ? null : blocker;
        return {
          code: structured?.code ?? `scoreability_${index + 1}`,
          title: structured?.title ?? structured?.detail ?? String(blocker),
          howToClear: structured?.howToClear ?? "Resolve the underlying decision-pack blocker, then rebuild the contributor decision pack.",
        };
      }),
    },
  ];
  /* v8 ignore stop */
}

function buildProjectionRows(pack: { repoDecisions?: Array<{ scoreability?: string; priorityScore?: number; recommendation?: string; repoFullName?: string }> }) {
  /* v8 ignore start -- Projection row defaults normalize partial decision-pack snapshots; route tests cover ready and missing packs. */
  const decisions = pack.repoDecisions ?? [];
  if (decisions.length === 0) return [];
  return decisions.slice(0, 6).map((decision) => ({
    name: decision.repoFullName ?? decision.recommendation ?? "repo",
    label: decision.scoreability ?? decision.recommendation ?? "scoreability",
    weight: Math.max(0, Math.min(1, (decision.priorityScore ?? 0) / 100)),
    note: decision.recommendation ?? "from decision pack",
  }));
  /* v8 ignore stop */
}

function buildMaintainerSettingsPreview() {
  return {
    removed: ["public_surface: comments", "check_mode: always", "label_policy: legacy"],
    added: [
      "public_surface: confirmed-miner-only",
      "check_mode: opt-in",
      "label_policy: { fixes: required, area: optional }",
      "maintainer_lane: { paths: [docs/**] }",
    ],
  };
}

const PREVIEWABLE_MENTION_COMMANDS = new Set<LoopOverMentionCommandName>(LOOPOVER_MENTION_COMMAND_CATALOG.map((command) => command.id));

type CommandPreviewDecision = {
  status: "ready" | "skipped" | "missing_permission" | "private_api";
  willComment: boolean;
  willLabel: boolean;
  willCheckRun: boolean;
  skipped: boolean;
  skipReason: string | null;
  actions: Array<"comment" | "label" | "check_run" | "skip" | "none">;
  summary: string;
};

function buildCommandPreview(
  command: (typeof APP_COMMANDS)[number],
  request: z.infer<typeof commandPreviewSchema>,
  context: { repo: RepositoryRecord | null; installation: InstallationHealthRecord | null; pullRequest: PullRequestRecord | null; env: LoopOverFooterEnv },
) {
  const target = request.repoFullName ? `${request.repoFullName}${request.pullNumber ? `#${request.pullNumber}` : ""}` : "selected target";
  const mentionCommandName = previewableMentionCommandName(command.id);
  if (!mentionCommandName) {
    return buildPrivateApiCommandPreview(command, request, target);
  }

  const sample = buildCommandPreviewSample(request, context.pullRequest);
  const missingPermissions = commandPreviewMissingPermissions(request, context.installation);
  const permissionWarnings = commandPreviewPermissionWarnings(missingPermissions);
  const officialAuthorDetection =
    sample.minerStatus === "confirmed"
      ? { status: "confirmed" as const, snapshot: sampleMinerSnapshot(sample.authorLogin) }
      : sample.minerStatus === "unavailable"
        ? { status: "unavailable" as const, error: "Official miner detection is unavailable in this preview scenario." }
        : { status: "not_found" as const };
  const authorization = isAuthorizedCommandActor({
    commandName: mentionCommandName,
    commenterLogin: sample.commenterLogin,
    commenterAssociation: sample.commenterAssociation,
    pullRequestAuthorLogin: sample.authorLogin,
    officialAuthorDetection,
  });

  const base = {
    boundary: "public" as const,
    endpoint: "GitHub issue comment",
    target,
    sample,
    missingPermissions,
    permissionDiagnostics: permissionWarnings.map((warning) => ({
      permission: warning.permission,
      requiredAccess: warning.requiredAccess,
      currentAccess: warning.currentAccess,
      ok: false,
      action: warning.action,
    })),
    warnings: permissionWarnings.map((warning) => warning.message),
  };

  if (!request.repoFullName || !request.pullNumber) {
    const summary = commandPreviewSkipSummary("missing_target");
    const body = sanitizePublicComment(`LoopOver would not post a public command response for ${target}: ${summary}`);
    return {
      ...base,
      body,
      sanitizer: commandPreviewSanitizer(body),
      decision: commandPreviewDecision({
        status: "skipped",
        willComment: false,
        skipReason: "missing_target",
        summary,
      }),
    };
  }

  if (!authorization.authorized) {
    const body = sanitizePublicComment(`LoopOver would not post a public command response for ${target}: ${commandPreviewSkipSummary(authorization.reason)}.`);
    return {
      ...base,
      body,
      sanitizer: commandPreviewSanitizer(body),
      decision: commandPreviewDecision({
        status: "skipped",
        willComment: false,
        skipReason: authorization.reason,
        summary: commandPreviewSkipSummary(authorization.reason),
      }),
    };
  }

  if (missingPermissions.includes("issues")) {
    const summary = "GitHub App permission Issues: write is required before a command response can be posted.";
    const body = sanitizePublicComment(`LoopOver preview is ready for ${target}, but ${summary}`);
    return {
      ...base,
      body,
      sanitizer: commandPreviewSanitizer(body),
      decision: commandPreviewDecision({
        status: "missing_permission",
        willComment: false,
        skipReason: "missing_permission",
        summary,
      }),
    };
  }

  const issue = {
    number: sample.pullNumber,
    title: sample.title,
    state: "open",
    ...(request.repoFullName && request.pullNumber ? { html_url: `https://github.com/${request.repoFullName}/pull/${request.pullNumber}` } : {}),
    user: { login: sample.authorLogin },
    author_association: sample.authorAssociation,
    labels: sample.labels.map((name) => ({ name })),
    body: sample.body,
    pull_request: {},
  };
  const pullRequest = buildCommandPreviewPullRequest(request, sample, context.pullRequest);
  const body =
    command.id === "public-summary"
      ? `LoopOver can summarize public-safe context for ${target}. Private scorer details stay out of the PR thread.`
      : buildPublicAgentCommandComment({
          command: { name: mentionCommandName, raw: `@loopover ${mentionCommandName}` },
          repo: context.repo,
          issue,
          pullRequest,
          actorKind: authorization.actorKind === "maintainer" ? "maintainer" : "author",
          officialMiner: officialAuthorDetection.status === "confirmed" ? officialAuthorDetection.snapshot : null,
          maintainerDigest: isMaintainerOnlyCommand(mentionCommandName)
            ? buildMaintainerQueueDigest({
                repo: context.repo,
                issues: [],
                pullRequests: [pullRequest],
                confirmedMinerLogins: sample.minerStatus === "confirmed" ? [sample.authorLogin] : [],
              })
            : null,
          env: context.env,
        });

  return {
    ...base,
    body,
    sanitizer: commandPreviewSanitizer(body),
    decision: commandPreviewDecision({
      status: "ready",
      willComment: true,
      skipReason: null,
      summary: "LoopOver would post this sanitized command response and would not create labels or check runs.",
    }),
  };
}

function buildPrivateApiCommandPreview(command: (typeof APP_COMMANDS)[number], request: z.infer<typeof commandPreviewSchema>, target: string) {
  return {
    boundary: command.boundary,
    endpoint: command.endpoint,
    target,
    body: `${command.command} will call ${command.endpoint} for ${target}${request.login ? ` as ${request.login}` : ""}.`,
    missingPermissions: [],
    permissionDiagnostics: [],
    warnings: [],
    decision: commandPreviewDecision({
      status: "private_api",
      willComment: false,
      skipReason: null,
      summary: "Private API preview only; no GitHub comment, label, or check run would be created.",
    }),
  };
}

function previewableMentionCommandName(commandId: string): LoopOverMentionCommandName | null {
  if (PREVIEWABLE_MENTION_COMMANDS.has(commandId as LoopOverMentionCommandName)) return commandId as LoopOverMentionCommandName;
  if (commandId === "public-summary") return "help";
  return null;
}

function commandPreviewDecision(args: {
  status: CommandPreviewDecision["status"];
  willComment: boolean;
  skipReason: string | null;
  summary: string;
}): CommandPreviewDecision {
  return {
    status: args.status,
    willComment: args.willComment,
    willLabel: false,
    willCheckRun: false,
    skipped: args.status === "skipped" || args.status === "missing_permission",
    skipReason: args.skipReason,
    actions: args.willComment ? ["comment"] : args.status === "private_api" ? ["none"] : ["skip"],
    summary: args.summary,
  };
}

function buildCommandPreviewSample(request: z.infer<typeof commandPreviewSchema>, pullRequest: PullRequestRecord | null) {
  const sample = request.sample ?? {};
  const authorLogin = sample.authorLogin?.trim() || pullRequest?.authorLogin || request.login || "sample-contributor";
  const commenterAssociation =
    sample.commenterAssociation ?? (isMaintainerOnlyCommand(previewableMentionCommandName(request.command.replace(/^@loopover\s+/, "")) ?? "help") ? "OWNER" : "NONE");
  return {
    pullNumber: request.pullNumber ?? pullRequest?.number ?? 1,
    authorLogin,
    authorType: sample.authorType ?? "User",
    authorAssociation: sample.authorAssociation ?? pullRequest?.authorAssociation ?? "NONE",
    commenterLogin: sample.commenterLogin?.trim() || request.login || authorLogin,
    commenterAssociation,
    minerStatus: sample.minerStatus ?? "confirmed",
    title: sample.title?.trim() || pullRequest?.title || "Sample pull request",
    body: sample.body ?? pullRequest?.body ?? null,
    labels: sample.labels ?? pullRequest?.labels ?? [],
    linkedIssues: sample.linkedIssues ?? pullRequest?.linkedIssues ?? [],
  };
}

function buildCommandPreviewPullRequest(
  request: z.infer<typeof commandPreviewSchema>,
  sample: ReturnType<typeof buildCommandPreviewSample>,
  pullRequest: PullRequestRecord | null,
): PullRequestRecord {
  return {
    repoFullName: request.repoFullName ?? pullRequest?.repoFullName ?? "selected/repository",
    number: sample.pullNumber,
    title: sample.title,
    state: pullRequest?.state ?? "open",
    authorLogin: sample.authorLogin,
    authorAssociation: sample.authorAssociation,
    headSha: pullRequest?.headSha ?? "preview-head-sha",
    headRef: pullRequest?.headRef ?? "preview-branch",
    baseRef: pullRequest?.baseRef ?? "main",
    htmlUrl: pullRequest?.htmlUrl ?? (request.repoFullName && sample.pullNumber ? `https://github.com/${request.repoFullName}/pull/${sample.pullNumber}` : null),
    mergedAt: null,
    isDraft: pullRequest?.isDraft ?? false,
    mergeableState: pullRequest?.mergeableState ?? null,
    reviewDecision: pullRequest?.reviewDecision ?? null,
    body: sample.body,
    createdAt: pullRequest?.createdAt ?? nowIso(),
    updatedAt: pullRequest?.updatedAt ?? nowIso(),
    labels: sample.labels,
    linkedIssues: sample.linkedIssues,
  };
}

function commandPreviewMissingPermissions(request: z.infer<typeof commandPreviewSchema>, installation: InstallationHealthRecord | null): string[] {
  const configured = new Set([...(installation?.missingPermissions ?? []), ...(request.sample?.missingPermissions ?? [])]);
  configured.delete("pull_requests");
  const permissions = request.sample?.permissions ?? installation?.permissions;
  if (permissions && permissions.issues !== "write") configured.add("issues");
  return [...configured].sort();
}

function commandPreviewPermissionWarnings(missingPermissions: string[]) {
  return missingPermissions.map((permission) => {
    const requiredAccess = "write";
    const currentAccess = "missing";
    return {
      permission,
      requiredAccess,
      currentAccess,
      action: `Set repository permission ${permission} to ${requiredAccess}, then approve the GitHub App permission change.`,
      message:
        permission === "issues"
          ? "Command responses require GitHub App permission Issues: write; preview will not post while it is missing."
          : `GitHub App permission ${permission}: ${requiredAccess} is missing for this preview scenario.`,
    };
  });
}

function commandPreviewSanitizer(body: string) {
  const forbiddenTerms = [
    "wallet",
    "hotkey",
    "raw trust",
    "trust score",
    "payout",
    "reward estimate",
    "farming",
    "scoreability",
    "public score estimate",
  ].filter((term) => new RegExp(term, "i").test(body));
  return { passed: forbiddenTerms.length === 0, forbiddenTerms };
}

function commandPreviewSkipSummary(reason: string): string {
  const summaries: Record<string, string> = {
    missing_target: "public command previews require a repository and pull request number.",
    maintainer_command_requires_maintainer: "maintainer-only commands require an owner, member, or collaborator invocation.",
    not_maintainer_or_pr_author: "the commenter is neither a maintainer nor the pull request author.",
    miner_detection_unavailable: "official Gittensor miner detection is unavailable, so LoopOver would skip rather than guess.",
    pr_author_not_confirmed_miner: "the pull request author is not a confirmed Gittensor miner.",
  };
  return summaries[reason] ?? reason.replace(/_/g, " ");
}

function sampleMinerSnapshot(login: string) {
  return {
    source: "gittensor_api" as const,
    githubId: `preview-${login}`,
    githubUsername: login,
    isEligible: true,
    credibility: 1,
    eligibleRepoCount: 1,
    issueDiscoveryScore: 0,
    issueTokenScore: 0,
    issueCredibility: 1,
    isIssueEligible: false,
    issueEligibleRepoCount: 0,
    alphaPerDay: 0,
    taoPerDay: 0,
    usdPerDay: 0,
    totals: {
      pullRequests: 1,
      mergedPullRequests: 0,
      openPullRequests: 1,
      closedPullRequests: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
    },
    repositories: [],
    pullRequests: [],
    issueLabels: [],
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function buildDigestItems(args: {
  repositories: RepositoryRecord[];
  health: InstallationHealthRecord[];
  upstreamDrift: Awaited<ReturnType<typeof loadUpstreamStatus>>;
  rateLimits: Awaited<ReturnType<typeof listLatestGitHubRateLimitObservations>>;
}) {
  const items: Array<{ kind: "summary" | "review-now" | "queue" | "drift" | "install"; title: string; detail: string; meta?: string }> = [];
  // Lead with `installed` (repos this instance actually operates on) rather than `registered` (gittensor-subnet
  // membership, an opt-in plugin -- see gittensor-wire.ts). "0 registered" is the normal, expected headline for
  // any operator who hasn't opted into the gittensor plugin and must not read as broken (#5026).
  const installed = args.repositories.filter((repo) => repo.isInstalled).length;
  const registered = args.repositories.filter((repo) => repo.isRegistered).length;
  items.push({
    kind: "summary",
    title: `${installed} installed repositories tracked`,
    detail:
      registered > 0
        ? `${args.repositories.length} repositories are present in the local LoopOver data cache; ${registered} registered with the gittensor plugin.`
        : `${args.repositories.length} repositories are present in the local LoopOver data cache.`,
    meta: "registry",
  });
  const unhealthy = args.health.filter((record) => record.status !== "healthy");
  for (const record of unhealthy.slice(0, 4)) {
    items.push({
      kind: "install",
      title: `${record.accountLogin} installation needs attention`,
      detail: [...record.missingPermissions, ...record.missingEvents].slice(0, 3).join(", ") || "Installation health is degraded.",
      meta: String(record.installationId),
    });
  }
  if (args.upstreamDrift.status !== "current") {
    const registryDrift = args.upstreamDrift.registryHyperparameterDrift;
    items.push({
      kind: "drift",
      title: "Upstream ruleset drift check is not current",
      detail:
        registryDrift.highImpactCount > 0
          ? `Current upstream status: ${args.upstreamDrift.status}; ${registryDrift.highImpactCount} high-impact registry hyperparameter drift event(s) are open.`
          : `Current upstream status: ${args.upstreamDrift.status}.`,
      meta: args.upstreamDrift.highestSeverity ?? "watch",
    });
  }
  if (args.rateLimits.length > 0) {
    items.push({
      kind: "queue",
      title: `${args.rateLimits.length} GitHub rate-limit observations recorded`,
      detail: "Recent API calls include rate-limit telemetry; check sync status before large backfills.",
      meta: "rate-limit",
    });
  }
  return items;
}

async function buildRepoIntelligenceResponse(env: Env, fullName: string) {
  let burdenForecastError: unknown;
  const [repo, snapshots, dataQuality, burdenForecast, queueTrends] = await Promise.all([
    getRepository(env, fullName),
    Promise.all(
      ["queue-health", "config-quality", "label-audit", "maintainer-lane", "maintainer-cut-readiness", "contributor-intake-health"].map(async (signalType) => [
        signalType,
        (await listSignalSnapshots(env, signalType, fullName))[0]?.payload ?? null,
      ]),
    ),
    loadRepoDataQuality(env, fullName),
    loadCachedBurdenForecastResponse(env, fullName).catch((error) => {
      burdenForecastError = error;
      return null;
    }),
    getRepoQueueTrendSnapshot(env, fullName),
  ]);
  const intelligenceDataQuality = burdenForecastError
    ? withDataQualityWarning(dataQuality, `Burden forecast unavailable for ${fullName}: ${errorMessage(burdenForecastError)}`)
    : dataQuality;
  const snapshotMap = Object.fromEntries(snapshots);
  const burdenForecastSlice = burdenForecast
    ? {
        burdenForecast: burdenForecast.report,
        burdenForecastFreshness: {
          source: burdenForecast.source,
          generatedAt: burdenForecast.generatedAt,
          ageSeconds: burdenForecast.ageSeconds,
          freshness: burdenForecast.freshness,
        },
      }
    : {};
  const queueTrendReport = queueTrends?.payload ?? (buildUnavailableQueueTrendReport(fullName) as unknown as Record<string, never>);
  if (snapshotMap["queue-health"] && snapshotMap["config-quality"] && snapshotMap["label-audit"]) {
    return {
      status: "ready",
      source: "snapshot",
      repoFullName: fullName,
      generatedAt: nowIso(),
      repo,
      lane: buildLaneAdvice(repo, fullName),
      queueHealth: snapshotMap["queue-health"],
      queueTrends: queueTrendReport,
      configQuality: snapshotMap["config-quality"],
      labelAudit: snapshotMap["label-audit"],
      maintainerLane: snapshotMap["maintainer-lane"],
      maintainerCutReadiness: snapshotMap["maintainer-cut-readiness"],
      contributorIntakeHealth: snapshotMap["contributor-intake-health"],
      dataQuality: intelligenceDataQuality,
      ...burdenForecastSlice,
    };
  }
  const [issues, pullRequests, recentMergedPullRequests, labels, queueCounts] = await Promise.all([
    listIssueSignalSample(env, fullName),
    listOpenPullRequests(env, fullName),
    listRecentMergedPullRequests(env, fullName),
    listRepoLabels(env, fullName),
    loadOpenQueueCounts(env, fullName),
  ]);
  const collisions = buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts);
  const configQuality = buildConfigQuality(repo, issues, pullRequests, fullName);
  const labelAudit = buildLabelAudit(repo, labels, issues, pullRequests, fullName);
  const maintainerLane = buildMaintainerLaneReport(repo, issues, pullRequests, fullName, collisions, queueCounts);
  const maintainerCutReadiness = buildMaintainerCutReadiness(repo, issues, pullRequests, fullName, queueCounts, collisions);
  const contributorIntakeHealth = buildContributorIntakeHealth(repo, issues, pullRequests, fullName, collisions, queueCounts);
  return {
    status: "ready",
    source: "computed",
    repoFullName: fullName,
    generatedAt: nowIso(),
    repo,
    lane: buildLaneAdvice(repo, fullName),
    queueHealth,
    queueTrends: queueTrendReport,
    collisions,
    configQuality,
    labelAudit,
    maintainerLane,
    maintainerCutReadiness,
    contributorIntakeHealth,
    dataQuality: intelligenceDataQuality,
    ...burdenForecastSlice,
  };
}

function withDataQualityWarning(dataQuality: DataQuality, warning: string): DataQuality {
  return {
    ...dataQuality,
    status: dataQuality.status === "complete" ? "degraded" : dataQuality.status,
    partial: true,
    warnings: [...new Set([...dataQuality.warnings, warning])],
  };
}

async function buildIssueQualityResponse(env: Env, fullName: string) {
  return loadOrComputeIssueQualityResponse(env, fullName);
}

async function loadInstallationHealthSummary(env: Env, repo: RepositoryRecord | null): Promise<InstallationHealthSummary | null> {
  /* v8 ignore start -- Installation health loading is route-level glue over covered signal helpers. */
  const installationId = repo?.installationId ?? null;
  if (installationId === null) return null;
  const healthRecord = await getInstallationHealth(env, installationId);
  if (!healthRecord) return null;
  const enriched = enrichInstallationHealth(healthRecord);
  return { status: enriched.status, missingPermissions: enriched.missingPermissions, missingEvents: enriched.missingEvents };
  /* v8 ignore stop */
}

async function buildRepoOutcomePatternsResponse(env: Env, fullName: string) {
  const response = await loadOrComputeRepoOutcomePatternsResponse(env, fullName);
  if (!response) return null;
  const dataQuality = await loadRepoDataQuality(env, fullName);
  return attachDataQuality(response as unknown as Record<string, unknown>, dataQuality);
}

// Batch A (loopover#6442) + Batch B (loopover#6443): these fields moved off the DB entirely -- rawSettings
// (getRepositorySettings) always returns the same hardcoded default for them now, so a "DB vs yml" comparison
// built on rawSettings alone would be comparing a constant against yml, never reflecting a repo's real
// .loopover.yml-driven behavior. Overlays the true EFFECTIVE value for just these fields onto an otherwise-
// raw-DB settings object, preserving the #2912 DB-vs-yml comparison intent for every other (still DB-backed)
// field.
const CONFIG_AS_CODE_ONLY_FIELDS = [
  // Batch A (loopover#6442)
  "commentMode",
  "publicAudienceMode",
  "publicSignalLevel",
  "checkRunMode",
  "checkRunDetailLevel",
  "regateSweepOrderMode",
  "publicSurface",
  "includeMaintainerAuthors",
  "backfillEnabled",
  // Batch B (loopover#6443)
  "gittensorLabel",
  "blacklistLabel",
  "createMissingLabel",
  "typeLabelsEnabled",
  "typeLabels",
  "linkedIssueLabelPropagation",
  "contributorBlacklist",
  "moderationGateMode",
  "moderationRules",
  "moderationWarningLabel",
  "moderationBannedLabel",
  "reviewEvasionProtection",
  "reviewEvasionLabel",
  "reviewEvasionComment",
  "mergeTrainMode",
  // #fairness-analytics: per-repo participation in contributor trust-profile analytics.
  "fairnessAnalyticsMode",
  // Batch C (loopover#6444): only reviewCheckMode is read directly in this file (buildGithubAppBehavior) --
  // the other 10 Batch C fields (linkedIssueGateMode, duplicatePrGateMode, qualityGateMode,
  // qualityGateMinScore, selfAuthoredLinkedIssueGateMode, aiReviewMode, aiReviewByok, aiReviewProvider,
  // aiReviewModel, aiReviewAllAuthors) are never read by registration-readiness.ts/this response, so they
  // don't need adding here.
  "reviewCheckMode",
] as const satisfies ReadonlyArray<keyof RepositorySettings>;
function applyConfigAsCodeOnlyFields(rawSettings: RepositorySettings, resolvedSettings: RepositorySettings): RepositorySettings {
  const settings = { ...rawSettings };
  for (const field of CONFIG_AS_CODE_ONLY_FIELDS) (settings[field] as unknown) = resolvedSettings[field];
  return settings;
}

export async function buildRegistrationReadinessResponse(env: Env, fullName: string) {
  /* v8 ignore start -- Registration readiness route-level shaping over covered signal helpers. */
  // Intentionally the raw DB `settings` alongside the raw (cache-only, never live-fetched) `focusManifest`,
  // not resolveRepositorySettings's merged view: this endpoint's whole purpose is to advise on the
  // relationship between the two config layers (e.g. "your yml sets X but the currently active settings say
  // Y"), which requires seeing them unmerged (#2912). See buildRegistrationReadiness's use of `focusManifest`
  // for the yml-compiled policy section, separate from `settings` for the currently-active-behavior section.
  const [intelligence, rawSettings, upstreamReports, focusManifest] = await Promise.all([
    buildRepoIntelligenceResponse(env, fullName),
    getRepositorySettings(env, fullName),
    listUpstreamDriftReports(env, 20),
    loadRepoFocusManifest(env, fullName, { fetcher: async () => null }),
  ]);
  // Batch A (loopover#6442): the 9 config-as-code-only fields no longer have an independent DB value to
  // compare against yml (#2912's rationale doesn't apply to them anymore -- `rawSettings` would always show
  // the same hardcoded default), so overlay the real EFFECTIVE value for those specific fields onto the raw
  // DB settings used for everything else.
  const settings = applyConfigAsCodeOnlyFields(rawSettings, resolveEffectiveSettings(rawSettings, focusManifest));
  const repo = intelligence.repo;
  const installation = await loadInstallationHealthSummary(env, repo);
  const report = buildRegistrationReadiness({
    repoFullName: fullName,
    repo,
    settings,
    lane: buildLaneAdvice(repo, fullName),
    configQuality: intelligence.configQuality as ReturnType<typeof buildConfigQuality>,
    labelAudit: intelligence.labelAudit as ReturnType<typeof buildLabelAudit>,
    queueHealth: intelligence.queueHealth as ReturnType<typeof buildQueueHealth>,
    maintainerCutReadiness: intelligence.maintainerCutReadiness as ReturnType<typeof buildMaintainerCutReadiness>,
    contributorIntakeHealth: intelligence.contributorIntakeHealth as ReturnType<typeof buildContributorIntakeHealth>,
    installation,
    upstreamRegistryDriftWarnings: registryHyperparameterDriftWarningsForRepo(upstreamReports, fullName),
    focusManifest,
  });
  const { policyReadiness } = report;
  const publicPolicyReadiness = policyReadiness === null ? null : stripOwnerPolicyContext(policyReadiness);
  return { ...report, policyReadiness: publicPolicyReadiness, dataQuality: intelligence.dataQuality };
  /* v8 ignore stop */
}

function stripOwnerPolicyContext<T extends { ownerContext: unknown }>(policyReadiness: T): Omit<T, "ownerContext"> {
  const { ownerContext: _ownerContext, ...publicPolicyReadiness } = policyReadiness;
  return publicPolicyReadiness;
}

async function buildSelfDogfoodRegistrationPackResponse(env: Env) {
  const fullName = resolveSelfDogfoodRepoFullName(env);
  const [readinessPayload, recommendationPayload] = await Promise.all([
    buildRegistrationReadinessResponse(env, fullName),
    buildGittensorConfigRecommendationResponse(env, fullName),
  ]);
  const { dataQuality: _readinessQuality, ...registrationReadiness } = readinessPayload;
  const { dataQuality: _recommendationQuality, ...gittensorConfigRecommendation } = recommendationPayload;
  return {
    ...buildSelfDogfoodRegistrationPack({
      repoFullName: fullName,
      registrationReadiness: registrationReadiness as RegistrationReadinessReport,
      gittensorConfigRecommendation,
    }),
    dataQuality: _readinessQuality,
  };
}

export async function buildGittensorConfigRecommendationResponse(env: Env, fullName: string) {
  /* v8 ignore start -- Config recommendation route-level shaping over covered signal helpers. */
  // Intentionally the raw DB settings, not resolveRepositorySettings's merged view: this tool recommends what
  // to ADD to .loopover.yml based on the repo's currently-active (dashboard/API-configured) behavior — using
  // the yml-merged view here would be comparing the recommendation against itself once a yml override exists
  // (#2912).
  const [intelligence, rawSettings, resolvedSettings] = await Promise.all([
    buildRepoIntelligenceResponse(env, fullName),
    getRepositorySettings(env, fullName),
    resolveRepositorySettings(env, fullName),
  ]);
  // Batch A (loopover#6442): see buildRegistrationReadinessResponse's identical comment above.
  const settings = applyConfigAsCodeOnlyFields(rawSettings, resolvedSettings);
  const repo = intelligence.repo;
  const recommendation = buildGittensorConfigRecommendation({
    repoFullName: fullName,
    repo,
    settings,
    lane: buildLaneAdvice(repo, fullName),
    configQuality: intelligence.configQuality as ReturnType<typeof buildConfigQuality>,
    contributorIntakeHealth: intelligence.contributorIntakeHealth as ReturnType<typeof buildContributorIntakeHealth>,
    maintainerCutReadiness: intelligence.maintainerCutReadiness as ReturnType<typeof buildMaintainerCutReadiness>,
  });
  return { ...recommendation, dataQuality: intelligence.dataQuality };
  /* v8 ignore stop */
}

async function loadOpenQueueCounts(env: Env, fullName: string): Promise<{ openIssues: number; openPullRequests: number }> {
  const [totals, openIssues, openPullRequests] = await Promise.all([getLatestRepoGithubTotalsSnapshot(env, fullName), countOpenIssues(env, fullName), countOpenPullRequests(env, fullName)]);
  return {
    openIssues: totals?.openIssuesTotal ?? openIssues,
    openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
  };
}

async function loadContributorFastContext(env: Env, login: string) {
  const [github, contributorPullRequests, contributorIssues, repositories, syncStates, syncSegments, cachedRepoStats, gittensorSnapshot] = await Promise.all([
    fetchPublicContributorProfile(login, env),
    listContributorPullRequests(env, login),
    listContributorIssues(env, login),
    listRepositories(env),
    listRepoSyncStates(env),
    listRepoSyncSegments(env),
    listContributorRepoStats(env, login),
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
    login,
    github,
    contributorPullRequests,
    contributorIssues,
    repositories,
    syncStates,
    syncSegments,
    repoStats,
    gittensorSnapshot,
    profile,
    outcomeHistory,
  };
}

async function loadCheckSummariesForPullRequests(env: Env, repoFullName: string, input: Parameters<typeof findCurrentBranchPullRequest>[0], pullRequests: Parameters<typeof findCurrentBranchPullRequest>[1]) {
  const currentPullRequest = findCurrentBranchPullRequest(input, pullRequests);
  return currentPullRequest ? listCheckSummaries(env, repoFullName, currentPullRequest.number) : [];
}

async function loadRepoDataQuality(env: Env, fullName: string) {
  const [syncStates, syncSegments] = await Promise.all([listRepoSyncStates(env), listRepoSyncSegments(env, fullName)]);
  return buildRepoDataQuality(
    fullName,
    syncStates.find((state) => state.repoFullName === fullName),
    syncSegments,
  );
}

function enrichSyncSegment(segment: RepoSyncSegmentRecord) {
  const expected = segment.expectedCount ?? 0;
  const coveragePercent = expected > 0 ? Math.min(100, Math.round((segment.fetchedCount / expected) * 10000) / 100) : segment.status === "complete" ? 100 : null;
  return {
    ...segment,
    cursor: segment.nextCursor ?? segment.lastCursor,
    coveragePercent,
    isRequired: ["metadata", "labels", "open_issues", "open_pull_requests", "pull_request_files", "pull_request_reviews", "check_summaries"].includes(segment.segment),
  };
}

function parseBackfillSegment(value: unknown): Extract<JobMessage, { type: "backfill-repo-segment" }>["segment"] | null {
  return value === "labels" || value === "open_issues" || value === "open_pull_requests" || value === "recent_merged_pull_requests" ? value : null;
}

async function persistSignal(
  env: Env,
  signalType: string,
  targetKey: string,
  repoFullName: string | null,
  payload: Record<string, JsonValue>,
  generatedAt: string,
): Promise<void> {
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType,
    targetKey,
    repoFullName,
    payload,
    generatedAt,
  });
}


const OPPORTUNITIES_FIND_PATH = "/v1/opportunities/find";
const ISSUE_RAG_RETRIEVE_PATH = "/v1/issue-rag/retrieve";
const LINT_PR_TEXT_PATH = "/v1/lint/pr-text";
const VALIDATE_FOCUS_MANIFEST_PATH = "/v1/validate/focus-manifest";
const LINT_SLOP_RISK_PATH = "/v1/lint/slop-risk";
const LINT_ISSUE_SLOP_PATH = "/v1/lint/issue-slop";

type ProtectedRouteContext = {
  env: Env;
  req: { header: (name: string) => string | undefined | null };
  json: (object: { error: string; reason?: string }, status?: number) => Response;
};

// ─── Authorization model (the miner ⊕ maintainer boundary) ──────────────────────────────────────
// Identity is per-LOGIN; authority is per-REPO. Two independent axes a single session can hold at once:
//   • MINER (gittensor contributor): may read ONLY its own contributor/miner data — enforced by
//     `requireContributorAccess` (HTTP) and `LoopoverMcp.requireContributorAccess` (MCP), which 403/throw
//     unless `session.actor === requestedLogin`. Being a miner grants ZERO maintainer visibility.
//   • MAINTAINER OF A SPECIFIC REPO: may read/write maintainer data ONLY for repos it is a verified
//     maintainer of — enforced by `requireSessionRepoAccess` / `requireRepoMaintainer` (HTTP) and
//     `LoopoverMcp.canAccessRepo` (MCP). Maintainer-of-repo-A grants ZERO access to repo B.
// Two maintainer tiers: (a) affiliation (owns/installed the repo, or authored a PR there with a
// maintainer association) gates maintainer-DATA reads; (b) verified write/admin/maintain permission,
// resolved live via the installation, additionally gates repo-visible settings writes and SECRET BYOK key
// writes (`requireRepoWriteAccess`).
// Operators (ADMIN_GITHUB_LOGINS) and server-to-server tokens bypass per-repo scope by design.
// `canSessionAccessPath` is the coarse path allowlist that runs in the global middleware BEFORE a route
// handler; it only decides whether a session may REACH a path — the per-route guards above enforce the
// actual identity/repo scope. A path added here MUST be scoped by a per-route guard in its handler.
function canSessionAccessPath(env: Env, identity: Extract<AuthIdentity, { kind: "session" }>, path: string): boolean {
  if (isAuthorizedGitHubSessionLogin(env, identity.actor, identity.session?.githubUserId)) return true;
  if (path.startsWith("/v1/app/")) return true;
  if (isIssueQualityPath(path)) return true;
  if (isRepoSettingsPath(path)) return true;
  if (isRepoActivationPath(path)) return true;
  if (isRepoOutcomeCalibrationPath(path)) return true;
  if (isRepoGatePrecisionPath(path)) return true;
  if (isRepoMaintainerNoisePath(path)) return true;
  if (isRepoAutomationStatePath(path)) return true; // #8653: route's requireRepoMaintainer enforces per-repo authority
  if (isRepoAmsMinerCohortPath(path)) return true; // #8653: route's requireRepoMaintainer enforces per-repo authority
  if (isRepoChatQaPath(path)) return true; // #8653: route's requireRepoMaintainer enforces per-repo authority
  if (isRepoSelftuneOverridesPath(path)) return true;
  if (isRepoSettingsPreviewPath(path)) return true;
  if (isRepoOnboardingPackPreviewPath(path)) return true;
  if (isRepoFocusManifestPath(path)) return true;
  if (isRepoAiConfigPath(path)) return true;
  if (isRepoLinearConfigPath(path)) return true;
  if (isRepoCheckBeforeStartPath(path)) return true;
  // #8654: advisory registration-readiness / gittensor-config-recommendation lookups are intentionally open to
  // any authenticated session -- the handlers carry no per-repo ownership guard by design (the owner panel takes
  // a free-text repo name, and the readiness handler already strips owner-private context via
  // stripOwnerPolicyContext before returning). They were simply omitted from this allowlist, so every real
  // non-operator browser session got 403 on the owner panel's only two data calls.
  if (isRepoRegistrationReadinessPath(path)) return true;
  if (isRepoGittensorConfigRecommendationPath(path)) return true;
  if (isRepoValidateLinkedIssuePath(path)) return true;
  if (isRepoAgentAuditFeedPath(path)) return true; // route's requireRepoMaintainer enforces per-repo authority (contributors → 403)
  if (isRepoDocRefreshPath(path)) return true; // route's requireRepoWriteAccess enforces real per-repo write authority
  if (isRepoAgentPendingActionsPath(path)) return true; // list (GET, requireRepoMaintainer) + propose (POST, requireRepoWriteAccess); decision POSTs on /:id/:decision require server tokens
  if (isRepoIncidentReportsPath(path)) return true; // #5672: route's requireRepoMaintainer enforces per-repo authority (contributors → 403)
  if (isRepoContributorIssueDraftGeneratePath(path)) return true;
  if (isRepoIssuePlanDraftGeneratePath(path)) return true;
  if (path === OPPORTUNITIES_FIND_PATH) return true;
  if (path === ISSUE_RAG_RETRIEVE_PATH) return true;
  if (path === LINT_PR_TEXT_PATH || path === VALIDATE_FOCUS_MANIFEST_PATH || path === LINT_SLOP_RISK_PATH || path === LINT_ISSUE_SLOP_PATH) return true;
  return false;
}

function isRepoSettingsPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/settings$/.test(path);
}

function isRepoRegistrationReadinessPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/registration-readiness$/.test(path);
}

function isRepoGittensorConfigRecommendationPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/gittensor-config-recommendation$/.test(path);
}

function isRepoActivationPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/activation(?:-preview)?$/.test(path);
}

function isRepoOutcomeCalibrationPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/outcome-calibration$/.test(path);
}

function isRepoGatePrecisionPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/gate-precision$/.test(path);
}

function isRepoMaintainerNoisePath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/maintainer-noise$/.test(path);
}

// #8653: three maintainer-session routes documented themselves as reachable by a maintainer's browser panel
// (automation-state "Maintainer-gated like /settings", ams-miner-cohort "mirrors maintainer-noise",
// pulls/:number/chat-qa "exposes ... to apps/loopover-ui's maintainer panel") but were missing from this
// allowlist, so a real non-operator maintainer session hit the coarse 403 before the handler's own
// requireRepoMaintainer/requireRepoWriteAccess guard could admit them. Each route's own guard still enforces
// per-repo authority (a maintainer of A reaching B → 403 forbidden_repo).
function isRepoAutomationStatePath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/automation-state$/.test(path);
}

function isRepoAmsMinerCohortPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/ams-miner-cohort$/.test(path);
}

function isRepoChatQaPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/chat-qa$/.test(path);
}

// #6168: let a browser (session) maintainer reach the self-tune override admin routes; the route's own
// requireRepoMaintainer then enforces per-repo authority (a non-maintainer session → 403). Matches the
// gate-precision allowlist entry above. Covers both the audit read and the live-override delete.
function isRepoSelftuneOverridesPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/selftune\/overrides(?:\/audit)?$/.test(path);
}

function isRepoSettingsPreviewPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/settings-preview$/.test(path);
}

function isRepoOnboardingPackPreviewPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/onboarding-pack\/preview$/.test(path);
}

function isRepoContributorIssueDraftGeneratePath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/contributor-issue-drafts\/generate$/.test(path);
}

// #7764: coarse path admission for the issue-plan-drafts generate route -- the route's own requireAppRole +
// requireSessionRepoAccess gate enforces real per-repo maintainer authority, exactly like the sibling above.
function isRepoIssuePlanDraftGeneratePath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/issue-plan-drafts\/generate$/.test(path);
}

function isRepoCheckBeforeStartPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/check-before-start$/.test(path);
}

function isRepoValidateLinkedIssuePath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/validate-linked-issue$/.test(path);
}

function isRepoAgentAuditFeedPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/agent\/audit-feed$/.test(path);
}

// #6743: coarse path admission only -- the route's own requireRepoWriteAccess enforces real per-repo write
// authority (a session with mere read/maintainer-data access still 403s there).
function isRepoDocRefreshPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/repo-docs\/refresh$/.test(path);
}

function isRepoIncidentReportsPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/incident-reports$/.test(path);
}

function isRepoAgentPendingActionsPath(path: string): boolean { return /^\/v1\/repos\/[^/]+\/[^/]+\/agent\/pending-actions$/.test(path); }
function isIssueQualityPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/issue-quality$/.test(path);
}

function isRepoFocusManifestPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/focus-manifest(?:\/refresh)?$/.test(path);
}

function isRepoAiConfigPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/ai-(?:review|key)$/.test(path);
}

// #3186: without this, a session (browser) caller hits the coarse-grained "insufficient_role" 403 from this
// module's own broad path-allowlist BEFORE ever reaching the route's own requireRepoWriteAccess check --
// same shape as isRepoAiConfigPath above, just for the new Linear key route.
function isRepoLinearConfigPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/linear-key$/.test(path);
}

async function authenticateRequestIdentity(c: ProtectedRouteContext): Promise<AuthIdentity | null> {
  const bearer = await authenticatePrivateToken(c.env, extractBearerToken(c.req.header("authorization")));
  if (bearer) return bearer;
  const browserSessionToken = extractBrowserSessionToken(c.req.header("cookie"));
  return authenticateSessionToken(c.env, browserSessionToken);
}

async function getRoleSummaryForIdentity(env: Env, identity: AuthIdentity) {
  if (identity.kind === "session") return loadControlPanelRoleSummary(env, identity.actor, identity.session?.githubUserId);
  return buildStaticControlPanelRoleSummary(identity.actor);
}

async function requireAppRole(c: ProtectedRouteContext, allowedRoles: ControlPanelRoleName[]): Promise<Response | null> {
  const identity = await authenticateRequestIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (identity.kind !== "session") {
    // LOOPOVER_MCP_TOKEN is a shared end-user credential; it must not satisfy app-role gates implicitly.
    // LOOPOVER_MCP_ADMIN_TOKEN (#7721) is narrower still by design -- config read/write only, explicitly
    // NOT the public dashboard/API settings surface these app-role gates protect -- so it's excluded here
    // too, same as the ordinary mcp token.
    if (identity.actor === "mcp" || identity.actor === "mcp-admin") return c.json({ error: "insufficient_role" }, 403);
    return null;
  }
  const summary = await loadControlPanelRoleSummary(c.env, identity.actor, identity.session?.githubUserId);
  return summary.roles.some((role) => allowedRoles.includes(role)) ? null : c.json({ error: "insufficient_role" }, 403);
}

/** Tenant-scoped gate for the `/v1/app/installations*` self-service routes (#7661), mirroring
 *  `/v1/app/maintainer-dashboard`: requires a maintainer/owner/operator role and, for a non-operator session,
 *  resolves the caller's installation access scope. Returns `{ identity, scope }` (scope === null means the
 *  caller — an operator or static service identity — sees the whole fleet), or a Response to short-circuit. */
async function resolveAppInstallationScope(
  c: ProtectedRouteContext,
): Promise<Response | { identity: AuthIdentity; scope: ControlPanelAccessScope | null }> {
  const identity = await authenticateRequestIdentity(c);
  /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before reaching the handler. */
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const summary = await getRoleSummaryForIdentity(c.env, identity);
  if (!summary.roles.some((role) => ["maintainer", "owner", "operator"].includes(role))) {
    return c.json({ error: "insufficient_role" }, 403);
  }
  const scope =
    identity.kind === "session" && !summary.roles.includes("operator")
      ? await loadControlPanelAccessScope(c.env, identity.actor, identity.session?.githubUserId)
      : null;
  return { identity, scope };
}

/** Whether an installation/health record is visible under a resolved installation scope, using the exact
 *  installation-id / account-login match `/v1/app/maintainer-dashboard` applies. A null scope is the operator
 *  (whole-fleet) case and matches everything. */
function installationRecordInScope(
  scope: ControlPanelAccessScope | null,
  record: { installationId: number; accountLogin: string },
): boolean {
  if (!scope) return true;
  const scopedInstallationIds = new Set(scope.installationIds);
  const scopedAccountLogins = new Set(scope.accountLogins.map((accountLogin) => accountLogin.toLowerCase()));
  return scopedInstallationIds.has(record.installationId) || scopedAccountLogins.has(record.accountLogin.toLowerCase());
}

/** #9045: `repoFullName` folds the MCP read-allowlist check INTO this gate rather than leaving it to each
 *  route to remember. Three of the four repo-scoped callers hand-rolled the identical check; the fourth
 *  (maintainer-packet) simply omitted it, so the shared, end-user-obtainable `mcp` token could read the full
 *  packet — every issue, PR, file, review, and check summary — for ANY repo over HTTP, while the MCP tool this
 *  route mirrors denied exactly that. Worse, MCP_READ_REPO_ALLOWLIST is fail-closed by default (unset ⇒ deny
 *  all), so the intended posture was "deny everything" while this route allowed everything. Passing the repo
 *  makes the check structural: a future repo-scoped route cannot forget it without also failing to pass the
 *  argument it needs anyway. Operator-only `api`/`internal` tokens stay trusted and are never allowlist-scoped. */
async function requireStaticProtectedApiToken(c: ProtectedRouteContext, repoFullName?: string): Promise<Response | null> {
  const identity = await authenticateRequestIdentity(c);
  /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before static-token-only route guards. */
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (identity.kind === "session") return c.json({ error: "static_token_required" }, 403);
  if (
    repoFullName !== undefined &&
    identity.actor === "mcp" &&
    !(await import("../auth/security")).isMcpReadRepoAllowed(c.env.MCP_READ_REPO_ALLOWLIST, repoFullName)
  ) {
    return c.json({ error: "forbidden_repo" }, 403);
  }
  return null;
}

async function requireContributorAccess(c: ProtectedRouteContext, login: string): Promise<Response | null> {
  const identity = await authenticateRequestIdentity(c);
  /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before contributor-scoped route guards. */
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (identity.kind === "session" && identity.actor.toLowerCase() !== login.toLowerCase()) return c.json({ error: "forbidden_contributor" }, 403);
  // The shared, end-user-obtainable LOOPOVER_MCP_TOKEN (static `mcp` identity) must NOT read an ARBITRARY
  // contributor's private decision pack / profile / notifications over HTTP either — this mirrors the MCP tool
  // surface's guard for the identical data (LoopoverMcp.requireContributorAccess, #2455). Without this, the
  // HTTP surface silently grants what the MCP surface explicitly denies for the very same token. Only the full
  // MCP_READ_REPO_ALLOWLIST wildcard opt-in unlocks it; operator-only `api`/`internal` tokens stay trusted by design.
  if (identity.kind === "static" && identity.actor === "mcp" && !isMcpReadUnscoped(c.env.MCP_READ_REPO_ALLOWLIST)) {
    return c.json({ error: "forbidden_contributor" }, 403);
  }
  return null;
}

async function requireCommandPreviewRepoAccess(
  c: ProtectedRouteContext,
  identity: AuthIdentity | null,
  repoFullName: string | undefined,
  repo: RepositoryRecord | null,
): Promise<Response | null> {
  /* v8 ignore next -- The broad route role guard already authenticates protected preview requests. */
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (identity.kind !== "session" || !repoFullName) return null;
  return requireSessionRepoAccess(c, identity, repoFullName, repo);
}

async function requireDiscoveryAccessForApi(c: ProtectedRouteContext, identity: AuthIdentity): Promise<Response | null> {
  if (identity.kind === "session") {
    if (isAuthorizedGitHubSessionLogin(c.env, identity.actor, identity.session?.githubUserId)) return null;
    const scope = await loadControlPanelAccessScope(c.env, identity.actor, identity.session?.githubUserId);
    if (scope.operator) return null;
    return c.json({ error: "forbidden", reason: "cross_repo_search_requires_discovery_access" }, 403);
  }
  if (identity.kind === "static" && identity.actor === "mcp" && !isMcpReadUnscoped(c.env.MCP_READ_REPO_ALLOWLIST)) {
    return c.json({ error: "forbidden", reason: "cross_repo_search_requires_unscoped_mcp_read" }, 403);
  }
  return null;
}

async function canApiAccessRepo(env: Env, identity: AuthIdentity, repoFullName: string): Promise<boolean> {
  if (identity.kind === "session") return canLoginAccessRepo(env, identity.actor, repoFullName, identity.session?.githubUserId);
  if (identity.kind === "static" && identity.actor === "mcp") {
    return isMcpReadRepoAllowed(env.MCP_READ_REPO_ALLOWLIST, repoFullName);
  }
  return true;
}

async function requireApiRepoReadAccess(
  c: ProtectedRouteContext,
  identity: AuthIdentity,
  repoFullName: string,
): Promise<Response | null> {
  if (await canApiAccessRepo(c.env, identity, repoFullName)) return null;
  return c.json({ error: "forbidden_repo" }, 403);
}

async function requireSessionRepoAccess(
  c: ProtectedRouteContext,
  identity: Extract<AuthIdentity, { kind: "session" }>,
  repoFullName: string,
  repo: RepositoryRecord | null,
): Promise<Response | null> {
  const summary = await loadControlPanelRoleSummary(c.env, identity.actor, identity.session?.githubUserId);
  if (summary.roles.includes("operator")) return null;
  const scope = await loadControlPanelAccessScope(c.env, identity.actor, identity.session?.githubUserId);
  const requestedRepo = repoFullName.toLowerCase();
  const scopedRepoNames = new Set(scope.repositoryFullNames.map((name) => name.toLowerCase()));
  if (scopedRepoNames.has(requestedRepo)) return null;
  if (repo && scope.accountLogins.some((login) => login.toLowerCase() === repo.owner.toLowerCase())) return null;
  return c.json({ error: "forbidden_repo" }, 403);
}

/** Gate a maintainer-scoped repo route: requires a maintainer/owner/operator role and, for session
 *  callers, access to that specific repo. Returns the resolved identity, or a Response to short-circuit. */
async function requireRepoMaintainer(c: ProtectedRouteContext, fullName: string): Promise<Response | { identity: AuthIdentity | null }> {
  const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
  if (forbidden) return forbidden;
  const identity = await authenticateRequestIdentity(c);
  if (identity?.kind === "session") {
    const repo = await getRepository(c.env, fullName);
    const repoForbidden = await requireSessionRepoAccess(c, identity, fullName, repo);
    if (repoForbidden) return repoForbidden;
  }
  return { identity };
}

// GitHub permissions that imply real write access to a repo (and thus authority to change repo-visible
// behavior or manage its secret BYOK key). "maintain"/"write"/"admin" can push; "triage"/"read"/"none" cannot.
const REPO_WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Stricter gate for repo-visible settings and secret-key status/writes. On top of the maintainer gate, a session caller
 * must have real GitHub write access to the repo — resolved via the installation, not merely inferred
 * from a PR author_association (which includes org MEMBER / read-only COLLABORATOR). Operators and
 * server-to-server tokens are exempt. Fails closed (403) if write access can't be verified.
 */
async function requireRepoWriteAccess(c: ProtectedRouteContext, fullName: string): Promise<Response | { identity: AuthIdentity | null }> {
  const gate = await requireRepoMaintainer(c, fullName);
  if (gate instanceof Response) return gate;
  if (gate.identity?.kind !== "session") return gate; // server-to-server token: no per-repo push check
  const summary = await loadControlPanelRoleSummary(c.env, gate.identity.actor, gate.identity.session?.githubUserId);
  if (summary.roles.includes("operator")) return gate; // operators manage any repo
  const repo = await getRepository(c.env, fullName);
  const installationId = repo?.installationId ?? null;
  let permission: string | null = null;
  if (installationId !== null) {
    try {
      permission = await getRepositoryCollaboratorPermission(c.env, installationId, fullName, gate.identity.actor);
    } catch {
      /* v8 ignore next -- defensive: a GitHub permission-check failure fails closed (→ 403 below) */
      permission = null;
    }
  }
  if (!permission || !REPO_WRITE_PERMISSIONS.has(permission)) {
    return c.json({ error: "insufficient_repo_permission" }, 403);
  }
  return gate;
}

async function skippedPrAuditRepoScope(
  c: ProtectedRouteContext,
  identity: AuthIdentity,
  roles: ControlPanelRoleName[],
  requestedRepo: string | undefined,
): Promise<string[] | undefined | Response> {
  if (identity.kind !== "session" || roles.includes("operator")) return requestedRepo ? [requestedRepo] : undefined;
  const scope = await loadControlPanelAccessScope(c.env, identity.actor, identity.session?.githubUserId);
  const scopedRepoNames = new Set(scope.repositoryFullNames.map((name) => name.toLowerCase()));
  if (requestedRepo) {
    return scopedRepoNames.has(requestedRepo.toLowerCase()) ? [requestedRepo] : c.json({ error: "forbidden_repo" }, 403);
  }
  return scope.repositoryFullNames;
}

function toIsoQueryDate(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}


/**
 * #9046: the SINGLE authorization rule for every telemetry-collector ingest endpoint (Orb and AMS), so the two
 * products cannot drift apart again. They previously had separate, near-identical copies — and AMS ended up
 * BOTH fail-open AND missing from the strict rate class, purely because it was a second copy nobody kept in
 * lockstep. Any future collector route gets the correct posture by calling this rather than hand-rolling it;
 * the per-product secret stays separate (passed in) so the two credentials rotate independently.
 *
 * FAILS CLOSED when the token is unset. Both copies previously returned `true` for an unset token — the
 * shipped default — so anyone with network access could POST batches, and Orb's batches feed the PUBLISHED
 * accuracy numbers. Network isolation was doing all the work (the tunnel exposes only the shot path, 8787
 * binds to loopback), which the planned hosted Orb removes. An unconfigured collector now rejects rather than
 * accepting anonymous writes; operators who want ingest set the secret, matching every other credentialed
 * surface here. Constant-time compare (mirrors auth/security) — a `===` is timing-attack vulnerable for a
 * shared secret.
 */
async function isAuthorizedIngest(configuredToken: string | undefined, presentedToken: string | undefined): Promise<boolean> {
  if (!configuredToken) return false;
  return timingSafeEqual(presentedToken, configuredToken);
}


// Unauthenticated, cookie-free, aggregate-only public GET endpoints (health check, homepage stats counter,
// per-repo public stats badge) -- open to any origin via a separate, credential-free CORS branch above.
// Every other route stays on the strict exact-match allowlist + Access-Control-Allow-Credentials, since a
// wildcard origin there would let any third party hosted on the SAME shared platform (a fresh
// *.workers.dev/*.pages.dev preview build isn't the only thing that can land on those suffixes) ride an
// authenticated user's session cookie cross-origin.
function isPublicNoCredentialRoute(path: string): boolean {
  if (path === "/health") return true;
  if (path === "/v1/public/stats") return true;
  if (/^\/v1\/public\/github\/repos\/[^/]+\/[^/]+\/stats$/.test(path)) return true;
  return false;
}

const DEFAULT_CORS_ORIGINS = [
  "https://loopover.ai",
  "https://api.loopover.ai",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  // loopover-ui's dev server (@lovable.dev/vite-tanstack-config) binds 8080, not Vite's 5173 default —
  // without this, every local/preview dev server is CORS-blocked from /health and shows a false "API unreachable" banner.
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8080",
] as const;

function allowedCorsOrigin(env: Env, origin: string | undefined): string | null {
  if (!origin) return null;
  const allowed = new Set<string>(DEFAULT_CORS_ORIGINS);
  for (const configured of [env.PUBLIC_API_ORIGIN, env.PUBLIC_SITE_ORIGIN]) {
    const normalized = normalizeOrigin(configured);
    if (normalized) allowed.add(normalized);
  }
  return [...allowed].find((allowedOrigin) => allowedOrigin === origin) ?? null;
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
