import { Hono, type Context } from "hono";
import { sentry } from "@sentry/hono/cloudflare";
import { z } from "zod";
import { parsePositiveInt } from "../utils/json";
import { analyzePRQueue, type AuthorRole, type ChecksStatus } from "../queue-intelligence";
import { completeGitHubWebOAuth, createSessionFromGitHubToken, getLiveSessionGitHubToken, pollGitHubDeviceFlow, startGitHubDeviceFlow, startGitHubWebOAuth } from "../auth/github-oauth";
import { enforceRateLimit, routeClassForPath } from "../auth/rate-limit";
import { handleShot } from "../review/visual/shot";
import { isScreenshotsEnabled } from "../review/visual-wire";
import { buildFindingTaxonomyDocument } from "../review/finding-taxonomy";
import { buildEnrichmentAnalyzersTaxonomyDocument } from "../review/enrichment-analyzers-taxonomy";
import {
  BROWSER_SESSION_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE,
  authenticateInternalToken,
  authenticatePrivateToken,
  authenticateSessionToken,
  buildBrowserSessionCookie,
  buildClearedBrowserSessionCookie,
  buildClearedGitHubOAuthStateCookie,
  buildGitHubOAuthStateCookie,
  createSessionForGitHubUser,
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
import { SCENARIO_MAX_BRANCH_REF_CHARS, SCENARIO_MAX_LINKED_ISSUE_NUMBERS, SCENARIO_MAX_REPO_FULL_NAME_CHARS } from "../scenarios/input-model";
import {
  countOpenIssues,
  countOpenPullRequests,
  countActiveAuthSessions,
  countActiveDigestSubscriptions,
  countRecentAuditEventsForActorAndTarget,
  getBounty,
  getAgentCommandAnswer,
  getCommandUsefulnessSummary,
  getFreshOfficialMinerDetection,
  getIssue,
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
  MAX_NOTIFICATION_DELIVERY_ID_LENGTH,
  MAX_NOTIFICATION_MARK_READ_IDS,
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
  summarizeProductUsageEvents,
  upsertDigestSubscription,
  upsertBounty,
  upsertContributorEvidence,
  upsertContributorScoringProfile,
  upsertRepositorySettings,
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
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
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
import { handleOrbIngest, readOrbIngestBody } from "../orb/ingest";
import { handleAmsIngest } from "../ams/ingest";
import { handleOrbWebhook } from "../orb/webhook";
import { handleOrbOAuthCallback } from "../orb/oauth";
import { brokerOrbToken, isOrbBrokerEnabled, issueOrbEnrollment } from "../orb/broker";
import {
  enqueueConfigPushRelay,
  MAX_ORB_RELAY_REGISTER_BODY_BYTES,
  pruneRelayPending,
  pullRelayPending,
  readOrbRelayRegisterBody,
  registerValidatedOrbRelay,
  validateOrbRelayEnrollment,
} from "../orb/relay";
import { computeFleetAnalytics } from "../orb/analytics";
import { handleMcpRequest } from "../mcp/server";
import { simulateOpenPrPressureShape } from "../mcp/server";
import { simulateOpenPrPressure, type OpenPrPressureInput } from "../services/open-pr-pressure-scenarios";
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
  loadControlPanelAccessScope,
  loadControlPanelRoleSummary,
} from "../services/control-panel-roles";
import { runFindOpportunities, validateFindOpportunitiesInput, type FindOpportunitiesInput } from "../mcp/find-opportunities";
import { runIssueRagRetrieval, validateIssueRagInput, type IssueRagInput } from "../mcp/issue-rag";
import { buildBoundaryTestGenerationFinding, buildBoundaryTestGenerationSpec } from "../signals/boundary-test-generation";
import { buildTestEvidenceReport } from "../signals/test-evidence";
import { buildStructuralImprovementAssessment } from "../signals/improvement";
import { evaluateEscalation } from "../loop-escalation";
import { buildResultsPayload } from "../results-payload";
import { buildProgressSnapshot } from "../loop-progress";
import { validateIdeaSubmission, buildTaskGraph, buildClaimPlan } from "../idea-intake";
import { loadPrAiReviewFindings } from "../mcp/pr-ai-review-findings";
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
  buildWeeklyValueReport,
  formatWeeklyValueReportMarkdown,
  generateWeeklyValueReport,
  loadWeeklyValueReport,
} from "../services/weekly-value-report";
import { generateAndSendReviewRecap } from "../services/review-recap";
import { loadOrComputeIssueQualityResponse } from "../services/issue-quality";
import { loadMaintainerNoiseReport } from "../services/maintainer-noise";
import { buildAmsMinerCohortComparison } from "../review/ams-miner-cohort";
import { loadOrComputeBurdenForecastResponse } from "../services/burden-forecast";
import { buildUnavailableQueueTrendReport } from "../services/queue-trends";
import { loadOrComputeRepoOutcomePatternsResponse } from "../services/repo-outcome-patterns";
import { PREFLIGHT_LIMITS } from "../signals/preflight-limits";
import {
  buildBountyAdvisory,
  buildBurdenForecast,
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
  buildRoleContext,
  buildPreflightResult,
  buildQueueHealth,
  buildRegistryChangeReport,
  buildContributorOpportunities,
  buildPublicReadinessScore,
  type ContributorOutcomeHistory,
  type IssueQualityReport,
  type PullRequestMaintainerPacket,
  type RoleContext,
} from "../signals/engine";
import {
  buildExtensionIssueFit,
  buildExtensionIssueBadges,
  buildExtensionPrStatus,
} from "../signals/extension-contributor-context";
import { attachDataQuality, buildCoreSignalFidelity, buildFreshnessSloReport, buildRepoDataQuality, buildSignalFidelity } from "../signals/data-quality";
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildContributorPrOutcomes } from "../signals/contributor-pr-outcomes";
import { buildReviewRiskExplanation } from "../signals/review-risk";
import { buildNotificationFeed } from "../notifications/service";
import { buildPullRequestReviewability, type PullRequestReviewability } from "../signals/reward-risk";
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
import { handleInternalCalibration, handleInternalDecision, type OpsAgentConfig } from "../review/ops";
import { computeParityReadiness, isParityAuditEnabled } from "../review/parity-wire";
import { computePredictedGateAgreement } from "../review/predicted-gate-agreement";
import { computeContributorGateEval, contributorFairnessFlags } from "../review/contributor-gate-eval";
import { getContributorTrustProfile } from "../review/contributor-trust-profile";
import { backfillContributorGateHistory } from "../review/contributor-gate-history-backfill";
import { isFairnessAnalyticsEnabled, resolveFairnessAnalyticsManifestOverride } from "../review/contributor-trust-profile-wire";
import { isRagEnabled } from "../review/rag-wire";
import { getPublicStats, isPublicStatsEnabled, resolvePublicStatsManifestOverride } from "../review/public-stats";
import { loadPublicAccuracyTrend } from "../services/public-accuracy-trend";
import { loadPublicReuseRateTrend } from "../services/public-reuse-rate-trend";
import { loadPublicReviewVolumeTrend } from "../services/public-review-volume-trend";
import { buildMaintainerQualityDashboard, isMaintainerQualityDataStale } from "../services/maintainer-quality-dashboard";
import { buildMaintainerSlopDuplicateTrend, SLOP_DUPLICATE_TREND_SNAPSHOT_LIMIT } from "../services/maintainer-slop-duplicate-trend";
import { buildFederatedBenchmark } from "../orb/federated-benchmark";
import { resolveLoopOverSelfRepoFullName } from "../config/loopover-repo-focus-manifest";
import { buildGateOutcomeBreakdown, GATE_OUTCOME_BREAKDOWN_WINDOW_DAYS } from "../services/gate-outcome-breakdown";
import { MAX_LOCAL_SCORER_WARNING_CHARS, MAX_LOCAL_SCORER_WARNING_COUNT } from "../signals/local-scorer-diagnostics";
import { compileFocusManifestPolicy, MAX_FOCUS_MANIFEST_BYTES, resolveEffectiveSettings } from "../signals/focus-manifest";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { loadPublicRepoFocusManifest, loadRepoFocusManifest, upsertRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildRepoOnboardingPackPreviewForRepo } from "../services/repo-onboarding-pack";
import { generateContributorIssueDrafts } from "../services/contributor-issue-draft";
import { buildRepoSettingsPreview, PUBLIC_SURFACE_SKIP_REASONS, skippedPrAuditRemediation } from "../signals/settings-preview";
import {
  buildGittensorConfigRecommendation,
  buildRegistrationReadiness,
  type InstallationHealthSummary,
  type RegistrationReadinessReport,
} from "../signals/registration-readiness";
import { fileUpstreamDriftIssues, loadUpstreamStatus, refreshUpstreamDrift, registryHyperparameterDriftWarningsForRepo, resolveAutoFileDriftIssuesManifestOverride } from "../upstream/ruleset";
import type {
  BountyLifecycleEventRecord,
  ControlPanelRoleName,
  ContributorEvidenceRecord,
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
const QUEUE_INTELLIGENCE_MAX_BODY_BYTES = 1024 * 1024;
const QUEUE_INTELLIGENCE_MAX_PULL_REQUESTS = 250;
const QUEUE_INTELLIGENCE_MAX_AUTHOR_LENGTH = 100;
const QUEUE_INTELLIGENCE_MAX_TITLE_LENGTH = 300;
const QUEUE_INTELLIGENCE_MAX_BODY_LENGTH = 4000;
const QUEUE_INTELLIGENCE_MAX_DUPLICATE_CANDIDATES = 25;

function isJsonByteLengthWithinLimit(value: unknown, maxBytes: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

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

const MAX_LOCAL_BRANCH_REF_CHARS = 256;
const MAX_LOCAL_BRANCH_TEXT_CHARS = 4000;

// #6745: body of POST /v1/contributors/:login/notifications/read. Mirrors markNotificationsReadShape
// (src/mcp/server.ts) minus `login` (which is the path param): `ids` is optional (absent = mark all delivered).
const markNotificationsReadBodySchema = z.object({
  ids: z.array(z.string().min(1).max(MAX_NOTIFICATION_DELIVERY_ID_LENGTH)).max(MAX_NOTIFICATION_MARK_READ_IDS).optional(),
});

// #6746: body of POST/DELETE /v1/contributors/:login/watches. Mirrors watchIssuesShape (src/mcp/server.ts) minus
// `login` (path param) and `action` (the HTTP verb). `labels` is POST-only (a DELETE ignores it).
const watchSubscriptionBodySchema = z.object({
  repoFullName: z.string().min(3).max(200),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
});

const preflightSchema = z.object({
  repoFullName: z.string().min(3).max(PREFLIGHT_LIMITS.repoFullNameChars),
  contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(PREFLIGHT_LIMITS.linkedIssues).optional(),
  tests: z.array(z.string().max(PREFLIGHT_LIMITS.testChars)).max(PREFLIGHT_LIMITS.tests).optional(),
  authorAssociation: z.string().max(PREFLIGHT_LIMITS.authorAssociationChars).optional(),
});

const localDiffPreflightSchema = preflightSchema.extend({
  changedLineCount: z.number().int().min(0).optional(),
  testFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  commitMessage: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
});

const validateLinkedIssueSchema = z.object({
  issueNumber: z.number().int().positive(),
  plannedChange: z
    .object({
      title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars).optional(),
      changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
      contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
    })
    .optional(),
});

const checkBeforeStartSchema = z.object({
  issueNumber: z.number().int().positive().optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars).optional(),
  plannedPaths: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
});

