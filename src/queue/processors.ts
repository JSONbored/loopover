import {
  listOpenItemsForAuthorAcrossInstall,
  type OpenItemAcrossInstallRow,
  getAgentCommandAnswer,
  getInstallation,
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
  listOtherOpenPullRequests,
  listOtherOpenPullRequestsForAuthor,
  listOpenIssues,
  listOpenPullRequests,
  listPullRequests,
  listPullRequestFiles,
  listRecentMergedPullRequests,
  updatePullRequestSlopAssessment,
  updatePullRequestCopycatAssessment,
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
  hasPublishedAiSlopAdvisory,
  getCachedLinkedIssueSatisfaction,
  getLatestPublishedLinkedIssueSatisfaction,
  putCachedLinkedIssueSatisfaction,
  hasPublishedLinkedIssueSatisfaction,
  markPullRequestsRegated,
  markPullRequestsBacklogConvergenceRegated,
  markPullRequestReviewsInvalidated,
  markPullRequestSurfacePublished,
  markPullRequestVisualCaptureSatisfied,
  markPullRequestScreenshotTablePresenceSatisfied,
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
  getActiveReviewStartedAt,
  isGlobalAgentFrozen,
  markGateOutcomeOverridden,
  markPullRequestLinkedIssueHardRuleViolated,
  startActiveReviewTracking,
  terminalizeActiveReviewTracking,
  bumpPullRequestDraftConversionCount,
  recordProductUsageEvent,
  recordAiUsageEvent,
  persistSignalSnapshot,
  recordWebhookEvent,
  upsertAgentCommandAnswer,
  upsertOfficialMinerDetection,
  upsertBurdenForecast,
  upsertContributorEvidence,
  upsertContributorScoringProfile,
  upsertInstallation,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  getLatestAdvisoryForPullRequest,
} from "../db/repositories";
import { renameRepositoryIdentity } from "../db/repo-identity-rename";
import {
  effectiveIssueCapForAccountAge,
  isBelowAccountAgeThreshold,
  repoOwnerLoginFromFullName,
} from "./account-age-throttle";
import {
  backfillRepositorySegment,
  fetchAndStorePullRequestFilesForReview,
  fetchLinkedIssueFacts,
  fetchLiveBaseBranchAdvancedAt,
  invalidateCiStateCache,
  type LiveCiAggregate,
  fetchLiveIssueState,
  fetchLivePullRequest,
  fetchLivePullRequestHeadSha,
  fetchLivePullRequestReviewDecision,
  fetchLiveReviewThreadBlockers,
  fetchLivePullRequestState,
  fetchNamedCheckRunConclusion,
  fetchOpenPullRequestNumbersForCommit,
  invalidatePrStateCache,
  isReviewsCacheUpToDate,
  primeDurablePrStateCache,
  refreshPullRequestDetails,
} from "../github/backfill";
import {
  contributorRepoStatsFromGittensor,
  fetchGittensorContributorSnapshot,
  fetchOfficialGittensorMiner,
  type GittensorContributorSnapshot,
  type OfficialGittensorMinerDetection,
} from "../gittensor/api";
import {
  cancelInFlightWorkflowRunsForHeadSha,
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
  LOOPOVER_GATE_CHECK_NAME,
  isGitHubRateLimitedError,
  isForeignAppInstallation,
} from "../github/app";
import { isSelfAuthoredCiCompletionWebhook } from "../github/self-authored";
import {
  AGENT_COMMAND_COMMENT_MARKER,
  createOrUpdateAgentCommandComment,
  createOrUpdatePrIntelligenceComment,
  createOrUpdateVisualFollowupComment,
  PR_PANEL_COMMENT_MARKER,
} from "../github/comments";
import {
  loopoverFooter,
  gittensorRepoEarnUrl,
  maintainerControlPanelUrl,
} from "../github/footer";
import {
  buildMaintainerQueueDigest,
  buildPublicAgentCommandComment,
  INTENT_ROUTABLE_COMMANDS,
  type LoopOverMentionCommandName,
  isAiCostBearingCommand,
  isAuthorizedCommandActor,
  isLoopOverActionCommand,
  isMaintainerQueueDigestCommand,
  parseAgentCommandFeedbackContext,
  parseLoopOverMentionCommand,
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
import { getLatestRegistrySnapshot } from "../registry/sync";
import {
  buildIssueAdvisory,
  buildPullRequestAdvisory,
  evaluateGateCheck,
  resolveAiReviewLowConfidenceHold,
} from "../rules/advisory";
import { hasValidationNote, isTestPath } from "../signals/test-evidence";
import { detectNotificationEvents } from "../notifications/events";
import { detectIssueWatchEvents } from "../notifications/service";
import { getOrCreateScoringModelSnapshot } from "../scoring/model";
import {
  authoritativeContributorRepoStats,
  buildAndPersistContributorDecisionPack,
  loadDecisionPackSharedInputs,
} from "../services/decision-pack";
import {
  buildContributorEvidenceGraph,
  CONTRIBUTOR_EVIDENCE_GRAPH_SIGNAL,
  evidenceGraphTouchedRepoFullNames,
} from "../services/contributor-evidence-graph";
import {
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
  isAgentConfigured,
  resolveAutonomy,
} from "../settings/autonomy";
import {
  isGlobalAgentPause,
  resolveAgentActionMode,
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
import { linkedIssueSatisfactionCacheInputFingerprint } from "../review/linked-issue-satisfaction-cache-input";
import {
  AGENT_LABEL_NEEDS_REVIEW,
  downgradeCloseToHold,
  downgradeMergeToHold,
  MAX_REVIEW_NAG_COOLDOWN_DAYS,
  isProtectedAutomationAuthor,
  planAgentMaintenanceActions,
  type AgentActionPlanInput,
  type AgentDispositionLabelSettings,
  type PlannedAgentAction,
} from "../settings/agent-actions";
import { isAutoCloseExempt } from "../settings/auto-close-exempt";
import {
  isSkipAutomationBotPullRequestsEnabledGlobally,
  isTrustedAutomationBotAuthor,
  isTrustedAutomationBotWebhookActor,
  resolveSkipAutomationBotPullRequests,
} from "../settings/automation-bot-skip";
import { resolveGlobalContributorOpenItemCap, resolveGlobalContributorOpenItemCapForMiner } from "../settings/global-contributor-cap";
import { detectMigrationCollisions, extractMigrationNumber, KNOWN_MIGRATION_DUPLICATES } from "../db/migration-collisions";
import { listMigrationFilenamesAtRef } from "../github/migration-tree";
import {
  executeAgentMaintenanceActions,
  executeIssueMaintenanceActions,
  pendingClosureLabelApplied,
} from "../services/agent-action-executor";
import { loadIssueQualityReportMap } from "../services/issue-quality";
import { generateAndSendReviewRecap } from "../services/review-recap";
import {
  buildFreshnessSloReport,
  freshnessAuditMetadata,
} from "../signals/data-quality";
import {
  buildBurdenForecast,
  buildCollisionReport,
  isPullRequestInDuplicateCluster,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorStrategy,
  buildDuplicateWinnerRelatedWorkView,
  buildPreflightResult,
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
import { isDuplicateClusterWinnerByClaim } from "../signals/duplicate-winner";
import { isDuplicateWinnerEnabledGlobally, resolveDuplicateWinnerEnabled } from "../settings/duplicate-winner-mode";
import { isOpenPrFileCollisionEnabledGlobally, resolveOpenPrFileCollisionEnabled } from "../settings/open-pr-file-collision-mode";
import { buildAiReviewDiff, buildSecretScanDiff, buildUnifiedReviewDiff, totalAddedLineCount } from "../review/review-diff";
// #4013 step 4 (prep): buildAiReviewDiff/buildSecretScanDiff moved to review-diff.ts (a natural existing
// home -- both already wrapped buildUnifiedReviewDiff there) rather than staying here, since keeping them
// in this file would have made the new slop-detection.ts below circularly import this file just for
// buildAiReviewDiff. Re-exported so test/unit/linked-issue-satisfaction-run.test.ts,
// test/unit/ai-review-advisory.test.ts, test/unit/ai-slop.test.ts, and
// test/unit/patchless-secret-scan.test.ts's existing `import { ... } from "../../src/queue/processors"`
// keep working unchanged.
export { buildAiReviewDiff, buildSecretScanDiff } from "../review/review-diff";
import { estimateReviewEffort } from "../review/review-effort";
import { buildUnifiedCommentBody } from "../review/unified-comment-bridge";
import { isRetryableJobError, RetryableJobError } from "./retryable";
import {
  claimPrActuationLock,
  PrActuationLockContendedError,
  releasePrActuationLock,
  type TransientLockClaim,
} from "./transient-locks";
// #4013 step 1: temporary re-export shim so test/unit/queue.test.ts and its size-split siblings
// (queue-2/3/4/5.test.ts, queue-lifecycle-guards.test.ts)'s existing
// `import { claimPrActuationLock, releasePrActuationLock } from "../../src/queue/processors"` keeps working
// unchanged -- those tests are deeply interspersed with unrelated ones in that file family, not in a cleanly
// extractable describe block, so relocating them is deliberately deferred rather than forced into this PR.
export { claimPrActuationLock, releasePrActuationLock } from "./transient-locks";
// #4013 step 2: same shim shape for generateSignalSnapshots -- imported here for processJob's own internal
// call below, and re-exported so src/api/routes.ts and test/unit/queue-trends.test.ts's existing
// `import { generateSignalSnapshots } from "../../src/queue/processors"` keeps working unchanged.
// loadOpenQueueCounts moved there too (it has no other callers besides generateSignalSnapshots and this
// file's own buildBurdenForecasts) rather than staying here and importing back, which would have made the
// two files circularly dependent.
import { generateSignalSnapshots, loadOpenQueueCounts } from "./signal-snapshot";
export { generateSignalSnapshots } from "./signal-snapshot";
// #4013 step 3: same shim shape for the duplicate-cluster adjudication/reconciliation functions -- imported
// here for this file's own internal callers, and re-exported so test/unit/duplicate-winner.test.ts and
// test/unit/reconcile-live-duplicate-siblings.test.ts's existing
// `import { ... } from "../../src/queue/processors"` keeps working unchanged.
import {
  dupWinnerLinkedDuplicateCount,
  dupWinnerLinkedDuplicateWinnerNumber,
  linkedIssueDuplicatePullRequestRecordsForGate,
  linkedIssueDuplicatePullRequestsForGate,
  reconcileLiveDuplicateSiblings,
} from "./duplicate-detection";
export {
  dupWinnerLinkedDuplicateCount,
  dupWinnerLinkedDuplicateWinnerNumber,
  linkedIssueDuplicatePullRequestRecordsForGate,
  linkedIssueDuplicatePullRequestsForGate,
  reconcileLiveDuplicateSiblings,
} from "./duplicate-detection";
import { mapWithConcurrency } from "./map-with-concurrency";
export { mapWithConcurrency } from "./map-with-concurrency";
// #4013 step 4: same shim shape for the AI-slop-advisory gating/orchestration functions -- imported here
// for this file's own internal callers, and re-exported so test/unit/advisory-ai-routing-call-sites.test.ts,
// test/unit/ai-slop.test.ts, and test/unit/gate-check-policy.test.ts's existing
// `import { ... } from "../../src/queue/processors"` keeps working unchanged.
import { runAiSlopForAdvisory, shouldCollectSlopEvidence, shouldRunSlopAiAdvisory } from "./slop-detection";
export { runAiSlopForAdvisory, shouldCollectSlopEvidence, shouldRunSlopAiAdvisory } from "./slop-detection";
import { runCopycatAssessment, shouldCollectCopycatEvidence } from "./copycat-detection";
export { runCopycatAssessment, shouldCollectCopycatEvidence } from "./copycat-detection";
// #4013 step 5: the 5 review-evasion entry points, imported for this file's own webhook-handler call
// sites. No re-export here (unlike the shims above) -- none of these 5 functions were ever exported from
// this file, so there is no existing external `import { ... } from "../../src/queue/processors"` to keep
// working.
import {
  maybeCloseDraftDodgeAttempt,
  maybeCloseDraftPr,
  maybeCloseRepeatedDraftCycling,
  maybeCloseReviewEvasionDraftConversion,
  maybeCloseReviewEvasionSelfClose,
  maybeRecloseDisallowedReopen,
  type ReopenRecloseOutcome,
} from "./review-evasion";
// #4013 step 6: the live CI-aggregate/merge-state cache functions, imported for this file's own remaining
// direct callers (primeLiveMergeState's liveFactKey/liveFactTokenPart use, plus the disposition/readiness
// call sites elsewhere in this file). No re-export -- nothing outside this file ever imported any of these
// from "../../src/queue/processors" (none were exported before this move either).
import {
  cachedLiveCiAggregate,
  cachedLiveMergeState,
  cachedRequiredStatusContexts,
  liveFactKey,
  liveFactTokenPart,
  refreshLiveCiAggregate,
  refreshLiveMergeState,
  reuseOrRefreshLiveCiAggregate,
  reuseOrRefreshLiveMergeState,
} from "./ci-resolution";
// #4013 step 7: same shim shape for runRetentionPrune -- imported here for processJob's own internal call
// below, and re-exported so test/unit/retention.test.ts and test/unit/selfhost-pg-retention.test.ts's
// existing `import { ... } from "../../src/queue/processors"` keeps working unchanged.
import { runRetentionPrune } from "./retention";
export { runRetentionPrune } from "./retention";
// #4013 step 8: same shim shape for the gate-check policy/publish/audit functions -- imported here for
// this file's own many disposition/publish call sites, and re-exported so
// test/unit/gate-check-policy.test.ts and test/unit/repository-settings-enforcement.test.ts's existing
// `import { gateCheckPolicy } from "../../src/queue/processors"` keeps working unchanged.
import { auditGateCheckPermissionMissing, gateCheckPolicy, recordPublishedGateCheckSummary } from "./gate-checks";
export { gateCheckPolicy } from "./gate-checks";
// #4013 step 9: same shim shape for the AI-review-orchestration functions -- imported here for this file's
// own remaining internal callers, and re-exported so the many existing tests importing claimAiReviewLock,
// releaseAiReviewLock, runAiReviewForAdvisory, shouldStartAiReviewForAdvisory,
// resolveReviewManifestForAiReview, and/or splitRepoForRag from "../../src/queue/processors" keep working
// unchanged. aiReviewLockContendedResult, resolveReviewEnrichmentGithubToken,
// shouldRequirePublicAiReviewForAdvisory, and AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS have no test
// importing them directly, so they're imported-back only, not re-exported.
import {
  AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS,
  aiReviewLockContendedResult,
  claimAiReviewLock,
  releaseAiReviewLock,
  resolveReviewEnrichmentGithubToken,
  resolveReviewManifestForAiReview,
  runAiReviewForAdvisory,
  shouldRequirePublicAiReviewForAdvisory,
  shouldStartAiReviewForAdvisory,
  splitRepoForRag,
} from "./ai-review-orchestration";
export {
  claimAiReviewLock,
  releaseAiReviewLock,
  resolveReviewManifestForAiReview,
  runAiReviewForAdvisory,
  shouldStartAiReviewForAdvisory,
  splitRepoForRag,
} from "./ai-review-orchestration";
// #4013 step 10 (final): same shim shape for processJob -- re-exported because src/index.ts, src/server.ts,
// and the bulk of the test suite import it directly as `import { processJob } from "../../src/queue/processors"`.
// Nothing in this file calls processJob itself, so this is a pure re-export (no separate import needed).
export { processJob } from "./job-dispatch";
import { isVisualPath } from "../review/visual/paths";
import { buildCapture, fetchExternalScreenshotContentBlock, fetchShotContentBlock, hasSuccessfulBotCapture, resolveVisualRoutes, type CaptureInteractionRoute, type CaptureRoute } from "../review/visual/capture";
import { MAX_PREVIEW_POLL_ATTEMPTS } from "../review/visual/preview-poll-budget";
import {
  clearFallbackDispatchMarker,
  fallbackShotFileName,
  fallbackShotR2Key,
  fetchFallbackArtifactShots,
  FALLBACK_WORKFLOW_NAME,
  parseFallbackRunCorrelation,
} from "../review/visual/actions-fallback";
import {
  buildVisualBugAnalysisUserPrompt,
  buildVisualRegressionFindings,
  buildVisualVisionUserPrompt,
  evaluateVisualVisionGate,
  parseVisualVisionResponse,
  VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT,
  VISUAL_VISION_SYSTEM_PROMPT,
} from "../review/visual/visual-findings";
import { buildVisualFollowupComment, resolveVisualFollowupNotifyLogins } from "../review/visual/visual-followup";
import { incr, observe, REVIEW_LATENCY_BUCKETS } from "../selfhost/metrics";
import { withAdvisoryAiEnv } from "../selfhost/ai";
import {
  renderReviewingPlaceholder,
  shouldPostReviewingPlaceholder,
  type CheckFailureDetail,
  type MergeReadiness,
} from "../review/unified-comment";
import { buildIssueSlopAssessment } from "../signals/issue-slop";
import { buildSlopAssessment, type SlopBand } from "../signals/slop";
import { copycatWouldActOnPersistedScore } from "../signals/copycat";
import { buildStructuralImprovementAssessment } from "../signals/improvement";
import { runLoopOverLinkedIssueSatisfaction } from "../services/linked-issue-satisfaction-run";
import { decidePublicSurface } from "../signals/settings-preview";
import {
  buildFocusManifestGuidance,
  composeRepoReviewContext,
  composeManifestReviewInstructions,
  resolvePullRequestAutoReviewSkipReason,
  resolveAutoReviewSkipSummary,
  isContributorControlledAutoReviewSkipReason,
  resolveReviewAutoReviewConfig,
  isAutoReviewCommitThresholdReached,
  resolveReviewPathInstructions,
  resolveReviewPreMergeChecks,
  resolveReviewPromptOverrides,
  resolveReviewMemoryManifestToggle,
  resolveE2eTestAutoTriggerManifestToggle,
  resolveReviewVisualConfig,
  type AiReviewCadence,
  type FocusManifestFinding,
  type FocusManifest,
  type ReviewFindingSeverity,
  type VisualConfig,
} from "../signals/focus-manifest";
import { decideReviewEligibility } from "../review/review-eligibility";
import {
  hasLocalManifest,
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
  coerceAiUsage,
  DEFAULT_BYOK_DAILY_REPO_LIMIT,
  hasPublicReviewAssessment,
  utcDayStartIso,
  type AiReviewActualUsage,
  type ImprovementMagnitude,
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
import { resolvePlannerEnabled } from "../settings/planner-mode";
import { classifyConfigurationCommandRequest } from "../github/configuration-command";
import { summarizeEffectiveConfig } from "../settings/effective-config-summary";
import { makeGithubFileFetcher } from "../review/grounding-wire";
import {
  enrichSecretScanFilesWithPatchFallback,
  hasPatchLessSecretScanCandidates,
  incompletePatchLessSecretScanFinding,
  markEligiblePatchLessFilesIncomplete,
} from "./patchless-secret-scan";
import { isRagEnabled } from "../review/rag-wire";
import { computeImpactMap, type ImpactMapEntry } from "../review/impact-map";
import { shouldComputeImpactMap } from "../review/impact-map-wire";
import { shouldEmitFixHandoff } from "../review/fix-handoff";
import { buildFixHandoffBlocks } from "../review/fix-handoff-render";
import { buildE2eTestGenCommentBody, type E2eTestGenCommitOutcome } from "../review/e2e-test-gen-render";
import { resolveE2eTestGenInstructions, runLoopOverE2eTestGeneration } from "../services/ai-e2e-test-gen";
import { generateChatQaAnswer } from "../services/ai-chat-qa";
import { classifyLoopOverIntent } from "../services/ai-intent-router";
import { commitE2eTestToPrBranch } from "../github/e2e-test-commit";
import { shouldApplyRepoCultureProfile } from "../review/repo-culture-profile-wire";
import { applyReviewMemorySuppression, getCachedReviewSuppressions, invalidateReviewSuppressionCache, shouldApplyReviewMemory } from "../review/review-memory-wire";
import { isEnrichmentEnabled } from "../review/enrichment-wire";
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
import { createIssueComment, listPullRequestCommitMessages } from "../github/pr-actions";
import {
  anyLinkedIssueHardRuleOn,
  loadLinkedIssueHardRules,
  mergeLinkedIssueHardRuleWithPersistedViolation,
  resolveLinkedIssueHardRule,
  resolveLinkedIssueHasOpenReference,
} from "../review/linked-issue-hard-rules";
import { DEFAULT_UNLINKED_ISSUE_GUARDRAIL } from "../review/unlinked-issue-guardrail-config";
import { resolveUnlinkedIssueMatchDisposition } from "../review/unlinked-issue-guardrail";
import { DEFAULT_SCREENSHOT_CONTRACT_MESSAGE, DEFAULT_SCREENSHOT_TABLE_GATE, evaluateScreenshotTableGate, extractTableRowImageUrls, type ScreenshotTableGateConfig } from "../review/screenshot-table-gate";
import { isSafeHttpUrl } from "../review/content-lane/safe-url";
import {
  buildScreenshotTableVisionFindings,
  buildScreenshotTableVisionUserPrompt,
  evaluateScreenshotTableVisionGate,
  parseScreenshotTableVisionResponse,
  SCREENSHOT_TABLE_VISION_FINDING_CODE,
  SCREENSHOT_TABLE_VISION_SYSTEM_PROMPT,
} from "../review/visual/screenshot-table-vision";
import {
  isCloseHoldOnly,
  isHoldOnly,
  recordPrOutcome,
  recordReversalSignals,
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
import { sha256Hex } from "../utils/crypto";
import { errorMessage, nowIso, repoParts } from "../utils/json";
import { maybeSuggestMilestoneMatchForPr } from "../integrations/project-tracker-adapter";

const OFFICIAL_MINER_DETECTION_TTL_MS = 5 * 60 * 1000;
const OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS = 60 * 1000;
const PER_PR_REGATE_BACKPRESSURE_TYPES = ["agent-regate-pr"] as const;
const SWEEP_OPEN_PULL_REQUEST_SYNC_MAX_AGE_MS = 10 * 60 * 1000;
const PR_PANEL_RETRIGGER_COMMAND_AUTHORIZATION: RepositoryCommandAuthorizationPolicy = {
  default: ["maintainer", "collaborator"],
  commands: { "review-now": ["maintainer", "collaborator"] },
};
const PR_PUBLIC_SURFACE_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "edited",
]);
const PR_GATE_CLOSED_ACTIONS = new Set(["closed"]);
// #4818 follow-up: the three review-family event names `shouldProcessPullRequestPublicSurface` (below) also
// routes into `maybePublishPrPublicSurface` -- none of them can ever change a PR's title or its own linked-issue
// list (the only two inputs a TYPE-label decision depends on), yet each carries its OWN independently-timed,
// independently-stale embedded `pull_request` webhook snapshot. Used ONLY to skip the type-label recompute
// itself (see `maybePublishPrPublicSurface`'s type-label block) -- every OTHER piece of the public-surface
// publish (gate re-evaluation, comments, screenshots, …) still needs to run on these events same as before.
const PR_TYPE_LABEL_IRRELEVANT_EVENT_NAMES = new Set(["pull_request_review", "pull_request_review_comment", "pull_request_review_thread"]);
const ISSUE_PLAN_COOLDOWN_MS = 10 * 60 * 1000;
const NOTIFY_EVALUATE_EVENTS_PER_JOB = 100;

export type RequiredStatusContextsLookup = { requiredContexts: Set<string> | null; resolved: boolean };

export interface LiveGithubFacts {
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
// maintainer to already know the `@loopover generate-tests` command exists from documentation alone.
const E2E_TEST_GEN_CTA = "Maintainers can also comment `@loopover generate-tests` for an AI-generated Playwright test.";

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

export async function buildContributorDecisionPacks(
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

export async function fanOutRepoSignalSnapshotJobs(
  env: Env,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  // #5019: most of what generateSignalSnapshots produces (queue-health, config-quality, label-audit,
  // contributor-intake-health, issue-quality, repo-outcome-patterns) is generic repo health, unrelated to
  // gittensor-subnet membership. The gittensor-specific pieces (maintainer-lane/maintainer-cut-readiness)
  // already degrade gracefully for !isRegistered internally, so no other change is needed here.
  const repositories = (await listRepositories(env)).filter(
    (repo) => repo.isInstalled,
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
export async function fanOutAgentRegateSweepJobs(
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
  // Sweep every REVIEW-ACTIVE repo (#sweep-all-modes): the convergence allowlist (LOOPOVER_REVIEW_REPOS) UNION the
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
        // #sweep-requires-installation: isAgentConfigured resolves the OPERATOR'S global-default autonomy
        // (e.g. a self-host `.loopover.yml` settings.autonomy block meant for the repos this instance
        // actually operates on) for ANY repoFullName, regardless of whether the GitHub App is installed
        // there. A repo that merely has a local `repositories` row (a stray subnet-registry row, say) with
        // no real `installationId` would otherwise inherit that global default and look "agent-configured"
        // purely by existing — even though no installation token exists to act on it, and it was never
        // intentionally onboarded. Require a real installation before the autonomy-based path can make a
        // repo eligible; the explicit allowlist path is untouched (LOOPOVER_REVIEW_REPOS is a deliberate,
        // operator-typed signal independent of installation state, e.g. reviewing ahead of a pending install).
        const hasInstallation = typeof repo.installationId === "number";
        if (
          !(
            isConvergenceRepoAllowed(env, repoFullName) ||
            (hasInstallation && isAgentConfigured(settings.autonomy))
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

/**
 * True when `pr`'s current head SHA has already exhausted REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA repair attempts
 * within the lookback window. Records (at most once per SHA) the exhausted audit event + error-level log as a
 * side effect the first time a SHA crosses the cap. Shared by both surfaceRepairPriorityPullNumbers and
 * sweepRepoBacklogConvergence (#orb-retry-storm, backlog-convergence half): both sweeps re-select on the
 * identical lastPublishedSurfaceSha-mismatch signal, so they share one attempt budget per SHA rather than each
 * independently hammering the same stuck PR.
 */
async function isRegateRepairExhausted(env: Env, repoFullName: string, pr: Pick<PullRequestRecord, "number" | "headSha">): Promise<boolean> {
  const headSha = pr.headSha!;
  const sinceIso = new Date(Date.now() - REGATE_REPAIR_ATTEMPT_LOOKBACK_MS).toISOString();
  const targetKey = regateRepairTargetKey(repoFullName, pr.number, headSha);
  const attempts = await countRecentAuditEventsForActorAndTarget(env, "loopover", REGATE_REPAIR_ATTEMPT_EVENT_TYPE, targetKey, sinceIso);
  if (attempts < REGATE_REPAIR_MAX_ATTEMPTS_PER_SHA) return false;
  const alreadyFlagged = await countRecentAuditEventsForActorAndTarget(env, "loopover", REGATE_REPAIR_EXHAUSTED_EVENT_TYPE, targetKey, sinceIso);
  if (alreadyFlagged === 0) {
    await recordAuditEvent(env, {
      eventType: REGATE_REPAIR_EXHAUSTED_EVENT_TYPE,
      actor: "loopover",
      targetKey,
      outcome: "denied",
      detail: `re-gate repair exhausted after ${attempts} attempt(s) for the same head SHA; falling back to ordinary staleness cadence`,
      metadata: { repoFullName, prNumber: pr.number, headSha, attempts },
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
        headSha,
        attempts,
      }),
    );
  }
  return true;
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
            check.name === LOOPOVER_GATE_CHECK_NAME &&
            check.headSha === pr.headSha &&
            check.status === "completed",
        );
        if (!currentGateCheck) priorityPullNumbers.add(pr.number);
      }),
    );
  }
  await Promise.all(
    [...priorityPullNumbers].map(async (prNumber) => {
      const pr = pulls.find((candidate) => candidate.number === prNumber);
      /* v8 ignore next -- priorityPullNumbers is only ever populated (both loops above) from a `pr` in `pulls` that already had a truthy headSha, so this lookup always succeeds with one; the guard only satisfies Array#find's `| undefined` return type. */
      if (!pr?.headSha) return;
      if (await isRegateRepairExhausted(env, repoFullName, pr)) priorityPullNumbers.delete(prNumber);
    }),
  );
  return [...priorityPullNumbers];
}

// Convergence (RAG / codebase index, flag LOOPOVER_REVIEW_RAG). The dispatch for the `rag-index-repo` job.
// Caller already gated on isRagEnabled(env).
//   - No repoFullName → cron fan-out: enqueue one FULL re-index job per registered + cutover-allowlisted repo.
//   - repoFullName + paths → INCREMENTAL re-index of those changed paths (the push / merged-PR path).
//   - repoFullName + no paths → FULL re-index of that one repo's code.
// Fully fail-safe — indexRepo / reindexChangedPaths never throw; this only delegates.
export async function runRagIndexJob(
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

// Enqueue one per-repo FULL re-index job for every RAG-active repo, candidates drawn from ALL known repos plus the
// cutover allowlist (mirrors the agent-regate fan-out: a delayed per-repo queue message so each repo's index runs
// as its own bounded, retryable job rather than one giant tick). Only RAG-active repos are indexed — retrieval is
// gated the same way, so indexing a non-converged repo would only burn the free-tier vector budget for no benefit.
async function fanOutRagIndexJobs(
  env: Env,
  requestedBy: "schedule" | "api" | "webhook" | "test",
): Promise<void> {
  // Candidate repos = ALL known repos UNION the maintainer's CONFIGURED repos (LOOPOVER_REVIEW_REPOS) — mirrors
  // fanOutAgentRegateSweepJobs's own candidate set exactly (#5024). Filtering to isRegistered-only left an
  // installed-but-never-registered repo (the brokered self-host case: is_registered=0, never went through the
  // registration webhook) out of the candidate pool entirely, so even a per-repo `features.rag` override could never
  // resurface it — the regate sweep still reviewed that repo, just without codebase-context retrieval. Deduped
  // case-insensitively (a repo can be both known AND configured). Each candidate is then filtered by whether RAG is
  // active for it (`features.rag` override → LOOPOVER_REVIEW_REPOS allowlist default) just below, so this widens
  // ELIGIBILITY only — the convergedFeatureActive gate below is what actually controls indexing spend.
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
 * Convergence (RAG / codebase index, flag LOOPOVER_REVIEW_RAG). On a MERGED PR into an allowlisted repo, enqueue
 * an incremental re-index of the PR's changed files so the index reflects the new default-branch state. No-op when
 * the flag is off, the repo isn't allowlisted, the action isn't a merge-close, or there are no changed paths.
 *
 * INCREMENTAL TRIGGER NOTE: loopover does not (yet) subscribe to raw `push` events — the merged-PR close is the
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
export async function sweepRepoRegate(
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
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), // env brake OR DB kill-switch (#audit-§5.2)
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  if (mode === "paused") {
    await recordAuditEvent(env, {
      eventType: "agent.sweep.regate",
      actor: "loopover",
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
      actor: "loopover",
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
      actor: "loopover",
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
  const duplicateWinnerEnabled = resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode);
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
    actor: "loopover",
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
export async function fanOutBacklogConvergenceSweepJobs(
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
// this repo's `.loopover.yml reviewRecap.enabled` (default OFF, mirrors repoDocGeneration.enabled below) --
// fail-safe: a repo with no `reviewRecap:` block, or a manifest load failure, never posts. Config-gated at
// THIS single call site (not inside generateAndSendReviewRecap itself) because this PR has no fan-out sweep
// yet; the eventual scheduled trigger will enumerate opted-in repos the same way fanOutRepoDocRefreshSweepJobs
// does, and can call generateAndSendReviewRecap directly since the enumeration step already filtered on
// `.enabled` -- this per-call gate is what keeps a MANUAL trigger against a non-opted-in repo a no-op too.
export async function runReviewRecapJob(env: Env, repoFullName: string, windowDays: number | undefined): Promise<void> {
  const manifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  if (!manifest?.reviewRecap.enabled) return;
  await generateAndSendReviewRecap(env, repoFullName, {
    windowDays: windowDays ?? manifest.reviewRecap.cadenceDays,
  });
}

// Repo-doc refresh sweep (#3003, part of #2993): enumerate every installed repo, bulk-load their
// .loopover.yml manifests, and enqueue one per-repo job for each repo that (a) has
// repoDocGeneration.enabled: true and (b) is due per its own refreshIntervalDays (default weekly). No atomic
// fan-out dedup (unlike agent-regate-sweep) -- this runs once a day, not every tick, so a burst of overlapping
// fan-outs is not a realistic risk. Eligibility/scope/diffing itself lives entirely inside
// openRepoDocPullRequest (via performRepoDocRefresh) -- this fan-out is purely an enumeration + rate-limiting
// optimization so a stable repo isn't re-checked more often than its own configured interval.
export async function fanOutRepoDocRefreshSweepJobs(env: Env, requestedBy: "schedule" | "api" | "test"): Promise<void> {
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
export async function sweepRepoBacklogConvergence(
  env: Env,
  repoFullName: string | undefined,
  requestedBy: "schedule" | "api" | "test",
): Promise<void> {
  if (!repoFullName) return;
  const settings = await resolveRepositorySettings(env, repoFullName);
  if (!(isConvergenceRepoAllowed(env, repoFullName) || isAgentConfigured(settings.autonomy))) return;
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  if (mode === "paused") {
    await recordAuditEvent(env, {
      eventType: "agent.sweep.backlog_convergence",
      actor: "loopover",
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
  const allCandidates = selectBacklogConvergenceCandidates({ pulls: openPullRequests });
  // #orb-retry-storm (backlog-convergence half): needsSurfaceConvergence re-fires on the exact same
  // lastPublishedSurfaceSha-mismatch signal as the main sweep's outage-repair priority path, but this sweeper
  // had no memory of prior attempts at all -- a PR whose gate-check finalize kept failing silently got a fresh
  // full re-review dispatched every ~30 minutes indefinitely. Share the same per-SHA attempt budget as the main
  // sweep (isRegateRepairExhausted) rather than adding an independent cap, since both sweeps competing for the
  // same stuck PR would otherwise double the wasted spend the cap exists to prevent.
  const exhaustedFlags = await Promise.all(allCandidates.map((pr) => isRegateRepairExhausted(env, repoFullName, pr)));
  const candidates = allCandidates.filter((_pr, index) => !exhaustedFlags[index]);
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
        // #orb-retry-storm: selectBacklogConvergenceCandidates only returns PRs needsSurfaceConvergence already
        // confirmed have a truthy headSha, so this is unconditional (unlike the main sweep's priority-repair
        // dispatch, which mixes repair and ordinary candidates). Passing it lets regatePullRequest record the
        // attempt at execution time against the SAME shared per-SHA budget isRegateRepairExhausted checked
        // above -- jobs deferred or dropped before they run still don't count against the cap.
        repairHeadSha: pr.headSha!,
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
    actor: "loopover",
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
export async function regatePullRequest(
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
  const settings = await resolveRepositorySettings(env, repoFullName);
  // #orb-retry-storm/#5385-sentry (GITTENSORY-1E): record the repair attempt only once
  // reReviewStoredPullRequest confirms it actually got PAST the review pipeline's own readiness gate
  // (prReadyForReview) -- not merely once the job cleared rate-limit admission above. A PR legitimately
  // waiting on a still-missing branch-protection-required check defers UNCONDITIONALLY and INDEFINITELY
  // (prReadyForReview's own deliberate #3947 design -- there is no finalize escape for that specific case),
  // so recording the OLD way (before ever checking readiness) charged a full attempt to a healthy PR doing
  // nothing wrong on every ~2-minute sweep tick, exhausting the 5-attempt budget in ~10 minutes -- an order
  // of magnitude shorter than realistic required-CI latency -- and firing a false "repair exhausted" alert
  // for a review that was never actually broken. Mirrors the same "count executions, not deferrals"
  // reasoning #orb-retry-storm already applied one layer out (rate-limit admission, above).
  //
  // `reachedReadiness` is set via reReviewStoredPullRequest's own onReachedReadiness callback -- NOT inferred
  // from whether the call below returns vs. throws. A retryable error (GitHub rate limit / actuation-lock
  // contention) can surface from real post-readiness work, and that is still a genuinely executed attempt that
  // must consume the repair budget before the queue retries the message, or a repair stuck behind repeated
  // contention could reselect indefinitely without ever exhausting. Conversely, an error thrown BEFORE
  // readiness (e.g. a DB read failing) must NOT charge the budget for a pass that never got a real chance to
  // review -- the callback (fired exactly once, right as the gate passes) is the only way to tell these apart
  // once the call has thrown, since the boolean return value alone is lost on a throw.
  let reachedReadiness = false;
  try {
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
        onReachedReadiness: () => {
          reachedReadiness = true;
        },
      },
    );
  } catch (error) {
    /* v8 ignore next -- retryable/rate-limit propagation is exercised by queue retry tests; this catch only preserves that contract. */
    if (isGitHubRateLimitedError(error) || isRetryableJobError(error)) {
      // The finally block below still records the attempt (if reached) before this rethrow completes.
      throw error;
    }
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
  } finally {
    // Best-effort, same as every other recordAuditEvent call in this file (`.catch(() => undefined)`) -- a
    // failure writing THIS audit row must never replace a pending rethrown retryable error (or a normal
    // return) with its own, which `finally` would otherwise do per JS semantics.
    if (repairHeadSha && reachedReadiness) {
      await recordAuditEvent(env, {
        eventType: REGATE_REPAIR_ATTEMPT_EVENT_TYPE,
        actor: "loopover",
        targetKey: regateRepairTargetKey(repoFullName, prNumber, repairHeadSha),
        outcome: "completed",
        detail: `outage-repair re-review executing for ${repoFullName}#${prNumber}`,
        metadata: { repoFullName, prNumber, headSha: repairHeadSha },
      }).catch(() => undefined);
    }
  }
}

/** The merge/disposition facts the public PR comment renders, derived from the live CI + merge-state refresh
 *  (#4607). Extracted out of `maybePublishPrPublicSurface`'s inline body: it is pure, and its output IS the
 *  renderer's input contract (`buildUnifiedCommentBody`'s ciState/mergeStateLabel/mergeReadiness/heldForReview/
 *  neverClosed arguments), so the seam is a real step rather than an arbitrary cut. */
export type PublicCommentMergeFacts = {
  ciState: MergeReadiness["ciState"];
  mergeStateLabel: string | undefined;
  mergeReadiness: MergeReadiness;
  heldForReview: boolean;
  neverClosed: boolean;
};

/** Public-safe projection of one failing check: name + short reason only, dropping absent optionals so the
 *  rendered chip never carries an `undefined` summary/url. */
function publicCheckFailureDetails(details: LiveCiAggregate["failingDetails"]): CheckFailureDetail[] {
  return details.map((detail) => ({
    name: detail.name,
    ...(detail.summary ? { summary: detail.summary } : {}),
    ...(detail.detailsUrl ? { detailsUrl: detail.detailsUrl } : {}),
  }));
}

/**
 * Derive the public comment's merge-readiness + disposition flags (#4607). Pure: no D1, no GitHub client, no
 * metrics — the caller keeps the `incr()` emit, which reads the gate conclusion this function never sees.
 *
 * The two flags exist so the COMMENT agrees with the ACTION the disposition planner will take:
 * - `heldForReview` — a clean, green PR whose diff touches a hard-guardrail path is held for owner review by
 *   `planAgentMaintenanceActions`, never auto-merged, so the comment must not headline "safe to merge"
 *   (#guarded-hold-comment). Uses the same shared `isGuardrailHit` the planner uses, not a second copy.
 * - `neverClosed` — the disposition never auto-closes a repo-owner or protected-automation PR, so a gate
 *   "close" verdict on one must headline "held", not "Closed" (#8/#9).
 */
export function derivePublicCommentMergeFacts(args: {
  liveMergeState: string | undefined;
  mergeableState: string | null | undefined;
  authorLogin: string | null | undefined;
  liveCi: Pick<LiveCiAggregate, "ciState" | "failingDetails" | "nonRequiredFailingDetails">;
  settings: Pick<RepositorySettings, "hardGuardrailGlobs" | "hardGuardrailGlobsOverridesInvariants">;
  unifiedFiles: Awaited<ReturnType<typeof listPullRequestFiles>>;
  repoFullName: string;
}): PublicCommentMergeFacts {
  const mergeStateLabel = args.liveMergeState ?? args.mergeableState ?? undefined; // fail-safe to the stored value
  const ciState: MergeReadiness["ciState"] =
    args.liveCi.ciState === "passed" ? "passed" : args.liveCi.ciState === "failed" ? "failed" : "unverified";
  // Per-failed-check WHY (codecov %/test/lint reason) from each check-run output or commit-status description.
  const failingDetails = publicCheckFailureDetails(args.liveCi.failingDetails);
  // Non-required-but-red checks (#4414-class advisory holds): surfaced so a flagged check is never silently
  // invisible, but never folded into failingChecks/failingDetails -- those two drive ciState/close.
  const nonRequiredFailingDetails = publicCheckFailureDetails(args.liveCi.nonRequiredFailingDetails);
  const mergeReadiness: MergeReadiness = {
    ciState,
    ...(mergeStateLabel ? { mergeStateLabel } : {}),
    ...(failingDetails.length > 0 ? { failingChecks: failingDetails.map((detail) => detail.name) } : {}),
    ...(failingDetails.length > 0 ? { failingDetails } : {}),
    ...(nonRequiredFailingDetails.length > 0 ? { nonRequiredFailingDetails } : {}),
  };
  const heldForReview = isGuardrailHit(changedPathsForGuardrail(args.unifiedFiles), resolveHardGuardrailGlobs(args.settings));
  const repoOwner = args.repoFullName.includes("/") ? args.repoFullName.slice(0, args.repoFullName.indexOf("/")) : "";
  const authorLogin = args.authorLogin ?? "";
  const neverClosed =
    (authorLogin.length > 0 && authorLogin.toLowerCase() === repoOwner.toLowerCase()) || isProtectedAutomationAuthor(args.authorLogin);
  return { ciState, mergeStateLabel, mergeReadiness, heldForReview, neverClosed };
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
    comment: `LoopOver: a live check of \`migrations/**\` on \`${args.baseRef}\` found a migration-number collision that isn't visible from this PR's own diff — another PR merged a same-numbered migration file since this PR's CI last ran (**${detail}**). This PR is held for manual review — please rebase onto the latest \`${args.baseRef}\` and renumber your migration to the next free number before this can merge.`,
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

/** PURE: the bounded `{actionClass, blockerClass}` label pair for the `loopover_agent_disposition_total`
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

/**
 * Assemble the {@link AgentActionPlanInput} for {@link runAgentMaintenancePlanAndExecute}'s
 * planAgentMaintenanceActions call from its ~30 already-resolved local signals (gate verdict, settings, live
 * CI/merge/review state, guardrail + hold/match results, author flags, duplicate-cluster state). PURE — every
 * input is already resolved by the caller; this only shapes them into the planner's input contract, so the
 * shaping itself is unit-tested directly instead of only through the orchestrator (#4607).
 */
function buildAgentMaintenancePlanInput(args: {
  gate: ReturnType<typeof evaluateGateCheck>;
  settings: RepositorySettings;
  changedPaths: string[];
  hardGuardrailGlobs: string[];
  authorIsOwner: boolean;
  authorIsAdmin: boolean;
  authorIsAutomationBot: boolean;
  ciAggregate: LiveCiAggregate;
  requiredContexts: Set<string> | null;
  blacklistEntry: ReturnType<typeof findBlacklistEntry>;
  screenshotTableMatch: AgentActionPlanInput["screenshotTableMatch"];
  contributorCapMatch: AgentActionPlanInput["contributorCapMatch"];
  linkedIssueHardRule: AgentActionPlanInput["linkedIssueHardRule"];
  linkedIssueRulesConfig: Awaited<ReturnType<typeof loadLinkedIssueHardRules>>;
  migrationCollisionHold: AgentActionPlanInput["migrationCollisionHold"];
  unlinkedIssueMatchHold: AgentActionPlanInput["unlinkedIssueMatchHold"];
  aiReviewLowConfidenceHold: AgentActionPlanInput["aiReviewLowConfidenceHold"];
  unlinkedIssueMatchClose: AgentActionPlanInput["unlinkedIssueMatchClose"];
  liveMergeState: string | undefined;
  liveReviewDecision: string | undefined;
  pr: PullRequestRecord;
  openDuplicateSiblings: ReturnType<typeof linkedIssueDuplicatePullRequestRecordsForGate>;
  duplicateWinnerEnabled: boolean;
}): AgentActionPlanInput {
  const {
    gate,
    settings,
    changedPaths,
    hardGuardrailGlobs,
    authorIsOwner,
    authorIsAdmin,
    authorIsAutomationBot,
    ciAggregate,
    requiredContexts,
    blacklistEntry,
    screenshotTableMatch,
    contributorCapMatch,
    linkedIssueHardRule,
    linkedIssueRulesConfig,
    migrationCollisionHold,
    unlinkedIssueMatchHold,
    aiReviewLowConfidenceHold,
    unlinkedIssueMatchClose,
    liveMergeState,
    liveReviewDecision,
    pr,
    openDuplicateSiblings,
    duplicateWinnerEnabled,
  } = args;
  return {
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
    // #4372: any maintainer-declared advisory check-run that resolved to a non-passing terminal conclusion. It
    // never gated CI (excluded from ciState above), but it must not be silently swallowed — surface it so the
    // planner routes the PR to a manual-review HOLD naming the triggering check/app. Always threaded (the
    // aggregate's field is always an array, [] when none); the planner applies its own length>0 gate, matching
    // how failingCheckNames above is likewise threaded unconditionally.
    advisoryCheckHold: ciAggregate.advisoryHoldDetails,
    ...(blacklistEntry !== null
      ? { blacklistMatch: { matched: true, reason: blacklistEntry.reason } }
      : {}),
    // Always threaded (the DB layer populates it, default "slop"); the planner applies its own fallback.
    blacklistLabel: settings.blacklistLabel,
    // Copycat/plagiarism containment (#1969): re-derive "matched" from the PERSISTED score (written by the
    // gate-evaluation pass that already ran the containment engine, src/queue/copycat-detection.ts — never
    // re-run here) rather than the live per-PR score, since this actuation pass reads the re-fetched `pr` row.
    // Absent copycatGateMode (config-as-code only, no DB column — see RepositorySettings.copycatGateMode's own
    // doc comment) defaults to "off" the same way copycatWouldActOnPersistedScore itself does.
    ...(copycatWouldActOnPersistedScore(pr.copycatScore, pr.copycatMatchedPullNumber, settings.copycatGateMode, settings.copycatGateMinScore) && pr.copycatMatchedPullNumber !== null && pr.copycatMatchedPullNumber !== undefined
      ? { copycatMatch: { matched: true, score: pr.copycatScore ?? 0, matchedPullNumber: pr.copycatMatchedPullNumber } }
      : {}),
    copycatGateMode: settings.copycatGateMode,
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
  };
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
    settings.advisoryCheckRuns,
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
      actor: "loopover",
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
  // confirmed violation isn't remembered, matching every other loopover-computed marker write in this file
  // (mergeBlockedSha, draftConversionCount, lastRegatedAt).
  if (liveLinkedIssueHardRule?.violated === true) {
    await markPullRequestLinkedIssueHardRuleViolated(env, repoFullName, pr.number, liveLinkedIssueHardRule.reason ?? "the linked issue is not eligible for a community PR").catch(() => undefined);
  }
  const linkedIssueHardRule = mergeLinkedIssueHardRuleWithPersistedViolation(
    liveLinkedIssueHardRule,
    {
      violatedAt: pr.linkedIssueHardRuleViolatedAt,
      reason: pr.linkedIssueHardRuleViolationReason,
    },
    anyLinkedIssueHardRuleOn(linkedIssueRulesConfig),
  );

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
  // below is effectively free for the common case. "close" is the only ENFORCEMENT action this gate has (#4110
  // removed the dead request_changes/comment surface) -- the ternary below is the only place that folds a
  // violation into an actual close. "advisory" mode gets its own separate, non-blocking visibility via
  // maybeAddScreenshotTableAdvisoryFinding (this file), which re-evaluates the SAME pure check later in the
  // main gate pass and appends a finding instead of a close.
  /* v8 ignore next -- defensive: resolveRepositorySettings always populates screenshotTableGate (getRepositorySettings's DB defaults), so this fallback is unreachable in practice. */
  const screenshotTableGateConfig = settings.screenshotTableGate ?? DEFAULT_SCREENSHOT_TABLE_GATE;
  const botCaptureSatisfied = Boolean(pr.headSha) && pr.visualCaptureSatisfiedSha === pr.headSha;
  const screenshotTableGateResult = evaluateScreenshotTableGate({
    config: screenshotTableGateConfig,
    prBody: pr.body,
    prLabels: pr.labels,
    changedFiles: changedPaths,
    botCaptureSatisfied,
    headSha: pr.headSha,
    presenceModeSatisfied: pr.screenshotTablePresenceSatisfied,
  });
  const screenshotTableMatch =
    screenshotTableGateResult.violated && screenshotTableGateConfig.action === "close"
      ? { matched: true, reason: screenshotTableGateResult.reason }
      : undefined;
  // #stale-screenshot-table-fix: presence mode just independently re-confirmed the gate for THIS head SHA --
  // persist the (headSha, evidenceFingerprint) checkpoint so a LATER push that carries the SAME UNCHANGED
  // evidence correctly re-violates instead of silently staying green forever (see evaluateScreenshotTableGate's
  // staleness comment). Best-effort, mirrors markPullRequestVisualCaptureSatisfied's call site: a write failure
  // here just means the next evaluation can't tell this evidence was already checked, never blocks the rest of
  // the maintenance pass.
  if (screenshotTableGateResult.presenceModeSatisfiedState) {
    await markPullRequestScreenshotTablePresenceSatisfied(env, repoFullName, pr.number, screenshotTableGateResult.presenceModeSatisfiedState).catch((error) => {
      console.log(
        JSON.stringify({
          event: "screenshot_table_presence_satisfied_mark_failed",
          repoFullName,
          pull: pr.number,
          message: errorMessage(error).slice(0, 200),
        }),
      );
    });
  }

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
        globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
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
  // way to opt out of the PER-REPO cap specifically, even though `.loopover.yml`'s own doc comment already
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
  const duplicateWinnerEnabled = resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode);
  const openDuplicateSiblings = linkedIssueDuplicatePullRequestRecordsForGate(pr, otherOpenPullRequests);
  // AI-review low-confidence guardrail (#4603): resolved PURELY from this pass's own gate evaluation + settings
  // (no extra network/DB call, unlike migrationCollisionHold/unlinkedIssueMatchHold above) -- undefined unless the
  // gate failed SOLELY on a sub-aiReviewCloseConfidence-floor ai_consensus_defect/ai_review_split finding under
  // the (default) hold_for_review disposition. See resolveAiReviewLowConfidenceHold's own doc comment.
  const aiReviewLowConfidenceHold = resolveAiReviewLowConfidenceHold(gate, settings);
  const planned = planAgentMaintenanceActions(
    buildAgentMaintenancePlanInput({
      gate,
      settings,
      changedPaths,
      hardGuardrailGlobs,
      authorIsOwner,
      authorIsAdmin,
      authorIsAutomationBot,
      ciAggregate,
      requiredContexts,
      blacklistEntry,
      screenshotTableMatch,
      contributorCapMatch,
      linkedIssueHardRule,
      linkedIssueRulesConfig,
      migrationCollisionHold,
      unlinkedIssueMatchHold,
      aiReviewLowConfidenceHold,
      unlinkedIssueMatchClose,
      liveMergeState,
      liveReviewDecision,
      pr,
      openDuplicateSiblings,
      duplicateWinnerEnabled,
    }),
  );
  // Accuracy circuit-breakers (#self-improve / GAP-4): two INDEPENDENT, fail-open precision breakers, chained.
  //   • MERGE breaker (holdonly:<scope>): when set, convert a would-MERGE into a human HOLD before executing.
  //   • CLOSE breaker (closehold:<scope>): when set, convert a HEURISTIC would-CLOSE into a human HOLD (the
  //     deterministic linked-issue-hard-rule close is exempt — downgradeCloseToHold scopes itself).
  // Each read is independent and fail-open (isHoldOnly / isCloseHoldOnly read false until a breaker actually
  // engages), so the common path is byte-identical (both downgrades return the plan unchanged). The chaining is
  // extracted into the pure applyPrecisionBreakers below so it is unit-tested directly.
  const breakerMinerAuthored = pr.authorLogin
    ? (
        await getCachedOfficialMinerDetection(env, pr.authorLogin, {
          targetKey: `${repoFullName}#${pr.number}`,
          deliveryId,
        })
      ).status === "confirmed"
    : false;
  const breakerOnPlan = applyPrecisionBreakers(
    planned,
    await isHoldOnly(env, repoFullName, breakerMinerAuthored),
    await isCloseHoldOnly(env, repoFullName, breakerMinerAuthored),
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
    incr("loopover_precision_breaker_downgrades_total", { direction });
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
  incr("loopover_agent_disposition_total", {
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
    // #2352: this row is the ACTUAL autonomous disposition that the precision breaker evaluates, so preserve
    // the same miner-authored scope as the gate-check audit row below. Omitting it defaults to non-miner and can
    // erase a prior miner-authored prediction for the same head.
    minerAuthored: breakerMinerAuthored,
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
      actor: "loopover",
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
      advisoryCheckRuns: settings.advisoryCheckRuns, // #4372: same exclusion the plan used, for step-8 re-verify
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
 *
 * Returns `true` once the review pipeline's own readiness gate (`prReadyForReview`, below) has actually
 * passed and this call is genuinely proceeding with a real review/gate attempt; `false` for every early
 * decline before that point (PR missing/closed, terminal-state reconcile, automation-bot skip, or
 * `prReadyForReview` itself deferring — e.g. CI/required-context still pending). regatePullRequest (#5385-
 * sentry, GITTENSORY-1E) uses this to only charge its bounded repair-attempt budget for a pass that actually
 * got a chance to review, not one `prReadyForReview` correctly, harmlessly declined.
 *
 * `options.onReachedReadiness` fires the instant the gate passes, BEFORE any further (throwable) work runs —
 * a side channel so a caller can still know readiness was reached even when this call later THROWS instead of
 * returning (e.g. a retryable GitHub-rate-limit/lock-contention error surfacing from the post-readiness public-
 * surface publish below). The `true`/`false` return value alone cannot carry that signal across a throw.
 */
export async function reReviewStoredPullRequest(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  prNumber: number,
  previewPollAttempt?: number,
  options: { skipAiReview?: boolean; force?: boolean; onReachedReadiness?: () => void } = {},
): Promise<boolean> {
  const [repo, settings] = await Promise.all([
    getRepository(env, repoFullName),
    resolveRepositorySettings(env, repoFullName),
  ]);
  let pr = await getPullRequest(env, repoFullName, prNumber);
  if (!pr || pr.state !== "open") return false;
  const automationBotSkipEnabled = resolveSkipAutomationBotPullRequests(
    isSkipAutomationBotPullRequestsEnabledGlobally(env),
    settings.skipAutomationBotAuthors,
  );
  const storedHeadShaBeforeResync = pr.headSha;
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
    return false;
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
  // Actorless re-entry paths may only skip a known bot-authored PR after the live-head resync proves the stored
  // row was already current. If the live fetch fails, or if the live head drifted (the dropped-synchronize case
  // this resync exists to recover), fail open into the full review/gate instead of trusting the immutable author.
  if (
    automationBotSkipEnabled &&
    isTrustedAutomationBotAuthor(pr.authorLogin) &&
    live?.head?.sha === storedHeadShaBeforeResync
  )
    return false;
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
    return false;
  // Fire BEFORE any further (throwable) work below -- this is the one instant readiness is confirmed, so a
  // caller learns it even if this call goes on to THROW instead of returning (see the JSDoc above).
  options.onReachedReadiness?.();
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
    settings,
  );
  const advisory = buildPullRequestAdvisory(repo, pr, {
    otherOpenPullRequests,
    requireLinkedIssue: shouldCollectLinkedIssueEvidence(settings),
    duplicateWinnerEnabled: resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode),
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
  return true;
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
  // 2) wait for CI to finish before running the LoopOver review. Required contexts still define which failures
  // block/close, but hasPending tracks any visible non-bot CI that is not settled yet.
  const ci = await cachedLiveCiAggregate(env, {
    repoFullName,
    facts: liveFacts,
    prNumber: pr.number,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    token,
    expectedCiContexts: settings.expectedCiContexts,
    advisoryCheckRuns: settings.advisoryCheckRuns,
    admissionKey,
  }).catch(() => undefined);
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
        actor: "loopover",
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
        actor: "loopover",
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
      "loopover",
      CI_STUCK_FINALIZE_GUARD_EVENT_TYPE,
      guardTargetKey,
      new Date(Date.now() - CI_STUCK_FINALIZE_GUARD_LOOKBACK_MS).toISOString(),
    );
    if (alreadyFinalizedForSha >= CI_STUCK_FINALIZE_MAX_PER_SHA) {
      await recordAuditEvent(env, {
        eventType: "github_app.review_deferred_ci_pending",
        actor: "loopover",
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "queued",
        detail: "CI still stuck pending, but already finalized once for this head SHA — deferring again instead of re-spending a review",
        metadata: { deliveryId, repoFullName, headSha: pr.headSha },
      }).catch(() => undefined);
      // level:"error" is deliberate, not a code failure: this line only fires once the guard above already
      // stopped the wasteful re-review, so its OWN existence is the operator-visible signal (via the structured
      // log → Sentry forwarder, forwardStructuredLogToSentry) that a PR's CI has been permanently stuck long
      // enough to need a human — the same "surface an anomaly at error level" convention selfhost_ai_provider_
      // failed / selfhost_ai_providers_exhausted already use in src/selfhost/ai.ts. Rate-limited to once per
      // (repo, pr, headSha) per day (#4998) — the defer above still runs on every evaluation; only the log is
      // coalesced, so one permanently-stuck PR doesn't flood Sentry with hundreds of copies of the same signal.
      if (!(await ciStuckRepeatLogCoalesced(env, repoFullName, pr.number, pr.headSha))) {
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
      }
      return false;
    }
    await recordAuditEvent(env, {
      eventType: "github_app.review_finalized_ci_stuck",
      actor: "loopover",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail:
        "CI stuck pending past the staleness cap — finalizing so the PR is surfaced, not silently deferred forever",
      metadata: { deliveryId, repoFullName },
    }).catch(() => undefined);
    await recordAuditEvent(env, {
      eventType: CI_STUCK_FINALIZE_GUARD_EVENT_TYPE,
      actor: "loopover",
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

// #4998: the ci_stuck_review_repeat_suppressed log below announces ONE thing (this PR has been stuck long enough
// that a human should look) -- but the guard it reports on re-fires on EVERY later evaluation of a PR still
// stuck on the same head SHA (a webhook re-trigger, a sweep pass), which flooded Sentry (650 events over 4 days
// for a single PR). Rate-limits the LOG only, once per (repo, pr, headSha) per day -- the underlying suppression
// (the guard immediately above the log call) is untouched and still runs every time.
const CI_STUCK_REPEAT_LOG_WINDOW_SECONDS = 24 * 60 * 60;

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

/** True when the ci_stuck_review_repeat_suppressed log for this exact (repo, pr, headSha) already fired within
 *  the window -- caller should skip logging (but still perform the actual defer). A missing/unavailable
 *  transient cache degrades to "never coalesced" (every call logs, matching the pre-#4998 behavior) rather than
 *  risk silently dropping the one operator-visible signal that a PR is stuck. */
async function ciStuckRepeatLogCoalesced(
  env: Env,
  repoFullName: string,
  prNumber: number,
  headSha: string,
): Promise<boolean> {
  const key = `ci-stuck-repeat-log:${repoFullName.toLowerCase()}#${prNumber}:${headSha}`;
  // getTransientKey/putTransientKey are already internally fail-safe (never throw), so no outer try/catch here.
  if (await getTransientKey(env, key)) return true;
  await putTransientKey(env, key, "1", CI_STUCK_REPEAT_LOG_WINDOW_SECONDS);
  return false;
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
      actor: "loopover",
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
    actor: "loopover",
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
// review time, re-review after this delay to re-capture the AFTER shot. The actual attempt CAP
// (MAX_PREVIEW_POLL_ATTEMPTS) now lives in preview-poll-budget.ts and is enforced INSIDE buildCapture itself,
// durably per head SHA across every trigger (#6323) -- this local scheduling check below is a harmless,
// now-redundant secondary bound for the dedicated self-poll job chain specifically; it stays for defense in
// depth but is no longer the thing that actually stops a never-resolving preview from polling forever.
const PREVIEW_POLL_SECONDS = 90;

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
      // #5385-sentry (GITTENSORY-1D): keyed by the sibling's CURRENT head SHA (not just its number) and held for
      // a much longer cooldown than the 60s CI-completion-burst window CI_COALESCE_WINDOW_SECONDS was designed
      // for -- a repeat over-cap discovery for an UNCHANGED head within the cooldown has nothing new to learn
      // from a fresh full re-review; a new commit changes the head SHA and naturally resets the guard, mirroring
      // the identical "a new commit resets the CI-stuck-finalize guard" idiom used above (#orb-ci-stuck-repeat).
      // Without this, a contributor who repeatedly opens (and has auto-closed) near-duplicate PRs re-triggers
      // THIS sibling's full review/gate republish every time the cap is recomputed, even though nothing about
      // the sibling itself changed -- confirmed live: one PR published 27 redundant review surfaces in 2 hours
      // this way, driven entirely by a different PR's open/close churn. Fail open to the tighter, headSha-less
      // key on a lookup miss (PR not found locally) rather than skip the wake outright.
      const sibling = await getPullRequest(env, repoFullName, prNumber).catch(() => null);
      const key = sibling?.headSha
        ? `contributor-cap-wake:${repoFullName.toLowerCase()}#${prNumber}#${sibling.headSha}`
        : `contributor-cap-wake:${repoFullName.toLowerCase()}#${prNumber}`;
      const cooldownSeconds = sibling?.headSha ? Math.round(AI_REVIEW_NON_CACHEABLE_RETRY_COOLDOWN_MS / 1000) : CI_COALESCE_WINDOW_SECONDS;
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
      await putTransientKey(env, key, "1", cooldownSeconds);
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
        actor: "loopover",
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
  // #5385: mirrors sweepRepoRegate's own gate exactly -- a repo with acting autonomy configured but NOT in the
  // LOOPOVER_REVIEW_REPOS allowlist (e.g. removed during a rollback, or a self-hoster who configured autonomy
  // without also updating the env allowlist) used to silently never wake affected PRs here, leaving a stale
  // type label (or any other issue-driven verdict) until the sweep eventually reached it, cycles later.
  // Short-circuited deliberately: resolveRepositorySettings does a live manifest fetch, so the allowlisted
  // common case (this repo is already in LOOPOVER_REVIEW_REPOS) must never pay for it -- this handler's own
  // doc comment promises "never doing the expensive live re-review inline", and that includes this gate check.
  if (isConvergenceRepoAllowed(env, repoFullName) || isAgentConfigured((await resolveRepositorySettings(env, repoFullName)).autonomy)) {
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

export async function repairDataFidelity(
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
  // #5020: cache hygiene for cached labels/issues/PRs has nothing to do with subnet economics -- scope to
  // repos this instance actually operates on (isInstalled), matching #5021's retarget of the underlying
  // backfill job this function dispatches.
  const registeredRepos = repositories.filter((repo) => repo.isInstalled);
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

export async function buildContributorEvidence(
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

export async function buildBurdenForecasts(
  env: Env,
  repoFullName?: string,
): Promise<void> {
  // Burden forecasting is generic repo-health forecasting, unrelated to subnet economics -- it should
  // cover every repo this instance operates on (isInstalled), not just gittensor-subnet-registered ones
  // (isRegistered), so a self-host operator's installed-but-unregistered repos aren't left with zero
  // coverage (#5022, part of the isRegistered->isInstalled untangling epic #5016).
  const repositories = (await listRepositories(env)).filter(
    (repo) =>
      repo.isInstalled && (!repoFullName || repo.fullName === repoFullName),
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

// The per-repo contributor-cap live-verification (#2270 busy-repo bypass fix) walks a fixed-size author-scoped
// sibling sample. An author with many open PRs would otherwise fire too many concurrent
// fetchLivePullRequestState calls from a single webhook, and the delivery-order-guard wake below can re-trigger
// this same check for over-cap siblings. Every sampled entry must still be verified, so this bounds concurrency
// via mapWithConcurrency in addition to the repository query's total row cap.
const CONTRIBUTOR_CAP_LIVE_CHECK_CONCURRENCY = 10;

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
    if (globalCap !== null) {
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
              authorLogin,
              moderationSettings: { moderationGateMode: settings.moderationGateMode, moderationRules: settings.moderationRules, moderationWarningLabel: settings.moderationWarningLabel, moderationBannedLabel: settings.moderationBannedLabel },
            },
            planned,
          );
        }
        return;
      }
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
        authorLogin,
        moderationSettings: { moderationGateMode: settings.moderationGateMode, moderationRules: settings.moderationRules, moderationWarningLabel: settings.moderationWarningLabel, moderationBannedLabel: settings.moderationBannedLabel },
      },
      planned,
    );
  }
}

/**
 * Handles the `installation` webhook's `deleted` action: marks the installation deleted and acks the
 * delivery. Returns `true` when handled (the caller must return immediately without further processing),
 * `false` otherwise. Extracted from processGitHubWebhook (#4607) — pure code motion, no behavior change.
 */
async function maybeHandleInstallationDeletedWebhookEvent(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
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
    return true;
  }
  return false;
}

/**
 * Dual-app safety (#selfhost-app-id): acks and skips a delivery whose installation belongs to a DIFFERENT
 * loopover App than this backend's own (cloud + self-host installed on the same account), so neither
 * backend acts on the other's installation. Returns `true` when handled (the caller must return
 * immediately), `false` otherwise. Extracted from processGitHubWebhook (#4607) — pure code motion, no
 * behavior change.
 */
async function maybeHandleForeignAppInstallationWebhookEvent(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
  installationAppId: number | null,
): Promise<boolean> {
  // Dual-app safety (#selfhost-app-id): if this delivery's installation belongs to a DIFFERENT loopover App
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
    return true;
  }
  return false;
}

/**
 * Handles a `repository` webhook with `action: "renamed"`: migrates the repo's identity forward across
 * every structural repo-identity column (see repo-identity-rename.ts) BEFORE the caller's normal
 * upsertRepositoryFromGitHub(payload.repository) runs, so that upsert correctly UPDATEs the now-renamed
 * anchor row instead of inserting a fresh, disconnected duplicate. A no-op (and safely so) for any other
 * event/action, for a payload missing the old-name field, or when the old and new names are identical
 * (e.g. a case-only GitHub-side normalization with nothing to migrate).
 */
async function maybeHandleRepositoryRenamedWebhookEvent(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<void> {
  if (eventName !== "repository" || payload.action !== "renamed") return;
  const oldName = payload.changes?.repository?.name?.from;
  const newFullName = payload.repository?.full_name;
  if (!oldName || !newFullName) return;
  const owner = payload.repository?.owner?.login ?? repoParts(newFullName).owner;
  const oldFullName = `${owner}/${oldName}`;
  if (oldFullName === newFullName) return;
  await renameRepositoryIdentity(env, oldFullName, newFullName);
  await recordAuditEvent(env, {
    eventType: "github_app.repository_renamed",
    actor: "loopover",
    targetKey: newFullName,
    outcome: "completed",
    detail: `repository identity migrated from ${oldFullName} to ${newFullName}`,
    metadata: { oldFullName, newFullName },
  });
  await maybeWarnOnMissingLocalConfigAfterRename(env, oldFullName, newFullName);
}

/**
 * #repo-rename-migration (self-host follow-up): the ONE piece of a rename that renameRepositoryIdentity
 * cannot fix on its own -- a self-host operator's container-private per-repo config folder
 * (LOOPOVER_REPO_CONFIG_DIR/{owner}__{repo}/...), which the app can only READ (the mount is read-only)
 * and which private-config.ts derives from the repo's CURRENT name. If one existed under the old name but
 * not the new one, the operator's gate/autonomy/review policy for this repo just silently reverted to
 * global defaults -- loud enough to reach Sentry (level:"error"), not a routine info line, because the
 * failure mode is exactly "reviews quietly stop matching what the operator configured," not a crash.
 * A cloud deployment (no local reader registered) always resolves both sides false, so this never fires there.
 */
async function maybeWarnOnMissingLocalConfigAfterRename(env: Env, oldFullName: string, newFullName: string): Promise<void> {
  const [hadOldLocalConfig, hasNewLocalConfig] = await Promise.all([hasLocalManifest(oldFullName), hasLocalManifest(newFullName)]);
  if (!hadOldLocalConfig || hasNewLocalConfig) return;
  await recordAuditEvent(env, {
    eventType: "selfhost.repo_rename_local_config_missing",
    actor: "loopover",
    targetKey: newFullName,
    outcome: "denied",
    detail: `${oldFullName} had a container-private per-repo config folder, but ${newFullName} does not -- the operator's gate/autonomy/review policy for this repo has silently reverted to defaults. Rename or copy the config folder on the host to match the new repo name.`,
    metadata: { oldFullName, newFullName },
  });
  console.error(
    JSON.stringify({
      level: "error",
      event: "selfhost_repo_rename_local_config_missing",
      oldFullName,
      newFullName,
    }),
  );
}

/**
 * Handles the `installation_repositories` webhook event: upserts added repos, marks removed repos, and
 * records product-usage telemetry for both. Extracted from processGitHubWebhook (#4607) — pure code
 * motion, no behavior change.
 */
async function handleInstallationRepositoriesWebhookEvent(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
  installationActor: string | undefined,
): Promise<void> {
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
            /* v8 ignore next -- defensive: the enclosing `if` above already requires payload.installation?.id truthy to reach this block, so the ternary's `repoFullName` fallback arm is unreachable via any real invocation. */
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
            /* v8 ignore next -- defensive: the enclosing `if` above already requires payload.installation?.id truthy to reach this block, so the ternary's `repoFullName` fallback arm is unreachable via any real invocation. */
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
}

/**
 * Handles the `installation` webhook's `created` action: records product-usage telemetry for the newly
 * installed repos. Extracted from processGitHubWebhook (#4607) — pure code motion, no behavior change.
 */
async function handleInstallationCreatedWebhookEvent(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
  installationActor: string | undefined,
): Promise<void> {
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
}

/**
 * Handles the `reaction` webhook event via the agent-command-feedback-reaction pipeline. Returns `true`
 * when handled (the caller must return immediately), `false` otherwise. Extracted from
 * processGitHubWebhook (#4607) — pure code motion, no behavior change.
 */
async function maybeHandleReactionWebhookEvent(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
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
    return true;
  }
  return false;
}

/**
 * Handles the `issue_comment` webhook event's command/mention dispatch chain — panel retrigger, panel
 * generate-tests, gate-override, resolve/explain/generate-tests/review/pause/resume/configuration/plan
 * mention commands, review-nag cooldown throttling, monitored-mention throttling, and the general
 * @loopover mention command — in the SAME priority order as before, stopping at the first handler that
 * claims the comment. Returns `true` when any handler claimed it (the caller must return immediately),
 * `false` otherwise. Extracted from processGitHubWebhook (#4607) — pure code motion, no behavior change;
 * every branch, condition, and comment is preserved verbatim and in the same order.
 */
async function maybeHandleIssueCommentCommandWebhookEvent(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
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
    return true;
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
    return true;
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
    return true;
  }

  if (eventName === "issue_comment" && (await maybeProcessResolveCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return true; }
  if (eventName === "issue_comment" && (await maybeProcessExplainCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return true; }
  if (eventName === "issue_comment" && (await maybeProcessGenerateTestsCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return true; }
  if (eventName === "issue_comment" && (await maybeProcessReviewCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return true; }
  if (eventName === "issue_comment" && (await maybeProcessPauseCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return true; }
  if (eventName === "issue_comment" && (await maybeProcessResumeCommand(env, deliveryId, payload))) { await recordWebhookEvent(env, { deliveryId, eventName, action: payload.action, installationId: payload.installation?.id, repositoryFullName: payload.repository?.full_name, payloadHash: "processed", status: "processed" }); return true; }
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
    return true;
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
    return true;
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
    return true;
  }

  // Maintainer-mention nag moderation (#label-scoping): independent of the @loopover ping above — a
  // mention of a configured maintainer login is never a bot command, so this must run regardless of whether
  // the comment also contains an @loopover mention/command.
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
    return true;
  }

  if (
    eventName === "issue_comment" &&
    (await maybeProcessLoopOverMentionCommand(env, deliveryId, payload))
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
    return true;
  }
  return false;
}

/** CI-run cancellation on a draft conversion (#6670, anti-abuse/resource-waste): a PR converted to draft
 *  stops burning CI minutes on whatever was already queued/in-progress for its current head SHA, mirroring
 *  the contributor_cap/blacklist close-time cancellation in agent-action-executor.ts (#2462/#6659) --
 *  duplicated rather than shared because this fires on the webhook path itself, before any planner/executor
 *  action exists to hang the cancel off of. Respects the same global-freeze/agentPaused/dry-run mode every
 *  other mutating action in this file respects (#2130 follow-up: "this close path previously bypassed
 *  pause/freeze/dry-run entirely" in review-evasion.ts is exactly the bug class a real GitHub-mutating
 *  side effect here must not reintroduce) -- a paused/frozen/dry-run install records what WOULD have been
 *  cancelled instead of actually calling the Actions API. Never throws -- every recordAuditEvent call is
 *  best-effort (`.catch(() => undefined)`), since a failure to WRITE the audit record must not affect the
 *  rest of this webhook delivery's processing. */
async function recordDraftConversionCiCancelOutcome(env: Env, installationId: number, repoFullName: string, pullNumber: number, headSha: string, settings: RepositorySettings): Promise<void> {
  const targetKey = `${repoFullName}#${pullNumber}`;
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
  if (mode !== "live") {
    await recordAuditEvent(env, {
      eventType: "github_app.draft_convert_ci_cancel_skipped",
      actor: "loopover",
      targetKey,
      outcome: "completed",
      detail: `dry-run: would cancel in-flight CI for headSha ${headSha}`,
      metadata: { repoFullName, headSha, mode },
    }).catch(() => undefined);
    return;
  }
  const outcome = await cancelInFlightWorkflowRunsForHeadSha(env, installationId, repoFullName, headSha, pullNumber);
  if (outcome.kind === "cancelled") {
    const detail = `cancelled ${outcome.cancelledCount} of ${outcome.totalFound} in-flight workflow run(s)`;
    await recordAuditEvent(env, {
      eventType: "github_app.draft_convert_ci_cancelled",
      actor: "loopover",
      targetKey,
      outcome: "completed",
      detail,
      metadata: { repoFullName, headSha, cancelledCount: outcome.cancelledCount, totalFound: outcome.totalFound },
    }).catch(() => undefined);
    return;
  }
  const eventType = outcome.kind === "permission_missing" ? "github_app.draft_convert_ci_cancel_permission_missing" : "github_app.draft_convert_ci_cancel_failed";
  await recordAuditEvent(env, { eventType, actor: "loopover", targetKey, outcome: "error", detail: outcome.warning, metadata: { repoFullName, headSha, reason: outcome.kind } }).catch(() => undefined);
}

/**
 * Handles a webhook payload that carries a `pull_request` object: PR-outcome/reversal signal recording,
 * reviews-cache invalidation, mergeable-state cache invalidation, review-evasion-tracking invalidation,
 * one-shot reopen-reclose enforcement, draft-dodge / review-evasion (draft-conversion, repeated-cycling)
 * enforcement, the readiness → gate → auto-maintain pipeline, reputation recording, and RAG /
 * sibling-regate enqueueing. Returns `true` when the caller (processGitHubWebhook) must return
 * immediately — currently only the one-shot disallowed-reopen reclose path — `false` otherwise (fall
 * through to issue handling, matching the original control flow). Extracted from processGitHubWebhook
 * (#4607) — pure code motion, no behavior change; every branch, condition, and comment is preserved
 * verbatim and in the same order.
 */
async function handlePullRequestWebhookEvent(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
  installationId: number | null,
): Promise<boolean> {
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
      /* v8 ignore next -- best-effort: invalidatePrStateCache never rejects against a healthy D1, and a cache-invalidation failure here must never block the webhook. */
      await invalidatePrStateCache(env, repoFullName, pr.number).catch(() => undefined);
    }
    // Review-evasion protection (#review-evasion-protection): a head change (synchronize) invalidates any
    // active-review tracking for the OLD head immediately -- a fresh pass starts its own tracking later in
    // this same handler. Best-effort; the guarded CAS update is a safe no-op when nothing is active. The
    // "closed" case is handled AFTER the self-close/converted_to_draft evasion checks below, not here --
    // those checks must read the row before this general cleanup would otherwise clear it out from under
    // them.
    if (eventName === "pull_request" && payload.action === "synchronize") {
      /* v8 ignore next -- best-effort: the guarded CAS update never rejects against a healthy D1, and a cleanup failure here must never block the webhook. */
      await terminalizeActiveReviewTracking(env, repoFullName, pr.number).catch(() => undefined);
    }
    // Reopen-prevention (#one-shot-reopen): a CONTRIBUTOR may not reopen a PR that loopover or a maintainer
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
      return true;
    }
    // Resolve settings first so the self-authored + open-reference live-fetch fallbacks only fire when their
    // respective gates are in block mode.
    const settings = await resolveRepositorySettings(env, repoFullName);
    // Waste elimination for known automation authors (settings/automation-bot-skip.ts): a PR/event genuinely
    // triggered by release-please's github-actions[bot], Renovate, or Dependabot never needs AI review, gate
    // evaluation, or a public-surface publish. Checked here (not earlier) because it needs `settings` for the
    // per-repo override, but BEFORE the expensive Promise.all/refreshPullRequestDetails/AI/gate work below --
    // isTrustedAutomationBotWebhookActor is the security-critical check (see its own doc comment): it verifies
    // the ACTOR WHO TRIGGERED THIS EVENT, not just the PR's stored author, so a human pushing to an existing
    // bot PR's branch still gets full review of their own commits.
    if (
      resolveSkipAutomationBotPullRequests(isSkipAutomationBotPullRequestsEnabledGlobally(env), settings.skipAutomationBotAuthors) &&
      isTrustedAutomationBotWebhookActor(payload.sender, pr.authorLogin)
    ) {
      await recordAuditEvent(env, {
        eventType: "github_app.automation_bot_pr_skipped",
        actor: payload.sender?.login ?? pr.authorLogin,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        detail: "skipped: known automation-bot author (release-please/Renovate/Dependabot)",
        metadata: { deliveryId, repoFullName, eventName, action: payload.action ?? null },
      }).catch((error) => {
        /* v8 ignore next -- best-effort: audit recording never blocks (or un-skips) the webhook. */
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "automation_bot_pr_skip_audit_failed",
            deliveryId,
            repository: repoFullName,
            error: errorMessage(error),
          }),
        );
      });
      await recordWebhookEvent(env, {
        deliveryId,
        eventName,
        action: payload.action,
        installationId: payload.installation?.id,
        repositoryFullName: payload.repository?.full_name,
        payloadHash: "processed",
        status: "processed",
      });
      return true;
    }
    // #7372: read BEFORE buildPullRequestAdvisory/persistAdvisory below overwrite "most recent" with THIS
    // pass's own fresh (visual-finding-less) advisory row -- the advisories table has no separate "current"
    // column, so reading late would always see this pass's own bookkeeping write instead of the real prior
    // review pass's recorded visual_unrelated_issue_finding. Gated on `closed` (the only action
    // maybePostVisualFollowupComment ever fires for) so every other action skips this read entirely.
    const [repo, cachedOtherOpenPullRequests, { linkedIssueAuthorLogins, confirmedNoOpenLinkedIssue }, priorAdvisoryForVisualFollowup] =
      await Promise.all([
        getRepository(env, repoFullName),
        listOtherOpenPullRequests(env, repoFullName, pr.number),
        resolveLinkedIssueAdvisoryContext(env, installationId, repoFullName, pr.linkedIssues, settings),
        payload.action === "closed" && installationId ? getLatestAdvisoryForPullRequest(env, repoFullName, pr.number) : Promise.resolve(null),
      ]);
    // #dup-winner / audit #15: drop any cached-open duplicate sibling already closed on GitHub before the
    // advisory (and the disposition) elect the cluster winner, so the real lowest-OPEN PR is never auto-closed.
    const otherOpenPullRequests = await reconcileLiveDuplicateSiblings(
      env,
      installationId,
      repoFullName,
      pr,
      cachedOtherOpenPullRequests,
      settings,
    );
    const advisory = buildPullRequestAdvisory(repo, pr, {
      otherOpenPullRequests,
      requireLinkedIssue: shouldCollectLinkedIssueEvidence(settings),
      duplicateWinnerEnabled: resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode),
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
      actionMode: await resolveRepoActionMode(env, settings),
    });
    // Review-evasion protection (#review-evasion-protection): a contributor closing their OWN PR while
    // loopover has an ACTIVE review pass running is dodging the one-shot review, not making an ordinary
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
    // PR-closed maintainer-notify follow-up (#7372, review.visual.bugAnalysisNotify): fires on EITHER a
    // genuine merge OR an ordinary close -- unlike maybeEnqueueSiblingRegateForMergedPr above, this is NOT
    // merge-only, since an "unrelated" visual finding is just as real and just as easy to lose track of
    // either way. Independent of every review-evasion/draft-dodge guard around it; those enforce close
    // POLICY, this just makes sure an already-recorded advisory finding gets one last chance to be seen.
    if (payload.action === "closed" && installationId) {
      await maybePostVisualFollowupComment(env, installationId, repoFullName, pr.number, priorAdvisoryForVisualFollowup);
    }
    // Draft-dodge guard (#converted-to-draft): a contributor converting an OPEN PR to draft cannot use
    // draft state to keep a gate-rejected PR alive. When a prior gate failure exists for the PR's current
    // headSha (and the block has not been maintainer-overridden), close the PR immediately — the gate
    // verdict stands and does not reset on draft conversion. Skipped when the agent is unconfigured and for
    // owner / automation PRs. Pause/freeze/dry-run are enforced inside evaluateCloseEnforcementGate (same as
    // the other 4 close-enforcement guards) so a paused stand-down is audited (#6604), not silently skipped.
    if (
      payload.action === "converted_to_draft" &&
      installationId &&
      pr.headSha &&
      pr.state === "open" &&
      isAgentConfigured(settings.autonomy) &&
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
    // Draft-PR close policy (#draft-pr-close-policy): opt-in, off by default -- distinct from the two review-
    // evasion guards above, which only enforce once a review has already run against this head. Fires on
    // EITHER trigger for a draft PR: opened directly as a draft, or converted to draft after opening --
    // closing it before any review pass gets a chance to run at all, so a contributor can't farm bot labels/
    // AI-review/CI feedback from a PR that never reaches a real one-shot disposition. Placed after both
    // review-evasion draft guards above so a PR already closed by either of them fails this guard's own
    // freshness re-check instead of being redundantly re-closed (same ordering rationale as the
    // repeated-cycling guard below).
    if ((payload.action === "opened" || payload.action === "converted_to_draft") && installationId && pr.isDraft) {
      await maybeCloseDraftPr(
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
        ? await bumpPullRequestDraftConversionCount(env, repoFullName, pr.number, deliveryId).catch(
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
    // CI-run cancellation on a draft conversion (#6670, resource-waste): converting an already-open PR to
    // draft stops burning CI minutes on whatever GitHub Actions already queued for its current head SHA --
    // unconditional (no config toggle), fires regardless of whether any of the review-evasion guards above
    // also acted, and independent of pr.state (a PR the guards above just closed still had CI queued for
    // its head SHA the moment this webhook fired, so the cancel is still worth attempting). Best-effort:
    // cancelInFlightWorkflowRunsForHeadSha never throws, so a missing actions:write grant never affects the
    // rest of this webhook delivery's processing.
    if (payload.action === "converted_to_draft" && installationId && pr.headSha) {
      await recordDraftConversionCiCancelOutcome(env, installationId, repoFullName, pr.number, pr.headSha, settings);
    }
    // Review-evasion protection: the "closed" half of the active-review-tracking cleanup (the
    // "synchronize" half runs earlier, alongside invalidatePrStateCache). Deliberately placed AFTER the
    // self-close-evasion check above so that check reads the tracking row before this general cleanup
    // would otherwise clear it out from under it -- a normal close and this repo's own evasion-enforcement
    // close (which already terminalizes internally, scoped to its own head) both land here too; the
    // guarded CAS update is a safe no-op in both of those already-terminal cases.
    if (eventName === "pull_request" && payload.action === "closed") {
      /* v8 ignore next -- best-effort: the guarded CAS update never rejects against a healthy D1, and a cleanup failure here must never block the webhook. */
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
                eventName,
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
      // Reputation (convergence, flag-gated by LOOPOVER_REVIEW_REPUTATION). After the gate decides, record this
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
      // RAG incremental index (convergence, flag-gated by LOOPOVER_REVIEW_RAG + the per-repo cutover allowlist).
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
  return false;
}

/**
 * Handles a webhook payload that carries a non-PR `issue` object: issue advisory persistence, issue-side
 * slop triage, account-age visibility labeling, the per-contributor open-issue cap, and (#699 path B)
 * detecting issue-watch notification events for a newly opened issue. Returns the detected issue-watch
 * notification events (empty when the payload doesn't carry a qualifying issue, or the issue wasn't just
 * opened), matching the original `issueWatchEvents` local's lifecycle exactly. Extracted from
 * processGitHubWebhook (#4607) — pure code motion, no behavior change.
 */
async function handleIssueWebhookEvent(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
  installationId: number | null,
): Promise<DetectedNotificationEvent[]> {
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
              globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
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
  return issueWatchEvents;
}

export async function processGitHubWebhook(
  env: Env,
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<void> {
  try {
    if (
      await maybeHandleInstallationDeletedWebhookEvent(env, deliveryId, eventName, payload)
    )
      return;

    const installationAppId = await upsertInstallation(env, payload);
    if (
      await maybeHandleForeignAppInstallationWebhookEvent(
        env,
        deliveryId,
        eventName,
        payload,
        installationAppId,
      )
    )
      return;
    const installationActor =
      payload.installation?.account?.login ??
      (payload.installation?.id
        ? (await getInstallation(env, payload.installation.id))?.accountLogin
        : undefined);
    await handleInstallationRepositoriesWebhookEvent(env, eventName, payload, installationActor);
    await handleInstallationCreatedWebhookEvent(env, eventName, payload, installationActor);
    // Must run BEFORE the upsertRepositoryFromGitHub(payload.repository) call just below: that upsert keys
    // on full_name, so renaming the anchor row first is what makes it an UPDATE instead of a fresh INSERT.
    await maybeHandleRepositoryRenamedWebhookEvent(env, eventName, payload);

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

    if (await maybeHandleReactionWebhookEvent(env, deliveryId, eventName, payload)) return;

    if (
      await maybeHandleIssueCommentCommandWebhookEvent(env, deliveryId, eventName, payload)
    )
      return;

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

    if (
      await handlePullRequestWebhookEvent(env, deliveryId, eventName, payload, installationId)
    )
      return;

    const issueWatchEvents = await handleIssueWebhookEvent(env, deliveryId, payload, installationId);

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

export async function shouldRefreshFilesForPreMergeChecks(
  env: Env,
  repoFullName: string,
): Promise<boolean> {
  const checks = resolveReviewPreMergeChecks(
    await loadRepoFocusManifest(env, repoFullName).catch(() => null),
  );
  return checks.some((check) => check.whenPaths.length > 0);
}

/** #one-shot-review-cadence: resolve the effective AI review re-trigger cadence. The per-repo
 *  `review.auto_review.cadence` manifest field (`configuredCadence`, already resolved by
 *  resolveReviewAutoReviewConfig) always wins when set; otherwise falls back to the operator's fleet-wide
 *  LOOPOVER_REVIEW_CONTINUOUS default. Both unset ⇒ "one_shot" — see AutoReviewConfig["cadence"]'s own doc
 *  comment for the full semantics. */
export function resolveAiReviewCadence(
  env: {
    LOOPOVER_REVIEW_CONTINUOUS?: string | undefined;
  },
  configuredCadence: AiReviewCadence | null,
): AiReviewCadence {
  if (configuredCadence !== null) return configuredCadence;
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_CONTINUOUS ?? "").trim())
    ? "continuous"
    : "one_shot";
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
    // Fail closed: if complete author history cannot be determined, report a non-first-timer profile
    // rather than an artificially clean one (#2266's RESERVED/INERT authorMergedPrCount/
    // authorClosedUnmergedPrCount counts still need a safe fallback here).
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

/** Resolve `review.visual` (#3609 preview.url_template / #3610 routes) for the before/after capture pipeline —
 *  a deterministic, non-AI feature, so it's resolved independently rather than reusing the AI-review manifest
 *  cache above. Fail-safe: a manifest-load error yields the empty defaults (byte-identical to no config
 *  configured), matching every other `resolveReview*` accessor's null-manifest behavior. */
export async function resolveVisualCaptureConfig(env: Env, repoFullName: string): Promise<VisualConfig> {
  const manifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  return resolveReviewVisualConfig(manifest);
}

/**
 * Safety secrets-scan (convergence, flag-gated by LOOPOVER_REVIEW_SAFETY). Scans the PR diff for leaked secrets and,
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
 * Screenshot-table gate advisory visibility (#2006 follow-up). `action: "close"` already communicates via its
 * own templated close comment (see planAgentMaintenanceActions/screenshotTableCloseMessage), so a violation
 * there never needs a SEPARATE advisory finding -- this only ever fires for `action: "advisory"`, which
 * previously had NO visible effect at all: the live gate's only other `evaluateScreenshotTableGate` call site
 * (`runAgentMaintenancePlanAndExecute`) discards the result entirely once `action !== "close"`. Mirrors
 * `maybeAddLockfileTamperFinding` immediately above: off/out-of-scope is free, a violation appends ONE
 * warning-severity, non-blocking finding (unrecognized by `isConfiguredGateBlocker`, so it can never gate),
 * and any evaluation error is swallowed so it can never destabilize the gate.
 */
export async function maybeAddScreenshotTableAdvisoryFinding(
  env: Env,
  args: {
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pullNumber: number;
    screenshotTableGateConfig: ScreenshotTableGateConfig;
    prBody: string | null | undefined;
    prLabels: string[];
    botCaptureSatisfied: boolean;
    files: Awaited<ReturnType<typeof listPullRequestFiles>> | null;
  },
): Promise<void> {
  if (!args.screenshotTableGateConfig.enabled || args.screenshotTableGateConfig.action !== "advisory") return;
  try {
    const files =
      args.files ??
      (await listPullRequestFiles(env, args.repoFullName, args.pullNumber));
    const result = evaluateScreenshotTableGate({
      config: args.screenshotTableGateConfig,
      prBody: args.prBody,
      prLabels: args.prLabels,
      changedFiles: files.map((file) => file.path),
      botCaptureSatisfied: args.botCaptureSatisfied,
    });
    if (!result.violated) return;
    const detail = result.reason ?? DEFAULT_SCREENSHOT_CONTRACT_MESSAGE;
    args.advisory.findings.push({
      code: "screenshot_table_missing",
      severity: "warning",
      title: "Missing before/after screenshot table",
      detail,
      action: "Add a before/after screenshot table to the pull request description (advisory only — this does not block merge).",
      publicText: detail,
    });
  } catch (error) {
    /* v8 ignore next -- fail-safe: an evaluation error never destabilizes the gate. */
    console.error(
      JSON.stringify({
        level: "error",
        event: "screenshot_table_advisory_scan_failed",
        repository: args.repoFullName,
        pullNumber: args.pullNumber,
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
    let result: Awaited<ReturnType<typeof runLoopOverLinkedIssueSatisfaction>>;
    if (cached) {
      result = { status: "ok", result: cached.result, estimatedNeurons: cached.estimatedNeurons };
      incr("loopover_linked_issue_satisfaction_cache_hit_total");
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
      incr("loopover_linked_issue_satisfaction_cache_miss_total");
      await recordAuditEvent(env, {
        eventType: "github_app.linked_issue_satisfaction_cache_miss",
        actor: args.author,
        targetKey: `${args.repoFullName}#${args.pr.number}`,
        outcome: "completed",
        detail: "no reusable stored linked-issue satisfaction assessment for this head+issue+fingerprint; running a fresh assessment",
        /* v8 ignore next -- reached only past this function's own `!args.advisory.headSha` early return, so headSha is always truthy here; the `?? null` is a type-level fallback for an unreachable branch. */
        metadata: { repoFullName: args.repoFullName, headSha: args.advisory.headSha ?? null, linkedIssueNumber: primaryIssueNumber },
      }).catch(() => undefined);
      result = await runLoopOverLinkedIssueSatisfaction(env, {
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
          incr("loopover_linked_issue_satisfaction_cache_write_error_total");
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
 * Map a PR's realized terminal state + the gate verdict to the {@link SubmissionOutcome} the reputation table
 * records — or `undefined` when there is no terminal signal to record yet. Pure + total; uses ONLY the PR
 * state / merged flag and the gate conclusion (no PR content):
 *   • merged (the webhook payload's merged_at, or the persisted mergedAt) → "merged" (ground-truth success).
 *   • closed without merge → "closed".
 *   • still open but the gate routed it to manual review (failure / action_required) → "manual".
 *   • still open and the gate did not flag it → undefined (no terminal outcome — nothing to record).
 * Internal-only; the result is never surfaced. Used only when LOOPOVER_REVIEW_REPUTATION is ON.
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
/** Label recorded for a self-host vision call when the provider reports no usage/model at all (e.g. a
 *  malformed/non-JSON response) -- mirrors the same static-fallback convention as the other advisory AI
 *  features (WORKERS_SLOP_MODELS et al.), since there is no per-repo config field for this binding's model. */
const SELF_HOST_VISION_MODEL_FALLBACK = "ollama:visual-vision";

async function runSelfHostVisualVision(
  env: Env,
  system: string,
  user: string,
  images: readonly AiContentBlock[],
): Promise<{ text: string | null; usage?: AiReviewActualUsage | undefined }> {
  const ai = env.AI_VISION as unknown as SelfHostVisionRunner | undefined;
  if (!ai || typeof ai.run !== "function") return { text: null };
  try {
    const result = await ai.run("visual-vision", {
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
    });
    const text = (result as { response?: string } | null)?.response?.trim() || null;
    return { text, usage: coerceAiUsage(result) };
  } catch {
    return { text: null };
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
    // title/body are OPTIONAL and only ever read when bugAnalysisEnabled is true (VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT
    // is the only prompt that uses PR context at all) -- a caller that doesn't pass them still gets the exact
    // same default-prompt behavior as before this field existed.
    pr: { number: number; title?: string | null | undefined; body?: string | null | undefined };
    author: string | null;
    confirmedContributor: boolean;
    settings: RepositorySettings;
    advisory: { findings: AdvisoryFinding[] };
    routes: readonly CaptureRoute[];
    // review.visual.bugAnalysis (config-as-code, resolved by the caller from resolveVisualCaptureConfig) --
    // absent/false ⇒ byte-identical to today: VISUAL_VISION_SYSTEM_PROMPT, no PR context, no "unrelated"
    // finding category ever produced. See visual-findings.ts's VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT doc comment
    // for why this is a separate prompt rather than an always-on superset.
    bugAnalysisEnabled?: boolean;
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
    // review.visual.bugAnalysis (config-as-code): swap in the PR-intent-aware, dual-category prompt + a
    // user-turn that also names the PR's own stated title/description. Absent/false ⇒ the exact same
    // VISUAL_VISION_SYSTEM_PROMPT/buildVisualVisionUserPrompt call every existing caller already makes.
    const visionSystemPrompt = args.bugAnalysisEnabled ? VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT : VISUAL_VISION_SYSTEM_PROMPT;
    const visionUserPrompt = args.bugAnalysisEnabled
      ? buildVisualBugAnalysisUserPrompt(visionGate.routes, { title: args.pr.title, body: args.pr.body })
      : buildVisualVisionUserPrompt(visionGate.routes);
    let visionText: string | null;
    let visionUsage: AiReviewActualUsage | undefined;
    if (visionProviderKey) {
      const visionResponse = await callAiProvider(visionProviderKey, visionSystemPrompt, visionUserPrompt, 600, images);
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
      const selfHostResult = await runSelfHostVisualVision(env, visionSystemPrompt, visionUserPrompt, images);
      visionText = selfHostResult.text;
      visionUsage = selfHostResult.usage;
      if (!visionText) {
        await recordVisualVisionUsage(env, args, null, "ok", "no usable output", visionUsage);
        return;
      }
    }
    const visionFindings = parseVisualVisionResponse(visionText);
    const findings = buildVisualRegressionFindings(visionFindings, args.routes);
    args.advisory.findings.push(...findings);
    await recordVisualVisionUsage(
      env,
      args,
      visionProviderKey,
      "ok",
      findings.length > 0 ? `advisory findings (${findings.length})` : "no usable output",
      visionUsage,
    );
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
  providerKey: { provider: string } | null,
  status: string,
  detail: string,
  usage?: AiReviewActualUsage | undefined,
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "visual_vision",
    actor: args.author ?? null,
    route: "github_app.visual_vision",
    model: providerKey ? `byok:${providerKey.provider}` : (usage?.model ?? SELF_HOST_VISION_MODEL_FALLBACK),
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
 * PR-closed maintainer-notify follow-up (#7372, review.visual.bugAnalysisNotify): when a PR closes (merged
 * OR not -- either outcome leaves the same unrelated-but-real issue behind, so this is not merge-only) and its
 * last recorded advisory (`priorAdvisory`, read by the caller BEFORE this same webhook pass's own
 * `buildPullRequestAdvisory`/`persistAdvisory` calls overwrite "most recent" -- see the call site's own
 * comment for why that ordering matters) carried at least one `visual_unrelated_issue_finding`, post a
 * standalone comment describing each one with its screenshot evidence, @-mentioning the configured (or
 * default-maintainer) notify list. Gated on `review.visual.bugAnalysis` being on for this repo -- off (the
 * default) means no unrelated finding was ever produced in the first place, so this is a cheap no-op for
 * every repo that hasn't opted in. `createOrUpdateVisualFollowupComment` is itself idempotent (its own
 * marker, create-or-update, byte-identical-body skip), so a retried "closed" delivery is a safe no-op rather
 * than a duplicate post. Best-effort: any failure here is logged and swallowed, never lets a comment-posting
 * error block or retry the rest of this webhook delivery.
 */
async function maybePostVisualFollowupComment(
  env: Env,
  installationId: number,
  repoFullName: string,
  pullNumber: number,
  priorAdvisory: { findings: AdvisoryFinding[] } | null,
): Promise<void> {
  try {
    if (!priorAdvisory || priorAdvisory.findings.length === 0) return;
    const visualConfig = await resolveVisualCaptureConfig(env, repoFullName);
    if (!visualConfig.bugAnalysis) return;
    const { owner } = repoParts(repoFullName);
    const notifyLogins = resolveVisualFollowupNotifyLogins(visualConfig.bugAnalysisNotify, owner, parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS));
    const body = buildVisualFollowupComment(priorAdvisory.findings, notifyLogins);
    if (!body) return;
    await createOrUpdateVisualFollowupComment(env, installationId, repoFullName, pullNumber, body);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "visual_followup_comment_error",
        repoFullName,
        pullNumber,
        message: errorMessage(error).slice(0, 200),
      }),
    );
  }
}

async function recordScreenshotTableVisionUsage(
  env: Env,
  args: { repoFullName: string; pr: { number: number }; author: string | null },
  providerKey: { provider: string } | null,
  status: string,
  detail: string,
  usage?: AiReviewActualUsage | undefined,
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "screenshot_table_vision",
    actor: args.author ?? null,
    route: "github_app.screenshot_table_vision",
    model: providerKey ? `byok:${providerKey.provider}` : (usage?.model ?? SELF_HOST_VISION_MODEL_FALLBACK),
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
 * Vision-verify a contributor-pasted screenshot-table's images (#4366, part of #4325): screenshot-table-gate.ts's
 * DETERMINISTIC check only verifies markdown STRUCTURE (a table exists with image-bearing cells), so a
 * contributor can satisfy it with two identical images or a screenshot unrelated to the stated change. This
 * adds that missing check on top, in the SAME two stages screenshot-table-vision.ts's header documents:
 * a free byte-identical pre-check (no AI) here, then a bounded AI-vision call for genuinely different pairs.
 * Gated on `settings.screenshotTableGate?.enabled` — this repo must already have opted into the deterministic
 * gate at all; there is no separate dedicated toggle, mirroring how #4111's sibling visual-vision check has no
 * config field of its own either (gated by AI_VISION/BYOK availability + the existing reputation/aiReviewAllAuthors
 * settings). STRICTLY ADVISORY, mirrors `runVisualVisionForAdvisory`'s exact shape (resolve reputation + BYOK,
 * gate, call, parse, mutate `args.advisory.findings`) so it can be exercised directly in tests. Never throws:
 * any failure (a broken image fetch, a provider error, an unparseable response) degrades to "no finding added".
 */
export async function runScreenshotTableVisionForAdvisory(
  env: Env,
  args: {
    mode: AgentActionMode;
    repoFullName: string;
    pr: { number: number };
    prBody: string | null | undefined;
    prTitle: string | null | undefined;
    author: string | null;
    confirmedContributor: boolean;
    settings: RepositorySettings;
    advisory: { findings: AdvisoryFinding[] };
  },
): Promise<void> {
  if (args.mode === "paused" || !args.settings.screenshotTableGate?.enabled) return;
  const rawPairs = extractTableRowImageUrls(args.prBody).filter((pair) => pair.every((url) => isSafeHttpUrl(url)));
  if (rawPairs.length === 0) return;
  try {
    const fetchedPairs: Array<{ before: AiContentBlock; after: AiContentBlock }> = [];
    const findings: AdvisoryFinding[] = [];
    for (const [rowIndex, [beforeUrl, afterUrl]] of rawPairs.slice(0, 2).entries()) {
      /* v8 ignore next -- defensive: rawPairs only contains rows with >=2 urls, so both slots exist here. */
      if (!beforeUrl || !afterUrl) continue;
      const [beforeBlock, afterBlock] = await Promise.all([
        fetchExternalScreenshotContentBlock(beforeUrl),
        fetchExternalScreenshotContentBlock(afterUrl),
      ]);
      if (!beforeBlock || !afterBlock) continue;
      /* v8 ignore next -- defensive: fetchShotContentBlock's only success return shape is {type:"image",...}. */
      if (beforeBlock.type !== "image" || afterBlock.type !== "image") continue;
      if (beforeBlock.data === afterBlock.data) {
        findings.push({
          code: SCREENSHOT_TABLE_VISION_FINDING_CODE,
          severity: "warning",
          title: `Possible screenshot-table issue: identical images (row ${rowIndex + 1})`,
          detail: "The before and after images for this row are byte-identical — this doesn't look like real before/after evidence.",
          action: "Advisory only — verify the screenshot-table images against the stated change before deciding.",
        });
        continue;
      }
      fetchedPairs.push({ before: beforeBlock, after: afterBlock });
    }
    if (fetchedPairs.length > 0) {
      const reputation = await getEffectiveSubmitterReputation(env, { repoFullName: args.repoFullName, submitter: args.author ?? undefined });
      const storedKey =
        args.confirmedContributor && args.settings.aiReviewByok
          ? await getDecryptedRepositoryAiKey(env, args.repoFullName)
          : null;
      const providerKey =
        storedKey && (!args.settings.aiReviewProvider || args.settings.aiReviewProvider === storedKey.provider)
          ? { provider: storedKey.provider, key: storedKey.key, model: args.settings.aiReviewModel ?? storedKey.model }
          : null;
      const selfHostVisionAllowed = args.confirmedContributor || args.settings.aiReviewAllAuthors;
      const selfHostVisionAvailable = selfHostVisionAllowed && Boolean(env.AI_VISION);
      const gate = evaluateScreenshotTableVisionGate({
        imagePairCount: fetchedPairs.length,
        reputationSignal: reputation.signal,
        providerKey,
        selfHostVisionAvailable,
      });
      if (gate.run) {
        const images: AiContentBlock[] = fetchedPairs
          .slice(0, gate.pairCount)
          .flatMap((pair) => [pair.before, pair.after]);
        const userPrompt = buildScreenshotTableVisionUserPrompt(args.prTitle, gate.pairCount);
        let visionText: string | null;
        let visionUsage: AiReviewActualUsage | undefined;
        if (providerKey) {
          const response = await callAiProvider(providerKey, SCREENSHOT_TABLE_VISION_SYSTEM_PROMPT, userPrompt, 400, images);
          visionText = response.text;
          visionUsage = response.usage;
          await recordScreenshotTableVisionUsage(
            env,
            args,
            providerKey,
            visionText ? "ok" : response.failure ? "error" : "ok",
            visionText ? `advisory findings check (${gate.pairCount} pairs)` : response.failure ? `provider failure: ${String(response.failure)}` : "no usable output",
            visionUsage,
          );
        } else {
          const selfHostResult = await runSelfHostVisualVision(env, SCREENSHOT_TABLE_VISION_SYSTEM_PROMPT, userPrompt, images);
          visionText = selfHostResult.text;
          visionUsage = selfHostResult.usage;
          await recordScreenshotTableVisionUsage(
            env,
            args,
            null,
            "ok",
            visionText ? `advisory findings check (${gate.pairCount} pairs)` : "no usable output",
            visionUsage,
          );
        }
        if (visionText) {
          const parsed = parseScreenshotTableVisionResponse(visionText, gate.pairCount);
          findings.push(...buildScreenshotTableVisionFindings(parsed));
        }
      }
    }
    if (findings.length > 0) args.advisory.findings.push(...findings);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "screenshot_table_vision_error",
        repoFullName: args.repoFullName,
        pull: args.pr.number,
        message: errorMessage(error).slice(0, 200),
      }),
    );
  }
}

/**
 * Resolve `manifest_missing_tests`' `passedValidationCount` signal (gate-review finding, #4719): a PR-body
 * validation-note match (`hasValidationNote`) is checked FIRST since it's free; only when that misses, AND
 * the manifest actually configured `testExpectations`, AND no test file changed does this consult the PR's
 * live CI state -- via the SAME `cachedLiveCiAggregate` the disposition/unified-comment already read this
 * pass from -- so a fully-green required CI rollup counts as evidence too. Without this, a fully-automated,
 * CI-green, docs-only regen PR (the #4719 false positive) fails this check merely because its templated
 * body never happens to contain a "tested"/"validated" word. `ciState === "passed"` already excludes
 * loopover's own Gate/Context check-runs (`BOT_OWNED_CHECK_NAMES`, github/backfill.ts), so this can never
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
    advisoryCheckRuns: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined;
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
  const liveCi = await cachedLiveCiAggregate(env, {
    repoFullName: args.repoFullName,
    facts: args.liveFacts,
    prNumber: args.prNumber,
    headSha: args.headSha,
    baseRef: args.baseRef,
    token,
    expectedCiContexts: args.expectedCiContexts,
    advisoryCheckRuns: args.advisoryCheckRuns,
    admissionKey,
  });
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

/**
 * Focus-manifest policy gate (#555, opt-in via `manifestPolicyGateMode`). Reloads the CACHED manifest (the
 * settings resolver discards the raw manifest, but loadRepoFocusManifest is cached so this is cheap),
 * recomputes the guidance over the PR's changed files, and pushes ONLY the three enforceable policy findings
 * onto the advisory so isConfiguredGateBlocker can block under `manifestPolicy: block`. Also runs the E2E
 * test-generation auto-trigger (#4196, part of the #4189 epic) — see the inline comments below for the full
 * rationale of each step. `manifestPolicyGateMode: "off"` (the default) is a no-op, so the advisory/gate
 * stays byte-identical to today. Extracted from maybePublishPrPublicSurface (#4607) — pure code motion;
 * every branch, condition, and comment is preserved verbatim and in the same order.
 */
async function maybeApplyManifestPolicyGate(
  env: Env,
  args: {
    repoFullName: string;
    installationId: number;
    pr: Awaited<ReturnType<typeof upsertPullRequestFromGitHub>>;
    repo: Awaited<ReturnType<typeof getRepository>>;
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    webhook: { liveFacts: LiveGithubFacts; deliveryId: string };
    gateFiles: Awaited<ReturnType<typeof listPullRequestFiles>> | null;
    author: string | null;
  },
): Promise<void> {
  // Focus-manifest policy (#555, opt-in via manifestPolicyGateMode). Reload the CACHED manifest (the
  // settings resolver discards the raw manifest, but loadRepoFocusManifest is cached so this is cheap),
  // recompute the guidance over the PR's changed files, and push ONLY the three enforceable policy
  // findings into the advisory so isConfiguredGateBlocker can block under manifestPolicy: block.
  if (args.settings.manifestPolicyGateMode !== "off") {
    // `gateFiles` is threaded in by the ONLY caller (maybePublishPrPublicSurface) already resolved via
    // getReviewFiles() whenever manifestPolicyGateMode is not "off" -- the same condition gating this whole
    // block -- so it is never actually null here; the `| null` on the parameter type exists only because the
    // caller's own local starts as `let gateFiles: ... | null = null` for TypeScript soundness before that
    // conditional assignment runs. The `?? []` fallback is unreachable on this webhook-integration path
    // (pre-existing on origin/main before this function was extracted from maybePublishPrPublicSurface, #4607).
    /* v8 ignore next -- see the comment above */
    const manifestFiles = args.gateFiles ?? [];
    const manifest = await loadRepoFocusManifest(env, args.repoFullName);
    const testFileCount = manifestFiles.filter((file) => isTestPath(file.path)).length;
    const passedValidationCount = await resolveManifestPassedValidationCount(env, {
      repoFullName: args.repoFullName,
      installationId: args.installationId,
      prNumber: args.pr.number,
      headSha: args.pr.headSha,
      baseRef: args.pr.baseRef ?? args.repo?.defaultBranch,
      body: args.pr.body,
      expectedCiContexts: args.settings.expectedCiContexts,
      advisoryCheckRuns: args.settings.advisoryCheckRuns,
      liveFacts: args.webhook.liveFacts,
      testExpectationsConfigured: manifest.testExpectations.length > 0,
      testFileCount,
    });
    const guidance = buildFocusManifestGuidance({
      manifest,
      changedPaths: manifestFiles.map((file) => file.path),
      labels: args.pr.labels,
      linkedIssueCount: args.pr.linkedIssues.length,
      testFileCount,
      passedValidationCount,
      hasNoIssueRationale: hasClearNoIssueRationale(args.pr),
      bodyObserved: args.pr.bodyObservedAt !== null,
    });
    const policyCodes = new Set([
      "manifest_linked_issue_required",
      "manifest_missing_tests",
    ]);
    // Keep deterministic manifest policy findings independent from AI-review eligibility: ignored authors
    // suppress review/public output only, never maintainer-configured gate blockers or their downstream triggers.
    const policyFindings = guidance.findings;
    // Computed once and reused below for the #4196 auto-trigger check -- same feature gate, one call. Also
    // feeds #4583's inline CTA so the missing-tests finding surfaces `@loopover generate-tests` right in
    // ORB's own comment (mirrors CodeRabbit's inline walkthrough checkbox) only when the command would
    // actually work for this repo, never as noise on a repo that hasn't opted in.
    const e2eTestGenAvailable = resolveConvergedFeature(env, manifest, "e2eTests", args.repoFullName);
    for (const finding of policyFindings) {
      if (!policyCodes.has(finding.code)) continue;
      args.advisory.findings.push(publicSafeManifestPolicyFinding(finding, { e2eTestGenAvailable }));
    }
    // E2E test-generation auto-trigger (#4196, part of the #4189 epic): promotes the deterministic
    // manifest_missing_tests finding above from advisory-only text into an actual trigger for #4192/#4194's
    // generation-and-render path -- additive to, never a replacement for, the explicit `@loopover
    // generate-tests` command (#4195), which stays available regardless of whether this signal fired.
    // Filters the SAME policyFindings just computed above rather than re-deriving "PR probably needs
    // tests" from scratch, per the issue's own requirement -- this is why the auto-trigger lives inside this
    // exact manifestPolicyGateMode-gated block instead of a parallel code path: that is the only place this
    // finding is computed at all today.
    // Deliberately gated by its OWN separate manifest toggle (review.e2e_test_auto_trigger) on top of
    // e2eTestGenAvailable -- enabling features.e2eTests only unlocks the maintainer-initiated command/checkbox
    // paths below; it must never, by itself, start firing generation unprompted on every under-tested PR. A
    // repo opts into the auto-trigger explicitly, in addition to the base feature.
    const e2eAutoTriggerOptedIn = resolveE2eTestAutoTriggerManifestToggle(manifest);
    if (args.pr.headSha && policyFindings.some((finding) => finding.code === "manifest_missing_tests") && e2eTestGenAvailable && e2eAutoTriggerOptedIn) {
      const e2eTargetKey = `${args.repoFullName}#${args.pr.number}`;
      // Double-generation guard: an unchanged head SHA re-entering this pass (a re-review/sweep tick, not a
      // new push) must never re-spend an LLM call or repost a duplicate suggestion. A genuinely NEW push
      // (a new head SHA) is always a fresh miss here regardless of how many prior SHAs already fired. The
      // explicit command deliberately does NOT consult this guard -- a maintainer typing the command always
      // gets a fresh generation, even on a SHA the auto-trigger already covered (simplicity over a cache that
      // would need its own invalidation rules; the daily neuron budget shared by both paths already bounds
      // the cost of a maintainer choosing to ask twice).
      const alreadyTriggered = await hasAuditEventForHeadSha(env, "github_app.e2e_tests_generation", e2eTargetKey, args.pr.headSha);
      if (!alreadyTriggered) {
        const e2eMode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: args.settings.agentPaused, agentDryRun: args.settings.agentDryRun });
        if (e2eMode === "live") {
          await runE2eTestGenerationAndDeliver(env, {
            repoFullName: args.repoFullName,
            installationId: args.installationId,
            pr: args.pr,
            settings: args.settings,
            manifest,
            files: manifestFiles,
            // No comment-invoker exists for an automated trigger -- the PR's own author is the closest
            // analogue to "who this generated test is for" (unlike the explicit command, where `actor` is
            // whoever typed the command).
            actor: args.author ?? "the PR author",
            mode: e2eMode,
            deliveryId: args.webhook.deliveryId,
            targetKey: e2eTargetKey,
            trigger: "auto",
          });
        } else {
          await recordGenerateTestsSkip(env, args.webhook.deliveryId, args.repoFullName, e2eTargetKey, args.author, e2eMode === "dry_run" ? "dry_run" : "agent_paused");
        }
      }
    }
  }
}

/** Logs + audits a deliberate type-label no-op (#regression-safe-propagation): every reason this fires means
 *  "labels are left exactly as they are this pass," never "labels were cleared." Shared by every reason the
 *  type-label block below skips a pass -- the outer typeLabelsEnabled/gittensor_only gate, a contended
 *  per-PR actuation lock, and an inconclusive propagation recheck -- so all of them log/audit identically
 *  instead of duplicating the same two calls at each skip site. */
async function logTypeLabelSkip(env: Env, repoFullName: string, pullNumber: number, reason: string): Promise<void> {
  console.log(
    JSON.stringify({ event: "type_label_decision", repoFullName, pull: pullNumber, applied: false, reason }),
  );
  await recordAuditEvent(env, {
    eventType: "github_app.type_label_decision",
    targetKey: `${repoFullName}#${pullNumber}`,
    outcome: "denied",
    detail: reason,
    metadata: { labels: [], source: null },
  }).catch(() => undefined);
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
    // #4818 follow-up: the GitHub webhook event name (`pull_request`, `pull_request_review`, …), distinct from
    // `action` above -- `action: "edited"` alone can't tell a `pull_request` title edit apart from a
    // `pull_request_review` comment edit, and only the type-label block needs this distinction (see
    // `PR_TYPE_LABEL_IRRELEVANT_EVENT_NAMES`). Omitted (sweep / manual-retrigger callers) is never in that
    // set, so those paths are unaffected.
    eventName?: string | undefined;
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
  // #4745: hoisted out of the try-block below (same reason/shape as confirmedContributor just above) so the
  // risk × value quadrant label -- built once the comment/panel builders are reached, further down and OUTSIDE
  // that try -- can reuse the ALREADY-computed slop band without a second buildSlopAssessment call. Stays null
  // exactly when slopRisk (the sibling hoisted-inside-the-try variable) does: shouldCollectSlopEvidence(settings)
  // resolving false this pass, in which case the quadrant degrades to showing nothing extra rather than
  // fabricating a risk reading (see formatRiskValueQuadrant's own doc comment).
  let slopBand: SlopBand | null = null;
  // Resolve the repo's action mode ONCE for the whole publish pass and thread it into every GitHub write below, so
  // a dry-run / pause / global-freeze publishes NOTHING (check-run, comment, label) — the gate verdict is still
  // computed + returned for the disposition logic, the writes are just suppressed + audited. (#dry-run-chokepoint)
  const mode = await resolveRepoActionMode(env, settings);
  // improvementSignal (#4744): the first real caller of #4738's activation wiring (epic #4737's config-as-code
  // foundation) -- nothing resolved this feature before this PR (see signals/improvement.ts's own header
  // comment). Gates BOTH the deterministic tier's own computation further below (which has no AI dependency
  // at all -- a paused repo, a non-reviewable author, or aiReviewMode: "off" still gets it) and, threaded
  // into runAiReviewForAdvisory, the LLM tier's prompt addition (#4743). loadRepoFocusManifest is cached, so
  // this second manifest resolution costs no extra fetch in the common case where something else already
  // resolved it this pass.
  const improvementSignalAllowed = await convergedFeatureActive(
    env,
    repoFullName,
    "improvementSignal",
  );
  // `settings` is the EFFECTIVE config (`.loopover.yml` > DB > defaults), resolved by the caller via
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
  // #one-shot-review-cadence: resolved once, up front, so all three AI dispatch sites below (slop,
  // linked-issue satisfaction, main review) see the same answer. An explicit maintainer retrigger
  // (forceAiReview, set by the PR-panel checkbox or a maintainer's `@loopover review`) always bypasses
  // one-shot mode regardless of cadence -- that is the whole point of "one-shot until you ask again."
  const oneShotCadenceActive =
    resolveAiReviewCadence(env, autoReviewConfig.cadence) === "one_shot" &&
    webhook.forceAiReview !== true;
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
  // #4818 follow-up: skip the recompute ENTIRELY (not merely the ambiguous branch) for a review-family
  // trigger -- it can't legitimately change the answer, and its embedded PR snapshot is exactly the class of
  // stale input that caused #4818. Nothing is lost, only deferred to the next pull_request-native event or the
  // periodic sweep (which reaches this same code with `eventName` unset, so it is never excluded). Computed
  // once and reused by both the gate below and the skip-reason ternary in the `else` branch, rather than
  // re-evaluating `webhook.eventName ?? ""` twice for the identical answer.
  const isReviewFamilyEvent = PR_TYPE_LABEL_IRRELEVANT_EVENT_NAMES.has(webhook.eventName ?? "");
  if (
    typeLabelsEnabled &&
    !settings.agentPaused &&
    decision.skipReason !== "miner_detection_unavailable" &&
    decision.skipReason !== "not_official_gittensor_miner" &&
    !isReviewFamilyEvent
  ) {
    // Per-PR mutual exclusion (#regression-safe-propagation, mirrors the agent-maintenance claim at #2129
    // below in maybeRunAgentMaintenance): a merge fans out into a BURST of near-simultaneous webhook
    // deliveries for the SAME PR -- the merge event itself, the linked issue's own auto-close, and even an
    // echo of THIS block's own label writes a moment earlier -- so a webhook re-review and a sweep-driven
    // agent-regate-pr job (or simply two overlapping webhook deliveries) can each reach this block
    // concurrently, each with its own independently-timed live linked-issue fetch. Confirmed in production:
    // a correct propagation_exclusive decision, followed within 30-90s by a second concurrent pass computing
    // a DIFFERENT (wrong) verdict that then overwrote the first. A losing pass must defer to the next tick,
    // never compute-and-act on a stale/racing verdict for a PR another pass is actively deciding for.
    const typeLabelLock = await claimPrActuationLock(env, repoFullName, pr.number);
    if (!typeLabelLock.acquired) {
      await logTypeLabelSkip(env, repoFullName, pr.number, "lock_contended");
    } else {
      try {
        // Same reasoning as `typeLabelsEnabled` above: `settings.typeLabels` is optional only for
        // RepositorySettings-fixture-construction backward compat -- getRepositorySettings always
        // resolves it to a concrete, complete PrTypeLabelSet (config-as-code only as of #6443 --
        // hardcoded to DEFAULT_TYPE_LABELS, never undefined), so the `?? DEFAULT_TYPE_LABELS` fallback
        // is unreachable on this webhook-integration path.
        /* v8 ignore next -- see the comment above */
        const typeLabels = settings.typeLabels ?? DEFAULT_TYPE_LABELS;
        const propagation = settings.linkedIssueLabelPropagation;
        // Caller-gated (mirrors shouldCollectLinkedIssueEvidence/resolveLinkedIssueHardRule's own
        // cheap-check-before-fetch precedent): zero extra GitHub calls when propagation is off, which
        // is the default -- a repo that never opts in pays nothing for this feature.
        const propagationResult =
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
                // #4818: lets the ambiguous "issue closed but THIS pass's own prMergedAt reads null" case
                // (a pull_request_review/_comment/_thread webhook whose embedded snapshot predates an
                // imminent merge, delayed behind other queued work) resolve via one fresh live check instead
                // of silently downgrading a correct label.
                prNumber: pr.number,
              })
            : { labels: [], inconclusive: false };
        // #regression-safe-propagation: an INCONCLUSIVE recheck (the linked issue's facts or the
        // maintainer-authored-issue permission check could not be verified this pass -- a transient GitHub
        // fetch/rate-limit failure, never a confirmed "no") must NEVER be treated the same as a confirmed
        // absence of propagation authority. Falling through to the title heuristic here would silently
        // downgrade/remove a real, previously-applied propagation label the moment ANY transient hiccup hits
        // this recheck -- exactly the bug #4528 was meant to close and didn't, because that fix only ever
        // covered the CONFIRMED-closed-by-this-merge case, not an unrelated fetch failure. Leave existing
        // labels untouched and defer; the next tick gets a fresh, hopefully-conclusive read.
        if (propagationResult.labels.length === 0 && propagationResult.inconclusive) {
          await logTypeLabelSkip(env, repoFullName, pr.number, "propagation_inconclusive");
        } else {
          const decisionResult = resolvePrTypeLabel({
            title: pr.title,
            linkedIssueLabels: propagationResult.labels,
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
            // label (deriveKindFromTitle only ever returns "bug"/"feature", and a built-in category always
            // falls back to its default rather than an empty string -- either DEFAULT_TYPE_LABELS directly
            // for the config-as-code-only DB base (#6443), or normalizeTypeLabelSet's own fallback for a
            // manifest override), and its
            // propagation sources only ever use a mapping's `prLabel`, which normalizeMapping drops
            // entirely when empty -- applyLabels can never be [] here.
            /* v8 ignore next */
            detail: `applied labels: ${decisionResult.applyLabels.join(", ") || "none"}`,
            metadata: { labels: decisionResult.applyLabels, source: decisionResult.source },
          }).catch(() => undefined);
        }
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
      } finally {
        await releasePrActuationLock(env, repoFullName, pr.number, typeLabelLock.ownerToken);
      }
    }
  } else {
    const skipReason = isReviewFamilyEvent
      ? "irrelevant_review_family_event"
      : settings.agentPaused
        ? "agent_paused"
        : decision.skipReason === "miner_detection_unavailable" || decision.skipReason === "not_official_gittensor_miner"
          ? decision.skipReason
          : "typeLabelsEnabled_false";
    await logTypeLabelSkip(env, repoFullName, pr.number, skipReason);
  }

  // Respect the per-repo agent pause: suppress all public surface mutations (label, comment, context
  // check run) so a paused repo sees no loopover-authored GitHub content. The review-agent check
  // run still posts so the required-check status is not broken (#agent-pause).
  if (settings.agentPaused)
    decision = {
      ...decision,
      willLabel: false,
      willComment: false,
      willCheckRun: false,
    };

  // #ops-review-burst: the LAST completed gate-check conclusion recorded for this EXACT head SHA, captured
  // BEFORE this pass writes anything -- recordPublishedGateCheckSummary upserts keyed on
  // [repoFullName, headSha, name], so a row only exists here at all if THIS SAME COMMIT was already
  // gate-checked before (a genuinely new commit has no prior row for its own headSha, and correctly falls
  // through to "changed" below). Read once, up front, so the later surfaceContentChanged comparison
  // compares against what was true before this pass, not a value this pass's own writes already overwrote.
  const priorGateCheckConclusion =
    gateEnabled && advisory.headSha
      ? await listCheckSummaries(env, repoFullName, pr.number)
          .then((checks) =>
            checks.find(
              (check) =>
                check.name === LOOPOVER_GATE_CHECK_NAME &&
                check.headSha === advisory.headSha &&
                check.status === "completed",
            ),
          )
          .then((check) => check?.conclusion)
          .catch(() => undefined)
      : undefined;
  // Set at whichever of this pass's gate-check publish sites actually fires, to the SAME conclusion value
  // passed to recordPublishedGateCheckSummary there -- compared against priorGateCheckConclusion above when
  // surfaceContentChanged is computed further down, instead of re-deriving (and risking drifting from) the
  // conclusion actually recorded.
  let finalGateCheckConclusion: string | null | undefined;
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
  // valueAssessment (#4743/#4744) follows the exact same cache-miss-only shape as inlineFindings/impactMap --
  // see runAiReviewForAdvisory's own return-type doc comment.
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
        valueAssessment?: { magnitude: ImprovementMagnitude; rationale: string } | undefined;
      }
    | undefined;
  let inlineCommentsEnabledForReview = false;
  let suggestionsEnabledForReview = false;
  let changedFilesSummaryEnabledForReview = false;
  let effortScoreEnabledForReview = false;
  let autoMergeSummaryEnabledForReview = false;
  let reviewMemoryEnabledForReview = false;
  let findingCategoriesEnabledForReview = false;
  let fixHandoffEnabledForReview = false;
  let minFindingSeverityForReview: ReviewFindingSeverity | null = null;
  let inlineCommentsPerCategoryForReview: number | null = null;
  let aiReviewExpected = false;
  let aiReviewWasReused = false;
  let gateFinalized = false;
  // #6685: hoisted the same way aiReviewExpected/aiReviewWasReused are above -- assigned inside the try block
  // below, read at the draft-republish skip check past it (autoReviewSkipReason itself is try-block-scoped).
  let autoReviewSkipReasonForPublish: string | null = null;
  const publishedOutputs: PublicSurfaceOutput[] = [];
  const failedOutputs: PublicSurfaceOutputFailure[] = [];
  // #6724 (review-burst): true until a comment/label publish proves itself a no-op (byte-identical body / label
  // already present) -- read by finishPublicSurfacePublication's final call below to avoid double-counting a
  // republish that changed nothing on GitHub. Stay true (the safe default) for any output this pass doesn't
  // attempt, and for output kinds with no cheap no-op signal (gate_check_run, check_run).
  let commentContentChanged = true;
  let labelContentChanged = true;
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
  // #6724 (review-burst): contentChanged defaults true so every existing caller (the three early-return call
  // sites below, none of which reach the comment/label publish steps) keeps recording pr_public_surface_published
  // exactly as before -- only the final "full" call site computes and passes the real value.
  const finishPublicSurfacePublication = async (contentChanged = true): Promise<
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
        }, "pr_public_surface_publish_failed");
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
    // #6724 (review-burst): a proven no-op republish (comment byte-identical, label already present) still
    // completes every side effect below (surface-published stamp, AI-review-published stamp) -- those ARE
    // accurate on a no-op, since the head genuinely is current -- but skips the two DURABLE "a review was
    // published" records (this event feeds public-stats.ts/services/public-review-volume-trend.ts and is
    // exempt from retention pruning, db/retention.ts), so a CI-flap/retry-storm that keeps re-rendering the
    // same content stops inflating both the public "reviews completed" count and the review-burst anomaly
    // counter (findHottestReviewTargetForRepo, db/repositories.ts) that reads this exact event type. A narrower
    // event records the no-op instead, mirroring the existing github_app.public_surface_publish_skipped_current
    // precedent (#6685) for the same "provably nothing changed" shape.
    if (contentChanged) {
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
          reviewCheckMode: settings.reviewCheckMode,
          publicAudienceMode: settings.publicAudienceMode,
          publishedOutputs,
          failedOutputs,
          gateCheckFinalized: gateFinalized,
        },
      });
    } else {
      await recordAuditEvent(env, {
        eventType: "github_app.pr_public_surface_republish_noop",
        actor: author,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        detail: "republish produced no visible change (comment byte-identical / label already present)",
        metadata: { deliveryId: webhook.deliveryId, repoFullName, publishedOutputs },
      }).catch(() => undefined);
    }
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
      resolveOpenPrFileCollisionEnabled(isOpenPrFileCollisionEnabledGlobally(env), settings.openPrFileCollisionMode)
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
    const duplicateWinnerEnabled = resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode);
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
      settings.manifestPolicyGateMode !== "off" ||
      shouldCollectCopycatEvidence(settings)
    ) {
      gateFiles = await getReviewFiles();
    }
    if (shouldCollectSlopEvidence(settings)) {
      const slopFiles = gateFiles ?? [];
      // #slop-commit-messages: the low_quality_commit_message signal (weight 15) needs the PR's own commit
      // subject(s), which nothing on this path previously fetched -- buildLowQualityCommitMessageFinding
      // guards on commitMessages being undefined/empty and so silently never fired on the live gate.
      // Best-effort: listPullRequestCommitMessages fails safe to [] (same as never having fetched it).
      const slopCommitMessages = await listPullRequestCommitMessages(
        env,
        installationId,
        repoFullName,
        pr.number,
      );
      const slop = buildSlopAssessment({
        changedFiles: slopFiles.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        })),
        description: pr.body,
        commitMessages: slopCommitMessages,
        // Reuse the collision report already built for this gate run so a duplicate-cluster PR is flagged (#563).
        // Duplicate-winner adjudication (#dup-winner): the winner is judged on its OWN merits, so it is NOT
        // penalized for the cluster. Flag-OFF ⇒ isDupWinner is false ⇒ byte-identical to today.
        inDuplicateCluster:
          !isDupWinner &&
          isPullRequestInDuplicateCluster(collisions, pr.number),
      });
      slopRisk = slop.slopRisk;
      slopBand = slop.band;
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
        // #one-shot-review-cadence: a repeat automatic trigger (push/CI-completion/sweep) under one-shot mode
        // must not spend another slop LLM call once this PR has already had ITS one-shot slop pass -- silent
        // skip (mirrors commitThresholdReached just below: no reuse-for-display, matching the pre-existing
        // precedent for this same feature). An explicit maintainer retrigger already unset oneShotCadenceActive
        // above, so it always reaches the fresh call regardless of prior passes.
        const slopOneShotSkip =
          oneShotCadenceActive &&
          (await hasPublishedAiSlopAdvisory(env, repoFullName, pr.number).catch(() => false));
        if (slopOneShotSkip) {
          await recordAuditEvent(env, {
            eventType: "github_app.ai_slop_one_shot_skip",
            actor: author,
            targetKey: `${repoFullName}#${pr.number}`,
            outcome: "completed",
            detail: "one-shot review cadence: this PR already had its slop advisory pass; not spending a fresh call",
            /* v8 ignore next -- reached only when a PRIOR slop pass already published, and an open PR does not
             * lose its head SHA once set; the `?? null` is a type-level fallback for an unreachable branch. */
            metadata: { repoFullName, headSha: advisory.headSha ?? null },
          }).catch(() => undefined);
        } else {
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
    }
    // Copycat/plagiarism containment (#1969): only when opted in (copycatGateMode !== "off"). Surfaces the
    // deterministic containment finding as advisory context (no gate-level hard block here — see
    // planAgentMaintenanceActions's own copycat short-circuit for the label/close/strikes actuation, which
    // reads the score persisted below rather than re-running this candidate-fetching pass). Best-effort:
    // persistence failure never aborts gate evaluation.
    if (shouldCollectCopycatEvidence(settings)) {
      const copycat = await runCopycatAssessment(env, {
        repoFullName,
        pr: { number: pr.number, createdAt: pr.createdAt },
        files: gateFiles ?? [],
        otherOpenPullRequests,
        mode: settings.copycatGateMode,
        minScore: settings.copycatGateMinScore,
      });
      advisory.findings.push(...copycat.findings);
      await updatePullRequestCopycatAssessment(env, repoFullName, pr.number, {
        copycatScore: copycat.score,
        copycatMatchedPullNumber: copycat.matchedPullNumber,
      }).catch(() => undefined);
    }
    // Linked-issue satisfaction assessment (#1961/#3906, opt-in via linkedIssueSatisfactionGateMode). Assesses
    // only the PR's primary linked issue -- see runLinkedIssueSatisfactionForAdvisory's own doc comment for
    // the multi-linked-issue rationale. `off` (default) short-circuits before any fetch or model call, so this
    // is byte-identical to before this feature existed for every repo that hasn't opted in. (Declared/hoisted
    // to function scope above, alongside gateEvaluation, since it is consumed later outside this try block.)
    if (settings.linkedIssueSatisfactionGateMode !== "off" && pr.linkedIssues.length > 0) {
      // #one-shot-review-cadence: mirrors the slop advisory's skip above, scoped to the PR's PRIMARY linked
      // issue (matching runLinkedIssueSatisfactionForAdvisory's own "assesses only the first linked issue"
      // contract) -- a newly-linked issue never assessed before still gets its own first pass even when the
      // PR itself already had a satisfaction pass for a DIFFERENT (now-superseded) linked issue.
      const primaryLinkedIssueNumber = pr.linkedIssues[0];
      const linkedIssueOneShotSkip =
        oneShotCadenceActive &&
        primaryLinkedIssueNumber !== undefined &&
        (await hasPublishedLinkedIssueSatisfaction(env, repoFullName, pr.number, primaryLinkedIssueNumber).catch(() => false));
      if (linkedIssueOneShotSkip) {
        const priorLinkedIssueSatisfaction = await getLatestPublishedLinkedIssueSatisfaction(env, repoFullName, pr.number, primaryLinkedIssueNumber).catch(() => null);
        if (priorLinkedIssueSatisfaction?.status === "ok" && priorLinkedIssueSatisfaction.result) {
          linkedIssueSatisfaction = { status: priorLinkedIssueSatisfaction.result.status, rationale: priorLinkedIssueSatisfaction.result.rationale };
          if (settings.linkedIssueSatisfactionGateMode === "block" && priorLinkedIssueSatisfaction.result.status === "unaddressed") {
            advisory.findings.push({
              code: "linked_issue_scope_mismatch",
              severity: "warning",
              title: "Linked issue does not appear to be satisfied",
              detail: priorLinkedIssueSatisfaction.result.rationale,
              action: "Confirm this PR actually addresses the linked issue's scope, or link the correct issue.",
              publicText: `AI assessment: this PR does not appear to satisfy its linked issue's scope. ${priorLinkedIssueSatisfaction.result.rationale}`,
            });
          }
        }
        await recordAuditEvent(env, {
          eventType: "github_app.linked_issue_satisfaction_one_shot_skip",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "completed",
          detail: "one-shot review cadence: this PR's linked issue already had its satisfaction pass; not spending a fresh call",
          /* v8 ignore next -- reached only when a PRIOR satisfaction pass already published for this issue
           * number, and an open PR does not lose its head SHA once set; the `?? null` is a type-level
           * fallback for an unreachable branch. */
          metadata: { repoFullName, headSha: advisory.headSha ?? null },
        }).catch(() => undefined);
      } else {
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
    }
    // Focus-manifest policy gate (#555) -- see maybeApplyManifestPolicyGate's own doc comment.
    await maybeApplyManifestPolicyGate(env, {
      repoFullName,
      installationId,
      pr,
      repo,
      settings,
      advisory,
      webhook,
      gateFiles,
      author,
    });
    // Pre-merge checks (#review-pre-merge-checks, opt-in via .loopover.yml review.pre_merge_checks). DETERMINISTIC
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
    // CLA / license-compatibility gate (#2564, opt-in via .loopover.yml gate.claMode). DETERMINISTIC — a PR-body
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
    autoReviewSkipReasonForPublish = autoReviewSkipReason;
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
    autoMergeSummaryEnabledForReview = deterministicReviewOverrides.autoMergeSummary;
    minFindingSeverityForReview = deterministicReviewOverrides.minFindingSeverity;
    inlineCommentsPerCategoryForReview = deterministicReviewOverrides.inlineCommentsPerCategory;
    // review.memory (#2179, part of #1964): deterministic, no-AI -- resolved the same unconditional way as
    // changed_files_summary/effort_score above (must apply even when the AI review itself is skipped this
    // pass). ANDed with the operator's LOOPOVER_REVIEW_MEMORY kill-switch at the actual apply site below
    // (shouldApplyReviewMemory) — this flag alone only carries the per-repo manifest opt-in.
    reviewMemoryEnabledForReview = shouldApplyReviewMemory(env, resolveReviewMemoryManifestToggle(reviewManifestForAutoReview));
    // review.fixHandoff emission (#1962): resolved the same unconditional way as the deterministic sections above,
    // ANDing the per-repo `review.fixHandoff` manifest opt-in with the operator's LOOPOVER_REVIEW_FIX_HANDOFF
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
    // #one-shot-review-cadence: only even attempts the lookup when the review would otherwise be eligible to
    // run fresh this pass (mirrors how the frozen/paused branches below are similarly mutually exclusive) --
    // a PR that's blacklisted/frozen/already-skipped for another reason never shows AI content at all today,
    // and one-shot mode must not change that. A non-null result here means this PR already had its one-shot
    // main-review pass, so the fresh call below must be skipped and this reused instead.
    const oneShotPriorReview =
      oneShotCadenceActive && !authorBlacklisted && !isFrozenForManualReview && !autoReviewSkipReason
        ? await getLatestPublishedAiReview(env, repoFullName, pr.number, settings.aiReviewMode).catch(() => null)
        : null;
    const aiReviewWillRun =
      !authorBlacklisted &&
      !isFrozenForManualReview &&
      !autoReviewSkipReason &&
      !oneShotPriorReview &&
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
        incr("loopover_ai_review_frozen_reuse_total");
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
        incr("loopover_ai_review_paused_reuse_total");
        await recordAuditEvent(env, {
          eventType: "github_app.ai_review_paused_reuse",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "completed",
          detail: "Auto-review is paused (commit threshold); reused the last published AI review instead of spending a fresh call",
          metadata: { deliveryId: webhook.deliveryId, repoFullName, headSha: advisory.headSha ?? null },
        }).catch(() => undefined);
      }
    } else if (oneShotPriorReview && hasPublicReviewAssessment(oneShotPriorReview.notes)) {
      advisory.findings.push(...oneShotPriorReview.findings);
      aiReview = oneShotPriorReview;
      aiReviewWasReused = true;
      incr("loopover_ai_review_one_shot_reuse_total");
      await recordAuditEvent(env, {
        eventType: "github_app.ai_review_one_shot_reuse",
        actor: author,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        detail: "one-shot review cadence: reused the last published AI review instead of spending a fresh call",
        /* v8 ignore next -- a truthy `oneShotPriorReview` means markAiReviewPublished previously stamped a row
         * for a non-null head SHA, and an open PR does not lose its head SHA once set; the `?? null` is a
         * type-level fallback for a practically-unreachable branch, mirroring the identical fallback on the
         * frozen-reuse and paused-reuse audit events just above. */
        metadata: { deliveryId: webhook.deliveryId, repoFullName, headSha: advisory.headSha ?? null },
      }).catch(() => undefined);
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
          // `.loopover.yml` review.profile + review.security_focus + review.path_instructions +
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
            cultureProfile: shouldApplyRepoCultureProfile(env, reviewCultureProfile === true),
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
            body: pr.body,
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
            incr("loopover_ai_review_cache_hit_total");
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
            incr("loopover_regate_ai_skipped_current_total");
          } else {
            // A forced bypass is NOT a cache miss — the cache may well have had a valid, reusable entry; the
            // caller explicitly asked to skip it. Counting it under the miss metric would make "the cache failed
            // to serve" indistinguishable from "a caller deliberately opted out," which muddies exactly the
            // incident-dashboard signal this whole fix exists to provide.
            if (webhook.forceAiReview === true) {
              incr("loopover_ai_review_force_bypass_total");
              await recordAuditEvent(env, {
                eventType: "github_app.ai_review_force_bypass",
                actor: author,
                targetKey: `${repoFullName}#${pr.number}`,
                outcome: "completed",
                detail: "explicit force re-gate bypassed the AI review cache and cooldown",
                metadata: { deliveryId: webhook.deliveryId, repoFullName, /* v8 ignore next -- reached only inside aiReviewWillRun (which requires a truthy advisory.headSha) or the publish-skip guard's own `advisory.headSha &&` check; the `?? null` is a type-level fallback for an unreachable branch. */ headSha: advisory.headSha ?? null },
              }).catch(() => undefined);
            } else {
              incr("loopover_ai_review_cache_miss_total");
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
              // improvementSignal (#4744): resolved once above, reused here so the LLM tier's value-assessment
              // prompt addition (#4743) only fires when this repo has actually opted in.
              improvementSignal: improvementSignalAllowed,
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
                incr("loopover_ai_review_non_cacheable_total");
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
                incr("loopover_ai_review_cache_write_error_total");
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
      }, "ai_review_public_summary_missing");
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

    // Screenshot-table gate advisory visibility (#2006 follow-up): `action: "advisory"` previously had no
    // visible effect at all (see maybeAddScreenshotTableAdvisoryFinding's own doc comment). No-op for `off`,
    // out-of-scope, or `action: "close"` (which already communicates via its own close comment).
    await maybeAddScreenshotTableAdvisoryFinding(env, {
      advisory,
      repoFullName,
      pullNumber: pr.number,
      screenshotTableGateConfig: settings.screenshotTableGate ?? DEFAULT_SCREENSHOT_TABLE_GATE,
      prBody: pr.body,
      prLabels: pr.labels,
      botCaptureSatisfied: Boolean(pr.headSha) && pr.visualCaptureSatisfiedSha === pr.headSha,
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
    // flag-gated by LOOPOVER_REVIEW_PARITY_AUDIT: flag-OFF (default) is an immediate no-op (NO D1 write) so the review
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
        // #2352: lets the live auto-tune breaker (src/review/outcomes-wire.ts's runSelfTuneBreaker) scope a
        // SEPARATE precision read to miner-originated PRs, independently of the maintainer's overall accuracy.
        minerAuthored: confirmedContributor,
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
          check.name === LOOPOVER_GATE_CHECK_NAME &&
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
          incr("loopover_public_surface_publish_skipped_current_total");
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
          /* v8 ignore next -- gate-enabled publication always has a gate evaluation. */
          finalGateCheckConclusion =
            autoReviewSkipReason && !publicSurfaceSkipped && gateEvaluation?.conclusion === "success"
              ? "skipped"
              : (gateEvaluation?.conclusion ?? null);
          await recordPublishedGateCheckSummary(env, {
            repoFullName,
            pullNumber: pr.number,
            headSha: advisory.headSha,
            checkRunId: gateCheckResult.id,
            conclusion: finalGateCheckConclusion,
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
              finalGateCheckConclusion = "neutral";
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
            finalGateCheckConclusion = "neutral";
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
  // #6685 (review-burst): a draft fork PR's own CI produces one check_run.completed webhook per job (each
  // arriving with an empty pull_requests[] payload, forcing the fork-resume fallback in webhook-coalesce.ts
  // to re-run this whole pass), so a multi-job CI run on a draft PR republished the SAME surface once per
  // completing job even though nothing about the PR changed between them -- confirmed live, 12 identical
  // republishes of JSONbored/loopover#6592 in 29 minutes. autoReviewSkipReason === "review skipped (draft)"
  // is a deterministic signal (from pr.isDraft + config, resolved before any AI/cache call) that this pass
  // has nothing new to report from the review dimension; a matching lastPublishedSurfaceSha proves the head
  // hasn't moved since the last full publish either. Together they're a provable no-op for the draft case
  // specifically -- narrower than, and independent of, the check-run-only skip above (canSkipCurrentSurface
  // requires gateEnabled, which is false fleet-wide here since reviewCheckMode is disabled), so this applies
  // regardless of publicSurface/gateEnabled. !forceAiReview preserves an explicit maintainer re-trigger the
  // same way that guard does.
  if (
    autoReviewSkipReasonForPublish === "review skipped (draft)" &&
    !webhook.forceAiReview &&
    advisory.headSha &&
    advisory.headSha === pr.lastPublishedSurfaceSha
  ) {
    incr("loopover_public_surface_publish_skipped_current_total");
    await recordAuditEvent(env, {
      eventType: "github_app.public_surface_publish_skipped_current",
      actor: author,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "completed",
      detail: "draft PR already current for this head; skipped republish",
      metadata: { deliveryId: webhook.deliveryId, repoFullName, headSha: advisory.headSha },
    }).catch(() => undefined);
    return finishPublicSurfacePublication();
  }

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
    const duplicateWinnerEnabled = resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode);
    // improvementSignal deterministic tier (#4742/#4744): pure/sync, no AI dependency, so it is computed
    // independent of aiReview's own eligibility gates above (a paused repo, non-reviewable author, or
    // aiReviewMode: "off" still gets this tier -- the two tiers are deliberately independent, epic #4737).
    // Only computed when the feature resolves on for this repo, matching "nothing at all when the feature is
    // off" (#4744) and avoiding the extra file resolve on the default (until an operator opts in) path where
    // it's off. changedFiles reuses the SAME memoized getReviewFiles() resolver every other gate/panel input
    // already calls, so this costs no extra fetch when something else already resolved it this pass.
    // complexityDeltas/duplicationDeltas/patchCoverageDeltaPercent have no caller yet (see improvement.ts's own
    // header comment) -- only the changedFiles-based axes (test-evidence) can fire today; that is expected,
    // not a bug in this PR, and the assessment degrades cleanly ("insufficient-signal"/"none") when they don't.
    const structuralImprovementAssessment = improvementSignalAllowed
      ? buildStructuralImprovementAssessment({
          changedFiles: (await getReviewFiles()).map((file) => ({
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
          })),
        })
      : undefined;
    let deterministicBody: string;
    // Convergence (Stage D, #6103): the converged comment (loopover shape + reviewbot's review folded in) is
    // the only comment path -- the legacy buildPublicPrIntelligenceComment panel was retired once it had no
    // remaining production caller (settings-preview.ts's sample preview was migrated to this same renderer).
    // The gate stays authoritative (passed as `decision`), and the body carries the SAME panel marker so the
    // upsert updates in place.
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
    {
      // #6103: the converged renderer is the only comment path (the legacy buildPublicPrIntelligenceComment
      // panel was retired). When the gate was never evaluated for this repo (reviewCheckMode disabled AND no
      // autonomy configured -- see shouldEvaluateGate above), synthesize a "skipped" gate for rendering
      // purposes only, mirroring buildClosedUnifiedCommentBody's own pattern for the identical situation.
      // This never touches the check-run/label/audit/disposition lanes (those still read the real,
      // possibly-undefined `gateEvaluation`) -- only what this comment's verdict/"Gate result" row says.
      const commentGateEvaluation: NonNullable<typeof gateEvaluation> = gateEvaluation ?? {
        enabled: false,
        conclusion: "skipped",
        title: `${LOOPOVER_GATE_CHECK_NAME} skipped`,
        summary: "Gate evaluation is not configured for this repository.",
        blockers: [],
        warnings: [],
      };
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
      const liveCi = await refreshLiveCiAggregate(env, {
        repoFullName,
        facts: webhook.liveFacts,
        prNumber: pr.number,
        headSha: pr.headSha,
        baseRef,
        token,
        expectedCiContexts: settings.expectedCiContexts,
        advisoryCheckRuns: settings.advisoryCheckRuns,
        admissionKey,
      });
      // Live merge-state too — the SAME source the disposition uses (planAgentMaintenanceActions reads liveMergeState).
      // The stored pr.mergeableState lags GitHub's async recompute, and the gate's own check/review publication can
      // also advance mergeability after readiness ran, so refresh at this post-publish boundary.
      const liveMergeState = await refreshLiveMergeState(env, repoFullName, webhook.liveFacts, pr.number, token, admissionKey).catch(() => undefined);
      const { ciState, mergeStateLabel, mergeReadiness, heldForReview, neverClosed } = derivePublicCommentMergeFacts({
        liveMergeState,
        mergeableState: pr.mergeableState,
        authorLogin: pr.authorLogin,
        liveCi,
        settings,
        unifiedFiles,
        repoFullName,
      });
      // The public comment must match the authoritative Gate check-run conclusion.
      const commentGate = commentGateEvaluation;
      // Observability (#reviews-dashboard): record the would-be gate verdict so the Grafana panel shows the
      // merge/close/hold mix — the "are we rubber-stamping?" signal — even in advisory/dryRun (this is the rendered verdict).
      incr("loopover_gate_decisions_total", {
        repo: repoFullName,
        conclusion: commentGate.conclusion,
      });
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
        improvementSignal: structuralImprovementAssessment,
        valueAssessment: aiReview?.valueAssessment,
        // #4745: same reused slop band as the legacy commentArgs above -- the two panel builders never diverge.
        slopBand: slopBand ?? undefined,
      });
      // Visual before/after capture (visual-capture port). Fires ONLY when (1) the "screenshots" converged
      // feature resolves active for this repo (resolveConvergedFeature — the global flag AND (a per-repo
      // `features.screenshots` override OR the cutover allowlist default), #4616; reuses the manifest this
      // pass already loaded above, no extra fetch) AND (2) the PR touches WEB-VISIBLE files (isVisualPath —
      // frontend pages / public OG images; backend .ts/.md/.json PRs never qualify). Fully wrapped in
      // try/catch + defaults to [] so a capture failure (render timeout, missing binding, GitHub hiccup) can
      // NEVER sink the review — it just omits the "Visual preview" section. Flag-OFF (default) ⇒ this block is
      // skipped entirely and the unified comment is byte-identical.
      let beforeAfter: CaptureRoute[] = [];
      // review.visual.bugAnalysis — resolved inside the try block below alongside the rest of reviewVisualConfig,
      // but needed at the runVisualVisionForAdvisory call OUTSIDE that block's scope (that call is deliberately
      // independent of the capture try/catch above, see its own comment) — mirrors beforeAfter's own
      // declared-outer/assigned-inner pattern. false (unresolved, or resolution never ran) ⇒ byte-identical
      // default-prompt behavior, same fail-safe direction as every other config-as-code read here.
      let bugAnalysisEnabled = false;
      let interactionPreviews: CaptureInteractionRoute[] = [];
      const visualFiles = unifiedFiles
        .map((file) => file.path)
        .filter(isVisualPath);
      // #auto-interaction-detection: only ever read by buildCapture when review.visual.autoDetectInteractions
      // is on for this repo -- carries each changed file's own diff patch text (visualFiles above is bare
      // paths), the same file.payload?.patch shape review-diff.ts/grounding-wire.ts already read elsewhere.
      const changedCssFiles = unifiedFiles.map((file) => ({
        path: file.path,
        patch: typeof file.payload?.patch === "string" ? file.payload.patch : undefined,
      }));
      if (resolveConvergedFeature(env, repoFocusManifestForComment, "screenshots", repoFullName) && visualFiles.length > 0) {
        try {
          const token = await createInstallationToken(env, installationId);
          // review.visual (#3609 / #3610): an explicit per-repo preview-URL template / route list. Absent config
          // (the default for every repo today) ⇒ EMPTY_VISUAL_CONFIG ⇒ buildCapture's discovery/inference
          // behavior is byte-identical to pre-#3609.
          const reviewVisualConfig = await resolveVisualCaptureConfig(env, repoFullName);
          bugAnalysisEnabled = reviewVisualConfig.bugAnalysis === true;
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
              ? { routes: [], interactions: [], previewPending: false }
              : await buildCapture(env, token, captureTarget, visualFiles, githubRateLimitAdmissionKeyForInstallation(installationId), reviewVisualConfig, changedCssFiles);
          beforeAfter = capture.routes;
          interactionPreviews = capture.interactions;
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
            previewPollAttempt < MAX_PREVIEW_POLL_ATTEMPTS
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
        bugAnalysisEnabled,
      });
      // Vision-verify a contributor-pasted screenshot-table (#4366 wiring) — see runScreenshotTableVisionForAdvisory's
      // own doc comment. Independent of the bot-capture vision block above: this checks the CONTRIBUTOR's own
      // pasted table images, not the bot's rendered before/after pair.
      await runScreenshotTableVisionForAdvisory(env, {
        mode,
        repoFullName,
        pr,
        prBody: pr.body,
        prTitle: pr.title,
        author,
        confirmedContributor,
        settings,
        advisory,
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
            incr("loopover_review_memory_suppressed_total", { repo: repoFullName });
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
        // review.auto_merge_summary (#2051/#4147): deterministic, no-AI — reuses the SAME ciState/
        // mergeStateLabel/gate/linkedIssues facts this pass already resolved for mergeReadiness and the gate
        // verdict above, no extra fetch. gatePassing mirrors the gate's own "no hard blocker" definition
        // (conclusion === "success"); linkedIssueValid mirrors missing_linked_issue's own "has at least one
        // linked issue reference" check (pr.linkedIssues.length > 0).
        ...(autoMergeSummaryEnabledForReview
          ? {
              autoMergeSummary: {
                ciGreen: ciState === "passed",
                gatePassing: renderedGate.conclusion === "success",
                mergeableClean: mergeStateLabel === "clean",
                linkedIssueValid: pr.linkedIssues.length > 0,
              },
            }
          : {}),
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
          env,
        }),
        footerMarkdown: loopoverFooter(env, {
          earnUrl: repo?.isRegistered
            ? gittensorRepoEarnUrl(repoFullName)
            : undefined,
          ...(reviewConfig?.footerText
            ? { customText: reviewConfig.footerText }
            : {}),
        }),
        reRunLabel: `${PR_PANEL_RETRIGGER_MARKER} Re-run LoopOver review`,
        // #4589: only rendered when there's an actual gap AND the checkbox would work for this repo -- same
        // condition testCoverageBody gates its own (informational) collapsible on, so the two always agree.
        ...(missingTestsFinding && e2eTestGenAvailable
          ? { generateTestsLabel: `${PR_PANEL_GENERATE_TESTS_MARKER} **[BETA]** Generate an AI Playwright test for this PR` }
          : {}),
        ...(beforeAfter.length > 0 ? { beforeAfter } : {}),
        ...(interactionPreviews.length > 0 ? { interactions: interactionPreviews } : {}),
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
    }
    try {
      const commentResult = await withReviewPipelineSpan(
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
      // #6724 (review-burst): only a proven byte-identical no-op (createOrUpdatePrIntelligenceComment's own
      // idempotency check) sets this false -- a real create/update, or the createIfMissing:false null case
      // (not reachable on this call site, which never sets that option), both default true.
      commentContentChanged = commentResult?.changed ?? true;
      publishedOutputs.push("comment");
      incr("loopover_reviews_published_total", { repo: repoFullName });
      // Real end-to-end review latency (#review-latency-metric): pr.headShaObservedAt is the moment THIS
      // exact head SHA became ready for review (see upsertPullRequestFromGitHub) -- reusing
      // reviewDurationMsSince's existing parse/clamp logic (#4446) so a clock-skew or malformed timestamp
      // degrades to no observation rather than ever recording a negative/NaN sample.
      const endToEndLatencyMs = reviewDurationMsSince(pr.headShaObservedAt ?? null, Date.now());
      if (endToEndLatencyMs !== undefined) {
        observe("loopover_review_end_to_end_latency_seconds", endToEndLatencyMs / 1000, undefined, REVIEW_LATENCY_BUCKETS);
      }
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
      const labelResult = await withReviewPipelineSpan(
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
      // #6724 (review-burst): applied:false means the label was already present -- a proven no-op, same idea
      // as commentContentChanged above.
      labelContentChanged = labelResult.applied;
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
  // #6724 (review-burst): only a PUBLISHED-OUTPUTS SET of exactly comment/label (both proven no-ops, or absent
  // entirely) counts as a no-op pass. `check_run` (the separate advisory check, distinct from the gate one) has
  // no cheap no-op signal, so its mere presence keeps this true -- conservative by design, this can only ever
  // suppress a pr_public_surface_published record for a pass PROVEN to have changed nothing, never the reverse.
  // `gate_check_run` DOES have one (#ops-review-burst): finalGateCheckConclusion/priorGateCheckConclusion above
  // -- a stuck-CI-finalize loop that keeps re-reviewing the SAME unchanged head SHA republishes the IDENTICAL
  // gate conclusion every pass (confirmed live: repeated "review burst" ops_anomaly alerts, 6+ published
  // surfaces in 2h for one PR with no real state change), which this now proves a no-op rather than always
  // counting gate_check_run's mere presence as a change. Any doubt -- no gate_check_run this pass, no prior row
  // for this exact head (a genuinely new commit), or a differing conclusion -- still counts as changed.
  const gateCheckRunContentChanged =
    !publishedOutputs.includes("gate_check_run") ||
    priorGateCheckConclusion === undefined ||
    finalGateCheckConclusion !== priorGateCheckConclusion;
  const surfaceContentChanged =
    publishedOutputs.some((output) => output !== "comment" && output !== "label" && output !== "gate_check_run") ||
    (publishedOutputs.includes("gate_check_run") && gateCheckRunContentChanged) ||
    (publishedOutputs.includes("comment") && commentContentChanged) ||
    (publishedOutputs.includes("label") && labelContentChanged);
  return finishPublicSurfacePublication(surfaceContentChanged);
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
 * Handle `@loopover gate-override <reason>` on a PR thread. SECURITY-SENSITIVE: this finalizes the Gate
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
  const command = parseLoopOverMentionCommand(comment?.body);
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
    commandName: "gate-override" as LoopOverMentionCommandName,
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
  // an operator's pause or the DB kill-switch does not stop a maintainer's @loopover gate-override from
  // flipping the live Gate check-run to neutral and posting a real confirmation comment.
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
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
      `> **${LOOPOVER_GATE_CHECK_NAME} overridden by @${actor}**`,
      "> The review-agent check was set to neutral for the current commit only. This does NOT permanently bypass the review; a new push re-evaluates it.",
      "",
      `- Reason: ${safeReason}`,
      "",
      "---",
      loopoverFooter(env),
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

async function maybeProcessResolveCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> { const command = parseLoopOverMentionCommand(payload.comment?.body);
  if (!command) return false;
  if (command.name !== "resolve") return false;
  const { classifyPrCommandRequest } = await import("../github/pr-command-request");
  const { normalizeResolveFindingRef, selectWarningsForResolve } = await import("../review/review-memory-wire");
  const req = classifyPrCommandRequest(payload, getInstallationId(payload));
  if (!req.ok) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey: req.targetKey, outcome: "completed", detail: req.reason, metadata: { deliveryId, repoFullName: req.repoFullName ?? null, reason: req.reason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey: req.targetKey, outcome: "skipped", metadata: { reason: req.reason } }); return true; }
  const [pr, settings] = await Promise.all([getPullRequest(env, req.repoFullName, req.pr.number), resolveRepositorySettings(env, req.repoFullName)]);
  const targetKey = `${req.repoFullName}#${req.pr.number}`;
  if (!pr) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: "cached_pr_missing", metadata: { deliveryId, repoFullName: req.repoFullName, reason: "cached_pr_missing" } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: "cached_pr_missing" } }); return true; }
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "resolve" as LoopOverMentionCommandName, settings, pr });
  if (!authorization.authorized) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resolve") } }); await recordGithubProductUsage(env, "finding_resolved_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resolve") } }); return true; }
  const findingRef = normalizeResolveFindingRef(command.reason);
  if (!findingRef.ok) { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: findingRef.reason, metadata: { deliveryId, repoFullName: req.repoFullName, reason: findingRef.reason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: findingRef.reason } }); return true; }
  const { advisory } = await buildAuthorizedPrActionAdvisory(env, req.repoFullName, pr, settings);
  await appendPublishedAiReviewFindingsForResolve(env, req.repoFullName, pr, settings.aiReviewMode, advisory);
  const gate = evaluateGateCheck(advisory, gateCheckPolicy(settings, null, undefined, pr.slopRisk ?? null));
  const selection = selectWarningsForResolve(gate.warnings, findingRef);
  if (selection.reason === "finding_not_found") { await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: selection.reason, metadata: { deliveryId, repoFullName: req.repoFullName, reason: selection.reason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: selection.reason } }); return true; }
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
  if (mode !== "live") { const skipReason = mode === "dry_run" ? "dry_run" : "agent_paused"; await recordAuditEvent(env, { eventType: "github_app.finding_resolved_skipped", actor: req.actor, targetKey, outcome: "completed", detail: skipReason, metadata: { deliveryId, repoFullName: req.repoFullName, reason: skipReason } }); await recordGithubProductUsage(env, "finding_resolved_skipped", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "skipped", metadata: { reason: skipReason } }); return true; }
  const reviewManifest = await loadRepoFocusManifest(env, req.repoFullName).catch(() => null);
  const reviewMemoryEnabled = shouldApplyReviewMemory(env, resolveReviewMemoryManifestToggle(reviewManifest));
  let recordedSuppressionCount = 0;
  if (reviewMemoryEnabled && selection.findings.length > 0) { const { fingerprint } = await import("../review/review-memory-match"); const { recordReviewSuppression } = await import("../db/repositories"); const suppressionWrites = selection.findings.map((finding) => ({ category: finding.code, pathGlob: "", patternHash: fingerprint({ category: finding.code, message: `${finding.title} ${finding.detail}` }) })); await Promise.all(suppressionWrites.map((write) => recordReviewSuppression(env, { repoFullName: req.repoFullName, category: write.category, pathGlob: write.pathGlob, patternHash: write.patternHash, createdBy: req.actor }))); recordedSuppressionCount = suppressionWrites.length; invalidateReviewSuppressionCache(req.repoFullName); /* #4508: this repo's cached suppression list is stale as of this write -- the very next render must see it, not wait out the TTL. */ await recordAuditEvent(env, { eventType: "github_app.review_memory_recorded", actor: req.actor, targetKey, outcome: "completed", detail: `Recorded ${recordedSuppressionCount} review-memory suppression signal(s).`, metadata: { deliveryId, repoFullName: req.repoFullName, recordedSuppressionCount, scope: findingRef.scope, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } }); await recordGithubProductUsage(env, "review_memory_recorded", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { recordedSuppressionCount, scope: findingRef.scope, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } }); }
  const resolvedLabel = findingRef.scope === "whole_pr" ? "all current advisory findings" : `\`${findingRef.findingCode}\``;
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Review finding resolved by @${req.actor}**`, `> Marked ${resolvedLabel} as resolved for this PR. The Gate check-run is unchanged.`, ...(recordedSuppressionCount > 0 ? ["", `Recorded ${recordedSuppressionCount} review-memory suppression signal(s) for future reviews.`] : []), "", "---", loopoverFooter(env)].join("\n"));
  await createOrUpdateAgentCommandComment(env, req.installationId, req.repoFullName, req.pr.number, confirmation, mode);
  await recordAuditEvent(env, { eventType: "github_app.finding_resolved", actor: req.actor, targetKey, outcome: "completed", detail: `Marked ${resolvedLabel} as resolved.`, metadata: { deliveryId, repoFullName: req.repoFullName, scope: findingRef.scope, resolvedWarningCount: selection.findings.length, recordedSuppressionCount, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } });
  await recordGithubProductUsage(env, "finding_resolved", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "completed", metadata: { scope: findingRef.scope, resolvedWarningCount: selection.findings.length, recordedSuppressionCount, ...(findingRef.scope === "single" ? { findingCode: findingRef.findingCode } : {}) } }); return true; }

/**
 * `@loopover review` (#2163, part of #1960, alias `re-review`): a maintainer/collaborator/confirmed-miner
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
  const command = parseLoopOverMentionCommand(payload.comment?.body);
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
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "review" as LoopOverMentionCommandName, settings, pr, needsMinerDetection: true });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.review_command_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "review") } });
    await recordGithubProductUsage(env, "review_command_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "review") } });
    return true;
  }
  // Same dry-run/paused gate every other action command respects (pause/resolve/explain/gate-override/
  // generate-tests) -- a paused or dry-run repo must not dispatch a live re-review or post a confirmation.
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
  if (mode !== "live") {
    await recordReviewCommandSkip(env, deliveryId, req.repoFullName, targetKey, req.actor, mode === "dry_run" ? "dry_run" : "agent_paused");
    return true;
  }
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Re-review triggered by @${req.actor}**`, "> Re-running auto-review for this PR. The Gate check-run and one-shot disposition are produced the same way a scheduled pass would.", "", "---", loopoverFooter(env)].join("\n"));
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
 * `@loopover pause` (#2164, part of #1960): a maintainer pauses AUTO-REVIEW for THIS PR only by recording a
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
  const command = parseLoopOverMentionCommand(payload.comment?.body);
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
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "pause" as LoopOverMentionCommandName, settings, pr });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.autoreview_paused_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "pause") } });
    await recordGithubProductUsage(env, "autoreview_paused_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "pause") } });
    return true;
  }
  const safeReason = sanitizePublicComment((command.reason ?? "").trim() || "No reason provided.");
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Auto-review paused by @${req.actor}**`, "> Auto-review is paused for this PR only. Gate enforcement and the one-shot disposition are unchanged; use `@loopover resume` to re-enable auto-review.", "", `- Reason: ${safeReason}`, "", "---", loopoverFooter(env)].join("\n"));
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
 * `@loopover resume` (#2165, part of #1960): the inverse of pause — clears the per-PR auto-review-paused
 * marker by recording a `github_app.autoreview_resumed` event that SUPERSEDES an earlier pause (see
 * hasAutoreviewPausedMarker below, which now reads the MOST RECENT of {paused, resumed} rather than merely
 * checking pause existence — see that function's own doc comment for why the old existence-only check made
 * resume a no-op). Same hard constraint as pause: AUTO-REVIEW SCOPE ONLY, never touches the Gate check-run,
 * AgentActionMode, or the one-shot disposition. Mirrors maybeProcessPauseCommand's classify → authorize →
 * record shape exactly. Returns true once it owns the event.
 */
async function maybeProcessResumeCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseLoopOverMentionCommand(payload.comment?.body);
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
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "resume" as LoopOverMentionCommandName, settings, pr });
  if (!authorization.authorized) {
    await recordAuditEvent(env, { eventType: "github_app.autoreview_resumed_denied", actor: req.actor, targetKey, outcome: "denied", detail: authorization.reason, metadata: { deliveryId, repoFullName: req.repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resume") } });
    await recordGithubProductUsage(env, "autoreview_resumed_denied", { actor: req.actor, repoFullName: req.repoFullName, targetKey, outcome: "denied", metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "resume") } });
    return true;
  }
  const confirmation = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **Auto-review resumed by @${req.actor}**`, "> Auto-review is resumed for this PR. Gate enforcement and the one-shot disposition were never affected by pause.", "", "---", loopoverFooter(env)].join("\n"));
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
 * `@loopover explain <finding>` (#2169, part of #1960): a contributor/maintainer asks for more detail on a
 * specific posted review finding. Read-only — it looks the finding up in THIS PR's current advisory (the same
 * source `resolve` acts on) and echoes its ALREADY-generated, public-safe rationale; it deliberately runs NO
 * model (new generation is a separate maintainer-owned budget concern) and mutates nothing, so — like the
 * `configuration` info command — it posts regardless of the agent action mode. Requires naming a specific finding:
 * an absent argument (which `normalizeResolveFindingRef` reads as `whole_pr`) is a skip, not "explain everything".
 * An unknown id gets a public-safe not-found note rather than a silent no-op. Returns true once it owns the event.
 */
