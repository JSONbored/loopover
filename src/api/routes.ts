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
import {
  countOpenIssues,
  countOpenPullRequests,
  countActiveAuthSessions,
  countActiveDigestSubscriptions,
  getBounty,
  getIssue,
  getInstallationHealth,
  getLatestRepoGithubTotalsSnapshot,
  getLatestScoringModelSnapshot,
  getPullRequest,
  getRepository,
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
  enrichInstallationHealth,
  refreshContributorActivity,
  refreshInstallationHealth,
} from "../github/backfill";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { fetchPublicContributorProfile } from "../github/public";
import { GITTENSORY_MENTION_COMMAND_CATALOG } from "../github/commands";
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
  loadControlPanelRoleSummary,
} from "../services/control-panel-roles";
import {
  buildMcpCompatibilityMetadata,
  LATEST_RECOMMENDED_MCP_VERSION,
  MINIMUM_SUPPORTED_MCP_VERSION,
} from "../services/mcp-compatibility";
import { buildWeeklyValueReport, generateWeeklyValueReport, loadWeeklyValueReport } from "../services/weekly-value-report";
import { loadOrComputeIssueQualityResponse } from "../services/issue-quality";
import { loadOrComputeBurdenForecastResponse } from "../services/burden-forecast";
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
  buildPreflightResult,
  buildQueueHealth,
  buildRegistryChangeReport,
} from "../signals/engine";
import { attachDataQuality, buildCoreSignalFidelity, buildFreshnessSloReport, buildRepoDataQuality, buildSignalFidelity } from "../signals/data-quality";
import { buildContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildPullRequestReviewability } from "../signals/reward-risk";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest } from "../signals/local-branch";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildRepoSettingsPreview } from "../signals/settings-preview";
import { buildGittensorConfigRecommendation, buildRegistrationReadiness, type InstallationHealthSummary } from "../signals/registration-readiness";
import { fileUpstreamDriftIssues, loadUpstreamStatus, refreshUpstreamDrift } from "../upstream/ruleset";
import type {
  BountyLifecycleEventRecord,
  ControlPanelRoleName,
  ContributorEvidenceRecord,
  DataQuality,
  InstallationHealthRecord,
  JobMessage,
  JsonValue,
  ProductUsageOutcome,
  ProductUsageSurface,
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
    warnings: z.array(z.string()).optional(),
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
    focusManifest: z.record(z.unknown()).optional(),
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
    })
    .optional(),
});