const lintPrTextSchema = z.object({
  commitMessages: z.array(z.string().max(PREFLIGHT_LIMITS.bodyChars)).max(50).optional(),
  prBody: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  linkedIssue: z.number().int().positive().optional(),
});

const validateFocusManifestSchema = z.object({
  content: z.string().max(256 * 1024),
  source: z.enum(["repo_file", "api_record", "none"]).optional(),
});

// Pure local-metadata slop self-checks (no repo data, no secrets) — mirror the loopover_check_slop_risk /
// loopover_check_issue_slop MCP tools so the npm package can offer the same agent-native self-check.
// #6754: mirrors the loopover_evaluate_escalation MCP tool's input shape exactly (src/mcp/server.ts) so the
// REST surface can never accept something the tool would reject, or vice versa.
const evaluateEscalationSchema = z.object({
  runStatus: z.enum(["running", "converged", "abandoned", "error"]),
  healthStatus: z.enum(["healthy", "degraded", "critical"]).optional(),
  customerFlagged: z.boolean().optional(),
  killRequested: z.boolean().optional(),
});

// #6744: mirrors proposeActionShape in src/mcp/server.ts VERBATIM, minus owner/repo (they are path params), so
// POST /v1/repos/:owner/:repo/agent/pending-actions can never stage an action the loopover_propose_action MCP
// tool would reject, or vice versa. actionClass stays the 7-value propose set (a subset of AgentActionClass).
const proposePendingActionSchema = z.object({
  pullNumber: z.number().int().positive(),
  actionClass: z.enum(["review", "request_changes", "approve", "merge", "close", "label", "review_state_label"]),
  reason: z.string().max(500).optional(),
  label: z.string().min(1).max(100).optional(),
  reviewBody: z.string().max(60000).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  closeComment: z.string().max(60000).optional(),
});

// #6755: mirrors intakeIdeaShape in src/mcp/server.ts VERBATIM. Fields are deliberately LOOSE here for the same
// reason they are on the tool: the engine's validateIdeaSubmission owns the real bounds/format checks and returns
// the actionable error list, so an empty/malformed submission must reach the handler rather than be rejected
// upstream by the schema.
const intakeIdeaSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  targetRepo: z.string().optional(),
  constraints: z.array(z.string()).max(50).optional(),
  acceptanceHints: z.array(z.string()).max(50).optional(),
  priority: z.string().optional(),
  decomposition: z
    .array(z.object({ key: z.string(), title: z.string(), body: z.string(), dependsOn: z.array(z.string()).max(50).optional() }))
    .max(50)
    .optional(),
});

// #6752: mirrors buildResultsPayloadShape in src/mcp/server.ts VERBATIM (same bounds, same optionality) so the
// REST surface can never accept an input the MCP tool would reject, or vice versa.
const resultsPayloadSchema = z.object({
  repoFullName: z.string().min(1),
  prNumber: z.number().int().nullable().optional(),
  title: z.string(),
  changedFiles: z
    .array(z.object({ path: z.string(), additions: z.number().int().optional(), deletions: z.number().int().optional() }))
    .max(5000)
    .optional(),
  status: z.enum(["open", "merged", "closed"]).optional(),
});

// #6753: mirrors buildProgressSnapshotShape in src/mcp/server.ts VERBATIM (same bounds, same optionality) so the
// REST surface can never accept an input the MCP tool would reject, or vice versa.
const progressSnapshotSchema = z.object({
  iteration: z.number().int(),
  maxIterations: z.number().int().nullable().optional(),
  phase: z.enum(["queued", "claiming", "coding", "reviewing", "submitting", "done"]),
  status: z.enum(["running", "converged", "abandoned", "error"]),
  recentActivity: z
    .array(z.object({ step: z.string(), detail: z.string().optional(), at: z.string().optional() }))
    .max(1000)
    .optional(),
});

// #6749: mirrors checkTestEvidenceShape in src/mcp/server.ts VERBATIM (same bounds, same optionality) so the
// REST surface can never accept an input the MCP tool would reject, or vice versa.
const testEvidenceSchema = z.object({
  changedPaths: z.array(z.string().min(1).max(400)).max(2000),
  testFiles: z.array(z.string().min(1).max(400)).max(2000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
});

// #6750: mirrors suggestBoundaryTestsShape in src/mcp/server.ts VERBATIM (same bounds, same .strict()
// objects, same optionality) so the REST surface can never accept an input the MCP tool would reject.
const boundaryTestsSchema = z.object({
  changedFiles: z.array(z.object({ path: z.string().min(1).max(400) }).strict()).max(500),
  boundaryTouches: z
    .array(
      z
        .object({
          path: z.string().min(1).max(400),
          kind: z.enum(["array_index_bounds", "null_or_undefined_branch", "empty_collection_check"]),
        })
        .strict(),
    )
    .max(20)
    .optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
});

const slopRiskSchema = z.object({
  changedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
    .max(2000)
    .optional(),
  description: z.string().max(20000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
  commitMessages: z.array(z.string().max(2000)).max(200).optional(),
  hasLinkedIssue: z.boolean().optional(),
  issueDiscoveryLane: z.boolean().optional(),
});

// #6748: mirrors checkImprovementPotentialShape in src/mcp/server.ts VERBATIM (same bounds, same optionality)
// so the REST surface can never accept an input the MCP tool would reject, or vice versa.
const improvementPotentialSchema = z.object({
  changedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
    .max(2000)
    .optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
  patchCoverageDeltaPercent: z.number().optional(),
  complexityDeltas: z
    .array(
      z.object({
        file: z.string().min(1).max(400),
        line: z.number().int().min(1),
        name: z.string().min(1).max(400),
        before: z.number().int().min(0),
        after: z.number().int().min(0),
        delta: z.number().int(),
      }),
    )
    .max(2000)
    .optional(),
  duplicationDeltas: z
    .array(
      z.object({
        file: z.string().min(1).max(400),
        line: z.number().int().min(1),
        duplicateOfLine: z.number().int().min(1),
        lines: z.number().int().min(1),
      }),
    )
    .max(2000)
    .optional(),
});
const issueSlopSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(40000).optional(),
});

const selfhostDeadLetterQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
  })
  .strict();

const skippedPrAuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    repoFullName: z.string().trim().min(3).max(200).optional(),
    reason: z.enum(PUBLIC_SURFACE_SKIP_REASONS).optional(),
    since: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const localBranchChangedFileSchema = z
  .object({
    path: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS),
    previousPath: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
    binary: z.boolean().optional(),
  })
  .strict();

const localBranchValidationSchema = z
  .object({
    command: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS),
    status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
    summary: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    durationMs: z.number().int().min(0).optional(),
    exitCode: z.number().int().min(0).optional(),
  })
  .strict();

const localBranchScorerSchema = z
  .object({
    mode: z.enum(["metadata_only", "external_command", "gittensor_root"]),
    activeModel: z.string().max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    sourceTokenScore: z.number().min(0).optional(),
    totalTokenScore: z.number().min(0).optional(),
    sourceLines: z.number().min(0).optional(),
    testTokenScore: z.number().min(0).optional(),
    nonCodeTokenScore: z.number().min(0).optional(),
    nonCodeLines: z.number().min(0).optional(),
    warnings: z.array(z.string().max(MAX_LOCAL_SCORER_WARNING_CHARS)).max(MAX_LOCAL_SCORER_WARNING_COUNT).optional(),
  })
  .strict();

const linkedIssueContextSchema = z
  .object({
    status: z.enum(["raw", "plausible", "validated", "invalid", "unavailable"]).optional(),
    source: z.enum(["user_supplied", "official_mirror", "github_cache", "issue_quality", "missing"]).optional(),
    issueNumbers: z.array(z.number().int().positive()).max(50).optional(),
    solvedByPullRequests: z.array(z.number().int().positive()).max(50).optional(),
    reason: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    warnings: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(20).optional(),
  })
  .strict();

const branchEligibilitySchema = z
  .object({
    status: z.enum(["eligible", "ineligible", "unknown"]),
    source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
    reason: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    checkedAt: z.string().max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    stale: z.boolean().optional(),
  })
  .strict()
  .transform((value) => ({ ...value, status: value.status === "eligible" ? ("unknown" as const) : value.status, source: "user_supplied" as const }));

const focusManifestInputSchema = z
  .record(z.string(), z.unknown())
  .refine((manifest) => isJsonByteLengthWithinLimit(manifest, MAX_FOCUS_MANIFEST_BYTES), {
    message: `focusManifest must serialize to ${MAX_FOCUS_MANIFEST_BYTES} bytes or fewer`,
  });

export const localBranchAnalysisSchema = z
  .object({
    login: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS),
    repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
    baseRef: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
    headRef: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
    branchName: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
    baseSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    headSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    mergeBaseSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    remoteTrackingSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    commitMessages: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(30).optional(),
    changedFiles: z.array(localBranchChangedFileSchema).max(500).optional(),
    validation: z.array(localBranchValidationSchema).max(50).optional(),
    linkedIssues: z.array(z.number().int().positive()).max(SCENARIO_MAX_LINKED_ISSUE_NUMBERS).optional(),
    labels: z.array(z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS)).max(50).optional(),
    title: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    body: z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS).optional(),
    localScorer: localBranchScorerSchema.optional(),
    pendingMergedPrCount: z.number().int().min(0).optional(),
    pendingClosedPrCount: z.number().int().min(0).optional(),
    approvedPrCount: z.number().int().min(0).optional(),
    expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
    projectedCredibility: z.number().min(0).max(1).optional(),
    scenarioNotes: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(20).optional(),
    pendingCommitCount: z.number().int().min(0).optional(),
    ciStatusHints: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(20).optional(),
    focusManifest: focusManifestInputSchema.optional(),
    branchEligibility: branchEligibilitySchema.optional(),
  })
  .strict();

const scorePreviewSchema = z.object({
  repoFullName: z.string().min(3),
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("planned_pr"),
  targetKey: z.string().optional(),
  contributorLogin: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  linkedIssueContext: linkedIssueContextSchema.optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  testTokenScore: z.number().min(0).optional(),
  nonCodeTokenScore: z.number().min(0).optional(),
  nonCodeLines: z.number().min(0).optional(),
  existingContributorTokenScore: z.number().min(0).optional(),
  prAgeHours: z.number().min(0).optional(),
  openPrCount: z.number().int().min(0).optional(),
  mergedPullRequests: z.number().int().min(0).optional(),
  validSolvedIssues: z.number().int().min(0).optional(),
  issueCredibility: z.number().min(0).max(1).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  duplicateRiskCount: z.number().int().min(0).optional(),
  fixedBaseScore: z.number().min(0).optional(),
  metadataOnly: z.boolean().default(false),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  branchEligibility: branchEligibilitySchema.optional(),
});

const agentSurfaceSchema = z.enum(["api", "mcp", "github_comment"]).default("api");

