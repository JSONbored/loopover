import { Hono, type Context } from "hono";
import { z } from "zod";
import { analyzePRQueue, type AuthorRole, type ChecksStatus } from "../queue-intelligence";
import { completeGitHubWebOAuth, createSessionFromGitHubToken, pollGitHubDeviceFlow, startGitHubDeviceFlow, startGitHubWebOAuth } from "../auth/github-oauth";
import { enforceRateLimit, routeClassForPath } from "../auth/rate-limit";
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
  revokeSession,
  type AuthIdentity,
} from "../auth/security";
import { normalizeGittBountySnapshot } from "../bounties/ingest";
import { DEFAULT_COMMAND_AUTHORIZATION_POLICY, normalizeCommandAuthorizationPolicy } from "../settings/command-authorization";
import {
  countOpenIssues,
  countOpenPullRequests,
  countActiveAuthSessions,
  countActiveDigestSubscriptions,
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
  recordAuditEvent,
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
  listSignalSnapshots,
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
} from "../db/repositories";
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
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { fetchPublicContributorProfile } from "../github/public";
import {
  buildPublicAgentCommandComment,
  buildMaintainerQueueDigest,
  GITTENSORY_MENTION_COMMAND_CATALOG,
  isAuthorizedCommandActor,
  isMaintainerOnlyCommand,
  sanitizePublicComment,
  type GittensoryMentionCommandName,
} from "../github/commands";
import { handleGitHubWebhook } from "../github/webhook";
import { handleMcpRequest } from "../mcp/server";
import { buildOpenApiSpec } from "../openapi/spec";
import { generateSignalSnapshots } from "../queue/processors";
import { getLatestRegistrySnapshot, listLatestRegistrySnapshots, refreshRegistry } from "../registry/sync";
import { getOrCreateScoringModelSnapshot, refreshScoringModelSnapshot } from "../scoring/model";
import { buildScorePreview, makeScorePreviewRecord } from "../scoring/preview";
import {
  explainBlockersWithAgent,
  getAgentRunBundle,
  planNextWork,
  preparePrPacketWithAgent,
  preflightBranchWithAgent,
  startAgentRun,
} from "../services/agent-orchestrator";
import { buildMcpClientTelemetry } from "../services/client-telemetry";
import {
  buildAndPersistContributorDecisionPack,
  loadContributorDecisionPackForServing,
  repoDecisionFromPack,
} from "../services/decision-pack";
import {
  buildStaticControlPanelRoleSummary,
  loadControlPanelAccessScope,
  loadControlPanelRoleSummary,
} from "../services/control-panel-roles";
import {
  buildMcpCompatibilityMetadata,
  LATEST_RECOMMENDED_MCP_VERSION,
  MINIMUM_SUPPORTED_MCP_VERSION,
} from "../services/mcp-compatibility";
import { buildOperatorDashboardPayload } from "../services/operator-dashboard";
import {
  buildWeeklyValueReport,
  formatWeeklyValueReportMarkdown,
  generateWeeklyValueReport,
  loadWeeklyValueReport,
} from "../services/weekly-value-report";
import { loadOrComputeIssueQualityResponse } from "../services/issue-quality";
import { loadOrComputeBurdenForecastResponse } from "../services/burden-forecast";
import { buildUnavailableQueueTrendReport } from "../services/queue-trends";
import { loadOrComputeRepoOutcomePatternsResponse } from "../services/repo-outcome-patterns";
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
  buildLocalDiffPreflightResult,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildPullRequestMaintainerPacket,
  buildRoleContext,
  buildPreflightResult,
  buildQueueHealth,
  buildRegistryChangeReport,
  type ContributorOutcomeHistory,
  type PullRequestMaintainerPacket,
  type RoleContext,
} from "../signals/engine";
import { attachDataQuality, buildCoreSignalFidelity, buildFreshnessSloReport, buildRepoDataQuality, buildSignalFidelity } from "../signals/data-quality";
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildPullRequestReviewability, type PullRequestReviewability } from "../signals/reward-risk";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../signals/local-branch";
import { MAX_LOCAL_SCORER_WARNING_CHARS, MAX_LOCAL_SCORER_WARNING_COUNT } from "../signals/local-scorer-diagnostics";
import { compileFocusManifestPolicy } from "../signals/focus-manifest";
import { loadRepoFocusManifest, upsertRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildRepoOnboardingPackPreviewForRepo } from "../services/repo-onboarding-pack";
import { buildRepoSettingsPreview, type PublicSurfaceSkipReason } from "../signals/settings-preview";
import { buildGittensorConfigRecommendation, buildRegistrationReadiness, type InstallationHealthSummary } from "../signals/registration-readiness";
import { fileUpstreamDriftIssues, loadUpstreamStatus, refreshUpstreamDrift, registryHyperparameterDriftWarningsForRepo } from "../upstream/ruleset";
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
} from "../types";
import { errorMessage, nowIso } from "../utils/json";