const commandPreviewSchema = z
  .object({
    command: z.string().min(1).max(80),
    repoFullName: z.string().min(3).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
    pullNumber: z.number().int().positive().optional(),
    login: z.string().min(1).max(MAX_LOCAL_BRANCH_REF_CHARS).optional(),
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
    const forbidden = await requireAppRole(c, ["maintainer", "owner", "operator"]);
    if (forbidden) return forbidden;
    const [repositories, installations, health, rateLimits] = await Promise.all([
      listRepositories(c.env),
      listInstallations(c.env),
      listInstallationHealth(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
    ]);
    const openPullRequests = (
      await Promise.all(repositories.slice(0, 12).map((repo) => listOpenPullRequests(c.env, repo.fullName).then((rows) => rows.map((pull) => ({ repoFullName: repo.fullName, pull })))))
    ).flat();
    return c.json({
      generatedAt: nowIso(),
      installations,
      health: health.map(enrichInstallationHealth),
      metrics: [
        { label: "Installations", value: installations.length, spark: sparklineFromCounts(installations.length, Math.max(installations.length, 1)) },
        { label: "Open PRs cached", value: openPullRequests.length, spark: sparklineFromCounts(openPullRequests.length, Math.max(repositories.length, 1)) },
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

  app.get("/v1/app/operator-dashboard", async (c) => {
    const forbidden = await requireAppRole(c, ["operator"]);
    if (forbidden) return forbidden;
    const usageSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [
      repositories,
      installations,
      health,
      registry,
      scoring,
      upstreamDrift,
      activeSessions,
      digestSubscriptions,
      rateLimits,
      usageSummary,
      usageRollups,
      usageRollupStatus,
      mcpCompatibilityAdoption,
    ] = await Promise.all([
      listRepositories(c.env),
      listInstallations(c.env),
      listInstallationHealth(c.env),
      getLatestRegistrySnapshot(c.env),
      getLatestScoringModelSnapshot(c.env),
      loadUpstreamStatus(c.env),
      countActiveAuthSessions(c.env),
      countActiveDigestSubscriptions(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
      summarizeProductUsageEvents(c.env, usageSince),
      listProductUsageDailyRollups(c.env, { limit: 14 }),
      getProductUsageRollupStatus(c.env),
      summarizeMcpCompatibilityAdoption(c.env, usageSince),
    ]);
    const weeklyValueReport = buildWeeklyValueReport({
      generatedAt: nowIso(),
      variant: "operator",
      days: 7,
      repositories,
      installations,
      health,
      registry,
      scoring,
      upstreamDrift,
      usageSummary,
      usageRollups,
      usageRollupStatus,
      activeSessions,
      digestSubscriptions,
    });
    const installedRepos = repositories.filter((repo) => repo.isInstalled).length;
    const registeredRepos = repositories.filter((repo) => repo.isRegistered).length;
    return c.json({
      generatedAt: nowIso(),
      metrics: [
        { label: "Active sessions", value: String(activeSessions), delta: "browser + CLI/MCP" },
        { label: "Installations", value: String(installations.length), delta: `${installedRepos} installed repos` },
        { label: "Registered repos", value: String(registeredRepos), delta: registry ? `${registry.repoCount} in latest registry` : "registry missing" },
        { label: "Digest subscriptions", value: String(digestSubscriptions), delta: "store-only" },
        { label: "Product events", value: String(usageSummary.totalEvents), delta: "last 7 days" },
        { label: "Active users", value: String(usageSummary.activeActors), delta: "hashed, last 7 days" },
        { label: "Activation rollups", value: usageRollupStatus.status, delta: usageRollupStatus.latestRollupDay ?? "not generated" },
        { label: "MCP stale clients", value: String(mcpCompatibilityAdoption.staleEvents + mcpCompatibilityAdoption.incompatibleEvents), delta: `${mcpCompatibilityAdoption.totalEvents} MCP event(s)` },
        { label: "Install issues", value: String(health.filter((record) => record.status !== "healthy").length), delta: "current health cache" },
        { label: "Rate-limit events", value: String(rateLimits.length), delta: "latest observations" },
      ],
      noiseReduction: [
        { label: "Healthy installations", value: health.filter((record) => record.status === "healthy").length, spark: sparklineFromCounts(health.filter((record) => record.status === "healthy").length, Math.max(health.length, 1)) },
        { label: "Registered coverage", value: registeredRepos, spark: sparklineFromCounts(registeredRepos, Math.max(repositories.length, 1)) },
        { label: "Installed coverage", value: installedRepos, spark: sparklineFromCounts(installedRepos, Math.max(repositories.length, 1)) },
      ],
      weeklyReport: weeklyValueReport.summary,
      weeklyValueReport,
      usageSummary,
      usageRollups,
      usageRollupStatus,
      mcpCompatibilityAdoption,
      registry,
      scoringModel: scoring,
      upstreamDrift,
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
    const allowedRoles: ControlPanelRoleName[] = variant === "operator" ? ["operator"] : ["miner", "maintainer", "owner", "operator"];
    const forbidden = await requireAppRole(c, allowedRoles);
    if (forbidden) return forbidden;
    const days = Math.max(1, Math.min(31, Number(c.req.query("days") ?? 7) || 7));
    return c.json(await loadWeeklyValueReport(c.env, { variant, days }));
  });

  app.get("/v1/app/commands", async (c) =>
    c.json({
      generatedAt: nowIso(),
      commands: APP_COMMANDS,
    }),
  );

  app.post("/v1/app/commands/preview", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = commandPreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_command_preview_request", issues: parsed.error.issues }, 400);
    const command = APP_COMMANDS.find((candidate) => candidate.command === parsed.data.command || candidate.id === parsed.data.command.replace(/^@gittensory\s+/, ""));
    if (!command) return c.json({ error: "command_not_found" }, 404);
    const identity = await authenticateRequestIdentity(c).catch(() => null);
    const preview = buildCommandPreview(command, parsed.data);
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
    const [repo, pullRequest, issues, pullRequests, files, reviews, checks, recentMergedPullRequests] = await Promise.all([
      getRepository(c.env, fullName),
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
      pullNumber,
      profile: contributorContext?.profile,
      outcomeHistory: contributorContext?.outcomeHistory,
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
    return c.json({
      generatedAt: nowIso(),
      repoFullName: fullName,
      pullNumber,
      reviewability,
      panels: [
        { label: "Reviewability", badge: reviewability.action, rows: [{ k: "action", v: reviewability.action }, { k: "score", v: String(reviewability.score) }] },
        { label: "Contributor", badge: contributor ?? "unknown", rows: [{ k: "author", v: contributor ?? "unknown" }, { k: "prs", v: String(contributorContext?.contributorPullRequests.length ?? 0) }] },
        { label: "Boundary", badge: "private", rows: [{ k: "surface", v: "browser extension" }, { k: "public", v: "no" }] },
      ],
    });
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

  app.get("/v1/contributors/:login/profile", async (c) => {
    const login = c.req.param("login");
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
      }),
    );
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
  ...GITTENSORY_MENTION_COMMAND_CATALOG.filter((command) => !["help", "preflight", "blockers", "packet"].includes(command.id)).map((command) => ({
    id: command.id,
    command: `@gittensory ${command.id}`,
    audience: "public-safe",
    boundary: "public",
    description: command.description,
    endpoint: "GitHub issue comment",
  })),
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

function buildCommandPreview(command: (typeof APP_COMMANDS)[number], request: z.infer<typeof commandPreviewSchema>) {
  const target = request.repoFullName ? `${request.repoFullName}${request.pullNumber ? `#${request.pullNumber}` : ""}` : "selected target";
  if (command.id === "public-summary") {
    return {
      boundary: "public",
      body: `Gittensory can summarize public-safe context for ${target}. Private scorer details stay out of the PR thread.`,
    };
  }
  return {
    boundary: command.boundary,
    endpoint: command.endpoint,
    body: `${command.command} will call ${command.endpoint} for ${target}${request.login ? ` as ${request.login}` : ""}.`,
  };
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
    items.push({
      kind: "drift",
      title: "Upstream ruleset drift check is not current",
      detail: `Current upstream status: ${args.upstreamDrift.status}.`,
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
  const [repo, snapshots, dataQuality, burdenForecast] = await Promise.all([
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
  if (snapshotMap["queue-health"] && snapshotMap["config-quality"] && snapshotMap["label-audit"]) {
    return {
      status: "ready",
      source: "snapshot",
      repoFullName: fullName,
      generatedAt: nowIso(),
      repo,
      lane: buildLaneAdvice(repo, fullName),
      queueHealth: snapshotMap["queue-health"],
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

async function buildRegistrationReadinessResponse(env: Env, fullName: string) {
  /* v8 ignore start -- Registration readiness route-level shaping over covered signal helpers. */
  const intelligence = await buildRepoIntelligenceResponse(env, fullName);
  const settings = await getRepositorySettings(env, fullName);
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
  });
  return { ...report, dataQuality: intelligence.dataQuality };
  /* v8 ignore stop */
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
