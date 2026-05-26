import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createSessionFromGitHubToken, pollGitHubDeviceFlow, startGitHubDeviceFlow } from "../auth/github-oauth";
import { enforceRateLimit, routeClassForPath } from "../auth/rate-limit";
import { authenticateInternalToken, authenticatePrivateToken, authenticateSessionToken, extractBearerToken, revokeSession } from "../auth/security";
import { normalizeGittBountySnapshot } from "../bounties/ingest";
import {
  countOpenIssues,
  countOpenPullRequests,
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
  listAllPullRequestDetailSyncStates,
  listCheckSummaries,
  listBounties,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listLatestGitHubRateLimitObservations,
  listLatestRepoGithubTotalsSnapshots,
  listInstallationHealth,
  listInstallations,
  listIssues,
  listIssueSignalSample,
  listOpenPullRequests,
  listPullRequestFiles,
  listPullRequestReviews,
  listRecentMergedPullRequests,
  listRepoLabels,
  listRepoSyncSegments,
  listRepoSyncStates,
  listSignalSnapshots,
  listPullRequests,
  listRepositories,
  persistScorePreview,
  persistSignalSnapshot,
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
import { handleGitHubWebhook } from "../github/webhook";
import { handleMcpRequest } from "../mcp/server";
import { buildOpenApiSpec } from "../openapi/spec";
import { generateSignalSnapshots } from "../queue/processors";
import { getLatestRegistrySnapshot, listLatestRegistrySnapshots, refreshRegistry } from "../registry/sync";
import { getOrCreateScoringModelSnapshot, refreshScoringModelSnapshot } from "../scoring/model";
import { buildScorePreview, makeScorePreviewRecord } from "../scoring/preview";
import {
  buildAndPersistContributorDecisionPack,
  loadContributorDecisionPack,
  loadFreshContributorDecisionPack,
  repoDecisionFromPack,
} from "../services/decision-pack";
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
import { attachDataQuality, buildCoreSignalFidelity, buildRepoDataQuality, buildSignalFidelity } from "../signals/data-quality";
import { buildPullRequestReviewability } from "../signals/reward-risk";
import { buildLocalBranchAnalysis } from "../signals/local-branch";
import type { ContributorEvidenceRecord, JobMessage, JsonValue, RepoSyncSegmentRecord } from "../types";
import { nowIso } from "../utils/json";

type AppBindings = { Bindings: Env };

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
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
    binary: z.boolean().optional(),
  })
  .strict();

const localBranchValidationSchema = z
  .object({
    command: z.string().min(1),
    status: z.enum(["passed", "failed", "not_run"]),
    summary: z.string().optional(),
  })
  .strict();

const localBranchScorerSchema = z
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
  .strict();

const localBranchAnalysisSchema = z
  .object({
    login: z.string().min(1),
    repoFullName: z.string().min(3),
    baseRef: z.string().min(1).optional(),
    headRef: z.string().min(1).optional(),
    branchName: z.string().min(1).optional(),
    commitMessages: z.array(z.string()).max(30).optional(),
    changedFiles: z.array(localBranchChangedFileSchema).max(500).optional(),
    validation: z.array(localBranchValidationSchema).max(50).optional(),
    linkedIssues: z.array(z.number().int().positive()).optional(),
    labels: z.array(z.string()).optional(),
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    localScorer: localBranchScorerSchema.optional(),
  })
  .strict();

const scorePreviewSchema = z.object({
  repoFullName: z.string().min(3),
  targetType: z.enum(["planned_pr", "pull_request", "local_diff", "variant"]).default("planned_pr"),
  targetKey: z.string().optional(),
  contributorLogin: z.string().min(1).optional(),
  labels: z.array(z.string()).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
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
});

const repositorySettingsSchema = z.object({
  commentMode: z.enum(["off", "detected_contributors_only", "all_prs"]),
  publicSignalLevel: z.enum(["minimal", "standard"]).default("standard"),
  checkRunDetailLevel: z.enum(["minimal", "standard", "deep"]).default("standard"),
  backfillEnabled: z.boolean().default(true),
  privateTrustEnabled: z.boolean().default(true),
});