type AppBindings = { Bindings: Env };
type AppContext = Context<AppBindings>;

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
  const telemetry = buildMcpClientTelemetry(c.req.raw.headers, { requireGittensoryHeader: true });
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

const MAX_LOCAL_BRANCH_REF_CHARS = 256;
const MAX_LOCAL_BRANCH_TEXT_CHARS = 4000;
const PR_VISIBILITY_SKIP_REASONS = [
  "surface_off",
  "missing_author",
  "bot_author",
  "maintainer_author",
  "miner_detection_unavailable",
  "not_official_gittensor_miner",
] as const satisfies readonly PublicSurfaceSkipReason[];

const preflightSchema = z.object({
  repoFullName: z.string().min(3),
  contributorLogin: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  changedFiles: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  tests: z.array(z.string()).optional(),
  authorAssociation: z.string().optional(),
});

const localDiffPreflightSchema = preflightSchema.extend({
  changedLineCount: z.number().int().min(0).optional(),
  testFiles: z.array(z.string()).optional(),
  commitMessage: z.string().optional(),
});

const skippedPrAuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().optional(),
    repoFullName: z.string().trim().min(3).max(200).optional(),
    reason: z.enum(PR_VISIBILITY_SKIP_REASONS).optional(),
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
  .strict();

const localBranchAnalysisSchema = z
  .object({
    login: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS),
    repoFullName: z.string().min(3).max(MAX_LOCAL_BRANCH_REF_CHARS),
    baseRef: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    headRef: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    branchName: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    baseSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    headSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    mergeBaseSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    remoteTrackingSha: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    commitMessages: z.array(z.string().max(MAX_LOCAL_BRANCH_TEXT_CHARS)).max(30).optional(),
    changedFiles: z.array(localBranchChangedFileSchema).max(500).optional(),
    validation: z.array(localBranchValidationSchema).max(50).optional(),
    linkedIssues: z.array(z.number().int().positive()).optional(),
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
    focusManifest: z.record(z.string(), z.unknown()).optional(),
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
  existingContributorTokenScore: z.number().min(0).optional(),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
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

const repositorySettingsSchema = z.object({
  commentMode: z.enum(["off", "detected_contributors_only", "all_prs"]).default("detected_contributors_only"),
  publicSignalLevel: z.enum(["minimal", "standard"]).default("standard"),
  checkRunMode: z.enum(["off", "enabled"]).default("off"),
  checkRunDetailLevel: z.enum(["minimal", "standard", "deep"]).default("standard"),
  autoLabelEnabled: z.boolean().default(true),
  gittensorLabel: z.string().trim().min(1).max(50).default("gittensor"),
  createMissingLabel: z.boolean().default(true),
  publicSurface: z.enum(["off", "comment_and_label", "comment_only", "label_only"]).default("comment_and_label"),
  includeMaintainerAuthors: z.boolean().default(false),
  requireLinkedIssue: z.boolean().default(false),
  backfillEnabled: z.boolean().default(true),
  privateTrustEnabled: z.boolean().default(true),
  commandAuthorization: z
    .object({
      default: z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4).optional(),
      commands: z.record(z.string().trim().min(1).max(64), z.array(z.enum(["maintainer", "collaborator", "pr_author", "confirmed_miner"])).max(4)).optional(),
    })
    .default(DEFAULT_COMMAND_AUTHORIZATION_POLICY),
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

const digestSubscriptionSchema = z
  .object({
    email: z.string().email().max(320),
  })
  .strict();

export function createApp() {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    const allowedOrigin = allowedCorsOrigin(c.env, c.req.header("origin"));
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Expose-Headers", "x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin", { append: true });
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
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "gittensory-api",
      time: nowIso(),
      minMcpVersion: MINIMUM_SUPPORTED_MCP_VERSION,
      latestRecommendedMcpVersion: LATEST_RECOMMENDED_MCP_VERSION,
    }),
  );
  app.get("/v1/mcp/compatibility", (c) => c.json(buildMcpCompatibilityMetadata(nowIso())));
  app.get("/openapi.json", (c) => c.json(buildOpenApiSpec()));
  app.all("/mcp", handleMcpRequest);

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
      const session = await createSessionFromGitHubToken(c.env, githubToken, { source: "github_token_exchange" });
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

  app.post("/v1/auth/logout", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    const revoked = await revokeSession(c.env, identity);
    c.header("Set-Cookie", buildClearedBrowserSessionCookie(c.req.url));
    return c.json({ ok: true, revoked });
  });

  app.post("/v1/auth/extension/session", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity || identity.kind !== "session") return c.json({ error: "browser_session_required" }, 403);
    if (isExtensionScopedSession(identity)) return c.json({ error: "browser_session_required" }, 403);
    const roleSummary = await loadControlPanelRoleSummary(c.env, identity.actor);
    if (!roleSummary.roles.some((role) => role === "maintainer" || role === "owner" || role === "operator")) return c.json({ error: "insufficient_role" }, 403);
    const githubUser = identity.session.githubUserId === undefined ? { login: identity.session.login } : { login: identity.session.login, id: identity.session.githubUserId };
    const { token, session } = await createSessionForGitHubUser(
      c.env,
      githubUser,
      {
        scopes: [EXTENSION_PULL_CONTEXT_SCOPE],
        metadata: {
          source: "browser_extension",
          parentSessionId: identity.session.id,
        },
      },
    );
    await recordRouteProductUsage(c, {
      surface: "browser_extension",
      eventName: "extension_session_created",
      role: "maintainer",
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
    const [serving, scoring, upstreamDrift, runs] = await Promise.all([
      loadContributorDecisionPackForServing(c.env, login),
      getLatestScoringModelSnapshot(c.env),
      loadUpstreamStatus(c.env),
      listAgentRunsForActor(c.env, login, 5),
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
    return c.json({
      status: "ready",
      login,
      generatedAt: pack.generatedAt,
      source: pack.source,
      freshness: pack.freshness,
      nextActions: pack.topActions ?? [],
      blockers: groupDecisionPackBlockers(pack.scoreBlockers ?? []),
      projections: buildProjectionRows(pack),
      repoFit: [
        ...(pack.pursueRepos ?? []).map((repo) => ({ ...repo, lane: "pursue" })),
        ...(pack.cleanupFirst ?? []).map((repo) => ({ ...repo, lane: "cleanup-first" })),
        ...(pack.maintainerLaneRepos ?? []).map((repo) => ({ ...repo, lane: "maintainer-lane" })),
        ...(pack.avoidRepos ?? []).map((repo) => ({ ...repo, lane: "avoid" })),
      ],
      dataQuality: pack.dataQuality,
      mcp: { snapshot: scoring?.id ?? null, drift: upstreamDrift.status, lastRun: runs[0]?.updatedAt ?? null },
    });
  });

  app.get("/v1/app/maintainer-dashboard", async (c) => {
    const identity = await authenticateRequestIdentity(c);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const summary = await getRoleSummaryForIdentity(c.env, identity);
    if (!summary.roles.some((role) => ["maintainer", "owner", "operator"].includes(role))) return c.json({ error: "insufficient_role" }, 403);

    const [allRepositories, allInstallations, allHealth, allRateLimits, allSyncStates] = await Promise.all([
      listRepositories(c.env),
      listInstallations(c.env),
      listInstallationHealth(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
      listRepoSyncStates(c.env),
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
    // Cached open-PR count is summed across ALL in-scope repos from sync state (a single query) so the
    // headline metric is a true global count like its siblings. The per-repo PR fetch below is capped at
    // 12 only to bound the `reviewability` preview list, not the metric.
    const scopedRepoNameSet = new Set(repositories.map((repo) => repo.fullName.toLowerCase()));
    const scopedSyncStates = allSyncStates.filter((state) => scopedRepoNameSet.has(state.repoFullName.toLowerCase()));
    const totalOpenPullRequestsCached = scopedSyncStates.reduce((sum, state) => sum + Math.max(0, state.openPullRequestsCount), 0);
    const reposWithOpenPullRequests = scopedSyncStates.filter((state) => state.openPullRequestsCount > 0).length;
    const openPullRequests = (
      await Promise.all(repositories.slice(0, 12).map((repo) => listOpenPullRequests(c.env, repo.fullName).then((rows) => rows.map((pull) => ({ repoFullName: repo.fullName, pull })))))
    ).flat();
    return c.json({
      generatedAt: nowIso(),
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
      })),
      settingsPreview: buildMaintainerSettingsPreview(),
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
      repoFullNames,
      reason: parsed.data.reason,
      sinceIso,
    });
    return c.json({
      generatedAt: nowIso(),
      limit: page.limit,
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
    return c.json(await buildOperatorDashboardPayload(c.env));
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
    const command = APP_COMMANDS.find((candidate) => candidate.command === parsed.data.command || candidate.id === parsed.data.command.replace(/^@gittensory\s+/, ""));
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
    const preview = buildCommandPreview(command, parsed.data, { repo, installation, pullRequest });
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
      actor: contributor ?? "unknown",
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
    const [repo, snapshot, evidence] = await Promise.all([
      getRepository(c.env, parsed.data.repoFullName),
      getOrCreateScoringModelSnapshot(c.env),
      parsed.data.contributorLogin ? getContributorEvidence(c.env, parsed.data.contributorLogin) : Promise.resolve(null),
    ]);
    const result = buildScorePreview({ input: parsed.data, repo, snapshot, contributorEvidence: evidence });
    const record = makeScorePreviewRecord(parsed.data, snapshot, result);
    await persistScorePreview(c.env, record);
    return c.json(record);
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
    const ready = Boolean(snapshot) && Boolean(c.env.INTERNAL_JOB_TOKEN) && Boolean(c.env.GITTENSORY_API_TOKEN);
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
        apiToken: Boolean(c.env.GITTENSORY_API_TOKEN),
        mcpToken: Boolean(c.env.GITTENSORY_MCP_TOKEN),
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
    return c.json(await buildRepoIntelligenceResponse(c.env, fullName));
  });

  app.get("/v1/repos/:owner/:repo/issue-quality", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const response = await buildIssueQualityResponse(c.env, fullName);
    if (!response) return c.json({ error: "issue_quality_not_found", repoFullName: fullName }, 404);
    return c.json(response);
  });

  app.get("/v1/repos/:owner/:repo/registration-readiness", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await buildRegistrationReadinessResponse(c.env, fullName));
  });

  app.get("/v1/repos/:owner/:repo/gittensor-config-recommendation", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await buildGittensorConfigRecommendationResponse(c.env, fullName));
  });

  app.get("/v1/repos/:owner/:repo/onboarding-pack/preview", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const response = await buildRepoOnboardingPackPreviewForRepo(c.env, fullName, {
      refreshManifest: c.req.query("refresh") === "true",
    });
    if ("error" in response) {
      return c.json(response, 404);
    }
    return c.json(response);
  });

  app.get("/v1/repos/:owner/:repo/settings", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await getRepositorySettings(c.env, fullName));
  });

  app.post("/v1/repos/:owner/:repo/settings-preview", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const body = (await c.req.json().catch(() => null)) ?? {};
    const parsed = settingsPreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_settings_preview_request", issues: parsed.error.issues }, 400);
    const [repo, settings, issues, pullRequests] = await Promise.all([
      getRepository(c.env, fullName),
      getRepositorySettings(c.env, fullName),
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
      }),
    );
  });

  app.get("/v1/repos/:owner/:repo/pulls/:number/maintainer-packet", async (c) => {
    const unauthorized = await requireStaticProtectedApiToken(c);
    if (unauthorized) return unauthorized;
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const number = Number(c.req.param("number"));
    if (!Number.isFinite(number)) return c.json({ error: "invalid_pull_number" }, 400);
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
    const number = Number(c.req.param("number"));
    if (!Number.isFinite(number)) return c.json({ error: "invalid_pull_number" }, 400);
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
      fetchPublicContributorProfile(login),
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
    const body = await c.req.json().catch(() => null);
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
      loadRepoFocusManifest(c.env, parsed.data.repoFullName),
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
    const response = { ...analysis, dataQuality: await loadRepoDataQuality(c.env, parsed.data.repoFullName) };
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

  app.post("/v1/internal/jobs/refresh-registry", async (c) => {
    const message: JobMessage = { type: "refresh-registry", requestedBy: "api" };
    await c.env.JOBS.send(message);
    return c.json({ ok: true, status: "queued" }, 202);
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
    const message: JobMessage = {
      type: "backfill-repo-segment",
      requestedBy: "api",
      repoFullName: body.repoFullName,
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
    const message: JobMessage = {
      type: "backfill-pr-details",
      requestedBy: "api",
      repoFullName: body.repoFullName,
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

  app.post("/v1/internal/jobs/file-upstream-drift-issues/run", async (c) => c.json(await fileUpstreamDriftIssues(c.env)));

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
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.pullRequests)) {
      return c.json({ error: "invalid_request", detail: "pullRequests array required" }, 400);
    }
    const prSchema = z.object({
      number: z.number().int().positive(),
      author: z.string(),
      authorRole: z.enum(["first-time", "contributor", "maintainer"] as [AuthorRole, ...AuthorRole[]]),
      isConfirmedMiner: z.boolean(),
      linkedIssue: z.object({ qualityScore: z.number().min(0).max(1) }).nullable(),
      checksStatus: z.enum(["passing", "failing", "pending"] as [ChecksStatus, ...ChecksStatus[]]),
      isStale: z.boolean(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      title: z.string(),
      body: z.string(),
      duplicateCandidates: z.array(z.number().int().positive()),
      createdAt: z.string().datetime(),
      lastUpdatedAt: z.string().datetime(),
    });
    const repoContextSchema = z.object({
      totalOpenPRs: z.number().int().nonnegative(),
      avgReviewTimeDays: z.number().nonnegative(),
      maintainerWorkload: z.number().min(0).max(1),
    });
    const prsResult = z.array(prSchema).safeParse(body.pullRequests);
    if (!prsResult.success) return c.json({ error: "invalid_request", issues: prsResult.error.issues }, 400);
    const repoContext = repoContextSchema.safeParse(body.repoContext).success
      ? repoContextSchema.parse(body.repoContext)
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
        commentMode: parsed.data.commentMode,
        publicSignalLevel: parsed.data.publicSignalLevel,
        checkRunMode: parsed.data.checkRunMode,
        checkRunDetailLevel: parsed.data.checkRunDetailLevel,
        autoLabelEnabled: parsed.data.autoLabelEnabled,
        gittensorLabel: parsed.data.gittensorLabel,
        createMissingLabel: parsed.data.createMissingLabel,
        publicSurface: parsed.data.publicSurface,
        includeMaintainerAuthors: parsed.data.includeMaintainerAuthors,
        requireLinkedIssue: parsed.data.requireLinkedIssue,
        backfillEnabled: parsed.data.backfillEnabled,
        privateTrustEnabled: parsed.data.privateTrustEnabled,
        commandAuthorization: normalizeCommandAuthorizationPolicy(parsed.data.commandAuthorization).policy,
      }),
    );
  });

  app.get("/v1/internal/repos/:owner/:repo/contribution-policy", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const focusManifest = await loadRepoFocusManifest(c.env, fullName, { fetcher: async () => null });
    return c.json({
      repoFullName: fullName,
      generatedAt: nowIso(),
      focusManifest,
      policy: compileFocusManifestPolicy(focusManifest),
    });
  });

  app.post("/v1/internal/repos/:owner/:repo/contribution-policy", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: "invalid_contribution_policy_json" }, 400);
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const focusManifest = await upsertRepoFocusManifest(c.env, fullName, body, "api_record");
    return c.json({
      repoFullName: fullName,
      generatedAt: nowIso(),
      focusManifest,
      policy: compileFocusManifestPolicy(focusManifest),
    });
  });

  return app;
}

