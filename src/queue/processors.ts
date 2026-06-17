import {
  countOpenIssues,
  countOpenPullRequests,
  getAgentCommandAnswer,
  getInstallation,
  getLatestRepoGithubTotalsSnapshot,
  getFreshOfficialMinerDetection,
  getPullRequest,
  getRepository,
  getDecryptedRepositoryAiKey,
  getRepositorySettings,
  listCheckSummaries,
  listAllIssues,
  listAllPullRequests,
  listBounties,
  listBountiesByRepo,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listIssues,
  listIssueSignalSample,
  listLatestSignalSnapshotsByTarget,
  listSignalSnapshots,
  listRepoGithubTotalsSnapshotHistory,
  listOtherOpenPullRequests,
  listOpenPullRequests,
  listPullRequests,
  listPullRequestFiles,
  listRecentMergedPullRequests,
  updatePullRequestSlopAssessment,
  listRepoLabels,
  listRepoPullRequestFiles,
  listRepoSyncStates,
  listRepoSyncSegments,
  listRepositories,
  markInstallationDeleted,
  markRepositoriesRemovedFromInstallation,
  persistAdvisory,
  recordAgentCommandFeedback,
  recordAuditEvent,
  recordGateBlockOutcome,
  markGateOutcomeOverridden,
  recordProductUsageEvent,
  persistSignalSnapshot,
  recordWebhookEvent,
  replaceCollisionEdges,
  upsertRepoQueueTrendSnapshot,
  upsertAgentCommandAnswer,
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
import { pruneExpiredRecords } from "../db/retention";
import {
  backfillOpenPullRequestDetails,
  backfillRegisteredRepositories,
  backfillRepositorySegment,
  enqueueRepositoryOpenDataBackfill,
  refreshContributorActivity,
  refreshInstallationHealth,
} from "../github/backfill";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot, fetchOfficialGittensorMiner, type GittensorContributorSnapshot, type OfficialGittensorMinerDetection } from "../gittensor/api";
import { createOrUpdateCheckRun, createOrUpdateErroredGateCheckRun, createOrUpdateGateCheckRun, createOrUpdateOverriddenGateCheckRun, createOrUpdatePendingGateCheckRun, createOrUpdateSkippedGateCheckRun, getInstallationId, getRepositoryCollaboratorPermission } from "../github/app";
import { AGENT_COMMAND_COMMENT_MARKER, createOrUpdateAgentCommandComment, createOrUpdatePrIntelligenceComment, PR_PANEL_COMMENT_MARKER } from "../github/comments";
import { gittensoryFooter, gittensorRepoEarnUrl } from "../github/footer";
import {
  buildMaintainerQueueDigest,
  buildPublicAgentCommandComment,
  type GittensoryMentionCommandName,
  isAuthorizedCommandActor,
  isMaintainerAssociation,
  isMaintainerQueueDigestCommand,
  parseAgentCommandFeedbackContext,
  parseGittensoryMentionCommand,
  sanitizePublicComment,
} from "../github/commands";
import { ensurePullRequestLabel } from "../github/labels";
import { fetchPublicContributorProfile } from "../github/public";
import { refreshRegistry } from "../registry/sync";
import { buildIssueAdvisory, buildPullRequestAdvisory, evaluateGateCheck, isTestPath } from "../rules/advisory";
import { detectNotificationEvents } from "../notifications/events";
import { deliverNotification, detectIssueWatchEvents, evaluateNotificationEvent } from "../notifications/service";
import { getOrCreateScoringModelSnapshot, refreshScoringModelSnapshot } from "../scoring/model";
import { buildAndPersistContributorDecisionPack, loadDecisionPackSharedInputs } from "../services/decision-pack";
import {
  buildContributorEvidenceGraph,
  CONTRIBUTOR_EVIDENCE_GRAPH_SIGNAL,
  evidenceGraphTouchedRepoFullNames,
} from "../services/contributor-evidence-graph";
import { executeAgentRun, explainBlockersWithAgent, planNextWork, preflightBranchWithAgent, preparePrPacketWithAgent } from "../services/agent-orchestrator";
import { isAuthorizedGitHubSessionLogin } from "../auth/security";
import { commandAuthorizationAllowedRoles, commandAuthorizationNeedsMinerDetection } from "../settings/command-authorization";
import { loadIssueQualityReportMap } from "../services/issue-quality";
import { generateWeeklyValueReport } from "../services/weekly-value-report";
import { REPO_OUTCOME_PATTERNS_SIGNAL, computeRepoOutcomePatterns } from "../services/repo-outcome-patterns";
import { buildQueueTrendReport, QUEUE_TREND_HISTORY_DAYS } from "../services/queue-trends";
import {
  buildUpstreamRulesetSnapshot,
  detectAndPersistUpstreamDrift,
  fileUpstreamDriftIssues,
  refreshUpstreamDrift,
  refreshUpstreamSourceSnapshots,
} from "../upstream/ruleset";
import {
  buildFreshnessSloReport,
  freshnessAuditMetadata,
} from "../signals/data-quality";
import {
  buildBurdenForecast,
  buildCollisionEdges,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildContributorStrategy,
  buildContributorIntakeHealth,
  buildIssueQualityReport,
  buildLabelAudit,
  buildMaintainerCutReadiness,
  buildMaintainerLaneReport,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildPublicReadinessScore,
  buildQueueHealth,
  buildRoleContext,
  detectGittensorContributor,
  PR_PANEL_RETRIGGER_MARKER,
  unionScopedOverlapClusters,
} from "../signals/engine";
import { buildIssueSlopAssessment, buildSlopAssessment, type SlopBand } from "../signals/slop";
import { runGittensoryAiSlopAdvisory } from "../services/ai-slop";
import { decidePublicSurface } from "../signals/settings-preview";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { buildFocusManifestGuidance, resolveEffectiveSettings } from "../signals/focus-manifest";
import type { LocalBranchAnalysisInput } from "../signals/local-branch";
import { runGittensoryAiReview } from "../services/ai-review";
import type { AdvisoryFinding, ContributorEvidenceRecord, DetectedNotificationEvent, GitHubWebhookPayload, JobMessage, JsonValue, PullRequestRecord, RepositorySettings } from "../types";
import { sha256Hex } from "../utils/crypto";
import { errorMessage, nowIso } from "../utils/json";

const OFFICIAL_MINER_DETECTION_TTL_MS = 5 * 60 * 1000;
const OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS = 60 * 1000;
const PR_PUBLIC_SURFACE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);
const PR_GATE_CLOSED_ACTIONS = new Set(["closed"]);

/**
 * Run (or dry-run) the data-retention prune across the configured log/snapshot tables and audit the
 * outcome. The per-table windows live in RETENTION_POLICY; only append-only/superseded tables are pruned.
 */
export async function runRetentionPrune(env: Env, requestedBy: string, dryRun: boolean): Promise<void> {
  const results = await pruneExpiredRecords(env, { dryRun });
  const totalDeleted = results.reduce((sum, result) => sum + result.deleted, 0);
  await recordAuditEvent(env, {
    eventType: "retention.prune",
    actor: requestedBy,
    outcome: dryRun ? "completed" : "success",
    detail: dryRun ? `dry-run: ${totalDeleted} row(s) eligible` : `pruned ${totalDeleted} row(s)`,
    metadata: { dryRun, totalDeleted, perTable: Object.fromEntries(results.map((r) => [r.table, r.deleted])) },
  });
}

