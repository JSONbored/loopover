// Barrel export for @loopover/engine.
//
// This package houses the deterministic, side-effect-free logic shared by the LoopOver review-stack
// backend and the loopover-miner (scoring preview/model, predicted-gate types, reward-risk, slop signals,
// focus-manifest parse/compile core, duplicate-winner adjudication, and their engine-parity fixtures).
// More modules land in follow-up issues.
export { ENGINE_VERSION } from "./version.js";
export {
  pickTopRankedOpportunities,
  rankOpportunityScore,
  rankOpportunities,
  type OpportunityRankInput,
} from "./opportunity-ranker.js";
export { rankOpportunitiesAtOrAboveScore } from "./ranked-opportunity-min-score.js";
export { pickTopRankedOpportunitiesAtOrAboveScore } from "./ranked-opportunity-top-min-score.js";
export { bestRankedOpportunity } from "./ranked-opportunity-best-pick.js";
export { bestRankedOpportunityAtOrAboveScore } from "./ranked-opportunity-best-min-score.js";
export {
  extractObjectiveAnchorHistory,
  extractObjectiveAnchorFeatures,
  scoreObjectiveAnchor,
  scoreObjectiveAnchorHistory,
  renderObjectiveAnchorAuditMarkdown,
  type ObjectiveAnchorAudit,
  type ObjectiveAnchorChangeKind,
  type ObjectiveAnchorDimensionScores,
  type ObjectiveAnchorFeatures,
  type ObjectiveAnchorHistoryExtraction,
  type ObjectiveAnchorHistoryItem,
  type ObjectiveAnchorHistoryItemAudit,
  type ObjectiveAnchorHistoryScore,
  type ObjectiveAnchorInput,
  type ObjectiveAnchorScore,
  type ObjectiveAnchorWeights,
} from "./objective-anchor.js";
export {
  computePairwiseCalibrationScore,
  resolvePairwiseCalibrationSample,
  type PairwiseCalibrationAttempt,
  type PairwiseCalibrationResolvedSample,
  type PairwiseCalibrationScore,
  type PairwiseCalibrationVerdict,
  type PairwiseCalibrationWeights,
} from "./pairwise-calibration.js";
export {
  computeGateVerdictCompositeCalibrationScore,
  ingestGateVerdictCalibrationSignals,
  renderGateVerdictCalibrationAuditMarkdown,
  resolveGateVerdictCalibrationConfig,
  type GateVerdictCalibrationConfig,
  type GateVerdictCalibrationDimension,
  type GateVerdictCalibrationDimensionInput,
  type GateVerdictCalibrationDimensionSignal,
  type GateVerdictCalibrationIngestion,
  type GateVerdictCalibrationManifest,
  type GateVerdictCalibrationOutcome,
  type GateVerdictCalibrationSignal,
  type GateVerdictCalibrationSignalInput,
  type GateVerdictCalibrationWeights,
  type GateVerdictCompositeCalibrationScore,
} from "./gate-verdict-calibration.js";
export {
  computePhase7CalibrationLoop,
  computePrOutcomeCalibrationAccuracy,
  DOCUMENTED_CALIBRATION_BASELINE,
  evaluateAutonomyIncreaseEligibility,
  isHistoricalReplayRunFresh,
  renderPhase7CalibrationAuditMarkdown,
  resolvePhase7CalibrationConfig,
  shouldScheduleHistoricalReplayRun,
  type CalibrationSignalSource,
  type CalibrationSourceMetric,
  type HistoricalReplayCalibrationInput,
  type Phase7CalibrationConfig,
  type Phase7CalibrationLoopResult,
  type Phase7CalibrationManifest,
  type PrOutcomeCalibrationInput,
  type ReplayHarnessStatus,
} from "./phase7-calibration-loop.js";
export {
  buildCalibrationDashboardView,
  resolveCalibrationDashboardStatus,
  type CalibrationDashboardRow,
  type CalibrationDashboardStatus,
  type CalibrationDashboardView,
} from "./calibration-dashboard.js";
export {
  buildCalibrationTrendView,
  calibrationSnapshotFromResult,
  type CalibrationTrendDirection,
  type CalibrationTrendPoint,
  type CalibrationTrendSnapshot,
  type CalibrationTrendView,
} from "./calibration-trend.js";
export {
  computeFindingSeverityCompositeCalibrationScore,
  ingestFindingSeverityCalibrationSignals,
  renderFindingSeverityCalibrationAuditMarkdown,
  resolveFindingSeverityCalibrationConfig,
  type FindingSeverityCalibrationConfig,
  type FindingSeverityCalibrationIngestion,
  type FindingSeverityCalibrationManifest,
  type FindingSeverityCalibrationSignal,
  type FindingSeverityCalibrationSignalInput,
  type FindingSeverityCalibrationWeights,
  type FindingSeverityCompositeCalibrationScore,
  type FindingSeverityTier,
  type FindingSeverityTierInput,
  type FindingSeverityTierSignal,
} from "./finding-severity-calibration.js";
export {
  computeReviewerConsensusCompositeCalibrationScore,
  ingestReviewerConsensusCalibrationSignals,
  renderReviewerConsensusCalibrationAuditMarkdown,
  resolveReviewerConsensusCalibrationConfig,
  type ReviewerConsensusCalibrationConfig,
  type ReviewerConsensusCalibrationIngestion,
  type ReviewerConsensusCalibrationManifest,
  type ReviewerConsensusCalibrationSignal,
  type ReviewerConsensusCalibrationSignalInput,
  type ReviewerConsensusCalibrationWeights,
  type ReviewerConsensusCompositeCalibrationScore,
  type ReviewerConsensusDimension,
  type ReviewerConsensusDimensionInput,
  type ReviewerConsensusDimensionSignal,
  type ReviewerConsensusVote,
} from "./reviewer-consensus-calibration.js";
export {
  computeTrackRecordSummary,
  getTrackRecordSummary,
  TRACK_RECORD_SUMMARY_READ_VERSION,
  renderTrackRecordSummaryMarkdown,
  resolveTrackRecordSummaryConfig,
  shouldIncludeTrackRecordSummary,
  type TrackRecordIncidentKind,
  type TrackRecordIncidentRecord,
  type TrackRecordIncidentStatus,
  type TrackRecordMergeRate,
  type TrackRecordPullRequestOutcome,
  type TrackRecordPullRequestState,
  type TrackRecordSummary,
  type TrackRecordSummaryAudit,
  type TrackRecordSummaryConfig,
  type TrackRecordSummaryManifest,
  type TrackRecordSummaryOutcomeCounts,
  type TrackRecordSummaryReadResult,
  type TrackRecordTenure,
} from "./track-record-summary.js";
export {
  TRUST_SIGNAL_LEVELS,
  TRUST_SIGNAL_SOURCES,
  type TrustSignal,
  type TrustSignalLevel,
  type TrustSignalSource,
} from "./trust-signal.js";
export * from "./governor/rate-limit.js";
export * from "./governor/budget-cap.js";
export * from "./governor/self-plagiarism.js";
export * from "./governor/reputation-throttle.js";
export * from "./governor/write-rate-limit.js";
export * from "./governor/run-halt.js";
export * from "./governor/kill-switch.js";
export * from "./governor/action-mode.js";
export * from "./governor/chokepoint.js";
export {
  GOVERNOR_LEDGER_EVENT_TYPES,
  normalizeGovernorLedgerEvent,
  type GovernorLedgerEvent,
  type GovernorLedgerEventType,
  type NormalizedGovernorLedgerEvent,
} from "./governor-ledger.js";
export {
  MINER_TELEMETRY_EVENT_TYPES,
  MINER_TELEMETRY_OUTCOME_BUCKETS,
  normalizeMinerTelemetryEvent,
  type MinerTelemetryEvent,
  type MinerTelemetryEventType,
  type MinerTelemetryOutcomeBucket,
  type NormalizedMinerTelemetryEvent,
} from "./miner-telemetry.js";
export {
  MINER_PREDICTIONS_TOTAL,
  MINER_PREDICTION_CORRECT_TOTAL,
  MINER_PREDICTION_INCORRECT_TOTAL,
  renderMinerPredictionMetrics,
  type MinerPredictionMetricRow,
} from "./miner-prediction-metrics.js";
export {
  ATTEMPT_LOG_EVENT_TYPES,
  createAttemptLogBuffer,
  formatAttemptLogJsonl,
  normalizeAttemptLogEvent,
  type AttemptLogEvent,
  type AttemptLogEventType,
  type NormalizedAttemptLogEvent,
} from "./miner/attempt-log.js";
export {
  ACCEPTANCE_CRITERIA_FILENAME,
  ACCEPTANCE_CRITERIA_VERSION,
  buildAcceptanceCriteria,
  serializeAcceptanceCriteria,
  shouldWriteAcceptanceCriteria,
  type AcceptanceCriteria,
  type AcceptanceCriteriaInput,
} from "./miner/acceptance-criteria.js";
// Pure deny-hook evaluator + rule-proposal synthesis moved out of loopover-miner (#5667). The miner-lib
// `deny-hooks.js`/`deny-hook-synthesis.js` are now thin wrappers over these (the SQLite proposal store stays in
// the miner). `synthesizeDenyRuleProposals` takes an injected `nowMs` clock so synthesis is deterministic/pure.
export {
  DEFAULT_DENY_RULES,
  evaluateDenyHooks,
  type DenyRule,
  type DenyVerdict,
  type ProposedToolCall,
} from "./miner/deny-hooks.js";
export {
  DEFAULT_SYNTHESIS_CONFIG,
  PROPOSAL_STATUSES,
  aggregateBlockerHistory,
  canonicalizeChangedPath,
  changedPathToDenyGlob,
  isCoveredByDefaultDenyRules,
  normalizeBlockerHistory,
  normalizeBlockerHistoryRecord,
  normalizeRepoFullName,
  proposalStatusSet,
  resolveEffectiveDenyRules,
  setProposalStatuses,
  synthesizeDenyRuleProposals,
  type BlockerHistoryRecord,
  type DenyRuleProposal,
  type DenyRuleProposalAudit,
  type DenyRuleProposalStatus,
  type SynthesisConfig,
} from "./miner/deny-hook-synthesis.js";
// The subset of types/predicted-gate-types.ts's hand-kept mirrors (see that file's own header comment) that
// the self-review adapter's public signature (SelfReviewContext, SelfReviewSlopAssessment) references. Not
// previously part of the public barrel; exported now so those types are actually nameable by consumers.
export type {
  AdvisoryFinding,
  BountyRecord,
  IssueQualityReport,
  IssueRecord,
  PullRequestRecord,
  RepositoryRecord,
} from "./types/predicted-gate-types.js";
export {
  buildSelfReviewChangedPaths,
  buildSelfReviewPredictedGateInput,
  buildSelfReviewSlopInput,
  runSelfReview,
  SELF_REVIEW_PASSING_CONCLUSION,
  type AttemptDiffState,
  type SelfReviewAdapterDeps,
  type SelfReviewChangedFile,
  type SelfReviewContext,
  type SelfReviewSlopAssessment,
  type SelfReviewSlopBand,
  type SelfReviewSlopInput,
  type SelfReviewVerdict,
} from "./miner/self-review-adapter.js";
export {
  decideNextAction,
  decideNextActionWithReason,
  deriveSelfReviewOutcome,
  type AbandonReason,
  type HandoffPacket,
  type IterateLoopAction,
  type IterateLoopDecision,
  type IterationState,
  type SelfReviewOutcome,
} from "./miner/iterate-policy.js";
export {
  runIterateLoop,
  type IterateLoopDeps,
  type IterateLoopShouldAbort,
  type IterateLoopInput,
  type IterateLoopIterationRecord,
  type IterateLoopOutcome,
  type IterateLoopResult,
} from "./miner/iterate-loop.js";
export {
  isSlopBandWithinThreshold,
  shouldSubmit,
  SUBMISSION_GATE_PASSING_CONCLUSION,
  type SubmissionGateCandidate,
  type SubmissionGateDecision,
  type SubmissionGateMode,
} from "./miner/submission-gate.js";
export {
  DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS,
  DEFAULT_MAX_REENTRIES_PER_HOUR,
  DEFAULT_MAX_REENTRIES_PER_SESSION,
  shouldReenter,
  type LoopReentryCandidate,
  type LoopReentryDecision,
  type LoopReentryOutcome,
} from "./miner/loop-reentry-policy.js";
export {
  DEFAULT_MAX_CONSECUTIVE_GATE_BLOCKS,
  evaluateHarnessSubmissionTrigger,
  type HarnessSubmissionTriggerCandidate,
  type HarnessSubmissionTriggerDecision,
} from "./miner/harness-submission-trigger.js";
export {
  codingAgentModeExecutes,
  isGlobalMinerCodingAgentPause,
  resolveCodingAgentExecutionMode,
  resolveCodingAgentModeFromConfig,
  type CodingAgentExecutionMode,
} from "./miner/coding-agent-mode.js";
export {
  createFakeCodingAgentDriver,
  createNoopCodingAgentDriver,
  type CodingAgentDriver,
  type CodingAgentDriverResult,
  type CodingAgentDriverTask,
} from "./miner/coding-agent-driver.js";
export {
  createCliSubprocessCodingAgentDriver,
  defaultClaudeCliArgs,
  defaultCodexCliArgs,
  type CliSubprocessDriverOptions,
  type CliSubprocessSpawnFn,
} from "./miner/cli-subprocess-driver.js";
export {
  addWorktree,
  planWorktree,
  removeWorktree,
  shouldRetainWorktree,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_SUBDIR,
  type WorktreeAddResult,
  type WorktreeExecFn,
  type WorktreeExecResult,
  type WorktreePlan,
  type WorktreeRemoveResult,
} from "./miner/worktree-plan.js";
export * from "./miner/worktree-pool.js";
export {
  invokeCodingAgentDriver,
  type AttemptLogSink,
} from "./miner/coding-agent-invoke.js";
export {
  classifyLintGuardPackage,
  guardChangedFiles,
  guardCodingAgentDriverResult,
  type LintGuardCheckResult,
  type LintGuardedDriverResult,
  type LintGuardOptions,
  type LintGuardPackage,
  type LintGuardResult,
  type LintGuardSpawnFn,
} from "./miner/lint-guard.js";
export {
  CODING_AGENT_DRIVER_CONFIG_ENV,
  CODING_AGENT_DRIVER_NAMES,
  createCodingAgentDriver,
  createFakeCodingAgentDriverForFactory,
  isConfiguredCodingAgentDriver,
  resolveConfiguredCodingAgentDriverNames,
  resolveFirstConfiguredCodingAgentDriverName,
  runCodingAgentAttempt,
  type CodingAgentDriverName,
  type CreateCodingAgentDriverOptions,
  type RunCodingAgentAttemptOptions,
} from "./miner/driver-factory.js";
export * from "./miner/attempt-metering.js";
export {
  buildRepoMap,
  extractRepoMapSymbols,
  renderRepoMap,
  resolveRepoMapLanguage,
  type BuildRepoMapOptions,
  type ExtractRepoMapSymbolsOptions,
  type LoadRepoMapLanguageFn,
  type RepoMapFileEntry,
  type RepoMapSkipReason,
  type RepoMapSourceFile,
  type RepoMapSymbol,
  type RepoMapSymbolKind,
} from "./miner/repo-map.js";
export {
  createAgentSdkCodingAgentDriver,
  type AgentSdkHooks,
  type AgentSdkQueryFn,
  type AgentSdkQueryOptions,
  type CreateAgentSdkDriverOptions,
} from "./miner/agent-sdk-driver.js";
export {
  buildChatPrompt,
  CHAT_GROUNDING_MCP_SERVER_NAME,
  CHAT_GROUNDING_TOOL_NAMES,
  CHAT_REDACTED_TEXT,
  CHAT_SYSTEM_PROMPT,
  containsBlockedTerm,
  isValidChatMessages,
  redactBlockedText,
  resolveChatProviderError,
  resolveChatQuery,
  runChatGrounding,
  type ChatGroundingEvent,
  type ChatMessage,
  type ChatQueryFn,
  type ChatQueryOptions,
  type RunChatGroundingOptions,
} from "./miner/chat-grounding.js";
export {
  LOCAL_WRITE_BOUNDARY,
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
  type LocalWriteJsonValue,
} from "./miner/local-write-tools.js";
export {
  GENERIC_COMMIT_PATTERN,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
  buildDuplicateClusterFinding,
  buildEmptyDescriptionFinding,
  buildLowQualityCommitMessageFinding,
  buildMissingTestEvidenceFinding,
  buildNoLinkedIssueRationaleFinding,
  buildNonSubstantivePaddingFinding,
  buildSlopAssessment,
  buildTrivialWhitespaceChurnFinding,
  hasClearNoIssueRationale,
  type SlopAssessment,
  type SlopAssessmentInput,
  type SlopBand,
  type SlopChangedFile,
} from "./signals/slop.js";
// Scoped (not `export *`) because predicted-gate-engine.ts also defines its own hasClearNoIssueRationale --
// a near-duplicate of slop.js's own export (see that function's doc comment) -- which would collide with the
// one already re-exported above. Only buildCollisionReport + its result types are needed publicly so far
// (#5145, the miner's real SelfReviewContext fetcher needs to compute inDuplicateCluster the same way the
// live gate does), not this file's full internal surface.
export { buildCollisionReport, type CollisionCluster, type CollisionReport } from "./signals/predicted-gate-engine.js";
export type { CollisionItem } from "./types/predicted-gate-types.js";
// Package-local twin of the host engine's buildIssueQualityReport (#6057). Do NOT re-export from
// `./signals/engine.js` — that file is excluded from this package's tsc emit (host-bound imports) and
// pulling it into the public barrel breaks `npm run build` (closed #6139).
export { buildIssueQualityReport } from "./signals/issue-quality-report.js";
// Deterministic PR-text-lint rubric (#549), extracted from the host-bound `signals/engine.ts` (#6268) so the
// published loopover-mcp CLI can compute `loopover_lint_pr_text` in-process instead of proxying over HTTP.
export {
  buildPrTextLint,
  type PrTextLintComponent,
  type PrTextLintInput,
  type PrTextLintReport,
} from "./signals/pr-text-lint.js";
// Unlinked-issue candidate pre-filter (#4883), extracted out of src/signals/unlinked-issue-candidates.ts so the
// miner's self-review can run the SAME deterministic recall pass the maintainer gate uses to flag a PR's
// likely-but-unlinked issue, instead of a driftable copy. PURE — no IO, no AI call.
export {
  findUnlinkedIssueCandidates,
  MAX_CANDIDATES,
  type CandidateOpenIssue,
  type FindUnlinkedIssueCandidatesInput,
  type UnlinkedIssueCandidateMatch,
} from "./signals/unlinked-issue-candidates.js";
export * from "./plan-export.js";
export { countPlanStepsByStatus } from "./plan-step-stats.js";
export { countPlanSteps } from "./plan-step-count.js";
export { isPlanEmpty } from "./plan-empty.js";
export { isPlanFullyCompleted } from "./plan-completion.js";
export { hasPlanFailedSteps } from "./plan-failure.js";
export { hasPlanPendingSteps } from "./plan-pending.js";
export { hasPlanRunningSteps } from "./plan-running.js";
export { hasPlanSkippedSteps } from "./plan-skipped.js";
export { hasPlanCompletedSteps } from "./plan-completed.js";
export { isPlanBlocked } from "./plan-blocked.js";
export { isPlanProgressComplete } from "./plan-progress-complete.js";
export {
  resolvePlanOverallStatus,
  type PlanOverallStatus,
} from "./plan-overall-status.js";
export { hasPlanReadySteps } from "./plan-ready.js";
export { isPlanTerminated } from "./plan-terminated.js";
export * from "./plan-templates.js";
export * from "./issue-plan-decomposition.js";
export {
  PROMPT_PACKET_REDACTED_PATH,
  PROMPT_PACKET_REDACTED_TERM,
  PROMPT_PACKET_TEXT_FIELDS,
  buildPromptPacket,
  sanitizePromptPacketField,
  type PromptPacket,
  type PromptPacketInput,
  type PromptPacketTextField,
} from "./prompt-packet.js";
export * from "./portfolio/queue.js";
export * from "./portfolio/non-convergence.js";
export {
  applyAiPolicyFatigueToRankInput,
  createAiPolicyFatigueCacheEntry,
  describeAiPolicyFatigueCache,
  renderAiPolicyFatigueMarkdown,
  resolveAiPolicyFatigueVerdict,
  resolveAiPolicyVerdict,
  scanAiPolicyText,
  type AiFatigueDocLanguageChange,
  type AiFatiguePullRequestMetadata,
  type AiPolicyFatigueRankAdjustment,
  type AiPolicyFatigueRankInput,
  type AiPolicyFatigueCacheEntry,
  type AiPolicyFatigueCacheState,
  type AiPolicyFatigueEvidence,
  type AiPolicyFatigueEvidenceKind,
  type AiPolicyFatigueInput,
  type AiPolicyFatigueLevel,
  type AiPolicyFatigueVerdict,
  type AiPolicyPriorityAdjustment,
  type AiPolicySource,
  type AiPolicyVerdict,
} from "./ai-policy-map.js";
export {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpec,
  parseMinerGoalSpecContent,
  discoverMinerGoalSpecPath,
  MINER_GOAL_SPEC_FILENAMES,
  type FeasibilityGatePolicy,
  type MinerExecutionPolicy,
  type MinerGoalSpec,
  type MinerIssueDiscoveryPolicy,
  type MinerKillSwitchPolicy,
  type ParsedMinerGoalSpec,
} from "./miner-goal-spec.js";
export {
  DEFAULT_AMS_POLICY_SPEC,
  parseAmsPolicySpec,
  parseAmsPolicySpecContent,
  AMS_POLICY_SPEC_FILENAMES,
  type AmsCapLimits,
  type AmsPolicySpec,
  type AmsSlopThreshold,
  type AmsSubmissionMode,
  type ParsedAmsPolicySpec,
} from "./ams-policy-spec.js";
export {
  DEFAULT_FLEET_RUN_MANIFEST,
  parseFleetRunManifest,
  parseFleetRunManifestContent,
  type FleetRunManifest,
  type FleetRunManifestRepo,
  type ParsedFleetRunManifest,
} from "./fleet-run-manifest.js";
export {
  DISCOVERY_INDEX_CONTRACT_VERSION,
  DISCOVERY_INDEX_FORBIDDEN_FIELDS,
  discoveryIndexBoundaryViolations,
  normalizeDiscoveryIndexCandidate,
  normalizeDiscoveryIndexRequest,
  normalizeDiscoveryIndexResponse,
  type DiscoveryIndexAiPolicySource,
  type DiscoveryIndexCandidate,
  type DiscoveryIndexQuery,
  type DiscoveryIndexRequest,
  type DiscoveryIndexResponse,
  type ParsedDiscoveryIndexRequest,
  type ParsedDiscoveryIndexResponse,
} from "./discovery-index-contract.js";
export {
  buildSoftClaimRequest,
  softClaimActionForStatus,
  type SoftClaimAction,
  type SoftClaimRecord,
  type SoftClaimRequest,
  type SoftClaimRequestContext,
  type SoftClaimStatus,
} from "./discovery-soft-claim.js";
export {
  computeMetadataLaneFit,
  computeMinerGoalLaneFit,
  isMinerRepoTargetable,
} from "./miner-goal-lane-fit.js";
export {
  computeOpportunityFreshness,
  type FreshnessIssue,
} from "./opportunity-freshness.js";
export { computeOpportunityCompetition } from "./opportunity-competition.js";
export { computeLaneFit, type GoalModelInput } from "./goal-model.js";
export {
  classifyContributorFit,
  type ContributorFit,
  type ContributorFitCheck,
  type ContributorFitProfile,
} from "./contributor-fit.js";
export {
  buildFeasibilityVerdict,
  feasibilityInputFromPreStartCheck,
  type FeasibilityClaimStatus,
  type FeasibilityDuplicateClusterRisk,
  type FeasibilityGateInput,
  type FeasibilityGateResult,
  type FeasibilityIssueStatus,
  type FeasibilityVerdict,
} from "./feasibility.js";
export {
  buildClaimPlan,
  buildTaskGraph,
  scoreTaskGraph,
  validateIdeaSubmission,
  IDEA_TITLE_MAX_CHARS,
  IDEA_BODY_MAX_CHARS,
  IDEA_CONSTRAINT_MAX_CHARS,
  type AcceptanceCriterion,
  type ClaimPlan,
  type ClaimStep,
  type AcceptanceCriterionKind,
  type ConstituentIssue,
  type ConstituentIssueDraft,
  type IdeaPriority,
  type IdeaSubmission,
  type IdeaValidationResult,
  type TaskGraph,
  type TaskGraphIssueScore,
  type TaskGraphScore,
} from "./idea-intake.js";
export {
  buildResultsPayload,
  MAX_DIFF_PREVIEW_FILES,
  type DiffPreviewFile,
  type IterationResult,
  type LoopResultStatus,
  type ResultChangedFile,
  type ResultsPayload,
} from "./results-payload.js";
// `LoopConsumptionOutcome` is deliberately its own name, not loop-escalation.ts's `LoopRunOutcome` re-exported
// below: that one is a loop's HEALTH state (running/converged/abandoned/error), whereas a consumption entry
// only exists for a run that already stopped and only distinguishes finished work from work cut short.
// The customer-facing counterpart to #4808's internal ops fleet view: one customer's own loop only, with
// spend sourced through #4792's tenant-filtering primitive so another tenant's rows cannot reach it (#4807).
export {
  buildCustomerLoopView,
  type CustomerLoopSpend,
  type CustomerLoopView,
  type CustomerLoopViewInput,
} from "./customer-loop-view.js";
export {
  buildLoopConsumptionEntry,
  totalConsumptionForTenant,
  type LoopConsumptionEntry,
  type LoopConsumptionOutcome,
  type LoopRunFacts,
} from "./loop-consumption.js";
export {
  evaluateTenantQuota,
  type QuotaDimension,
  type TenantQuota,
  type TenantQuotaDecision,
  type TenantUsage,
} from "./tenant-quota.js";
export {
  DEFAULT_TENANT_CONFIG,
  EMPTY_TENANT_CONFIG_STORE,
  getTenantConfig,
  resolveTenantConfig,
  setTenantConfig,
  TENANT_AUTONOMY_LEVELS,
  type TenantAutonomyLevel,
  type TenantConfig,
  type TenantConfigOverrides,
  type TenantConfigStore,
  type TenantExecutionPreferences,
} from "./tenant-config.js";
export {
  buildProgressSnapshot,
  progressChanged,
  MAX_PROGRESS_ACTIVITY,
  type LoopPhase,
  type LoopProgressActivity,
  type LoopProgressState,
  type LoopRunStatus,
  type ProgressSnapshot,
} from "./loop-progress.js";
export {
  evaluateEscalation,
  type EscalationAction,
  type EscalationDecision,
  type EscalationSeverity,
  type LoopEscalationInput,
  type LoopHealthTier,
  type LoopRunOutcome,
} from "./loop-escalation.js";
// The internal ops fleet view (#4808) over the escalation vocabulary re-exported above: it calls the same
// evaluateEscalation per loop rather than restating what "needs a human" means.
export {
  buildActiveLoopFleetSummary,
  LOOP_HEALTH_TIERS,
  LOOP_RUN_STATUSES,
  type ActiveLoopFacts,
  type ActiveLoopFleetSummary,
  type FleetLoopRow,
} from "./loop-fleet-summary.js";
export {
  buildMetadataRankInput,
  computeMetadataDupRisk,
  computeMetadataFeasibility,
  computeMetadataPotential,
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "./opportunity-metadata.js";
export { pickTopMetadataOpportunities } from "./metadata-top-pick.js";
export { rankMetadataOpportunitiesAtOrAboveScore } from "./metadata-min-score.js";
export { pickTopMetadataOpportunitiesAtOrAboveScore } from "./metadata-top-min-score.js";
export { bestMetadataOpportunity } from "./metadata-best-pick.js";
export { bestMetadataOpportunityAtOrAboveScore } from "./metadata-best-min-score.js";
// Score-preview machinery (#2282): namespaced (rather than flattened) so the three ported files keep their
// own identity and cannot collide with each other or the ~50 other top-level exports above.
export * as scoringModel from "./scoring/model.js";
export * as scoringPreview from "./scoring/preview.js";
export * as scoringPendingPrScenarios from "./scoring/pending-pr-scenarios.js";
export {
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
  type DuplicateClaimMember,
} from "./duplicate-winner.js";
// Issue-centric RAG query composition (#2320, extracted in #4254): the pure query builder + the shared
// minimum-query floor; the Vectorize/D1 retrieval backend intentionally stays in the backend.
export {
  MIN_QUERY_CHARS,
  buildIssueRagQuery,
  type IssueRagQueryInput,
} from "./issue-rag-query.js";
// #782 deterministic local scorer (extracted in #4253): pure token-scoring from changed-file metadata,
// shared by the published CLIs and the hosted Worker. The Node-coupled local-branch.ts stays in the backend.
export {
  computeLocalScorerTokens,
  type LocalScorerChangedFile,
  type LocalScorerValidation,
  type LocalScorerResult,
} from "./local-scorer.js";
export {
  buildPredictedGateVerdict,
  predictedGateNote,
  publicSafeFinding,
  applyContributorCalibration,
  MIN_CALIBRATION_SAMPLES,
  MAX_READINESS_ADJUSTMENT,
  type GateCheckConclusion,
  type GatePolicyPack,
  type PredictedGateInput,
  type PredictedGateVerdict,
  type ContributorCalibrationSignal,
} from "./predicted-gate.js";
// Focus-manifest parse/compile core (#2280): shared by the maintainer review stack and the miner's
// `.loopover-miner.yml` goal-spec parser (see miner-goal-spec.ts for the parallel surface).
export {
  compileFocusManifestPolicy,
  contentLaneConfigToJson,
  experimentalConfigToJson,
  featuresConfigToJson,
  formatManifestValidationNotice,
  gateConfigToJson,
  isFocusManifestPublicSafe,
  matchesManifestPath,
  normalizeReadinessGateMode,
  parseFocusManifest,
  parseFocusManifestContent,
  repoDocGenerationConfigToJson,
  reviewConfigToJson,
  reviewRecapConfigToJson,
  maintainerRecapConfigToJson,
  opsConfigToJson,
  publicStatsConfigToJson,
  draftFlowConfigToJson,
  upstreamDriftIssuesConfigToJson,
  federatedIntelligenceConfigToJson,
  FEDERATED_COLLECTOR_MODES,
  settingsOverrideToJson,
  MAX_FOCUS_MANIFEST_BYTES,
  CONVERGED_FEATURE_KEYS,
  EXPERIMENTAL_PLUGIN_KEYS,
  COMMENT_VERBOSITY_LEVELS,
  EMPTY_AUTO_REVIEW_CONFIG,
  EMPTY_MAX_FINDINGS_CONFIG,
  EMPTY_SELF_HOST_AI_MODEL_CONFIG,
  EMPTY_VISUAL_CONFIG,
  LINKED_ISSUE_SATISFACTION_MODES,
  REVIEW_FIELD_KEYS,
  REVIEW_FINDING_SEVERITY_LADDER,
  REVIEW_PROFILES,
  type AutoReviewConfig,
  type CommentVerbosity,
  type ConvergedFeatureKey,
  type ExperimentalPluginKey,
  type FocusManifest,
  type FocusManifestContentLaneConfig,
  type FocusManifestExperimentalConfig,
  type FocusManifestFeaturesConfig,
  type FocusManifestGateConfig,
  type FocusManifestIssueDiscoveryPolicy,
  type FocusManifestLanePreference,
  type FocusManifestLinkedIssuePolicy,
  type FocusManifestPolicy,
  type FocusManifestPolicyContributionLane,
  type FocusManifestPolicyLabelPolicy,
  type FocusManifestPolicyValidation,
  type FocusManifestRepoDocGenerationConfig,
  type FocusManifestRepoDocGenerationScope,
  type FocusManifestReviewConfig,
  type FocusManifestReviewRecapConfig,
  type FocusManifestMaintainerRecapConfig,
  type FocusManifestOpsConfig,
  type FocusManifestPublicStatsConfig,
  type FocusManifestDraftFlowConfig,
  type FocusManifestUpstreamDriftIssuesConfig,
  type FocusManifestFederatedIntelligenceConfig,
  type FederatedCollectorMode,
  type FocusManifestSettings,
  type FocusManifestSource,
  type LinkedIssueSatisfactionMode,
  type MaxFindingsConfig,
  type PreMergeCheck,
  type ReviewFieldKey,
  type ReviewFindingSeverity,
  type ReviewPathInstruction,
  type ReviewProfile,
  type SelfHostAiModelConfig,
  type VisualConfig,
  type VisualPreviewConfig,
  type VisualRoutesConfig,
  type VisualTheme,
} from "./focus-manifest.js";
// Focus-manifest linting + validation (#6269), extracted so the local (`@loopover/mcp`) MCP server can lint
// and validate a `.loopover.yml` offline/in-process instead of round-tripping to the remote API.
export { lintManifestText, unknownTopLevelWarnings, type SelfHostConfigLintResult } from "./config-lint.js";
export {
  buildFocusManifestValidation,
  type FocusManifestValidationResult,
  type FocusManifestValidationStatus,
} from "./focus-manifest-validation.js";
// Reward/risk reasoning signals (#2281). The four builders depend on the still-in-`src` maintainer signal
// stack, so they take an injected `RewardRiskEngineDeps` (the `src/signals/reward-risk.ts` shim binds it).
export {
  buildRepoRewardRisk,
  buildContributorRewardRiskStrategy,
  buildMaintainerNoiseReport,
  buildPullRequestReviewability,
  rewardRiskFreshnessInternals,
  type RewardRiskEngineDeps,
  type PullRequestReviewabilityInput,
  type PullRequestReviewIntelligenceView,
  type RewardRiskAction,
  type RewardRiskActionKind,
  type RewardRiskActionSeverity,
  type RepoRewardRisk,
  type EligibilityGapEntry,
  type ContributorRewardRiskStrategy,
  type MaintainerNoiseReport,
  type PullRequestReviewability,
} from "./reward-risk.js";

// Shared subprocess env-allowlist + secret-redaction helpers (#4284) — one source of truth for every driver that
// spawns a locally-authenticated CLI subprocess (src/selfhost/ai.ts and the coming loopover-miner drivers).
export {
  SUBPROCESS_CLI_ENV_ALLOWLIST,
  buildAllowlistedEnv,
  SECRET_PATTERNS,
  redactSecrets,
} from "./subprocess-env.js";

// Shared telemetry-anonymization primitive (#5680) — one source of truth for the per-instance-secret HMAC
// hashing both Orb's self-host collector and AMS's export path use before repo/PR identifiers leave the
// instance.
export { generateAnonSecret, hmacAnonymize } from "./telemetry/anonymize.js";

// Pure PR-target-key parser (#4882) -- parses `"<owner>/<repo>#<number>"` into its parts; extracted so the
// D1-heavy repositories access layer no longer carries this stranded pure logic.
export { parsePullRequestTargetKey } from "./parse-pull-request-target-key.js";
