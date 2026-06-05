import {
  countOpenIssues,
  countOpenPullRequests,
  getAgentCommandAnswer,
  getInstallation,
  getLatestRepoGithubTotalsSnapshot,
  getFreshOfficialMinerDetection,
  getPullRequest,
  getRepository,
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
  listRecentMergedPullRequests,
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
import {
  backfillOpenPullRequestDetails,
  backfillRegisteredRepositories,
  backfillRepositorySegment,
  enqueueRepositoryOpenDataBackfill,
  refreshContributorActivity,
  refreshInstallationHealth,
} from "../github/backfill";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot, fetchOfficialGittensorMiner, type GittensorContributorSnapshot, type OfficialGittensorMinerDetection } from "../gittensor/api";
import { createOrUpdateCheckRun, createOrUpdateGateCheckRun, createOrUpdatePendingGateCheckRun, createOrUpdateSkippedGateCheckRun, getInstallationId } from "../github/app";
import { createOrUpdateAgentCommandComment, createOrUpdatePrIntelligenceComment } from "../github/comments";
import {
  buildMaintainerQueueDigest,
  buildPublicAgentCommandComment,
  type GittensoryMentionCommandName,
  isAuthorizedCommandActor,
  isMaintainerAssociation,
  isMaintainerQueueDigestCommand,
  parseAgentCommandFeedbackContext,
  parseGittensoryMentionCommand,
} from "../github/commands";
import { ensurePullRequestLabel } from "../github/labels";
import { fetchPublicContributorProfile } from "../github/public";
import { refreshRegistry } from "../registry/sync";
import { buildIssueAdvisory, buildPullRequestAdvisory, evaluateGateCheck } from "../rules/advisory";
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
} from "../signals/engine";
import { decidePublicSurface } from "../signals/settings-preview";
import type { LocalBranchAnalysisInput } from "../signals/local-branch";
import type { ContributorEvidenceRecord, GitHubWebhookPayload, JobMessage, JsonValue, PullRequestRecord, RepositorySettings } from "../types";
import { sha256Hex } from "../utils/crypto";
import { errorMessage, nowIso } from "../utils/json";