export async function processJob(env: Env, message: JobMessage): Promise<void> {
  switch (message.type) {
    case "refresh-registry":
      await refreshRegistry(env);
      return;
    case "backfill-registered-repos":
      if (!message.repoFullName && message.requestedBy !== "test") {
        const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered);
        if (repositories.length > 0) {
          const delayStepSeconds = message.mode === "full" || message.mode === "resume" ? 45 : 15;
          await Promise.all(
            repositories.map((repo, index) => {
              const repoMessage: JobMessage = {
                type: "backfill-registered-repos",
                requestedBy: message.requestedBy,
                repoFullName: repo.fullName,
                ...(message.force === undefined ? {} : { force: message.force }),
                ...(message.mode === undefined ? {} : { mode: message.mode }),
              };
              const delaySeconds = Math.min(index * delayStepSeconds, 900);
              return delaySeconds > 0 ? env.JOBS.send(repoMessage, { delaySeconds }) : env.JOBS.send(repoMessage);
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
    case "refresh-upstream-sources":
      await refreshUpstreamSourceSnapshots(env);
      return;
    case "build-upstream-ruleset":
      await buildUpstreamRulesetSnapshot(env);
      return;
    case "detect-upstream-drift":
      await detectAndPersistUpstreamDrift(env);
      return;
    case "refresh-upstream-drift":
      await refreshUpstreamDrift(env);
      return;
    case "file-upstream-drift-issues":
      await fileUpstreamDriftIssues(env);
      return;
    case "build-contributor-evidence":
      await buildContributorEvidence(env, message.login);
      return;
    case "build-contributor-decision-packs":
      await buildContributorDecisionPacks(env, message.login);
      return;
    case "refresh-contributor-activity":
      await refreshContributorActivity(env, message.login, message.repoFullName ? { repoFullName: message.repoFullName } : {});
      return;
    case "build-burden-forecasts":
      await buildBurdenForecasts(env, message.repoFullName);
      return;
    case "repair-data-fidelity":
      await repairDataFidelity(env, message.requestedBy);
      return;
    case "rollup-product-usage":
      await rollupProductUsageDaily(env, { ...(message.day ? { day: message.day } : {}), ...(message.days === undefined ? {} : { days: message.days }) });
      return;
    case "prune-retention":
      await runRetentionPrune(env, message.requestedBy, message.dryRun ?? false);
      return;
    case "generate-weekly-value-report":
      await generateWeeklyValueReport(env, { variant: message.variant ?? "operator", ...(message.days === undefined ? {} : { days: message.days }) });
      return;
    case "run-agent":
      await executeAgentRun(env, message.runId);
      return;
    case "notify-evaluate": {
      const deliveries = await evaluateNotificationEvent(env, message.event);
      await Promise.all(deliveries.map((delivery) => env.JOBS.send({ type: "notify-deliver", requestedBy: "notify-evaluate", deliveryId: delivery.id })));
      return;
    }
    case "notify-deliver":
      await deliverNotification(env, message.deliveryId);
      return;
    case "github-webhook":
      await processGitHubWebhook(env, message.deliveryId, message.eventName, message.payload);
      return;
  }
}

async function buildContributorDecisionPacks(env: Env, login?: string): Promise<void> {
  const logins = login ? [login] : await discoverContributorLogins(env);
  // Load the login-independent full-table datasets once, then reuse across every login instead of re-scanning per contributor.
  const shared = await loadDecisionPackSharedInputs(env);
  for (const contributorLogin of logins) {
    try {
      await buildAndPersistContributorDecisionPack(env, contributorLogin, shared);
    } catch (error) {
      // Isolate per-login failures so one bad login can't fail the whole batch (which would re-run
      // from the first login on retry and poison-pill the queue) (#787).
      /* v8 ignore next -- defensive per-login isolation; the log-and-continue path is not exercised in tests */
      console.error(JSON.stringify({ level: "warn", event: "decision_pack_login_failed", login: contributorLogin, error: errorMessage(error) }));
    }
  }
}

async function fanOutRepoSignalSnapshotJobs(env: Env, requestedBy: "schedule" | "api" | "test"): Promise<void> {
  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered);
  await Promise.all(
    repositories.map((repo, index) => {
      const message: JobMessage = {
        type: "generate-signal-snapshots",
        requestedBy,
        repoFullName: repo.fullName,
      };
      const delaySeconds = Math.min(index * 10, 600);
      return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
    }),
  );
  await recordAuditEvent(env, {
    eventType: "signals.snapshot_fanout",
    outcome: "queued",
    metadata: { repoCount: repositories.length, requestedBy },
  });
}

async function repairDataFidelity(env: Env, requestedBy: "schedule" | "api" | "test"): Promise<void> {
  const [repositories, segments, signalSnapshots] = await Promise.all([listRepositories(env), listRepoSyncSegments(env), listLatestSignalSnapshotsByTarget(env)]);
  const requiredSegments = new Set(["labels", "open_issues", "open_pull_requests"]);
  const segmentsByRepo = new Map<string, Set<string>>();
  for (const segment of segments) {
    if (requiredSegments.has(segment.segment) && segment.status === "complete") {
      const complete = segmentsByRepo.get(segment.repoFullName) ?? new Set<string>();
      complete.add(segment.segment);
      segmentsByRepo.set(segment.repoFullName, complete);
    }
  }
  const registeredRepos = repositories.filter((repo) => repo.isRegistered);
  const freshnessSlo = buildFreshnessSloReport({ repoCount: registeredRepos.length, segments, signalSnapshots });
  const repairs = [];
  const signalRefreshes = [];
  for (const repo of registeredRepos) {
    const complete = segmentsByRepo.get(repo.fullName) ?? new Set<string>();
    const missing = [...requiredSegments].filter((segment) => !complete.has(segment));
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
      return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
    }),
    ...signalRefreshes.slice(0, 50).map((repoFullName, index) => {
      const message: JobMessage = {
        type: "generate-signal-snapshots",
        requestedBy,
        repoFullName,
      };
      const delaySeconds = repairs.length > 0 || index > 0 ? Math.min(60 + index * 10, 900) : 0;
      return delaySeconds > 0 ? env.JOBS.send(message, { delaySeconds }) : env.JOBS.send(message);
    }),
  ]);
  await recordAuditEvent(env, {
    eventType: "sync.fidelity_repair",
    outcome: repairs.length > 0 || freshnessSlo.repairRecommended ? "queued" : "completed",
    metadata: { requestedBy, repairCount: repairs.length, signalRefreshCount: signalRefreshes.length, repairs: repairs.slice(0, 25), freshnessSlo: freshnessAuditMetadata(freshnessSlo) },
  });
  await recordAuditEvent(env, {
    eventType: "signals.freshness_slo",
    outcome: freshnessSlo.repairRecommended ? "queued" : "completed",
    detail: freshnessSlo.status,
    metadata: { requestedBy, ...freshnessAuditMetadata(freshnessSlo) },
  });
}

async function discoverContributorLogins(env: Env): Promise<string[]> {
  const [pullRequests, issues] = await Promise.all([listAllPullRequests(env), listAllIssues(env)]);
  return [...new Set([...pullRequests, ...issues].flatMap((record) => (record.authorLogin ? [record.authorLogin] : [])))].slice(0, 200);
}

async function buildContributorEvidence(env: Env, login?: string): Promise<void> {
  const [allPullRequests, allIssues, repositories, syncStates, allBounties, snapshot] = await Promise.all([
    listAllPullRequests(env),
    listAllIssues(env),
    listRepositories(env),
    listRepoSyncStates(env),
    listBounties(env),
    getOrCreateScoringModelSnapshot(env),
  ]);
  const logins = login ? [login] : [...new Set([...allPullRequests, ...allIssues].flatMap((record) => (record.authorLogin ? [record.authorLogin] : [])))].slice(0, 500);
  const issueQualityByRepo = await loadIssueQualityReportMap(env, repositories);
  for (const contributorLogin of logins) {
    // Isolate each login so one failure (transient GitHub/D1 error) doesn't abort the whole
    // 500-login batch and poison-pill the queue on retry (#787).
    try {
    const [github, contributorPullRequests, contributorIssues, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(contributorLogin, env),
      listContributorPullRequests(env, contributorLogin),
      listContributorIssues(env, contributorLogin),
      listContributorRepoStats(env, contributorLogin),
      fetchGittensorContributorSnapshot(contributorLogin),
    ]);
    const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
    const profile = buildContributorProfile(contributorLogin, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
    const pullRequestFiles = (
      await Promise.all(
        evidenceGraphTouchedRepoFullNames({
          login: contributorLogin,
          profile,
          pullRequests: contributorPullRequests,
          issues: contributorIssues,
          repoStats,
          repositories,
        }).map((repoFullName) => listRepoPullRequestFiles(env, repoFullName)),
      )
    ).flat();
    const fit = buildContributorFit(profile, repositories, allIssues, allPullRequests, syncStates, repoStats, allBounties, issueQualityByRepo);
    const scoringProfile = buildContributorScoringProfile({ login: contributorLogin, fit, scoringSnapshot: snapshot });
    const outcomeHistory = buildContributorOutcomeHistory({ login: contributorLogin, profile, repositories, pullRequests: allPullRequests, issues: allIssues, repoStats, cachedRepoStats });
    const strategy = buildContributorStrategy({ login: contributorLogin, fit, scoringProfile, scoringSnapshot: snapshot, outcomeHistory });
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
      console.error(JSON.stringify({ level: "warn", event: "contributor_evidence_login_failed", login: contributorLogin, error: errorMessage(error) }));
    }
  }
}

async function buildBurdenForecasts(env: Env, repoFullName?: string): Promise<void> {
  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered && (!repoFullName || repo.fullName === repoFullName));
  for (const repo of repositories) {
    const [issues, pullRequests, recentMergedPullRequests, queueCounts] = await Promise.all([
      listIssueSignalSample(env, repo.fullName),
      listOpenPullRequests(env, repo.fullName),
      listRecentMergedPullRequests(env, repo.fullName),
      loadOpenQueueCounts(env, repo.fullName),
    ]);
    const forecast = buildBurdenForecast(repo, issues, pullRequests, buildCollisionReport(repo.fullName, issues, pullRequests, recentMergedPullRequests), 30, queueCounts);
    await upsertBurdenForecast(env, {
      repoFullName: repo.fullName,
      payload: forecast as unknown as Record<string, JsonValue>,
      generatedAt: forecast.generatedAt,
    });
  }
}

