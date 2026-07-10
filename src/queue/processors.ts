import {
  countOpenIssues,
  countOpenPullRequests,
  listOpenItemsForAuthorAcrossInstall,
  type OpenItemAcrossInstallRow,
  getAgentCommandAnswer,
  getInstallation,
  getLatestRepoGithubTotalsSnapshot,
  getFreshOfficialMinerDetection,
  getPullRequest,
  getPullRequestDetailSyncState,
  getRepoAuthorPullRequestHistory,
  getRepository,
  getDecryptedRepositoryAiKey,
  countByokAiEventsForRepoSince,
  getRepositorySettings,
  listCheckSummaries,
  listAllIssues,
  listAllPullRequests,
  listBounties,
  listBountiesByRepo,
  listContributorIssues,
  getIssue,
  listContributorPullRequests,
  listContributorRepoStats,
  getRepoSyncSegment,
  listIssues,
  listIssueSignalSample,
  listLatestSignalSnapshotsByTarget,
  listSignalSnapshots,
  listRepoGithubTotalsSnapshotHistory,
  listOtherOpenPullRequests,
  listOtherOpenPullRequestsForAuthor,
  listOpenIssues,
  listOpenPullRequests,
  listPullRequests,
  listPullRequestFiles,
  listRecentMergedPullRequests,
  updatePullRequestSlopAssessment,
  listRepoLabels,
  listRepoPullRequestFilePaths,
  listRepoSyncStates,
  listRepoSyncSegments,
  listRepositories,
  markInstallationDeleted,
  markRepositoriesRemovedFromInstallation,
  persistAdvisory,
  getCachedAiReview,
  getLatestPublishedAiReview,
  countPublishedAiReviewHeads,
  putCachedAiReview,
  markAiReviewPublished,
  getCachedAiSlopAdvisory,
  putCachedAiSlopAdvisory,
  getCachedLinkedIssueSatisfaction,
  putCachedLinkedIssueSatisfaction,
  markPullRequestsRegated,
  markPullRequestsBacklogConvergenceRegated,
  markPullRequestReviewsInvalidated,
  markPullRequestSurfacePublished,
  markPullRequestVisualCaptureSatisfied,
  getLatestRegatedAt,
  getLatestBacklogConvergenceRegatedAt,
  claimRegateFanoutSlot,
  claimBacklogConvergenceFanoutSlot,
  recordAgentCommandFeedback,
  recordAuditEvent,
  countRecentAuditEventsForActorAndTarget,
  countRecentAuditEventsForActorInRepo,
  countRecentAuditEventsForActorInRepoWithTargetSuffix,
  hasAuditEventForDelivery,
  hasAuditEventForHeadSha,
  recordGateBlockOutcome,
  getGateBlockOutcome,
  hasActiveReviewForHeadSha,
  getActiveReviewStartedAt,
  isDbFrozenForRepo,
  markGateOutcomeOverridden,
  markPullRequestLinkedIssueHardRuleViolated,
  startActiveReviewTracking,
  terminalizeActiveReviewTracking,
  bumpPullRequestDraftConversionCount,
  recordProductUsageEvent,
  recordAiUsageEvent,
  persistSignalSnapshot,
  recordWebhookEvent,
  replaceCollisionEdges,
  upsertRepoQueueTrendSnapshot,
  upsertAgentCommandAnswer,
  upsertCheckSummary,
  upsertOfficialMinerDetection,
  rollupProductUsageDaily,
  upsertBurdenForecast,
  upsertContributorEvidence,
  upsertContributorScoringProfile,
  upsertInstallation,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
} from "../db/repositories";
import { dedupeSignalSnapshots, pruneExpiredRecords } from "../db/retention";
import {
  effectiveIssueCapForAccountAge,
  isBelowAccountAgeThreshold,
  repoOwnerLoginFromFullName,
} from "./account-age-throttle";
import {
  backfillOpenPullRequestDetails,
  backfillRegisteredRepositories,
  backfillRepositorySegment,
  cachedFetchLivePullRequestMergeState,
  CI_STATE_CACHE_METRIC,
  deserializeCachedCiAggregate,
  enqueueRepositoryOpenDataBackfill,
  fetchAndStorePullRequestFilesForReview,
  fetchLinkedIssueFacts,
  fetchLiveBaseBranchAdvancedAt,
  fetchLiveCiAggregatePreferGraphQl,
  invalidateCiStateCache,
  isCiStateCacheFresh,
  type LiveCiAggregate,
  fetchLiveIssueState,
  fetchLivePullRequest,
  fetchLivePullRequestHeadSha,
  fetchLivePullRequestMergeState,
  fetchLivePullRequestReviewDecision,
  fetchLiveReviewThreadBlockers,
  fetchLivePullRequestState,
  fetchNamedCheckRunConclusion,
  fetchOpenPullRequestNumbersForCommit,
  fetchRequiredStatusContexts,
  invalidatePrStateCache,
  isReviewsCacheUpToDate,
  mergeRequiredCiContexts,
  primeDurablePrStateCache,
  refreshContributorActivity,
  refreshInstallationHealth,
  refreshPullRequestDetails,
  writeThroughCiStateCache,
} from "../github/backfill";
import {
  contributorRepoStatsFromGittensor,
  fetchGittensorContributorSnapshot,
  fetchOfficialGittensorMiner,
  type GittensorContributorSnapshot,
  type OfficialGittensorMinerDetection,
} from "../gittensor/api";
import {
  createInstallationToken,
  createOrUpdateCheckRun,
  createOrUpdateErroredGateCheckRun,
  createOrUpdateGateCheckRun,
  createOrUpdateOverriddenGateCheckRun,
  createOrUpdatePendingGateCheckRun,
  createOrUpdateSkippedGateCheckRun,
  getGithubUserCreatedAt,
  getInstallationId,
  getRepositoryCollaboratorPermission,
  githubErrorStatus,
  GITTENSORY_GATE_CHECK_NAME,
  isGitHubRateLimitedError,
  isForeignAppInstallation,
} from "../github/app";
import { isSelfAuthoredCiCompletionWebhook } from "../github/self-authored";
import {
  AGENT_COMMAND_COMMENT_MARKER,
  createOrUpdateAgentCommandComment,
  createOrUpdatePrIntelligenceComment,
  PR_PANEL_COMMENT_MARKER,
} from "../github/comments";
import {
  gittensoryFooter,
  gittensorRepoEarnUrl,
  maintainerControlPanelUrl,
} from "../github/footer";
import {
  buildMaintainerQueueDigest,
  buildPublicAgentCommandComment,
  type GittensoryMentionCommandName,
  isAiCostBearingCommand,
  isAuthorizedCommandActor,
  isGittensoryActionCommand,
  isMaintainerQueueDigestCommand,
  parseAgentCommandFeedbackContext,
  parseGittensoryMentionCommand,
  sanitizePublicComment,
} from "../github/commands";
import { classifyPrCommandRequest } from "../github/pr-command-request";
import { normalizeResolveFindingRef } from "../github/resolve-command";
import {
  ensurePullRequestLabel,
  removePullRequestLabel,
} from "../github/labels";
import {
  githubRateLimitAdmissionKeyForInstallation,
  githubRateLimitAdmissionKeyForToken,
  resolveRepoActionMode,
  type GitHubRateLimitAdmissionKey,
} from "../github/client";
import {
  fetchPullRequestFreshness,
  pullRequestFreshnessDetail,
  reviewedPullRequestHeadSha,
  type PullRequestFreshness,
} from "../github/pr-freshness";
import { DEFAULT_TYPE_LABELS, resolvePrTypeLabel } from "../settings/pr-type-label";
import { fetchLinkedIssueLabelsForPropagation } from "../review/linked-issue-label-propagation-fetch";
import { shouldPublishReviewCheck } from "../review/check-names";
import { fetchPublicContributorProfile } from "../github/public";
import { getLatestRegistrySnapshot, refreshRegistry } from "../registry/sync";
import {
  buildIssueAdvisory,
  buildPullRequestAdvisory,
  evaluateGateCheck,
  resolveAiReviewLowConfidenceHold,
} from "../rules/advisory";
import { hasValidationNote, isTestPath } from "../signals/test-evidence";
import { detectNotificationEvents } from "../notifications/events";
import {
  deliverNotification,
  detectIssueWatchEvents,
  evaluateNotificationEvent,
} from "../notifications/service";
import {
  getOrCreateScoringModelSnapshot,
  refreshScoringModelSnapshot,
} from "../scoring/model";
import {
  buildAndPersistContributorDecisionPack,
  loadDecisionPackSharedInputs,
} from "../services/decision-pack";
import {
  buildContributorEvidenceGraph,
  CONTRIBUTOR_EVIDENCE_GRAPH_SIGNAL,
  evidenceGraphTouchedRepoFullNames,
} from "../services/contributor-evidence-graph";
import {
  executeAgentRun,
  explainBlockersWithAgent,
  planNextWork,
  preflightBranchWithAgent,
  preparePrPacketWithAgent,
} from "../services/agent-orchestrator";
import {
  isAuthorizedGitHubSessionLogin,
  parseGitHubLoginList,
} from "../auth/security";
import {
  commandAuthorizationAllowedRoles,
  commandAuthorizationNeedsMinerDetection,
  evaluateCommandAuthorization,
} from "../settings/command-authorization";
import {
  findBlacklistEntry,
  isAuthorBlacklisted,
} from "../settings/contributor-blacklist";
import {
  DEFAULT_AUTO_MAINTAIN_POLICY,
  autonomyRequiresApproval,
  isActingAutonomyLevel,
  isAgentConfigured,
  resolveAutonomy,
} from "../settings/autonomy";
import {
  isGlobalAgentPause,
  resolveAgentActionMode,
  resolveAgentPermissionReadiness,
  type AgentActionMode,
} from "../settings/agent-execution";
import {
  ISSUE_WAKE_MAX_PRS,
  MERGE_WAKE_MAX_PRS,
  SWEEP_FANOUT_DEDUP_MS,
  BACKLOG_CONVERGENCE_SWEEP_FRESHNESS_MS,
  SWEEP_MAX_PRS,
  isRegateSweepDraining,
  selectRegateCandidates,
} from "../settings/agent-sweep";
import { selectBacklogConvergenceCandidates } from "../selfhost/backlog-convergence";
import {
  LOW_REST_RATE_LIMIT_REMAINING,
  MAINTENANCE_RESERVED_HEADROOM,
  delayUntil,
  shouldWaitForGitHubRateLimit,
} from "../github/rate-limit";
import {
  isScheduledRegateSweepJob,
  queueSnapshotBacklog,
  queueSnapshotFromBinding,
} from "../selfhost/queue-common";
import { aiReviewCacheInputFingerprint } from "../review/ai-review-cache-input";
import { aiSlopCacheInputFingerprint } from "../review/ai-slop-cache-input";
import { linkedIssueSatisfactionCacheInputFingerprint } from "../review/linked-issue-satisfaction-cache-input";
import {
  AGENT_LABEL_NEEDS_REVIEW,
  DEFAULT_REVIEW_EVASION_LABEL,
  downgradeCloseToHold,
  downgradeMergeToHold,
  MAX_REVIEW_NAG_COOLDOWN_DAYS,
  isProtectedAutomationAuthor,
  planAgentMaintenanceActions,
  type AgentDispositionLabelSettings,
  type PlannedAgentAction,
} from "../settings/agent-actions";
import { isAutoCloseExempt } from "../settings/auto-close-exempt";
import { resolveGlobalContributorOpenItemCap, resolveGlobalContributorOpenItemCapForMiner } from "../settings/global-contributor-cap";
import { detectMigrationCollisions, extractMigrationNumber, KNOWN_MIGRATION_DUPLICATES } from "../db/migration-collisions";
import { listMigrationFilenamesAtRef } from "../github/migration-tree";
import {
  applyModerationEscalationForRule,
  executeAgentMaintenanceActions,
  executeIssueMaintenanceActions,
  pendingClosureLabelApplied,
} from "../services/agent-action-executor";
import { processSubmitDraft } from "../services/draft";
import { loadIssueQualityReportMap } from "../services/issue-quality";
import { generateWeeklyValueReport } from "../services/weekly-value-report";
import { generateAndSendReviewRecap } from "../services/review-recap";
import {
  REPO_OUTCOME_PATTERNS_SIGNAL,
  computeRepoOutcomePatterns,
} from "../services/repo-outcome-patterns";
import {
  buildQueueTrendReport,
  QUEUE_TREND_HISTORY_DAYS,
} from "../services/queue-trends";
import {
  fileUpstreamDriftIssues,
  refreshUpstreamDrift,
} from "../upstream/ruleset";
import {
  buildFreshnessSloReport,
  freshnessAuditMetadata,
} from "../signals/data-quality";
import {
  buildBurdenForecast,
  buildCollisionEdges,
  buildCollisionReport,
  isPullRequestInDuplicateCluster,
  buildConfigQuality,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorStrategy,
  buildDuplicateWinnerRelatedWorkView,
  buildContributorIntakeHealth,
  buildIssueQualityReport,
  buildLabelAudit,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildPublicPrPanelSignalRows,
  buildPublicReadinessScore,
  buildPublicSafeCollapsibles,
  buildQueueHealth,
  buildRoleContext,
  detectGittensorContributor,
  hasClearNoIssueRationale,
  PR_PANEL_RETRIGGER_MARKER,
  PR_PANEL_GENERATE_TESTS_MARKER,
  type ContributorProfile,
} from "../signals/engine";
import { isDuplicateClusterWinnerByClaim, resolveDuplicateClusterWinnerNumber } from "../signals/duplicate-winner";
import { buildUnifiedReviewDiff, totalAddedLineCount } from "../review/review-diff";
import { estimateReviewEffort } from "../review/review-effort";
import { buildUnifiedCommentBody } from "../review/unified-comment-bridge";
import { isRetryableJobError, RetryableJobError } from "./retryable";
import {
  claimPrActuationLock,
  claimTransientLock,
  PrActuationLockContendedError,
  releasePrActuationLock,
  releaseTransientLockIfOwner,
  type TransientLockClaim,
} from "./transient-locks";
// #4013 step 1: temporary re-export shim so test/unit/queue.test.ts's existing
// `import { claimPrActuationLock, releasePrActuationLock } from "../../src/queue/processors"` keeps working
// unchanged -- those tests are deeply interspersed with unrelated ones in that file, not in a cleanly
// extractable describe block, so relocating them is deliberately deferred rather than forced into this PR.
export { claimPrActuationLock, releasePrActuationLock } from "./transient-locks";
import { screenshotsAllowed } from "../review/visual-wire";
import { isVisualPath } from "../review/visual/paths";
import { buildCapture, fetchShotContentBlock, hasSuccessfulBotCapture, resolveVisualRoutes, type CaptureRoute } from "../review/visual/capture";
import {
  clearFallbackDispatchMarker,
  fallbackShotFileName,
  fallbackShotR2Key,
  fetchFallbackArtifactShots,
  FALLBACK_WORKFLOW_NAME,
  parseFallbackRunCorrelation,
} from "../review/visual/actions-fallback";
import {
  buildVisualRegressionFindings,
  buildVisualVisionUserPrompt,
  evaluateVisualVisionGate,
  parseVisualVisionResponse,
  VISUAL_VISION_SYSTEM_PROMPT,
} from "../review/visual/visual-findings";
import { incr } from "../selfhost/metrics";
import { withAdvisoryAiEnv } from "../selfhost/ai";
import {
  renderReviewingPlaceholder,
  shouldPostReviewingPlaceholder,
  type CheckFailureDetail,
  type MergeReadiness,
} from "../review/unified-comment";
import {
  buildIssueSlopAssessment,
  buildSlopAssessment,
  type SlopBand,
} from "../signals/slop";
import { runGittensoryAiSlopAdvisory } from "../services/ai-slop";
import { runGittensoryLinkedIssueSatisfaction } from "../services/linked-issue-satisfaction-run";
import { decidePublicSurface } from "../signals/settings-preview";
import {
  buildFocusManifestGuidance,
  composeRepoReviewContext,
  composeManifestReviewInstructions,
  filterReviewFilesForAi,
  resolvePullRequestAutoReviewSkipReason,
  resolveAutoReviewSkipSummary,
  isContributorControlledAutoReviewSkipReason,
  resolveRepoEnrichmentToggles,
  resolveReviewAutoReviewConfig,
  isAutoReviewCommitThresholdReached,
  resolveReviewPathInstructions,
  resolveReviewPreMergeChecks,
  resolveReviewPromptOverrides,
  resolveReviewMemoryManifestToggle,
  resolveReviewVisualConfig,
  type FocusManifestFinding,
  type FocusManifest,
  type ReviewPathInstruction,
  type ReviewProfile,
  type ReviewFindingSeverity,
  type SelfHostAiModelConfig,
  type VisualConfig,
} from "../signals/focus-manifest";
import { decideReviewEligibility } from "../review/review-eligibility";
import {
  loadPublicRepoFocusManifest,
  loadRepoFocusManifest,
  loadRepoFocusManifests,
  loadRepoReviewContext,
  mapWithConcurrencyLimit,
} from "../signals/focus-manifest-loader";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { getLastRepoDocRefreshAttemptedAtBulk, performRepoDocRefresh } from "../github/repo-doc-refresh-runner";
import { isRepoDocRefreshDue } from "../review/repo-doc-refresh-schedule";
import type { LocalBranchAnalysisInput } from "../signals/local-branch";
import {
  callAiProvider,
  clampNumber,
  DEFAULT_BYOK_DAILY_REPO_LIMIT,
  hasPublicReviewAssessment,
  isEnabled,
  runGittensoryAiReview,
  utcDayStartIso,
  type AiReviewActualUsage,
  type InlineFinding,
} from "../services/ai-review";
import {
  maybePostInlineComments,
  shouldRenderFindingCategories,
  shouldRenderSuggestions,
  shouldRequestInlineFindings,
} from "../review/inline-comments";
import { evaluateClaCheck } from "../review/cla-check";
import { evaluatePreMergeChecks } from "../review/pre-merge-checks";
import { secretLeakFinding } from "../review/safety";
import { lockfileTamperRiskFinding } from "../review/lockfile-tamper";
import {
  buildIssuePlanComment,
  classifyPlanCommandRequest,
  generateIssuePlan,
  isPlanCommand,
  isPlannerEnabled,
} from "../review/planner";
import { classifyConfigurationCommandRequest } from "../github/configuration-command";
import { summarizeEffectiveConfig } from "../settings/effective-config-summary";
import {
  buildReviewGroundingText,
  checkSummaryText as checkFailureSummaryText,
  isGroundingEnabled,
  makeGithubFileFetcher,
} from "../review/grounding-wire";
import {
  enrichSecretScanFilesWithPatchFallback,
  hasPatchLessSecretScanCandidates,
  incompletePatchLessSecretScanFinding,
  markEligiblePatchLessFilesIncomplete,
} from "./patchless-secret-scan";
import {
  attributeReviewRagTelemetry,
  buildReviewRagContextWithMetrics,
  emptyReviewRagTelemetry,
  isRagEnabled,
} from "../review/rag-wire";
import { createReviewAdapters } from "../review/adapters";
import { extractChangedSymbols } from "../review/impact-symbols";
import { computeImpactMap, type ImpactMapEntry } from "../review/impact-map";
import { formatImpactMapPromptSection, shouldComputeImpactMap } from "../review/impact-map-wire";
import { shouldEmitFixHandoff } from "../review/fix-handoff";
import { buildFixHandoffBlocks } from "../review/fix-handoff-render";
import { buildE2eTestGenCommentBody, type E2eTestGenCommitOutcome } from "../review/e2e-test-gen-render";
import { resolveE2eTestGenInstructions, runGittensoryE2eTestGeneration } from "../services/ai-e2e-test-gen";
import { commitE2eTestToPrBranch } from "../github/e2e-test-commit";
import {
  buildRepoCultureProfileContext,
  isRepoCultureProfileEnabled,
} from "../review/repo-culture-profile-wire";
import { applyReviewMemorySuppression, getCachedReviewSuppressions, invalidateReviewSuppressionCache, shouldApplyReviewMemory } from "../review/review-memory-wire";
import {
  buildReviewEnrichment,
  isEnrichmentEnabled,
  isReesGithubTokenForwardingEnabled,
  resolveEnrichmentLinkedIssue,
  resolveEnrichmentLinkedIssueNumbers,
} from "../review/enrichment-wire";
import { captureReviewFailure } from "../selfhost/sentry";
import {
  setReviewPipelineSpanOutcome,
  withReviewPipelineSpan,
} from "../selfhost/review-tracing";
import { evaluateWithSurfaceLane } from "../review/content-lane-wire";
import { reviewThreadBlockerFinding } from "../review/review-thread-findings";
import { indexRepo, reindexChangedPaths } from "../review/rag-index";
import {
  getEffectiveSubmitterReputation,
  isReputationEnabled,
  recordReputationOutcome,
  shouldSkipAiForReputation,
} from "../review/reputation-wire";
import {
  isConvergenceRepoAllowed,
  listConvergenceRepos,
} from "../review/cutover-gate";
import {
  convergedFeatureActive,
  resolveConvergedFeature,
} from "../review/feature-activation";
import {
  deploymentStatusToPreview,
  parseRepo,
  type DeploymentStatusPayload,
} from "../review/visual/preview-url";
import { resolveHardGuardrailGlobs } from "../review/guardrail-config";
import { guardrailPathMatches, isGuardrailHit } from "../signals/change-guardrail";
import {
  closePullRequest,
  createIssueComment,
  getLastCloserLogin,
  getLastReopenerLogin,
  reopenPullRequest,
} from "../github/pr-actions";
import {
  loadLinkedIssueHardRules,
  mergeLinkedIssueHardRuleWithPersistedViolation,
  resolveLinkedIssueHardRule,
  resolveLinkedIssueHasOpenReference,
} from "../review/linked-issue-hard-rules";
import { DEFAULT_UNLINKED_ISSUE_GUARDRAIL } from "../review/unlinked-issue-guardrail-config";
import { resolveUnlinkedIssueMatchDisposition } from "../review/unlinked-issue-guardrail";
import { DEFAULT_SCREENSHOT_TABLE_GATE, evaluateScreenshotTableGate } from "../review/screenshot-table-gate";
import { isOpsEnabled, runOpsAlerts } from "../review/ops-wire";
import { isRecapEnabled, resolveMaintainerRecapManifestOverride, runMaintainerRecapJob } from "../review/maintainer-recap-wire";
import { isSweepWatchdogEnabled, runSweepLivenessWatchdog } from "../review/sweep-watchdog";
import { isPrReconciliationEnabled, runOpenPrReconciliation } from "../review/pr-reconciliation";
import { isSelfTuneEnabled, runSelfTune } from "../review/selftune-wire";
import {
  isCloseHoldOnly,
  isHoldOnly,
  recordPrOutcome,
  recordReversalSignals,
  runSelfTuneBreaker,
} from "../review/outcomes-wire";
import { neutralHoldReasonCode, nativeGateActionFromConclusion, recordNativeGateDecision } from "../review/parity-wire";
import { recordContributorGateDecision } from "../review/contributor-calibration";
import { recordPredictedGateCalibration } from "../review/predicted-gate-calibration-ledger";
import type { SubmissionOutcome } from "../review/submitter-reputation";
import type {
  AdvisoryFinding,
  AiContentBlock,
  ContributorEvidenceRecord,
  ContributorRepoStatRecord,
  DetectedNotificationEvent,
  GateRuleMode,
  GitHubWebhookPayload,
  IssueRecord,
  JobMessage,
  JsonValue,
  PullRequestFilePathRecord,
  PullRequestRecord,
  RepositoryCommandAuthorizationPolicy,
  RepositoryRecord,
  RepositorySettings,
} from "../types";
import { retryFailedRelays } from "../orb/relay";
import { sha256Hex } from "../utils/crypto";
import { errorMessage, nowIso } from "../utils/json";
import { maybeSuggestMilestoneMatchForPr } from "../integrations/project-tracker-adapter";

const OFFICIAL_MINER_DETECTION_TTL_MS = 5 * 60 * 1000;
const OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS = 60 * 1000;
const PER_PR_REGATE_BACKPRESSURE_TYPES = ["agent-regate-pr"] as const;
const SWEEP_OPEN_PULL_REQUEST_SYNC_MAX_AGE_MS = 10 * 60 * 1000;
const PR_PANEL_RETRIGGER_COMMAND_AUTHORIZATION: RepositoryCommandAuthorizationPolicy = {
  default: ["maintainer", "collaborator"],
  commands: { "review-now": ["maintainer", "collaborator"] },
};
// #4589: the generate-tests checkbox is hardcoded to maintainer-only regardless of what a repo's own
// .gittensory.yml commandAuthorization might configure for the text-command version of generate-tests (which
// CAN be widened to collaborator/confirmed_miner) -- a one-click checkbox is meaningfully lower-friction than
// typing a command, so it gets a hard floor that can't be misconfigured away. Mirrors
// PR_PANEL_RETRIGGER_COMMAND_AUTHORIZATION's exact same override pattern, one tier narrower (no collaborator).
const PR_PANEL_GENERATE_TESTS_COMMAND_AUTHORIZATION: RepositoryCommandAuthorizationPolicy = {
  default: ["maintainer"],
  commands: { "generate-tests": ["maintainer"] },
};
const PR_PUBLIC_SURFACE_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "edited",
]);
const PR_GATE_CLOSED_ACTIONS = new Set(["closed"]);
const ISSUE_PLAN_COOLDOWN_MS = 10 * 60 * 1000;
const NOTIFY_EVALUATE_EVENTS_PER_JOB = 100;

type RequiredStatusContextsLookup = { requiredContexts: Set<string> | null; resolved: boolean };

interface LiveGithubFacts {
  requiredContexts: Map<string, Promise<RequiredStatusContextsLookup>>;
  ciAggregates: Map<string, Promise<LiveCiAggregate>>;
  mergeStates: Map<string, Promise<string | undefined>>;
  // #4498: which ciAggregates/mergeStates keys were populated by a FORCED (refreshLiveCiAggregate/
  // refreshLiveMergeState) write THIS pass, as opposed to a cached* reader's write -- the cached* variants can
  // populate the SAME map/key from the DURABLE cross-webhook cache (potentially stale, e.g. readiness's own
  // cachedLiveCiAggregate check), so a plain "is there anything in the map for this key" check cannot tell a
  // genuinely-fresh forced value apart from a possibly-stale cached one. reuseOrRefreshLiveCiAggregate/
  // reuseOrRefreshLiveMergeState only ever reuse a memoized value when its key is ALSO in these sets.
  forcedCiAggregateKeys: Set<string>;
  forcedMergeStateKeys: Set<string>;
}

function createLiveGithubFacts(): LiveGithubFacts {
  return {
    requiredContexts: new Map(),
    ciAggregates: new Map(),
    mergeStates: new Map(),
    forcedCiAggregateKeys: new Set(),
    forcedMergeStateKeys: new Set(),
  };
}

function liveFactKey(...parts: Array<string | number | null | undefined>): string {
  return JSON.stringify(parts.map((part) => [typeof part, part]));
}

function liveFactTokenPart(token: string | undefined): string {
  if (!token) return "token:none";
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `token:${token.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function chunkNotificationEvents(events: DetectedNotificationEvent[]): DetectedNotificationEvent[][] {
  const chunks: DetectedNotificationEvent[][] = [];
  for (let start = 0; start < events.length; start += NOTIFY_EVALUATE_EVENTS_PER_JOB) {
    chunks.push(events.slice(start, start + NOTIFY_EVALUATE_EVENTS_PER_JOB));
  }
  return chunks;
}

function githubAdmissionKeyForToken(
  env: Env,
  installationId: number | null | undefined,
  token: string | undefined,
): GitHubRateLimitAdmissionKey | undefined {
  return githubRateLimitAdmissionKeyForToken(env, token, installationId);
}

function primeLiveMergeState(
  facts: LiveGithubFacts,
  repoFullName: string,
  prNumber: number,
  token: string | undefined,
  mergeState: unknown,
): void {
  if (typeof mergeState !== "string") return;
  facts.mergeStates.set(
    liveFactKey(repoFullName, prNumber, liveFactTokenPart(token)),
    Promise.resolve(mergeState),
  );
}

// Stable, order-independent cache-key fragment for settings.expectedCiContexts (#selfhost-ci-verification):
// a config change must never reuse a stale required-contexts/live-CI cache entry from before the change, and
// two equal sets in different orders must hit the SAME cache entry rather than needlessly duplicating fetches.
function expectedCiContextsKeyPart(expectedCiContexts: ReadonlyArray<string> | null | undefined): string {
  if (!expectedCiContexts || expectedCiContexts.length === 0) return "";
  return [...expectedCiContexts].sort().join("\0");
}

// Stable, order-independent cache-key fragment for the RESOLVED required-contexts set (#selfhost-ci-verification):
// unlike expectedCiContextsKeyPart above (the raw, unresolved settings.expectedCiContexts config), this reflects
// mergeRequiredCiContexts' actual output -- live branch-protection required contexts unioned with config. The
// durable cross-job CI-state cache (cachedFetchLiveCiAggregate) MUST key on this, not on the raw config: branch
// protection can change server-side while expectedCiContexts config stays put, and a stale durable row keyed only
// on the unchanged config would keep serving an aggregate computed against the old required-context set.
function resolvedRequiredContextsKeyPart(requiredContexts: ReadonlySet<string> | null | undefined): string {
  if (!requiredContexts || requiredContexts.size === 0) return "";
  return JSON.stringify([...requiredContexts].sort());
}

// RC2 + #selfhost-ci-verification: the EFFECTIVE required-status-check contexts for this repo/baseRef, merging
// live branch-protection required contexts with the maintainer-configured settings.expectedCiContexts fallback
// (mergeRequiredCiContexts — branch protection stays authoritative when readable; expectedCiContexts is the
// SOLE source when it is null/empty). Downstream callers (fetchLiveCiAggregate et al.) never distinguish the
// two sources — they only see one effective required-contexts set, same as before this field existed.
function cachedRequiredStatusContexts(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  baseRef: string | null | undefined,
  token: string | undefined,
  expectedCiContexts: ReadonlyArray<string> | null | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<RequiredStatusContextsLookup> {
  const key = liveFactKey(repoFullName, baseRef, liveFactTokenPart(token), expectedCiContextsKeyPart(expectedCiContexts));
  const cached = facts.requiredContexts.get(key);
  if (cached) return cached;
  let branchProtectionFetchFailed = false;
  const next = evictLiveFactOnReject(
    facts.requiredContexts,
    key,
    fetchRequiredStatusContexts(env, repoFullName, baseRef, token, admissionKey, () => {
      branchProtectionFetchFailed = true;
    }).then((branchProtectionContexts) => ({
      requiredContexts: mergeRequiredCiContexts(branchProtectionContexts, expectedCiContexts),
      resolved: !branchProtectionFetchFailed,
    })),
  );
  facts.requiredContexts.set(key, next);
  return next;
}

function evictLiveFactOnReject<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  promise: Promise<T>,
): Promise<T> {
  return promise.catch((error) => {
    cache.delete(key);
    throw error;
  });
}

/**
 * Cached read of the live CI aggregate, backed by pull_request_detail_sync_state (#selfhost-ci-verification,
 * sibling to the #2537 PR-state cache in backfill.ts). A fresh cache row (webhook-invalidated on
 * check_run/check_suite `completed` via invalidateCiStateCache, capped at CI_STATE_CACHE_MAX_AGE_MS) is served
 * without a GitHub call; otherwise fetches live via fetchLiveCiAggregatePreferGraphQl and write-throughs the
 * result via writeThroughCiStateCache. Fail-open throughout: any cache read/write hiccup falls back to /
 * degrades to a live fetch, never blocks it.
 *
 * `forceRefresh` (set by refreshLiveCiAggregate below, mirroring refreshLiveMergeState's OWN "never durable-
 * cached" contract for merge-state): skips the freshness CHECK entirely (the existing row is still fetched, to
 * carry its `status` field into the write-through's previousState, but is never treated as a hit), so this always
 * fetches live -- a "refresh" caller needs a genuinely fresh read even within the SAME job pass (e.g. re-checking
 * CI right after this pass's own gate/check-run publication, which can flip a status GitHub hasn't sent a webhook
 * for yet). The WRITE-through still happens on a forced refresh, so a LATER pass/job still benefits from this read.
 *
 * Deliberately implemented HERE, not in backfill.ts (where writeThroughCiStateCache/isCiStateCacheFresh/
 * deserializeCachedCiAggregate live) -- a same-module call from backfill.ts to its own
 * fetchLiveCiAggregatePreferGraphQl would be invisible to `vi.spyOn(backfillModule,
 * "fetchLiveCiAggregatePreferGraphQl")`, which many existing tests already rely on to intercept the CROSS-module
 * call this file has always made. Keeping the orchestration here preserves that exact, already-tested call shape.
 *
 * NEVER call this from an act-boundary merge/close decision -- services/agent-approval-queue.ts and
 * services/agent-action-executor.ts call fetchLiveCiAggregate/fetchLiveCiAggregatePreferGraphQl directly, by
 * design, and must keep doing so.
 */
async function cachedFetchLiveCiAggregate(
  env: Env,
  repoFullName: string,
  prNumber: number,
  headSha: string | null | undefined,
  token: string | undefined,
  requiredContexts: ReadonlySet<string> | null | undefined,
  requiredContextsKey: string,
  forceRefresh: boolean,
  // False when the caller's own required-context lookup FAILED (not merely resolved to "none configured") --
  // that fail-open aggregate must never be persisted under the normal key, or a transient lookup error would
  // mask the repo's real required-context state for every other reader until the entry's TTL expires (#selfhost-
  // ci-verification gate review finding). The live-fetched aggregate is still returned to THIS caller either way.
  requiredContextsResolved: boolean,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate> {
  const cached = await getPullRequestDetailSyncState(env, repoFullName, prNumber).catch(() => null);
  if (!forceRefresh && cached && isCiStateCacheFresh(cached, headSha, requiredContextsKey)) {
    const deserialized = deserializeCachedCiAggregate(cached);
    if (deserialized) {
      incr(CI_STATE_CACHE_METRIC, { field: "aggregate", result: "hit" });
      return deserialized;
    }
  }
  incr(CI_STATE_CACHE_METRIC, { field: "aggregate", result: forceRefresh ? "forced" : "miss" });
  const live = await fetchLiveCiAggregatePreferGraphQl(env, repoFullName, headSha, token, requiredContexts, admissionKey);
  if (requiredContextsResolved) {
    await writeThroughCiStateCache(env, repoFullName, prNumber, cached, headSha, requiredContextsKey, live);
  }
  return live;
}

function fetchLiveCiAggregateWithRequiredContexts(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  headSha: string | null | undefined,
  baseRef: string | null | undefined,
  token: string | undefined,
  expectedCiContexts: ReadonlyArray<string> | null | undefined,
  forceRefresh: boolean,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate> {
  // CI refresh callers need fresh check/status state; branch protection contexts move slowly enough to stay
  // request-cached. When the #1941 flag is on, fetchLiveCiAggregatePreferGraphQl collapses the check/status reads
  // into one GraphQL rollup (reusing these requiredContexts), else it uses the proven REST aggregate.
  // cachedFetchLiveCiAggregate (#selfhost-ci-verification) is the durable, cross-job snapshot cache sibling to
  // this request-scoped LiveGithubFacts memo -- it is only ever consulted here, on a LiveGithubFacts miss.
  return cachedRequiredStatusContexts(env, repoFullName, facts, baseRef, token, expectedCiContexts, admissionKey)
    .catch(() => ({ requiredContexts: null, resolved: false }))
    .then(({ requiredContexts, resolved }) =>
      cachedFetchLiveCiAggregate(env, repoFullName, prNumber, headSha, token, requiredContexts, resolvedRequiredContextsKeyPart(requiredContexts), forceRefresh, resolved, admissionKey),
    );
}

function cachedLiveCiAggregate(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  headSha: string | null | undefined,
  baseRef: string | null | undefined,
  token: string | undefined,
  expectedCiContexts: ReadonlyArray<string> | null | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate> {
  const key = liveFactKey(repoFullName, headSha, baseRef, liveFactTokenPart(token), expectedCiContextsKeyPart(expectedCiContexts));
  const cached = facts.ciAggregates.get(key);
  if (cached) return cached;
  const next = evictLiveFactOnReject(
    facts.ciAggregates,
    key,
    fetchLiveCiAggregateWithRequiredContexts(
      env,
      repoFullName,
      facts,
      prNumber,
      headSha,
      baseRef,
      token,
      expectedCiContexts,
      false,
      admissionKey,
    ),
  );
  facts.ciAggregates.set(key, next);
  return next;
}

function refreshLiveCiAggregate(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  headSha: string | null | undefined,
  baseRef: string | null | undefined,
  token: string | undefined,
  expectedCiContexts: ReadonlyArray<string> | null | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate> {
  const key = liveFactKey(repoFullName, headSha, baseRef, liveFactTokenPart(token), expectedCiContextsKeyPart(expectedCiContexts));
  const next = evictLiveFactOnReject(
    facts.ciAggregates,
    key,
    fetchLiveCiAggregateWithRequiredContexts(
      env,
      repoFullName,
      facts,
      prNumber,
      headSha,
      baseRef,
      token,
      expectedCiContexts,
      true,
      admissionKey,
    ),
  );
  facts.ciAggregates.set(key, next);
  facts.forcedCiAggregateKeys.add(key);
  return next;
}

function cachedLiveMergeState(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const key = liveFactKey(repoFullName, prNumber, liveFactTokenPart(token));
  const cached = facts.mergeStates.get(key);
  if (cached) return cached;
  // #2537: on a request-local miss, check the DURABLE cross-webhook cache before hitting GitHub — this is the
  // readiness/freshness-guard path, not the act-boundary disposition (that's refreshLiveMergeState below, which
  // NEVER routes through the durable cache). A durable hit is itself memoized request-locally for the rest of
  // this pass via facts.mergeStates, same as a live fetch would be.
  const next = evictLiveFactOnReject(
    facts.mergeStates,
    key,
    cachedFetchLivePullRequestMergeState(env, repoFullName, prNumber, token, admissionKey),
  );
  facts.mergeStates.set(key, next);
  return next;
}

// #4220 contradiction: the stored pr.mergeableState lags GitHub's async recompute, so a base-conflicting PR could
// read clean here (safe to merge) while the disposition reads the live dirty and auto-CLOSES it. This ALWAYS
// force-refetches live from GitHub and MUST NEVER be routed through the durable pull_request_detail_sync_state
// cache added by #2537 — both act-boundary-adjacent callers (runAgentMaintenancePlanAndExecute's disposition
// input, and the unified-comment mirror) depend on this staying live and uncached.
function refreshLiveMergeState(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const key = liveFactKey(repoFullName, prNumber, liveFactTokenPart(token));
  const next = evictLiveFactOnReject(
    facts.mergeStates,
    key,
    fetchLivePullRequestMergeState(env, repoFullName, prNumber, token, admissionKey),
  );
  facts.mergeStates.set(key, next);
  facts.forcedMergeStateKeys.add(key);
  return next;
}

// #4498: reuses THIS PASS's own already-FORCED-live-refreshed value when an earlier refreshLiveMergeState/
// refreshLiveCiAggregate call in the SAME webhook pass (sharing the SAME `facts` object and key -- e.g.
// maybePublishPrPublicSurface's own post-gate-publish refresh) already populated the request-local memo,
// instead of re-fetching the identical resource from GitHub a second time. Deliberately NOT a plain "is
// something in facts.mergeStates/ciAggregates for this key" check: cachedLiveMergeState/cachedLiveCiAggregate
// (the READINESS-path reader) populate the SAME map/key from the DURABLE cross-webhook cache on their own
// request-local miss -- a durable-cache HIT there can be an OLDER webhook's snapshot, exactly what
// refreshLiveMergeState's #4220 doc comment above prohibits for this act-boundary-adjacent disposition input.
// So this only reuses a memoized value when its key is ALSO in forcedMergeStateKeys/forcedCiAggregateKeys --
// i.e. it was written by a FORCED (genuinely-live-this-pass) call, never by a cached-path reader. On a genuine
// miss (no forced call ran yet this pass, e.g. unifiedCommentAllowed was false) this falls through to a REAL
// live refresh, so behavior can only ever improve (fewer calls) over the pre-fix code, never go staler.
function reuseOrRefreshLiveMergeState(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  token: string | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<string | undefined> {
  const key = liveFactKey(repoFullName, prNumber, liveFactTokenPart(token));
  const cached = facts.forcedMergeStateKeys.has(key) ? facts.mergeStates.get(key) : undefined;
  if (cached) return cached;
  return refreshLiveMergeState(env, repoFullName, facts, prNumber, token, admissionKey);
}

function reuseOrRefreshLiveCiAggregate(
  env: Env,
  repoFullName: string,
  facts: LiveGithubFacts,
  prNumber: number,
  headSha: string | null | undefined,
  baseRef: string | null | undefined,
  token: string | undefined,
  expectedCiContexts: ReadonlyArray<string> | null | undefined,
  admissionKey?: GitHubRateLimitAdmissionKey,
): Promise<LiveCiAggregate> {
  const key = liveFactKey(repoFullName, headSha, baseRef, liveFactTokenPart(token), expectedCiContextsKeyPart(expectedCiContexts));
  const cached = facts.forcedCiAggregateKeys.has(key) ? facts.ciAggregates.get(key) : undefined;
  if (cached) return cached;
  return refreshLiveCiAggregate(env, repoFullName, facts, prNumber, headSha, baseRef, token, expectedCiContexts, admissionKey);
}

/**
 * Run (or dry-run) the data-retention prune across the configured log/snapshot tables, plus the
 * signal_snapshots dedup pass (#3810 -- signal_snapshots has no natural dedup, so within its own
 * retention window a key can still accumulate many superseded rows), and audit the combined outcome.
 * The per-table windows live in RETENTION_POLICY; only append-only/superseded tables are pruned.
 */
export async function runRetentionPrune(
  env: Env,
  requestedBy: string,
  dryRun: boolean,
): Promise<void> {
  const results = await pruneExpiredRecords(env, { dryRun });
  const dedupeResults = await dedupeSignalSnapshots(env, { dryRun });
  const totalDeleted = results.reduce((sum, result) => sum + result.deleted, 0);
  const totalDeduped = dedupeResults.reduce((sum, result) => sum + result.deleted, 0);
  await recordAuditEvent(env, {
    eventType: "retention.prune",
    actor: requestedBy,
    outcome: dryRun ? "completed" : "success",
    detail: dryRun
      ? `dry-run: ${totalDeleted} row(s) eligible, ${totalDeduped} duplicate signal_snapshots row(s) eligible`
      : `pruned ${totalDeleted} row(s), deduped ${totalDeduped} signal_snapshots row(s)`,
    metadata: {
      dryRun,
      totalDeleted,
      perTable: Object.fromEntries(results.map((r) => [r.table, r.deleted])),
      totalDeduped,
      perSignalType: Object.fromEntries(dedupeResults.map((r) => [r.signalType, r.deleted])),
    },
  });
}

const PUBLIC_MANIFEST_POLICY_FINDING_OVERRIDES: Partial<
  Record<
    FocusManifestFinding["code"],
    Pick<AdvisoryFinding, "title" | "detail" | "action">
  >
> = {
  manifest_missing_tests: {
    title: "Configured validation evidence missing",
    detail: "No changed test files or passing validation evidence were detected for this PR.",
    action:
      "Add regression/invariant coverage, update relevant tests, or attach passing validation output that satisfies the repo's configured expectations.",
  },
};

// #4583: surfaces the AI test-generation command right where a maintainer already sees the missing-coverage
// finding, mirroring CodeRabbit's inline "Generate unit tests" walkthrough checkbox instead of requiring the
// maintainer to already know the `@gittensory generate-tests` command exists from documentation alone.
const E2E_TEST_GEN_CTA = "Maintainers can also comment `@gittensory generate-tests` for an AI-generated Playwright test.";

export function publicSafeManifestPolicyFinding(
  finding: FocusManifestFinding,
  options: { e2eTestGenAvailable?: boolean } = {},
): AdvisoryFinding {
  const base: AdvisoryFinding = {
    code: finding.code,
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail,
    /* v8 ignore next -- the three manifest policy findings always carry an action; the no-action arm is unreachable. */
    ...(finding.action !== undefined ? { action: finding.action } : {}),
    // Override the leaky title/detail/action with static, public-safe text for codes whose raw text would echo
    // private blocked-path globs / test expectations; codes absent from the table keep their already-generic text.
    ...PUBLIC_MANIFEST_POLICY_FINDING_OVERRIDES[finding.code],
  };
  // Only appended when e2eTests is actually enabled for this repo (the SAME resolveConvergedFeature check the
  // #4196 auto-trigger already gates on), so an unconfigured repo is never told about a command that would just
  // bounce with "not enabled" -- and only for the missing-tests finding, the one case where the command is a
  // directly relevant next step rather than noise on an unrelated finding. base.action is always defined here
  // (PUBLIC_MANIFEST_POLICY_FINDING_OVERRIDES.manifest_missing_tests always sets one), the same always-populated
  // guarantee the v8-ignore above already documents for this code path.
  if (finding.code === "manifest_missing_tests" && options.e2eTestGenAvailable) {
    return { ...base, action: `${base.action} ${E2E_TEST_GEN_CTA}` };
  }
  return base;
}

export async function processJob(env: Env, message: JobMessage): Promise<void> {
  switch (message.type) {
    case "refresh-registry":
      await refreshRegistry(env);
      return;
    case "backfill-registered-repos":
      if (!message.repoFullName && message.requestedBy !== "test") {
        const repositories = (await listRepositories(env)).filter(
          (repo) => repo.isRegistered,
        );
        if (repositories.length > 0) {
          const delayStepSeconds =
            message.mode === "full" || message.mode === "resume" ? 45 : 15;
          await Promise.all(
            repositories.map((repo, index) => {
              const repoMessage: JobMessage = {
                type: "backfill-registered-repos",
                requestedBy: message.requestedBy,
                repoFullName: repo.fullName,
                ...(message.force === undefined
                  ? {}
                  : { force: message.force }),
                ...(message.mode === undefined ? {} : { mode: message.mode }),
              };
              const delaySeconds = Math.min(index * delayStepSeconds, 900);
              return delaySeconds > 0
                ? env.JOBS.send(repoMessage, { delaySeconds })
                : env.JOBS.send(repoMessage);
            }),
          );
          return;
        }
      }
      if (message.repoFullName && message.requestedBy !== "test") {
        await enqueueRepositoryOpenDataBackfill(env, {
          repoFullName: message.repoFullName,
          requestedBy: message.requestedBy,
          ...(message.force === undefined ? {} : { force: message.force }),
          ...(message.mode === undefined ? {} : { mode: message.mode }),
        });
        return;
      }
      await backfillRegisteredRepositories(env, {
        ...(message.repoFullName ? { repoFullName: message.repoFullName } : {}),
        requestedBy: message.requestedBy,
        ...(message.force === undefined ? {} : { force: message.force }),
        ...(message.mode === undefined ? {} : { mode: message.mode }),
      });
      return;
    case "backfill-repo-segment":
      await backfillRepositorySegment(env, {
        repoFullName: message.repoFullName,
        segment: message.segment,
        requestedBy: message.requestedBy,
        ...(message.mode === undefined ? {} : { mode: message.mode }),
        ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
        ...(message.force === undefined ? {} : { force: message.force }),
      });
      return;
    case "backfill-pr-details":
      await backfillOpenPullRequestDetails(env, {
        repoFullName: message.repoFullName,
        ...(message.mode === undefined ? {} : { mode: message.mode }),
        ...(message.cursor === undefined ? {} : { cursor: message.cursor }),
      });
      return;
    case "refresh-installation-health":
      await refreshInstallationHealth(env);
      return;
    case "generate-signal-snapshots":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutRepoSignalSnapshotJobs(env, message.requestedBy);
        return;
      }
      await generateSignalSnapshots(env, message.repoFullName);
      return;
    case "refresh-scoring-model":
      await refreshScoringModelSnapshot(env);
      return;
    case "refresh-upstream-drift":
      await refreshUpstreamDrift(env);
      return;
    case "file-upstream-drift-issues":
      await fileUpstreamDriftIssues(env);
      return;
    case "build-contributor-evidence":
      await buildContributorEvidence(env, message.login, message.logins);
      return;
    case "build-contributor-decision-packs":
      await buildContributorDecisionPacks(env, message.login);
      return;
    case "refresh-contributor-activity":
      await refreshContributorActivity(
        env,
        message.login,
        message.repoFullName ? { repoFullName: message.repoFullName } : {},
      );
      return;
    case "build-burden-forecasts":
      await buildBurdenForecasts(env, message.repoFullName);
      return;
    case "repair-data-fidelity":
      await repairDataFidelity(env, message.requestedBy);
      return;
    case "rollup-product-usage":
      await rollupProductUsageDaily(env, {
        ...(message.day ? { day: message.day } : {}),
        ...(message.days === undefined ? {} : { days: message.days }),
      });
      return;
    case "prune-retention":
      await runRetentionPrune(
        env,
        message.requestedBy,
        message.dryRun ?? false,
      );
      return;
    case "generate-weekly-value-report":
      await generateWeeklyValueReport(env, {
        variant: message.variant ?? "operator",
        ...(message.days === undefined ? {} : { days: message.days }),
      });
      return;
    case "generate-review-recap":
      await runReviewRecapJob(env, message.repoFullName, message.windowDays);
      return;
    case "generate-maintainer-recap": {
      // Convergence (maintainer recap digest, flag GITTENSORY_MAINTAINER_RECAP, #1963/#2248, config-as-code
      // override #2250). Defense-in-depth: the cron only ENQUEUES this when enabled, but a stale in-flight job
      // that lands after a flag-flip (env OR manifest) must still no-op, so disabled does zero work here too.
      const maintainerRecapOverride = await resolveMaintainerRecapManifestOverride(env);
      if (isRecapEnabled(env, maintainerRecapOverride)) await runMaintainerRecapJob(env, message.windowDays, maintainerRecapOverride);
      return;
    }
    case "agent-regate-sweep":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutAgentRegateSweepJobs(env, message.requestedBy);
        return;
      }
      await sweepRepoRegate(env, message.repoFullName, message.requestedBy);
      return;
    case "backlog-convergence-sweep":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutBacklogConvergenceSweepJobs(env, message.requestedBy);
        return;
      }
      await sweepRepoBacklogConvergence(env, message.repoFullName, message.requestedBy);
      return;
    case "repo-doc-refresh-sweep":
      if (!message.repoFullName && message.requestedBy !== "test") {
        await fanOutRepoDocRefreshSweepJobs(env, message.requestedBy);
        return;
      }
      if (message.repoFullName) await performRepoDocRefresh(env, message.repoFullName);
      return;
    case "agent-regate-pr":
      // One bounded re-gate unit fanned out by the sweep (#audit-sweep-fanout): re-review + stamp a single PR.
      await regatePullRequest(
        env,
        message.repairHeadSha,
        message.repoFullName,
        message.prNumber,
        message.installationId,
        message.deliveryId,
        message.force,
        message.prCreatedAt,
      );
      return;
    case "run-agent":
      await executeAgentRun(env, message.runId);
      return;
    case "notify-evaluate": {
      // Legacy payload compat: a row enqueued before the batched-events deploy (#selfhost-maintenance-self-pin)
      // still carries the OLD singular `event` field on disk, not `events` -- a rolling deploy can process such
      // a row after the new code ships, so normalize both shapes rather than assuming every persisted payload
      // already matches the current type (which only the type checker, not the durable queue, enforces).
      const legacyMessage = message as unknown as { events?: DetectedNotificationEvent[]; event?: DetectedNotificationEvent };
      const events = Array.isArray(legacyMessage.events) ? legacyMessage.events : legacyMessage.event ? [legacyMessage.event] : [];
      const deliveries = (
        await mapWithConcurrency(events, NOTIFY_EVALUATE_EVENT_CONCURRENCY, (event) => evaluateNotificationEvent(env, event))
      ).flat();
      await Promise.all(
        deliveries.map((delivery) =>
          env.JOBS.send({
            type: "notify-deliver",
            requestedBy: "notify-evaluate",
            deliveryId: delivery.id,
          }),
        ),
      );
      return;
    }
    case "notify-deliver":
      await deliverNotification(env, message.deliveryId);
      return;
    case "ops-alerts":
      // Convergence (ops / observability, flag GITTENSORY_REVIEW_OPS). Defense-in-depth: the cron only ENQUEUES this
      // when the flag is ON, but a stale in-flight job that lands after a flag-flip must still no-op, so
      // flag-OFF does zero work here too. Read-only telemetry — never throws into the queue.
      if (isOpsEnabled(env)) await runOpsAlerts(env);
      return;
    case "sweep-liveness-watchdog":
      // Self-heal (flag GITTENSORY_SWEEP_WATCHDOG). Defense-in-depth: the cron only ENQUEUES this when the flag
      // is ON, but a stale in-flight job that lands after a flag-flip must still no-op, so flag-OFF does zero
      // work here too. Fails safe internally — never throws into the queue.
      if (isSweepWatchdogEnabled(env)) await runSweepLivenessWatchdog(env);
      return;
    case "reconcile-open-prs":
      // Self-heal (flag GITTENSORY_PR_RECONCILIATION). Defense-in-depth: the cron only ENQUEUES this when the
      // flag is ON, but a stale in-flight job that lands after a flag-flip must still no-op, so flag-OFF does
      // zero work here too. Fails safe internally — never throws into the queue.
      if (isPrReconciliationEnabled(env)) await runOpenPrReconciliation(env);
      return;
    case "selftune":
      // Convergence (self-improve / auto-tune, flag GITTENSORY_REVIEW_SELFTUNE). Defense-in-depth: the cron only
      // ENQUEUES this when the flag is ON, but a stale in-flight job that lands after a flag-flip must still
      // no-op, so flag-OFF does zero work here too. TIGHTENING-ONLY + shadow-soak + audited; never throws into
      // the queue (runSelfTune fails safe).
      if (isSelfTuneEnabled(env)) {
        await runSelfTune(env);
        // GAP-4 accuracy circuit-breaker: read the gate-eval confusion matrix over the recorded pr_outcome
        // ground truth and ENGAGE holdonly (would-merge → hold) for any repo whose merge precision dropped
        // below the floor, plus AUTO-CLEAR a recovered breaker. Fail-safe: with no pr_outcome history the eval
        // reads neutral → nothing engages → byte-identical. (applyAutoTune / maybeAutoClearHoldOnly, previously
        // unwired — zero call-sites.)
        await runSelfTuneBreaker(env);
      }
      return;
    case "rag-index-repo":
      // Convergence (RAG / codebase index, flag GITTENSORY_REVIEW_RAG). Defense-in-depth: the cron + webhook only
      // ENQUEUE this when the flag is ON, but a stale in-flight job that lands after a flag-flip must still no-op,
      // so flag-OFF does zero work here too. indexRepo / reindexChangedPaths are fully fail-safe (never throw).
      if (isRagEnabled(env))
        await runRagIndexJob(
          env,
          message.requestedBy,
          message.repoFullName,
          message.paths,
        );
      return;
    case "recapture-preview":
      // Delayed visual self-poll: re-review the PR to re-capture the AFTER preview shot once its deploy is live.
      await reReviewStoredPullRequest(
        env,
        message.deliveryId,
        message.installationId,
        message.repoFullName,
        message.prNumber,
        message.attempt,
      );
      break;
    case "github-webhook":
      await processGitHubWebhook(
        env,
        message.deliveryId,
        message.eventName,
        message.payload,
      );
      return;
    case "submit-draft":
      // Public OAuth draft-submission (GITTENSORY_REVIEW_DRAFT). No-ops internally when the flag is off.
      await processSubmitDraft(env, message.draftId);
      return;
    case "retry-orb-relay":
      // Orb relay retry (#relay-retry): re-attempt events that failed to reach a brokered self-host container
      // (container was temporarily down). Enqueued by the cron ONLY when ORB_BROKER_ENABLED is set; a stale
      // in-flight job that arrives after the flag clears is still safe — retryFailedRelays fails open (no-op on
      // an empty table). Never throws.
      await retryFailedRelays(env);
      return;
  }
}

async function buildContributorDecisionPacks(
  env: Env,
  login?: string,
): Promise<void> {
  const logins = login ? [login] : await discoverContributorLogins(env);
  // Load the login-independent full-table datasets once, then reuse across every login instead of re-scanning per contributor.
  const shared = await loadDecisionPackSharedInputs(env);
  for (const contributorLogin of logins) {
    try {
      await buildAndPersistContributorDecisionPack(
        env,
        contributorLogin,
        shared,
      );
    } catch (error) {
      // Isolate per-login failures so one bad login can't fail the whole batch (which would re-run
      // from the first login on retry and poison-pill the queue) (#787).
      /* v8 ignore next -- defensive per-login isolation; the log-and-continue path is not exercised in tests */
      console.error(
        JSON.stringify({
          level: "warn",
          event: "decision_pack_login_failed",
          login: contributorLogin,
          error: errorMessage(error),
        }),
      );
    }
  }
}

async function fanOutRepoSignalSnapshotJobs(
  env: Env,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  const repositories = (await listRepositories(env)).filter(
    (repo) => repo.isRegistered,
  );
  await Promise.all(
    repositories.map((repo, index) => {
      const message: JobMessage = {
        type: "generate-signal-snapshots",
        requestedBy,
        repoFullName: repo.fullName,
      };
      const delaySeconds = Math.min(index * 10, 600);
      return delaySeconds > 0
        ? env.JOBS.send(message, { delaySeconds })
        : env.JOBS.send(message);
    }),
  );
  await recordAuditEvent(env, {
    eventType: "signals.snapshot_fanout",
    outcome: "queued",
    metadata: { repoCount: repositories.length, requestedBy },
  });
}

// Bounded concurrency for the per-repo settings+drain-state resolution below (#3899) — matches
// REPO_FOCUS_MANIFEST_MAX_CONCURRENT_LOADS, the same "many small per-repo D1/KV reads" shape.
export const SWEEP_FANOUT_RESOLUTION_CONCURRENCY = 4;

type SweepFanoutResolutionOutcome =
  | { kind: "ineligible" }
  | { kind: "draining" }
  | { kind: "configured"; repo: { fullName: string; installationId?: number } }
  | { kind: "errored" };

// #777 scheduled re-gate sweep. The cron (index.ts) enqueues one fan-out job hourly; this enqueues a per-repo
// sweep job for every repo that opted the agent in (an acting autonomy level). Mirrors the signal-snapshot
// fan-out so each repo's sweep runs as its own bounded, retryable queue message.
async function fanOutAgentRegateSweepJobs(
  env: Env,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  const now = nowIso();
  // Atomic fan-out dedup (#audit-fanout-dedup): collapse a BURST of fan-out jobs to a SINGLE effective fan-out per
  // window, so a deploy-restart cron catch-up (or fan-out jobs delayed behind a per-PR backlog then drained
  // together) cannot each enqueue a redundant per-repo sweep before the per-repo dispatch-stamp guard engages.
  if (!(await claimRegateFanoutSlot(env, now, SWEEP_FANOUT_DEDUP_MS))) {
    await recordAuditEvent(env, {
      eventType: "agent.sweep.fanout",
      outcome: "denied",
      detail:
        "re-gate fan-out deduped: another fan-out already claimed this window",
      metadata: { requestedBy, deduped: true },
    });
    return;
  }
  // Sweep every REVIEW-ACTIVE repo (#sweep-all-modes): the convergence allowlist (GITTENSORY_REVIEW_REPOS) UNION the
  // webhook-registered repos, deduped case-insensitively. A repo is swept when it is review-active (allowlisted) OR
  // has acting autonomy — so ADVISORY repos (autonomy=observe) are re-gated and get fresh reviews too, not only repos
  // that can merge/close. The action layer (maybeRunAgentMaintenance) stays autonomy-gated, so an observe repo is
  // re-reviewed but never auto-actioned. This is what makes advisory reviews fire on existing open PRs without
  // depending on a fresh webhook per PR.
  const repositoriesByKey = new Map((await listRepositories(env)).map((repo) => [repo.fullName.toLowerCase(), repo]));
  const byKey = new Map<string, { fullName: string; installationId?: number }>();
  for (const repo of repositoriesByKey.values())
    byKey.set(repo.fullName.toLowerCase(), { fullName: repo.fullName, ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}) });
  for (const fullName of listConvergenceRepos(env)) {
    const repo = repositoriesByKey.get(fullName.toLowerCase());
    byKey.set(fullName.toLowerCase(), {
      fullName,
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
    });
  }
  // #3899: resolve every repo's settings + drain-state CONCURRENTLY (bounded), not one at a time. Each repo
  // costs resolveRepositorySettings's own 3 parallel round-trips plus a 4th getLatestRegatedAt read; awaiting
  // that serially per repo made this whole prefix scale linearly with repo count, before the per-repo dispatch
  // below (already parallel) even started. Reuses the same bounded worker-pool helper loadRepoFocusManifests
  // already relies on for the same "many small per-repo D1/KV reads" shape.
  const outcomes = await mapWithConcurrencyLimit(
    [...byKey.values()],
    SWEEP_FANOUT_RESOLUTION_CONCURRENCY,
    async (repo): Promise<SweepFanoutResolutionOutcome> => {
      const repoFullName = repo.fullName;
      // #audit-sweep-fanout-isolation: one repo's settings/draining-check failure (a transient D1 read error, say)
      // must not throw and abort resolution for every OTHER repo's independent worker — return an "errored"
      // outcome for just this repo (it gets picked up again next tick) instead of rejecting.
      try {
        const settings = await resolveRepositorySettings(env, repoFullName);
        if (
          !(
            isConvergenceRepoAllowed(env, repoFullName) ||
            isAgentConfigured(settings.autonomy)
          )
        )
          return { kind: "ineligible" };
        // In-flight guard (#audit-sweep-fanout): skip a repo whose prior sweep is still draining — its per-PR jobs are
        // mid-flight and stamping last_regated_at as they run, so the freshest stamp being within the sweep window
        // means a sweep is active. Re-arming now would enqueue duplicate per-PR jobs for the not-yet-drained
        // candidates, so this is what finally stops the 2-min cron piling a second full sweep on an unfinished one.
        if (isRegateSweepDraining(await getLatestRegatedAt(env, repoFullName), now)) return { kind: "draining" };
        return { kind: "configured", repo };
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "sweep_fanout_repo_check_failed",
            repository: repoFullName,
            error: errorMessage(error),
          }),
        );
        return { kind: "errored" };
      }
    },
  );
  const configured: Array<{ fullName: string; installationId?: number }> = [];
  let skippedDraining = 0;
  let skippedErrored = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "configured") configured.push(outcome.repo);
    else if (outcome.kind === "draining") skippedDraining += 1;
    else if (outcome.kind === "errored") skippedErrored += 1;
  }
  await Promise.all(
    configured.map((repo, index) => {
      const message: JobMessage = {
        type: "agent-regate-sweep",
        requestedBy,
        repoFullName: repo.fullName,
        ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}),
      };
      const delaySeconds = Math.min(index * 10, 600);
      // #audit-sweep-fanout-isolation: one repo's dispatch failure (a transient queue-send error) must not reject
      // this Promise.all and, with it, abort every OTHER repo's already-in-flight send AND the audit event below
      // that records this fan-out's outcome. Swallow + log per-repo instead; a repo that fails to dispatch here
      // simply gets picked up again next tick (it never got its convergence marker stamped, so it stays eligible).
      const send = delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
      return send.catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "sweep_fanout_dispatch_failed",
            repository: repo.fullName,
            error: errorMessage(error),
          }),
        );
      });
    }),
  );
  await recordAuditEvent(env, {
    eventType: "agent.sweep.fanout",
    outcome: "queued",
    metadata: { repoCount: configured.length, skippedDraining, skippedErrored, requestedBy },
  });
}

async function currentRegateBacklog(env: Env): Promise<number> {
  const snapshot = await queueSnapshotFromBinding(env.JOBS).catch(() => null);
  return queueSnapshotBacklog(snapshot, PER_PR_REGATE_BACKPRESSURE_TYPES);
}

function sweepOpenPullRequestSyncCredentialAvailable(
  env: Env,
  repo: NonNullable<Awaited<ReturnType<typeof getRepository>>>,
): boolean {
  if (env.GITHUB_PUBLIC_TOKEN) return true;
  if (env.ORB_ENROLLMENT_SECRET) return true;
  return Boolean(
    repo.installationId &&
      env.GITHUB_APP_PRIVATE_KEY?.includes("BEGIN"),
  );
}

function openPullRequestSyncStale(
  segment: Awaited<ReturnType<typeof getRepoSyncSegment>>,
  nowMs: number,
): boolean {
  if (!segment) return true;
  if (
    segment.status === "running" ||
    segment.status === "refreshing" ||
    segment.status === "waiting_rate_limit"
  )
    return false;
  if (segment.status !== "complete" && segment.status !== "not_modified")
    return true;
  const completedMs = Date.parse(segment.completedAt ?? "");
  return (
    !Number.isFinite(completedMs) ||
    nowMs - completedMs > SWEEP_OPEN_PULL_REQUEST_SYNC_MAX_AGE_MS
  );
}

async function refreshOpenPullRequestsForScheduledSweep(
  env: Env,
  repo: Awaited<ReturnType<typeof getRepository>>,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  if (requestedBy !== "schedule") return;
  // No installation -> no per-PR regate fan-out will ever happen for this repo (the candidate-selection
  // gate below only dispatches agent-regate-pr jobs for installed repos), so refreshing its open-PR list
  // here only spends the shared GITHUB_PUBLIC_TOKEN budget on data nothing in THIS sweep will use. A
  // registry-only repo (registry/sync.ts, isRegistered) still gets its own data kept fresh by the
  // dedicated backfill-registered-repos/refresh-registry jobs, so skipping here is pure waste removal,
  // not a functionality gap (#audit-rate-headroom, #sweep-uninstalled-budget-waste).
  if (!repo?.installationId) return;
  if (!sweepOpenPullRequestSyncCredentialAvailable(env, repo)) return;
  const segment = await getRepoSyncSegment(
    env,
    repo.fullName,
    "open_pull_requests",
  ).catch(() => null);
  if (!openPullRequestSyncStale(segment, Date.now())) return;
  await backfillRepositorySegment(env, {
    repoFullName: repo.fullName,
    segment: "open_pull_requests",
    requestedBy,
    mode: "light",
    force: true,
  }).catch((error) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "sweep_open_pr_sync_failed",
        repoFullName: repo.fullName,
        error: errorMessage(error),
      }),
    );
  });
}

// #orb-retry-storm: outage-repair priority (below) deliberately bypasses the normal staleness throttle
// (priorityBypassesFreshness) so a PR missing its current-head gate check gets re-repaired on every ~2-minute
// sweep tick instead of waiting out the ordinary cadence. That is correct for a transient blip, but
// surfaceRepairPriorityPullNumbers has no memory of prior attempts -- if the repair keeps failing for the SAME
// head SHA (e.g. every AI-provider attempt times out), it would otherwise re-select that PR forever, burning a
// fresh review attempt every cycle for zero output. These two constants cap that: once a SHA has already had
// REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA dispatches recorded, it drops back to ordinary staleness-gated candidacy
// (still eventually re-checked, just not on every tick) and a single REGATE_REPAIR_EXHAUSTED_EVENT_TYPE audit
// event is recorded so the stuck PR is visible instead of silently retried forever. A new commit changes the
// head SHA, which resets the count naturally (the target key is scoped to repo+PR+SHA).
const REGATE_REPAIR_ATTEMPT_EVENT_TYPE = "agent.sweep.regate.repair_attempt";
const REGATE_REPAIR_EXHAUSTED_EVENT_TYPE = "agent.sweep.regate.repair_exhausted";
const REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA = 5;
const REGATE_REPAIR_ATTEMPT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function regateRepairTargetKey(repoFullName: string, prNumber: number, headSha: string): string {
  return `${repoFullName}#${prNumber}#${headSha}`;
}

async function surfaceRepairPriorityPullNumbers(
  env: Env,
  repoFullName: string,
  pulls: readonly PullRequestRecord[],
  gateCheckEnabled: boolean,
): Promise<number[]> {
  const priorityPullNumbers = new Set<number>();
  for (const pr of pulls) {
    if (pr.headSha && pr.lastPublishedSurfaceSha !== pr.headSha)
      priorityPullNumbers.add(pr.number);
  }
  if (gateCheckEnabled) {
    await Promise.all(
      pulls.map(async (pr) => {
        if (!pr.headSha) return;
        const checks = await listCheckSummaries(env, repoFullName, pr.number).catch(
          () => [],
        );
        const currentGateCheck = checks.find(
          (check) =>
            check.name === GITTENSORY_GATE_CHECK_NAME &&
            check.headSha === pr.headSha &&
            check.status === "completed",
        );
        if (!currentGateCheck) priorityPullNumbers.add(pr.number);
      }),
    );
  }
  const sinceIso = new Date(Date.now() - REGATE_REPAIR_ATTEMPT_LOOKBACK_MS).toISOString();
  await Promise.all(
    [...priorityPullNumbers].map(async (prNumber) => {
      const pr = pulls.find((candidate) => candidate.number === prNumber);
      /* v8 ignore next -- priorityPullNumbers is only ever populated (both loops above) from a `pr` in `pulls` that already had a truthy headSha, so this lookup always succeeds with one; the guard only satisfies Array#find's `| undefined` return type. */
      if (!pr?.headSha) return;
      const targetKey = regateRepairTargetKey(repoFullName, pr.number, pr.headSha);
      const attempts = await countRecentAuditEventsForActorAndTarget(
        env,
        "gittensory",
        REGATE_REPAIR_ATTEMPT_EVENT_TYPE,
        targetKey,
        sinceIso,
      );
      if (attempts < REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA) return;
      priorityPullNumbers.delete(prNumber);
      const alreadyFlagged = await countRecentAuditEventsForActorAndTarget(
        env,
        "gittensory",
        REGATE_REPAIR_EXHAUSTED_EVENT_TYPE,
        targetKey,
        sinceIso,
      );
      if (alreadyFlagged > 0) return;
      await recordAuditEvent(env, {
        eventType: REGATE_REPAIR_EXHAUSTED_EVENT_TYPE,
        actor: "gittensory",
        targetKey,
        outcome: "denied",
        detail: `re-gate repair exhausted after ${attempts} attempt(s) for the same head SHA; falling back to ordinary staleness cadence`,
        metadata: { repoFullName, prNumber: pr.number, headSha: pr.headSha, attempts },
      });
      // level:"error" is deliberate, not a code failure: this line only fires once the cap above already
      // stopped the wasteful repair loop, so its OWN existence is the operator-visible signal (via the
      // structured log → Sentry forwarder, forwardStructuredLogToSentry) that a PR kept failing repair for the
      // same head SHA — the same "surface an anomaly at error level" convention selfhost_ai_provider_failed /
      // selfhost_ai_providers_exhausted already use in src/selfhost/ai.ts.
      console.error(
        JSON.stringify({
          level: "error",
          event: "regate_repair_exhausted",
          repo: repoFullName,
          pullNumber: pr.number,
          headSha: pr.headSha,
          attempts,
        }),
      );
    }),
  );
  return [...priorityPullNumbers];
}

// Convergence (RAG / codebase index, flag GITTENSORY_REVIEW_RAG). The dispatch for the `rag-index-repo` job.
// Caller already gated on isRagEnabled(env).
//   - No repoFullName → cron fan-out: enqueue one FULL re-index job per registered + cutover-allowlisted repo.
//   - repoFullName + paths → INCREMENTAL re-index of those changed paths (the push / merged-PR path).
//   - repoFullName + no paths → FULL re-index of that one repo's code.
// Fully fail-safe — indexRepo / reindexChangedPaths never throw; this only delegates.
async function runRagIndexJob(
  env: Env,
  requestedBy: "schedule" | "api" | "webhook" | "test",
  repoFullName: string | undefined,
  paths: string[] | undefined,
): Promise<void> {
  if (!repoFullName && requestedBy !== "test") {
    await fanOutRagIndexJobs(env, requestedBy);
    return;
  }
  if (!repoFullName) return;
  // Defensive: a repo can drop out of activation between fan-out and processing. Only index repos where RAG is
  // active (per-repo `features.rag` override, allowlist fallback) — coherent with retrieval at review time.
  if (!(await convergedFeatureActive(env, repoFullName, "rag"))) return;
  const repo = await getRepository(env, repoFullName);
  /* v8 ignore next -- defensive: a fanned-out repo is always present; the null is belt-and-suspenders. */
  if (!repo) return;
  const [project] = splitRepoForRag(repoFullName);
  if (paths && paths.length > 0) {
    await reindexChangedPaths(env, project, repo, paths);
    return;
  }
  await indexRepo(env, project, repo);
}

// Enqueue one per-repo FULL re-index job for every registered + cutover-allowlisted repo (mirrors the
// signal-snapshot / agent-regate fan-out: a delayed per-repo queue message so each repo's index runs as its own
// bounded, retryable job rather than one giant tick). Only allowlisted repos are indexed — retrieval is gated the
// same way, so indexing a non-converged repo would only burn the free-tier vector budget for no benefit.
async function fanOutRagIndexJobs(
  env: Env,
  requestedBy: "schedule" | "api" | "webhook" | "test",
): Promise<void> {
  // Candidate repos = the webhook-REGISTERED repos UNION the maintainer's CONFIGURED repos (GITTENSORY_REVIEW_REPOS).
  // The union is the fix for the brokered self-host: a maintainer's repos are is_registered=0 (never went through the
  // registration webhook), so a registered-only fan-out never indexed them — leaving reviews without codebase context.
  // Deduped case-insensitively (a repo can be both registered AND configured). Each is then filtered by whether RAG is
  // active for it (`features.rag` override → GITTENSORY_REVIEW_REPOS allowlist default), so nothing extra is indexed.
  const repositoriesByKey = new Map((await listRepositories(env)).map((repo) => [repo.fullName.toLowerCase(), repo]));
  const byKey = new Map<string, { fullName: string; installationId?: number }>();
  for (const repo of [...repositoriesByKey.values()].filter(
    (r) => r.isRegistered,
  ))
    byKey.set(repo.fullName.toLowerCase(), { fullName: repo.fullName, ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}) });
  for (const fullName of listConvergenceRepos(env)) {
    const repo = repositoriesByKey.get(fullName.toLowerCase());
    byKey.set(fullName.toLowerCase(), {
      fullName,
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
    });
  }
  const candidates = [...byKey.values()];
  const ragActiveByRepo = await Promise.all(
    candidates.map((repo) => convergedFeatureActive(env, repo.fullName, "rag")),
  );
  const repositories = candidates.filter((_, index) => ragActiveByRepo[index]);
  await Promise.all(
    repositories.map((repo, index) => {
      const message: JobMessage = {
        type: "rag-index-repo",
        requestedBy,
        repoFullName: repo.fullName,
        ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}),
      };
      const delaySeconds = Math.min(index * 30, 900);
      return delaySeconds > 0
        ? env.JOBS.send(message, { delaySeconds })
        : env.JOBS.send(message);
    }),
  );
  await recordAuditEvent(env, {
    eventType: "rag.index.fanout",
    outcome: "queued",
    metadata: { repoCount: repositories.length, requestedBy },
  });
}

// Cap on changed paths fed to one incremental re-index job (a huge merge re-indexes its first N changed files;
// the slow-cadence full re-index catches the long tail). Bounds the per-job GitHub fetch + embed cost.
const RAG_REINDEX_MAX_PATHS = 100;

/**
 * Convergence (RAG / codebase index, flag GITTENSORY_REVIEW_RAG). On a MERGED PR into an allowlisted repo, enqueue
 * an incremental re-index of the PR's changed files so the index reflects the new default-branch state. No-op when
 * the flag is off, the repo isn't allowlisted, the action isn't a merge-close, or there are no changed paths.
 *
 * INCREMENTAL TRIGGER NOTE: gittensory does not (yet) subscribe to raw `push` events — the merged-PR close is the
 * available signal that "code landed on the default branch". If a `push` handler is added later, that is the
 * stronger trigger (it also catches direct-to-default-branch commits); enqueue the same `rag-index-repo` job with
 * the pushed paths there. The slow-cadence cron full re-index (index.ts) is the backstop that catches anything
 * the incremental path misses.
 */
async function maybeEnqueueRagReindexForMergedPr(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  action: string | undefined,
  mergedAt: string | null | undefined,
  installationId: number,
): Promise<void> {
  if (!(await convergedFeatureActive(env, repoFullName, "rag"))) return;
  // A PR that merged: closed action + a merged_at timestamp. (A closed-unmerged PR changed nothing on the base.)
  if (!PR_GATE_CLOSED_ACTIONS.has(action ?? "") || !mergedAt) return;
  const files = await listPullRequestFiles(env, repoFullName, pullNumber);
  const paths = files
    .map((file) => file.path)
    .filter((path) => path.length > 0)
    .slice(0, RAG_REINDEX_MAX_PATHS);
  if (paths.length === 0) return;
  await env.JOBS.send({
    type: "rag-index-repo",
    requestedBy: "webhook",
    repoFullName,
    paths,
    // #rate-limit-admission-attribution: without this, the queue's admission check has no installationId to key
    // off (githubRateLimitAdmissionKeyForJob), so it falls back to the shared public-token bucket instead of this
    // repo's own (usually healthy) installation bucket -- starving an installed repo's re-index behind unrelated
    // public-token traffic even though its own budget has headroom.
    installationId,
  });
}

/**
 * Event-driven re-gate trigger on sibling PR merge (#4005): companion to the merge-train gate. When a PR
 * MERGES, every OTHER open PR's gate verdict can be invalidated by it (a newly-conflicting base, a duplicate
 * cluster now missing its winner, a linked-issue cap that just freed up) with nothing proactively re-checking
 * it -- the scheduled sweep is bounded to SWEEP_MAX_PRS per repo per ~2-minute tick and can take several
 * cycles to reach a given sibling. Enqueue a bounded, staggered `agent-regate-pr` job per sibling right away
 * instead of waiting for the next sweep pass to notice the drift.
 *
 * Fires ONLY on a genuine merge -- `action === "closed"` AND a `merged_at` timestamp (an ordinary close changed
 * nothing on the base branch, so siblings have nothing new to react to; mirrors maybeEnqueueRagReindexForMergedPr's
 * own merge check just above). Scoped to the SAME repos the re-gate sweep already covers (self-host convergence-
 * allowlisted OR hosted agent-configured) -- this closes the "stale sibling" latency gap for repos already
 * getting proactive re-gates, not a scope expansion to repos that never were. `otherOpenPullRequests` is the
 * caller's already-fetched, already-bounded (100-row, ascending-by-number) sibling list — reused as-is rather than
 * re-querying, so the lowest-numbered open siblings are re-gated first, same tie-break the duplicate-winner
 * election uses elsewhere. Best-effort: enqueue failures are logged by the caller, never surfaced to the gate.
 */
async function maybeEnqueueSiblingRegateForMergedPr(
  env: Env,
  deliveryId: string,
  repoFullName: string,
  action: string | undefined,
  mergedAt: string | null | undefined,
  installationId: number,
  settings: RepositorySettings,
  otherOpenPullRequests: readonly PullRequestRecord[],
): Promise<void> {
  // action is only ever undefined before shouldProcessPullRequestPublicSurface's own action-set check has
  // already passed at the call site, so a direct comparison (no nullish fallback needed) keeps this line's
  // branches exhaustively reachable -- unlike maybeEnqueueRagReindexForMergedPr's `?? ""`, which predates this.
  if (action !== "closed" || !mergedAt) return;
  if (!(isConvergenceRepoAllowed(env, repoFullName) || isAgentConfigured(settings.autonomy))) return;
  const siblings = otherOpenPullRequests.slice(0, MERGE_WAKE_MAX_PRS);
  for (const [index, sibling] of siblings.entries()) {
    const job: JobMessage = {
      type: "agent-regate-pr",
      deliveryId,
      repoFullName,
      prNumber: sibling.number,
      installationId,
      ...(sibling.createdAt ? { prCreatedAt: sibling.createdAt } : {}),
    };
    const delaySeconds = Math.min(index * 10, 600);
    await (delaySeconds > 0
      ? env.JOBS.send(job, { delaySeconds })
      : env.JOBS.send(job));
  }
}

// Recompute the DETERMINISTIC gate verdict for a repo's stalest open PRs and record it as an audit event —
// ADVISORY ONLY: nothing is published to GitHub (no check, comment, or label) and no PR is mutated. This is
// the Phase-0 scheduling rail; the action layer (#778) is what will later turn a flagged verdict into a real
// action. Respects the #776 safety gate: a global or per-repo pause records a skip and recomputes nothing.
async function sweepRepoRegate(
  env: Env,
  repoFullName: string | undefined,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  if (!repoFullName) return;
  const settings = await resolveRepositorySettings(env, repoFullName);
  // Defensive re-check between fan-out and processing (#sweep-all-modes): the repo must still be review-active
  // (allowlisted) OR have acting autonomy. Advisory/observe repos pass here and are re-reviewed; the action layer
  // stays autonomy-gated, so they are never auto-actioned.
  if (
    !(
      isConvergenceRepoAllowed(env, repoFullName) ||
      isAgentConfigured(settings.autonomy)
    )
  )
    return;
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)), // env brake OR DB kill-switch (#audit-§5.2)
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  if (mode === "paused") {
    await recordAuditEvent(env, {
      eventType: "agent.sweep.regate",
      actor: "gittensory",
      targetKey: repoFullName,
      outcome: "denied",
      detail: "agent actions paused — re-gate sweep skipped",
      metadata: { repoFullName, mode },
    });
    return;
  }
  const repo = await getRepository(env, repoFullName);
  await refreshOpenPullRequestsForScheduledSweep(
    env,
    repo,
    requestedBy,
  );
  const openPullRequests = await listOpenPullRequests(env, repoFullName);
  const priorityPullNumbers = await surfaceRepairPriorityPullNumbers(
    env,
    repoFullName,
    openPullRequests,
    shouldPublishReviewCheck(settings.reviewCheckMode),
  );
  const regateBacklog = requestedBy === "schedule" ? await currentRegateBacklog(env) : 0;
  // Normal stale maintenance yields behind existing per-PR repairs. Missing current Gate checks are outage repair:
  // do not let one repo's draining sweep strand required statuses in another repo.
  if (regateBacklog > 0 && priorityPullNumbers.length === 0) {
    await recordAuditEvent(env, {
      eventType: "agent.sweep.regate",
      actor: "gittensory",
      targetKey: repoFullName,
      outcome: "queued",
      detail:
        "re-gate sweep deferred: prior scheduled re-gate work is still pending or processing",
      metadata: { repoFullName, mode, deferred: true, regateBacklog },
    });
    return;
  }
  // With an active backlog (regateBacklog > 0), a priority repair PR earns an EXCEPTION to the "yield to
  // backlog" rule above, not a license for the whole sweep to also drag along a full SWEEP_MAX_PRS batch of
  // ordinary stale PRs. Repair priority only affects selectRegateCandidates eligibility, not final ordering, so
  // the backlog path must narrow the input pool to priority repairs before applying the normal stale ordering cap.
  // No backlog pressure ⇒ a normal, full-size sweep as before.
  const priorityPullNumberSet = new Set(priorityPullNumbers);
  const repairCandidateLimit =
    priorityPullNumbers.length > 0
      ? regateBacklog > 0
        ? priorityPullNumbers.length
        : Math.max(SWEEP_MAX_PRS, priorityPullNumbers.length)
      : null;
  const candidatePullRequests =
    regateBacklog > 0 && priorityPullNumbers.length > 0
      ? openPullRequests.filter((pr) => priorityPullNumberSet.has(pr.number))
      : openPullRequests;
  const candidates = selectRegateCandidates({
    pulls: candidatePullRequests,
    now: nowIso(),
    priorityPullNumbers,
    priorityBypassesFreshness: priorityPullNumbers.length > 0,
    orderMode: settings.regateSweepOrderMode,
    ...(repairCandidateLimit !== null ? { max: repairCandidateLimit } : {}),
  });
  // No stale PRs this tick — stay quiet rather than writing an empty heartbeat to the audit feed.
  if (candidates.length === 0) return;
  // Reserve installation rate-limit headroom for real webhook traffic (#audit-rate-headroom): with the shared REST
  // budget at/below the maintenance floor, defer the WHOLE sweep until the reset rather than fanning out per-PR
  // jobs that would each have to defer. Webhooks never pre-yield, so this hands the remaining budget to them.
  // Scoped to THIS repo's own installation bucket (#audit-rate-scoping) — an unrelated installation's or the
  // shared public token's budget must never defer (or wrongly clear) this repo's own sweep.
  const sweepRateResetAt = await shouldWaitForGitHubRateLimit(
    env,
    MAINTENANCE_RESERVED_HEADROOM,
    typeof repo?.installationId === "number" ? githubRateLimitAdmissionKeyForInstallation(repo.installationId) : undefined,
  );
  if (sweepRateResetAt) {
    await env.JOBS.send(
      { type: "agent-regate-sweep", requestedBy: "schedule", repoFullName },
      { delaySeconds: delayUntil(sweepRateResetAt) },
    );
    await recordAuditEvent(env, {
      eventType: "agent.sweep.regate",
      actor: "gittensory",
      targetKey: repoFullName,
      outcome: "queued",
      detail: `re-gate sweep deferred: shared GitHub REST budget below the maintenance headroom floor; re-queued after ${sweepRateResetAt}`,
      metadata: {
        repoFullName,
        mode,
        deferred: true,
        rateResetAt: sweepRateResetAt,
      },
    });
    return;
  }
  // Stamp the convergence marker for EVERY candidate NOW, at dispatch — not in the downstream per-PR job
  // (#audit-sweep-dispatch-stamp). This makes getLatestRegatedAt() reflect this sweep immediately, so the in-flight
  // guard (fanOutAgentRegateSweepJobs) skips re-arming this repo on the next cron tick BEFORE the staggered/
  // rate-deferred per-PR re-reviews finish. Stamping in the per-PR job lagged minutes behind under load, so the
  // guard never engaged and overlapping sweeps stacked up (the metagraphed dry-run runaway). It also advances
  // selectRegateCandidates so the NEXT sweep picks the next-stalest 25. A plain D1 write → dry-run stays inert.
  await markPullRequestsRegated(
    env,
    repoFullName,
    candidates.map((pr) => pr.number),
  ).catch((error) => {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "sweep_mark_regated_failed",
        repository: repoFullName,
        error: errorMessage(error),
      }),
    );
  });
  const requireLinkedIssue =
    settings.requireLinkedIssue || settings.linkedIssueGateMode !== "off";
  const verdicts: Record<string, string> = {};
  const flaggedPulls: number[] = [];
  const sweepInstallationId = repo?.installationId ?? null;
  const duplicateWinnerEnabled = env.GITTENSORY_DUPLICATE_WINNER === "true";
  // #selfhost-queue-liveness: priorityPullNumbers (surfaceRepairPriorityPullNumbers, above) are OUTAGE REPAIR --
  // a PR with no current-head Gate check or an unpublished current-head surface -- not routine staleness. A
  // repair candidate's fanned-out job must NOT carry the "regate-sweep:" deliveryId prefix, or
  // isScheduledRegateSweepJob (queue-common.ts) misclassifies it as background maintenance and it inherits the
  // exact starvation this priority mechanism exists to avoid. Ordinary stale candidates keep the sweep prefix
  // unchanged.
  for (const [index, pr] of candidates.entries()) {
    const others = openPullRequests.filter(
      (other) => other.number !== pr.number,
    );
    // Thread linked-issue authors + the open-reference check so the re-gate sweep applies the same
    // self-authored-linked-issue block AND stale-issue-link countermeasure the main webhook path applies —
    // without this a self-authored or stale-link-gaming PR re-gated by the sweep escapes both. (#self-authored-parity, #unlinked-issue-guardrail-followup)
    const { linkedIssueAuthorLogins, confirmedNoOpenLinkedIssue } = await resolveLinkedIssueAdvisoryContext(
      env,
      sweepInstallationId,
      repoFullName,
      pr.linkedIssues,
      settings,
    );
    const advisory = buildPullRequestAdvisory(repo, pr, {
      otherOpenPullRequests: others,
      requireLinkedIssue,
      duplicateWinnerEnabled,
      linkedIssueAuthorLogins,
      confirmedNoOpenLinkedIssue,
    });
    const gate = evaluateGateCheck(
      advisory,
      gateCheckPolicy(settings, null, undefined, pr.slopRisk ?? null),
    );
    verdicts[String(pr.number)] = gate.conclusion;
    if (gate.conclusion === "failure" || gate.conclusion === "action_required")
      flaggedPulls.push(pr.number);
    // Fan the HEAVY re-review (rebuild advisory → re-publish the unified comment with the current head/CI →
    // re-run auto-maintain) into its own bounded, individually-retryable per-PR job, staggered like the repo
    // fan-out, so it interleaves with other work instead of monopolizing the consumer for all SWEEP_MAX_PRS
    // candidates at once (#audit-sweep-fanout). The cheap verdict summary above is computed inline and recorded
    // below, preserving the advisory audit. The convergence marker was already stamped for every candidate at
    // dispatch (above); with no installation to act with there is simply no re-review to fan out (audit-only).
    const isPriorityRepair = priorityPullNumberSet.has(pr.number);
    if (sweepInstallationId != null) {
      const job: JobMessage = {
        type: "agent-regate-pr",
        deliveryId: isPriorityRepair
          ? `regate-repair:${repoFullName}#${pr.number}`
          : `regate-sweep:${repoFullName}#${pr.number}`,
        repoFullName,
        prNumber: pr.number,
        installationId: sweepInstallationId,
        // #orb-retry-storm: pass the repair SHA so regatePullRequest can record the attempt at
        // execution time (after rate-limit admission), not here at dispatch time.  Jobs that are
        // deferred or dropped before they run no longer count against the per-SHA cap.
        ...(isPriorityRepair && pr.headSha ? { repairHeadSha: pr.headSha } : {}),
        ...(pr.createdAt ? { prCreatedAt: pr.createdAt } : {}),
      };
      const delaySeconds = Math.min(index * 10, 600);
      await (delaySeconds > 0
        ? env.JOBS.send(job, { delaySeconds })
        : env.JOBS.send(job));
    }
  }
  await recordAuditEvent(env, {
    eventType: "agent.sweep.regate",
    actor: "gittensory",
    targetKey: repoFullName,
    outcome: "completed",
    detail: `scheduled re-gate recomputed ${candidates.length} stale open PR verdict(s); ${flaggedPulls.length} flagged; fanned out per-PR re-review`,
    metadata: {
      repoFullName,
      mode,
      openCount: openPullRequests.length,
      examined: candidates.length,
      flagged: flaggedPulls.length,
      flaggedPulls,
      verdicts,
    },
  });
}

// #selfhost-backlog-convergence: the cron (index.ts) enqueues one fan-out trigger periodically; this enqueues a
// per-repo sweep job for every repo eligible for convergence (the SAME repo selection as the re-gate sweep, so
// a repo that opted the agent in — or is explicitly convergence-allowlisted — gets both). #4502: now mirrors
// fanOutAgentRegateSweepJobs's three-layer anti-duplication shape exactly — an atomic fan-out-slot claim
// (claimBacklogConvergenceFanoutSlot) collapses a BURST of this trigger, and the per-repo resolution below skips
// any repo whose prior fan-out is still draining (getLatestBacklogConvergenceRegatedAt / isRegateSweepDraining) —
// closing the gap where a crashed/restarted worker's stuck "processing" trigger row went unnoticed by the next
// 30-min tick and re-enqueued duplicate per-repo (and per-PR) jobs underneath the still-in-flight one.
async function fanOutBacklogConvergenceSweepJobs(
  env: Env,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  const now = nowIso();
  if (!(await claimBacklogConvergenceFanoutSlot(env, now, SWEEP_FANOUT_DEDUP_MS))) {
    await recordAuditEvent(env, {
      eventType: "agent.sweep.backlog_convergence.fanout",
      outcome: "denied",
      detail: "backlog-convergence fan-out deduped: another fan-out already claimed this window",
      metadata: { requestedBy, deduped: true },
    });
    return;
  }
  const repositoriesByKey = new Map((await listRepositories(env)).map((repo) => [repo.fullName.toLowerCase(), repo]));
  const byKey = new Map<string, { fullName: string; installationId?: number }>();
  for (const repo of repositoriesByKey.values())
    byKey.set(repo.fullName.toLowerCase(), { fullName: repo.fullName, ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}) });
  for (const fullName of listConvergenceRepos(env)) {
    const repo = repositoriesByKey.get(fullName.toLowerCase());
    byKey.set(fullName.toLowerCase(), {
      fullName,
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
    });
  }
  // #4502 (ports #3899): resolve every repo's settings + drain-state CONCURRENTLY (bounded), not one at a time —
  // mirrors fanOutAgentRegateSweepJobs's own port of this fix, the same "many small per-repo D1/KV reads" shape.
  const outcomes = await mapWithConcurrencyLimit(
    [...byKey.values()],
    SWEEP_FANOUT_RESOLUTION_CONCURRENCY,
    async (repo): Promise<SweepFanoutResolutionOutcome> => {
      const repoFullName = repo.fullName;
      try {
        const settings = await resolveRepositorySettings(env, repoFullName);
        if (!(isConvergenceRepoAllowed(env, repoFullName) || isAgentConfigured(settings.autonomy))) return { kind: "ineligible" };
        if (isRegateSweepDraining(await getLatestBacklogConvergenceRegatedAt(env, repoFullName), now, BACKLOG_CONVERGENCE_SWEEP_FRESHNESS_MS))
          return { kind: "draining" };
        return { kind: "configured", repo };
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "backlog_convergence_fanout_repo_check_failed",
            repository: repoFullName,
            error: errorMessage(error),
          }),
        );
        return { kind: "errored" };
      }
    },
  );
  const configured: Array<{ fullName: string; installationId?: number }> = [];
  let skippedDraining = 0;
  let skippedErrored = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "configured") configured.push(outcome.repo);
    else if (outcome.kind === "draining") skippedDraining += 1;
    else if (outcome.kind === "errored") skippedErrored += 1;
  }
  await Promise.all(
    configured.map((repo, index) => {
      const message: JobMessage = {
        type: "backlog-convergence-sweep",
        requestedBy,
        repoFullName: repo.fullName,
        ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}),
      };
      const delaySeconds = Math.min(index * 10, 600);
      const send = delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
      // #audit-sweep-fanout-isolation (mirrors fanOutAgentRegateSweepJobs): one repo's dispatch failure must not
      // reject this Promise.all and abort every OTHER repo's already-in-flight send.
      return send.catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "backlog_convergence_fanout_dispatch_failed",
            repository: repo.fullName,
            error: errorMessage(error),
          }),
        );
      });
    }),
  );
  await recordAuditEvent(env, {
    eventType: "agent.sweep.backlog_convergence.fanout",
    outcome: "queued",
    metadata: { repoCount: configured.length, skippedDraining, skippedErrored, requestedBy },
  });
}

// Maintainer review recap digest (#1963): build the recap for one repo and post it to Discord, gated on
// this repo's `.gittensory.yml reviewRecap.enabled` (default OFF, mirrors repoDocGeneration.enabled below) --
// fail-safe: a repo with no `reviewRecap:` block, or a manifest load failure, never posts. Config-gated at
// THIS single call site (not inside generateAndSendReviewRecap itself) because this PR has no fan-out sweep
// yet; the eventual scheduled trigger will enumerate opted-in repos the same way fanOutRepoDocRefreshSweepJobs
// does, and can call generateAndSendReviewRecap directly since the enumeration step already filtered on
// `.enabled` -- this per-call gate is what keeps a MANUAL trigger against a non-opted-in repo a no-op too.
async function runReviewRecapJob(env: Env, repoFullName: string, windowDays: number | undefined): Promise<void> {
  const manifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  if (!manifest?.reviewRecap.enabled) return;
  await generateAndSendReviewRecap(env, repoFullName, {
    windowDays: windowDays ?? manifest.reviewRecap.cadenceDays,
  });
}

// Repo-doc refresh sweep (#3003, part of #2993): enumerate every installed repo, bulk-load their
// .gittensory.yml manifests, and enqueue one per-repo job for each repo that (a) has
// repoDocGeneration.enabled: true and (b) is due per its own refreshIntervalDays (default weekly). No atomic
// fan-out dedup (unlike agent-regate-sweep) -- this runs once a day, not every tick, so a burst of overlapping
// fan-outs is not a realistic risk. Eligibility/scope/diffing itself lives entirely inside
// openRepoDocPullRequest (via performRepoDocRefresh) -- this fan-out is purely an enumeration + rate-limiting
// optimization so a stable repo isn't re-checked more often than its own configured interval.
async function fanOutRepoDocRefreshSweepJobs(env: Env, requestedBy: "schedule" | "api" | "test"): Promise<void> {
  const now = nowIso();
  const repoFullNames = (await listRepositories(env)).map((repo) => repo.fullName);
  const manifests = await loadRepoFocusManifests(env, repoFullNames);
  const enabledRepos = repoFullNames.flatMap((repoFullName) => {
    const manifest = manifests.get(repoFullName.toLowerCase());
    return manifest?.repoDocGeneration.enabled ? [{ repoFullName, manifest }] : [];
  });
  // Bulk-loaded in ONE round trip rather than one `getLastRepoDocRefreshAttemptedAt` call per repo (#3202
  // review finding) -- this sweep runs daily across every installed repo, so a per-repo query here would scale
  // linearly in DB round trips with the installed-repo count.
  const lastAttempts = await getLastRepoDocRefreshAttemptedAtBulk(
    env,
    enabledRepos.map((entry) => entry.repoFullName),
  );
  const due = enabledRepos
    .filter((entry) =>
      isRepoDocRefreshDue(lastAttempts.get(entry.repoFullName)?.generatedAt ?? null, entry.manifest.repoDocGeneration.refreshIntervalDays, now),
    )
    .map((entry) => entry.repoFullName);
  await Promise.all(
    due.map((repoFullName, index) => {
      const message: JobMessage = { type: "repo-doc-refresh-sweep", requestedBy, repoFullName };
      const delaySeconds = Math.min(index * 10, 600);
      return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
    }),
  );
  await recordAuditEvent(env, {
    eventType: "repo_doc.refresh.fanout",
    outcome: "queued",
    metadata: { repoCount: due.length, requestedBy },
  });
}

// #selfhost-backlog-convergence: sweep one repo's open PRs for a stale/missing public review surface at the
// current head (see selfhost/backlog-convergence.ts for why this is a distinct signal from the re-gate sweep's
// own staleness check) and fan out one `agent-regate-pr` job per candidate, tagged with a `backlog-convergence:`
// deliveryId prefix so the claim-time fairness lane (queue-fairness.ts, PR2) can prioritize it as backlog-drain
// work. No installation → nothing can be re-reviewed; skip quietly (mirrors sweepRepoRegate).
async function sweepRepoBacklogConvergence(
  env: Env,
  repoFullName: string | undefined,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  if (!repoFullName) return;
  const settings = await resolveRepositorySettings(env, repoFullName);
  if (!(isConvergenceRepoAllowed(env, repoFullName) || isAgentConfigured(settings.autonomy))) return;
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  if (mode === "paused") {
    await recordAuditEvent(env, {
      eventType: "agent.sweep.backlog_convergence",
      actor: "gittensory",
      targetKey: repoFullName,
      outcome: "denied",
      detail: "agent actions paused — backlog-convergence sweep skipped",
      metadata: { repoFullName, mode },
    });
    return;
  }
  const repo = await getRepository(env, repoFullName);
  const sweepInstallationId = repo?.installationId ?? null;
  if (sweepInstallationId == null) return;
  const openPullRequests = await listOpenPullRequests(env, repoFullName);
  const candidates = selectBacklogConvergenceCandidates({ pulls: openPullRequests });
  if (candidates.length === 0) return;
  // Stamp the backlog-convergence draining marker for EVERY candidate NOW, at dispatch — not in the downstream
  // per-PR job (#4502, mirrors #audit-sweep-dispatch-stamp). This makes getLatestBacklogConvergenceRegatedAt
  // reflect this sweep immediately, so fanOutBacklogConvergenceSweepJobs's in-flight guard skips re-arming this
  // repo on the next cron tick BEFORE the staggered per-PR re-reviews finish. A plain D1 write → dry-run stays inert.
  await markPullRequestsBacklogConvergenceRegated(
    env,
    repoFullName,
    candidates.map((pr) => pr.number),
  ).catch((error) => {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "backlog_convergence_mark_regated_failed",
        repository: repoFullName,
        error: errorMessage(error),
      }),
    );
  });
  await Promise.all(
    candidates.map((pr, index) => {
      const job: JobMessage = {
        type: "agent-regate-pr",
        deliveryId: `backlog-convergence:${repoFullName}#${pr.number}`,
        repoFullName,
        prNumber: pr.number,
        installationId: sweepInstallationId,
        ...(pr.createdAt ? { prCreatedAt: pr.createdAt } : {}),
      };
      const delaySeconds = Math.min(index * 10, 600);
      return delaySeconds > 0
        ? env.JOBS.send(job, { delaySeconds })
        : env.JOBS.send(job);
    }),
  );
  await recordAuditEvent(env, {
    eventType: "agent.sweep.backlog_convergence",
    actor: "gittensory",
    targetKey: repoFullName,
    outcome: "completed",
    detail: `backlog-convergence sweep found ${candidates.length} open PR(s) with a stale/missing public surface`,
    metadata: {
      repoFullName,
      mode,
      openCount: openPullRequests.length,
      examined: candidates.length,
      candidatePulls: candidates.map((pr) => pr.number),
    },
  });
}

// #audit-sweep-fanout: one per-PR re-gate unit fanned out by sweepRepoRegate. Re-reviews a single PR as its own
// bounded, retryable queue message. Routes through the #1258 chokepoint so a repo that paused or switched to
// dry-run between fan-out and processing stays inert. Self-contained: resolves the repo settings to mirror the
// sweep's skipAiReview policy. The convergence marker is NOT stamped here — the sweep already stamped every
// candidate at dispatch (#audit-sweep-dispatch-stamp), so the in-flight guard does not wait on this job and a
// deferred/failed re-review never stalls convergence (the next sweep after the window re-claims the PR). The public
// surface marker is observability only; it cannot prove GitHub still shows a complete current review panel, so the
// per-PR job always re-evaluates the head.
async function regatePullRequest(
  env: Env,
  repairHeadSha: string | undefined,
  repoFullName: string,
  prNumber: number,
  installationId: number,
  deliveryId: string,
  force?: boolean,
  prCreatedAt?: string | null,
): Promise<void> {
  // Reserve installation rate-limit headroom (#audit-rate-headroom): all repos share ONE GitHub App installation
  // = ONE REST bucket, so when the shared budget is low, DEFER this re-review until the reset instead of
  // burning budget other work needs. #selfhost-queue-liveness: the FLOOR depends on WHY this job exists — the
  // scheduled sweep's own stale-PR fan-out (isScheduledRegateSweepJob) can wait behind the conservative
  // maintenance floor same as any other periodic sweep, but every other trigger (a real webhook event: a
  // trailing coalesced re-review, an over-cap sibling wake, a linked-issue-change re-review, a reconciliation-
  // repair enqueue) is current-HEAD contributor-PR-review work and gets the SAME low floor a fresh webhook
  // gets — it must never be treated as background maintenance and parked behind it. Mirrors the SAME
  // reclassification githubRateLimitAdmissionTargetForJob applies at the queue-admission layer.
  // Scoped to THIS installation's own bucket (#audit-rate-scoping) — an unrelated installation's or the shared
  // public token's budget must never defer (or wrongly clear) this PR's own re-gate.
  const rateResetAt = await shouldWaitForGitHubRateLimit(
    env,
    isScheduledRegateSweepJob(deliveryId) ? MAINTENANCE_RESERVED_HEADROOM : LOW_REST_RATE_LIMIT_REMAINING,
    githubRateLimitAdmissionKeyForInstallation(installationId),
  );
  if (rateResetAt) {
    await env.JOBS.send(
      {
        type: "agent-regate-pr",
        ...(repairHeadSha ? { repairHeadSha } : {}),
        deliveryId,
        repoFullName,
        prNumber,
        installationId,
        ...(prCreatedAt ? { prCreatedAt } : {}),
        ...(force ? { force: true } : {}),
      },
      { delaySeconds: delayUntil(rateResetAt) },
    );
    return;
  }
  // #orb-retry-storm: record the repair attempt NOW — after rate-limit admission — so the cap in
  // surfaceRepairPriorityPullNumbers counts actual executions, not queued dispatches that may have
  // been deferred or dropped before running (the old dispatch-time recording let rate-limit deferrals
  // exhaust the 2-attempt budget without ever trying the repair).
  if (repairHeadSha) {
    await recordAuditEvent(env, {
      eventType: REGATE_REPAIR_ATTEMPT_EVENT_TYPE,
      actor: "gittensory",
      targetKey: regateRepairTargetKey(repoFullName, prNumber, repairHeadSha),
      outcome: "completed",
      detail: `outage-repair re-review executing for ${repoFullName}#${prNumber}`,
      metadata: { repoFullName, prNumber, headSha: repairHeadSha },
    });
  }
  const settings = await resolveRepositorySettings(env, repoFullName);
  await reReviewStoredPullRequest(
    env,
    deliveryId,
    installationId,
    repoFullName,
    prNumber,
    undefined,
    // Run the AI review on the sweep for BOTH advisory and block modes (#sweep-all-modes) — only skip when AI is
    // OFF. The #1462 per-(repo,pr,headSha,mode) cache bounds the cost: an unchanged PR re-gates from cache with no
    // re-spend, so an advisory PR gets a posted review without burning a token every sweep tick. `force` (#regate-
    // churn req 8) bypasses that cache/cooldown reuse entirely for an explicit manual re-gate request.
    {
      skipAiReview: settings.aiReviewMode === "off",
      ...(force ? { force: true } : {}),
    },
  ).catch((error) => {
    /* v8 ignore next -- retryable/rate-limit propagation is exercised by queue retry tests; this catch only preserves that contract. */
    if (isGitHubRateLimitedError(error) || isRetryableJobError(error)) throw error;
    console.error(
      JSON.stringify({
        level: "warn",
        event: "sweep_rereview_failed",
        deliveryId,
        repository: repoFullName,
        pullNumber: prNumber,
        error: errorMessage(error),
      }),
    );
  });
}

export function changedPathsForGuardrail(
  files: Awaited<ReturnType<typeof listPullRequestFiles>>,
): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.path.length > 0) paths.add(file.path);
    if (file.previousFilename && file.previousFilename.length > 0)
      paths.add(file.previousFilename);
  }
  return [...paths];
}

/**
 * Live premerge migrations/** collision recheck (#2550). `check-migrations.mjs` (CI) only validates against
 * THIS PR's own branch snapshot at the time CI ran — it can never see a sibling PR that merged a
 * same-numbered migration file to `baseRef` in the meantime. This does the live check right before the
 * merge-decision moment: fetch the base branch's CURRENT migration filenames, drop any filename THIS PR's
 * own diff removes from the base (an outright deletion, or a rename's pre-rename name — otherwise renaming
 * an existing base migration self-collides with its own old name, which is still live on `baseRef` until
 * this PR merges), union what's left with THIS PR's own new migration filenames (the live tree never
 * contains this PR's own not-yet-merged files, so checking main alone could never detect a collision from
 * this PR's perspective — the union is load-bearing, not optional), then run the SAME collision-detection
 * function scripts/check-migrations.mjs uses.
 *
 * Deliberately scoped to a collision involving THIS PR's own migration number(s) only (via `prNumbers`) — a
 * pre-existing collision between two OTHER already-merged files (which would mean `main` itself is already
 * broken, a separate problem CI already surfaces loudly) must not hold an unrelated third PR whose own
 * migration number doesn't collide with anything.
 *
 * Fail-OPEN throughout: a missing baseRef or a failed live fetch returns undefined (no hold) rather than
 * risking a false hold on inconclusive data — this is a safety net, not a new way to get PRs stuck.
 */
// Deliberately UNCACHED: this is the safety check the whole feature exists to provide, so it must always
// read the live tree fresh. A cache keyed by repo+baseRef (even a short-TTL one) can serve a snapshot taken
// BEFORE a sibling PR merged its own colliding migration — defeating the exact race this function exists to
// catch (PR A merges 0099, a still-cached pre-merge tree lets a later-processed PR B also merge its own 0099
// within the cache window). The existing GitHub rate-limit admission/backoff mechanism (the same
// `admissionKey` every other live call in this function already uses) already bounds the cost; correctness
// here matters far more than shaving a redundant API call.
async function resolveLiveMigrationCollisionHold(
  args: {
    repoFullName: string;
    baseRef: string | null | undefined;
    token: string | undefined;
    admissionKey: GitHubRateLimitAdmissionKey | undefined;
    prMigrationFilenames: string[];
    prRemovedMigrationFilenames: string[];
  },
): Promise<{ reason: string; comment: string } | undefined> {
  if (!args.baseRef) return undefined;
  const liveFilenames = await listMigrationFilenamesAtRef(args.repoFullName, args.baseRef, args.token, args.admissionKey);
  if (liveFilenames === null) return undefined;
  const removedFromBase = new Set(args.prRemovedMigrationFilenames);
  const effectiveLiveFilenames = liveFilenames.filter((f) => !removedFromBase.has(f));
  const union = [...new Set([...effectiveLiveFilenames, ...args.prMigrationFilenames])];
  const prNumbers = new Set(args.prMigrationFilenames.map((f) => extractMigrationNumber(f)).filter((n): n is number => n !== null));
  const collisions = detectMigrationCollisions(union, KNOWN_MIGRATION_DUPLICATES).filter((c) => prNumbers.has(c.number));
  if (collisions.length === 0) return undefined;
  const detail = collisions.map((c) => `${c.paddedNumber}: ${c.files.join(", ")}`).join("; ");
  return {
    reason: `live migrations/** collision on ${args.baseRef} (${detail})`,
    comment: `Gittensory: a live check of \`migrations/**\` on \`${args.baseRef}\` found a migration-number collision that isn't visible from this PR's own diff — another PR merged a same-numbered migration file since this PR's CI last ran (**${detail}**). This PR is held for manual review — please rebase onto the latest \`${args.baseRef}\` and renumber your migration to the next free number before this can merge.`,
  };
}

/**
 * Chain the two INDEPENDENT precision circuit-breakers over a planned action set (the merge-side and close-side
 * downgrades), in order. PURE — the live flag reads happen at the call site (each fail-open), so this composes
 * only the transforms:
 *   • holdOnly      → downgradeMergeToHold (would-MERGE → human HOLD), else passthrough.
 *   • closeHoldOnly → downgradeCloseToHold (HEURISTIC would-CLOSE → human HOLD; deterministic close exempt), else passthrough.
 * Both off (the common path) returns the plan byte-identically. The breakers don't interfere: the merge
 * downgrade only touches `merge`/ready-label, the close downgrade only touches a heuristic `close`.
 */
export function applyPrecisionBreakers(
  planned: PlannedAgentAction[],
  holdOnly: boolean,
  closeHoldOnly: boolean,
  labelSettings: AgentDispositionLabelSettings = {},
): PlannedAgentAction[] {
  const afterMerge = holdOnly ? downgradeMergeToHold(planned, true, labelSettings) : planned;
  return closeHoldOnly ? downgradeCloseToHold(afterMerge, true, labelSettings) : afterMerge;
}

/** PURE: which precision-breaker directions actually rewrote the plan — i.e. `planned` had a merge/close that
 *  `breakerOnPlan` (the post-{@link applyPrecisionBreakers} result) no longer has. Extracted from the call site
 *  so the bounded-cardinality observability counter (#terminal-outcome-audit) is unit-tested directly, the same
 *  way applyPrecisionBreakers itself is. Returns at most one entry per direction, in a stable merge-then-close
 *  order; empty on the common (not-engaged, or nothing downgraded) path. */
export function precisionBreakerDowngradeDirections(planned: PlannedAgentAction[], breakerOnPlan: PlannedAgentAction[]): Array<"merge" | "close"> {
  // Reference identity, not "is the class still present anywhere in the array": downgradeMergeToHold /
  // downgradeCloseToHold both filter() the input (preserving object identity for every KEPT action) and only
  // ever push brand-new label actions, so a specific planned action survives iff the SAME object reference is
  // still in breakerOnPlan. A coarse `!breakerOnPlan.some(actionClass === "close")` check would miss a downgrade
  // when a plan carries TWO close actions and only one (the heuristic one) is dropped — the surviving
  // deterministic close keeps that check from ever firing even though the breaker did rewrite the plan (gate
  // review finding, round 2).
  const kept = new Set(breakerOnPlan);
  const directions: Array<"merge" | "close"> = [];
  if (planned.some((action) => action.actionClass === "merge" && !kept.has(action))) directions.push("merge");
  if (planned.some((action) => action.actionClass === "close" && !kept.has(action))) directions.push("close");
  return directions;
}

/** PURE: the bounded `{actionClass, blockerClass}` label pair for the `gittensory_agent_disposition_total`
 *  counter (#terminal-outcome-audit), derived from the FINAL post-breaker plan and the gate's own blocker/hold
 *  codes -- never from free text. `actionClass` is "merge"/"close" when the final plan still contains that
 *  action, else "hold" (guardrail, owner-exemption, migration-collision, not-yet-mergeable, breaker-downgraded,
 *  or any other bucket that produces no merge/close action). `blockerClass` is the first gate-blocker code
 *  (a `failure` conclusion); when the gate reported none, it falls back to `holdReasonCode` -- the bounded
 *  reason class for a `neutral` conclusion (guardrail_hold/oversized_pr/ai_review_inconclusive/etc., see
 *  `neutralHoldReasonCode`) -- so a real, nameable hold is never flattened to the same "none" bucket as a
 *  merge-ready PR waiting on nothing more than pending CI. */
export function agentDispositionLabels(
  breakerOnPlan: PlannedAgentAction[],
  gateBlockerCodes: string[],
  holdReasonCode: string | null,
): { actionClass: "merge" | "close" | "hold"; blockerClass: string } {
  const actionClass = breakerOnPlan.some((action) => action.actionClass === "merge")
    ? "merge"
    : breakerOnPlan.some((action) => action.actionClass === "close")
      ? "close"
      : "hold";
  return { actionClass, blockerClass: gateBlockerCodes[0] ?? holdReasonCode ?? "none" };
}

const AGENT_HOLD_AUDIT_REASON_MAX_LENGTH = 240;

function boundAgentHoldAuditReason(reason: string): string {
  return reason.length > AGENT_HOLD_AUDIT_REASON_MAX_LENGTH
    ? `${reason.slice(0, AGENT_HOLD_AUDIT_REASON_MAX_LENGTH)}...`
    : reason;
}

/** Shared disambiguation for "the PR isn't review-good/mergeable and a close should be considered, but no
 *  close ended up in the final plan" -- used by BOTH the CI-failed branch and the gate-blocker-codes branch in
 *  {@link agentHoldAuditDetail} below, so a protected author or a not-yet-"auto" close autonomy is surfaced
 *  with the SAME specific reason regardless of which signal (red CI vs. a gate blocker) triggered the hold.
 *  Before this helper existed, the ciState==="failed" branch returned a bare, unexplained
 *  "no close action was planned" message unconditionally -- it never checked protectedAuthor/closeAutonomy the
 *  way the gate-blocker-codes branch already did just a few lines below it, so the single MOST common real-world
 *  hold reason (a protected author, or close autonomy not yet set to auto) was invisible for a red-CI hold even
 *  though the identical check already worked correctly for a gate-blocker hold (#selfhost-holdplan-audit). Returns
 *  null when neither condition explains the hold -- a genuine residual case the caller falls back to its own
 *  more specific generic message for. */
function closeWithheldReason(args: { protectedAuthor: boolean; closeOwnerAuthors: boolean; closeAutonomy: string; blockerCode?: string | undefined }): string | null {
  if (args.protectedAuthor && args.closeOwnerAuthors !== true) {
    return args.blockerCode ? boundAgentHoldAuditReason(`close withheld for protected author on gate blocker ${args.blockerCode}`) : "close withheld for protected author";
  }
  if (args.closeAutonomy !== "auto" && args.closeAutonomy !== "auto_with_approval") {
    return boundAgentHoldAuditReason(`close withheld because close autonomy is ${args.closeAutonomy}`);
  }
  return null;
}

export function agentHoldAuditDetail(args: {
  planned: PlannedAgentAction[];
  breakerOnPlan: PlannedAgentAction[];
  gateConclusion: string;
  gateBlockerCodes: string[];
  ciState: string;
  ciHasPending: boolean;
  mergeableState: string | null | undefined;
  approvalsSatisfied: boolean;
  authorIsOwner: boolean;
  authorIsAdmin: boolean;
  authorIsAutomationBot: boolean;
  closeOwnerAuthors: boolean;
  mergeAutonomy: string;
  closeAutonomy: string;
}): string {
  const plannedTerminalAction = args.planned.some((action) => action.actionClass === "merge" || action.actionClass === "close");
  const finalTerminalAction = args.breakerOnPlan.some((action) => action.actionClass === "merge" || action.actionClass === "close");
  if (plannedTerminalAction && !finalTerminalAction)
    return "auto-action held by precision circuit breaker";
  if (args.ciHasPending || args.ciState === "pending")
    return "auto-action held because CI is still pending";
  const protectedAuthor = args.authorIsAutomationBot || args.authorIsOwner || args.authorIsAdmin;
  if (args.ciState === "failed") {
    return (
      closeWithheldReason({ protectedAuthor, closeOwnerAuthors: args.closeOwnerAuthors, closeAutonomy: args.closeAutonomy }) ??
      "auto-action held because CI is failing but no close action was planned"
    );
  }
  if (args.gateConclusion === "success") {
    if (args.mergeableState === "dirty")
      return "merge withheld because the PR conflicts with the base branch";
    if (args.mergeableState && args.mergeableState !== "clean")
      return boundAgentHoldAuditReason(`merge withheld because mergeable_state is ${args.mergeableState}`);
    if (!args.approvalsSatisfied)
      return "merge withheld because required approvals are not satisfied";
    if (args.mergeAutonomy !== "auto" && args.mergeAutonomy !== "auto_with_approval")
      return boundAgentHoldAuditReason(`merge withheld because merge autonomy is ${args.mergeAutonomy}`);
    return "merge withheld because no merge action was planned";
  }
  if (args.gateBlockerCodes.length > 0) {
    return (
      closeWithheldReason({ protectedAuthor, closeOwnerAuthors: args.closeOwnerAuthors, closeAutonomy: args.closeAutonomy, blockerCode: args.gateBlockerCodes[0] }) ??
      boundAgentHoldAuditReason(`held on gate blocker ${args.gateBlockerCodes[0]}`)
    );
  }
  if (protectedAuthor && args.closeOwnerAuthors !== true)
    return "auto-action held for protected author";
  return "no auto-action planned";
}

/**
 * Historical compatibility helper for callers/tests that still need to know whether branch-protection contexts
 * were readable. The disposition planner no longer uses this to soften red CI: any visible completed red
 * check/status is adverse, while required contexts still matter for missing/pending detection.
 */
export function hasVerifiedRequiredContexts(
  requiredContexts: Set<string> | null,
): boolean {
  return requiredContexts != null && requiredContexts.size > 0;
}

export function agentMaintenanceHeadMatchesGate(reviewedHeadSha: string | null | undefined, currentHeadSha: string | null | undefined): boolean {
  return reviewedHeadSha == null || currentHeadSha == null || currentHeadSha === reviewedHeadSha;
}

type BlockingPullRequestFreshness = Extract<
  PullRequestFreshness,
  { status: "stale" }
>;

function freshnessBlocksReviewOutput(
  freshness: PullRequestFreshness,
): freshness is BlockingPullRequestFreshness {
  return freshness.status === "stale";
}

class RetryablePullRequestFreshnessUnavailableError extends RetryableJobError {
  constructor() {
    super("live PR state unavailable; retrying review output publication", {
      retryAfterMs: 60_000,
      retryKind: "pr_freshness_unavailable",
    });
    this.name = "RetryablePullRequestFreshnessUnavailableError";
  }
}

async function reviewTargetFreshness(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    pullNumber: number;
    expectedHeadSha?: string | null | undefined;
    deliveryId: string;
    phase: string;
    actor: string | null;
  },
): Promise<PullRequestFreshness> {
  const freshness = await fetchPullRequestFreshness(env, {
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    expectedHeadSha: args.expectedHeadSha,
  });
  if (!freshnessBlocksReviewOutput(freshness)) return freshness;
  await recordAuditEvent(env, {
    eventType: "github_app.pr_review_stale",
    actor: args.actor,
    targetKey: `${args.repoFullName}#${args.pullNumber}`,
    outcome: "denied",
    detail: `${pullRequestFreshnessDetail(freshness)} — stale review output suppressed`,
    metadata: {
      deliveryId: args.deliveryId,
      repoFullName: args.repoFullName,
      phase: args.phase,
      reason: freshness.reason,
      expectedHeadSha: freshness.expectedHeadSha,
      liveHeadSha: freshness.liveHeadSha,
      liveState: freshness.liveState,
      ...(freshness.reason === "unavailable"
        ? {
            unavailableSource: freshness.unavailableSource ?? "unknown",
            unavailableDetail: freshness.unavailableDetail ?? null,
          }
        : {}),
    },
  }).catch(() => undefined);
  return freshness;
}

/**
 * #778 maintainer auto-maintain trigger. After the gate runs on a PR webhook, if the repo opted the agent in
 * (an acting autonomy level), reuse the CANONICAL verdict produced by the full gate evaluation, plan the
 * GitHub state actions, and run them through the
 * executor's deny-toward-safety gate stack (pause → approval → write-permission → mode). Decoupled and
 * best-effort: a failure here never affects the gate or the public surface. The agent acts purely off the
 * gate verdict + CI state — every author is handled identically (auto-merge on a clean pass, one-shot close
 * on a real blocker), since confirmed-status no longer changes the gate. (#gate-nonconfirmed)
 */
async function maybeRunAgentMaintenance(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    repo: Awaited<ReturnType<typeof getRepository>>;
    pr: PullRequestRecord;
    settings: RepositorySettings;
    otherOpenPullRequests: PullRequestRecord[];
    deliveryId: string;
    gate: ReturnType<typeof evaluateGateCheck> | undefined;
    liveFacts: LiveGithubFacts;
  },
): Promise<void> {
  const {
    installationId,
    repoFullName,
    settings,
    otherOpenPullRequests,
    gate,
  } = args;
  if (!isAgentConfigured(settings.autonomy)) return;
  // Re-read the stored PR so we act on the persisted slop score the gate just wrote, not the pre-gate payload.
  const pr = await getPullRequest(env, repoFullName, args.pr.number);
  /* v8 ignore next -- defensive: the PR was upserted earlier in this same webhook, so it is always present. */
  if (!pr) return;
  if (pr.state !== "open") return;
  // The gate verdict belongs to the webhook/re-review head that produced it. Under concurrent self-host queues, a
  // newer synchronize can advance the stored row before this job acts; fail closed rather than pairing a stale
  // passing gate with a newer, unreviewed head for CI, planning, or merge execution.
  if (!agentMaintenanceHeadMatchesGate(args.pr.headSha, pr.headSha)) return;
  // Drafts are work-in-progress: never auto-approve / merge / close / label a draft. Symmetric with the re-gate
  // sweep, which drops drafts (agent-sweep.ts). A draft signals "not ready"; the agent acts once it is marked
  // ready_for_review (which re-triggers this path on the now-undrafted PR). The converted_to_draft draft-dodge
  // guard is a separate handler and is unaffected. (#audit-draft-maintenance)
  if (pr.isDraft) return;
  if (!gate) return;

  // Per-PR mutual exclusion (#2129): a webhook re-review and a sweep-driven agent-regate-pr job use different
  // coalesce-key shapes (jobCoalesceKey never matches one against the other) and QUEUE_CONCURRENCY explicitly
  // overlaps I/O-bound jobs, so two passes for the SAME PR can both reach this point concurrently, each with its
  // own independently-timed live CI/mergeable/reviewDecision read. If those reads disagree, both could plan and
  // execute DIFFERENT actions for the same PR. Claim a short-TTL advisory lock before the plan-and-execute
  // critical section (extracted below so the try/finally doesn't force-reindent that whole block); a pass that
  // loses the race defers cleanly — the next webhook/sweep tick is the backstop. Lightweight stand-in for the
  // per-PR SubmissionLock Durable Object noted as a longer-term TODO in env.d.ts.
  const actuationLock = await claimPrActuationLock(env, repoFullName, pr.number);
  if (!actuationLock.acquired) return;
  try {
    await runAgentMaintenancePlanAndExecute(env, {
      installationId,
      repoFullName,
      repo: args.repo,
      pr,
      settings,
      otherOpenPullRequests,
      deliveryId: args.deliveryId,
      gate,
      liveFacts: args.liveFacts,
    });
  } finally {
    await releasePrActuationLock(env, repoFullName, pr.number, actuationLock.ownerToken);
  }
}

/** The plan-and-execute critical section of {@link maybeRunAgentMaintenance}, extracted so the caller's
 *  per-PR lock (#2129) wraps it in a try/finally without reindenting this whole block. */
async function runAgentMaintenancePlanAndExecute(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    repo: Awaited<ReturnType<typeof getRepository>>;
    pr: PullRequestRecord;
    settings: RepositorySettings;
    otherOpenPullRequests: PullRequestRecord[];
    deliveryId: string;
    gate: ReturnType<typeof evaluateGateCheck>;
    liveFacts: LiveGithubFacts;
  },
): Promise<void> {
  const { installationId, repoFullName, pr, settings, otherOpenPullRequests, deliveryId, gate } = args;

  // Convergence safety: feed the planner the PR's changed paths + the repo's hard-guardrail globs so guarded
  // paths force manual review, and flag owner-authored PRs so they are never auto-closed (standing rule).
  // FIX B: resolve files via the shared resolver so an EMPTY stored list (the maintenance ran before the
  // detail-sync populated pull_request_files) can't silently empty changedPaths and let a guarded PR slip the
  // guardrail into an auto-merge — it inline-fetches the real changed paths when stored is still empty.
  // CRITICAL CI POLICY (reviewbot ci_red parity): fetch the LIVE CI aggregate over BOTH check-runs AND classic
  // commit-statuses (codecov posts a commit-status, NOT a check-run — the stored check_summaries miss it). The
  // planner uses this to NEVER approve/merge a PR whose CI isn't green, to CLOSE a red-CI non-owner PR (citing
  // the failing checks) / HOLD the owner's, and to DEFER entirely while CI is still pending.
  const ciToken = await createInstallationToken(env, installationId).catch(
    () => undefined,
  );
  const token = ciToken ?? env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubAdmissionKeyForToken(env, installationId, token);
  const baseRef = pr.baseRef ?? args.repo?.defaultBranch;
  const hardGuardrailGlobs = resolveHardGuardrailGlobs(settings);
  const [
    changedFiles,
    requiredContextsLookup,
    liveMergeState,
    liveReviewDecision,
  ] = await Promise.all([
    resolvePullRequestFilesForReview(env, {
      installationId,
      repoFullName,
      pullNumber: pr.number,
    }),
    // RC2: branch-protection REQUIRED status contexts, so only a required red check gates the PR (a red
    // codecov/* is surfaced but never blocks merge/approve or forces request_changes). null ⇒ fold all red.
    cachedRequiredStatusContexts(
      env,
      repoFullName,
      args.liveFacts,
      baseRef,
      token,
      settings.expectedCiContexts,
      admissionKey,
    ),
    // Live mergeable_state after the gate's own publish/review/check mutations. Readiness may have seen the PR as
    // blocked before the bot approval/check landed, so this boundary must never replay the durable cross-webhook
    // cache -- but maybePublishPrPublicSurface's OWN post-publish refresh (same pass, same liveFacts object) has
    // typically already paid for this exact live read moments earlier (#4498); reuse it instead of fetching twice.
    reuseOrRefreshLiveMergeState(env, repoFullName, args.liveFacts, pr.number, token, admissionKey),
    // RC1: live reviewDecision so the approve/request-changes dedup is accurate. The STORED reviewDecision is
    // only written by the open-PR backfill and goes stale → the planner re-posted a review every cycle (the
    // re-review loop with 14-23 stacked reviews). With the live value, an already-approved/changes-requested PR
    // is not re-reviewed for the same state.
    fetchLivePullRequestReviewDecision(env, repoFullName, pr.number, token, admissionKey),
  ]);
  const requiredContexts = requiredContextsLookup.requiredContexts;
  // Same reuse-this-pass-else-refresh-live rationale as reuseOrRefreshLiveMergeState above (#4498).
  const ciAggregate = await reuseOrRefreshLiveCiAggregate(
    env,
    repoFullName,
    args.liveFacts,
    pr.number,
    pr.headSha,
    baseRef,
    token,
    settings.expectedCiContexts,
    admissionKey,
  );
  // #2137: informational-only nudge for the operator — never affects the disposition below (ciState is
  // unchanged). recordAuditEvent is a DB write with its own internal failure handling; a failure here must
  // never block the maintenance pass, hence the outer .catch().
  if (ciAggregate.ciCompletenessWarning) {
    /* v8 ignore next -- ciCompletenessWarning is only ever set when ciState === "passed", and
     * fetchLiveCiAggregate/reduceLiveCiAggregate short-circuit to "unverified" for a falsy headSha before ever
     * reaching that computation — so pr.headSha (the same value passed into refreshLiveCiAggregate above) is
     * always truthy here; the fallback is defensive. */
    const ciCompletenessHeadSha = pr.headSha ?? null;
    await recordAuditEvent(env, {
      eventType: "github_app.ci_completeness_unverified",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail: ciAggregate.ciCompletenessWarning,
      metadata: { deliveryId: args.deliveryId, repoFullName, headSha: ciCompletenessHeadSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
  }
  const changedPaths = changedPathsForGuardrail(changedFiles);
  const guardrailMatches = guardrailPathMatches(changedPaths, hardGuardrailGlobs);
  // #2550: live migrations/** collision recheck — config-gated (off by default) AND path-gated (only a PR
  // that actually touches migrations/** pays the extra GitHub API call), so a non-migrations PR sees zero
  // added latency: the whole block short-circuits on the boolean+array checks before any network call.
  //
  // Deliberately built from `changedFiles` directly, NOT from `changedPaths` (changedPathsForGuardrail's
  // output) — that helper unions BOTH `file.path` (current name) and `file.previousFilename` (pre-rename
  // name) into one flat set for its own, unrelated guardrail-path-matching purpose. Reusing it here would
  // mean a PR that simply RENAMES its own not-yet-merged migration file (e.g. fixing a typo, or renumbering
  // to resolve a collision — the exact remediation this feature's own hold comment recommends) counts BOTH
  // the old and new filenames as "this PR's own migration files", numerically colliding with itself and
  // producing a false hold that can never clear (a later rename still carries the stale old name forever, on
  // every subsequent maintenance pass). Only `.path` (the file's CURRENT name) and only non-removed files
  // reflect what will actually exist in this PR's tree once merged.
  const prMigrationFilenames = changedFiles
    .filter((f) => f.status !== "removed" && f.path.startsWith("migrations/") && f.path.endsWith(".sql"))
    .map((f) => f.path.slice("migrations/".length));
  // Base filenames this PR's diff removes from `migrations/**` — an outright deletion's own `.path`, or a
  // rename's pre-rename `.previousFilename` — so a filename that won't exist once this PR merges isn't still
  // counted from the live base fetch below. Without this, renaming an EXISTING base migration within the same
  // number (e.g. `migrations/0099_old.sql` -> `migrations/0099_new.sql`, fixing a typo on an already-merged
  // file) unions both the old (still live) and new (this PR's) name and self-collides, even though the merged
  // tree would only ever contain the new file.
  const prRemovedMigrationFilenames = changedFiles.flatMap((f) => {
    const removed: string[] = [];
    if (f.status === "removed" && f.path.startsWith("migrations/") && f.path.endsWith(".sql")) {
      removed.push(f.path.slice("migrations/".length));
    }
    if (f.previousFilename && f.previousFilename.startsWith("migrations/") && f.previousFilename.endsWith(".sql")) {
      removed.push(f.previousFilename.slice("migrations/".length));
    }
    return removed;
  });
  const migrationCollisionHold =
    settings.premergeContentRecheck === true && prMigrationFilenames.length > 0
      ? await resolveLiveMigrationCollisionHold({
          repoFullName,
          baseRef,
          token,
          admissionKey,
          prMigrationFilenames,
          prRemovedMigrationFilenames,
        })
      : undefined;
  const repoOwner = repoFullName.includes("/")
    ? repoFullName.slice(0, repoFullName.indexOf("/"))
    : "";
  const authorLogin = pr.authorLogin ?? "";
  const authorIsOwner =
    authorLogin.length > 0 &&
    authorLogin.toLowerCase() === repoOwner.toLowerCase();
  // Fleet-operator identity (#2133): the same ADMIN_GITHUB_LOGINS allowlist already honored by the
  // reopen-reclose path's hasMaintainerPermission, folded into the primary close-eligibility computation so an
  // admin login (not the literal repo owner) gets the identical never-auto-closed exemption everywhere.
  const authorIsAdmin =
    authorLogin.length > 0 &&
    parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(authorLogin.toLowerCase());
  const authorIsAutomationBot = isProtectedAutomationAuthor(pr.authorLogin);

  // Linked-issue HARD-RULE close (#linked-issue-hard-rules): when the repo enabled any rule, a body that links
  // MORE closing references than we can safely verify (overflow) is itself a violation; otherwise evaluate the
  // linked issues' facts (fail-open per issue). The decision is extracted into resolveLinkedIssueHardRule (pure,
  // dependency-injected) so it is unit-tested directly rather than only through this orchestrator. Config load is
  // FAIL-SAFE (a KV fault yields all-off, never a surprise close).
  const linkedIssueRulesConfig = await loadLinkedIssueHardRules(
    env,
    repoFullName,
  );
  const liveLinkedIssueHardRule = await resolveLinkedIssueHardRule({
    env,
    repoFullName,
    repoOwner,
    config: linkedIssueRulesConfig,
    body: pr.body,
    linkedIssues: pr.linkedIssues,
    ciToken,
    prAuthorLogin: pr.authorLogin,
    installationId,
  });
  // Violation-persistence backstop (#linked-issue-hard-rule-persistence): remember a CONFIRMED violation forever
  // (markPullRequestLinkedIssueHardRuleViolated is a no-op once already set) so a LATER pass can't lose it to a
  // body edit or a linked issue's live state changing -- see mergeLinkedIssueHardRuleWithPersistedViolation's own
  // doc comment for the full dodge-window rationale. Best-effort write: a D1 hiccup here only means this ONE
  // confirmed violation isn't remembered, matching every other gittensory-computed marker write in this file
  // (mergeBlockedSha, draftConversionCount, lastRegatedAt).
  if (liveLinkedIssueHardRule?.violated === true) {
    await markPullRequestLinkedIssueHardRuleViolated(env, repoFullName, pr.number, liveLinkedIssueHardRule.reason ?? "the linked issue is not eligible for a community PR").catch(() => undefined);
  }
  const linkedIssueHardRule = mergeLinkedIssueHardRuleWithPersistedViolation(liveLinkedIssueHardRule, {
    violatedAt: pr.linkedIssueHardRuleViolatedAt,
    reason: pr.linkedIssueHardRuleViolationReason,
  });

  // Unlinked-issue guardrail (#unlinked-issue-guardrail, credibility-gate-farming defense): when this PR
  // links NO issue and the repo opted in (settings.unlinkedIssueGuardrail.mode === "hold"), check whether the
  // diff appears to directly, unambiguously solve an EXISTING open issue that was never linked -- a possible
  // sign of a contributor slicing an issue into unlinked PRs to dodge scope scrutiny while still farming
  // merge-ratio credibility. Config-gated AND linked-issue-count-gated at the CALL SITE (not just inside the
  // resolver) so the diff-building work below is skipped entirely for the default-off / already-linked cases
  // -- byte-identical extra cost, mirroring migrationCollisionHold's own gating above. A FIRST confirmed match
  // only ever HOLDS the PR for manual review (folded into heldForManualReview); a CONFIRMED REPEAT by the
  // same contributor (#unlinked-issue-guardrail-followup, tracked via audit_events) escalates to a CLOSE.
  const unlinkedIssueGuardrailConfig = settings.unlinkedIssueGuardrail ?? DEFAULT_UNLINKED_ISSUE_GUARDRAIL;
  const unlinkedIssueMatchDisposition =
    unlinkedIssueGuardrailConfig.mode === "hold" && pr.linkedIssues.length === 0
      ? await resolveUnlinkedIssueMatchDisposition(env, {
          repoFullName,
          pullNumber: pr.number,
          config: unlinkedIssueGuardrailConfig,
          linkedIssueCount: pr.linkedIssues.length,
          prTitle: pr.title,
          prBody: pr.body,
          changedPaths,
          diff: buildAiReviewDiff(changedFiles),
          prAuthorLogin: pr.authorLogin,
        })
      : undefined;
  const unlinkedIssueMatchHold = unlinkedIssueMatchDisposition?.kind === "hold" ? unlinkedIssueMatchDisposition : undefined;
  const unlinkedIssueMatchClose = unlinkedIssueMatchDisposition?.kind === "close" ? unlinkedIssueMatchDisposition : undefined;

  // Contributor blacklist (#1425): resolve whether the PR author is on the repo's blacklist (the shared/global
  // list unions in once its table lands). A match short-circuits the planner to a deterministic label + close
  // ahead of merit/CI/AI; only the configured label (default "slop") reaches public actions.
  const blacklistEntry = findBlacklistEntry(
    pr.authorLogin,
    settings.contributorBlacklist,
  );

  // Screenshot-table gate (#2006): a DETERMINISTIC check (no AI) that an in-scope (label/path-matched)
  // contributor visual/frontend PR's body contains a before/after screenshot table -- OR (#4110) that the
  // bot's own visual-capture pipeline already produced a real before/after render for this exact head
  // (markPullRequestVisualCaptureSatisfied, written earlier in this same webhook by maybePublishPrPublicSurface
  // -- see that function's beforeAfter block -- and re-read here on `pr`, which this caller already re-fetched
  // fresh from the DB). Off by default (settings.screenshotTableGate.enabled === false), so the pure evaluator
  // below is effectively free for the common case. "close" is the only enforcement action this gate has (#4110
  // removed the dead request_changes/comment surface) -- the check below is the ONLY place that reads `.action`.
  /* v8 ignore next -- defensive: resolveRepositorySettings always populates screenshotTableGate (getRepositorySettings's DB defaults), so this fallback is unreachable in practice. */
  const screenshotTableGateConfig = settings.screenshotTableGate ?? DEFAULT_SCREENSHOT_TABLE_GATE;
  const botCaptureSatisfied = Boolean(pr.headSha) && pr.visualCaptureSatisfiedSha === pr.headSha;
  const screenshotTableGateResult = evaluateScreenshotTableGate({
    config: screenshotTableGateConfig,
    prBody: pr.body,
    prLabels: pr.labels,
    changedFiles: changedPaths,
    botCaptureSatisfied,
  });
  const screenshotTableMatch =
    screenshotTableGateResult.violated && screenshotTableGateConfig.action === "close"
      ? { matched: true, reason: screenshotTableGateResult.reason }
      : undefined;

  // Account-age throttle (#2561, anti-abuse): a friction/visibility signal for the classic ban-evasion pattern
  // (a banned login gets a fresh account the same day) — NEVER an automatic close on account age alone. Off
  // (null accountAgeThresholdDays, the default) ⇒ this block is a no-op, no extra GitHub API call at all.
  // Fires for a CONTRIBUTOR only — same standing owner/admin/automation-bot exemption as every other
  // anti-abuse mechanism above. The label is applied directly (fire-and-forget, matching mode gating) rather
  // than threaded through the planner: this is advisory/visibility only, independent of the merit/CI/AI
  // disposition the planner computes below. #label-scoping: gated on the DEDICATED `review_state_label` class
  // (the same family as the planner's own disposition-communication labels — this is a visibility signal about
  // the bot's own read on the PR, never an enforcement action), NOT the generic `label` — a repo that has not
  // opted into `review_state_label` must not have this throttle silently write labels.
  let isNewAccount = false;
  const accountAgeThresholdDays = settings.accountAgeThresholdDays;
  if (typeof accountAgeThresholdDays === "number" && pr.authorLogin && !authorIsOwner && !authorIsAdmin && !authorIsAutomationBot) {
    const createdAt = await getGithubUserCreatedAt(env, installationId, pr.authorLogin);
    if (createdAt) {
      const ageDays = (Date.now() - Date.parse(createdAt)) / (24 * 60 * 60 * 1000);
      isNewAccount = ageDays < accountAgeThresholdDays;
    }
    if (isNewAccount && resolveAutonomy(settings.autonomy, "review_state_label") === "auto") {
      const newAccountMode = resolveAgentActionMode({
        globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
        agentPaused: settings.agentPaused,
        agentDryRun: settings.agentDryRun,
      });
      await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, settings.newAccountLabel ?? "new-account", {
        createMissingLabel: settings.createMissingLabel,
        mode: newAccountMode,
      }).catch(
        /* v8 ignore next -- fail-safe: a label-application failure must never block the rest of the handler */
        () => undefined,
      );
    }
  }

  // Per-contributor open-PR cap (#2270, anti-abuse): count this author's OTHER currently-open PRs on this repo
  // (otherOpenPullRequests already excludes the current PR — see reconcileLiveDuplicateSiblings) plus this one,
  // ranked by PR NUMBER (GitHub's own creation order, not webhook-arrival order) so a burst of near-simultaneous
  // opens still ranks deterministically. Only matches when THIS PR's number is among the ones over the cap — an
  // older sibling that was already under the cap when it was opened stays open. The owner/admin/automation-bot
  // exemption is applied by the planner itself (defense-in-depth, mirroring how blacklistEntry above is resolved
  // unconditionally and exempted only inside planAgentMaintenanceActions). Disabled (null/undefined cap, the
  // default) ⇒ this block is a no-op. A below-account-age-threshold author (#2561) gets a TIGHTER effective
  // cap (half, rounded up, minimum 1) — visibility/friction, still never a close on account age by itself
  // (the close, if any, is still tagged/reasoned as the ordinary contributor-cap close).
  let contributorCapMatch: { matched: boolean; authorLogin: string; openCount: number; cap: number; itemKind: "pull requests" | "issues" | "pull requests and issues"; scope?: "repository" | "install" | undefined } | undefined;
  const contributorOpenPrCap =
    isNewAccount && typeof settings.contributorOpenPrCap === "number"
      ? Math.max(1, Math.ceil(settings.contributorOpenPrCap / 2))
      : settings.contributorOpenPrCap;
  // #2270/#2463-parity: the per-repo cap now honors the SAME shared `autoCloseExemptLogins` allowlist the
  // install-wide cap (below) and review-nag cooldown already do -- previously only the owner/admin/automation-bot
  // exemption (applied later, inside planAgentMaintenanceActions) protected an author here, so a maintainer-named
  // trusted-but-not-a-recognized-bot login (e.g. a third-party automation App like Sentry's Seer fix bot) had no
  // way to opt out of the PER-REPO cap specifically, even though `.gittensory.yml`'s own doc comment already
  // promised this reuse (auto-close-exempt.ts).
  if (typeof contributorOpenPrCap === "number" && pr.authorLogin && !isAutoCloseExempt(pr.authorLogin, settings.autoCloseExemptLogins)) {
    // Fixed-budget author-scoped set (the lowest-numbered sibling sample), with every counted sibling
    // positively LIVE-confirmed still open before it counts toward an irreversible close decision (#2270
    // busy-repo bypass fix). Runs unconditionally now -- not just for isNewAccount -- since a stale-DB-row
    // false positive is exactly as wrong for an established contributor as for a new one; this supersedes the
    // narrower new-account-only live-verify this block used to have. Reuses the function-scoped token/admissionKey
    // (already resolved above for the live-CI recheck) rather than minting a second one.
    const otherAuthorOpenPullRequests = await listOtherOpenPullRequestsForAuthor(env, repoFullName, pr.number, pr.authorLogin);
    const confirmedOpen = new Set<number>();
    // Bounded concurrency (security review finding): an unbounded Promise.all here scales with the author's
    // OWN open-PR sample, not a fixed small number -- an author with dozens of open PRs would fire that many
    // concurrent GitHub calls from a single webhook, and the delivery-order-guard wake below re-triggers this
    // same block for every over-cap sibling, compounding into near-quadratic API growth that can exhaust the
    // installation's rate-limit budget. Every sampled entry must still be verified (the exact over-cap PR
    // numbers below depend on the confirmed-open sample, not just "is the count over cap"), so this bounds
    // concurrency in addition to the repository query's total row cap.
    await mapWithConcurrency(otherAuthorOpenPullRequests, CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY, async (other) => {
      const liveState = await fetchLivePullRequestState(env, repoFullName, other.number, token, admissionKey).catch(() => undefined);
      if (liveState === "open") confirmedOpen.add(other.number);
    });
    const authorOpenPrNumbers = otherAuthorOpenPullRequests
      .filter((other) => confirmedOpen.has(other.number))
      .map((other) => other.number)
      .concat(pr.number)
      .sort((a, b) => a - b);
    const overCapNumbers = new Set(authorOpenPrNumbers.slice(contributorOpenPrCap));
    if (overCapNumbers.has(pr.number)) {
      contributorCapMatch = { matched: true, authorLogin: pr.authorLogin, openCount: authorOpenPrNumbers.length, cap: contributorOpenPrCap, itemKind: "pull requests" };
    }
    // Webhook-delivery-order guard (#2479 gate finding): delivery order is not guaranteed to match PR creation
    // order, so a sibling PR's own webhook can process before THIS PR exists in the DB and wrongly conclude the
    // author is within the cap. Use the fixed-budget author-scoped set and only siblings positively confirmed
    // open, matching the issue-cap fail-safe close contract.
    const otherOverCapSiblingNumbers = otherAuthorOpenPullRequests
      .filter((other) => confirmedOpen.has(other.number) && overCapNumbers.has(other.number))
      .map((other) => other.number);
    if (otherOverCapSiblingNumbers.length > 0) {
      await wakeOverCapSiblingPullRequests(env, deliveryId, installationId, repoFullName, otherOverCapSiblingNumbers);
    }
  }

  // Install-wide contributor open-item cap (#2562, anti-abuse): IN ADDITION TO the per-repo cap above, not
  // instead of it -- only evaluated when the per-repo cap didn't already match (short-circuit: no need for a
  // second cross-repo DB read once this PR is already being closed). Defaults to a real cap even when unset
  // (#4511) -- a CONFIRMED official Gittensor miner gets its own, higher fleet-appropriate default instead of
  // either "no cap" or the plain human default, since a legitimate fleet spread across many repos in one
  // install is expected to run more concurrent open items than a single human contributor. Reuses the shared
  // autoCloseExemptLogins list (#2463) so a maintainer-named login is exempt here exactly like the per-repo
  // caps and review-nag cooldown.
  const prGlobalCapForHuman = resolveGlobalContributorOpenItemCap(env);
  const prGlobalCapForMiner = resolveGlobalContributorOpenItemCapForMiner(env);
  if (
    contributorCapMatch === undefined &&
    pr.authorLogin &&
    (prGlobalCapForHuman !== null || prGlobalCapForMiner !== null) &&
    !isAutoCloseExempt(pr.authorLogin, settings.autoCloseExemptLogins)
  ) {
    // Deferred until we know at least one of the two resolvers is actually active (#4511): the identity
    // lookup below is cached but still a DB/network round trip, and both resolvers above are plain env reads.
    const officialMiner = await getCachedOfficialMinerDetection(env, pr.authorLogin, {
      targetKey: `${repoFullName}#${pr.number}`,
      deliveryId,
    });
    const globalCap = officialMiner.status === "confirmed" ? prGlobalCapForMiner : prGlobalCapForHuman;
    if (globalCap !== null) {
      const globalOpenCount = await verifiedGlobalOpenItemCount(env, installationId, pr.authorLogin, {
        repoFullName,
        number: pr.number,
        kind: "pull_request",
      }, globalCap);
      if (globalOpenCount > globalCap) {
        // verifiedGlobalOpenItemCount sums BOTH open PRs and open issues -- reporting this as "pull requests"
        // when the author's over-cap total may include issues would be a factually wrong close message.
        contributorCapMatch = { matched: true, authorLogin: pr.authorLogin, openCount: globalOpenCount, cap: globalCap, itemKind: "pull requests and issues", scope: "install" };
      }
    }
  }

  const autoMaintain =
    settings.autoMaintain ?? DEFAULT_AUTO_MAINTAIN_POLICY;
  const approvalsSatisfied =
    autoMaintain.requireApprovals === 0 ||
    (liveReviewDecision ?? pr.reviewDecision) === "APPROVED";
  const duplicateWinnerEnabled = env.GITTENSORY_DUPLICATE_WINNER === "true";
  const openDuplicateSiblings = linkedIssueDuplicatePullRequestRecordsForGate(pr, otherOpenPullRequests);
  // AI-review low-confidence guardrail (#4603): resolved PURELY from this pass's own gate evaluation + settings
  // (no extra network/DB call, unlike migrationCollisionHold/unlinkedIssueMatchHold above) -- undefined unless the
  // gate failed SOLELY on a sub-aiReviewCloseConfidence-floor ai_consensus_defect/ai_review_split finding under
  // the (default) hold_for_review disposition. See resolveAiReviewLowConfidenceHold's own doc comment.
  const aiReviewLowConfidenceHold = resolveAiReviewLowConfidenceHold(gate, settings);
  const planned = planAgentMaintenanceActions({
    conclusion: gate.conclusion,
    blockerTitles: gate.blockers.map((blocker) => blocker.title),
    // Public-safe finding identifiers retained for telemetry/action reasons. They no longer refute a blocker on
    // green CI; once the gate says failure, the close/hold decision follows that verdict.
    gateBlockerCodes: gate.blockers.map((blocker) => blocker.code),
    autonomy: settings.autonomy,
    autoMaintain: settings.autoMaintain,
    slopGateMinScore: settings.slopGateMinScore,
    changedPaths,
    hardGuardrailGlobs,
    manualReviewLabel: settings.manualReviewLabel,
    readyToMergeLabel: settings.readyToMergeLabel,
    changesRequestedLabel: settings.changesRequestedLabel,
    migrationCollisionLabel: settings.migrationCollisionLabel,
    pendingClosureLabel: settings.pendingClosureLabel,
    authorIsOwner,
    authorIsAdmin,
    authorIsAutomationBot,
    closeOwnerAuthors: settings.closeOwnerAuthors,
    ciState: ciAggregate.ciState,
    ciHasPending: ciAggregate.hasPending,
    failingCheckNames: ciAggregate.failingDetails.map((detail) => detail.name),
    ciRequiredContextsVerified: hasVerifiedRequiredContexts(requiredContexts),
    ...(blacklistEntry !== null
      ? { blacklistMatch: { matched: true, reason: blacklistEntry.reason } }
      : {}),
    // Always threaded (the DB layer populates it, default "slop"); the planner applies its own fallback.
    blacklistLabel: settings.blacklistLabel,
    ...(screenshotTableMatch !== undefined ? { screenshotTableMatch } : {}),
    ...(contributorCapMatch !== undefined ? { contributorCapMatch } : {}),
    // Always threaded (the DB layer populates it, default "over-contributor-limit"); the planner applies its
    // own fallback.
    contributorCapLabel: settings.contributorCapLabel,
    ...(linkedIssueHardRule !== undefined ? { linkedIssueHardRule } : {}),
    // Flag-then-close double-check: thread the loaded verify config so the planner FLAGS first then closes on
    // re-verification (default ON). Only passed when a rule is on (the planner reads it only for a violation).
    linkedIssueVerify: {
      verifyBeforeClose: linkedIssueRulesConfig.verifyBeforeClose,
      closeDelaySeconds: linkedIssueRulesConfig.closeDelaySeconds,
    },
    ...(migrationCollisionHold !== undefined ? { migrationCollisionHold } : {}),
    ...(unlinkedIssueMatchHold !== undefined ? { unlinkedIssueMatchHold } : {}),
    ...(aiReviewLowConfidenceHold !== undefined ? { aiReviewLowConfidenceHold } : {}),
    ...(unlinkedIssueMatchClose !== undefined ? { unlinkedIssueMatchClose } : {}),
    pr: {
      mergeableState: liveMergeState ?? pr.mergeableState,
      reviewDecision: liveReviewDecision ?? pr.reviewDecision,
      slopRisk: pr.slopRisk,
      labels: pr.labels,
      // Duplicate-winner adjudication (#dup-winner): the gate's open-only duplicate siblings drive the close
      // reason ("duplicate of another open PR" via agent-actions when count > 0). When the flag is ON and this
      // PR is the cluster winner, force the count to 0 so the winner's close reason OMITS the duplicate cause
      // (it can still close on its own merits — CI/conflict/blockers). Flag-OFF short-circuits ⇒ the real
      // count is used (byte-identical). Sparse legacy rows fail closed so duplicate evidence remains visible.
      linkedDuplicateCount: dupWinnerLinkedDuplicateCount(
        openDuplicateSiblings,
        pr.number,
        pr.linkedIssueClaimedAt,
        duplicateWinnerEnabled,
        pr.createdAt,
      ),
      // #dup-winner-credit: name the cluster's actual winner in a loser's close comment instead of a generic
      // "duplicate of another open PR". `null` (flag off, this PR IS the winner, or an ambiguous election)
      // falls back to the pre-existing generic wording in agent-actions.ts, byte-identical to before this existed.
      linkedDuplicateWinnerNumber: dupWinnerLinkedDuplicateWinnerNumber(
        openDuplicateSiblings,
        pr.number,
        pr.linkedIssueClaimedAt,
        duplicateWinnerEnabled,
        pr.createdAt,
      ),
      headSha: pr.headSha,
      mergeBlockedSha: pr.mergeBlockedSha,
      approvedHeadSha: pr.approvedHeadSha,
      authorLogin: pr.authorLogin,
      linkedIssues: pr.linkedIssues,
    },
  });
  // Accuracy circuit-breakers (#self-improve / GAP-4): two INDEPENDENT, fail-open precision breakers, chained.
  //   • MERGE breaker (holdonly:<scope>): when set, convert a would-MERGE into a human HOLD before executing.
  //   • CLOSE breaker (closehold:<scope>): when set, convert a HEURISTIC would-CLOSE into a human HOLD (the
  //     deterministic linked-issue-hard-rule close is exempt — downgradeCloseToHold scopes itself).
  // Each read is independent and fail-open (isHoldOnly / isCloseHoldOnly read false until a breaker actually
  // engages), so the common path is byte-identical (both downgrades return the plan unchanged). The chaining is
  // extracted into the pure applyPrecisionBreakers below so it is unit-tested directly.
  const breakerOnPlan = applyPrecisionBreakers(
    planned,
    await isHoldOnly(env, repoFullName),
    await isCloseHoldOnly(env, repoFullName),
    {
      manualReviewLabel: settings.manualReviewLabel,
      readyToMergeLabel: settings.readyToMergeLabel,
      changesRequestedLabel: settings.changesRequestedLabel,
      migrationCollisionLabel: settings.migrationCollisionLabel,
      pendingClosureLabel: settings.pendingClosureLabel,
    },
  );
  // Observability (#terminal-outcome-audit): a bounded-cardinality counter (direction only — no repo/PR/reason
  // text) so an operator can see, at a glance, how much of the plan a breaker is currently rewriting, without
  // re-deriving it from individual PR audit rows. Fires only when the breaker actually changed something —
  // the common (not-engaged) path increments nothing, matching every other breaker log in this codebase.
  // Captured into a variable (not just consumed by the loop below) so the hold-audit metadata below can report
  // whether/which direction the breaker engaged without recomputing it a second time (#selfhost-holdplan-audit).
  const precisionBreakerDirections = precisionBreakerDowngradeDirections(planned, breakerOnPlan);
  for (const direction of precisionBreakerDirections) {
    incr("gittensory_precision_breaker_downgrades_total", { direction });
  }
  // Observability (#terminal-outcome-audit): the final per-pass disposition, ALWAYS recorded -- including the
  // "hold" bucket below (guardrail, owner-exemption, migration-collision, breaker-downgraded, or any other
  // reason that produces no merge/close action), which previously left NO aggregate signal at all. Placed
  // BEFORE the early return so an empty breakerOnPlan (the most common hold shape: nothing was ever planned)
  // still increments. autonomy_level reports the class most directly relevant to the recorded action_class --
  // `close` for a hold, since "autonomy.close is auto but this PR still holds" is the exact symptom this
  // metric exists to make visible without hand-querying review_audit. `gate.blockers` is always empty for a
  // `neutral` conclusion (see evaluateGateCheckCore) -- neutralHoldReasonCode recovers the real, nameable hold
  // reason from `gate.warnings` in that case, so a guardrail/size/manifest-blocked hold doesn't flatten to the
  // same "none" bucket as a merge-ready PR waiting on nothing more than pending CI.
  const disposition = agentDispositionLabels(breakerOnPlan, gate.blockers.map((blocker) => blocker.code), neutralHoldReasonCode(gate));
  incr("gittensory_agent_disposition_total", {
    repo: repoFullName,
    action_class: disposition.actionClass,
    blocker_class: disposition.blockerClass,
    autonomy_level: resolveAutonomy(settings.autonomy, disposition.actionClass === "merge" ? "merge" : "close"),
  });
  // The native eval source is used by the self-tune precision breakers, so the stored prediction must reflect the
  // downstream autonomous disposition (merge/close/hold), not only the gate check conclusion. In particular, a
  // failing gate can still become a concrete auto-close after CI/conflict/duplicate/linked-issue planning; recording
  // only the gate's hold-shaped conclusion would blind the close-precision breaker to those live closes.
  await recordNativeGateDecision(env, {
    project: repoFullName,
    pullNumber: pr.number,
    headSha: pr.headSha,
    conclusion: gate.conclusion,
    action: disposition.actionClass,
    reasonCode: disposition.blockerClass === "none" ? gate.conclusion : disposition.blockerClass,
  });
  // #2349 (PR 1): additive per-contributor calibration data, gated identically to recordNativeGateDecision
  // above -- see src/review/contributor-calibration.ts's doc comment. Currently write-only; nothing reads
  // contributor_gate_history yet.
  await recordContributorGateDecision(env, {
    login: pr.authorLogin,
    project: repoFullName,
    pullNumber: pr.number,
    headSha: pr.headSha,
    decision: disposition.actionClass,
  });
  // #4517: pair this REAL decision against a recent predict_gate call from the same login/repo, if one
  // exists -- see src/review/predicted-gate-calibration-ledger.ts's doc comment. Cold start (no prior
  // prediction) records nothing.
  await recordPredictedGateCalibration(env, {
    login: pr.authorLogin,
    project: repoFullName,
    pullNumber: pr.number,
    headSha: pr.headSha,
    decision: disposition.actionClass,
  });
  if (disposition.actionClass === "hold") {
    const gateBlockerCodes = gate.blockers.map((blocker) => blocker.code);
    const mergeAutonomy = resolveAutonomy(settings.autonomy, "merge");
    const closeAutonomy = resolveAutonomy(settings.autonomy, "close");
    // Same isContributor/closeEligible formula planAgentMaintenanceActions itself uses (agent-actions.ts) --
    // duplicated here (not imported) because the planner computes it as a private local, never returns it.
    // Persisted so a hold can be debugged without re-deriving eligibility from the three author-flag booleans
    // by hand (#selfhost-holdplan-audit).
    const isContributorAuthor = !authorIsOwner && !authorIsAdmin && !authorIsAutomationBot;
    const closeEligible = isContributorAuthor || ((authorIsOwner || authorIsAdmin) && settings.closeOwnerAuthors === true);
    const holdDetail = agentHoldAuditDetail({
      planned,
      breakerOnPlan,
      gateConclusion: gate.conclusion,
      gateBlockerCodes,
      ciState: ciAggregate.ciState,
      ciHasPending: ciAggregate.hasPending,
      mergeableState: liveMergeState ?? pr.mergeableState,
      approvalsSatisfied,
      authorIsOwner,
      authorIsAdmin,
      authorIsAutomationBot,
      closeOwnerAuthors: settings.closeOwnerAuthors,
      mergeAutonomy,
      closeAutonomy,
    });
    await recordAuditEvent(env, {
      eventType: "agent.action.hold",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail: holdDetail,
      metadata: {
        deliveryId,
        repoFullName,
        pullNumber: pr.number,
        /* v8 ignore next -- defensive: a real GitHub PR always carries a head sha by the time it reaches this
         * planning/audit path (it was upserted from the API earlier in this same webhook); the null fallback
         * only keeps the JsonValue metadata type honest for the field's declared optionality. */
        headSha: pr.headSha ?? null,
        gateConclusion: gate.conclusion,
        gateBlockerCodes,
        gateBlockerTitles: gate.blockers.map((blocker) => blocker.title),
        ciState: ciAggregate.ciState,
        ciHasPending: ciAggregate.hasPending,
        ciFailingCheckNames: ciAggregate.failingDetails.map((detail) => detail.name),
        mergeableState: liveMergeState ?? pr.mergeableState ?? null,
        reviewDecision: liveReviewDecision ?? pr.reviewDecision ?? null,
        closeEligible,
        closeAutonomy,
        mergeAutonomy,
        protectedAuthor: { owner: authorIsOwner, admin: authorIsAdmin, automation: authorIsAutomationBot },
        closeOwnerAuthors: settings.closeOwnerAuthors,
        precisionBreakerEngaged: precisionBreakerDirections.length > 0,
        precisionBreakerDirections,
        guardrailMatches,
        disposition,
        plannedActionClasses: planned.map((action) => action.actionClass),
        finalActionClasses: breakerOnPlan.map((action) => action.actionClass),
      },
    }).catch(() => undefined);
  }
  if (breakerOnPlan.length === 0) {
    return;
  }

  // #2552 (gate review finding, round 2): force a fresh rebase + CI recheck when the base has advanced within
  // the configured window, immediately before what would otherwise be an agent-driven merge — mergeable_state
  // only detects git-level TEXTUAL conflicts, so a base that advanced with a new, non-conflicting sibling
  // commit (e.g. a second PR's distinct-but-colliding migration file) still reads `clean`, on a decision that
  // predates the base's latest commit. Deliberately placed AFTER the full plan (gate/CI/blockers/breakers) is
  // resolved, not on the raw mergeableState alone: the original placement ran this unconditionally whenever
  // mergeableState was clean, so a PR sitting on red CI or a gate blocker (still git-clean) could burn the
  // bounded retry cap on rebases nobody was about to act on, exhausting it before the PR was ever actually
  // merge-eligible. Only fires when the resolved plan contains a merge THAT WOULD EXECUTE NOW (requiresApproval
  // stages for a human, not an immediate merge). A forced rebase's resulting `synchronize` webhook re-triggers
  // a fresh evaluation on the new head, so this pass stops here rather than executing against stale inputs.
  const requireFreshRebaseWindowMinutes = settings.requireFreshRebaseWindowMinutes;
  const planHasImminentMerge = breakerOnPlan.some((action) => action.actionClass === "merge" && !action.requiresApproval);
  if (
    typeof requireFreshRebaseWindowMinutes === "number" &&
    baseRef &&
    planHasImminentMerge &&
    (liveMergeState ?? pr.mergeableState) === "clean" &&
    (await maybeForceFreshRebase(env, {
      installationId,
      repoFullName,
      pr,
      settings,
      windowMinutes: requireFreshRebaseWindowMinutes,
      baseRef,
      token,
      admissionKey,
      deliveryId,
    }))
  ) {
    return;
  }

  const installation = await getInstallation(env, installationId);
  /* v8 ignore next -- an installed-App PR webhook always carries an installation record; the null is defensive. */
  const installationPermissions = installation?.permissions ?? null;
  const actionOutcomes = await executeAgentMaintenanceActions(
    env,
    {
      installationId,
      repoFullName,
      pullNumber: pr.number,
      headSha: pr.headSha,
      autonomy: settings.autonomy,
      agentPaused: settings.agentPaused,
      agentDryRun: settings.agentDryRun,
      agentGlobalFreezeOverride: settings.agentGlobalFreezeOverride,
      installationPermissions,
      authorLogin: pr.authorLogin,
      mergeTrainMode: settings.mergeTrainMode,
      pullRequestCreatedAt: pr.createdAt,
      pullRequestLinkedIssues: pr.linkedIssues,
      pullRequestChangedFiles: pr.changedFiles,
      // CI-run cancellation on a contributor_cap close (#2462): the repo's own explicit setting always wins;
      // null/undefined (unset) falls back to the install-wide CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT env var.
      contributorCapCancelCi: settings.contributorCapCancelCi ?? env.CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT === "true",
      moderationSettings: {
        moderationGateMode: settings.moderationGateMode,
        moderationRules: settings.moderationRules,
        moderationWarningLabel: settings.moderationWarningLabel,
        moderationBannedLabel: settings.moderationBannedLabel,
      },
      // #selfhost-ci-verification: the executor's own final pre-mutation live-CI re-check (immediately before a
      // merge or a CI-driven close) must honor the same effective branch-protection-plus-expected contexts this
      // plan was evaluated against, or the two can disagree on ciState.
      requiredCiContexts: requiredContexts,
      // #3472 split-brain: the executor's own live manual-review hold guard (immediately before approve/merge)
      // must check the SAME configured label the planner itself resolves labels.manualReview from.
      manualReviewLabel: settings.manualReviewLabel,
    },
    breakerOnPlan,
  );

  // Flag-then-close double-check, Pass 2 trigger: only re-enqueue when the pending-closure label mutation
  // completed. Queued/failed/dry-run label actions do not establish the label-backed state that Pass 2 requires,
  // so scheduling off the plan alone can create a verification loop. Best-effort — if the enqueue fails, the next
  // sweep / CI event is the backstop Pass 2. Reuses the existing `recapture-preview` delayed-re-review job.
  const flaggedForLinkedIssue = pendingClosureLabelApplied(
    breakerOnPlan,
    actionOutcomes,
  );
  if (flaggedForLinkedIssue) {
    const delaySeconds = Math.max(0, linkedIssueRulesConfig.closeDelaySeconds);
    const verifyJob = {
      type: "recapture-preview" as const,
      deliveryId: `linked-issue-verify:${repoFullName}#${pr.number}`,
      repoFullName,
      prNumber: pr.number,
      installationId,
      attempt: 0,
    };
    await (
      delaySeconds > 0
        ? env.JOBS.send(verifyJob, { delaySeconds })
        : env.JOBS.send(verifyJob)
    ).catch(() => undefined);
  }
}

/**
 * Re-review a STORED open PR (no payload PR) — rebuild the advisory + gate, re-publish the unified comment, and
 * re-run auto-maintain. Shared by the CI-completion (check_suite/check_run) handler below, mirroring reviewbot's
 * "the CI event WAKES the existing row and re-runs the full review". The PR's persisted head SHA is used as-is
 * (never overwritten from the CI payload — reviewbot scope parity). Best-effort throughout.
 */
async function reReviewStoredPullRequest(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  prNumber: number,
  previewPollAttempt?: number,
  options: { skipAiReview?: boolean; force?: boolean } = {},
): Promise<void> {
  const [repo, settings] = await Promise.all([
    getRepository(env, repoFullName),
    resolveRepositorySettings(env, repoFullName),
  ]);
  let pr = await getPullRequest(env, repoFullName, prNumber);
  if (!pr || pr.state !== "open") return;
  const autoreviewPaused = await hasAutoreviewPausedMarker(env, repoFullName, prNumber);
  const liveFacts = createLiveGithubFacts();
  // #sweep-resync: RESYNC the stored PR to its LIVE head before reviewing. The self-host relay can drop the
  // `synchronize` webhook (relay down), so a push/rebase never refreshes the stored head SHA + cached files; the
  // sweep would then review a STALE diff and the AI fail-closes it as INCOHERENT_DIFF, stranding the PR in "held".
  // Fetch the live PR, and if its head drifted, upsert it + refresh the files so the review runs on the current
  // head. FAIL OPEN: any token/fetch/undefined-head hiccup proceeds with the stored `pr` (never stall the sweep).
  const resyncToken =
    (await createInstallationToken(env, installationId).catch(
      () => undefined,
    )) ?? env.GITHUB_PUBLIC_TOKEN;
  const resyncAdmissionKey = githubAdmissionKeyForToken(env, installationId, resyncToken);
  const live = await fetchLivePullRequest(
    env,
    repoFullName,
    prNumber,
    resyncToken,
    resyncAdmissionKey,
  );
  primeLiveMergeState(liveFacts, repoFullName, prNumber, resyncToken, live?.mergeable_state);
  // #2537: this resync ALREADY paid for a bare GET /pulls/{n} — persist it to the durable cross-webhook cache so
  // the readiness/dup-winner readers below (and future webhook deliveries) don't re-fetch it. Best-effort, never
  // blocks the sweep on a write hiccup.
  await primeDurablePrStateCache(env, repoFullName, prNumber, live).catch(() => undefined);
  // Terminal early-exit (#1942): the PR is CLOSED/merged on GitHub even though the stored row still reads open — a
  // dropped `closed` webhook (relay down). Reconcile the stored row from the live payload and RETURN before the
  // expensive resync (files) + readiness + re-review reads. A stale sweep must never spend GitHub budget — or post
  // visible output — re-reviewing a PR that can no longer produce a valid outcome. Fail-open: only a live NON-open
  // state early-exits (a fetch hiccup leaves `live` undefined → proceed with the stored open PR).
  if (live && live.state !== "open") {
    const current = await getPullRequest(env, repoFullName, prNumber);
    if (current?.state === "open" && current.updatedAt === pr.updatedAt) {
      await upsertPullRequestFromGitHub(env, repoFullName, live).catch(() => undefined);
    }
    return;
  }
  if (live?.head?.sha && live.head.sha !== pr.headSha) {
    await upsertPullRequestFromGitHub(env, repoFullName, live).catch(
      () => undefined,
    );
    await refreshPullRequestDetails(env, repoFullName, prNumber).catch(
      () => undefined,
    );
    /* v8 ignore next -- the row was just upserted above, so the re-read always returns it; `?? pr` is belt-and-suspenders fail-open. */
    pr = (await getPullRequest(env, repoFullName, prNumber)) ?? pr;
  }
  // Operator review flow: rebase-if-behind → wait for ALL CI to finish → only THEN review. Defers (returns) when
  // a rebase fired a synchronize, or CI is still running — the synchronize / CI-completion webhook re-triggers
  // once the head is current and CI has settled (the sweep backstops a missed event). REST-budget dedup
  // (#audit-rate-headroom): seed the request-local facts from the resync payload, then share them with the
  // readiness check, public surface, and auto-maintain planner.
  if (
    !(await withReviewPipelineSpan(
      "selfhost.review.readiness",
      {
        installationId,
        repoFullName,
        pullNumber: pr.number,
        operation: "readiness",
      },
      () =>
        prReadyForReview(
          env,
          installationId,
          repoFullName,
          pr,
          settings,
          deliveryId,
          liveFacts,
        ),
    ))
  )
    return;
  const [cachedOtherOpenPullRequests, { linkedIssueAuthorLogins, confirmedNoOpenLinkedIssue }] =
    await Promise.all([
      listOtherOpenPullRequests(env, repoFullName, prNumber),
      resolveLinkedIssueAdvisoryContext(env, installationId, repoFullName, pr.linkedIssues, settings),
    ]);
  // #dup-winner / audit #15: drop any cached-open duplicate sibling already closed on GitHub before the advisory
  // (and the disposition below) elect the cluster winner, so the real lowest-OPEN PR is never demoted+auto-closed.
  const otherOpenPullRequests = await reconcileLiveDuplicateSiblings(
    env,
    installationId,
    repoFullName,
    pr,
    cachedOtherOpenPullRequests,
  );
  const advisory = buildPullRequestAdvisory(repo, pr, {
    otherOpenPullRequests,
    requireLinkedIssue: shouldCollectLinkedIssueEvidence(settings),
    duplicateWinnerEnabled: env.GITTENSORY_DUPLICATE_WINNER === "true",
    confirmedNoOpenLinkedIssue,
    linkedIssueAuthorLogins,
  });
  await persistAdvisory(env, advisory);
  // #2537 follow-up (gate-flagged): the durable review cache's only invalidation path is markPullRequestReviewsInvalidated
  // on a webhook (processors.ts). A "quiet" PR (no new pushes, slop evidence + manifest gate both off, no
  // pre-merge check paths) never hits any of the three reasons below, so a DROPPED invalidation write could sit
  // stale indefinitely even though this per-PR sweep unit visits every open PR on a bounded cadence.
  // Short-circuit the extra read when another reason already forces the refresh.
  const otherRefreshReasons =
    shouldCollectSlopEvidence(settings) ||
    settings.manifestPolicyGateMode !== "off" ||
    (await shouldRefreshFilesForPreMergeChecks(env, repoFullName));
  const reviewsCacheStale =
    !otherRefreshReasons &&
    !isReviewsCacheUpToDate(await getPullRequestDetailSyncState(env, repoFullName, prNumber).catch(() => null));
  if (otherRefreshReasons || reviewsCacheStale) {
    await refreshPullRequestDetails(env, repoFullName, prNumber).catch(
      () => undefined,
    );
  }
  const gate = await withReviewPipelineSpan(
    "selfhost.review.public_surface",
    {
      installationId,
      repoFullName,
      pullNumber: pr.number,
      operation: "public_surface",
    },
    () =>
      maybePublishPrPublicSurface(
        env,
        installationId,
        repoFullName,
        pr,
        repo,
        settings,
        advisory,
        otherOpenPullRequests,
        {
          deliveryId,
          baseSha: live?.base?.sha ?? null,
          liveFacts,
          ...(previewPollAttempt !== undefined ? { previewPollAttempt } : {}),
          ...(options.skipAiReview || autoreviewPaused ? { skipAiReview: true } : {}),
          ...(options.force ? { forceAiReview: true } : {}),
          hasPendingRefreshSignal: otherRefreshReasons || reviewsCacheStale,
        },
      ),
  ).catch((error) => {
    /* v8 ignore next -- retryable/rate-limit propagation is exercised by queue retry tests; this catch only preserves that contract. */
    if (isGitHubRateLimitedError(error) || isRetryableJobError(error)) throw error;
    console.error(
      JSON.stringify({
        level: "warn",
        event: "pr_public_surface_failed",
        deliveryId,
        repository: repoFullName,
        pullNumber: prNumber,
        error: errorMessage(error),
      }),
    );
    return undefined;
  });
  await withReviewPipelineSpan(
    "selfhost.review.maintenance",
    {
      installationId,
      repoFullName,
      pullNumber: pr.number,
      operation: "maintenance",
      decisionOutcome: gate?.conclusion,
    },
    () =>
      maybeRunAgentMaintenance(env, {
        installationId,
        repoFullName,
        repo,
        pr,
        settings,
        otherOpenPullRequests,
        deliveryId,
        gate,
        liveFacts,
      }),
  ).catch((error) => {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "agent_maintenance_failed",
        deliveryId,
        repository: repoFullName,
        pullNumber: prNumber,
        error: errorMessage(error),
      }),
    );
  });
}

/**
 * Operator per-PR review flow (rebase → wait for ALL CI → review once). Returns TRUE to review NOW, FALSE to
 * DEFER:
 *  - BEHIND base → issue update-branch; the resulting `synchronize` re-triggers on the rebased head.
 *  - CI still RUNNING (any non-bot check/status pending, regardless of whether it is branch-protection-required)
 *    → wait; the check_run/check_suite `completed` webhook re-triggers once CI settles (the sweep backstops a
 *    missed event). Once settled, only the gate disposition can block/close; readiness remains advisory.
 * Agent-OFF / draft / no-head PRs are never gated (reviewed as before). Fail-OPEN on a token/API hiccup (review
 * rather than stall a PR forever).
 */
async function prReadyForReview(
  env: Env,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  settings: RepositorySettings,
  deliveryId: string,
  // REST-budget dedup (#audit-rate-headroom): callers thread a request-local live-facts bag through readiness,
  // public rendering, and auto-maintain so one review/regate job only pays for each mutable GitHub read once.
  liveFacts: LiveGithubFacts,
): Promise<boolean> {
  // Only gate an OPEN, non-draft, agent-configured PR. A closed PR (the live path also runs on `closed` to
  // finalize / record reputation) must NOT be rebased or CI-waited — proceed so finalization runs.
  if (
    !isAgentConfigured(settings.autonomy) ||
    pr.isDraft ||
    !pr.headSha ||
    pr.state !== "open"
  )
    return true;
  const token =
    (await createInstallationToken(env, installationId).catch(
      () => undefined,
    )) ?? env.GITHUB_PUBLIC_TOKEN;
  if (!token) return true;
  const admissionKey = githubAdmissionKeyForToken(env, installationId, token);
  // 1) rebase if BEHIND base — the synchronize on the new head re-triggers this flow on the merged result. The
  // request-local facts may already be seeded from the sweep's resync payload, and the fallback live merge-state
  // fetch fails open internally (swallows its own fetch errors → undefined).
  const liveMergeState = await cachedLiveMergeState(env, repoFullName, liveFacts, pr.number, token, admissionKey);
  if (liveMergeState === "behind") {
    const autonomyLevel = resolveAutonomy(settings.autonomy, "update_branch");
    const installation = await getInstallation(env, installationId);
    const [outcome] = await executeAgentMaintenanceActions(
      env,
      {
        installationId,
        repoFullName,
        pullNumber: pr.number,
        headSha: pr.headSha,
        autonomy: settings.autonomy,
        agentPaused: settings.agentPaused,
        agentDryRun: settings.agentDryRun,
        agentGlobalFreezeOverride: settings.agentGlobalFreezeOverride,
        installationPermissions: installation?.permissions ?? null,
        authorLogin: pr.authorLogin,
      },
      [
        {
          actionClass: "update_branch",
          requiresApproval: autonomyRequiresApproval(autonomyLevel),
          reason: "behind base; update-branch before review",
          expectedHeadSha: pr.headSha,
        },
      ],
    );
    if (outcome?.outcome === "completed") {
      return false; // the rebase fires a synchronize → fresh review runs on the new head
    }
    // Not authorized, staged, dry-run, or failed (conflict/transient) → fall through and review without mutating.
  }
  // 2) wait for CI to finish before running the Gittensory review. Required contexts still define which failures
  // block/close, but hasPending tracks any visible non-bot CI that is not settled yet.
  const ci = await cachedLiveCiAggregate(env, repoFullName, liveFacts, pr.number, pr.headSha, pr.baseRef, token, settings.expectedCiContexts, admissionKey).catch(() => undefined);
  if (ci?.hasPending) {
    // Staleness cap: inferred or unreadable pending CI can otherwise defer FOREVER (orphaned required context,
    // transiently unreadable pages, fork check that never reports). Past the cap we stop deferring and let the
    // gate FINALIZE so the PR surfaces. A trusted required/base-repo visibly queued/in_progress CI signal is
    // active CI, though, so never cut in front of it. first-seen is tracked in the self-host Redis transient
    // cache per PR+headSha (a new push = a fresh window, and the SAME key anchors both cap classes so a pending
    // reason that changes class mid-window doesn't reset the clock); a cache miss degrades to the old defer.
    // (#ci-stuck-finalize)
    const deferCapMs = ci.hasMissingRequiredContext ? MISSING_REQUIRED_CONTEXT_DEFER_MS : STUCK_CI_DEFER_MS;
    if (
      ci.hasVisiblePending ||
      !(await ciPendingDeferStuck(env, repoFullName, pr.number, pr.headSha, deferCapMs))
    ) {
      await recordAuditEvent(env, {
        eventType: "github_app.review_deferred_ci_pending",
        actor: "gittensory",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "queued",
        detail: "CI still running — review deferred until all checks finish",
        metadata: { deliveryId, repoFullName },
      }).catch(() => undefined);
      return false;
    }
    if (ci.hasMissingRequiredContext) {
      await recordAuditEvent(env, {
        eventType: "github_app.review_deferred_ci_pending",
        actor: "gittensory",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "queued",
        detail:
          "Required CI context is still missing — review deferred instead of publishing a passing gate before expected CI reports",
        metadata: { deliveryId, repoFullName },
      }).catch(() => undefined);
      return false;
    }
    // #orb-ci-stuck-repeat: finalizing here runs a full paid AI review -- but a permanently-stuck CI context
    // (a fork check that will never report, an orphaned required context) never resolves, so every later
    // evaluation of the SAME head SHA hits this exact branch again and would re-spend another review for a
    // disposition already established. Confirmed live: 3 PRs whose CI never settled each burned 200-300+ full
    // reviews over 20+ hours this way, at a steady few-minute cadence, entirely independent of the sweep's own
    // outage-repair cap (#orb-retry-storm) since ordinary (non-priority) sweep candidacy still reaches this
    // function. Cap it at one finalize per head SHA (via a SHA-scoped audit event, no new table): once already
    // finalized for this exact SHA, defer again instead of paying for another review. A new commit changes the
    // head SHA, which resets the guard and lets the PR finalize fresh if it's still stuck.
    const guardTargetKey = `${repoFullName}#${pr.number}#${pr.headSha}`;
    const alreadyFinalizedForSha = await countRecentAuditEventsForActorAndTarget(
      env,
      "gittensory",
      CI_STUCK_FINALIZE_GUARD_EVENT_TYPE,
      guardTargetKey,
      new Date(Date.now() - CI_STUCK_FINALIZE_GUARD_LOOKBACK_MS).toISOString(),
    );
    if (alreadyFinalizedForSha >= CI_STUCK_FINALIZE_MAX_PER_SHA) {
      await recordAuditEvent(env, {
        eventType: "github_app.review_deferred_ci_pending",
        actor: "gittensory",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "queued",
        detail: "CI still stuck pending, but already finalized once for this head SHA — deferring again instead of re-spending a review",
        metadata: { deliveryId, repoFullName, headSha: pr.headSha },
      }).catch(() => undefined);
      // level:"error" is deliberate, not a code failure: this line only fires once the guard above already
      // stopped the wasteful re-review, so its OWN existence is the operator-visible signal (via the structured
      // log → Sentry forwarder, forwardStructuredLogToSentry) that a PR's CI has been permanently stuck long
      // enough to need a human — the same "surface an anomaly at error level" convention selfhost_ai_provider_
      // failed / selfhost_ai_providers_exhausted already use in src/selfhost/ai.ts.
      console.error(
        JSON.stringify({
          level: "error",
          event: "ci_stuck_review_repeat_suppressed",
          repo: repoFullName,
          pullNumber: pr.number,
          headSha: pr.headSha,
          deliveryId,
        }),
      );
      return false;
    }
    await recordAuditEvent(env, {
      eventType: "github_app.review_finalized_ci_stuck",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail:
        "CI stuck pending past the staleness cap — finalizing so the PR is surfaced, not silently deferred forever",
      metadata: { deliveryId, repoFullName },
    }).catch(() => undefined);
    await recordAuditEvent(env, {
      eventType: CI_STUCK_FINALIZE_GUARD_EVENT_TYPE,
      actor: "gittensory",
      targetKey: guardTargetKey,
      outcome: "completed",
      detail: "recorded so a repeat evaluation of the SAME head SHA does not pay for another review",
      metadata: { repoFullName, prNumber: pr.number, headSha: pr.headSha },
    }).catch(() => undefined);
    // fall through → return true → the gate finalizes + the PR is disposed/held, never silently stuck.
  }
  return true;
}

const CI_STUCK_FINALIZE_GUARD_EVENT_TYPE = "github_app.review_finalized_ci_stuck_guard";
const CI_STUCK_FINALIZE_MAX_PER_SHA = 1;
const CI_STUCK_FINALIZE_GUARD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// A required check pending longer than this is treated as STUCK (orphaned / never-completing — e.g. a fork check
// that will never report). Past it, prReadyForReview stops deferring and finalizes the gate so the PR surfaces
// (held / needs-human) instead of deferring forever. Generous so a genuinely-slow CI is never cut off early.
const STUCK_CI_DEFER_MS = 30 * 60 * 1000;

// A required branch-protection context that never appeared in any check-run/status page a fetch read to
// completion (#selfhost-ci-deferral-staleness) has no webhook to ever wait for — unlike genuinely active or
// merely unreadable/non-required pending CI, there is no forward signal this cap races against, so it can be
// much shorter than STUCK_CI_DEFER_MS: long enough to absorb GitHub's own event-ordering lag (a check-run for a
// DIFFERENT required context still arriving, or a just-pushed commit's check-runs not yet indexed) without
// stalling review for up to half an hour on a context that will structurally never post.
const MISSING_REQUIRED_CONTEXT_DEFER_MS = 2 * 60 * 1000;

async function getTransientKey(env: Env, key: string): Promise<string | null> {
  if (!env.SELFHOST_TRANSIENT_CACHE) return null;
  try {
    return await env.SELFHOST_TRANSIENT_CACHE.get(key);
  } catch {
    return null;
  }
}

async function putTransientKey(
  env: Env,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  if (!env.SELFHOST_TRANSIENT_CACHE) return;
  try {
    await env.SELFHOST_TRANSIENT_CACHE.set(key, value, ttlSeconds);
  } catch {
    // best-effort coalescing only
  }
}


/**
 * True when CI for this PR+headSha has been pending past `capMs`. Stamps the first-seen time in a transient
 * cache keyed by repo#pr:headSha — a new push is a new SHA, so the window resets per commit. The SAME key is
 * reused regardless of which cap the caller passes: if a PR's pending reason changes class between polls (e.g.
 * a non-required check pending at first look, then a missing-required-context on a later look), the first-seen
 * timestamp still anchors to when pending was FIRST observed for that head SHA — only the comparison threshold
 * varies by call (#selfhost-ci-deferral-staleness). A missing cache / cache hiccup degrades to `false` (never
 * force-finalize → keeps the safe old defer rather than acting early).
 */
async function ciPendingDeferStuck(
  env: Env,
  repoFullName: string,
  prNumber: number,
  headSha: string | null | undefined,
  capMs: number,
): Promise<boolean> {
  if (!headSha) return false;
  const key = `ci-pending-first-seen:${repoFullName.toLowerCase()}#${prNumber}:${headSha}`;
  try {
    const first = await getTransientKey(env, key);
    if (!first) {
      await putTransientKey(env, key, String(Date.now()), 7 * 24 * 3600);
      return false;
    }
    const firstMs = Number(first);
    return Number.isFinite(firstMs) && Date.now() - firstMs > capMs;
  } catch {
    return false;
  }
}

// #2552: bounded-retry cap for the force-fresh-rebase gate — without this, a fast-moving base could keep the
// freshness window perpetually "hot" and never let the PR clear to a real merge. Past the cap, the gate falls
// through to a normal merge decision (with an audit trail) rather than holding the PR hostage to base
// velocity. Deliberately keyed by PR NUMBER ONLY, NOT head SHA (gate review finding on the first version of
// this PR): a SUCCESSFUL forced update_branch itself produces a NEW head SHA, so a headSha-keyed counter would
// mint a fresh key — and reset to attempt 0 — on every single successful force, making the cap unreachable via
// the exact path it exists to bound. A 24h TTL on the stored counter still gives an eventual fresh start.
const MAX_FRESH_REBASE_FORCES = 3;
function freshRebaseForceCountKey(repoFullName: string, prNumber: number): string {
  return `fresh-rebase-forced:${repoFullName.toLowerCase()}#${prNumber}`;
}

/**
 * #2552: when the repo has opted into `gate.requireFreshRebaseWindow` and the base branch's live tip commit
 * landed within that window of NOW, force an `update_branch` (merges base into head, re-triggering CI on the
 * rebased result — the SAME action class/write-permission/dry-run/kill-switch stack `prReadyForReview`'s
 * BEHIND-branch path already uses, not a new one) immediately before what would otherwise be a merge, instead
 * of trusting a `mergeable_state: clean` read that predates the base's latest commit. Returns true when it
 * forced the rebase (the caller stops this pass — the resulting `synchronize` webhook re-triggers a fresh
 * evaluation on the new head); false when the freshness check doesn't apply, the cap was already reached, or
 * the forced action itself couldn't complete (not authorized / dry-run / transient failure) — in every false
 * case the caller falls through to the normal merge decision, so this gate fails open to today's behavior.
 */
async function maybeForceFreshRebase(
  env: Env,
  args: {
    installationId: number;
    repoFullName: string;
    pr: PullRequestRecord;
    settings: RepositorySettings;
    // Narrowed by the caller (typeof settings.requireFreshRebaseWindowMinutes === "number") -- re-deriving and
    // re-checking the same nullable field here would just be an unreachable duplicate of that guard.
    windowMinutes: number;
    baseRef: string;
    token: string | undefined;
    admissionKey: GitHubRateLimitAdmissionKey | undefined;
    deliveryId: string;
  },
): Promise<boolean> {
  const { installationId, repoFullName, pr, settings, windowMinutes, baseRef, token, admissionKey, deliveryId } = args;
  /* v8 ignore next -- structurally unreachable: the caller only invokes this after confirming
   * (liveMergeState ?? pr.mergeableState) === "clean", which GitHub can never compute for a PR with no
   * head commit; the null check is belt-and-suspenders against the field's optional TS type. */
  if (!pr.headSha) return false;
  const advancedAt = await fetchLiveBaseBranchAdvancedAt(env, repoFullName, baseRef, token, admissionKey);
  if (!advancedAt) return false; // fail-open: unreadable base commit -> no forced rebase
  const advancedAtMs = Date.parse(advancedAt);
  if (!Number.isFinite(advancedAtMs) || Date.now() - advancedAtMs >= windowMinutes * 60_000) return false;

  const countKey = freshRebaseForceCountKey(repoFullName, pr.number);
  const storedCount = Number(await getTransientKey(env, countKey));
  const attempt = Number.isFinite(storedCount) && storedCount > 0 ? storedCount : 0;
  if (attempt >= MAX_FRESH_REBASE_FORCES) {
    await recordAuditEvent(env, {
      eventType: "agent.action.fresh_rebase_window_cap_exceeded",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail: `base advanced within the ${windowMinutes}m freshness window, but the ${MAX_FRESH_REBASE_FORCES}-attempt forced-rebase cap was already reached for this PR — falling through to a normal merge decision`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, windowMinutes },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the caller's fallthrough */
      () => undefined,
    );
    return false;
  }

  const autonomyLevel = resolveAutonomy(settings.autonomy, "update_branch");
  const installation = await getInstallation(env, installationId);
  const [outcome] = await executeAgentMaintenanceActions(
    env,
    {
      installationId,
      repoFullName,
      pullNumber: pr.number,
      headSha: pr.headSha,
      autonomy: settings.autonomy,
      agentPaused: settings.agentPaused,
      agentDryRun: settings.agentDryRun,
      agentGlobalFreezeOverride: settings.agentGlobalFreezeOverride,
      /* v8 ignore next -- an installed-App PR webhook always carries an installation record; the null is defensive (mirrors runAgentMaintenancePlanAndExecute's own identical merge-time read). */
      installationPermissions: installation?.permissions ?? null,
      authorLogin: pr.authorLogin,
    },
    [
      {
        actionClass: "update_branch",
        requiresApproval: autonomyRequiresApproval(autonomyLevel),
        reason: `base branch advanced within the ${windowMinutes}m freshness window; forcing a fresh rebase + CI recheck before merge`,
        expectedHeadSha: pr.headSha,
      },
    ],
  );
  if (outcome?.outcome !== "completed") return false;
  const nextAttempt = attempt + 1;
  await putTransientKey(env, countKey, String(nextAttempt), 24 * 3600);
  await recordAuditEvent(env, {
    eventType: "agent.action.forced_rebase_freshness",
    actor: "gittensory",
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: "completed",
    detail: `forced update_branch (attempt ${nextAttempt}/${MAX_FRESH_REBASE_FORCES}) — base advanced within the ${windowMinutes}m freshness window`,
    metadata: { deliveryId, repoFullName, headSha: pr.headSha, windowMinutes, attempt: nextAttempt },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the caller */
    () => undefined,
  );
  return true;
}

// One CI run fires MANY check_run (one per job) + check_suite completions. Re-reviewing on every one storms the
// PR with duplicate reviews (and races the request_changes/approve dedup). reviewbot's CI_COALESCE_WINDOW parity:
// re-review a given PR at most once per this window. The re-review always re-fetches the LIVE CI, so the window
// only bounds FREQUENCY, never correctness — a later out-of-window completion + the hourly sweep + the merge-time
// re-check still catch the settled state.
const CI_COALESCE_WINDOW_SECONDS = 60;

// Visual preview self-poll (reviewbot PREVIEW_POLL_SECONDS parity): when a PR's preview deploy isn't live at
// review time, re-review after this delay to re-capture the AFTER shot, up to MAX_PREVIEW_POLLS times (so a
// never-resolving preview can't poll forever ~ 5×90s = 7.5min).
const PREVIEW_POLL_SECONDS = 90;
const MAX_PREVIEW_POLLS = 5;

/**
 * Coalesce CI-completion re-reviews: claims a per-PR window and returns true if this PR was already re-reviewed
 * within CI_COALESCE_WINDOW_SECONDS (caller skips). Self-host uses the transient Redis cache. A missing cache or
 * cache hiccup degrades to NO coalescing (returns false — never blocks a re-review, never throws).
 */
async function ciCompletionCoalesced(env: Env, key: string): Promise<boolean> {
  try {
    if (await getTransientKey(env, key)) return true; // already handled within the window → skip this event
    await putTransientKey(env, key, "1", CI_COALESCE_WINDOW_SECONDS); // claim the window
    return false;
  } catch {
    return false;
  }
}

async function ciReReviewCoalesced(
  env: Env,
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  return ciCompletionCoalesced(
    env,
    `ci-coalesce:${repoFullName.toLowerCase()}#${prNumber}`,
  );
}

// Issue-side wake coalescing (#2371): a DEDICATED key namespace, distinct from ciReReviewCoalesced's
// `ci-coalesce:` window. The two triggers are semantically different — CI-completion webhooks for the same run
// are interchangeable (whichever wins the race re-fetches the SAME already-settled CI state), but an issue-side
// label/assignment change is not: a completely unrelated CI re-review claiming the shared window would silently
// suppress a genuinely different issue-side signal, leaving the PR on stale linked-issue state until the window
// expires or the sweep eventually reaches it. Reusing ciReReviewCoalesced's key made that cross-domain collision
// possible; a separate namespace confines coalescing to a burst of same-PR issue-side events.
async function issueLinkedPrReReviewCoalesced(
  env: Env,
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  return ciCompletionCoalesced(
    env,
    `issue-link-coalesce:${repoFullName.toLowerCase()}#${prNumber}`,
  );
}

// Unlike CI-completion events, same-PR issue-side events are NOT interchangeable within the coalesce window: an
// add-then-remove label or assign-then-unassign sequence carries genuinely DIFFERENT states, so silently dropping
// every event after the first (as ciCompletionCoalesced's plain throttle does) can leave the PR on a stale
// verdict for up to the window's length. Schedule exactly ONE trailing agent-regate-pr re-review to run just
// after the window closes, guaranteeing the LATEST state is always eventually captured — deduped (its own
// window, same TTL) so a burst of N coalesced events schedules ONE trailing job, not N. Reuses the existing
// agent-regate-pr sweep-unit job (already rate-limit-aware and retried), not a new job type (#2371).
async function scheduleTrailingIssueLinkedReReview(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  prNumber: number,
  prCreatedAt?: string | null,
): Promise<void> {
  const key = `issue-link-trailing:${repoFullName.toLowerCase()}#${prNumber}`;
  // Check-then-claim, but the CLAIM only happens after the send actually succeeds (#2371 follow-up): claiming
  // eagerly (as ciCompletionCoalesced's own combined check-and-set does) would record "a trailing re-review is
  // scheduled" even when the enqueue itself throws, permanently swallowing the guarantee this function exists to
  // provide for the rest of the window — a later coalesced event would see the marker held and skip retrying,
  // even though nothing was actually queued.
  if (await getTransientKey(env, key)) return;
  try {
    await env.JOBS.send(
      {
        type: "agent-regate-pr",
        deliveryId,
        repoFullName,
        prNumber,
        installationId,
        ...(prCreatedAt ? { prCreatedAt } : {}),
      },
      { delaySeconds: CI_COALESCE_WINDOW_SECONDS },
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "issue_link_trailing_enqueue_failed",
        repoFullName,
        pull: prNumber,
        message: errorMessage(error).slice(0, 120),
      }),
    );
    return; // do NOT claim — a later coalesced event in this window should retry the enqueue
  }
  await putTransientKey(env, key, "1", CI_COALESCE_WINDOW_SECONDS);
}

/** Best-effort wake for sibling PRs discovered to be over the per-contributor cap by a LATER delivery (#2270,
 *  #2479 gate finding): webhook delivery order isn't guaranteed to match PR creation order, so a sibling's own
 *  webhook can fire before this one exists in the DB and wrongly conclude the author is within the cap — with
 *  nothing else to ever re-evaluate it, that verdict would otherwise stand forever. Reuses the existing
 *  agent-regate-pr sweep-unit job (already rate-limit-aware and retried) — the SAME "wake and fully
 *  re-evaluate" entry point the linked-issue-wake feature (#2259) uses for an identical class of problem, so
 *  the sibling gets its own live-head/CI-freshness re-check before anything acts on it, not a shortcut based
 *  on this delivery's now-possibly-stale snapshot. Coalesced per sibling PR (mirrors
 *  scheduleTrailingIssueLinkedReReview's check-then-claim-after-success shape) so a burst of N over-cap
 *  siblings each discovering the same others doesn't fan out into an O(N^2) job storm. */
async function wakeOverCapSiblingPullRequests(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  siblingPrNumbers: number[],
): Promise<void> {
  await Promise.all(
    siblingPrNumbers.map(async (prNumber) => {
      const key = `contributor-cap-wake:${repoFullName.toLowerCase()}#${prNumber}`;
      if (await getTransientKey(env, key)) return;
      try {
        await env.JOBS.send({
          type: "agent-regate-pr",
          deliveryId,
          repoFullName,
          prNumber,
          installationId,
        });
      } catch (error) {
        console.log(
          JSON.stringify({
            event: "contributor_cap_wake_enqueue_failed",
            repoFullName,
            pull: prNumber,
            message: errorMessage(error).slice(0, 120),
          }),
        );
        return; // do NOT claim — a later discovery should retry the enqueue
      }
      await putTransientKey(env, key, "1", CI_COALESCE_WINDOW_SECONDS);
    }),
  );
}

async function ciHeadShaResolutionCoalesced(
  env: Env,
  repoFullName: string,
  headSha: string,
): Promise<boolean> {
  return ciCompletionCoalesced(
    env,
    `ci-head-sha-resolve:${repoFullName.toLowerCase()}@${headSha.toLowerCase()}`,
  );
}


// Per-(repo, PR, head SHA) advisory lock around runAiReviewForAdvisory's expensive grounding/RAG/enrichment/LLM
// section (#confirmed-bug: a webhook pass and an agent-regate-pr sweep pass can independently reach this same
// code for the SAME PR at the SAME head SHA, both miss the cache, and both fire a real LLM call — which can
// return DIFFERENT verdicts). The TTL is a crash-safety backstop only (see AI_REVIEW_LOCK_TTL_SECONDS below), not
// a throughput bound — same philosophy as PR_ACTUATION_LOCK_TTL_SECONDS (#2129/#2368). Deliberately its OWN lock
// namespace, not the shared pr-actuation-lock above: this guards an expensive read-and-cache (dedup a redundant
// LLM call for the identical head+mode), not a GitHub-mutating actuation, so it has different scoping (keyed by
// head SHA + mode, not just PR) and a much longer TTL (an LLM call legitimately runs far longer than a close).
const AI_REVIEW_LOCK_TTL_SECONDS = 1_800; // 30 minutes — see justification below.

// #regate-churn: how long a non-durably-cacheable AI review outcome may be reused by a scheduled re-gate at the
// IDENTICAL head+fingerprint+mode before a fresh LLM call is paid for again. Covers TWO distinct non-cacheable
// sources, both of which used to have NO retry bound at all: (1) a genuine non-cacheable verdict (consensus
// defect / inconclusive / lock-contention placeholder) that the durable cache (see #1 above) correctly never
// stores as a reusable result, and (2) a dynamic-context repo (grounding/RAG/enrichment/reputation), which
// previously bypassed the cache unconditionally on every single call. Root-caused in production: a single PR
// with RAG enabled generated 259 of 281 AI review calls in 24h via (2) at an UNCHANGED head, plus another 24 via
// (1) — 281 calls total, ~1 every 5 minutes, forever, with nothing ever throttling the retry. This bounds that
// retry cadence without ever treating either outcome as a durable, indefinitely-trustworthy result — it still
// expires and retries periodically (the LLM's own non-determinism may resolve a dispute; dynamic external
// context may genuinely have drifted), and any REAL state change (a new head, a changed review-input
// fingerprint) bypasses this bound immediately regardless of age. Matches AI_REVIEW_LOCK_TTL_SECONDS's
// 30-minute order of magnitude — same "crash/dispute backstop, not a throughput bound" philosophy.
const AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

function aiReviewLockKey(repoFullName: string, prNumber: number, headSha: string, mode: string): string {
  return `ai-review-lock:${repoFullName.toLowerCase()}#${prNumber}@${headSha.toLowerCase()}:${mode}`;
}

/**
 * Claim the per-(repo, PR, head SHA, mode) advisory lock before the expensive grounding/RAG/enrichment/LLM
 * section of runAiReviewForAdvisory. Returns false when another pass already holds it for this exact head (the
 * caller must treat this as "another pass is already reviewing this head" and return the inconclusive-hold shape
 * below — the next webhook/sweep tick, or the pass that IS running, is the backstop that populates the cache).
 * A missing cache or cache hiccup fails OPEN (returns true — the lock is defense-in-depth, never the primary
 * safety gate, and must never itself block a real review from running).
 */
export async function claimAiReviewLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  mode: string,
): Promise<TransientLockClaim> {
  return claimTransientLock(
    env,
    aiReviewLockKey(repoFullName, prNumber, headSha, mode),
    AI_REVIEW_LOCK_TTL_SECONDS,
  );
}

/** Best-effort release, called from a finally block so the lock frees promptly instead of waiting out the TTL. */
export async function releaseAiReviewLock(
  env: Env,
  repoFullName: string,
  prNumber: number,
  headSha: string,
  mode: string,
  ownerToken: string | null,
): Promise<void> {
  await releaseTransientLockIfOwner(env, aiReviewLockKey(repoFullName, prNumber, headSha, mode), ownerToken);
}

/**
 * The inconclusive-hold shape a pass returns when it lost the {@link claimAiReviewLock} race (#regate-dup-prep):
 * another pass already owns this exact (repo, PR, head, mode) lock, so THIS pass defers entirely rather than
 * racing it. Shared by both lock-claim sites that guard runAiReviewForAdvisory's expensive section — the
 * caller-side claim in maybePublishPrPublicSurface (wraps the cache-read decision itself, so a loser never even
 * reaches the cache-miss log) and runAiReviewForAdvisory's own claim (the historical, narrower placement, kept for
 * any other/direct caller) — so both produce byte-identical advisory findings and gate disposition instead of two
 * hand-written "another pass is running" messages drifting apart over time. `persistable: false` (not merely
 * `cacheable: false`): the concurrent pass this call deferred to persists the REAL result within seconds, so this
 * placeholder must never be written even non-durably — a later read within the non-cacheable retry cooldown could
 * otherwise replay a stale "another pass is running" long after that pass finished.
 */
function aiReviewLockContendedResult(
  advisory: Pick<Awaited<ReturnType<typeof buildPullRequestAdvisory>>, "findings">,
): Awaited<ReturnType<typeof runAiReviewForAdvisory>> {
  const findings: AdvisoryFinding[] = [
    {
      code: "ai_review_inconclusive",
      severity: "warning",
      title: "AI review already in progress for this PR head",
      detail: "Another Gittensory pass is already running the AI review for this exact PR head. This pass is skipping to avoid a duplicate LLM call.",
      action: "The gate is held for a human reviewer rather than passed automatically; it re-evaluates once the in-flight review completes or on the next update.",
    },
  ];
  advisory.findings.push(...findings);
  return {
    notes: "AI review is already running for this PR head in another Gittensory pass. Gittensory is holding this PR for manual review until that pass completes.",
    reviewerCount: 0,
    inlineFindings: [],
    findings,
    cacheable: false,
    persistable: false,
  };
}

/** Read the CI head SHA off a `check_suite`/`check_run` `completed` payload (the event node carries `head_sha`;
 *  `check_run` also nests it under `check_suite.head_sha`). Returns "" when absent. The payload type doesn't model
 *  these events, so we narrow off `Record<string, unknown>` the same way the `pull_requests[]` read does. */
export function ciCompletionHeadSha(
  eventName: string,
  payload: GitHubWebhookPayload,
): string {
  const node = (payload as Record<string, unknown>)[eventName] as
    | {
        head_sha?: string | null;
        check_suite?: { head_sha?: string | null } | null;
      }
    | undefined;
  return (node?.head_sha ?? node?.check_suite?.head_sha ?? "").trim();
}

/**
 * Resolve the OPEN PR number(s) a CI-completion event applies to. SAME-REPO PRs carry them in
 * `payload[event].pull_requests[]` (reviewbot core/scope.ts parity) — that path is authoritative and tried FIRST.
 * FORK (cross-repo) PRs get an EMPTY `pull_requests[]` from GitHub, so when that's empty we fall back to resolving
 * by the CI head SHA: a fast STORED-DB lookup first (open `pull_requests` rows whose `headSha` matches), then the
 * live GitHub `GET /commits/{sha}/pulls` (works for forks). Returns `{ numbers, viaHeadShaFallback }` so the caller
 * can audit the fork-resume path. Fully FAIL-OPEN: any lookup error degrades to whatever was found so far / [].
 */
export async function resolveCiCompletionPrNumbers(
  env: Env,
  installationId: number,
  repoFullName: string,
  populatedPrNumbers: number[],
  headSha: string,
): Promise<{ numbers: number[]; viaHeadShaFallback: boolean }> {
  if (populatedPrNumbers.length > 0)
    return { numbers: populatedPrNumbers, viaHeadShaFallback: false };
  if (!headSha) return { numbers: [], viaHeadShaFallback: false };
  const resolved = new Set<number>();
  // 1) Fast path: a stored open PR row whose head SHA matches the completed CI (no GitHub round-trip).
  try {
    const open = await listOpenPullRequests(env, repoFullName);
    for (const pr of open) if (pr.headSha === headSha) resolved.add(pr.number);
  } catch {
    // fail-open: fall through to the live API
  }
  // 2) Fork fallback: GitHub's commit→PRs association, the only resolution that works for cross-repo PRs.
  if (resolved.size === 0) {
    const token =
      (await createInstallationToken(env, installationId).catch(
        () => undefined,
      )) ?? env.GITHUB_PUBLIC_TOKEN;
    if (token) {
      const admissionKey = githubAdmissionKeyForToken(env, installationId, token);
      const apiNumbers = await fetchOpenPullRequestNumbersForCommit(
        env,
        repoFullName,
        headSha,
        token,
        admissionKey,
      ).catch(() => []);
      for (const number of apiNumbers) resolved.add(number);
    }
  }
  return { numbers: [...resolved], viaHeadShaFallback: resolved.size > 0 };
}

/**
 * THE auto-merge / close-on-red TRIGGER. A `check_run`/`check_suite` `completed` event means a PR's CI just
 * settled — re-review the associated PR(s) so the now-green PR is merged and the now-red PR is closed (non-owner)
 * / held (owner). Without this, a PR reviewed at open-time (CI still pending → deferred) is never re-evaluated.
 * SAME-REPO PRs are resolved from `payload[event].pull_requests[]` (reviewbot core/scope.ts parity). FORK PRs get
 * an EMPTY `pull_requests[]` from GitHub, so they're resolved by the CI head SHA (stored DB → live commits/pulls)
 * — without this fork PRs deferred at open-time never get their required gate posted and are BLOCKED forever.
 * COALESCED so one CI run's ~20 completions collapse to one re-review. Returns true (handled).
 */
async function maybeReReviewOnCiCompletion(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  if (eventName !== "check_run" && eventName !== "check_suite") return false;
  if (payload.action !== "completed") return false;
  const repoFullName = payload.repository?.full_name;
  const installationId = getInstallationId(payload);
  if (!repoFullName || !installationId) return false;
  if (isSelfAuthoredCiCompletionWebhook(env, eventName, payload)) {
    await recordWebhookEvent(env, {
      deliveryId,
      eventName,
      action: payload.action,
      installationId,
      repositoryFullName: repoFullName,
      payloadHash: "processed",
      status: "processed",
    });
    return true;
  }
  const node = (payload as Record<string, unknown>)[eventName] as
    | { pull_requests?: Array<{ number?: number | null }> }
    | undefined;
  const populatedPrNumbers = [
    ...new Set(
      (node?.pull_requests ?? [])
        .map((entry) => entry?.number)
        .filter((value): value is number => typeof value === "number"),
    ),
  ];
  const headSha = ciCompletionHeadSha(eventName, payload);
  if (isConvergenceRepoAllowed(env, repoFullName)) {
    // GitHub can emit many empty-pull_requests CI completions for the same fork head SHA. Claim a head-SHA
    // window before the fallback resolver so duplicate events do not repeat DB scans or commits/{sha}/pulls calls.
    if (
      populatedPrNumbers.length === 0 &&
      headSha &&
      (await ciHeadShaResolutionCoalesced(env, repoFullName, headSha))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId,
        repositoryFullName: repoFullName,
        payloadHash: "processed",
        status: "processed",
      });
      return true;
    }
    const { numbers: prNumbers, viaHeadShaFallback } =
      await resolveCiCompletionPrNumbers(
        env,
        installationId,
        repoFullName,
        populatedPrNumbers,
        headSha,
      ).catch(() => ({
        numbers: populatedPrNumbers,
        viaHeadShaFallback: false,
      }));
    if (viaHeadShaFallback && prNumbers.length > 0) {
      await recordAuditEvent(env, {
        eventType: "github_app.ci_completion_fork_resume",
        actor: "gittensory",
        targetKey: `${repoFullName}#${prNumbers.join(",")}`,
        outcome: "queued",
        detail:
          "resumed fork PR via head-SHA fallback (empty check pull_requests[])",
        metadata: { deliveryId, repoFullName, eventName, prNumbers },
      }).catch(() => undefined);
    }
    for (const prNumber of prNumbers) {
      // #selfhost-ci-verification: invalidate the durable CI-state cache for EVERY resolved PR, regardless of
      // whether the re-review below actually fires -- some OTHER reader (a readiness check or disposition-
      // planner pass already in flight) may consult the cache in the near future and must not see a stale
      // pre-completion snapshot. Best-effort, matches every other cache-invalidation call site's fail-open
      // contract; ordered BEFORE reReviewStoredPullRequest so that pass's own refreshLiveCiAggregate read (which
      // now also consults this durable cache on a request-scoped memo miss) sees a genuine miss and re-fetches
      // live, preserving refreshLiveCiAggregate's existing "always fresh" contract for this triggering PR.
      await invalidateCiStateCache(env, repoFullName, prNumber).catch(() => undefined);
      // Coalesce the CI-completion storm: skip if this PR was re-reviewed within the window.
      if (await ciReReviewCoalesced(env, repoFullName, prNumber)) continue;
      await reReviewStoredPullRequest(
        env,
        deliveryId,
        installationId,
        repoFullName,
        prNumber,
      );
    }
  }
  await recordWebhookEvent(env, {
    deliveryId,
    eventName,
    action: payload.action,
    installationId,
    repositoryFullName: repoFullName,
    payloadHash: "processed",
    status: "processed",
  });
  return true;
}

/**
 * Invalidate the durable CI-state cache on a legacy `status`/`workflow_run` event (#selfhost-ci-verification gate
 * review finding). These two event types are NOT wired to re-review triggering (see maybeReReviewOnCiCompletion's
 * own doc comment) -- that stays out of scope here -- but leaving the cache itself untouched meant a real legacy
 * status/workflow_run transition could leave prReadyForReview reading a stale, pre-transition CI aggregate for up
 * to the full cache TTL. Deliberately narrower than maybeReReviewOnCiCompletion: only resolves PR numbers via the
 * fast stored-DB head-SHA lookup (no live GitHub fork-fallback call) -- a cache entry only exists for a PR this
 * process already tracks, so there is nothing to invalidate for an untracked/fork PR the DB lookup misses.
 */
async function maybeInvalidateCiCacheOnLegacyCiEvent(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  if (eventName !== "status" && eventName !== "workflow_run") return false;
  const repoFullName = payload.repository?.full_name;
  const installationId = getInstallationId(payload);
  if (!repoFullName || !installationId) return false;
  // `status`'s state settles the same event this-transition-matters signal that `action: "completed"` gives
  // check_run/check_suite/workflow_run -- "pending" is an in-flight update, not a settled result worth
  // invalidating over. workflow_run DOES carry `action`, exactly like check_run/check_suite.
  const settled =
    eventName === "status"
      ? (payload as unknown as { state?: string }).state !== "pending"
      : (payload as unknown as { action?: string }).action === "completed";
  if (settled && isConvergenceRepoAllowed(env, repoFullName)) {
    const headSha = (
      eventName === "status"
        ? ((payload as unknown as { sha?: string }).sha ?? "")
        : ((payload as unknown as { workflow_run?: { head_sha?: string } }).workflow_run?.head_sha ?? "")
    ).trim();
    if (headSha) {
      const open = await listOpenPullRequests(env, repoFullName).catch(() => []);
      for (const pr of open) {
        if (pr.headSha !== headSha) continue;
        await invalidateCiStateCache(env, repoFullName, pr.number).catch(() => undefined);
      }
    }
  }
  await recordWebhookEvent(env, {
    deliveryId,
    eventName,
    action: payload.action,
    installationId,
    repositoryFullName: repoFullName,
    payloadHash: "processed",
    status: "processed",
  });
  return true;
}

/**
 * Wake linked PRs on an issue-side signal (#2259). Labeling/unlabeling (e.g. maintainer-only) or
 * assigning/unassigning on a linked ISSUE can flip a linked-issue hard-rule verdict, but that only gets
 * re-evaluated when the PR ITSELF receives a webhook or the staleness-ordered sweep eventually reaches it —
 * which can lag for many cycles on a repo with more than a few open PRs. Enqueue a bounded, staggered batch of
 * per-PR re-gate jobs instead of doing the expensive live re-review inline.
 * Uses its OWN coalesce window (issueLinkedPrReReviewCoalesced,
 * DISTINCT from CI-completion's — #2371): the two triggers are not interchangeable, so a shared window let an
 * unrelated CI re-review silently suppress a genuinely different issue-side signal. Within the issue-side
 * window itself, same-PR events are ALSO not interchangeable (an add-then-remove or assign-then-unassign
 * sequence carries genuinely different states), so a coalesced event schedules a trailing re-review
 * (scheduleTrailingIssueLinkedReReview) instead of silently dropping the state it represents.
 */
async function maybeReReviewOnLinkedIssueChange(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  if (eventName !== "issues") return false;
  if (
    payload.action !== "labeled" &&
    payload.action !== "unlabeled" &&
    payload.action !== "assigned" &&
    payload.action !== "unassigned"
  )
    return false;
  const repoFullName = payload.repository?.full_name;
  const installationId = getInstallationId(payload);
  const issueNumber = payload.issue?.number;
  if (!repoFullName || !installationId || !issueNumber) return false;
  if (isConvergenceRepoAllowed(env, repoFullName)) {
    const openPullRequests = await listOpenPullRequests(env, repoFullName);
    // Issue-side label/assignment changes can flip linked-issue hard-rule verdicts from mergeable to close.
    // Wake affected PRs promptly: the issue-side signal can invalidate public gate state, so dropping every
    // linked PR past a tiny cap would leave stale passing checks until the regular sweep eventually reaches
    // it. But this must still be BOUNDED -- a popular/tracking issue linked from hundreds of PRs cannot be
    // allowed to enqueue hundreds of ~9-REST-GET re-gates from one webhook, which is exactly the budget
    // exhaustion SWEEP_MAX_PRS exists to prevent for the periodic sweep. ISSUE_WAKE_MAX_PRS is a separate,
    // larger one-shot budget (see its own comment) since this handler fires once per event, not every ~2 min.
    // Keep the actual re-gates asynchronous and staggered so the webhook does not perform expensive live reviews.
    const linkingPrs = openPullRequests
      .filter((pr) => pr.linkedIssues.includes(issueNumber))
      .slice(0, ISSUE_WAKE_MAX_PRS)
      .map((pr) => ({ number: pr.number, createdAt: pr.createdAt ?? null }));
    for (const [index, pr] of linkingPrs.entries()) {
      const prNumber = pr.number;
      if (await issueLinkedPrReReviewCoalesced(env, repoFullName, prNumber)) {
        await scheduleTrailingIssueLinkedReReview(
          env,
          deliveryId,
          installationId,
          repoFullName,
          prNumber,
          pr.createdAt,
        );
        continue;
      }
      const job: JobMessage = {
        type: "agent-regate-pr",
        deliveryId,
        repoFullName,
        prNumber,
        installationId,
        ...(pr.createdAt ? { prCreatedAt: pr.createdAt } : {}),
      };
      const delaySeconds = Math.min(index * 10, 600);
      await (delaySeconds > 0
        ? env.JOBS.send(job, { delaySeconds })
        : env.JOBS.send(job));
    }
  }
  await recordWebhookEvent(env, {
    deliveryId,
    eventName,
    action: payload.action,
    installationId,
    repositoryFullName: repoFullName,
    payloadHash: "processed",
    status: "processed",
  });
  return true;
}

/**
 * deployment_status (success/failure) → re-review the associated PR so the before/after visual capture fills the
 * "after" cell once the preview deploy finishes (or flips to a deploy-failed note). Mirrors reviewbot's
 * deployment_status routing; the capture itself runs inside the re-published review (visual-capture path).
 */
async function maybeCaptureOnDeploymentStatus(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  if (eventName !== "deployment_status") return false;
  const repoFullName = payload.repository?.full_name;
  const installationId = getInstallationId(payload);
  if (!repoFullName || !installationId) return false;
  const preview = deploymentStatusToPreview(
    payload as unknown as DeploymentStatusPayload,
  );
  // The deployment-status re-review just refreshes the visual capture; the capture site itself honors the per-repo
  // `features.screenshots` override, so this trigger stays on the convergence allowlist (a re-review for a repo
  // with screenshots disabled simply produces no capture — same outcome, no incoherence).
  if (preview && isConvergenceRepoAllowed(env, repoFullName)) {
    await reReviewStoredPullRequest(
      env,
      deliveryId,
      installationId,
      repoFullName,
      preview.prNumber,
    );
  }
  await recordWebhookEvent(env, {
    deliveryId,
    eventName,
    action: payload.action,
    installationId,
    repositoryFullName: repoFullName,
    payloadHash: "processed",
    status: "processed",
  });
  return true;
}

/**
 * Store the captured PNGs from a completed actions_fallback run into R2 under buildCapture's own lookup keys
 * (#4112) — resolveVisualRoutes MUST be recomputed the exact same way buildCapture derives it, since the run
 * carries only filenames (viewport-tagged, per fallbackShotFileName), not the original route paths. Fail-safe
 * throughout: any missing token/config/route match just skips that shot (or all of them), never throws.
 */
async function storeVisualCaptureFallbackShots(
  env: Env,
  repoFullName: string,
  installationId: number,
  runId: number,
  prNumber: number,
  headSha: string,
  rateLimitAdmissionKey: GitHubRateLimitAdmissionKey,
): Promise<void> {
  if (!env.REVIEW_AUDIT) return;
  const token = await createInstallationToken(env, installationId).catch(() => undefined);
  if (!token) return;
  const shots = await fetchFallbackArtifactShots({ token, repo: parseRepo(repoFullName), runId, rateLimitAdmissionKey });
  if (shots.length === 0) return;
  const byFileName = new Map(shots.map((shot) => [shot.fileName, shot.png]));

  // Recompute the SAME route list buildCapture would derive for this PR right now — the artifact carries only
  // viewport-tagged filenames (fallbackShotFileName), not the original route paths, so both sides must agree
  // independently on which routes those filenames correspond to.
  const [visualConfig, storedFiles] = await Promise.all([
    resolveVisualCaptureConfig(env, repoFullName),
    listPullRequestFiles(env, repoFullName, prNumber),
  ]);
  const visualFiles = storedFiles.map((file) => file.path).filter(isVisualPath);
  for (const path of resolveVisualRoutes(visualFiles, visualConfig.routes)) {
    for (const viewportName of ["desktop", "mobile"] as const) {
      const png = byFileName.get(fallbackShotFileName(path, viewportName));
      if (!png) continue;
      const key = await fallbackShotR2Key(headSha, path, viewportName);
      await env.REVIEW_AUDIT.put(key, png, { httpMetadata: { contentType: "image/png" } }).catch(() => undefined);
    }
  }
}

/**
 * workflow_run (completed) from THIS module's own .github/workflows/visual-capture-fallback.yml (#4112) →
 * store its captured PNGs in R2, then re-review so a fresh buildCapture pass picks them up as the "after"
 * shot. The run carries no natural PR link (it's workflow_dispatch, not pull_request) — parseFallbackRunCorrelation
 * recovers {prNumber, headSha} from the run's own display_title, which dispatchVisualCaptureFallback set via
 * the workflow's `run-name:`. Gated on the run's OWN name + trigger type so an unrelated workflow_run (this
 * repo's ui-preview.yml, a target repo's other CI, etc.) is never mistaken for this fallback's completion.
 */
async function maybeCaptureOnActionsFallbackWorkflowRun(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  if (eventName !== "workflow_run") return false;
  const repoFullName = payload.repository?.full_name;
  const installationId = getInstallationId(payload);
  if (!repoFullName || !installationId) return false;
  const run = (
    payload as unknown as {
      workflow_run?: { id?: number; name?: string; event?: string; conclusion?: string; display_title?: string };
    }
  ).workflow_run;
  if (run?.name !== FALLBACK_WORKFLOW_NAME || run?.event !== "workflow_dispatch") return false;
  if (payload.action !== "completed") return false;

  const correlation = parseFallbackRunCorrelation(run.display_title);
  if (correlation) {
    // The run has settled -- success, failure, cancelled, or timed_out all mean "no longer in flight," so
    // clear the dispatch marker regardless of conclusion (#4112 review fix). Otherwise a genuinely failed run
    // would leave the marker in place for the rest of FALLBACK_DISPATCH_MARKER_MAX_AGE_MS, blocking a retry
    // that could otherwise succeed immediately.
    await clearFallbackDispatchMarker(env, correlation.headSha);
  }
  if (run.conclusion === "success" && run.id && correlation && isConvergenceRepoAllowed(env, repoFullName)) {
    const admissionKey = githubRateLimitAdmissionKeyForInstallation(installationId);
    await storeVisualCaptureFallbackShots(env, repoFullName, installationId, run.id, correlation.prNumber, correlation.headSha, admissionKey);
    await reReviewStoredPullRequest(env, deliveryId, installationId, repoFullName, correlation.prNumber);
  }
  await recordWebhookEvent(env, {
    deliveryId,
    eventName,
    action: payload.action,
    installationId,
    repositoryFullName: repoFullName,
    payloadHash: "processed",
    status: "processed",
  });
  return true;
}

async function repairDataFidelity(
  env: Env,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  const [repositories, segments, signalSnapshots] = await Promise.all([
    listRepositories(env),
    listRepoSyncSegments(env),
    listLatestSignalSnapshotsByTarget(env),
  ]);
  const requiredSegments = new Set([
    "labels",
    "open_issues",
    "open_pull_requests",
  ]);
  const segmentsByRepo = new Map<string, Set<string>>();
  for (const segment of segments) {
    if (
      requiredSegments.has(segment.segment) &&
      segment.status === "complete"
    ) {
      const complete =
        segmentsByRepo.get(segment.repoFullName) ?? new Set<string>();
      complete.add(segment.segment);
      segmentsByRepo.set(segment.repoFullName, complete);
    }
  }
  const registeredRepos = repositories.filter((repo) => repo.isRegistered);
  const freshnessSlo = buildFreshnessSloReport({
    repoCount: registeredRepos.length,
    segments,
    signalSnapshots,
  });
  const repairs = [];
  const signalRefreshes = [];
  for (const repo of registeredRepos) {
    const complete = segmentsByRepo.get(repo.fullName) ?? new Set<string>();
    const missing = [...requiredSegments].filter(
      (segment) => !complete.has(segment),
    );
    if (missing.length > 0) {
      repairs.push({ repoFullName: repo.fullName, missing });
      continue;
    }
    signalRefreshes.push(repo.fullName);
  }
  await Promise.all([
    ...repairs.map((repair, index) => {
      const message: JobMessage = {
        type: "backfill-registered-repos",
        requestedBy,
        repoFullName: repair.repoFullName,
        mode: "resume",
      };
      const delaySeconds = Math.min(index * 30, 900);
      return delaySeconds > 0
        ? env.JOBS.send(message, { delaySeconds })
        : env.JOBS.send(message);
    }),
    ...signalRefreshes.slice(0, 50).map((repoFullName, index) => {
      const message: JobMessage = {
        type: "generate-signal-snapshots",
        requestedBy,
        repoFullName,
      };
      const delaySeconds =
        repairs.length > 0 || index > 0 ? Math.min(60 + index * 10, 900) : 0;
      return delaySeconds > 0
        ? env.JOBS.send(message, { delaySeconds })
        : env.JOBS.send(message);
    }),
  ]);
  await recordAuditEvent(env, {
    eventType: "sync.fidelity_repair",
    outcome:
      repairs.length > 0 || freshnessSlo.repairRecommended
        ? "queued"
        : "completed",
    metadata: {
      requestedBy,
      repairCount: repairs.length,
      signalRefreshCount: signalRefreshes.length,
      repairs: repairs.slice(0, 25),
      freshnessSlo: freshnessAuditMetadata(freshnessSlo),
    },
  });
  await recordAuditEvent(env, {
    eventType: "signals.freshness_slo",
    outcome: freshnessSlo.repairRecommended ? "queued" : "completed",
    detail: freshnessSlo.status,
    metadata: { requestedBy, ...freshnessAuditMetadata(freshnessSlo) },
  });
}

async function discoverContributorLogins(env: Env): Promise<string[]> {
  const [pullRequests, issues] = await Promise.all([
    listAllPullRequests(env),
    listAllIssues(env),
  ]);
  return [
    ...new Set(
      [...pullRequests, ...issues].flatMap((record) =>
        record.authorLogin ? [record.authorLogin] : [],
      ),
    ),
  ].slice(0, 200);
}

const CONTRIBUTOR_EVIDENCE_MAX_PR_FILE_PATHS = 2000;
const CONTRIBUTOR_EVIDENCE_PR_FILE_PATHS_PER_REPO = 200;

async function loadContributorPullRequestFilePaths(
  env: Env,
  args: {
    login: string;
    profile: ContributorProfile;
    pullRequests: PullRequestRecord[];
    issues: IssueRecord[];
    repoStats: ContributorRepoStatRecord[];
    repositories: RepositoryRecord[];
  },
): Promise<PullRequestFilePathRecord[]> {
  const pullNumbersByRepo = new Map<string, Set<number>>();
  for (const pr of args.pullRequests) {
    if (pr.authorLogin?.toLowerCase() !== args.login.toLowerCase()) continue;
    const key = pr.repoFullName.toLowerCase();
    const current = pullNumbersByRepo.get(key) ?? new Set<number>();
    current.add(pr.number);
    pullNumbersByRepo.set(key, current);
  }
  const files: PullRequestFilePathRecord[] = [];
  for (const repoFullName of evidenceGraphTouchedRepoFullNames(args)) {
    if (files.length >= CONTRIBUTOR_EVIDENCE_MAX_PR_FILE_PATHS) break;
    const remaining = CONTRIBUTOR_EVIDENCE_MAX_PR_FILE_PATHS - files.length;
    const repoFiles = await listRepoPullRequestFilePaths(env, repoFullName, {
      pullNumbers: [
        ...(pullNumbersByRepo.get(repoFullName.toLowerCase()) ?? []),
      ],
      limit: Math.min(CONTRIBUTOR_EVIDENCE_PR_FILE_PATHS_PER_REPO, remaining),
    });
    files.push(...repoFiles);
  }
  return files;
}

const CONTRIBUTOR_EVIDENCE_LOGIN_CAP = 500;
const DEFAULT_CONTRIBUTOR_EVIDENCE_BATCH_SIZE = 150;

// Max logins processed per build-contributor-evidence job before the scheduled trigger fans out into per-batch jobs.
// 0 disables the fan-out (single job). Read from process.env so it works on cloud + self-host without a binding.
export function contributorEvidenceBatchSize(): number {
  const raw = Number(process.env.CONTRIBUTOR_EVIDENCE_BATCH_SIZE ?? String(DEFAULT_CONTRIBUTOR_EVIDENCE_BATCH_SIZE));
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_CONTRIBUTOR_EVIDENCE_BATCH_SIZE;
}

async function buildContributorEvidence(
  env: Env,
  login?: string,
  batchLogins?: string[],
): Promise<void> {
  // A single login or a fanned-out batch → process exactly those (no derivation).
  const explicitLogins = batchLogins?.length ? batchLogins : login ? [login] : null;
  if (explicitLogins) {
    await processContributorEvidenceLogins(env, explicitLogins);
    return;
  }
  // Scheduled trigger: derive the full contributor set from stored PRs + issues.
  const [allPullRequests, allIssues] = await Promise.all([
    listAllPullRequests(env),
    listAllIssues(env),
  ]);
  const derivedLogins = [
    ...new Set(
      [...allPullRequests, ...allIssues].flatMap((record) =>
        record.authorLogin ? [record.authorLogin] : [],
      ),
    ),
  ].slice(0, CONTRIBUTOR_EVIDENCE_LOGIN_CAP);
  const batchSize = contributorEvidenceBatchSize();
  // Fan out into per-batch jobs so the per-login GitHub reads (/users/{login} + its repos pages) spread across the
  // queue's paced execution + rate-limit admission instead of bursting for every contributor in one job. Stays one
  // job when the set fits a batch or the fan-out is disabled (CONTRIBUTOR_EVIDENCE_BATCH_SIZE=0).
  if (batchSize > 0 && derivedLogins.length > batchSize) {
    const batches: string[][] = [];
    for (let i = 0; i < derivedLogins.length; i += batchSize) {
      batches.push(derivedLogins.slice(i, i + batchSize));
    }
    await Promise.all(
      batches.map((batch, index) => {
        const message: JobMessage = { type: "build-contributor-evidence", requestedBy: "schedule", logins: batch };
        const delaySeconds = Math.min(index * 15, 600);
        return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
      }),
    );
    return;
  }
  // Small enough (or fan-out disabled): process inline, reusing the PRs + issues loaded above.
  await processContributorEvidenceLogins(env, derivedLogins, { allPullRequests, allIssues });
}

async function processContributorEvidenceLogins(
  env: Env,
  logins: string[],
  preloaded?: {
    allPullRequests: Awaited<ReturnType<typeof listAllPullRequests>>;
    allIssues: Awaited<ReturnType<typeof listAllIssues>>;
  },
): Promise<void> {
  if (logins.length === 0) return;
  const [
    allPullRequests,
    allIssues,
    repositories,
    syncStates,
    allBounties,
    snapshot,
  ] = await Promise.all([
    preloaded ? Promise.resolve(preloaded.allPullRequests) : listAllPullRequests(env),
    preloaded ? Promise.resolve(preloaded.allIssues) : listAllIssues(env),
    listRepositories(env),
    listRepoSyncStates(env),
    listBounties(env),
    getOrCreateScoringModelSnapshot(env),
  ]);
  const issueQualityByRepo = await loadIssueQualityReportMap(env, repositories);
  for (const contributorLogin of logins) {
    // Isolate each login so one failure (transient GitHub/D1 error) doesn't abort the whole
    // 500-login batch and poison-pill the queue on retry (#787).
    try {
      const [
        github,
        contributorPullRequests,
        contributorIssues,
        cachedRepoStats,
        gittensorSnapshot,
      ] = await Promise.all([
        fetchPublicContributorProfile(contributorLogin, env),
        listContributorPullRequests(env, contributorLogin),
        listContributorIssues(env, contributorLogin),
        listContributorRepoStats(env, contributorLogin),
        fetchGittensorContributorSnapshot(contributorLogin),
      ]);
      const repoStats = authoritativeContributorRepoStats(
        gittensorSnapshot,
        cachedRepoStats,
      );
      const profile = buildContributorProfile(
        contributorLogin,
        github,
        contributorPullRequests,
        contributorIssues,
        repoStats,
        gittensorSnapshot,
      );
      const pullRequestFiles = await loadContributorPullRequestFilePaths(env, {
        login: contributorLogin,
        profile,
        pullRequests: contributorPullRequests,
        issues: contributorIssues,
        repoStats,
        repositories,
      });
      const fit = buildContributorFit(
        profile,
        repositories,
        allIssues,
        allPullRequests,
        syncStates,
        repoStats,
        allBounties,
        issueQualityByRepo,
      );
      const scoringProfile = buildContributorScoringProfile({
        login: contributorLogin,
        fit,
        scoringSnapshot: snapshot,
      });
      const outcomeHistory = buildContributorOutcomeHistory({
        login: contributorLogin,
        profile,
        repositories,
        pullRequests: allPullRequests,
        issues: allIssues,
        repoStats,
        cachedRepoStats,
      });
      const strategy = buildContributorStrategy({
        login: contributorLogin,
        fit,
        scoringProfile,
        scoringSnapshot: snapshot,
        outcomeHistory,
      });
      const roleContexts = repositories
        .filter((repo) => repo.isRegistered)
        .map((repo) =>
          buildRoleContext({
            login: contributorLogin,
            repo,
            repoFullName: repo.fullName,
            pullRequests: contributorPullRequests,
            issues: contributorIssues,
            profile,
          }),
        );
      const evidenceGraph = buildContributorEvidenceGraph({
        login: contributorLogin,
        profile,
        outcomeHistory,
        roleContexts,
        repositories,
        pullRequests: contributorPullRequests,
        issues: contributorIssues,
        repoStats,
        syncStates,
        pullRequestFiles,
        gittensorSnapshot,
      });
      const evidence: ContributorEvidenceRecord = {
        login: contributorLogin,
        generatedAt: scoringProfile.generatedAt,
        payload: {
          pullRequests: scoringProfile.evidence.registeredRepoPullRequests,
          mergedPullRequests: scoringProfile.evidence.mergedPullRequests,
          openPullRequests: scoringProfile.evidence.openPullRequests,
          stalePullRequests: scoringProfile.evidence.stalePullRequests,
          unlinkedPullRequests: scoringProfile.evidence.unlinkedPullRequests,
          issueDiscoveryReports: scoringProfile.evidence.issueDiscoveryReports,
          languageMatches: scoringProfile.evidence.languageMatches,
          credibilityAssumption: scoringProfile.evidence.credibilityAssumption,
          evidenceGraph: evidenceGraph as unknown as JsonValue,
        },
      };
      await upsertContributorEvidence(env, evidence);
      await upsertContributorScoringProfile(env, {
        login: contributorLogin,
        scoringModelSnapshotId: snapshot.id,
        payload: scoringProfile as unknown as Record<string, JsonValue>,
        generatedAt: scoringProfile.generatedAt,
      });
      await persistSignalSnapshot(env, {
        id: crypto.randomUUID(),
        signalType: "contributor-outcome-history",
        targetKey: contributorLogin,
        payload: outcomeHistory as unknown as Record<string, JsonValue>,
        generatedAt: outcomeHistory.generatedAt,
      });
      await persistSignalSnapshot(env, {
        id: crypto.randomUUID(),
        signalType: "contributor-strategy",
        targetKey: contributorLogin,
        payload: strategy as unknown as Record<string, JsonValue>,
        generatedAt: strategy.generatedAt,
      });
      await persistSignalSnapshot(env, {
        id: crypto.randomUUID(),
        signalType: CONTRIBUTOR_EVIDENCE_GRAPH_SIGNAL,
        targetKey: contributorLogin,
        payload: evidenceGraph as unknown as Record<string, JsonValue>,
        generatedAt: evidenceGraph.generatedAt,
      });
    } catch (error) {
      /* v8 ignore next -- defensive per-login isolation; the log-and-continue path is not exercised in tests */
      console.error(
        JSON.stringify({
          level: "warn",
          event: "contributor_evidence_login_failed",
          login: contributorLogin,
          error: errorMessage(error),
        }),
      );
    }
  }
}

async function buildBurdenForecasts(
  env: Env,
  repoFullName?: string,
): Promise<void> {
  const repositories = (await listRepositories(env)).filter(
    (repo) =>
      repo.isRegistered && (!repoFullName || repo.fullName === repoFullName),
  );
  for (const repo of repositories) {
    const [issues, pullRequests, recentMergedPullRequests, queueCounts] =
      await Promise.all([
        listIssueSignalSample(env, repo.fullName),
        listOpenPullRequests(env, repo.fullName),
        listRecentMergedPullRequests(env, repo.fullName),
        loadOpenQueueCounts(env, repo.fullName),
      ]);
    const forecast = buildBurdenForecast(
      repo,
      issues,
      pullRequests,
      buildCollisionReport(
        repo.fullName,
        issues,
        pullRequests,
        recentMergedPullRequests,
      ),
      30,
      queueCounts,
    );
    await upsertBurdenForecast(env, {
      repoFullName: repo.fullName,
      payload: forecast as unknown as Record<string, JsonValue>,
      generatedAt: forecast.generatedAt,
    });
  }
}

export async function generateSignalSnapshots(
  env: Env,
  repoFullName?: string,
): Promise<void> {
  const repositories = (await listRepositories(env)).filter(
    (repo) =>
      repo.isRegistered && (!repoFullName || repo.fullName === repoFullName),
  );
  for (const repo of repositories) {
    const trendSince = new Date(
      Date.now() - QUEUE_TREND_HISTORY_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const [
      issues,
      pullRequests,
      recentMergedPullRequests,
      labels,
      queueCounts,
      bounties,
      totalsHistory,
      queueHealthHistory,
    ] = await Promise.all([
      listIssueSignalSample(env, repo.fullName),
      listOpenPullRequests(env, repo.fullName),
      listRecentMergedPullRequests(env, repo.fullName),
      listRepoLabels(env, repo.fullName),
      loadOpenQueueCounts(env, repo.fullName),
      listBountiesByRepo(env, repo.fullName),
      listRepoGithubTotalsSnapshotHistory(env, repo.fullName, {
        sinceIso: trendSince,
        limit: 120,
      }),
      listSignalSnapshots(env, "queue-health", repo.fullName),
    ]);
    const collisions = buildCollisionReport(
      repo.fullName,
      issues,
      pullRequests,
      recentMergedPullRequests,
    );
    const queueHealth = buildQueueHealth(
      repo,
      issues,
      pullRequests,
      collisions,
      queueCounts,
    );
    const configQuality = buildConfigQuality(
      repo,
      issues,
      pullRequests,
      repo.fullName,
    );
    const labelAudit = buildLabelAudit(
      repo,
      labels,
      issues,
      pullRequests,
      repo.fullName,
    );
    const maintainerLane = buildMaintainerLaneReport(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      collisions,
      queueCounts,
    );
    const maintainerCutReadiness = buildMaintainerCutReadiness(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      queueCounts,
      collisions,
    );
    const contributorIntakeHealth = buildContributorIntakeHealth(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      collisions,
      queueCounts,
    );
    const issueQuality = buildIssueQualityReport(
      repo,
      issues,
      pullRequests,
      repo.fullName,
      bounties,
      collisions,
      recentMergedPullRequests,
    );
    await replaceCollisionEdges(
      env,
      repo.fullName,
      buildCollisionEdges(collisions),
    );
    const generatedAt = new Date().toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "queue-health",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: queueHealth as unknown as Record<string, never>,
      generatedAt,
    });
    await upsertRepoQueueTrendSnapshot(env, {
      repoFullName: repo.fullName,
      payload: buildQueueTrendReport({
        repoFullName: repo.fullName,
        totalsSnapshots: totalsHistory,
        queueHealthSnapshots: queueHealthHistory,
        currentQueueHealth: queueHealth,
        generatedAt,
      }) as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "config-quality",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: configQuality as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "label-audit",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: labelAudit as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "maintainer-lane",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: maintainerLane as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "maintainer-cut-readiness",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: maintainerCutReadiness as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "contributor-intake-health",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: contributorIntakeHealth as unknown as Record<string, never>,
      generatedAt,
    });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "issue-quality",
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: issueQuality as unknown as Record<string, never>,
      generatedAt,
    });
    const repoOutcomePatterns = await computeRepoOutcomePatterns(
      env,
      repo.fullName,
      repo,
    );
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: repo.fullName,
      repoFullName: repo.fullName,
      payload: repoOutcomePatterns as unknown as Record<string, never>,
      generatedAt,
    });
  }
}

async function loadOpenQueueCounts(
  env: Env,
  repoFullName: string,
): Promise<{ openIssues: number; openPullRequests: number }> {
  const [totals, openIssues, openPullRequests] = await Promise.all([
    getLatestRepoGithubTotalsSnapshot(env, repoFullName),
    countOpenIssues(env, repoFullName),
    countOpenPullRequests(env, repoFullName),
  ]);
  return {
    openIssues: totals?.openIssuesTotal ?? openIssues,
    openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
  };
}

/**
 * True when one row from listOpenItemsForAuthorAcrossInstall is CONFIRMED still open on GitHub right now
 * (#2562 gate-review follow-up): the stored DB cache can lag GitHub for a repo OTHER than the one this
 * webhook is for (closed manually, by another automation, or by a webhook this instance hasn't processed
 * yet) -- an inflated stale count must never itself trigger an irreversible close. Fail SAFE, not fail-open:
 * an item this call cannot POSITIVELY confirm is still open is excluded from the count (mirrors the existing
 * per-repo issue-cap's own sibling live-verification, #2479).
 */
async function isOpenItemRowStillLiveOpen(
  env: Env,
  row: OpenItemAcrossInstallRow,
  liveToken: string | undefined,
  admissionKey: GitHubRateLimitAdmissionKey | undefined,
): Promise<boolean> {
  if (row.kind === "issue") {
    const liveState = await fetchLiveIssueState(env, row.repoFullName, row.number, liveToken, admissionKey).catch(() => undefined);
    return liveState === "open";
  }
  const livePr = await fetchLivePullRequest(env, row.repoFullName, row.number, liveToken, admissionKey).catch(() => undefined);
  return livePr?.state === "open";
}

// A contributor can have thousands of open rows across a large install. Verify in fixed-size batches and stop
// once the caller has enough confirmed-open siblings to prove the cap is exceeded, preserving stale-row safety
// without letting one webhook drain the installation rate-limit bucket.
const GLOBAL_OPEN_ITEM_LIVE_CHECK_CONCURRENCY = 10;

async function countLiveOpenWithConcurrencyUntil(
  rows: OpenItemAcrossInstallRow[],
  concurrency: number,
  stopAfterConfirmedOpen: number,
  mapper: (row: OpenItemAcrossInstallRow) => Promise<boolean>,
): Promise<number> {
  let confirmedOpenCount = 0;
  for (let start = 0; start < rows.length && confirmedOpenCount <= stopAfterConfirmedOpen; start += concurrency) {
    const batch = rows.slice(start, start + concurrency);
    const results = await Promise.all(batch.map(mapper));
    confirmedOpenCount += results.filter(Boolean).length;
  }
  return confirmedOpenCount;
}

// A batched notify-evaluate job (#selfhost-maintenance-self-pin) can carry many events from one webhook (a
// popular newly-opened issue can have dozens of watchers) -- an unbounded Promise.all over all of them would
// let a single job spend as many concurrent DB/eval calls as it likes, bypassing the queue's own
// backgroundConcurrency cap (which defaults to 1) entirely from inside one job's execution. Bounded worker-pool
// fan-out, same shape as GLOBAL_OPEN_ITEM_LIVE_CHECK_CONCURRENCY above.
const NOTIFY_EVALUATE_EVENT_CONCURRENCY = 5;

// The per-repo contributor-cap live-verification (#2270 busy-repo bypass fix) walks a fixed-size author-scoped
// sibling sample. An author with many open PRs would otherwise fire too many concurrent
// fetchLivePullRequestState calls from a single webhook, and the delivery-order-guard wake below can re-trigger
// this same check for over-cap siblings. Every sampled entry must still be verified, so this bounds concurrency
// via mapWithConcurrency in addition to the repository query's total row cap.
const CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY = 10;

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index] as T);
      }
    }),
  );
  return results;
}

/**
 * Install-wide contributor open-item count, LIVE-VERIFIED (#2562 gate-review follow-up): every OTHER counted
 * item is confirmed still-open via a live GET before counting toward the cap (mirrors the existing per-repo
 * issue-cap's own sibling live-verification, #2479); `currentItem` (the one THIS webhook just delivered) is
 * trusted unverified, same as every other cap check in this file.
 */
async function verifiedGlobalOpenItemCount(
  env: Env,
  installationId: number,
  authorLogin: string,
  currentItem: { repoFullName: string; number: number; kind: "pull_request" | "issue" },
  globalCap: number,
): Promise<number> {
  const rows = await listOpenItemsForAuthorAcrossInstall(env, installationId, authorLogin);
  const otherRows = rows.filter(
    (row) => !(row.repoFullName === currentItem.repoFullName && row.number === currentItem.number && row.kind === currentItem.kind),
  );
  const token = await createInstallationToken(env, installationId).catch(() => undefined);
  const liveToken = token ?? env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubAdmissionKeyForToken(env, installationId, liveToken);
  const confirmedOpenCount = await countLiveOpenWithConcurrencyUntil(
    otherRows,
    GLOBAL_OPEN_ITEM_LIVE_CHECK_CONCURRENCY,
    globalCap - 1,
    (row) => isOpenItemRowStillLiveOpen(env, row, liveToken, admissionKey),
  );
  return confirmedOpenCount + 1;
}

/**
 * Per-contributor open-ISSUE cap (#2270, anti-abuse): the first `eventName === "issues"` actuation branch —
 * issues have no other auto-close path today. Mirrors the PR-path cap in runAgentMaintenancePlanAndExecute:
 * counts the author's currently-open issues on this repo (including this one), ranked by issue NUMBER
 * (GitHub's own creation order, not webhook-arrival order). Reuses planAgentMaintenanceActions to build the
 * SAME label+close plan the PR path uses (identical closeKind/label/close-comment construction): passing
 * `conclusion: "skipped"` and no `blacklistMatch` guarantees the function returns at the contributor_cap
 * short-circuit (the very next check in the planner) before ever touching any PR/CI-specific field, so
 * building a plan for an issue this way is safe.
 *
 * Webhook-delivery-order guard (#2479 gate finding, mirrored here for issues): delivery order is not
 * guaranteed to match issue creation order, so an OLDER sibling's own webhook can process before a NEWER
 * sibling exists in the DB and wrongly conclude the author is within the cap — closing only "the incoming
 * issue, if it's over cap" would let that stale verdict stand forever, since nothing else ever re-evaluates
 * it. Closes EVERY number in the over-cap set discovered by THIS delivery, not just the incoming issue, so
 * whichever delivery happens to see the complete picture corrects any sibling a prior delivery missed. Unlike
 * the PR path (which enqueues a `agent-regate-pr` wake job so each sibling gets its own live-head/CI-freshness
 * re-check before acting), issues have no head SHA or CI to go stale, and there's no issue-side "regate" job
 * type to reuse — so that PARTICULAR staleness risk does not apply here.
 *
 * Stale-closed-sibling guard (#2479 gate finding): a DIFFERENT staleness risk DOES apply — `listOpenIssues`
 * reads the local DB cache, which can still say `open` for a sibling already closed on GitHub (manually, by
 * another automation, or by a webhook this instance hasn't processed yet). An inflated count from such a stale
 * row could wrongly put a newly opened issue over the REAL cap. Guarded by live-verifying each counted sibling
 * below before trusting it -- and unlike a non-final ranking signal, an inconclusive live check here is treated
 * as NOT open (excluded from the count), never left as an unverified "counts toward the cap" default, because
 * this count gates an irreversible close (#2479 gate finding, second pass).
 */
async function maybeCloseIssueOverContributorCap(
  env: Env,
  args: { installationId: number; repoFullName: string; issue: IssueRecord; settings: RepositorySettings; deliveryId: string },
): Promise<void> {
  const { installationId, repoFullName, issue, settings, deliveryId } = args;
  const cap = settings.contributorOpenIssueCap;
  const authorLogin = issue.authorLogin;
  // Install-wide cap (#2562) is checked IN ADDITION TO the per-repo cap, so this function must still run when
  // ONLY a global cap is configured (the per-repo cap stays optional/off, its usual default). Both global
  // resolvers now default to a real number even when unset (#4511) -- a CONFIRMED official Gittensor miner
  // gets its own fleet-appropriate cap instead of the human one, checked separately below once we know at
  // least one of the two is active (both resolvers here are plain env reads; the identity check isn't).
  const globalCapForHuman = resolveGlobalContributorOpenItemCap(env);
  const globalCapForMiner = resolveGlobalContributorOpenItemCapForMiner(env);
  if ((typeof cap !== "number" && globalCapForHuman === null && globalCapForMiner === null) || !authorLogin) return;

  const repoOwner = repoOwnerLoginFromFullName(repoFullName);
  const authorIsOwner = authorLogin.toLowerCase() === repoOwner.toLowerCase();
  const authorIsAdmin = parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(authorLogin.toLowerCase());
  const authorIsAutomationBot = isProtectedAutomationAuthor(authorLogin);
  if (authorIsOwner || authorIsAdmin || authorIsAutomationBot) return;

  // Account-age throttle (#2561): mirror the PR-path cap tightening — a below-threshold author gets half
  // the configured per-repo issue cap (rounded up, minimum 1). Fail-open when created_at cannot be resolved.
  const isNewAccount = await isBelowAccountAgeThreshold(env, installationId, authorLogin, settings.accountAgeThresholdDays);

  // Install-wide check first (#2562): reuses the shared autoCloseExemptLogins list, same as the PR path.
  // verifiedGlobalOpenItemCount live-verifies every OTHER counted item before trusting it toward an
  // irreversible close (#2562 gate-review follow-up), mirroring the per-repo cap's own sibling live-verify.
  if ((globalCapForHuman !== null || globalCapForMiner !== null) && !isAutoCloseExempt(authorLogin, settings.autoCloseExemptLogins)) {
    const officialMiner = await getCachedOfficialMinerDetection(env, authorLogin, {
      targetKey: `${repoFullName}#${issue.number}`,
      deliveryId,
    });
    const globalCap = officialMiner.status === "confirmed" ? globalCapForMiner : globalCapForHuman;
    if (globalCap === null) return;
    const globalOpenCount = await verifiedGlobalOpenItemCount(env, installationId, authorLogin, {
      repoFullName,
      number: issue.number,
      kind: "issue",
    }, globalCap);
    if (globalOpenCount > globalCap) {
      const planned = planAgentMaintenanceActions({
        conclusion: "skipped",
        blockerTitles: [],
        autonomy: settings.autonomy,
        changedPaths: [],
        hardGuardrailGlobs: [],
        authorIsOwner,
        authorIsAdmin,
        authorIsAutomationBot,
        ciState: "unverified",
        // verifiedGlobalOpenItemCount sums BOTH open PRs and open issues; "pull requests and issues" is
        // accurate regardless of the actual split, unlike a hardcoded single kind.
        contributorCapMatch: { matched: true, authorLogin, openCount: globalOpenCount, cap: globalCap, itemKind: "pull requests and issues", scope: "install" },
        contributorCapLabel: settings.contributorCapLabel,
        pr: { labels: [] },
      });
      if (planned.length > 0) {
        await executeIssueMaintenanceActions(
          env,
          {
            installationId,
            repoFullName,
            issueNumber: issue.number,
            autonomy: settings.autonomy,
            agentPaused: settings.agentPaused,
            agentDryRun: settings.agentDryRun,
            agentGlobalFreezeOverride: settings.agentGlobalFreezeOverride,
            authorLogin,
            moderationSettings: { moderationGateMode: settings.moderationGateMode, moderationRules: settings.moderationRules, moderationWarningLabel: settings.moderationWarningLabel, moderationBannedLabel: settings.moderationBannedLabel },
          },
          planned,
        );
      }
      return;
    }
  }

  // #2270/#2463-parity: same shared `autoCloseExemptLogins` allowlist the install-wide cap above and review-nag
  // cooldown already honor -- see the matching comment on the PR-side per-repo cap in the PR maintenance path.
  if (typeof cap !== "number" || isAutoCloseExempt(authorLogin, settings.autoCloseExemptLogins)) return;

  const effectiveIssueCap = effectiveIssueCapForAccountAge(cap, isNewAccount);

  const otherOpenIssues = await listOpenIssues(env, repoFullName);
  const authorLoginLower = authorLogin.toLowerCase();
  const otherAuthorIssueNumbers = otherOpenIssues
    .filter((other) => (other.authorLogin ?? "").toLowerCase() === authorLoginLower && other.number !== issue.number)
    .map((other) => other.number);

  // Live-verify each OTHER counted sibling before trusting it toward the cap (#2479 gate finding): the stored
  // open-issue cache lags GitHub, so a sibling already closed elsewhere (manually, by another automation, or a
  // webhook this instance hasn't processed yet) can still read `open` here and inflate the count enough to close
  // a newly opened issue that is actually within the real cap. `issue` itself is trusted unverified -- it is the
  // issue THIS webhook just delivered, so it is open by construction.
  //
  // Fail SAFE (not open, per gate finding on this exact block, second pass), NOT fail-open-to-stored like
  // reconcileLiveDuplicateSiblings: that helper only re-ranks a duplicate-cluster WINNER (a non-final signal
  // recomputed every delivery), so failing open there just risks a transient wrong ranking. Here the count
  // directly gates an IRREVERSIBLE close, so an unreadable live check (a transient fetch failure) must NOT be
  // allowed to compound with a stale "open" DB row and tip a within-cap issue into being wrongly closed --
  // any sibling this delivery cannot POSITIVELY confirm is still open is excluded from the count. The cost is
  // symmetric-but-safe: a transient miss can undercount and momentarily under-enforce the cap, but that is
  // self-correcting (the delivery-order guard below already re-evaluates on every subsequent issue-open), while
  // a wrongful close is not.
  const token = await createInstallationToken(env, installationId).catch(() => undefined);
  const liveToken = token ?? env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubAdmissionKeyForToken(env, installationId, liveToken);
  const confirmedOpen = new Set<number>();
  // Bounded fan-out, mirroring the per-repo PR cap (#2766): an unbounded Promise.all scales with the author's
  // own open-issue count, so a single delivery could fire dozens of concurrent live-state calls. Every sibling
  // must still be verified (the over-cap numbers below depend on the complete confirmed-open set), so this
  // bounds concurrency via the shared CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY rather than stopping early.
  await mapWithConcurrency(otherAuthorIssueNumbers, CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY, async (number) => {
    const liveState = await fetchLiveIssueState(env, repoFullName, number, liveToken, admissionKey).catch(() => undefined);
    if (liveState === "open") confirmedOpen.add(number);
  });
  const authorOpenIssueNumbers = otherAuthorIssueNumbers
    .filter((number) => confirmedOpen.has(number))
    .concat(issue.number)
    .sort((a, b) => a - b);
  const overCapNumbers = new Set(authorOpenIssueNumbers.slice(effectiveIssueCap));
  if (overCapNumbers.size === 0) return;

  const planned = planAgentMaintenanceActions({
    conclusion: "skipped",
    blockerTitles: [],
    autonomy: settings.autonomy,
    changedPaths: [],
    hardGuardrailGlobs: [],
    authorIsOwner,
    authorIsAdmin,
    authorIsAutomationBot,
    ciState: "unverified",
    contributorCapMatch: { matched: true, authorLogin, openCount: authorOpenIssueNumbers.length, cap: effectiveIssueCap, itemKind: "issues" },
    contributorCapLabel: settings.contributorCapLabel,
    pr: { labels: [] },
  });
  if (planned.length === 0) return;

  for (const overCapNumber of overCapNumbers) {
    await executeIssueMaintenanceActions(
      env,
      {
        installationId,
        repoFullName,
        issueNumber: overCapNumber,
        autonomy: settings.autonomy,
        agentPaused: settings.agentPaused,
        agentDryRun: settings.agentDryRun,
        agentGlobalFreezeOverride: settings.agentGlobalFreezeOverride,
        authorLogin,
        moderationSettings: { moderationGateMode: settings.moderationGateMode, moderationRules: settings.moderationRules, moderationWarningLabel: settings.moderationWarningLabel, moderationBannedLabel: settings.moderationBannedLabel },
      },
      planned,
    );
  }
}

async function processGitHubWebhook(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<void> {
  try {
    if (
      eventName === "installation" &&
      payload.action === "deleted" &&
      payload.installation?.id
    ) {
      await markInstallationDeleted(env, payload.installation.id);
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    const installationAppId = await upsertInstallation(env, payload);
    // Dual-app safety (#selfhost-app-id): if this delivery's installation belongs to a DIFFERENT gittensory App
    // (cloud + self-host installed on the same account), ack it without processing so neither backend acts on the
    // other's installation. FAIL-OPEN — an unknown/own-matching app_id always processes, so the LIVE single-app
    // path is byte-identical. Signature verification (per-App secret) is the primary isolation; this is the
    // belt-and-suspenders for a shared-endpoint/secret misconfig.
    if (isForeignAppInstallation(env.GITHUB_APP_ID, installationAppId)) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "foreign_app",
        status: "processed",
      });
      return;
    }
    const installationActor =
      payload.installation?.account?.login ??
      (payload.installation?.id
        ? (await getInstallation(env, payload.installation.id))?.accountLogin
        : undefined);
    if (eventName === "installation_repositories" && payload.installation?.id) {
      const addedRepos =
        payload.repositories_added
          ?.map((repo) => repo.full_name)
          .filter(Boolean) ?? [];
      const removedRepos =
        payload.repositories_removed
          ?.map((repo) => repo.full_name)
          .filter(Boolean) ?? [];
      for (const repo of payload.repositories_added ?? [])
        await upsertRepositoryFromGitHub(env, repo, payload.installation.id);
      await markRepositoriesRemovedFromInstallation(
        env,
        payload.installation.id,
        removedRepos,
      );
      await Promise.all([
        ...addedRepos.slice(0, 50).map((repoFullName) =>
          recordGithubProductUsage(
            env,
            "github_installation_repository_added",
            {
              actor: installationActor,
              repoFullName,
              targetKey: payload.installation?.id
                ? `installation:${payload.installation.id}`
                : repoFullName,
              outcome: "completed",
              metadata: {
                action: payload.action,
                repoCount: addedRepos.length,
                truncatedRepos: Math.max(addedRepos.length - 50, 0),
              },
            },
          ),
        ),
        ...removedRepos.slice(0, 50).map((repoFullName) =>
          recordGithubProductUsage(
            env,
            "github_installation_repository_removed",
            {
              actor: installationActor,
              repoFullName,
              targetKey: payload.installation?.id
                ? `installation:${payload.installation.id}`
                : repoFullName,
              outcome: "completed",
              metadata: {
                action: payload.action,
                repoCount: removedRepos.length,
                truncatedRepos: Math.max(removedRepos.length - 50, 0),
              },
            },
          ),
        ),
      ]);
    }

    if (eventName === "installation" && payload.action === "created") {
      const installedRepos =
        payload.repositories?.map((repo) => repo.full_name).filter(Boolean) ??
        (payload.repository?.full_name ? [payload.repository.full_name] : []);
      await Promise.all(
        installedRepos.slice(0, 50).map((repoFullName) =>
          recordGithubProductUsage(env, "github_installation_created", {
            actor: installationActor,
            repoFullName,
            targetKey: payload.installation?.id
              ? `installation:${payload.installation.id}`
              : repoFullName,
            outcome: "completed",
            metadata: {
              action: payload.action,
              repoCount: installedRepos.length,
              truncatedRepos: Math.max(installedRepos.length - 50, 0),
            },
          }),
        ),
      );
    }

    const installationId = getInstallationId(payload);
    if (payload.repositories) {
      for (const repo of payload.repositories)
        await upsertRepositoryFromGitHub(
          env,
          repo,
          installationId ?? undefined,
        );
    }
    if (payload.repository)
      await upsertRepositoryFromGitHub(
        env,
        payload.repository,
        installationId ?? undefined,
      );

    if (
      eventName === "reaction" &&
      (await maybeProcessAgentCommandFeedbackReaction(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    if (
      eventName === "issue_comment" &&
      (await maybeProcessPrPanelRetrigger(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    if (
      eventName === "issue_comment" &&
      (await maybeProcessPrPanelGenerateTests(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    if (
      eventName === "issue_comment" &&
      (await maybeProcessGateOverrideCommand(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    if (eventName === "issue_comment" && (await maybeProcessResolveCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return; }
    if (eventName === "issue_comment" && (await maybeProcessExplainCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return; }
    if (eventName === "issue_comment" && (await maybeProcessGenerateTestsCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return; }
    if (eventName === "issue_comment" && (await maybeProcessReviewCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return; }
    if (eventName === "issue_comment" && (await maybeProcessPauseCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return; }
    if (eventName === "issue_comment" && (await maybeProcessResumeCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return; }
    if (
      eventName === "issue_comment" &&
      (await maybeProcessConfigurationCommand(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    if (
      eventName === "issue_comment" &&
      (await maybeProcessPlanCommand(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    // Review-nag cooldown (#2463) runs BEFORE the mention-command dispatch below: a throttled ping must
    // short-circuit ahead of the normal answer-card reply, not alongside it.
    if (
      eventName === "issue_comment" &&
      (await maybeThrottleReviewNagPing(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    // Maintainer-mention nag moderation (#label-scoping): independent of the @gittensory ping above — a
    // mention of a configured maintainer login is never a bot command, so this must run regardless of whether
    // the comment also contains an @gittensory mention/command.
    if (
      eventName === "issue_comment" &&
      (await maybeThrottleMonitoredMentions(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    if (
      eventName === "issue_comment" &&
      (await maybeProcessGittensoryMentionCommand(env, deliveryId, payload))
    ) {
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return;
    }

    // CI-completion re-review — THE auto-merge / close-on-red trigger. A check_run/check_suite completion
    // carries no `payload.pull_request`, so it must be handled BEFORE the pull_request block: it wakes the
    // stored PR row and re-reviews it now that CI has settled (merge on green, close-non-owner / hold-owner on
    // red). Without this a PR that goes green/red AFTER its open-time review is never re-evaluated.
    if (await maybeReReviewOnCiCompletion(env, deliveryId, eventName, payload))
      return;
    // actions_fallback's own workflow_run completion (#4112) — checked BEFORE the legacy status/workflow_run
    // handler below, which otherwise unconditionally consumes EVERY workflow_run event first.
    if (await maybeCaptureOnActionsFallbackWorkflowRun(env, deliveryId, eventName, payload))
      return;
    // Legacy status/workflow_run CI signals aren't re-review triggers (see the function's own doc comment), but
    // must still invalidate the durable CI-state cache so a tracked PR's next reader doesn't see a stale
    // pre-transition aggregate for the rest of the cache TTL.
    if (await maybeInvalidateCiCacheOnLegacyCiEvent(env, deliveryId, eventName, payload))
      return;
    // deployment_status (preview deploy finished) → re-review so the visual before/after capture fills in.
    if (
      await maybeCaptureOnDeploymentStatus(env, deliveryId, eventName, payload)
    )
      return;
    // Linked-issue label/assignment change (#2259) — an `issues` event carries no `payload.pull_request` either,
    // so it must be handled here alongside the other non-PR wake triggers: it re-reviews every open PR that
    // links this issue promptly, instead of waiting for a PR-side webhook or the staleness-ordered sweep.
    if (
      await maybeReReviewOnLinkedIssueChange(env, deliveryId, eventName, payload)
    )
      return;

    if (payload.repository?.full_name && payload.pull_request) {
      const repoFullName = payload.repository.full_name;
      const payloadPullRequest = payload.pull_request;
      // Accuracy/eval feedback loop (#self-improve / GAP-4). Independent of the review path + best-effort:
      //   • pr_outcome — on `closed`, record the REALIZED merge-vs-close ground truth so computeGateEval can
      //     score the gate's prediction against what the human actually did.
      //   • reversal — on `reopened` of a bot-CLOSED PR (contributor dispute) / a merged "Reverts #N" PR,
      //     record the human override so reversalRate/calibration are no longer blind. Both fail safe.
      await recordPrOutcome(env, eventName, payload).catch((error) => {
        /* v8 ignore next -- best-effort: outcome recording never blocks the webhook. */
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "pr_outcome_record_failed",
            deliveryId,
            repository: repoFullName,
            error: errorMessage(error),
          }),
        );
      });
      await recordReversalSignals(env, eventName, payload).catch((error) => {
        /* v8 ignore next -- best-effort: reversal recording never blocks the webhook. */
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "reversal_record_failed",
            deliveryId,
            repository: repoFullName,
            error: errorMessage(error),
          }),
        );
      });
      // Reviews-cache invalidation (#2537): a `pull_request_review` webhook (submitted/dismissed/edited) is
      // the ONLY event that can change the set of reviews GitHub reports for this PR, so it is the sole signal
      // fetchAndStorePullRequestDetails's reviewsUpToDate check needs to know the cached reviews are stale.
      // Independent of, and does not gate, any downstream processing below — best-effort like the outcome/
      // reversal recording above, so a transient D1 failure here never blocks the webhook.
      if (
        eventName === "pull_request_review" &&
        (payload.action === "submitted" || payload.action === "dismissed" || payload.action === "edited")
      ) {
        await markPullRequestReviewsInvalidated(env, repoFullName, payloadPullRequest.number).catch((error) => {
          /* v8 ignore next -- best-effort: cache-invalidation stamping never blocks the webhook. */
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "pull_request_reviews_invalidate_failed",
              deliveryId,
              repository: repoFullName,
              pullNumber: payloadPullRequest.number,
              error: errorMessage(error),
            }),
          );
        });
      }
      const pr = await upsertPullRequestFromGitHub(
        env,
        repoFullName,
        payload.pull_request,
      );
      // #2537: the durable PR-state cache (mergeable_state/state) goes stale exactly when GitHub recomputes them —
      // synchronize (new head → new mergeable_state recompute), closed (state flips), reopened (state flips back).
      // Clear explicitly (null, not omitted — PARTIAL-UPDATE CONTRACT) so the next cached read is a forced live
      // miss; other pull_request actions (labeled, edited, etc.) don't change these fields and are left untouched
      // to avoid spurious cache churn / extra writes on high-frequency low-signal actions.
      if (eventName === "pull_request" && (payload.action === "synchronize" || payload.action === "closed" || payload.action === "reopened")) {
        await invalidatePrStateCache(env, repoFullName, pr.number).catch(() => undefined);
      }
      // Review-evasion protection (#review-evasion-protection): a head change (synchronize) invalidates any
      // active-review tracking for the OLD head immediately -- a fresh pass starts its own tracking later in
      // this same handler. Best-effort; the guarded CAS update is a safe no-op when nothing is active. The
      // "closed" case is handled AFTER the self-close/converted_to_draft evasion checks below, not here --
      // those checks must read the row before this general cleanup would otherwise clear it out from under
      // them.
      if (eventName === "pull_request" && payload.action === "synchronize") {
        await terminalizeActiveReviewTracking(env, repoFullName, pr.number).catch(() => undefined);
      }
      // Reopen-prevention (#one-shot-reopen): a CONTRIBUTOR may not reopen a PR that gittensory or a maintainer
      // closed — closes are one-shot (resubmit, don't reopen). If a non-maintainer reopened a PR whose last close
      // was by the bot / repo owner / admin, re-close it and skip the re-review. Self-closes (the contributor
      // closed their own PR) stay reopenable; the bot's own nightly-re-review reopens are exempt. A contended
      // actuation lock is retryable (#2135/#2447): this pass must not evaluate/mutate the PR concurrently, but
      // ordinary maintenance can now hold the same lock and may not enforce this one-shot reopen event.
      // Deliberately UNCAUGHT here: every step inside maybeRecloseDisallowedReopen already fails safe on its own
      // (the lock claim/release fail open; recloseDisallowedReopenIfNeeded's own operations all .catch()), so a
      // swallowing catch at this call site could only ever mask a genuinely unexpected error into a silent
      // "allowed" — which would re-permit exactly the disallowed reopen this guard exists to stop. Let it
      // propagate and retry instead, same reasoning as the draft-dodge sibling's uncaught getInstallation read.
      const reopenOutcome: ReopenRecloseOutcome =
        payload.action === "reopened" && installationId
          ? await maybeRecloseDisallowedReopen(
              env,
              deliveryId,
              installationId,
              repoFullName,
              pr,
              payload,
            )
          : "allowed";
      if (reopenOutcome === "reclosed") {
        // Stamp the delivery processed like every other owning path — the early return otherwise leaves the
        // webhook_events row stuck at "queued"/its body hash, mis-reporting the delivery as un-acked (#review-audit).
        await recordWebhookEvent(env, {
          deliveryId,
          eventName,
          action: payload.action,
          installationId: payload.installation?.id,
          repositoryFullName: payload.repository?.full_name,
          payloadHash: "processed",
          status: "processed",
        });
        return;
      }
      // Resolve settings first so the self-authored + open-reference live-fetch fallbacks only fire when their
      // respective gates are in block mode.
      const settings = await resolveRepositorySettings(env, repoFullName);
      const [repo, cachedOtherOpenPullRequests, { linkedIssueAuthorLogins, confirmedNoOpenLinkedIssue }] =
        await Promise.all([
          getRepository(env, repoFullName),
          listOtherOpenPullRequests(env, repoFullName, pr.number),
          resolveLinkedIssueAdvisoryContext(env, installationId, repoFullName, pr.linkedIssues, settings),
        ]);
      // #dup-winner / audit #15: drop any cached-open duplicate sibling already closed on GitHub before the
      // advisory (and the disposition) elect the cluster winner, so the real lowest-OPEN PR is never auto-closed.
      const otherOpenPullRequests = await reconcileLiveDuplicateSiblings(
        env,
        installationId,
        repoFullName,
        pr,
        cachedOtherOpenPullRequests,
      );
      const advisory = buildPullRequestAdvisory(repo, pr, {
        otherOpenPullRequests,
        requireLinkedIssue: shouldCollectLinkedIssueEvidence(settings),
        duplicateWinnerEnabled: env.GITTENSORY_DUPLICATE_WINNER === "true",
        confirmedNoOpenLinkedIssue,
        linkedIssueAuthorLogins,
      });
      await persistAdvisory(env, advisory);
      // Auto-project/milestone matching (#3183): independent of the gate/disposition entirely -- a missed or
      // wrong match must never affect CI/merge, so this is a best-effort side comment, never a blocker. All the
      // "should this run at all" gating + error logging lives in maybeSuggestMilestoneMatchForPr itself, so
      // this call site stays a single unconditional call with no logic of its own.
      await maybeSuggestMilestoneMatchForPr({
        env,
        installationId,
        repoFullName,
        pullNumber: pr.number,
        prState: pr.state,
        prTitle: pr.title,
        prBody: pr.body,
        prUrl: pr.htmlUrl,
        mode: settings.autoProjectMilestoneMatch,
        backend: settings.autoProjectMilestoneMatchBackend,
        deliveryId,
        eventName,
        action: payload.action,
      });
      // Review-evasion protection (#review-evasion-protection): a contributor closing their OWN PR while
      // gittensory has an ACTIVE review pass running is dodging the one-shot review, not making an ordinary
      // close. Runs regardless of the general draft-dodge/reopen-reclose gates above -- it is its own
      // independent enforcement, config-gated on settings.reviewEvasionProtection (close by default, #4011).
      if (payload.action === "closed" && installationId) {
        await maybeCloseReviewEvasionSelfClose(
          env,
          deliveryId,
          installationId,
          repoFullName,
          pr,
          payload,
          settings,
        );
      }
      // Draft-dodge guard (#converted-to-draft): a contributor converting an OPEN PR to draft cannot use
      // draft state to keep a gate-rejected PR alive. When a prior gate failure exists for the PR's current
      // headSha (and the block has not been maintainer-overridden), close the PR immediately — the gate
      // verdict stands and does not reset on draft conversion. Skipped when the agent is unconfigured or
      // paused (the gate doesn't act on paused repos) and for owner / automation PRs.
      if (
        payload.action === "converted_to_draft" &&
        installationId &&
        pr.headSha &&
        pr.state === "open" &&
        isAgentConfigured(settings.autonomy) &&
        !settings.agentPaused &&
        !isProtectedAutomationAuthor(pr.authorLogin)
      ) {
        // Deliberately UNCAUGHT here: closeDraftDodgeAttemptIfBlocked catches every operation that should
        // fail safely, but leaves the write-permission-readiness getInstallation read (#2134) uncaught on
        // purpose so a transient D1 failure propagates and the queue retries instead of misrecording a
        // permission denial.
        await maybeCloseDraftDodgeAttempt(
          env,
          deliveryId,
          installationId,
          repoFullName,
          pr,
          settings,
        );
      }
      // Review-evasion protection: the active-review sibling of the draft-dodge guard above -- fires
      // regardless of whether a PRIOR gate failure exists (draft-dodge's own trigger), as long as a review
      // pass is CURRENTLY active for this head. Naturally near-mutually-exclusive with draft-dodge in
      // practice: the same pass that records a gate-block-outcome also terminalizes the active-review row it
      // was tracking, so by the time draft-dodge's prior-gate-failure condition is true, this guard's
      // active-review condition is normally already false.
      if (payload.action === "converted_to_draft" && installationId) {
        await maybeCloseReviewEvasionDraftConversion(
          env,
          deliveryId,
          installationId,
          repoFullName,
          pr,
          payload,
          settings,
        );
      }
      // Review-evasion protection: repeated ready<->draft cycling (#gaming-tactic-draft-cycle). Only counts a
      // conversion PERFORMED BY THE PR'S OWN AUTHOR -- a maintainer/third-party converting the PR to draft is an
      // unrelated action and must never contribute to (or be conflated with) the author's own cycling pattern;
      // counting it here would let one maintainer draft-toggle plus the author's own first-ever (legitimate)
      // conversion reach count>=2 and wrongly close that first conversion as "repeated" cycling. Always counts
      // (cheap, no side effects) so the count is accurate from the very first converted_to_draft event this repo
      // ever sees, even before reviewEvasionProtection is turned on for it -- only the ENFORCEMENT is gated on
      // that setting. Runs after both guards above so a PR already closed by either of them fails this guard's
      // own freshness re-check instead of being redundantly re-closed.
      if (payload.action === "converted_to_draft" && installationId) {
        const draftConverter = (payload.sender?.login ?? "").toLowerCase();
        const draftAuthor = (pr.authorLogin ?? "").toLowerCase();
        const isAuthorDraftConversion = draftConverter.length > 0 && draftConverter === draftAuthor;
        const draftConversionCount = isAuthorDraftConversion
          ? await bumpPullRequestDraftConversionCount(env, repoFullName, pr.number).catch(
              /* v8 ignore next -- fail-safe: a counter-write failure only means this ONE cycle isn't detected. */
              () => 0,
            )
          : 0;
        await maybeCloseRepeatedDraftCycling(
          env,
          deliveryId,
          installationId,
          repoFullName,
          pr,
          payload,
          settings,
          draftConversionCount,
        );
      }
      // Review-evasion protection: the "closed" half of the active-review-tracking cleanup (the
      // "synchronize" half runs earlier, alongside invalidatePrStateCache). Deliberately placed AFTER the
      // self-close-evasion check above so that check reads the tracking row before this general cleanup
      // would otherwise clear it out from under it -- a normal close and this repo's own evasion-enforcement
      // close (which already terminalizes internally, scoped to its own head) both land here too; the
      // guarded CAS update is a safe no-op in both of those already-terminal cases.
      if (eventName === "pull_request" && payload.action === "closed") {
        await terminalizeActiveReviewTracking(env, repoFullName, pr.number).catch(() => undefined);
      }
      if (
        installationId &&
        shouldProcessPullRequestPublicSurface(eventName, payload.action)
      ) {
        if (
          shouldCollectSlopEvidence(settings) ||
          settings.manifestPolicyGateMode !== "off" ||
          isAgentConfigured(settings.autonomy) ||
          (await shouldRefreshFilesForPreMergeChecks(env, repoFullName))
        ) {
          await refreshPullRequestDetails(env, repoFullName, pr.number);
        }
        // Operator review flow: rebase-if-behind → wait for ALL CI → only THEN review/act. When deferred (a
        // rebase fired a synchronize, or CI is still running) skip the review+maintain now; the synchronize /
        // CI-completion webhook (sweep backstop) re-runs this once the head is current and CI has settled. gate
        // stays undefined so the reputation/RAG steps below no-op until the terminal decision.
        let gate:
          | Awaited<ReturnType<typeof maybePublishPrPublicSurface>>
          | undefined;
        const liveFacts = createLiveGithubFacts();
        if (
          await withReviewPipelineSpan(
            "selfhost.review.readiness",
            {
              installationId,
              repoFullName,
              pullNumber: pr.number,
              operation: "readiness",
            },
            () =>
              prReadyForReview(
                env,
                installationId,
                repoFullName,
                pr,
                settings,
                deliveryId,
                liveFacts,
              ),
          )
        ) {
          gate = await withReviewPipelineSpan(
            "selfhost.review.public_surface",
            {
              installationId,
              repoFullName,
              pullNumber: pr.number,
              operation: "public_surface",
            },
            () =>
              maybePublishPrPublicSurface(
                env,
                installationId,
                repoFullName,
                pr,
                repo,
                settings,
                advisory,
                otherOpenPullRequests,
                {
                  deliveryId,
                  authorType: payloadPullRequest.user?.type,
                  action: payload.action,
                  baseSha: payloadPullRequest.base?.sha ?? null,
                  liveFacts,
                },
              ),
          ).catch((error) => {
            if (isGitHubRateLimitedError(error) || isRetryableJobError(error)) throw error;
            console.error(
              JSON.stringify({
                level: "warn",
                event: "pr_public_surface_failed",
                deliveryId,
                repository: payload.repository?.full_name,
                pullNumber: pr.number,
                error: errorMessage(error),
              }),
            );
            return undefined;
          });
          // #778 maintainer auto-maintain: act on the PR's state (label/review/merge/close) per the repo's
          // autonomy config, after the gate has run. The function self-guards on agent config; best-effort here
          // so it never blocks the gate or public surface.
          await withReviewPipelineSpan(
            "selfhost.review.maintenance",
            {
              installationId,
              repoFullName,
              pullNumber: pr.number,
              operation: "maintenance",
              decisionOutcome: gate?.conclusion,
            },
            () =>
              maybeRunAgentMaintenance(env, {
                installationId,
                repoFullName,
                repo,
                pr,
                settings,
                otherOpenPullRequests,
                deliveryId,
                gate,
                liveFacts,
              }),
          ).catch((error) => {
            /* v8 ignore next -- best-effort: auto-maintain failures are logged, never surfaced to the gate. */
            console.error(
              JSON.stringify({
                level: "warn",
                event: "agent_maintenance_failed",
                deliveryId,
                repository: repoFullName,
                pullNumber: pr.number,
                error: errorMessage(error),
              }),
            );
          });
        }
        // Reputation (convergence, flag-gated by GITTENSORY_REVIEW_REPUTATION). After the gate decides, record this
        // submitter's terminal outcome (merged / closed / manual) so the INTERNAL reputation stays current. The
        // outcome is derived ONLY from the PR's realized terminal state + the gate verdict (no PR content);
        // nothing is ever surfaced publicly. Flag-OFF (default) is an immediate no-op (nothing recorded), so the
        // path is byte-identical. Best-effort: a record failure must never affect the gate or the public surface.
        const reputationOutcome = (await convergedFeatureActive(
          env,
          repoFullName,
          "reputation",
        ))
          ? reputationOutcomeFromTerminalState(pr, payload.pull_request, gate)
          : undefined;
        if (reputationOutcome) {
          await recordReputationOutcome(env, {
            project: repoFullName,
            submitter: pr.authorLogin ?? null,
            outcome: reputationOutcome,
          }).catch((error) => {
            /* v8 ignore next -- best-effort: a reputation-record failure is logged, never surfaced to the gate. */
            console.error(
              JSON.stringify({
                level: "warn",
                event: "reputation_record_failed",
                deliveryId,
                repository: repoFullName,
                pullNumber: pr.number,
                error: errorMessage(error),
              }),
            );
          });
        }
        // RAG incremental index (convergence, flag-gated by GITTENSORY_REVIEW_RAG + the per-repo cutover allowlist).
        // When a PR MERGES into an allowlisted repo, its changes have landed on the default branch — enqueue an
        // incremental re-index of just the changed files (reindexChangedPaths) so the index stays fresh without a
        // full re-crawl. Enqueued (not run inline) so the webhook stays fast + the index work is its own retryable
        // job. Flag-OFF (default) is a no-op (the job is never enqueued AND the processor no-ops). Best-effort.
        await maybeEnqueueRagReindexForMergedPr(
          env,
          repoFullName,
          pr.number,
          payload.action,
          payload.pull_request.merged_at,
          installationId,
        ).catch((error) => {
          /* v8 ignore next -- best-effort: a RAG re-index enqueue failure is logged, never surfaced to the gate. */
          console.error(
            JSON.stringify({
              level: "warn",
              event: "rag_reindex_enqueue_failed",
              deliveryId,
              repository: repoFullName,
              pullNumber: pr.number,
              error: errorMessage(error),
            }),
          );
        });
        // Event-driven sibling re-gate (#4005): a merge can invalidate every OTHER open PR's gate verdict, and
        // otherwise nothing re-checks them until the next bounded sweep tick reaches each one. Enqueued (not run
        // inline), same shape as the RAG re-index just above. Best-effort.
        await maybeEnqueueSiblingRegateForMergedPr(
          env,
          deliveryId,
          repoFullName,
          payload.action,
          payload.pull_request.merged_at,
          installationId,
          settings,
          otherOpenPullRequests,
        ).catch((error) => {
          /* v8 ignore next -- best-effort: a sibling re-gate enqueue failure is logged, never surfaced to the gate. */
          console.error(
            JSON.stringify({
              level: "warn",
              event: "sibling_regate_enqueue_failed",
              deliveryId,
              repository: repoFullName,
              pullNumber: pr.number,
              error: errorMessage(error),
            }),
          );
        });
      }
    }

    let issueWatchEvents: DetectedNotificationEvent[] = [];
    if (
      payload.repository?.full_name &&
      payload.issue &&
      !payload.issue.pull_request
    ) {
      const issue = await upsertIssueFromGitHub(
        env,
        payload.repository.full_name,
        payload.issue,
      );
      const repo = await getRepository(env, payload.repository.full_name);
      const advisory = buildIssueAdvisory(repo, issue);
      // Issue-side slop triage (#533): opt-in via slopGateMode, advisory-only (issues have no gate, and
      // the issue advisory is maintainer-facing — never a public comment). Flags clearly low-effort issues.
      const issueSettings = await resolveRepositorySettings(
        env,
        payload.repository.full_name,
      );
      if (issueSettings.slopGateMode !== "off") {
        advisory.findings.push(
          ...buildIssueSlopAssessment({ title: issue.title, body: issue.body })
            .findings,
        );
      }
      await persistAdvisory(env, advisory);
      // Account-age visibility (#2561 issue-path parity): label newly opened issues from below-threshold
      // accounts when review_state_label autonomy is auto — same contract as the PR maintenance path.
      if (payload.action === "opened" && installationId && issue.authorLogin) {
        const repoOwner = repoOwnerLoginFromFullName(payload.repository.full_name);
        const authorLogin = issue.authorLogin;
        const authorIsOwner = authorLogin.toLowerCase() === repoOwner.toLowerCase();
        const authorIsAdmin = parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(authorLogin.toLowerCase());
        const authorIsAutomationBot = isProtectedAutomationAuthor(authorLogin);
        const accountAgeThresholdDays = issueSettings.accountAgeThresholdDays;
        if (
          !authorIsOwner &&
          !authorIsAdmin &&
          !authorIsAutomationBot &&
          typeof accountAgeThresholdDays === "number"
        ) {
          if (await isBelowAccountAgeThreshold(env, installationId, authorLogin, accountAgeThresholdDays)) {
            if (resolveAutonomy(issueSettings.autonomy, "review_state_label") === "auto") {
              const newAccountMode = resolveAgentActionMode({
                globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, issueSettings.agentGlobalFreezeOverride)),
                agentPaused: issueSettings.agentPaused,
                agentDryRun: issueSettings.agentDryRun,
              });
              await ensurePullRequestLabel(
                env,
                installationId,
                payload.repository.full_name,
                issue.number,
                issueSettings.newAccountLabel!,
                { createMissingLabel: issueSettings.createMissingLabel, mode: newAccountMode },
              ).catch(
                /* v8 ignore next -- fail-safe: a label-application failure must never block the rest of the handler */
                () => undefined,
              );
            }
          }
        }
      }
      // Per-contributor open-issue cap (#2270, anti-abuse): the first issue-side auto-close path. Best-effort —
      // a failure here must never affect the advisory/notification handling above or the webhook overall.
      if (payload.action === "opened" && installationId) {
        await maybeCloseIssueOverContributorCap(env, {
          installationId,
          repoFullName: payload.repository.full_name,
          issue,
          settings: issueSettings,
          deliveryId,
        }).catch((error) => {
          /* v8 ignore next -- best-effort: an issue-cap enforcement failure is logged, never surfaced to the webhook. */
          console.error(
            JSON.stringify({
              level: "warn",
              event: "contributor_issue_cap_failed",
              deliveryId,
              repository: payload.repository?.full_name,
              issueNumber: issue.number,
              error: errorMessage(error),
            }),
          );
        });
      }
      // #699 path B: a newly opened grabbable, high-multiplier issue notifies the miners watching this repo
      // (fanned out through the same #535 pipeline below).
      if (payload.action === "opened")
        issueWatchEvents = await detectIssueWatchEvents(
          env,
          payload.repository.full_name,
          issue,
        );
    }

    const trustedReviewEvents = await filterTrustedReviewNotificationEvents(
      env,
      payload.installation?.id,
      detectNotificationEvents(eventName, payload),
    );
    const notificationEvents = [...trustedReviewEvents, ...issueWatchEvents];
    for (const notificationEvent of notificationEvents) {
      await recordAuditEvent(env, {
        eventType: "notification.event_detected",
        actor: notificationEvent.actorLogin,
        targetKey: notificationEvent.recipientLogin,
        outcome: "success",
        detail: `${notificationEvent.eventType} for ${notificationEvent.repoFullName}#${notificationEvent.pullNumber}`,
        metadata: {
          deliveryId,
          eventType: notificationEvent.eventType,
          recipientLogin: notificationEvent.recipientLogin,
          repoFullName: notificationEvent.repoFullName,
          pullNumber: notificationEvent.pullNumber,
          dedupKey: notificationEvent.dedupKey,
          deeplink: notificationEvent.deeplink,
        },
      });
    }
    // Batched, but bounded (#selfhost-maintenance-self-pin): a popular issue can have thousands of watchers,
    // so keep queue payloads comfortably below backend message limits while still avoiding one row per event.
    // Sorted by dedupKey BEFORE chunking (#3218 review): jobCoalesceKey hashes each chunk's OWN sorted dedup-key
    // set, so it's already order-independent WITHIN a chunk -- but chunk MEMBERSHIP itself was still built from
    // notificationEvents' arrival order, so a redelivery whose events resolved in a different order could split
    // across a different 100-event boundary and never coalesce with the earlier attempt. Sorting first makes
    // chunk membership a pure function of the detected event SET, not its arrival order, restoring the "same
    // full set in any order" coalescing guarantee across chunk boundaries too.
    const notificationEventsForChunking = [...notificationEvents].sort((a, b) => a.dedupKey.localeCompare(b.dedupKey));
    for (const events of chunkNotificationEvents(notificationEventsForChunking)) {
      await env.JOBS.send({
        type: "notify-evaluate",
        requestedBy: "webhook",
        events,
      });
    }

    await recordWebhookEvent(env, {
      deliveryId,
      eventName,
      action: payload.action,
      installationId: payload.installation?.id,
      repositoryFullName: payload.repository?.full_name,
      payloadHash: "processed",
      status: "processed",
    });
  } catch (error) {
    await recordWebhookEvent(env, {
      deliveryId,
      eventName,
      action: payload.action,
      installationId: payload.installation?.id,
      repositoryFullName: payload.repository?.full_name,
      payloadHash: "processed",
      status: "error",
      errorSummary: errorMessage(error),
    });
    throw error;
  }
}

type PublicSurfaceOutput = "comment" | "label" | "check_run" | "gate_check_run";
type PublicSurfaceOutputFailure = {
  output: PublicSurfaceOutput;
  error: string;
  // Captured AT CATCH TIME, not reconstructed later: errorMessage() already reduces `error` to a plain string by
  // the time it lands here, discarding the `.status`/`.response` shape isGitHubTransientPublishError needs. A
  // permission_missing check-run push (no live error object) is correctly "false" via the default below.
  transient: boolean;
};

// A revoked/expired installation token mid-request, a GitHub 5xx, or a rate-limit blip are all momentary — the
// job should retry, not silently drop a computed review. A 4xx auth/permission/not-found error is not: retrying
// forever would never converge, so it keeps today's swallow-and-audit behavior.
function isGitHubTransientPublishError(error: unknown): boolean {
  if (isGitHubRateLimitedError(error)) return true;
  const status = githubErrorStatus(error);
  return status !== null && status >= 500;
}

// Intentionally writes to check_summaries only, not audit_events (#2908): this fires on every successful gate-
// check publish, which is a very high-frequency event (every review pass, potentially several times per PR as
// it iterates) -- check_summaries is the purpose-built, already-queryable canonical record for "when was this
// check published and what did it conclude" (repo/PR/headSha/checkRunId/conclusion/detailsUrl), so a parallel
// audit_events row would roughly double that table's volume for no new queryable information. The DOWNSTREAM
// actions this verdict triggers (merge/close/hold) are already fully audited via recordNativeGateDecision and
// agent-action-executor's audit() closure. Only the FAILURE/degraded sub-paths of the caller below are audited
// (auditGateCheckPermissionMissing, auditPrVisibilitySkip) -- that asymmetry is deliberate, not a gap.
async function recordPublishedGateCheckSummary(
  env: Env,
  args: {
    repoFullName: string;
    pullNumber: number;
    headSha: string | null | undefined;
    checkRunId: number;
    conclusion: string | null | undefined;
    detailsUrl?: string | undefined;
    deliveryId: string;
  },
): Promise<void> {
  /* v8 ignore next -- createOrUpdateNamedCheckRun returns null without a head SHA, so published results have one. */
  if (!args.headSha) return;
  const completedAt = nowIso();
  await upsertCheckSummary(env, {
    id: String(args.checkRunId),
    repoFullName: args.repoFullName,
    pullNumber: args.pullNumber,
    headSha: args.headSha,
    name: GITTENSORY_GATE_CHECK_NAME,
    status: "completed",
    /* v8 ignore next -- Gate publication always supplies a conclusion; this keeps the DB value defensive. */
    conclusion: args.conclusion ?? null,
    startedAt: null,
    completedAt,
    ...(args.detailsUrl ? { detailsUrl: args.detailsUrl } : {}),
    payload: {
      deliveryId: args.deliveryId,
      source: "gittensory_gate_check",
    },
  });
}

function mergeReadinessGateEnabled(
  settings: Pick<RepositorySettings, "mergeReadinessGateMode">,
): boolean {
  return settings.mergeReadinessGateMode !== "off";
}

export function shouldCollectLinkedIssueEvidence(
  settings: Pick<
    RepositorySettings,
    "requireLinkedIssue" | "linkedIssueGateMode" | "mergeReadinessGateMode"
  >,
): boolean {
  return (
    settings.requireLinkedIssue ||
    settings.linkedIssueGateMode !== "off" ||
    mergeReadinessGateEnabled(settings)
  );
}

// Resolve the author login for each linked issue number. Prefers the local DB cache; on a cache MISS (issue not
// cached, or no recorded author), falls back to a LIVE GitHub fetch so a stale/missing cache can't silently void
// the self_authored_linked_issue anti-farming detection (#audit-3.11). The live token is minted lazily — only
// when at least one issue misses the cache — so the common (fully-cached) path adds no fetch. Each lookup is
// fail-safe: a per-issue error yields null (the detection stays fail-open only on a genuine inability to resolve).
export async function resolveLinkedIssueAuthorLogins(
  env: Env,
  installationId: number | null | undefined,
  repoFullName: string,
  linkedIssues: number[],
  liveFallback = false,
): Promise<(string | null)[]> {
  if (linkedIssues.length === 0) return [];
  const cached = await Promise.all(
    linkedIssues.map((n) =>
      getIssue(env, repoFullName, n)
        .then((i) => i?.authorLogin ?? null)
        .catch(() => null),
    ),
  );
  // The live-fetch fallback only fires when the self-authored gate can actually BLOCK (caller passes
  // liveFallback) — so quiet/advisory paths add no API calls, and we pay the fetch only where a cache miss
  // could otherwise void a hard block.
  if (
    !liveFallback ||
    !installationId ||
    cached.every((login) => login != null)
  )
    return cached;
  const token = await createInstallationToken(env, installationId).catch(
    () => undefined,
  );
  if (!token) return cached;
  const admissionKey = githubAdmissionKeyForToken(env, installationId, token);
  return Promise.all(
    cached.map((login, index) =>
      login != null
        ? Promise.resolve(login)
        : fetchLinkedIssueFacts(env, repoFullName, linkedIssues[index]!, token, admissionKey)
            .then((result) => (result.status === "found" ? result.facts.authorLogin : null)),
    ),
  );
}

// Shared per-call-site resolver for buildPullRequestAdvisory's linked-issue-derived context
// (#unlinked-issue-guardrail-followup). Every gate-evaluating call site (the main webhook path, the cron
// sweep, the heavy re-review pass, and authorized PR actions) already threads `linkedIssueAuthorLogins` the
// same way; bundling the new open-reference check into the SAME resolver keeps all of them in parity rather
// than risking only some remembering to add it. The live open-reference fetch is skipped entirely (resolves
// `true` with no network call) unless `linkedIssueGateMode` is actually "block" -- the only mode where
// whether a citation is open can change the gate's outcome.
export async function resolveLinkedIssueAdvisoryContext(
  env: Env,
  installationId: number | null | undefined,
  repoFullName: string,
  linkedIssues: number[],
  settings: Pick<RepositorySettings, "selfAuthoredLinkedIssueGateMode" | "linkedIssueGateMode">,
): Promise<{ linkedIssueAuthorLogins: (string | null)[]; confirmedNoOpenLinkedIssue: boolean }> {
  const [linkedIssueAuthorLogins, hasOpenReference] = await Promise.all([
    resolveLinkedIssueAuthorLogins(env, installationId, repoFullName, linkedIssues, settings.selfAuthoredLinkedIssueGateMode === "block"),
    settings.linkedIssueGateMode === "block" ? resolveLinkedIssueHasOpenReference({ env, repoFullName, linkedIssues, installationId }) : Promise.resolve(true),
  ]);
  return { linkedIssueAuthorLogins, confirmedNoOpenLinkedIssue: !hasOpenReference };
}

export function shouldCollectSlopEvidence(
  settings: Pick<RepositorySettings, "slopGateMode" | "mergeReadinessGateMode">,
): boolean {
  return settings.slopGateMode !== "off" || mergeReadinessGateEnabled(settings);
}

export async function shouldRefreshFilesForPreMergeChecks(
  env: Env,
  repoFullName: string,
): Promise<boolean> {
  const checks = resolveReviewPreMergeChecks(
    await loadRepoFocusManifest(env, repoFullName).catch(() => null),
  );
  return checks.some((check) => check.whenPaths.length > 0);
}

export function shouldRunSlopAiAdvisory(
  settings: Pick<RepositorySettings, "slopAiAdvisory" | "slopGateMode">,
): boolean {
  return settings.slopAiAdvisory && settings.slopGateMode !== "off";
}

function shouldProcessPullRequestPublicSurface(
  eventName: string,
  action: string | undefined,
): boolean {
  if (eventName === "pull_request_review_comment") {
    return action === "created" || action === "edited" || action === "deleted";
  }
  if (eventName === "pull_request_review_thread") {
    return action === "resolved" || action === "unresolved";
  }
  if (eventName === "pull_request_review") {
    return action === "submitted" || action === "edited" || action === "dismissed";
  }
  return (
    PR_PUBLIC_SURFACE_ACTIONS.has(action ?? "") ||
    PR_GATE_CLOSED_ACTIONS.has(action ?? "")
  );
}

export function gateCheckPolicy(
  settings: RepositorySettings,
  readinessScore?: number | null,
  confirmedContributor?: boolean,
  slopRisk?: number | null,
  authorHistory?: { mergedPrCount: number; closedUnmergedPrCount: number },
  sizeContext?: {
    changedFileCount: number;
    changedLineCount: number;
    guardrailHit: boolean;
    guardrailMatches?: ReturnType<typeof guardrailPathMatches> | undefined;
  },
) {
  // `settings` is already the EFFECTIVE config (`.gittensory.yml` > DB > defaults), resolved upstream by
  // resolveRepositorySettings, so the blocker modes here reflect the repo's config file directly.
  // The `oss-anti-slop` pack (#692) is repo-agnostic and carries no confirmed-contributor field at all (no
  // Gittensor coupling). The `gittensor` pack still threads confirmedContributor for context/telemetry, but
  // it no longer changes the verdict — every author is gated identically. (#gate-nonconfirmed)
  const confirmedContributorForPack =
    settings.gatePack === "oss-anti-slop" ? undefined : confirmedContributor;
  return {
    linkedIssueGateMode: settings.linkedIssueGateMode,
    duplicatePrGateMode: settings.duplicatePrGateMode,
    qualityGateMode: settings.qualityGateMode,
    qualityGateMinScore: settings.qualityGateMinScore ?? null,
    aiReviewGateMode: settings.aiReviewMode,
    // Calibrated AI close-confidence floor (#7) — config-as-code via `.gittensory.yml gate.aiReview.closeConfidence`,
    // resolved into settings upstream. `null`/undefined ⇒ advisory.ts applies the 0.93 default.
    aiReviewCloseConfidence: settings.aiReviewCloseConfidence ?? null,
    // Sub-floor AI-judgment disposition (#4603) — DB-backed (dashboard-settable) + `.gittensory.yml
    // gate.aiReview.lowConfidenceDisposition` override, resolved into settings upstream. `null`/undefined ⇒
    // advisory.ts applies the "hold_for_review" default.
    aiReviewLowConfidenceDisposition: settings.aiReviewLowConfidenceDisposition ?? null,
    readinessScore: readinessScore ?? null,
    slopGateMode: settings.slopGateMode,
    mergeReadinessGateMode: settings.mergeReadinessGateMode,
    manifestPolicyGateMode: settings.manifestPolicyGateMode,
    selfAuthoredLinkedIssueGateMode: settings.selfAuthoredLinkedIssueGateMode,
    linkedIssueSatisfactionGateMode: settings.linkedIssueSatisfactionGateMode,
    firstTimeContributorGrace: settings.firstTimeContributorGrace,
    authorMergedPrCount: authorHistory?.mergedPrCount,
    authorClosedUnmergedPrCount: authorHistory?.closedUnmergedPrCount,
    slopGateMinScore: settings.slopGateMinScore ?? null,
    slopRisk: slopRisk ?? null,
    confirmedContributor: confirmedContributorForPack,
    // PR-size + guardrail manual-review HOLD (#gate-size / #gate-guardrail): the MODE comes from config; the
    // thresholds default to 10 files / 1000 lines (advisory.ts constants); the live counts + guardrail-hit come from
    // the per-PR sizeContext threaded by the caller.
    sizeGateMode: settings.sizeGateMode,
    lockfileIntegrityGateMode: settings.lockfileIntegrityGateMode,
    changedFileCount: sizeContext?.changedFileCount ?? null,
    changedLineCount: sizeContext?.changedLineCount ?? null,
    guardrailHit: sizeContext?.guardrailHit ?? false,
    guardrailMatches: sizeContext?.guardrailMatches,
    // CLA / license-compatibility gate (#2564): the MODE comes from config; the `cla_consent_missing` finding
    // itself (or its absence) is pushed into the advisory upstream by evaluateClaCheck, so this only decides
    // whether isConfiguredGateBlocker escalates it to a hard blocker.
    claGateMode: settings.claGateMode,
    // #gate-dryrun: render the would-be merge/close/manual verdict (advisory promoted to block) without enforcing.
    dryRun: settings.gateDryRun ?? false,
  };
}

async function loadGateAuthorHistory(
  env: Env,
  repoFullName: string,
  author: string | null,
  pullNumber: number,
): Promise<{ mergedPrCount: number; closedUnmergedPrCount: number }> {
  if (!author) return { mergedPrCount: 1, closedUnmergedPrCount: 3 };
  try {
    return await getRepoAuthorPullRequestHistory(
      env,
      repoFullName,
      author,
      pullNumber,
    );
  } catch {
    // Fail closed for firstTimeContributorGrace: if complete author history cannot be determined,
    // make the author ineligible for grace rather than publishing a would-be blocking gate as neutral.
    return { mergedPrCount: 1, closedUnmergedPrCount: 3 };
  }
}

/**
 * Resolve the PR's changed files for the review path, preferring the stored rows and, when they are empty at
 * review time, fetching them inline from GitHub (and persisting them). This fixes diff-less first reviews:
 * the PR-opened webhook can fire the review BEFORE the async detail-sync populated `pull_request_files`, so
 * the AI review / grounding / gate / unified comment built their diff from an EMPTY `listPullRequestFiles`
 * → "0 files / No diff provided", and the review never re-ran. Now the FIRST review sees the real diff.
 *
 * Efficient: stored rows are read once; the inline GitHub fetch happens only when stored is empty, and the
 * result is persisted so every later read in the SAME review run reuses it. Fully fail-safe — a token-mint or
 * fetch failure degrades to the (possibly empty) stored rows, exactly as before this fix.
 */
async function resolvePullRequestFilesForReview(
  env: Env,
  args: { installationId: number; repoFullName: string; pullNumber: number },
): Promise<Awaited<ReturnType<typeof listPullRequestFiles>>> {
  const stored = await listPullRequestFiles(
    env,
    args.repoFullName,
    args.pullNumber,
  );
  if (stored.length > 0) return stored;
  // Stored files are empty (the review fired before detail-sync). Fetch + persist inline from GitHub.
  try {
    const token = await createInstallationToken(env, args.installationId).catch(
      () => undefined,
    );
    /* v8 ignore next -- installation-token failure fallback is covered by public-token fetch paths; this branch depends on token-cache timing. */
    const reviewFilesToken = token ?? env.GITHUB_PUBLIC_TOKEN;
    const admissionKey = githubAdmissionKeyForToken(env, args.installationId, reviewFilesToken);
    const fetched = await fetchAndStorePullRequestFilesForReview(
      env,
      args.repoFullName,
      args.pullNumber,
      reviewFilesToken,
      admissionKey,
    );
    if (fetched.length > 0) {
      console.log(
        JSON.stringify({
          event: "review_files_fetched_inline",
          repository: args.repoFullName,
          pullNumber: args.pullNumber,
          files: fetched.length,
        }),
      );
      return fetched;
    }
  } catch (error) {
    /* v8 ignore next -- fail-safe: an inline fetch failure degrades to the empty stored rows (byte-identical to pre-fix). */
    console.error(
      JSON.stringify({
        level: "warn",
        event: "review_files_inline_fetch_failed",
        repository: args.repoFullName,
        pullNumber: args.pullNumber,
        error: errorMessage(error),
      }),
    );
  }
  return stored;
}

/** Build a bounded unified-diff string from cached PR files for the AI reviewer. Caps total size so a
 *  huge PR cannot blow the model context or the neuron budget; each file's patch is taken from the raw
 *  GitHub file payload when present. */
export function buildAiReviewDiff(
  files: Awaited<ReturnType<typeof listPullRequestFiles>>,
): string {
  // Source-first + hunk-aware + always-list-dropped-files (ported from reviewbot). The old blind 60k
  // head-slice `break`-dropped whole files in stored order, so the file DEFINING a symbol could vanish
  // while another referenced it → the model hallucinated "missing import / undefined symbol" (the #1528
  // class, which survived even with grounding on). (#accuracy-gap-1)
  return buildUnifiedReviewDiff(
    files.map((file) => ({
      path: file.path,
      patch:
        typeof file.payload?.patch === "string"
          ? file.payload.patch
          : undefined,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
  );
}

/**
 * Build the complete inline patch corpus for deterministic secret scanning. Unlike {@link buildAiReviewDiff},
 * this is intentionally unbudgeted and does not reorder files or drop hunks: security controls must inspect
 * every raw patch GitHub returned instead of the lossy AI-review prompt view.
 *
 * GitHub omits inline `patch` for binary/large files; {@link enrichSecretScanFilesWithPatchFallback} recovers
 * scannable `+` lines for those files before this runs (see {@link maybeAddSecretLeakFinding}).
 */
export function buildSecretScanDiff(
  files: Awaited<ReturnType<typeof listPullRequestFiles>>,
): string {
  return files
    .map((file) => {
      const status = file.status ?? "modified";
      const header = `### ${file.path} (${status}) +${file.additions ?? 0}/-${file.deletions ?? 0}`;
      const patch =
        typeof file.payload?.patch === "string" ? file.payload.patch : "";
      return patch ? `${header}\n${patch}` : header;
    })
    .join("\n\n")
    .trim();
}

/**
 * Run the opt-in AI maintainer review and fold it into the gate + panel. Mutates `advisory.findings`
 * with a dual-model consensus defect (when `aiReviewMode: block` and the free Workers-AI pair agrees with
 * high confidence) so it can become a gate blocker BEFORE evaluateGateCheck runs. The default `gittensor`
 * pack keeps AI spend confirmed-contributor gated; `oss-anti-slop` may run the blocking review for any
 * author because that pack is explicitly author-agnostic. Returns the advisory notes for the public panel.
 * Fully fail-safe: disabled / ineligible author / no head SHA / non-ok AI / any thrown error → no finding
 * and no notes.
 */

export async function shouldStartAiReviewForAdvisory(
  env: Env,
  args: {
    settings: RepositorySettings;
    advisory: Pick<Awaited<ReturnType<typeof buildPullRequestAdvisory>>, "headSha">;
    repoFullName: string;
    author: string | null;
    confirmedContributor: boolean;
    skipAiReview?: boolean | undefined;
    // #4507: the caller's own already-computed shouldSkipAiForReputation result, from the SAME gate condition
    // this function uses below (isReputationEnabled && isConvergenceRepoAllowed) -- threaded in so this call makes
    // no second REPUTATION_WINDOW_ROW_CAP-bounded review_targets scan when the caller already ran one this pass.
    // Absent (every existing/direct caller) ⇒ computed here exactly as before.
    preComputedReputationSkip?: boolean | undefined;
  },
): Promise<boolean> {
  if (!shouldRequirePublicAiReviewForAdvisory(env, args)) return false;
  if (args.settings.aiReviewAllAuthors) return true;
  if (!(isReputationEnabled(env) && isConvergenceRepoAllowed(env, args.repoFullName))) return true;
  const reputationSkip =
    args.preComputedReputationSkip ??
    (await shouldSkipAiForReputation(env, { project: args.repoFullName, submitter: args.author }));
  return !reputationSkip;
}

export function maybeAddRequiredAutoReviewSkipHold(
  env: Env,
  args: {
    settings: RepositorySettings;
    advisory: Pick<Awaited<ReturnType<typeof buildPullRequestAdvisory>>, "headSha" | "findings">;
    repoFullName: string;
    author: string | null;
    confirmedContributor: boolean;
    skipAiReview?: boolean | undefined;
    autoReviewSkipReason: string | null;
  },
): boolean {
  if (
    args.autoReviewSkipReason === null ||
    !isContributorControlledAutoReviewSkipReason(args.autoReviewSkipReason) ||
    !shouldRequirePublicAiReviewForAdvisory(env, args)
  ) {
    return false;
  }
  args.advisory.findings.push({
    code: "ai_review_inconclusive",
    severity: "warning",
    title: "Required AI review was skipped by contributor-controlled metadata",
    detail:
      "The repository requires blocking AI review, but review.auto_review matched the PR title or base branch. The gate is held for human review instead of passing automatically.",
    action: "Run AI review with a trusted override or remove the contributor-controlled auto_review match before merging.",
  });
  return true;
}

export function shouldRequirePublicAiReviewForAdvisory(
  env: Env,
  args: {
    settings: RepositorySettings;
    advisory: Pick<Awaited<ReturnType<typeof buildPullRequestAdvisory>>, "headSha">;
    repoFullName: string;
    author: string | null;
    confirmedContributor: boolean;
    skipAiReview?: boolean | undefined;
  },
): boolean {
  const packAllowsAnyAuthorBlockingReview =
    args.settings.gatePack === "oss-anti-slop" &&
    args.settings.aiReviewMode === "block";
  const reviewableAuthor =
    args.confirmedContributor ||
    packAllowsAnyAuthorBlockingReview ||
    args.settings.aiReviewAllAuthors;
  if (
    args.skipAiReview ||
    args.settings.aiReviewMode === "off" ||
    !reviewableAuthor ||
    !args.advisory.headSha ||
    !isEnabled(env.AI_SUMMARIES_ENABLED) ||
    !isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED) ||
    !env.AI
  )
    return false;
  return true;
}

/** Record a quiet auto-review skip (never a gate failure). Exported for unit tests. (#1954) */
export async function auditPullRequestAutoReviewSkip(
  env: Env,
  args: {
    actor: string | null;
    repoFullName: string;
    pullNumber: number;
    deliveryId: string;
    headSha: string | null | undefined;
    skipReason: string;
  },
): Promise<void> {
  const summary = resolveAutoReviewSkipSummary(args.skipReason);
  await recordAuditEvent(env, {
    eventType: "github_app.ai_review_auto_review_skipped",
    actor: args.actor,
    targetKey: `${args.repoFullName}#${args.pullNumber}`,
    outcome: "completed",
    detail: args.skipReason,
    metadata: { deliveryId: args.deliveryId, repoFullName: args.repoFullName, headSha: args.headSha ?? null, summary },
  }).catch(() => undefined);
  await recordGithubProductUsage(env, "ai_review_auto_review_skipped", {
    actor: args.actor,
    repoFullName: args.repoFullName,
    targetKey: `${args.repoFullName}#${args.pullNumber}`,
    outcome: "skipped",
    metadata: { skipReason: args.skipReason, summary },
  });
}

/** Resolve auto-review eligibility for a PR, loading the manifest for deterministic review surfaces before AI-only skips. (#1954) */
export async function resolveAutoReviewSkipForPullRequest(
  env: Env,
  args: {
    authorBlacklisted: boolean;
    isFrozenForManualReview: boolean;
    forceAiReview?: boolean | undefined;
    repoFullName: string;
    pr: { isDraft?: boolean | null; title: string; baseRef?: string | null; number: number; labels?: readonly string[] };
    author: string | null;
    deliveryId: string;
    headSha: string | null | undefined;
    changedPaths?: readonly string[] | undefined;
    addedLineCount?: number | undefined;
    changedFileCount?: number | undefined;
  },
): Promise<{ skipReason: string | null; reviewManifest: FocusManifest | null }> {
  const reviewManifest = await loadRepoFocusManifest(env, args.repoFullName).catch(() => null);
  if (args.authorBlacklisted || args.isFrozenForManualReview) {
    return { skipReason: null, reviewManifest };
  }
  const reviewedCommitCount = await countPublishedAiReviewHeads(env, args.repoFullName, args.pr.number).catch(() => 0);
  const skipReason = resolvePullRequestAutoReviewSkipReason({
    forceAiReview: args.forceAiReview,
    manifest: reviewManifest,
    isDraft: args.pr.isDraft === true,
    author: args.author,
    title: args.pr.title,
    labels: args.pr.labels ?? [],
    changedPaths: args.changedPaths ?? [],
    addedLineCount: args.addedLineCount ?? 0,
    changedFileCount: args.changedFileCount ?? 0,
    baseRef: args.pr.baseRef ?? null,
    reviewedCommitCount,
  });
  if (skipReason) {
    await auditPullRequestAutoReviewSkip(env, {
      actor: args.author,
      repoFullName: args.repoFullName,
      pullNumber: args.pr.number,
      deliveryId: args.deliveryId,
      headSha: args.headSha,
      skipReason,
    });
  }
  return { skipReason, reviewManifest };
}

/** Reuse a cached review manifest when present; otherwise load fail-safely for the AI review pass. (#1954) */
export async function resolveReviewManifestForAiReview(
  env: Env,
  repoFullName: string,
  cachedManifest: FocusManifest | null,
): Promise<FocusManifest | null> {
  return cachedManifest ?? (await loadRepoFocusManifest(env, repoFullName).catch(() => null));
}

/** Resolve `review.visual` (#3609 preview.url_template / #3610 routes) for the before/after capture pipeline —
 *  a deterministic, non-AI feature, so it's resolved independently rather than reusing the AI-review manifest
 *  cache above. Fail-safe: a manifest-load error yields the empty defaults (byte-identical to no config
 *  configured), matching every other `resolveReview*` accessor's null-manifest behavior. */
export async function resolveVisualCaptureConfig(env: Env, repoFullName: string): Promise<VisualConfig> {
  const manifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  return resolveReviewVisualConfig(manifest);
}

async function resolveReviewEnrichmentGithubToken(
  env: Env,
  repoFullName: string,
): Promise<string | undefined> {
  const repo = await getRepository(env, repoFullName);
  const installationToken = repo?.installationId
    ? await createInstallationToken(env, repo.installationId).catch(
        () => undefined,
      )
    : undefined;
  return installationToken ?? env.GITHUB_PUBLIC_TOKEN;
}

export async function runAiReviewForAdvisory(
  env: Env,
  args: {
    // The caller's already-resolved resolveRepoActionMode() result (#token-bleed-spend-gate): a "paused" repo
    // must NEVER reach the LLM call below, full stop -- not just have its GitHub publish suppressed. Every
    // feature-specific gate below (aiReviewMode, confirmedContributor, ...) is independent of this and was, on
    // its own, insufficient: a fleet-wide freeze or per-repo pause with aiReviewMode still "block"/"advisory"
    // spent real tokens for hours on frozen repos before this field existed. "dry_run" still computes (so a
    // maintainer can validate decision logic locally); only "paused" stops spend.
    mode: AgentActionMode;
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    installationId?: number | null | undefined;
    repoFullName: string;
    pr: {
      number: number;
      title: string;
      body?: string | null | undefined;
      baseSha?: string | null | undefined;
      linkedIssues?: number[] | undefined;
    };
    author: string | null;
    confirmedContributor: boolean;
    // Pre-resolved PR files (the caller's resolvePullRequestFilesForReview output). When provided, the AI
    // review + grounding + RAG use these instead of re-reading the stored rows — so a review that fired before
    // detail-sync still sees the REAL diff (FIX B). Omitted (e.g. unit tests) → fall back to the stored read.
    files?: Awaited<ReturnType<typeof listPullRequestFiles>> | undefined;
    // `.gittensory.yml` review.profile (#review-profile), resolved by the caller from the (already-cached)
    // manifest. Threaded in (not loaded here) so the AI review path makes no extra manifest fetch — absent ⇒
    // null ⇒ balanced ⇒ the reviewer prompt is byte-identical.
    reviewProfile?: ReviewProfile | null | undefined;
    // `.gittensory.yml` review.security_focus (#review-security-focus), resolved by the caller from the
    // (already-cached) manifest. Orthogonal to reviewProfile — composes with it rather than replacing it.
    // Absent/false ⇒ the reviewer prompt is byte-identical.
    reviewSecurityFocus?: boolean | undefined;
    // `.gittensory.yml` review.path_instructions (#review-path-instructions), resolved by the caller from the
    // cached manifest. The CONFIG (not a fetch) is threaded in; the per-PR glob match against `files` happens
    // here (pure), so the AI path makes no extra manifest fetch. Absent/empty ⇒ byte-identical reviewer prompt.
    reviewPathInstructions?: ReviewPathInstruction[] | undefined;
    // `.gittensory.yml` review.instructions (#review-instructions): a repo-level maintainer brief, resolved by the
    // caller from the cached manifest, handed to the reviewer on EVERY review (bounded + public-safe at parse time).
    // Absent/null ⇒ byte-identical reviewer prompt.
    reviewInstructions?: string | null | undefined;
    // `.gittensory.yml` review.exclude_paths (#review-exclude-paths), resolved by the caller from the cached
    // manifest. Globs whose files are dropped from the AI review (diff + grounding + RAG) — generated/lockfiles
    // the maintainer doesn't want reviewed. Empty ⇒ every file is reviewed (byte-identical). The gate is unaffected.
    reviewExcludePaths?: string[] | undefined;
    // `.gittensory.yml` review.path_filters (#2043): include + `!`-negation globs applied AFTER exclude_paths to
    // positively scope the AI review. Empty ⇒ every non-excluded file is reviewed (byte-identical). Gate unaffected.
    reviewPathFilters?: string[] | undefined;
    // `.gittensory.yml` review.inline_comments (#inline-comments), resolved by the caller from the cached manifest
    // (the per-repo toggle). Precedence (#4099): the operator flag is a master kill-switch, never bypassable by
    // config; an explicit true/false here now fully controls the feature, bypassing the cutover allowlist; unset
    // stays byte-identical to every repo's behavior before this change (the allowlist alone was never sufficient
    // on its own). Absent ⇒ the reviewer prompt is byte-identical (no findings) for every repo untouched by this.
    reviewInlineComments?: boolean | undefined;
    // `.gittensory.yml` review.finding_categories (#1958), resolved by the caller from the cached manifest. ANDed
    // here with reviewInlineComments (a category has nothing to categorize without an inline finding) to decide
    // whether to ASK the model to self-categorize each inlineFindings item. Absent/false ⇒ byte-identical prompt.
    reviewFindingCategories?: boolean | undefined;
    // `.gittensory.yml` review.ai_model (#selfhost-ai-model-override), resolved by the caller from the cached
    // manifest. Self-host only — overrides that repo's claude-code/codex model+effort, taking priority over the
    // operator's global env vars. Absent/all-null ⇒ byte-identical (global env var, then provider default).
    reviewSelfHostAiModel?: SelfHostAiModelConfig | undefined;
    // `.gittensory.yml` review.impact_map (#2184/#2186), resolved by the caller from the cached manifest. ANDed
    // here with the operator's GITTENSORY_REVIEW_IMPACT_MAP flag (shouldComputeImpactMap) to decide whether to
    // compute the deterministic impact map and splice it into the reviewer prompt as additive reference
    // context. Absent/false ⇒ byte-identical reviewer prompt (no impact-map computation, no RAG query for it).
    reviewImpactMap?: boolean | undefined;
    // `.gittensory.yml` review.culture_profile (#2995), resolved by the caller from the cached manifest. ANDed
    // here with the GITTENSORY_REVIEW_CULTURE_PROFILE global flag to decide whether to append the repo's
    // quality-culture reference block (typical merged-PR size + common labels) to the reviewer prompt. Absent/
    // false ⇒ byte-identical (no section, no extra D1 read).
    reviewCultureProfile?: boolean | undefined;
    // The inbound webhook delivery id that triggered this review (#codex-timeout-fields) — forwarded to a
    // self-host provider's failure log purely for operator correlation; never read by any review logic. Absent
    // (e.g. a sweep/repair fan-out with no single originating delivery, or a unit test) ⇒ the log line omits it.
    deliveryId?: string | undefined;
    // A {@link claimAiReviewLock} claim the CALLER already acquired (#regate-dup-prep) before its own cache-read
    // decision, so the (repo, PR, head, mode) mutex covers that cache-read too — not just this function's
    // expensive section. When supplied and `.acquired`, this function trusts it, skips its OWN claim below
    // entirely, and — critically — does NOT release it in its `finally` (release stays the claiming caller's job,
    // so the lock keeps covering the caller's own post-return cache WRITE too; releasing here the instant this
    // function returns would reopen a narrower version of the exact race this lock exists to close). Absent (the
    // default, and every existing caller) ⇒ this function claims + releases its own lock exactly as before —
    // byte-identical to today.
    preAcquiredAiReviewLock?: TransientLockClaim | undefined;
    // #4507: the caller's own already-computed shouldSkipAiForReputation result, threaded in exactly like
    // preAcquiredAiReviewLock above, so this function's OWN reputationActive gate (below) reuses it instead of
    // re-deriving a second REPUTATION_WINDOW_ROW_CAP-bounded review_targets scan -- but ONLY when it's actually
    // present. Absent (the caller's own plain-allowlist gate condition didn't apply, or a direct/test caller
    // that doesn't thread it) ⇒ this function computes its own, independently authoritative check exactly as
    // before -- correctly handling a per-repo manifest override that disagrees with the allowlist (the
    // divergent-config case where only one of the two call sites' gates evaluates true in practice, so the
    // other's threaded value is never populated to begin with).
    preComputedReputationSkip?: boolean | undefined;
  },
): Promise<
  | {
      notes: string;
      reviewerCount: number;
      inlineFindings: InlineFinding[];
      // Deterministic impact-map entries this pass computed for the AI prompt (#1971), threaded out so the
      // publish site can ALSO render them as the unified comment's "Impact map" collapsible. Empty when the
      // feature is off (flag/manifest) — the render arm keys on `.length`, so off ⇒ no section.
      impactMap?: ImpactMapEntry[] | undefined;
      findings: AdvisoryFinding[];
      metadata?: Record<string, unknown> | undefined;
      cacheable?: boolean | undefined;
      // #regate-churn: distinct from `cacheable` — false ONLY for the lock-contention placeholder below (another
      // pass is concurrently reviewing this exact head RIGHT NOW). That placeholder describes a transient
      // scheduling race, not a real AI opinion, and the concurrent pass it deferred to will itself persist the
      // real result within seconds — so it must never be written at all (not even non-durably), or a later read
      // within the bounded cooldown could replay "another pass is running" long after that pass finished.
      // Defaults to true (persistable) for every other outcome, cacheable or not.
      persistable?: boolean | undefined;
    }
  | undefined
> {
  const packAllowsAnyAuthorBlockingReview =
    args.settings.gatePack === "oss-anti-slop" &&
    args.settings.aiReviewMode === "block";
  // `aiReviewAllAuthors` (per-repo opt-in, default false) widens the AI-spend gate to EVERY author — a self-host
  // operator who wants real reviews on all PRs (incl. their own / unconfirmed contributors) and pays for the AI
  // themselves. Default false ⇒ the confirmed-contributor gate is byte-identical to today.
  const reviewableAuthor =
    args.confirmedContributor ||
    packAllowsAnyAuthorBlockingReview ||
    args.settings.aiReviewAllAuthors;
  if (
    args.mode === "paused" ||
    args.settings.aiReviewMode === "off" ||
    !reviewableAuthor ||
    !args.advisory.headSha
  )
    return undefined;
  // Per-repo cutover gate (GITTENSORY_REVIEW_REPOS): the converged review features (reputation AI-skip,
  // grounding, RAG) activate for THIS repo only when it is allowlisted. Computed once and ANDed into each
  // feature's global flag below. Empty/unset allowlist → false → every converged branch here is unreachable
  // (byte-identical to today) regardless of the global flags.
  const convergedRepoAllowed = isConvergenceRepoAllowed(env, args.repoFullName);
  // Per-repo feature overrides (phase 2): reputation + RAG + grounding (#4100) honor the container-private
  // `.gittensory.yml` `features:` block, falling back to the `convergedRepoAllowed` allowlist when unset
  // (byte-identical default). The (cached) manifest is loaded once and shared, and ONLY when at least one of the
  // three features is globally enabled — so a deploy with all three flags off does no extra read (preserves the
  // no-op default).
  const featureManifest =
    isReputationEnabled(env) || isRagEnabled(env) || isGroundingEnabled(env)
      ? await loadRepoFocusManifest(env, args.repoFullName).catch(() => null)
      : null;
  const reputationActive = resolveConvergedFeature(
    env,
    featureManifest,
    "reputation",
    args.repoFullName,
  );
  const ragActive = resolveConvergedFeature(
    env,
    featureManifest,
    "rag",
    args.repoFullName,
  );
  const groundingActive = resolveConvergedFeature(
    env,
    featureManifest,
    "grounding",
    args.repoFullName,
  );
  // Reputation anti-abuse (convergence, flag-gated by GITTENSORY_REVIEW_REPUTATION). Extends the AI-spend gate above:
  // an INTERNAL low-reputation / burst / new submitter is downgraded to a DETERMINISTIC-ONLY review — the
  // (paid) AI neurons are skipped here exactly as they are for an unconfirmed contributor, so a serial abuser
  // can't make the project spend AI on a flood of low-quality PRs. STRICTLY INTERNAL: the reputation is never
  // surfaced — this only routes the private AI-spend decision. Flag-OFF (default) is an immediate no-op (no DB
  // read, no new branch) → the AI-spend gate is byte-identical to today. Fail-safe (the read degrades to
  // neutral → false on any error).
  if (
    reputationActive &&
    !args.settings.aiReviewAllAuthors &&
    (args.preComputedReputationSkip ??
      (await shouldSkipAiForReputation(env, {
        project: args.repoFullName,
        submitter: args.author,
      })))
  )
    return undefined;
  // Per-(repo, PR, head SHA, mode) advisory lock (#confirmed-bug, mirrors #2129/#2368's claimPrActuationLock):
  // a webhook pass and an agent-regate-pr sweep pass can independently reach this point for the SAME PR at the
  // SAME head, both miss the cache (neither has written yet), and both fire a real, wasteful LLM call that can
  // return different verdicts. Claim before the expensive section below; a pass that loses the race returns the
  // same inconclusive-hold shape the "AI produced no usable verdict" path already returns, so the gate is held
  // (neutral) for a human rather than either pass's independently-decided verdict racing the other's cache write.
  // #regate-dup-prep: prefer the caller's OWN claim (args.preAcquiredAiReviewLock) when it already did one — the
  // caller wraps its own cache-read decision in the SAME lock key, so claiming again here would be this function
  // contending against its own caller's claim (always losing) rather than against a genuinely different pass.
  // Absent (every existing/direct caller) ⇒ claim it here exactly as before.
  const selfClaimedAiReviewLock = args.preAcquiredAiReviewLock === undefined;
  const aiReviewLock =
    args.preAcquiredAiReviewLock ??
    (await claimAiReviewLock(
      env,
      args.repoFullName,
      args.pr.number,
      args.advisory.headSha,
      args.settings.aiReviewMode,
    ));
  if (!aiReviewLock.acquired) return aiReviewLockContendedResult(args.advisory);
  try {
    // BYOK: decrypt the maintainer's provider key only for confirmed contributors when opted in. Falls back to free Workers AI when
    // no key is configured or the encryption secret is unavailable (getDecryptedRepositoryAiKey → null).
    // Apply config-as-code provider/model: a declared provider must match the stored key's provider (else
    // skip BYOK → Workers-AI fallback); a declared model overrides the stored/default model.
    const storedKey =
      args.confirmedContributor && args.settings.aiReviewByok
        ? await getDecryptedRepositoryAiKey(env, args.repoFullName)
        : null;
    const providerKey =
      storedKey &&
      (!args.settings.aiReviewProvider ||
        args.settings.aiReviewProvider === storedKey.provider)
        ? {
            provider: storedKey.provider,
            key: storedKey.key,
            model: args.settings.aiReviewModel ?? storedKey.model,
          }
        : null;
    // FIX B: prefer the caller's pre-resolved files (real diff even on a pre-sync first review); fall back to
    // the stored read when the caller didn't pass them (e.g. unit tests calling this function directly).
    // review.exclude_paths + review.path_filters (#review-exclude-paths / #2043): advisory-mode prose can skip
    // generated/lockfiles and positively scope review targets, but block mode is gate-relevant and must review the
    // full diff so filtered paths cannot bypass AI consensus blockers.
    const allFiles =
      args.files ??
      (await listPullRequestFiles(env, args.repoFullName, args.pr.number));
    const files =
      args.settings.aiReviewMode === "block"
        ? allFiles
        : filterReviewFilesForAi(allFiles, args.reviewExcludePaths ?? [], args.reviewPathFilters ?? []);
    // Grounding (convergence, flag-gated by GITTENSORY_REVIEW_GROUNDING; per-repo `features.grounding` override,
    // #4100). Build the FINISHED CI status + the full content of the changed files so the reviewer verifies its
    // claims against reality instead of guessing. Flag-OFF (default) → we take no new branch at all: NO
    // check/repo load, NO file fetch, and `grounding` is left undefined so the prompt handed to the model is
    // byte-identical to today. Fully fail-safe.
    const grounding =
      groundingActive
        ? await buildReviewGroundingText(env, {
            repoFullName: args.repoFullName,
            headSha: args.advisory.headSha,
            files,
            checks: await listCheckSummaries(
              env,
              args.repoFullName,
              args.pr.number,
            ),
            installationId:
              (await getRepository(env, args.repoFullName))?.installationId ??
              null,
          })
        : undefined;
    // RAG retrieval (convergence, flag-gated by GITTENSORY_REVIEW_RAG). Query the codebase vector index for code/docs
    // semantically related to the changed files and append them as additive reference context — exactly like
    // grounding. Flag-OFF (default) → NO new branch: no adapter use, no vector query, and `ragContext` is left
    // undefined so the prompt is byte-identical to today. Fully fail-safe (a missing/cold index degrades to "").
    const ragContextResult = ragActive
      ? await buildReviewRagContextWithMetrics(env, {
          repoFullName: args.repoFullName,
          title: args.pr.title,
          files: files.map((file) => ({
            path: file.path,
            patch:
              typeof file.payload?.patch === "string"
                ? file.payload.patch
                : undefined,
          })),
        })
      : undefined;
    const ragTelemetry =
      ragContextResult?.telemetry ?? emptyReviewRagTelemetry(false);
    // Deterministic impact map (#2184/#2186), ANDed operator env flag + per-repo review.impact_map opt-in
    // (shouldComputeImpactMap). Reuses the SAME changed files this pass already resolved — no extra fetch.
    // Flag-OFF (default) → NO new branch: no symbol extraction, no RAG query, and `impactMapContext` is left
    // undefined so the prompt is byte-identical to today. Fully fail-safe (computeImpactMap never throws; a
    // missing/cold RAG index degrades to an empty impact map, which formats to "" and appends nothing).
    let impactMapContext: string | undefined;
    // The computed entries are ALSO threaded out of this function (#1971) so the publish site can render the
    // "Impact map" collapsible from the exact same array — no second RAG query. Empty when the feature is off.
    let impactMapEntries: ImpactMapEntry[] = [];
    if (shouldComputeImpactMap(env, args.reviewImpactMap === true)) {
      const [impactMapProject, impactMapRepo] = splitRepoForRag(args.repoFullName);
      const changedSymbols = extractChangedSymbols(
        files.map((file) => ({
          path: file.path,
          patch: typeof file.payload?.patch === "string" ? file.payload.patch : undefined,
        })),
      );
      impactMapEntries = await computeImpactMap(changedSymbols, {
        infra: createReviewAdapters(env),
        project: impactMapProject,
        repo: impactMapRepo,
      });
      impactMapContext = formatImpactMapPromptSection(impactMapEntries);
    }
    // Repo quality-culture profile (#2995, flag-gated by GITTENSORY_REVIEW_CULTURE_PROFILE AND the per-repo
    // `review.culture_profile` opt-in). Derives a compact reference block from the repo's OWN merge history
    // (typical PR size, common accepted labels) and appends it as additive grounding — exactly like RAG. Both
    // gates OFF (default) → NO new branch: no D1 read, and `cultureProfileContext` is left undefined so the
    // prompt is byte-identical to today. Fully fail-safe (any error/insufficient-history degrades to "").
    const cultureProfileContext =
      isRepoCultureProfileEnabled(env) && args.reviewCultureProfile === true
        ? await buildRepoCultureProfileContext(env, args.repoFullName)
        : undefined;
    // Review-enrichment (#1472, flag-gated by GITTENSORY_REVIEW_ENRICHMENT + REES_URL). POST the PR to the external
    // REES for the heavy/external analysis the reviewer can't run (dependency CVEs, secrets, license/EOL/supply-chain);
    // its public-safe brief splices into the prompt next to grounding + RAG. Flag-OFF (default) → no call, no branch,
    // byte-identical prompt. Fully fail-safe (any timeout/error/empty → undefined → review proceeds).
    const enrichmentDiff = buildAiReviewDiff(files);
    const enrichment =
      isEnrichmentEnabled(env) && convergedRepoAllowed
        ? await buildReviewEnrichment(env, {
            repoFullName: args.repoFullName,
            prNumber: args.pr.number,
            headSha: args.advisory.headSha,
            baseSha: args.pr.baseSha ?? null,
            title: args.pr.title,
            body: args.pr.body ?? undefined,
            author: args.author,
            linkedIssue: await resolveEnrichmentLinkedIssue(
              env,
              args.repoFullName,
              resolveEnrichmentLinkedIssueNumbers(
                args.pr.linkedIssues,
                args.pr.body,
                args.repoFullName,
              ),
            ),
            githubToken: isReesGithubTokenForwardingEnabled(env)
              ? await resolveReviewEnrichmentGithubToken(
                  env,
                  args.repoFullName,
                )
              : undefined,
            // The AI-review path loads the focus manifest later (inside runGittensoryAiReview), not before this
            // enrichment call, so there is no already-resolved manifest to pass here; loadRepoFocusManifest is
            // cached per repo, so this is a cache hit rather than an extra fetch. resolveRepoEnrichmentToggles is
            // exactly the load-and-swallow caller (a load error ⇒ no toggles ⇒ default analyzer set).
            enrichmentAnalyzers: await resolveRepoEnrichmentToggles(() =>
              loadRepoFocusManifest(env, args.repoFullName),
            ),
            files,
            diff: enrichmentDiff,
          })
        : undefined;
    // Resolved once and reused for BOTH inlineFindings itself and the finding-categories opt-in layered on top
    // of it (#1958) — a category has nothing to categorize without an inline finding to attach it to.
    const inlineFindingsRequested = shouldRequestInlineFindings(
      env,
      args.repoFullName,
      args.reviewInlineComments,
    );
    const result = await runGittensoryAiReview(env, {
      repoFullName: args.repoFullName,
      prNumber: args.pr.number,
      title: args.pr.title,
      body: args.pr.body ?? undefined,
      diff: enrichmentDiff,
      actor: args.author,
      mode: args.settings.aiReviewMode === "block" ? "block" : "advisory",
      jobId: args.deliveryId,
      providerKey,
      grounding,
      ragContext: ragContextResult?.text,
      cultureProfileContext,
      observability: { rag: ragTelemetry },
      impactMapContext,
      enrichment,
      profile: args.reviewProfile ?? null,
      // Per-repo dual-AI combine/onMerge/reviewers overrides (#2567), resolved by resolveEffectiveSettings from
      // `.gittensory.yml gate.aiReview.*` onto `args.settings`. Absent ⇒ undefined ⇒ runGittensoryAiReview falls
      // back to the operator's AI_REVIEW_PLAN (byte-identical to today). `onMerge` is clamped to the operator's
      // floor INSIDE runGittensoryAiReview (resolveEffectiveAiReviewOnMerge), not here.
      combine: args.settings.aiReviewCombine ?? undefined,
      onMerge: args.settings.aiReviewOnMerge ?? undefined,
      reviewers: args.settings.aiReviewReviewers ?? undefined,
      securityFocus: args.reviewSecurityFocus === true,
      // Self-host per-repo model/effort override (#selfhost-ai-model-override): absent/null fields fall through
      // runGittensoryAiReview -> runWorkersOpinion -> the self-host provider's own global-env/hardcoded default,
      // exactly as if review.ai_model had never been set.
      claudeModel: args.reviewSelfHostAiModel?.claudeModel ?? null,
      claudeEffort: args.reviewSelfHostAiModel?.claudeEffort ?? null,
      codexModel: args.reviewSelfHostAiModel?.codexModel ?? null,
      codexEffort: args.reviewSelfHostAiModel?.codexEffort ?? null,
      ollamaModel: args.reviewSelfHostAiModel?.ollamaModel ?? null,
      openaiModel: args.reviewSelfHostAiModel?.openaiModel ?? null,
      openaiCompatibleModel: args.reviewSelfHostAiModel?.openaiCompatibleModel ?? null,
      anthropicModel: args.reviewSelfHostAiModel?.anthropicModel ?? null,
      // Inline comments (#inline-comments): ask the model for line-anchored findings only when the operator flag,
      // the cutover allowlist, AND the per-repo manifest toggle all pass. Otherwise the prompt is byte-identical.
      inlineFindings: inlineFindingsRequested,
      // review.finding_categories (#1958): ask the model to ALSO self-categorize each inlineFindings item, only
      // when inline findings themselves are being requested (a category has nothing to categorize otherwise).
      findingCategories: shouldRenderFindingCategories(inlineFindingsRequested, args.reviewFindingCategories),
      pathGuidance: resolveReviewPathInstructions(
        args.reviewPathInstructions ?? [],
        files.map((file) => file.path),
      ),
      repoInstructions: args.reviewInstructions ?? null,
      changedFiles: files,
    });
    if (result.status !== "ok") return undefined;
    const findings: AdvisoryFinding[] = [];
    if (result.consensusDefect) {
      findings.push({
        code: "ai_consensus_defect",
        severity: "critical",
        title: `AI reviewers agree on a likely critical defect: ${result.consensusDefect.title}`,
        detail: result.consensusDefect.detail,
        action:
          "Resolve the flagged defect, or override if the AI reviewers are mistaken, then re-run the gate.",
        // Calibrated confidence (#8). This finding ALWAYS blocks under aiReviewGateMode: block regardless of
        // where it falls relative to aiReviewCloseConfidence (isConfiguredGateBlocker never refutes a blocker
        // on confidence alone) -- what varies below the floor is the DISPOSITION (#4603,
        // aiReviewLowConfidenceDisposition): hold_for_review (default) routes the would-be close to manual
        // review instead of one-shot-closing; advisory_only drops it to non-blocking; one_shot ignores the
        // floor. See resolveAiReviewLowConfidenceHold in src/rules/advisory.ts.
        confidence: result.consensusDefect.confidence,
      });
    } else if (result.split) {
      // The reviewers DISAGREED — exactly one flagged a blocking defect. reviewbot's quorum treats any reviewer
      // rejection as a configured AI defect; advisory.ts gates `ai_review_split` like a consensus defect, with
      // the same confidence floor deciding block vs human-review hold. (#ai-review-split)
      findings.push({
        code: "ai_review_split",
        severity: "critical",
        title: "An AI reviewer flagged a likely blocking defect",
        detail:
          "One AI reviewer independently flagged a concrete must-fix defect in this change (the other did not). Under the quorum rule, a single rejection closes the PR; see the review notes for specifics.",
        action:
          "Resolve the flagged defect and open a new pull request, or override if the reviewers are mistaken.",
        // Calibrated confidence (#8) of the lone flagging reviewer. Like the consensus-defect finding above, this
        // ALWAYS blocks under aiReviewGateMode: block regardless of the aiReviewCloseConfidence floor -- the
        // floor only selects the DISPOSITION of a sub-floor finding (#4603, aiReviewLowConfidenceDisposition):
        // hold_for_review (default) holds instead of one-shot-closing; advisory_only drops it to non-blocking;
        // one_shot ignores the floor. A consensus split ALWAYS carries this (combineReviews sets it whenever
        // split is true), so the spread is effectively unconditional; the guard is a defensive belt-and-braces —
        // an absent value degrades to 1.0 in the threshold check (advisory.ts `?? 1`), matching an at-or-above-floor
        // confidence.
        /* v8 ignore next 3 -- a split always carries splitConfidence; the absent arm is an unreachable guard. */
        ...(result.splitConfidence !== undefined
          ? { confidence: result.splitConfidence }
          : {}),
      });
    } else if (result.inconclusive) {
      // Fail-CLOSED (#ai-fail-closed): block-mode AI could not return a usable verdict. Hold the PR for a human
      // (an evaluation-blocker code → neutral gate) rather than letting it pass to auto-merge uncertified.
      findings.push({
        code: "ai_review_inconclusive",
        severity: "warning",
        title: "AI review could not be completed",
        detail:
          "The dual-model AI review did not return a usable verdict for this change.",
        action:
          "The gate is held for a human reviewer rather than passed automatically; it re-evaluates on the next update.",
      });
      // A review that could not be produced is a real failure the maintainer must SEE — surface it to Sentry as an
      // ERROR (this also covers the INCOHERENT_DIFF bail, which parses to a missing opinion → inconclusive). (#1468)
      captureReviewFailure(new Error("AI review inconclusive — no usable verdict for the PR head"), {
        kind: "review",
        reason: "ai_review_inconclusive",
        installationId: args.installationId,
        owner: args.repoFullName.split("/")[0],
        repo: args.repoFullName,
        pr: args.pr.number,
        head_sha: args.advisory.headSha,
        ai_review_mode: args.settings.aiReviewMode,
        reviewer_count: result.reviewerCount,
        public_notes: hasPublicReviewAssessment(result.advisoryNotes),
        /* v8 ignore next -- current review runner always supplies diagnostics for completed AI attempts. */
        review_diagnostics: result.reviewDiagnostics ?? [],
      });
    }
    args.advisory.findings.push(...findings);
    const metadataFor = (
      notes: string | null | undefined,
      inlineFindings: InlineFinding[],
    ): Record<string, unknown> => ({
      rag: attributeReviewRagTelemetry(ragTelemetry, {
        notes,
        findings,
        inlineFindings,
      }),
    });
    if (result.inconclusive && hasPublicReviewAssessment(result.advisoryNotes)) {
      return {
        notes: result.advisoryNotes!,
        reviewerCount: result.reviewerCount,
        inlineFindings: [],
        findings,
        metadata: metadataFor(result.advisoryNotes, []),
        cacheable: false,
      };
    }
    if (hasPublicReviewAssessment(result.advisoryNotes)) {
      return {
        notes: result.advisoryNotes!,
        reviewerCount: result.reviewerCount,
        inlineFindings: result.inlineFindings,
        impactMap: impactMapEntries,
        findings,
        metadata: metadataFor(result.advisoryNotes, result.inlineFindings),
      };
    }
    if (result.inconclusive) {
      return {
        notes:
          "AI review could not be completed for this PR head. Gittensory is holding this PR for manual review instead of relying on deterministic signals alone.",
        reviewerCount: result.reviewerCount,
        inlineFindings: [],
        findings,
        metadata: metadataFor(null, []),
        cacheable: false,
      };
    }
    const unavailableFinding: AdvisoryFinding = {
      code: "ai_review_inconclusive",
      severity: "warning",
      title: "AI review did not produce public notes",
      detail:
        "The configured AI reviewer returned no usable public assessment for this PR head.",
      action:
        "Fix the configured AI provider, then re-run Gittensory review before relying on the result.",
    };
    findings.push(unavailableFinding);
    args.advisory.findings.push(unavailableFinding);
    captureReviewFailure(
      new Error("AI review did not produce public notes for the PR head"),
      {
        kind: "review",
        reason: "ai_review_public_summary_missing",
        installationId: args.installationId,
        owner: args.repoFullName.split("/")[0],
        repo: args.repoFullName,
        pr: args.pr.number,
        head_sha: args.advisory.headSha,
        ai_review_mode: args.settings.aiReviewMode,
        reviewer_count: result.reviewerCount,
        /* v8 ignore next -- current review runner always supplies diagnostics for completed AI attempts. */
        review_diagnostics: result.reviewDiagnostics ?? [],
        configured_reviewers:
          env.AI_REVIEW_PLAN?.reviewers?.map((reviewer) => reviewer.model) ??
          null,
        combine: env.AI_REVIEW_PLAN?.combine ?? null,
      },
    );
    return {
      notes:
        "AI review is unavailable for this PR head. Gittensory is holding this PR for manual review until the configured AI provider returns a usable public review summary.",
      reviewerCount: result.reviewerCount,
      inlineFindings: [],
      findings,
      metadata: metadataFor(null, []),
      cacheable: false,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "ai_review_failed",
        repository: args.repoFullName,
        pullNumber: args.pr.number,
        error: errorMessage(error),
      }),
    );
    captureReviewFailure(error, {
      kind: "review",
      installationId: args.installationId,
      repo: args.repoFullName,
      pr: args.pr.number,
      head_sha: args.advisory.headSha,
    });
    return undefined;
  } finally {
    // #regate-dup-prep: only release a lock THIS call actually claimed. A caller-supplied
    // preAcquiredAiReviewLock must keep covering the caller's own post-return work (e.g. persisting the fresh
    // review to cache) — releasing it here the instant this function returns would free the lock before that
    // write happens, reopening a narrower version of the exact race this lock exists to close.
    if (selfClaimedAiReviewLock)
      await releaseAiReviewLock(
        env,
        args.repoFullName,
        args.pr.number,
        args.advisory.headSha,
        args.settings.aiReviewMode,
        aiReviewLock.ownerToken,
      );
  }
}

/**
 * Safety secrets-scan (convergence, flag-gated by GITTENSORY_REVIEW_SAFETY). Scans the PR diff for leaked secrets and,
 * on a hit, appends ONE critical `secret_leak` finding to the advisory BEFORE evaluateGateCheck runs — the
 * gate treats that code as a hard blocker (rules/advisory.ts), so a committed credential holds the PR. Reuses
 * the already-loaded gate files when present, else loads them lazily. Flag-OFF (default) returns immediately:
 * no finding is produced and the advisory/gate is byte-identical to today. Fail-safe: a load error is
 * swallowed so it can never destabilize the gate.
 */
export async function maybeAddSecretLeakFinding(
  env: Env,
  args: {
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pullNumber: number;
    files: Awaited<ReturnType<typeof listPullRequestFiles>> | null;
    installationId?: number | null | undefined;
    headSha?: string | null | undefined;
    baseSha?: string | null | undefined;
  },
): Promise<void> {
  // UNCONDITIONAL (#audit-3.4): a CONCRETE, real-format committed credential (github_token, aws_access_key, …)
  // is unambiguously a leak regardless of which repo it lands in, so the secret-leak hard block runs for every
  // repo — NOT only the safety-flag-on / allowlisted ones. secretLeakFinding already filters to HARD_SECRET_KINDS
  // (the weak heuristics that false-positive on config/workflow content are dropped), so this never mis-fires.
  try {
    const files =
      args.files ??
      (await listPullRequestFiles(env, args.repoFullName, args.pullNumber));
    let scanFiles = files;
    if (args.headSha && hasPatchLessSecretScanCandidates(files, args.baseSha)) {
      try {
        const fetcher = await makeGithubFileFetcher(env, args.repoFullName, args.installationId);
        scanFiles = await enrichSecretScanFilesWithPatchFallback(files, {
          headSha: args.headSha,
          baseSha: args.baseSha,
          fetcher,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "secret_scan_patch_fallback_failed",
            repository: args.repoFullName,
            pullNumber: args.pullNumber,
            error: errorMessage(error),
          }),
        );
        scanFiles = markEligiblePatchLessFilesIncomplete(files, args.baseSha);
      }
    }
    const incompleteFinding = incompletePatchLessSecretScanFinding(scanFiles);
    if (incompleteFinding) args.advisory.findings.push(incompleteFinding);
    const finding = secretLeakFinding(buildSecretScanDiff(scanFiles));
    if (finding) args.advisory.findings.push(finding);
  } catch (error) {
    /* v8 ignore next -- fail-safe: a file-load error never destabilizes the gate. */
    console.error(
      JSON.stringify({
        level: "error",
        event: "secret_scan_failed",
        repository: args.repoFullName,
        pullNumber: args.pullNumber,
        error: errorMessage(error),
      }),
    );
  }
}

/**
 * Lockfile-tamper-risk scan (#2563, opt-in via `lockfileIntegrityGateMode`). Scans a changed
 * `package-lock.json`'s diff for a `resolved`/`integrity` value that changed without the corresponding
 * `package.json` dependency version changing, or a `resolved` URL outside `registry.npmjs.org`, and on a hit
 * appends ONE warning-severity `lockfile_tamper_risk` finding to the advisory BEFORE evaluateGateCheck runs —
 * the gate treats that code as a blocker only when the repo has set `lockfileIntegrityGateMode: block`
 * (rules/advisory.ts). Mode `off` (the default) skips the scan entirely so the advisory/gate stays
 * byte-identical to today. Fail-safe: a file-load error is swallowed so it can never destabilize the gate.
 */
export async function maybeAddLockfileTamperFinding(
  env: Env,
  args: {
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pullNumber: number;
    lockfileIntegrityGateMode: GateRuleMode | undefined;
    files: Awaited<ReturnType<typeof listPullRequestFiles>> | null;
  },
): Promise<void> {
  if (!args.lockfileIntegrityGateMode || args.lockfileIntegrityGateMode === "off") return;
  try {
    const files =
      args.files ??
      (await listPullRequestFiles(env, args.repoFullName, args.pullNumber));
    const finding = lockfileTamperRiskFinding(files);
    if (finding) args.advisory.findings.push(finding);
  } catch (error) {
    /* v8 ignore next -- fail-safe: a file-load error never destabilizes the gate. */
    console.error(
      JSON.stringify({
        level: "error",
        event: "lockfile_tamper_scan_failed",
        repository: args.repoFullName,
        pullNumber: args.pullNumber,
        error: errorMessage(error),
      }),
    );
  }
}

/**
 * AI-assisted slop advisory (opt-in `slopAiAdvisory`). Appends at most one ADVISORY-only `ai_slop_advisory`
 * finding to the advisory; NEVER touches slopRisk or the gate (only the deterministic core can block). The
 * caller gates on `settings.slopAiAdvisory` and reuses the already-fetched changed files. Like the AI review
 * path, it runs ONLY for confirmed contributors so an unconfirmed/untrusted PR author cannot spend either the
 * shared Workers AI budget or the maintainer-paid BYOK quota. Fail-safe: any AI error is swallowed so the
 * gate still finalizes.
 *
 * `commitThresholdReached` (#ai-slop-repeat-spend): mirrors `ai_review`'s OWN `auto_pause_after_reviewed_commits`
 * cap (`isAutoReviewCommitThresholdReached`) — a PR that's already been reviewed this many times at essentially
 * its current state stops getting a fresh slop advisory too. Before this, every sweep pass re-ran the FULL
 * advisory regardless of how many times the SAME head had already been checked (only a headSha+prompt-fingerprint
 * cache guarded re-spend, so a stale PR the sweep kept re-visiting paid for a fresh attempt on every pass).
 */
export async function runAiSlopForAdvisory(
  env: Env,
  args: {
    // See runAiReviewForAdvisory's doc comment on this same field (#token-bleed-spend-gate) -- a paused repo
    // must never reach the LLM call below, independent of settings.slopAiAdvisory.
    mode: AgentActionMode;
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pr: { number: number; title: string; body?: string | null | undefined };
    author: string | null;
    files: Awaited<ReturnType<typeof listPullRequestFiles>>;
    deterministicBand: SlopBand;
    confirmedContributor: boolean;
    commitThresholdReached: boolean;
  },
): Promise<void> {
  // Confirmed-contributor gate (matches runAiReviewForAdvisory): no AI spend — free OR BYOK — on a PR from
  // an unconfirmed author. The deterministic slop core still ran for everyone; only the AI layer is gated.
  if (args.mode === "paused" || !args.confirmedContributor || !args.advisory.headSha) return;
  if (args.commitThresholdReached) {
    await recordAuditEvent(env, {
      eventType: "github_app.ai_slop_auto_review_skipped",
      actor: args.author,
      targetKey: `${args.repoFullName}#${args.pr.number}`,
      outcome: "completed",
      detail: "slop advisory paused (commit threshold); this head has already been reviewed enough times",
      metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return;
  }
  try {
    // BYOK (opt-in): reuse the repo's encrypted key + aiReviewByok flag — one BYOK key serves both AI
    // features. A declared provider must match the stored key's provider, else skip BYOK (Workers-AI
    // fallback). The contributor is already confirmed (early return above), so BYOK billing is authorized.
    // The slop advisory stays advisory-only regardless of which model writes it.
    const storedKey = args.settings.aiReviewByok
      ? await getDecryptedRepositoryAiKey(env, args.repoFullName)
      : null;
    const providerKey =
      storedKey &&
      (!args.settings.aiReviewProvider ||
        args.settings.aiReviewProvider === storedKey.provider)
        ? {
            provider: storedKey.provider,
            key: storedKey.key,
            model: args.settings.aiReviewModel ?? storedKey.model,
          }
        : null;
    // #ai-slop-cache: repeated scheduled sweeps at an unchanged prompt reuse the stored result instead of
    // re-spending up to 6 free-tier attempts (or a BYOK call) on every tick. The fingerprint includes the
    // provider identity plus the prompt-shaping inputs that can drift for the same head SHA (PR edits,
    // retarget/base-diff changes, or deterministic-band setting changes).
    const aiSlopDiff = buildAiReviewDiff(args.files);
    const inputFingerprint = await aiSlopCacheInputFingerprint({
      title: args.pr.title,
      body: args.pr.body ?? null,
      diff: aiSlopDiff,
      deterministicBand: args.deterministicBand,
      byok: Boolean(providerKey),
      provider: providerKey?.provider,
      model: providerKey?.model,
    });
    const cachedSlop = await getCachedAiSlopAdvisory(env, args.repoFullName, args.pr.number, args.advisory.headSha, inputFingerprint).catch(() => null);
    let result: Awaited<ReturnType<typeof runGittensoryAiSlopAdvisory>>;
    if (cachedSlop) {
      result = { status: "ok", finding: cachedSlop.finding, band: cachedSlop.band as SlopBand | null, estimatedNeurons: cachedSlop.estimatedNeurons };
      incr("gittensory_ai_slop_cache_hit_total");
      await recordAuditEvent(env, {
        eventType: "github_app.ai_slop_cache_hit",
        actor: args.author,
        targetKey: `${args.repoFullName}#${args.pr.number}`,
        outcome: "completed",
        detail: "reused a stored AI slop advisory instead of re-spending an LLM call",
        /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
        metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null },
      }).catch(() => undefined);
    } else {
      incr("gittensory_ai_slop_cache_miss_total");
      await recordAuditEvent(env, {
        eventType: "github_app.ai_slop_cache_miss",
        actor: args.author,
        targetKey: `${args.repoFullName}#${args.pr.number}`,
        outcome: "completed",
        detail: "no reusable stored AI slop advisory for this head+fingerprint; running a fresh advisory",
        /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
        metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null },
      }).catch(() => undefined);
      result = await runGittensoryAiSlopAdvisory(withAdvisoryAiEnv(env, args.settings.advisoryAiRouting?.slop === true), {
        repoFullName: args.repoFullName,
        prNumber: args.pr.number,
        title: args.pr.title,
        body: args.pr.body ?? undefined,
        diff: aiSlopDiff,
        actor: args.author,
        deterministicBand: args.deterministicBand,
        providerKey,
      });
      // Only "ok" actually spent the LLM call (free-tier attempts or a BYOK call) — disabled/unavailable/
      // quota_exceeded all short-circuit BEFORE any provider call, so caching them would suppress a legitimate
      // retry once the condition clears without having saved anything.
      if (result.status === "ok") {
        await putCachedAiSlopAdvisory(env, args.repoFullName, args.pr.number, args.advisory.headSha, inputFingerprint, {
          status: result.status,
          band: result.band,
          finding: result.finding,
          estimatedNeurons: result.estimatedNeurons,
        }).catch((error) => {
          incr("gittensory_ai_slop_cache_write_error_total");
          return recordAuditEvent(env, {
            eventType: "github_app.ai_slop_cache_write_error",
            actor: args.author,
            targetKey: `${args.repoFullName}#${args.pr.number}`,
            outcome: "error",
            detail: errorMessage(error),
            /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
            metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null },
          }).catch(() => undefined);
        });
      }
    }
    if (result.status === "ok" && result.finding)
      args.advisory.findings.push(result.finding);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "ai_slop_failed",
        repository: args.repoFullName,
        pullNumber: args.pr.number,
        error: errorMessage(error),
      }),
    );
  }
}

/**
 * Run the linked-issue satisfaction assessment for advisory purposes (#1961/#3906) — opt-in via
 * `linkedIssueSatisfactionGateMode != "off"`. Assesses only the PR's PRIMARY (first) linked issue: v1 chooses
 * cost/complexity over completeness for the multi-linked-issue case (each additional issue would need its own
 * bounded model-call budget on top of an already-bounded retry/fallback loop), and the concrete repro this
 * closes (JSONbored/metagraphed PR #3910) cited exactly one issue. A future slice could widen this to assess
 * every linked issue independently; documented here rather than built speculatively.
 *
 * Returns the resolved `{status, rationale}` for the caller to thread into the comment's dedicated "Linked
 * issue satisfaction" section (both `advisory` and `block` modes render it) — or `null` when nothing usable
 * was produced (no linked issue, the issue couldn't be fetched, the model produced nothing publishable, or a
 * low-confidence "unaddressed" call degraded to no finding — see buildLinkedIssueSatisfactionResult's own
 * fail-safe contract). In `block` mode, an above-confidence-floor "unaddressed" verdict ALSO pushes a
 * `linked_issue_scope_mismatch` finding into `args.advisory.findings` so `isConfiguredGateBlocker` can block
 * the gate; `advisory` mode never pushes a finding — the dedicated rendered section is the only surface, so a
 * repo running advisory-only never ALSO sees the same gap restated as a generic Nit line.
 *
 * Like `runAiSlopForAdvisory`, this runs ONLY for confirmed contributors so an unconfirmed/untrusted PR author
 * cannot spend either the shared Workers AI budget or the maintainer-paid BYOK quota. Fail-safe: any error is
 * swallowed so the gate still finalizes.
 */
export async function runLinkedIssueSatisfactionForAdvisory(
  env: Env,
  args: {
    // See runAiReviewForAdvisory's doc comment on this same field (#token-bleed-spend-gate) -- a paused repo
    // must never reach the LLM call below, independent of settings.linkedIssueSatisfactionGateMode.
    mode: AgentActionMode;
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pr: { number: number; title: string; body?: string | null | undefined; linkedIssues: number[] };
    author: string | null;
    files: Awaited<ReturnType<typeof listPullRequestFiles>>;
    confirmedContributor: boolean;
    installationId: number;
  },
): Promise<{ status: "addressed" | "partial" | "unaddressed"; rationale: string } | null> {
  if (args.mode === "paused" || !args.confirmedContributor || !args.advisory.headSha) return null;
  const primaryIssueNumber = args.pr.linkedIssues[0];
  if (primaryIssueNumber === undefined) return null;
  try {
    // Dedicated fetch (independent of resolveLinkedIssueAdvisoryContext's own, narrower, conditional fetch) so
    // this feature's issue-text needs stay self-contained regardless of whether linkedIssueGateMode is also
    // configured for this repo. A modest bounded extra GitHub call when BOTH features are enabled for the same
    // repo is an acceptable, minor cost for keeping each feature isolated and easy to reason about.
    const token = (await createInstallationToken(env, args.installationId).catch(() => undefined)) ?? env.GITHUB_PUBLIC_TOKEN;
    const admissionKey = githubAdmissionKeyForToken(env, args.installationId, token);
    const issueFetch = await fetchLinkedIssueFacts(env, args.repoFullName, primaryIssueNumber, token, admissionKey);
    // Fail-safe: no confirmed issue text -> no assessment (mirrors buildLinkedIssueSatisfactionResult's own
    // contract). A fetch error or a confirmed-not-found issue both yield no assessment rather than a guess.
    if (issueFetch.status !== "found") return null;
    const issueText = [issueFetch.facts.title, issueFetch.facts.body]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n");
    if (!issueText.trim()) return null;

    // BYOK (opt-in): reuse the repo's encrypted key + aiReviewByok flag, exactly like runAiSlopForAdvisory —
    // one BYOK key serves every AI feature.
    const storedKey = args.settings.aiReviewByok
      ? await getDecryptedRepositoryAiKey(env, args.repoFullName)
      : null;
    const providerKey =
      storedKey &&
      (!args.settings.aiReviewProvider ||
        args.settings.aiReviewProvider === storedKey.provider)
        ? {
            provider: storedKey.provider,
            key: storedKey.key,
            model: args.settings.aiReviewModel ?? storedKey.model,
          }
        : null;
    const diff = buildAiReviewDiff(args.files);
    // #linked-issue-satisfaction-cache: the assessment's LLM call is fully deterministic for the same
    // reviewer configuration and prompt. GitHub issue/PR text can be edited without changing the head SHA, so
    // those prompt fields are part of this fingerprint rather than relying only on the row key.
    const inputFingerprint = await linkedIssueSatisfactionCacheInputFingerprint({
      byok: Boolean(providerKey),
      provider: providerKey?.provider,
      model: providerKey?.model,
      issueText,
      prTitle: args.pr.title,
      prBody: args.pr.body ?? undefined,
      diff,
    });
    const cached = await getCachedLinkedIssueSatisfaction(
      env,
      args.repoFullName,
      args.pr.number,
      args.advisory.headSha,
      primaryIssueNumber,
      inputFingerprint,
    ).catch(() => null);
    let result: Awaited<ReturnType<typeof runGittensoryLinkedIssueSatisfaction>>;
    if (cached) {
      result = { status: "ok", result: cached.result, estimatedNeurons: cached.estimatedNeurons };
      incr("gittensory_linked_issue_satisfaction_cache_hit_total");
      await recordAuditEvent(env, {
        eventType: "github_app.linked_issue_satisfaction_cache_hit",
        actor: args.author,
        targetKey: `${args.repoFullName}#${args.pr.number}`,
        outcome: "completed",
        detail: "reused a stored linked-issue satisfaction assessment instead of re-spending an LLM call",
        /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
        metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null, linkedIssueNumber: primaryIssueNumber },
      }).catch(() => undefined);
    } else {
      incr("gittensory_linked_issue_satisfaction_cache_miss_total");
      await recordAuditEvent(env, {
        eventType: "github_app.linked_issue_satisfaction_cache_miss",
        actor: args.author,
        targetKey: `${args.repoFullName}#${args.pr.number}`,
        outcome: "completed",
        detail: "no reusable stored linked-issue satisfaction assessment for this head+issue+fingerprint; running a fresh assessment",
        /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
        metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null, linkedIssueNumber: primaryIssueNumber },
      }).catch(() => undefined);
      result = await runGittensoryLinkedIssueSatisfaction(env, {
        repoFullName: args.repoFullName,
        prNumber: args.pr.number,
        issueText,
        prTitle: args.pr.title,
        prBody: args.pr.body ?? undefined,
        diff,
        actor: args.author,
        providerKey,
      });
      // Only "ok" actually spent the LLM call (free-tier attempts or a BYOK call) — disabled/unavailable/
      // quota_exceeded all short-circuit BEFORE any provider call, so caching them would suppress a legitimate
      // retry once the condition clears without having saved anything.
      if (result.status === "ok") {
        await putCachedLinkedIssueSatisfaction(
          env,
          args.repoFullName,
          args.pr.number,
          args.advisory.headSha,
          primaryIssueNumber,
          inputFingerprint,
          { status: result.status, result: result.result, estimatedNeurons: result.estimatedNeurons },
        ).catch((error) => {
          incr("gittensory_linked_issue_satisfaction_cache_write_error_total");
          return recordAuditEvent(env, {
            eventType: "github_app.linked_issue_satisfaction_cache_write_error",
            actor: args.author,
            targetKey: `${args.repoFullName}#${args.pr.number}`,
            outcome: "error",
            detail: errorMessage(error),
            /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
            metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null, linkedIssueNumber: primaryIssueNumber },
          }).catch(() => undefined);
        });
      }
    }
    if (result.status !== "ok" || !result.result) return null;
    // `block` mode: an above-confidence-floor "unaddressed" verdict becomes a hard blocker. `advisory` mode
    // never pushes a finding here — the dedicated rendered section (populated via this function's return
    // value, regardless of mode) is the only surface for that mode, so the same gap is never ALSO shown as a
    // generic advisory Nit line.
    if (args.settings.linkedIssueSatisfactionGateMode === "block" && result.result.status === "unaddressed") {
      args.advisory.findings.push({
        code: "linked_issue_scope_mismatch",
        severity: "warning",
        title: "Linked issue does not appear to be satisfied",
        detail: result.result.rationale,
        action: "Confirm this PR actually addresses the linked issue's scope, or link the correct issue.",
        publicText: `AI assessment: this PR does not appear to satisfy its linked issue's scope. ${result.result.rationale}`,
      });
    }
    return { status: result.result.status, rationale: result.result.rationale };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "linked_issue_satisfaction_failed",
        repository: args.repoFullName,
        pullNumber: args.pr.number,
        error: errorMessage(error),
      }),
    );
    return null;
  }
}

/**
 * Duplicate-winner adjudication (#dup-winner) seam for the close-reason disposition. Given a PR's open
 * duplicate-sibling numbers (from {@link linkedIssueDuplicatePullRequestsForGate}, open-only), return the
 * `linkedDuplicateCount` the agent planner reads. When the flag is ON and this PR is the cluster winner, return
 * 0 so the winner's close reason OMITS the "duplicate of another open PR" cause (agent-actions only adds it
 * when count > 0). Flag-OFF (default) returns the real sibling count — byte-identical to today.
 */
export function dupWinnerLinkedDuplicateCount(
  openSiblings: Pick<PullRequestRecord, "number" | "linkedIssueClaimedAt" | "createdAt">[],
  prNumber: number,
  linkedIssueClaimedAt: string | null | undefined,
  duplicateWinnerEnabled: boolean,
  createdAt?: string | null | undefined,
): number {
  if (
    duplicateWinnerEnabled &&
    isDuplicateClusterWinnerByClaim({ number: prNumber, linkedIssueClaimedAt, createdAt }, openSiblings)
  )
    return 0;
  return openSiblings.length;
}

/**
 * Duplicate-winner adjudication (#dup-winner-credit) seam for naming the cluster's actual winner in a loser's
 * close comment. Returns `null` (generic "duplicate of another open PR" wording, byte-identical to before this
 * existed) when the flag is off, this PR IS the winner (nothing to name — its close reason omits the cause
 * entirely via {@link dupWinnerLinkedDuplicateCount}), or the election is too ambiguous to name a specific
 * winner ({@link resolveDuplicateClusterWinnerNumber}'s fail-closed `null`).
 */
export function dupWinnerLinkedDuplicateWinnerNumber(
  openSiblings: Pick<PullRequestRecord, "number" | "linkedIssueClaimedAt" | "createdAt">[],
  prNumber: number,
  linkedIssueClaimedAt: string | null | undefined,
  duplicateWinnerEnabled: boolean,
  createdAt?: string | null | undefined,
): number | null {
  if (!duplicateWinnerEnabled) return null;
  const winner = resolveDuplicateClusterWinnerNumber({ number: prNumber, linkedIssueClaimedAt, createdAt }, openSiblings);
  return winner === null || winner === prNumber ? null : winner;
}

/**
 * Live-reconcile the duplicate cluster's open siblings before the winner is elected (#dup-winner / audit #15).
 *
 * The stored open-PR cache ({@link listOtherOpenPullRequests}) lags GitHub: a sibling that was closed/merged on
 * GitHub but is still cached `open` would keep "winning" the duplicate cluster, demoting the real lowest-OPEN PR
 * to a loser and auto-closing it via the `duplicate_pr_risk` blocker. Only a LOWER-numbered overlapping sibling
 * can demote this PR from winner, so re-fetch the LIVE state of just those siblings and drop any that are no
 * longer open. Then the downstream election ({@link isDuplicateClusterWinner}) reflects ground truth.
 *
 * FAIL-OPEN to the stored state: a sibling is dropped ONLY on a positive "not open" confirmation — an unreadable
 * live fetch keeps it, so a transient GitHub hiccup never newly spares a real loser. Flag-OFF (default), no
 * linked issues, or no lower overlapping sibling ⇒ returns the input unchanged with no extra API calls.
 */
export async function reconcileLiveDuplicateSiblings(
  env: Env,
  installationId: number | null,
  repoFullName: string,
  pr: PullRequestRecord,
  otherOpenPullRequests: PullRequestRecord[],
): Promise<PullRequestRecord[]> {
  if (env.GITTENSORY_DUPLICATE_WINNER !== "true") return otherOpenPullRequests;
  const linkedIssues = new Set(pr.linkedIssues);
  if (linkedIssues.size === 0) return otherOpenPullRequests;
  const overlapping = otherOpenPullRequests.filter(
    (other) =>
      other.state === "open" &&
      other.linkedIssues.some((issue) => linkedIssues.has(issue)),
  );
  if (overlapping.length === 0) return otherOpenPullRequests;
  const installationToken =
    installationId === null
      ? undefined
      : await createInstallationToken(env, installationId).catch(
          () => undefined,
        );
  const token = installationToken ?? env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubAdmissionKeyForToken(env, installationId, token);
  const staleClosed = new Set<number>();
  await Promise.all(
    overlapping.map(async (sibling) => {
      // #2537: deliberately NOT durable-cached (flagged by the gate's own review) -- despite recomputing every
      // delivery, this reconcile feeds duplicate-winner selection, which can auto-CLOSE the CURRENT PR when
      // duplicateWinnerEnabled. A cached "open" read up to PR_STATE_CACHE_MAX_AGE_MS stale after a missed
      // `closed` webhook would keep an already-closed sibling eligible as the winner, wrongly closing this PR
      // as the loser. That is the same class of irreversible-actuation risk the merge/close decision and
      // gate-override guard against, so this stays on the raw live fetch like they do.
      const liveState = await fetchLivePullRequestState(
        env,
        repoFullName,
        sibling.number,
        token,
        admissionKey,
      ).catch(() => undefined);
      if (liveState !== undefined && liveState !== "open")
        staleClosed.add(sibling.number);
    }),
  );
  if (staleClosed.size === 0) return otherOpenPullRequests;
  return otherOpenPullRequests.filter(
    (other) => !staleClosed.has(other.number),
  );
}

export function linkedIssueDuplicatePullRequestsForGate(
  pr: PullRequestRecord,
  pullRequests: PullRequestRecord[],
): number[] {
  return linkedIssueDuplicatePullRequestRecordsForGate(pr, pullRequests).map((otherPr) => otherPr.number);
}

export function linkedIssueDuplicatePullRequestRecordsForGate(
  pr: PullRequestRecord,
  pullRequests: PullRequestRecord[],
): PullRequestRecord[] {
  const linkedIssues = new Set(pr.linkedIssues);
  if (linkedIssues.size === 0) return [];
  return [
    ...new Map(
      pullRequests.flatMap((otherPr) => {
        if (otherPr.number === pr.number || otherPr.state !== "open") return [];
        return otherPr.linkedIssues.some((issue) => linkedIssues.has(issue)) ? [[otherPr.number, otherPr] as const] : [];
      }),
    ).values(),
  ].sort((left, right) => left.number - right.number);
}

async function auditGateCheckPermissionMissing(
  env: Env,
  actor: string | null,
  repoFullName: string,
  pullNumber: number,
  deliveryId: string,
  warning: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.gate_check_permission_missing",
    actor,
    targetKey: `${repoFullName}#${pullNumber}`,
    outcome: "error",
    detail: warning,
    metadata: { deliveryId, repoFullName },
  });
  // Surface the install-wide Checks:write gap to Sentry — until the scope is granted the required gate check-run
  // silently never posts on ANY PR for this install; an operator must SEE this config fault, not just the ledger.
  console.error(JSON.stringify({ level: "error", event: "gate_check_permission_missing", message: warning, repository: repoFullName, pullNumber, deliveryId }));
}

/**
 * Map a PR's realized terminal state + the gate verdict to the {@link SubmissionOutcome} the reputation table
 * records — or `undefined` when there is no terminal signal to record yet. Pure + total; uses ONLY the PR
 * state / merged flag and the gate conclusion (no PR content):
 *   • merged (the webhook payload's merged_at, or the persisted mergedAt) → "merged" (ground-truth success).
 *   • closed without merge → "closed".
 *   • still open but the gate routed it to manual review (failure / action_required) → "manual".
 *   • still open and the gate did not flag it → undefined (no terminal outcome — nothing to record).
 * Internal-only; the result is never surfaced. Used only when GITTENSORY_REVIEW_REPUTATION is ON.
 */
export function reputationOutcomeFromTerminalState(
  pr: { state: string; mergedAt?: string | null | undefined },
  payload: { merged_at?: string | null | undefined } | undefined,
  gate: ReturnType<typeof evaluateGateCheck> | undefined,
): SubmissionOutcome | undefined {
  const merged = Boolean(payload?.merged_at) || Boolean(pr.mergedAt);
  if (pr.state !== "open") return merged ? "merged" : "closed";
  if (
    gate &&
    (gate.conclusion === "failure" || gate.conclusion === "action_required")
  )
    return "manual";
  return undefined;
}

/**
 * Open-PR file-path collision (#2653): enrich `changedFiles` on the reviewed PR and its open siblings from the
 * `pull_request_files` cache, so `buildCollisionReport`'s existing termOverlap heuristic (which already tokenizes
 * `changedFiles` for merged PRs, see recentMergedItem) gets real path signal for open-vs-open pairs too — not
 * just title/label/linked-issue text. A single bounded D1 read (no GitHub API calls): siblings are populated by
 * the routine detail-sync backfill independent of this flag, so this is a cache read, not a live fetch. Only
 * `PullRequestRecord`s already carrying no `changedFiles` are overwritten; entries missing from the cache (e.g. a
 * brand-new PR reviewed before its first detail-sync) are left as-is and simply carry no path signal this pass —
 * a fail-safe degrade, not an error, and the next scheduled re-gate sweep picks it up once synced.
 */
export async function enrichOpenPullRequestsWithChangedFiles(env: Env, repoFullName: string, pullRequests: PullRequestRecord[]): Promise<PullRequestRecord[]> {
  const openPullNumbers = pullRequests.filter((candidate) => candidate.state === "open").map((candidate) => candidate.number);
  if (openPullNumbers.length === 0) return pullRequests;
  const filePaths = await listRepoPullRequestFilePaths(env, repoFullName, { pullNumbers: openPullNumbers });
  if (filePaths.length === 0) return pullRequests;
  const pathsByPullNumber = new Map<number, string[]>();
  for (const row of filePaths) {
    const paths = pathsByPullNumber.get(row.pullNumber) ?? [];
    paths.push(row.path);
    pathsByPullNumber.set(row.pullNumber, paths);
  }
  return pullRequests.map((candidate) => {
    const paths = pathsByPullNumber.get(candidate.number);
    return paths ? { ...candidate, changedFiles: paths } : candidate;
  });
}

// GITTENSORY-5: a transient publish failure (rate limit / GitHub 5xx / momentary token issue) used to be
// swallowed and only audited — the job still completed "successfully" from the queue's point of view, so a
// review that computed real output silently never reached the PR, with no retry. Extending RetryableJobError
// (same shape as RetryablePullRequestFreshnessUnavailableError / PrActuationLockContendedError above) makes the
// queue retry the whole job instead. Thrown only when NOTHING published at all (see finishPublicSurfacePublication)
// and at least one failure was transient — a permanent 4xx keeps today's swallow-and-audit behavior.
class RetryablePublicSurfacePublishFailedError extends RetryableJobError {
  constructor(repoFullName: string, prNumber: number) {
    super(`public-surface publish failed transiently for ${repoFullName}#${prNumber}; retrying`, {
      retryAfterMs: 60_000,
      retryKind: "public_surface_publish_transient",
    });
    this.name = "RetryablePublicSurfacePublishFailedError";
  }
}

/** A vision-capable self-host provider's `.run()` — mirrors ai-slop.ts's `AiRunner` (same loose shape for a
 *  `env.AI`-family binding called outside the SelfHostAi/RagInfra type boundaries), scoped locally since it
 *  is not exported. */
type SelfHostVisionRunner = { run?: (model: string, options: Record<string, unknown>) => Promise<unknown> };

/** Self-host local vision (#4335): calls the dedicated `env.AI_VISION` binding (ollama + a vision-language
 *  model) the SAME way `env.AI_EMBED` is called for embeddings — a binding kept separate from the review
 *  chain so a vision request never competes with/degrades review-model routing. The `model` argument is a
 *  placeholder: `createOpenAiCompatibleAi`'s chat path prefers its own construction-time-configured model
 *  (AI_VISION_MODEL) over whatever string is passed here (see `resolveModel` in `selfhost/ai.ts`). Fail-safe
 *  on every path, exactly like `callAiProvider`'s BYOK sibling: no binding / no `.run` / a thrown error / an
 *  unparseable response all degrade to `null`, never a thrown error reaching the caller. */
async function runSelfHostVisualVision(env: Env, system: string, user: string, images: readonly AiContentBlock[]): Promise<string | null> {
  const ai = env.AI_VISION as unknown as SelfHostVisionRunner | undefined;
  if (!ai || typeof ai.run !== "function") return null;
  try {
    const result = (await ai.run("visual-vision", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: [{ type: "text", text: user }, ...images] },
      ],
      max_tokens: 600,
      // Bounds per-request KV cache on a concurrency-constrained GPU (#4327/#4335 concurrency tuning docs
      // this exact figure) -- without a cap, vision's larger-than-text context can exhaust VRAM under
      // concurrent load faster than the embed model does, degrading to latency collapse rather than a clean
      // OOM. Ignored by every non-Ollama provider (embeddings, subscription CLIs, Anthropic).
      providerOptions: { num_ctx: 4096 },
    })) as { response?: string } | null;
    return result?.response?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * AI-vision analysis of a confirmed visual regression (#4111 wiring): the existing pixel-diff threshold can
 * tell "the pixels changed" but not "does it look broken" — a route the capture pipeline already flagged
 * changed gets ONE more look from a real vision-capable model. Mirrors runAiReviewForAdvisory's own shape
 * (resolve reputation + BYOK, gate, call, parse, mutate `args.advisory.findings`) so it can be exercised
 * directly in tests without driving the full webhook pipeline. STRICTLY ADVISORY: `visual_regression_finding`
 * can never become a gate blocker (see visual-findings.ts's header) — this only ever adds a "Visual findings"
 * collapsible to the comment. Never throws: any failure (a broken image fetch, a provider error, an
 * unparseable response) degrades to "no finding added", exactly like the capture block it runs after.
 */
export async function runVisualVisionForAdvisory(
  env: Env,
  args: {
    // See runAiReviewForAdvisory's doc comment on this same field (#token-bleed-spend-gate) -- a paused repo
    // must never reach the vision-model call below.
    mode: AgentActionMode;
    repoFullName: string;
    pr: { number: number };
    author: string | null;
    confirmedContributor: boolean;
    settings: RepositorySettings;
    advisory: { findings: AdvisoryFinding[] };
    routes: readonly CaptureRoute[];
  },
): Promise<void> {
  if (args.mode === "paused" || args.routes.length === 0) return;
  try {
    const visionReputation = await getEffectiveSubmitterReputation(env, { repoFullName: args.repoFullName, submitter: args.author ?? undefined });
    // BYOK resolution mirrors runAiReviewForAdvisory's own (re-resolved per-caller is this codebase's
    // established convention for this exact 3-line block, not an anti-pattern — see e.g. runAiSlopForAdvisory).
    const storedVisionKey =
      args.confirmedContributor && args.settings.aiReviewByok
        ? await getDecryptedRepositoryAiKey(env, args.repoFullName)
        : null;
    const visionProviderKey =
      storedVisionKey &&
      (!args.settings.aiReviewProvider || args.settings.aiReviewProvider === storedVisionKey.provider)
        ? {
            provider: storedVisionKey.provider,
            key: storedVisionKey.key,
            model: args.settings.aiReviewModel ?? storedVisionKey.model,
          }
        : null;
    // Self-host local vision (#4335) still consumes operator resources, so mirror the AI-spend gate used by
    // the other self-host review paths: confirmed contributors only unless the repo explicitly opts in to all
    // authors. BYOK remains checked above because it also requires a confirmed contributor-owned repo key.
    const selfHostVisionAllowed = args.confirmedContributor || args.settings.aiReviewAllAuthors;
    const selfHostVisionAvailable = selfHostVisionAllowed && Boolean(env.AI_VISION);
    const visionGate = evaluateVisualVisionGate({
      routes: args.routes,
      reputationSignal: visionReputation.signal,
      providerKey: visionProviderKey,
      selfHostVisionAvailable,
    });
    if (!visionGate.run) return;
    // evaluateVisualVisionGate only ever returns run:true when providerKey OR selfHostVisionAvailable (the
    // SAME two values resolved above) was truthy -- this is a defensive type-narrowing guard, not a reachable
    // false case: if neither is set here, the gate itself would already have returned run:false above.
    /* v8 ignore next 2 -- see comment above */
    if (!visionProviderKey && !selfHostVisionAvailable) return;
    // BYOK (a maintainer's own anthropic/openai key) takes priority when both are configured -- matches every
    // other dual-path AI call site's convention (BYOK bills the maintainer's own account, so it's preferred
    // over the shared/free local resource when the operator has explicitly set one up). Only the BYOK branch
    // is metered/capped below -- self-host vision consumes the operator's own resources, already gated
    // separately by selfHostVisionAllowed above, and was never part of the BYOK daily-spend surface. The cap
    // check runs BEFORE the shot-fetching loop so a repo that's already over budget never even pays for the
    // screenshot fetches, not just the provider call.
    if (visionProviderKey) {
      const byokDailyLimit = clampNumber(
        Number(env.AI_BYOK_DAILY_REPO_LIMIT || DEFAULT_BYOK_DAILY_REPO_LIMIT),
        0,
        10_000,
      );
      const byokUsed = await countByokAiEventsForRepoSince(env, args.repoFullName, utcDayStartIso());
      if (byokUsed >= byokDailyLimit) {
        await recordVisualVisionUsage(
          env,
          args,
          visionProviderKey,
          "quota_exceeded",
          "BYOK daily repo limit reached",
        );
        return;
      }
    }
    const images: AiContentBlock[] = [];
    for (const route of visionGate.routes) {
      // Show the model the viewport that actually crossed the pixel-diff threshold — a route can qualify via
      // desktop, mobile, or both; preferring desktop only when BOTH changed keeps this a single before/after
      // pair per route (the prompt's own "before, after order" contract), same as
      // routeHasConfirmedVisualRegression's own desktop-first `||` check.
      const useMobile = !route.diffUrl && Boolean(route.diffUrlMobile);
      const beforeShotUrl = useMobile ? route.beforeUrlMobile : route.beforeUrl;
      const afterShotUrl = useMobile ? route.afterUrlMobile : route.afterUrl;
      if (!beforeShotUrl || !afterShotUrl) continue;
      const [beforeBlock, afterBlock] = await Promise.all([
        fetchShotContentBlock(beforeShotUrl),
        fetchShotContentBlock(afterShotUrl),
      ]);
      if (beforeBlock) images.push(beforeBlock);
      if (afterBlock) images.push(afterBlock);
    }
    if (images.length === 0) return;
    let visionText: string | null;
    let visionUsage: AiReviewActualUsage | undefined;
    if (visionProviderKey) {
      const visionResponse = await callAiProvider(visionProviderKey, VISUAL_VISION_SYSTEM_PROMPT, buildVisualVisionUserPrompt(visionGate.routes), 600, images);
      visionText = visionResponse.text;
      visionUsage = visionResponse.usage;
      if (!visionText) {
        // "error" (not "ok") when the provider call itself failed (timeout/http_error/exception) -- matches
        // runAgentSummary's convention (services/ai-summaries.ts) of a distinct status for a genuine call
        // failure vs. a call that completed but returned nothing usable. countByokAiEventsForRepoSince
        // deliberately still counts "error" rows toward the daily cap (it only excludes "quota_exceeded",
        // not "ok" specifically) -- a repo hitting a flaky/misconfigured provider must not get a free,
        // uncapped retry budget just because every attempt happens to fail.
        await recordVisualVisionUsage(
          env,
          args,
          visionProviderKey,
          visionResponse.failure ? "error" : "ok",
          visionResponse.failure ? `provider failure: ${String(visionResponse.failure)}` : "no usable output",
          visionResponse.usage,
        );
        return;
      }
    } else {
      visionText = await runSelfHostVisualVision(env, VISUAL_VISION_SYSTEM_PROMPT, buildVisualVisionUserPrompt(visionGate.routes), images);
    }
    if (!visionText) return;
    const visionFindings = parseVisualVisionResponse(visionText);
    const findings = buildVisualRegressionFindings(visionFindings);
    args.advisory.findings.push(...findings);
    if (visionProviderKey) {
      await recordVisualVisionUsage(
        env,
        args,
        visionProviderKey,
        "ok",
        findings.length > 0 ? `advisory findings (${findings.length})` : "no usable output",
        visionUsage,
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "visual_vision_error",
        repoFullName: args.repoFullName,
        pull: args.pr.number,
        message: errorMessage(error).slice(0, 200),
      }),
    );
  }
}

async function recordVisualVisionUsage(
  env: Env,
  args: { repoFullName: string; pr: { number: number }; author: string | null },
  providerKey: { provider: string },
  status: string,
  detail: string,
  usage?: AiReviewActualUsage | undefined,
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "visual_vision",
    actor: args.author ?? null,
    route: "github_app.visual_vision",
    model: `byok:${providerKey.provider}`,
    status,
    estimatedNeurons: 0,
    provider: usage?.provider,
    effort: usage?.effort,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    costUsd: usage?.costUsd,
    detail,
    metadata: { repoFullName: args.repoFullName, pullNumber: args.pr.number },
  });
}

/**
 * Resolve `manifest_missing_tests`' `passedValidationCount` signal (gate-review finding, #4719): a PR-body
 * validation-note match (`hasValidationNote`) is checked FIRST since it's free; only when that misses, AND
 * the manifest actually configured `testExpectations`, AND no test file changed does this consult the PR's
 * live CI state -- via the SAME `cachedLiveCiAggregate` the disposition/unified-comment already read this
 * pass from -- so a fully-green required CI rollup counts as evidence too. Without this, a fully-automated,
 * CI-green, docs-only regen PR (the #4719 false positive) fails this check merely because its templated
 * body never happens to contain a "tested"/"validated" word. `ciState === "passed"` already excludes
 * gittensory's own Gate/Context check-runs (`BOT_OWNED_CHECK_NAMES`, github/backfill.ts), so this can never
 * be satisfied by the very check-run this signal feeds into.
 */
async function resolveManifestPassedValidationCount(
  env: Env,
  args: {
    repoFullName: string;
    installationId: number;
    prNumber: number;
    headSha: string | null | undefined;
    baseRef: string | null | undefined;
    body: string | null | undefined;
    expectedCiContexts: ReadonlyArray<string> | null | undefined;
    liveFacts: LiveGithubFacts;
    testExpectationsConfigured: boolean;
    testFileCount: number;
  },
): Promise<number> {
  if (hasValidationNote(args.body ?? "")) return 1;
  if (!args.testExpectationsConfigured || args.testFileCount > 0) return 0;
  const installationToken = await createInstallationToken(env, args.installationId).catch(
    () => undefined,
  );
  /* v8 ignore next -- installation-token failure fallback is covered by public-token fetch paths (see
   * resolvePullRequestFilesForReview above); this branch depends on token-cache timing. */
  const token = installationToken ?? env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubAdmissionKeyForToken(env, args.installationId, token);
  // No outer .catch() here: cachedLiveCiAggregate's own chain (fetchRequiredStatusContexts,
  // fetchLiveCiAggregatePreferGraphQl, and the durable-cache read/write) is already fail-open at every
  // internal step (see their own doc comments), so it never rejects -- an extra catch here would just be
  // dead, uncoverable code.
  const liveCi = await cachedLiveCiAggregate(
    env,
    args.repoFullName,
    args.liveFacts,
    args.prNumber,
    args.headSha,
    args.baseRef,
    token,
    args.expectedCiContexts,
    admissionKey,
  );
  return liveCi.ciState === "passed" ? 1 : 0;
}

// review turnaround-time (#4446): elapsed ms between startedAt and "now", clamped to a sane non-negative
// finite value -- a clock-skew or malformed-timestamp edge case (a future startedAt, or an unparseable one)
// degrades to undefined rather than ever letting a negative or NaN duration reach the public payload.
export function reviewDurationMsSince(startedAt: string | null, nowMs: number): number | undefined {
  if (!startedAt) return undefined;
  const ms = nowMs - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

async function maybePublishPrPublicSurface(
  env: Env,
  installationId: number,
  repoFullName: string,
  pr: Awaited<ReturnType<typeof upsertPullRequestFromGitHub>>,
  repo: Awaited<ReturnType<typeof getRepository>>,
  settings: Awaited<ReturnType<typeof getRepositorySettings>>,
  advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>,
  // The SAME live-reconciled open siblings the gate's own duplicate-close decision uses (reconcileLiveDuplicateSiblings,
  // built by the caller before this function runs — see reReviewStoredPullRequest / handlePullRequestWebhook /
  // buildAuthorizedPrActionAdvisory). Threaded in rather than re-derived so the duplicate-winner election below
  // (#dup-winner) agrees with the gate BY CONSTRUCTION instead of computing its own, separately-stale answer
  // from a raw, un-reconciled DB read (#dup-winner-slop-drift).
  otherOpenPullRequests: PullRequestRecord[],
  webhook: {
    deliveryId: string;
    authorType?: string | undefined;
    action?: string | undefined;
    baseSha?: string | null | undefined;
    previewPollAttempt?: number | undefined;
    skipAiReview?: boolean | undefined;
    // #regate-churn (req 8): an explicit manual re-gate can force a fresh AI opinion, bypassing BOTH the durable
    // cache and the bounded non-cacheable-reuse cooldown. Threaded from regatePullRequest's own `force` param
    // (see the "agent-regate-pr" job's optional `force` field) — no production scheduler or webhook enqueues a
    // job with `force` set today, so this is a supported hook for a future manual-trigger producer, not yet
    // reachable from any automatic path.
    forceAiReview?: boolean | undefined;
    // #regate-churn (req 6/7): true when the caller ALREADY determined something besides the AI review itself
    // may need a fresh look this pass (slop evidence collection, the manifest gate, a pre-merge-check refresh, or
    // a stale reviews-data cache — see reReviewStoredPullRequest's otherRefreshReasons/reviewsCacheStale). The
    // public-surface no-op guard below only fires when this is false — any of those signals means something
    // besides the head SHA could make the published output differ from what is already live.
    hasPendingRefreshSignal?: boolean | undefined;
    liveFacts: LiveGithubFacts;
  },
): Promise<ReturnType<typeof evaluateGateCheck> | undefined> {
  const author = pr.authorLogin ?? null;
  // Hoisted out of the try-block below (where it's actually resolved) so the AI-vision step further down --
  // which needs the SAME already-resolved confirmed-Gittensor status for its own BYOK gate, mirroring
  // runAiReviewForAdvisory's identical check -- can read it without a second, audit-event-duplicating
  // getCachedOfficialMinerDetection lookup. Defaults false; only ever set true inside that try-block.
  let confirmedContributor = false;
  // Resolve the repo's action mode ONCE for the whole publish pass and thread it into every GitHub write below, so
  // a dry-run / pause / global-freeze publishes NOTHING (check-run, comment, label) — the gate verdict is still
  // computed + returned for the disposition logic, the writes are just suppressed + audited. (#dry-run-chokepoint)
  const mode = await resolveRepoActionMode(env, settings);
  // Per-repo feature override (phase 2): the unified converged comment renders for THIS repo when the global
  // GITTENSORY_REVIEW_UNIFIED_COMMENT kill-switch is ON and the repo's container-private `.gittensory.yml`
  // `features.unifiedComment` opts in — falling back to the GITTENSORY_REVIEW_REPOS allowlist when the manifest
  // says nothing (byte-identical default). Computed once and used by both unified-comment sites below.
  const unifiedCommentAllowed = await convergedFeatureActive(
    env,
    repoFullName,
    "unifiedComment",
  );
  // `settings` is the EFFECTIVE config (`.gittensory.yml` > DB > defaults), resolved by the caller via
  // resolveRepositorySettings — so gate on/off and every blocker mode already reflect the repo's config
  // file. The gate verdict is the same for every author; confirmedContributor feeds only on-chain scoring.
  const gateEnabled =
    shouldPublishReviewCheck(settings.reviewCheckMode) && Boolean(advisory.headSha);
  // Cheap, network-free skip checks (also avoids the miner lookup when it would be wasted).
  const prelim = decidePublicSurface({
    settings,
    authorLogin: author,
    authorType: webhook.authorType ?? null,
    authorAssociation: pr.authorAssociation ?? null,
    minerStatus: "not_checked",
  });
  let publicSurfaceSkipped = false;
  if (prelim.skipped) {
    await auditPrVisibilitySkip(
      env,
      repoFullName,
      pr.number,
      author,
      prelim.skipReason ?? "skipped",
      webhook.deliveryId,
    );
    publicSurfaceSkipped = true;
  }
  const needsMinerCheckForDetectedComment =
    !publicSurfaceSkipped &&
    settings.commentMode === "detected_contributors_only" &&
    (settings.publicSurface === "comment_and_label" ||
      settings.publicSurface === "comment_only");
  // #2852: when the check-run is disabled AND there is nothing to publish, this function would otherwise bail
  // to `undefined` -- but maybeRunAgentMaintenance (the caller's very next step) hard-requires a defined `gate`
  // to act on (`if (!gate) return;`), so bailing here would silently break auto-merge/close for a repo that
  // configured autonomy but has no check-run/public surface. Only skip the bail when autonomy is actually
  // configured — an unconfigured repo keeps today's exact early-return (no wasted evaluation work).
  const autonomyNeedsGateEvaluation = isAgentConfigured(settings.autonomy);
  // #2852: the actual gate CONCLUSION must be computed whenever either the check-run will publish OR autonomous
  // merge/close needs it to act on — the two are now independent axes (reviewCheckMode only ever controlled the
  // former; gate evaluation itself has always been meant to run regardless of publish mode). Every site below
  // that feeds evaluateGateCheck's result (review-thread blockers, evaluateGateCheck itself, the surface-lane
  // override) is gated on this, NOT on gateEnabled alone — gateEnabled stays scoped to the check-run PUBLISH
  // calls (createOrUpdate*GateCheckRun), which must still never fire when reviewCheckMode is disabled.
  const shouldEvaluateGate = gateEnabled || autonomyNeedsGateEvaluation;
  if (
    !gateEnabled &&
    !autonomyNeedsGateEvaluation &&
    (publicSurfaceSkipped ||
      (prelim.actions.length === 1 &&
        prelim.actions[0] === "none" &&
        !needsMinerCheckForDetectedComment))
  )
    return undefined;
  const reviewManifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  const autoReviewConfig = resolveReviewAutoReviewConfig(reviewManifest);
  const reviewEligibility = decideReviewEligibility({
    authorLogin: author,
    ignoreAuthors: autoReviewConfig.ignoreAuthors,
  });
  if (!reviewEligibility.eligible) {
    await auditPrVisibilitySkip(
      env,
      repoFullName,
      pr.number,
      author,
      reviewEligibility.skipReason,
      webhook.deliveryId,
    );
    publicSurfaceSkipped = true;
    if (!shouldEvaluateGate) return undefined;
  }
  // A missing author already forces publicSurfaceSkipped=true above (decidePublicSurface's own
  // "missing_author" skip), so the guard just above already returns undefined whenever `!author` combines with
  // `!gateEnabled && !autonomyNeedsGateEvaluation` -- a separate `!author` check here can never fire and was
  // dead code even before #2852 (removed rather than left as an uncoverable branch).

  if (gateEnabled && (pr.state !== "open" || webhook.action === "closed")) {
    // The PR is already closed/merged. Mark the gate check skipped, but DO NOT overwrite the unified review
    // comment. This post-close pass was clobbering the REAL review (the one published while the PR was open, with
    // the actual diff + verdict) with an empty "advisory only — 0 files — no longer open" skip card — so a
    // freshly MERGED PR ended up showing a contentless review. The real review must survive the merge/close.
    // (#preserve-review-on-close) A bot-CLOSED PR still gets its close reasoning from the executor's close comment.
    const gateCheckResult = await createOrUpdateSkippedGateCheckRun(
      env,
      installationId,
      repoFullName,
      advisory,
      "PR closed before full evaluation.",
      mode,
    );
    if (gateCheckResult?.kind === "permission_missing") {
      await auditGateCheckPermissionMissing(
        env,
        author,
        repoFullName,
        pr.number,
        webhook.deliveryId,
        gateCheckResult.warning,
      );
    }
    return undefined;
  }
  // `typeLabelsEnabled` is optional only for RepositorySettings-fixture-construction backward compat (see
  // its doc comment in types.ts); getRepositorySettings always resolves it to a concrete boolean, so the
  // `?? true` fallback is unreachable on this webhook-integration path (unlike a pure function such as
  // buildRepoSettingsPreview, which a unit test can call with a hand-built, genuinely-undefined settings object).
  /* v8 ignore next -- see the comment above */
  const typeLabelsEnabled = settings.typeLabelsEnabled ?? true;
  const needsTypeLabelMinerCheck =
    settings.publicAudienceMode === "gittensor_only" && typeLabelsEnabled;
  const prelimHasPublicOutput =
    !publicSurfaceSkipped &&
    (needsMinerCheckForDetectedComment ||
      needsTypeLabelMinerCheck ||
      prelim.actions.some(
        (action) =>
          action === "comment" || action === "label" || action === "check_run",
      ));
  let official: Awaited<
    ReturnType<typeof getCachedOfficialMinerDetection>
  > | null = null;
  let decision = prelim;
  if (prelimHasPublicOutput && author) {
    const requireOfficialMiner =
      settings.publicAudienceMode === "gittensor_only";
    official = await getCachedOfficialMinerDetection(env, author, {
      targetKey: `${repoFullName}#${pr.number}`,
      deliveryId: webhook.deliveryId,
    });
    if (requireOfficialMiner && official.status === "unavailable") {
      await auditPrVisibilitySkip(
        env,
        repoFullName,
        pr.number,
        author,
        "miner_detection_unavailable",
        webhook.deliveryId,
      );
      if (!gateEnabled && !autonomyNeedsGateEvaluation) return undefined;
      publicSurfaceSkipped = true;
    } else if (requireOfficialMiner && official.status !== "confirmed") {
      await auditPrVisibilitySkip(
        env,
        repoFullName,
        pr.number,
        author,
        "not_official_gittensor_miner",
        webhook.deliveryId,
      );
      if (!gateEnabled && !autonomyNeedsGateEvaluation) return undefined;
      publicSurfaceSkipped = true;
    }
    decision = decidePublicSurface({
      settings,
      authorLogin: author,
      authorType: webhook.authorType ?? null,
      authorAssociation: pr.authorAssociation ?? null,
      minerStatus: official.status,
    });

    if (
      !gateEnabled &&
      !autonomyNeedsGateEvaluation &&
      decision.actions.length === 1 &&
      decision.actions[0] === "none"
    )
      return undefined;
  }

  // Per-PR TYPE label (reviewbot auto-label parity): bug/feature by the PR title, or a configured
  // `linkedIssueLabelPropagation` mapping (#priority-linked-issue-gate) -- the ONLY way a maintainer-
  // reward label like gittensor:priority can ever be chosen; never inferred from title, changed
  // files, AI output, or existing PR labels. Gated by `typeLabelsEnabled` (#label-decoupling), NOT
  // `decision.willLabel` -- type labels are internal triage metadata, applied regardless of author
  // type (bot/maintainer/missing-author) or the narrower reasons `willLabel` itself can be false
  // (`oss_maintainer` mode + an unconfirmed miner, `autoLabelEnabled`, or the repo's `publicSurface`
  // mode) -- see `typeLabelsEnabled`'s doc comment in types.ts. The ONE thing still respected is
  // `publicAudienceMode: "gittensor_only"`'s stricter promise to stay entirely quiet for a
  // non-confirmed-miner author (`not_official_gittensor_miner` / `miner_detection_unavailable`) --
  // that mode's whole point is total silence for that audience, not merely suppressing the context
  // label, so a type label would violate it same as a comment would. `typeLabelsEnabled` itself is
  // computed earlier (see its declaration above prelimHasPublicOutput) so gittensor_only's silence
  // promise can gate the public-surface computation too, not just this label decision (#gate-only-type-labels).
  if (
    typeLabelsEnabled &&
    !settings.agentPaused &&
    decision.skipReason !== "miner_detection_unavailable" &&
    decision.skipReason !== "not_official_gittensor_miner"
  ) {
    try {
      // Same reasoning as `typeLabelsEnabled` above: `settings.typeLabels` is optional only for
      // RepositorySettings-fixture-construction backward compat -- getRepositorySettings always
      // resolves it to a concrete, complete PrTypeLabelSet (parseTypeLabelSet never returns
      // undefined), so the `?? DEFAULT_TYPE_LABELS` fallback is unreachable on this webhook-
      // integration path.
      /* v8 ignore next -- see the comment above */
      const typeLabels = settings.typeLabels ?? DEFAULT_TYPE_LABELS;
      const propagation = settings.linkedIssueLabelPropagation;
      // Caller-gated (mirrors shouldCollectLinkedIssueEvidence/resolveLinkedIssueHardRule's own
      // cheap-check-before-fetch precedent): zero extra GitHub calls when propagation is off, which
      // is the default -- a repo that never opts in pays nothing for this feature.
      const linkedIssueLabels =
        propagation?.enabled && pr.linkedIssues.length > 0
          ? await fetchLinkedIssueLabelsForPropagation({
              env,
              repoFullName,
              linkedIssues: pr.linkedIssues,
              installationId,
              prAuthorLogin: pr.authorLogin,
              mappings: propagation.mappings,
              // #4528: lets a closed linked issue still count when THIS PR's own merge is what closed it
              // (the standard "Closes #N" auto-close), instead of losing propagation authority the instant
              // the merge that's supposed to earn the label also closes its evidence.
              prMergedAt: pr.mergedAt ?? null,
            })
          : [];
      const decisionResult = resolvePrTypeLabel({
        title: pr.title,
        linkedIssueLabels,
        labels: typeLabels,
        propagation,
      });
      for (const label of decisionResult.applyLabels) {
        await ensurePullRequestLabel(
          env,
          installationId,
          repoFullName,
          pr.number,
          label,
          { createMissingLabel: true, mode },
        );
      }
      for (const label of decisionResult.removeLabels) {
        await removePullRequestLabel(
          env,
          installationId,
          repoFullName,
          pr.number,
          label,
          mode,
        );
      }
      console.log(
        JSON.stringify({
          event: "type_label_decision",
          repoFullName,
          pull: pr.number,
          applied: true,
          labels: decisionResult.applyLabels,
          source: decisionResult.source,
        }),
      );
      await recordAuditEvent(env, {
        eventType: "github_app.type_label_decision",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        // `|| "none"` is unreachable: resolvePrTypeLabel's "title" source always resolves a non-empty
        // label (deriveKindFromTitle only ever returns "bug"/"feature", and parseTypeLabelSet always
        // falls back a built-in category to its default rather than an empty string), and its
        // propagation sources only ever use a mapping's `prLabel`, which normalizeMapping drops
        // entirely when empty -- applyLabels can never be [] here.
        /* v8 ignore next */
        detail: `applied labels: ${decisionResult.applyLabels.join(", ") || "none"}`,
        metadata: { labels: decisionResult.applyLabels, source: decisionResult.source },
      }).catch(() => undefined);
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "type_label_error",
          repoFullName,
          pull: pr.number,
          message: errorMessage(error).slice(0, 150),
        }),
      );
      await recordAuditEvent(env, {
        eventType: "github_app.type_label_decision",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "error",
        detail: errorMessage(error).slice(0, 150),
        metadata: { labels: [], source: null },
      }).catch(() => undefined);
    }
  } else {
    const skipReason = settings.agentPaused
      ? "agent_paused"
      : decision.skipReason === "miner_detection_unavailable" || decision.skipReason === "not_official_gittensor_miner"
        ? decision.skipReason
        : "typeLabelsEnabled_false";
    console.log(
      JSON.stringify({
        event: "type_label_decision",
        repoFullName,
        pull: pr.number,
        applied: false,
        reason: skipReason,
      }),
    );
    await recordAuditEvent(env, {
      eventType: "github_app.type_label_decision",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: skipReason,
      metadata: { labels: [], source: null },
    }).catch(() => undefined);
  }

  // Respect the per-repo agent pause: suppress all public surface mutations (label, comment, context
  // check run) so a paused repo sees no gittensory-authored GitHub content. The review-agent check
  // run still posts so the required-check status is not broken (#agent-pause).
  if (settings.agentPaused)
    decision = {
      ...decision,
      willLabel: false,
      willComment: false,
      willCheckRun: false,
    };

  let pendingGateCheckRunId: number | undefined;
  if (gateEnabled) {
    const pendingGateResult = await createOrUpdatePendingGateCheckRun(
      env,
      installationId,
      repoFullName,
      advisory,
      mode,
    );
    if (pendingGateResult?.kind === "published")
      pendingGateCheckRunId = pendingGateResult.id;
    if (pendingGateResult?.kind === "permission_missing") {
      await auditGateCheckPermissionMissing(
        env,
        author,
        repoFullName,
        pr.number,
        webhook.deliveryId,
        pendingGateResult.warning,
      );
    }
  }

  // The pending Gate check is now posted (status in_progress). Everything from here until the gate is
  // completed runs inside a try so that ANY failure/timeout (a slow Gittensor or GitHub call, a D1 error)
  // still finalizes the check to a neutral, non-blocking state instead of orphaning it in_progress forever
  // (the cause of the multi-hour stuck Gate). External calls in this window are bounded by request timeouts
  // (GitHub App + Gittensor API), so a hang becomes a catchable error here.
  let collisions!: ReturnType<typeof buildCollisionReport>;
  let queueHealth!: ReturnType<typeof buildQueueHealth>;
  let preflight!: ReturnType<typeof buildPreflightResult>;
  let gateEvaluation: ReturnType<typeof evaluateGateCheck> | undefined;
  // Linked-issue satisfaction assessment (#1961/#3906) result, hoisted to function scope (like gateEvaluation
  // above) because it is computed inside the try block below but consumed later, outside it, when building the
  // unified comment. Declared undefined/null-equivalent by default so an unopted-in repo (linkedIssueSatisfactionGateMode:
  // "off", the default) or a caught error never threads a section into the comment.
  let linkedIssueSatisfaction: { status: "addressed" | "partial" | "unaddressed"; rationale: string } | null = null;
  // inlineFindings is present ONLY on a FRESH review (cache miss) with inline comments enabled; the AI cache
  // round-trips notes + reviewerCount + the gate findings (so a cache hit replays consensus/split/inconclusive
  // blockers — see below), but NOT inlineFindings, so a cache hit never re-posts inline comments (#inline-comments).
  let aiReview:
    | {
        notes: string;
        reviewerCount: number;
        inlineFindings?: InlineFinding[];
        impactMap?: ImpactMapEntry[] | undefined;
        findings?: AdvisoryFinding[];
        metadata?: Record<string, unknown> | undefined;
        cacheable?: boolean | undefined;
        persistable?: boolean | undefined;
      }
    | undefined;
  let inlineCommentsEnabledForReview = false;
  let suggestionsEnabledForReview = false;
  let changedFilesSummaryEnabledForReview = false;
  let effortScoreEnabledForReview = false;
  let reviewMemoryEnabledForReview = false;
  let findingCategoriesEnabledForReview = false;
  let fixHandoffEnabledForReview = false;
  let minFindingSeverityForReview: ReviewFindingSeverity | null = null;
  let inlineCommentsPerCategoryForReview: number | null = null;
  let aiReviewExpected = false;
  let aiReviewWasReused = false;
  let gateFinalized = false;
  const publishedOutputs: PublicSurfaceOutput[] = [];
  const failedOutputs: PublicSurfaceOutputFailure[] = [];
  const reviewedHeadSha = reviewedPullRequestHeadSha(pr.headSha, advisory.headSha);
  const freshnessForReviewOutput = (phase: string): Promise<PullRequestFreshness> =>
    reviewTargetFreshness(env, {
      installationId,
      repoFullName,
      pullNumber: pr.number,
      expectedHeadSha: reviewedHeadSha,
      deliveryId: webhook.deliveryId,
      phase,
      actor: author,
    });
  const skipStaleReviewOutput = async (freshness: PullRequestFreshness): Promise<boolean> => {
    if (!freshnessBlocksReviewOutput(freshness)) return false;
    if (gateEnabled && pendingGateCheckRunId !== undefined && !gateFinalized) {
      await createOrUpdateSkippedGateCheckRun(
        env,
        installationId,
        repoFullName,
        advisory,
        pullRequestFreshnessDetail(freshness),
        mode,
        { checkRunId: pendingGateCheckRunId },
      ).catch(() => undefined);
    }
    if (freshness.reason === "unavailable") {
      throw new RetryablePullRequestFreshnessUnavailableError();
    }
    return true;
  };
  // The PR's changed files are needed by the slop/manifest gates, the AI review + grounding + RAG, the secret
  // scan, the check-run, and the unified comment. Resolve them AT MOST ONCE per review and share across the
  // gate phase (inside the try) AND the publish phase (check-run + comment, after the try): memoize the first
  // resolve so a repo that needs files anywhere pays a single resolve, and a gate-only repo that never needs
  // them pays nothing. resolvePullRequestFilesForReview prefers the stored rows and, when they are empty at
  // review time (the webhook beat detail-sync), fetches + persists them inline — so the FIRST review sees the
  // real diff instead of "0 files / No diff provided" (FIX B). Fail-safe by construction.
  let reviewFiles: Awaited<ReturnType<typeof listPullRequestFiles>> | null =
    null;
  const getReviewFiles = async (): Promise<
    Awaited<ReturnType<typeof listPullRequestFiles>>
  > => {
    if (reviewFiles === null)
      reviewFiles = await resolvePullRequestFilesForReview(env, {
        installationId,
        repoFullName,
        pullNumber: pr.number,
      });
    return reviewFiles;
  };
  const finishPublicSurfacePublication = async (): Promise<
    ReturnType<typeof evaluateGateCheck> | undefined
  > => {
    const gateSurfaceIncomplete = gateEnabled && !gateFinalized;
    if (publishedOutputs.length === 0) {
      if (failedOutputs.length > 0) {
        await recordAuditEvent(env, {
          eventType: "github_app.pr_public_surface_failed",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "error",
          detail: failedOutputs.map((failure) => failure.output).join(","),
          metadata: {
            deliveryId: webhook.deliveryId,
            repoFullName,
            failedOutputs,
            gateCheckRequired: gateEnabled,
            gateCheckFinalized: gateFinalized,
          },
        });
        // The advisory ran but NOTHING reached the PR (revoked token / perms removed / GitHub 5xx). For an
        // advisory-only bot this is the worst failure — escalate to Sentry at error level, not just the audit ledger.
        captureReviewFailure(new Error("PR public-surface publish failed — review produced output but nothing was posted to the PR"), {
          kind: "publish",
          installationId,
          owner: repoFullName.split("/")[0],
          repo: repoFullName,
          pr: pr.number,
          head_sha: advisory.headSha,
          failedOutputs: failedOutputs.map((failure) => failure.output),
        });
        // At least one output failed for a reason that can plausibly clear on its own (rate limit / 5xx / momentary
        // token issue) — retry the whole job instead of leaving the review permanently unposted. A mix of transient
        // and permanent failures still retries: the permanent one re-fails identically next pass and re-audits, but
        // the transient one gets the chance it needs, and nothing here is published twice (publishedOutputs is empty).
        if (failedOutputs.some((failure) => failure.transient)) {
          throw new RetryablePublicSurfacePublishFailedError(repoFullName, pr.number);
        }
      }
      if (gateSurfaceIncomplete) {
        await recordAuditEvent(env, {
          eventType: "github_app.pr_public_surface_incomplete",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "error",
          detail: "required gate check did not finalize",
          metadata: {
            deliveryId: webhook.deliveryId,
            repoFullName,
            gateCheckMode: settings.gateCheckMode,
            reviewCheckMode: settings.reviewCheckMode,
            publishedOutputs,
            failedOutputs,
          },
        }).catch(() => undefined);
      }
      return gateEvaluation;
    }
    if (gateSurfaceIncomplete) {
      // This branch is reachable with publishedOutputs non-empty (e.g. gate-only: ["gate_check_run"]), which
      // can happen via the early `!prelimHasPublicOutput` return below -- at that point `decision` is still
      // `prelim` (never reassigned by decidePublicSurface's official-miner-aware pass). That is safe here:
      // `willLabel` is a non-optional boolean on every PublicSurfaceDecision variant (never undefined), and
      // prelimHasPublicOutput being false means "label" was not in prelim.actions, which decidePublicSurface
      // never sets independently of willLabel -- so decision.willLabel is always false on this path anyway.
      await recordAuditEvent(env, {
        eventType: "github_app.pr_public_surface_incomplete",
        actor: author,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "error",
        detail: "required gate check did not finalize",
        metadata: {
          deliveryId: webhook.deliveryId,
          repoFullName,
          publicSurface: settings.publicSurface,
          label: decision.willLabel ? settings.gittensorLabel : null,
          checkRunMode: settings.checkRunMode,
          gateCheckMode: settings.gateCheckMode,
          reviewCheckMode: settings.reviewCheckMode,
          publicAudienceMode: settings.publicAudienceMode,
          publishedOutputs,
          failedOutputs,
        },
      }).catch(() => undefined);
      return gateEvaluation;
    }
    // review-effort minutes (#1955): a deterministic, no-AI per-PR estimate persisted onto the SAME published
    // event public-stats.ts already reads (github_app.pr_public_surface_published) -- so the public "time saved"
    // stat can average a REAL per-PR figure instead of only the flat MINUTES_SAVED_PER_PR fallback constant.
    // Computed unconditionally (independent of review.effort_score, which only gates the unified-comment CHIP)
    // because public-stats is a cross-repo aggregate with no manifest of its own. Reuses the SAME memoized
    // getReviewFiles() accessor the gate/comment pipeline already resolved this pass -- no extra fetch when the
    // unified comment already ran; exactly one fetch otherwise. Fail-safe: a files-fetch error here must never
    // block the publish audit itself, so a throw degrades to `undefined` (public-stats' own COALESCE fallback
    // then applies, same as a pre-#1955 historical row).
    const reviewEffortMinutesForStats = await getReviewFiles()
      .then((files) =>
        estimateReviewEffort(
          files.map((file) => ({
            path: file.path,
            patch: typeof file.payload?.patch === "string" ? file.payload.patch : undefined,
          })),
        ),
      )
      .then((effort) => effort.minutes)
      .catch(() => undefined);
    // review turnaround-time (#4446): reuses the SAME startedAt startActiveReviewTracking already records for
    // review-evasion protection -- persisted onto this SAME published event, mirroring reviewEffortMinutes'
    // exact precedent above (a raw per-PR number in audit metadata; the daily rollup job aggregates it later).
    // Read before terminalizeActiveReviewTracking runs later in this same pass, matched to the EXACT headSha
    // being published so a race with a newer pass degrades to "no duration" (undefined), never a wrong number.
    // Fail-safe: a lookup error must never block the publish audit itself.
    const reviewDurationMsForStats = pr.headSha
      ? await getActiveReviewStartedAt(env, repoFullName, pr.number, pr.headSha)
          .then((startedAt) => reviewDurationMsSince(startedAt, Date.now()))
          .catch(() => undefined)
      : undefined;
    await recordAuditEvent(env, {
      eventType: "github_app.pr_public_surface_published",
      actor: author,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      metadata: {
        deliveryId: webhook.deliveryId,
        publicSurface: settings.publicSurface,
        label: decision.willLabel ? settings.gittensorLabel : null,
        checkRunMode: settings.checkRunMode,
        gateCheckMode: settings.gateCheckMode,
        reviewCheckMode: settings.reviewCheckMode,
        publicAudienceMode: settings.publicAudienceMode,
        publishedOutputs,
        failedOutputs,
        gateCheckFinalized: gateFinalized,
        ...(reviewEffortMinutesForStats !== undefined ? { reviewEffortMinutes: reviewEffortMinutesForStats } : {}),
        ...(reviewDurationMsForStats !== undefined ? { reviewDurationMs: reviewDurationMsForStats } : {}),
      },
    });
    await recordGithubProductUsage(env, "pr_public_surface_published", {
      actor: author,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      metadata: {
        publicSurface: settings.publicSurface,
        labelApplied: decision.willLabel,
        checkRunMode: settings.checkRunMode,
        gateCheckMode: settings.gateCheckMode,
        reviewCheckMode: settings.reviewCheckMode,
        publicAudienceMode: settings.publicAudienceMode,
        publishedOutputs,
        failedOutputs,
        gateCheckFinalized: gateFinalized,
      },
    });
    // Stamp the head SHA only after every required public surface for this repo completed. For gate-enabled repos,
    // a comment/label without a finalized Orb gate check is incomplete and must stay repair-visible to the sweep.
    await markPullRequestSurfacePublished(env, repoFullName, pr.number, advisory.headSha).catch((error) => {
      console.error(JSON.stringify({ level: "warn", event: "surface_published_mark_failed", repoFullName, pullNumber: pr.number, error: errorMessage(error) }));
    });
    // #regate-churn: mark the AI review row for THIS head+fingerprint as durably published (a no-op when no fresh
    // row was written this pass -- e.g. the frozen-reuse path above, or AI review off/skipped entirely).
    await markAiReviewPublished(env, repoFullName, pr.number, advisory.headSha).catch((error) => {
      console.error(JSON.stringify({ level: "warn", event: "ai_review_published_mark_failed", repoFullName, pullNumber: pr.number, error: errorMessage(error) }));
    });
    return gateEvaluation;
  };
  try {
    const [repoIssues, repoPullRequests, repoBounties, latestRegistrySnapshot] = await Promise.all([
      listIssues(env, repoFullName),
      listPullRequests(env, repoFullName),
      listBountiesByRepo(env, repoFullName),
      getLatestRegistrySnapshot(env),
    ]);
    // An unregistered repo is only a meaningful preflight signal once the registry sync has actually
    // produced at least one snapshot (see buildPreflightResult's registryEverSynced param) -- otherwise every
    // PR on a self-host instance whose registry feed has never succeeded gets held for no reason tied to the PR.
    const registryEverSynced = latestRegistrySnapshot !== null;
    // Open-PR file-path collision (#2653): flag-gated, byte-identical when OFF (see enrichOpenPullRequestsWithChangedFiles).
    // Scoped to collision/preflight/queue-health inputs only — every OTHER use of repoPullRequests below (e.g. the
    // duplicate-winner adjudication, which is same-linked-issue-based, not path-based) keeps reading the un-enriched array.
    const collisionPullRequests =
      env.GITTENSORY_OPEN_PR_FILE_COLLISION === "true"
        ? await enrichOpenPullRequestsWithChangedFiles(env, repoFullName, repoPullRequests)
        : repoPullRequests;
    collisions = buildCollisionReport(
      repoFullName,
      repoIssues,
      collisionPullRequests,
    );
    queueHealth = buildQueueHealth(
      repo,
      repoIssues,
      collisionPullRequests,
      collisions,
    );
    preflight = buildPreflightResult(
      {
        repoFullName,
        contributorLogin: author ?? undefined,
        title: pr.title,
        body: pr.body ?? undefined,
        labels: pr.labels,
        linkedIssues: pr.linkedIssues,
        authorAssociation: pr.authorAssociation ?? undefined,
      },
      repo,
      repoIssues,
      collisionPullRequests,
      repoBounties,
      undefined,
      registryEverSynced,
    );
    // Duplicate-winner adjudication (#dup-winner): compute the winner ONCE for this review run from the SAME
    // live-RECONCILED open-only sibling source the gate's own close decision uses (otherOpenPullRequests, threaded
    // in by the caller via reconcileLiveDuplicateSiblings — NOT repoPullRequests, a raw un-reconciled read of the
    // cached `state` column that can still say "open" for a sibling GitHub already closed, e.g. a missed/delayed
    // webhook), and thread the flag/result consistently into readiness, the slop penalty (below), and the public
    // panel builders (further down) so they agree by construction with the actual close decision
    // (#dup-winner-slop-drift). Flag-OFF (default) ⇒ duplicateWinnerEnabled is false and isDupWinner is false ⇒
    // every guard short-circuits (byte-identical).
    const linkedDuplicatePrsForGate = linkedIssueDuplicatePullRequestRecordsForGate(
      pr,
      otherOpenPullRequests,
    );
    const duplicateWinnerEnabled = env.GITTENSORY_DUPLICATE_WINNER === "true";
    const isDupWinner =
      duplicateWinnerEnabled &&
      isDuplicateClusterWinnerByClaim(pr, linkedDuplicatePrsForGate);
    const relatedWork = buildDuplicateWinnerRelatedWorkView({
      pr,
      collisions,
      preflightCollisions: preflight.collisions,
      duplicateWinnerEnabled,
    });
    const readiness = buildPublicReadinessScore({
      pr,
      preflight,
      queueHealth,
      linkedDuplicatePrs: isDupWinner ? [] : linkedDuplicatePrsForGate.map((otherPr) => otherPr.number),
      scopedOverlapCount: relatedWork.scopedOverlapClusters.length,
    });

    // #2852: gated on shouldEvaluateGate, not gateEnabled alone -- confirmedContributor (sourced from
    // `official` below) feeds runAiSlopForAdvisory's hard gate later in this pass, so a reviewCheckMode:
    // disabled repo with autonomy configured must still resolve it, not silently treat a confirmed miner as
    // unconfirmed.
    if (shouldEvaluateGate && author && !publicSurfaceSkipped && !official) {
      official = await getCachedOfficialMinerDetection(env, author, {
        targetKey: `${repoFullName}#${pr.number}`,
        deliveryId: webhook.deliveryId,
      });
    }

    // Resolve the author's confirmed-Gittensor status. It feeds on-chain SCORING and the public surface, but
    // it no longer gates the verdict — every author is hard-blocked the same way on a configured blocker, and
    // a clean PR passes the same way. (#gate-nonconfirmed)
    confirmedContributor = official?.status === "confirmed";

    // Anti-slop (#530/#532): only when opted in (slopGateMode !== "off"). Surface the deterministic slop
    // findings as advisory context, and feed the score to the gate (it only blocks under slop: block + the
    // threshold). Loads files lazily so disabled repos pay nothing.
    let slopRisk: number | null = null;
    // Slop (#530) and focus-manifest-policy (#555) gates both need the PR's changed files; load via the shared
    // resolver (lazy — a repo with both off pays nothing; see getReviewFiles above).
    let gateFiles: Awaited<ReturnType<typeof listPullRequestFiles>> | null =
      null;
    if (
      shouldCollectSlopEvidence(settings) ||
      settings.manifestPolicyGateMode !== "off"
    ) {
      gateFiles = await getReviewFiles();
    }
    if (shouldCollectSlopEvidence(settings)) {
      const slopFiles = gateFiles ?? [];
      const slop = buildSlopAssessment({
        changedFiles: slopFiles.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        })),
        description: pr.body,
        // Reuse the collision report already built for this gate run so a duplicate-cluster PR is flagged (#563).
        // Duplicate-winner adjudication (#dup-winner): the winner is judged on its OWN merits, so it is NOT
        // penalized for the cluster. Flag-OFF ⇒ isDupWinner is false ⇒ byte-identical to today.
        inDuplicateCluster:
          !isDupWinner &&
          isPullRequestInDuplicateCluster(collisions, pr.number),
      });
      slopRisk = slop.slopRisk;
      advisory.findings.push(...slop.findings);
      // Persist dashboard-visible slop only when the repo opted into the slop gate. Merge-readiness may
      // still use the live score above, but disabling slop should clear any previously cached dashboard row.
      // Best-effort: a write hiccup must not abort gate evaluation.
      const persistedSlop =
        settings.slopGateMode === "off"
          ? { slopRisk: null, slopBand: null }
          : { slopRisk: slop.slopRisk, slopBand: slop.band };
      await updatePullRequestSlopAssessment(
        env,
        repoFullName,
        pr.number,
        persistedSlop,
      ).catch(() => undefined);
      // AI-assisted slop advisory (#533, opt-in). Reuses the already-fetched files; appends at most one
      // advisory-only finding. Deliberately does NOT update slopRisk — only the deterministic core blocks.
      if (shouldRunSlopAiAdvisory(settings)) {
        // #ai-slop-repeat-spend: same commit-threshold cap ai_review already applies (auto_pause_after_reviewed_commits)
        // — a PR the sweep keeps re-visiting stops getting a fresh slop advisory once it's been reviewed enough
        // times, instead of re-attempting (and re-touching the shared neuron/provider budget) on every single pass.
        const slopReviewedCommitCount = await countPublishedAiReviewHeads(env, repoFullName, pr.number).catch(() => 0);
        await runAiSlopForAdvisory(env, {
          mode,
          settings,
          advisory,
          repoFullName,
          pr,
          author,
          files: slopFiles,
          deterministicBand: slop.band,
          confirmedContributor,
          commitThresholdReached: isAutoReviewCommitThresholdReached(autoReviewConfig, slopReviewedCommitCount),
        });
      }
    }
    // Linked-issue satisfaction assessment (#1961/#3906, opt-in via linkedIssueSatisfactionGateMode). Assesses
    // only the PR's primary linked issue -- see runLinkedIssueSatisfactionForAdvisory's own doc comment for
    // the multi-linked-issue rationale. `off` (default) short-circuits before any fetch or model call, so this
    // is byte-identical to before this feature existed for every repo that hasn't opted in. (Declared/hoisted
    // to function scope above, alongside gateEvaluation, since it is consumed later outside this try block.)
    if (settings.linkedIssueSatisfactionGateMode !== "off" && pr.linkedIssues.length > 0) {
      linkedIssueSatisfaction = await runLinkedIssueSatisfactionForAdvisory(env, {
        mode,
        settings,
        advisory,
        repoFullName,
        pr,
        author,
        files: await getReviewFiles(),
        confirmedContributor,
        installationId,
      });
    }
    // Focus-manifest policy (#555, opt-in via manifestPolicyGateMode). Reload the CACHED manifest (the
    // settings resolver discards the raw manifest, but loadRepoFocusManifest is cached so this is cheap),
    // recompute the guidance over the PR's changed files, and push ONLY the three enforceable policy
    // findings into the advisory so isConfiguredGateBlocker can block under manifestPolicy: block.
    if (settings.manifestPolicyGateMode !== "off") {
      const manifestFiles = gateFiles ?? [];
      const manifest = await loadRepoFocusManifest(env, repoFullName);
      const testFileCount = manifestFiles.filter((file) => isTestPath(file.path)).length;
      const passedValidationCount = await resolveManifestPassedValidationCount(env, {
        repoFullName,
        installationId,
        prNumber: pr.number,
        headSha: pr.headSha,
        baseRef: pr.baseRef ?? repo?.defaultBranch,
        body: pr.body,
        expectedCiContexts: settings.expectedCiContexts,
        liveFacts: webhook.liveFacts,
        testExpectationsConfigured: manifest.testExpectations.length > 0,
        testFileCount,
      });
      const guidance = buildFocusManifestGuidance({
        manifest,
        changedPaths: manifestFiles.map((file) => file.path),
        labels: pr.labels,
        linkedIssueCount: pr.linkedIssues.length,
        testFileCount,
        passedValidationCount,
        hasNoIssueRationale: hasClearNoIssueRationale(pr),
      });
      const policyCodes = new Set([
        "manifest_blocked_path",
        "manifest_linked_issue_required",
        "manifest_missing_tests",
      ]);
      // Keep deterministic manifest policy findings independent from AI-review eligibility: ignored authors
      // suppress review/public output only, never maintainer-configured gate blockers or their downstream triggers.
      const policyFindings = guidance.findings;
      // Computed once and reused below for the #4196 auto-trigger check -- same feature gate, one call. Also
      // feeds #4583's inline CTA so the missing-tests finding surfaces `@gittensory generate-tests` right in
      // ORB's own comment (mirrors CodeRabbit's inline walkthrough checkbox) only when the command would
      // actually work for this repo, never as noise on a repo that hasn't opted in.
      const e2eTestGenAvailable = resolveConvergedFeature(env, manifest, "e2eTests", repoFullName);
      for (const finding of policyFindings) {
        if (!policyCodes.has(finding.code)) continue;
        advisory.findings.push(publicSafeManifestPolicyFinding(finding, { e2eTestGenAvailable }));
      }
      // E2E test-generation auto-trigger (#4196, part of the #4189 epic): promotes the deterministic
      // manifest_missing_tests finding above from advisory-only text into an actual trigger for #4192/#4194's
      // generation-and-render path -- additive to, never a replacement for, the explicit `@gittensory
      // generate-tests` command (#4195), which stays available regardless of whether this signal fired.
      // Filters the SAME policyFindings just computed above rather than re-deriving "PR probably needs
      // tests" from scratch, per the issue's own requirement -- this is why the auto-trigger lives inside this
      // exact manifestPolicyGateMode-gated block instead of a parallel code path: that is the only place this
      // finding is computed at all today.
      if (pr.headSha && policyFindings.some((finding) => finding.code === "manifest_missing_tests") && e2eTestGenAvailable) {
        const e2eTargetKey = `${repoFullName}#${pr.number}`;
        // Double-generation guard: an unchanged head SHA re-entering this pass (a re-review/sweep tick, not a
        // new push) must never re-spend an LLM call or repost a duplicate suggestion. A genuinely NEW push
        // (a new head SHA) is always a fresh miss here regardless of how many prior SHAs already fired. The
        // explicit command deliberately does NOT consult this guard -- a maintainer typing the command always
        // gets a fresh generation, even on a SHA the auto-trigger already covered (simplicity over a cache that
        // would need its own invalidation rules; the daily neuron budget shared by both paths already bounds
        // the cost of a maintainer choosing to ask twice).
        const alreadyTriggered = await hasAuditEventForHeadSha(env, "github_app.e2e_tests_generation", e2eTargetKey, pr.headSha);
        if (!alreadyTriggered) {
          const e2eMode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
          if (e2eMode === "live") {
            await runE2eTestGenerationAndDeliver(env, {
              repoFullName,
              installationId,
              pr,
              settings,
              manifest,
              files: manifestFiles,
              // No comment-invoker exists for an automated trigger -- the PR's own author is the closest
              // analogue to "who this generated test is for" (unlike the explicit command, where `actor` is
              // whoever typed the command).
              actor: author ?? "the PR author",
              mode: e2eMode,
              deliveryId: webhook.deliveryId,
              targetKey: e2eTargetKey,
              trigger: "auto",
            });
          } else {
            await recordGenerateTestsSkip(env, webhook.deliveryId, repoFullName, e2eTargetKey, author, e2eMode === "dry_run" ? "dry_run" : "agent_paused");
          }
        }
      }
    }
    // Pre-merge checks (#review-pre-merge-checks, opt-in via .gittensory.yml review.pre_merge_checks). DETERMINISTIC
    // content assertions (title/description must contain a phrase, a label must be present), optionally path-gated.
    // Each FAILED check appends an advisory `pre_merge_check_failed` finding — or a blocking `pre_merge_check_required`
    // one when the maintainer set enforce: true — BEFORE the gate evaluates. No AI judgment, so this can never cause
    // an AI false-close. The manifest is cached (settings resolution loaded it), so this is a cheap hit;
    // resolveReviewPreMergeChecks fail-safes to [] on a load error. Empty (default) ⇒ no finding (byte-identical).
    const preMergeChecks = resolveReviewPreMergeChecks(
      await loadRepoFocusManifest(env, repoFullName).catch(() => null),
    );
    if (preMergeChecks.length > 0) {
      const checkFiles = await getReviewFiles(); // memoized — reuses the gate/slop diff when already resolved
      // An empty resolved file set means the changed paths could not be resolved (a PR always touches >=1 file),
      // so a path-gated check cannot be evaluated — pass filesResolved=false so an ENFORCED whenPaths check HOLDS
      // the gate (re-evaluates later) instead of silently skipping a hard requirement into an auto-merge (#review-audit).
      advisory.findings.push(
        ...evaluatePreMergeChecks(preMergeChecks, {
          title: pr.title,
          body: pr.body,
          labels: pr.labels,
          changedPaths: checkFiles.map((file) => file.path),
          filesResolved: checkFiles.length > 0,
        }),
      );
    }
    // CLA / license-compatibility gate (#2564, opt-in via .gittensory.yml gate.claMode). DETERMINISTIC — a PR-body
    // consent-phrase match (mirrors pre_merge_checks' descriptionContains exactly) and/or a named CLA-bot
    // check-run's conclusion; consent is satisfied when EITHER configured method holds. No AI judgment, so this
    // can never cause an AI false-close. Off by default (claGateMode undefined/"off"), so a repo that has not
    // opted in makes no extra GitHub call and pushes no finding — byte-identical to today.
    if (settings.claGateMode && settings.claGateMode !== "off") {
      const claCheckRunName = settings.claCheckRunName ?? null;
      const claCheckRunAppSlug = settings.claCheckRunAppSlug ?? null;
      // Only resolve a live check-run when the maintainer actually configured that detection method — a
      // phrase-only config must never spend an extra GitHub call.
      const claCheckRunConclusion = claCheckRunName
        ? await fetchNamedCheckRunConclusion(
            env,
            repoFullName,
            advisory.headSha,
            claCheckRunName,
            claCheckRunAppSlug,
            await resolveReviewEnrichmentGithubToken(env, repoFullName),
          )
        : undefined;
      advisory.findings.push(
        ...evaluateClaCheck(
          { consentPhrase: settings.claConsentPhrase ?? null, checkRunName: claCheckRunName },
          { body: pr.body, checkRunConclusion: claCheckRunConclusion },
        ),
      );
    }

    // AI maintainer review (opt-in via aiReviewMode). Mutates `advisory` with a consensus defect (if any)
    // BEFORE the gate evaluates, and returns advisory notes for the panel. Inside the try so any AI
    // failure is caught and the gate is still finalized (never left in_progress). Pass the shared resolved
    // files so the review (+ grounding + RAG) sees the REAL diff even on a pre-detail-sync first review (FIX B);
    // resolve only when the review will actually run (aiReviewMode !== off + a head SHA + not explicitly skipped)
    // to keep gate-only and advisory-sweep repos free of an extra file resolve.
    // Contributor blacklist (#1425): a blocked author's PR is closed by the deterministic disposition, so it must
    // NEVER spend an AI call — skip the AI review entirely when the author is blacklisted (the gate + disposition
    // still run; the close fires there). Per-repo list now; the shared/global list unions in once its table lands.
    const authorBlacklisted = isAuthorBlacklisted(
      author,
      settings.contributorBlacklist,
    );
    // #regate-churn (maintainer-gated freeze): once a PR is held for manual review -- the manual-review label is
    // already on it from a PRIOR pass -- a repeat CONTRIBUTOR push must not buy a fresh, real AI review. That is
    // exactly the gaming surface this closes: iterating pushes hoping to slip a green verdict past the bot (or
    // just to see what the AI says next), at real LLM cost, instead of waiting for the human judgment the hold
    // exists for. Only an explicit maintainer/collaborator retrigger (the PR-panel checkbox, which sets
    // `webhook.forceAiReview`) may unfreeze a contributor's held PR. CI/mergeable facts and label/assignee
    // reconciliation are UNAFFECTED — both are recomputed fresh every pass below regardless of this flag; only
    // the AI's own substantive verdict/findings are pinned. The very FIRST pass that establishes the hold is
    // never frozen: the label is applied by the disposition executor AFTER this pass publishes, so `pr.labels`
    // (read at the top of this sweep, before that write) does not carry it yet.
    //
    // #freeze-owner-exemption (incident, confirmed live 2026-07-05 on PR #3476): the freeze must NOT apply to
    // the repo owner's own PR, an ADMIN_GITHUB_LOGINS fleet-operator's, or a protected automation bot's -- same
    // exemption this codebase already grants these authors everywhere else (auto-close, review-nag, contributor
    // caps). The gaming concern this freeze exists to close is specific to a CONTRIBUTOR iterating pushes
    // against the bot; it never applies to the maintainer's own PRs. Without this exemption, a maintainer
    // pushing a genuine fix to their OWN held PR kept replaying the ORIGINAL (now-stale) AI verdict pass after
    // pass, hiding the maintainer's own fix from the review meant to evaluate it -- confirmed live via
    // `github_app.ai_review_frozen_reuse` firing on every one of #3476's own follow-up commits.
    const manualReviewLabel = settings.manualReviewLabel === null ? null : (settings.manualReviewLabel ?? AGENT_LABEL_NEEDS_REVIEW);
    const authorIsExemptFromFreeze =
      author !== null &&
      (author.toLowerCase() === repoOwnerLoginFromFullName(repoFullName).toLowerCase() ||
        parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(author.toLowerCase()) ||
        isProtectedAutomationAuthor(author));
    const isFrozenForManualReview =
      webhook.forceAiReview !== true &&
      !authorIsExemptFromFreeze &&
      manualReviewLabel !== null &&
      pr.labels.some((label) => label.toLowerCase() === manualReviewLabel.toLowerCase());
    let reviewManifestForAutoReview: FocusManifest | null = null;
    let autoReviewSkipReason: string | null = null;
    const autoReviewFiles = await getReviewFiles();
    const autoReviewChangedPaths = autoReviewFiles.map((file) => file.path);
    const autoReviewAddedLineCount = totalAddedLineCount(autoReviewFiles);
    const autoReviewChangedFileCount = autoReviewFiles.length;
    ({
      skipReason: autoReviewSkipReason,
      reviewManifest: reviewManifestForAutoReview,
    } = await resolveAutoReviewSkipForPullRequest(env, {
      authorBlacklisted,
      isFrozenForManualReview,
      forceAiReview: webhook.forceAiReview,
      repoFullName,
      pr: { number: pr.number, title: pr.title, baseRef: pr.baseRef ?? null, isDraft: pr.isDraft ?? null, labels: pr.labels },
      author,
      deliveryId: webhook.deliveryId,
      headSha: advisory.headSha ?? null,
      changedPaths: autoReviewChangedPaths,
      addedLineCount: autoReviewAddedLineCount,
      changedFileCount: autoReviewChangedFileCount,
    }));
    // review.changed_files_summary (#1957) + review.effort_score (#1955): both deterministic, no-AI — resolve
    // them here, UNCONDITIONALLY, rather than inside the aiReviewWillRun-gated closure below. These sections
    // must still render whenever the manifest opts in even when the AI review itself is skipped this pass
    // (author blacklisted, frozen for manual review, or AI review disabled for the repo) — neither has anything
    // to do with the AI pipeline. One resolve call feeds both outer-scoped flags (mirroring
    // inlineCommentsEnabledForReview/suggestionsEnabledForReview) so they survive past this try block to the
    // publish step below.
    const deterministicReviewOverrides = resolveReviewPromptOverrides(reviewManifestForAutoReview);
    changedFilesSummaryEnabledForReview = deterministicReviewOverrides.changedFilesSummary;
    effortScoreEnabledForReview = deterministicReviewOverrides.effortScore;
    minFindingSeverityForReview = deterministicReviewOverrides.minFindingSeverity;
    inlineCommentsPerCategoryForReview = deterministicReviewOverrides.inlineCommentsPerCategory;
    // review.memory (#2179, part of #1964): deterministic, no-AI -- resolved the same unconditional way as
    // changed_files_summary/effort_score above (must apply even when the AI review itself is skipped this
    // pass). ANDed with the operator's GITTENSORY_REVIEW_MEMORY kill-switch at the actual apply site below
    // (shouldApplyReviewMemory) — this flag alone only carries the per-repo manifest opt-in.
    reviewMemoryEnabledForReview = shouldApplyReviewMemory(env, resolveReviewMemoryManifestToggle(reviewManifestForAutoReview));
    // review.fixHandoff emission (#1962): resolved the same unconditional way as the deterministic sections above,
    // ANDing the per-repo `review.fixHandoff` manifest opt-in with the operator's GITTENSORY_REVIEW_FIX_HANDOFF
    // kill-switch + convergence allowlist (shouldEmitFixHandoff). The blocks themselves are built from this pass's
    // inline findings at the publish site below, mirroring findingCategories.
    fixHandoffEnabledForReview = shouldEmitFixHandoff(env, repoFullName, reviewManifestForAutoReview?.review.fixHandoff ?? undefined);
    maybeAddRequiredAutoReviewSkipHold(env, {
      settings,
      advisory,
      repoFullName,
      author,
      confirmedContributor,
      skipAiReview: webhook.skipAiReview,
      autoReviewSkipReason,
    });
    // #4507: computed ONCE here (the same isReputationEnabled/isConvergenceRepoAllowed gate
    // shouldStartAiReviewForAdvisory uses internally) and threaded into both shouldStartAiReviewForAdvisory below
    // and runAiReviewForAdvisory further down, instead of each independently re-deriving it -- a second
    // REPUTATION_WINDOW_ROW_CAP-bounded review_targets scan for the identical (repo, submitter) within the same
    // pass. undefined when this pass's gate condition doesn't apply; both downstream call sites then fall back to
    // their own fresh (and, for runAiReviewForAdvisory, manifest-override-aware) check.
    const preComputedReputationSkip =
      isReputationEnabled(env) && isConvergenceRepoAllowed(env, repoFullName)
        ? await shouldSkipAiForReputation(env, { project: repoFullName, submitter: author })
        : undefined;
    const aiReviewWillRun =
      !authorBlacklisted &&
      !isFrozenForManualReview &&
      !autoReviewSkipReason &&
      (await shouldStartAiReviewForAdvisory(env, {
        settings,
        advisory,
        repoFullName,
        author,
        confirmedContributor,
        skipAiReview: webhook.skipAiReview,
        preComputedReputationSkip,
      }));
    aiReviewExpected = aiReviewWillRun;
    if (isFrozenForManualReview) {
      const frozenReview = await getLatestPublishedAiReview(env, repoFullName, pr.number, settings.aiReviewMode).catch(() => null);
      if (frozenReview && hasPublicReviewAssessment(frozenReview.notes)) {
        advisory.findings.push(...frozenReview.findings);
        aiReview = frozenReview;
        aiReviewWasReused = true;
        incr("gittensory_ai_review_frozen_reuse_total");
        await recordAuditEvent(env, {
          eventType: "github_app.ai_review_frozen_reuse",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "completed",
          detail: "PR is held for manual review; reused the last published AI review instead of spending a fresh call",
          /* v8 ignore next -- a truthy `frozenReview` means markAiReviewPublished previously stamped a row for
           * a non-null head SHA (it no-ops on a nullish one), and an open PR does not lose its head SHA once
           * set; the `?? null` is a type-level fallback for a practically-unreachable branch, mirroring the
           * identical `advisory.headSha ?? null` fallbacks elsewhere in this function. */
          metadata: { deliveryId: webhook.deliveryId, repoFullName, headSha: advisory.headSha ?? null },
        }).catch(() => undefined);
      }
    } else if (autoReviewSkipReason === "review paused (commit threshold)") {
      // #selfhost-token-burn: countPublishedAiReviewHeads now counts the PR's OWN current head (see that
      // function's own doc comment), so this reason can fire repeatedly for the SAME unchanged head across
      // every scheduled sweep pass, not just once when a truly new commit lands. Without reusing the cached
      // findings here, an already-published blocker would silently vanish from every later gate evaluation
      // the instant the pause engaged (#3719's original regression) — reapply them the SAME way a
      // frozen-for-manual-review PR does, just under this reason's own distinct audit event.
      const pausedReview = await getLatestPublishedAiReview(env, repoFullName, pr.number, settings.aiReviewMode).catch(() => null);
      if (pausedReview && hasPublicReviewAssessment(pausedReview.notes)) {
        advisory.findings.push(...pausedReview.findings);
        aiReview = pausedReview;
        aiReviewWasReused = true;
        incr("gittensory_ai_review_paused_reuse_total");
        await recordAuditEvent(env, {
          eventType: "github_app.ai_review_paused_reuse",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "completed",
          detail: "Auto-review is paused (commit threshold); reused the last published AI review instead of spending a fresh call",
          metadata: { deliveryId: webhook.deliveryId, repoFullName, headSha: advisory.headSha ?? null },
        }).catch(() => undefined);
      }
    }
    // Review-evasion protection (#review-evasion-protection): durably record that a review pass is starting
    // for this EXACT head BEFORE any cost-bearing AI-review work begins (including the reviewing placeholder
    // below), so a contributor who closes/converts-to-draft their PR from this point until the pass concludes
    // is dodging an ACTIVE review, not making an ordinary close. Gated on aiReviewWillRun (not the narrower
    // shouldPostPlaceholder below, which also requires willComment -- a check-run-only repo still runs a real
    // review and must still be protected); aiReviewWillRun already folds in !isFrozenForManualReview, so a PR
    // held for manual review (reusing a frozen prior verdict, not doing fresh work) never starts tracking here
    // -- there is no active pass for a contributor to evade in that case. Best-effort: a failed write only
    // means this ONE pass is not evasion-protected, never a mutation failure. Terminalized once the gate
    // decision concludes (below).
    if (aiReviewWillRun && pr.headSha) {
      await startActiveReviewTracking(env, {
        repoFullName,
        pullNumber: pr.number,
        headSha: pr.headSha,
        authorLogin: author,
        deliveryId: webhook.deliveryId,
      }).catch(
        /* v8 ignore next -- fail-safe: a failed tracking write only means this ONE pass is not evasion-protected. */
        () => undefined,
      );
    }
    // Post a transient "🟪 reviewing…" placeholder BEFORE the review refresh runs so contributors never see a
    // stale green/yellow/red verdict while the current head is being recomputed. In-place upsert: once the final
    // verdict is ready it overwrites this comment. GitHub rate-limits still abort so the queue can retry instead
    // of leaving a stale public surface visible. `shouldPostPlaceholder` (unchanged) also gates the pre-publish
    // staleness check below — that check is a general "has this pass already been superseded" abort, independent
    // of the placeholder UI itself, so it must keep running whenever a placeholder would ever be eligible here.
    const shouldPostPlaceholder = shouldPostReviewingPlaceholder({
      reviewWillRun: true,
      mode,
      willComment: decision.willComment,
    });
    if (shouldPostPlaceholder) {
      if (
        await skipStaleReviewOutput(
          await freshnessForReviewOutput("pre_public_output"),
        )
      )
        return undefined;
      // #regate-churn (req 4): only actually SHOW it when something is genuinely about to (re)run -- the PR
      // already carries the exact published result for this head (a same-head scheduled sweep / CI-completion
      // pass), or the review is frozen for manual review, so painting "reviewing" and then immediately
      // overwriting it with the SAME final content would otherwise defeat createOrUpdatePrIntelligenceComment's
      // own byte-identical no-op guard (it only ever compares against whatever is CURRENTLY posted).
      // A nullish (no-head/ghost) advisory.headSha can never be "the same as last published" -- markPullRequestSurfacePublished
      // itself no-ops without a real head SHA to key on, so a nullish headSha must never spuriously compare equal
      // to a nullish (never-published) lastPublishedSurfaceSha -- that would wrongly suppress the placeholder on
      // a genuinely first-time, no-head review (#regate-churn, no-head-ghost-pr regression).
      const shouldShowPlaceholderNow = !isFrozenForManualReview && (webhook.forceAiReview === true || !advisory.headSha || advisory.headSha !== pr.lastPublishedSurfaceSha);
      if (shouldShowPlaceholderNow) {
        const placeholderBody = `${PR_PANEL_COMMENT_MARKER}\n\n${renderReviewingPlaceholder()}`;
        try {
          await createOrUpdatePrIntelligenceComment(
            env,
            installationId,
            repoFullName,
            pr.number,
            placeholderBody,
            { mode },
          );
        } catch (error) {
          /* v8 ignore next -- placeholder rate-limit propagation is covered by final-comment rate-limit tests. */
          if (isGitHubRateLimitedError(error)) throw error;
          await recordAuditEvent(env, {
            eventType: "github_app.reviewing_placeholder_failed",
            actor: author,
            targetKey: `${repoFullName}#${pr.number}`,
            outcome: "error",
            detail: errorMessage(error),
            metadata: { deliveryId: webhook.deliveryId, repoFullName },
          }).catch(() => undefined);
        }
      }
    }
    if (aiReviewWillRun) {
      // Per-(repo, PR, head SHA, mode) advisory lock (#regate-dup-prep), claimed HERE — not just inside
      // runAiReviewForAdvisory — so it covers the cache-read DECISION below too, not only the LLM call itself.
      // Two near-simultaneous webhook deliveries (or a webhook racing a sweep tick) for the SAME PR at the SAME
      // head can both reach this point before either has written a cache entry; without this outer claim both
      // would independently run resolveReviewManifestForAiReview, the review-file load, the cache read, log an
      // identical "cache miss," and only THEN contend on runAiReviewForAdvisory's own (narrower) internal claim —
      // by which point the duplicate prep work (and, depending on timing, a duplicate real LLM call) already
      // happened. Claiming before ANY of that means a losing pass defers immediately: it never reads the cache,
      // never logs a miss, never loads review files, and never spends the fingerprint computation. A lost race
      // returns the shared inconclusive-hold placeholder (same shape runAiReviewForAdvisory's own claim returns)
      // rather than duplicating that work anyway — the winning pass (or the next webhook/sweep tick if the
      // winner itself fails) is the backstop that populates the cache. Passed into runAiReviewForAdvisory as
      // preAcquiredAiReviewLock so that function trusts this claim instead of re-claiming (and losing) against
      // itself; released here, AFTER the cache write below, so the lock covers the full read-decide-run-persist
      // sequence, not just the read or just the run.
      const aiReviewHeadSha = advisory.headSha;
      /* v8 ignore next -- defensive: aiReviewWillRun folds in shouldRequirePublicAiReviewForAdvisory's own
       * `!args.advisory.headSha` guard, so a truthy aiReviewWillRun always means a truthy headSha; this narrows
       * the type for claimAiReviewLock/releaseAiReviewLock (both require a non-nullish headSha) rather than
       * guard against a reachable runtime state. */
      if (!aiReviewHeadSha) return;
      const aiReviewLock = await claimAiReviewLock(
        env,
        repoFullName,
        pr.number,
        aiReviewHeadSha,
        settings.aiReviewMode,
      );
      if (!aiReviewLock.acquired) {
        aiReview = aiReviewLockContendedResult(advisory);
      } else {
        try {
          await aiReviewCacheReadDecideAndRun(aiReviewLock);
        } finally {
          await releaseAiReviewLock(
            env,
            repoFullName,
            pr.number,
            aiReviewHeadSha,
            settings.aiReviewMode,
            aiReviewLock.ownerToken,
          );
        }
      }
    }
    async function aiReviewCacheReadDecideAndRun(
      aiReviewLock: TransientLockClaim,
    ): Promise<void> {
      await withReviewPipelineSpan(
        "selfhost.review.ai",
        {
          installationId,
          repoFullName,
          pullNumber: pr.number,
          operation: "ai_review",
          agent: "dual-ai",
        },
        async () => {
          const reviewManifest = await resolveReviewManifestForAiReview(env, repoFullName, reviewManifestForAutoReview);
          // `.gittensory.yml` review.profile + review.security_focus + review.path_instructions +
          // review.exclude_paths + review.path_filters + review.ai_model (#review-profile / #review-security-focus /
          // #review-path-instructions / #review-exclude-paths / #2043 / #selfhost-ai-model-override): resolve from
          // the manifest (cached from settings resolution, so a cheap cache hit — no extra fetch) and thread them
          // into the AI review. Profile shapes nitpickiness; security-focus adds elevated scrutiny for a
          // security-defect category (orthogonal to profile); path-instructions add per-path guidance; exclude-paths
          // drop files from review; path-filters positively scope the review set after excludes; ai_model overrides
          // which self-host model/effort reviews THIS repo. Absent ⇒ byte-identical prompt/provider. Fail-safe to
          // defaults on any read error (resolveReviewPromptOverrides).
          const {
            profile: reviewProfile,
            securityFocus: reviewSecurityFocus,
            inlineComments: reviewInlineComments,
            suggestions: reviewSuggestions,
            findingCategories: reviewFindingCategories,
            pathInstructions: reviewPathInstructions,
            instructions: manifestReviewInstructions,
            tone: reviewTone,
            excludePaths: reviewExcludePaths,
            pathFilters: reviewPathFilters,
            selfHostAiModel: reviewSelfHostAiModel,
            impactMap: reviewImpactMap,
            cultureProfile: reviewCultureProfile,
          } = resolveReviewPromptOverrides(reviewManifest);
          inlineCommentsEnabledForReview = shouldRequestInlineFindings(
            env,
            repoFullName,
            reviewInlineComments,
          );
          suggestionsEnabledForReview = shouldRenderSuggestions(
            inlineCommentsEnabledForReview,
            reviewSuggestions,
          );
          findingCategoriesEnabledForReview = shouldRenderFindingCategories(
            inlineCommentsEnabledForReview,
            reviewFindingCategories,
          );
          const reviewFilesForAi = await getReviewFiles();
          const changedPaths = reviewFilesForAi.map((file) => file.path);
          // Per-repo review CONTEXT (#review-skills): fold the container-private review/AGENTS.md (or legacy
          // review/CLAUDE.md) guide + the matching review/skills/*.md modules into the SAME review-instructions slot,
          // so reviews follow each repo's conventions.
          // Glob-gated for cost (only skills matching the changed files are injected); absent config dir ⇒ empty ⇒
          // byte-identical prompt. getReviewFiles() is memoized, so the second call reuses the loaded diff.
          const reviewInstructions =
            [
              composeManifestReviewInstructions(manifestReviewInstructions, reviewTone),
              composeRepoReviewContext(
                await loadRepoReviewContext(repoFullName),
                changedPaths,
              ),
            ]
              .map((part) => part?.trim())
              .filter(Boolean)
              .join("\n\n") || null;
          const convergedRepoAllowed = isConvergenceRepoAllowed(env, repoFullName);
          // Resolved ONCE and reused both for the fingerprint AND the cache-bypass decision below: grounding/RAG/
          // enrichment/reputation each pull TIME-VARYING external context (live CI checks, the vector index,
          // REES/CVE data, the submitter's evolving reputation) that can change for the SAME head SHA without
          // any of these booleans flipping. Fingerprinting only "is the feature on" can't detect that drift
          // without fetching the content itself (which would defeat caching), so a repo with ANY of these active
          // bypasses the cache entirely rather than fingerprinting a value that can't prove freshness.
          const dynamicReviewFeatures = {
            grounding: resolveConvergedFeature(env, reviewManifest, "grounding", repoFullName),
            rag: resolveConvergedFeature(env, reviewManifest, "rag", repoFullName),
            enrichment: isEnrichmentEnabled(env) && convergedRepoAllowed,
            reputation: resolveConvergedFeature(
              env,
              reviewManifest,
              "reputation",
              repoFullName,
            ),
            // Repo quality-culture profile (#2995): its own cache (signal_snapshots, TTL + merged-PR-count
            // invalidation) can refresh independently of this PR's head SHA, exactly like RAG's vector index —
            // so a repo with it active also bypasses the AI-review result cache rather than fingerprinting a
            // value that can't prove freshness.
            cultureProfile: isRepoCultureProfileEnabled(env) && reviewCultureProfile === true,
            // Impact map (#2182-#2186): queries the SAME live vector index RAG does (computeImpactMap issues
            // its own retrieveContextWithMetrics calls), so it can go stale for the SAME head SHA exactly like
            // RAG — a repo with it active also bypasses the AI-review result cache.
            impactMap: shouldComputeImpactMap(env, reviewImpactMap === true),
          };
          const dynamicReviewContextActive =
            dynamicReviewFeatures.grounding ||
            dynamicReviewFeatures.rag ||
            dynamicReviewFeatures.enrichment ||
            dynamicReviewFeatures.reputation ||
            dynamicReviewFeatures.cultureProfile ||
            dynamicReviewFeatures.impactMap;
          const inputFingerprint = await aiReviewCacheInputFingerprint({
            title: pr.title,
            mode: settings.aiReviewMode,
            byok: settings.aiReviewByok,
            provider: settings.aiReviewProvider,
            model: settings.aiReviewModel,
            aiReviewAllAuthors: settings.aiReviewAllAuthors,
            aiReviewCloseConfidence: settings.aiReviewCloseConfidence,
            aiReviewCombine: settings.aiReviewCombine,
            aiReviewOnMerge: settings.aiReviewOnMerge,
            aiReviewReviewers: settings.aiReviewReviewers,
            gatePack: settings.gatePack,
            reviewerPlan: env.AI_REVIEW_PLAN,
            selfHostProviderConfig: env.AI_REVIEW_PLAN
              ? {
                  claudeModel: env.CLAUDE_AI_MODEL,
                  claudeEffort: env.CLAUDE_AI_EFFORT,
                  claudeTimeoutMs: env.CLAUDE_AI_TIMEOUT_MS,
                  codexModel: env.CODEX_AI_MODEL,
                  codexEffort: env.CODEX_AI_EFFORT,
                  codexTimeoutMs: env.CODEX_AI_TIMEOUT_MS,
                  ollamaBaseUrl: env.OLLAMA_AI_BASE_URL,
                  ollamaModel: env.OLLAMA_AI_MODEL,
                  openaiCompatibleBaseUrl: env.OPENAI_COMPATIBLE_AI_BASE_URL,
                  openaiCompatibleModel: env.OPENAI_COMPATIBLE_AI_MODEL,
                  openaiBaseUrl: env.OPENAI_AI_BASE_URL,
                  openaiModel: env.OPENAI_AI_MODEL,
                  anthropicBaseUrl: env.ANTHROPIC_AI_BASE_URL,
                  anthropicModel: env.ANTHROPIC_AI_MODEL,
                }
              : null,
            selfHostAiModelOverride: reviewSelfHostAiModel,
            profile: reviewProfile,
            securityFocus: reviewSecurityFocus,
            inlineComments: inlineCommentsEnabledForReview,
            pathInstructions: reviewPathInstructions,
            pathGuidance: resolveReviewPathInstructions(
              reviewPathInstructions,
              changedPaths,
            ),
            repoInstructions: reviewInstructions,
            excludePaths: reviewExcludePaths,
            pathFilters: reviewPathFilters,
            changedPaths,
            reviewFiles: reviewFilesForAi.map((file) => ({
              path: file.path,
              status: file.status,
              patch: typeof file.payload?.patch === "string" ? file.payload.patch : undefined,
              additions: file.additions,
              deletions: file.deletions,
            })),
            features: dynamicReviewFeatures,
          });
          // #1 self-host AI-review cache: the LLM output for a PR changes only when the code (head SHA), review
          // mode, reviewer plan, feature activation, or prompt-shaping inputs change. A re-delivered webhook or the
          // block-mode re-gate sweep can reuse that exact review; stale same-head reviews from older private review
          // instructions or feature config are intentionally treated as misses. The deterministic gate still runs.
          // `webhook.forceAiReview` (a manual re-gate, if the caller opts in) bypasses the cache entirely: the
          // caller is explicitly asking for a fresh opinion, not a replayed one.
          //
          // #regate-churn (root cause, confirmed in production): a repo with an active dynamic-context feature
          // (grounding/RAG/enrichment/reputation) used to bypass the cache UNCONDITIONALLY on every single call,
          // on the theory that TIME-VARYING external context (the vector index, REES/CVE data, evolving
          // reputation) can drift for the SAME head SHA without any of these booleans flipping, and fingerprinting
          // only "is the feature on" can't detect that drift without fetching the content itself. That reasoning
          // is right for a genuinely time-sensitive re-check, but a live incident showed it also means a
          // dynamic-context repo re-spends an LLM call on EVERY scheduled sweep tick forever, with no bound at
          // all: one PR with RAG enabled generated 259 of 281 AI review calls in 24h this way, at an UNCHANGED
          // head. A dynamic-context result is therefore now always written non-durably (cacheable=false, same as
          // a consensus-defect/inconclusive outcome below) rather than not written at all, so it can ALSO be
          // reused for a bounded cooldown (AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS) — long enough to collapse a
          // sweep tick's worth of redundant calls into one, short enough that genuinely drifted external context
          // is still picked up well within the hour. A genuinely cacheable, non-dynamic-context row is unaffected
          // (unbounded reuse, exactly as before this fix).
          const cachedReview = webhook.forceAiReview === true
            ? null
            : await getCachedAiReview(
                env,
                repoFullName,
                pr.number,
                advisory.headSha,
                settings.aiReviewMode,
                inputFingerprint,
                { allowNonCacheable: true, maxAgeMs: AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS },
              ).catch(() => null);
          if (cachedReview && hasPublicReviewAssessment(cachedReview.notes)) {
            advisory.findings.push(...cachedReview.findings);
            aiReview = cachedReview;
            aiReviewWasReused = true;
            incr("gittensory_ai_review_cache_hit_total");
            await recordAuditEvent(env, {
              eventType: "github_app.ai_review_cache_hit",
              actor: author,
              targetKey: `${repoFullName}#${pr.number}`,
              outcome: "completed",
              detail: "reused a stored AI review instead of re-spending an LLM call",
              metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
            }).catch(() => undefined);
            await recordAuditEvent(env, {
              eventType: "agent.sweep.regate_ai_skipped_current",
              actor: author,
              targetKey: `${repoFullName}#${pr.number}`,
              outcome: "completed",
              detail: "AI review already current for this head+fingerprint; skipped re-review",
              metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
            }).catch(() => undefined);
            incr("gittensory_regate_ai_skipped_current_total");
          } else {
            // A forced bypass is NOT a cache miss — the cache may well have had a valid, reusable entry; the
            // caller explicitly asked to skip it. Counting it under the miss metric would make "the cache failed
            // to serve" indistinguishable from "a caller deliberately opted out," which muddies exactly the
            // incident-dashboard signal this whole fix exists to provide.
            if (webhook.forceAiReview === true) {
              incr("gittensory_ai_review_force_bypass_total");
              await recordAuditEvent(env, {
                eventType: "github_app.ai_review_force_bypass",
                actor: author,
                targetKey: `${repoFullName}#${pr.number}`,
                outcome: "completed",
                detail: "explicit force re-gate bypassed the AI review cache and cooldown",
                metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
              }).catch(() => undefined);
            } else {
              incr("gittensory_ai_review_cache_miss_total");
              await recordAuditEvent(env, {
                eventType: "github_app.ai_review_cache_miss",
                actor: author,
                targetKey: `${repoFullName}#${pr.number}`,
                outcome: "completed",
                detail: "no reusable stored AI review for this head+fingerprint; running a fresh review",
                metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
              }).catch(() => undefined);
            }
            aiReview = await runAiReviewForAdvisory(env, {
              mode,
              settings,
              advisory,
              installationId,
              repoFullName,
              pr: { ...pr, baseSha: webhook.baseSha ?? null },
              author,
              confirmedContributor,
              files: reviewFilesForAi,
              reviewProfile,
              reviewSecurityFocus,
              reviewPathInstructions,
              reviewInstructions,
              reviewExcludePaths,
              reviewPathFilters,
              reviewInlineComments,
              reviewFindingCategories,
              reviewSelfHostAiModel,
              reviewImpactMap,
              reviewCultureProfile,
              // #regate-dup-prep: this call's own advisory lock is already claimed (by aiReviewCacheReadDecideAndRun's
              // caller, above) — pass it through so runAiReviewForAdvisory trusts it instead of re-claiming (and
              // losing) against itself, and does not release it before the cache write below runs.
              preAcquiredAiReviewLock: aiReviewLock,
              deliveryId: webhook.deliveryId,
              preComputedReputationSkip,
            });
            // `persistable === false` (only the lock-contention placeholder — see runAiReviewForAdvisory's return
            // type doc comment) is excluded from EVERY write, not just the durable one: it describes a transient
            // scheduling race, not a real AI opinion, and the concurrent pass it deferred to persists the real
            // result within seconds — writing this placeholder (even non-durably) could replay a stale "another
            // pass is running" message for the rest of the cooldown window, well after that race resolved.
            if (aiReview && aiReview.persistable !== false) {
              // A dynamic-context result is never durably cacheable (see the comment above); otherwise defer to
              // the review's own verdict (consensus defect / inconclusive → false).
              const cacheableForStorage = !dynamicReviewContextActive && aiReview.cacheable !== false;
              if (!cacheableForStorage) {
                incr("gittensory_ai_review_non_cacheable_total");
                await recordAuditEvent(env, {
                  eventType: "github_app.ai_review_non_cacheable",
                  actor: author,
                  targetKey: `${repoFullName}#${pr.number}`,
                  outcome: "completed",
                  detail: "AI review outcome is not durably cacheable; persisted for bounded-cooldown reuse only",
                  metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
                }).catch(() => undefined);
              }
              await putCachedAiReview(
                env,
                repoFullName,
                pr.number,
                advisory.headSha,
                settings.aiReviewMode,
                {
                  ...aiReview,
                  cacheable: cacheableForStorage,
                  metadata: {
                    /* v8 ignore next -- runAiReviewForAdvisory (the sole path reaching here) always sets metadata on its "ok" returns; the nullish fallback is a type-level (optional field) safeguard, not a reachable runtime path. */
                    ...(aiReview.metadata ?? {}),
                    inputFingerprint,
                    // Persist line-anchored findings for post-submission MCP readback (#4519). Inline comments
                    // themselves are still only posted on a fresh review (see inlineFindings hoisting above);
                    // this metadata is read-only structured output, not a cache-replay trigger.
                    ...(aiReview.inlineFindings && aiReview.inlineFindings.length > 0
                      ? { inlineFindings: aiReview.inlineFindings }
                      : {}),
                  },
                },
              ).catch((error) => {
                // #regate-churn (req 3/9): a swallowed write failure here is exactly how the cache goes silently
                // stale in production — make it observable instead of a bare no-op catch.
                incr("gittensory_ai_review_cache_write_error_total");
                return recordAuditEvent(env, {
                  eventType: "github_app.ai_review_cache_write_error",
                  actor: author,
                  targetKey: `${repoFullName}#${pr.number}`,
                  outcome: "error",
                  detail: errorMessage(error),
                  metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
                }).catch(() => undefined);
              });
            }
          }
        },
      );
    }
    if (aiReviewExpected && !hasPublicReviewAssessment(aiReview?.notes)) {
      const message =
        "AI review did not produce a public summary; publishing deterministic PR surface without AI notes";
      await recordAuditEvent(env, {
        eventType: "github_app.ai_review_public_summary_missing",
        actor: author,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        detail: message,
        metadata: {
          deliveryId: webhook.deliveryId,
          repoFullName,
          aiReviewMode: settings.aiReviewMode,
        },
      }).catch(() => undefined);
      captureReviewFailure(new Error(message), {
        kind: "review",
        reason: "ai_review_public_summary_missing",
        installationId,
        repo: repoFullName,
        pr: pr.number,
        head_sha: advisory.headSha,
        reviewer_count: aiReview?.reviewerCount ?? 0,
        public_notes: hasPublicReviewAssessment(aiReview?.notes),
      });
    }

    // Secrets-scan (#audit-3.4): always scans the REAL resolved diff and, on a CONCRETE credential hit, appends a
    // critical `secret_leak` hard blocker BEFORE the gate evaluates — unconditionally, since a committed token is
    // a leak on any repo. getReviewFiles() is memoized, so this reuses the already-loaded diff when present.
    await maybeAddSecretLeakFinding(env, {
      advisory,
      repoFullName,
      pullNumber: pr.number,
      files: await getReviewFiles(),
      installationId,
      headSha: advisory.headSha,
      baseSha: webhook.baseSha ?? null,
    });

    // Lockfile-tamper-risk scan (#2563): opt-in via `lockfileIntegrityGateMode` (default off — the scan is
    // skipped entirely). getReviewFiles() is memoized, so this reuses the already-loaded diff when present.
    await maybeAddLockfileTamperFinding(env, {
      advisory,
      repoFullName,
      pullNumber: pr.number,
      lockfileIntegrityGateMode: settings.lockfileIntegrityGateMode,
      files: await getReviewFiles(),
    });

    // Unresolved GitHub review threads (for example external security scanner inline findings) are blocking
    // review facts. Fetch them before gate evaluation so the normal blocker path drives the check-run, comment,
    // and disposition consistently. Fail-open on GitHub/GraphQL errors: a transient thread-read failure should not
    // invent a blocker, but any thread we can see must be resolved before approval/merge. Gated on
    // shouldEvaluateGate (#2852), not gateEnabled alone, so a disabled-check-run repo with autonomy configured
    // still gets this blocker fed into the merge/close decision.
    if (shouldEvaluateGate) {
      const reviewThreadToken =
        (await createInstallationToken(env, installationId).catch(
          () => undefined,
        )) ?? env.GITHUB_PUBLIC_TOKEN;
      const reviewThreadAdmissionKey = githubAdmissionKeyForToken(env, installationId, reviewThreadToken);
      const reviewThreadBlockers = await fetchLiveReviewThreadBlockers(
        env,
        repoFullName,
        pr.number,
        reviewThreadToken,
        reviewThreadAdmissionKey,
      ).catch(() => []);
      advisory.findings.push(...reviewThreadBlockers.map(reviewThreadBlockerFinding));
    }

    // First-time-contributor grace (#552): compute the author's complete per-repo PR history
    // (excluding this PR) with an aggregate DB query. Do not derive policy-enforcement history from
    // the bounded repoPullRequests sample; missing or case-mismatched history could soften a block.
    const authorHistory = await loadGateAuthorHistory(
      env,
      repoFullName,
      author,
      pr.number,
    );

    // PR-size + guardrail manual-review HOLD (#gate-size / #gate-guardrail): compute the live change size + the
    // guardrail-hit from the resolved files (getReviewFiles is memoized — no extra fetch) so the gate can HOLD an
    // oversized or guardrail-touching PR (neutral → "manual" verdict), visible even in advisory/dry-run.
    const sizeGateFiles = await getReviewFiles();
    const hardGuardrailGlobs = resolveHardGuardrailGlobs(settings);
    const guardrailChangedPaths = changedPathsForGuardrail(sizeGateFiles);
    const gateSizeContext = {
      changedFileCount: sizeGateFiles.length,
      changedLineCount: sizeGateFiles.reduce(
        (n, f) => n + f.additions + f.deletions,
        0,
      ),
      guardrailHit: isGuardrailHit(guardrailChangedPaths, hardGuardrailGlobs),
      guardrailMatches: guardrailPathMatches(guardrailChangedPaths, hardGuardrailGlobs),
    };
    const gatePolicy = gateCheckPolicy(
      settings,
      readiness.total,
      confirmedContributor,
      slopRisk,
      authorHistory,
      gateSizeContext,
    );
    gateEvaluation = await withReviewPipelineSpan(
      "selfhost.review.gate",
      {
        installationId,
        repoFullName,
        pullNumber: pr.number,
        operation: "gate_decision",
      },
      async () => {
        // #2852: computed whenever the check-run publishes OR autonomous merge/close needs a conclusion to act
        // on — this is the actual gate CONCLUSION, independent of whether anything gets published to GitHub.
        let evaluation = shouldEvaluateGate
          ? evaluateGateCheck(advisory, gatePolicy)
          : undefined;
        // Deterministic content/registry surface lane (#1255) — flag-gated + per-repo allowlist, byte-identical when
        // off (evaluateWithSurfaceLane returns the generic evaluation unchanged and resolves no files). A metagraphed
        // registry-submission PR's surface verdict OVERRIDES the generic gate; the helper preserves a generic HARD
        // blocker (e.g. a committed secret) and an unreadable head defers. AI-free → independent of the AI reviewer.
        evaluation = await evaluateWithSurfaceLane(
          env,
          repoFullName,
          shouldEvaluateGate,
          evaluation,
          {
            installationId,
            pr,
            repo,
            advisory,
            getChangedFiles: getReviewFiles,
          },
        );
        if (evaluation)
          await setReviewPipelineSpanOutcome({
            decisionOutcome: evaluation.conclusion,
          });
        return evaluation;
      },
    );
    // #554 gate false-positive telemetry: when the gate BLOCKS, record the block (one latest row per PR) so a
    // maintainer can later compute a per-gate-type false-positive rate (blocked-then-merged / blocked).
    // MEASUREMENT only — never adjusts the gate. Best-effort: a write failure must NOT abort finalization
    // (mirrors the slop-assessment persist above). Privacy: codes + PR number only, no actor/trust fields.
    if (gateEvaluation?.conclusion === "failure") {
      const blockerCodes = gateEvaluation.blockers.map(
        (blocker) => blocker.code,
      );
      await recordGateBlockOutcome(env, {
        repoFullName,
        pullNumber: pr.number,
        headSha: pr.headSha,
        blockerCodes,
      }).catch(() => undefined);
      await recordGithubProductUsage(env, "gate_blocked", {
        repoFullName,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        metadata: { blockerCodes },
      });
    }
    // #preconv-parity (convergence prep): SHADOW-record the gittensory-native gate decision (source=
    // 'gittensory-native') into review_audit so the pre-cutover parity harness has data to read. RECORD-ONLY,
    // flag-gated by GITTENSORY_REVIEW_PARITY_AUDIT: flag-OFF (default) is an immediate no-op (NO D1 write) so the review
    // path is BYTE-IDENTICAL to today; flag-ON it writes one row and changes NO behavior. Best-effort. The
    // authoritative 'reviewbot' rows it is later compared against are written by reviewbot's deploy-time dual-
    // run, not here (see src/review/parity-wire.ts). Only a finalized gate evaluation (not skipped) is recorded.
    if (gateEvaluation) {
      // #terminal-outcome-audit: a neutral conclusion is now ALSO recorded as a hold (nativeGateActionFromConclusion),
      // so give it the same bounded-reason-class treatment "failure" already gets, instead of falling back to
      // the bare "neutral" string -- an operator asking "why is this held" should see guardrail_hold /
      // oversized_pr / ai_review_inconclusive / etc, not an undifferentiated bucket.
      const reasonCode =
        gateEvaluation.conclusion === "failure"
          ? (gateEvaluation.blockers[0]?.code ?? gateEvaluation.conclusion)
          : (neutralHoldReasonCode(gateEvaluation) ?? gateEvaluation.conclusion);
      await recordNativeGateDecision(env, {
        project: repoFullName,
        pullNumber: pr.number,
        headSha: pr.headSha,
        conclusion: gateEvaluation.conclusion,
        reasonCode,
      });
      // #2349 (PR 1): additive per-contributor calibration data, mirroring recordNativeGateDecision's own
      // action derivation above so both writers agree on whether this conclusion is a comparable decision --
      // see src/review/contributor-calibration.ts's doc comment. Currently write-only.
      const contributorDecision = nativeGateActionFromConclusion(gateEvaluation.conclusion);
      // unreachable implicit-else at THIS call site: gateEvaluation is only "skipped" (the one conclusion
      // nativeGateActionFromConclusion maps to null) when shouldEvaluateGate is false, which leaves
      // gateEvaluation itself undefined and never reaches this branch (see the outer `if (gateEvaluation)`
      // above) -- neither evaluateGateCheck/evaluateGateCheckCore nor evaluateWithSurfaceLane ever construct
      // a "skipped" conclusion object. Kept as a real (not asserted-away) null check for robustness against a
      // future caller that does produce one, mirroring recordNativeGateDecision's own defensive null-check.
      /* v8 ignore else */
      if (contributorDecision !== null) {
        await recordContributorGateDecision(env, {
          login: pr.authorLogin,
          project: repoFullName,
          pullNumber: pr.number,
          headSha: pr.headSha,
          decision: contributorDecision,
        });
        // #4517: same pairing as the other recordContributorGateDecision call site above.
        await recordPredictedGateCalibration(env, {
          login: pr.authorLogin,
          project: repoFullName,
          pullNumber: pr.number,
          headSha: pr.headSha,
          decision: contributorDecision,
        });
      }
    }
    // Review-evasion protection (#review-evasion-protection): the cost-bearing review pass for this head has
    // now concluded (the gate decision is made) -- terminalize the active-review row so a close/draft-convert
    // AFTER this point is treated as an ordinary action, not evasion of a still-running review. Scoped to this
    // head so a slower, superseded pass can never clear a NEWER pass's still-active tracking. Symmetric with
    // the startActiveReviewTracking call above (same aiReviewWillRun gate).
    if (aiReviewWillRun && pr.headSha) {
      await terminalizeActiveReviewTracking(env, repoFullName, pr.number, { onlyIfHeadSha: pr.headSha }).catch(() => undefined);
    }
    // #regate-churn (req 6/7): a public-surface no-op guard, deliberately narrow. markPullRequestSurfacePublished's
    // own doc comment warns lastPublishedSurfaceSha is "reporting/diagnostic state, not a hard scheduled-sweep
    // skip" because a comment can be stale or partial even when the head marker matches — so this ONLY applies to
    // a check-run-only repo (publicSurface "off": no comment, no label ever published, nothing else that marker
    // can't prove current) with an independently-verified COMPLETED check run at the exact current head, no
    // pending refresh signal (slop evidence / manifest gate / pre-merge-check / reviews-cache staleness — see
    // hasPendingRefreshSignal), and an AI review dimension that is either not in play or was itself reused rather
    // than freshly computed. Any doubt on any of these falls through to the full, unconditional publish below —
    // this guard is only ever allowed to skip a PROVABLE no-op, never to guess one.
    if (
      gateEnabled &&
      settings.publicSurface === "off" &&
      !webhook.hasPendingRefreshSignal &&
      !webhook.forceAiReview &&
      (!aiReviewWillRun || aiReviewWasReused) &&
      advisory.headSha &&
      advisory.headSha === pr.lastPublishedSurfaceSha
    ) {
      const existingChecks = await listCheckSummaries(env, repoFullName, pr.number).catch(() => []);
      const currentGateCheck = existingChecks.find(
        (check) =>
          check.name === GITTENSORY_GATE_CHECK_NAME &&
          check.headSha === advisory.headSha &&
          check.status === "completed",
      );
      if (currentGateCheck) {
        let canSkipCurrentSurface = true;
        if (pendingGateCheckRunId !== undefined) {
          const refreshedGateCheckResult = await createOrUpdateGateCheckRun(
            env,
            installationId,
            repoFullName,
            advisory,
            gatePolicy,
            { checkRunId: pendingGateCheckRunId, gate: gateEvaluation },
            mode,
          );
          /* v8 ignore next -- refreshedGateCheckResult is only ever null when advisory.headSha is falsy or the
           * write is dry-run-suppressed; pendingGateCheckRunId !== undefined already proves headSha was truthy
           * and mode was "live" for the earlier pending-check post in this SAME pass (mode/advisory are both
           * immutable locals shared by both calls), so the nullish `?.` short-circuit here is unreachable. */
          if (refreshedGateCheckResult?.kind === "published") {
            await recordPublishedGateCheckSummary(env, {
              repoFullName,
              pullNumber: pr.number,
              headSha: advisory.headSha,
              checkRunId: refreshedGateCheckResult.id,
              conclusion: gateEvaluation?.conclusion ?? null,
              detailsUrl: refreshedGateCheckResult.html_url,
              deliveryId: webhook.deliveryId,
            }).catch((error) => {
              console.error(
                JSON.stringify({
                  level: "warn",
                  event: "gate_check_summary_upsert_failed",
                  repoFullName,
                  pullNumber: pr.number,
                  error: errorMessage(error),
                }),
              );
            });
          } else {
            canSkipCurrentSurface = false;
          }
        }
        if (canSkipCurrentSurface) {
          incr("gittensory_public_surface_publish_skipped_current_total");
          await recordAuditEvent(env, {
            eventType: "github_app.public_surface_publish_skipped_current",
            actor: author,
            targetKey: `${repoFullName}#${pr.number}`,
            outcome: "completed",
            detail: "public surface already current for this head; skipped republish",
            metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
          }).catch(() => undefined);
          return gateEvaluation;
        }
        // The no-op proof is only safe if the pending check this pass created is terminal too.
        // Fall through to the normal publish path on any doubt so branch protection cannot be left pending.
      }
    }
    const finalFreshness = await freshnessForReviewOutput("final_publish");
    if (await skipStaleReviewOutput(finalFreshness)) {
      return undefined;
    }
    if (gateEnabled) {
      try {
        const gateCheckResult = await withReviewPipelineSpan(
          "selfhost.review.publish.check_run",
          {
            installationId,
            repoFullName,
            pullNumber: pr.number,
            operation: "publish_check_run",
            decisionOutcome: gateEvaluation?.conclusion,
          },
          () =>
            // #3698/#security: auto_review skip reasons are AI-review eligibility only. They may come
            // from PR-controlled metadata, so the quiet skipped status is safe only after the deterministic
            // gate has already passed; failures/holds must publish their real blocking conclusion.
            autoReviewSkipReason && !publicSurfaceSkipped && gateEvaluation?.conclusion === "success"
              ? createOrUpdateSkippedGateCheckRun(
                  env,
                  installationId,
                  repoFullName,
                  advisory,
                  resolveAutoReviewSkipSummary(autoReviewSkipReason),
                  mode,
                  { checkRunId: pendingGateCheckRunId },
                )
              : createOrUpdateGateCheckRun(
                  env,
                  installationId,
                  repoFullName,
                  advisory,
                  gatePolicy,
                  {
                    checkRunId: pendingGateCheckRunId,
                    // #5 (audit): publish the AUTHORITATIVE surface-lane-merged verdict so the check-run conclusion matches
                    // the disposition; without this the check re-derives the generic verdict and shows green on a surface-
                    // lane reject/manual PR that is actually auto-closed/held. Undefined (gate off) ⇒ re-derive (identical).
                    gate: gateEvaluation,
                  },
                  mode,
                ),
        );
        if (gateCheckResult?.kind === "published") {
          gateFinalized = true;
          publishedOutputs.push("gate_check_run");
          await recordPublishedGateCheckSummary(env, {
            repoFullName,
            pullNumber: pr.number,
            headSha: advisory.headSha,
            checkRunId: gateCheckResult.id,
            /* v8 ignore next -- gate-enabled publication always has a gate evaluation. */
            conclusion:
              autoReviewSkipReason && !publicSurfaceSkipped && gateEvaluation?.conclusion === "success"
                ? "skipped"
                : (gateEvaluation?.conclusion ?? null),
            detailsUrl: gateCheckResult.html_url,
            deliveryId: webhook.deliveryId,
          }).catch((error) => {
            console.error(
              JSON.stringify({
                level: "warn",
                event: "gate_check_summary_upsert_failed",
                repoFullName,
                pullNumber: pr.number,
                error: errorMessage(error),
              }),
            );
          });
        }
        if (gateCheckResult?.kind === "permission_missing") {
          await auditGateCheckPermissionMissing(
            env,
            author,
            repoFullName,
            pr.number,
            webhook.deliveryId,
            gateCheckResult.warning,
          );
          // A permission_missing completion result does NOT throw, so the catch below never runs and the pending
          // in_progress check would be orphaned. But the pending check already posted (pendingGateCheckRunId is
          // set), proving the App could write checks for this head at least once. Finalize the pending check to
          // neutral (mirrors the catch); if access was truly revoked this PATCH also fails and is swallowed.
          if (pendingGateCheckRunId !== undefined && !gateFinalized) {
            const fallbackGateCheckResult = await createOrUpdateErroredGateCheckRun(
              env,
              installationId,
              repoFullName,
              advisory,
              { checkRunId: pendingGateCheckRunId },
              mode,
            ).catch(() => undefined);
            if (fallbackGateCheckResult?.kind === "published") {
              gateFinalized = true;
              publishedOutputs.push("gate_check_run");
              await recordPublishedGateCheckSummary(env, {
                repoFullName,
                pullNumber: pr.number,
                headSha: advisory.headSha,
                checkRunId: fallbackGateCheckResult.id,
                conclusion: "neutral",
                detailsUrl: fallbackGateCheckResult.html_url,
                deliveryId: webhook.deliveryId,
              }).catch((error) => {
                console.error(
                  JSON.stringify({
                    level: "warn",
                    event: "gate_check_summary_upsert_failed",
                    repoFullName,
                    pullNumber: pr.number,
                    error: errorMessage(error),
                  }),
                );
              });
            }
          }
        }
      } catch (checkError) {
        if (isGitHubRateLimitedError(checkError)) throw checkError;
        // CRITICAL: a check-run API failure (e.g. a 422 from an over-long output.title) must NEVER abort the
        // review. The outer catch re-throws → the comment, the audit row, and the auto-action (merge/close)
        // would all be skipped and the review dead-lettered. That is exactly why red-CI PRs (whose gate title
        // grew long with failing-check names) were silently never reviewed or closed. Finalize the pending
        // check to a neutral terminal state so it doesn't hang, log, and CONTINUE — do not re-throw.
        if (pendingGateCheckRunId !== undefined && !gateFinalized) {
          const fallbackGateCheckResult = await createOrUpdateErroredGateCheckRun(
            env,
            installationId,
            repoFullName,
            advisory,
            { checkRunId: pendingGateCheckRunId },
            mode,
          ).catch(() => undefined);
          if (fallbackGateCheckResult?.kind === "published") {
            gateFinalized = true;
            publishedOutputs.push("gate_check_run");
            await recordPublishedGateCheckSummary(env, {
              repoFullName,
              pullNumber: pr.number,
              headSha: advisory.headSha,
              checkRunId: fallbackGateCheckResult.id,
              conclusion: "neutral",
              detailsUrl: fallbackGateCheckResult.html_url,
              deliveryId: webhook.deliveryId,
            }).catch((error) => {
              console.error(
                JSON.stringify({
                  level: "warn",
                  event: "gate_check_summary_upsert_failed",
                  repoFullName,
                  pullNumber: pr.number,
                  error: errorMessage(error),
                }),
              );
            });
          }
        }
        await recordAuditEvent(env, {
          eventType: "github_app.gate_check_failed_nonfatal",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "error",
          detail: errorMessage(checkError),
          metadata: { deliveryId: webhook.deliveryId, repoFullName },
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    /* v8 ignore next -- outer fail-safe preserves queue retry semantics already covered by retryable queue tests. */
    if (isGitHubRateLimitedError(error) || isRetryableJobError(error)) throw error;
    // The pending Gate check was posted but evaluation could not finish. Finalize it to a neutral
    // (non-blocking) terminal state so it never hangs in_progress; it re-runs on the next push. Only when
    // the gate was enabled, a pending check id exists, and a real conclusion was not already published.
    if (gateEnabled && pendingGateCheckRunId !== undefined && !gateFinalized) {
      /* v8 ignore next -- outer-catch recovery for a mid-evaluation throw; the mode-threaded errored-finalize is exercised by its inner-catch twin above */
      await createOrUpdateErroredGateCheckRun(
        env,
        installationId,
        repoFullName,
        advisory,
        { checkRunId: pendingGateCheckRunId },
        mode,
      ).catch(() => undefined);
      await recordAuditEvent(env, {
        eventType: "github_app.gate_finalized_on_error",
        actor: author,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "error",
        detail: errorMessage(error),
        metadata: { deliveryId: webhook.deliveryId, repoFullName },
      }).catch(() => undefined);
    }
    throw error;
  }

  if (!prelimHasPublicOutput) return finishPublicSurfacePublication();
  if (publicSurfaceSkipped || !official || !author)
    return finishPublicSurfacePublication();

  const [github] = await Promise.all([
    fetchPublicContributorProfile(author, env),
  ]);
  const contributorPullRequests: Awaited<
    ReturnType<typeof listContributorPullRequests>
  > = [];
  const contributorIssues: Awaited<ReturnType<typeof listContributorIssues>> =
    [];
  const repoStats: Awaited<ReturnType<typeof listContributorRepoStats>> =
    official.status === "confirmed"
      ? contributorRepoStatsFromGittensor(official.snapshot)
      : [];
  const detection =
    official.status === "confirmed"
      ? officialGittensorContributorDetection(
          official.snapshot,
          pr,
          contributorPullRequests,
          contributorIssues,
          repoStats,
        )
      : {
          detected: false,
          reason: "Official Gittensor API did not confirm this GitHub user.",
          priorPullRequests: 0,
          priorMergedPullRequests: 0,
          priorIssues: 0,
        };

  const profile = buildContributorProfile(
    author,
    github,
    contributorPullRequests,
    contributorIssues,
    repoStats,
    official.status === "confirmed" ? official.snapshot : null,
  );
  if (decision.willCheckRun && advisory.headSha) {
    try {
      // FIX B: the check-run annotations/details need the real diff too — reuse the shared resolver (one resolve
      // per review; inline-fetches when the stored rows are still empty from a pre-detail-sync first review).
      const checkRunFiles = await getReviewFiles();
      const checkRunResult = await createOrUpdateCheckRun(
        env,
        installationId,
        repoFullName,
        advisory,
        settings.checkRunDetailLevel,
        {
          files: checkRunFiles,
          collisions,
          pullNumber: pr.number,
        },
        mode,
      );
      if (checkRunResult?.kind === "permission_missing") {
        failedOutputs.push({
          output: "check_run",
          error: checkRunResult.warning,
          transient: false,
        });
        await recordAuditEvent(env, {
          eventType: "github_app.check_run_permission_missing",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "error",
          detail: checkRunResult.warning,
          metadata: { deliveryId: webhook.deliveryId, repoFullName },
        });
        console.error(JSON.stringify({ level: "error", event: "check_run_permission_missing", message: checkRunResult.warning, repository: repoFullName, pullNumber: pr.number, deliveryId: webhook.deliveryId }));
      } else if (checkRunResult?.kind === "published") {
        publishedOutputs.push("check_run");
      }
    } catch (error) {
      const message = errorMessage(error);
      failedOutputs.push({ output: "check_run", error: message, transient: isGitHubTransientPublishError(error) });
      await recordPublicSurfaceOutputFailure(
        env,
        "check_run",
        author,
        repoFullName,
        pr.number,
        webhook.deliveryId,
        message,
      );
      /* v8 ignore next -- comment rate-limit retry propagation is covered by the reviewing-placeholder retry test. */
      if (isGitHubRateLimitedError(error)) throw error;
    }
  }

  if (decision.willComment) {
    // Maintainer review-content overrides may come from private self-host config, but validation warnings
    // rendered in the public PR comment must come only from the repo-published manifest.
    const [repoFocusManifestForComment, publicRepoFocusManifestForComment] = await Promise.all([
      loadRepoFocusManifest(env, repoFullName),
      loadPublicRepoFocusManifest(env, repoFullName).catch(() => null),
    ]);
    const reviewConfig = repoFocusManifestForComment.review;
    // Duplicate-winner adjudication (#dup-winner): thread the flag into the public panel builders so the
    // winner's hard-duplicate block is suppressed (they recompute the winner from their own open-only sibling
    // list). Flag-OFF (default) ⇒ false ⇒ the panels are byte-identical to today.
    const duplicateWinnerEnabled = env.GITTENSORY_DUPLICATE_WINNER === "true";
    const commentArgs = {
      repo,
      pr,
      profile,
      detection,
      queueHealth,
      collisions,
      preflight,
      settings,
      gate: gateEvaluation,
      review: reviewConfig,
      aiReview,
      duplicateWinnerEnabled,
    };
    let deterministicBody: string;
    // Convergence (Stage D): when the unified-review-comment flag is ON, render the single converged comment
    // (gittensory shape + reviewbot's review folded in). The gate stays authoritative (passed as `decision`),
    // and the body carries the SAME panel marker so the upsert updates in place. Flag-OFF (default) keeps the
    // legacy panel byte-identical. Only the comment lane is affected; the gate check-run/labels/audit are not.
    //
    // RECONCILIATION INVARIANT (#1016 — two-gate → one authoritative path; pinned by
    // test/unit/unified-comment-bridge.test.ts "reconciliation invariant"):
    //   1. ONE AI pass. `runAiReviewForAdvisory` ran exactly once above (line ~1600) and its result feeds
    //      BOTH surfaces: it mutated `advisory.findings` with the `ai_consensus_defect` (which the SAME
    //      `gateEvaluation` already read via evaluateGateCheck) AND returned `aiReview.notes`. We pass that
    //      same `advisory.findings` here so the bridge RECOVERS the consensus defect (consensusDefectFromFindings)
    //      — it never makes a second model call or a divergent second synthesis.
    //   2. The gate is AUTHORITATIVE for the comment's color/headline: `buildUnifiedCommentBody` maps
    //      `gateEvaluation.conclusion` → a Verdict and feeds it as the renderer `decision`, which
    //      deriveUnifiedStatus honors BEFORE any reviewer recommendation. So the comment's tone can never
    //      contradict the review-agent check-run conclusion.
    //   3. The `ai_consensus_defect` surfaces exactly ONCE — as the Code-review blocker — never also in the
    //      gate signal row (which renders only the conclusion-derived status text, not the defect string).
    if (unifiedCommentAllowed && gateEvaluation) {
      // FIX B: the unified comment's file count + visual-capture path filter need the real diff — reuse the
      // shared resolver (one resolve per review; inline-fetches when stored is still empty pre-detail-sync).
      const unifiedFiles = await getReviewFiles();
      // CI + merge-state readiness — a converged enrichment the legacy panel never showed. Maps each cached
      // check's conclusion to passed/failed/unverified; any failure (failure/timed_out/cancelled/action_required)
      // flips the whole PR to 'failed'. The gate decision stays authoritative for the comment's color (always
      // passed here), so these CI chips never spuriously flip the unified status to held/blocked.
      // CRITICAL (CI-green parity): the comment's CI state must reflect the LIVE aggregate over BOTH check-runs
      // AND classic commit-statuses — codecov (codecov/patch) posts a commit-status the stored check_summaries
      // never captured, which is why a red codecov was shown as "CI green". Use the SAME live fetch the
      // auto-maintain planner uses so the public chip and the disposition can never disagree. "pending" folds to
      // the "unverified" bucket for the 3-state comment chip (renders "CI pending").
      const ciToken = await createInstallationToken(env, installationId).catch(
        () => undefined,
      );
      const token = ciToken ?? env.GITHUB_PUBLIC_TOKEN;
      const admissionKey = githubAdmissionKeyForToken(env, installationId, token);
      const baseRef = pr.baseRef ?? repo?.defaultBranch;
      // Required contexts still detect missing/pending required CI, but every visible completed red check/status is
      // adverse and blocks the PR.
      const liveCi = await refreshLiveCiAggregate(env, repoFullName, webhook.liveFacts, pr.number, pr.headSha, baseRef, token, settings.expectedCiContexts, admissionKey);
      // Live merge-state too — the SAME source the disposition uses (planAgentMaintenanceActions reads liveMergeState).
      // The stored pr.mergeableState lags GitHub's async recompute, and the gate's own check/review publication can
      // also advance mergeability after readiness ran, so refresh at this post-publish boundary.
      const liveMergeState = await refreshLiveMergeState(env, repoFullName, webhook.liveFacts, pr.number, token, admissionKey).catch(() => undefined);
      const mergeStateLabel = liveMergeState ?? pr.mergeableState; // fail-safe to the stored value
      const ciState: MergeReadiness["ciState"] =
        liveCi.ciState === "passed"
          ? "passed"
          : liveCi.ciState === "failed"
            ? "failed"
            : "unverified";
      // Per-failed-check WHY (codecov %/test/lint reason) from each check-run output or commit-status
      // description — capped + public-safe (name + short reason only). The renderer lists these under the CI chip.
      const failingDetails: CheckFailureDetail[] = liveCi.failingDetails.map(
        (detail) => ({
          name: detail.name,
          ...(detail.summary ? { summary: detail.summary } : {}),
          ...(detail.detailsUrl ? { detailsUrl: detail.detailsUrl } : {}),
        }),
      );
      // Non-required-but-red checks (#4414-class advisory holds): surfaced so a flagged check is never silently
      // invisible, but never folded into failingChecks/failingDetails -- those two drive ciState/close.
      const nonRequiredFailingDetails: CheckFailureDetail[] = liveCi.nonRequiredFailingDetails.map(
        (detail) => ({
          name: detail.name,
          ...(detail.summary ? { summary: detail.summary } : {}),
          ...(detail.detailsUrl ? { detailsUrl: detail.detailsUrl } : {}),
        }),
      );
      const mergeReadiness: MergeReadiness = {
        ciState,
        ...(mergeStateLabel ? { mergeStateLabel } : {}),
        ...(failingDetails.length > 0
          ? { failingChecks: failingDetails.map((detail) => detail.name) }
          : {}),
        ...(failingDetails.length > 0 ? { failingDetails } : {}),
        ...(nonRequiredFailingDetails.length > 0 ? { nonRequiredFailingDetails } : {}),
      };
      // The public comment must match the authoritative Gate check-run conclusion.
      const commentGate = gateEvaluation;
      // Observability (#reviews-dashboard): record the would-be gate verdict so the Grafana panel shows the
      // merge/close/hold mix — the "are we rubber-stamping?" signal — even in advisory/dryRun (this is the rendered verdict).
      incr("gittensory_gate_decisions_total", {
        repo: repoFullName,
        conclusion: commentGate.conclusion,
      });
      // Guarded-hold (#guarded-hold-comment): a clean+green PR whose diff touches a hard-guardrail path is HELD
      // for owner review by the disposition (planAgentMaintenanceActions), never auto-merged — so the comment
      // must render "held for review", not "✅ safe to merge". Compute the SAME guardrail-hit the disposition uses
      // (shared isGuardrailHit) and thread it so the signal and the action agree (the #4220 class, clean variant).
      const commentHardGuardrailGlobs = resolveHardGuardrailGlobs(settings);
      const heldForReview = isGuardrailHit(
        changedPathsForGuardrail(unifiedFiles),
        commentHardGuardrailGlobs,
      );
      // Held-vs-closed parity (#8/#9): the disposition NEVER auto-closes an owner / automation-bot PR, so a gate
      // "close" verdict on one must headline "held", not "Closed". Compute the same author classification the
      // planner uses (repo-owner login match + protected automation author) and thread it to the comment.
      const commentRepoOwner = repoFullName.includes("/")
        ? repoFullName.slice(0, repoFullName.indexOf("/"))
        : "";
      const commentAuthorLogin = pr.authorLogin ?? "";
      const neverClosed =
        (commentAuthorLogin.length > 0 &&
          commentAuthorLogin.toLowerCase() ===
            commentRepoOwner.toLowerCase()) ||
        isProtectedAutomationAuthor(pr.authorLogin);
      const { rows, readinessTotal } = buildPublicPrPanelSignalRows({
        repo,
        pr,
        profile,
        detection,
        queueHealth,
        collisions,
        preflight,
        settings,
        gate: commentGate,
        duplicateWinnerEnabled,
      });
      // Visual before/after capture (visual-capture port). Fires ONLY when (1) the global flag + per-repo
      // cutover gate both allow it (screenshotsAllowed) AND (2) the PR touches WEB-VISIBLE files (isVisualPath
      // — frontend pages / public OG images; backend .ts/.md/.json PRs never qualify). Fully wrapped in
      // try/catch + defaults to [] so a capture failure (render timeout, missing binding, GitHub hiccup) can
      // NEVER sink the review — it just omits the "Visual preview" section. Flag-OFF (default) ⇒ this block is
      // skipped entirely and the unified comment is byte-identical.
      let beforeAfter: CaptureRoute[] = [];
      const visualFiles = unifiedFiles
        .map((file) => file.path)
        .filter(isVisualPath);
      if (screenshotsAllowed(env, repoFullName) && visualFiles.length > 0) {
        try {
          const token = await createInstallationToken(env, installationId);
          // review.visual (#3609 / #3610): an explicit per-repo preview-URL template / route list. Absent config
          // (the default for every repo today) ⇒ EMPTY_VISUAL_CONFIG ⇒ buildCapture's discovery/inference
          // behavior is byte-identical to pre-#3609.
          const reviewVisualConfig = await resolveVisualCaptureConfig(env, repoFullName);
          const captureTarget = {
            repoFullName,
            prNumber: pr.number,
            ...(pr.headSha ? { headSha: pr.headSha } : {}),
            ...(pr.headRef ? { headRef: pr.headRef } : {}),
            previewFromChecks: true,
            // Pins the actions_fallback dispatch (#4112) to a trusted ref -- see buildCapture. Absent (no
            // stored default branch yet) ⇒ that dispatch just never fires, same as leaving it unconfigured.
            ...(repo?.defaultBranch ? { defaultBranchRef: repo.defaultBranch } : {}),
          };
          // review.visual.enabled (#4083): a config-as-code override layered on top of the screenshotsAllowed
          // env-var gate above, not a replacement for it. Unset/true ⇒ defer to that gate's decision (buildCapture
          // runs exactly as before); explicit `false` (global default or per-repo, VPS-only) ⇒ force capture off
          // for this repo -- a no-routes, non-pending sentinel result, so every line below behaves exactly as an
          // ordinary "nothing found" capture would, with no separate code path to maintain.
          const capture =
            reviewVisualConfig.enabled === false
              ? { routes: [], previewPending: false }
              : await buildCapture(env, token, captureTarget, visualFiles, githubRateLimitAdmissionKeyForInstallation(installationId), reviewVisualConfig);
          beforeAfter = capture.routes;
          // Screenshot-table gate satisfaction (#4110): a successful capture (a real before+after render pair
          // on at least one route) is evidence equivalent to a hand-authored before/after table -- persist the
          // head SHA it was proven at so the LATER maintenance pass (runAgentMaintenancePlanAndExecute, which
          // re-reads this PR row fresh) can see it without re-running the capture or threading a new return
          // value through every caller of this function. Best-effort: a write failure here just means the gate
          // falls back to requiring a body table, never blocks the rest of the review.
          if (pr.headSha && hasSuccessfulBotCapture(beforeAfter)) {
            await markPullRequestVisualCaptureSatisfied(env, repoFullName, pr.number, pr.headSha).catch((error) => {
              console.log(
                JSON.stringify({
                  event: "visual_capture_satisfied_mark_failed",
                  repoFullName,
                  pull: pr.number,
                  message: errorMessage(error).slice(0, 200),
                }),
              );
            });
          }
          // Visual self-poll: the FIRST capture returns a "loading" placeholder for the AFTER shot when the
          // preview deploy isn't live yet (capture.previewPending). Schedule a delayed re-review to re-capture
          // the now-ready shot — bounded by `attempt` so a never-resolving preview can't loop (the deployment_status
          // webhook also refills it; this is the backstop when that event is missed/late).
          const previewPollAttempt = webhook.previewPollAttempt ?? 0;
          if (
            capture.previewPending &&
            previewPollAttempt < MAX_PREVIEW_POLLS
          ) {
            await env.JOBS.send(
              {
                type: "recapture-preview",
                deliveryId: webhook.deliveryId,
                repoFullName,
                prNumber: pr.number,
                installationId,
                attempt: previewPollAttempt + 1,
              },
              { delaySeconds: PREVIEW_POLL_SECONDS },
            ).catch((error) =>
              console.log(
                JSON.stringify({
                  event: "recapture_enqueue_failed",
                  repoFullName,
                  pull: pr.number,
                  message: errorMessage(error).slice(0, 120),
                }),
              ),
            );
          }
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "visual_capture_error",
              repoFullName,
              pull: pr.number,
              message: errorMessage(error).slice(0, 200),
            }),
          );
        }
      }
      // AI-vision analysis of a confirmed visual regression (#4111 wiring) — see runVisualVisionForAdvisory's
      // own doc comment. Deliberately independent of the capture block above (its own try/catch there) so a
      // vision failure can never affect the "Visual preview" section that block already rendered.
      await runVisualVisionForAdvisory(env, {
        mode,
        repoFullName,
        pr,
        author,
        confirmedContributor,
        settings,
        advisory,
        routes: beforeAfter,
      });
      // review.memory (#2181, apply slice of #1964): before the unified comment renders, suppress/demote
      // advisory (non-blocking) findings a maintainer already dismissed as false positives for this repo. ONLY
      // ever applied to `commentGate.warnings` -- NEVER `commentGate.blockers` -- so this can never change the
      // merge/close disposition, matching the ADVISORY-ONLY constraint. Fail-safe: a suppression-store read
      // error leaves `renderedGate` as the original, untouched `commentGate` (the catch below never assigns
      // renderedGate, so it keeps its `let` initializer). Flag-OFF (default, reviewMemoryEnabledForReview
      // false) takes no new branch at all -- zero extra D1 read, byte-identical to today.
      let renderedGate = commentGate;
      if (reviewMemoryEnabledForReview && commentGate.warnings.length > 0) {
        try {
          // #4508: cached (short in-isolate TTL, invalidated on write) — the 3 independent
          // maybePublishPrPublicSurface call sites (auto re-review, webhook-triggered review, manual panel
          // retrigger) no longer each force a fresh D1 read for the same repo within a short window.
          const suppressionSignals = await getCachedReviewSuppressions(env, repoFullName, Date.now());
          const { findings: suppressedWarnings, suppressedCount, demotedCount } = applyReviewMemorySuppression(
            commentGate.warnings,
            suppressionSignals,
          );
          if (suppressedCount > 0 || demotedCount > 0) {
            renderedGate = { ...commentGate, warnings: suppressedWarnings };
            incr("gittensory_review_memory_suppressed_total", { repo: repoFullName });
            console.log(
              JSON.stringify({
                event: "review_memory_applied",
                repoFullName,
                pull: pr.number,
                suppressedCount,
                demotedCount,
              }),
            );
          }
        } catch (error) {
          console.log(
            JSON.stringify({
              event: "review_memory_error",
              repoFullName,
              pull: pr.number,
              message: errorMessage(error).slice(0, 200),
            }),
          );
        }
      }
      // #4589: the SAME finding #4583's inline CTA already reads off advisory.findings, resolved here (right
      // before rendering, so it reflects the fully-populated array) rather than re-deriving it a third time.
      // e2eTestGenAvailable is block-scoped to the manifestPolicyGateMode branch above (where #4583 already
      // computes it once for that block's own use) and out of scope here, so it's re-resolved via the async
      // convenience wrapper -- loadRepoFocusManifest is cached, so this is a cache hit, not a fresh read,
      // mirroring the "reload the CACHED manifest, it's cheap" idiom this same function already documents
      // a few hundred lines up for the identical reason.
      const missingTestsFinding = advisory.findings.find((finding) => finding.code === "manifest_missing_tests");
      const e2eTestGenAvailable = missingTestsFinding ? await convergedFeatureActive(env, repoFullName, "e2eTests") : false;
      deterministicBody = buildUnifiedCommentBody({
        gate: renderedGate,
        ...(aiReview !== undefined ? { aiReview } : {}),
        advisoryFindings: advisory.findings,
        ...(linkedIssueSatisfaction !== null ? { linkedIssueSatisfaction } : {}),
        panelRows: rows,
        ...(reviewConfig?.fields !== undefined
          ? { reviewFields: reviewConfig.fields }
          : {}),
        readinessTotal,
        changedFiles: unifiedFiles.length,
        ...(aiReview?.reviewerCount !== undefined
          ? { reviewerCount: aiReview.reviewerCount }
          : {}),
        mergeReadiness,
        heldForReview,
        neverClosed,
        // A preflight HOLD (e.g. the review lane is unavailable → the review is incomplete) must never render as
        // "safe to merge"; the renderer downgrades an otherwise-ready status to a manual-review hold. (#2002)
        preflightHeld: preflight.status === "hold",
        extraCollapsibles: buildPublicSafeCollapsibles({
          repo,
          pr,
          profile,
          detection,
          settings,
          collisions,
          preflight,
          queueHealth,
          ...(reviewConfig !== undefined ? { review: reviewConfig } : {}),
          duplicateWinnerEnabled,
          // #4589: reuse the SAME finding + feature-gate the #4583 inline CTA already computed above (this
          // function's own e2eTestGenAvailable const), rather than a second detection pass.
          ...(missingTestsFinding !== undefined ? { missingTestsFinding } : {}),
          e2eTestGenAvailable,
        }),
        footerMarkdown: gittensoryFooter({
          earnUrl: repo?.isRegistered
            ? gittensorRepoEarnUrl(repoFullName)
            : undefined,
          ...(reviewConfig?.footerText
            ? { customText: reviewConfig.footerText }
            : {}),
        }),
        reRunLabel: `${PR_PANEL_RETRIGGER_MARKER} Re-run Gittensory review`,
        // #4589: only rendered when there's an actual gap AND the checkbox would work for this repo -- same
        // condition testCoverageBody gates its own (informational) collapsible on, so the two always agree.
        ...(missingTestsFinding && e2eTestGenAvailable
          ? { generateTestsLabel: `${PR_PANEL_GENERATE_TESTS_MARKER} Generate an AI Playwright test for this PR` }
          : {}),
        ...(beforeAfter.length > 0 ? { beforeAfter } : {}),
        ...(changedFilesSummaryEnabledForReview
          ? {
              changedFilesSummary: unifiedFiles.map((file) => ({
                path: file.path,
                additions: file.additions,
                deletions: file.deletions,
              })),
              changedFilesSummaryContext: { repoFullName, pullNumber: pr.number },
            }
          : {}),
        // review.effort_score (#1955): deterministic, no-AI complexity/time estimate — only computed when the
        // manifest opts in (effortScoreEnabledForReview, resolved unconditionally above), mirroring
        // changedFilesSummaryEnabledForReview immediately above. Reuses the SAME unifiedFiles this pass already
        // resolved (no extra fetch); `patch` comes from the file record's raw payload, the same extraction the AI
        // review request already uses (reviewFilesForAi.map above).
        ...(effortScoreEnabledForReview
          ? {
              reviewEffort: estimateReviewEffort(
                unifiedFiles.map((file) => ({
                  path: file.path,
                  patch: typeof file.payload?.patch === "string" ? file.payload.patch : undefined,
                })),
              ),
            }
          : {}),
        ...(findingCategoriesEnabledForReview && aiReview?.inlineFindings?.length
          ? { findingCategories: aiReview.inlineFindings }
          : {}),
        // review.impact_map render (#1971): the deterministic impact-map entries this fresh pass already computed
        // for the AI prompt ALSO render here as the "Impact map" collapsible — no second RAG query. A cache hit /
        // frozen reuse / skipped review carries none (undefined ⇒ []); buildImpactMapCollapsible returns null for
        // an empty list, so off/empty ⇒ no section ⇒ byte-identical. `ImpactMapEntry` IS `ImpactMapSummaryInput`.
        impactMap: aiReview?.impactMap ?? [],
        // review.fixHandoff emission (#1962): the SAME fresh inline findings feed the fix-handoff blocks —
        // present ONLY on a cache-miss review with inline comments enabled — so a cache hit never re-emits them,
        // exactly like findingCategories above. Flag-OFF ⇒ omitted ⇒ the rendered comment is byte-identical.
        ...(fixHandoffEnabledForReview && aiReview?.inlineFindings?.length
          ? { fixHandoffBlocks: buildFixHandoffBlocks(aiReview.inlineFindings) }
          : {}),
        maxFindingsCaps: reviewConfig.maxFindings,
        commentVerbosity: reviewConfig.commentVerbosity,
        // review-manifest validation (#2056): public PR comments may disclose only repo-published manifest
        // warnings. Self-host private config can carry operator-only policy and raw invalid values, so never
        // render warnings from the full/private manifest here.
        manifestWarnings: publicRepoFocusManifestForComment?.warnings ?? [],
      });
    } else {
      deterministicBody = buildPublicPrIntelligenceComment(commentArgs);
    }
    try {
      await withReviewPipelineSpan(
        "selfhost.review.publish.comment",
        {
          installationId,
          repoFullName,
          pullNumber: pr.number,
          operation: "publish_comment",
          decisionOutcome: gateEvaluation?.conclusion,
        },
        () =>
          createOrUpdatePrIntelligenceComment(
            env,
            installationId,
            repoFullName,
            pr.number,
            deterministicBody,
            { mode },
          ),
      );
      publishedOutputs.push("comment");
      incr("gittensory_reviews_published_total", { repo: repoFullName });
    } catch (error) {
      const message = errorMessage(error);
      failedOutputs.push({ output: "comment", error: message, transient: isGitHubTransientPublishError(error) });
      await recordPublicSurfaceOutputFailure(
        env,
        "comment",
        author,
        repoFullName,
        pr.number,
        webhook.deliveryId,
        message,
      );
      /* v8 ignore next -- label rate-limit propagation shares the same GitHub retry path as comment/check publication. */
      if (isGitHubRateLimitedError(error)) throw error;
    }
    // Quiet inline review comments (#inline-comments): layer the AI's line-anchored findings on top of the
    // summary just posted, as a NON-BLOCKING COMMENT review. A no-op (no extra work) unless this is a fresh
    // review that actually produced findings — a cache hit carries none, so the ~2-min re-gate sweep never
    // reposts. Fully fail-safe: drops out-of-diff lines (no 422), threads `mode`, and never affects the gate.
    await maybePostInlineComments(env, {
      aiReview,
      installationId,
      repoFullName,
      pullNumber: pr.number,
      commitId: advisory.headSha,
      getFiles: getReviewFiles,
      mode,
      inlineCommentsEnabled: inlineCommentsEnabledForReview,
      suggestionsEnabled: suggestionsEnabledForReview,
      categoriesEnabled: findingCategoriesEnabledForReview,
      minFindingSeverity: minFindingSeverityForReview,
      perCategoryCap: inlineCommentsPerCategoryForReview,
    });
  }
  if (decision.willLabel) {
    try {
      await withReviewPipelineSpan(
        "selfhost.review.publish.label",
        {
          installationId,
          repoFullName,
          pullNumber: pr.number,
          operation: "publish_label",
          decisionOutcome: gateEvaluation?.conclusion,
        },
        () =>
          ensurePullRequestLabel(
            env,
            installationId,
            repoFullName,
            pr.number,
            settings.gittensorLabel,
            {
              createMissingLabel: settings.createMissingLabel,
              mode,
            },
          ),
      );
      publishedOutputs.push("label");
    } catch (error) {
      const message = errorMessage(error);
      failedOutputs.push({ output: "label", error: message, transient: isGitHubTransientPublishError(error) });
      await recordPublicSurfaceOutputFailure(
        env,
        "label",
        author,
        repoFullName,
        pr.number,
        webhook.deliveryId,
        message,
      );
      if (isGitHubRateLimitedError(error)) throw error;
    }
  }
  return finishPublicSurfacePublication();
}

async function recordPublicSurfaceOutputFailure(
  env: Env,
  output: PublicSurfaceOutput,
  actor: string | null,
  repoFullName: string,
  pullNumber: number,
  deliveryId: string,
  error: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: `github_app.pr_${output}_publish_failed`,
    actor,
    targetKey: `${repoFullName}#${pullNumber}`,
    outcome: "error",
    detail: error,
    metadata: { deliveryId, repoFullName, output },
  });
}

async function recordGithubProductUsage(
  env: Env,
  eventName: string,
  event: {
    actor?: string | null | undefined;
    repoFullName?: string | null | undefined;
    targetKey?: string | null | undefined;
    outcome?:
      | "success"
      | "denied"
      | "error"
      | "queued"
      | "completed"
      | "skipped";
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const actorRole =
    typeof event.metadata?.actorKind === "string"
      ? event.metadata.actorKind
      : typeof event.metadata?.role === "string"
        ? event.metadata.role
        : undefined;
  await recordProductUsageEvent(env, {
    surface: "github_app",
    eventName,
    role: actorRole,
    actor: event.actor,
    repoFullName: event.repoFullName,
    targetKey: event.targetKey,
    outcome: event.outcome,
    clientName: "github_app",
    metadata: event.metadata,
  }).catch(() => undefined);
}

/**
 * Resolve the head SHA a `gate-override` should neutralize (#16 / audit). The stored `pr.headSha` lags GitHub
 * when a commit lands between the override comment and its processing, so re-fetch the LIVE head and override
 * THAT commit (the neutral check-run is per-commit by design). FAIL-OPEN: an unreadable live fetch returns the
 * cached head, so a transient GitHub hiccup never strands the override — it just targets the stored SHA as before.
 * Mirrors the rebase path's live re-fetch (prReadyForReview) and the dup-winner live reconcile.
 * #2537: deliberately NOT routed through the durable head-SHA cache (cachedFetchLivePullRequestHeadSha,
 * backfill.ts) -- this is the same class of security-sensitive, human-triggered re-check as the act-boundary
 * merge/close decision, wanting the literal current commit rather than a value that can be up to
 * PR_STATE_CACHE_MAX_AGE_MS stale. A commit landing inside that freshness window right after the override
 * comment is exactly the race this function exists to close; a cache hit would silently reintroduce it.
 */
export async function resolveOverrideHeadSha(
  env: Env,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
): Promise<string | null | undefined> {
  const token =
    (await createInstallationToken(env, installationId).catch(
      () => undefined,
    )) ?? env.GITHUB_PUBLIC_TOKEN;
  const admissionKey = githubAdmissionKeyForToken(env, installationId, token);
  const liveHeadSha = await fetchLivePullRequestHeadSha(
    env,
    repoFullName,
    pr.number,
    token,
    admissionKey,
  );
  return liveHeadSha ?? pr.headSha;
}

/**
 * Handle `@gittensory gate-override <reason>` on a PR thread. SECURITY-SENSITIVE: this finalizes the Gate
 * check to neutral for the current commit, so authorization MUST come from real repo permission
 * (resolveRealRepoPermissionAssociation → getRepositoryCollaboratorPermission), never the spoofable
 * payload.comment.author_association. The override is intentionally NOT persisted: a follow-up push
 * re-evaluates the Gate from scratch (no permanent bypass).
 */
async function maybeProcessGateOverrideCommand(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  const comment = payload.comment;
  const command = parseGittensoryMentionCommand(comment?.body);
  if (!command || command.name !== "gate-override") return false;

  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const actor = payload.sender?.login ?? comment?.user?.login ?? null;
  const targetKey =
    repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (payload.action !== "created") {
    await recordGateOverrideSkip(
      env,
      deliveryId,
      repoFullName,
      targetKey,
      actor,
      "unsupported_comment_action",
    );
    return true;
  }
  if (
    comment?.user?.type === "Bot" ||
    payload.sender?.type === "Bot" ||
    /\[bot\]$/i.test(actor ?? "")
  ) {
    await recordGateOverrideSkip(
      env,
      deliveryId,
      repoFullName,
      targetKey,
      actor,
      "bot_author",
    );
    return true;
  }
  if (!repoFullName || !issue?.pull_request || !installationId || !actor) {
    await recordGateOverrideSkip(
      env,
      deliveryId,
      repoFullName,
      targetKey,
      actor,
      "missing_repo_pr_installation_or_actor",
    );
    return true;
  }
  const [pr, settings] = await Promise.all([
    getPullRequest(env, repoFullName, issue.number),
    resolveRepositorySettings(env, repoFullName),
  ]);
  if (!pr) {
    await recordGateOverrideSkip(
      env,
      deliveryId,
      repoFullName,
      targetKey,
      actor,
      "cached_pr_missing",
    );
    return true;
  }

  const { authorization } = await authorizePrActionActor({
    env,
    deliveryId,
    installationId,
    repoFullName,
    issue,
    actor,
    commandName: "gate-override" as GittensoryMentionCommandName,
    settings,
    pr,
  });
  if (!authorization.authorized) {
    await recordAuditEvent(env, {
      eventType: "github_app.gate_override_denied",
      actor,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: authorization.reason,
      metadata: {
        deliveryId,
        repoFullName,
        allowedRoles: commandAuthorizationAllowedRoles(
          settings.commandAuthorization,
          "gate-override",
        ),
      },
    });
    await recordGithubProductUsage(env, "gate_override_denied", {
      actor,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      metadata: {
        reason: authorization.reason,
        actorKind: authorization.actorKind,
        allowedRoles: commandAuthorizationAllowedRoles(
          settings.commandAuthorization,
          "gate-override",
        ),
      },
    });
    return true;
  }

  // Respect pause/dry-run/global-freeze like every other agent-driven write in this file (#2256). Without this,
  // an operator's pause or the DB kill-switch does not stop a maintainer's @gittensory gate-override from
  // flipping the live Gate check-run to neutral and posting a real confirmation comment.
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });

  // #16 (audit): the cached pr.headSha can be stale if a commit landed between the comment and this processing.
  // The override is a per-commit neutral check-run, so posting it on the cached SHA is a silent no-op on the LIVE
  // head (whose Gate check stays blocking). Re-fetch the live head and override THAT commit (fail-open to the
  // cached head), then thread it through the advisory so the check-run + audit target the right SHA.
  const headForOverride = await resolveOverrideHeadSha(
    env,
    installationId,
    repoFullName,
    pr,
  );
  const prAtLiveHead =
    headForOverride === pr.headSha ? pr : { ...pr, headSha: headForOverride };
  const { advisory } = await buildAuthorizedPrActionAdvisory(
    env,
    repoFullName,
    prAtLiveHead,
    settings,
  );
  const safeReason = sanitizePublicComment(
    (command.reason ?? "").trim() || "No reason provided.",
  );
  await createOrUpdateOverriddenGateCheckRun(
    env,
    installationId,
    repoFullName,
    advisory,
    { actor, reason: safeReason },
    mode,
  );
  const confirmation = sanitizePublicComment(
    [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      "> [!NOTE]",
      `> **${GITTENSORY_GATE_CHECK_NAME} overridden by @${actor}**`,
      "> The review-agent check was set to neutral for the current commit only. This does NOT permanently bypass the review; a new push re-evaluates it.",
      "",
      `- Reason: ${safeReason}`,
      "",
      "---",
      gittensoryFooter(),
    ].join("\n"),
  );
  await createOrUpdateAgentCommandComment(
    env,
    installationId,
    repoFullName,
    issue.number,
    confirmation,
    mode,
  );
  // createOrUpdateOverriddenGateCheckRun/createOrUpdateAgentCommandComment already suppress the actual GitHub
  // writes for a non-live mode -- calling them unconditionally is fine (and lets a dry-run still exercise the
  // code path). What must NOT happen unconditionally is recording this as a completed override: a paused or
  // dry-run command never flipped the check-run or posted the confirmation, so audit/usage must reflect that
  // instead of reporting a real override that did not occur (mirrors recordPlanSkip's *_skipped convention).
  if (mode === "live") {
    await recordAuditEvent(env, {
      eventType: "github_app.gate_overridden",
      actor,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail: safeReason,
      metadata: {
        deliveryId,
        repoFullName,
        headSha: advisory.headSha ?? null,
        cachedHeadSha: pr.headSha ?? null,
      },
    });
    await recordGithubProductUsage(env, "gate_overridden", {
      actor,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      metadata: {
        actorKind: authorization.actorKind,
        headSha: advisory.headSha ?? null,
      },
    });
    // #554 gate false-positive telemetry: flag the gate-block row as maintainer-overridden — the strongest
    // false-positive signal (a human explicitly judged the block wrong). Best-effort + no-op if no block was
    // recorded; never affects the override outcome above. Only meaningful once the check-run was actually
    // flipped (mode === "live") -- a paused/dry-run "override" never changed the live gate result.
    await markGateOutcomeOverridden(env, repoFullName, pr.number).catch(
      () => undefined,
    );
  } else {
    await recordAuditEvent(env, {
      eventType: "github_app.gate_override_skipped",
      actor,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail: mode === "dry_run" ? "dry_run" : "agent_paused",
      metadata: {
        deliveryId,
        repoFullName,
        headSha: advisory.headSha ?? null,
        cachedHeadSha: pr.headSha ?? null,
        mode,
      },
    });
    await recordGithubProductUsage(env, "gate_override_skipped", {
      actor,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "skipped",
      metadata: {
        actorKind: authorization.actorKind,
        headSha: advisory.headSha ?? null,
        mode,
      },
    });
  }
  return true;
}

async function recordGateOverrideSkip(
  env: Env,
  deliveryId: string,
  repoFullName: string | null | undefined,
  targetKey: string | null | undefined,
  actor: string | null,
  reason: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.gate_override_skipped",
    actor,
    targetKey,
    outcome: "completed",
    detail: reason,
    metadata: { deliveryId, repoFullName: repoFullName ?? null, reason },
  });
  await recordGithubProductUsage(env, "gate_override_skipped", {
    actor,
    repoFullName,
    targetKey,
    outcome: "skipped",
    metadata: { reason },
  });
}

async function maybeProcessResolveCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> { const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command) return false;
  if (command.name !== "resolve") return false;
  const { classifyPrCommandRequest } = await import("../github/pr-command-request");
  const { normalizeResolveFindingRef, selectWarningsForResolve } = await import("../review/review-memory-wire");
  const req = classifyPrCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey: req.targetKey, outcome: "completed", detail: req.reason, metadata: { deliveryId, repoFullName: req.repoFullName ?? null, reason: req.reason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey: req.targetKey, outcome: "skipped", metadata: { reason: req.reason } }); return true; }
  const [pr, settings] = await Promise.all([getPullRequest(env, req.repoFullName, req.pr.number), resolveRepositorySettings(env, req.repoFullName)]);
  const targetKey = `${req.repoFullName}#${req.pr.number}`;
  if (!pr) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: "cached_pr_missing", metadata: { deliveryId, repoFullName: req.repoFullName, reason: "cached_pr_missing" } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: "cached_pr_missing" } }); return true; }
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "resolve" as GittensoryMentionCommandName, settings, pr });
  if (!authorization.authorized) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resolve") } }); await recordGithubProductUsage(env, "finding_resolved_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resolve") } }); return true; }
  const findingRef = normalizeResolveFindingRef(command.reason);
  if (!findingRef.ok) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: findingRef.reason, metadata: { deliveryId, repoFullName: req.repoFullName, reason: findingRef.reason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: findingRef.reason } }); return true; }
  const { advisory } = await buildAuthorizedPrActionAdvisory(env, req.repoFullName, pr, settings);
  await appendPublishedAiReviewFindingsForResolve(env, req.repoFullName, pr, settings.aiReviewMode, advisory);
  const gate = evaluateGateCheck(advisory, gateCheckPolicy(settings, null, undefined, pr.slopRisk ?? null));
  const selection = selectWarningsForResolve(gate.warnings, findingRef);
  if (selection.reason === "finding_not_found") { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: selection.reason, metadata: { deliveryId, repoFullName: req.repoFullName, reason: selection.reason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: selection.reason } }); return true; }
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
  if (mode !== "live") { const skipReason = mode === "dry_run" ? "dry_run" : "agent_paused"; await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: skipReason, metadata: { deliveryId, repoFullName: req.repoFullName, reason: skipReason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: skipReason } }); return true; }
  const reviewManifest = await loadRepoFocusManifest(env, req.repoFullName).catch(() => null);
  const reviewMemoryEnabled = shouldApplyReviewMemory(env, resolveReviewMemoryManifestToggle(reviewManifest));
  let recordedSuppressionCount = 0;
  if (reviewMemoryEnabled && selection.findings.length > 0) { const { fingerprint } = await import("../review/review-memory-match"); const { recordReviewSuppression } = await import("../db/repositories"); const suppressionWrites = selection.findings.map((finding) => ({ category: finding.code, pathGlob: "", patternHash: fingerprint({ category: finding.code, message: `${finding.title} ${finding.detail}` }) })); await Promise.all(suppressionWrites.map((write) => recordReviewSuppression(env, { repoFullName: req.repoFullName, category: write.category, pathGlob: write.pathGlob, patternHash: write.patternHash, createdBy: req.actor }))); recordedSuppressionCount = suppressionWrites.length; invalidateReviewSuppressionCache(req.repoFullName); /* #4508: this repo's cached suppression list is stale as of this write -- the very next render must see it, not wait out the TTL. */ await recordAuditEvent(env, { eventType: "github_app.review_memory_recorded", actor: req.actor, targetKey, outcome: "completed", detail: `Recorded ${recordedSuppressionCount} review-memory suppression signal(s).`, metadata: { deliveryId, repoFullName: req.repoFullName, recordedSuppressionCount, scope: findingRef.scope, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } }); await recordGithubProductUsage(env, "review_memory_recorded", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { recordedSuppressionCount, scope: findingRef.scope, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } }); }
  const resolvedLabel = findingRef.scope === "whole_pr" ? "all current advisory findings" : `\`${findingRef.findingCode}\``;
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Review finding resolved by @${req.actor}**`, `> Marked ${resolvedLabel} as resolved for this PR. The Gate check-run is unchanged.`, ...(recordedSuppressionCount > 0 ? ["", `Recorded ${recordedSuppressionCount} review-memory suppression signal(s) for future reviews.`] : []), "", "---", gittensoryFooter()].join("\n"));
  await createOrUpdateAgentCommandComment(env, req.installationId, req.repoFullName, req.pr.number, confirmation, mode);
  await recordAuditEvent(env, { eventType: "github_app.finding_resolved", actor: req.actor, targetKey, outcome: "completed", detail: `Marked ${resolvedLabel} as resolved.`, metadata: { deliveryId, repoFullName: req.repoFullName, scope: findingRef.scope, resolvedWarningCount: selection.findings.length, recordedSuppressionCount, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } });
  await recordGithubProductUsage(env, "finding_resolved", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { scope: findingRef.scope, resolvedWarningCount: selection.findings.length, recordedSuppressionCount, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } }); return true; }

/**
 * `@gittensory review` (#2163, part of #1960, alias `re-review`): a maintainer/collaborator/confirmed-miner
 * asks for an AUTO-REVIEW pass on this PR. AUTO-REVIEW SCOPE ONLY, same hard constraint as pause/resolve/
 * explain (#1960): this dispatches to the EXISTING reReviewStoredPullRequest path. Maintainers and
 * collaborators keep the explicit fresh-review behavior; author/miner self-reruns intentionally reuse the
 * normal cached path so a low-privilege actor cannot repeatedly spend provider budget or re-roll findings.
 * It never touches the Gate check-run, the AgentActionMode, or the one-shot disposition directly;
 * whatever reReviewStoredPullRequest's own gate evaluation produces is exactly what a scheduled sweep pass
 * would produce. If the PR is currently paused (hasAutoreviewPausedMarker), reReviewStoredPullRequest's own
 * existing skipAiReview-on-pause behavior still applies — this command does not special-case or bypass pause;
 * it is a re-review trigger, not a resume. Mirrors maybeProcessResolveCommand's classify → authorize → dispatch
 * shape. Returns true once it owns the event.
 */
async function maybeProcessReviewCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command || command.name !== "review") return false;
  const { classifyPrCommandRequest } = await import("../github/pr-command-request");
  const req = classifyPrCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) {
    await recordReviewCommandSkip(env, deliveryId, req.repoFullName, req.targetKey, req.actor, req.reason);
    return true;
  }
  const targetKey = `${req.repoFullName}#${req.pr.number}`;
  const [pr, settings] = await Promise.all([getPullRequest(env, req.repoFullName, req.pr.number), resolveRepositorySettings(env, req.repoFullName)]);
  if (!pr) {
    await recordReviewCommandSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "cached_pr_missing");
    return true;
  }
  // needsMinerDetection: true -- "review" is deliberately widened to confirmed_miner (see the doc comment
  // above and DEFAULT_COMMAND_AUTHORIZATION_POLICY's own comment on this command), so the miner-status lookup
  // authorizePrActionActor gates behind this flag MUST run here, or a confirmed miner re-triggering review on
  // their own PR is wrongly denied (there is no other role they could match instead).
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "review" as GittensoryMentionCommandName, settings, pr, needsMinerDetection: true });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.review_command_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "review") } });
    await recordGithubProductUsage(env, "review_command_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "review") } });
    return true;
  }
  // Same dry-run/paused gate every other action command respects (pause/resolve/explain/gate-override/
  // generate-tests) -- a paused or dry-run repo must not dispatch a live re-review or post a confirmation.
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
  if (mode !== "live") {
    await recordReviewCommandSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, mode === "dry_run" ? "dry_run" : "agent_paused");
    return true;
  }
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Re-review triggered by @${req.actor}**`, "> Re-running auto-review for this PR. The Gate check-run and one-shot disposition are produced the same way a scheduled pass would.", "", "---", gittensoryFooter()].join("\n"));
  await createIssueComment(env, req.installationId, req.repoFullName, req.pr.number, confirmation);
  const forceFreshReview = authorization.actorKind === "maintainer";
  await reReviewStoredPullRequest(env, deliveryId, req.installationId, req.repoFullName, req.pr.number, undefined, forceFreshReview ? { force: true } : undefined);
  await recordAuditEvent(env, { eventType: "github_app.review_command_completed", actor: req.actor, targetKey, outcome: "completed", detail: "Re-review dispatched.", metadata: { deliveryId, repoFullName: req.repoFullName } });
  await recordGithubProductUsage(env, "review_command_completed", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { actorKind: authorization.actorKind } });
  return true;
}

async function recordReviewCommandSkip(env: Env, deliveryId: string, repoFullName: string | null, targetKey: string | null, actor: string | null, reason: string): Promise<void> {
  await recordAuditEvent(env, { eventType: "github_app.review_command_skipped", actor, targetKey, outcome: "completed", detail: reason, metadata: { deliveryId, repoFullName, reason } });
  await recordGithubProductUsage(env, "review_command_skipped", { actor, repoFullName, targetKey, outcome: "skipped", metadata: { reason } });
}

/**
 * `@gittensory pause` (#2164, part of #1960): a maintainer pauses AUTO-REVIEW for THIS PR only by recording a
 * per-PR `github_app.autoreview_paused` marker (an audit event keyed to repo#pr) that the sweep/webhook re-review
 * path can honor. AUTO-REVIEW SCOPE ONLY — it deliberately touches neither the Gate check-run, the AgentActionMode,
 * nor any advisory, so the one-shot gate disposition and its enforcement are left intact (#1960's hard constraint:
 * pause must never flip the gate to advisory or bypass the disposition; the gate-enforcement side and any
 * repository_settings kill-switch stay maintainer-owned). Mirrors maybeProcessResolveCommand's classify → authorize
 * → record shape (classifyPrCommandRequest + authorizePrActionActor + the gate-override skip/denied/completed
 * recording convention). Unlike gate-override it does NOT consult resolveAgentActionMode: the pause IS the
 * "stop auto-reviewing" instruction, so gating the marker behind the execution mode would make an already
 * paused/dry-run agent impossible to pause — the marker + public-safe confirmation are therefore recorded
 * unconditionally on an authorized pause. Returns true once it owns the event; a non-pause comment returns false
 * and falls through to the other command handlers.
 */
async function maybeProcessPauseCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command || command.name !== "pause") return false;
  const { classifyPrCommandRequest } = await import("../github/pr-command-request");
  const req = classifyPrCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) {
    await recordAutoreviewPausedSkip(env, deliveryId, req.repoFullName, req.targetKey, req.actor, req.reason);
    return true;
  }
  const targetKey = `${req.repoFullName}#${req.pr.number}`;
  const [pr, settings] = await Promise.all([getPullRequest(env, req.repoFullName, req.pr.number), resolveRepositorySettings(env, req.repoFullName)]);
  if (!pr) {
    await recordAutoreviewPausedSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "cached_pr_missing");
    return true;
  }
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "pause" as GittensoryMentionCommandName, settings, pr });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.autoreview_paused_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "pause") } });
    await recordGithubProductUsage(env, "autoreview_paused_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "pause") } });
    return true;
  }
  const safeReason = sanitizePublicComment((command.reason ?? "").trim() || "No reason provided.");
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Auto-review paused by @${req.actor}**`, "> Auto-review is paused for this PR only. Gate enforcement and the one-shot disposition are unchanged; use `@gittensory resume` to re-enable auto-review.", "", `- Reason: ${safeReason}`, "", "---", gittensoryFooter()].join("\n"));
  await createIssueComment(env, req.installationId, req.repoFullName, req.pr.number, confirmation);
  await recordAuditEvent(env, { eventType: "github_app.autoreview_paused", actor: req.actor, targetKey, outcome: "completed", detail: safeReason, metadata: { deliveryId, repoFullName: req.repoFullName } });
  await recordGithubProductUsage(env, "autoreview_paused", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { actorKind: authorization.actorKind } });
  return true;
}

async function recordAutoreviewPausedSkip(env: Env, deliveryId: string, repoFullName: string | null, targetKey: string | null, actor: string | null, reason: string): Promise<void> {
  await recordAuditEvent(env, { eventType: "github_app.autoreview_paused_skipped", actor, targetKey, outcome: "completed", detail: reason, metadata: { deliveryId, repoFullName, reason } });
  await recordGithubProductUsage(env, "autoreview_paused_skipped", { actor, repoFullName, targetKey, outcome: "skipped", metadata: { reason } });
}

/**
 * `@gittensory resume` (#2165, part of #1960): the inverse of pause — clears the per-PR auto-review-paused
 * marker by recording a `github_app.autoreview_resumed` event that SUPERSEDES an earlier pause (see
 * hasAutoreviewPausedMarker below, which now reads the MOST RECENT of {paused, resumed} rather than merely
 * checking pause existence — see that function's own doc comment for why the old existence-only check made
 * resume a no-op). Same hard constraint as pause: AUTO-REVIEW SCOPE ONLY, never touches the Gate check-run,
 * AgentActionMode, or the one-shot disposition. Mirrors maybeProcessPauseCommand's classify → authorize →
 * record shape exactly. Returns true once it owns the event.
 */
async function maybeProcessResumeCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command || command.name !== "resume") return false;
  const { classifyPrCommandRequest } = await import("../github/pr-command-request");
  const req = classifyPrCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) {
    await recordAutoreviewResumedSkip(env, deliveryId, req.repoFullName, req.targetKey, req.actor, req.reason);
    return true;
  }
  const targetKey = `${req.repoFullName}#${req.pr.number}`;
  const [pr, settings] = await Promise.all([getPullRequest(env, req.repoFullName, req.pr.number), resolveRepositorySettings(env, req.repoFullName)]);
  if (!pr) {
    await recordAutoreviewResumedSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "cached_pr_missing");
    return true;
  }
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "resume" as GittensoryMentionCommandName, settings, pr });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.autoreview_resumed_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resume") } });
    await recordGithubProductUsage(env, "autoreview_resumed_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resume") } });
    return true;
  }
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Auto-review resumed by @${req.actor}**`, "> Auto-review is resumed for this PR. Gate enforcement and the one-shot disposition were never affected by pause.", "", "---", gittensoryFooter()].join("\n"));
  await createIssueComment(env, req.installationId, req.repoFullName, req.pr.number, confirmation);
  await recordAuditEvent(env, { eventType: "github_app.autoreview_resumed", actor: req.actor, targetKey, outcome: "completed", detail: "Auto-review resumed.", metadata: { deliveryId, repoFullName: req.repoFullName } });
  await recordGithubProductUsage(env, "autoreview_resumed", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { actorKind: authorization.actorKind } });
  return true;
}

async function recordAutoreviewResumedSkip(env: Env, deliveryId: string, repoFullName: string | null, targetKey: string | null, actor: string | null, reason: string): Promise<void> {
  await recordAuditEvent(env, { eventType: "github_app.autoreview_resumed_skipped", actor, targetKey, outcome: "completed", detail: reason, metadata: { deliveryId, repoFullName, reason } });
  await recordGithubProductUsage(env, "autoreview_resumed_skipped", { actor, repoFullName, targetKey, outcome: "skipped", metadata: { reason } });
}

/** True when the MOST RECENT of {autoreview_paused, autoreview_resumed} for this target is a pause (#2165
 *  fix): the original version of this check only tested for the EXISTENCE of any autoreview_paused row ever
 *  recorded, so a resume command could parse/authorize/post its confirmation but silently fail to actually
 *  resume auto-review -- the very next re-review pass would still read the stale pause as active forever.
 *  Ordering by created_at DESC across BOTH event types and checking which one is latest lets a resume
 *  genuinely supersede an earlier pause, while a later pause after a resume still re-pauses correctly.
 *  `created_at` is millisecond-precision text, so two rows written within the same millisecond (a real
 *  possibility for back-to-back commands) would tie under created_at alone -- `rowid DESC` (audit_events'
 *  implicit insertion-order column; `id` itself is a non-chronological TEXT primary key) breaks the tie by
 *  true write order, not timestamp precision. */
async function hasAutoreviewPausedMarker(env: Env, repoFullName: string, prNumber: number): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "select event_type from audit_events where event_type in (?, ?) and target_key = ? and outcome = ? order by created_at desc, rowid desc limit 1",
    )
      .bind("github_app.autoreview_paused", "github_app.autoreview_resumed", `${repoFullName}#${prNumber}`, "completed")
      .first<{ event_type: string }>();
    return row?.event_type === "github_app.autoreview_paused";
  } catch {
    /* v8 ignore next -- audit lookup failures fail open so a stale/corrupt ledger cannot wedge review processing. */
    return false;
  }
}

/**
 * `@gittensory explain <finding>` (#2169, part of #1960): a contributor/maintainer asks for more detail on a
 * specific posted review finding. Read-only — it looks the finding up in THIS PR's current advisory (the same
 * source `resolve` acts on) and echoes its ALREADY-generated, public-safe rationale; it deliberately runs NO
 * model (new generation is a separate maintainer-owned budget concern) and mutates nothing, so — like the
 * `configuration` info command — it posts regardless of the agent action mode. Requires naming a specific finding:
 * an absent argument (which `normalizeResolveFindingRef` reads as `whole_pr`) is a skip, not "explain everything".
 * An unknown id gets a public-safe not-found note rather than a silent no-op. Returns true once it owns the event.
 */
async function maybeProcessExplainCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command || command.name !== "explain") return false;
  const { classifyPrCommandRequest } = await import("../github/pr-command-request");
  const { normalizeResolveFindingRef, selectWarningsForResolve } = await import("../review/review-memory-wire");
  const req = classifyPrCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) {
    await recordFindingExplainedSkip(env, deliveryId, req.repoFullName, req.targetKey, req.actor, req.reason);
    return true;
  }
  const targetKey = `${req.repoFullName}#${req.pr.number}`;
  const [pr, settings] = await Promise.all([getPullRequest(env, req.repoFullName, req.pr.number), resolveRepositorySettings(env, req.repoFullName)]);
  if (!pr) {
    await recordFindingExplainedSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "cached_pr_missing");
    return true;
  }
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "explain" as GittensoryMentionCommandName, settings, pr });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.finding_explained_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "explain") } });
    await recordGithubProductUsage(env, "finding_explained_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind } });
    return true;
  }
  const findingRef = normalizeResolveFindingRef(command.argument);
  if (!findingRef.ok) {
    await recordFindingExplainedSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, findingRef.reason);
    return true;
  }
  if (findingRef.scope === "whole_pr") {
    // Unlike `resolve`, `explain` needs a specific target — an empty argument is a skip, not "explain all findings".
    await recordFindingExplainedSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "missing_finding_argument");
    return true;
  }
  const { advisory } = await buildAuthorizedPrActionAdvisory(env, req.repoFullName, pr, settings);
  await appendPublishedAiReviewFindingsForResolve(env, req.repoFullName, pr, settings.aiReviewMode, advisory);
  const gate = evaluateGateCheck(advisory, gateCheckPolicy(settings, null, undefined, pr.slopRisk ?? null));
  const selection = selectWarningsForResolve(gate.warnings, findingRef);
  if (selection.reason === "finding_not_found") {
    const notFound = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **No review finding \`${findingRef.findingCode}\` on this PR**`, "> That id is not among this PR's current review findings — re-run `@gittensory explain <finding-id>` with an id from the review summary.", "", "---", gittensoryFooter()].join("\n"));
    await createIssueComment(env, req.installationId, req.repoFullName, req.pr.number, notFound);
    await recordFindingExplainedSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "finding_not_found");
    return true;
  }
  const body = sanitizePublicComment(
    [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      `> [!NOTE]`,
      `> **Explanation of \`${findingRef.findingCode}\` for @${req.actor}**`,
      "",
      ...selection.findings.flatMap((finding) => [
        `### ${finding.title}`,
        "",
        finding.publicText ?? finding.detail,
        ...(finding.action ? ["", `**Suggested action:** ${finding.action}`] : []),
        "",
      ]),
      "---",
      gittensoryFooter(),
    ].join("\n"),
  );
  await createIssueComment(env, req.installationId, req.repoFullName, req.pr.number, body);
  await recordAuditEvent(env, { eventType: "github_app.finding_explained", actor: req.actor, targetKey, outcome: "completed", detail: `Explained \`${findingRef.findingCode}\` for ${targetKey}.`, metadata: { deliveryId, repoFullName: req.repoFullName, findingCode: findingRef.findingCode, explainedCount: selection.findings.length } });
  await recordGithubProductUsage(env, "finding_explained", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { findingCode: findingRef.findingCode, explainedCount: selection.findings.length } });
  return true;
}

async function recordFindingExplainedSkip(env: Env, deliveryId: string, repoFullName: string | null, targetKey: string | null, actor: string | null, reason: string): Promise<void> {
  await recordAuditEvent(env, { eventType: "github_app.finding_explained_skipped", actor, targetKey, outcome: "completed", detail: reason, metadata: { deliveryId, repoFullName, reason } });
  await recordGithubProductUsage(env, "finding_explained_skipped", { actor, repoFullName, targetKey, outcome: "skipped", metadata: { reason } });
}

/**
 * `@gittensory generate-tests` (#4195, part of the #4189 epic): on-demand, MAINTAINER-ONLY AI-generated E2E
 * test coverage for this PR's changed behavior, posted as its own reply comment — mirroring
 * `maybeProcessExplainCommand`'s classify → authorize → act → audit shape exactly, but posting fresh
 * generated content rather than explaining already-published findings.
 *
 * Deliberately does NOT splice into the automated review's sticky unified comment (unlike fix-handoff):
 * this is an explicit, cost-bearing, maintainer-triggered action, not something derived for free from data
 * the regular review pass already computed — see `explain`/`configuration` for the same "own dedicated
 * reply comment" precedent for on-demand actions.
 */
async function maybeProcessGenerateTestsCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command || command.name !== "generate-tests") return false;
  const { classifyPrCommandRequest } = await import("../github/pr-command-request");
  const req = classifyPrCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) {
    await recordGenerateTestsSkip(env, deliveryId, req.repoFullName, req.targetKey, req.actor, req.reason);
    return true;
  }
  const targetKey = `${req.repoFullName}#${req.pr.number}`;
  const [pr, settings] = await Promise.all([getPullRequest(env, req.repoFullName, req.pr.number), resolveRepositorySettings(env, req.repoFullName)]);
  if (!pr) {
    await recordGenerateTestsSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "cached_pr_missing");
    return true;
  }
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "generate-tests" as GittensoryMentionCommandName, settings, pr });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.e2e_tests_generation_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "generate-tests") } });
    await recordGithubProductUsage(env, "e2e_tests_generation_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind } });
    return true;
  }
  const manifest = await loadRepoFocusManifest(env, req.repoFullName).catch(() => null);
  if (!resolveConvergedFeature(env, manifest, "e2eTests", req.repoFullName)) {
    await postGenerateTestsNotEnabledComment(env, req.installationId, req.repoFullName, req.pr.number);
    await recordGenerateTestsSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, "feature_disabled");
    return true;
  }
  // Same dry-run/paused gate every other action command respects (mirrors maybeProcessResolveCommand's own
  // resolveAgentActionMode check) — an agent-paused or dry-run repo gets no generated content posted at all.
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
  if (mode !== "live") {
    const skipReason = mode === "dry_run" ? "dry_run" : "agent_paused";
    await recordGenerateTestsSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, skipReason);
    return true;
  }
  const files = await listPullRequestFiles(env, req.repoFullName, req.pr.number);
  await runE2eTestGenerationAndDeliver(env, {
    repoFullName: req.repoFullName,
    installationId: req.installationId,
    pr,
    settings,
    manifest,
    files,
    actor: req.actor,
    mode,
    deliveryId,
    targetKey,
    trigger: "command",
  });
  return true;
}

/**
 * The shared generation-and-delivery core behind `@gittensory generate-tests` (#4195, the explicit command),
 * the `manifest_missing_tests` auto-trigger (#4196), and the panel checkbox (#4589) — one code path, so the
 * three triggers can never silently drift apart. Everything the caller must have already resolved BEFORE this
 * runs: the feature is enabled (#4192's `resolveConvergedFeature` gate), the repo is not paused/dry-run
 * (`mode === "live"`), and (for the auto-trigger specifically) the per-head-SHA double-generation guard has
 * already passed — this function itself has no opinion on any of that, it only generates, delivers, and audits.
 */
async function runE2eTestGenerationAndDeliver(
  env: Env,
  args: {
    repoFullName: string;
    installationId: number;
    pr: PullRequestRecord;
    settings: RepositorySettings;
    manifest: FocusManifest | null;
    files: Awaited<ReturnType<typeof listPullRequestFiles>>;
    actor: string;
    mode: ReturnType<typeof resolveAgentActionMode>;
    deliveryId: string;
    targetKey: string;
    // #4589: "checkbox" behaves like "command" below (a real, re-authorized maintainer invoker exists, so
    // delivery mode is NOT forced comment-only) -- it's kept as its own literal purely so audit/metadata can
    // distinguish "typed the command" from "clicked the checkbox" without changing any behavior.
    trigger: "command" | "auto" | "checkbox";
  },
): Promise<void> {
  const changedPaths = args.files.map((file) => file.path);
  // BYOK resolution mirrors runAiReviewForAdvisory's own (re-resolved per-caller is this codebase's
  // established convention for this exact 3-line block — see e.g. the vision-capture caller above).
  const storedKey = args.settings.aiReviewByok ? await getDecryptedRepositoryAiKey(env, args.repoFullName) : null;
  const providerKey =
    storedKey && (!args.settings.aiReviewProvider || args.settings.aiReviewProvider === storedKey.provider)
      ? { provider: storedKey.provider, key: storedKey.key, model: args.settings.aiReviewModel ?? storedKey.model }
      : null;
  const result = await runGittensoryE2eTestGeneration(withAdvisoryAiEnv(env, args.settings.advisoryAiRouting?.e2eTestGen === true), {
    repoFullName: args.repoFullName,
    prNumber: args.pr.number,
    title: args.pr.title,
    body: args.pr.body,
    files: args.files.map((file) => ({ path: file.path, patch: typeof file.payload?.patch === "string" ? file.payload.patch : undefined })),
    instructions: resolveE2eTestGenInstructions(args.manifest?.review, changedPaths),
    actor: args.actor,
    providerKey,
  });
  const testSource = result.status === "ok" ? result.testSource : null;

  // Delivery escalation (#4197): "comment" (default) never attempts a write; "commit" pushes the generated
  // test onto the PR's own head branch, UNLESS the PR author is a confirmed Gittensor miner (#4201's
  // scoring-integrity safeguard) — that check runs regardless of this repo's own delivery config, since the
  // external, upstream-computed score must never be able to include a maintainer-authored line a miner didn't
  // write themselves. The automated #4196 trigger has no maintainer invoker to authorize, so it is always
  // comment-only even for repositories that opt explicit maintainer commands into commit delivery.
  const deliveryMode = args.trigger === "auto" ? "comment" : resolveReviewPromptOverrides(args.manifest).e2eTestDelivery ?? "comment";
  let commitOutcome: E2eTestGenCommitOutcome | undefined;
  if (testSource && deliveryMode === "commit") {
    const minerDetection = args.pr.authorLogin
      ? await getCachedOfficialMinerDetection(env, args.pr.authorLogin, { targetKey: args.targetKey, deliveryId: args.deliveryId })
      : ({ status: "not_found" } as const);
    if (minerDetection.status === "confirmed") {
      commitOutcome = { status: "blocked" };
    } else if (args.pr.headSha && args.pr.headRef) {
      const attempt = await commitE2eTestToPrBranch(env, {
        installationId: args.installationId,
        repoFullName: args.repoFullName,
        prNumber: args.pr.number,
        headRef: args.pr.headRef,
        headSha: args.pr.headSha,
        testSource,
        actor: args.actor,
        mode: args.mode,
      });
      // The render layer only distinguishes committed/declined/blocked -- an "error" (unexpected failure,
      // vs. an expected can-never-work case) is still surfaced to the maintainer as "declined", with its
      // real reason, so the generated test is never silently dropped just because the write failed oddly.
      commitOutcome = attempt.status === "error" ? { status: "declined", reason: attempt.reason } : attempt;
    } else {
      commitOutcome = { status: "declined", reason: "the PR's head branch/commit is not cached" };
    }
  }

  const body = buildE2eTestGenCommentBody({ actor: args.actor, testSource, commit: commitOutcome });
  try {
    await createIssueComment(env, args.installationId, args.repoFullName, args.pr.number, sanitizePublicComment(body));
  } catch (error) {
    // Generated test source is far less predictable than this codebase's other curated comment content, so
    // a failure posting it (a GitHub API error, a rate limit, or any other unexpected throw) degrades to a
    // safe withheld-content note (never the raw error, never the raw generated text) rather than leaving the
    // maintainer with silence.
    await createIssueComment(
      env,
      args.installationId,
      args.repoFullName,
      args.pr.number,
      sanitizePublicComment(buildE2eTestGenCommentBody({ actor: args.actor, testSource: null })),
    );
    console.log(JSON.stringify({ event: "e2e_test_gen_comment_withheld", repoFullName: args.repoFullName, pr: args.pr.number, error: errorMessage(error) }));
  }
  await recordAuditEvent(env, {
    eventType: "github_app.e2e_tests_generation",
    actor: args.actor,
    targetKey: args.targetKey,
    outcome: "completed",
    detail: testSource ? "Generated an E2E test." : `No usable test generated (${result.status}).`,
    // headSha is included so the #4196 auto-trigger's per-commit double-generation guard (hasAuditEventForHeadSha)
    // can find this row again; a null headSha (never observed in practice -- both callers require a truthy one
    // before reaching here) degrades to simply never matching that guard, not a thrown error.
    metadata: { deliveryId: args.deliveryId, repoFullName: args.repoFullName, status: result.status, byok: Boolean(providerKey), deliveryMode, trigger: args.trigger, headSha: args.pr.headSha ?? null, ...(commitOutcome ? { commitStatus: commitOutcome.status } : {}) },
  });
  await recordGithubProductUsage(env, "e2e_tests_generation", { actor: args.actor, repoFullName: args.repoFullName, targetKey: args.targetKey, outcome: "completed", metadata: { status: result.status, generated: Boolean(testSource), deliveryMode, trigger: args.trigger, ...(commitOutcome ? { commitStatus: commitOutcome.status } : {}) } });
}

async function postGenerateTestsNotEnabledComment(env: Env, installationId: number, repoFullName: string, prNumber: number): Promise<void> {
  const body = sanitizePublicComment(
    [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      "> [!NOTE]",
      "> **E2E test generation is not enabled for this repository**",
      "> Ask a maintainer to enable `features.e2eTests` in `.gittensory.yml` (the operator's global flag must also be on).",
      "",
      "---",
      gittensoryFooter(),
    ].join("\n"),
  );
  await createIssueComment(env, installationId, repoFullName, prNumber, body);
}

async function recordGenerateTestsSkip(env: Env, deliveryId: string, repoFullName: string | null, targetKey: string | null, actor: string | null, reason: string): Promise<void> {
  await recordAuditEvent(env, { eventType: "github_app.e2e_tests_generation_skipped", actor, targetKey, outcome: "completed", detail: reason, metadata: { deliveryId, repoFullName, reason } });
  await recordGithubProductUsage(env, "e2e_tests_generation_skipped", { actor, repoFullName, targetKey, outcome: "skipped", metadata: { reason } });
}

async function appendPublishedAiReviewFindingsForResolve(
  env: Env,
  repoFullName: string,
  pr: PullRequestRecord,
  aiReviewMode: string,
  advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>,
): Promise<void> {
  const cachedReview = await getCachedAiReview(env, repoFullName, pr.number, advisory.headSha, aiReviewMode).catch(
    /* v8 ignore next -- fail-open parity with the main review path: a stale AI cache read must not block resolve. */
    () => null,
  );
  const publishedReview = cachedReview && hasPublicReviewAssessment(cachedReview.notes)
    ? cachedReview
    : await getLatestPublishedAiReview(env, repoFullName, pr.number, aiReviewMode).catch(
      /* v8 ignore next -- fail-open parity with frozen-review reuse; resolve still handles deterministic findings. */
      () => null,
    );
  if (publishedReview && hasPublicReviewAssessment(publishedReview.notes)) {
    advisory.findings.push(...publishedReview.findings);
  }
}

/**
 * `@gittensory configuration` (#2168): post the EFFECTIVE resolved review config (yml>DB>defaults) as a
 * public-safe comment so a maintainer can see what's actually in force without the dashboard. Read-only — it never
 * mutates the PR, so unlike gate-override it always answers a maintainer's direct query (the displayed execution
 * mode still reflects a pause). Honors the repo's per-repo `commandAuthorization` for `configuration` over the REAL
 * repo permission (never the spoofable comment author_association). Returns true once it owns the event; a
 * non-configuration comment returns false and falls through to the other command handlers.
 */
async function maybeProcessConfigurationCommand(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  const req = classifyConfigurationCommandRequest(payload, getInstallationId(payload));
  if (!req) return false;
  if (!req.ok) {
    await recordConfigurationSkip(env, deliveryId, req.repoFullName, req.targetKey, req.actor, req.reason);
    return true;
  }
  const targetKey = `${req.repoFullName}#${req.issueNumber}`;
  const settings = await resolveRepositorySettings(env, req.repoFullName);
  const association = await resolveRealRepoPermissionAssociation(env, req.installationId, req.repoFullName, req.actor);
  const authorization = evaluateCommandAuthorization({
    policy: settings.commandAuthorization,
    commandName: "configuration",
    commenterLogin: req.actor,
    commenterAssociation: association,
  });
  if (!authorization.authorized) {
    await recordConfigurationSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, authorization.reason);
    return true;
  }
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const body = sanitizePublicComment(
    [AGENT_COMMAND_COMMENT_MARKER, "", summarizeEffectiveConfig(settings, mode), "", "---", gittensoryFooter()].join("\n"),
  );
  await createOrUpdateAgentCommandComment(env, req.installationId, req.repoFullName, req.issueNumber, body, mode);
  await recordAuditEvent(env, {
    eventType: "github_app.configuration_posted",
    actor: req.actor,
    targetKey,
    outcome: "completed",
    detail: `Effective configuration posted for ${targetKey}.`,
    metadata: { deliveryId, repoFullName: req.repoFullName, mode },
  });
  return true;
}

async function recordConfigurationSkip(
  env: Env,
  deliveryId: string,
  repoFullName: string | null,
  targetKey: string | null,
  actor: string | null,
  reason: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.configuration_skipped",
    actor,
    targetKey,
    outcome: "completed",
    detail: reason,
    metadata: { deliveryId, repoFullName, reason },
  });
}

/**
 * `@gittensory plan` (#issue-coding-plan, flag-gated by GITTENSORY_REVIEW_PLANNER). On a MAINTAINER's comment on
 * an ISSUE (not a PR), generate a concise implementation plan from the issue text via Workers AI and post it as an
 * issue comment so a contributor has a concrete starting point. Flag-OFF (default) returns false immediately
 * (BEFORE any parse), so `@gittensory plan` falls through to the existing mention path → byte-identical. Returns
 * true once it owns the event (so the caller records it processed and stops). Fail-safe: a model/post error is
 * recorded as a skip and never throws into the webhook loop. A per-actor/per-repo cooldown prevents repeated
 * maintainer comments from spending shared AI quota in a burst.
 */
async function maybeProcessPlanCommand(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  if (!isPlannerEnabled(env)) return false; // flag-OFF → not handled here; the worker is byte-identical to today
  if (!isPlanCommand(payload.comment?.body)) return false;
  // #22: planning is ISSUE-only. A `@gittensory plan` on a PR is not a plan request, so DON'T consume it — fall
  // through to the generic mention handler so it posts the help card, exactly as the flag-OFF path does. Without
  // this the flag-ON worker swallowed a PR-thread `plan` mention and the contributor saw nothing.
  if (payload.issue?.pull_request) return false;
  // All eligibility guards live in the PURE classifier (exhaustively unit-tested); here we carry one ok branch.
  const req = classifyPlanCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) {
    await recordPlanSkip(
      env,
      deliveryId,
      req.repoFullName,
      req.targetKey,
      req.actor,
      req.reason,
    );
    return true;
  }
  const targetKey = `${req.repoFullName}#${req.issue.number}`;
  // Issue-level authorization: planning spends Workers AI + posts publicly. Honor the repo's per-repo
  // commandAuthorization policy for `plan` (#21) — the SAME policy every other command respects — over the REAL
  // repo permission (resolveRealRepoPermissionAssociation), never the comment's spoofable author_association.
  // `plan` defaults to maintainer/collaborator (DEFAULT_COMMAND_AUTHORIZATION_POLICY), so the default behavior is
  // unchanged; a maintainer can now widen/narrow it like any other command.
  const settings = await resolveRepositorySettings(env, req.repoFullName);
  const association = await resolveRealRepoPermissionAssociation(
    env,
    req.installationId,
    req.repoFullName,
    req.actor,
  );
  const authorization = evaluateCommandAuthorization({
    policy: settings.commandAuthorization,
    commandName: "plan",
    commenterLogin: req.actor,
    commenterAssociation: association,
  });
  if (!authorization.authorized) {
    await recordPlanSkip(
      env,
      deliveryId,
      req.repoFullName,
      targetKey,
      req.actor,
      authorization.reason,
    );
    return true;
  }
  if (
    await isPlanCommandCoolingDown(
      env,
      req.repoFullName,
      req.actor,
      ISSUE_PLAN_COOLDOWN_MS,
    )
  ) {
    await recordPlanSkip(
      env,
      deliveryId,
      req.repoFullName,
      targetKey,
      req.actor,
      "cooldown_active",
    );
    return true;
  }
  // Respect pause/dry-run/global-freeze like every other agent-driven write in this file (#2257). Checked right
  // before the only effectful work (a real Workers AI call + a public comment) so a paused/dry-run repo never
  // incurs the AI cost speculatively — mirroring how the reopen-reclose handler skips its write uniformly for
  // both dry_run and paused, not just paused.
  const planMode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  if (planMode !== "live") {
    await recordPlanSkip(
      env,
      deliveryId,
      req.repoFullName,
      targetKey,
      req.actor,
      planMode === "dry_run" ? "dry_run" : "agent_paused",
    );
    return true;
  }
  const plan = await generateIssuePlan(
    withAdvisoryAiEnv(env, settings.advisoryAiRouting?.planner === true),
    { title: req.issue.title, body: req.issue.body },
    {
      actor: req.actor,
      repoFullName: req.repoFullName,
      issueNumber: req.issue.number,
    },
  );
  if (!plan) {
    await recordPlanSkip(
      env,
      deliveryId,
      req.repoFullName,
      targetKey,
      req.actor,
      "no_plan_generated",
    );
    return true;
  }
  await createIssueComment(
    env,
    req.installationId,
    req.repoFullName,
    req.issue.number,
    buildIssuePlanComment(plan, {
      actor: req.actor,
      repoFullName: req.repoFullName,
      issueNumber: req.issue.number,
    }),
  );
  await recordAuditEvent(env, {
    eventType: "github_app.issue_plan_generated",
    actor: req.actor,
    targetKey,
    outcome: "completed",
    detail: `Implementation plan posted for ${targetKey}.`,
    metadata: { deliveryId, repoFullName: req.repoFullName },
  });
  await recordGithubProductUsage(env, "issue_plan_generated", {
    actor: req.actor,
    repoFullName: req.repoFullName,
    targetKey,
    outcome: "completed",
    metadata: {},
  });
  return true;
}

async function isPlanCommandCoolingDown(
  env: Env,
  repoFullName: string,
  actor: string,
  cooldownMs: number,
): Promise<boolean> {
  const since = new Date(Date.now() - cooldownMs).toISOString();
  const row = await env.DB.prepare(
    `select 1 as active
       from audit_events
      where event_type in ('github_app.issue_plan_generated', 'github_app.issue_plan_skipped')
        and actor = ?
        and json_extract(metadata_json, '$.repoFullName') = ?
        and created_at >= ?
        and (event_type = 'github_app.issue_plan_generated' or coalesce(detail, '') in ('no_plan_generated', 'cooldown_active'))
      limit 1`,
  )
    .bind(actor, repoFullName, since)
    .first<{ active: number }>();
  return Boolean(row);
}

async function recordPlanSkip(
  env: Env,
  deliveryId: string,
  repoFullName: string | null,
  targetKey: string | null,
  actor: string | null,
  reason: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.issue_plan_skipped",
    actor,
    targetKey,
    outcome: "completed",
    detail: reason,
    metadata: { deliveryId, repoFullName, reason },
  });
  await recordGithubProductUsage(env, "issue_plan_skipped", {
    actor,
    repoFullName,
    targetKey,
    outcome: "skipped",
    metadata: { reason },
  });
}

async function maybeProcessPrPanelRetrigger(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  const comment = payload.comment;
  if (
    payload.action !== "edited" ||
    !comment ||
    !isCheckedPrPanelRetrigger(comment.body)
  )
    return false;
  if (!isGittensoryPanelBotComment(env, comment.user)) return false;

  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const actor = payload.sender?.login ?? null;
  const targetKey =
    repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (payload.sender?.type === "Bot" || /\[bot\]$/i.test(actor ?? "")) {
    await recordPrPanelRetriggerSkip(
      env,
      deliveryId,
      repoFullName,
      targetKey,
      actor,
      "bot_author",
    );
    return true;
  }
  if (!repoFullName || !issue?.pull_request || !installationId) {
    await recordPrPanelRetriggerSkip(
      env,
      deliveryId,
      repoFullName,
      targetKey,
      actor,
      "missing_repo_pr_or_installation",
    );
    return true;
  }
  const [pr, settings] = await Promise.all([
    getPullRequest(env, repoFullName, issue.number),
    resolveRepositorySettings(env, repoFullName),
  ]);
  if (!pr) {
    await recordPrPanelRetriggerSkip(
      env,
      deliveryId,
      repoFullName,
      targetKey,
      actor,
      "cached_pr_missing",
    );
    return true;
  }

  const { authorization } = await authorizePrActionActor({
    env,
    deliveryId,
    installationId,
    repoFullName,
    issue,
    actor,
    commandName: "review-now",
    settings: { ...settings, commandAuthorization: PR_PANEL_RETRIGGER_COMMAND_AUTHORIZATION },
    pr,
    needsMinerDetection: false,
  });
  if (!authorization.authorized) {
    await recordPrPanelRetriggerSkip(
      env,
      deliveryId,
      repoFullName,
      `${repoFullName}#${pr.number}`,
      actor,
      authorization.reason,
    );
    await recordGithubProductUsage(env, "pr_panel_retrigger_skipped", {
      actor,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome:
        authorization.reason === "miner_detection_unavailable"
          ? "error"
          : "skipped",
      metadata: {
        reason: authorization.reason,
        actorKind: authorization.actorKind,
        allowedRoles: commandAuthorizationAllowedRoles(
          PR_PANEL_RETRIGGER_COMMAND_AUTHORIZATION,
          "review-now",
        ),
      },
    });
    return true;
  }

  const { repo, advisory, otherOpenPullRequests } = await buildAuthorizedPrActionAdvisory(
    env,
    repoFullName,
    pr,
    settings,
  );
  await persistAdvisory(env, advisory);
  await recordAuditEvent(env, {
    eventType: "github_app.pr_panel_retriggered",
    actor,
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: "completed",
    metadata: { deliveryId, repoFullName, commentId: comment.id },
  });
  // A manual re-run is a re-evaluation surface — the user clicks it AFTER the PR changed — so the slop and
  // manifest-policy gates must see the PR's current files, not whatever is cached. Mirror the webhook path
  // (#866/#925): refresh before publishing so the re-published Gate check reflects the latest file set. This is
  // the explicit manual repair/debug trigger (#audit-rate-headroom), so force a fresh fetch past the head-SHA
  // snapshot cache — the user asked for a re-check even if nothing detectably changed.
  if (
    shouldCollectSlopEvidence(settings) ||
    settings.manifestPolicyGateMode !== "off" ||
    (await shouldRefreshFilesForPreMergeChecks(env, repoFullName))
  ) {
    await refreshPullRequestDetails(env, repoFullName, pr.number, { force: true });
  }
  const liveFacts = createLiveGithubFacts();
  if (
    !(await prReadyForReview(
      env,
      installationId,
      repoFullName,
      pr,
      settings,
      deliveryId,
      liveFacts,
    ))
  ) {
    await recordAuditEvent(env, {
      eventType: "github_app.pr_panel_retrigger_deferred",
      actor,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "queued",
      detail: "manual panel retrigger deferred until CI finishes",
      metadata: { deliveryId, repoFullName, commentId: comment.id },
    }).catch(() => undefined);
    return true;
  }
  await maybePublishPrPublicSurface(
    env,
    installationId,
    repoFullName,
    pr,
    repo,
    settings,
    advisory,
    otherOpenPullRequests,
    {
      deliveryId,
      action: "manual_retrigger",
      liveFacts,
      // The user explicitly asked for a re-run: bypass both the AI-review cache and the manual-review freeze so
      // this pass always spends a fresh opinion instead of silently replaying a stale/cached one (#3725).
      forceAiReview: true,
    },
  );
  await recordGithubProductUsage(env, "pr_panel_retriggered", {
    actor,
    repoFullName,
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: "completed",
    metadata: { commentId: comment.id },
  });
  return true;
}

/**
 * The generate-tests checkbox (#4589) — the interactive counterpart to #4583's text-only inline CTA, and a
 * sibling of `maybeProcessPrPanelRetrigger` above: SAME `issue_comment.edited` detection shell (marker
 * presence, bot's-own-comment confirmation, bot-sender guard, `payload.sender` as the real actor — a GitHub
 * task-list checkbox can be toggled by anyone who can comment on the PR, so the checkbox itself proves
 * nothing; only this server-side re-authorization does), but dispatches through the SAME shared
 * `runE2eTestGenerationAndDeliver` core `@gittensory generate-tests` (#4195) and the `manifest_missing_tests`
 * auto-trigger (#4196) already use, rather than a full panel re-render.
 *
 * Hardcoded to `commandAuthorization: PR_PANEL_GENERATE_TESTS_COMMAND_AUTHORIZATION` (maintainer-only, one
 * tier narrower than the retrigger's own maintainer+collaborator floor) regardless of what a repo's own
 * `.gittensory.yml` might configure for the text-command version of `generate-tests` — a one-click checkbox
 * must never be wider than the deliberately narrow default the text command itself already has. An
 * unauthorized click is a SILENT no-op (no comment fetch, no patch, no revert, no explanation) — audit-logged
 * only, exactly mirroring `maybeProcessPrPanelRetrigger`'s own denial behavior above.
 */
async function maybeProcessPrPanelGenerateTests(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  const comment = payload.comment;
  if (
    payload.action !== "edited" ||
    !comment ||
    !isCheckedPrPanelGenerateTests(comment.body)
  )
    return false;
  if (!isGittensoryPanelBotComment(env, comment.user)) return false;

  const repoFullName = payload.repository?.full_name ?? null;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const actor = payload.sender?.login ?? null;
  const targetKey =
    repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (payload.sender?.type === "Bot" || /\[bot\]$/i.test(actor ?? "")) {
    await recordGenerateTestsSkip(env, deliveryId, repoFullName, targetKey, actor, "bot_author");
    return true;
  }
  if (!repoFullName || !issue?.pull_request || !installationId) {
    await recordGenerateTestsSkip(env, deliveryId, repoFullName, targetKey, actor, "missing_repo_pr_or_installation");
    return true;
  }
  const [pr, settings] = await Promise.all([
    getPullRequest(env, repoFullName, issue.number),
    resolveRepositorySettings(env, repoFullName),
  ]);
  if (!pr) {
    await recordGenerateTestsSkip(env, deliveryId, repoFullName, targetKey, actor, "cached_pr_missing");
    return true;
  }

  const { authorization } = await authorizePrActionActor({
    env,
    deliveryId,
    installationId,
    repoFullName,
    issue,
    actor,
    commandName: "generate-tests" as GittensoryMentionCommandName,
    settings: { ...settings, commandAuthorization: PR_PANEL_GENERATE_TESTS_COMMAND_AUTHORIZATION },
    pr,
    needsMinerDetection: false,
  });
  if (!authorization.authorized) {
    await recordAuditEvent(env, {
      eventType: "github_app.e2e_tests_generation_denied",
      actor,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: authorization.reason,
      metadata: {
        deliveryId,
        repoFullName,
        commentId: comment.id,
        allowedRoles: commandAuthorizationAllowedRoles(PR_PANEL_GENERATE_TESTS_COMMAND_AUTHORIZATION, "generate-tests"),
      },
    });
    await recordGithubProductUsage(env, "e2e_tests_generation_denied", {
      actor,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      metadata: { reason: authorization.reason, actorKind: authorization.actorKind },
    });
    return true;
  }

  // Defense in depth: re-check the feature is STILL enabled -- the repo's own .gittensory.yml could have
  // changed between when this comment was posted (checkbox rendered) and when it was actually clicked.
  const manifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  if (!resolveConvergedFeature(env, manifest, "e2eTests", repoFullName)) {
    await recordGenerateTestsSkip(env, deliveryId, repoFullName, `${repoFullName}#${pr.number}`, actor, "feature_disabled");
    return true;
  }
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
  if (mode !== "live") {
    const skipReason = mode === "dry_run" ? "dry_run" : "agent_paused";
    await recordGenerateTestsSkip(env, deliveryId, repoFullName, `${repoFullName}#${pr.number}`, actor, skipReason);
    return true;
  }
  const files = await listPullRequestFiles(env, repoFullName, pr.number);
  await runE2eTestGenerationAndDeliver(env, {
    repoFullName,
    installationId,
    pr,
    settings,
    manifest,
    files,
    // Non-null: authorization.authorized is only ever true when actor resolved to a real login in the first
    // place (evaluateCommandAuthorization can't match a maintainer/collaborator/confirmed_miner role off a
    // null commenterLogin) -- guaranteed by the `authorization.authorized` check above, not re-derivable here.
    actor: actor!,
    mode,
    deliveryId,
    targetKey: `${repoFullName}#${pr.number}`,
    trigger: "checkbox",
  });
  return true;
}

async function resolveRealRepoPermissionAssociation(
  env: Env,
  installationId: number,
  repoFullName: string,
  actor: string | null,
): Promise<string | null> {
  if (!actor) return null;
  const permission = await getRepositoryCollaboratorPermission(
    env,
    installationId,
    repoFullName,
    actor,
  ).catch(() => null);
  if (permission === "admin" || permission === "maintain") return "MEMBER";
  if (permission === "write") return "COLLABORATOR";
  return null;
}

async function filterTrustedReviewNotificationEvents(
  env: Env,
  installationId: number | undefined,
  events: DetectedNotificationEvent[],
): Promise<DetectedNotificationEvent[]> {
  const trustedEvents: DetectedNotificationEvent[] = [];
  for (const event of events) {
    if (event.eventType !== "pull_request_changes_requested") {
      trustedEvents.push(event);
      continue;
    }
    if (!installationId || event.actorLogin === "unknown") continue;
    const permission = await getRepositoryCollaboratorPermission(
      env,
      installationId,
      event.repoFullName,
      event.actorLogin,
    ).catch(() => null);
    if (
      permission === "admin" ||
      permission === "maintain" ||
      permission === "write"
    )
      trustedEvents.push(event);
  }
  return trustedEvents;
}

// #824 the SINGLE real-permission authorization gate for @gittensory action commands (gate-override, the
// PR-panel retrigger, and the agent-layer write actions to come in #778/#769). It resolves the actor's REAL
// repo permission via resolveRealRepoPermissionAssociation — never the spoofable author_association (the #788
// hazard) — then runs isAuthorizedCommandActor. Every action command authorizes through here, so no future
// command can accidentally fall back to a weaker check. Returns the decision; the caller owns the
// command-specific deny/allow handling.
async function authorizePrActionActor(args: {
  env: Env;
  deliveryId: string;
  installationId: number;
  repoFullName: string;
  issue: NonNullable<GitHubWebhookPayload["issue"]>;
  actor: string | null;
  commandName: GittensoryMentionCommandName;
  settings: RepositorySettings;
  pr: PullRequestRecord;
  needsMinerDetection?: boolean;
}): Promise<{
  authorization: ReturnType<typeof isAuthorizedCommandActor>;
  actorAssociation: string | null;
  pullRequestAuthor: string | null;
}> {
  const actorAssociation = await resolveRealRepoPermissionAssociation(
    args.env,
    args.installationId,
    args.repoFullName,
    args.actor,
  );
  const pullRequestAuthor =
    args.pr.authorLogin ?? args.issue.user?.login ?? null;
  const official =
    args.needsMinerDetection &&
    pullRequestAuthor &&
    commandAuthorizationNeedsMinerDetection({
      policy: args.settings.commandAuthorization,
      commandName: args.commandName,
      commenterLogin: args.actor,
      commenterAssociation: actorAssociation,
      pullRequestAuthorLogin: pullRequestAuthor,
    })
      ? await getCachedOfficialMinerDetection(args.env, pullRequestAuthor, {
          targetKey: `${args.repoFullName}#${args.issue.number}`,
          deliveryId: args.deliveryId,
        })
      : undefined;
  const authorization = isAuthorizedCommandActor({
    commandName: args.commandName,
    commenterLogin: args.actor,
    commenterAssociation: actorAssociation,
    pullRequestAuthorLogin: pullRequestAuthor,
    officialAuthorDetection: official,
    commandAuthorizationPolicy: args.settings.commandAuthorization,
  });
  return { authorization, actorAssociation, pullRequestAuthor };
}

// #824 the common "load the PR's repo context + build its advisory" step every authorized action command runs
// before its mutation. Identical across gate-override and the PR-panel retrigger.
export async function buildAuthorizedPrActionAdvisory(
  env: Env,
  repoFullName: string,
  pr: PullRequestRecord,
  settings: RepositorySettings,
): Promise<{
  repo: Awaited<ReturnType<typeof getRepository>>;
  advisory: ReturnType<typeof buildPullRequestAdvisory>;
  // Reconciled open siblings (#dup-winner-staleness), returned so a caller that also needs to invoke
  // maybePublishPrPublicSurface (the panel-retrigger path) can reuse the SAME reconciled set instead of
  // re-deriving it from a second, un-reconciled read.
  otherOpenPullRequests: PullRequestRecord[];
}> {
  const [repo, cachedOtherOpenPullRequests] = await Promise.all([
    getRepository(env, repoFullName),
    listOtherOpenPullRequests(env, repoFullName, pr.number),
  ]);
  // #dup-winner-staleness: reconcile the cached open-PR read against GitHub's live state, same as the main
  // webhook path (reReviewStoredPullRequest / handlePullRequestWebhook) -- an authorized PR action (gate-
  // override / panel retrigger) must see the same ground truth, not a second, independently-stale snapshot.
  const otherOpenPullRequests = await reconcileLiveDuplicateSiblings(
    env,
    repo?.installationId ?? null,
    repoFullName,
    pr,
    cachedOtherOpenPullRequests,
  );
  // Mirror the main webhook path: thread linked-issue authors + the open-reference check so an authorized PR
  // action (gate-override / panel retrigger) honors the same self-authored-linked-issue block AND stale-
  // issue-link countermeasure. installationId comes from the repo record. (#self-authored-parity, #unlinked-issue-guardrail-followup)
  const { linkedIssueAuthorLogins, confirmedNoOpenLinkedIssue } = await resolveLinkedIssueAdvisoryContext(
    env,
    repo?.installationId ?? null,
    repoFullName,
    pr.linkedIssues,
    settings,
  );
  const advisory = buildPullRequestAdvisory(repo, pr, {
    otherOpenPullRequests,
    requireLinkedIssue: shouldCollectLinkedIssueEvidence(settings),
    duplicateWinnerEnabled: env.GITTENSORY_DUPLICATE_WINNER === "true",
    confirmedNoOpenLinkedIssue,
    linkedIssueAuthorLogins,
  });
  return { repo, advisory, otherOpenPullRequests };
}

function isCheckedPrPanelRetrigger(body: string | null | undefined): boolean {
  if (
    !body?.includes(PR_PANEL_COMMENT_MARKER) ||
    !body.includes(PR_PANEL_RETRIGGER_MARKER)
  )
    return false;
  return checkedMarkerRegex(PR_PANEL_RETRIGGER_MARKER).test(body);
}

// #4589: sibling of isCheckedPrPanelRetrigger above, same marker-presence + checkedMarkerRegex mechanism, own
// dedicated marker so the two checkboxes (re-run vs generate-tests) can independently appear/toggle in the
// same comment without either detector matching the other's line.
function isCheckedPrPanelGenerateTests(body: string | null | undefined): boolean {
  if (
    !body?.includes(PR_PANEL_COMMENT_MARKER) ||
    !body.includes(PR_PANEL_GENERATE_TESTS_MARKER)
  )
    return false;
  return checkedMarkerRegex(PR_PANEL_GENERATE_TESTS_MARKER).test(body);
}

function checkedMarkerRegex(marker: string): RegExp {
  return new RegExp(
    `(?:^|\\n)\\s*[-*]\\s*\\[[xX]\\]\\s*${escapeRegExp(marker)}`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGittensoryPanelBotComment(
  env: Env,
  user: NonNullable<GitHubWebhookPayload["comment"]>["user"] | undefined,
): boolean {
  return (
    user?.type === "Bot" &&
    user.login?.toLowerCase() === `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase()
  );
}

async function recordPrPanelRetriggerSkip(
  env: Env,
  deliveryId: string,
  repoFullName: string | null | undefined,
  targetKey: string | null | undefined,
  actor: string | null,
  reason: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.pr_panel_retrigger_skipped",
    actor,
    targetKey,
    outcome: "completed",
    detail: reason,
    metadata: { deliveryId, ...(repoFullName ? { repoFullName } : {}) },
  });
  await recordGithubProductUsage(env, "pr_panel_retrigger_skipped", {
    actor,
    repoFullName,
    targetKey,
    outcome: "skipped",
    metadata: { reason },
  });
}

/** Draft-dodge guard (#converted-to-draft): a contributor converting an OPEN PR to draft cannot use draft state
 *  to keep a gate-rejected PR alive. When a prior gate failure exists for the PR's current headSha (and the
 *  block has not been maintainer-overridden), close the PR immediately — the gate verdict stands and does not
 *  reset on draft conversion. Per-PR actuation-locked (#2135/#2447): a concurrent delivery for the same PR must
 *  not evaluate + potentially mutate it at the same time. Lock contention is retryable because ordinary
 *  maintenance can hold the shared lock without enforcing this converted_to_draft event. */
async function maybeCloseDraftDodgeAttempt(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  settings: RepositorySettings,
): Promise<void> {
  const actuationLock = await claimPrActuationLock(env, repoFullName, pr.number);
  if (!actuationLock.acquired) {
    throw new PrActuationLockContendedError(repoFullName, pr.number, "draft-dodge");
  }
  try {
    await closeDraftDodgeAttemptIfBlocked(
      env,
      deliveryId,
      installationId,
      repoFullName,
      pr,
      settings,
    );
  } finally {
    await releasePrActuationLock(env, repoFullName, pr.number, actuationLock.ownerToken);
  }
}

async function closeDraftDodgeAttemptIfBlocked(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  settings: RepositorySettings,
): Promise<void> {
  const block = await getGateBlockOutcome(
    env,
    repoFullName,
    pr.number,
  ).catch(() => undefined);
  const repoOwner = repoFullName.includes("/")
    ? repoFullName.slice(0, repoFullName.indexOf("/")).toLowerCase()
    : "";
  const draftDodgeAuthorLogin = (pr.authorLogin ?? "").toLowerCase();
  const authorIsOwner =
    draftDodgeAuthorLogin === repoOwner && repoOwner.length > 0;
  // Fleet-operator identity (#2133): same ADMIN_GITHUB_LOGINS exemption as the primary close-eligibility
  // computation elsewhere — an admin login must never be auto-closed here either, matching every other
  // actuation path's trusted-operator definition.
  const authorIsAdmin =
    draftDodgeAuthorLogin.length > 0 &&
    parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(draftDodgeAuthorLogin);
  if (
    block &&
    block.headSha === pr.headSha &&
    !block.overridden &&
    !authorIsOwner &&
    !authorIsAdmin
  ) {
    // Respect the agent action mode (#killswitch-gap): the outer guard already excludes a per-repo pause,
    // but this close path must also honor the global freeze and dry-run — so a freeze is a COMPLETE stop
    // and a dry-run records the would-be close without touching GitHub.
    const draftMode = resolveAgentActionMode({
      globalPaused:
        isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
      agentPaused: settings.agentPaused,
      agentDryRun: settings.agentDryRun,
    });
    // Close-autonomy gate (#4602): this enforcement path bypasses executeAgentMaintenanceActions entirely
    // (like every check above), so it never got the standard pipeline's per-action-class autonomy check --
    // the outer dispatch condition only requires isAgentConfigured (true for ANY acting class), not
    // specifically close. Without this, a repo that opts into some OTHER autonomy class (e.g. assign: "auto")
    // while deliberately leaving close unconfigured (deny-by-default) could still have PRs auto-closed here.
    // Mirrors the review-evasion siblings' identical gate; checked before the live/dry-run branch so a
    // dry-run never claims "would close" when the repo isn't even configured to close for real.
    const draftDodgeCloseAutonomy = resolveAutonomy(settings.autonomy, "close");
    if (draftDodgeCloseAutonomy !== "auto") {
      await recordAuditEvent(env, {
        eventType: "github_app.draft_dodge_closed",
        actor: "gittensory",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "denied",
        detail:
          draftDodgeCloseAutonomy === "auto_with_approval"
            ? `close autonomy requires approval -- draft-dodge close not enforced for ${pr.authorLogin ?? "unknown"}`
            : `autonomy for close is not acting -- draft-dodge close not enforced for ${pr.authorLogin ?? "unknown"}`,
        metadata: {
          deliveryId,
          repoFullName,
          headSha: pr.headSha,
          blockerCodes: block.blockerCodes,
        },
      }).catch(
        /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
        () => undefined,
      );
      return;
    }
    if (draftMode === "live") {
      // Write-permission readiness (#2134): this close bypasses executeAgentMaintenanceActions entirely
      // (the whole point is to enforce the gate verdict against the CURRENT headSha even though the PR
      // was converted to draft), so it never got the standard pipeline's step-6 PR_WRITE_CLASSES guard.
      // Without this, a revoked/never-consented pull_requests:write grant would still attempt the close,
      // get a 403 from GitHub, and have it silently swallowed by the .catch() below — with the audit
      // event still recorded as "completed" as if the close actually happened. Checked BEFORE the live
      // freshness re-check below so a permission-denied installation never pays for a live GitHub fetch.
      // Deliberately UNCAUGHT: getInstallation itself never swallows a genuine D1 read failure (it only
      // resolves null on a legitimate "row not found" query result), so let a transient storage hiccup
      // propagate and fail this whole webhook job -- the queue's own retry re-runs it, and a later attempt
      // with a working DB read correctly evaluates readiness. Catching it into `null` here would instead
      // permanently misrecord the outcome as "pull_requests: write not granted" (a real GitHub-permission
      // problem) when the actual cause was an infra blip, misleading an operator investigating the audit
      // trail and burying the fact that no retry ever happens for a caught, definitively-denied outcome.
      const draftDodgeInstallation = await getInstallation(
        env,
        installationId,
      );
      /* v8 ignore next -- upsertInstallation already ran unconditionally earlier in this same handler for
       * every webhook, so a genuinely-missing row is not reachable through the normal webhook path
       * exercised by tests; a synced installation always has a permissions object. */
      const draftDodgeInstallationPermissions = draftDodgeInstallation?.permissions ?? null;
      const draftDodgePermissionReadiness = resolveAgentPermissionReadiness({
        autonomy: settings.autonomy,
        installationPermissions: draftDodgeInstallationPermissions,
        actionClass: "close",
      });
      if (draftDodgePermissionReadiness !== "ready") {
        /* v8 ignore next -- a deleted-account PR yields a null author login; the fallback is defensive */
        const draftDodgeAuthor = pr.authorLogin ?? "unknown";
        await recordAuditEvent(env, {
          eventType: "github_app.draft_dodge_closed",
          actor: "gittensory",
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "denied",
          detail: `denied draft-dodge close for ${draftDodgeAuthor} — pull_requests: write not granted`,
          metadata: {
            deliveryId,
            repoFullName,
            headSha: pr.headSha,
            blockerCodes: block.blockerCodes,
          },
        }).catch(
          /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
          () => undefined,
        );
        return;
      }
      // Live re-check (#2130): the two async DB reads above (getGateBlockOutcome, resolveAgentActionMode's
      // isGlobalAgentFrozen) leave a window where a maintainer could merge/close the PR, or a fresh push
      // could clear the gate failure, before this fires. Unlike the main gate-close path — which routes
      // every close through executeAgentMaintenanceActions's freshness guard — this handler acted purely
      // off the stale webhook-ingestion payload. Re-verify live state immediately before the mutation.
      // requireDraft: head/state alone would still read "current" if the author converted the PR BACK
      // to ready_for_review in that window -- the draft-dodge close's own justification no longer
      // holds, since there is no longer a draft to be "dodging" the gate through.
      const freshness = await fetchPullRequestFreshness(env, {
        installationId,
        repoFullName,
        pullNumber: pr.number,
        expectedHeadSha: pr.headSha,
        requireDraft: true,
      });
      if (freshness.status !== "current") {
        await recordAuditEvent(env, {
          eventType: "github_app.draft_dodge_closed",
          actor: "gittensory",
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "denied",
          detail: `${pullRequestFreshnessDetail(freshness)} — draft-dodge close not executed`,
          metadata: {
            deliveryId,
            repoFullName,
            headSha: pr.headSha,
            blockerCodes: block.blockerCodes,
          },
        }).catch(() => undefined);
      } else {
        const codes = block.blockerCodes.join(", ");
        await createIssueComment(
          env,
          installationId,
          repoFullName,
          pr.number,
          `Gate verdict stands for this commit — converting to draft does not reset the review. Re-submit a new PR with the issues addressed${codes ? ` (${codes})` : ""}.`,
        ).catch(() => undefined);
        await closePullRequest(
          env,
          installationId,
          repoFullName,
          pr.number,
        ).catch(() => undefined);
        await recordAuditEvent(env, {
          eventType: "github_app.draft_dodge_closed",
          actor: "gittensory",
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "completed",
          detail: `closed draft-dodge attempt by ${pr.authorLogin ?? "unknown"} — prior gate failure on headSha ${pr.headSha} stands`,
          metadata: {
            deliveryId,
            repoFullName,
            headSha: pr.headSha,
            blockerCodes: block.blockerCodes,
          },
        }).catch(() => undefined);
      }
    } else if (draftMode === "dry_run") {
      /* v8 ignore next -- a deleted-account PR yields a null author login; the fallback is defensive */
      const draftAuthor = pr.authorLogin ?? "unknown";
      await recordAuditEvent(env, {
        eventType: "github_app.draft_dodge_closed",
        actor: "gittensory",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        detail: `dry-run: would close draft-dodge attempt by ${draftAuthor} — prior gate failure on headSha ${pr.headSha} stands`,
        metadata: {
          deliveryId,
          repoFullName,
          headSha: pr.headSha,
          blockerCodes: block.blockerCodes,
          mode: "dry_run",
        },
      }).catch(
        /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
        () => undefined,
      );
    }
  }
}

/** Outcome of {@link maybeRecloseDisallowedReopen}: "reclosed" means the caller must skip the normal re-review
 *  pass; a plain boolean can't distinguish "evaluated, not blocked" from "reclosed, stop here". */
type ReopenRecloseOutcome = "reclosed" | "allowed";

/** Reopen-prevention (#one-shot-reopen): re-close a contributor's reopen of a PR that gittensory / a maintainer
 *  closed (closes are one-shot). Returns "reclosed" when it re-closed (caller skips the re-review). Exempt: the
 *  bot's own re-review reopens, owner/admin reopens, and a contributor reopening a PR they CLOSED THEMSELVES.
 *  Per-PR actuation-locked (#2135/#2447): a concurrent delivery for the same PR must not evaluate + potentially
 *  mutate this PR at the same time. Lock contention is retryable because ordinary maintenance can hold the
 *  shared lock without enforcing this reopened event. */
async function maybeRecloseDisallowedReopen(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
): Promise<ReopenRecloseOutcome> {
  const actuationLock = await claimPrActuationLock(env, repoFullName, pr.number);
  if (!actuationLock.acquired) {
    throw new PrActuationLockContendedError(repoFullName, pr.number, "reopen-reclose");
  }
  try {
    const reclosed = await recloseDisallowedReopenIfNeeded(
      env,
      deliveryId,
      installationId,
      repoFullName,
      pr,
      payload,
    );
    return reclosed ? "reclosed" : "allowed";
  } finally {
    await releasePrActuationLock(env, repoFullName, pr.number, actuationLock.ownerToken);
  }
}

async function recloseDisallowedReopenIfNeeded(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  const reopener = (payload.sender?.login ?? "").toLowerCase();
  if (!reopener) return false;
  const botLogin = `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
  if (reopener === botLogin) return false; // the bot's own nightly re-review reopen is allowed
  const repoOwner = repoFullName.includes("/")
    ? repoFullName.slice(0, repoFullName.indexOf("/")).toLowerCase()
    : "";
  const admins = parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS); // unified parse: whitespace OR comma (#audit-3.13)
  const hasMaintainerPermission = async (login: string): Promise<boolean> => {
    if (login === repoOwner || admins.has(login)) return true;
    const permission = await getRepositoryCollaboratorPermission(
      env,
      installationId,
      repoFullName,
      login,
    ).catch(() => null);
    return (
      permission === "admin" ||
      permission === "maintain" ||
      permission === "write"
    );
  };
  if (await hasMaintainerPermission(reopener)) return false; // owner / admin / write collaborators may reopen
  // A non-maintainer reopened: re-close ONLY if gittensory or a maintainer closed it (one-shot). A contributor
  // reopening a PR they closed themselves is allowed (fail-open on an unknown closer).
  const closerResult = await getLastCloserLogin(
    env,
    installationId,
    repoFullName,
    pr.number,
  );
  const closer = closerResult.login?.toLowerCase() ?? null;
  const closerIsBotOrMaintainer =
    closer != null &&
    (closer === botLogin || (await hasMaintainerPermission(closer)));
  // #audit-2.4: getLastCloserLogin inspects only a bounded newest-events window, so a contributor who appends
  // >1000 timeline events can push the real close out of view → null closer → bypass. When we could NOT inspect
  // the whole timeline AND found no qualifying closer, fail CLOSED — a one-shot close stands. A genuine
  // self-close sits at the timeline end and is found in-window, so legitimate self-close reopens stay allowed.
  const windowEvasionSuspected =
    closer == null && !closerResult.coveredAllPages;
  if (!closerIsBotOrMaintainer && !windowEvasionSuspected) return false;
  // Respect the agent action mode like every other write action (#killswitch-gap): a paused/frozen repo must
  // NOT touch GitHub, and dry-run records the would-be re-close without acting — so a dry-run is truly inert and
  // the global kill-switch is a COMPLETE stop. This close path previously bypassed pause/freeze/dry-run entirely.
  const reopenSettings = await resolveRepositorySettings(env, repoFullName);
  // Close-autonomy gate (#4602): isAgentConfigured alone is too loose here -- it is true whenever ANY autonomy
  // class is acting (e.g. merge: "auto"), not specifically close, so a repo that opts into some OTHER
  // autonomy class while deliberately leaving close unconfigured (deny-by-default) could still have a
  // disallowed reopen re-closed here. Check the close action class directly, mirroring the review-evasion
  // siblings' identical gate. resolveAgentActionMode below is orthogonal to autonomy (it only reflects
  // pause/freeze/dry-run) and returns "live" for an unconfigured repo, so without this the re-close would
  // genuinely reach GitHub on a repo that never authorized the close action specifically (#review-audit).
  const closeAutonomy = resolveAutonomy(reopenSettings.autonomy, "close");
  if (closeAutonomy !== "auto") {
    await recordAuditEvent(env, {
      eventType: "github_app.reopen_reclosed",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail:
        closeAutonomy === "auto_with_approval"
          ? `close autonomy requires approval -- reopen re-close not enforced for ${reopener}`
          : `autonomy for close is not acting -- reopen re-close not enforced for ${reopener}`,
      metadata: { deliveryId, repoFullName },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return false;
  }
  const reopenMode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, reopenSettings.agentGlobalFreezeOverride)),
    agentPaused: reopenSettings.agentPaused,
    agentDryRun: reopenSettings.agentDryRun,
  });
  if (reopenMode !== "live") {
    await recordAuditEvent(env, {
      eventType: "github_app.reopen_reclosed",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: reopenMode === "dry_run" ? "completed" : "denied",
      detail: `${reopenMode === "dry_run" ? "dry-run: would re-close" : `skipped (agent ${reopenMode}): would re-close`} a disallowed reopen by ${reopener}`,
      metadata: { deliveryId, repoFullName, mode: reopenMode },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return true; // handled (decision made); never falls through to act on a stood-down repo
  }
  // Live re-check (#2130): the maintainer-permission lookup, getLastCloserLogin's timeline read, and
  // resolveRepositorySettings/isGlobalAgentFrozen above leave a window where the PR's live state could have
  // moved — e.g. a maintainer re-closes it themselves, or reopens it a second time with real authorization —
  // before this fires. Mirrors the draft-dodge sibling's identical fix; re-verify immediately before the mutation.
  const reopenFreshness = await fetchPullRequestFreshness(env, {
    installationId,
    repoFullName,
    pullNumber: pr.number,
    expectedHeadSha: pr.headSha,
  });
  if (reopenFreshness.status !== "current") {
    await recordAuditEvent(env, {
      eventType: "github_app.reopen_reclosed",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: `${pullRequestFreshnessDetail(reopenFreshness)} — reopen re-close not executed`,
      metadata: { deliveryId, repoFullName },
    }).catch(() => undefined);
    return true; // handled (decision made); a stale re-check still counts as handled, not a fallthrough
  }
  // Head/state freshness alone can't see a permission grant: the SAME reopener could be promoted to a
  // maintainer/admin/write collaborator (or added as one) in the window since the check above ran, which
  // would authorize exactly the reopen this handler is about to undo. Re-verify immediately before the
  // mutation, not just once at ingestion time.
  if (await hasMaintainerPermission(reopener)) {
    await recordAuditEvent(env, {
      eventType: "github_app.reopen_reclosed",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: `${reopener} now holds maintainer permission — reopen re-close not executed`,
      metadata: { deliveryId, repoFullName },
    }).catch(() => undefined);
    return true; // handled (decision made); a newly-authorized reopener still counts as handled
  }
  // Live re-check #3 (#2369): head/state freshness and the reopener's OWN permission are not the only things that
  // can move in the window before this fires — a DIFFERENT person (e.g. an actual maintainer) can reopen the SAME
  // PR again after the original disallowed reopen, which is a legitimate, authorized reopen. Since the PR was
  // already open, that second reopen doesn't change head/state, so checks #1/#2 above cannot see it. Ask directly:
  // is `reopener` STILL the most recent "reopened" actor on this PR's timeline? If someone else's reopen is now the
  // live reason the PR is open, re-closing it would wrongly undo that person's authorized action.
  const latestReopener = await getLastReopenerLogin(
    env,
    installationId,
    repoFullName,
    pr.number,
  );
  const latestReopenerLogin = latestReopener.login?.toLowerCase() ?? null;
  // A bounded scan that did NOT cover every page and found no reopened event is attacker-controllable: padding can
  // hide either the original contributor reopen or a later maintainer-authorized reopen. If the current reopener is
  // not visible and confirmed to still be the webhook sender, fail safe by denying the GitHub write. (#2369)
  const reopenerSuperseded = latestReopener.errored || latestReopenerLogin !== reopener;
  if (reopenerSuperseded) {
    await recordAuditEvent(env, {
      eventType: "github_app.reopen_reclosed",
      actor: "gittensory",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: latestReopener.errored
        ? `could not confirm ${reopener} is still the most recent reopener (timeline read failed) — reopen re-close not executed`
        : `the current reopener is now ${latestReopenerLogin ?? "unknown"}, not ${reopener} — reopen re-close not executed`,
      metadata: { deliveryId, repoFullName },
    }).catch(() => undefined);
    return true; // handled (decision made); a confirmed superseding reopener still counts as handled
  }
  // The comment is a courtesy notice; its failure must not mask whether the close itself succeeded (below).
  await createIssueComment(
    env,
    installationId,
    repoFullName,
    pr.number,
    "This pull request was closed by Gittensory and can't be reopened — reviews are one-shot. Please open a new pull request with the issues resolved.",
  ).catch(() => undefined);
  // #2260: the audit outcome must reflect whether the close actually happened on GitHub, not just whether this
  // handler ran. A swallowed 403/404/5xx here previously still recorded outcome:"completed", so an operator
  // trusting the audit trail believed a one-shot close was enforced when it may not have been.
  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  const originallyClosedBy = closer ?? "Gittensory (close beyond the inspected event window)";
  await recordAuditEvent(env, {
    eventType: "github_app.reopen_reclosed",
    actor: "gittensory",
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: closeError === null ? "completed" : "error",
    detail:
      closeError === null
        ? `re-closed a disallowed reopen by ${reopener} (originally closed by ${originallyClosedBy}) — one-shot; resubmit a new PR`
        : `FAILED to re-close a disallowed reopen by ${reopener} (originally closed by ${originallyClosedBy}) — the close API call did not succeed; the PR may still be open`,
    metadata: closeError === null ? { deliveryId, repoFullName } : { deliveryId, repoFullName, error: errorMessage(closeError) },
  }).catch(() => undefined);
  return true;
}

// Audit eventType for every review-evasion enforcement outcome (#review-evasion-protection). Shared by both
// the self-close and converted_to_draft evasion handlers below so a cross-repo query can scope to exactly
// this family, mirroring github_app.draft_dodge_closed / github_app.reopen_reclosed.
const REVIEW_EVASION_CLOSED_EVENT_TYPE = "github_app.review_evasion_closed";

// Whether `login` holds a maintainer-equivalent permission on repoFullName -- the owner, an ADMIN_GITHUB_LOGINS
// entry, or a collaborator with admin/maintain/write access. Shared by both review-evasion guards below;
// mirrors recloseDisallowedReopenIfNeeded's identical `hasMaintainerPermission` closure (kept as a standalone
// function here since the two guards below do not share an enclosing scope to close over).
async function hasMaintainerOrOwnerPermission(env: Env, installationId: number, repoFullName: string, login: string): Promise<boolean> {
  // The ": \"\"" fallback is unreachable via the real webhook path: repoFullName is always the
  // "owner/repo"-formatted payload.repository.full_name, and the surrounding pipeline already requires a
  // repository match on that exact format before any review-evasion handler runs.
  /* v8 ignore next */
  const repoOwner = repoFullName.includes("/") ? repoFullName.slice(0, repoFullName.indexOf("/")).toLowerCase() : "";
  if (login === repoOwner || parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(login)) return true;
  const permission = await getRepositoryCollaboratorPermission(env, installationId, repoFullName, login).catch(() => null);
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/** Review-evasion protection (#review-evasion-protection): a CONTRIBUTOR closing their OWN PR while
 *  gittensory has an ACTIVE review pass running against its current headSha is dodging the one-shot review,
 *  not making an ordinary close. GitHub lets a contributor reopen a PR they closed themselves but NOT one
 *  closed by a maintainer or the App (#one-shot-reopen) -- so this reopens the PR (as the App) and
 *  immediately re-closes it (as the App), converting the contributor's own close into an App-authored,
 *  terminal one they cannot reopen; any later reopen attempt is caught by the EXISTING
 *  maybeRecloseDisallowedReopen guard above. Per-PR actuation-locked like its draft-dodge/reopen-reclose
 *  siblings. The strike only counts once the enforcement close actually succeeds. */
async function maybeCloseReviewEvasionSelfClose(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  const actuationLock = await claimPrActuationLock(env, repoFullName, pr.number);
  if (!actuationLock.acquired) {
    throw new PrActuationLockContendedError(repoFullName, pr.number, "review-evasion-self-close");
  }
  try {
    await closeReviewEvasionSelfCloseIfActive(env, deliveryId, installationId, repoFullName, pr, payload, settings);
  } finally {
    await releasePrActuationLock(env, repoFullName, pr.number, actuationLock.ownerToken);
  }
}

async function closeReviewEvasionSelfCloseIfActive(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  if (settings.reviewEvasionProtection === "off") return; // #4011: default-ON -- only the explicit opt-out bails
  const closer = (payload.sender?.login ?? "").toLowerCase();
  const authorLogin = (pr.authorLogin ?? "").toLowerCase();
  // Only the PR's OWN author closing their OWN PR is a self-close-evasion candidate -- a third party (e.g. a
  // maintainer) closing someone else's PR is an ordinary maintainer action, not evasion.
  if (!closer || !authorLogin || closer !== authorLogin) return;
  if (isProtectedAutomationAuthor(pr.authorLogin)) return;
  if (!pr.headSha) return;
  if (await hasMaintainerOrOwnerPermission(env, installationId, repoFullName, authorLogin)) return;
  if (!(await hasActiveReviewForHeadSha(env, repoFullName, pr.number, pr.headSha))) return;

  const targetKey = `${repoFullName}#${pr.number}`;
  const evasionMode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const closeAutonomy = resolveAutonomy(settings.autonomy, "close");
  if (closeAutonomy !== "auto") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail:
        closeAutonomy === "auto_with_approval"
          ? `close autonomy requires approval -- review-evasion self-close not enforced for ${pr.authorLogin}`
          : `autonomy for close is not acting -- review-evasion self-close not enforced for ${pr.authorLogin}`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  if (evasionMode === "dry_run") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "completed",
      detail: `dry-run: would reopen + re-close review-evasion self-close by ${pr.authorLogin} -- active review on headSha ${pr.headSha}`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, mode: "dry_run" },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  if (evasionMode !== "live") {
    // paused/frozen -- a complete stop, matching the draft-dodge/reopen-reclose siblings' identical gate.
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `agent actions paused -- review-evasion self-close not enforced for ${pr.authorLogin}`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  // Write-permission readiness (#2134-style): this enforcement bypasses executeAgentMaintenanceActions
  // entirely (like its draft-dodge/reopen-reclose siblings), so it never got the standard pipeline's
  // PR_WRITE_CLASSES guard.
  const installation = await getInstallation(env, installationId);
  const installationPermissions = installation?.permissions ?? null;
  if (resolveAgentPermissionReadiness({ autonomy: settings.autonomy, installationPermissions, actionClass: "close" }) !== "ready") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `denied review-evasion enforcement for ${pr.authorLogin} -- pull_requests: write not granted`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  // Live re-check (#2130-style): the PR's live head may have moved since the webhook was ingested.
  // A legitimate self-close webhook is already closed by definition, so allow that one stale reason only
  // when GitHub still reports the same head SHA we started reviewing; every other stale result means the
  // enforcement justification no longer matches the live PR.
  const freshness = await fetchPullRequestFreshness(env, { installationId, repoFullName, pullNumber: pr.number, expectedHeadSha: pr.headSha });
  const sameHeadSelfClosed =
    freshness.status === "stale" &&
    freshness.reason === "closed" &&
    freshness.liveHeadSha !== null &&
    freshness.liveHeadSha.toLowerCase() === pr.headSha.toLowerCase();
  if (freshness.status !== "current" && !sameHeadSelfClosed) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `${pullRequestFreshnessDetail(freshness)} -- review-evasion enforcement not executed`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }

  const reopenError = await reopenPullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (reopenError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "error",
      detail: `FAILED to reopen ${pr.authorLogin}'s self-close for review-evasion enforcement -- the reopen API call did not succeed`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, error: errorMessage(reopenError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return; // the strike only counts once the enforcement close actually succeeds.
  }
  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (closeError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "error",
      detail: `FAILED to re-close review-evasion self-close by ${pr.authorLogin} -- the reopen already succeeded, so the PR is live on GitHub as OPEN; retrying via the queue rather than leaving it that way`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, error: errorMessage(closeError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    // Deliberately UNCAUGHT: the reopen above already succeeded, so returning normally here would silently
    // leave the PR OPEN on GitHub -- worse than the contributor's original close, and the whole point of
    // this enforcement. Propagate so the queue's own retry/backoff re-processes this job; on retry, the live
    // freshness check earlier in this function will see the PR as open (current, since we just reopened it)
    // and this handler will attempt the re-close again, converging once closePullRequest actually succeeds.
    // The `else` (closeError NOT an Error, falling through to the normalization below) is unreachable in
    // practice -- closePullRequest's only failure path is Octokit's `request()` call, which always rejects
    // with a RequestError (an Error subclass), never a raw thrown value -- but `closeError` is typed
    // `unknown`, so the fallback below stays as a type-safe normalization. The `if` body itself (the real
    // rethrow) IS reachable and IS exercised by the existing re-close-failure tests -- only the else branch
    // (this `if`'s implicit non-Error path) and the fallback statement below are ignored. Concretely: a 500
    // from GitHub on the re-close PATCH makes closePullRequest reject with a RequestError, which is exactly
    // what test/unit/queue.test.ts's "REGRESSION (gate-flagged): a retry after the re-close failure
    // converges -- the PR ends up closed, and the strike is recorded exactly once" drives through this `if`.
    /* v8 ignore else */
    if (closeError instanceof Error) throw closeError;
    /* v8 ignore next -- unreachable, see above. */
    throw new Error(errorMessage(closeError));
  }

  // The close succeeded: post the public explanation, apply the configured label, record the strike -- in
  // that order, after the enforcement close is confirmed (never before).
  const shouldPostSelfCloseComment = settings.reviewEvasionComment ?? true;
  if (shouldPostSelfCloseComment) {
    await createIssueComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      "Gittensory had already started reviewing this pull request — closing it to dodge the one-shot review process is not allowed. Please open a new pull request with the issues addressed.",
    ).catch(
      /* v8 ignore next -- fail-safe: a courtesy-comment failure never blocks the handler. */
      () => undefined,
    );
  }
  const label = settings.reviewEvasionLabel === null ? null : (settings.reviewEvasionLabel ?? DEFAULT_REVIEW_EVASION_LABEL);
  if (label !== null) {
    await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, label, { createMissingLabel: true }).catch(() => undefined);
  }
  await recordAuditEvent(env, {
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    actor: "gittensory",
    targetKey,
    outcome: "completed",
    detail: `re-closed a review-evasion self-close by ${pr.authorLogin} -- active review on headSha ${pr.headSha} was in progress`,
    metadata: { deliveryId, repoFullName, headSha: pr.headSha },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
    () => undefined,
  );
  await terminalizeActiveReviewTracking(env, repoFullName, pr.number, { onlyIfHeadSha: pr.headSha }).catch(() => undefined);
  // unreachable implicit-else: the actor guard above already proved pr.authorLogin is a non-empty string
  // (closer/authorLogin are both derived from it and must be truthy to reach this point); the check only
  // exists to narrow the type for applyModerationEscalationForRule's non-nullable authorLogin param.
  /* v8 ignore else */
  if (pr.authorLogin) {
    await applyModerationEscalationForRule(env, {
      installationId,
      repoFullName,
      number: pr.number,
      authorLogin: pr.authorLogin,
      rule: "review_evasion",
      moderationSettings: {
        moderationGateMode: settings.moderationGateMode,
        moderationRules: settings.moderationRules,
        moderationWarningLabel: settings.moderationWarningLabel,
        moderationBannedLabel: settings.moderationBannedLabel,
      },
    }).catch(
      /* v8 ignore next -- fail-safe: an escalation failure never blocks the (already-completed) close. */
      () => undefined,
    );
  }
}

/** Review-evasion protection (#review-evasion-protection): a contributor converting their OWN OPEN PR to
 *  draft while gittensory has an ACTIVE review pass running against its current headSha is dodging the
 *  one-shot review, distinct from the EXISTING draft-dodge guard above (which only fires after a PRIOR gate
 *  FAILURE on this head). Unlike the self-close sibling, converting to draft never closes the PR on GitHub,
 *  so no reopen step is needed -- a direct close, exactly like the draft-dodge guard's own close step,
 *  suffices. Per-PR actuation-locked like its draft-dodge/reopen-reclose/self-close siblings. */
async function maybeCloseReviewEvasionDraftConversion(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  const actuationLock = await claimPrActuationLock(env, repoFullName, pr.number);
  if (!actuationLock.acquired) {
    throw new PrActuationLockContendedError(repoFullName, pr.number, "review-evasion-draft");
  }
  try {
    await closeReviewEvasionDraftConversionIfActive(env, deliveryId, installationId, repoFullName, pr, payload, settings);
  } finally {
    await releasePrActuationLock(env, repoFullName, pr.number, actuationLock.ownerToken);
  }
}

async function closeReviewEvasionDraftConversionIfActive(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  if (settings.reviewEvasionProtection === "off") return; // #4011: default-ON -- only the explicit opt-out bails
  const converter = (payload.sender?.login ?? "").toLowerCase();
  const authorLogin = (pr.authorLogin ?? "").toLowerCase();
  // Only the PR's OWN author converting their OWN PR to draft is a draft-conversion-evasion candidate -- a
  // third party (e.g. a maintainer converting a contributor's PR to draft) is an ordinary maintainer action,
  // not evasion, and must never be enforced against the AUTHOR who didn't do it (mirrors the self-close
  // sibling's identical actor check).
  if (!converter || !authorLogin || converter !== authorLogin) return;
  if (isProtectedAutomationAuthor(pr.authorLogin)) return;
  if (!pr.headSha) return;
  if (await hasMaintainerOrOwnerPermission(env, installationId, repoFullName, authorLogin)) return;
  if (!(await hasActiveReviewForHeadSha(env, repoFullName, pr.number, pr.headSha))) return;

  const targetKey = `${repoFullName}#${pr.number}`;
  const evasionMode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const closeAutonomy = resolveAutonomy(settings.autonomy, "close");
  if (closeAutonomy !== "auto") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail:
        closeAutonomy === "auto_with_approval"
          ? `close autonomy requires approval -- review-evasion draft-conversion not enforced for ${pr.authorLogin}`
          : `autonomy for close is not acting -- review-evasion draft-conversion not enforced for ${pr.authorLogin}`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  if (evasionMode === "dry_run") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "completed",
      detail: `dry-run: would close review-evasion draft-conversion by ${pr.authorLogin} -- active review on headSha ${pr.headSha}`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, mode: "dry_run" },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  if (evasionMode !== "live") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `agent actions paused -- review-evasion draft-conversion not enforced for ${pr.authorLogin}`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  const installation = await getInstallation(env, installationId);
  const installationPermissions = installation?.permissions ?? null;
  if (resolveAgentPermissionReadiness({ autonomy: settings.autonomy, installationPermissions, actionClass: "close" }) !== "ready") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `denied review-evasion enforcement for ${pr.authorLogin} -- pull_requests: write not granted`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  // requireDraft: the justification evaporates if the author converted the PR BACK to ready_for_review in
  // the window between ingestion and this check, mirroring the draft-dodge guard's identical fix (#2130).
  const freshness = await fetchPullRequestFreshness(env, { installationId, repoFullName, pullNumber: pr.number, expectedHeadSha: pr.headSha, requireDraft: true });
  if (freshness.status !== "current") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `${pullRequestFreshnessDetail(freshness)} -- review-evasion enforcement not executed`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }

  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (closeError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "error",
      detail: `FAILED to close review-evasion draft-conversion by ${pr.authorLogin} -- the close API call did not succeed; the PR may still be open`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, error: errorMessage(closeError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return; // the strike only counts once the enforcement close actually succeeds.
  }

  const shouldPostDraftConversionComment = settings.reviewEvasionComment ?? true;
  if (shouldPostDraftConversionComment) {
    await createIssueComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      "Gittensory had already started reviewing this pull request — converting it to draft to dodge the one-shot review process is not allowed. Please open a new pull request with the issues addressed.",
    ).catch(
      /* v8 ignore next -- fail-safe: a courtesy-comment failure never blocks the handler. */
      () => undefined,
    );
  }
  const label = settings.reviewEvasionLabel === null ? null : (settings.reviewEvasionLabel ?? DEFAULT_REVIEW_EVASION_LABEL);
  if (label !== null) {
    await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, label, { createMissingLabel: true }).catch(() => undefined);
  }
  await recordAuditEvent(env, {
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    actor: "gittensory",
    targetKey,
    outcome: "completed",
    detail: `closed a review-evasion draft-conversion by ${pr.authorLogin} -- active review on headSha ${pr.headSha} was in progress`,
    metadata: { deliveryId, repoFullName, headSha: pr.headSha },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
    () => undefined,
  );
  await terminalizeActiveReviewTracking(env, repoFullName, pr.number, { onlyIfHeadSha: pr.headSha }).catch(() => undefined);
  // unreachable implicit-else: the actor guard above already proved pr.authorLogin is a non-empty string
  // (converter/authorLogin are both derived from it and must be truthy to reach this point); the check only
  // exists to narrow the type for applyModerationEscalationForRule's non-nullable authorLogin param.
  /* v8 ignore else */
  if (pr.authorLogin) {
    await applyModerationEscalationForRule(env, {
      installationId,
      repoFullName,
      number: pr.number,
      authorLogin: pr.authorLogin,
      rule: "review_evasion",
      moderationSettings: {
        moderationGateMode: settings.moderationGateMode,
        moderationRules: settings.moderationRules,
        moderationWarningLabel: settings.moderationWarningLabel,
        moderationBannedLabel: settings.moderationBannedLabel,
      },
    }).catch(
      /* v8 ignore next -- fail-safe: an escalation failure never blocks the (already-completed) close. */
      () => undefined,
    );
  }
}

/** Review-evasion protection (#gaming-tactic-draft-cycle): a contributor who converts their OWN PR to draft
 *  more than once is using draft state as a repeated shield to harvest AI-review/CI feedback for free while
 *  dodging the one-shot disposition -- distinct from the two EXISTING draft guards above, which key off a
 *  SPECIFIC head's review/gate state (an active pass, or a prior recorded gate failure) and can both be
 *  legitimately absent on a fast cycle (e.g. converting to draft before either has recorded anything for the
 *  new head at all). This guard instead keys purely on REPETITION: the second (and every later) ready->draft
 *  conversion on the same PR is enforced regardless of the current review/gate state, since the pattern
 *  itself -- not any one head's verdict -- is the abuse signal. A single, first-time draft conversion is
 *  never enforced here (ordinary WIP behavior). Per-PR actuation-locked like its siblings. */
async function maybeCloseRepeatedDraftCycling(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
  draftConversionCount: number,
): Promise<void> {
  // Checked BEFORE claiming the actuation lock (unlike the two sibling guards above): this guard only ever
  // fires on the >=2nd author-driven conversion of a `reviewEvasionProtection: close` repo, which is rare -- an
  // unconditional lock claim on every converted_to_draft webhook would add avoidable contention with the two
  // siblings above on every repo that never enabled this feature, or on every first-time conversion.
  if (settings.reviewEvasionProtection === "off") return; // #4011: default-ON -- only the explicit opt-out bails
  if (draftConversionCount < 2) return;
  const actuationLock = await claimPrActuationLock(env, repoFullName, pr.number);
  if (!actuationLock.acquired) {
    throw new PrActuationLockContendedError(repoFullName, pr.number, "review-evasion-draft-cycle");
  }
  try {
    await closeRepeatedDraftCyclingIfDetected(env, deliveryId, installationId, repoFullName, pr, payload, settings, draftConversionCount);
  } finally {
    await releasePrActuationLock(env, repoFullName, pr.number, actuationLock.ownerToken);
  }
}

async function closeRepeatedDraftCyclingIfDetected(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
  draftConversionCount: number,
): Promise<void> {
  // Defense-in-depth (mirrors the two sibling guards' identical actor check): the call site already only ever
  // increments draftConversionCount -- and therefore only ever reaches draftConversionCount >= 2 -- when THIS
  // SAME payload's sender matches the PR's author (both non-empty), so neither `?? ""` fallback below can
  // actually trigger and the guard below can never actually return here today. Kept anyway so a future call
  // site added without that same pre-filter can't silently enforce against the wrong (or a blank) actor.
  /* v8 ignore next -- unreachable given the call site's own author-only increment guarantee; see comment above. */
  const authorLogin = (pr.authorLogin ?? "").toLowerCase();
  /* v8 ignore next -- unreachable given the call site's own author-only increment guarantee; see comment above. */
  const converter = (payload.sender?.login ?? "").toLowerCase();
  /* v8 ignore next -- unreachable given the call site's own author-only increment guarantee; see comment above. */
  if (!converter || !authorLogin || converter !== authorLogin) return;
  if (isProtectedAutomationAuthor(pr.authorLogin)) return;
  if (!pr.headSha) return;
  if (await hasMaintainerOrOwnerPermission(env, installationId, repoFullName, authorLogin)) return;

  const targetKey = `${repoFullName}#${pr.number}`;
  const evasionMode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const closeAutonomy = resolveAutonomy(settings.autonomy, "close");
  if (closeAutonomy !== "auto") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail:
        closeAutonomy === "auto_with_approval"
          ? `close autonomy requires approval -- repeated draft-cycling not enforced for ${pr.authorLogin} (conversion #${draftConversionCount})`
          : `autonomy for close is not acting -- repeated draft-cycling not enforced for ${pr.authorLogin} (conversion #${draftConversionCount})`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  if (evasionMode === "dry_run") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "completed",
      detail: `dry-run: would close repeated draft-cycling by ${pr.authorLogin} -- conversion #${draftConversionCount}`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, mode: "dry_run", draftConversionCount },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  if (evasionMode !== "live") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `agent actions paused -- repeated draft-cycling not enforced for ${pr.authorLogin} (conversion #${draftConversionCount})`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  const installation = await getInstallation(env, installationId);
  const installationPermissions = installation?.permissions ?? null;
  if (resolveAgentPermissionReadiness({ autonomy: settings.autonomy, installationPermissions, actionClass: "close" }) !== "ready") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `denied repeated-draft-cycling enforcement for ${pr.authorLogin} -- pull_requests: write not granted`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }
  // requireDraft: the justification evaporates if the author converted the PR BACK to ready_for_review in the
  // window between ingestion and this check, mirroring the two sibling guards' identical fix (#2130). A PR
  // already closed moments ago by one of the sibling guards also fails this (status !== "current"), so it is
  // never redundantly re-closed here.
  const freshness = await fetchPullRequestFreshness(env, { installationId, repoFullName, pullNumber: pr.number, expectedHeadSha: pr.headSha, requireDraft: true });
  if (freshness.status !== "current") {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `${pullRequestFreshnessDetail(freshness)} -- repeated-draft-cycling enforcement not executed`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return;
  }

  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (closeError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "gittensory",
      targetKey,
      outcome: "error",
      detail: `FAILED to close repeated draft-cycling by ${pr.authorLogin} -- the close API call did not succeed; the PR may still be open`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount, error: errorMessage(closeError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return; // the strike only counts once the enforcement close actually succeeds.
  }

  const shouldPostComment = settings.reviewEvasionComment ?? true;
  if (shouldPostComment) {
    await createIssueComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      `Gittensory detected this pull request has been converted to draft ${draftConversionCount} times — repeatedly cycling between ready and draft to solicit review feedback without a real one-shot attempt is not allowed. Please open a new pull request with the issues addressed.`,
    ).catch(
      /* v8 ignore next -- fail-safe: a courtesy-comment failure never blocks the handler. */
      () => undefined,
    );
  }
  const label = settings.reviewEvasionLabel === null ? null : (settings.reviewEvasionLabel ?? DEFAULT_REVIEW_EVASION_LABEL);
  if (label !== null) {
    await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, label, { createMissingLabel: true }).catch(() => undefined);
  }
  await recordAuditEvent(env, {
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    actor: "gittensory",
    targetKey,
    outcome: "completed",
    detail: `closed repeated draft-cycling by ${pr.authorLogin} -- conversion #${draftConversionCount} on this PR`,
    metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
    () => undefined,
  );
  await terminalizeActiveReviewTracking(env, repoFullName, pr.number, { onlyIfHeadSha: pr.headSha }).catch(() => undefined);
  // unreachable implicit-else: the actor guard above already proved pr.authorLogin is a non-empty string
  // (converter/authorLogin are both derived from it and must be truthy to reach this point); the check only
  // exists to narrow the type for applyModerationEscalationForRule's non-nullable authorLogin param.
  /* v8 ignore else */
  if (pr.authorLogin) {
    await applyModerationEscalationForRule(env, {
      installationId,
      repoFullName,
      number: pr.number,
      authorLogin: pr.authorLogin,
      rule: "review_evasion",
      moderationSettings: {
        moderationGateMode: settings.moderationGateMode,
        moderationRules: settings.moderationRules,
        moderationWarningLabel: settings.moderationWarningLabel,
        moderationBannedLabel: settings.moderationBannedLabel,
      },
    }).catch(
      /* v8 ignore next -- fail-safe: an escalation failure never blocks the (already-completed) close. */
      () => undefined,
    );
  }
}

// Audit eventType for one recorded @gittensory ping (#2463). Shared between the recorder below and the
// cooldown-window count query so a naming drift can't silently under/over-count.
const REVIEW_NAG_PING_EVENT_TYPE = "github_app.review_nag_ping";

/**
 * Review-request nagging cooldown (#2463, anti-abuse): throttle a thread's OWN author repeatedly pinging
 * @gittensory for review. Runs BEFORE maybeProcessGittensoryMentionCommand below so a throttled ping
 * short-circuits ahead of the normal answer-card dispatch — under the threshold this just records the ping
 * (still tagged with the THIS thread's own targetKey, so a per-thread audit trail is preserved) and falls
 * through unchanged; only crossing the threshold applies the repo's configured policy.
 *
 * The running count is scoped to the ACTOR across the WHOLE repo (#review-nag-cross-pr-carryover), not to one
 * `targetKey` — a contributor who exhausts their pings on PR A and opens a fresh PR B carries the count over
 * instead of resetting to a clean 0/maxPings slate, mirroring how the contributor blacklist and moderation-rules
 * ban tally already persist by login rather than by thread. This also makes enforcement immediate rather than
 * merely cumulative: because the count already reflects every prior target, the very FIRST ping on PR B can
 * already cross `maxPings` on its own — there's no need for a separate "still on cooldown" table, since the
 * audit-events ledger read at the new repo scope already IS that persistent per-actor state.
 *
 * Deliberately scoped to the THREAD'S OWN author (`issue.user.login === commenter`): a third party pinging on
 * someone else's PR/issue must never throttle or close the AUTHOR's unrelated work — this mirrors the standing
 * "never punish someone for another actor's behavior" rule the blacklist/contributor-cap features already
 * follow. Off (`reviewNagPolicy: "off"`, the default) is a complete no-op — no audit writes, no reads beyond
 * the settings resolve.
 */
async function maybeThrottleReviewNagPing(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  // Only a NEWLY-created comment counts as a ping (mirrors maybeProcessGittensoryMentionCommand) — an edited
  // or deleted comment must not re-count or double-count.
  if (payload.action !== "created") return false;
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command) return false; // not an @gittensory mention at all
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const commenter = payload.comment?.user?.login;
  if (!repoFullName || !issue || !installationId || !commenter) return false;
  if (payload.comment?.user?.type === "Bot" || /\[bot\]$/i.test(commenter)) return false;

  const settings = await resolveRepositorySettings(env, repoFullName);
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete "off"/"hold"/"close" (NOT NULL DEFAULT 'off'); the undefined side is defensive against the field's optional TS type. */
  const policy = settings.reviewNagPolicy ?? "off";
  if (policy === "off") return false;

  const threadAuthor = issue.user?.login;
  if (!threadAuthor || commenter.toLowerCase() !== threadAuthor.toLowerCase()) return false;

  // repoFullName is always "owner/repo" for a real GitHub webhook; the empty-owner fallback only guards a
  // malformed/synthetic payload from ever matching an empty commenter login as "the owner".
  const repoOwner = repoFullName.includes("/") ? repoFullName.slice(0, repoFullName.indexOf("/")) : "";
  if (commenter.toLowerCase() === repoOwner.toLowerCase()) return false;
  if (parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(commenter.toLowerCase())) return false;
  // NOTE: no separate isProtectedAutomationAuthor(commenter) check here — every entry in that set (e.g.
  // "dependabot[bot]") already ends in "[bot]" and was rejected by the bot-suffix guard above, so it would be
  // unreachable dead code at this point (unlike the PR-webhook maintenance path, which checks a PR's stored
  // author rather than a live comment author already filtered for bot-ness).
  if (isAutoCloseExempt(commenter, settings.autoCloseExemptLogins)) return false;

  const targetKey = `${repoFullName}#${issue.number}`;
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer (NOT NULL DEFAULT 3); the undefined side is defensive against the field's optional TS type. */
  const maxPings = settings.reviewNagMaxPings ?? 3;
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer (NOT NULL DEFAULT 5); the undefined side is defensive against the field's optional TS type. */
  const cooldownDays = Math.min(settings.reviewNagCooldownDays ?? 5, MAX_REVIEW_NAG_COOLDOWN_DAYS);
  const sinceIso = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString();
  // Repo-wide, not per-target (#review-nag-cross-pr-carryover): counts every @gittensory ping this actor has
  // sent anywhere in this repo within the window, so exhausting the budget on PR A already shows up on PR B's
  // very first ping instead of restarting at 0/maxPings just because the targetKey (issue.number) is new.
  const priorPings = await countRecentAuditEventsForActorInRepo(env, commenter, REVIEW_NAG_PING_EVENT_TYPE, repoFullName, sinceIso);
  const pingCount = priorPings + 1; // this ping counts too

  // Always record the ping first so the running count reflects reality even when the rest of this handler
  // short-circuits below (a failed recordAuditEvent must never block the mention-command fallthrough).
  await recordAuditEvent(env, {
    eventType: REVIEW_NAG_PING_EVENT_TYPE,
    actor: commenter,
    targetKey,
    outcome: "completed",
    detail: `ping ${pingCount}/${maxPings} within ${cooldownDays}d window`,
    metadata: { deliveryId, repoFullName },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the mention-command fallthrough */
    () => undefined,
  );

  if (pingCount <= maxPings) return false; // under threshold — normal command processing proceeds unchanged

  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });

  // "close" only ever applies to a PR thread — an issue thread has no closeIssue primitive yet (tracked
  // separately), so it degrades to "hold" with a comment explaining the v1 limit.
  if (policy === "hold" || !issue.pull_request) {
    if (mode === "live") {
      await createIssueComment(
        env,
        installationId,
        repoFullName,
        issue.number,
        `@${commenter} this thread has reached the review-request cooldown limit (${maxPings} pings within ${cooldownDays} days). Please wait for the cooldown window to pass before pinging @gittensory again. This is an automated maintenance action.`,
      ).catch(
        /* v8 ignore next -- fail-safe: a comment-post failure must not crash the throttle decision itself */
        () => undefined,
      );
    }
    await recordAuditEvent(env, {
      eventType: "github_app.review_nag_cooldown_applied",
      actor: "gittensory",
      targetKey,
      outcome: mode === "live" ? "completed" : "denied",
      detail: `hold applied: ${commenter} pinged ${pingCount} times (limit ${maxPings})`,
      metadata: { deliveryId, repoFullName, mode, policy },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return true; // short-circuit — skip the normal @gittensory command dispatch
  }

  // policy === "close" on a PR thread: build the deterministic label+close plan through the SAME planner/
  // executor gate stack (autonomy/dry-run/kill-switch/write-permission) as every other agent-driven mutation.
  const pr = await getPullRequest(env, repoFullName, issue.number);
  if (!pr || pr.state !== "open") return false; // nothing left to close — fall through harmlessly

  const planned = planAgentMaintenanceActions({
    conclusion: "skipped",
    blockerTitles: [],
    autonomy: settings.autonomy,
    changedPaths: [],
    hardGuardrailGlobs: [],
    authorIsOwner: false,
    authorIsAdmin: false,
    authorIsAutomationBot: false,
    ciState: "unverified",
    reviewNagMatch: { matched: true, authorLogin: commenter, pingCount, maxPings },
    // planAgentMaintenanceActions applies its own DEFAULT_REVIEW_NAG_LABEL fallback for an absent label —
    // mirrors how blacklistLabel is threaded straight through without a second fallback layer here.
    reviewNagLabel: settings.reviewNagLabel,
    pr: { labels: pr.labels, headSha: pr.headSha },
  });
  if (planned.length === 0) {
    // Autonomy is not currently acting for label/close — nothing to execute, but the policy still engaged.
    await recordAuditEvent(env, {
      eventType: "github_app.review_nag_cooldown_applied",
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `close policy engaged but autonomy is not acting for label/close: ${commenter} pinged ${pingCount} times (limit ${maxPings})`,
      metadata: { deliveryId, repoFullName, mode, policy },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return true;
  }

  const installation = await getInstallation(env, installationId);
  await executeAgentMaintenanceActions(
    env,
    {
      installationId,
      repoFullName,
      pullNumber: pr.number,
      headSha: pr.headSha,
      autonomy: settings.autonomy,
      agentPaused: settings.agentPaused,
      agentDryRun: settings.agentDryRun,
      agentGlobalFreezeOverride: settings.agentGlobalFreezeOverride,
      installationPermissions: installation?.permissions ?? null,
      authorLogin: pr.authorLogin,
      moderationSettings: { moderationGateMode: settings.moderationGateMode, moderationRules: settings.moderationRules, moderationWarningLabel: settings.moderationWarningLabel, moderationBannedLabel: settings.moderationBannedLabel },
    },
    planned,
  );
  return true;
}

// Audit eventType for one recorded monitored-mention ping (#label-scoping). Shared between the recorder below
// and the cooldown-window count query so a naming drift can't silently under/over-count.
const MONITORED_MENTION_PING_EVENT_TYPE = "github_app.monitored_mention_ping";

/** Word-boundary, case-insensitive check for `@login` in a comment body — the SAME precision level as
 *  `parseGittensoryMentionCommand`'s own `@gittensory` detection (a literal match, not an intent classifier):
 *  conservative and testable, per the feature's design goal. `login` already survived
 *  `normalizeAutoCloseExemptLogins`'s GitHub-login-format validation, but bot-shaped logins contain `[bot]`;
 *  escape before embedding so every configured login is matched literally. */
function bodyMentionsLogin(body: string, login: string): boolean {
  return new RegExp(`(?:^|\\s)@${escapeRegExp(login)}(?:\\s|$|[^\\w-])`, "i").test(body);
}

/**
 * Maintainer-mention nag moderation (#label-scoping): extends the review-nag cooldown above to ALSO throttle a
 * thread's OWN author repeatedly @-mentioning a CONFIGURED maintainer login (`settings.reviewNagMonitoredMentions`)
 * — e.g. a contributor who keeps tagging a specific maintainer for review/status instead of (or in addition to)
 * pinging `@gittensory`. Reuses the exact same policy/threshold/cooldown/label settings as
 * {@link maybeThrottleReviewNagPing} (one cooldown policy, multiple watched mention targets) and the same
 * thread-author-only scoping + owner/admin/bot/autoCloseExemptLogins exemptions, but counts EACH mentioned login
 * independently (and independently of the `@gittensory` counter) so pinging the bot and pinging a maintainer
 * don't share one budget. Runs regardless of whether the comment also contains an `@gittensory` mention/command
 * — mentioning a maintainer is never a bot command, so this must not gate or interact with command dispatch.
 * Off (`reviewNagMonitoredMentions` empty/absent, the default) is a complete no-op — no extra reads at all.
 *
 * Like {@link maybeThrottleReviewNagPing}, the running count is scoped to the ACTOR across the WHOLE repo
 * (#review-nag-cross-pr-carryover) rather than to one `targetKey`, so exhausting the budget mentioning @maintainer
 * on PR A carries over to PR B instead of resetting. Because a mentioned login's own budget must stay independent
 * of every OTHER monitored login's budget (the "don't share one budget" design above), the repo-wide count is
 * additionally pinned to this one login's `mention:<login>` targetKey suffix via
 * {@link countRecentAuditEventsForActorInRepoWithTargetSuffix} — carryover happens across PRs, never across
 * different mentioned logins.
 */
async function maybeThrottleMonitoredMentions(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  if (payload.action !== "created") return false;
  const body = payload.comment?.body;
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const commenter = payload.comment?.user?.login;
  if (!body || !repoFullName || !issue || !installationId || !commenter) return false;
  if (payload.comment?.user?.type === "Bot" || /\[bot\]$/i.test(commenter)) return false;

  const settings = await resolveRepositorySettings(env, repoFullName);
  const monitoredLogins = settings.reviewNagMonitoredMentions ?? [];
  if (monitoredLogins.length === 0) return false;
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete "off"/"hold"/"close" (NOT NULL DEFAULT 'off'); the undefined side is defensive against the field's optional TS type. */
  const policy = settings.reviewNagPolicy ?? "off";
  if (policy === "off") return false;

  const threadAuthor = issue.user?.login;
  if (!threadAuthor || commenter.toLowerCase() !== threadAuthor.toLowerCase()) return false;

  const repoOwner = repoFullName.includes("/") ? repoFullName.slice(0, repoFullName.indexOf("/")) : "";
  if (commenter.toLowerCase() === repoOwner.toLowerCase()) return false;
  if (parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(commenter.toLowerCase())) return false;
  if (isAutoCloseExempt(commenter, settings.autoCloseExemptLogins)) return false;

  const mentionedLogin = monitoredLogins.find((login) => bodyMentionsLogin(body, login));
  if (!mentionedLogin) return false;

  // The per-login suffix is shared between the full targetKey (below, for the recordAuditEvent audit trail) and
  // the repo-wide count's suffix filter, so a naming drift between the two can never silently under/over-count.
  const mentionTargetSuffix = `mention:${mentionedLogin.toLowerCase()}`;
  const targetKey = `${repoFullName}#${issue.number}#${mentionTargetSuffix}`;
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer (NOT NULL DEFAULT 3); the undefined side is defensive against the field's optional TS type. */
  const maxPings = settings.reviewNagMaxPings ?? 3;
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer (NOT NULL DEFAULT 5); the undefined side is defensive against the field's optional TS type. */
  const cooldownDays = Math.min(settings.reviewNagCooldownDays ?? 5, MAX_REVIEW_NAG_COOLDOWN_DAYS);
  const sinceIso = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString();
  // Repo-wide, not per-target (#review-nag-cross-pr-carryover), but still pinned to THIS mentioned login's own
  // suffix so independently-budgeted mentioned logins never bleed into each other's count.
  const priorPings = await countRecentAuditEventsForActorInRepoWithTargetSuffix(
    env,
    commenter,
    MONITORED_MENTION_PING_EVENT_TYPE,
    repoFullName,
    mentionTargetSuffix,
    sinceIso,
  );
  const pingCount = priorPings + 1;

  await recordAuditEvent(env, {
    eventType: MONITORED_MENTION_PING_EVENT_TYPE,
    actor: commenter,
    targetKey,
    outcome: "completed",
    detail: `ping ${pingCount}/${maxPings} within ${cooldownDays}d window (mentioned @${mentionedLogin})`,
    metadata: { deliveryId, repoFullName, mentionedLogin },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the mention-command fallthrough */
    () => undefined,
  );

  if (pingCount <= maxPings) return false;

  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });

  if (policy === "hold" || !issue.pull_request) {
    if (mode === "live") {
      await createIssueComment(
        env,
        installationId,
        repoFullName,
        issue.number,
        `@${commenter} this thread has reached the review-request cooldown limit for @${mentionedLogin} (${maxPings} pings within ${cooldownDays} days). Please wait for the cooldown window to pass before pinging @${mentionedLogin} again. This is an automated maintenance action.`,
      ).catch(
        /* v8 ignore next -- fail-safe: a comment-post failure must not crash the throttle decision itself */
        () => undefined,
      );
    }
    await recordAuditEvent(env, {
      eventType: "github_app.review_nag_cooldown_applied",
      actor: "gittensory",
      targetKey,
      outcome: mode === "live" ? "completed" : "denied",
      detail: `hold applied: ${commenter} pinged @${mentionedLogin} ${pingCount} times (limit ${maxPings})`,
      metadata: { deliveryId, repoFullName, mode, policy, mentionedLogin },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return true;
  }

  const pr = await getPullRequest(env, repoFullName, issue.number);
  if (!pr || pr.state !== "open") return false;

  const planned = planAgentMaintenanceActions({
    conclusion: "skipped",
    blockerTitles: [],
    autonomy: settings.autonomy,
    changedPaths: [],
    hardGuardrailGlobs: [],
    authorIsOwner: false,
    authorIsAdmin: false,
    authorIsAutomationBot: false,
    ciState: "unverified",
    reviewNagMatch: { matched: true, authorLogin: commenter, pingCount, maxPings },
    reviewNagLabel: settings.reviewNagLabel,
    pr: { labels: pr.labels, headSha: pr.headSha },
  });
  if (planned.length === 0) {
    await recordAuditEvent(env, {
      eventType: "github_app.review_nag_cooldown_applied",
      actor: "gittensory",
      targetKey,
      outcome: "denied",
      detail: `close policy engaged but autonomy is not acting for label/close: ${commenter} pinged @${mentionedLogin} ${pingCount} times (limit ${maxPings})`,
      metadata: { deliveryId, repoFullName, mode, policy, mentionedLogin },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return true;
  }

  const installation = await getInstallation(env, installationId);
  await executeAgentMaintenanceActions(
    env,
    {
      installationId,
      repoFullName,
      pullNumber: pr.number,
      headSha: pr.headSha,
      autonomy: settings.autonomy,
      agentPaused: settings.agentPaused,
      agentDryRun: settings.agentDryRun,
      agentGlobalFreezeOverride: settings.agentGlobalFreezeOverride,
      installationPermissions: installation?.permissions ?? null,
      authorLogin: pr.authorLogin,
      moderationSettings: { moderationGateMode: settings.moderationGateMode, moderationRules: settings.moderationRules, moderationWarningLabel: settings.moderationWarningLabel, moderationBannedLabel: settings.moderationBannedLabel },
    },
    planned,
  );
  return true;
}

// Audit eventType for one recorded @gittensory command invocation (#2560). Shared between the recorder below
// and the cooldown-window count query so a naming drift can't silently under/over-count.
const COMMAND_RATE_LIMIT_EVENT_TYPE = "github_app.command_invocation";
// How far back to look for a redelivered webhook's OWN prior invocation record. Deliberately much shorter
// than the rate-limit window itself (hours) -- a genuine GitHub redelivery lands within seconds/minutes.
const COMMAND_RATE_LIMIT_REDELIVERY_WINDOW_MS = 10 * 60_000;

/**
 * Per-command @gittensory rate limit (#2560, anti-abuse): generalizes review-nag's audit-ledger counting
 * pattern (`countRecentAuditEventsForActorAndTarget`) to EVERY `@gittensory` Q&A command, not just
 * review-request pings. Keyed by `(actor, command, targetKey)` — the command name is folded into targetKey so
 * repeatedly invoking ONE command never counts against a DIFFERENT command's own limit. Independent of, and
 * complementary to, `maybeThrottleReviewNagPing` above: that one stays scoped to the thread's OWN author and
 * can close a PR; this covers ANY authorized actor invoking ANY command and only ever holds (declines with a
 * notice), never closes. Off (`commandRateLimitPolicy: "off"`, the default) is a complete no-op.
 */
async function maybeThrottleGittensoryCommand(
  env: Env,
  args: {
    deliveryId: string;
    repoFullName: string;
    issueNumber: number;
    installationId: number;
    commenter: string;
    command: GittensoryMentionCommandName;
    settings: RepositorySettings;
    mode: ReturnType<typeof resolveAgentActionMode>;
  },
): Promise<boolean> {
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete "off"/"hold"; the undefined side is defensive against the field's optional TS type. */
  const policy = args.settings.commandRateLimitPolicy ?? "off";
  if (policy === "off") return false;

  const targetKey = `${args.repoFullName}#${args.issueNumber}#${args.command}`;

  // Webhook redelivery guard: GitHub can and does redeliver the same issue_comment event (timeout/retry) --
  // without this, a redelivered event would increment the counter a SECOND time for one real invocation and
  // could incorrectly rate-limit it. Scoped to a short recent window (not the full rate-limit window) — a
  // genuine redelivery lands within seconds/minutes, not hours later.
  const redeliverySinceIso = new Date(Date.now() - COMMAND_RATE_LIMIT_REDELIVERY_WINDOW_MS).toISOString();
  const alreadySeen = await hasAuditEventForDelivery(env, args.commenter, COMMAND_RATE_LIMIT_EVENT_TYPE, targetKey, args.deliveryId, redeliverySinceIso);
  // Gate review finding: returning `false` here let a redelivered webhook fall through to normal dispatch — a
  // SECOND run of the (possibly cost-bearing) command for one real invocation, uncounted and unheld. The
  // original delivery already ran the command and posted its own answer, so short-circuit the replay entirely
  // (no dispatch, no comment) rather than treating it as an under-threshold pass-through.
  if (alreadySeen) {
    await recordAuditEvent(env, {
      eventType: "github_app.command_redelivery_suppressed",
      actor: args.commenter,
      targetKey,
      outcome: "completed",
      detail: `redelivered ${args.command} invocation suppressed (deliveryId ${args.deliveryId})`,
      metadata: { deliveryId: args.deliveryId, repoFullName: args.repoFullName, command: args.command },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the redelivery suppression itself */
      () => undefined,
    );
    return true;
  }

  const aiCostBearing = isAiCostBearingCommand(args.command);
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer; the undefined side is defensive against the field's optional TS type. */
  const maxPerWindow = aiCostBearing
    ? (args.settings.commandRateLimitAiMaxPerWindow ?? 5)
    : (args.settings.commandRateLimitMaxPerWindow ?? 20);
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer; the undefined side is defensive against the field's optional TS type. */
  const windowHours = args.settings.commandRateLimitWindowHours ?? 24;
  const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const priorInvocations = await countRecentAuditEventsForActorAndTarget(env, args.commenter, COMMAND_RATE_LIMIT_EVENT_TYPE, targetKey, sinceIso);
  const invocationCount = priorInvocations + 1; // this invocation counts too

  // Always record the invocation first so the running count reflects reality even when the rest of this
  // handler short-circuits below (a failed recordAuditEvent must never block command dispatch).
  await recordAuditEvent(env, {
    eventType: COMMAND_RATE_LIMIT_EVENT_TYPE,
    actor: args.commenter,
    targetKey,
    outcome: "completed",
    detail: `invocation ${invocationCount}/${maxPerWindow} within ${windowHours}h window`,
    metadata: { deliveryId: args.deliveryId, repoFullName: args.repoFullName, command: args.command, aiCostBearing },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks command dispatch */
    () => undefined,
  );

  if (invocationCount <= maxPerWindow) return false; // under threshold — normal dispatch proceeds unchanged

  if (args.mode === "live") {
    await createIssueComment(
      env,
      args.installationId,
      args.repoFullName,
      args.issueNumber,
      `@${args.commenter} the \`${args.command}\` command has reached its rate limit (${maxPerWindow} within ${windowHours}h). Please wait for the window to pass before trying again. This is an automated maintenance action.`,
    ).catch(
      /* v8 ignore next -- fail-safe: a comment-post failure must not crash the throttle decision itself */
      () => undefined,
    );
  }
  await recordAuditEvent(env, {
    eventType: "github_app.command_rate_limit_applied",
    actor: "gittensory",
    targetKey,
    outcome: args.mode === "live" ? "completed" : "denied",
    detail: `hold applied: ${args.commenter} invoked ${args.command} ${invocationCount} times (limit ${maxPerWindow})`,
    metadata: { deliveryId: args.deliveryId, repoFullName: args.repoFullName, mode: args.mode, command: args.command },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
    () => undefined,
  );
  return true;
}

async function maybeProcessGittensoryMentionCommand(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  // Only act on a NEWLY-created comment (mirrors maybeProcessGateOverrideCommand / maybeProcessPlanCommand). Without
  // this an `edited` comment re-runs the agent + rewrites the card, and a `deleted` command still posts an answer
  // card for a command that no longer exists (#review-audit).
  if (payload.action !== "created") return false;
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command) return false;
  // Action commands (gate-override + the #1960 PR control-surface verbs) are handled by their own dispatch
  // earlier in processGitHubWebhook; they never produce a Q&A answer card here. Bail so the rest of this
  // handler narrows to Q&A commands only.
  if (isGittensoryActionCommand(command.name)) return false;
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const commenter = payload.comment?.user?.login;
  const targetKey =
    repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (!repoFullName || !issue || !installationId || !commenter) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_skipped",
      actor: commenter,
      targetKey: repoFullName,
      outcome: "completed",
      detail: "missing_repo_issue_installation_or_actor",
      metadata: { deliveryId, command: command.name },
    });
    await recordAgentCommandUsage(env, {
      repoFullName,
      targetKey,
      actor: commenter,
      command: command.name,
      actorKind: "none",
      outcome: "skipped",
      detail: "missing_repo_issue_installation_or_actor",
    });
    await recordGithubProductUsage(env, "agent_command_skipped", {
      actor: commenter,
      repoFullName,
      targetKey: repoFullName,
      outcome: "skipped",
      metadata: {
        command: command.name,
        reason: "missing_repo_issue_installation_or_actor",
      },
    });
    return true;
  }
  if (payload.comment?.user?.type === "Bot" || /\[bot\]$/i.test(commenter)) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_skipped",
      actor: commenter,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "completed",
      detail: "bot_author",
      metadata: { deliveryId, command: command.name },
    });
    await recordAgentCommandUsage(env, {
      repoFullName,
      targetKey,
      actor: commenter,
      command: command.name,
      actorKind: "none",
      outcome: "skipped",
      detail: "bot_author",
    });
    await recordGithubProductUsage(env, "agent_command_skipped", {
      actor: commenter,
      repoFullName,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "skipped",
      metadata: { command: command.name, reason: "bot_author" },
    });
    return true;
  }
  if (!issue.pull_request) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_skipped",
      actor: commenter,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "completed",
      detail: "not_a_pull_request_thread",
      metadata: { deliveryId, command: command.name },
    });
    await recordAgentCommandUsage(env, {
      repoFullName,
      targetKey,
      actor: commenter,
      command: command.name,
      actorKind: "none",
      outcome: "skipped",
      detail: "not_a_pull_request_thread",
    });
    await recordGithubProductUsage(env, "agent_command_skipped", {
      actor: commenter,
      repoFullName,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "skipped",
      metadata: { command: command.name, reason: "not_a_pull_request_thread" },
    });
    return true;
  }

  // #788 write-safety: authorize @gittensory Q&A maintainer commands by the commenter's REAL repo permission
  // (getRepositoryCollaboratorPermission via resolveRealRepoPermissionAssociation), NOT the spoofable
  // payload.comment.author_association — an org `MEMBER` is not a maintainer of THIS repo. This matches the
  // action-command path (#538) and closes the privilege-escalation hole before write-capable commands (#778).
  const [repo, cachedPullRequest, settings, commenterAssociation] =
    await Promise.all([
      getRepository(env, repoFullName),
      getPullRequest(env, repoFullName, issue.number),
      resolveRepositorySettings(env, repoFullName),
      resolveRealRepoPermissionAssociation(
        env,
        installationId,
        repoFullName,
        commenter,
      ),
    ]);
  // Respect pause/dry-run/global-freeze like every other agent-driven write in this file (#2258) — the answer
  // card is a live public comment post, same as gate-override's confirmation comment.
  const mentionMode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isDbFrozenForRepo(env, settings.agentGlobalFreezeOverride)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const pullRequestAuthor =
    cachedPullRequest?.authorLogin ?? issue.user?.login ?? null;
  const needsMinerDetection = commandAuthorizationNeedsMinerDetection({
    policy: settings.commandAuthorization,
    commandName: command.name,
    commenterLogin: commenter,
    commenterAssociation,
    pullRequestAuthorLogin: pullRequestAuthor,
  });
  const official =
    pullRequestAuthor &&
    (needsMinerDetection || command.name === "miner-context")
      ? await getCachedOfficialMinerDetection(env, pullRequestAuthor, {
          targetKey: `${repoFullName}#${issue.number}`,
          deliveryId,
        })
      : undefined;
  const authorization = isAuthorizedCommandActor({
    commandName: command.name,
    commenterLogin: commenter,
    commenterAssociation,
    pullRequestAuthorLogin: pullRequestAuthor,
    officialAuthorDetection: official,
    commandAuthorizationPolicy: settings.commandAuthorization,
  });
  if (!authorization.authorized) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_skipped",
      actor: commenter,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome:
        authorization.reason === "miner_detection_unavailable"
          ? "error"
          : "completed",
      detail: authorization.reason,
      metadata: {
        deliveryId,
        command: command.name,
        allowedRoles: commandAuthorizationAllowedRoles(
          settings.commandAuthorization,
          command.name,
        ),
      },
    });
    await recordAgentCommandUsage(env, {
      repoFullName,
      targetKey,
      actor: commenter,
      command: command.name,
      actorKind: authorization.actorKind,
      outcome:
        authorization.reason === "miner_detection_unavailable"
          ? "error"
          : "skipped",
      detail: authorization.reason,
    });
    await recordGithubProductUsage(env, "agent_command_skipped", {
      actor: commenter,
      repoFullName,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome:
        authorization.reason === "miner_detection_unavailable"
          ? "error"
          : "skipped",
      metadata: { command: command.name, reason: authorization.reason },
    });
    return true;
  }

  if (
    await maybeThrottleGittensoryCommand(env, {
      deliveryId,
      repoFullName,
      issueNumber: issue.number,
      installationId,
      commenter,
      command: command.name,
      settings,
      mode: mentionMode,
    })
  ) {
    return true;
  }

  const answerId = crypto.randomUUID();
  const login = pullRequestAuthor ?? commenter;
  const maintainerDigest = isMaintainerQueueDigestCommand(command.name)
    ? await buildMaintainerQueueDigestForCommand(env, repo, repoFullName)
    : null;
  const bundle = maintainerDigest
    ? null
    : await buildMentionCommandBundle(
        env,
        command.name,
        {
          login,
          repoFullName,
          issue,
          pullRequest: cachedPullRequest,
        },
        command.question,
      );
  const body = buildPublicAgentCommandComment({
    command,
    repo,
    issue,
    pullRequest: cachedPullRequest,
    actorKind:
      authorization.actorKind === "maintainer" ? "maintainer" : "author",
    answerId,
    officialMiner: official?.status === "confirmed" ? official.snapshot : null,
    bundle,
    maintainerDigest,
  });
  const responseComment = await createOrUpdateAgentCommandComment(
    env,
    installationId,
    repoFullName,
    issue.number,
    body,
    mentionMode,
  );
  await upsertAgentCommandAnswer(env, {
    id: answerId,
    repoFullName,
    issueNumber: issue.number,
    command: command.name,
    requestCommentId: payload.comment?.id ?? null,
    responseCommentId: responseComment?.id ?? null,
    responseUrl: responseComment?.html_url ?? null,
    actorKind:
      authorization.actorKind === "maintainer" ? "maintainer" : "author",
    metadata: {
      publicSurface: "github_comment",
      responseCommentStored: Boolean(responseComment?.id),
    },
  });
  // createOrUpdateAgentCommandComment already suppresses the answer-card post for a non-live mode. As with
  // gate-override above, what must NOT happen unconditionally is recording this as a completed reply: a
  // paused/dry-run mention command never posted the card, so telemetry (and the feedback prompt, which
  // presumes a real reply exists to react to) must reflect that instead of a reply that never happened.
  if (mentionMode === "live") {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_replied",
      actor: commenter,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "completed",
      metadata: {
        deliveryId,
        command: command.name,
        actorKind: authorization.actorKind,
        runId: bundle?.run.id ?? null,
        answerId,
      },
    });
    await recordAgentCommandUsage(env, {
      repoFullName,
      targetKey,
      actor: commenter,
      command: command.name,
      actorKind: authorization.actorKind,
      outcome: "replied",
      detail:
        bundle?.run.status ?? (maintainerDigest ? "maintainer_digest" : "no_run"),
      family: maintainerDigest ? "maintainer_digest" : "agent_command",
      runId: bundle?.run.id ?? null,
    });
    await recordGithubProductUsage(env, "agent_command_replied", {
      actor: commenter,
      repoFullName,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "completed",
      metadata: {
        command: command.name,
        actorKind: authorization.actorKind,
        hasAgentRun: Boolean(bundle),
        family: maintainerDigest ? "queue_digest" : "agent_command",
      },
    });
    await recordAgentCommandFeedbackPrompt(env, {
      deliveryId,
      command: command.name,
      actor: commenter,
      targetKey: `${repoFullName}#${issue.number}`,
      actorKind:
        authorization.actorKind === "maintainer" ? "maintainer" : "author",
      family: maintainerDigest ? "maintainer_digest" : "agent_command",
    });
  } else {
    const reason = mentionMode === "dry_run" ? "dry_run" : "agent_paused";
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_reply_skipped",
      actor: commenter,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "completed",
      detail: reason,
      metadata: {
        deliveryId,
        command: command.name,
        actorKind: authorization.actorKind,
        answerId,
        mode: mentionMode,
      },
    });
    await recordAgentCommandUsage(env, {
      repoFullName,
      targetKey,
      actor: commenter,
      command: command.name,
      actorKind: authorization.actorKind,
      outcome: "skipped",
      detail: reason,
      family: maintainerDigest ? "maintainer_digest" : "agent_command",
      runId: bundle?.run.id ?? null,
    });
    await recordGithubProductUsage(env, "agent_command_reply_skipped", {
      actor: commenter,
      repoFullName,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: "skipped",
      metadata: {
        command: command.name,
        actorKind: authorization.actorKind,
        hasAgentRun: Boolean(bundle),
        family: maintainerDigest ? "queue_digest" : "agent_command",
        mode: mentionMode,
      },
    });
  }
  return true;
}

async function buildMentionCommandBundle(
  env: Env,
  commandName: GittensoryMentionCommandName,
  context: {
    login: string;
    repoFullName: string;
    issue: NonNullable<GitHubWebhookPayload["issue"]>;
    pullRequest: Awaited<ReturnType<typeof getPullRequest>>;
  },
  question?: string | undefined,
) {
  if (commandName === "help" || commandName === "miner-context") return null;
  if (commandName === "blockers")
    return explainBlockersWithAgent(env, {
      login: context.login,
      repoFullName: context.repoFullName,
      surface: "github_comment",
    });
  if (commandName === "preflight" || commandName === "reviewability")
    return preflightBranchWithAgent(
      env,
      buildMentionBranchInput(context),
      "github_comment",
    );
  if (commandName === "packet")
    return preparePrPacketWithAgent(
      env,
      buildMentionBranchInput(context),
      "github_comment",
    );
  return planNextWork(env, {
    login: context.login,
    repoFullName: context.repoFullName,
    surface: "github_comment",
    objective:
      commandName === "ask" && question && question.trim().length > 0
        ? `Respond to @gittensory ask for ${context.repoFullName}#${context.issue.number}. Question: ${question.trim().slice(0, 280)}`
        : `Respond to @gittensory ${commandName} for ${context.repoFullName}#${context.issue.number}.`,
  });
}

function buildMentionBranchInput(context: {
  login: string;
  repoFullName: string;
  issue: NonNullable<GitHubWebhookPayload["issue"]>;
  pullRequest: Awaited<ReturnType<typeof getPullRequest>>;
}): LocalBranchAnalysisInput {
  return {
    login: context.login,
    repoFullName: context.repoFullName,
    branchName: `github-pr-${context.issue.number}`,
    headRef: context.pullRequest?.headRef ?? undefined,
    headSha: context.pullRequest?.headSha ?? undefined,
    title: context.pullRequest?.title ?? context.issue.title,
    body: context.pullRequest?.body ?? undefined,
    labels: context.pullRequest?.labels ?? [],
    linkedIssues: context.pullRequest?.linkedIssues ?? [],
  };
}

async function recordAgentCommandUsage(
  env: Env,
  args: {
    repoFullName?: string | null | undefined;
    targetKey?: string | null | undefined;
    actor?: string | null | undefined;
    command: string;
    actorKind: "maintainer" | "author" | "none";
    outcome: "replied" | "skipped" | "error";
    detail?: string | null | undefined;
    family?: "agent_command" | "maintainer_digest" | undefined;
    runId?: string | null | undefined;
  },
): Promise<void> {
  try {
    const actorHash = args.actor
      ? await sha256Hex(`github:${args.actor.toLowerCase()}`)
      : null;
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: "github-agent-command-usage",
      targetKey: args.targetKey ?? args.repoFullName ?? "unknown",
      repoFullName: args.repoFullName ?? null,
      payload: {
        command: args.command,
        actorKind: args.actorKind,
        actorHash,
        outcome: args.outcome,
        detail: args.detail ?? null,
        family: args.family ?? "agent_command",
        runId: args.runId ?? null,
      },
      generatedAt: nowIso(),
    });
  } catch (error) {
    console.warn("Failed to record GitHub agent command usage", {
      command: args.command,
      outcome: args.outcome,
      error: errorMessage(error),
    });
  }
}

async function buildMaintainerQueueDigestForCommand(
  env: Env,
  repo: Awaited<ReturnType<typeof getRepository>>,
  repoFullName: string,
): Promise<ReturnType<typeof buildMaintainerQueueDigest>> {
  const [issues, pullRequests, recentMergedPullRequests] = await Promise.all([
    listIssues(env, repoFullName),
    listPullRequests(env, repoFullName),
    listRecentMergedPullRequests(env, repoFullName),
  ]);
  const [confirmedMinerLogins, checkSummariesByPullNumber] = await Promise.all([
    loadCachedConfirmedMinerLogins(env, pullRequests),
    loadQueueCheckSummariesByPullNumber(env, repoFullName, pullRequests),
  ]);
  return buildMaintainerQueueDigest({
    repo,
    issues,
    pullRequests,
    recentMergedPullRequests,
    confirmedMinerLogins,
    checkSummariesByPullNumber,
    controlPanelUrl: maintainerControlPanelUrl(env, repoFullName),
  });
}

async function loadCachedConfirmedMinerLogins(
  env: Env,
  pullRequests: Awaited<ReturnType<typeof listPullRequests>>,
): Promise<string[]> {
  const logins = [
    ...new Set(
      pullRequests
        .filter((pr) => pr.state === "open")
        .flatMap((pr) => (pr.authorLogin ? [pr.authorLogin] : []))
        .map((login) => login.toLowerCase()),
    ),
  ].slice(0, 50);
  const detections = await Promise.all(
    logins.map(
      async (login) =>
        [login, await getFreshOfficialMinerDetection(env, login)] as const,
    ),
  );
  return detections.flatMap(([login, detection]) =>
    detection?.status === "confirmed" ? [login] : [],
  );
}

async function loadQueueCheckSummariesByPullNumber(
  env: Env,
  repoFullName: string,
  pullRequests: Awaited<ReturnType<typeof listPullRequests>>,
): Promise<Record<number, Awaited<ReturnType<typeof listCheckSummaries>>>> {
  const openPullRequests = pullRequests
    .filter((pr) => pr.state === "open")
    .slice(0, 50);
  const entries = await Promise.all(
    openPullRequests.map(
      async (pr) =>
        [
          pr.number,
          await listCheckSummaries(env, repoFullName, pr.number),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function recordAgentCommandFeedbackPrompt(
  env: Env,
  args: {
    deliveryId: string;
    command: string;
    actor: string;
    targetKey: string;
    actorKind: "maintainer" | "author";
    family: "agent_command" | "maintainer_digest";
  },
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.agent_command_feedback_prompted",
    actor: args.actor,
    targetKey: args.targetKey,
    outcome: "completed",
    detail: args.command,
    metadata: {
      deliveryId: args.deliveryId,
      command: args.command,
      actorKind: args.actorKind,
      family: args.family,
      scoringImpact: "none",
    },
  });
}

async function maybeProcessAgentCommandFeedbackReaction(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const actor = payload.reaction?.user?.login ?? payload.sender?.login;
  const vote = reactionVote(payload.reaction?.content);
  const feedback = parseAgentCommandFeedbackContext(payload.comment?.body);
  if (!repoFullName || !issue || !actor || !feedback || !vote) return false;

  const targetKey = `${repoFullName}#${issue.number}`;
  if (payload.action !== "created") {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_feedback_skipped",
      actor,
      targetKey,
      outcome: "completed",
      detail: "unsupported_reaction_action",
      metadata: {
        deliveryId,
        action: payload.action ?? null,
        answerId: feedback.answerId,
      },
    });
    return true;
  }
  if (payload.reaction?.user?.type === "Bot" || /\[bot\]$/i.test(actor)) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_feedback_skipped",
      actor,
      targetKey,
      outcome: "completed",
      detail: "bot_reaction",
      metadata: { deliveryId, answerId: feedback.answerId },
    });
    return true;
  }
  const [answer, cachedPullRequest] = await Promise.all([
    getAgentCommandAnswer(env, feedback.answerId),
    getPullRequest(env, repoFullName, issue.number),
  ]);
  const command = answer?.command ?? feedback.command ?? "unknown";
  if (!answer) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_feedback_skipped",
      actor,
      targetKey,
      outcome: "completed",
      detail: "unknown_answer",
      metadata: { deliveryId, answerId: feedback.answerId, command, vote },
    });
    return true;
  }
  const contextMismatch =
    answer.repoFullName.toLowerCase() !== repoFullName.toLowerCase() ||
    answer.issueNumber !== issue.number;
  if (contextMismatch) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_feedback_skipped",
      actor,
      targetKey,
      outcome: "completed",
      detail: "answer_context_mismatch",
      metadata: { deliveryId, answerId: feedback.answerId, command, vote },
    });
    return true;
  }
  if (
    !answer.responseCommentId ||
    answer.responseCommentId !== payload.comment?.id
  ) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_feedback_skipped",
      actor,
      targetKey,
      outcome: "completed",
      detail: "answer_comment_mismatch",
      metadata: {
        deliveryId,
        answerId: feedback.answerId,
        command,
        vote,
        commentId: payload.comment?.id ?? null,
      },
    });
    return true;
  }
  const pullRequestAuthor =
    cachedPullRequest?.authorLogin ?? issue.user?.login ?? null;
  const official =
    pullRequestAuthor && actor.toLowerCase() === pullRequestAuthor.toLowerCase()
      ? await getCachedOfficialMinerDetection(env, actor, {
          targetKey,
          deliveryId,
        })
      : undefined;
  const authorization = authorizeFeedbackActor(env, {
    actor,
    repoFullName,
    pullRequestAuthor,
    officialAuthorDetection: official,
  });
  if (!authorization.authorized) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_feedback_denied",
      actor,
      targetKey,
      outcome: "denied",
      detail: authorization.reason,
      metadata: { deliveryId, answerId: feedback.answerId, command, vote },
    });
    return true;
  }

  await recordAgentCommandFeedback(env, {
    answerId: feedback.answerId,
    repoFullName,
    issueNumber: issue.number,
    command,
    actorLogin: actor,
    vote,
    source: "github_reaction",
    actorKind: authorization.actorKind,
    metadata: {
      deliveryId,
      reactionId: payload.reaction?.id ?? null,
    },
  });
  await recordAuditEvent(env, {
    eventType: "github_app.agent_command_feedback_recorded",
    actor,
    targetKey,
    outcome: "completed",
    metadata: {
      deliveryId,
      answerId: feedback.answerId,
      command,
      vote,
      source: "github_reaction",
      actorKind: authorization.actorKind,
    },
  });
  return true;
}

function reactionVote(
  content: string | null | undefined,
): "useful" | "not_useful" | null {
  if (content === "+1") return "useful";
  if (content === "-1") return "not_useful";
  return null;
}

function authorizeFeedbackActor(
  env: Env,
  args: {
    actor: string;
    repoFullName: string;
    pullRequestAuthor?: string | null | undefined;
    officialAuthorDetection?: OfficialGittensorMinerDetection | undefined;
  },
): { authorized: boolean; reason: string; actorKind: "maintainer" | "author" } {
  const [owner] = args.repoFullName.split("/");
  if (owner && owner.toLowerCase() === args.actor.toLowerCase()) {
    return {
      authorized: true,
      reason: "repo_owner_feedback",
      actorKind: "maintainer",
    };
  }
  if (isAuthorizedGitHubSessionLogin(env, args.actor)) {
    return {
      authorized: true,
      reason: "operator_feedback",
      actorKind: "maintainer",
    };
  }
  const authorAuthorization = isAuthorizedCommandActor({
    commenterLogin: args.actor,
    commenterAssociation: null,
    pullRequestAuthorLogin: args.pullRequestAuthor,
    officialAuthorDetection: args.officialAuthorDetection,
  });
  return {
    authorized: authorAuthorization.authorized,
    reason: authorAuthorization.reason,
    actorKind: "author",
  };
}

async function auditPrVisibilitySkip(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  author: string | null,
  reason: string,
  deliveryId: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: author,
    targetKey: `${repoFullName}#${pullNumber}`,
    outcome: "completed",
    detail: reason,
    metadata: { deliveryId },
  });
  await recordGithubProductUsage(env, "pr_visibility_skipped", {
    actor: author,
    repoFullName,
    targetKey: `${repoFullName}#${pullNumber}`,
    outcome: "skipped",
    metadata: { reason },
  });
}

async function getCachedOfficialMinerDetection(
  env: Env,
  login: string,
  context: { targetKey: string; deliveryId: string },
): Promise<OfficialGittensorMinerDetection> {
  const cached = await getFreshOfficialMinerDetection(env, login);
  if (cached) {
    await auditMinerDetectionCache(
      env,
      "github_app.miner_detection_cache_hit",
      login,
      context,
      cached.status,
    );
    if (cached.status === "unavailable")
      await auditMinerDetectionUnavailable(env, login, context, cached.error);
    return cached;
  }
  await auditMinerDetectionCache(
    env,
    "github_app.miner_detection_cache_miss",
    login,
    context,
    "miss",
  );
  const detection = await fetchOfficialGittensorMiner(login);
  const cacheableDetection = await upsertOfficialMinerDetection(
    env,
    login,
    detection,
    detection.status === "unavailable"
      ? OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS
      : OFFICIAL_MINER_DETECTION_TTL_MS,
  );
  if (cacheableDetection.status === "unavailable")
    await auditMinerDetectionUnavailable(
      env,
      login,
      context,
      cacheableDetection.error,
    );
  return cacheableDetection;
}

async function auditMinerDetectionUnavailable(
  env: Env,
  actor: string,
  context: { targetKey: string; deliveryId: string },
  detail: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: "github_app.miner_detection_unavailable",
    actor,
    targetKey: context.targetKey,
    outcome: "error",
    detail,
    metadata: { deliveryId: context.deliveryId },
  });
}

async function auditMinerDetectionCache(
  env: Env,
  eventType:
    | "github_app.miner_detection_cache_hit"
    | "github_app.miner_detection_cache_miss",
  actor: string,
  context: { targetKey: string; deliveryId: string },
  detail: string,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType,
    actor,
    targetKey: context.targetKey,
    outcome: "completed",
    detail,
    metadata: { deliveryId: context.deliveryId },
  });
}

function officialGittensorContributorDetection(
  snapshot: GittensorContributorSnapshot,
  currentPr: Awaited<ReturnType<typeof upsertPullRequestFromGitHub>>,
  pullRequests: Awaited<ReturnType<typeof listContributorPullRequests>>,
  issues: Awaited<ReturnType<typeof listContributorIssues>>,
  repoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const cached = detectGittensorContributor(
    snapshot.githubUsername,
    currentPr,
    pullRequests,
    issues,
    repoStats,
  );
  return {
    ...cached,
    detected: true,
    source: "official_gittensor_api" as const,
    reason: "Official Gittensor API confirms this GitHub user.",
    priorPullRequests: Math.max(
      cached.priorPullRequests,
      snapshot.totals.pullRequests,
    ),
    priorMergedPullRequests: Math.max(
      cached.priorMergedPullRequests,
      snapshot.totals.mergedPullRequests,
    ),
    priorIssues: Math.max(
      cached.priorIssues,
      snapshot.totals.openIssues + snapshot.totals.closedIssues,
    ),
  };
}

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<
    ReturnType<typeof fetchGittensorContributorSnapshot>
  >,
  cachedRepoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const officialRepoStats =
    contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
}

/** Split `owner/name` into the project/repo key shape shared by RAG indexing and retrieval. */
export function splitRepoForRag(repoFullName: string): [string, string] {
  const slash = repoFullName.indexOf("/");
  return slash === -1
    ? ["", repoFullName]
    : [repoFullName.slice(0, slash), repoFullName.slice(slash + 1)];
}
