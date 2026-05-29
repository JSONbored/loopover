import {
  countOpenIssues,
  countOpenPullRequests,
  getLatestRepoGithubTotalsSnapshot,
  getFreshOfficialMinerDetection,
  getPullRequest,
  getRepository,
  getRepositorySettings,
  listAllIssues,
  listAllPullRequests,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listIssues,
  listIssueSignalSample,
  listLatestSignalSnapshotsByTarget,
  listOtherOpenPullRequests,
  listOpenPullRequests,
  listPullRequests,
  listRecentMergedPullRequests,
  listRepoLabels,
  listRepoSyncStates,
  listRepoSyncSegments,
  listRepositories,
  markInstallationDeleted,
  persistAdvisory,
  recordAuditEvent,
  persistSignalSnapshot,
  recordWebhookEvent,
  replaceCollisionEdges,
  upsertOfficialMinerDetection,
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
import { createOrUpdateCheckRun, getInstallationId } from "../github/app";
import { createOrUpdateAgentCommandComment, createOrUpdatePrIntelligenceComment } from "../github/comments";
import {
  buildPublicAgentCommandComment,
  isAuthorizedCommandActor,
  parseGittensoryMentionCommand,
} from "../github/commands";
import { ensurePullRequestLabel } from "../github/labels";
import { fetchPublicContributorProfile } from "../github/public";
import { refreshRegistry } from "../registry/sync";
import { buildIssueAdvisory, buildPullRequestAdvisory } from "../rules/advisory";
import { getOrCreateScoringModelSnapshot, refreshScoringModelSnapshot } from "../scoring/model";
import { buildAndPersistContributorDecisionPack } from "../services/decision-pack";
import { executeAgentRun, explainBlockersWithAgent, planNextWork } from "../services/agent-orchestrator";
import { loadIssueQualityReportMap } from "../services/issue-quality";
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
  buildQueueHealth,
  detectGittensorContributor,
} from "../signals/engine";
import { decidePublicSurface } from "../signals/settings-preview";
import type { ContributorEvidenceRecord, GitHubWebhookPayload, JobMessage, JsonValue } from "../types";
import { errorMessage } from "../utils/json";

