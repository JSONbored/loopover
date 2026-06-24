import { createMcpHandler } from "agents/mcp";
import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authenticatePrivateToken, extractBearerToken, type AuthIdentity } from "../auth/security";
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
  getRepository,
  getRepositorySettings,
  getRepoQueueTrendSnapshot,
  listAgentAuditEvents,
  listCheckSummaries,
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
  listOpenPullRequests,
  listPullRequests,
  listRecentMergedPullRequests,
  listRepoSyncSegments,
  listRepoSyncStates,
  listRepositories,
  MAX_NOTIFICATION_DELIVERY_ID_LENGTH,
  MAX_NOTIFICATION_MARK_READ_IDS,
  markNotificationDeliveriesRead,
  recordProductUsageEvent,
} from "../db/repositories";
import { decidePendingAgentAction } from "../services/agent-approval-queue";
import { buildNotificationFeed } from "../notifications/service";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { getRepositoryCollaboratorPermission } from "../github/app";
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
import { loadContributorDecisionPackForServing, repoDecisionFromPack } from "../services/decision-pack";
import { buildPublicPrBodyDraft } from "../services/pr-body-draft";
import { buildRemediationPlan } from "../services/remediation-plan";
import { explainScoreBreakdown } from "../services/score-breakdown";
import { loadOrComputeIssueQualityResponse } from "../services/issue-quality";
import { loadOrComputeBurdenForecastResponse } from "../services/burden-forecast";
import { buildMcpClientTelemetry } from "../services/client-telemetry";
import { loadOrComputeRepoOutcomePatternsResponse } from "../services/repo-outcome-patterns";
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
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../signals/local-branch";
import { computeLocalScorerTokens } from "../signals/local-scorer";
import {
  buildApplyLabelsSpec,
  buildCreateBranchSpec,
  buildDeleteBranchSpec,
  buildFileIssueSpec,
  buildOpenPrSpec,
  buildPostEligibilityCommentSpec,
  type LocalWriteActionSpec,
} from "./local-write-tools";
import { applyStepResult, buildPlanDag, nextReadySteps, planProgress, validatePlanDag, type PlanDag } from "../services/plan-dag";
import { isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "../settings/agent-execution";
import { AGENT_ACTION_CLASSES, isActingAutonomyLevel, resolveAutonomy } from "../settings/autonomy";
import { MAX_FOCUS_MANIFEST_BYTES } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildPredictedGateVerdict } from "../rules/predicted-gate";
import { buildIssueSlopAssessment, buildSlopAssessment, ISSUE_SLOP_RUBRIC_MARKDOWN, SLOP_RUBRIC_MARKDOWN } from "../signals/slop";
import { buildRepoDataQuality } from "../signals/data-quality";
import { PREFLIGHT_LIMITS } from "../signals/preflight-limits";
import { SCENARIO_MAX_BRANCH_REF_CHARS, SCENARIO_MAX_LINKED_ISSUE_NUMBERS, SCENARIO_MAX_REPO_FULL_NAME_CHARS } from "../scenarios/input-model";
import { loadUpstreamStatus } from "../upstream/ruleset";

type AppContext = Context<{ Bindings: Env }>;
type ToolPayload = {
  summary: string;
  data: Record<string, unknown>;
};
type McpToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function decisionPackSummary(login: string, freshness: string, rebuildEnqueued: boolean): string {
  if (freshness === "fresh") return `Gittensory decision pack for ${login}.`;
  if (rebuildEnqueued) return `Gittensory decision pack for ${login} (stale; background rebuild enqueued).`;
  return `Gittensory decision pack for ${login} (stale; rebuild not enqueued).`;
}

const ownerRepoShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
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

