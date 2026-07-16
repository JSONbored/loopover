import { createMcpHandler } from "agents/mcp";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH,
  MAX_FIND_OPPORTUNITIES_LANGUAGES,
  MAX_FIND_OPPORTUNITIES_OWNER_LENGTH,
  MAX_FIND_OPPORTUNITIES_REPO_LENGTH,
  MAX_FIND_OPPORTUNITIES_TARGETS,
  runFindOpportunities,
  validateFindOpportunitiesInput,
} from "./find-opportunities";
import { loadPrAiReviewFindings, assertContributorOwnsPullRequest } from "./pr-ai-review-findings";
import {
  MAX_ISSUE_RAG_OWNER_LENGTH,
  MAX_ISSUE_RAG_REPO_LENGTH,
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
import { canLoginAccessRepo, canWatchRepo, loadControlPanelAccessScope, loadControlPanelRoleSummary, type ControlPanelAccessScope } from "../services/control-panel-roles";
import {
  countOpenIssues,
  countPendingAgentActions,
  countOpenPullRequests,
  createPendingAgentActionIfAbsent,
  getBounty,
  listBountiesByRepo,
  getContributorEvidence,
  getLatestRepoGithubTotalsSnapshot,
  getInstallation,
  getIssue,
  getPendingAgentAction,
  getPullRequest,
  getRepository,
  getRepositorySettings,
  isGlobalAgentFrozen,
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
  listOpenPullRequests,
  listPullRequests,
  listPullRequestFiles,
  listPullRequestReviews,
  listRecentMergedPullRequests,
  listSignalSnapshots,
  listRepoSyncSegments,
  listRepoSyncStates,
  listRepositories,
  MAX_NOTIFICATION_DELIVERY_ID_LENGTH,
  MAX_NOTIFICATION_MARK_READ_IDS,
  markNotificationDeliveriesRead,
  recordProductUsageEvent,
} from "../db/repositories";
import { decidePendingAgentAction } from "../services/agent-approval-queue";
import { nowIso } from "../utils/json";
import { buildNotificationFeed } from "../notifications/service";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { getRepositoryCollaboratorPermission } from "../github/app";
import { performRepoDocRefresh } from "../github/repo-doc-refresh-runner";
import { sanitizePublicComment } from "../github/commands";
import { fetchPublicContributorProfile } from "../github/public";
import { listLatestRegistrySnapshots } from "../registry/sync";
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
import { loadOrComputeBurdenForecastResponse } from "../services/burden-forecast";
import { buildMcpClientTelemetry } from "../services/client-telemetry";
import { loadOrComputeRepoOutcomePatternsResponse } from "../services/repo-outcome-patterns";
import { buildRepoOutcomeCalibration, outcomeCalibrationSummary } from "../services/outcome-calibration";
import { buildRecommendationQualityReport } from "../services/recommendation-quality-report";
import { computeFleetAnalytics } from "../orb/analytics";
import { loadMaintainerNoiseReport, maintainerNoiseSummary } from "../services/maintainer-noise";
import { loadLabelAudit, labelAuditSummary } from "../services/label-audit";
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
  buildQueueHealth,
  buildRegistryChangeReport,
  buildRoleContext,
} from "../signals/engine";
import { PUBLIC_SURFACE_SKIP_REASONS, skippedPrAuditRemediation, type PublicSurfaceSkipReason } from "../signals/settings-preview";
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../signals/local-branch";
import { computeLocalScorerTokens } from "../signals/local-scorer";
import { buildPullRequestReviewability, type PullRequestReviewability } from "../signals/reward-risk";
import {
  buildApplyLabelsSpec,
  buildCreateBranchSpec,
  buildDeleteBranchSpec,
  buildFileIssueSpec,
  buildFollowUpIssueSpec,
  buildOpenPrSpec,
  buildPostEligibilityCommentSpec,
  buildTestGenSpec,
  type LocalWriteActionSpec,
} from "./local-write-tools";
import { classifyTestCoverage, isCodeFile, isTestPath, TEST_FRAMEWORKS } from "../signals/test-evidence";
import { applyStepResult, buildPlanDag, nextReadySteps, planProgress, validatePlanDag, type PlanDag } from "../services/plan-dag";
import { buildFocusManifestValidation } from "../services/focus-manifest-validation";
import { isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "../settings/agent-execution";
import { AGENT_ACTION_CLASSES, AUTONOMY_LEVELS, isActingAutonomyLevel, resolveAutonomy } from "../settings/autonomy";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { MAX_FOCUS_MANIFEST_BYTES } from "../signals/focus-manifest";
import { loadPublicRepoFocusManifest, loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildPredictedGateVerdict, type PredictedGateVerdict } from "../rules/predicted-gate";
import { buildIssueSlopAssessment } from "../signals/issue-slop";
import { buildSlopAssessment } from "../signals/slop";
import { validateIdeaSubmission, buildTaskGraph, buildClaimPlan } from "../idea-intake";
import { buildResultsPayload } from "../results-payload";
import { buildProgressSnapshot } from "../loop-progress";
import { evaluateEscalation } from "../loop-escalation";
import { buildStructuralImprovementAssessment } from "../signals/improvement";
import { buildBoundaryTestGenerationFinding, buildBoundaryTestGenerationSpec } from "../signals/boundary-test-generation";
import { buildRepoDataQuality } from "../signals/data-quality";
import { PREFLIGHT_LIMITS } from "../signals/preflight-limits";
import { SCENARIO_MAX_BRANCH_REF_CHARS, SCENARIO_MAX_LINKED_ISSUE_NUMBERS, SCENARIO_MAX_REPO_FULL_NAME_CHARS } from "../scenarios/input-model";
import { loadUpstreamStatus } from "../upstream/ruleset";
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

const ownerRepoShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const ownerRepoPullShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
};

const ownerRepoWindowShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  windowDays: z.number().int().positive().optional(),
};

const windowOnlyShape = {
  windowDays: z.number().int().positive().optional(),
};

const fleetAnalyticsOutputSchema = {
  windowDays: z.number().optional(),
  instanceCount: z.number().optional(),
  fleet: z.unknown().optional(),
  instances: z.array(z.unknown()).optional(),
  outliers: z.array(z.unknown()).optional(),
};

// Operator-only, same as fleetAnalyticsOutputSchema: buildRecommendationQualityReport aggregates
// agent-recommendation outcomes across every repo (visibility: "operator_only" in the report itself),
// so this mirrors the fleet-analytics tool's windowDays-only input + operator gate rather than the
// per-repo ownerRepoWindowShape pattern -- a single repo's maintainer access must never unlock
// cross-repo recommendation data.
const recommendationQualityOutputSchema = {
  generatedAt: z.string().optional(),
  windowDays: z.number().optional(),
  visibility: z.string().optional(),
  empty: z.boolean().optional(),
  sparse: z.boolean().optional(),
  totals: z.unknown().optional(),
  trends: z.array(z.unknown()).optional(),
  failureCategories: z.array(z.unknown()).optional(),
  rollups: z.array(z.unknown()).optional(),
  roleSurfaces: z.array(z.unknown()).optional(),
  warnings: z.array(z.string()).optional(),
  publicExport: z.unknown().optional(),
  privateSummary: z.string().optional(),
};

const loginShape = {
  login: z.string().min(1),
};

const loginRepoShape = {
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const bountyShape = {
  id: z.string().min(1),
};

const validateLinkedIssueShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
  plannedChange: z
    .object({
      title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars).optional(),
      changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
      contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
    })
    .optional(),
};

const checkBeforeStartShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive().optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars).optional(),
  plannedPaths: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
};

const issueRagShape = {
  owner: z.string().max(MAX_ISSUE_RAG_OWNER_LENGTH),
  repo: z.string().max(MAX_ISSUE_RAG_REPO_LENGTH),
  title: z.string().max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  topK: z.number().int().min(1).max(12).optional(),
};

const findOpportunitiesShape = {
  targets: z
    .array(
      z.object({
        owner: z.string().min(1).max(MAX_FIND_OPPORTUNITIES_OWNER_LENGTH),
        repo: z.string().min(1).max(MAX_FIND_OPPORTUNITIES_REPO_LENGTH),
      }),
    )
    .max(MAX_FIND_OPPORTUNITIES_TARGETS)
    .optional(),
  searchQuery: z.string().min(1).max(500).optional(),
  goalSpec: z
    .object({
      lane: z.string().min(1).optional(),
      minRankScore: z.number().min(0).max(100).optional(),
      languages: z.array(z.string().min(1).max(MAX_FIND_OPPORTUNITIES_LANGUAGE_LENGTH)).max(MAX_FIND_OPPORTUNITIES_LANGUAGES).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

const lintPrTextShape = {
  commitMessages: z.array(z.string().max(PREFLIGHT_LIMITS.bodyChars)).max(50).optional(),
  prBody: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  linkedIssue: z.number().int().positive().optional(),
};

const validateConfigShape = {
  content: z.string().max(256 * 1024),
  source: z.enum(["repo_file", "api_record", "none"]).optional(),
};

const preflightShape = {
  repoFullName: z.string().min(3).max(PREFLIGHT_LIMITS.repoFullNameChars),
  contributorLogin: z.string().min(1).max(PREFLIGHT_LIMITS.contributorLoginChars).optional(),
  title: z.string().min(1).max(PREFLIGHT_LIMITS.titleChars),
  body: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  labels: z.array(z.string().max(PREFLIGHT_LIMITS.labelChars)).max(PREFLIGHT_LIMITS.labels).optional(),
  changedFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(PREFLIGHT_LIMITS.linkedIssues).optional(),
  tests: z.array(z.string().max(PREFLIGHT_LIMITS.testChars)).max(PREFLIGHT_LIMITS.tests).optional(),
  authorAssociation: z.string().max(PREFLIGHT_LIMITS.authorAssociationChars).optional(),
};

const localDiffPreflightShape = {
  ...preflightShape,
  changedLineCount: z.number().int().min(0).optional(),
  testFiles: z.array(z.string().max(PREFLIGHT_LIMITS.changedFileChars)).max(PREFLIGHT_LIMITS.changedFiles).optional(),
  commitMessage: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
};

const branchEligibilityShape = {
  status: z.enum(["eligible", "ineligible", "unknown"]),
  source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
  reason: z.string().optional(),
  checkedAt: z.string().optional(),
  stale: z.boolean().optional(),
};

const callerBranchEligibilitySchema = z
  .object(branchEligibilityShape)
  .strict()
  .transform((value) => ({ ...value, status: value.status === "eligible" ? ("unknown" as const) : value.status, source: "user_supplied" as const }));

// Changed-file metadata + local validation results — shared by the local-branch analysis and the #782 local
// scorer. METADATA ONLY (paths + line counts), never source content, so the no-upload boundary holds.
const changedFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
    binary: z.boolean().optional(),
  })
  .strict();

const validationEntrySchema = z
  .object({
    command: z.string().min(1),
    status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
    summary: z.string().optional(),
    durationMs: z.number().int().min(0).optional(),
    exitCode: z.number().int().min(0).optional(),
  })
  .strict();

// #782 run_local_scorer input — changed-file metadata + the local validation results.
const runLocalScorerShape = {
  changedFiles: z.array(changedFileSchema).min(1).max(500),
  validation: z.array(validationEntrySchema).max(50).optional(),
};

const runLocalScorerOutputSchema = {
  tokenScores: z
    .object({
      mode: z.string(),
      activeModel: z.string().optional(),
      sourceTokenScore: z.number().optional(),
      totalTokenScore: z.number().optional(),
      sourceLines: z.number().optional(),
      testTokenScore: z.number().optional(),
      nonCodeTokenScore: z.number().optional(),
      warnings: z.array(z.string()).optional(),
    })
    .optional(),
  usage: z.string().optional(),
};

// #780 miner write-tools. Inputs are content/targets; the OUTPUT is an action spec the LOCAL harness runs with
// its own creds — loopover never performs the write.
const WRITE_TOOL_TITLE_MAX = 400;
const WRITE_TOOL_BODY_MAX = 60000;
const WRITE_TOOL_BRANCH_MAX = 255;
const openPrShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  base: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS),
  head: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS),
  title: z.string().min(1).max(WRITE_TOOL_TITLE_MAX),
  body: z.string().max(WRITE_TOOL_BODY_MAX),
  draft: z.boolean().optional(),
};
const fileIssueShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  title: z.string().min(1).max(WRITE_TOOL_TITLE_MAX),
  body: z.string().max(WRITE_TOOL_BODY_MAX),
  labels: z.array(z.string().min(1).max(100)).max(20).optional(),
};
const applyLabelsShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  number: z.number().int().positive(),
  labels: z.array(z.string().min(1).max(100)).min(1).max(20),
};
const postEligibilityCommentShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  number: z.number().int().positive(),
  body: z.string().min(1).max(WRITE_TOOL_BODY_MAX),
};
const createBranchShape = { branch: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX), base: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX).optional() };
const deleteBranchShape = { branch: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX), remote: z.boolean().optional() };
// #2188: the framework list mirrors detectTestConvention's TEST_FRAMEWORKS (#2187) so a caller cannot request a
// spec for a framework the detector could never have produced.
const WRITE_TOOL_TARGET_FILES_MAX = 50;
const testGenShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  targetFiles: z.array(z.string().min(1).max(500)).min(1).max(WRITE_TOOL_TARGET_FILES_MAX),
  framework: z.enum(TEST_FRAMEWORKS),
  testDir: z.string().min(1).max(255).optional(),
  criteria: z.array(z.string().min(1).max(300)).max(20).optional(),
};
// #2177 (follow-up-issue slice of #1962): composes a file_issue spec from a single deferred review finding.
const followUpIssueShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  path: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
  finding: z.string().min(1).max(WRITE_TOOL_BODY_MAX),
  label: z.string().min(1).max(100).optional(),
};
const localWriteActionOutputSchema = {
  action: z.string(),
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  command: z.string(),
  boundary: z.string(),
};