const agentRunSchema = z
  .object({
    objective: z.string().min(1).max(500),
    actorLogin: z.string().min(1),
    surface: agentSurfaceSchema.optional(),
    target: z
      .object({
        repoFullName: z.string().min(3).optional(),
        pullNumber: z.number().int().positive().optional(),
        issueNumber: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const agentPlanSchema = z
  .object({
    login: z.string().min(1),
    objective: z.string().min(1).max(500).optional(),
    repoFullName: z.string().min(3).optional(),
    surface: agentSurfaceSchema.optional(),
  })
  .strict();

const agentExplainBlockersSchema = z.union([localBranchAnalysisSchema, agentPlanSchema]);

// reviewCheckMode/linkedIssueGateMode/duplicatePrGateMode/qualityGateMode/qualityGateMinScore/
// aiReviewMode/aiReviewByok/aiReviewProvider/aiReviewModel/aiReviewAllAuthors removed from this write
// schema (Batch C, loopover#6444) -- config-as-code only via .loopover.yml's gate.* block now;
// upsertRepositorySettings no longer has a DB column to write any of them into.
const repositorySettingsSchema = z.object({
  gatePack: z.enum(["gittensor", "oss-anti-slop"]).default("gittensor"),
  aiReviewLowConfidenceDisposition: z.enum(["one_shot", "hold_for_review", "advisory_only"]).default("hold_for_review"),
  closeOwnerAuthors: z.boolean().default(false),
  autoLabelEnabled: z.boolean().default(true),
  // #6443: gittensorLabel/blacklistLabel/createMissingLabel/contributorBlacklist removed -- no longer
  // DB-backed, config-as-code only via .loopover.yml's settings: block now.
  requireLinkedIssue: z.boolean().default(false),
  commandAuthorization: z
    .object({
      default: z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4).optional(),
      commands: z.record(z.string().trim().min(1).max(64), z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4)).optional(),
    })
    .default(DEFAULT_COMMAND_AUTHORIZATION_POLICY),
});

// #130 maintainer self-serve settings editor. A PATCH-style subset: every field optional so the maintainer
// dashboard can save just the group it changed. Excludes the secret-bearing aiReview* group (set via the
// dedicated /ai-review + /ai-key routes) and the operator-only scoring internal (backfillEnabled). The
// handler loads current settings and merges, since upsertRepositorySettings defaults any absent field
// rather than preserving it.
// reviewCheckMode/linkedIssueGateMode/duplicatePrGateMode/qualityGateMode/qualityGateMinScore/
// selfAuthoredLinkedIssueGateMode removed from this write schema (Batch C, loopover#6444) --
// config-as-code only via .loopover.yml's gate.* block now.
const maintainerSettingsSchema = z
  .object({
    gatePack: z.enum(["gittensor", "oss-anti-slop"]),
    mergeReadinessGateMode: z.enum(["off", "advisory", "block"]),
    manifestPolicyGateMode: z.enum(["off", "advisory", "block"]),
    linkedIssueSatisfactionGateMode: z.enum(["off", "advisory", "block"]),
    // #6443: mergeTrainMode/gittensorLabel/blacklistLabel/createMissingLabel removed -- no longer DB-backed,
    // config-as-code only via .loopover.yml's settings: block now.
    // #6446: firstTimeContributorGrace removed -- a dead, never-wired RESERVED/INERT field (#2266); deleted
    // rather than wired in, since the gate's one-shot design deliberately never softens a blocker for a
    // newcomer.
    slopGateMode: z.enum(["off", "advisory", "block"]),
    slopGateMinScore: z.number().int().min(0).max(100).nullable(),
    slopAiAdvisory: z.boolean(),
    autoLabelEnabled: z.boolean(),
    closeOwnerAuthors: z.boolean(),
    requireLinkedIssue: z.boolean(),
    agentPaused: z.boolean(),
    agentDryRun: z.boolean(),
    requireFreshRebaseWindowMinutes: z.number().int().positive().nullable(),
    commandAuthorization: z.object({
      default: z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4).optional(),
      commands: z.record(z.string().trim().min(1).max(64), z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4)).optional(),
    }),
    // Agent-layer config (#773/#774). The DB layer normalizes autonomy (deny-by-default), so a loose
    // record here is safe — invalid entries are dropped on persist.
    // #6445: autoMaintain removed -- no longer DB-backed, config-as-code only via .loopover.yml's
    // settings: block now.
    autonomy: z.record(z.string().trim().min(1).max(32), z.enum(["observe", "auto_with_approval", "auto"])),
  })
  .partial();

// downgradeQualityGateMode (the settings-write-path "block" -> "advisory" downgrade for
// qualityGateMode/#2267) was removed here: qualityGateMode is config-as-code only now (Batch C,
// loopover#6444), so no write path sets it anymore. resolveEffectiveSettings's own downgrade logic
// (src/signals/focus-manifest.ts) still applies the same rule on the read/resolver path.