export function createApp() {
  const app = new Hono<AppBindings>();
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        if (!origin) return null;
        const allowed = allowedCorsOrigins(c.env);
        return allowed.has(origin) ? origin : null;
      },
      allowHeaders: ["authorization", "content-type", "mcp-session-id", "mcp-protocol-version"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      exposeHeaders: ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"],
      maxAge: 600,
    }),
  );
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/health" || c.req.path === "/v1/github/webhook") return next();
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
    if (c.req.method === "OPTIONS") return next();
    if (!requiresApiToken(c.req.path)) return next();
    const identity = await authenticatePrivateToken(c.env, extractBearerToken(c.req.header("authorization")));
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/health", (c) => c.json({ status: "ok", service: "gittensory-api", time: nowIso() }));
  app.get("/openapi.json", (c) => c.json(buildOpenApiSpec()));
  app.all("/mcp", handleMcpRequest);

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
      return c.json({ error: error instanceof Error ? error.message : "github_device_flow_start_failed" }, error instanceof Error && error.message === "github_oauth_not_configured" ? 503 : 502);
    }
  });

  app.post("/v1/auth/github/device/poll", async (c) => {
    const body = await c.req.json().catch(() => null);
    const deviceCode = typeof body?.deviceCode === "string" ? body.deviceCode : "";
    if (!deviceCode) return c.json({ error: "device_code_required" }, 400);
    try {
      return c.json(await pollGitHubDeviceFlow(c.env, deviceCode));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "github_device_flow_poll_failed" }, error instanceof Error && error.message === "github_oauth_not_configured" ? 503 : 502);
    }
  });

  app.post("/v1/auth/github/session", async (c) => {
    const body = await c.req.json().catch(() => null);
    const githubToken = typeof body?.githubToken === "string" ? body.githubToken : "";
    if (!githubToken) return c.json({ error: "github_token_required" }, 400);
    try {
      return c.json(await createSessionFromGitHubToken(c.env, githubToken, { source: "github_token_exchange" }), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "github_session_create_failed" }, 401);
    }
  });

  app.get("/v1/auth/session", async (c) => {
    const identity = await authenticateSessionToken(c.env, extractBearerToken(c.req.header("authorization")));
    if (!identity || identity.kind !== "session") return c.json({ error: "unauthorized" }, 401);
    return c.json({
      status: "authenticated",
      login: identity.session.login,
      expiresAt: identity.session.expiresAt,
      scopes: identity.session.scopes,
      createdAt: identity.session.createdAt,
      lastSeenAt: identity.session.lastSeenAt,
    });
  });

  app.post("/v1/auth/logout", async (c) => {
    const identity = await authenticateSessionToken(c.env, extractBearerToken(c.req.header("authorization")));
    const revoked = await revokeSession(c.env, identity);
    return c.json({ ok: true, revoked });
  });

  app.get("/v1/registry/snapshot", async (c) => {
    const snapshot = await getLatestRegistrySnapshot(c.env);
    if (!snapshot) return c.json({ error: "registry_snapshot_not_found" }, 404);
    return c.json(snapshot);
  });

  app.get("/v1/registry/changes", async (c) => c.json(buildRegistryChangeReport(await listLatestRegistrySnapshots(c.env, 2))));

  app.get("/v1/scoring/model", async (c) => c.json(await getOrCreateScoringModelSnapshot(c.env)));

  app.post("/v1/scoring/preview", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = scorePreviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_scoring_preview_request", issues: parsed.error.issues }, 400);
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
    const [snapshot, repositories, segments, totals, detailStates, installations, rateLimits] = await Promise.all([
      getLatestRegistrySnapshot(c.env),
      listRepoSyncStates(c.env),
      listRepoSyncSegments(c.env),
      listLatestRepoGithubTotalsSnapshots(c.env),
      listAllPullRequestDetailSyncStates(c.env),
      listInstallationHealth(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
    ]);
    const repoCount = snapshot?.repoCount ?? repositories.length;
    const coreSignalFidelity = buildCoreSignalFidelity(repoCount, repositories, segments, totals, detailStates);
    return c.json({
      generatedAt: nowIso(),
      signalFidelity: buildSignalFidelity(repoCount, repositories, segments),
      coreSignalFidelity,
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
    const [snapshot, scoringSnapshot, syncStates, syncSegments, totals, detailStates, installations, installationHealth, rateLimits] = await Promise.all([
      getLatestRegistrySnapshot(c.env),
      getLatestScoringModelSnapshot(c.env),
      listRepoSyncStates(c.env),
      listRepoSyncSegments(c.env),
      listLatestRepoGithubTotalsSnapshots(c.env),
      listAllPullRequestDetailSyncStates(c.env),
      listInstallations(c.env),
      listInstallationHealth(c.env),
      listLatestGitHubRateLimitObservations(c.env, 20),
    ]);
    const repoCount = snapshot?.repoCount ?? syncStates.length;
    const signalFidelity = buildSignalFidelity(repoCount, syncStates, syncSegments);
    const coreSignalFidelity = buildCoreSignalFidelity(repoCount, syncStates, syncSegments, totals, detailStates);
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
      ...(installationHealth.some((health) => health.status !== "healthy") ? ["One or more GitHub App installations need attention."] : []),
    ];
    const ready = Boolean(snapshot) && Boolean(c.env.INTERNAL_JOB_TOKEN) && Boolean(c.env.GITTENSORY_API_TOKEN);
    const readyForPublicReview = snapshot
      ? snapshot.repoCount > 0 &&
        ready &&
        Boolean(scoringSnapshot) &&
        Boolean(c.env.GITHUB_PUBLIC_TOKEN) &&
        missingSyncCount === 0 &&
        failingSyncs.length === 0 &&
        coreSignalFidelity.status === "complete"
      : false;
    return c.json({
      status: ready ? "ready" : "needs_attention",
      generatedAt: nowIso(),
      ready,
      readyForPublicReview,
      signalFidelity,
      coreSignalFidelity,
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

  app.get("/v1/repos/:owner/:repo/settings", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    return c.json(await getRepositorySettings(c.env, fullName));
  });

  app.get("/v1/repos/:owner/:repo/pulls/:number/maintainer-packet", async (c) => {
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
    const pack = await loadFreshContributorDecisionPack(c.env, login);
    if (pack) return c.json(pack);
    const stalePack = await loadContributorDecisionPack(c.env, login);
    await c.env.JOBS.send({ type: "build-contributor-decision-packs", requestedBy: "api", login });
    return c.json(
      {
        status: "needs_snapshot_refresh",
        login,
        generatedAt: nowIso(),
        reason: stalePack ? "stale_snapshot" : "missing_snapshot",
        enqueued: true,
        ...(stalePack ? { staleSnapshot: { generatedAt: stalePack.generatedAt, ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(stalePack.generatedAt)) / 1000)) } } : {}),
        ...(stalePack?.dataQuality ? { dataQuality: stalePack.dataQuality } : {}),
      },
      202,
    );
  });

  app.get("/v1/contributors/:login/repos/:owner/:repo/decision", async (c) => {
    const login = c.req.param("login");
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const pack = await loadFreshContributorDecisionPack(c.env, login);
    if (!pack) {
      const stalePack = await loadContributorDecisionPack(c.env, login);
      await c.env.JOBS.send({ type: "build-contributor-decision-packs", requestedBy: "api", login });
      return c.json(
        {
          status: "needs_snapshot_refresh",
          login,
          repoFullName: fullName,
          generatedAt: nowIso(),
          reason: stalePack ? "stale_snapshot" : "missing_snapshot",
          enqueued: true,
        },
        202,
      );
    }
    const decision = repoDecisionFromPack(pack, fullName);
    if (!decision) return c.json({ error: "repo_decision_not_found", login, repoFullName: fullName }, 404);
    return c.json({ status: "ready", login, repoFullName: fullName, generatedAt: pack.generatedAt, source: pack.source, decision, dataQuality: pack.dataQuality });
  });

  app.post("/v1/preflight/pr", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = preflightSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_preflight_request", issues: parsed.error.issues }, 400);
    const repo = await getRepository(c.env, parsed.data.repoFullName);
    const issues = await listIssues(c.env, parsed.data.repoFullName);
    const pullRequests = await listPullRequests(c.env, parsed.data.repoFullName);
    return c.json(buildPreflightResult(parsed.data, repo, issues, pullRequests));
  });

  app.post("/v1/preflight/local-diff", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = localDiffPreflightSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_local_diff_preflight_request", issues: parsed.error.issues }, 400);
    const repo = await getRepository(c.env, parsed.data.repoFullName);
    const issues = await listIssues(c.env, parsed.data.repoFullName);
    const pullRequests = await listPullRequests(c.env, parsed.data.repoFullName);
    return c.json(buildLocalDiffPreflightResult(parsed.data, repo, issues, pullRequests));
  });

  app.post("/v1/local/branch-analysis", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = localBranchAnalysisSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_local_branch_analysis_request", issues: parsed.error.issues }, 400);
    const [context, repo, issues, pullRequests, recentMergedPullRequests, snapshot] = await Promise.all([
      loadContributorFastContext(c.env, parsed.data.login),
      getRepository(c.env, parsed.data.repoFullName),
      listIssues(c.env, parsed.data.repoFullName),
      listPullRequests(c.env, parsed.data.repoFullName),
      listRecentMergedPullRequests(c.env, parsed.data.repoFullName),
      getOrCreateScoringModelSnapshot(c.env),
    ]);
    const fit = buildContributorFit(context.profile, context.repositories, [], [], context.syncStates, context.repoStats);
    const scoringProfile = buildContributorScoringProfile({ login: parsed.data.login, fit, scoringSnapshot: snapshot });
    const analysis = buildLocalBranchAnalysis({
      input: parsed.data,
      repo,
      issues,
      pullRequests,
      recentMergedPullRequests,
      profile: context.profile,
      outcomeHistory: context.outcomeHistory,
      scoringSnapshot: snapshot,
      scoringProfile,
    });
    const response = { ...analysis, dataQuality: await loadRepoDataQuality(c.env, parsed.data.repoFullName) };
    await persistSignal(c.env, "local-branch-analysis", `${parsed.data.login}:${parsed.data.repoFullName}:${parsed.data.branchName ?? parsed.data.headRef ?? "local"}`, parsed.data.repoFullName, response as unknown as Record<string, JsonValue>, analysis.generatedAt);
    return c.json(response);
  });

  app.get("/v1/bounties", async (c) => c.json(await listBounties(c.env)));

  app.get("/v1/bounties/:id/advisory", async (c) => {
    const bounty = await getBounty(c.env, c.req.param("id"));
    if (!bounty) return c.json({ error: "bounty_not_found" }, 404);
    const [repo, issue] = await Promise.all([
      getRepository(c.env, bounty.repoFullName),
      getIssue(c.env, bounty.repoFullName, bounty.issueNumber),
    ]);
    return c.json(buildBountyAdvisory(bounty, repo, issue));
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

  app.post("/v1/internal/jobs/refresh-installation-health/run", async (c) => {
    return c.json(await refreshInstallationHealth(c.env));
  });

  app.post("/v1/internal/bounties/import", async (c) => {
    const body = await c.req.json().catch(() => null);
    const bounties = normalizeGittBountySnapshot(body);
    await Promise.all(bounties.map((bounty) => upsertBounty(c.env, bounty)));
    return c.json({ ok: true, imported: bounties.length });
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
        checkRunMode: "enabled",
        checkRunDetailLevel: parsed.data.checkRunDetailLevel,
        backfillEnabled: parsed.data.backfillEnabled,
        privateTrustEnabled: parsed.data.privateTrustEnabled,
      }),
    );
  });

  return app;
}

async function buildRepoIntelligenceResponse(env: Env, fullName: string) {
  const [repo, snapshots, dataQuality] = await Promise.all([
    getRepository(env, fullName),
    Promise.all(
      ["queue-health", "config-quality", "label-audit", "maintainer-lane", "maintainer-cut-readiness", "contributor-intake-health"].map(async (signalType) => [
        signalType,
        (await listSignalSnapshots(env, signalType, fullName))[0]?.payload ?? null,
      ]),
    ),
    loadRepoDataQuality(env, fullName),
  ]);
  const snapshotMap = Object.fromEntries(snapshots);
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
      dataQuality,
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
    dataQuality,
  };
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

function requiresApiToken(path: string): boolean {
  if (path === "/health") return false;
  if (path === "/mcp") return false;
  if (path.startsWith("/v1/auth/")) return false;
  if (path === "/v1/github/webhook") return false;
  if (path.startsWith("/v1/internal/")) return false;
  return path === "/openapi.json" || path.startsWith("/v1/");
}

function allowedCorsOrigins(env: Env): Set<string> {
  const values = [env.PUBLIC_API_ORIGIN, "http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"];
  return new Set(values.filter((value): value is string => Boolean(value)));
}