// #783 plan DAG — STATELESS: the harness holds the plan and passes it back each call; these tools only advance
// the state machine, so loopover keeps no record of the miner's plan.
const planStepStatusEnum = z.enum(["pending", "running", "completed", "failed", "skipped"]);
export const rawPlanStepSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    codingAgentMode: z.enum(["paused", "dry_run", "live"]).optional(),
  })
  .strict();
const planStepSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50),
    status: planStepStatusEnum,
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(1).max(10),
    lastError: z.string().max(2000).nullable().optional(),
  })
  .strict();
const planDagSchema = z.object({ steps: z.array(planStepSchema).max(100) }).strict();
const buildPlanShape = { steps: z.array(rawPlanStepSchema).min(1).max(100) };
const planStatusShape = { plan: planDagSchema };
const recordStepResultShape = {
  plan: planDagSchema,
  stepId: z.string().min(1).max(100),
  outcome: z.enum(["completed", "failed", "skipped"]),
  error: z.string().max(2000).optional(),
};
const planViewOutputSchema = {
  plan: planDagSchema.optional(),
  progress: z
    .object({ total: z.number(), completed: z.number(), failed: z.number(), running: z.number(), pending: z.number(), skipped: z.number(), status: z.string() })
    .optional(),
  readySteps: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
  validation: z.object({ valid: z.boolean(), errors: z.array(z.string()) }).optional(),
};

// #784 (MCP slice) — propose-action: a maintainer stages an action into the approval queue (#779).
const proposeActionShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  actionClass: z.enum(["review", "request_changes", "approve", "merge", "close", "label", "review_state_label"]),
  reason: z.string().max(500).optional(),
  label: z.string().min(1).max(100).optional(),
  reviewBody: z.string().max(60000).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  closeComment: z.string().max(60000).optional(),
};

// GitHub permissions that imply real write access to a repo. Cached PR author_association can report
// MEMBER/COLLABORATOR for users without push permission, so write-capable MCP surfaces must verify live.
const REPO_WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

const proposeActionOutputSchema = {
  created: z.boolean().optional(),
  action: z
    .object({ id: z.string(), actionClass: z.string(), pullNumber: z.number(), status: z.string(), reason: z.string().nullable() })
    .optional(),
};

// #784 (MCP slice) — the read side of the agent automation control surface for a repo.
const automationStateOutputSchema = {
  repoFullName: z.string().optional(),
  configured: z.boolean().optional(),
  autonomy: z.record(z.string(), z.string()).optional(),
  autoMaintain: z.object({ requireApprovals: z.number(), mergeMethod: z.string() }).optional(),
  agentPaused: z.boolean().optional(),
  agentDryRun: z.boolean().optional(),
  mode: z.string().optional(),
  permissionReadiness: z.string().optional(),
  actingActionClasses: z.array(z.string()).optional(),
  pendingActionCount: z.number().optional(),
};

// #6087 (MCP slice) — the write side of the automation control surface: pause/resume and per-action autonomy,
// the two `maintain` CLI operations (loopover-mcp.js:1783-1800) that had no MCP tool yet. Both read-merge-write
// over the same repo `settings` row loopover_get_automation_state reads, so unrelated settings groups (and,
// for autonomy, other action classes) are preserved.
const setAgentPausedShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  paused: z.boolean(),
};

const setAgentPausedOutputSchema = {
  repoFullName: z.string().optional(),
  agentPaused: z.boolean().optional(),
};

// `action` mirrors the CLI's MAINTAIN_ACTION_CLASSES exactly (loopover-mcp.js). `level` validates against the
// LIVE AUTONOMY_LEVELS (src/settings/autonomy.ts) rather than restating one: "suggest"/"propose" were removed
// server-side by #4620 and are silently dropped by normalizeAutonomyPolicy on persist, so accepting either here
// would report success on a write that never actually took effect. (#6153: the CLI's own MAINTAIN_AUTONOMY_LEVELS
// carried both until then -- binding to the live enum is what kept this surface correct while that one drifted.)
const MAINTAIN_AUTONOMY_ACTION_CLASSES = ["review", "request_changes", "approve", "merge", "close", "label"] as const;

const setActionAutonomyShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  action: z.enum(MAINTAIN_AUTONOMY_ACTION_CLASSES),
  level: z.enum(AUTONOMY_LEVELS),
};

const setActionAutonomyOutputSchema = {
  repoFullName: z.string().optional(),
  action: z.string().optional(),
  level: z.string().optional(),
  autonomy: z.record(z.string(), z.string()).optional(),
};

// #784 (MCP slice) — surface + decide the approval queue, so an MCP client can do the full loop it can
// already propose into: list staged actions, then accept (execute) or reject one.
const listPendingActionsShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  status: z.enum(["pending", "accepted", "rejected", "errored"]).optional(),
};

const pendingActionEntrySchema = z.object({
  id: z.string(),
  actionClass: z.string(),
  pullNumber: z.number(),
  status: z.string(),
  autonomyLevel: z.string(),
  reason: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});

const listPendingActionsOutputSchema = {
  repoFullName: z.string().optional(),
  status: z.string().optional(),
  pendingActions: z.array(pendingActionEntrySchema).optional(),
};

const decidePendingActionShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  id: z.string().min(1),
  decision: z.enum(["accept", "reject"]),
};

const decidePendingActionOutputSchema = {
  status: z.string().optional(),
  executionOutcome: z.string().optional(),
  action: pendingActionEntrySchema.optional(),
};

// #3003 (part of #2993) — on-demand repo-doc refresh, the manual counterpart to the scheduled sweep
// (src/queue/processors.ts's "repo-doc-refresh-sweep"). Both call the SAME performRepoDocRefresh runner, which
// itself calls openRepoDocPullRequest -- the one place enable/scope/eligibility/diffing is decided.
const refreshRepoDocsShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const refreshRepoDocsOutputSchema = {
  opened: z.boolean().optional(),
  reused: z.boolean().optional(),
  pullNumber: z.number().optional(),
  url: z.string().optional(),
  reason: z.string().optional(),
};

// #784 (MCP slice) — the agent audit feed: executed actions + approval decisions for a repo.
const auditFeedShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().positive().max(200).optional(),
};

const auditFeedOutputSchema = {
  repoFullName: z.string().optional(),
  events: z
    .array(
      z.object({
        eventType: z.string(),
        pullNumber: z.number().nullable(),
        outcome: z.string(),
        actor: z.string().nullable(),
        detail: z.string().nullable(),
        createdAt: z.string(),
      }),
    )
    .optional(),
};

const focusManifestInputSchema = z
  .record(z.string(), z.unknown())
  .refine((manifest) => isJsonByteLengthWithinLimit(manifest, MAX_FOCUS_MANIFEST_BYTES), {
    message: `focusManifest must serialize to ${MAX_FOCUS_MANIFEST_BYTES} bytes or fewer`,
  });

function isJsonByteLengthWithinLimit(value: unknown, maxBytes: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

const localBranchAnalysisShape = {
  login: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS),
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  baseRef: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
  headRef: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
  branchName: z.string().min(1).max(SCENARIO_MAX_BRANCH_REF_CHARS).optional(),
  baseSha: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  mergeBaseSha: z.string().min(1).optional(),
  remoteTrackingSha: z.string().min(1).optional(),
  commitMessages: z.array(z.string()).max(30).optional(),
  changedFiles: z.array(changedFileSchema).max(500).optional(),
  validation: z.array(validationEntrySchema).max(50).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(SCENARIO_MAX_LINKED_ISSUE_NUMBERS).optional(),
  labels: z.array(z.string()).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  focusManifest: focusManifestInputSchema.optional(),
  branchEligibility: callerBranchEligibilitySchema.optional(),
  localScorer: z
    .object({
      mode: z.enum(["metadata_only", "external_command", "gittensor_root"]),
      activeModel: z.string().optional(),
      sourceTokenScore: z.number().min(0).optional(),
      totalTokenScore: z.number().min(0).optional(),
      sourceLines: z.number().min(0).optional(),
      testTokenScore: z.number().min(0).optional(),
      nonCodeTokenScore: z.number().min(0).optional(),
      warnings: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
};

const localBranchVariantsShape = {
  variants: z.array(z.object(localBranchAnalysisShape).strict()).min(1).max(10),
};

const agentRunShape = {
  objective: z.string().min(1).max(500),
  actorLogin: z.string().min(1),
  targetRepoFullName: z.string().min(3).optional(),
  targetPullNumber: z.number().int().positive().optional(),
  targetIssueNumber: z.number().int().positive().optional(),
};

const agentRunIdShape = {
  runId: z.string().min(1),
};

const agentPlanShape = {
  login: z.string().min(1),
  objective: z.string().min(1).max(500).optional(),
  repoFullName: z.string().min(3).optional(),
};

function contributorOpenIssueCount(issues: Array<{ repoFullName: string; state: string }>, repoFullName: string): number {
  const targetRepo = repoFullName.toLowerCase();
  return issues.filter((issue) => issue.repoFullName.toLowerCase() === targetRepo && issue.state === "open").length;
}

const linkedIssueContextShape = {
  status: z.enum(["raw", "plausible", "validated", "invalid", "unavailable"]).optional(),
  source: z.enum(["user_supplied", "official_mirror", "github_cache", "issue_quality", "missing"]).optional(),
  issueNumbers: z.array(z.number().int().positive()).max(50).optional(),
  solvedByPullRequests: z.array(z.number().int().positive()).max(50).optional(),
  reason: z.string().optional(),
  warnings: z.array(z.string()).max(20).optional(),
};

const scorePreviewShape = {
  repoFullName: z.string().min(3),
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("local_diff"),
  targetKey: z.string().optional(),
  contributorLogin: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  linkedIssueContext: z.object(linkedIssueContextShape).strict().optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  testTokenScore: z.number().min(0).optional(),
  nonCodeTokenScore: z.number().min(0).optional(),
  existingContributorTokenScore: z.number().min(0).optional(),
  prAgeHours: z.number().min(0).optional(),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  duplicateRiskCount: z.number().int().min(0).optional(),
  metadataOnly: z.boolean().default(true),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).max(20).optional(),
  branchEligibility: callerBranchEligibilitySchema.optional(),
};

const variantsShape = {
  variants: z.array(z.object(scorePreviewShape)).min(1).max(10),
};

// ── MCP tool output schemas ────────────────────────────────────────────────
// Structured-output metadata for machine-readable tools so modern MCP clients
// can discover and validate LoopOver responses. Schemas declare documented
// top-level fields; complex/nullable/variant fields use a permissive type so
// validation never rejects a real response (the SDK strips unknown keys). All
// fields are optional because several tools return either a result payload or a
// `{ status: "not_found" | ... }` / refresh envelope.
const repoContextOutputSchema = {
  repoFullName: z.string().optional(),
  repo: z.unknown().optional(),
  lane: z.unknown().optional(),
  queueHealth: z.unknown().optional(),
  queueTrends: z.unknown().optional(),
  collisions: z.unknown().optional(),
  configQuality: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};

const maintainerNoiseOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  score: z.number().optional(),
  level: z.string().optional(),
  noiseSources: z.array(z.string()).optional(),
  maintainerActions: z.array(z.string()).optional(),
  queueHealth: z.unknown().optional(),
  summary: z.string().optional(),
};

const labelAuditOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  configuredLabels: z.array(z.string()).optional(),
  liveLabels: z.array(z.string()).optional(),
  observedLabels: z.array(z.unknown()).optional(),
  missingConfiguredLabels: z.array(z.string()).optional(),
  suspiciousConfiguredLabels: z.array(z.string()).optional(),
  trustedPipelineReady: z.boolean().optional(),
  findings: z.array(z.unknown()).optional(),
  summary: z.string().optional(),
};

const maintainerLaneOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  lane: z.unknown().optional(),
  maintainerCut: z.number().optional(),
  maintainerCutConfigured: z.boolean().optional(),
  queueHealth: z.unknown().optional(),
  configQuality: z.unknown().optional(),
  contributorIntakeHealth: z.unknown().optional(),
  findings: z.array(z.unknown()).optional(),
  summary: z.string().optional(),
};

const repoOnboardingPackOutputSchema = {
  repoFullName: z.string().optional(),
  accepted: z.boolean().optional(),
  preview: z.unknown().optional(),
  policySource: z.string().optional(),
  error: z.string().optional(),
};

const registrationReadinessOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  ready: z.boolean().optional(),
  recommendedRegistrationMode: z.string().optional(),
  issuePolicy: z.string().optional(),
  directPrReadiness: z.unknown().optional(),
  issueDiscoveryReadiness: z.unknown().optional(),
  labelPolicy: z.unknown().optional(),
  maintainerCutReadiness: z.unknown().optional(),
  testCoverageHealth: z.unknown().optional(),
  queueHealth: z.unknown().optional(),
  contributorIntakeHealth: z.unknown().optional(),
  docsCompleteness: z.unknown().optional(),
  githubApp: z.unknown().optional(),
  policyReadiness: z.unknown().optional(),
  onboardingPackPreview: z.unknown().optional(),
  blockers: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  dataQuality: z.unknown().optional(),
};

const configRecommendationOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  privateOnly: z.boolean().optional(),
  current: z.unknown().optional(),
  recommended: z.unknown().optional(),
  tradeoffs: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  dataQuality: z.unknown().optional(),
};

const freshnessResponseOutputSchema = {
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  generatedAt: z.string().optional(),
  report: z.unknown().optional(),
};

const maintainerMeasurementReportOutputSchema = {
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
const gatePrecisionOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  windowDays: z.number().nullable().optional(),
  perGateType: z.array(z.unknown()).optional(),
  overall: z.unknown().optional(),
  signals: z.array(z.string()).optional(),
};