const APP_COMMANDS = [
  {
    id: "plan-next-work",
    command: "@gittensory plan",
    audience: "private",
    boundary: "private-api",
    description: "Rank the next contributor-safe work from the current decision pack.",
    endpoint: "/v1/agent/plan-next-work",
  },
  {
    id: "blockers",
    command: "@gittensory blockers",
    audience: "private",
    boundary: "private-api",
    description: "Explain scoreability blockers without leaking private scoring context.",
    endpoint: "/v1/agent/explain-blockers",
  },
  {
    id: "preflight",
    command: "@gittensory preflight",
    audience: "private",
    boundary: "private-api",
    description: "Run branch preflight against cached repo, PR, issue, and scorer context.",
    endpoint: "/v1/agent/preflight-branch",
  },
  {
    id: "packet",
    command: "@gittensory packet",
    audience: "maintainer",
    boundary: "private-api",
    description: "Prepare a maintainer review packet from private and public evidence.",
    endpoint: "/v1/agent/prepare-pr-packet",
  },
  {
    id: "public-summary",
    command: "@gittensory public-summary",
    audience: "public-safe",
    boundary: "public",
    description: "Preview the public-safe summary that may be posted to a PR thread.",
    endpoint: "/v1/app/commands/preview",
  },
  ...GITTENSORY_MENTION_COMMAND_CATALOG.filter(
    (command) => !["preflight", "blockers", "packet", "queue-summary", "review-now", "needs-author", "confirmed-miners", "duplicate-clusters"].includes(command.id),
  ).map((command) => ({
    id: command.id,
    command: `@gittensory ${command.id}`,
    audience: "public-safe",
    boundary: "public",
    description: command.description,
    endpoint: "GitHub issue comment",
  })),
  {
    id: "queue-summary",
    command: "@gittensory queue-summary",
    audience: "maintainer",
    boundary: "public-safe",
    description: "Post a maintainer-only queue digest from cached GitHub metadata.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "review-now",
    command: "@gittensory review-now",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List cached PRs that look ready for maintainer review.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "needs-author",
    command: "@gittensory needs-author",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List cached PRs that need author cleanup before detailed review.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "confirmed-miners",
    command: "@gittensory confirmed-miners",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List open PRs whose authors are confirmed in the official-miner cache.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
  {
    id: "duplicate-clusters",
    command: "@gittensory duplicate-clusters",
    audience: "maintainer",
    boundary: "public-safe",
    description: "List duplicate or WIP clusters visible from cached GitHub metadata.",
    endpoint: "/v1/app/maintainer-dashboard",
  },
] as const;

function authRedirectWithError(env: Env, reason: string): string {
  const siteOrigin = env.PUBLIC_SITE_ORIGIN ?? "https://gittensory.aethereal.dev";
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

const PREVIEWABLE_MENTION_COMMANDS = new Set<GittensoryMentionCommandName>(GITTENSORY_MENTION_COMMAND_CATALOG.map((command) => command.id));

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
  context: { repo: RepositoryRecord | null; installation: InstallationHealthRecord | null; pullRequest: PullRequestRecord | null },
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
    const body = sanitizePublicComment(`Gittensory would not post a public command response for ${target}: ${summary}`);
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
    const body = sanitizePublicComment(`Gittensory would not post a public command response for ${target}: ${commandPreviewSkipSummary(authorization.reason)}.`);
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
    const body = sanitizePublicComment(`Gittensory preview is ready for ${target}, but ${summary}`);
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
      ? `Gittensory can summarize public-safe context for ${target}. Private scorer details stay out of the PR thread.`
      : buildPublicAgentCommandComment({
          command: { name: mentionCommandName, raw: `@gittensory ${mentionCommandName}` },
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
        });

  return {
    ...base,
    body,
    sanitizer: commandPreviewSanitizer(body),
    decision: commandPreviewDecision({
      status: "ready",
      willComment: true,
      skipReason: null,
      summary: "Gittensory would post this sanitized command response and would not create labels or check runs.",
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

function previewableMentionCommandName(commandId: string): GittensoryMentionCommandName | null {
  if (PREVIEWABLE_MENTION_COMMANDS.has(commandId as GittensoryMentionCommandName)) return commandId as GittensoryMentionCommandName;
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
    sample.commenterAssociation ?? (isMaintainerOnlyCommand(previewableMentionCommandName(request.command.replace(/^@gittensory\s+/, "")) ?? "help") ? "OWNER" : "NONE");
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
    miner_detection_unavailable: "official Gittensor miner detection is unavailable, so Gittensory would skip rather than guess.",
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
  const registered = args.repositories.filter((repo) => repo.isRegistered).length;
  items.push({
    kind: "summary",
    title: `${registered} registered repositories tracked`,
    detail: `${args.repositories.length} repositories are present in the local Gittensory data cache.`,
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

async function buildRegistrationReadinessResponse(env: Env, fullName: string) {
  /* v8 ignore start -- Registration readiness route-level shaping over covered signal helpers. */
  const [intelligence, settings, upstreamReports, focusManifest] = await Promise.all([
    buildRepoIntelligenceResponse(env, fullName),
    getRepositorySettings(env, fullName),
    listUpstreamDriftReports(env, 20),
    loadRepoFocusManifest(env, fullName, { fetcher: async () => null }),
  ]);
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

async function buildGittensorConfigRecommendationResponse(env: Env, fullName: string) {
  /* v8 ignore start -- Config recommendation route-level shaping over covered signal helpers. */
  const intelligence = await buildRepoIntelligenceResponse(env, fullName);
  const settings = await getRepositorySettings(env, fullName);
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
    fetchPublicContributorProfile(login),
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

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>>,
  cachedRepoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const officialRepoStats = contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
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

type ProtectedRouteContext = {
  env: Env;
  req: { header: (name: string) => string | undefined | null };
  json: (object: { error: string }, status?: number) => Response;
};

function isExtensionScopedSession(identity: AuthIdentity): boolean {
  return identity.kind === "session" && identity.session.scopes.includes(EXTENSION_PULL_CONTEXT_SCOPE);
}

function canSessionAccessPath(env: Env, identity: Extract<AuthIdentity, { kind: "session" }>, path: string): boolean {
  if (isAuthorizedGitHubSessionLogin(env, identity.actor)) return true;
  if (path.startsWith("/v1/app/")) return true;
  if (path === EXTENSION_PULL_CONTEXT_PATH && isExtensionScopedSession(identity)) return true;
  return false;
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
  if (identity.kind !== "session") return null;
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

async function requireExtensionPullContextRepoAccess(
  c: ProtectedRouteContext,
  identity: Extract<AuthIdentity, { kind: "session" }>,
  repoFullName: string,
  repo: RepositoryRecord | null,
): Promise<Response | null> {
  return requireSessionRepoAccess(c, identity, repoFullName, repo);
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

function skippedPrAuditRemediation(reason: string): string {
  switch (reason) {
    case "surface_off":
      return "Enable a PR public surface or check runs in repository settings if maintainers want Gittensory to post.";
    case "missing_author":
      return "Retry after GitHub provides a resolvable pull request author.";
    case "bot_author":
      return "No action needed; bot-authored pull requests are intentionally kept quiet.";
    case "maintainer_author":
      return "Enable maintainer-authored PRs in repository settings only if those PRs should receive public GitHub App output.";
    case "miner_detection_unavailable":
      return "Retry after official Gittensor miner detection recovers; Gittensory skips instead of guessing.";
    case "not_official_gittensor_miner":
      return "No public action is needed unless the author should be recognized as an official Gittensor miner.";
    default:
      return "Review repository settings and installation health before reprocessing the pull request.";
  }
}

function toIsoQueryDate(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function requiresApiToken(path: string): boolean {
  if (path === "/health") return false;
  if (path === "/v1/mcp/compatibility") return false;
  if (path === "/openapi.json") return false;
  if (path === "/mcp") return false;
  if (path.startsWith("/v1/auth/")) return false;
  if (path === "/v1/github/webhook") return false;
  if (path.startsWith("/v1/internal/")) return false;
  return path.startsWith("/v1/");
}

const DEFAULT_CORS_ORIGINS = [
  "https://gittensory.aethereal.dev",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
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
};