export async function generateSignalSnapshots(env: Env, repoFullName?: string): Promise<void> {
  const repositories = (await listRepositories(env)).filter((repo) => repo.isRegistered && (!repoFullName || repo.fullName === repoFullName));
  for (const repo of repositories) {
    const trendSince = new Date(Date.now() - QUEUE_TREND_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const [issues, pullRequests, recentMergedPullRequests, labels, queueCounts, bounties, totalsHistory, queueHealthHistory] = await Promise.all([
      listIssueSignalSample(env, repo.fullName),
      listOpenPullRequests(env, repo.fullName),
      listRecentMergedPullRequests(env, repo.fullName),
      listRepoLabels(env, repo.fullName),
      loadOpenQueueCounts(env, repo.fullName),
      listBountiesByRepo(env, repo.fullName),
      listRepoGithubTotalsSnapshotHistory(env, repo.fullName, { sinceIso: trendSince, limit: 120 }),
      listSignalSnapshots(env, "queue-health", repo.fullName),
    ]);
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests, recentMergedPullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts);
    const configQuality = buildConfigQuality(repo, issues, pullRequests, repo.fullName);
    const labelAudit = buildLabelAudit(repo, labels, issues, pullRequests, repo.fullName);
    const maintainerLane = buildMaintainerLaneReport(repo, issues, pullRequests, repo.fullName, collisions, queueCounts);
    const maintainerCutReadiness = buildMaintainerCutReadiness(repo, issues, pullRequests, repo.fullName, queueCounts, collisions);
    const contributorIntakeHealth = buildContributorIntakeHealth(repo, issues, pullRequests, repo.fullName, collisions, queueCounts);
    const issueQuality = buildIssueQualityReport(repo, issues, pullRequests, repo.fullName, bounties, collisions, recentMergedPullRequests);
    await replaceCollisionEdges(env, repo.fullName, buildCollisionEdges(collisions));
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
    const repoOutcomePatterns = await computeRepoOutcomePatterns(env, repo.fullName, repo);
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

async function loadOpenQueueCounts(env: Env, repoFullName: string): Promise<{ openIssues: number; openPullRequests: number }> {
  const [totals, openIssues, openPullRequests] = await Promise.all([getLatestRepoGithubTotalsSnapshot(env, repoFullName), countOpenIssues(env, repoFullName), countOpenPullRequests(env, repoFullName)]);
  return {
    openIssues: totals?.openIssuesTotal ?? openIssues,
    openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
  };
}

async function processGitHubWebhook(env: Env, deliveryId: string, eventName: string, payload: GitHubWebhookPayload): Promise<void> {
  try {
    if (eventName === "installation" && payload.action === "deleted" && payload.installation?.id) {
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

    await upsertInstallation(env, payload);
    const installationActor =
      payload.installation?.account?.login ??
      (payload.installation?.id ? (await getInstallation(env, payload.installation.id))?.accountLogin : undefined);
    if (eventName === "installation_repositories" && payload.installation?.id) {
      const addedRepos = payload.repositories_added?.map((repo) => repo.full_name).filter(Boolean) ?? [];
      const removedRepos = payload.repositories_removed?.map((repo) => repo.full_name).filter(Boolean) ?? [];
      for (const repo of payload.repositories_added ?? []) await upsertRepositoryFromGitHub(env, repo, payload.installation.id);
      await markRepositoriesRemovedFromInstallation(env, payload.installation.id, removedRepos);
      await Promise.all([
        ...addedRepos.slice(0, 50).map((repoFullName) =>
          recordGithubProductUsage(env, "github_installation_repository_added", {
            actor: installationActor,
            repoFullName,
            targetKey: payload.installation?.id ? `installation:${payload.installation.id}` : repoFullName,
            outcome: "completed",
            metadata: { action: payload.action, repoCount: addedRepos.length, truncatedRepos: Math.max(addedRepos.length - 50, 0) },
          }),
        ),
        ...removedRepos.slice(0, 50).map((repoFullName) =>
          recordGithubProductUsage(env, "github_installation_repository_removed", {
            actor: installationActor,
            repoFullName,
            targetKey: payload.installation?.id ? `installation:${payload.installation.id}` : repoFullName,
            outcome: "completed",
            metadata: { action: payload.action, repoCount: removedRepos.length, truncatedRepos: Math.max(removedRepos.length - 50, 0) },
          }),
        ),
      ]);
    }

    if (eventName === "installation" && payload.action === "created") {
      const installedRepos = payload.repositories?.map((repo) => repo.full_name).filter(Boolean) ?? (payload.repository?.full_name ? [payload.repository.full_name] : [undefined]);
      await Promise.all(
        installedRepos.slice(0, 50).map((repoFullName) =>
          recordGithubProductUsage(env, "github_installation_created", {
            actor: installationActor,
            repoFullName,
            targetKey: payload.installation?.id ? `installation:${payload.installation.id}` : repoFullName,
            outcome: "completed",
            metadata: { action: payload.action, repoCount: installedRepos.filter(Boolean).length, truncatedRepos: Math.max(installedRepos.length - 50, 0) },
          }),
        ),
      );
    }

    const installationId = getInstallationId(payload);
    if (payload.repositories) {
      for (const repo of payload.repositories) await upsertRepositoryFromGitHub(env, repo, installationId ?? undefined);
    }
    if (payload.repository) await upsertRepositoryFromGitHub(env, payload.repository, installationId ?? undefined);

    if (eventName === "reaction" && (await maybeProcessAgentCommandFeedbackReaction(env, deliveryId, payload))) {
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

    if (eventName === "issue_comment" && (await maybeProcessPrPanelRetrigger(env, deliveryId, payload))) {
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

    if (eventName === "issue_comment" && (await maybeProcessGateOverrideCommand(env, deliveryId, payload))) {
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

    if (eventName === "issue_comment" && (await maybeProcessGittensoryMentionCommand(env, deliveryId, payload))) {
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

    if (payload.repository?.full_name && payload.pull_request) {
      const repoFullName = payload.repository.full_name;
      const pr = await upsertPullRequestFromGitHub(env, repoFullName, payload.pull_request);
      const [repo, settings, otherOpenPullRequests] = await Promise.all([
        getRepository(env, repoFullName),
        resolveRepositorySettings(env, repoFullName),
        listOtherOpenPullRequests(env, repoFullName, pr.number),
      ]);
      const advisory = buildPullRequestAdvisory(repo, pr, {
        otherOpenPullRequests,
        requireLinkedIssue: settings.requireLinkedIssue || settings.linkedIssueGateMode !== "off",
      });
      await persistAdvisory(env, advisory);
      if (installationId && shouldProcessPullRequestPublicSurface(payload.action)) {
        await maybePublishPrPublicSurface(env, installationId, repoFullName, pr, repo, settings, advisory, {
          deliveryId,
          authorType: payload.pull_request.user?.type,
          action: payload.action,
        }).catch((error) => {
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
        });
      }
    }

    let issueWatchEvents: DetectedNotificationEvent[] = [];
    if (payload.repository?.full_name && payload.issue && !payload.issue.pull_request) {
      const issue = await upsertIssueFromGitHub(env, payload.repository.full_name, payload.issue);
      const repo = await getRepository(env, payload.repository.full_name);
      const advisory = buildIssueAdvisory(repo, issue);
      // Issue-side slop triage (#533): opt-in via slopGateMode, advisory-only (issues have no gate, and
      // the issue advisory is maintainer-facing — never a public comment). Flags clearly low-effort issues.
      const issueSettings = await resolveRepositorySettings(env, payload.repository.full_name);
      if (issueSettings.slopGateMode !== "off") {
        advisory.findings.push(...buildIssueSlopAssessment({ title: issue.title, body: issue.body }).findings);
      }
      await persistAdvisory(env, advisory);
      // #699 path B: a newly opened grabbable, high-multiplier issue notifies the miners watching this repo
      // (fanned out through the same #535 pipeline below).
      if (payload.action === "opened") issueWatchEvents = await detectIssueWatchEvents(env, payload.repository.full_name, issue);
    }

    for (const notificationEvent of [...detectNotificationEvents(eventName, payload), ...issueWatchEvents]) {
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
      await env.JOBS.send({ type: "notify-evaluate", requestedBy: "webhook", event: notificationEvent });
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

type PublicSurfaceOutput = "comment" | "label" | "check_run";
type PublicSurfaceOutputFailure = { output: PublicSurfaceOutput; error: string };

function shouldProcessPullRequestPublicSurface(action: string | undefined): boolean {
  return PR_PUBLIC_SURFACE_ACTIONS.has(action ?? "") || PR_GATE_CLOSED_ACTIONS.has(action ?? "");
}

export function gateCheckPolicy(
  settings: RepositorySettings,
  readinessScore?: number | null,
  confirmedContributor?: boolean,
  slopRisk?: number | null,
  authorHistory?: { mergedPrCount: number; closedUnmergedPrCount: number },
) {
  // `settings` is already the EFFECTIVE config (`.gittensory.yml` > DB > defaults), resolved upstream by
  // resolveRepositorySettings, so the blocker modes here reflect the repo's config file directly.
  // The `oss-anti-slop` pack (#692) is repo-agnostic: it blocks ANY author whose PR trips an opted-in
  // deterministic rule, so it drops the confirmed-contributor gate entirely (no Gittensor coupling). The
  // `gittensor` pack keeps the contributor gate — only confirmed contributors are hard-blocked.
  const confirmedContributorForPack = settings.gatePack === "oss-anti-slop" ? undefined : confirmedContributor;
  return {
    linkedIssueGateMode: settings.linkedIssueGateMode,
    duplicatePrGateMode: settings.duplicatePrGateMode,
    qualityGateMode: settings.qualityGateMode,
    qualityGateMinScore: settings.qualityGateMinScore ?? null,
    aiReviewGateMode: settings.aiReviewMode,
    readinessScore: readinessScore ?? null,
    slopGateMode: settings.slopGateMode,
    mergeReadinessGateMode: settings.mergeReadinessGateMode,
    manifestPolicyGateMode: settings.manifestPolicyGateMode,
    firstTimeContributorGrace: settings.firstTimeContributorGrace,
    authorMergedPrCount: authorHistory?.mergedPrCount,
    authorClosedUnmergedPrCount: authorHistory?.closedUnmergedPrCount,
    slopGateMinScore: settings.slopGateMinScore ?? null,
    slopRisk: slopRisk ?? null,
    confirmedContributor: confirmedContributorForPack,
  };
}

/**
 * Effective repository settings for webhook handling: the DB-backed settings overlaid with the repo's
 * `.gittensory.yml` (config-as-code). This single resolver is why EVERYTHING — gate on/off, all blocker
 * modes, comments, labels, surface, audience — is controllable from the repo's config file.
 */
async function resolveRepositorySettings(env: Env, repoFullName: string): Promise<RepositorySettings> {
  const [dbSettings, manifest] = await Promise.all([getRepositorySettings(env, repoFullName), loadRepoFocusManifest(env, repoFullName)]);
  return resolveEffectiveSettings(dbSettings, manifest);
}

/** Build a bounded unified-diff string from cached PR files for the AI reviewer. Caps total size so a
 *  huge PR cannot blow the model context or the neuron budget; each file's patch is taken from the raw
 *  GitHub file payload when present. */
export function buildAiReviewDiff(files: Awaited<ReturnType<typeof listPullRequestFiles>>): string {
  const MAX_DIFF_CHARS = 60000;
  const parts: string[] = [];
  let total = 0;
  for (const file of files) {
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    const header = `### ${file.path}${file.status ? ` (${file.status})` : ""} +${file.additions}/-${file.deletions}`;
    const block = patch ? `${header}\n${patch}` : header;
    if (total + block.length > MAX_DIFF_CHARS) {
      parts.push(`… diff truncated (${files.length} files total).`);
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n\n");
}

/**
 * Run the opt-in AI maintainer review and fold it into the gate + panel. Mutates `advisory.findings`
 * with a dual-model consensus defect (when `aiReviewMode: block` and the free Workers-AI pair agrees with
 * high confidence) so it can become a gate blocker BEFORE evaluateGateCheck runs — still confirmed-
 * contributor gated. Returns the advisory notes for the public panel. Fully fail-safe: disabled / not a
 * confirmed contributor / no head SHA / non-ok AI / any thrown error → no finding and no notes.
 */
export async function runAiReviewForAdvisory(
  env: Env,
  args: {
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pr: { number: number; title: string; body?: string | null | undefined };
    author: string | null;
    confirmedContributor: boolean;
  },
): Promise<{ notes: string } | undefined> {
  if (args.settings.aiReviewMode === "off" || !args.confirmedContributor || !args.advisory.headSha) return undefined;
  try {
    // BYOK: decrypt the maintainer's provider key only when opted in. Falls back to free Workers AI when
    // no key is configured or the encryption secret is unavailable (getDecryptedRepositoryAiKey → null).
    // Apply config-as-code provider/model: a declared provider must match the stored key's provider (else
    // skip BYOK → Workers-AI fallback); a declared model overrides the stored/default model.
    const storedKey = args.settings.aiReviewByok ? await getDecryptedRepositoryAiKey(env, args.repoFullName) : null;
    const providerKey =
      storedKey && (!args.settings.aiReviewProvider || args.settings.aiReviewProvider === storedKey.provider)
        ? { provider: storedKey.provider, key: storedKey.key, model: args.settings.aiReviewModel ?? storedKey.model }
        : null;
    const files = await listPullRequestFiles(env, args.repoFullName, args.pr.number);
    const result = await runGittensoryAiReview(env, {
      repoFullName: args.repoFullName,
      prNumber: args.pr.number,
      title: args.pr.title,
      body: args.pr.body ?? undefined,
      diff: buildAiReviewDiff(files),
      actor: args.author,
      mode: args.settings.aiReviewMode === "block" ? "block" : "advisory",
      providerKey,
    });
    if (result.status !== "ok") return undefined;
    if (result.consensusDefect) {
      const defect: AdvisoryFinding = {
        code: "ai_consensus_defect",
        severity: "critical",
        title: `AI reviewers agree on a likely critical defect: ${result.consensusDefect.title}`,
        detail: result.consensusDefect.detail,
        action: "Resolve the flagged defect, or override if the AI reviewers are mistaken, then re-run the gate.",
      };
      args.advisory.findings.push(defect);
    }
    return result.advisoryNotes ? { notes: result.advisoryNotes } : undefined;
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", event: "ai_review_failed", repository: args.repoFullName, pullNumber: args.pr.number, error: errorMessage(error) }));
    return undefined;
  }
}

/**
 * AI-assisted slop advisory (opt-in `slopAiAdvisory`). Appends at most one ADVISORY-only `ai_slop_advisory`
 * finding to the advisory; NEVER touches slopRisk or the gate (only the deterministic core can block). The
 * caller gates on `settings.slopAiAdvisory` and reuses the already-fetched changed files. Like the AI review
 * path, it runs ONLY for confirmed contributors so an unconfirmed/untrusted PR author cannot spend either the
 * shared Workers AI budget or the maintainer-paid BYOK quota. Fail-safe: any AI error is swallowed so the
 * gate still finalizes.
 */
export async function runAiSlopForAdvisory(
  env: Env,
  args: {
    settings: RepositorySettings;
    advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>;
    repoFullName: string;
    pr: { number: number; title: string; body?: string | null | undefined };
    author: string | null;
    files: Awaited<ReturnType<typeof listPullRequestFiles>>;
    deterministicBand: SlopBand;
    confirmedContributor: boolean;
  },
): Promise<void> {
  // Confirmed-contributor gate (matches runAiReviewForAdvisory): no AI spend — free OR BYOK — on a PR from
  // an unconfirmed author. The deterministic slop core still ran for everyone; only the AI layer is gated.
  if (!args.confirmedContributor || !args.advisory.headSha) return;
  try {
    // BYOK (opt-in): reuse the repo's encrypted key + aiReviewByok flag — one BYOK key serves both AI
    // features. A declared provider must match the stored key's provider, else skip BYOK (Workers-AI
    // fallback). The contributor is already confirmed (early return above), so BYOK billing is authorized.
    // The slop advisory stays advisory-only regardless of which model writes it.
    const storedKey = args.settings.aiReviewByok ? await getDecryptedRepositoryAiKey(env, args.repoFullName) : null;
    const providerKey =
      storedKey && (!args.settings.aiReviewProvider || args.settings.aiReviewProvider === storedKey.provider)
        ? { provider: storedKey.provider, key: storedKey.key, model: args.settings.aiReviewModel ?? storedKey.model }
        : null;
    const result = await runGittensoryAiSlopAdvisory(env, {
      repoFullName: args.repoFullName,
      prNumber: args.pr.number,
      title: args.pr.title,
      body: args.pr.body ?? undefined,
      diff: buildAiReviewDiff(args.files),
      actor: args.author,
      deterministicBand: args.deterministicBand,
      providerKey,
    });
    if (result.status === "ok" && result.finding) args.advisory.findings.push(result.finding);
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", event: "ai_slop_failed", repository: args.repoFullName, pullNumber: args.pr.number, error: errorMessage(error) }));
  }
}

function linkedIssueDuplicatePullRequestsForGate(pr: PullRequestRecord, pullRequests: PullRequestRecord[]): number[] {
  const linkedIssues = new Set(pr.linkedIssues);
  if (linkedIssues.size === 0) return [];
  return [
    ...new Set(
      pullRequests.flatMap((otherPr) => {
        if (otherPr.number === pr.number || otherPr.state !== "open") return [];
        return otherPr.linkedIssues.some((issue) => linkedIssues.has(issue)) ? [otherPr.number] : [];
      }),
    ),
  ].sort((left, right) => left - right);
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
}

function buildClosedPrPanelUpdate(repoFullName: string, pullNumber: number): string {
  return [
    "<!-- gittensory-pr-panel:v1 -->",
    "",
    "> [!NOTE]",
    "> ## Gittensory Gate skipped",
    "> PR closed before full evaluation. No late first comment was created.",
    ">",
    "> | Signal | Result | Evidence | Action |",
    "> | --- | --- | --- | --- |",
    `> | Gate result | ⚠️ Skipped | ${repoFullName}#${pullNumber} is no longer open. | No action. |`,
    "",
    "---",
    gittensoryFooter({ earnUrl: gittensorRepoEarnUrl(repoFullName) }),
  ].join("\n");
}

async function maybePublishPrPublicSurface(
  env: Env,
  installationId: number,
  repoFullName: string,
  pr: Awaited<ReturnType<typeof upsertPullRequestFromGitHub>>,
  repo: Awaited<ReturnType<typeof getRepository>>,
  settings: Awaited<ReturnType<typeof getRepositorySettings>>,
  advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>,
  webhook: { deliveryId: string; authorType?: string | undefined; action?: string | undefined },
): Promise<void> {
  const author = pr.authorLogin ?? null;
  // `settings` is the EFFECTIVE config (`.gittensory.yml` > DB > defaults), resolved by the caller via
  // resolveRepositorySettings — so gate on/off and every blocker mode already reflect the repo's config
  // file. The gate only chooses what to do; confirmedContributor governs WHO can be blocked.
  const gateEnabled = settings.gateCheckMode === "enabled" && Boolean(advisory.headSha);
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
    await auditPrVisibilitySkip(env, repoFullName, pr.number, author, prelim.skipReason ?? "skipped", webhook.deliveryId);
    publicSurfaceSkipped = true;
  }
  const needsMinerCheckForDetectedComment =
    !publicSurfaceSkipped &&
    settings.commentMode === "detected_contributors_only" &&
    (settings.publicSurface === "comment_and_label" || settings.publicSurface === "comment_only");
  if (!gateEnabled && (publicSurfaceSkipped || (prelim.actions.length === 1 && prelim.actions[0] === "none" && !needsMinerCheckForDetectedComment))) return;
  if (!author && !gateEnabled) return;

  if (gateEnabled && (pr.state !== "open" || webhook.action === "closed")) {
    const gateCheckResult = await createOrUpdateSkippedGateCheckRun(env, installationId, repoFullName, advisory, "PR closed before full evaluation.");
    if (gateCheckResult?.kind === "permission_missing") {
      await auditGateCheckPermissionMissing(env, author, repoFullName, pr.number, webhook.deliveryId, gateCheckResult.warning);
    }
    await createOrUpdatePrIntelligenceComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      buildClosedPrPanelUpdate(repoFullName, pr.number),
      { createIfMissing: false },
    ).catch(() => undefined);
    return;
  }
  const prelimHasPublicOutput =
    !publicSurfaceSkipped && (needsMinerCheckForDetectedComment || prelim.actions.some((action) => action === "comment" || action === "label" || action === "check_run"));
  let official: Awaited<ReturnType<typeof getCachedOfficialMinerDetection>> | null = null;
  let decision = prelim;
  if (prelimHasPublicOutput && author) {
    const requireOfficialMiner = settings.publicAudienceMode === "gittensor_only";
    official = await getCachedOfficialMinerDetection(env, author, {
      targetKey: `${repoFullName}#${pr.number}`,
      deliveryId: webhook.deliveryId,
    });
    if (requireOfficialMiner && official.status === "unavailable") {
      await auditPrVisibilitySkip(env, repoFullName, pr.number, author, "miner_detection_unavailable", webhook.deliveryId);
      if (!gateEnabled) return;
      publicSurfaceSkipped = true;
    }
    if (requireOfficialMiner && official.status !== "confirmed") {
      await auditPrVisibilitySkip(env, repoFullName, pr.number, author, "not_official_gittensor_miner", webhook.deliveryId);
      if (!gateEnabled) return;
      publicSurfaceSkipped = true;
    }
    decision = decidePublicSurface({
      settings,
      authorLogin: author,
      authorType: webhook.authorType ?? null,
      authorAssociation: pr.authorAssociation ?? null,
      minerStatus: official.status,
    });

    if (!gateEnabled && decision.actions.length === 1 && decision.actions[0] === "none") return;
  }

  let pendingGateCheckRunId: number | undefined;
  if (gateEnabled) {
    const pendingGateResult = await createOrUpdatePendingGateCheckRun(env, installationId, repoFullName, advisory);
    if (pendingGateResult?.kind === "published") pendingGateCheckRunId = pendingGateResult.id;
    if (pendingGateResult?.kind === "permission_missing") {
      await auditGateCheckPermissionMissing(env, author, repoFullName, pr.number, webhook.deliveryId, pendingGateResult.warning);
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
  let aiReview: { notes: string } | undefined;
  let gateFinalized = false;
  try {
    const [repoIssues, repoPullRequests, repoBounties] = await Promise.all([
      listIssues(env, repoFullName),
      listPullRequests(env, repoFullName),
      listBountiesByRepo(env, repoFullName),
    ]);
    collisions = buildCollisionReport(repoFullName, repoIssues, repoPullRequests);
    queueHealth = buildQueueHealth(repo, repoIssues, repoPullRequests, collisions);
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
      repoPullRequests,
      repoBounties,
    );
    const readiness = buildPublicReadinessScore({
      pr,
      preflight,
      queueHealth,
      linkedDuplicatePrs: linkedIssueDuplicatePullRequestsForGate(pr, repoPullRequests),
      scopedOverlapCount: unionScopedOverlapClusters(collisions, pr, preflight.collisions).length,
    });

    if (gateEnabled && author && !publicSurfaceSkipped && !official) {
      official = await getCachedOfficialMinerDetection(env, author, {
        targetKey: `${repoFullName}#${pr.number}`,
        deliveryId: webhook.deliveryId,
      });
    }

    // Only CONFIRMED gittensor contributors can be hard-blocked; everyone else (or an unavailable
    // detection) gets a neutral, non-blocking gate. Gate-only runs still verify confirmation before
    // evaluating blockers so confirmed contributors cannot bypass a required Gate check.
    const confirmedContributor = official?.status === "confirmed";

    // Anti-slop (#530/#532): only when opted in (slopGateMode !== "off"). Surface the deterministic slop
    // findings as advisory context, and feed the score to the gate (it only blocks under slop: block + the
    // threshold). Loads files lazily so disabled repos pay nothing.
    let slopRisk: number | null = null;
    // Slop (#530) and focus-manifest-policy (#555) gates both need the PR's changed files. Load ONCE and
    // share so two opted-in gates don't double-fetch; the load is lazy so a repo with both off pays nothing.
    let gateFiles: Awaited<ReturnType<typeof listPullRequestFiles>> | null = null;
    if (settings.slopGateMode !== "off" || settings.manifestPolicyGateMode !== "off") {
      gateFiles = await listPullRequestFiles(env, repoFullName, pr.number);
    }
    if (settings.slopGateMode !== "off") {
      const slopFiles = gateFiles ?? [];
      const slop = buildSlopAssessment({
        changedFiles: slopFiles.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
        description: pr.body,
      });
      slopRisk = slop.slopRisk;
      advisory.findings.push(...slop.findings);
      // Persist the assessment so the maintainer dashboard can show a per-PR slop score row without
      // re-fetching changed files. Best-effort: a write hiccup must not abort gate evaluation.
      await updatePullRequestSlopAssessment(env, repoFullName, pr.number, { slopRisk: slop.slopRisk, slopBand: slop.band }).catch(() => undefined);
      // AI-assisted slop advisory (#533, opt-in). Reuses the already-fetched files; appends at most one
      // advisory-only finding. Deliberately does NOT update slopRisk — only the deterministic core blocks.
      if (settings.slopAiAdvisory) {
        await runAiSlopForAdvisory(env, { settings, advisory, repoFullName, pr, author, files: slopFiles, deterministicBand: slop.band, confirmedContributor });
      }
    }
    // Focus-manifest policy (#555, opt-in via manifestPolicyGateMode). Reload the CACHED manifest (the
    // settings resolver discards the raw manifest, but loadRepoFocusManifest is cached so this is cheap),
    // recompute the guidance over the PR's changed files, and push ONLY the three enforceable policy
    // findings into the advisory so isConfiguredGateBlocker can block under manifestPolicy: block.
    if (settings.manifestPolicyGateMode !== "off") {
      const manifestFiles = gateFiles ?? [];
      const manifest = await loadRepoFocusManifest(env, repoFullName);
      const guidance = buildFocusManifestGuidance({
        manifest,
        changedPaths: manifestFiles.map((file) => file.path),
        labels: pr.labels,
        linkedIssueCount: pr.linkedIssues.length,
        testFileCount: manifestFiles.filter((file) => isTestPath(file.path)).length,
        passedValidationCount: 0,
      });
      const policyCodes = new Set(["manifest_blocked_path", "manifest_linked_issue_required", "manifest_missing_tests"]);
      for (const finding of guidance.findings) {
        if (!policyCodes.has(finding.code)) continue;
        advisory.findings.push({
          code: finding.code,
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail,
          ...(finding.action !== undefined ? { action: finding.action } : {}),
        });
      }
    }

    // AI maintainer review (opt-in via aiReviewMode). Mutates `advisory` with a consensus defect (if any)
    // BEFORE the gate evaluates, and returns advisory notes for the panel. Inside the try so any AI
    // failure is caught and the gate is still finalized (never left in_progress).
    aiReview = await runAiReviewForAdvisory(env, { settings, advisory, repoFullName, pr, author, confirmedContributor });

    // First-time-contributor grace (#552): the author's per-repo PR history (excluding this PR). Newcomer =
    // 0 merged here; repeat offender = >= 3 closed-unmerged here. Cheap (in-memory over the already-loaded
    // repo PRs) and only consulted by evaluateGateCheck when firstTimeContributorGrace is on.
    const authorPrs = author ? repoPullRequests.filter((candidate) => candidate.authorLogin === author && candidate.number !== pr.number) : [];
    const authorHistory = {
      mergedPrCount: authorPrs.filter((candidate) => candidate.mergedAt || candidate.state === "merged").length,
      closedUnmergedPrCount: authorPrs.filter((candidate) => candidate.state === "closed" && !candidate.mergedAt).length,
    };

    const gatePolicy = gateCheckPolicy(settings, readiness.total, confirmedContributor, slopRisk, authorHistory);
    gateEvaluation = gateEnabled ? evaluateGateCheck(advisory, gatePolicy) : undefined;
    // #554 gate false-positive telemetry: when the gate BLOCKS, record the block (one latest row per PR) so a
    // maintainer can later compute a per-gate-type false-positive rate (blocked-then-merged / blocked).
    // MEASUREMENT only — never adjusts the gate. Best-effort: a write failure must NOT abort finalization
    // (mirrors the slop-assessment persist above). Privacy: codes + PR number only, no actor/trust fields.
    if (gateEvaluation?.conclusion === "failure") {
      const blockerCodes = gateEvaluation.blockers.map((blocker) => blocker.code);
      await recordGateBlockOutcome(env, { repoFullName, pullNumber: pr.number, headSha: pr.headSha, blockerCodes }).catch(() => undefined);
      await recordGithubProductUsage(env, "gate_blocked", {
        repoFullName,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "completed",
        metadata: { blockerCodes },
      });
    }
    if (gateEnabled) {
      const gateCheckResult = await createOrUpdateGateCheckRun(
        env,
        installationId,
        repoFullName,
        advisory,
        gatePolicy,
        {
          checkRunId: pendingGateCheckRunId,
        },
      );
      if (gateCheckResult?.kind === "published") gateFinalized = true;
      if (gateCheckResult?.kind === "permission_missing") {
        await auditGateCheckPermissionMissing(env, author, repoFullName, pr.number, webhook.deliveryId, gateCheckResult.warning);
        // A 403 on the COMPLETION call is classified as permission_missing and does NOT throw, so the catch
        // below never runs and the pending in_progress check would be orphaned. But the pending check already
        // posted (pendingGateCheckRunId is set), proving the App had Checks:write — so a 403 here is almost
        // always a transient secondary-rate-limit, not a real revocation. Finalize the pending check to
        // neutral (mirrors the catch); if it were a genuine revocation this PATCH also 403s and is swallowed.
        if (pendingGateCheckRunId !== undefined && !gateFinalized) {
          await createOrUpdateErroredGateCheckRun(env, installationId, repoFullName, advisory, { checkRunId: pendingGateCheckRunId }).catch(() => undefined);
          gateFinalized = true;
        }
      }
    }
  } catch (error) {
    // The pending Gate check was posted but evaluation could not finish. Finalize it to a neutral
    // (non-blocking) terminal state so it never hangs in_progress; it re-runs on the next push. Only when
    // the gate was enabled, a pending check id exists, and a real conclusion was not already published.
    if (gateEnabled && pendingGateCheckRunId !== undefined && !gateFinalized) {
      await createOrUpdateErroredGateCheckRun(env, installationId, repoFullName, advisory, { checkRunId: pendingGateCheckRunId }).catch(() => undefined);
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

  if (!prelimHasPublicOutput) return;
  if (publicSurfaceSkipped || !official || !author) return;

  const [github] = await Promise.all([fetchPublicContributorProfile(author, env)]);
  const contributorPullRequests: Awaited<ReturnType<typeof listContributorPullRequests>> = [];
  const contributorIssues: Awaited<ReturnType<typeof listContributorIssues>> = [];
  const repoStats: Awaited<ReturnType<typeof listContributorRepoStats>> = official.status === "confirmed" ? contributorRepoStatsFromGittensor(official.snapshot) : [];
  const detection =
    official.status === "confirmed"
      ? officialGittensorContributorDetection(official.snapshot, pr, contributorPullRequests, contributorIssues, repoStats)
      : { detected: false, reason: "Official Gittensor API did not confirm this GitHub user.", priorPullRequests: 0, priorMergedPullRequests: 0, priorIssues: 0 };

  const profile = buildContributorProfile(author, github, contributorPullRequests, contributorIssues, repoStats, official.status === "confirmed" ? official.snapshot : null);
  const publishedOutputs: PublicSurfaceOutput[] = [];
  const failedOutputs: PublicSurfaceOutputFailure[] = [];

  if (decision.willCheckRun && advisory.headSha) {
    try {
      const checkRunFiles = await listPullRequestFiles(env, repoFullName, pr.number);
      const checkRunResult = await createOrUpdateCheckRun(env, installationId, repoFullName, advisory, settings.checkRunDetailLevel, {
        files: checkRunFiles,
        collisions,
        pullNumber: pr.number,
      });
      if (checkRunResult?.kind === "permission_missing") {
        failedOutputs.push({ output: "check_run", error: checkRunResult.warning });
        await recordAuditEvent(env, {
          eventType: "github_app.check_run_permission_missing",
          actor: author,
          targetKey: `${repoFullName}#${pr.number}`,
          outcome: "error",
          detail: checkRunResult.warning,
          metadata: { deliveryId: webhook.deliveryId, repoFullName },
        });
      } else if (checkRunResult?.kind === "published") {
        publishedOutputs.push("check_run");
      }
    } catch (error) {
      const message = errorMessage(error);
      failedOutputs.push({ output: "check_run", error: message });
      await recordPublicSurfaceOutputFailure(env, "check_run", author, repoFullName, pr.number, webhook.deliveryId, message);
    }
  }

  if (decision.willComment) {
    // Maintainer review-content overrides from `.gittensory.yml` (footer text, row toggles, intro note).
    // Cached, so this is a DB read after the settings resolution already loaded the manifest.
    const reviewConfig = (await loadRepoFocusManifest(env, repoFullName)).review;
    const commentArgs = { repo, pr, profile, detection, queueHealth, collisions, preflight, settings, gate: gateEvaluation, review: reviewConfig, aiReview };
    const deterministicBody = buildPublicPrIntelligenceComment(commentArgs);
    try {
      await createOrUpdatePrIntelligenceComment(env, installationId, repoFullName, pr.number, deterministicBody);
      publishedOutputs.push("comment");
    } catch (error) {
      const message = errorMessage(error);
      failedOutputs.push({ output: "comment", error: message });
      await recordPublicSurfaceOutputFailure(env, "comment", author, repoFullName, pr.number, webhook.deliveryId, message);
    }
  }
  if (decision.willLabel) {
    try {
      await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, settings.gittensorLabel, {
        createMissingLabel: settings.createMissingLabel,
      });
      publishedOutputs.push("label");
    } catch (error) {
      const message = errorMessage(error);
      failedOutputs.push({ output: "label", error: message });
      await recordPublicSurfaceOutputFailure(env, "label", author, repoFullName, pr.number, webhook.deliveryId, message);
    }
  }
  if (publishedOutputs.length === 0) {
    if (failedOutputs.length > 0) {
      await recordAuditEvent(env, {
        eventType: "github_app.pr_public_surface_failed",
        actor: author,
        targetKey: `${repoFullName}#${pr.number}`,
        outcome: "error",
        detail: failedOutputs.map((failure) => failure.output).join(","),
        metadata: { deliveryId: webhook.deliveryId, repoFullName, failedOutputs },
      });
    }
    return;
  }
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
      publicAudienceMode: settings.publicAudienceMode,
      publishedOutputs,
      failedOutputs,
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
      publicAudienceMode: settings.publicAudienceMode,
      publishedOutputs,
      failedOutputs,
    },
  });
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
    outcome?: "success" | "denied" | "error" | "queued" | "completed" | "skipped";
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const actorRole = typeof event.metadata?.actorKind === "string" ? event.metadata.actorKind : typeof event.metadata?.role === "string" ? event.metadata.role : undefined;
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
 * Handle `@gittensory gate-override <reason>` on a PR thread. SECURITY-SENSITIVE: this finalizes the Gate
 * check to neutral for the current commit, so authorization MUST come from real repo permission
 * (resolveRealRepoPermissionAssociation → getRepositoryCollaboratorPermission), never the spoofable
 * payload.comment.author_association. The override is intentionally NOT persisted: a follow-up push
 * re-evaluates the Gate from scratch (no permanent bypass).
 */
async function maybeProcessGateOverrideCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const comment = payload.comment;
  const command = parseGittensoryMentionCommand(comment?.body);
  if (!command || command.name !== "gate-override") return false;

  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const actor = comment?.user?.login ?? payload.sender?.login ?? null;
  const targetKey = repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (comment?.user?.type === "Bot" || payload.sender?.type === "Bot" || /\[bot\]$/i.test(actor ?? "")) {
    await recordGateOverrideSkip(env, deliveryId, repoFullName, targetKey, actor, "bot_author");
    return true;
  }
  if (!repoFullName || !issue?.pull_request || !installationId || !actor) {
    await recordGateOverrideSkip(env, deliveryId, repoFullName, targetKey, actor, "missing_repo_pr_installation_or_actor");
    return true;
  }
  const [pr, settings] = await Promise.all([getPullRequest(env, repoFullName, issue.number), resolveRepositorySettings(env, repoFullName)]);
  if (!pr) {
    await recordGateOverrideSkip(env, deliveryId, repoFullName, targetKey, actor, "cached_pr_missing");
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
      metadata: { deliveryId, repoFullName, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "gate-override") },
    });
    await recordGithubProductUsage(env, "gate_override_denied", {
      actor,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "gate-override") },
    });
    return true;
  }

  const { advisory } = await buildAuthorizedPrActionAdvisory(env, repoFullName, pr, settings);
  const safeReason = sanitizePublicComment((command.reason ?? "").trim() || "No reason provided.");
  await createOrUpdateOverriddenGateCheckRun(env, installationId, repoFullName, advisory, { actor, reason: safeReason });
  await recordAuditEvent(env, {
    eventType: "github_app.gate_overridden",
    actor,
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: "completed",
    detail: safeReason,
    metadata: { deliveryId, repoFullName, headSha: advisory.headSha ?? null },
  });
  const confirmation = sanitizePublicComment(
    [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      "> [!NOTE]",
      `> **Gittensory Gate overridden by @${actor}**`,
      "> The Gate check was set to neutral for the current commit only. This does NOT permanently bypass the Gate; a new push re-evaluates it.",
      "",
      `- Reason: ${safeReason}`,
      "",
      "---",
      gittensoryFooter(),
    ].join("\n"),
  );
  await createOrUpdateAgentCommandComment(env, installationId, repoFullName, issue.number, confirmation);
  await recordGithubProductUsage(env, "gate_overridden", {
    actor,
    repoFullName,
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: "completed",
    metadata: { actorKind: authorization.actorKind, headSha: advisory.headSha ?? null },
  });
  // #554 gate false-positive telemetry: flag the gate-block row as maintainer-overridden — the strongest
  // false-positive signal (a human explicitly judged the block wrong). Best-effort + no-op if no block was
  // recorded; never affects the override outcome above.
  await markGateOutcomeOverridden(env, repoFullName, pr.number).catch(() => undefined);
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

async function maybeProcessPrPanelRetrigger(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const comment = payload.comment;
  if (payload.action !== "edited" || !comment || !isCheckedPrPanelRetrigger(comment.body)) return false;
  if (!isGittensoryPanelBotComment(env, comment.user)) return false;

  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const actor = payload.sender?.login ?? null;
  const targetKey = repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  if (payload.sender?.type === "Bot" || /\[bot\]$/i.test(actor ?? "")) {
    await recordPrPanelRetriggerSkip(env, deliveryId, repoFullName, targetKey, actor, "bot_author");
    return true;
  }
  if (!repoFullName || !issue?.pull_request || !installationId) {
    await recordPrPanelRetriggerSkip(env, deliveryId, repoFullName, targetKey, actor, "missing_repo_pr_or_installation");
    return true;
  }
  const [pr, settings] = await Promise.all([getPullRequest(env, repoFullName, issue.number), resolveRepositorySettings(env, repoFullName)]);
  if (!pr) {
    await recordPrPanelRetriggerSkip(env, deliveryId, repoFullName, targetKey, actor, "cached_pr_missing");
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
    settings,
    pr,
    needsMinerDetection: true,
  });
  if (!authorization.authorized) {
    await recordPrPanelRetriggerSkip(env, deliveryId, repoFullName, `${repoFullName}#${pr.number}`, actor, authorization.reason);
    await recordGithubProductUsage(env, "pr_panel_retrigger_skipped", {
      actor,
      repoFullName,
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: authorization.reason === "miner_detection_unavailable" ? "error" : "skipped",
      metadata: { reason: authorization.reason, actorKind: authorization.actorKind, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, "review-now") },
    });
    return true;
  }

  const { repo, advisory } = await buildAuthorizedPrActionAdvisory(env, repoFullName, pr, settings);
  await persistAdvisory(env, advisory);
  await recordAuditEvent(env, {
    eventType: "github_app.pr_panel_retriggered",
    actor,
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: "completed",
    metadata: { deliveryId, repoFullName, commentId: comment.id },
  });
  await maybePublishPrPublicSurface(env, installationId, repoFullName, pr, repo, settings, advisory, {
    deliveryId,
    action: "manual_retrigger",
  });
  await recordGithubProductUsage(env, "pr_panel_retriggered", {
    actor,
    repoFullName,
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: "completed",
    metadata: { commentId: comment.id },
  });
  return true;
}

async function resolveRealRepoPermissionAssociation(env: Env, installationId: number, repoFullName: string, actor: string | null): Promise<string | null> {
  if (!actor) return null;
  const permission = await getRepositoryCollaboratorPermission(env, installationId, repoFullName, actor).catch(() => null);
  if (permission === "admin" || permission === "maintain") return "MEMBER";
  if (permission === "write") return "COLLABORATOR";
  return null;
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
}): Promise<{ authorization: ReturnType<typeof isAuthorizedCommandActor>; actorAssociation: string | null; pullRequestAuthor: string | null }> {
  const actorAssociation = await resolveRealRepoPermissionAssociation(args.env, args.installationId, args.repoFullName, args.actor);
  const pullRequestAuthor = args.pr.authorLogin ?? args.issue.user?.login ?? null;
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
      ? await getCachedOfficialMinerDetection(args.env, pullRequestAuthor, { targetKey: `${args.repoFullName}#${args.issue.number}`, deliveryId: args.deliveryId })
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
async function buildAuthorizedPrActionAdvisory(
  env: Env,
  repoFullName: string,
  pr: PullRequestRecord,
  settings: RepositorySettings,
): Promise<{ repo: Awaited<ReturnType<typeof getRepository>>; advisory: ReturnType<typeof buildPullRequestAdvisory> }> {
  const [repo, otherOpenPullRequests] = await Promise.all([getRepository(env, repoFullName), listOtherOpenPullRequests(env, repoFullName, pr.number)]);
  const advisory = buildPullRequestAdvisory(repo, pr, {
    otherOpenPullRequests,
    requireLinkedIssue: settings.requireLinkedIssue || settings.linkedIssueGateMode !== "off",
  });
  return { repo, advisory };
}

function isCheckedPrPanelRetrigger(body: string | null | undefined): boolean {
  if (!body?.includes(PR_PANEL_COMMENT_MARKER) || !body.includes(PR_PANEL_RETRIGGER_MARKER)) return false;
  return checkedMarkerRegex(PR_PANEL_RETRIGGER_MARKER).test(body);
}

function checkedMarkerRegex(marker: string): RegExp {
  return new RegExp(`(?:^|\\n)\\s*[-*]\\s*\\[[xX]\\]\\s*${escapeRegExp(marker)}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGittensoryPanelBotComment(env: Env, user: NonNullable<GitHubWebhookPayload["comment"]>["user"] | undefined): boolean {
  return user?.type === "Bot" && user.login?.toLowerCase() === `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
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

async function maybeProcessGittensoryMentionCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command) return false;
  // Action commands (e.g. gate-override) are handled by their own dispatch earlier in processGitHubWebhook;
  // they never produce a Q&A answer card here. Bail so the rest of this handler narrows to Q&A commands.
  if (command.name === "gate-override") return false;
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const commenter = payload.comment?.user?.login;
  const targetKey = repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
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
      metadata: { command: command.name, reason: "missing_repo_issue_installation_or_actor" },
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
    await recordAgentCommandUsage(env, { repoFullName, targetKey, actor: commenter, command: command.name, actorKind: "none", outcome: "skipped", detail: "bot_author" });
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
    await recordAgentCommandUsage(env, { repoFullName, targetKey, actor: commenter, command: command.name, actorKind: "none", outcome: "skipped", detail: "not_a_pull_request_thread" });
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
  const [repo, cachedPullRequest, settings, commenterAssociation] = await Promise.all([
    getRepository(env, repoFullName),
    getPullRequest(env, repoFullName, issue.number),
    resolveRepositorySettings(env, repoFullName),
    resolveRealRepoPermissionAssociation(env, installationId, repoFullName, commenter),
  ]);
  const pullRequestAuthor = cachedPullRequest?.authorLogin ?? issue.user?.login ?? null;
  const needsMinerDetection = commandAuthorizationNeedsMinerDetection({
    policy: settings.commandAuthorization,
    commandName: command.name,
    commenterLogin: commenter,
    commenterAssociation,
    pullRequestAuthorLogin: pullRequestAuthor,
  });
  const official = pullRequestAuthor && (needsMinerDetection || command.name === "miner-context")
    ? await getCachedOfficialMinerDetection(env, pullRequestAuthor, { targetKey: `${repoFullName}#${issue.number}`, deliveryId })
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
      outcome: authorization.reason === "miner_detection_unavailable" ? "error" : "completed",
      detail: authorization.reason,
      metadata: { deliveryId, command: command.name, allowedRoles: commandAuthorizationAllowedRoles(settings.commandAuthorization, command.name) },
    });
    await recordAgentCommandUsage(env, {
      repoFullName,
      targetKey,
      actor: commenter,
      command: command.name,
      actorKind: authorization.actorKind,
      outcome: authorization.reason === "miner_detection_unavailable" ? "error" : "skipped",
      detail: authorization.reason,
    });
    await recordGithubProductUsage(env, "agent_command_skipped", {
      actor: commenter,
      repoFullName,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: authorization.reason === "miner_detection_unavailable" ? "error" : "skipped",
      metadata: { command: command.name, reason: authorization.reason },
    });
    return true;
  }

  const answerId = crypto.randomUUID();
  const login = pullRequestAuthor ?? commenter;
  const maintainerDigest = isMaintainerQueueDigestCommand(command.name)
    ? await buildMaintainerQueueDigestForCommand(env, repo, repoFullName)
    : null;
  const bundle = maintainerDigest
    ? null
    : await buildMentionCommandBundle(env, command.name, {
        login,
        repoFullName,
        issue,
        pullRequest: cachedPullRequest,
      }, command.question);
  const body = buildPublicAgentCommandComment({
    command,
    repo,
    issue,
    pullRequest: cachedPullRequest,
    actorKind: authorization.actorKind === "maintainer" ? "maintainer" : "author",
    answerId,
    officialMiner: official?.status === "confirmed" ? official.snapshot : null,
    bundle,
    maintainerDigest,
  });
  const responseComment = await createOrUpdateAgentCommandComment(env, installationId, repoFullName, issue.number, body);
  await upsertAgentCommandAnswer(env, {
    id: answerId,
    repoFullName,
    issueNumber: issue.number,
    command: command.name,
    requestCommentId: payload.comment?.id ?? null,
    responseCommentId: responseComment?.id ?? null,
    responseUrl: responseComment?.html_url ?? null,
    actorKind: authorization.actorKind === "maintainer" ? "maintainer" : "author",
    metadata: {
      publicSurface: "github_comment",
      responseCommentStored: Boolean(responseComment?.id),
    },
  });
  await recordAuditEvent(env, {
    eventType: "github_app.agent_command_replied",
    actor: commenter,
    targetKey: `${repoFullName}#${issue.number}`,
    outcome: "completed",
    metadata: { deliveryId, command: command.name, actorKind: authorization.actorKind, runId: bundle?.run.id ?? null, answerId },
  });
  await recordAgentCommandUsage(env, {
    repoFullName,
    targetKey,
    actor: commenter,
    command: command.name,
    actorKind: authorization.actorKind,
    outcome: "replied",
    detail: bundle?.run.status ?? (maintainerDigest ? "maintainer_digest" : "no_run"),
    family: maintainerDigest ? "maintainer_digest" : "agent_command",
    runId: bundle?.run.id ?? null,
  });
  await recordGithubProductUsage(env, "agent_command_replied", {
    actor: commenter,
    repoFullName,
    targetKey: `${repoFullName}#${issue.number}`,
    outcome: "completed",
    metadata: { command: command.name, actorKind: authorization.actorKind, hasAgentRun: Boolean(bundle), family: maintainerDigest ? "queue_digest" : "agent_command" },
  });
  await recordAgentCommandFeedbackPrompt(env, {
    deliveryId,
    command: command.name,
    actor: commenter,
    targetKey: `${repoFullName}#${issue.number}`,
    actorKind: authorization.actorKind === "maintainer" ? "maintainer" : "author",
    family: maintainerDigest ? "maintainer_digest" : "agent_command",
  });
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
  if (commandName === "blockers") return explainBlockersWithAgent(env, { login: context.login, repoFullName: context.repoFullName, surface: "github_comment" });
  if (commandName === "preflight" || commandName === "reviewability") return preflightBranchWithAgent(env, buildMentionBranchInput(context), "github_comment");
  if (commandName === "packet") return preparePrPacketWithAgent(env, buildMentionBranchInput(context), "github_comment");
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
    const actorHash = args.actor ? await sha256Hex(`github:${args.actor.toLowerCase()}`) : null;
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
    console.warn("Failed to record GitHub agent command usage", { command: args.command, outcome: args.outcome, error: errorMessage(error) });
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

async function loadCachedConfirmedMinerLogins(env: Env, pullRequests: Awaited<ReturnType<typeof listPullRequests>>): Promise<string[]> {
  const logins = [
    ...new Set(
      pullRequests
        .filter((pr) => pr.state === "open")
        .flatMap((pr) => (pr.authorLogin ? [pr.authorLogin] : []))
        .map((login) => login.toLowerCase()),
    ),
  ].slice(0, 50);
  const detections = await Promise.all(logins.map(async (login) => [login, await getFreshOfficialMinerDetection(env, login)] as const));
  return detections.flatMap(([login, detection]) => (detection?.status === "confirmed" ? [login] : []));
}

async function loadQueueCheckSummariesByPullNumber(
  env: Env,
  repoFullName: string,
  pullRequests: Awaited<ReturnType<typeof listPullRequests>>,
): Promise<Record<number, Awaited<ReturnType<typeof listCheckSummaries>>>> {
  const openPullRequests = pullRequests.filter((pr) => pr.state === "open").slice(0, 50);
  const entries = await Promise.all(openPullRequests.map(async (pr) => [pr.number, await listCheckSummaries(env, repoFullName, pr.number)] as const));
  return Object.fromEntries(entries);
}

function maintainerControlPanelUrl(env: Env, repoFullName: string): string | null {
  const origin = env.PUBLIC_SITE_ORIGIN ?? "https://gittensory.aethereal.dev";
  try {
    const url = new URL("/app", origin);
    url.searchParams.set("view", "maintainer");
    url.searchParams.set("repo", repoFullName);
    return url.toString();
  } catch {
    return null;
  }
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

async function maybeProcessAgentCommandFeedbackReaction(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
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
      metadata: { deliveryId, action: payload.action ?? null, answerId: feedback.answerId },
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
  const contextMismatch = answer.repoFullName.toLowerCase() !== repoFullName.toLowerCase() || answer.issueNumber !== issue.number;
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
  if (!answer.responseCommentId || answer.responseCommentId !== payload.comment?.id) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_feedback_skipped",
      actor,
      targetKey,
      outcome: "completed",
      detail: "answer_comment_mismatch",
      metadata: { deliveryId, answerId: feedback.answerId, command, vote, commentId: payload.comment?.id ?? null },
    });
    return true;
  }
  const pullRequestAuthor = cachedPullRequest?.authorLogin ?? issue.user?.login ?? null;
  const official = pullRequestAuthor && actor.toLowerCase() === pullRequestAuthor.toLowerCase()
    ? await getCachedOfficialMinerDetection(env, actor, { targetKey, deliveryId })
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
    metadata: { deliveryId, answerId: feedback.answerId, command, vote, source: "github_reaction", actorKind: authorization.actorKind },
  });
  return true;
}