// #5825 - maintainer-authenticated skipped-PR audit trail, mirroring GET /v1/app/skipped-pr-audit's
// filters (all optional: a bare call returns the caller's own repo-scoped feed). No owner/repo shape
// here on purpose: unlike ownerRepoShape tools this report can legitimately span every repo the caller
// is scoped to, so repoFullName narrows rather than requires.
const skippedPrAuditShape = {
  repoFullName: z.string().trim().min(1).max(200).optional(),
  reason: z.enum(PUBLIC_SURFACE_SKIP_REASONS).optional(),
  since: z.string().trim().min(1).max(64).optional(),
  limit: z.number().int().positive().optional(),
};

const skippedPrAuditOutputSchema = {
  generatedAt: z.string().optional(),
  limit: z.number().optional(),
  hasMore: z.boolean().optional(),
  filters: z.unknown().optional(),
  items: z.array(z.unknown()).optional(),
};

const contributorProfileOutputSchema = {
  login: z.string().optional(),
  github: z.unknown().optional(),
  source: z.unknown().optional(),
  repoStats: z.unknown().optional(),
  trustSignals: z.unknown().optional(),
};

const decisionPackOutputSchema = {
  status: z.string().optional(),
  login: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  generatedAt: z.string().optional(),
  rebuildEnqueued: z.boolean().optional(),
  summary: z.string().optional(),
  repoDecisions: z.unknown().optional(),
  topActions: z.unknown().optional(),
};

const openPrMonitorOutputSchema = {
  login: z.string().optional(),
  generatedAt: z.string().optional(),
  openPrCount: z.number().optional(),
  registeredRepoCount: z.number().optional(),
  cleanupFirst: z.boolean().optional(),
  summary: z.string().optional(),
  guidance: z.unknown().optional(),
  pendingScenarios: z.unknown().optional(),
  pullRequests: z.unknown().optional(),
};

const notificationsOutputSchema = {
  login: z.string().optional(),
  unreadCount: z.number().optional(),
  notifications: z.unknown().optional(),
};

const prOutcomeShape = {
  login: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
};

const prOutcomeOutputSchema = {
  login: z.string().optional(),
  count: z.number().optional(),
  outcomes: z.unknown().optional(),
};

const loginRepoPullShape = {
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
};

const prAiReviewFindingsOutputSchema = {
  status: z.enum(["ready", "not_found", "ai_review_off"]),
  repoFullName: z.string().optional(),
  pullNumber: z.number().optional(),
  login: z.string().optional(),
  headSha: z.string().nullable().optional(),
  findings: z
    .array(
      z.object({
        category: z.string(),
        path: z.string(),
        severity: z.enum(["blocker", "nit"]),
        line: z.number(),
        body: z.string(),
      }),
    )
    .optional(),
  categoryCounts: z.record(z.string(), z.number()).optional(),
};

const predictGateShape = {
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  // The PR's changed file PATHS (metadata only — paths, never source content). Supplying them lets the predictor
  // also evaluate the focus-manifest path policy + path-gated pre-merge checks, matching the live gate (#11-13/#18).
  changedPaths: z.array(z.string().min(1).max(PREFLIGHT_LIMITS.changedFileChars)).max(500).optional(),
};