const lintPrTextShape = {
  commitMessages: z.array(z.string().max(PREFLIGHT_LIMITS.bodyChars)).max(50).optional(),
  prBody: z.string().max(PREFLIGHT_LIMITS.bodyChars).optional(),
  linkedIssue: z.number().int().positive().optional(),
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
// its own creds — gittensory never performs the write.
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
const localWriteActionOutputSchema = {
  action: z.string(),
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  command: z.string(),
  boundary: z.string(),
};

// #783 plan DAG — STATELESS: the harness holds the plan and passes it back each call; these tools only advance
// the state machine, so gittensory keeps no record of the miner's plan.
const planStepStatusEnum = z.enum(["pending", "running", "completed", "failed", "skipped"]);
const rawPlanStepSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
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
  actionClass: z.enum(["review", "request_changes", "approve", "merge", "close", "label"]),
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

// #784 (MCP slice) — surface + decide the approval queue, so an MCP client can do the full loop it can
// already propose into: list staged actions, then accept (execute) or reject one.
const listPendingActionsShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  status: z.enum(["pending", "accepted", "rejected"]).optional(),
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
// can discover and validate Gittensory responses. Schemas declare documented
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

const freshnessResponseOutputSchema = {
  status: z.string().optional(),
  repoFullName: z.string().optional(),
  source: z.string().optional(),
  freshness: z.string().optional(),
  generatedAt: z.string().optional(),
  report: z.unknown().optional(),
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

const predictGateShape = {
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
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

// Issue-side slop triage (#533): pure local-metadata, like checkSlopRisk — the agent supplies the issue
// title + body, nothing to scope. Advisory-only; issues never block.
const checkIssueSlopShape = {
  title: z.string().max(500).optional(),
  body: z.string().max(40000).optional(),
};

const checkIssueSlopOutputSchema = checkSlopRiskOutputSchema;

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

const lintPrTextOutputSchema = {
  verdict: z.string().optional(),
  score: z.number().optional(),
  components: z.unknown().optional(),
  fixes: z.unknown().optional(),
  summary: z.string().optional(),
  generatedAt: z.string().optional(),
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
  const server = new GittensoryMcp(c.env, identity).createServer();
  try {
    const response = await createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(c.req.raw, c.env, getExecutionContext(c));
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

export class GittensoryMcp {
  private accessScopePromise: Promise<ControlPanelAccessScope> | null = null;

  constructor(
    private readonly env: Env,
    private readonly identity: AuthIdentity = { kind: "static", actor: "mcp" },
  ) {}

  createServer(): McpServer {
    const server = new McpServer({
      name: "gittensory",
      version: "0.1.0",
    });

    server.registerTool(
      "gittensory_get_repo_context",
      {
        description: "Return Gittensory repo context: registration, lane, queue health, collisions, and config quality.",
        inputSchema: ownerRepoShape,
        outputSchema: repoContextOutputSchema,
      },
      async (input) => this.toolResult(await this.getRepoContext(input)),
    );

    server.registerTool(
      "gittensory_get_burden_forecast",
      {
        description: "Return the cached maintainer burden forecast for a repo, including projected review load, queue growth risk, stale PR signals, and a freshness marker.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getBurdenForecast(input)),
    );

    server.registerTool(
      "gittensory_get_repo_outcome_patterns",
      {
        description: "Return cached or freshly-computed per-repo accepted/rejected PR outcome patterns: what maintainers actually merge or close, separated from maintainer-lane activity, with a freshness marker and explicit evidence-completeness.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getRepoOutcomePatterns(input)),
    );

    server.registerTool(
      "gittensory_get_contributor_profile",
      {
        description: "Return an evidence-backed Gittensory contributor profile for a GitHub login.",
        inputSchema: loginShape,
        outputSchema: contributorProfileOutputSchema,
      },
      async (input) => this.toolResult(await this.getContributorProfile(input.login)),
    );

    server.registerTool(
      "gittensory_get_decision_pack",
      {
        description: "Return the canonical private contributor decision pack for a GitHub login.",
        inputSchema: loginShape,
        outputSchema: decisionPackOutputSchema,
      },
      async (input) => this.toolResult(await this.getDecisionPack(input.login)),
    );

    server.registerTool(
      "gittensory_monitor_open_prs",
      {
        description:
          "Inspect a contributor's open PRs on registered repos, classify queue state, and return public-safe next-step packets from cached metadata.",
        inputSchema: loginShape,
        outputSchema: openPrMonitorOutputSchema,
      },
      async (input) => this.toolResult(await this.monitorOpenPullRequests(input.login)),
    );

    server.registerTool(
      "gittensory_predict_gate",
      {
        description:
          "Predict whether a planned PR would pass the repo's Gittensory gate, from its PUBLIC .gittensory.yml only — an agent-native pre-submission self-check that works on ANY repo (no Gittensor account). Under the oss-anti-slop pack the verdict applies to any author; self-scoped to the authenticated login.",
        inputSchema: predictGateShape,
        outputSchema: predictGateOutputSchema,
      },
      async (input) => this.toolResult(await this.predictGate(input)),
    );

    server.registerTool(
      "gittensory_check_slop_risk",
      {
        description:
          "Assess the deterministic slop risk of a planned change from local diff metadata (paths + line counts) + the PR description — an agent-native, source-free quality self-check. Returns slopRisk (0-100), band, findings, and the rubric. No repo data needed.",
        inputSchema: checkSlopRiskShape,
        outputSchema: checkSlopRiskOutputSchema,
      },
      async (input) => this.toolResult(await this.checkSlopRisk(input)),
    );

    server.registerTool(
      "gittensory_check_issue_slop",
      {
        description:
          "Assess the deterministic slop risk of an issue from its title + body alone (no repo data) — flags clearly low-effort issues (empty body, an unfilled template) for triage. Returns slopRisk (0-100), band, findings, and the rubric. Advisory-only: issues never block.",
        inputSchema: checkIssueSlopShape,
        outputSchema: checkIssueSlopOutputSchema,
      },
      async (input) => this.toolResult(await this.checkIssueSlop(input)),
    );

    server.registerTool(
      "gittensory_pr_outcome",
      {
        description:
          "Return a contributor's own post-merge outcome records — for each merged PR, a public-safe attribution of what it did for their standing on the repo. Self-scoped: only the authenticated login's outcomes.",
        inputSchema: prOutcomeShape,
        outputSchema: prOutcomeOutputSchema,
      },
      async (input) => this.toolResult(await this.prOutcomes(input.login, input.limit)),
    );

    server.registerTool(
      "gittensory_list_notifications",
      {
        description:
          "Return a contributor's own Gittensory notifications (e.g. changes requested on their PRs) and unread badge count. Self-scoped: only the authenticated login's notifications.",
        inputSchema: listNotificationsShape,
        outputSchema: notificationsOutputSchema,
      },
      async (input) => this.toolResult(await this.listNotifications(input.login)),
    );

    server.registerTool(
      "gittensory_mark_notifications_read",
      {
        description:
          "Mark a contributor's own delivered notifications as read (clears the badge). Self-scoped; pass `ids` to clear specific notifications or omit to clear all.",
        inputSchema: markNotificationsReadShape,
        outputSchema: markNotificationsReadOutputSchema,
      },
      async (input) => this.toolResult(await this.markNotificationsRead(input.login, input.ids)),
    );

    server.registerTool(
      "gittensory_watch_issues",
      {
        description:
          "Watch repos for NEW grabbable, high-multiplier issues (maintainer-created, not WIP). action=watch subscribes a repo (optional label filter), unwatch removes it, list (default) returns your watches. When a matching issue opens you're notified via gittensory_list_notifications. Self-scoped to the authenticated login.",
        inputSchema: watchIssuesShape,
        outputSchema: watchIssuesOutputSchema,
      },
      async (input) => this.toolResult(await this.watchIssues(input)),
    );

    server.registerTool(
      "gittensory_explain_repo_decision",
      {
        description: "Return the contributor/repo decision from the canonical decision pack.",
        inputSchema: loginRepoShape,
        outputSchema: explainRepoDecisionOutputSchema,
      },
      async (input) => this.toolResult(await this.explainRepoDecision(input)),
    );

    server.registerTool(
      "gittensory_preflight_pr",
      {
        description: "Preflight a planned PR for lane correctness, duplicate risk, linked issues, and review burden.",
        inputSchema: preflightShape,
        outputSchema: preflightResultOutputSchema,
      },
      async (input) => this.toolResult(await this.preflightPr(input)),
    );

    server.registerTool(
      "gittensory_get_bounty_advisory",
      {
        description: "Return lifecycle, funding, and consensus-risk context for a cached Gittensor bounty.",
        inputSchema: bountyShape,
        outputSchema: bountyAdvisoryOutputSchema,
      },
      async (input) => this.toolResult(await this.getBountyAdvisory(input.id)),
    );

    server.registerTool(
      "gittensory_get_registry_changes",
      {
        description: "Return the diff between the latest cached Gittensor registry snapshots.",
        inputSchema: {},
        outputSchema: registryChangesOutputSchema,
      },
      async () => this.toolResult(await this.getRegistryChanges()),
    );

    server.registerTool(
      "gittensory_get_upstream_drift",
      {
        description: "Return private upstream Gittensor ruleset drift status, including stale/drift warnings for MCP planning.",
        inputSchema: {},
        outputSchema: upstreamDriftOutputSchema,
      },
      async () => this.toolResult(await this.getUpstreamDrift()),
    );

    server.registerTool(
      "gittensory_get_issue_quality",
      {
        description: "Return the cached or freshly-computed issue-quality report for a repo, ranking which open issues are actionable, need proof, are stale/duplicate-prone, or already solved.",
        inputSchema: ownerRepoShape,
        outputSchema: freshnessResponseOutputSchema,
      },
      async (input) => this.toolResult(await this.getIssueQuality(input)),
    );

    server.registerTool(
      "gittensory_validate_linked_issue",
      {
        description:
          "Report whether linking a given issue will actually earn the standard linked-issue scoring multiplier for a planned PR — is it open, valid, single-owner, and solvable by this PR — with the precise blocking reason if not. Public-safe; the raw multiplier value stays private. No GitHub writes.",
        inputSchema: validateLinkedIssueShape,
        outputSchema: validateLinkedIssueOutputSchema,
      },
      async (input) => this.toolResult(await this.validateLinkedIssue(input)),
    );

    server.registerTool(
      "gittensory_check_before_start",
      {
        description:
          "Before any code is written, check whether an issue is already claimed or solved, whether a duplicate cluster is forming, and whether it is a valid target. Returns a go/raise/avoid recommendation with public-safe reasons from cached metadata. No GitHub writes.",
        inputSchema: checkBeforeStartShape,
        outputSchema: checkBeforeStartOutputSchema,
      },
      async (input) => this.toolResult(await this.checkBeforeStart(input)),
    );

    server.registerTool(
      "gittensory_lint_pr_text",
      {
        description:
          "Lint a commit message + PR body against the gittensor traceability/no-issue-rationale and Conventional Commit rubric, before submitting. Returns a deterministic quality verdict (strong/adequate/weak) and specific public-safe fixes. Metadata only; no source upload, no GitHub writes.",
        inputSchema: lintPrTextShape,
        outputSchema: lintPrTextOutputSchema,
      },
      async (input) => this.toolResult(this.lintPrText(input)),
    );

    server.registerTool(
      "gittensory_preflight_local_diff",
      {
        description: "Preflight local git-diff metadata without uploading code content.",
        inputSchema: localDiffPreflightShape,
        outputSchema: preflightLocalDiffOutputSchema,
      },
      async (input) => this.toolResult(await this.preflightLocalDiff(input)),
    );

    server.registerTool(
      "gittensory_preview_local_pr_score",
      {
        description: "Return a private scoring preview from local diff metrics or supplied metadata. Source contents are not required.",
        inputSchema: scorePreviewShape,
        outputSchema: scorePreviewRecordOutputSchema,
      },
      async (input) => this.toolResult(await this.previewScore(input)),
    );

    server.registerTool(
      "gittensory_run_local_scorer",
      {
        description:
          "Run Gittensory's deterministic local token scorer over changed-file metadata + local validation results (no source content). Returns token scores to pass back as the `localScorer` field of the score-preview / analyze tools (external_command mode), so the miner never runs the gittensor-root scorer by hand.",
        inputSchema: runLocalScorerShape,
        outputSchema: runLocalScorerOutputSchema,
      },
      async (input) => this.toolResult(this.runLocalScorer(input)),
    );

    // #780 miner write-tools — each returns a LOCAL-execution action spec; gittensory never performs the write.
    server.registerTool(
      "gittensory_open_pr",
      { description: "Build a LOCAL-execution spec to open a pull request from your branch (run it with your own gh creds; gittensory never performs the write).", inputSchema: openPrShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildOpenPrSpec(input))),
    );
    server.registerTool(
      "gittensory_file_issue",
      { description: "Build a LOCAL-execution spec to file an issue (run it with your own gh creds; gittensory never performs the write).", inputSchema: fileIssueShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildFileIssueSpec(input))),
    );
    server.registerTool(
      "gittensory_apply_labels",
      { description: "Build a LOCAL-execution spec to add labels to an issue or PR (run it with your own gh creds; gittensory never performs the write).", inputSchema: applyLabelsShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildApplyLabelsSpec(input))),
    );
    server.registerTool(
      "gittensory_post_eligibility_comment",
      { description: "Build a LOCAL-execution spec to post an eligibility/context comment on an issue or PR (run it with your own gh creds; gittensory never performs the write).", inputSchema: postEligibilityCommentShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildPostEligibilityCommentSpec(input))),
    );
    server.registerTool(
      "gittensory_create_branch",
      { description: "Build a LOCAL-execution spec to create a branch (run it locally; gittensory never performs the write).", inputSchema: createBranchShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildCreateBranchSpec(input))),
    );
    server.registerTool(
      "gittensory_delete_branch",
      { description: "Build a LOCAL-execution spec to delete a branch (run it locally; gittensory never performs the write).", inputSchema: deleteBranchShape, outputSchema: localWriteActionOutputSchema },
      async (input) => this.toolResult(this.localWriteSpec(buildDeleteBranchSpec(input))),
    );

    // #783 multi-step plan DAG — stateless: pass the plan back each call.
    server.registerTool(
      "gittensory_build_plan",
      { description: "Normalize raw steps into a validated multi-step plan DAG (per-step state + retries). Returns the plan to hold and pass back to the other plan tools.", inputSchema: buildPlanShape, outputSchema: planViewOutputSchema },
      async (input) => this.toolResult(this.buildPlan(input)),
    );
    server.registerTool(
      "gittensory_plan_status",
      { description: "Return a plan's progress, validation, and the steps ready to run now (all dependencies met).", inputSchema: planStatusShape, outputSchema: planViewOutputSchema },
      async (input) => this.toolResult(this.planStatusTool(input)),
    );
    server.registerTool(
      "gittensory_record_step_result",
      { description: "Record a step's outcome (completed / failed / skipped). A failure retries until maxAttempts is exhausted. Returns the advanced plan + the next ready steps.", inputSchema: recordStepResultShape, outputSchema: planViewOutputSchema },
      async (input) => this.toolResult(this.recordStepResult(input)),
    );

    // #784 (MCP control surface, read side): a repo's agent automation posture — autonomy dial, kill-switch /
    // dry-run mode, write-permission readiness, and the pending-approval count. Repo-access scoped.
    server.registerTool(
      "gittensory_get_automation_state",
      {
        description:
          "Return a repo's agent automation state: the per-action autonomy levels, kill-switch / dry-run mode, GitHub write-permission readiness, and how many auto_with_approval actions are awaiting a maintainer decision.",
        inputSchema: ownerRepoShape,
        outputSchema: automationStateOutputSchema,
      },
      async (input) => this.toolResult(await this.getAutomationState(input)),
    );

    server.registerTool(
      "gittensory_propose_action",
      {
        description:
          "Stage a PR action (label / request_changes / approve / merge / close) into the repo's approval queue for a maintainer to accept or reject. Maintainer access required; the action is NOT executed until approved.",
        inputSchema: proposeActionShape,
        outputSchema: proposeActionOutputSchema,
      },
      async (input) => this.toolResult(await this.proposeAction(input)),
    );

    server.registerTool(
      "gittensory_list_pending_actions",
      {
        description:
          "List the agent actions staged in a repo's approval queue (default status=pending), so a maintainer can review what is awaiting a decision. Maintainer access required.",
        inputSchema: listPendingActionsShape,
        outputSchema: listPendingActionsOutputSchema,
      },
      async (input) => this.toolResult(await this.listPendingActions(input)),
    );

    server.registerTool(
      "gittensory_decide_pending_action",
      {
        description:
          "Accept (execute) or reject a staged approval-queue action by id. Accept runs it through the live executor gates; reject cancels it. Idempotent and scoped to this repo. Maintainer access required.",
        inputSchema: decidePendingActionShape,
        outputSchema: decidePendingActionOutputSchema,
      },
      async (input) => this.toolResult(await this.decidePendingAction(input)),
    );

    server.registerTool(
      "gittensory_get_agent_audit_feed",
      {
        description:
          "Return a repo's agent audit feed: executed actions (agent.action.*) and approval-queue decisions (accepted/rejected), newest first. Read-only and public-safe (action posture only). Maintainer access required.",
        inputSchema: auditFeedShape,
        outputSchema: auditFeedOutputSchema,
      },
      async (input) => this.toolResult(await this.getAgentAuditFeed(input)),
    );

    server.registerTool(
      "gittensory_explain_score_breakdown",
      {
        description:
          "Explain a private score preview multiplier-by-multiplier with plain-English levers and the single highest-impact improvement. Login and repo scoped; no new computation beyond the preview projection.",
        inputSchema: scorePreviewShape,
        outputSchema: scoreBreakdownOutputSchema,
      },
      async (input) => this.toolResult(await this.explainScoreBreakdown(input)),
    );

    server.registerTool(
      "gittensory_explain_review_risk",
      {
        description: "Explain review risk for a planned PR using preflight, lane, duplicate, and role context.",
        inputSchema: preflightShape,
        outputSchema: explainReviewRiskOutputSchema,
      },
      async (input) => this.toolResult(await this.explainReviewRisk(input)),
    );

    server.registerTool(
      "gittensory_compare_pr_variants",
      {
        description: "Compare private scoring previews for multiple PR variants.",
        inputSchema: variantsShape,
        outputSchema: variantsOutputSchema,
      },
      async (input) => this.toolResult(await this.comparePrVariants(input.variants)),
    );

    server.registerTool(
      "gittensory_local_status",
      {
        description: "Return Gittensory local-MCP contract status and privacy defaults.",
        inputSchema: {},
        outputSchema: localStatusOutputSchema,
      },
      async () =>
        this.toolResult({
          summary: "Gittensory local MCP status.",
          data: {
            apiAvailable: true,
            sourceUploadDefault: false,
            supportedEndpoint: "/v1/local/branch-analysis",
            supportedTools: [
              "gittensory_get_decision_pack",
              "gittensory_explain_repo_decision",
              "gittensory_get_upstream_drift",
              "gittensory_preflight_current_branch",
              "gittensory_preview_current_branch_score",
              "gittensory_rank_local_next_actions",
              "gittensory_compare_local_variants",
              "gittensory_explain_local_blockers",
              "gittensory_prepare_pr_packet",
            ],
          },
        }),
    );

    server.registerTool(
      "gittensory_preflight_current_branch",
      {
        description: "Analyze current-branch metadata supplied by a local MCP wrapper and return PR readiness.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: preflightCurrentBranchOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "preflight")),
    );

    server.registerTool(
      "gittensory_preview_current_branch_score",
      {
        description: "Analyze current-branch metadata and return private scoreability context.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: previewCurrentBranchScoreOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scorePreview")),
    );

    server.registerTool(
      "gittensory_rank_local_next_actions",
      {
        description: "Analyze current-branch metadata and rank local next actions by private reward/risk signals.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: rankLocalNextActionsOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "nextActions")),
    );

    server.registerTool(
      "gittensory_explain_local_blockers",
      {
        description: "Analyze current-branch metadata and explain private scoreability and review blockers.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: explainLocalBlockersOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "scoreBlockers")),
    );

    server.registerTool(
      "gittensory_remediation_plan",
      {
        description:
          "Turn local branch blocker lists into an ordered, deduplicated public-safe remediation checklist with rerun conditions. Metadata only.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: remediationPlanOutputSchema,
      },
      async (input) => this.toolResult(await this.remediationPlan(input)),
    );

    server.registerTool(
      "gittensory_prepare_pr_packet",
      {
        description: "Analyze current-branch metadata and return a public-safe PR packet for coding agents.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: prepareLocalPrPacketOutputSchema,
      },
      async (input) => this.toolResult(await this.localBranchSlice(input, "prPacket")),
    );

    server.registerTool(
      "gittensory_draft_pr_body",
      {
        description: "Draft a public-safe, copy/paste PR body from local branch metadata (changed files, tests run, linked issue, duplicate/WIP caution, branch freshness, next steps). Private scoreability/reward/trust context is excluded; source contents are not uploaded.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: draftPrBodyOutputSchema,
      },
      async (input) => this.toolResult(await this.draftPrBody(input)),
    );

    server.registerTool(
      "gittensory_compare_local_variants",
      {
        description: "Compare private local-branch analysis variants without source uploads.",
        inputSchema: localBranchVariantsShape,
        outputSchema: variantsOutputSchema,
      },
      async (input) => this.toolResult(await this.compareLocalVariants(input.variants)),
    );

    server.registerTool(
      "gittensory_agent_plan_next_work",
      {
        description: "Run the deterministic Gittensory base-agent planner and rank the next Gittensor OSS contribution actions.",
        inputSchema: agentPlanShape,
        outputSchema: agentPlanNextWorkOutputSchema,
      },
      async (input, extra) => this.toolResult(await this.agentPlanNextWork(input, extra, server)),
    );

    server.registerTool(
      "gittensory_agent_start_run",
      {
        description: "Create a queued copilot-only Gittensory agent run. The agent plans and explains; it does not edit code or open PRs.",
        inputSchema: agentRunShape,
        outputSchema: agentRunBundleOutputSchema,
      },
      async (input) => this.toolResult(await this.agentStartRun(input)),
    );

    server.registerTool(
      "gittensory_agent_get_run",
      {
        description: "Fetch a persisted Gittensory agent run with ranked actions and context snapshots.",
        inputSchema: agentRunIdShape,
        outputSchema: agentRunBundleOutputSchema,
      },
      async (input) => this.toolResult(await this.agentGetRun(input.runId)),
    );

    server.registerTool(
      "gittensory_agent_explain_next_action",
      {
        description: "Explain the top deterministic next action and its scoreability/risk/maintainer impact.",
        inputSchema: agentPlanShape,
        outputSchema: agentExplainNextActionOutputSchema,
      },
      async (input) => this.toolResult(await this.agentExplainNextAction(input)),
    );

    server.registerTool(
      "gittensory_agent_prepare_pr_packet",
      {
        description: "Prepare a public-safe PR packet from local branch metadata. Source contents are not uploaded.",
        inputSchema: localBranchAnalysisShape,
        outputSchema: agentRunBundleOutputSchema,
      },
      async (input) => this.toolResult(await this.agentPreparePrPacket(input)),
    );

    // ── Miner planning prompts ───────────────────────────────────────────
    server.registerPrompt(
      "gittensory_select_contribution_issue",
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
              text: `Use gittensory_get_issue_quality and gittensory_explain_repo_decision for ${login} on ${owner}/${repo} to identify which open issues are the best fit. Rank candidates by actionability, lane alignment, and queue pressure. Present a short ranked list with a brief rationale for each. Do not create issues, file comments, or take any GitHub action — this is a planning aid for the contributor to decide from.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "gittensory_draft_contribution_pr_packet",
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
              text: `Use gittensory_get_repo_context and gittensory_get_decision_pack for ${login} to prepare a public-safe PR packet for work on ${owner}/${repo}. The packet should include lane fit, recommended next steps, and any preflight considerations the contributor should address before opening the PR. Do not open a PR, post any comment, or take any GitHub action — present the packet for the contributor to review and submit manually.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "gittensory_preflight_contribution_branch",
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
              text: `Use gittensory_get_repo_context and gittensory_explain_repo_decision for ${login} on ${owner}/${repo} to assess whether the planned branch is ready to be submitted as a PR. Check lane fit, duplicate risk, linked issue coverage, and any signals that suggest the branch needs more work. Present a preflight summary the contributor can act on before opening the PR. Do not open a PR, push any branch, or take any GitHub action.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "gittensory_plan_cleanup_first",
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
              text: `Use gittensory_monitor_open_prs and gittensory_get_decision_pack for ${login} to identify which open PRs to address before starting new contribution work. Surface PRs with failing checks, pending review comments, stale queue pressure, or duplicate risk. Recommend an ordered cleanup list with a brief rationale for each item. Do not close PRs, post comments, or take any GitHub action — present the plan for the contributor to execute manually.`,
            },
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
  }

  private async requireRepoAccess(repoFullName: string): Promise<void> {
    if (await this.canAccessRepo(repoFullName)) return;
    throw new Error("Forbidden: session cannot access this repository.");
  }

  // Stricter than requireRepoAccess (read): a maintainer-MANAGE gate for write actions (#784 propose-action).
  // A session must own/maintain the repo (or be an operator); private-token / static identities are trusted.
  private async requireRepoManageAccess(repoFullName: string): Promise<void> {
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
  // first require repo-scoped Gittensory maintainer/owner/operator authority, then verify live GitHub write.
  private async requireRepoApprovalQueueAccess(repoFullName: string): Promise<void> {
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

  // Issue-watch gate (#699 path B). Sessions may only watch repos they can SEE: any gittensory-tracked PUBLIC
  // repo (the miner use case) or a PRIVATE repo they can access — never an arbitrary/private repo they cannot,
  // so private-repo issues never fan out to them. Non-session (private-token) identities are trusted.
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
      summary: `Gittensory repo context for ${fullName}.`,
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

  private async getBurdenForecast(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const response = await loadOrComputeBurdenForecastResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `Gittensory has no cached burden forecast for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary: `Gittensory burden forecast for ${fullName} (cached, ${response.freshness}).`,
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
        summary: `Gittensory has no cached issue quality for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary:
        response.source === "snapshot"
          ? `Gittensory issue quality for ${fullName} (cached).`
          : `Gittensory issue quality for ${fullName} (computed from cached metadata).`,
      data: response as unknown as Record<string, unknown>,
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
      summary: `Gittensory linked-issue validation for ${fullName}#${input.issueNumber}: multiplier ${report.multiplierWouldApply ? "would apply" : "would not apply"}.`,
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
      summary: `Gittensory pre-start check for ${fullName}: ${report.recommendation.toUpperCase()}.`,
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

  private lintPrText(input: { commitMessages?: string[] | undefined; prBody?: string | undefined; linkedIssue?: number | undefined }): ToolPayload {
    const report = buildPrTextLint(input);
    return {
      summary: `Gittensory PR-text lint verdict: ${report.verdict}.`,
      data: report as unknown as Record<string, unknown>,
    };
  }

  private async canAccessRepo(fullName: string): Promise<boolean> {
    if (this.identity.kind !== "session") return true;
    return canLoginAccessRepo(this.env, this.identity.actor, fullName);
  }

  private async getRepoOutcomePatterns(input: { owner: string; repo: string }): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(fullName);
    const response = await loadOrComputeRepoOutcomePatternsResponse(this.env, fullName);
    if (!response) {
      return {
        summary: `Gittensory has no cached repo outcome patterns for ${fullName}.`,
        data: { status: "not_found", repoFullName: fullName },
      };
    }
    return {
      summary:
        response.source === "snapshot"
          ? `Gittensory repo outcome patterns for ${fullName} (cached, ${response.freshness}).`
          : `Gittensory repo outcome patterns for ${fullName} (computed from cached metadata).`,
      data: response as unknown as Record<string, unknown>,
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
      summary: `Gittensory contributor profile for ${login}.`,
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
      summary: `Gittensory decision pack for ${login} needs a snapshot refresh.`,
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

  private async checkSlopRisk(input: z.infer<z.ZodObject<typeof checkSlopRiskShape>>): Promise<ToolPayload> {
    const assessment = buildSlopAssessment(input);
    return {
      summary: `Slop risk: ${assessment.slopRisk}/100 (${assessment.band}).`,
      data: { ...assessment, rubric: SLOP_RUBRIC_MARKDOWN } as unknown as Record<string, unknown>,
    };
  }

  private async checkIssueSlop(input: z.infer<z.ZodObject<typeof checkIssueSlopShape>>): Promise<ToolPayload> {
    const assessment = buildIssueSlopAssessment(input);
    return {
      summary: `Issue slop risk: ${assessment.slopRisk}/100 (${assessment.band}).`,
      data: { ...assessment, rubric: ISSUE_SLOP_RUBRIC_MARKDOWN } as unknown as Record<string, unknown>,
    };
  }

  private async predictGate(input: z.infer<z.ZodObject<typeof predictGateShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const repoFullName = `${input.owner}/${input.repo}`;
    await this.requireRepoAccess(repoFullName);
    const [repo, issues, pullRequests, bounties, issueQuality, manifest] = await Promise.all([
      getRepository(this.env, repoFullName),
      listIssues(this.env, repoFullName),
      listPullRequests(this.env, repoFullName),
      listBountiesByRepo(this.env, repoFullName),
      loadOrComputeIssueQualityResponse(this.env, repoFullName),
      loadRepoFocusManifest(this.env, repoFullName),
    ]);
    // Resolve the caller's own confirmed-Gittensor status the same way the maintainer pipeline does (official
    // Gittensor API → confirmed). It is surfaced in the verdict for transparency but no longer changes the
    // predicted conclusion — every author is gated identically, so a blocker predicts `failure` regardless of
    // confirmed status (parity with the new real gate). The oss-anti-slop pack carries no contributor field at
    // all, so skip the lookup there (keeps the prediction account-free for non-Gittensor adopters).
    const pack = manifest.gate.pack ?? "gittensor";
    const confirmedContributor = pack === "oss-anti-slop" ? undefined : (await fetchGittensorContributorSnapshot(input.login)) !== null;
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
    });
    return {
      summary: `Predicted Gittensory gate for ${repoFullName} under the ${verdict.pack} pack: ${verdict.conclusion}.`,
      data: verdict as unknown as Record<string, unknown>,
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
      summary: `Gittensory post-merge outcomes for ${login}: ${outcomes.length} merged PR(s).`,
      data: { login: login.toLowerCase(), count: outcomes.length, outcomes } as unknown as Record<string, unknown>,
    };
  }

  private async listNotifications(login: string): Promise<ToolPayload> {
    this.requireContributorAccess(login);
    const deliveries = await listNotificationDeliveriesForRecipient(this.env, login, { channel: "badge", limit: 50 });
    const feed = buildNotificationFeed(login, deliveries);
    return {
      summary: `Gittensory notifications for ${login}: ${feed.unreadCount} unread.`,
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
      summary: `Marked ${marked} Gittensory notification(s) read for ${login}.`,
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
        summary: `Gittensory repo decision for ${input.login} in ${fullName} needs a snapshot refresh.`,
        data: { ...serving.refresh, repoFullName: fullName } as unknown as Record<string, unknown>,
      };
    }
    const pack = serving.pack;
    const decision = repoDecisionFromPack(pack, fullName);
    return {
      summary: `Gittensory repo decision for ${input.login} in ${fullName}.`,
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
      summary: "Gittensory registry changes from latest cached snapshots.",
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
      summary: `Gittensory upstream drift status: ${detail}.`,
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
      summary: `Gittensory PR preflight for ${input.repoFullName}.`,
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
      summary: `Gittensory local diff preflight for ${input.repoFullName}.`,
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
      summary: `Private Gittensory scoring preview for ${input.repoFullName}.`,
      data: makeScorePreviewRecord(scoreInput, snapshot, result) as unknown as Record<string, unknown>,
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
        usage: "Pass `tokenScores` as the `localScorer` field of gittensory_preview_local_pr_score or the analyze tools to score this branch in external_command mode (off metadata-only).",
      },
    };
  }

  // #780 — wrap a local write-action spec for return. gittensory never executes it; the harness runs `command`
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
      getRepositorySettings(this.env, fullName),
      countPendingAgentActions(this.env, { repoFullName: fullName, status: "pending" }),
    ]);
    const autonomy = settings.autonomy;
    const actingActionClasses = AGENT_ACTION_CLASSES.filter((actionClass) => isActingAutonomyLevel(resolveAutonomy(autonomy, actionClass)));
    const installation = repo?.installationId ? await getInstallation(this.env, repo.installationId) : null;
    const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(this.env), agentPaused: settings.agentPaused, agentDryRun: settings.agentDryRun });
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

  // #784 — stage a proposed PR action into the approval queue (#779) for a maintainer to accept/reject. The
  // action is auto_with_approval (never auto-executes); maintainer-manage access required.
  private async proposeAction(input: z.infer<z.ZodObject<typeof proposeActionShape>>): Promise<ToolPayload> {
    const fullName = `${input.owner}/${input.repo}`;
    await this.requireRepoManageAccess(fullName);
    const repo = await getRepository(this.env, fullName);
    if (!repo?.installationId) throw new Error("Cannot propose an action: the Gittensory App is not installed on this repository.");
    const params = {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.reviewBody !== undefined ? { reviewBody: input.reviewBody } : {}),
      ...(input.mergeMethod !== undefined ? { mergeMethod: input.mergeMethod } : {}),
      ...(input.closeComment !== undefined ? { closeComment: input.closeComment } : {}),
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
      summary: `Private Gittensory score breakdown for ${input.contributorLogin} in ${input.repoFullName}. Highest leverage: ${breakdown.highestLeverageLever.component}.`,
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
      summary: `Gittensory review-risk explanation for ${input.repoFullName}.`,
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
      summary: "Private Gittensory PR variant comparison.",
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
      summary: "Gittensory local branch variant comparison.",
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
      summary: `Gittensory base-agent plan for ${input.login}.`,
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
      summary: `Queued Gittensory base-agent run for ${input.actorLogin}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async agentGetRun(runId: string): Promise<ToolPayload> {
    const bundle = await getAgentRunBundle(this.env, runId);
    if (!bundle) throw new Error("Agent run not found.");
    this.requireContributorAccess(bundle.run.actorLogin);
    return {
      summary: `Gittensory base-agent run ${runId}.`,
      data: bundle as unknown as Record<string, unknown>,
    };
  }

  private async agentExplainNextAction(input: z.infer<z.ZodObject<typeof agentPlanShape>>): Promise<ToolPayload> {
    this.requireContributorAccess(input.login);
    const bundle = await explainBlockersWithAgent(this.env, { ...input, surface: "mcp" });
    return {
      summary: `Gittensory base-agent next-action explanation for ${input.login}.`,
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
      summary: `Gittensory base-agent public-safe PR packet for ${input.repoFullName}.`,
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
      summary: `Gittensory remediation plan for ${analysis.login} in ${analysis.repoFullName}.`,
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
      loadRepoFocusManifest(this.env, input.repoFullName),
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
      summary: `Gittensory bounty advisory for ${id}.`,
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

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>>,
  cachedRepoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const officialRepoStats = contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
}

async function authenticateMcpRequest(c: AppContext): Promise<AuthIdentity | null> {
  const identity = await authenticatePrivateToken(c.env, extractBearerToken(c.req.header("authorization")));
  if (!identity || identity.kind !== "session") return identity;
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