function reactionVote(content: string | null | undefined): "useful" | "not_useful" | null {
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
    return { authorized: true, reason: "repo_owner_feedback", actorKind: "maintainer" };
  }
  if (isAuthorizedGitHubSessionLogin(env, args.actor)) {
    return { authorized: true, reason: "operator_feedback", actorKind: "maintainer" };
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

async function getCachedOfficialMinerDetection(env: Env, login: string, context: { targetKey: string; deliveryId: string }): Promise<OfficialGittensorMinerDetection> {
  const cached = await getFreshOfficialMinerDetection(env, login);
  if (cached) {
    await auditMinerDetectionCache(env, "github_app.miner_detection_cache_hit", login, context, cached.status);
    if (cached.status === "unavailable") await auditMinerDetectionUnavailable(env, login, context, cached.error);
    return cached;
  }
  await auditMinerDetectionCache(env, "github_app.miner_detection_cache_miss", login, context, "miss");
  const detection = await fetchOfficialGittensorMiner(login);
  const cacheableDetection = await upsertOfficialMinerDetection(env, login, detection, detection.status === "unavailable" ? OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS : OFFICIAL_MINER_DETECTION_TTL_MS);
  if (cacheableDetection.status === "unavailable") await auditMinerDetectionUnavailable(env, login, context, cacheableDetection.error);
  return cacheableDetection;
}

async function auditMinerDetectionUnavailable(env: Env, actor: string, context: { targetKey: string; deliveryId: string }, detail: string): Promise<void> {
  await recordAuditEvent(env, { eventType: "github_app.miner_detection_unavailable", actor, targetKey: context.targetKey, outcome: "error", detail, metadata: { deliveryId: context.deliveryId } });
}

async function auditMinerDetectionCache(env: Env, eventType: "github_app.miner_detection_cache_hit" | "github_app.miner_detection_cache_miss", actor: string, context: { targetKey: string; deliveryId: string }, detail: string): Promise<void> {
  await recordAuditEvent(env, { eventType, actor, targetKey: context.targetKey, outcome: "completed", detail, metadata: { deliveryId: context.deliveryId } });
}

function officialGittensorContributorDetection(
  snapshot: GittensorContributorSnapshot,
  currentPr: Awaited<ReturnType<typeof upsertPullRequestFromGitHub>>,
  pullRequests: Awaited<ReturnType<typeof listContributorPullRequests>>,
  issues: Awaited<ReturnType<typeof listContributorIssues>>,
  repoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const cached = detectGittensorContributor(snapshot.githubUsername, currentPr, pullRequests, issues, repoStats);
  return {
    ...cached,
    detected: true,
    source: "official_gittensor_api" as const,
    reason: "Official Gittensor API confirms this GitHub user.",
    priorPullRequests: Math.max(cached.priorPullRequests, snapshot.totals.pullRequests),
    priorMergedPullRequests: Math.max(cached.priorMergedPullRequests, snapshot.totals.mergedPullRequests),
    priorIssues: Math.max(cached.priorIssues, snapshot.totals.openIssues + snapshot.totals.closedIssues),
  };
}

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>>,
  cachedRepoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const officialRepoStats = contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
}