// Maintainer BYOK provider key. Write-only: the key is encrypted at rest and never returned. A loose
// prefix check catches the common provider/key mismatch (e.g. pasting an OpenAI key under Anthropic)
// without coupling to exact provider key formats: Anthropic keys start with `sk-ant-`; OpenAI keys
// start with `sk-` but never `sk-ant-`.
const repositoryAiKeySchema = z
  .object({
    provider: z.enum(["anthropic", "openai"]),
    key: z.string().trim().min(20).max(400),
    model: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .refine((value) => (value.provider === "anthropic" ? value.key.startsWith("sk-ant-") : value.key.startsWith("sk-") && !value.key.startsWith("sk-ant-")), {
    message: "API key does not match the selected provider (Anthropic keys start with sk-ant-, OpenAI keys start with sk-).",
    path: ["key"],
  });

// Linear personal API key (#3186) -- no provider-prefix assertion (unlike the AI-key schema above): Linear's
// key format is not a stable enough public contract to hard-validate against, so only a length bound applies.
const repositoryLinearKeySchema = z.object({
  key: z.string().trim().min(20).max(400),
});

// Maintainer-settable AI-review config. mode/byok/provider/model/allAuthors are config-as-code only now
// (Batch C, loopover#6444) -- set via a repo's own .loopover.yml gate.aiReview.* block, not this route --
// so they are intentionally NOT accepted here anymore (a caller submitting the old shape gets a clean
// validation error naming the current route, not a silently-ignored write). The secret key is set
// separately via the ai-key route; never here.
const repositoryAiReviewSchema = z
  .object({
    closeOwnerAuthors: z.boolean().optional(),
    // Disposition for a sub-aiReviewCloseConfidence-floor ai_consensus_defect/ai_review_split finding (#4603).
    // Optional -- upsertRepositorySettings applies its own "hold_for_review" default when omitted.
    lowConfidenceDisposition: z.enum(["one_shot", "hold_for_review", "advisory_only"]).optional(),
  })
  // .strict() so a caller still sending the pre-Batch-C shape (mode/byok/provider/model/allAuthors) gets
  // an immediate "unrecognized key" validation error naming exactly which fields moved, instead of those
  // keys being silently dropped and the request appearing to partially succeed.
  .strict();

const contributorIssueDraftGenerateSchema = z.object({
  dryRun: z.boolean().optional().default(true),
  create: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

const settingsPreviewSchema = z.object({
  sample: z
    .object({
      authorLogin: z.string().trim().min(1).max(100).optional(),
      authorType: z.enum(["User", "Bot"]).optional(),
      authorAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
      minerStatus: z.enum(["confirmed", "not_found", "unavailable"]).optional(),
      title: z.string().max(300).optional(),
      body: z.string().max(10000).nullable().optional(),
      labels: z.array(z.string().max(100)).max(50).optional(),
      linkedIssues: z.array(z.number().int().positive()).max(50).optional(),
      commandName: z.string().trim().min(1).max(64).optional(),
      commenterLogin: z.string().trim().min(1).max(100).optional(),
      commenterAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
    })
    .optional(),
});

const chatQaRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
  })
  .strict();

const commandPreviewSchema = z
  .object({
    command: z.string().min(1).max(80),
    repoFullName: z.string().min(3).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    pullNumber: z.number().int().positive().optional(),
    login: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    sample: z
      .object({
        authorLogin: z.string().trim().min(1).max(100).optional(),
        authorType: z.enum(["User", "Bot"]).optional(),
        authorAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
        commenterLogin: z.string().trim().min(1).max(100).optional(),
        commenterAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]).optional(),
        minerStatus: z.enum(["confirmed", "not_found", "unavailable"]).optional(),
        title: z.string().max(300).optional(),
        body: z.string().max(10000).nullable().optional(),
        labels: z.array(z.string().max(100)).max(50).optional(),
        linkedIssues: z.array(z.number().int().positive()).max(50).optional(),
        permissions: z.record(z.string(), z.string()).optional(),
        missingPermissions: z.array(z.string().max(100)).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const commandFeedbackSchema = z
  .object({
    answerId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
    vote: z.enum(["useful", "not_useful"]),
  })
  .strict();

const killSwitchUpdateSchema = z
  .object({
    frozen: z.boolean(),
  })
  .strict();

// Config-push write path (#7522, piece 1 of #4902's design): an operator-addressed Orb-operational notice
// (enrollment lifecycle, capability announcement, deprecation notice) -- explicit installationIds target list
// only, no percentage/canary selector (no rollout-percentage primitive exists in this codebase to build one on
// top of; out of scope here). pushId doubles as the idempotency key (see enqueueConfigPushRelay's deliveryId
// derivation), so it's constrained to the same safe-identifier shape as commandFeedbackSchema's answerId above.
const configPushSchema = z
  .object({
    installationIds: z.array(z.number().int().positive()).min(1).max(500),
    pushId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
    message: z.string().min(1).max(500),
    capability: z.string().min(1).max(120).optional(),
    deprecatesAt: z.string().datetime().optional(),
  })
  .strict();

const digestSubscriptionSchema = z
  .object({
    email: z.string().email().max(320),
  })
  .strict();

const postMergeIncidentSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

const postMergeIncidentReportSchema = z
  .object({
    description: z.string().min(1).max(4000),
    severity: postMergeIncidentSeveritySchema,
    mergedSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i)
      .optional(),
  })
  .strict();

const operatorPostMergeIncidentReportSchema = z
  .object({
    repoFullName: z.string().min(3).max(200),
    pullNumber: z.number().int().positive(),
    description: z.string().min(1).max(4000),
    severity: postMergeIncidentSeveritySchema,
    mergedSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i)
      .optional(),
  })
  .strict();

function contributorOpenIssueCount(issues: Array<{ repoFullName: string; state: string }>, repoFullName: string): number {
  const targetRepo = repoFullName.toLowerCase();
  return issues.filter((issue) => issue.repoFullName.toLowerCase() === targetRepo && issue.state === "open").length;
}

/** True only inside a genuine Cloudflare Workers isolate (the `global_navigator` compat flag, on by default
 *  for this project's compatibility_date, sets `navigator.userAgent` to this exact literal -- Cloudflare's own
 *  documented idiom for this check). Self-host's server.ts calls the SAME exported `worker.fetch` this app
 *  produces (it synthesizes a Worker-shaped `env` by spreading `process.env` specifically so it can reuse this
 *  handler byte-for-byte) -- gating the Cloudflare-only Sentry middleware on this, rather than on env var
 *  presence alone, is what keeps it from ever activating inside a self-hoster's own Node process. */
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
  // Registered FIRST/outermost (Sentry's own guidance) so it wraps every other middleware and route below,
  // including a thrown exception from the CORS/rate-limit middleware right after this. No-ops completely
  // outside a real Workers isolate (see isCloudflareWorkerRuntime) and when WORKER_SENTRY_DSN is unset -- this
  // is the Worker-side counterpart to self-host's own initSentry()/installStructuredLogForwarding(), which
  // this Worker has never had any equivalent of despite being the actual central Orb broker server.
  /* v8 ignore start -- the TRUE branch only genuinely exercises inside a real Workers isolate (this vitest
   * run is Node); covered instead by test/workers/worker-runtime.test.ts, which runs under
   * @cloudflare/vitest-pool-workers and is NOT part of this coverage-instrumented run. isCloudflareWorkerRuntime
   * itself has its own direct Node-side (false) and real-isolate (true) tests. */
  if (isCloudflareWorkerRuntime()) {
    app.use(sentry(app, (env) => ({ dsn: env.WORKER_SENTRY_DSN, environment: env.WORKER_SENTRY_ENVIRONMENT ?? "production" })));
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
    if (isExtensionScopedSession(identity) && c.req.path !== EXTENSION_PULL_CONTEXT_PATH) return c.json({ error: "insufficient_scope" }, 403);
    // Contributor extension tokens are STRICTLY self-only: like the pull-context token above, they are
    // confined to their own surface and may not reach any other path (control-panel /v1/app/*, the
    // session-mint endpoint, etc.). Without this they would be LESS confined than the maintainer token.
    if (isExtensionContributorScopedSession(identity) && !isExtensionContributorContextPath(c.req.path)) return c.json({ error: "insufficient_scope" }, 403);
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
      const [stats, accuracyTrend, reuseRateTrend, reviewVolumeTrend] = await Promise.all([
        getPublicStats(c.env),
        loadPublicAccuracyTrend(c.env),
        loadPublicReuseRateTrend(c.env),
        loadPublicReviewVolumeTrend(c.env),
      ]);
      c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return c.json({ ...stats, accuracyTrend, reuseRateTrend, reviewVolumeTrend });
    } catch {
      return c.json({ error: "public_stats_unavailable" }, 503);
    }
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
  app.get("/v1/public/repos/:owner/:repo/badge.svg", async (c) => {
    const quality = await loadPublicRepoBadge(c.env, c.req.param("owner"), c.req.param("repo"));
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    if (!quality) {
      c.header("Cache-Control", "public, max-age=300");
      return c.body(renderUnavailableBadgeSvg(), 404);
    }
    c.header("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");
    return c.body(renderBadgeSvg(quality));
  });

  app.get("/v1/public/repos/:owner/:repo/badge.json", async (c) => {
    const quality = await loadPublicRepoBadge(c.env, c.req.param("owner"), c.req.param("repo"));
    if (!quality) {
      c.header("Cache-Control", "public, max-age=300");
      return c.json({ schemaVersion: 1, label: PUBLIC_BADGE_LABEL, message: "unavailable", color: "#9e9e9e", cacheSeconds: 300 }, 404);
    }
    c.header("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");
    return c.json(buildShieldsBadge(quality, 600));
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
  // the rate-limit middleware classifies it as 'normal' (a sane public class) via routeClassForPath.
  // Flag-OFF = TRULY inert: when LOOPOVER_REVIEW_SCREENSHOTS is off nothing references this route (no comment
  // carries a /loopover/shot URL), so 404 it outright — that removes the on-demand `?url=` render surface
  // entirely until the feature is deliberately enabled, rather than relying on the host allowlist alone.
  app.get("/loopover/shot", (c) => {
    if (!isScreenshotsEnabled(c.env)) return c.notFound();
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
  // operations without a separately-configured GITHUB_TOKEN PAT. Session-only (mirrors
  // /v1/auth/extension/session's identity gate below) -- the static "mcp"/"api" shared-secret identities
  // never reach this, since they don't represent one logged-in GitHub user's own credential. Never cached
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

  app.post("/v1/auth/extension/session", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity || identity.kind !== "session") return c.json({ error: "browser_session_required" }, 403);
    // An extension token (maintainer OR contributor scope) may not mint another — only a full browser
    // session can. Without covering the contributor scope here, a contributor token could self-renew an
    // unbounded, effectively non-revocable chain of sessions.
    if (isExtensionScopedSession(identity) || isExtensionContributorScopedSession(identity)) return c.json({ error: "browser_session_required" }, 403);
    const roleSummary = await loadControlPanelRoleSummary(c.env, identity.actor);
    // Maintainers (own/installed a repo, or operators) get the maintainer pull-context scope; everyone
    // else gets the strictly self-only contributor scope (#556). Either way the session is minted from a
    // verified browser sign-in, so a non-maintainer can only ever read its OWN contributor data.
    const isMaintainer = roleSummary.roles.some((role) => role === "maintainer" || role === "owner" || role === "operator");
    const scope = isMaintainer ? EXTENSION_PULL_CONTEXT_SCOPE : EXTENSION_CONTRIBUTOR_CONTEXT_SCOPE;
    const githubUser = identity.session.githubUserId === undefined ? { login: identity.session.login } : { login: identity.session.login, id: identity.session.githubUserId };
    const { token, session } = await createSessionForGitHubUser(
      c.env,
      githubUser,
      {
        scopes: [scope],
        metadata: {
          source: "browser_extension",
          parentSessionId: identity.session.id,
        },
      },
    );
    await recordRouteProductUsage(c, {
      surface: "browser_extension",
      eventName: "extension_session_created",
      role: isMaintainer ? "maintainer" : "contributor",
      identity,
      sessionId: session.id,
      outcome: "success",
      clientName: "browser_extension",
      metadata: { scopeCount: session.scopes.length },
    });
    return c.json(
      {
        token,
        login: session.login,
        expiresAt: session.expiresAt,
        scopes: session.scopes,
        apiOrigin: c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin,
      },
      201,
    );
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
    const scope = identity.kind === "session" && !summary.roles.includes("operator") ? await loadControlPanelAccessScope(c.env, identity.actor) : null;
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
    const queueHealthHistoriesByRepo = await listRecentSignalSnapshotsForTargets(
      c.env,
      "queue-health",
      qualityRepos.map((repo) => repo.fullName),
      SLOP_DUPLICATE_TREND_SNAPSHOT_LIMIT,
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
    // than any of the maintainer's own repos — federatedIntelligence is operator-level, not per-repo. Bounded
    // to a single, short-timeout attempt so an unreachable or slow collector degrades the panel to its
    // existing empty state instead of holding up the whole dashboard load.
    const federatedIntelligenceManifest = await loadRepoFocusManifest(c.env, resolveLoopOverSelfRepoFullName(c.env));
    const federatedBenchmark = await buildFederatedBenchmark(federatedIntelligenceManifest, c.env.DB, {
      now: Date.parse(generatedAt),
      timeoutMs: 5_000,
      maxAttempts: 1,
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
    const { installationIds, ...payload } = parsed.data;
    // #7611 review fix: prune ONCE for the whole request, not once per target -- enqueueConfigPushRelay no
    // longer prunes itself (see its own doc comment) precisely so a 500-installation fan-out below can't turn
    // into 500 redundant global TTL-prune scans/deletes against the shared orb_relay_pending table.
    await pruneRelayPending(c.env);
    await Promise.all(installationIds.map((installationId) => enqueueConfigPushRelay(c.env, installationId, payload)));
    await recordAuditEvent(c.env, {
      eventType: "operator.config_push_enqueued",
      actor: identity.actor,
      targetKey: `config_push#${parsed.data.pushId}`,
      outcome: "completed",
      metadata: { installationCount: installationIds.length, capability: payload.capability ?? null },
    });
    return c.json({ ok: true, pushId: parsed.data.pushId, installationCount: installationIds.length });
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
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const identity = await authenticateRequestIdentity(c);
    const login = identity?.kind === "session" ? identity.actor : null;
    const [repositories, health, upstreamDrift, rateLimits, subscriptions] = await Promise.all([
      listRepositories(c.env),
      listInstallationHealth(c.env),
      loadUpstreamStatus(c.env),
      listLatestGitHubRateLimitObservations(c.env, 10),
      login ? listDigestSubscriptionsForLogin(c.env, login) : Promise.resolve([]),
    ]);
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

  app.get("/v1/extension/pull-context", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity || identity.kind !== "session" || !isExtensionScopedSession(identity)) return c.json({ error: "extension_session_required" }, 403);
    const owner = c.req.query("owner") ?? "";
    const repoName = c.req.query("repo") ?? "";
    const pullNumber = Number(c.req.query("pullNumber") ?? "");
    if (!owner || !repoName || !Number.isInteger(pullNumber) || pullNumber <= 0) return c.json({ error: "valid_owner_repo_pull_required" }, 400);
    const fullName = `${owner}/${repoName}`;
    const repo = await getRepository(c.env, fullName);
    const repoForbidden = await requireExtensionPullContextRepoAccess(c, identity, fullName, repo);
    if (repoForbidden) return repoForbidden;
    const [pullRequest, issues, pullRequests, files, reviews, checks, recentMergedPullRequests] = await Promise.all([
      getPullRequest(c.env, fullName, pullNumber),
      listIssues(c.env, fullName),
      listPullRequests(c.env, fullName),
      listPullRequestFiles(c.env, fullName, pullNumber),
      listPullRequestReviews(c.env, fullName, pullNumber),
      listCheckSummaries(c.env, fullName, pullNumber),
      listRecentMergedPullRequests(c.env, fullName),
    ]);
    const contributor = pullRequest?.authorLogin;
    const contributorContext = contributor ? await loadContributorFastContext(c.env, contributor).catch(() => null) : null;
    const signalArgs = {
      repo,
      pullRequest,
      issues,
      pullRequests,
      files,
      reviews,
      checks,
      recentMergedPullRequests,
      repoFullName: fullName,
      pullNumber,
      profile: contributorContext?.profile,
      outcomeHistory: contributorContext?.outcomeHistory,
    };
    const packet = buildPullRequestMaintainerPacket(signalArgs);
    const reviewability = buildPullRequestReviewability(signalArgs);
    const roleContext = buildRoleContext({
      login: contributor ?? contributorContext?.profile.login ?? "unknown",
      repo,
      repoFullName: fullName,
      pullRequests,
      issues,
      profile: contributorContext?.profile,
    });
    const publicSafePacketMarkdown = buildExtensionPublicSafePacket({
      repoFullName: fullName,
      pullNumber,
      reviewability,
      contributor: contributor ?? "unknown",
    });
    const privateBlockers = buildExtensionPrivateBlockers(reviewability);
    await recordAuditEvent(c.env, {
      eventType: "extension.pull_context_view",
      actor: identity.actor,
      route: c.req.path,
      outcome: "success",
      metadata: {
        redacted: true,
        hasPublicPacket: publicSafePacketMarkdown.length > 0,
        blockerCount: privateBlockers.length,
      },
    });
    await recordRouteProductUsage(c, {
      surface: "browser_extension",
      eventName: "pull_context_viewed",
      identity,
      repoFullName: fullName,
      targetKey: `${fullName}#${pullNumber}`,
      outcome: "success",
      clientName: "browser_extension",
      metadata: { hasContributorContext: Boolean(contributorContext), hasCachedPullRequest: Boolean(pullRequest) },
    });
    return c.json(
      buildExtensionPullContextPayload({
        fullName,
        pullNumber,
        pullRequest,
        contributorContext,
        packet,
        reviewability,
        roleContext,
        pullRequests,
        publicSafePacketMarkdown,
        privateBlockers,
      }),
    );
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
    if (!Number.isFinite(installationId)) return c.json({ error: "invalid_installation_id" }, 400);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    return c.json(enrichInstallationHealth(health));
  });

  app.get("/v1/installations/:id/repair", async (c) => {
    const installationId = Number(c.req.param("id"));
    if (!Number.isFinite(installationId)) return c.json({ error: "invalid_installation_id" }, 400);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    return c.json(await buildInstallationRepairDiagnostics(c.env, health));
  });

  app.post("/v1/installations/:id/repair/refresh", async (c) => {
    const installationId = Number(c.req.param("id"));
    if (!Number.isFinite(installationId)) return c.json({ error: "invalid_installation_id" }, 400);
    const refreshed = await refreshInstallationHealthForInstallation(c.env, installationId);
    if (!refreshed) return c.json({ error: "installation_not_found" }, 404);
    const health = await getInstallationHealth(c.env, installationId);
    if (!health) return c.json({ error: "installation_health_not_found" }, 404);
    return c.json({ ...(await buildInstallationRepairDiagnostics(c.env, health)), refreshed: true });
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
    const unauthorized = await requireStaticProtectedApiToken(c);
    if (unauthorized) return unauthorized;
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
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
    const unauthorized = await requireStaticProtectedApiToken(c);
    if (unauthorized) return unauthorized;
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const identity = await authenticateRequestIdentity(c);
    if (identity?.kind === "static" && identity.actor === "mcp" && !(await import("../auth/security")).isMcpReadRepoAllowed(c.env.MCP_READ_REPO_ALLOWLIST, fullName)) return c.json({ error: "forbidden_repo" }, 403);
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
    return c.json(await loadPrAiReviewFindings(c.env, { repoFullName: fullName, pullNumber: number, login }));
  });

  // Read-only view of a repo's CURRENT effective self-tuned gate thresholds (#6247, groundwork for #6209).
  // Returns only the resolved effective values from auto-apply.ts's live override — never the raw
  // override_audit history or the shadow's queued recommendation, just a flag that a shadow is soaking.
  // Gated behind the same most-conservative repo-scoped read precedent the reviewability route (#6154) uses.
  app.get("/v1/repos/:owner/:repo/gate-config/effective", async (c) => {
    const unauthorized = await requireStaticProtectedApiToken(c);
    if (unauthorized) return unauthorized;
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireStaticProtectedApiToken above already rejected null and session identities, so only static tokens reach here. */
    if (!identity || identity.kind !== "static") return c.json({ error: "unauthorized" }, 401);
    // Only the shared, end-user-obtainable static `mcp` token is allowlist-scoped; operator-only api/internal
    // tokens stay trusted — same repo-scoped read precedent the reviewability route (#6154) uses.
    if (identity.actor === "mcp" && !(await import("../auth/security")).isMcpReadRepoAllowed(c.env.MCP_READ_REPO_ALLOWLIST, fullName)) return c.json({ error: "forbidden_repo" }, 403);
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
    const unauthorized = await requireStaticProtectedApiToken(c);
    /* v8 ignore next -- both arms hit by integration 401 + success; codecov still marks this branch patch-partial across shards. */
    if (unauthorized) return unauthorized;
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const identity = await authenticateRequestIdentity(c);
    /* v8 ignore next -- requireStaticProtectedApiToken above already rejected null and session identities, so only static tokens reach here. */
    if (!identity || identity.kind !== "static") return c.json({ error: "unauthorized" }, 401);
    // Only the shared, end-user-obtainable static `mcp` token is allowlist-scoped; operator-only api/internal
    // tokens stay trusted — same repo-scoped read precedent the reviewability route (#6154) uses.
    if (identity.actor === "mcp" && !(await import("../auth/security")).isMcpReadRepoAllowed(c.env.MCP_READ_REPO_ALLOWLIST, fullName)) return c.json({ error: "forbidden_repo" }, 403);
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
    const parsed = z.object(simulateOpenPrPressureShape).safeParse(body);
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
    const parsed = validateFindOpportunitiesInput((body ?? {}) as FindOpportunitiesInput);
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
    const parsed = validateIssueRagInput((body ?? {}) as IssueRagInput);
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

  // ─── Extension contributor-context endpoints (#556) ─────────────────────────────────────────────
  // Self-only (requireContributorAccess: actor === login), public-safe, scores returned as BANDS.
  // The coarse path allowlist (canSessionAccessPath) only lets the contributor scope reach these paths.
  app.get("/v1/extension/contributors/:login/issue-fit", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const owner = c.req.query("owner") ?? "";
    const repoName = c.req.query("repo") ?? "";
    const issueNumber = Number(c.req.query("issueNumber") ?? "");
    if (!owner || !repoName || !Number.isInteger(issueNumber) || issueNumber <= 0) return c.json({ error: "valid_owner_repo_issue_required" }, 400);
    const repoFullName = `${owner}/${repoName}`;
    const repo = await getRepository(c.env, repoFullName);
    if (!repo) return c.json({ error: "repo_not_found" }, 404);
    const repoForbidden = await requireContributorRepoAccess(c, repoFullName, repo);
    if (repoForbidden) return repoForbidden;
    const [context, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      loadContributorFastContext(c.env, login),
      listIssues(c.env, repoFullName),
      listPullRequests(c.env, repoFullName),
      listBountiesByRepo(c.env, repoFullName),
      loadOrComputeIssueQualityResponse(c.env, repoFullName),
    ]);
    const opportunities = buildContributorOpportunities(context.profile, [repo], issues, pullRequests, bounties, issueQualityMap(repoFullName, issueQuality?.report));
    const opportunity = opportunities.find((entry) => entry.issueNumber === issueNumber);
    if (!opportunity) return c.json({ repoFullName, issueNumber, eligible: false, reason: "Issue is not an open, unclaimed outside-contributor target right now." }, 200);
    return c.json({ eligible: true, ...buildExtensionIssueFit(opportunity) });
  });

  app.get("/v1/extension/contributors/:login/issue-badges", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const owner = c.req.query("owner") ?? "";
    const repoName = c.req.query("repo") ?? "";
    if (!owner || !repoName) return c.json({ error: "valid_owner_repo_required" }, 400);
    const repoFullName = `${owner}/${repoName}`;
    const repo = await getRepository(c.env, repoFullName);
    if (!repo) return c.json({ error: "repo_not_found" }, 404);
    const repoForbidden = await requireContributorRepoAccess(c, repoFullName, repo);
    if (repoForbidden) return repoForbidden;
    const [context, issues, pullRequests, bounties, issueQuality] = await Promise.all([
      loadContributorFastContext(c.env, login),
      listIssues(c.env, repoFullName),
      listPullRequests(c.env, repoFullName),
      listBountiesByRepo(c.env, repoFullName),
      loadOrComputeIssueQualityResponse(c.env, repoFullName),
    ]);
    const opportunities = buildContributorOpportunities(context.profile, [repo], issues, pullRequests, bounties, issueQualityMap(repoFullName, issueQuality?.report));
    return c.json({ repoFullName, badges: buildExtensionIssueBadges(opportunities, repoFullName) });
  });

  app.get("/v1/extension/contributors/:login/pr-status", async (c) => {
    const login = c.req.param("login");
    const unauthorized = await requireContributorAccess(c, login);
    if (unauthorized) return unauthorized;
    const owner = c.req.query("owner") ?? "";
    const repoName = c.req.query("repo") ?? "";
    const pullNumber = Number(c.req.query("pullNumber") ?? "");
    if (!owner || !repoName || !Number.isInteger(pullNumber) || pullNumber <= 0) return c.json({ error: "valid_owner_repo_pull_required" }, 400);
    const repoFullName = `${owner}/${repoName}`;
    const repo = await getRepository(c.env, repoFullName);
    if (!repo) return c.json({ error: "repo_not_found" }, 404);
    const repoForbidden = await requireContributorRepoAccess(c, repoFullName, repo);
    if (repoForbidden) return repoForbidden;
    const [issues, pullRequests, bounties, issueQuality] = await Promise.all([
      listIssues(c.env, repoFullName),
      listPullRequests(c.env, repoFullName),
      listBountiesByRepo(c.env, repoFullName),
      loadOrComputeIssueQualityResponse(c.env, repoFullName),
    ]);
    const pr = pullRequests.find((entry) => entry.number === pullNumber);
    if (!pr) return c.json({ error: "pull_request_not_found" }, 404);
    // Self-only on the PR itself: a contributor reads only their OWN PR's status.
    if ((pr.authorLogin ?? "").toLowerCase() !== login.toLowerCase()) return c.json({ error: "forbidden_contributor" }, 403);
    const preflight = buildPreflightResult(
      { repoFullName, contributorLogin: login, title: pr.title, body: pr.body ?? undefined, labels: pr.labels, linkedIssues: pr.linkedIssues, authorAssociation: pr.authorAssociation ?? undefined },
      repo,
      issues,
      pullRequests,
      bounties,
      issueQuality?.report,
    );
    const collisions = buildCollisionReport(repoFullName, issues, pullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
    const readiness = buildPublicReadinessScore({ pr, preflight, queueHealth });
    return c.json(buildExtensionPrStatus({ repoFullName, pullNumber, readiness }));
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
    const events = await pullRelayPending(c.env, enrollment.installationId, { ack }).catch(dbBrokerError);
    if (events === null) return c.json({ error: "broker_error" }, 503);
    return c.json({ events }, 200);
  });

  // LoopOver Orb (#1255) — central fleet-calibration collector. Receives anonymized, reversal-aware outcome
  // batches from self-hosted instances. Sender-side HMAC anonymization is for privacy, not authentication.
  // OPTIONAL shared-token gate (#1285): unset ⇒ OPEN ingress (the live fleet keeps working, as before); set
  // ⇒ the collector REQUIRES it, so an operator can lock the write path down after distributing the matching
  // ORB_COLLECTOR_TOKEN to exporters. Bounded by a hard body ceiling, and dedup'd via UNIQUE(instance_id, repo_hash, pr_hash).
  app.post("/v1/orb/ingest", async (c) => {
    if (!(await isAuthorizedOrbIngest(c.env, extractBearerToken(c.req.header("authorization"))))) return c.json({ error: "unauthorized" }, 401);
    const body = await readOrbIngestBody(c.req.raw, c.req.header("content-length"));
    if (body === null) return c.json({ error: "payload_too_large" }, 413);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const result = await handleOrbIngest(body, c.env.DB);
    if ("error" in result) return c.json(result, 400);
    return c.json(result, 200);
  });

  // LoopOver AMS (#5681) — central telemetry collector for the miner product, mirroring the Orb ingest
  // route above (same optional bearer-token gate, same hard body ceiling — readOrbIngestBody is generic over
  // request bytes despite the name, so it's reused as-is rather than duplicated).
  app.post("/v1/ams/ingest", async (c) => {
    if (!(await isAuthorizedAmsIngest(c.env, extractBearerToken(c.req.header("authorization"))))) return c.json({ error: "unauthorized" }, 401);
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
  app.get("/v1/internal/orb/instances", async (c) => {
    const rows = await c.env.DB
      .prepare(
        `SELECT i.instance_id AS instanceId, i.registered AS registered, i.first_seen_at AS firstSeenAt,
                i.last_seen_at AS lastSeenAt, i.registered_at AS registeredAt,
                (SELECT COUNT(*) FROM orb_signals s WHERE s.instance_id = i.instance_id) AS signalCount
         FROM orb_instances i ORDER BY i.last_seen_at DESC`,
      )
      .all<{ instanceId: string; registered: number; firstSeenAt: string; lastSeenAt: string; registeredAt: string | null; signalCount: number }>();
    return c.json({ instances: (rows.results ?? []).map((r) => ({ ...r, registered: r.registered === 1 })) });
  });

  // Opt an instance into (or out of) fleet calibration. Body: { instanceId, registered? } (registered
  // defaults true). Upserts so an operator can register an instance that has ingested but isn't recorded yet.
  app.post("/v1/internal/orb/instances/register", async (c) => {
    const payload = (await c.req.json().catch(() => null)) as { instanceId?: unknown; registered?: unknown } | null;
    const instanceId = typeof payload?.instanceId === "string" ? payload.instanceId : "";
    if (!instanceId) return c.json({ error: "instanceId required" }, 400);
    const registered = payload?.registered === false ? 0 : 1;
    await c.env.DB
      .prepare(
        `INSERT INTO orb_instances (instance_id, registered, registered_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(instance_id) DO UPDATE SET registered = excluded.registered,
           registered_at = CASE WHEN excluded.registered = 1 THEN CURRENT_TIMESTAMP ELSE NULL END`,
      )
      .bind(instanceId, registered)
      .run();
    return c.json({ instanceId, registered: registered === 1 });
  });

  // Central Orb GitHub App installation registry — the onboarding gate. Every installation the Orb App webhook
  // records lands at registered=0; only REGISTERED ones count toward the global public counter (getOrbGlobalStats)
  // and are eligible for token brokering. Bearer-gated by the `/v1/internal/*` middleware (INTERNAL_JOB_TOKEN). The
  // list shows pending + registered installs so an operator knows what they're opting in.
  app.get("/v1/internal/orb/installations", async (c) => {
    const rows = await c.env.DB
      .prepare(
        `SELECT installation_id AS installationId, account_login AS accountLogin, account_type AS accountType,
                repository_selection AS repositorySelection, registered, suspended_at AS suspendedAt,
                removed_at AS removedAt, first_seen_at AS firstSeenAt, last_event_at AS lastEventAt
         FROM orb_github_installations ORDER BY last_event_at DESC`,
      )
      .all<{ installationId: number; accountLogin: string | null; accountType: string | null; repositorySelection: string | null; registered: number; suspendedAt: string | null; removedAt: string | null; firstSeenAt: string; lastEventAt: string }>();
    return c.json({ installations: (rows.results ?? []).map((r) => ({ ...r, registered: r.registered === 1 })) });
  });

  // Opt an installation into (or out of) the registry. Body: { installationId, registered? } (registered defaults
  // true). Opting out also blocks OAuth self-enrollment until an operator opts back in. 404 when the installation
  // isn't recorded yet — an install MUST arrive via the webhook first (unlike the fleet instances there's no account
  // context to upsert a never-seen installation from).
  app.post("/v1/internal/orb/installations/register", async (c) => {
    const payload = (await c.req.json().catch(() => null)) as { installationId?: unknown; registered?: unknown } | null;
    const installationId = Number(payload?.installationId);
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "installationId required" }, 400);
    const existing = await c.env.DB.prepare("SELECT installation_id FROM orb_github_installations WHERE installation_id = ?").bind(installationId).first();
    if (!existing) return c.json({ error: "installation_not_found" }, 404);
    const registered = payload?.registered === false ? 0 : 1;
    await c.env.DB.prepare("UPDATE orb_github_installations SET registered = ?, self_enrollment_disabled = ? WHERE installation_id = ?").bind(registered, registered === 1 ? 0 : 1, installationId).run();
    return c.json({ installationId, registered: registered === 1 });
  });

  // Operator-only: issue a one-time token-broker enrollment secret for a REGISTERED install, to hand to that
  // maintainer's self-hosted container. The secret is returned ONCE (stored only hashed). Bearer-gated by the
  // /v1/internal/* middleware (INTERNAL_JOB_TOKEN); flag-gated (404 until ORB_BROKER_ENABLED).
  app.post("/v1/internal/orb/enrollments", async (c) => {
    if (!isOrbBrokerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const payload = (await c.req.json().catch(() => null)) as { installationId?: unknown } | null;
    const installationId = Number(payload?.installationId);
    if (!Number.isInteger(installationId) || installationId <= 0) return c.json({ error: "installationId required" }, 400);
    const result = await issueOrbEnrollment(c.env, installationId);
    if ("error" in result) return c.json(result, result.error === "installation_not_found" ? 404 : 409);
    return c.json(result); // { enrollId, secret } — secret shown exactly once
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
  app.get("/v1/internal/fairness/contributors/:login", async (c) => {
    if (!isFairnessAnalyticsEnabled(c.env, await resolveFairnessAnalyticsManifestOverride(c.env))) return c.json({ error: "not_found" }, 404);
    const login = c.req.param("login");
    const nowMs = Date.now();
    const [profile, evalReport] = await Promise.all([
      getContributorTrustProfile(c.env, login, { nowMs }),
      computeContributorGateEval(c.env, { days: 90, nowMs }),
    ]);
    const flags = contributorFairnessFlags(evalReport.rows).filter((f) => f.login === login);
    return c.json({ profile, fairnessFlags: flags });
  });

  // Fleet-wide fairness summary (#fairness-analytics): counts only, never individual contributor rows -- the
  // per-login detail lives behind the :login route above. Intended for the operator dashboard tile.
  app.get("/v1/internal/fairness/contributors", async (c) => {
    if (!isFairnessAnalyticsEnabled(c.env, await resolveFairnessAnalyticsManifestOverride(c.env))) return c.json({ error: "not_found" }, 404);
    const evalReport = await computeContributorGateEval(c.env, { days: 90, nowMs: Date.now() });
    const flags = contributorFairnessFlags(evalReport.rows);
    return c.json({ contributorsEvaluated: evalReport.rows.length, hasSignal: evalReport.hasSignal, flaggedCount: flags.length });
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
    const events: BountyLifecycleEventRecord[] = [];
    for (const bounty of bounties) {
      const existing = await getBounty(c.env, bounty.id);
      await upsertBounty(c.env, bounty);
      if (!existing || existing.status !== bounty.status) {
        events.push({
          id: crypto.randomUUID(),
          bountyId: bounty.id,
          repoFullName: bounty.repoFullName,
          issueNumber: bounty.issueNumber,
          status: bounty.status,
          payload: { previousStatus: existing?.status ?? null, source: "gitt_import" },
          generatedAt: nowIso(),
        });
      }
    }
    await Promise.all(events.map((event) => persistBountyLifecycleEvent(c.env, event)));
    return c.json({ ok: true, imported: bounties.length, lifecycleEvents: events.length });
  });

  app.post("/v1/internal/queue-intelligence", async (c) => {
    const contentLength = parsePositiveInt(c.req.header("content-length"));
    if (contentLength !== null && contentLength > QUEUE_INTELLIGENCE_MAX_BODY_BYTES) {
      return c.json({ error: "payload_too_large", maxBytes: QUEUE_INTELLIGENCE_MAX_BODY_BYTES }, 413);
    }

    const rawBody = await readRequestBodyWithLimit(c.req.raw, QUEUE_INTELLIGENCE_MAX_BODY_BYTES);
    if (rawBody === null) {
      return c.json({ error: "payload_too_large", maxBytes: QUEUE_INTELLIGENCE_MAX_BODY_BYTES }, 413);
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
    const prSchema = z.object({
      number: z.number().int().positive(),
      author: z.string().max(QUEUE_INTELLIGENCE_MAX_AUTHOR_LENGTH),
      authorRole: z.enum(["first-time", "contributor", "maintainer"] as [AuthorRole, ...AuthorRole[]]),
      isConfirmedMiner: z.boolean(),
      linkedIssue: z.object({ qualityScore: z.number().min(0).max(1) }).nullable(),
      checksStatus: z.enum(["passing", "failing", "pending"] as [ChecksStatus, ...ChecksStatus[]]),
      isStale: z.boolean(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      title: z.string().max(QUEUE_INTELLIGENCE_MAX_TITLE_LENGTH),
      body: z.string().max(QUEUE_INTELLIGENCE_MAX_BODY_LENGTH),
      duplicateCandidates: z.array(z.number().int().positive()).max(QUEUE_INTELLIGENCE_MAX_DUPLICATE_CANDIDATES),
      createdAt: z.string().datetime(),
      lastUpdatedAt: z.string().datetime(),
    });
    const repoContextSchema = z.object({
      totalOpenPRs: z.number().int().nonnegative(),
      avgReviewTimeDays: z.number().nonnegative(),
      maintainerWorkload: z.number().min(0).max(1),
    });
    const prsResult = z.array(prSchema).max(QUEUE_INTELLIGENCE_MAX_PULL_REQUESTS).safeParse(queueBody.pullRequests);
    if (!prsResult.success) return c.json({ error: "invalid_request", issues: prsResult.error.issues }, 400);
    const repoContext = repoContextSchema.safeParse(queueBody.repoContext).success
      ? repoContextSchema.parse(queueBody.repoContext)
      : { totalOpenPRs: 0, avgReviewTimeDays: 0, maintainerWorkload: 0 };
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
  const roleSummary = await loadControlPanelRoleSummary(env, identity.actor);
  return {
    status: "authenticated",
    login: identity.session.login,
    githubId: identity.session.githubUserId ?? null,
    github_id: identity.session.githubUserId ?? null,
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
    loadOrComputeBurdenForecastResponse(env, fullName).catch((error) => {
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

type ExtensionContributorContext = Awaited<ReturnType<typeof loadContributorFastContext>> | null;

type ExtensionPullContextSection = {
  id: string;
  label: string;
  badge: string;
  tone: "good" | "warn" | "neutral" | "private";
  rows: Array<{ label: string; value: string }>;
  items: string[];
  actions: string[];
};

type ExtensionQueueLevel = "low" | "medium" | "high" | "unknown";

const EXTENSION_REVIEWABILITY_TONES: Record<PullRequestReviewability["action"], ExtensionPullContextSection["tone"]> = {
  review_now: "good",
  needs_author: "warn",
  likely_duplicate: "warn",
  close_or_redirect: "warn",
  watch: "neutral",
  maintainer_lane: "private",
};

const EXTENSION_QUEUE_TONES: Record<ExtensionQueueLevel, ExtensionPullContextSection["tone"]> = {
  low: "good",
  medium: "warn",
  high: "warn",
  unknown: "neutral",
};

const EXTENSION_QUEUE_DETAILS: Record<ExtensionQueueLevel, string> = {
  low: "Cached repo and author queue pressure are low enough for normal review flow.",
  medium: "Some open PR pressure is visible; check queue hygiene before encouraging more work from the same lane.",
  high: "Resolve open PR pressure before encouraging more work from the same lane.",
  unknown: "Author repo-history context is unavailable; use cached repo open PR count as a lightweight pressure signal.",
};

function buildExtensionPullContextPayload(args: {
  fullName: string;
  pullNumber: number;
  pullRequest: PullRequestRecord | null;
  contributorContext: ExtensionContributorContext;
  packet: PullRequestMaintainerPacket;
  reviewability: PullRequestReviewability;
  roleContext: RoleContext;
  pullRequests: PullRequestRecord[];
  publicSafePacketMarkdown: string;
  privateBlockers: ReturnType<typeof buildExtensionPrivateBlockers>;
}) {
  const contributor = args.pullRequest?.authorLogin ?? args.contributorContext?.profile.login ?? "unknown";
  const minerStatus = extensionMinerStatus(args.contributorContext);
  const repoOutcome = args.contributorContext?.outcomeHistory.repoOutcomes.find((outcome) => outcome.repoFullName.toLowerCase() === args.fullName.toLowerCase());
  const repoOpenPullRequests = args.pullRequests.filter((pull) => pull.repoFullName === args.fullName && pull.state === "open").length;
  const queue = extensionQueuePressure(repoOpenPullRequests, repoOutcome);
  const linkedIssues = args.packet.reviewSignals.linkedIssues;
  const duplicateCount = args.packet.reviewSignals.collisionClusters;
  const publicActions = uniqueStrings([...args.reviewability.maintainerNextSteps, ...args.packet.contributorNextSteps]).slice(0, 5).map(sanitizeExtensionPrivateText);
  const sections: ExtensionPullContextSection[] = [
    cleanExtensionSection({
      id: "miner-context",
      label: "Miner Context",
      badge: minerStatus.badge,
      tone: minerStatus.tone,
      rows: [
        { label: "author", value: contributor },
        { label: "status", value: minerStatus.label },
        { label: "source", value: minerStatus.source },
      ],
      items: [minerStatus.detail],
      actions: [],
    }),
    cleanExtensionSection({
      id: "lane-fit",
      label: "Lane Fit",
      badge: args.roleContext.maintainerLane ? "maintainer lane" : args.roleContext.role,
      tone: args.roleContext.maintainerLane ? "private" : args.roleContext.role === "outside_contributor" ? "good" : "neutral",
      rows: [
        { label: "role", value: args.roleContext.role },
        { label: "normal evidence", value: args.roleContext.normalContributorEvidenceAllowed ? "allowed" : "separate lane" },
        { label: "source", value: args.roleContext.source },
      ],
      items: uniqueStrings([args.roleContext.guidance, ...args.roleContext.reasons]).slice(0, 4),
      actions: [],
    }),
    cleanExtensionSection({
      id: "duplicate-risk",
      label: "Duplicate Risk",
      badge: duplicateCount > 0 ? "check overlap" : "clear",
      tone: duplicateCount > 0 ? "warn" : "good",
      rows: [
        { label: "clusters", value: String(duplicateCount) },
        { label: "action", value: duplicateCount > 0 ? "compare before review" : "no cached overlap" },
      ],
      items:
        duplicateCount > 0
          ? ["Compare linked issues, active PRs, and recent merges before detailed review."]
          : ["No duplicate or WIP collision cluster includes this PR in cached metadata."],
      actions: [],
    }),
    cleanExtensionSection({
      id: "linked-issue-state",
      label: "Linked Issue State",
      badge: linkedIssues.length > 0 ? "linked" : "missing",
      tone: linkedIssues.length > 0 ? "good" : "warn",
      rows: [
        { label: "issues", value: linkedIssues.length > 0 ? linkedIssues.map((issue) => `#${issue}`).join(", ") : "none cached" },
        { label: "policy", value: linkedIssues.length > 0 ? "review traceable" : "ask for context" },
      ],
      items:
        linkedIssues.length > 0
          ? [`Cached PR body links ${linkedIssues.map((issue) => `#${issue}`).join(", ")}.`]
          : ["Ask for a linked issue or a clear no-issue rationale before deep review."],
      actions: [],
    }),
    cleanExtensionSection({
      id: "queue-pressure",
      label: "Queue Pressure",
      badge: queue.level,
      tone: queue.tone,
      rows: [
        { label: "repo open PRs", value: String(repoOpenPullRequests) },
        { label: "author open PRs", value: queue.authorOpenPullRequests },
        { label: "author merged", value: queue.authorMergedPullRequests },
      ],
      items: [queue.detail],
      actions: [],
    }),
    cleanExtensionSection({
      id: "public-safe-actions",
      label: "Public-Safe Packet Actions",
      badge: args.reviewability.action,
      tone: EXTENSION_REVIEWABILITY_TONES[args.reviewability.action],
      rows: [
        { label: "priority", value: args.packet.reviewPriority },
        { label: "checks", value: `${args.packet.reviewSignals.checkFailureCount} failing` },
        { label: "reviews", value: `${args.packet.reviewSignals.reviewCount} cached` },
      ],
      items: args.reviewability.whyThisHelps.slice(0, 3),
      actions: publicActions,
    }),
    cleanExtensionSection({
      id: "boundary",
      label: "Boundary",
      badge: "private",
      tone: "private",
      rows: [
        { label: "surface", value: "browser extension" },
        { label: "public posting", value: "none" },
        { label: "source upload", value: "none" },
      ],
      items: ["This panel is maintainer-private context and does not create comments, labels, checks, or source uploads."],
      actions: [],
    }),
  ];

  return {
    generatedAt: nowIso(),
    repoFullName: args.fullName,
    pullNumber: args.pullNumber,
    contributor: {
      login: sanitizeExtensionPrivateText(contributor),
      minerStatus: minerStatus.status,
      role: sanitizeExtensionPrivateText(args.roleContext.role),
      maintainerLane: args.roleContext.maintainerLane,
    },
    privacy: {
      surface: "browser_extension",
      publicPosting: false,
      sourceUpload: false,
      githubMutations: false,
    },
    reviewability: args.reviewability,
    actions: [
      {
        id: "copy_public_safe_packet",
        label: "Copy public-safe packet",
        visibility: "public_safe",
        markdown: args.publicSafePacketMarkdown,
      },
      {
        id: "view_private_blockers",
        label: "View private blockers",
        visibility: "private",
        requiresAuth: true,
        blockers: args.privateBlockers,
      },
    ],
    sections,
    panels: [
      {
        label: "Reviewability",
        badge: sanitizeExtensionPrivateText(args.reviewability.action),
        rows: [
          { k: "action", v: sanitizeExtensionPrivateText(args.reviewability.action) },
          { k: "score", v: String(args.reviewability.score) },
        ],
      },
      {
        label: "Contributor",
        badge: sanitizeExtensionPrivateText(contributor),
        rows: [
          { k: "author", v: sanitizeExtensionPrivateText(contributor) },
          { k: "prs", v: String(args.contributorContext?.contributorPullRequests.length ?? 0) },
        ],
      },
      {
        label: "Boundary",
        badge: "private",
        rows: [
          { k: "surface", v: "browser extension" },
          { k: "public", v: "no" },
        ],
      },
    ],
  };
}

function extensionMinerStatus(context: ExtensionContributorContext): {
  status: "confirmed" | "not_found" | "unavailable";
  badge: string;
  label: string;
  source: string;
  detail: string;
  tone: ExtensionPullContextSection["tone"];
} {
  if (!context) {
    return {
      status: "unavailable",
      badge: "unavailable",
      label: "official context unavailable",
      source: "unavailable",
      detail: "Official contributor context is unavailable; this panel does not guess or post publicly.",
      tone: "neutral",
    };
  }
  if (context.profile.gittensor) {
    return {
      status: "confirmed",
      badge: "confirmed",
      label: "confirmed miner",
      source: "official Gittensor API",
      detail: "Official miner context is available for private maintainer triage without exposing wallet or key material.",
      tone: "good",
    };
  }
  return {
    status: "not_found",
    badge: "non-miner",
    label: "no confirmed miner record",
    source: context.profile.source,
    detail: "No confirmed miner record is cached for this GitHub login; use normal PR review signals.",
    tone: "neutral",
  };
}

function extensionQueuePressure(
  repoOpenPullRequests: number,
  repoOutcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined,
): { level: ExtensionQueueLevel; tone: ExtensionPullContextSection["tone"]; authorOpenPullRequests: string; authorMergedPullRequests: string; detail: string } {
  if (!repoOutcome) {
    const level = repoOpenPullRequests >= 6 ? "medium" : "unknown";
    return {
      level,
      tone: EXTENSION_QUEUE_TONES[level],
      authorOpenPullRequests: "unknown",
      authorMergedPullRequests: "unknown",
      detail: EXTENSION_QUEUE_DETAILS[level],
    };
  }
  const authorOpenPullRequests = repoOutcome.openPullRequests;
  const level = extensionQueueLevel(repoOpenPullRequests, authorOpenPullRequests);
  return {
    level,
    tone: EXTENSION_QUEUE_TONES[level],
    authorOpenPullRequests: String(authorOpenPullRequests),
    authorMergedPullRequests: String(repoOutcome.mergedPullRequests),
    detail: EXTENSION_QUEUE_DETAILS[level],
  };
}

function extensionQueueLevel(repoOpenPullRequests: number, authorOpenPullRequests: number): "low" | "medium" | "high" {
  if (repoOpenPullRequests >= 8 || authorOpenPullRequests >= 4) return "high";
  if (repoOpenPullRequests >= 4 || authorOpenPullRequests >= 2) return "medium";
  return "low";
}

function cleanExtensionSection(section: ExtensionPullContextSection): ExtensionPullContextSection {
  return {
    id: section.id,
    label: sanitizeExtensionPrivateText(section.label),
    badge: sanitizeExtensionPrivateText(section.badge),
    tone: section.tone,
    rows: section.rows.map((row) => ({ label: sanitizeExtensionPrivateText(row.label), value: sanitizeExtensionPrivateText(row.value) })),
    items: section.items.map(sanitizeExtensionPrivateText),
    actions: section.actions.map(sanitizeExtensionPrivateText),
  };
}

function sanitizeExtensionPrivateText(value: unknown): string {
  const text = String(value).replace(
    /\b(wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|private keys?|raw trust scores?|trust scores?|raw rankings?|private rankings?|reward estimates?|payouts?|farming)\b|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+/gi,
    "private signal",
  );
  return text.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function contributorEvidenceFromProfile(profile: {
  login: string;
  generatedAt: string;
  evidence: {
    registeredRepoPullRequests: number;
    mergedPullRequests: number;
    openPullRequests: number;
    stalePullRequests: number;
    unlinkedPullRequests: number;
    issueDiscoveryReports: number;
    languageMatches: number;
    credibilityAssumption: number;
  };
}): ContributorEvidenceRecord {
  return {
    login: profile.login,
    generatedAt: profile.generatedAt,
    payload: {
      pullRequests: profile.evidence.registeredRepoPullRequests,
      mergedPullRequests: profile.evidence.mergedPullRequests,
      openPullRequests: profile.evidence.openPullRequests,
      stalePullRequests: profile.evidence.stalePullRequests,
      unlinkedPullRequests: profile.evidence.unlinkedPullRequests,
      issueDiscoveryReports: profile.evidence.issueDiscoveryReports,
      languageMatches: profile.evidence.languageMatches,
      credibilityAssumption: profile.evidence.credibilityAssumption,
    },
  };
}

const EXTENSION_PULL_CONTEXT_PATH = "/v1/extension/pull-context";
const EXTENSION_PULL_CONTEXT_SCOPE = "extension:pull_context";
const OPPORTUNITIES_FIND_PATH = "/v1/opportunities/find";
const ISSUE_RAG_RETRIEVE_PATH = "/v1/issue-rag/retrieve";
const LINT_PR_TEXT_PATH = "/v1/lint/pr-text";
const VALIDATE_FOCUS_MANIFEST_PATH = "/v1/validate/focus-manifest";
const LINT_SLOP_RISK_PATH = "/v1/lint/slop-risk";
const LINT_ISSUE_SLOP_PATH = "/v1/lint/issue-slop";
// Contributor (miner) side of the extension (#556). Minted for NON-maintainer sign-ins; strictly
// self-only — a token may only reach `/v1/extension/contributors/<self>/*`, enforced by the coarse
// path check below plus `requireContributorAccess` (actor === login) in every handler.
const EXTENSION_CONTRIBUTOR_CONTEXT_SCOPE = "extension:contributor_context";
const EXTENSION_CONTRIBUTOR_CONTEXT_PATH = /^\/v1\/extension\/contributors\/[^/]+\/[^/]+$/;

type ProtectedRouteContext = {
  env: Env;
  req: { header: (name: string) => string | undefined | null };
  json: (object: { error: string; reason?: string }, status?: number) => Response;
};

function isExtensionScopedSession(identity: AuthIdentity): boolean {
  return identity.kind === "session" && identity.session.scopes.includes(EXTENSION_PULL_CONTEXT_SCOPE);
}

function isExtensionContributorScopedSession(identity: AuthIdentity): boolean {
  return identity.kind === "session" && identity.session.scopes.includes(EXTENSION_CONTRIBUTOR_CONTEXT_SCOPE);
}

function isExtensionContributorContextPath(path: string): boolean {
  return EXTENSION_CONTRIBUTOR_CONTEXT_PATH.test(path);
}

// Wrap a single repo's issue-quality report in the by-repo map buildContributorOpportunities expects.
function issueQualityMap(repoFullName: string, report: IssueQualityReport | undefined): Map<string, IssueQualityReport> | undefined {
  return report ? new Map([[repoFullName, report]]) : undefined;
}

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
  if (isAuthorizedGitHubSessionLogin(env, identity.actor)) return true;
  if (path.startsWith("/v1/app/")) return true;
  if (isIssueQualityPath(path)) return true;
  if (isRepoSettingsPath(path)) return true;
  if (isRepoActivationPath(path)) return true;
  if (isRepoOutcomeCalibrationPath(path)) return true;
  if (isRepoGatePrecisionPath(path)) return true;
  if (isRepoMaintainerNoisePath(path)) return true;
  if (isRepoSelftuneOverridesPath(path)) return true;
  if (isRepoSettingsPreviewPath(path)) return true;
  if (isRepoOnboardingPackPreviewPath(path)) return true;
  if (isRepoFocusManifestPath(path)) return true;
  if (isRepoAiConfigPath(path)) return true;
  if (isRepoLinearConfigPath(path)) return true;
  if (isRepoCheckBeforeStartPath(path)) return true;
  if (isRepoValidateLinkedIssuePath(path)) return true;
  if (isRepoAgentAuditFeedPath(path)) return true; // route's requireRepoMaintainer enforces per-repo authority (contributors → 403)
  if (isRepoDocRefreshPath(path)) return true; // route's requireRepoWriteAccess enforces real per-repo write authority
  if (isRepoAgentPendingActionsPath(path)) return true; // list (GET, requireRepoMaintainer) + propose (POST, requireRepoWriteAccess); decision POSTs on /:id/:decision require server tokens
  if (isRepoIncidentReportsPath(path)) return true; // #5672: route's requireRepoMaintainer enforces per-repo authority (contributors → 403)
  if (isRepoContributorIssueDraftGeneratePath(path)) return true;
  if (path === OPPORTUNITIES_FIND_PATH) return true;
  if (path === ISSUE_RAG_RETRIEVE_PATH) return true;
  if (path === LINT_PR_TEXT_PATH || path === VALIDATE_FOCUS_MANIFEST_PATH || path === LINT_SLOP_RISK_PATH || path === LINT_ISSUE_SLOP_PATH) return true;
  if (path === EXTENSION_PULL_CONTEXT_PATH && isExtensionScopedSession(identity)) return true;
  // Contributor extension scope reaches only `/v1/extension/contributors/<login>/*`; the handler's
  // requireContributorAccess then enforces actor === login (self-only).
  if (isExtensionContributorContextPath(path) && isExtensionContributorScopedSession(identity)) return true;
  return false;
}

function isRepoSettingsPath(path: string): boolean {
  return /^\/v1\/repos\/[^/]+\/[^/]+\/settings$/.test(path);
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
  if (identity.kind === "session") return loadControlPanelRoleSummary(env, identity.actor);
  return buildStaticControlPanelRoleSummary(identity.actor);
}

async function requireAppRole(c: ProtectedRouteContext, allowedRoles: ControlPanelRoleName[]): Promise<Response | null> {
  const identity = await authenticateRequestIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (identity.kind !== "session") {
    // LOOPOVER_MCP_TOKEN is a shared end-user credential; it must not satisfy app-role gates implicitly.
    if (identity.actor === "mcp") return c.json({ error: "insufficient_role" }, 403);
    return null;
  }
  const summary = await loadControlPanelRoleSummary(c.env, identity.actor);
  return summary.roles.some((role) => allowedRoles.includes(role)) ? null : c.json({ error: "insufficient_role" }, 403);
}

async function requireStaticProtectedApiToken(c: ProtectedRouteContext): Promise<Response | null> {
  const identity = await authenticateRequestIdentity(c);
  /* v8 ignore next -- Protected middleware rejects unauthenticated private routes before static-token-only route guards. */
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (identity.kind === "session") return c.json({ error: "static_token_required" }, 403);
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

async function requireContributorRepoAccess(c: ProtectedRouteContext, repoFullName: string, repo: RepositoryRecord): Promise<Response | null> {
  if (!repo.isPrivate) return null;
  const identity = await authenticateRequestIdentity(c);
  /* v8 ignore next -- Contributor route guard authenticates before repository access is checked. */
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (identity.kind !== "session") return null;
  return requireSessionRepoAccess(c, identity, repoFullName, repo);
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

async function requireExtensionPullContextRepoAccess(
  c: ProtectedRouteContext,
  identity: Extract<AuthIdentity, { kind: "session" }>,
  repoFullName: string,
  repo: RepositoryRecord | null,
): Promise<Response | null> {
  return requireSessionRepoAccess(c, identity, repoFullName, repo);
}

async function requireDiscoveryAccessForApi(c: ProtectedRouteContext, identity: AuthIdentity): Promise<Response | null> {
  if (identity.kind === "session") {
    if (isAuthorizedGitHubSessionLogin(c.env, identity.actor)) return null;
    const scope = await loadControlPanelAccessScope(c.env, identity.actor);
    if (scope.operator) return null;
    return c.json({ error: "forbidden", reason: "cross_repo_search_requires_discovery_access" }, 403);
  }
  if (identity.kind === "static" && identity.actor === "mcp" && !isMcpReadUnscoped(c.env.MCP_READ_REPO_ALLOWLIST)) {
    return c.json({ error: "forbidden", reason: "cross_repo_search_requires_unscoped_mcp_read" }, 403);
  }
  return null;
}

async function canApiAccessRepo(env: Env, identity: AuthIdentity, repoFullName: string): Promise<boolean> {
  if (identity.kind === "session") return canLoginAccessRepo(env, identity.actor, repoFullName);
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
  const summary = await loadControlPanelRoleSummary(c.env, identity.actor);
  if (summary.roles.includes("operator")) return null;
  const scope = await loadControlPanelAccessScope(c.env, identity.actor);
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
  const summary = await loadControlPanelRoleSummary(c.env, gate.identity.actor);
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
  const scope = await loadControlPanelAccessScope(c.env, identity.actor);
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


// Optional Orb-ingest auth (#1285). FAIL-OPEN by default: with no ORB_INGEST_TOKEN configured the ingress stays
// OPEN (matching today's live fleet — deploying this is non-breaking). Once the operator sets the token, the
// collector REQUIRES an exact bearer match, so the write path can be locked down after the matching
// ORB_COLLECTOR_TOKEN is rolled out to exporters.
async function isAuthorizedOrbIngest(env: Env, token: string | undefined): Promise<boolean> {
  if (!env.ORB_INGEST_TOKEN) return true;
  // Constant-time compare (mirrors every other secret check in auth/security) — a `===` here is timing-attack
  // vulnerable for a shared secret.
  return timingSafeEqual(token, env.ORB_INGEST_TOKEN);
}

// Optional AMS-ingest auth (#5681), same fail-open shape as isAuthorizedOrbIngest: unset ⇒ open ingress, set ⇒
// the collector requires an exact bearer match. A separate token/env var from ORB_INGEST_TOKEN so the two
// products' collector credentials can be rotated or locked down independently.
async function isAuthorizedAmsIngest(env: Env, token: string | undefined): Promise<boolean> {
  if (!env.AMS_INGEST_TOKEN) return true;
  return timingSafeEqual(token, env.AMS_INGEST_TOKEN);
}

function requiresApiToken(path: string): boolean {
  if (path === "/health") return false;
  if (path === "/v1/mcp/compatibility") return false;
  if (path === "/v1/mcp/finding-taxonomy") return false;
  if (path === "/v1/mcp/enrichment-analyzers") return false;
  if (/^\/v1\/public\/github\/repos\/[^/]+\/[^/]+\/stats$/.test(path)) return false;
  if (/^\/v1\/public\/repos\/[^/]+\/[^/]+\/badge\.(svg|json)$/.test(path)) return false;
  if (/^\/v1\/public\/repos\/[^/]+\/[^/]+\/quality$/.test(path)) return false;
  if (path === "/v1/public/subnet-interface") return false;
  if (path === "/v1/public/stats") return false;
  if (path === "/openapi.json") return false;
  if (path === "/mcp") return false;
  // Public OAuth draft-submission flow (LOOPOVER_REVIEW_DRAFT): the submission entry points are unauthenticated
  // by design. The handlers themselves 404 when the flag is off, so this exemption is inert flag-OFF.
  if (path === "/v1/drafts" || path.startsWith("/v1/drafts/")) return false;
  if (path.startsWith("/v1/auth/")) return false;
  if (path === "/v1/github/webhook") return false;
  if (path === "/v1/orb/webhook") return false;
  if (path === "/v1/orb/relay") return false;
  if (path === "/v1/orb/oauth/callback") return false;
  if (path === "/v1/orb/token") return false;
  if (path === "/v1/orb/relay/register") return false;
  if (path === "/v1/orb/relay/pull") return false;
  if (path === "/v1/orb/ingest") return false;
  if (path === "/v1/ams/ingest") return false;
  if (path.startsWith("/v1/internal/")) return false;
  return path.startsWith("/v1/");
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

function buildExtensionPublicSafePacket(args: { repoFullName: string; pullNumber: number; contributor: string; reviewability: { action: string; noiseSources?: string[]; maintainerNextSteps?: string[] } }): string {
  const lines = [
    "# Public-safe PR packet",
    "",
    "## Linked context",
    `- Repository: ${args.repoFullName}`,
    `- Pull request: #${args.pullNumber}`,
    `- Contributor: ${args.contributor}`,
    "",
    "## Review readiness",
    ...extensionPublicReviewReadinessLines(args.reviewability.action),
    "",
    "## Queue caution",
    "- Use only public GitHub context when discussing prioritization or next steps.",
    "- Keep private reviewability signals in the extension and out of public comments.",
    "",
    "## Safety",
    "- Keep public comments limited to linked context, validation status, and maintainer-ready next steps.",
  ];
  const markdown = sanitizePublicComment(lines.join("\n"));
  return ensureExtensionPublicSafeText(markdown);
}

function extensionPublicReviewReadinessLines(action: string): string[] {
  switch (action) {
    case "review_now":
      return ["- Public status: ready for maintainer review.", "- Suggested next step: review the technical diff and public checks."];
    case "maintainer_lane":
      return ["- Public status: maintainer follow-up recommended.", "- Suggested next step: verify the public diff and repository impact."];
    case "likely_duplicate":
      return ["- Public status: possible overlap to verify.", "- Suggested next step: compare against linked public issues, active PRs, and recent merges."];
    case "close_or_redirect":
      return ["- Public status: triage may be needed before review.", "- Suggested next step: confirm whether the public PR context is still current and actionable."];
    case "needs_author":
      return ["- Public status: author input may be needed before deep review.", "- Suggested next step: ask for missing public context, tests, or validation details."];
    default:
      return ["- Public status: keep monitoring the public PR context.", "- Suggested next step: watch for public tests, checks, linked context, or related changes before prioritizing review."];
  }
}

function buildExtensionPrivateBlockers(reviewability: { noiseSources: string[]; maintainerNextSteps: string[]; privateSummary: string }) {
  const items = [...reviewability.noiseSources.slice(0, 5), ...reviewability.maintainerNextSteps.slice(0, 3)];
  if (items.length === 0) items.push("No private blocker detail is currently cached.");
  return items.map((detail, index) => ({ id: `blocker-${index + 1}`, detail: sanitizePublicComment(detail) }));
}

function ensureExtensionPublicSafeText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (/\b(wallet|hotkey|coldkey|raw trust score|trust score|estimated score|score estimate|reward estimate|payout|farming|private reviewability|reviewability\s*\d|\/100)\b/i.test(compact)) {
    return "# Public-safe PR packet\n\n- Public-safe packet unavailable. Regenerate after private context is sanitized.";
  }
  return text;
}

export const __routesInternals = {
  buildExtensionPublicSafePacket,
  buildExtensionPrivateBlockers,
  ensureExtensionPublicSafeText,
  authenticateRequestIdentity,
  issueQualityMap,
};