async function maybeProcessExplainCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseLoopOverMentionCommand(payload.comment?.body);
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
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "explain" as LoopOverMentionCommandName, settings, pr });
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
    const notFound = sanitizePublicComment([AGENT_COMMAND_COMMENT_MARKER, "", "> [!NOTE]", `> **No review finding \`${findingRef.findingCode}\` on this PR**`, "> That id is not among this PR's current review findings — re-run `@loopover explain <finding-id>` with an id from the review summary.", "", "---", loopoverFooter(env)].join("\n"));
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
      loopoverFooter(env),
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
 * `@loopover generate-tests` (#4195, part of the #4189 epic): on-demand, MAINTAINER-ONLY AI-generated E2E
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
  const command = parseLoopOverMentionCommand(payload.comment?.body);
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
  const { authorization } = await authorizePrActionActor({ env, deliveryId, installationId: req.installationId, repoFullName: req.repoFullName, issue: payload.issue!, actor: req.actor, commandName: "generate-tests" as LoopOverMentionCommandName, settings, pr });
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
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
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
 * The shared generation-and-delivery core behind `@loopover generate-tests` (#4195, the explicit command),
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
  const result = await runLoopOverE2eTestGeneration(withAdvisoryAiEnv(env, args.settings.advisoryAiRouting?.e2eTestGen === true), {
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

  const body = buildE2eTestGenCommentBody({ actor: args.actor, testSource, commit: commitOutcome, env });
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
      sanitizePublicComment(buildE2eTestGenCommentBody({ actor: args.actor, testSource: null, env })),
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
      "> Ask a maintainer to enable `features.e2eTests` in `.loopover.yml` (the operator's global flag must also be on).",
      "",
      "---",
      loopoverFooter(env),
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
 * `@loopover configuration` (#2168): post the EFFECTIVE resolved review config (yml>DB>defaults) as a
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
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const body = sanitizePublicComment(
    [AGENT_COMMAND_COMMENT_MARKER, "", summarizeEffectiveConfig(settings, mode), "", "---", loopoverFooter(env)].join("\n"),
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
 * `@loopover plan` (#issue-coding-plan, gated by LOOPOVER_REVIEW_PLANNER + the per-repo `settings.plannerMode`
 * override, #issue-coding-plan-config). On a MAINTAINER's comment on an ISSUE (not a PR), generate a concise
 * implementation plan from the issue text via Workers AI and post it as an issue comment so a contributor has a
 * concrete starting point. Disabled (fleet default OFF and no repo override) returns false before any classify/
 * parse, so `@loopover plan` falls through to the existing mention path → byte-identical. Returns true once it
 * owns the event (so the caller records it processed and stops). Fail-safe: a model/post error is recorded as a
 * skip and never throws into the webhook loop. A per-actor/per-repo cooldown prevents repeated maintainer comments
 * from spending shared AI quota in a burst.
 */
async function maybeProcessPlanCommand(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  // Cheap synchronous checks FIRST: an unrelated comment or a PR-thread comment never pays for a manifest load
  // below, matching the pre-#issue-coding-plan-config behavior byte-for-byte for both cases.
  if (!isPlanCommand(payload.comment?.body)) return false;
  // #22: planning is ISSUE-only. A `@loopover plan` on a PR is not a plan request, so DON'T consume it — fall
  // through to the generic mention handler so it posts the help card, exactly as the disabled path does. Without
  // this the enabled worker swallowed a PR-thread `plan` mention and the contributor saw nothing.
  if (payload.issue?.pull_request) return false;
  // Per-repo override (#issue-coding-plan-config): `.loopover.yml settings.plannerMode` can turn the command ON
  // for a repo even when the fleet default (LOOPOVER_REVIEW_PLANNER) is off, or OFF even when the fleet default
  // is on — mirrors resolveDuplicateWinnerEnabled's inherit/off/enabled shape. repoFullName is read directly off
  // the payload (the same one-liner classifyPlanCommandRequest below uses) rather than running the classifier
  // just to get it, since the classifier also needs installationId/actor this cheap gate doesn't. No repo name
  // at all (edge case) ⇒ no manifest to load, so the fleet-only default decides. loadRepoFocusManifest is
  // fail-safe on its own, but a webhook handler must never let a manifest-load blip throw into the queue loop —
  // same `.catch(() => null)` convention every other manifest-driven feature in this file uses (e.g.
  // runReviewRecapJob, resolveVisualCaptureConfig).
  const repoFullName = payload.repository?.full_name ?? null;
  const manifest = repoFullName ? await loadRepoFocusManifest(env, repoFullName).catch(() => null) : null;
  if (!resolvePlannerEnabled(isPlannerEnabled(env), manifest?.settings.plannerMode)) return false;
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
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
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
      env,
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
  if (!isLoopOverPanelBotComment(env, comment.user)) return false;

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
 * `runE2eTestGenerationAndDeliver` core `@loopover generate-tests` (#4195) and the `manifest_missing_tests`
 * auto-trigger (#4196) already use, rather than a full panel re-render.
 *
 * Authorization uses the repo's OWN `settings.commandAuthorization` — same as the text-command version of
 * `generate-tests` above, and configurable like every other command (#4589 follow-up: this used to hardcode a
 * maintainer-only override here, overriding whatever `.loopover.yml` configured; a self-hoster who wants
 * contributors/confirmed miners to trigger test generation can now widen it there instead). Out of the box —
 * no override configured — this still resolves to maintainer-only, since `DEFAULT_COMMAND_AUTHORIZATION_POLICY`
 * already restricts `generate-tests` to `["maintainer"]` and `normalizeCommandRoleList` clamps any configured
 * widening to `maintainer`/`collaborator`/`confirmed_miner` (the spoofable raw `pr_author` role is always
 * dropped for this command). An unauthorized click is a SILENT no-op (no comment fetch, no patch, no revert, no
 * explanation) — audit-logged only, exactly mirroring `maybeProcessPrPanelRetrigger`'s own denial behavior above.
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
  if (!isLoopOverPanelBotComment(env, comment.user)) return false;

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
    commandName: "generate-tests" as LoopOverMentionCommandName,
    settings,
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
        allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "generate-tests"),
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

  // Defense in depth: re-check the feature is STILL enabled -- the repo's own .loopover.yml could have
  // changed between when this comment was posted (checkbox rendered) and when it was actually clicked.
  const manifest = await loadRepoFocusManifest(env, repoFullName).catch(() => null);
  if (!resolveConvergedFeature(env, manifest, "e2eTests", repoFullName)) {
    await recordGenerateTestsSkip(env, deliveryId, repoFullName, `${repoFullName}#${pr.number}`, actor, "feature_disabled");
    return true;
  }
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
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

// #824 the SINGLE real-permission authorization gate for @loopover action commands (gate-override, the
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
  commandName: LoopOverMentionCommandName;
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
    settings,
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
    duplicateWinnerEnabled: resolveDuplicateWinnerEnabled(isDuplicateWinnerEnabledGlobally(env), settings.duplicateWinnerMode),
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

function isLoopOverPanelBotComment(
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


// Audit eventType for one recorded @loopover ping (#2463). Shared between the recorder below and the
// cooldown-window count query so a naming drift can't silently under/over-count.
const REVIEW_NAG_PING_EVENT_TYPE = "github_app.review_nag_ping";

/**
 * Review-request nagging cooldown (#2463, anti-abuse): throttle a thread's OWN author repeatedly pinging
 * @loopover for review. Runs BEFORE maybeProcessLoopOverMentionCommand below so a throttled ping
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
  // Only a NEWLY-created comment counts as a ping (mirrors maybeProcessLoopOverMentionCommand) — an edited
  // or deleted comment must not re-count or double-count.
  if (payload.action !== "created") return false;
  const command = parseLoopOverMentionCommand(payload.comment?.body);
  if (!command) return false; // not an @loopover mention at all
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
  // Repo-wide, not per-target (#review-nag-cross-pr-carryover): counts every @loopover ping this actor has
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
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
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
        `@${commenter} this thread has reached the review-request cooldown limit (${maxPings} pings within ${cooldownDays} days). Please wait for the cooldown window to pass before pinging @loopover again. This is an automated maintenance action.`,
      ).catch(
        /* v8 ignore next -- fail-safe: a comment-post failure must not crash the throttle decision itself */
        () => undefined,
      );
    }
    await recordAuditEvent(env, {
      eventType: "github_app.review_nag_cooldown_applied",
      actor: "loopover",
      targetKey,
      outcome: mode === "live" ? "completed" : "denied",
      detail: `hold applied: ${commenter} pinged ${pingCount} times (limit ${maxPings})`,
      metadata: { deliveryId, repoFullName, mode, policy },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return true; // short-circuit — skip the normal @loopover command dispatch
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
      actor: "loopover",
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
 *  `parseLoopOverMentionCommand`'s own `@loopover` detection (a literal match, not an intent classifier):
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
 * pinging `@loopover`. Reuses the exact same policy/threshold/cooldown/label settings as
 * {@link maybeThrottleReviewNagPing} (one cooldown policy, multiple watched mention targets) and the same
 * thread-author-only scoping + owner/admin/bot/autoCloseExemptLogins exemptions, but counts EACH mentioned login
 * independently (and independently of the `@loopover` counter) so pinging the bot and pinging a maintainer
 * don't share one budget. Runs regardless of whether the comment also contains an `@loopover` mention/command
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
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
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
      actor: "loopover",
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
      actor: "loopover",
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
      installationPermissions: installation?.permissions ?? null,
      authorLogin: pr.authorLogin,
      moderationSettings: { moderationGateMode: settings.moderationGateMode, moderationRules: settings.moderationRules, moderationWarningLabel: settings.moderationWarningLabel, moderationBannedLabel: settings.moderationBannedLabel },
    },
    planned,
  );
  return true;
}

// Audit eventType for one recorded @loopover command invocation (#2560). Shared between the recorder below
// and the cooldown-window count query so a naming drift can't silently under/over-count. Exported so the
// maintainer-dashboard chat Q&A route (#6489) counts against this SAME per-(actor, targetKey) budget rather
// than inventing a second counter -- a maintainer's dashboard questions and their own `@loopover chat`
// PR-comment usage on the same PR share one limit.
export const COMMAND_RATE_LIMIT_EVENT_TYPE = "github_app.command_invocation";
// How far back to look for a redelivered webhook's OWN prior invocation record. Deliberately much shorter
// than the rate-limit window itself (hours) -- a genuine GitHub redelivery lands within seconds/minutes.
const COMMAND_RATE_LIMIT_REDELIVERY_WINDOW_MS = 10 * 60_000;

/**
 * Per-command @loopover rate limit (#2560, anti-abuse): generalizes review-nag's audit-ledger counting
 * pattern to EVERY `@loopover` Q&A command, not just review-request pings. The full `targetKey` (still
 * `repo#issueNumber#command`, used for the redelivery guard and the audit-trail record below) stays
 * per-thread, but the BUDGET COUNT itself is repo-wide via `countRecentAuditEventsForActorInRepoWithTargetSuffix`
 * (#rate-limit-cross-thread-carryover, the same cross-PR-carryover fix #4021 already applied to review-nag's
 * own cooldown) — pinned to THIS command's own suffix so one command's budget never bleeds into another's, but
 * no longer resettable by simply invoking the command on a fresh issue/PR (a bare per-target count would reset
 * to 0 the moment `issueNumber` changes, letting an actor who exhausts the limit on thread A get a full new
 * budget on thread B). Independent of, and complementary to, `maybeThrottleReviewNagPing` above: that one stays
 * scoped to the thread's OWN author and can close a PR; this covers ANY authorized actor invoking ANY command
 * and only ever holds (declines with a notice), never closes. Off (`commandRateLimitPolicy: "off"`, the
 * default) is a complete no-op.
 */
async function maybeThrottleLoopOverCommand(
  env: Env,
  args: {
    deliveryId: string;
    repoFullName: string;
    issueNumber: number;
    installationId: number;
    commenter: string;
    command: LoopOverMentionCommandName;
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
  // Repo-wide, not per-target (#rate-limit-cross-thread-carryover), but still pinned to THIS command's own
  // suffix so independently-budgeted commands never bleed into each other's count.
  const priorInvocations = await countRecentAuditEventsForActorInRepoWithTargetSuffix(
    env,
    args.commenter,
    COMMAND_RATE_LIMIT_EVENT_TYPE,
    args.repoFullName,
    args.command,
    sinceIso,
  );
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
    actor: "loopover",
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

const INTENT_ROUTING_RATE_LIMIT_EVENT_TYPE = "github_app.intent_routing_invocation";
// Shared between the full targetKey (redelivery guard / audit-trail record) and the repo-wide count's suffix
// filter below, so a naming drift between the two can never silently under/over-count (#rate-limit-cross-thread-carryover).
const INTENT_ROUTING_TARGET_SUFFIX = "intent-routing";

/**
 * Dedicated rate limit for the intent-classification router (#4596): every unrecognized-verb mention with
 * non-trivial trailing text that reaches the classifier consumes ONE tick here, using the SAME AI-cost-bearing
 * ceiling (`commandRateLimitAiMaxPerWindow`) and "off"/"hold" policy switch as every other AI-cost-bearing
 * command, with hold policy required before the cost-bearing classifier can run -- kept as its OWN counter (not folded into any single command's bucket via
 * `maybeThrottleLoopOverCommand`) because an unrecognized-verb mention isn't attributable to any one command
 * until AFTER classification runs, and a "no match" classification must still count for budget-ledger
 * consistency (req 5) even though it never becomes a real command dispatch. Fails OPEN when policy is off or any throttle trips: this
 * only ever skips the classifier call itself, never blocks the existing did-you-mean fallback it would
 * otherwise replace -- a contributor still gets a reply either way.
 */
async function maybeThrottleIntentRouting(
  env: Env,
  args: {
    deliveryId: string;
    repoFullName: string;
    issueNumber: number;
    commenter: string;
    settings: RepositorySettings;
  },
): Promise<boolean> {
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete "off"/"hold"; the undefined side is defensive against the field's optional TS type. */
  const policy = args.settings.commandRateLimitPolicy ?? "off";
  if (policy === "off") return true;

  const targetKey = `${args.repoFullName}#${args.issueNumber}#${INTENT_ROUTING_TARGET_SUFFIX}`;
  const redeliverySinceIso = new Date(Date.now() - COMMAND_RATE_LIMIT_REDELIVERY_WINDOW_MS).toISOString();
  const alreadySeen = await hasAuditEventForDelivery(env, args.commenter, INTENT_ROUTING_RATE_LIMIT_EVENT_TYPE, targetKey, args.deliveryId, redeliverySinceIso);
  // A redelivered webhook must not re-classify (and re-spend shared neuron budget) for one real mention.
  if (alreadySeen) return true;

  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer; the undefined side is defensive against the field's optional TS type. */
  const maxPerWindow = args.settings.commandRateLimitAiMaxPerWindow ?? 5;
  /* v8 ignore next -- resolveRepositorySettings always resolves a concrete positive integer; the undefined side is defensive against the field's optional TS type. */
  const windowHours = args.settings.commandRateLimitWindowHours ?? 24;
  const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  // Repo-wide, not per-target (#rate-limit-cross-thread-carryover) -- same fix as maybeThrottleLoopOverCommand
  // above, mirroring review-nag's #4021 cross-PR-carryover pattern.
  const priorInvocations = await countRecentAuditEventsForActorInRepoWithTargetSuffix(
    env,
    args.commenter,
    INTENT_ROUTING_RATE_LIMIT_EVENT_TYPE,
    args.repoFullName,
    INTENT_ROUTING_TARGET_SUFFIX,
    sinceIso,
  );
  const invocationCount = priorInvocations + 1;

  await recordAuditEvent(env, {
    eventType: INTENT_ROUTING_RATE_LIMIT_EVENT_TYPE,
    actor: args.commenter,
    targetKey,
    outcome: "completed",
    detail: `intent-routing invocation ${invocationCount}/${maxPerWindow} within ${windowHours}h window`,
    metadata: { deliveryId: args.deliveryId, repoFullName: args.repoFullName },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the classifier attempt */
    () => undefined,
  );

  return invocationCount > maxPerWindow;
}

async function maybeProcessLoopOverMentionCommand(
  env: Env,
  deliveryId: string,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  // Only act on a NEWLY-created comment (mirrors maybeProcessGateOverrideCommand / maybeProcessPlanCommand). Without
  // this an `edited` comment re-runs the agent + rewrites the card, and a `deleted` command still posts an answer
  // card for a command that no longer exists (#review-audit).
  if (payload.action !== "created") return false;
  let command = parseLoopOverMentionCommand(payload.comment?.body);
  if (!command) return false;
  // Action commands (gate-override + the #1960 PR control-surface verbs) are handled by their own dispatch
  // earlier in processGitHubWebhook; they never produce a Q&A answer card here. Bail so the rest of this
  // handler narrows to Q&A commands only.
  if (isLoopOverActionCommand(command.name)) return false;
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

  // #788 write-safety: authorize @loopover Q&A maintainer commands by the commenter's REAL repo permission
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

  const pullRequestAuthor =
    cachedPullRequest?.authorLogin ?? issue.user?.login ?? null;

  // Intent-classification router (#4596): an unrecognized-verb mention with real trailing text (e.g. "why is
  // this stuck?") gets ONE chance to be re-routed to an existing Q&A command. Because the classifier is a
  // cost-bearing local-AI call, it is only attempted after the actor is authorized for at least one command the
  // router is allowed to pick and after the dedicated hold-policy throttle admits the request. A no-match (or
  // anything not enabled/available/authorized/throttled) leaves `command` untouched and the existing did-you-mean
  // fallback renders exactly as it always has.
  const needsIntentMinerDetection =
    command.name === "help" &&
    command.unrecognizedText &&
    settings.advisoryAiRouting?.intentRouting === true &&
    INTENT_ROUTABLE_COMMANDS.some((commandName) =>
      commandAuthorizationNeedsMinerDetection({
        policy: settings.commandAuthorization,
        commandName,
        commenterLogin: commenter,
        commenterAssociation,
        pullRequestAuthorLogin: pullRequestAuthor,
      }),
    );
  let official =
    pullRequestAuthor && needsIntentMinerDetection
      ? await getCachedOfficialMinerDetection(env, pullRequestAuthor, {
          targetKey: `${repoFullName}#${issue.number}`,
          deliveryId,
        })
      : undefined;
  let interpretedFrom: { question: string; matchedCommand: LoopOverMentionCommandName } | undefined;
  if (command.name === "help" && command.unrecognizedText && settings.advisoryAiRouting?.intentRouting === true) {
    const authorizedForIntentRouting = INTENT_ROUTABLE_COMMANDS.some((commandName) =>
      isAuthorizedCommandActor({
        commandName,
        commenterLogin: commenter,
        commenterAssociation,
        pullRequestAuthorLogin: pullRequestAuthor,
        officialAuthorDetection: official,
        commandAuthorizationPolicy: settings.commandAuthorization,
      }).authorized,
    );
    const throttled = authorizedForIntentRouting
      ? await maybeThrottleIntentRouting(env, { deliveryId, repoFullName, issueNumber: issue.number, commenter, settings })
      : true;
    if (!throttled) {
      const classification = await classifyLoopOverIntent(env, {
        text: command.unrecognizedText,
        advisoryAiRouting: settings.advisoryAiRouting,
        repoFullName,
        issueNumber: issue.number,
        actor: commenter,
        route: "github_app.intent_routing",
      });
      if (classification.status === "matched") {
        const matchedCommand = classification.command;
        interpretedFrom = { question: command.unrecognizedText, matchedCommand };
        command = {
          name: matchedCommand,
          raw: command.raw,
          question: matchedCommand === "ask" || matchedCommand === "chat" ? command.unrecognizedText : undefined,
        };
      }
    }
  }
  // Re-assert the action-command exclusion TypeScript's control-flow narrowing loses across the `let`
  // reassignment above: dead code by construction (INTENT_ROUTABLE_COMMANDS, github/commands.ts, never
  // contains an action-command name, so `command.name` can never actually be one here), but restores
  // `command.name`'s narrowed type for every reference below.
  /* v8 ignore next */
  if (isLoopOverActionCommand(command.name)) return false;

  // Respect pause/dry-run/global-freeze like every other agent-driven write in this file (#2258) — the answer
  // card is a live public comment post, same as gate-override's confirmation comment.
  const mentionMode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const needsMinerDetection = commandAuthorizationNeedsMinerDetection({
    policy: settings.commandAuthorization,
    commandName: command.name,
    commenterLogin: commenter,
    commenterAssociation,
    pullRequestAuthorLogin: pullRequestAuthor,
  });
  if (pullRequestAuthor && !official && (needsMinerDetection || command.name === "miner-context")) {
    official = await getCachedOfficialMinerDetection(env, pullRequestAuthor, {
      targetKey: `${repoFullName}#${issue.number}`,
      deliveryId,
    });
  }
  const authorization = isAuthorizedCommandActor({
    commandName: command.name,
    commenterLogin: commenter,
    commenterAssociation,
    pullRequestAuthorLogin: pullRequestAuthor,
    officialAuthorDetection: official,
    commandAuthorizationPolicy: settings.commandAuthorization,
    commandRateLimitPolicy: settings.commandRateLimitPolicy,
    // #5092: the per-PR rate-limit counter below never checks PR state on its own (a closed/merged PR keeps
    // its own counter forever; a brand-new PR gets a fresh one) -- without this, a contributor could keep a
    // fresh chat allowance indefinitely by reopening/reusing a closed PR or spamming cheap draft PRs.
    pullRequestOpenAndNotDraft: cachedPullRequest?.state === "open" && cachedPullRequest?.isDraft !== true,
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
    await maybeThrottleLoopOverCommand(env, {
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
  // #4595: resolved BEFORE the (synchronous) card renderer, mirroring how `bundle` above is fetched first --
  // generateChatQaAnswer is Ollama-only and never falls back to the frontier chain (a hard requirement, unlike
  // the other four advisoryAiRouting capabilities), so no withAdvisoryAiEnv() swap belongs here.
  const chatAnswer =
    command.name === "chat"
      ? await generateChatQaAnswer(env, {
          bundle,
          question: command.question,
          advisoryAiRouting: settings.advisoryAiRouting,
          repoFullName,
          issueNumber: issue.number,
          actor: commenter,
          route: "github_app.chat_qa",
        })
      : null;
  // Q&A commands (#5063): ask/chat answer a SPECIFIC question at a point in time, unlike every other command
  // here (preflight/blockers/etc.), which reports the PR's CURRENT state and therefore reasonably shares one
  // persistent, continuously-updated panel comment. Reusing that same panel slot for ask/chat meant each new
  // question silently overwrote the previous answer (and could overwrite the review verdict itself), with the
  // reply landing wherever the panel comment originally happened to sit -- never near the question that
  // prompted it. Post a fresh reply per invocation instead, linking back to the triggering comment.
  const isQaCommand = command.name === "ask" || command.name === "chat";
  const replyingToUrl = isQaCommand ? (payload.comment?.html_url ?? undefined) : undefined;
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
    chatAnswer,
    interpretedFrom,
    replyingToUrl,
    env,
  });
  const responseComment = isQaCommand
    ? mentionMode === "live"
      ? await createIssueComment(env, installationId, repoFullName, issue.number, body)
      : null
    : await createOrUpdateAgentCommandComment(
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
  // Both posting paths above suppress the actual write for a non-live mode -- createOrUpdateAgentCommandComment
  // does it internally; the isQaCommand branch checks mentionMode itself before calling createIssueComment,
  // which has no such awareness of its own. As with gate-override above, what must NOT happen unconditionally
  // is recording this as a completed reply: a paused/dry-run mention command never posted anything, so
  // telemetry (and the feedback prompt, which presumes a real reply exists to react to) must reflect that
  // instead of a reply that never happened.
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
  commandName: LoopOverMentionCommandName,
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
      (commandName === "ask" || commandName === "chat") && question && question.trim().length > 0
        ? `Respond to @loopover ${commandName} for ${context.repoFullName}#${context.issue.number}. Question: ${question.trim().slice(0, 280)}`
        : `Respond to @loopover ${commandName} for ${context.repoFullName}#${context.issue.number}.`,
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