const OFFICIAL_MINER_DETECTION_TTL_MS = 5 * 60 * 1000;
const OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS = 60 * 1000;
const PR_PUBLIC_SURFACE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);
const PR_GATE_CLOSED_ACTIONS = new Set(["closed"]);

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
    case "generate-weekly-value-report":
      await generateWeeklyValueReport(env, { variant: message.variant ?? "operator", ...(message.days === undefined ? {} : { days: message.days }) });
      return;
    case "run-agent":
      await executeAgentRun(env, message.runId);
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
  for (const contributorLogin of logins) await buildAndPersistContributorDecisionPack(env, contributorLogin, shared);
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
    const [github, contributorPullRequests, contributorIssues, cachedRepoStats, gittensorSnapshot] = await Promise.all([
      fetchPublicContributorProfile(contributorLogin),
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
        getRepositorySettings(env, repoFullName),
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

    if (payload.repository?.full_name && payload.issue && !payload.issue.pull_request) {
      const issue = await upsertIssueFromGitHub(env, payload.repository.full_name, payload.issue);
      const repo = await getRepository(env, payload.repository.full_name);
      const advisory = buildIssueAdvisory(repo, issue);
      await persistAdvisory(env, advisory);
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

function gateCheckPolicy(settings: RepositorySettings, readinessScore?: number | null) {
  return {
    linkedIssueGateMode: settings.linkedIssueGateMode,
    duplicatePrGateMode: settings.duplicatePrGateMode,
    qualityGateMode: settings.qualityGateMode,
    qualityGateMinScore: settings.qualityGateMinScore ?? null,
    readinessScore: readinessScore ?? null,
  };
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

function pullRequestSpecificCollisionCount(collisions: ReturnType<typeof buildCollisionReport>, pr: PullRequestRecord): number {
  return collisions.clusters.filter((cluster) => cluster.items.some((item) => item.type === "pull_request" && item.number === pr.number)).length;
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
    "Checked by [Gittensory](https://github.com/JSONbored/gittensory), a quiet PR intelligence layer for OSS maintainers.",
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
  const gateEnabled = settings.gateCheckMode === "enabled" && Boolean(advisory.headSha);
  // Cheap, network-free skip checks (also avoids the miner lookup when it would be wasted).
  const prelim = decidePublicSurface({
    settings,
    authorLogin: author,
    authorType: webhook.authorType ?? null,
    authorAssociation: pr.authorAssociation ?? null,
    minerStatus: "not_checked",
  });
  if (prelim.skipped) {
    await auditPrVisibilitySkip(env, repoFullName, pr.number, author, prelim.skipReason ?? "skipped", webhook.deliveryId);
    return;
  }
  if (!gateEnabled && prelim.actions.length === 1 && prelim.actions[0] === "none") return;
  if (!author) return;

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
  const prelimHasPublicOutput = prelim.actions.some((action) => action === "comment" || action === "label" || action === "check_run");
  let official: Awaited<ReturnType<typeof getCachedOfficialMinerDetection>> | null = null;
  let decision = prelim;
  if (prelimHasPublicOutput) {
    const requireOfficialMiner = settings.publicAudienceMode === "gittensor_only";
    official = await getCachedOfficialMinerDetection(env, author, {
      targetKey: `${repoFullName}#${pr.number}`,
      deliveryId: webhook.deliveryId,
    });
    if (requireOfficialMiner && official.status === "unavailable") {
      await auditPrVisibilitySkip(env, repoFullName, pr.number, author, "miner_detection_unavailable", webhook.deliveryId);
      return;
    }
    if (requireOfficialMiner && official.status !== "confirmed") {
      await auditPrVisibilitySkip(env, repoFullName, pr.number, author, "not_official_gittensor_miner", webhook.deliveryId);
      return;
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

  const [repoIssues, repoPullRequests, repoBounties] = await Promise.all([
    listIssues(env, repoFullName),
    listPullRequests(env, repoFullName),
    listBountiesByRepo(env, repoFullName),
  ]);
  const collisions = buildCollisionReport(repoFullName, repoIssues, repoPullRequests);
  const queueHealth = buildQueueHealth(repo, repoIssues, repoPullRequests, collisions);
  const preflight = buildPreflightResult(
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
    scopedOverlapCount: Math.max(pullRequestSpecificCollisionCount(collisions, pr), preflight.collisions.length),
  });

  const gateEvaluation = settings.gateCheckMode === "enabled" ? evaluateGateCheck(advisory, gateCheckPolicy(settings, readiness.total)) : undefined;
  if (gateEnabled) {
    const gateCheckResult = await createOrUpdateGateCheckRun(env, installationId, repoFullName, advisory, gateCheckPolicy(settings, readiness.total), {
      checkRunId: pendingGateCheckRunId,
    });
    if (gateCheckResult?.kind === "permission_missing") {
      await auditGateCheckPermissionMissing(env, author, repoFullName, pr.number, webhook.deliveryId, gateCheckResult.warning);
    }
  }

  if (!prelimHasPublicOutput) return;
  if (!official) return;

  const publishCachedContributorActivity = official.status === "confirmed";
  const [contributorPullRequests, contributorIssues, github, cachedRepoStats] = await Promise.all([
    publishCachedContributorActivity ? listContributorPullRequests(env, author) : Promise.resolve([]),
    publishCachedContributorActivity ? listContributorIssues(env, author) : Promise.resolve([]),
    fetchPublicContributorProfile(author),
    publishCachedContributorActivity ? listContributorRepoStats(env, author) : Promise.resolve([]),
  ]);
  const repoStats = official.status === "confirmed" ? authoritativeContributorRepoStats(official.snapshot, cachedRepoStats) : [];
  const detection =
    official.status === "confirmed"
      ? officialGittensorContributorDetection(official.snapshot, pr, contributorPullRequests, contributorIssues, repoStats)
      : { detected: false, reason: "Official Gittensor API did not confirm this GitHub user.", priorPullRequests: 0, priorMergedPullRequests: 0, priorIssues: 0 };

  const profile = buildContributorProfile(author, github, contributorPullRequests, contributorIssues, repoStats, official.status === "confirmed" ? official.snapshot : null);
  const publishedOutputs: PublicSurfaceOutput[] = [];
  const failedOutputs: PublicSurfaceOutputFailure[] = [];

  if (decision.willCheckRun && advisory.headSha) {
    try {
      const checkRunResult = await createOrUpdateCheckRun(env, installationId, repoFullName, advisory, settings.checkRunDetailLevel);
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
    const commentArgs = { repo, pr, profile, detection, queueHealth, collisions, preflight, settings, gate: gateEvaluation };
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

async function maybeProcessGittensoryMentionCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command) return false;
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const commenter = payload.comment?.user?.login;
  const targetKey = repoFullName && issue ? `${repoFullName}#${issue.number}` : repoFullName;
  const commenterAssociation = payload.comment?.author_association ?? issue?.author_association;
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

  const [repo, cachedPullRequest, settings] = await Promise.all([getRepository(env, repoFullName), getPullRequest(env, repoFullName, issue.number), getRepositorySettings(env, repoFullName)]);
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