const OFFICIAL_MINER_DETECTION_TTL_MS = 5 * 60 * 1000;
const OFFICIAL_MINER_DETECTION_UNAVAILABLE_TTL_MS = 60 * 1000;

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
  for (const contributorLogin of logins) await buildAndPersistContributorDecisionPack(env, contributorLogin);
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
  const [allPullRequests, allIssues, repositories, syncStates, snapshot] = await Promise.all([
    listAllPullRequests(env),
    listAllIssues(env),
    listRepositories(env),
    listRepoSyncStates(env),
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
    const fit = buildContributorFit(profile, repositories, allIssues, allPullRequests, syncStates, repoStats, issueQualityByRepo);
    const scoringProfile = buildContributorScoringProfile({ login: contributorLogin, fit, scoringSnapshot: snapshot });
    const outcomeHistory = buildContributorOutcomeHistory({ login: contributorLogin, profile, repositories, pullRequests: allPullRequests, issues: allIssues, repoStats });
    const strategy = buildContributorStrategy({ login: contributorLogin, fit, scoringProfile, scoringSnapshot: snapshot, outcomeHistory });
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
    const [issues, pullRequests, recentMergedPullRequests, labels, queueCounts] = await Promise.all([
      listIssueSignalSample(env, repo.fullName),
      listOpenPullRequests(env, repo.fullName),
      listRecentMergedPullRequests(env, repo.fullName),
      listRepoLabels(env, repo.fullName),
      loadOpenQueueCounts(env, repo.fullName),
    ]);
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests, recentMergedPullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts);
    const configQuality = buildConfigQuality(repo, issues, pullRequests, repo.fullName);
    const labelAudit = buildLabelAudit(repo, labels, issues, pullRequests, repo.fullName);
    const maintainerLane = buildMaintainerLaneReport(repo, issues, pullRequests, repo.fullName, collisions, queueCounts);
    const maintainerCutReadiness = buildMaintainerCutReadiness(repo, issues, pullRequests, repo.fullName, queueCounts, collisions);
    const contributorIntakeHealth = buildContributorIntakeHealth(repo, issues, pullRequests, repo.fullName, collisions, queueCounts);
    const issueQuality = buildIssueQualityReport(repo, issues, pullRequests, repo.fullName, collisions, recentMergedPullRequests);
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

    const installationId = getInstallationId(payload);
    if (payload.repositories) {
      for (const repo of payload.repositories) await upsertRepositoryFromGitHub(env, repo, installationId ?? undefined);
    }
    if (payload.repository) await upsertRepositoryFromGitHub(env, payload.repository, installationId ?? undefined);

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
      const advisory = buildPullRequestAdvisory(repo, pr, { otherOpenPullRequests, requireLinkedIssue: settings.requireLinkedIssue });
      await persistAdvisory(env, advisory);
      if (installationId) {
        await maybePublishPrPublicSurface(env, installationId, repoFullName, pr, repo, settings, advisory, {
          deliveryId,
          authorType: payload.pull_request.user?.type,
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

async function maybePublishPrPublicSurface(
  env: Env,
  installationId: number,
  repoFullName: string,
  pr: Awaited<ReturnType<typeof upsertPullRequestFromGitHub>>,
  repo: Awaited<ReturnType<typeof getRepository>>,
  settings: Awaited<ReturnType<typeof getRepositorySettings>>,
  advisory: Awaited<ReturnType<typeof buildPullRequestAdvisory>>,
  webhook: { deliveryId: string; authorType?: string | undefined },
): Promise<void> {
  const author = pr.authorLogin ?? null;
  // Cheap, network-free skip checks (also avoids the miner lookup when it would be wasted).
  const prelim = decidePublicSurface({
    settings,
    authorLogin: author,
    authorType: webhook.authorType ?? null,
    authorAssociation: pr.authorAssociation ?? null,
    minerStatus: "not_checked",
  });
  if (prelim.skipped) {
    if (prelim.skipReason === "surface_off") return;
    await auditPrVisibilitySkip(env, repoFullName, pr.number, author, prelim.skipReason ?? "skipped", webhook.deliveryId);
    return;
  }
  if (!author) return;

  const official = await getCachedOfficialMinerDetection(env, author, {
    targetKey: `${repoFullName}#${pr.number}`,
    deliveryId: webhook.deliveryId,
  });
  if (official.status === "unavailable") {
    await auditPrVisibilitySkip(env, repoFullName, pr.number, author, "miner_detection_unavailable", webhook.deliveryId);
    return;
  }
  if (official.status !== "confirmed") {
    await auditPrVisibilitySkip(env, repoFullName, pr.number, author, "not_official_gittensor_miner", webhook.deliveryId);
    return;
  }
  const decision = decidePublicSurface({
    settings,
    authorLogin: author,
    authorType: webhook.authorType ?? null,
    authorAssociation: pr.authorAssociation ?? null,
    minerStatus: "confirmed",
  });

  const [contributorPullRequests, contributorIssues, repoIssues, repoPullRequests, github, cachedRepoStats] = await Promise.all([
    listContributorPullRequests(env, author),
    listContributorIssues(env, author),
    listIssues(env, repoFullName),
    listPullRequests(env, repoFullName),
    fetchPublicContributorProfile(author),
    listContributorRepoStats(env, author),
  ]);
  const repoStats = authoritativeContributorRepoStats(official.snapshot, cachedRepoStats);
  const detection = officialGittensorContributorDetection(official.snapshot, pr, contributorPullRequests, contributorIssues, repoStats);

  const profile = buildContributorProfile(author, github, contributorPullRequests, contributorIssues, repoStats, official.snapshot);
  const collisions = buildCollisionReport(repoFullName, repoIssues, repoPullRequests);
  const queueHealth = buildQueueHealth(repo, repoIssues, repoPullRequests, collisions);
  const preflight = buildPreflightResult(
    {
      repoFullName,
      contributorLogin: author,
      title: pr.title,
      body: pr.body ?? undefined,
      labels: pr.labels,
      linkedIssues: pr.linkedIssues,
      authorAssociation: pr.authorAssociation ?? undefined,
    },
    repo,
    repoIssues,
    repoPullRequests,
  );
  if (decision.willComment) {
    const body = buildPublicPrIntelligenceComment({
      repo,
      pr,
      profile,
      detection,
      queueHealth,
      collisions,
      preflight,
      settings,
    });
    await createOrUpdatePrIntelligenceComment(env, installationId, repoFullName, pr.number, body);
  }
  if (decision.willLabel) {
    await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, settings.gittensorLabel, {
      createMissingLabel: settings.createMissingLabel,
    });
  }
  if (decision.willCheckRun && advisory.headSha) {
    await createOrUpdateCheckRun(env, installationId, repoFullName, {
      ...advisory,
      conclusion: "success",
      severity: "info",
      title: "Gittensory context posted",
      summary: "Gittensory posted public-safe contributor context.",
      findings: [],
    });
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
    },
  });
}

async function maybeProcessGittensoryMentionCommand(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const command = parseGittensoryMentionCommand(payload.comment?.body);
  if (!command) return false;
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  const installationId = getInstallationId(payload);
  const commenter = payload.comment?.user?.login;
  if (!repoFullName || !issue || !installationId || !commenter) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_skipped",
      actor: commenter,
      targetKey: repoFullName,
      outcome: "completed",
      detail: "missing_repo_issue_installation_or_actor",
      metadata: { deliveryId, command: command.name },
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
    return true;
  }

  const [repo, cachedPullRequest] = await Promise.all([getRepository(env, repoFullName), getPullRequest(env, repoFullName, issue.number)]);
  const pullRequestAuthor = cachedPullRequest?.authorLogin ?? issue.user?.login ?? null;
  const official = pullRequestAuthor
    ? await getCachedOfficialMinerDetection(env, pullRequestAuthor, { targetKey: `${repoFullName}#${issue.number}`, deliveryId })
    : undefined;
  const authorization = isAuthorizedCommandActor({
    commenterLogin: commenter,
    commenterAssociation: payload.comment?.author_association ?? issue.author_association,
    pullRequestAuthorLogin: pullRequestAuthor,
    officialAuthorDetection: official,
  });
  if (!authorization.authorized) {
    await recordAuditEvent(env, {
      eventType: "github_app.agent_command_skipped",
      actor: commenter,
      targetKey: `${repoFullName}#${issue.number}`,
      outcome: authorization.reason === "miner_detection_unavailable" ? "error" : "completed",
      detail: authorization.reason,
      metadata: { deliveryId, command: command.name },
    });
    return true;
  }

  const login = pullRequestAuthor ?? commenter;
  const bundle =
    command.name === "help" || command.name === "miner-context"
      ? null
      : command.name === "blockers"
        ? await explainBlockersWithAgent(env, { login, repoFullName, surface: "github_comment" })
        : await planNextWork(env, {
            login,
            repoFullName,
            surface: "github_comment",
            objective: `Respond to @gittensory ${command.name} for ${repoFullName}#${issue.number}.`,
          });
  const body = buildPublicAgentCommandComment({
    command,
    repo,
    issue,
    pullRequest: cachedPullRequest,
    actorKind: authorization.actorKind === "maintainer" ? "maintainer" : "author",
    officialMiner: official?.status === "confirmed" ? official.snapshot : null,
    bundle,
  });
  await createOrUpdateAgentCommandComment(env, installationId, repoFullName, issue.number, body);
  await recordAuditEvent(env, {
    eventType: "github_app.agent_command_replied",
    actor: commenter,
    targetKey: `${repoFullName}#${issue.number}`,
    outcome: "completed",
    metadata: { deliveryId, command: command.name, actorKind: authorization.actorKind, runId: bundle?.run.id ?? null },
  });
  return true;
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