// Pure local-metadata computation (no repo data, no secrets) — the agent supplies its own diff metadata
// (paths + line counts, never source), so there is nothing to scope. Mirrors the other local-* tools.
const checkSlopRiskShape = {
  changedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
    .max(2000),
  description: z.string().max(20000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
  commitMessages: z.array(z.string().max(2000)).max(200).optional(),
  hasLinkedIssue: z.boolean().optional(),
  issueDiscoveryLane: z.boolean().optional(),
};

const checkSlopRiskOutputSchema = {
  slopRisk: z.number().optional(),
  band: z.enum(["clean", "low", "elevated", "high"]).optional(),
  findings: z.unknown().optional(),
  rubric: z.string().optional(),
};

// Idea-intake bridge input (#4798, spec #4779). Fields are loose here so the engine's validateIdeaSubmission
// owns the real bounds/format checks and returns the actionable error list — an empty/malformed submission
// reaches the handler rather than being rejected upstream by the schema. `decomposition` is the optional
// renter-reviewed idea→issues split (the one fuzzy step, supplied in); omit it for the single-issue baseline.
const intakeIdeaShape = {
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
};

const intakeIdeaOutputSchema = {
  ok: z.boolean(),
  verdict: z.enum(["go", "raise", "avoid"]).optional(),
  taskGraph: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
};

// Claim-plan hand-off (#4799): same idea input, but the output is the loop disposition — which constituent
// issues the claim/code/submit loop can claim now vs. must defer or skip.
const planIdeaClaimsOutputSchema = {
  ok: z.boolean(),
  verdict: z.enum(["go", "raise", "avoid"]).optional(),
  claimPlan: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
};

// Loop results-delivery input (#4801): a completed iteration's already-computed metadata.
const buildResultsPayloadShape = {
  repoFullName: z.string().min(1),
  prNumber: z.number().int().nullable().optional(),
  title: z.string(),
  changedFiles: z
    .array(z.object({ path: z.string(), additions: z.number().int().optional(), deletions: z.number().int().optional() }))
    .max(5000)
    .optional(),
  status: z.enum(["open", "merged", "closed"]).optional(),
};

const buildResultsPayloadOutputSchema = {
  prLink: z.string().nullable().optional(),
  summary: z.string().optional(),
  diffPreview: z.unknown().optional(),
  totals: z.unknown().optional(),
};

// Loop progress-snapshot input (#4800): a running loop's already-computed state.
const buildProgressSnapshotShape = {
  iteration: z.number().int(),
  maxIterations: z.number().int().nullable().optional(),
  phase: z.enum(["queued", "claiming", "coding", "reviewing", "submitting", "done"]),
  status: z.enum(["running", "converged", "abandoned", "error"]),
  recentActivity: z
    .array(z.object({ step: z.string(), detail: z.string().optional(), at: z.string().optional() }))
    .max(1000)
    .optional(),
};

const buildProgressSnapshotOutputSchema = {
  phase: z.string().optional(),
  status: z.string().optional(),
  iteration: z.number().optional(),
  maxIterations: z.number().nullable().optional(),
  percentComplete: z.number().nullable().optional(),
  recentActivity: z.unknown().optional(),
  done: z.boolean().optional(),
};

// Loop escalation evaluator input (#4806): an already-computed loop outcome + health tier + operator signals.
const evaluateEscalationShape = {
  runStatus: z.enum(["running", "converged", "abandoned", "error"]),
  healthStatus: z.enum(["healthy", "degraded", "critical"]).optional(),
  customerFlagged: z.boolean().optional(),
  killRequested: z.boolean().optional(),
};

const evaluateEscalationOutputSchema = {
  shouldEscalate: z.boolean().optional(),
  action: z.enum(["none", "notify", "human_review", "stop"]).optional(),
  severity: z.enum(["none", "low", "medium", "high"]).optional(),
  reasons: z.array(z.string()).optional(),
};

// Deterministic structural-improvement counterpart to checkSlopRiskShape (#4746, sub-issue I of epic #4737):
// the positive-axis mirror of checkSlopRisk, same pure local-metadata contract. changedFiles/tests/testFiles
// are reused verbatim (same shape as checkSlopRiskShape) so the two signals never disagree about what counts
// as test evidence. complexityDeltas/duplicationDeltas mirror ComplexityDeltaLike/DuplicationDeltaLike
// (src/signals/improvement.ts) as already-derived structured deltas — the calling agent computes them from
// its own local working tree (real before/after content, no reconstructOldContent trick needed) and supplies
// them here; this tool never reads file content or diffs itself. Every field is optional:
// buildStructuralImprovementAssessment degrades cleanly to "insufficient-signal" when nothing is supplied
// (see its own tests), so there is no synthetic "at least one field required" check to duplicate here. No
// auth required — same choice as checkSlopRisk: a pure function over caller-supplied structured data with no
// owner/repo/login to scope, and improvementScore carries no gate/blocker power (advisory-only; see
// improvement.ts's header comment), so there is nothing to gate.
const checkImprovementPotentialShape = {
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
};

// Unlike checkSlopRiskOutputSchema, the numeric score is NOT blunted: improvementScore has no gate/blocker
// power (unlike slopRisk, which the blunting explicitly protects from reverse-engineering an evasion of a
// block — #mcp-slop-blunt), and the whole point of a supply-side pre-submit value signal is to let a miner
// see how close their planned change is to the next band, so hiding the number would defeat the tool.
const checkImprovementPotentialOutputSchema = {
  improvementScore: z.number().optional(),
  band: z.enum(["insufficient-signal", "none", "minor", "moderate", "significant"]).optional(),
  findings: z.unknown().optional(),
};

// Coverage-gap self-check (#2235): pure local-metadata, like checkSlopRisk — the agent supplies its changed
// paths (plus any test paths) and asks whether the change carries enough test evidence, no source uploaded.
const checkTestEvidenceShape = {
  changedPaths: z.array(z.string().min(1).max(400)).max(2000),
  testFiles: z.array(z.string().min(1).max(400)).max(2000).optional(),
};

const checkTestEvidenceOutputSchema = {
  classification: z.enum(["strong", "adequate", "weak", "absent"]).optional(),
  changedFileCount: z.number().optional(),
  codeFileCount: z.number().optional(),
  testFileCount: z.number().optional(),
  guidance: z.array(z.string()).optional(),
};

// Issue-side slop triage (#533): pure local-metadata, like checkSlopRisk — the agent supplies the issue
// title + body, nothing to scope. Advisory-only; issues never block.
const checkIssueSlopShape = {
  title: z.string().max(500).optional(),
  body: z.string().max(40000).optional(),
};

const checkIssueSlopOutputSchema = checkSlopRiskOutputSchema;

// Boundary-safe test-generation suggestion (#1972): pure local-metadata, like checkSlopRisk — the agent
// supplies changed-file paths plus precomputed boundary-touch metadata from its local diff scan. The remote MCP
// boundary never accepts patch/source text. Advisory-only; this tool never blocks or writes anything — it only
// returns criteria/hints for the caller's OWN agent to scaffold tests from.
const suggestBoundaryTestsShape = {
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
};

const suggestBoundaryTestsOutputSchema = {
  finding: z.unknown().optional(),
  spec: z.unknown().optional(),
};

/** One per-rule gate disposition (#2234): a fired gate rule and whether it BLOCKS or is merely ADVISORY, with the
 *  public-safe reason already computed by the predictor. */
export type GateDisposition = { rule: string; status: "block" | "advisory"; reason: string };

/** Itemize a predicted-gate verdict into per-rule dispositions (#2234): every fired blocker is a `block`, every
 *  warning an `advisory`, in that order. A rule that did not fire is not listed (it passed). PURE — a read-only
 *  reshaping of what {@link buildPredictedGateVerdict} already computed; it adds no gate logic and no decision. */
export function buildGateDispositions(verdict: Pick<PredictedGateVerdict, "blockers" | "warnings">): GateDisposition[] {
  return [
    ...verdict.blockers.map((finding) => ({ rule: finding.code, status: "block" as const, reason: finding.detail })),
    ...verdict.warnings.map((finding) => ({ rule: finding.code, status: "advisory" as const, reason: finding.detail })),
  ];
}

const explainGateDispositionOutputSchema = {
  conclusion: z.string().optional(),
  pack: z.enum(["gittensor", "oss-anti-slop"]).optional(),
  dispositions: z
    .array(z.object({ rule: z.string(), status: z.enum(["block", "advisory"]), reason: z.string() }))
    .optional(),
};

const predictGateOutputSchema = {
  predicted: z.boolean().optional(),
  basis: z.string().optional(),
  pack: z.enum(["gittensor", "oss-anti-slop"]).optional(),
  conclusion: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  readinessScore: z.number().nullable().optional(),
  blockers: z.unknown().optional(),
  warnings: z.unknown().optional(),
  funnel: z.unknown().optional(),
  note: z.string().optional(),
};

const markNotificationsReadOutputSchema = {
  login: z.string().optional(),
  marked: z.number().optional(),
};

const listNotificationsShape = {
  login: z.string().min(1),
};

const markNotificationsReadShape = {
  login: z.string().min(1),
  ids: z
    .array(z.string().min(1).max(MAX_NOTIFICATION_DELIVERY_ID_LENGTH))
    .max(MAX_NOTIFICATION_MARK_READ_IDS)
    .optional(),
};

// #699 path B: a miner's self-scoped issue-watch subscriptions. `action` defaults to `list`; `watch`/`unwatch`
// require repoFullName. `labels` ([]/omitted = any) filters which new issues notify.
const watchIssuesShape = {
  login: z.string().min(1),
  action: z.enum(["watch", "unwatch", "list"]).default("list"),
  repoFullName: z.string().min(3).max(200).optional(),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
};

const watchIssuesOutputSchema = {
  watching: z.array(z.object({ repoFullName: z.string(), labels: z.array(z.string()) })).optional(),
  changed: z.string().optional(),
};

const explainRepoDecisionOutputSchema = {
  status: z.string().optional(),
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  rebuildEnqueued: z.boolean().optional(),
  decision: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};

const registryChangesOutputSchema = {
  generatedAt: z.string().optional(),
  currentSnapshotId: z.string().optional(),
  previousSnapshotId: z.string().optional(),
  addedRepos: z.unknown().optional(),
  removedRepos: z.unknown().optional(),
  changedRepos: z.unknown().optional(),
  summary: z.string().optional(),
};

const upstreamDriftOutputSchema = {
  generatedAt: z.string().optional(),
  status: z.string().optional(),
  latestCommitSha: z.string().nullable().optional(),
  latestRulesetId: z.string().nullable().optional(),
  highestSeverity: z.string().nullable().optional(),
  affectedAreas: z.unknown().optional(),
  openReportCount: z.number().optional(),
  reports: z.unknown().optional(),
};

const localStatusOutputSchema = {
  apiAvailable: z.boolean().optional(),
  sourceUploadDefault: z.boolean().optional(),
  supportedEndpoint: z.string().optional(),
  supportedTools: z.unknown().optional(),
};

const validateLinkedIssueOutputSchema = {
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  issueNumber: z.number().optional(),
  found: z.boolean().optional(),
  multiplierStatus: z.string().optional(),
  multiplierWouldApply: z.boolean().optional(),
  blockingReason: z.string().optional(),
  reasons: z.unknown().optional(),
  report: z.unknown().optional(),
};

const checkBeforeStartOutputSchema = {
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  found: z.boolean().optional(),
  claimStatus: z.string().optional(),
  duplicateClusterRisk: z.string().optional(),
  recommendation: z.string().optional(),
  reasons: z.unknown().optional(),
  blockers: z.unknown().optional(),
  report: z.unknown().optional(),
};

const issueRagOutputSchema = {
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  reason: z.string().optional(),
  telemetry: z
    .object({
      attempted: z.boolean().optional(),
      injected: z.boolean().optional(),
      candidates: z.number().optional(),
      kept: z.number().optional(),
      topScore: z.number().optional(),
      minScore: z.number().optional(),
      reranked: z.boolean().optional(),
      injectedChars: z.number().optional(),
      retrievedPathCount: z.number().optional(),
      retrievedPaths: z.array(z.string()).optional(),
    })
    .optional(),
};

const findOpportunitiesOutputSchema = {
  status: z.string().optional(),
  ranked: z
    .array(
      z.object({
        owner: z.string(),
        repo: z.string(),
        issueNumber: z.number(),
        title: z.string(),
        rankScore: z.number(),
        laneFit: z.number(),
        freshness: z.number(),
        dupRisk: z.number(),
        aiPolicyAllowed: z.literal(true),
      }),
    )
    .optional(),
  totalCandidates: z.number().optional(),
  appliedLane: z.string().optional(),
  appliedMinRankScore: z.number().optional(),
  reason: z.string().optional(),
  warnings: z
    .array(
      z.object({
        repoFullName: z.string(),
        stage: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
};

const remediationPlanOutputSchema = {
  repoFullName: z.string().optional(),
  login: z.string().optional(),
  summary: z.string().optional(),
  recommendedRerunCondition: z.string().optional(),
  items: z.unknown().optional(),
};

const scoreBreakdownOutputSchema = {
  repoFullName: z.string().optional(),
  scoreabilityStatus: z.string().optional(),
  effectiveEstimatedScore: z.number().optional(),
  components: z.unknown().optional(),
  gateHighlights: z.unknown().optional(),
  highestLeverageLever: z.unknown().optional(),
};

const eligibilityPlanOutputSchema = {
  eligible: z.boolean().optional(),
  linkedIssueStatus: z.string().optional(),
  branchEligibilityStatus: z.string().optional(),
  blockers: z.array(z.string()).optional(),
  cleanupPaths: z.array(z.string()).optional(),
  linkedIssueProjection: z.string().nullable().optional(),
  publicSummary: z.string().optional(),
};

const lintPrTextOutputSchema = {
  verdict: z.string().optional(),
  score: z.number().optional(),
  components: z.unknown().optional(),
  fixes: z.unknown().optional(),
  summary: z.string().optional(),
  generatedAt: z.string().optional(),
};

const validateConfigOutputSchema = {
  present: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  normalized: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["ok", "warn", "error"]).optional(),
};
// #550: output schemas for the remaining tools (preflight/score/local-branch/agent), so MCP clients can
// machine-validate their results. Same lenient style as the schemas above — documented top-level keys,
// all optional, complex values as z.unknown(). No behavior change; these mirror the existing payloads.
const preflightResultOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  status: z.string().optional(),
  lane: z.unknown().optional(),
  reviewBurden: z.unknown().optional(),
  linkedIssues: z.unknown().optional(),
  findings: z.array(z.unknown()).optional(),
  collisions: z.unknown().optional(),
};
const bountyAdvisoryOutputSchema = {
  id: z.string().optional(),
  repoFullName: z.string().optional(),
  issueNumber: z.number().optional(),
  status: z.string().optional(),
  lifecycle: z.unknown().optional(),
  isActiveOpportunity: z.boolean().optional(),
  fundingStatus: z.unknown().optional(),
  consensusRisk: z.unknown().optional(),
  source: z.unknown().optional(),
  linkedPrs: z.unknown().optional(),
  findings: z.array(z.unknown()).optional(),
};
const preflightLocalDiffOutputSchema = {
  ...preflightResultOutputSchema,
  localDiff: z.unknown().optional(),
};
const scorePreviewRecordOutputSchema = {
  id: z.string().optional(),
  scoringModelSnapshotId: z.string().optional(),
  repoFullName: z.string().optional(),
  targetType: z.string().optional(),
  targetKey: z.string().optional(),
  contributorLogin: z.string().optional(),
  input: z.unknown().optional(),
  result: z.unknown().optional(),
  generatedAt: z.string().optional(),
};
const explainReviewRiskOutputSchema = {
  preflight: z.unknown().optional(),
  roleContext: z.unknown().optional(),
  recommendation: z.string().optional(),
};
const variantsOutputSchema = {
  variants: z.array(z.unknown()).optional(),
};

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
const simulateOpenPrPressureShape = {
  repoFullName: z.string().min(3).max(SCENARIO_MAX_REPO_FULL_NAME_CHARS),
  generatedAt: z.string().min(1).max(100),
  queueHealth: simulateOpenPrPressureQueueHealthSchema,
  roleContext: z.object({ maintainerLane: z.boolean() }).passthrough(),
  contributorOpenPrCount: simulateOpenPrPressureCountSchema.optional(),
};
const simulateOpenPrPressureOutputSchema = {
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  lane: z.string().optional(),
  queuePressure: z.string().optional(),
  recommendedOption: z.string().optional(),
  scenarios: z.array(z.unknown()).optional(),
  summary: z.string().optional(),
};
const preflightCurrentBranchOutputSchema = {
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  preflight: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};
const previewCurrentBranchScoreOutputSchema = {
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  scorePreview: z.unknown().optional(),
  scenarioScorePreview: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};
const rankLocalNextActionsOutputSchema = {
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  nextActions: z.array(z.unknown()).optional(),
  recommendedRerunCondition: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};
const explainLocalBlockersOutputSchema = {
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  scoreBlockers: z.unknown().optional(),
  scenarioScorePreview: z.unknown().optional(),
  branchQualityBlockers: z.unknown().optional(),
  accountStateBlockers: z.unknown().optional(),
  recommendedRerunCondition: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};
const prepareLocalPrPacketOutputSchema = {
  login: z.string().optional(),
  repoFullName: z.string().optional(),
  generatedAt: z.string().optional(),
  prPacket: z.unknown().optional(),
  dataQuality: z.unknown().optional(),
};
const draftPrBodyOutputSchema = {
  repoFullName: z.string().optional(),
  title: z.string().optional(),
  sections: z.unknown().optional(),
  markdown: z.string().optional(),
  caveats: z.array(z.unknown()).optional(),
  excludedPrivateFields: z.array(z.unknown()).optional(),
  sourceUploadDisabled: z.boolean().optional(),
};
const agentRunBundleOutputSchema = {
  run: z.unknown().optional(),
  actions: z.array(z.unknown()).optional(),
  contextSnapshots: z.array(z.unknown()).optional(),
  summary: z.unknown().optional(),
};
const agentPlanNextWorkOutputSchema = {
  ...agentRunBundleOutputSchema,
  planningElicitation: z.unknown().optional(),
  planningChoices: z.unknown().optional(),
};
const agentExplainNextActionOutputSchema = {
  ...agentRunBundleOutputSchema,
  topAction: z.unknown().optional(),
};

export async function handleMcpRequest(c: AppContext): Promise<Response> {
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
  const identity = await authenticateMcpRequest(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);

  const telemetry = buildMcpClientTelemetry(c.req.raw.headers, { defaultClientName: "mcp" })!;
  const usageMetadata = await describeMcpUsageRequest(c.req.raw, telemetry.metadata);
  const startedAt = Date.now();
  const server = new LoopoverMcp(c.env, identity).createServer();
  try {
    const response = await createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(c.req.raw, c.env, getExecutionContext(c));
    if (typeof usageMetadata.toolName === "string") {
      recordMcpToolTelemetry(c.env, usageMetadata.toolName, response.status < 400, Date.now() - startedAt);
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
      recordMcpToolTelemetry(c.env, usageMetadata.toolName, false, Date.now() - startedAt);
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
// no-op guarantee (#6235) with a second, defensive layer at the actual call site.
function recordMcpToolTelemetry(env: Env, tool: string, ok: boolean, durationMs: number): void {
  try {
    recordMcpToolCall(env, { tool, callerType: "remote", ok, durationMs });
  } catch {
    // Telemetry must never affect the tool response (#6237).
  }
}

async function describeMcpUsageRequest(request: Request, telemetryMetadata: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const body = await request.clone().json().catch(() => null);
  if (!body || typeof body !== "object") return { transport: "http", method: request.method, ...telemetryMetadata };
  const envelope = body as { method?: unknown; params?: { name?: unknown } };
  const rpcMethod = typeof envelope.method === "string" ? envelope.method : undefined;
  const toolName = envelope.params && typeof envelope.params.name === "string" ? envelope.params.name : undefined;
  return {
    transport: "http",
    rpcMethod,
    toolName,
    ...telemetryMetadata,
  };
}

// #6301 — coarse tool categories so tools/list clients and the `loopover-mcp tools` CLI can group
// this server's tool surface by the repo's own conceptual groupings instead of reading one flat
// list. The ids mirror the issue's suggested surfaces: contributor discovery/planning, local-branch
// & PR prep, review/gate prediction, agent automation, maintainer/repo-owner, and registry/config
// utility. Attached to each tool as MCP `_meta.category` at registration (see createServer).
export type McpToolCategory = "discovery" | "branch" | "review" | "agent" | "maintainer" | "utility";

// Canonical category order for grouped rendering (contributor-facing surfaces first, operator ones
// last). Kept as a single source of truth so a display/grouping consumer never invents its own order.
export const MCP_TOOL_CATEGORY_IDS: readonly McpToolCategory[] = ["discovery", "branch", "review", "agent", "maintainer", "utility"];

// Every registered tool maps to exactly one category. Listed in registration order (matching
// createServer) so a new tool without a category entry is easy to spot in review; the
// every-tool-has-a-category test fails loudly if one is ever missed.
export const MCP_TOOL_CATEGORIES: Record<string, McpToolCategory> = {
  loopover_get_repo_context: "maintainer",
  loopover_get_maintainer_noise: "maintainer",
  loopover_get_label_audit: "maintainer",
  loopover_get_maintainer_lane: "maintainer",
  loopover_get_repo_onboarding_pack: "maintainer",
  loopover_get_registration_readiness: "maintainer",
  loopover_get_config_recommendation: "maintainer",
  loopover_get_burden_forecast: "maintainer",
  loopover_get_repo_outcome_patterns: "maintainer",
  loopover_get_outcome_calibration: "maintainer",
  loopover_get_gate_precision: "maintainer",
  loopover_get_skipped_pr_audit: "maintainer",
  loopover_get_fleet_analytics: "maintainer",
  loopover_get_recommendation_quality: "maintainer",
  loopover_simulate_open_pr_pressure: "discovery",
  loopover_get_contributor_profile: "discovery",
  loopover_get_decision_pack: "discovery",
  loopover_monitor_open_prs: "discovery",
  loopover_predict_gate: "review",
  loopover_explain_gate_disposition: "review",
  loopover_intake_idea: "agent",
  loopover_plan_idea_claims: "agent",
  loopover_build_results_payload: "agent",
  loopover_build_progress_snapshot: "agent",
  loopover_evaluate_escalation: "agent",
  loopover_check_slop_risk: "review",
  loopover_check_improvement_potential: "review",
  loopover_check_test_evidence: "review",
  loopover_check_issue_slop: "review",
  loopover_suggest_boundary_tests: "review",
  loopover_pr_outcome: "review",
  loopover_get_pr_ai_review_findings: "review",
  loopover_list_notifications: "utility",
  loopover_mark_notifications_read: "utility",
  loopover_watch_issues: "utility",
  loopover_explain_repo_decision: "discovery",
  loopover_preflight_pr: "discovery",
  loopover_get_bounty_advisory: "discovery",
  loopover_get_registry_changes: "utility",
  loopover_get_upstream_drift: "utility",
  loopover_get_issue_quality: "maintainer",
  loopover_get_pr_reviewability: "review",
  loopover_validate_linked_issue: "discovery",
  loopover_check_before_start: "discovery",
  loopover_find_opportunities: "discovery",
  loopover_retrieve_issue_context: "discovery",
  loopover_lint_pr_text: "review",
  loopover_validate_config: "utility",
  loopover_preflight_local_diff: "branch",
  loopover_preview_local_pr_score: "branch",
  loopover_get_eligibility_plan: "discovery",
  loopover_run_local_scorer: "branch",
  loopover_open_pr: "agent",
  loopover_file_issue: "agent",
  loopover_apply_labels: "agent",
  loopover_post_eligibility_comment: "agent",
  loopover_create_branch: "agent",
  loopover_delete_branch: "agent",
  loopover_generate_tests: "agent",
  loopover_file_follow_up_issue: "agent",
  loopover_build_plan: "agent",
  loopover_plan_status: "agent",
  loopover_record_step_result: "agent",
  loopover_get_automation_state: "agent",
  loopover_set_agent_paused: "agent",
  loopover_set_action_autonomy: "agent",
  loopover_propose_action: "agent",
  loopover_list_pending_actions: "agent",
  loopover_decide_pending_action: "agent",
  loopover_refresh_repo_docs: "maintainer",
  loopover_get_agent_audit_feed: "agent",
  loopover_explain_score_breakdown: "review",
  loopover_explain_review_risk: "review",
  loopover_compare_pr_variants: "branch",
  loopover_local_status: "utility",
  loopover_preflight_current_branch: "branch",
  loopover_preview_current_branch_score: "branch",
  loopover_rank_local_next_actions: "branch",
  loopover_explain_local_blockers: "branch",
  loopover_remediation_plan: "branch",
  loopover_prepare_pr_packet: "branch",
  loopover_draft_pr_body: "branch",
  loopover_compare_local_variants: "branch",
  loopover_agent_plan_next_work: "agent",
  loopover_agent_start_run: "agent",
  loopover_agent_get_run: "agent",
  loopover_agent_explain_next_action: "agent",
  loopover_agent_prepare_pr_packet: "branch",
};

export class LoopoverMcp {
  private accessScopePromise: Promise<ControlPanelAccessScope> | null = null;

  constructor(
    private readonly env: Env,
    private readonly identity: AuthIdentity = { kind: "static", actor: "mcp" },
  ) {}

  createServer(): McpServer {
    const server = new McpServer({
      name: "loopover",
      version: "0.1.0",
    });

    // #6301 — register every tool through this thin wrapper so its category rides along as MCP
    // `_meta.category`, exposed in tools/list for clients (and mirrored by the CLI `tools` command).
    const baseRegister = server.registerTool.bind(server);
    const register: McpServer["registerTool"] = (name, config, cb) =>
      baseRegister(name, { ...config, _meta: { category: MCP_TOOL_CATEGORIES[name] } }, cb);

    register(
      "loopover_get_repo_context",
      {
        description: "Return LoopOver repo context: registration, lane, queue health, collisions, and config quality.",
        inputSchema: ownerRepoShape,
        outputSchema: repoContextOutputSchema,
      },
      async (input) => this.toolResult(await this.getRepoContext(input)),
    );

    register(
      "loopover_get_maintainer_noise",
      {
        description: "Return the maintainer queue-noise triage report for a repo: a noise score/level, the specific noise sources to clear first, and recommended maintainer actions. Maintainer-authenticated; advisory only.",
        inputSchema: ownerRepoShape,
        outputSchema: maintainerNoiseOutputSchema,
      },
      async (input) => this.toolResult(await this.getMaintainerNoise(input)),
    );

    register(
      "loopover_get_label_audit",
      {
        description: "Return the repo's label-policy audit: configured-vs-live labels, missing configured labels, suspicious status/source-style labels, and trusted-label-pipeline readiness for label-multiplier scoring. Maintainer-authenticated; advisory only.",
        inputSchema: ownerRepoShape,
        outputSchema: labelAuditOutputSchema,
      },
      async (input) => this.toolResult(await this.getLabelAudit(input)),
    );

    register(
      "loopover_get_maintainer_lane",
      {
        description: "Return the maintainer-lane triage report for a repo: the lane recommendation alongside the configured maintainer cut, queue health, config quality, and contributor-intake health. Maintainer-authenticated; advisory only.",
        inputSchema: ownerRepoShape,
        outputSchema: maintainerLaneOutputSchema,
      },
      async (input) => this.toolResult(await this.getMaintainerLane(input)),
    );

    register(
      "loopover_get_repo_onboarding_pack",
      {
        description:
          "Preview-only onboarding pack for a repository owner (contribution lanes, label policy, and public-safe guidance). Not published to GitHub.",
        inputSchema: ownerRepoShape,
        outputSchema: repoOnboardingPackOutputSchema,
      },
      async (input) => this.toolResult(await this.getRepoOnboardingPack(input)),
    );

    register(
      "loopover_get_registration_readiness",
      {
        description:
          "Preview-only registration-readiness report for a repository: what's missing/present before/after registering with LoopOver (direct-PR and issue-discovery lane readiness, label policy, maintainer-cut readiness, queue health, docs, and the GitHub App install state). Advisory only, not a registration action.",
        inputSchema: ownerRepoShape,
        outputSchema: registrationReadinessOutputSchema,
      },
      async (input) => this.toolResult(await this.getRegistrationReadiness(input)),
    );

    register(
      "loopover_get_config_recommendation",
      {
        description:
          "Return recommended .loopover.yml additions for a repository, derived from the repo's live, currently-active configured behavior (the raw dashboard/API-configured settings, not a yml-merged view — so the recommendation never compares itself against an override that already exists). Advisory only, not a write action.",
        inputSchema: ownerRepoShape,
        outputSchema: configRecommendationOutputSchema,
      },
      async (input) => this.toolResult(await this.getConfigRecommendation(input)),
    );

    register(
      "loopover_get_burden_forecast",
      {
        description: "Return the cached maintainer burden forecast for a repo, including projected review load, queue growth risk, stale PR signals, and a freshness marker.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getBurdenForecast(input)),
    );

    register(
      "loopover_get_repo_outcome_patterns",
      {
        description: "Return cached or freshly-computed per-repo accepted/rejected PR outcome patterns: what maintainers actually merge or close, separated from maintainer-lane activity, with a freshness marker and explicit evidence-completeness.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getRepoOutcomePatterns(input)),
    );

    register(
      "loopover_get_outcome_calibration",
      {
        description:
          "Return slop-band and recommendation outcome calibration for a repo: whether higher-slop bands merge less often and how agent recommendations are panning out. Maintainer-authenticated; measurement only.",
        inputSchema: ownerRepoWindowShape,
        outputSchema: maintainerMeasurementReportOutputSchema,
      },
      async (input) => this.toolResult(await this.getOutcomeCalibration(input)),
    );

    register(
      "loopover_get_gate_precision",
      {
        description:
          "Return per-gate-type false-positive precision for a repo's recorded gate blocks — blocked / blocked-then-merged / overridden counts and false-positive rates with low-sample guards. Maintainer-authenticated; measurement only.",
        inputSchema: ownerRepoWindowShape,
        outputSchema: gatePrecisionOutputSchema,
      },
      async (input) => this.toolResult(await this.getGatePrecision(input)),
    );

    register(
      "loopover_get_skipped_pr_audit",
      {
        description:
          "Return the skipped-PR audit trail: pull requests LoopOver's automated reviewer intentionally stayed quiet on, each with a reason code and a remediation hint. Optionally filter by repoFullName, reason, or since. Maintainer-authenticated; read-only measurement, not a moderation or override action.",
        inputSchema: skippedPrAuditShape,
        outputSchema: skippedPrAuditOutputSchema,
      },
      async (input) => this.toolResult(await this.getSkippedPrAudit(input)),
    );

    register(
      "loopover_get_fleet_analytics",
      {
        description:
          "Operator-only: aggregated gate-calibration analytics across the self-host fleet — median merge/close precision, false-positive + reversal rates, cycle-time percentiles, and per-instance outliers. Measurement only.",
        inputSchema: windowOnlyShape,
        outputSchema: fleetAnalyticsOutputSchema,
      },
      async (input) => this.toolResult(await this.getFleetAnalytics(input)),
    );

    register(
      "loopover_get_recommendation_quality",
      {
        description:
          "Operator-only: how agent recommendations panned out across every repo (positive/negative outcome totals, trends, failure categories, and per-role surfaces). Measurement only.",
        inputSchema: windowOnlyShape,
        outputSchema: recommendationQualityOutputSchema,
      },
      async (input) => this.toolResult(await this.getRecommendationQuality(input)),
    );

    register(
      "loopover_simulate_open_pr_pressure",
      {
        description:
          "Simulate how opening another PR affects a repo's review-queue pressure: ranks the open-new-work / wait / clean-up-first strategy options for the supplied queue-health and role context. Deterministic, public-safe, and read-only - no repo access required and no GitHub writes.",
        inputSchema: simulateOpenPrPressureShape,
        outputSchema: simulateOpenPrPressureOutputSchema,
      },
      async (input) => this.toolResult(this.simulateOpenPrPressureTool(input)),
    );

    register(
      "loopover_get_contributor_profile",
      {
        description: "Return an evidence-backed LoopOver contributor profile for a GitHub login.",
        inputSchema: loginShape,
        outputSchema: contributorProfileOutputSchema,
      },
      async (input) => this.toolResult(await this.getContributorProfile(input.login)),
    );

    register(
      "loopover_get_decision_pack",
      {
        description: "Return the canonical private contributor decision pack for a GitHub login.",
        inputSchema: loginShape,
        outputSchema: decisionPackOutputSchema,
      },
      async (input) => this.toolResult(await this.getDecisionPack(input.login)),
    );

    register(
      "loopover_monitor_open_prs",
      {
        description:
          "Inspect a contributor's open PRs on registered repos, classify queue state, and return public-safe next-step packets from cached metadata.",
        inputSchema: loginShape,
        outputSchema: openPrMonitorOutputSchema,
      },
      async (input) => this.toolResult(await this.monitorOpenPullRequests(input.login)),
    );

    register(
      "loopover_predict_gate",
      {
        description:
          "Predict whether a planned PR would pass the repo's LoopOver gate, from its PUBLIC .loopover.yml only — an agent-native pre-submission self-check that works on ANY repo (no Gittensor account). Under the oss-anti-slop pack the verdict applies to any author; self-scoped to the authenticated login.",
        inputSchema: predictGateShape,
        outputSchema: predictGateOutputSchema,
      },
      async (input) => this.toolResult(await this.predictGate(input)),
    );

    register(
      "loopover_explain_gate_disposition",
      {
        description:
          "Explain WHY the LoopOver gate would pass or block a planned PR: the itemized per-rule dispositions (which specific gate rules block vs advise, and why) behind loopover_predict_gate's verdict. Read-only reasoning surface from the repo's PUBLIC .loopover.yml only — no merge/close decision. Self-scoped to the authenticated login.",
        inputSchema: predictGateShape,
        outputSchema: explainGateDispositionOutputSchema,
      },
      async (input) => this.toolResult(await this.explainGateDisposition(input)),
    );

    register(
      "loopover_intake_idea",
      {
        description:
          "Turn a freeform renter idea into a strict, claimable task-graph (spec #4779) and score it against the same feasibility gate the loop runs on. Deterministic and source-free: validates the submission, assembles constituent issues (an optional caller-supplied decomposition, else a single-issue baseline), and returns the graph plus its go/raise/avoid verdict. A malformed or empty submission returns an actionable error list, not a silent failure.",
        inputSchema: intakeIdeaShape,
        outputSchema: intakeIdeaOutputSchema,
      },
      async (input) => this.toolResult(await this.intakeIdea(input)),
    );

    register(
      "loopover_plan_idea_claims",
      {
        description:
          "Route a freeform idea through the intake bridge (#4798) into a claim/code/submit-loop plan (#4799): validates the submission, builds the scored task-graph, and returns which constituent issues the loop can claim now vs. defer (held on a prerequisite) vs. skip (unshippable) — dependency-ordered so a prerequisite is always claimed before its dependents. Deterministic and source-free; it decides what to claim, it does not claim or run anything. A malformed/empty submission returns an actionable error list.",
        inputSchema: intakeIdeaShape,
        outputSchema: planIdeaClaimsOutputSchema,
      },
      async (input) => this.toolResult(await this.planIdeaClaims(input)),
    );

    register(
      "loopover_build_results_payload",
      {
        description:
          "Package a completed loop iteration into the customer-facing result (#4801): a PR link, a plain-language summary, and a bounded diff preview, from already-computed iteration metadata. Deterministic and source-free — it formats the result, it does not fetch, open, or deliver anything.",
        inputSchema: buildResultsPayloadShape,
        outputSchema: buildResultsPayloadOutputSchema,
      },
      async (input) => this.toolResult(await this.buildLoopResults(input)),
    );

    register(
      "loopover_build_progress_snapshot",
      {
        description:
          "Build a near-real-time progress snapshot for a running rented loop (#4800): phase, status, iteration/percent-complete, and a bounded recent-activity tail, from already-computed loop state. Deterministic and source-free; a customer surface pushes it on change (via the engine's progressChanged) rather than polling on a fixed interval.",
        inputSchema: buildProgressSnapshotShape,
        outputSchema: buildProgressSnapshotOutputSchema,
      },
      async (input) => this.toolResult(await this.buildLoopProgress(input)),
    );

    register(
      "loopover_evaluate_escalation",
      {
        description:
          "Decide whether a rented loop needs a human, and what action to take (#4806), from an already-computed run outcome, health tier, and operator/customer signals — the deterministic support/escalation-path logic. Source-free; returns shouldEscalate + action (none/notify/human_review/stop) + severity + reasons. It decides; the caller wires the action.",
        inputSchema: evaluateEscalationShape,
        outputSchema: evaluateEscalationOutputSchema,
      },
      async (input) => this.toolResult(await this.evalEscalation(input)),
    );

    register(
      "loopover_check_slop_risk",
      {
        description:
          "Assess the deterministic slop risk of a planned change from local diff metadata (paths + line counts) + the PR description — an agent-native, source-free quality self-check. Returns band (clean/low/elevated/high) and actionable findings. No repo data needed.",
        inputSchema: checkSlopRiskShape,
        outputSchema: checkSlopRiskOutputSchema,
      },
      async (input) => this.toolResult(await this.checkSlopRisk(input)),
    );

    register(
      "loopover_check_improvement_potential",
      {
        description:
          "Assess the deterministic structural-improvement potential of a planned change from local diff metadata (paths + line counts) plus optional precomputed complexity/duplication deltas and a patch-coverage delta — an agent-native, source-free positive-signal self-check mirroring loopover_check_slop_risk. Returns the score, band (insufficient-signal/none/minor/moderate/significant), and actionable findings. Deterministic tier only (no LLM judgment); no repo data needed.",
        inputSchema: checkImprovementPotentialShape,
        outputSchema: checkImprovementPotentialOutputSchema,
      },
      async (input) => this.toolResult(await this.checkImprovementPotential(input)),
    );

    register(
      "loopover_check_test_evidence",
      {
        description:
          "Classify whether a planned change's changed files carry enough test evidence, from path metadata alone (no source uploaded) — an agent-native coverage-gap self-check before opening a PR. Returns a coverage band (strong/adequate/weak/absent) plus actionable guidance.",
        inputSchema: checkTestEvidenceShape,
        outputSchema: checkTestEvidenceOutputSchema,
      },
      async (input) => this.toolResult(await this.checkTestEvidence(input)),
    );

    register(
      "loopover_check_issue_slop",
      {
        description:
          "Assess the deterministic slop risk of an issue from its title + body alone (no repo data) — flags clearly low-effort issues (empty body, an unfilled template) for triage. Returns band and findings. Advisory-only: issues never block.",
        inputSchema: checkIssueSlopShape,
        outputSchema: checkIssueSlopOutputSchema,
      },
      async (input) => this.toolResult(await this.checkIssueSlop(input)),
    );

    register(
      "loopover_suggest_boundary_tests",
      {
        description:
          "Boundary-safe test-generation suggestion (#1972): evaluate locally precomputed boundary-touch metadata (path + pattern kind only; no patch/source text) with no test evidence in the diff, and return a LOCAL-execution action spec (criteria/hints only — never generated test code) for your OWN agent to scaffold tests with. Advisory-only; never blocks, never writes.",
        inputSchema: suggestBoundaryTestsShape,
        outputSchema: suggestBoundaryTestsOutputSchema,
      },
      async (input) => this.toolResult(this.suggestBoundaryTests(input)),
    );

    register(
      "loopover_pr_outcome",
      {
        description:
          "Return a contributor's own post-merge outcome records — for each merged PR, a public-safe attribution of what it did for their standing on the repo. Self-scoped: only the authenticated login's outcomes.",
        inputSchema: prOutcomeShape,
        outputSchema: prOutcomeOutputSchema,
      },
      async (input) => this.toolResult(await this.prOutcomes(input.login, input.limit)),
    );

    register(
      "loopover_get_pr_ai_review_findings",
      {
        description:
          "Return a submitted pull request's real AI-review inline findings as structured JSON (category, path, severity, line, body) — the same categorization the PR comment uses. Post-submission only; self-scoped to the authenticated login's own PRs on repos you can access.",
        inputSchema: loginRepoPullShape,
        outputSchema: prAiReviewFindingsOutputSchema,
      },
      async (input) => this.toolResult(await this.getPrAiReviewFindings(input)),
    );

    register(
      "loopover_list_notifications",
      {
        description:
          "Return a contributor's own LoopOver notifications (e.g. changes requested on their PRs) and unread badge count. Self-scoped: only the authenticated login's notifications.",
        inputSchema: listNotificationsShape,
        outputSchema: notificationsOutputSchema,
      },
      async (input) => this.toolResult(await this.listNotifications(input.login)),
    );

    register(
      "loopover_mark_notifications_read",
      {
        description:
          "Mark a contributor's own delivered notifications as read (clears the badge). Self-scoped; pass `ids` to clear specific notifications or omit to clear all.",
        inputSchema: markNotificationsReadShape,
        outputSchema: markNotificationsReadOutputSchema,
      },
      async (input) => this.toolResult(await this.markNotificationsRead(input.login, input.ids)),
    );

    register(
      "loopover_watch_issues",
      {
        description:
          "Watch repos for NEW grabbable, high-multiplier issues (maintainer-created, not WIP). action=watch subscribes a repo (optional label filter), unwatch removes it, list (default) returns your watches. When a matching issue opens you're notified via loopover_list_notifications. Self-scoped to the authenticated login.",
        inputSchema: watchIssuesShape,
        outputSchema: watchIssuesOutputSchema,
      },
      async (input) => this.toolResult(await this.watchIssues(input)),
    );

    register(
      "loopover_explain_repo_decision",
      {
        description: "Return the contributor/repo decision from the canonical decision pack.",
        inputSchema: loginRepoShape,
        outputSchema: explainRepoDecisionOutputSchema,
      },
      async (input) => this.toolResult(await this.explainRepoDecision(input)),
    );

    register(
      "loopover_preflight_pr",
      {
        description: "Preflight a planned PR for lane correctness, duplicate risk, linked issues, and review burden.",
        inputSchema: preflightShape,
        outputSchema: preflightResultOutputSchema,
      },
      async (input) => this.toolResult(await this.preflightPr(input)),
    );

    register(
      "loopover_get_bounty_advisory",
      {
        description: "Return lifecycle, funding, and consensus-risk context for a cached Gittensor bounty.",
        inputSchema: bountyShape,
        outputSchema: bountyAdvisoryOutputSchema,
      },
      async (input) => this.toolResult(await this.getBountyAdvisory(input.id)),
    );

    register(
      "loopover_get_registry_changes",
      {
        description: "Return the diff between the latest cached Gittensor registry snapshots.",
        inputSchema: {},
        outputSchema: registryChangesOutputSchema,
      },
      async () => this.toolResult(await this.getRegistryChanges()),
    );

    register(
      "loopover_get_upstream_drift",
      {
        description: "Return private upstream Gittensor ruleset drift status, including stale/drift warnings for MCP planning.",
        inputSchema: {},
        outputSchema: upstreamDriftOutputSchema,
      },
      async () => this.toolResult(await this.getUpstreamDrift()),
    );

    register(
      "loopover_get_issue_quality",
      {
        description: "Return the cached or freshly-computed issue-quality report for a repo, ranking which open issues are actionable, need proof, are stale/duplicate-prone, or already solved.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getIssueQuality(input)),
    );

    register(
      "loopover_get_pr_reviewability",
      {
        description:
          "Return the cached or freshly-computed reviewability report for an open PR: how ready it is to review/merge, the blocking or advisory signals against it, and its lane/duplicate/linked-issue context. Metadata-only, repo-scoped, no GitHub writes.",
        inputSchema: ownerRepoPullShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getPrReviewability(input)),
    );

    register(
      "loopover_validate_linked_issue",
      {
        description:
          "Report whether linking a given issue will actually earn the standard linked-issue scoring multiplier for a planned PR — is it open, valid, single-owner, and solvable by this PR — with the precise blocking reason if not. Public-safe; the raw multiplier value stays private. No GitHub writes.",
        inputSchema: validateLinkedIssueShape,
        outputSchema: validateLinkedIssueOutputSchema,
      },
      async (input) => this.toolResult(await this.validateLinkedIssue(input)),
    );

    register(
      "loopover_check_before_start",
      {
        description:
          "Before any code is written, check whether an issue is already claimed or solved, whether a duplicate cluster is forming, and whether it is a valid target. Returns a go/raise/avoid recommendation with public-safe reasons from cached metadata. No GitHub writes.",
        inputSchema: checkBeforeStartShape,
        outputSchema: checkBeforeStartOutputSchema,
      },
      async (input) => this.toolResult(await this.checkBeforeStart(input)),
    );

    register(
      "loopover_find_opportunities",
      {
        description:
          "Metadata-only, no GitHub writes: discover and rank cross-repo open issues for miner targeting. Composes deterministic fan-out, AI-policy filtering (banned repos never appear), and opportunity ranking. Returns only public-safe fields — never raw reward/score internals.",
        inputSchema: findOpportunitiesShape,
        outputSchema: findOpportunitiesOutputSchema,
      },
      async (input) => this.toolResult(await this.findOpportunities(input)),
    );

    register(
      "loopover_retrieve_issue_context",
      {
        description:
          "Metadata-only, repo-scoped issue-centric RAG retrieval for the miner analyze phase. Composes an embeddable query from issue title/body/labels and returns retrieved file paths plus retrieval scores — never chunk bodies or source text. Requires hosted Vectorize/D1; degrades to empty paths when unavailable.",
        inputSchema: issueRagShape,
        outputSchema: issueRagOutputSchema,
      },
      async (input) => this.toolResult(await this.retrieveIssueContext(input)),
    );

    register(
      "loopover_lint_pr_text",
      {
        description:
          "Lint a commit message + PR body against the gittensor traceability/no-issue-rationale and Conventional Commit rubric, before submitting. Returns a deterministic quality verdict (strong/adequate/weak) and specific public-safe fixes. Metadata only; no source upload, no GitHub writes.",
        inputSchema: lintPrTextShape,
        outputSchema: lintPrTextOutputSchema,
      },
      async (input) => this.toolResult(this.lintPrText(input)),
    );

    register(
      "loopover_validate_config",
      {
        description:
          "Parse and validate a .loopover.yml manifest string using the same focus-manifest parser as the server. Returns normalized config fields, parse warnings, and an ok/warn/error status. Metadata-only, no GitHub writes.",
        inputSchema: validateConfigShape,
        outputSchema: validateConfigOutputSchema,
      },
      async (input) => this.toolResult(this.validateConfig(input)),
    );

    register(
      "loopover_preflight_local_diff",
      {
        description: "Preflight local git-diff metadata without uploading code content.",
        inputSchema: localDiffPreflightShape,
        outputSchema: preflightLocalDiffOutputSchema,
      },
      async (input) => this.toolResult(await this.preflightLocalDiff(input)),
    );

    register(
      "loopover_preview_local_pr_score",
      {
        description: "Return a private scoring preview from local diff metrics or supplied metadata. Source contents are not required.",
        inputSchema: scorePreviewShape,
        outputSchema: scorePreviewRecordOutputSchema,
      },
      async (input) => this.toolResult(await this.previewScore(input)),
    );

    register(
      "loopover_get_eligibility_plan",
      {
        description:
          "Derive a structured eligibility plan from local score-preview metadata: whether the branch/PR is eligible now, public-safe blockers, and cleanup paths. Advisory dry-run only — no GitHub writes.",
        inputSchema: scorePreviewShape,
        outputSchema: eligibilityPlanOutputSchema,
      },
      async (input) => this.toolResult(await this.getEligibilityPlan(input)),
    );

    register(
      "loopover_run_local_scorer",
      {
        description:
          "Run LoopOver's deterministic local token scorer over changed-file metadata + local validation results (no source content). Returns token scores to pass back as the `localScorer` field of the score-preview / analyze tools (external_command mode), so the miner never runs the gittensor-root scorer by hand.",
        inputSchema: runLocalScorerShape,
        outputSchema: runLocalScorerOutputSchema,
      },
      async (input) => this.toolResult(this.runLocalScorer(input)),
    );

    // #780 miner write-tools — each returns a LOCAL-execution action spec; loopover never performs the write.
    register(
      "loopover_open_pr",
      { description: "Build a LOCAL-execution spec to open a pull request from your branch (run it with your own gh creds; loopover never performs the write).", inputSchema: openPrShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildOpenPrSpec(input))),
    );
    register(
      "loopover_file_issue",
      { description: "Build a LOCAL-execution spec to file an issue (run it with your own gh creds; loopover never performs the write).", inputSchema: fileIssueShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildFileIssueSpec(input))),
    );
    register(
      "loopover_apply_labels",
      { description: "Build a LOCAL-execution spec to add labels to an issue or PR (run it with your own gh creds; loopover never performs the write).", inputSchema: applyLabelsShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildApplyLabelsSpec(input))),
    );
    register(
      "loopover_post_eligibility_comment",
      { description: "Build a LOCAL-execution spec to post an eligibility/context comment on an issue or PR (run it with your own gh creds; loopover never performs the write).", inputSchema: postEligibilityCommentShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildPostEligibilityCommentSpec(input))),
    );
    register(
      "loopover_create_branch",
      { description: "Build a LOCAL-execution spec to create a branch (run it locally; loopover never performs the write).", inputSchema: createBranchShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildCreateBranchSpec(input))),
    );
    register(
      "loopover_delete_branch",
      { description: "Build a LOCAL-execution spec to delete a branch (run it locally; loopover never performs the write).", inputSchema: deleteBranchShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildDeleteBranchSpec(input))),
    );
    register(
      "loopover_generate_tests",
      {
        description:
          "Build a LOCAL-execution spec describing WHAT boundary-safe test cases should exist for the given target files, using the repo's detected framework/convention (see loopover's test-evidence signal). LoopOver supplies the criteria; your OWN agent scaffolds and runs the actual test files locally — no source code is uploaded and loopover never performs the write.",
        inputSchema: testGenShape,
        outputSchema: localWriteActionOutputSchema,
      },
      async (input) => this.toolResult(this.localWriteSpec(buildTestGenSpec(input))),
    );
    register(
      "loopover_file_follow_up_issue",
      {
        description:
          "Build a LOCAL-execution spec to file a follow-up issue for a review finding a maintainer wants TRACKED rather than blocked on this PR. Composes a bounded, public-safe title/body from the finding (run it with your own gh creds; loopover never performs the write).",
        inputSchema: followUpIssueShape,
        outputSchema: localWriteActionOutputSchema,
      },
      async (input) => this.toolResult(this.localWriteSpec(buildFollowUpIssueSpec(input))),
    );

    // #783 multi-step plan DAG — stateless: pass the plan back each call.
    register(
      "loopover_build_plan",
      { description: "Normalize raw steps into a validated multi-step plan DAG (per-step state + retries). Returns the plan to hold and pass back to the other plan tools.", inputSchema: buildPlanShape, outputSchema: planViewOutputSchema },
      async (input) => this.toolResult(this.buildPlan(input)),
    );
    register(
      "loopover_plan_status",
      { description: "Return a plan's progress, validation, and the steps ready to run now (all dependencies met).", inputSchema: planStatusShape, outputSchema: planViewOutputSchema },
      async (input) => this.toolResult(this.planStatusTool(input)),
    );
    register(
      "loopover_record_step_result",
      { description: "Record a step's outcome (completed / failed / skipped). A failure retries until maxAttempts is exhausted. Returns the advanced plan + the next ready steps.", inputSchema: recordStepResultShape, outputSchema: planViewOutputSchema },
      async (input) => this.toolResult(this.recordStepResult(input)),
    );

    // #784 (MCP control surface, read side): a repo's agent automation posture — autonomy dial, kill-switch /
    // dry-run mode, write-permission readiness, and the pending-approval count. Repo-access scoped.
    register(
      "loopover_get_automation_state",
      {
        description:
          "Return a repo's agent automation state: the per-action autonomy levels, kill-switch / dry-run mode, GitHub write-permission readiness, and how many auto_with_approval actions are awaiting a maintainer decision.",
        inputSchema: ownerRepoShape,
        outputSchema: automationStateOutputSchema,
      },
      async (input) => this.toolResult(await this.getAutomationState(input)),
    );

    // #6087 (MCP control surface, write side): the missing MCP counterpart to `maintain pause`/`resume`
    // (loopover-mcp.js:1783). Maintainer-manage access required, same as loopover_propose_action.
    register(
      "loopover_set_agent_paused",
      {
        description:
          "Pause or resume ALL agent actions on a repo (the kill-switch toggle) -- the write-side counterpart to loopover_get_automation_state's agentPaused/mode fields, same as `loopover-mcp maintain pause|resume`. Maintainer access required.",
        inputSchema: setAgentPausedShape,
        outputSchema: setAgentPausedOutputSchema,
      },
      async (input) => this.toolResult(await this.setAgentPaused(input)),
    );

    // #6087 (MCP control surface, write side): the missing MCP counterpart to `maintain set-level`
    // (loopover-mcp.js:1789). Maintainer-manage access required, same as loopover_propose_action.
    register(
      "loopover_set_action_autonomy",
      {
        description:
          "Set the autonomy level for one action class via a read-merge-write so other classes are left untouched -- the write-side counterpart to loopover_get_automation_state's autonomy map, same as `loopover-mcp maintain set-level <action> <level>`. Maintainer access required.",
        inputSchema: setActionAutonomyShape,
        outputSchema: setActionAutonomyOutputSchema,
      },
      async (input) => this.toolResult(await this.setActionAutonomy(input)),
    );

    register(
      "loopover_propose_action",
      {
        description:
          "Stage a PR action (label / request_changes / approve / merge / close) into the repo's approval queue for a maintainer to accept or reject. Maintainer access required; the action is NOT executed until approved.",
        inputSchema: proposeActionShape,
        outputSchema: proposeActionOutputSchema,
      },
      async (input) => this.toolResult(await this.proposeAction(input)),
    );

    register(
      "loopover_list_pending_actions",
      {
        description:
          "List the agent actions staged in a repo's approval queue (default status=pending), so a maintainer can review what is awaiting a decision. Maintainer access required.",
        inputSchema: listPendingActionsShape,
        outputSchema: listPendingActionsOutputSchema,
      },
      async (input) => this.toolResult(await this.listPendingActions(input)),
    );

    register(
      "loopover_decide_pending_action",
      {
        description:
          "Accept (execute) or reject a staged approval-queue action by id. Accept runs it through the live executor gates; reject cancels it. Idempotent and scoped to this repo. Maintainer access required.",
        inputSchema: decidePendingActionShape,
        outputSchema: decidePendingActionOutputSchema,
      },
      async (input) => this.toolResult(await this.decidePendingAction(input)),
    );

    register(
      "loopover_refresh_repo_docs",
      {
        description:
          "Force an immediate repo-doc refresh (AGENTS.md/CLAUDE.md, and a skill file when warranted) for one repo, without waiting for the scheduled interval. Only ever opens a pull request -- never a direct commit -- and only when repoDocGeneration is enabled for this repo and the generated content actually changed. Maintainer access required.",
        inputSchema: refreshRepoDocsShape,
        outputSchema: refreshRepoDocsOutputSchema,
      },
      async (input) => this.toolResult(await this.refreshRepoDocs(input)),
    );

    register(
      "loopover_get_agent_audit_feed",
      {
        description:
          "Return a repo's agent audit feed: executed actions (agent.action.*) and approval-queue decisions (accepted/rejected), newest first. Read-only and public-safe (action posture only). Maintainer access required.",
        inputSchema: auditFeedShape,
        outputSchema: auditFeedOutputSchema,
      },
      async (input) => this.toolResult(await this.getAgentAuditFeed(input)),
    );

    register(
      "loopover_explain_score_breakdown",
      {
        description:
          "Explain a private score preview multiplier-by-multiplier with plain-English levers and the single highest-impact improvement. Login and repo scoped; no new computation beyond the preview projection.",
        inputSchema: scorePreviewShape,
        outputSchema: scoreBreakdownOutputSchema,
      },
      async (input) => this.toolResult(await this.explainScoreBreakdown(input)),
    );

    register(
      "loopover_explain_review_risk",
      {
        description: "Explain review risk for a planned PR using preflight, lane, duplicate, and role context.",
        inputSchema: preflightShape,
        outputSchema: explainReviewRiskOutputSchema,
      },
      async (input) => this.toolResult(await this.explainReviewRisk(input)),
    );

    register(
      "loopover_compare_pr_variants",
      {
        description: "Compare private scoring previews for multiple PR variants.",
        inputSchema: variantsShape,
        outputSchema: variantsOutputSchema,
      },
      async (input) => this.toolResult(await this.comparePrVariants(input.variants)),
    );

    register(
      "loopover_local_status",
      {
        description: "Return LoopOver local-MCP contract status and privacy defaults.",
        inputSchema: {},
        outputSchema: localStatusOutputSchema,
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
        description: "Analyze current-branch metadata supplied by a local MCP wrapper and return PR readiness.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: preflightCurrentBranchOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "preflight")),
    );

    register(
      "loopover_preview_current_branch_score",
      {
        description: "Analyze current-branch metadata and return private scoreability context.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: previewCurrentBranchScoreOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scorePreview")),
    );

    register(
      "loopover_rank_local_next_actions",
      {
        description: "Analyze current-branch metadata and rank local next actions by private reward/risk signals.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: rankLocalNextActionsOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "nextActions")),
    );

    register(
      "loopover_explain_local_blockers",
      {
        description: "Analyze current-branch metadata and explain private scoreability and review blockers.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: explainLocalBlockersOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scoreBlockers")),
    );

    register(
      "loopover_remediation_plan",
      {
        description:
          "Turn local branch blocker lists into an ordered, deduplicated public-safe remediation checklist with rerun conditions. Metadata only.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: remediationPlanOutputSchema,
      },
      async (input) => this.toolResult(await this.remediationPlan(input)),
    );

    register(
      "loopover_prepare_pr_packet",
      {
        description: "Analyze current-branch metadata and return a public-safe PR packet for coding agents.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: prepareLocalPrPacketOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "prPacket")),
    );

    register(
      "loopover_draft_pr_body",
      {
        description: "Draft a public-safe, copy/paste PR body from local branch metadata (changed files, tests run, linked issue, duplicate/WIP caution, branch freshness, next steps). Private scoreability/reward/trust context is excluded; source contents are not uploaded.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: draftPrBodyOutputSchema,
      },
      async (input) => this.toolResult(await this.draftPrBody(input)),
    );

    register(
      "loopover_compare_local_variants",
      {
        description: "Compare private local-branch analysis variants without source uploads.",
        inputSchema: localBranchVariantsShape,
        outputSchema: variantsOutputSchema,
      },
      async (input) => this.toolResult(await this.compareLocalVariants(input.variants)),
    );

    register(
      "loopover_agent_plan_next_work",
      {
        description: "Run the deterministic LoopOver base-agent planner and rank the next Gittensor OSS contribution actions.",
        inputSchema: agentPlanShape,
        outputSchema: agentPlanNextWorkOutputSchema,
      },
      async (input, extra) => this.toolResult(await this.agentPlanNextWork(input, extra, server)),
    );

    register(
      "loopover_agent_start_run",
      {
        description: "Create a queued copilot-only LoopOver agent run. The agent plans and explains; it does not edit code or open PRs.",
        inputSchema: agentRunShape,
        outputSchema: agentRunBundleOutputSchema,
      },
      async (input) => this.toolResult(await this.agentStartRun(input)),
    );

    register(
      "loopover_agent_get_run",
      {
        description: "Fetch a persisted LoopOver agent run with ranked actions and context snapshots.",
        inputSchema: agentRunIdShape,
        outputSchema: agentRunBundleOutputSchema,
      },
      async (input) => this.toolResult(await this.agentGetRun(input.runId)),
    );

    register(
      "loopover_agent_explain_next_action",
      {
        description: "Explain the top deterministic next action and its scoreability/risk/maintainer impact.",
        inputSchema: agentPlanShape,
        outputSchema: agentExplainNextActionOutputSchema,
      },
      async (input) => this.toolResult(await this.agentExplainNextAction(input)),
    );

    register(
      "loopover_agent_prepare_pr_packet",
      {
        description: "Prepare a public-safe PR packet from local branch metadata. Source contents are not uploaded.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: agentRunBundleOutputSchema,
      },
      async (input) => this.toolResult(await this.agentPreparePrPacket(input)),
    );

    // ── Miner planning prompts ───────────────────────────────────────────
    server.registerPrompt(
      "loopover_select_contribution_issue",
      {
        title: "Select contribution issue",
        description: "Identify the best open issue for a contributor to work on based on lane fit, issue quality, and queue signals. Advisory only — no GitHub writes.",
        argsSchema: { ...ownerRepoShape, login: z.string().min(1) },
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
        argsSchema: { ...ownerRepoShape, login: z.string().min(1) },
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
        argsSchema: { ...ownerRepoShape, login: z.string().min(1) },
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
    if (await canWatchRepo(this.env, login, repoFullName)) return;
    throw new Error("Forbidden: session cannot watch this repository.");
  }

  private loadSessionAccessScope(): Promise<ControlPanelAccessScope> {
    if (this.identity.kind !== "session") throw new Error("Session access scope is only available for session identities.");
    this.accessScopePromise ??= loadControlPanelAccessScope(this.env, this.identity.actor);
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
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoApprovalQueueAccess(fullName);
    const report = await loadMaintainerNoiseReport(this.env, fullName);
    return {
      summary: maintainerNoiseSummary(report),
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
    const response = await loadOrComputeBurdenForecastResponse(this.env, fullName);
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
    const report = buildPreStartCheck(repo, issues, pullRequests, recentMergedPullRequests, fullName, {
      issueNumber: input.issueNumber,
      title: input.title,
      plannedPaths: input.plannedPaths,
    });
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

  private async findOpportunities(input: z.infer<z.ZodObject<typeof findOpportunitiesShape>>): Promise<ToolPayload> {
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

  private async retrieveIssueContext(input: z.infer<z.ZodObject<typeof issueRagShape>>): Promise<ToolPayload> {
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
      if (isAuthorizedGitHubSessionLogin(this.env, this.identity.actor)) return;
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

  private async canAccessRepo(fullName: string): Promise<boolean> {
    if (this.identity.kind === "session") return canLoginAccessRepo(this.env, this.identity.actor, fullName);
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
      const [summary, scope] = await Promise.all([loadControlPanelRoleSummary(this.env, this.identity.actor), this.loadSessionAccessScope()]);
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
  }): Promise<ToolPayload> {
    const repoFullNames = await this.requireSkippedPrAuditAccess(input.repoFullName);
    let sinceIso: string | undefined;
    if (input.since !== undefined) {
      const timestamp = Date.parse(input.since);
      if (!Number.isFinite(timestamp)) throw new Error(`Invalid since: "${input.since}" is not a parseable date.`);
      sinceIso = new Date(timestamp).toISOString();
    }
    const page = await listPrVisibilitySkipAuditEvents(this.env, { limit: input.limit, repoFullNames, reason: input.reason, sinceIso });
    return {
      summary: `LoopOver skipped-PR audit: ${page.items.length} event(s) (limit ${page.limit}${page.hasMore ? ", more available" : ""}).`,
      data: {
        generatedAt: nowIso(),
        limit: page.limit,
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

  private async intakeIdea(input: z.infer<z.ZodObject<typeof intakeIdeaShape>>): Promise<ToolPayload> {
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

  private async planIdeaClaims(input: z.infer<z.ZodObject<typeof intakeIdeaShape>>): Promise<ToolPayload> {
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

  private async buildLoopResults(input: z.infer<z.ZodObject<typeof buildResultsPayloadShape>>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_build_results_payload");
    const payload = buildResultsPayload(input);
    return {
      summary: payload.summary,
      data: payload as unknown as Record<string, unknown>,
    };
  }

  private async evalEscalation(input: z.infer<z.ZodObject<typeof evaluateEscalationShape>>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_evaluate_escalation");
    const decision = evaluateEscalation(input);
    return {
      summary: `Escalation: ${decision.action} (severity ${decision.severity}), ${decision.reasons.length} reason(s).`,
      data: decision as unknown as Record<string, unknown>,
    };
  }

  private async buildLoopProgress(input: z.infer<z.ZodObject<typeof buildProgressSnapshotShape>>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_build_progress_snapshot");
    const snapshot = buildProgressSnapshot(input);
    return {
      summary: `Loop progress: ${snapshot.phase} (${snapshot.status}), iteration ${snapshot.iteration}.`,
      data: snapshot as unknown as Record<string, unknown>,
    };
  }

  private async checkSlopRisk(input: z.infer<z.ZodObject<typeof checkSlopRiskShape>>): Promise<ToolPayload> {
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
    input: z.infer<z.ZodObject<typeof checkImprovementPotentialShape>>,
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

  private async checkTestEvidence(input: z.infer<z.ZodObject<typeof checkTestEvidenceShape>>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_check_test_evidence");
    const allPaths = [...input.changedPaths, ...(input.testFiles ?? [])];
    const classification = classifyTestCoverage(allPaths);
    const codeFileCount = input.changedPaths.filter(isCodeFile).length;
    const testFileCount = allPaths.filter(isTestPath).length;
    const guidance: string[] = [];
    if (codeFileCount === 0) {
      guidance.push("No hand-authored code files changed, so the missing-test-evidence signal does not apply (e.g. a docs- or config-only change).");
    } else if (classification === "absent") {
      guidance.push("Changed code files carry no test evidence — add or update a test that exercises the change before opening the PR.");
    } else if (classification === "strong") {
      guidance.push("Test coverage looks strong for this change.");
    } else {
      guidance.push(`Test coverage is ${classification} for this change — adding another focused test would strengthen the evidence.`);
    }
    return {
      summary: `Test evidence: ${classification}.`,
      data: { classification, changedFileCount: allPaths.length, codeFileCount, testFileCount, guidance } as unknown as Record<string, unknown>,
    };
  }

  private async checkIssueSlop(input: z.infer<z.ZodObject<typeof checkIssueSlopShape>>): Promise<ToolPayload> {
    await this.enforceToolRateLimit("loopover_check_issue_slop");
    const assessment = buildIssueSlopAssessment(input);
    return {
      summary: `Issue slop risk: ${assessment.band}.`,
      data: { band: assessment.band, findings: assessment.findings } as unknown as Record<string, unknown>,
    };
  }

  private suggestBoundaryTests(input: z.infer<z.ZodObject<typeof suggestBoundaryTestsShape>>): ToolPayload {
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
    input: z.infer<z.ZodObject<typeof predictGateShape>>,
  ): Promise<{ repoFullName: string; verdict: PredictedGateVerdict }> {
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

  private async predictGate(input: z.infer<z.ZodObject<typeof predictGateShape>>): Promise<ToolPayload> {
    const { repoFullName, verdict } = await this.computePredictedGateVerdict(input);
    return {
      summary: `Predicted LoopOver gate for ${repoFullName} under the ${verdict.pack} pack: ${verdict.conclusion}.`,
      data: verdict as unknown as Record<string, unknown>,
    };
  }

  /** #2234: the itemized per-rule dispositions behind predict_gate's verdict — which specific gate rules would
   *  block vs advise, and why. Reuses computePredictedGateVerdict (identical prediction), then reshapes it via the
   *  pure buildGateDispositions. Read-only reasoning surface — no merge/close decision. */
  private async explainGateDisposition(input: z.infer<z.ZodObject<typeof predictGateShape>>): Promise<ToolPayload> {
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
    const deliveries = await listNotificationDeliveriesForRecipient(this.env, login, { eventType: "pull_request_merged", limit: limit ?? 50 });
    const outcomes = deliveries.map((delivery) => ({
      repoFullName: delivery.repoFullName,
      pullNumber: delivery.pullNumber,
      outcome: "merged" as const,
      attribution: delivery.body,
      deeplink: delivery.deeplink,
      recordedAt: delivery.createdAt,
    }));
    return {
      summary: `LoopOver post-merge outcomes for ${login}: ${outcomes.length} merged PR(s).`,
      data: { login: login.toLowerCase(), count: outcomes.length, outcomes } as unknown as Record<string, unknown>,
    };
  }

  private async getPrAiReviewFindings(input: z.infer<z.ZodObject<typeof loginRepoPullShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const repoFullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(repoFullName);
    const pullRequest = await getPullRequest(this.env, repoFullName, input.pullNumber);
    if (!pullRequest) {
      return {
        summary: `No pull request ${repoFullName}#${input.pullNumber}.`,
        data: {
          status: "not_found",
          repoFullName,
          pullNumber: input.pullNumber,
          login: input.login.toLowerCase(),
          findings: [],
          categoryCounts: {},
        },
      };
    }
    assertContributorOwnsPullRequest(pullRequest.authorLogin, input.login);
    const payload = await loadPrAiReviewFindings(this.env, {
      repoFullName,
      pullNumber: input.pullNumber,
      login: input.login,
    });
    const findingCount = payload.status === "ready" ? payload.findings.length : 0;
    const summary =
      payload.status === "ready"
        ? `${findingCount} AI-review finding(s) on ${repoFullName}#${input.pullNumber}.`
        : payload.status === "ai_review_off"
          ? `AI review is off for ${repoFullName}; no findings to return for #${input.pullNumber}.`
          : `No published AI review findings for ${repoFullName}#${input.pullNumber}.`;
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
  private async watchIssues(input: z.infer<z.ZodObject<typeof watchIssuesShape>>): Promise<ToolPayload> {
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

  private async preflightPr(input: z.infer<z.ZodObject<typeof preflightShape>>): Promise<ToolPayload> {
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

  private async preflightLocalDiff(input: z.infer<z.ZodObject<typeof localDiffPreflightShape>>): Promise<ToolPayload> {
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

  private async previewScore(input: z.infer<z.ZodObject<typeof scorePreviewShape>>): Promise<ToolPayload> {
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

  private async getEligibilityPlan(input: z.infer<z.ZodObject<typeof scorePreviewShape>>): Promise<ToolPayload> {
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
  private runLocalScorer(input: z.infer<z.ZodObject<typeof runLocalScorerShape>>): ToolPayload {
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

  private buildPlan(input: z.infer<z.ZodObject<typeof buildPlanShape>>): ToolPayload {
    const plan = buildPlanDag(input.steps);
    const validation = validatePlanDag(plan);
    return { summary: `Built a ${plan.steps.length}-step plan (${validation.valid ? "valid DAG" : `INVALID: ${validation.errors.join("; ")}`}).`, data: this.planView(plan) };
  }

  private planStatusTool(input: z.infer<z.ZodObject<typeof planStatusShape>>): ToolPayload {
    const plan = input.plan as PlanDag;
    return { summary: `Plan status: ${planProgress(plan).status}.`, data: this.planView(plan) };
  }

  private recordStepResult(input: z.infer<z.ZodObject<typeof recordStepResultShape>>): ToolPayload {
    const plan = applyStepResult(input.plan as PlanDag, input.stepId, { outcome: input.outcome, ...(input.error !== undefined ? { error: input.error } : {}) });
    return { summary: `Recorded ${input.outcome} for step ${input.stepId}; plan is now ${planProgress(plan).status}.`, data: this.planView(plan) };
  }

  // #784 — read the agent automation state for a repo. Repo-access scoped; surfaces the count (not the
  // details) of the approval queue — the full queue + accept/reject stay behind the maintainer-authed REST API.
  private async getAutomationState(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const [repo, settings, pendingActionCount] = await Promise.all([
      getRepository(this.env, fullName),
      resolveRepositorySettings(this.env, fullName),
      countPendingAgentActions(this.env, { repoFullName: fullName, status: "pending" }),
    ]);
    const autonomy = settings.autonomy;
    const actingActionClasses = AGENT_ACTION_CLASSES.filter((actionClass) => isActingAutonomyLevel(resolveAutonomy(autonomy, actionClass)));
    const installation = repo?.installationId ? await getInstallation(this.env, repo.installationId) : null;
    const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(this.env) || (await isGlobalAgentFrozen(this.env)), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
    const permissionReadiness = resolveAgentPermissionReadiness({ autonomy, installationPermissions: installation?.permissions ?? null });
    return {
      summary: `Agent automation for ${fullName}: mode=${mode}, ${actingActionClasses.length} acting class(es), ${pendingActionCount} pending approval(s).`,
      data: {
        repoFullName: fullName,
        configured: actingActionClasses.length > 0,
        autonomy,
        autoMaintain: settings.autoMaintain,
        agentPaused: settings.agentPaused === true,
        agentDryRun: settings.agentDryRun === true,
        mode,
        permissionReadiness,
        actingActionClasses,
        pendingActionCount,
      },
    };
  }

  // #6087 — pause/resume: the write-side kill-switch counterpart to loopover_get_automation_state's read-only
  // mode/agentPaused fields. Reads the RAW settings row (not resolveRepositorySettings's yaml-merged view --
  // writing back a yaml-only override would wrongly persist it into the DB row) and writes the whole row back,
  // mirroring the PUT /settings route's own read-merge-write so unrelated settings groups are preserved.
  private async setAgentPaused(input: z.infer<z.ZodObject<typeof setAgentPausedShape>>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const current = await getRepositorySettings(this.env, fullName);
    const updated = await upsertRepositorySettings(this.env, { ...current, agentPaused: input.paused });
    return {
      summary: `Agent actions ${input.paused ? "paused" : "resumed"} for ${fullName}.`,
      data: { repoFullName: fullName, agentPaused: updated.agentPaused },
    };
  }

  // #6087 — set-level: the write-side per-action-class autonomy dial. Read-merge-write over the autonomy map
  // (mirrors the CLI's own read-merge-write, loopover-mcp.js:1789-1796) so setting one action class's level
  // never clobbers the others.
  private async setActionAutonomy(input: z.infer<z.ZodObject<typeof setActionAutonomyShape>>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const current = await getRepositorySettings(this.env, fullName);
    const autonomy = { ...current.autonomy, [input.action]: input.level };
    const updated = await upsertRepositorySettings(this.env, { ...current, autonomy });
    return {
      summary: `Set ${input.action} autonomy to ${input.level} for ${fullName}.`,
      data: { repoFullName: fullName, action: input.action, level: input.level, autonomy: updated.autonomy },
    };
  }

  // #784 — stage a proposed PR action into the approval queue (#779) for a maintainer to accept/reject. The
  // action is auto_with_approval (never auto-executes); maintainer-manage access required.
  private async proposeAction(input: z.infer<z.ZodObject<typeof proposeActionShape>>): Promise<ToolPayload> {
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
  private async listPendingActions(input: z.infer<z.ZodObject<typeof listPendingActionsShape>>): Promise<ToolPayload> {
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
  private async decidePendingAction(input: z.infer<z.ZodObject<typeof decidePendingActionShape>>): Promise<ToolPayload> {
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
  private async refreshRepoDocs(input: z.infer<z.ZodObject<typeof refreshRepoDocsShape>>): Promise<ToolPayload> {
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

  // #784 — the agent audit feed: executed actions + approval decisions for a repo, newest first.
  // Maintainer-manage scoped; read-only and public-safe (action posture only — no trust/score metadata).
  private async getAgentAuditFeed(input: z.infer<z.ZodObject<typeof auditFeedShape>>): Promise<ToolPayload> {
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

  private async explainScoreBreakdown(input: z.infer<z.ZodObject<typeof scorePreviewShape>>): Promise<ToolPayload> {
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

  private async explainReviewRisk(input: z.infer<z.ZodObject<typeof preflightShape>>): Promise<ToolPayload> {
    if (input.contributorLogin) this.requireContributorAccess(input.contributorLogin);
    await this.requireRepoAccess(input.repoFullName);
    const [repo, issues, pullRequests, bounties] = await Promise.all([
      getRepository(this.env, input.repoFullName),
      listIssues(this.env, input.repoFullName),
      listPullRequests(this.env, input.repoFullName),
      listBountiesByRepo(this.env, input.repoFullName),
    ]);
    const preflight = buildPreflightResult(input, repo, issues, pullRequests, bounties);
    const roleContext = input.contributorLogin
      ? buildRoleContext({ login: input.contributorLogin, repo, repoFullName: input.repoFullName, pullRequests, issues })
      : null;
    return {
      summary: `LoopOver review-risk explanation for ${input.repoFullName}.`,
      data: {
        preflight,
        roleContext,
        recommendation: preflight.collisions.some((cluster) => cluster.risk === "high")
          ? "likely_duplicate"
          : roleContext?.maintainerLane
            ? "maintainer_lane"
            : preflight.status === "needs_work"
              ? "needs_author"
              : preflight.status === "ready"
                ? "review"
                : "watch",
      },
    };
  }

  private async comparePrVariants(variants: Array<z.infer<z.ZodObject<typeof scorePreviewShape>>>): Promise<ToolPayload> {
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

  private async localBranchSlice(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>, slice: "preflight" | "scorePreview" | "nextActions" | "scoreBlockers" | "prPacket"): Promise<ToolPayload> {
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

  private async compareLocalVariants(variants: Array<z.infer<z.ZodObject<typeof localBranchAnalysisShape>>>): Promise<ToolPayload> {
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
    input: z.infer<z.ZodObject<typeof agentPlanShape>>,
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
    input: z.infer<z.ZodObject<typeof agentPlanShape>>,
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

  private async agentStartRun(input: z.infer<z.ZodObject<typeof agentRunShape>>): Promise<ToolPayload> {
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

  private async agentExplainNextAction(input: z.infer<z.ZodObject<typeof agentPlanShape>>): Promise<ToolPayload> {
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

  private async agentPreparePrPacket(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const bundle = await preparePrPacketWithAgent(this.env, input, "mcp");
    return {
      summary: `LoopOver base-agent public-safe PR packet for ${input.repoFullName}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async remediationPlan(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>): Promise<ToolPayload> {
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

  private async draftPrBody(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>): Promise<ToolPayload> {
    const analysis = await this.analyzeLocalBranch(input);
    const draft = buildPublicPrBodyDraft(analysis);
    // Human-readable summary carries the rendered markdown body; structured draft is returned as JSON.
    return {
      summary: `Public-safe PR body draft for ${analysis.repoFullName} (metadata only; internal analysis context omitted).\n\n${draft.markdown}`,
      data: draft as unknown as Record<string, unknown>,
    };
  }

  private async analyzeLocalBranch(input: z.infer<z.ZodObject<typeof localBranchAnalysisShape>>) {
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
  // Extension-scoped browser sessions (extension:pull_context / extension:contributor_context) are
  // down-scoped credentials confined to /v1/extension/* by the global route middleware. The /mcp
  // endpoint lives outside /v1/ (so requiresApiToken, and with it the extension-scope 403, never
  // runs) and does its own auth here — so it must re-apply that confinement. Without this, a leaked
  // extension token authenticates to /mcp and invokes MCP tools the scope was meant to forbid.
  if (identity.session.scopes.some((scope) => scope.startsWith("extension:"))) return null;
  const summary = await loadControlPanelRoleSummary(c.env, identity.actor);
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
