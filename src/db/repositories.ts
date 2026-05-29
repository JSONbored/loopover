import { and, desc, eq, gte, not, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  advisories,
  aiUsageEvents,
  agentActions,
  agentContextSnapshots,
  agentRuns,
  auditEvents,
  authSessions,
  bounties,
  bountyLifecycleEvents,
  checkSummaries,
  burdenForecasts,
  contributorEvidence,
  collisionEdges,
  contributorRepoStats,
  contributorScoringProfiles,
  contributors,
  installationHealth,
  installations,
  issueQualityReports,
  issues,
  githubRateLimitObservations,
  officialMinerDetections,
  pullRequestFiles,
  pullRequestDetailSyncState,
  pullRequestReviews,
  pullRequests,
  recentMergedPullRequests,
  repositories,
  repoGithubTotalsSnapshots,
  registryDriftEvents,
  repoLabels,
  repoSnapshots,
  repoSyncSegments,
  repoSyncState,
  repositorySettings,
  scorePreviews,
  scoringModelSnapshots,
  signalSnapshots,
  webhookEvents,
} from "./schema";
import type {
  Advisory,
  AgentActionRecord,
  AgentActionStatus,
  AgentActionType,
  AgentContextSnapshotRecord,
  AgentMode,
  AgentRunRecord,
  AgentRunStatus,
  AgentSafetyClass,
  AgentSurface,
  AuditEventRecord,
  AuthSessionRecord,
  BountyLifecycleEventRecord,
  BountyRecord,
  BurdenForecastRecord,
  CheckSummaryRecord,
  CollisionEdgeRecord,
  ContributorEvidenceRecord,
  ContributorRecord,
  ContributorRepoStatRecord,
  ContributorScoringProfileRecord,
  GitHubIssuePayload,
  GitHubPullRequestPayload,
  GitHubRateLimitObservationRecord,
  GitHubRepositoryPayload,
  GitHubWebhookPayload,
  InstallationHealthRecord,
  InstallationRecord,
  IssueRecord,
  IssueQualityReportRecord,
  JsonValue,
  PullRequestFileRecord,
  PullRequestDetailSyncStateRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RegistryRepoConfig,
  RegistryDriftEventRecord,
  RepoLabelRecord,
  RepoGithubTotalsSnapshotRecord,
  RepoSnapshotRecord,
  RepoSyncSegmentRecord,
  RepoSyncStateRecord,
  RepositorySettings,
  RepositoryRecord,
  ScorePreviewRecord,
  ScoringModelSnapshotRecord,
  SignalSnapshotRecord,
} from "../types";
import type { GittensorContributorSnapshot, OfficialGittensorMinerDetection } from "../gittensor/api";
import { jsonString, nowIso, parseJson, repoParts } from "../utils/json";

const MAX_STORED_BODY_CHARS = 4000;

export async function upsertInstallation(env: Env, payload: GitHubWebhookPayload): Promise<void> {
  if (!payload.installation?.id) return;
  const account = payload.installation.account;
  const db = getDb(env.DB);
  await db
    .insert(installations)
    .values({
      id: payload.installation.id,
      accountLogin: account?.login ?? "unknown",
      accountId: account?.id ?? 0,
      targetType: payload.installation.target_type ?? account?.type ?? "unknown",
      repositorySelection: payload.installation.repository_selection,
      permissionsJson: jsonString((payload.installation.permissions ?? {}) as Record<string, string>),
      eventsJson: jsonString(payload.installation.events ?? []),
      suspendedAt: payload.installation.suspended_at ?? undefined,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: installations.id,
      set: {
        accountLogin: account?.login ?? "unknown",
        accountId: account?.id ?? 0,
        targetType: payload.installation.target_type ?? account?.type ?? "unknown",
        repositorySelection: payload.installation.repository_selection,
        permissionsJson: jsonString((payload.installation.permissions ?? {}) as Record<string, string>),
        eventsJson: jsonString(payload.installation.events ?? []),
        suspendedAt: payload.installation.suspended_at ?? undefined,
        updatedAt: nowIso(),
      },
    });
}

export async function markInstallationDeleted(env: Env, installationId: number): Promise<void> {
  const db = getDb(env.DB);
  await db.update(installations).set({ suspendedAt: nowIso(), updatedAt: nowIso() }).where(eq(installations.id, installationId));
  await db
    .update(repositories)
    .set({ isInstalled: false, installationId: null, updatedAt: nowIso() })
    .where(eq(repositories.installationId, installationId));
}

export async function listInstallations(env: Env): Promise<InstallationRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(installations).orderBy(desc(installations.updatedAt)).limit(100);
  return rows.map(toInstallationRecord);
}

export async function upsertRepositoryFromGitHub(env: Env, repo: GitHubRepositoryPayload, installationId?: number): Promise<void> {
  const db = getDb(env.DB);
  const parts = repoParts(repo.full_name);
  await db
    .insert(repositories)
    .values({
      fullName: repo.full_name,
      owner: repo.owner?.login ?? parts.owner,
      name: repo.name,
      installationId,
      isInstalled: installationId !== undefined,
      isPrivate: repo.private ?? false,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: repositories.fullName,
      set: {
        owner: repo.owner?.login ?? parts.owner,
        name: repo.name,
        installationId,
        isInstalled: installationId !== undefined,
        isPrivate: repo.private ?? false,
        htmlUrl: repo.html_url,
        defaultBranch: repo.default_branch,
        updatedAt: nowIso(),
      },
    });
}

export async function upsertPullRequestFromGitHub(
  env: Env,
  repoFullName: string,
  pr: GitHubPullRequestPayload,
  options: { seenOpenAt?: string } = {},
): Promise<PullRequestRecord> {
  const record = toPullRequestRecord(repoFullName, pr);
  const db = getDb(env.DB);
  const lastSeenOpenAt = pr.state === "open" ? (options.seenOpenAt ?? nowIso()) : null;
  await db
    .insert(pullRequests)
    .values({
      id: `${repoFullName}#${pr.number}`,
      repoFullName,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      authorLogin: pr.user?.login,
      authorAssociation: pr.author_association,
      headSha: pr.head?.sha,
      headRef: pr.head?.ref,
      baseRef: pr.base?.ref,
      mergedAt: pr.merged_at ?? undefined,
      htmlUrl: pr.html_url,
      labelsJson: jsonString(record.labels),
      linkedIssuesJson: jsonString(record.linkedIssues),
      lastSeenOpenAt,
      payloadJson: jsonString(compactGitHubPayload(pr)),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [pullRequests.repoFullName, pullRequests.number],
      set: {
        title: pr.title,
        state: pr.state,
        authorLogin: pr.user?.login,
        authorAssociation: pr.author_association,
        headSha: pr.head?.sha,
        headRef: pr.head?.ref,
        baseRef: pr.base?.ref,
        mergedAt: pr.merged_at ?? undefined,
        htmlUrl: pr.html_url,
        labelsJson: jsonString(record.labels),
        linkedIssuesJson: jsonString(record.linkedIssues),
        lastSeenOpenAt,
        payloadJson: jsonString(compactGitHubPayload(pr)),
        updatedAt: nowIso(),
      },
    });
  return record;
}

export async function upsertIssueFromGitHub(env: Env, repoFullName: string, issue: GitHubIssuePayload, options: { seenOpenAt?: string } = {}): Promise<IssueRecord> {
  const record = toIssueRecord(repoFullName, issue);
  const db = getDb(env.DB);
  const lastSeenOpenAt = issue.state === "open" ? (options.seenOpenAt ?? nowIso()) : null;
  await db
    .insert(issues)
    .values({
      id: `${repoFullName}#${issue.number}`,
      repoFullName,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      authorLogin: issue.user?.login,
      authorAssociation: issue.author_association,
      htmlUrl: issue.html_url,
      labelsJson: jsonString(record.labels),
      linkedPrsJson: jsonString(record.linkedPrs),
      lastSeenOpenAt,
      payloadJson: jsonString(compactGitHubPayload(issue)),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [issues.repoFullName, issues.number],
      set: {
        title: issue.title,
        state: issue.state,
        authorLogin: issue.user?.login,
        authorAssociation: issue.author_association,
        htmlUrl: issue.html_url,
        labelsJson: jsonString(record.labels),
        linkedPrsJson: jsonString(record.linkedPrs),
        lastSeenOpenAt,
        payloadJson: jsonString(compactGitHubPayload(issue)),
        updatedAt: nowIso(),
      },
    });
  return record;
}

export async function getRepository(env: Env, fullName: string): Promise<RepositoryRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(repositories).where(eq(repositories.fullName, fullName)).limit(1);
  if (row) return toRepositoryRecord(row);
  const [caseInsensitiveRow] = await db
    .select()
    .from(repositories)
    .where(sql`lower(${repositories.fullName}) = ${fullName.toLowerCase()}`)
    .limit(1);
  return caseInsensitiveRow ? toRepositoryRecord(caseInsensitiveRow) : null;
}

export async function listRepositories(env: Env): Promise<RepositoryRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(repositories).orderBy(desc(repositories.isRegistered), repositories.fullName);
  return rows.map(toRepositoryRecord);
}

export async function getRepositorySettings(env: Env, fullName: string): Promise<RepositorySettings> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(repositorySettings).where(eq(repositorySettings.repoFullName, fullName)).limit(1);
  if (!row) {
    return {
      repoFullName: fullName,
      commentMode: "detected_contributors_only",
      publicSignalLevel: "standard",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
    };
  }
  return {
    repoFullName: row.repoFullName,
    commentMode: parseCommentMode(row.commentMode),
    publicSignalLevel: row.publicSignalLevel === "minimal" ? "minimal" : "standard",
    checkRunMode: parseCheckRunMode(row.checkRunMode),
    checkRunDetailLevel: parseCheckRunDetailLevel(row.checkRunDetailLevel),
    autoLabelEnabled: row.autoLabelEnabled,
    gittensorLabel: row.gittensorLabel,
    createMissingLabel: row.createMissingLabel,
    publicSurface: parsePublicSurface(row.publicSurface),
    includeMaintainerAuthors: row.includeMaintainerAuthors,
    requireLinkedIssue: row.requireLinkedIssue,
    backfillEnabled: row.backfillEnabled,
    privateTrustEnabled: row.privateTrustEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertRepositorySettings(env: Env, settings: Partial<RepositorySettings> & { repoFullName: string }): Promise<RepositorySettings> {
  const resolved: RepositorySettings = {
    repoFullName: settings.repoFullName,
    commentMode: settings.commentMode ?? "detected_contributors_only",
    publicSignalLevel: settings.publicSignalLevel ?? "standard",
    checkRunMode: settings.checkRunMode ?? "off",
    checkRunDetailLevel: settings.checkRunDetailLevel ?? "minimal",
    autoLabelEnabled: settings.autoLabelEnabled ?? true,
    gittensorLabel: settings.gittensorLabel ?? "gittensor",
    createMissingLabel: settings.createMissingLabel ?? true,
    publicSurface: settings.publicSurface ?? "comment_and_label",
    includeMaintainerAuthors: settings.includeMaintainerAuthors ?? false,
    requireLinkedIssue: settings.requireLinkedIssue ?? false,
    backfillEnabled: settings.backfillEnabled ?? true,
    privateTrustEnabled: settings.privateTrustEnabled ?? true,
  };
  const db = getDb(env.DB);
  await db
    .insert(repositorySettings)
    .values({
      repoFullName: resolved.repoFullName,
      commentMode: resolved.commentMode,
      publicSignalLevel: resolved.publicSignalLevel,
      checkRunMode: resolved.checkRunMode,
      checkRunDetailLevel: resolved.checkRunDetailLevel,
      autoLabelEnabled: resolved.autoLabelEnabled,
      gittensorLabel: resolved.gittensorLabel,
      createMissingLabel: resolved.createMissingLabel,
      publicSurface: resolved.publicSurface,
      includeMaintainerAuthors: resolved.includeMaintainerAuthors,
      requireLinkedIssue: resolved.requireLinkedIssue,
      backfillEnabled: resolved.backfillEnabled,
      privateTrustEnabled: resolved.privateTrustEnabled,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: repositorySettings.repoFullName,
      set: {
        commentMode: resolved.commentMode,
        publicSignalLevel: resolved.publicSignalLevel,
        checkRunMode: resolved.checkRunMode,
        checkRunDetailLevel: resolved.checkRunDetailLevel,
        autoLabelEnabled: resolved.autoLabelEnabled,
        gittensorLabel: resolved.gittensorLabel,
        createMissingLabel: resolved.createMissingLabel,
        publicSurface: resolved.publicSurface,
        includeMaintainerAuthors: resolved.includeMaintainerAuthors,
        requireLinkedIssue: resolved.requireLinkedIssue,
        backfillEnabled: resolved.backfillEnabled,
        privateTrustEnabled: resolved.privateTrustEnabled,
        updatedAt: nowIso(),
      },
    });
  return getRepositorySettings(env, resolved.repoFullName);
}

export async function upsertRepoSyncState(env: Env, state: RepoSyncStateRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(repoSyncState)
    .values({
      repoFullName: state.repoFullName,
      status: state.status,
      sourceKind: state.sourceKind,
      primaryLanguage: state.primaryLanguage,
      defaultBranch: state.defaultBranch,
      isPrivate: state.isPrivate,
      openIssuesCount: state.openIssuesCount,
      openPullRequestsCount: state.openPullRequestsCount,
      recentMergedPullRequestsCount: state.recentMergedPullRequestsCount,
      labelsSyncedAt: state.labelsSyncedAt,
      issuesSyncedAt: state.issuesSyncedAt,
      pullRequestsSyncedAt: state.pullRequestsSyncedAt,
      mergedPullRequestsSyncedAt: state.mergedPullRequestsSyncedAt,
      lastStartedAt: state.lastStartedAt,
      lastCompletedAt: state.lastCompletedAt,
      errorSummary: state.errorSummary,
      warningsJson: jsonString(state.warnings),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: repoSyncState.repoFullName,
      set: {
        status: state.status,
        sourceKind: state.sourceKind,
        primaryLanguage: state.primaryLanguage,
        defaultBranch: state.defaultBranch,
        isPrivate: state.isPrivate,
        openIssuesCount: state.openIssuesCount,
        openPullRequestsCount: state.openPullRequestsCount,
        recentMergedPullRequestsCount: state.recentMergedPullRequestsCount,
        labelsSyncedAt: state.labelsSyncedAt,
        issuesSyncedAt: state.issuesSyncedAt,
        pullRequestsSyncedAt: state.pullRequestsSyncedAt,
        mergedPullRequestsSyncedAt: state.mergedPullRequestsSyncedAt,
        lastStartedAt: state.lastStartedAt,
        lastCompletedAt: state.lastCompletedAt,
        errorSummary: state.errorSummary,
        warningsJson: jsonString(state.warnings),
        updatedAt: nowIso(),
      },
    });
}

export async function getRepoSyncState(env: Env, fullName: string): Promise<RepoSyncStateRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(repoSyncState).where(eq(repoSyncState.repoFullName, fullName)).limit(1);
  return row ? toRepoSyncStateRecord(row) : null;
}

export async function listRepoSyncStates(env: Env): Promise<RepoSyncStateRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(repoSyncState).orderBy(desc(repoSyncState.updatedAt)).limit(500);
  return rows.map(toRepoSyncStateRecord);
}

export async function upsertRepoSyncSegment(env: Env, segment: RepoSyncSegmentRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(repoSyncSegments)
    .values({
      id: `${segment.repoFullName}#${segment.segment}`,
      repoFullName: segment.repoFullName,
      segment: segment.segment,
      status: segment.status,
      sourceKind: segment.sourceKind,
      mode: segment.mode,
      lastCursor: segment.lastCursor ?? null,
      nextCursor: segment.nextCursor ?? null,
      fetchedCount: segment.fetchedCount,
      expectedCount: segment.expectedCount ?? null,
      pageCount: segment.pageCount,
      startedAt: segment.startedAt ?? null,
      completedAt: segment.completedAt ?? null,
      staleAt: segment.staleAt ?? null,
      rateLimitResetAt: segment.rateLimitResetAt ?? null,
      etag: segment.etag ?? null,
      lastModified: segment.lastModified ?? null,
      warningsJson: jsonString(segment.warnings),
      errorSummary: segment.errorSummary ?? null,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [repoSyncSegments.repoFullName, repoSyncSegments.segment],
      set: {
        status: segment.status,
        sourceKind: segment.sourceKind,
        mode: segment.mode,
        lastCursor: segment.lastCursor ?? null,
        nextCursor: segment.nextCursor ?? null,
        fetchedCount: segment.fetchedCount,
        expectedCount: segment.expectedCount ?? null,
        pageCount: segment.pageCount,
        startedAt: segment.startedAt ?? null,
        completedAt: segment.completedAt ?? null,
        staleAt: segment.staleAt ?? null,
        rateLimitResetAt: segment.rateLimitResetAt ?? null,
        etag: segment.etag ?? null,
        lastModified: segment.lastModified ?? null,
        warningsJson: jsonString(segment.warnings),
        errorSummary: segment.errorSummary ?? null,
        updatedAt: nowIso(),
      },
    });
}

export async function getRepoSyncSegment(env: Env, fullName: string, segment: RepoSyncSegmentRecord["segment"]): Promise<RepoSyncSegmentRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select()
    .from(repoSyncSegments)
    .where(and(eq(repoSyncSegments.repoFullName, fullName), eq(repoSyncSegments.segment, segment)))
    .limit(1);
  return row ? toRepoSyncSegmentRecord(row) : null;
}

export async function listRepoSyncSegments(env: Env, fullName?: string): Promise<RepoSyncSegmentRecord[]> {
  const db = getDb(env.DB);
  const rows = fullName
    ? await db
        .select()
        .from(repoSyncSegments)
        .where(eq(repoSyncSegments.repoFullName, fullName))
        .orderBy(repoSyncSegments.repoFullName, repoSyncSegments.segment)
        .limit(500)
    : await db.select().from(repoSyncSegments).orderBy(repoSyncSegments.repoFullName, repoSyncSegments.segment).limit(2000);
  return rows.map(toRepoSyncSegmentRecord);
}

export async function recordGitHubRateLimitObservation(env: Env, observation: GitHubRateLimitObservationRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(githubRateLimitObservations).values({
    id: observation.id ?? crypto.randomUUID(),
    repoFullName: observation.repoFullName,
    resource: observation.resource,
    path: observation.path,
    statusCode: observation.statusCode,
    limitValue: observation.limitValue,
    remaining: observation.remaining,
    resetAt: observation.resetAt,
    observedAt: observation.observedAt ?? nowIso(),
  });
}

export async function listLatestGitHubRateLimitObservations(env: Env, limit = 50): Promise<GitHubRateLimitObservationRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(githubRateLimitObservations).orderBy(desc(githubRateLimitObservations.observedAt)).limit(limit);
  return rows.map(toGitHubRateLimitObservationRecord);
}

export async function persistRepoGithubTotalsSnapshot(env: Env, snapshot: RepoGithubTotalsSnapshotRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(repoGithubTotalsSnapshots).values({
    id: snapshot.id,
    repoFullName: snapshot.repoFullName,
    openIssuesTotal: snapshot.openIssuesTotal,
    openPullRequestsTotal: snapshot.openPullRequestsTotal,
    mergedPullRequestsTotal: snapshot.mergedPullRequestsTotal,
    closedUnmergedPullRequestsTotal: snapshot.closedUnmergedPullRequestsTotal,
    labelsTotal: snapshot.labelsTotal,
    sourceKind: snapshot.sourceKind,
    fetchedAt: snapshot.fetchedAt,
    rateLimitRemaining: snapshot.rateLimitRemaining,
    rateLimitResetAt: snapshot.rateLimitResetAt,
    payloadJson: jsonString(snapshot.payload),
  });
}

export async function getLatestRepoGithubTotalsSnapshot(env: Env, fullName: string): Promise<RepoGithubTotalsSnapshotRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select()
    .from(repoGithubTotalsSnapshots)
    .where(eq(repoGithubTotalsSnapshots.repoFullName, fullName))
    .orderBy(desc(repoGithubTotalsSnapshots.fetchedAt))
    .limit(1);
  return row ? toRepoGithubTotalsSnapshotRecord(row) : null;
}

export async function listLatestRepoGithubTotalsSnapshots(env: Env): Promise<RepoGithubTotalsSnapshotRecord[]> {
  const db = getDb(env.DB);
  const latestRows = await db
    .select({
      repoFullName: repoGithubTotalsSnapshots.repoFullName,
      fetchedAt: sql<string>`max(${repoGithubTotalsSnapshots.fetchedAt})`,
    })
    .from(repoGithubTotalsSnapshots)
    .groupBy(repoGithubTotalsSnapshots.repoFullName);
  const rows = [];
  for (const latest of latestRows) {
    const [row] = await db
      .select()
      .from(repoGithubTotalsSnapshots)
      .where(and(eq(repoGithubTotalsSnapshots.repoFullName, latest.repoFullName), eq(repoGithubTotalsSnapshots.fetchedAt, latest.fetchedAt)))
      .limit(1);
    if (row) rows.push(row);
  }
  return rows.map(toRepoGithubTotalsSnapshotRecord).sort((left, right) => left.repoFullName.localeCompare(right.repoFullName));
}

export async function upsertPullRequestDetailSyncState(env: Env, state: PullRequestDetailSyncStateRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(pullRequestDetailSyncState)
    .values({
      id: `${state.repoFullName}#${state.pullNumber}`,
      repoFullName: state.repoFullName,
      pullNumber: state.pullNumber,
      status: state.status,
      filesSyncedAt: state.filesSyncedAt,
      reviewsSyncedAt: state.reviewsSyncedAt,
      checksSyncedAt: state.checksSyncedAt,
      lastSyncedAt: state.lastSyncedAt,
      errorSummary: state.errorSummary,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [pullRequestDetailSyncState.repoFullName, pullRequestDetailSyncState.pullNumber],
      set: {
        status: state.status,
        filesSyncedAt: state.filesSyncedAt,
        reviewsSyncedAt: state.reviewsSyncedAt,
        checksSyncedAt: state.checksSyncedAt,
        lastSyncedAt: state.lastSyncedAt,
        errorSummary: state.errorSummary,
        updatedAt: nowIso(),
      },
    });
}

export async function listPullRequestDetailSyncStates(env: Env, fullName: string): Promise<PullRequestDetailSyncStateRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequestDetailSyncState).where(eq(pullRequestDetailSyncState.repoFullName, fullName)).limit(2000);
  return rows.map(toPullRequestDetailSyncStateRecord).sort((left, right) => left.pullNumber - right.pullNumber);
}

export async function listAllPullRequestDetailSyncStates(env: Env): Promise<PullRequestDetailSyncStateRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequestDetailSyncState).orderBy(pullRequestDetailSyncState.repoFullName, pullRequestDetailSyncState.pullNumber).limit(10000);
  return rows.map(toPullRequestDetailSyncStateRecord);
}

export async function persistScoringModelSnapshot(env: Env, snapshot: ScoringModelSnapshotRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(scoringModelSnapshots).values({
    id: snapshot.id,
    sourceKind: snapshot.sourceKind,
    sourceUrl: snapshot.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    activeModel: snapshot.activeModel,
    constantsJson: jsonString(snapshot.constants),
    programmingLanguagesJson: jsonString(snapshot.programmingLanguages),
    registrySnapshotId: snapshot.registrySnapshotId,
    warningsJson: jsonString(snapshot.warnings),
    payloadJson: jsonString(snapshot.payload),
  });
}

export async function getLatestScoringModelSnapshot(env: Env): Promise<ScoringModelSnapshotRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(scoringModelSnapshots).orderBy(desc(scoringModelSnapshots.fetchedAt)).limit(1);
  return row ? toScoringModelSnapshotRecord(row) : null;
}

export async function persistScorePreview(env: Env, preview: ScorePreviewRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(scorePreviews).values({
    id: preview.id,
    scoringModelSnapshotId: preview.scoringModelSnapshotId,
    repoFullName: preview.repoFullName,
    targetType: preview.targetType,
    targetKey: preview.targetKey,
    contributorLogin: preview.contributorLogin,
    inputJson: jsonString(preview.input),
    resultJson: jsonString(preview.result),
    generatedAt: preview.generatedAt,
  });
}

export async function getLatestScorePreview(env: Env, repoFullName: string, targetKey: string): Promise<ScorePreviewRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select()
    .from(scorePreviews)
    .where(and(eq(scorePreviews.repoFullName, repoFullName), eq(scorePreviews.targetKey, targetKey)))
    .orderBy(desc(scorePreviews.generatedAt))
    .limit(1);
  return row ? toScorePreviewRecord(row) : null;
}

export async function upsertContributorEvidence(env: Env, evidence: ContributorEvidenceRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(contributorEvidence)
    .values({ login: evidence.login, payloadJson: jsonString(evidence.payload), generatedAt: evidence.generatedAt })
    .onConflictDoUpdate({
      target: contributorEvidence.login,
      set: { payloadJson: jsonString(evidence.payload), generatedAt: evidence.generatedAt },
    });
}

export async function getContributorEvidence(env: Env, login: string): Promise<ContributorEvidenceRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(contributorEvidence).where(eq(contributorEvidence.login, login)).limit(1);
  return row ? { login: row.login, payload: parseJson(row.payloadJson, {}), generatedAt: row.generatedAt } : null;
}

export async function createAuthSession(env: Env, session: AuthSessionRecord): Promise<AuthSessionRecord> {
  const db = getDb(env.DB);
  await db.insert(authSessions).values({
    id: session.id,
    tokenHash: session.tokenHash,
    login: session.login,
    githubUserId: session.githubUserId,
    scopesJson: jsonString(session.scopes),
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    metadataJson: jsonString(session.metadata),
  });
  return session;
}

export async function getAuthSessionByTokenHash(env: Env, tokenHash: string): Promise<AuthSessionRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).limit(1);
  return row ? toAuthSessionRecord(row) : null;
}

export async function touchAuthSession(env: Env, sessionId: string): Promise<void> {
  const db = getDb(env.DB);
  await db.update(authSessions).set({ lastSeenAt: nowIso() }).where(eq(authSessions.id, sessionId));
}

export async function revokeAuthSession(env: Env, sessionId: string): Promise<void> {
  const db = getDb(env.DB);
  await db.update(authSessions).set({ revokedAt: nowIso(), lastSeenAt: nowIso() }).where(eq(authSessions.id, sessionId));
}

export async function recordAuditEvent(env: Env, event: AuditEventRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(auditEvents).values({
    id: event.id ?? crypto.randomUUID(),
    eventType: event.eventType,
    actor: event.actor,
    route: event.route,
    targetKey: event.targetKey,
    outcome: event.outcome,
    detail: event.detail,
    metadataJson: jsonString(event.metadata ?? {}),
    createdAt: event.createdAt ?? nowIso(),
  });
}

export async function hasRecentAuditEvent(env: Env, actor: string, eventType: string, sinceIso: string): Promise<boolean> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.actor, actor), eq(auditEvents.eventType, eventType), gte(auditEvents.createdAt, sinceIso)))
    .limit(1);
  return rows.length > 0;
}

export async function getFreshOfficialMinerDetection(env: Env, login: string, now = nowIso()): Promise<OfficialGittensorMinerDetection | null> {
  const [row] = await getDb(env.DB).select().from(officialMinerDetections).where(and(eq(officialMinerDetections.login, login.toLowerCase()), gte(officialMinerDetections.expiresAt, now))).limit(1);
  return row ? toOfficialMinerDetection(row) : null;
}

export async function upsertOfficialMinerDetection(env: Env, login: string, detection: OfficialGittensorMinerDetection, ttlMs: number, fetchedAtMs = Date.now()): Promise<void> {
  const fetchedAt = new Date(fetchedAtMs).toISOString();
  const cacheableDetection = toCacheableOfficialMinerDetection(detection);
  const values = {
    login: login.toLowerCase(), status: cacheableDetection.status,
    snapshotJson: cacheableDetection.status === "confirmed" ? jsonString(cacheableDetection.snapshot) : "{}",
    error: cacheableDetection.status === "unavailable" ? cacheableDetection.error : null, fetchedAt,
    expiresAt: new Date(fetchedAtMs + ttlMs).toISOString(), updatedAt: fetchedAt,
  };
  await getDb(env.DB).insert(officialMinerDetections).values(values).onConflictDoUpdate({ target: officialMinerDetections.login, set: values });
}

function toCacheableOfficialMinerDetection(detection: OfficialGittensorMinerDetection): OfficialGittensorMinerDetection {
  return detection.status === "confirmed" ? { status: "confirmed", snapshot: toCacheableGittensorSnapshot(detection.snapshot) } : detection;
}

function toCacheableGittensorSnapshot(snapshot: Partial<GittensorContributorSnapshot>): GittensorContributorSnapshot {
  return {
    source: "gittensor_api",
    githubId: String(snapshot.githubId ?? ""),
    githubUsername: String(snapshot.githubUsername ?? ""),
    uid: optionalNumber(snapshot.uid),
    failedReason: typeof snapshot.failedReason === "string" ? snapshot.failedReason : snapshot.failedReason === null ? null : undefined,
    evaluatedAt: typeof snapshot.evaluatedAt === "string" ? snapshot.evaluatedAt : undefined,
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : undefined,
    isEligible: Boolean(snapshot.isEligible),
    credibility: finiteNumber(snapshot.credibility),
    eligibleRepoCount: finiteNumber(snapshot.eligibleRepoCount),
    issueDiscoveryScore: finiteNumber(snapshot.issueDiscoveryScore),
    issueTokenScore: finiteNumber(snapshot.issueTokenScore),
    issueCredibility: finiteNumber(snapshot.issueCredibility),
    isIssueEligible: Boolean(snapshot.isIssueEligible),
    issueEligibleRepoCount: finiteNumber(snapshot.issueEligibleRepoCount),
    alphaPerDay: finiteNumber(snapshot.alphaPerDay),
    taoPerDay: finiteNumber(snapshot.taoPerDay),
    usdPerDay: finiteNumber(snapshot.usdPerDay),
    totals: {
      pullRequests: finiteNumber(snapshot.totals?.pullRequests),
      mergedPullRequests: finiteNumber(snapshot.totals?.mergedPullRequests),
      openPullRequests: finiteNumber(snapshot.totals?.openPullRequests),
      closedPullRequests: finiteNumber(snapshot.totals?.closedPullRequests),
      openIssues: finiteNumber(snapshot.totals?.openIssues),
      closedIssues: finiteNumber(snapshot.totals?.closedIssues),
      solvedIssues: finiteNumber(snapshot.totals?.solvedIssues),
      validSolvedIssues: finiteNumber(snapshot.totals?.validSolvedIssues),
    },
    repositories: Array.isArray(snapshot.repositories)
      ? snapshot.repositories.map((repo) => ({
          repoFullName: String(repo.repoFullName ?? ""),
          pullRequests: finiteNumber(repo.pullRequests),
          mergedPullRequests: finiteNumber(repo.mergedPullRequests),
          openPullRequests: finiteNumber(repo.openPullRequests),
          closedPullRequests: finiteNumber(repo.closedPullRequests),
          openIssues: finiteNumber(repo.openIssues),
          closedIssues: finiteNumber(repo.closedIssues),
          solvedIssues: finiteNumber(repo.solvedIssues),
          validSolvedIssues: finiteNumber(repo.validSolvedIssues),
          isEligible: Boolean(repo.isEligible),
          isIssueEligible: Boolean(repo.isIssueEligible),
          credibility: finiteNumber(repo.credibility),
          issueCredibility: finiteNumber(repo.issueCredibility),
          totalScore: finiteNumber(repo.totalScore),
          baseTotalScore: finiteNumber(repo.baseTotalScore),
        }))
      : [],
    pullRequests: Array.isArray(snapshot.pullRequests)
      ? snapshot.pullRequests.map((pr) => ({
          repoFullName: String(pr.repoFullName ?? ""),
          number: finiteNumber(pr.number),
          title: String(pr.title ?? ""),
          state: String(pr.state ?? ""),
          mergedAt: typeof pr.mergedAt === "string" ? pr.mergedAt : pr.mergedAt === null ? null : undefined,
          label: typeof pr.label === "string" ? pr.label : pr.label === null ? null : undefined,
          score: finiteNumber(pr.score),
          baseScore: finiteNumber(pr.baseScore),
          tokenScore: finiteNumber(pr.tokenScore),
        }))
      : [],
    issueLabels: Array.isArray(snapshot.issueLabels) ? snapshot.issueLabels.filter((label): label is string => typeof label === "string") : [],
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function recordAiUsageEvent(
  env: Env,
  event: {
    feature: string;
    actor?: string | null | undefined;
    route?: string | null | undefined;
    model: string;
    status: string;
    estimatedNeurons: number;
    detail?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(aiUsageEvents).values({
    id: crypto.randomUUID(),
    feature: event.feature,
    actor: event.actor ?? null,
    route: event.route ?? null,
    model: event.model,
    status: event.status,
    estimatedNeurons: Math.max(0, Math.round(event.estimatedNeurons)),
    detail: event.detail ?? null,
    metadataJson: jsonString(event.metadata ?? {}),
    createdAt: nowIso(),
  });
}

export async function sumAiEstimatedNeuronsSince(env: Env, sinceIso: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${aiUsageEvents.estimatedNeurons}), 0)` })
    .from(aiUsageEvents)
    .where(and(gte(aiUsageEvents.createdAt, sinceIso), eq(aiUsageEvents.status, "ok")));
  return Number(row?.total ?? 0);
}

export async function upsertContributorScoringProfile(env: Env, profile: ContributorScoringProfileRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(contributorScoringProfiles)
    .values({
      login: profile.login,
      scoringModelSnapshotId: profile.scoringModelSnapshotId,
      payloadJson: jsonString(profile.payload),
      generatedAt: profile.generatedAt,
    })
    .onConflictDoUpdate({
      target: contributorScoringProfiles.login,
      set: {
        scoringModelSnapshotId: profile.scoringModelSnapshotId,
        payloadJson: jsonString(profile.payload),
        generatedAt: profile.generatedAt,
      },
    });
}

export async function getContributorScoringProfile(env: Env, login: string): Promise<ContributorScoringProfileRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(contributorScoringProfiles).where(eq(contributorScoringProfiles.login, login)).limit(1);
  return row
    ? { login: row.login, scoringModelSnapshotId: row.scoringModelSnapshotId, payload: parseJson(row.payloadJson, {}), generatedAt: row.generatedAt }
    : null;
}

export async function upsertIssueQualityReport(env: Env, report: IssueQualityReportRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(issueQualityReports)
    .values({
      id: report.id,
      repoFullName: report.repoFullName,
      issueNumber: report.issueNumber,
      payloadJson: jsonString(report.payload),
      generatedAt: report.generatedAt,
    })
    .onConflictDoUpdate({
      target: [issueQualityReports.repoFullName, issueQualityReports.issueNumber],
      set: { payloadJson: jsonString(report.payload), generatedAt: report.generatedAt },
    });
}

export async function upsertBurdenForecast(env: Env, forecast: BurdenForecastRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(burdenForecasts)
    .values({ repoFullName: forecast.repoFullName, payloadJson: jsonString(forecast.payload), generatedAt: forecast.generatedAt })
    .onConflictDoUpdate({
      target: burdenForecasts.repoFullName,
      set: { payloadJson: jsonString(forecast.payload), generatedAt: forecast.generatedAt },
    });
}

export async function persistRegistryDriftEvents(env: Env, events: RegistryDriftEventRecord[]): Promise<void> {
  const db = getDb(env.DB);
  for (const event of events) {
    await db.insert(registryDriftEvents).values({
      id: event.id,
      repoFullName: event.repoFullName,
      driftType: event.driftType,
      detail: event.detail,
      previousSnapshotId: event.previousSnapshotId,
      currentSnapshotId: event.currentSnapshotId,
      payloadJson: jsonString(event.payload),
      generatedAt: event.generatedAt,
    });
  }
}

export async function persistBountyLifecycleEvent(env: Env, event: BountyLifecycleEventRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(bountyLifecycleEvents).values({
    id: event.id,
    bountyId: event.bountyId,
    repoFullName: event.repoFullName,
    issueNumber: event.issueNumber,
    status: event.status,
    payloadJson: jsonString(event.payload),
    generatedAt: event.generatedAt,
  });
}

export async function upsertRepoLabel(env: Env, label: RepoLabelRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(repoLabels)
    .values({
      id: `${label.repoFullName}#${label.name.toLowerCase()}`,
      repoFullName: label.repoFullName,
      name: label.name,
      color: label.color,
      description: label.description,
      isConfigured: label.isConfigured,
      observedCount: label.observedCount,
      payloadJson: jsonString(label.payload),
      lastSeenAt: label.lastSeenAt ?? nowIso(),
    })
    .onConflictDoUpdate({
      target: [repoLabels.repoFullName, repoLabels.name],
      set: {
        color: label.color,
        description: label.description,
        isConfigured: label.isConfigured,
        observedCount: label.observedCount,
        payloadJson: jsonString(label.payload),
        lastSeenAt: label.lastSeenAt ?? nowIso(),
      },
    });
}

export async function listRepoLabels(env: Env, fullName: string): Promise<RepoLabelRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(repoLabels).where(eq(repoLabels.repoFullName, fullName)).limit(500);
  return rows.map(toRepoLabelRecord).sort((left, right) => left.name.localeCompare(right.name));
}

export async function countRepoLabels(env: Env, fullName: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(repoLabels).where(eq(repoLabels.repoFullName, fullName));
  return Number(row?.count ?? 0);
}

export async function persistRepoSnapshot(env: Env, snapshot: RepoSnapshotRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(repoSnapshots).values({
    id: snapshot.id,
    repoFullName: snapshot.repoFullName,
    snapshotKind: snapshot.snapshotKind,
    sourceKind: snapshot.sourceKind,
    fetchedAt: snapshot.fetchedAt,
    primaryLanguage: snapshot.primaryLanguage,
    defaultBranch: snapshot.defaultBranch,
    openIssuesCount: snapshot.openIssuesCount,
    openPullRequestsCount: snapshot.openPullRequestsCount,
    recentMergedPullRequestsCount: snapshot.recentMergedPullRequestsCount,
    payloadJson: jsonString(snapshot.payload),
  });
}

export async function getPullRequest(env: Env, fullName: string, number: number): Promise<PullRequestRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number)))
    .limit(1);
  return row ? toPullRequestRecordFromRow(row) : null;
}

export async function getIssue(env: Env, fullName: string, number: number): Promise<IssueRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(issues).where(and(eq(issues.repoFullName, fullName), eq(issues.number, number))).limit(1);
  return row ? toIssueRecordFromRow(row) : null;
}

export async function listOpenIssues(env: Env, fullName: string): Promise<IssueRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(issues).where(and(eq(issues.repoFullName, fullName), eq(issues.state, "open"))).orderBy(desc(issues.updatedAt)).limit(10000);
  return rows.map(toIssueRecordFromRow);
}

export async function countOpenIssues(env: Env, fullName: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(issues).where(and(eq(issues.repoFullName, fullName), eq(issues.state, "open")));
  return Number(row?.count ?? 0);
}

export async function listOpenIssueNumbers(env: Env, fullName: string): Promise<number[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ number: issues.number })
    .from(issues)
    .where(and(eq(issues.repoFullName, fullName), eq(issues.state, "open")))
    .limit(10000);
  return rows.map((row) => row.number);
}

export async function listIssueSignalSample(env: Env, fullName: string, limit = 400): Promise<IssueRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.repoFullName, fullName), eq(issues.state, "open")))
    .orderBy(desc(issues.updatedAt))
    .limit(limit);
  return rows.map(toIssueRecordFromRow);
}

export async function markUnseenOpenIssuesClosed(env: Env, fullName: string, seenOpenAt: string): Promise<number> {
  const db = getDb(env.DB);
  const result = await db
    .update(issues)
    .set({ state: "closed", updatedAt: nowIso() })
    .where(sql`${issues.repoFullName} = ${fullName} AND ${issues.state} = 'open' AND (${issues.lastSeenOpenAt} IS NULL OR ${issues.lastSeenOpenAt} < ${seenOpenAt})`);
  return Number(result.meta.changes ?? 0);
}

export async function listIssues(env: Env, fullName: string): Promise<IssueRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(issues).where(eq(issues.repoFullName, fullName)).limit(500);
  return rows.map(toIssueRecordFromRow);
}

export async function listAllIssues(env: Env): Promise<IssueRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(issues).limit(2000);
  return rows.map(toIssueRecordFromRow);
}

export async function listOpenPullRequests(env: Env, fullName: string): Promise<PullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequests).where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.state, "open"))).limit(10000);
  return rows.map(toPullRequestRecordFromRow);
}

export async function countOpenPullRequests(env: Env, fullName: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(pullRequests).where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.state, "open")));
  return Number(row?.count ?? 0);
}

export async function markUnseenOpenPullRequestsClosed(env: Env, fullName: string, seenOpenAt: string): Promise<number> {
  const db = getDb(env.DB);
  const result = await db
    .update(pullRequests)
    .set({ state: "closed", updatedAt: nowIso() })
    .where(
      sql`${pullRequests.repoFullName} = ${fullName} AND ${pullRequests.state} = 'open' AND (${pullRequests.lastSeenOpenAt} IS NULL OR ${pullRequests.lastSeenOpenAt} < ${seenOpenAt})`,
    );
  return Number(result.meta.changes ?? 0);
}

export async function listPullRequests(env: Env, fullName: string): Promise<PullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequests).where(eq(pullRequests.repoFullName, fullName)).limit(500);
  return rows.map(toPullRequestRecordFromRow);
}

export async function listAllPullRequests(env: Env): Promise<PullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequests).limit(2000);
  return rows.map(toPullRequestRecordFromRow);
}

export async function listOtherOpenPullRequests(env: Env, fullName: string, number: number): Promise<PullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.state, "open"), not(eq(pullRequests.number, number))))
    .limit(100);
  return rows.map(toPullRequestRecordFromRow);
}

export async function listContributorPullRequests(env: Env, login: string): Promise<PullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequests).where(loginMatches(pullRequests.authorLogin, login)).limit(1000);
  return rows.map(toPullRequestRecordFromRow);
}

export async function listContributorIssues(env: Env, login: string): Promise<IssueRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(issues).where(loginMatches(issues.authorLogin, login)).limit(1000);
  return rows.map(toIssueRecordFromRow);
}

export async function upsertPullRequestFile(env: Env, file: PullRequestFileRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(pullRequestFiles)
    .values({
      id: `${file.repoFullName}#${file.pullNumber}#${file.path}`,
      repoFullName: file.repoFullName,
      pullNumber: file.pullNumber,
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      previousFilename: file.previousFilename,
      payloadJson: jsonString(file.payload),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [pullRequestFiles.repoFullName, pullRequestFiles.pullNumber, pullRequestFiles.path],
      set: {
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        previousFilename: file.previousFilename,
        payloadJson: jsonString(file.payload),
        updatedAt: nowIso(),
      },
    });
}

export async function listPullRequestFiles(env: Env, fullName: string, pullNumber: number): Promise<PullRequestFileRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(pullRequestFiles)
    .where(and(eq(pullRequestFiles.repoFullName, fullName), eq(pullRequestFiles.pullNumber, pullNumber)))
    .limit(500);
  return rows.map(toPullRequestFileRecord);
}

export async function upsertPullRequestReview(env: Env, review: PullRequestReviewRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(pullRequestReviews)
    .values({
      id: review.id,
      repoFullName: review.repoFullName,
      pullNumber: review.pullNumber,
      reviewerLogin: review.reviewerLogin,
      state: review.state,
      authorAssociation: review.authorAssociation,
      submittedAt: review.submittedAt,
      payloadJson: jsonString(review.payload),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: pullRequestReviews.id,
      set: {
        reviewerLogin: review.reviewerLogin,
        state: review.state,
        authorAssociation: review.authorAssociation,
        submittedAt: review.submittedAt,
        payloadJson: jsonString(review.payload),
        updatedAt: nowIso(),
      },
    });
}

export async function listPullRequestReviews(env: Env, fullName: string, pullNumber: number): Promise<PullRequestReviewRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(pullRequestReviews)
    .where(and(eq(pullRequestReviews.repoFullName, fullName), eq(pullRequestReviews.pullNumber, pullNumber)))
    .limit(500);
  return rows.map(toPullRequestReviewRecord);
}

export async function upsertCheckSummary(env: Env, check: CheckSummaryRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(checkSummaries)
    .values({
      id: check.id,
      repoFullName: check.repoFullName,
      pullNumber: check.pullNumber,
      headSha: check.headSha,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      detailsUrl: check.detailsUrl,
      payloadJson: jsonString(check.payload),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [checkSummaries.repoFullName, checkSummaries.headSha, checkSummaries.name],
      set: {
        pullNumber: check.pullNumber,
        status: check.status,
        conclusion: check.conclusion,
        startedAt: check.startedAt,
        completedAt: check.completedAt,
        detailsUrl: check.detailsUrl,
        payloadJson: jsonString(check.payload),
        updatedAt: nowIso(),
      },
    });
}

export async function listCheckSummaries(env: Env, fullName: string, pullNumber: number): Promise<CheckSummaryRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(checkSummaries)
    .where(and(eq(checkSummaries.repoFullName, fullName), eq(checkSummaries.pullNumber, pullNumber)))
    .limit(500);
  return rows.map(toCheckSummaryRecord);
}

export async function upsertRecentMergedPullRequest(env: Env, pr: RecentMergedPullRequestRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(recentMergedPullRequests)
    .values({
      id: `${pr.repoFullName}#${pr.number}`,
      repoFullName: pr.repoFullName,
      number: pr.number,
      title: pr.title,
      authorLogin: pr.authorLogin,
      htmlUrl: pr.htmlUrl,
      mergedAt: pr.mergedAt,
      labelsJson: jsonString(pr.labels),
      linkedIssuesJson: jsonString(pr.linkedIssues),
      changedFilesJson: jsonString(pr.changedFiles),
      payloadJson: jsonString(pr.payload),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [recentMergedPullRequests.repoFullName, recentMergedPullRequests.number],
      set: {
        title: pr.title,
        authorLogin: pr.authorLogin,
        htmlUrl: pr.htmlUrl,
        mergedAt: pr.mergedAt,
        labelsJson: jsonString(pr.labels),
        linkedIssuesJson: jsonString(pr.linkedIssues),
        changedFilesJson: jsonString(pr.changedFiles),
        payloadJson: jsonString(pr.payload),
        updatedAt: nowIso(),
      },
    });
}

export async function listRecentMergedPullRequests(env: Env, fullName: string): Promise<RecentMergedPullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(recentMergedPullRequests)
    .where(eq(recentMergedPullRequests.repoFullName, fullName))
    .orderBy(desc(recentMergedPullRequests.mergedAt))
    .limit(200);
  return rows.map(toRecentMergedPullRequestRecord);
}

export async function countRecentMergedPullRequests(env: Env, fullName: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(recentMergedPullRequests).where(eq(recentMergedPullRequests.repoFullName, fullName));
  return Number(row?.count ?? 0);
}

export async function listContributorRecentMergedPullRequests(env: Env, login: string): Promise<RecentMergedPullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(recentMergedPullRequests)
    .where(loginMatches(recentMergedPullRequests.authorLogin, login))
    .orderBy(desc(recentMergedPullRequests.mergedAt))
    .limit(1000);
  return rows.map(toRecentMergedPullRequestRecord);
}

export async function upsertContributor(env: Env, contributor: ContributorRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(contributors)
    .values({
      login: contributor.login,
      githubProfileJson: jsonString(contributor.githubProfile),
      topLanguagesJson: jsonString(contributor.topLanguages),
      publicRepos: contributor.publicRepos,
      followers: contributor.followers,
      source: contributor.source,
      lastSeenAt: contributor.lastSeenAt ?? nowIso(),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: contributors.login,
      set: {
        githubProfileJson: jsonString(contributor.githubProfile),
        topLanguagesJson: jsonString(contributor.topLanguages),
        publicRepos: contributor.publicRepos,
        followers: contributor.followers,
        source: contributor.source,
        lastSeenAt: contributor.lastSeenAt ?? nowIso(),
        updatedAt: nowIso(),
      },
    });
}

export async function upsertContributorRepoStat(env: Env, stat: ContributorRepoStatRecord): Promise<void> {
  const db = getDb(env.DB);
  const login = stat.login.toLowerCase();
  await db
    .insert(contributorRepoStats)
    .values({
      id: `${login}#${stat.repoFullName}`,
      login,
      repoFullName: stat.repoFullName,
      pullRequests: stat.pullRequests,
      mergedPullRequests: stat.mergedPullRequests,
      openPullRequests: stat.openPullRequests,
      issues: stat.issues,
      stalePullRequests: stat.stalePullRequests,
      unlinkedPullRequests: stat.unlinkedPullRequests,
      dominantLabelsJson: jsonString(stat.dominantLabels),
      lastActivityAt: stat.lastActivityAt,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [contributorRepoStats.login, contributorRepoStats.repoFullName],
      set: {
        pullRequests: stat.pullRequests,
        mergedPullRequests: stat.mergedPullRequests,
        openPullRequests: stat.openPullRequests,
        issues: stat.issues,
        stalePullRequests: stat.stalePullRequests,
        unlinkedPullRequests: stat.unlinkedPullRequests,
        dominantLabelsJson: jsonString(stat.dominantLabels),
        lastActivityAt: stat.lastActivityAt,
        updatedAt: nowIso(),
      },
    });
}

export async function listContributorRepoStats(env: Env, login: string): Promise<ContributorRepoStatRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(contributorRepoStats).where(loginMatches(contributorRepoStats.login, login)).limit(500);
  return mergeContributorRepoStats(rows.map(toContributorRepoStatRecord));
}

export async function listBounties(env: Env): Promise<BountyRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(bounties).orderBy(desc(bounties.updatedAt)).limit(1000);
  return rows.map(toBountyRecord);
}

export async function getBounty(env: Env, id: string): Promise<BountyRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(bounties).where(eq(bounties.id, id)).limit(1);
  return row ? toBountyRecord(row) : null;
}

export async function upsertBounty(env: Env, bounty: BountyRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(bounties)
    .values({
      id: bounty.id,
      repoFullName: bounty.repoFullName,
      issueNumber: bounty.issueNumber,
      status: bounty.status,
      amountText: bounty.amountText,
      sourceUrl: bounty.sourceUrl,
      payloadJson: jsonString(bounty.payload),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: bounties.id,
      set: {
        repoFullName: bounty.repoFullName,
        issueNumber: bounty.issueNumber,
        status: bounty.status,
        amountText: bounty.amountText,
        sourceUrl: bounty.sourceUrl,
        payloadJson: jsonString(bounty.payload),
        updatedAt: nowIso(),
      },
    });
}

export async function persistAdvisory(env: Env, advisory: Advisory): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(advisories).values({
    id: advisory.id,
    targetType: advisory.targetType,
    targetKey: advisory.targetKey,
    repoFullName: advisory.repoFullName,
    pullNumber: advisory.pullNumber,
    issueNumber: advisory.issueNumber,
    headSha: advisory.headSha,
    conclusion: advisory.conclusion,
    severity: advisory.severity,
    title: advisory.title,
    summary: advisory.summary,
    findingsJson: jsonString(advisory.findings as unknown as Record<string, unknown>[]),
    updatedAt: nowIso(),
  });
}

export async function replaceCollisionEdges(env: Env, repoFullName: string, edges: CollisionEdgeRecord[]): Promise<void> {
  const db = getDb(env.DB);
  await env.DB.prepare("DELETE FROM collision_edges WHERE repo_full_name = ?").bind(repoFullName).run();
  const limitedEdges = edges.slice(0, 40);
  for (const edge of limitedEdges) {
    await db.insert(collisionEdges).values({
      id: edge.id,
      repoFullName: edge.repoFullName,
      leftType: edge.leftType,
      leftNumber: edge.leftNumber,
      leftTitle: edge.leftTitle,
      rightType: edge.rightType,
      rightNumber: edge.rightNumber,
      rightTitle: edge.rightTitle,
      risk: edge.risk,
      reason: edge.reason,
      sharedTermsJson: jsonString(edge.sharedTerms),
      generatedAt: edge.generatedAt ?? nowIso(),
    });
  }
}

export async function listCollisionEdges(env: Env, repoFullName: string): Promise<CollisionEdgeRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(collisionEdges).where(eq(collisionEdges.repoFullName, repoFullName)).limit(1000);
  return rows.map(toCollisionEdgeRecord);
}

export async function persistSignalSnapshot(env: Env, snapshot: SignalSnapshotRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(signalSnapshots).values({
    id: snapshot.id,
    signalType: snapshot.signalType,
    targetKey: snapshot.targetKey,
    repoFullName: snapshot.repoFullName,
    payloadJson: jsonString(snapshot.payload),
    generatedAt: snapshot.generatedAt ?? nowIso(),
  });
}

export async function listSignalSnapshots(env: Env, signalType: string, targetKey: string): Promise<SignalSnapshotRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(signalSnapshots)
    .where(and(eq(signalSnapshots.signalType, signalType), eq(signalSnapshots.targetKey, targetKey)))
    .orderBy(desc(signalSnapshots.generatedAt))
    .limit(100);
  return rows.map(toSignalSnapshotRecord);
}

export async function listLatestSignalSnapshotsByTarget(env: Env): Promise<SignalSnapshotRecord[]> {
  const { results } = await env.DB.prepare(
    `
      SELECT id, signal_type, target_key, repo_full_name, payload_json, generated_at
      FROM (
        SELECT
          id,
          signal_type,
          target_key,
          repo_full_name,
          payload_json,
          generated_at,
          row_number() OVER (
            PARTITION BY signal_type, target_key
            ORDER BY generated_at DESC, id DESC
          ) AS snapshot_rank
        FROM signal_snapshots
      )
      WHERE snapshot_rank = 1
      ORDER BY signal_type, target_key
    `,
  ).all<{ id: string; signal_type: string; target_key: string; repo_full_name: string | null; payload_json: string; generated_at: string }>();
  return results.map((row) => ({
    id: row.id,
    signalType: row.signal_type,
    targetKey: row.target_key,
    repoFullName: row.repo_full_name,
    payload: parseJson<Record<string, never>>(row.payload_json, {}),
    generatedAt: row.generated_at,
  }));
}

export async function createAgentRun(env: Env, run: AgentRunRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(agentRuns).values({
    id: run.id,
    objective: run.objective,
    actorLogin: run.actorLogin,
    surface: run.surface,
    mode: run.mode,
    status: run.status,
    dataQualityStatus: run.dataQualityStatus,
    errorSummary: run.errorSummary ?? null,
    payloadJson: jsonString(run.payload),
    createdAt: run.createdAt ?? nowIso(),
    updatedAt: run.updatedAt ?? nowIso(),
  });
}

export async function updateAgentRun(
  env: Env,
  runId: string,
  patch: Partial<Pick<AgentRunRecord, "status" | "dataQualityStatus" | "errorSummary" | "payload">>,
): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(agentRuns)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.dataQualityStatus ? { dataQualityStatus: patch.dataQualityStatus } : {}),
      ...(patch.errorSummary !== undefined ? { errorSummary: patch.errorSummary } : {}),
      ...(patch.payload ? { payloadJson: jsonString(patch.payload) } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(agentRuns.id, runId));
}

export async function getAgentRun(env: Env, runId: string): Promise<AgentRunRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return row ? toAgentRunRecord(row) : null;
}

export async function listAgentActions(env: Env, runId: string): Promise<AgentActionRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(agentActions).where(eq(agentActions.runId, runId)).orderBy(agentActions.createdAt).limit(100);
  return rows.map(toAgentActionRecord);
}

export async function replaceAgentActions(env: Env, runId: string, actions: AgentActionRecord[]): Promise<void> {
  const db = getDb(env.DB);
  await db.delete(agentActions).where(eq(agentActions.runId, runId));
  for (const action of actions) {
    await db.insert(agentActions).values({
      id: action.id,
      runId,
      actionType: action.actionType,
      targetRepoFullName: action.targetRepoFullName ?? null,
      targetPullNumber: action.targetPullNumber ?? null,
      targetIssueNumber: action.targetIssueNumber ?? null,
      status: action.status,
      recommendation: action.recommendation,
      whyJson: jsonString(action.why),
      scoreabilityImpact: action.scoreabilityImpact ?? null,
      riskImpact: action.riskImpact ?? null,
      maintainerImpact: action.maintainerImpact ?? null,
      blockedByJson: jsonString(action.blockedBy),
      rerunWhen: action.rerunWhen ?? null,
      publicSafeSummary: action.publicSafeSummary,
      approvalRequired: action.approvalRequired,
      safetyClass: action.safetyClass,
      payloadJson: jsonString(action.payload),
      createdAt: action.createdAt ?? nowIso(),
    });
  }
}

export async function persistAgentContextSnapshot(env: Env, snapshot: AgentContextSnapshotRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(agentContextSnapshots).values({
    id: snapshot.id,
    runId: snapshot.runId,
    decisionPackVersion: snapshot.decisionPackVersion ?? null,
    repoSignalSnapshotIdsJson: jsonString(snapshot.repoSignalSnapshotIds),
    scoringModelId: snapshot.scoringModelId ?? null,
    freshnessWarningsJson: jsonString(snapshot.freshnessWarnings),
    payloadJson: jsonString(snapshot.payload),
    createdAt: snapshot.createdAt ?? nowIso(),
  });
}

export async function listAgentContextSnapshots(env: Env, runId: string): Promise<AgentContextSnapshotRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(agentContextSnapshots).where(eq(agentContextSnapshots.runId, runId)).orderBy(desc(agentContextSnapshots.createdAt)).limit(50);
  return rows.map(toAgentContextSnapshotRecord);
}

export async function upsertInstallationHealth(env: Env, health: InstallationHealthRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(installationHealth)
    .values({
      installationId: health.installationId,
      accountLogin: health.accountLogin,
      repositorySelection: health.repositorySelection,
      installedReposCount: health.installedReposCount,
      registeredInstalledCount: health.registeredInstalledCount,
      status: health.status,
      missingPermissionsJson: jsonString(health.missingPermissions),
      missingEventsJson: jsonString(health.missingEvents),
      permissionsJson: jsonString(health.permissions),
      eventsJson: jsonString(health.events),
      checkedAt: health.checkedAt,
      errorSummary: health.errorSummary ?? null,
    })
    .onConflictDoUpdate({
      target: installationHealth.installationId,
      set: {
        accountLogin: health.accountLogin,
        repositorySelection: health.repositorySelection,
        installedReposCount: health.installedReposCount,
        registeredInstalledCount: health.registeredInstalledCount,
        status: health.status,
        missingPermissionsJson: jsonString(health.missingPermissions),
        missingEventsJson: jsonString(health.missingEvents),
        permissionsJson: jsonString(health.permissions),
        eventsJson: jsonString(health.events),
        checkedAt: health.checkedAt,
        errorSummary: health.errorSummary ?? null,
      },
    });
}

export async function listInstallationHealth(env: Env): Promise<InstallationHealthRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(installationHealth).orderBy(desc(installationHealth.checkedAt)).limit(100);
  return rows.map(toInstallationHealthRecord);
}

export async function getInstallationHealth(env: Env, installationId: number): Promise<InstallationHealthRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(installationHealth).where(eq(installationHealth.installationId, installationId)).limit(1);
  return row ? toInstallationHealthRecord(row) : null;
}

export async function recordWebhookEvent(
  env: Env,
  args: {
    deliveryId: string;
    eventName: string;
    action?: string | undefined;
    installationId?: number | undefined;
    repositoryFullName?: string | undefined;
    payloadHash: string;
    status: "queued" | "processed" | "error";
    errorSummary?: string;
  },
): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(webhookEvents)
    .values({
      deliveryId: args.deliveryId,
      eventName: args.eventName,
      action: args.action,
      installationId: args.installationId,
      repositoryFullName: args.repositoryFullName,
      payloadHash: args.payloadHash,
      status: args.status,
      errorSummary: args.errorSummary,
      processedAt: args.status === "processed" || args.status === "error" ? nowIso() : undefined,
    })
    .onConflictDoUpdate({
      target: webhookEvents.deliveryId,
      set: {
        status: args.status,
        errorSummary: args.errorSummary,
        processedAt: args.status === "processed" || args.status === "error" ? nowIso() : undefined,
      },
    });
}

export async function getWebhookEvent(
  env: Env,
  deliveryId: string,
): Promise<{
  deliveryId: string;
  payloadHash: string;
  status: string;
} | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.deliveryId, deliveryId)).limit(1);
  if (!row) return null;
  return {
    deliveryId: row.deliveryId,
    payloadHash: row.payloadHash,
    status: row.status,
  };
}

function toInstallationRecord(row: typeof installations.$inferSelect): InstallationRecord {
  return {
    id: row.id,
    accountLogin: row.accountLogin,
    accountId: row.accountId,
    targetType: row.targetType,
    repositorySelection: row.repositorySelection,
    permissions: parseJson<Record<string, string>>(row.permissionsJson, {}),
    events: parseJson<string[]>(row.eventsJson, []),
    suspendedAt: row.suspendedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRepositoryRecord(row: typeof repositories.$inferSelect): RepositoryRecord {
  return {
    fullName: row.fullName,
    owner: row.owner,
    name: row.name,
    installationId: row.installationId,
    isInstalled: row.isInstalled,
    isRegistered: row.isRegistered,
    isPrivate: row.isPrivate,
    htmlUrl: row.htmlUrl,
    defaultBranch: row.defaultBranch,
    registryConfig: parseJson<RegistryRepoConfig | null>(row.registryConfigJson, null),
  };
}

function toRepoSyncStateRecord(row: typeof repoSyncState.$inferSelect): RepoSyncStateRecord {
  return {
    repoFullName: row.repoFullName,
    status: parseSyncStatus(row.status),
    sourceKind: parseSyncSourceKind(row.sourceKind),
    primaryLanguage: row.primaryLanguage,
    defaultBranch: row.defaultBranch,
    isPrivate: row.isPrivate,
    openIssuesCount: row.openIssuesCount,
    openPullRequestsCount: row.openPullRequestsCount,
    recentMergedPullRequestsCount: row.recentMergedPullRequestsCount,
    labelsSyncedAt: row.labelsSyncedAt,
    issuesSyncedAt: row.issuesSyncedAt,
    pullRequestsSyncedAt: row.pullRequestsSyncedAt,
    mergedPullRequestsSyncedAt: row.mergedPullRequestsSyncedAt,
    lastStartedAt: row.lastStartedAt,
    lastCompletedAt: row.lastCompletedAt,
    errorSummary: row.errorSummary,
    warnings: parseJson<string[]>(row.warningsJson, []),
    updatedAt: row.updatedAt,
  };
}

function toRepoSyncSegmentRecord(row: typeof repoSyncSegments.$inferSelect): RepoSyncSegmentRecord {
  return {
    repoFullName: row.repoFullName,
    segment: parseRepoSyncSegment(row.segment),
    status: parseRepoSyncSegmentStatus(row.status),
    sourceKind: parseSyncSourceKind(row.sourceKind),
    mode: parseBackfillMode(row.mode),
    lastCursor: row.lastCursor,
    nextCursor: row.nextCursor,
    fetchedCount: row.fetchedCount,
    expectedCount: row.expectedCount,
    pageCount: row.pageCount,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    staleAt: row.staleAt,
    rateLimitResetAt: row.rateLimitResetAt,
    etag: row.etag,
    lastModified: row.lastModified,
    warnings: parseJson<string[]>(row.warningsJson, []),
    errorSummary: row.errorSummary,
    updatedAt: row.updatedAt,
  };
}

function toGitHubRateLimitObservationRecord(row: typeof githubRateLimitObservations.$inferSelect): GitHubRateLimitObservationRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    resource: row.resource === "graphql" ? "graphql" : "rest",
    path: row.path,
    statusCode: row.statusCode,
    limitValue: row.limitValue,
    remaining: row.remaining,
    resetAt: row.resetAt,
    observedAt: row.observedAt,
  };
}

function toRepoGithubTotalsSnapshotRecord(row: typeof repoGithubTotalsSnapshots.$inferSelect): RepoGithubTotalsSnapshotRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    openIssuesTotal: row.openIssuesTotal,
    openPullRequestsTotal: row.openPullRequestsTotal,
    mergedPullRequestsTotal: row.mergedPullRequestsTotal,
    closedUnmergedPullRequestsTotal: row.closedUnmergedPullRequestsTotal,
    labelsTotal: row.labelsTotal,
    sourceKind: parseSyncSourceKind(row.sourceKind),
    fetchedAt: row.fetchedAt,
    rateLimitRemaining: row.rateLimitRemaining,
    rateLimitResetAt: row.rateLimitResetAt,
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
  };
}

function toPullRequestDetailSyncStateRecord(row: typeof pullRequestDetailSyncState.$inferSelect): PullRequestDetailSyncStateRecord {
  return {
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    status: parsePullRequestDetailSyncStatus(row.status),
    filesSyncedAt: row.filesSyncedAt,
    reviewsSyncedAt: row.reviewsSyncedAt,
    checksSyncedAt: row.checksSyncedAt,
    lastSyncedAt: row.lastSyncedAt,
    errorSummary: row.errorSummary,
    updatedAt: row.updatedAt,
  };
}

function toScoringModelSnapshotRecord(row: typeof scoringModelSnapshots.$inferSelect): ScoringModelSnapshotRecord {
  return {
    id: row.id,
    sourceKind: parseScoringSourceKind(row.sourceKind),
    sourceUrl: row.sourceUrl,
    fetchedAt: row.fetchedAt,
    activeModel: parseActiveScoringModel(row.activeModel),
    constants: parseJson<Record<string, number>>(row.constantsJson, {}),
    programmingLanguages: parseJson<Record<string, never>>(row.programmingLanguagesJson, {}),
    registrySnapshotId: row.registrySnapshotId,
    warnings: parseJson<string[]>(row.warningsJson, []),
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
  };
}

function toScorePreviewRecord(row: typeof scorePreviews.$inferSelect): ScorePreviewRecord {
  return {
    id: row.id,
    scoringModelSnapshotId: row.scoringModelSnapshotId,
    repoFullName: row.repoFullName,
    targetType: parseScorePreviewTargetType(row.targetType),
    targetKey: row.targetKey,
    contributorLogin: row.contributorLogin,
    input: parseJson<Record<string, never>>(row.inputJson, {}),
    result: parseJson<Record<string, never>>(row.resultJson, {}),
    generatedAt: row.generatedAt,
  };
}

function toRepoLabelRecord(row: typeof repoLabels.$inferSelect): RepoLabelRecord {
  return {
    repoFullName: row.repoFullName,
    name: row.name,
    color: row.color,
    description: row.description,
    isConfigured: row.isConfigured,
    observedCount: row.observedCount,
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
    lastSeenAt: row.lastSeenAt,
  };
}

function toPullRequestRecord(repoFullName: string, pr: GitHubPullRequestPayload): PullRequestRecord {
  return {
    repoFullName,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    authorLogin: pr.user?.login,
    authorAssociation: pr.author_association,
    headSha: pr.head?.sha,
    headRef: pr.head?.ref,
    baseRef: pr.base?.ref,
    htmlUrl: pr.html_url,
    mergedAt: pr.merged_at,
    body: pr.body,
    labels: (pr.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
    linkedIssues: extractLinkedIssueNumbers(pr.body ?? ""),
  };
}

function toPullRequestRecordFromRow(row: typeof pullRequests.$inferSelect): PullRequestRecord {
  const payload = parseJson<{ body?: string | null; created_at?: string | null; updated_at?: string | null }>(row.payloadJson, {});
  return {
    repoFullName: row.repoFullName,
    number: row.number,
    title: row.title,
    state: row.state,
    authorLogin: row.authorLogin,
    authorAssociation: row.authorAssociation,
    headSha: row.headSha,
    headRef: row.headRef,
    baseRef: row.baseRef,
    htmlUrl: row.htmlUrl,
    mergedAt: row.mergedAt,
    body: payload.body,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at ?? row.updatedAt,
    labels: parseJson<string[]>(row.labelsJson, []),
    linkedIssues: parseJson<number[]>(row.linkedIssuesJson, []),
  };
}

function toIssueRecord(repoFullName: string, issue: GitHubIssuePayload): IssueRecord {
  return {
    repoFullName,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    authorLogin: issue.user?.login,
    authorAssociation: issue.author_association,
    htmlUrl: issue.html_url,
    body: issue.body,
    labels: (issue.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
    linkedPrs: extractLinkedPrNumbers(issue.body ?? ""),
  };
}

function compactGitHubPayload(payload: { body?: string | null; created_at?: string | null; updated_at?: string | null }): Record<string, JsonValue> {
  return {
    body: truncateBody(payload.body),
    created_at: payload.created_at ?? null,
    updated_at: payload.updated_at ?? null,
  };
}

function truncateBody(body: string | null | undefined): string | null {
  if (!body) return body ?? null;
  return body.length > MAX_STORED_BODY_CHARS ? body.slice(0, MAX_STORED_BODY_CHARS) : body;
}

function toIssueRecordFromRow(row: typeof issues.$inferSelect): IssueRecord {
  const payload = parseJson<{ body?: string | null; created_at?: string | null; updated_at?: string | null }>(row.payloadJson, {});
  return {
    repoFullName: row.repoFullName,
    number: row.number,
    title: row.title,
    state: row.state,
    authorLogin: row.authorLogin,
    authorAssociation: row.authorAssociation,
    htmlUrl: row.htmlUrl,
    body: payload.body,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at ?? row.updatedAt,
    labels: parseJson<string[]>(row.labelsJson, []),
    linkedPrs: parseJson<number[]>(row.linkedPrsJson, []),
  };
}

function toPullRequestFileRecord(row: typeof pullRequestFiles.$inferSelect): PullRequestFileRecord {
  return {
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    path: row.path,
    status: row.status,
    additions: row.additions,
    deletions: row.deletions,
    changes: row.changes,
    previousFilename: row.previousFilename,
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
  };
}

function toPullRequestReviewRecord(row: typeof pullRequestReviews.$inferSelect): PullRequestReviewRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    reviewerLogin: row.reviewerLogin,
    state: row.state,
    authorAssociation: row.authorAssociation,
    submittedAt: row.submittedAt,
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
  };
}

function toCheckSummaryRecord(row: typeof checkSummaries.$inferSelect): CheckSummaryRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    headSha: row.headSha,
    name: row.name,
    status: row.status,
    conclusion: row.conclusion,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    detailsUrl: row.detailsUrl,
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
  };
}

function toRecentMergedPullRequestRecord(row: typeof recentMergedPullRequests.$inferSelect): RecentMergedPullRequestRecord {
  return {
    repoFullName: row.repoFullName,
    number: row.number,
    title: row.title,
    authorLogin: row.authorLogin,
    htmlUrl: row.htmlUrl,
    mergedAt: row.mergedAt,
    labels: parseJson<string[]>(row.labelsJson, []),
    linkedIssues: parseJson<number[]>(row.linkedIssuesJson, []),
    changedFiles: parseJson<string[]>(row.changedFilesJson, []),
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
  };
}

function toContributorRepoStatRecord(row: typeof contributorRepoStats.$inferSelect): ContributorRepoStatRecord {
  return {
    login: row.login,
    repoFullName: row.repoFullName,
    pullRequests: row.pullRequests,
    mergedPullRequests: row.mergedPullRequests,
    openPullRequests: row.openPullRequests,
    issues: row.issues,
    stalePullRequests: row.stalePullRequests,
    unlinkedPullRequests: row.unlinkedPullRequests,
    dominantLabels: parseJson<string[]>(row.dominantLabelsJson, []),
    lastActivityAt: row.lastActivityAt,
  };
}

function mergeContributorRepoStats(stats: ContributorRepoStatRecord[]): ContributorRepoStatRecord[] {
  const byRepo = new Map<string, ContributorRepoStatRecord>();
  for (const stat of stats) {
    const key = stat.repoFullName.toLowerCase();
    const existing = byRepo.get(key);
    if (!existing) {
      byRepo.set(key, stat);
      continue;
    }
    byRepo.set(key, {
      login: stat.login,
      repoFullName: stat.repoFullName,
      pullRequests: Math.max(existing.pullRequests, stat.pullRequests),
      mergedPullRequests: Math.max(existing.mergedPullRequests, stat.mergedPullRequests),
      openPullRequests: Math.max(existing.openPullRequests, stat.openPullRequests),
      issues: Math.max(existing.issues, stat.issues),
      stalePullRequests: Math.max(existing.stalePullRequests, stat.stalePullRequests),
      unlinkedPullRequests: Math.max(existing.unlinkedPullRequests, stat.unlinkedPullRequests),
      dominantLabels: topStringItems([...existing.dominantLabels, ...stat.dominantLabels], 8),
      lastActivityAt: latestIso([existing.lastActivityAt, stat.lastActivityAt]),
    });
  }
  return [...byRepo.values()].sort((left, right) => left.repoFullName.localeCompare(right.repoFullName));
}

function topStringItems(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function latestIso(values: Array<string | null | undefined>): string | null | undefined {
  return values.filter(Boolean).sort().at(-1);
}

function toBountyRecord(row: typeof bounties.$inferSelect): BountyRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    issueNumber: row.issueNumber,
    status: row.status,
    amountText: row.amountText,
    sourceUrl: row.sourceUrl,
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
    discoveredAt: row.discoveredAt,
    updatedAt: row.updatedAt,
  };
}

function toCollisionEdgeRecord(row: typeof collisionEdges.$inferSelect): CollisionEdgeRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    leftType: parseCollisionItemType(row.leftType),
    leftNumber: row.leftNumber,
    leftTitle: row.leftTitle,
    rightType: parseCollisionItemType(row.rightType),
    rightNumber: row.rightNumber,
    rightTitle: row.rightTitle,
    risk: parseCollisionRisk(row.risk),
    reason: row.reason,
    sharedTerms: parseJson<string[]>(row.sharedTermsJson, []),
    generatedAt: row.generatedAt,
  };
}

function toSignalSnapshotRecord(row: typeof signalSnapshots.$inferSelect): SignalSnapshotRecord {
  return {
    id: row.id,
    signalType: row.signalType,
    targetKey: row.targetKey,
    repoFullName: row.repoFullName,
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
    generatedAt: row.generatedAt,
  };
}

function toAgentRunRecord(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    objective: row.objective,
    actorLogin: row.actorLogin,
    surface: parseAgentSurface(row.surface),
    mode: parseAgentMode(row.mode),
    status: parseAgentRunStatus(row.status),
    dataQualityStatus: parseDataQualityStatus(row.dataQualityStatus),
    errorSummary: row.errorSummary,
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAgentActionRecord(row: typeof agentActions.$inferSelect): AgentActionRecord {
  return {
    id: row.id,
    runId: row.runId,
    actionType: parseAgentActionType(row.actionType),
    targetRepoFullName: row.targetRepoFullName,
    targetPullNumber: row.targetPullNumber,
    targetIssueNumber: row.targetIssueNumber,
    status: parseAgentActionStatus(row.status),
    recommendation: row.recommendation,
    why: parseJson<string[]>(row.whyJson, []),
    scoreabilityImpact: row.scoreabilityImpact,
    riskImpact: row.riskImpact,
    maintainerImpact: row.maintainerImpact,
    blockedBy: parseJson<string[]>(row.blockedByJson, []),
    rerunWhen: row.rerunWhen,
    publicSafeSummary: row.publicSafeSummary,
    approvalRequired: row.approvalRequired,
    safetyClass: parseAgentSafetyClass(row.safetyClass),
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
    createdAt: row.createdAt,
  };
}

function toAgentContextSnapshotRecord(row: typeof agentContextSnapshots.$inferSelect): AgentContextSnapshotRecord {
  return {
    id: row.id,
    runId: row.runId,
    decisionPackVersion: row.decisionPackVersion,
    repoSignalSnapshotIds: parseJson<string[]>(row.repoSignalSnapshotIdsJson, []),
    scoringModelId: row.scoringModelId,
    freshnessWarnings: parseJson<string[]>(row.freshnessWarningsJson, []),
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
    createdAt: row.createdAt,
  };
}

function toInstallationHealthRecord(row: typeof installationHealth.$inferSelect): InstallationHealthRecord {
  return {
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    repositorySelection: row.repositorySelection,
    installedReposCount: row.installedReposCount,
    registeredInstalledCount: row.registeredInstalledCount,
    status: parseInstallationHealthStatus(row.status),
    missingPermissions: parseJson<string[]>(row.missingPermissionsJson, []),
    missingEvents: parseJson<string[]>(row.missingEventsJson, []),
    permissions: parseJson<Record<string, string>>(row.permissionsJson, {}),
    events: parseJson<string[]>(row.eventsJson, []),
    checkedAt: row.checkedAt,
    errorSummary: row.errorSummary,
  };
}

function toOfficialMinerDetection(row: typeof officialMinerDetections.$inferSelect): OfficialGittensorMinerDetection {
  if (row.status === "confirmed") {
    const snapshot = parseJson<Partial<GittensorContributorSnapshot> | null>(row.snapshotJson, null);
    return snapshot?.githubId && snapshot.githubUsername
      ? { status: "confirmed", snapshot: toCacheableGittensorSnapshot(snapshot) }
      : { status: "unavailable", error: "cached Gittensor miner snapshot is invalid" };
  }
  return row.status === "unavailable" ? { status: "unavailable", error: row.error ?? "cached Gittensor API unavailable" } : { status: "not_found" };
}

function toAuthSessionRecord(row: typeof authSessions.$inferSelect): AuthSessionRecord {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    login: row.login,
    githubUserId: row.githubUserId,
    scopes: parseJson<string[]>(row.scopesJson, []),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    metadata: parseJson<Record<string, never>>(row.metadataJson, {}),
  };
}

function parseAgentSurface(value: string): AgentSurface {
  if (value === "mcp" || value === "github_comment") return value;
  return "api";
}

function parseAgentMode(_value: string): AgentMode {
  return "copilot";
}

function parseAgentRunStatus(value: string): AgentRunStatus {
  if (value === "running" || value === "completed" || value === "failed" || value === "needs_snapshot_refresh") return value;
  return "queued";
}

function parseDataQualityStatus(value: string): AgentRunRecord["dataQualityStatus"] {
  if (value === "complete" || value === "degraded" || value === "blocked") return value;
  return "unknown";
}

function parseAgentActionType(value: string): AgentActionType {
  if (
    value === "cleanup_existing_prs" ||
    value === "preflight_branch" ||
    value === "explain_score_blockers" ||
    value === "prepare_pr_packet" ||
    value === "check_duplicate_risk" ||
    value === "monitor_existing_pr" ||
    value === "explain_repo_fit"
  ) {
    return value;
  }
  return "choose_next_work";
}

function parseAgentActionStatus(value: string): AgentActionStatus {
  if (value === "ready" || value === "blocked" || value === "watch" || value === "needs_input") return value;
  return "recommended";
}

function parseAgentSafetyClass(value: string): AgentSafetyClass {
  if (value === "public_safe" || value === "approval_required") return value;
  return "private";
}

function parseCommentMode(value: string): RepositorySettings["commentMode"] {
  if (value === "detected_contributors_only" || value === "all_prs") return value;
  return "off";
}

function parseCheckRunMode(value: string): RepositorySettings["checkRunMode"] {
  return value === "enabled" ? "enabled" : "off";
}

function parseCheckRunDetailLevel(value: string): RepositorySettings["checkRunDetailLevel"] {
  if (value === "minimal" || value === "deep") return value;
  return "standard";
}

function parsePublicSurface(value: string): RepositorySettings["publicSurface"] {
  if (value === "comment_only" || value === "label_only" || value === "off") return value;
  return "comment_and_label";
}

function parseSyncStatus(value: string): RepoSyncStateRecord["status"] {
  if (
    value === "running" ||
    value === "success" ||
    value === "partial" ||
    value === "error" ||
    value === "skipped" ||
    value === "capped" ||
    value === "rate_limited" ||
    value === "stale"
  ) {
    return value;
  }
  return "never_synced";
}

function parseSyncSourceKind(value: string): RepoSyncStateRecord["sourceKind"] {
  if (value === "installation" || value === "test") return value;
  return "github";
}

function parseRepoSyncSegment(value: string): RepoSyncSegmentRecord["segment"] {
  if (
    value === "metadata" ||
    value === "labels" ||
    value === "open_issues" ||
    value === "open_pull_requests" ||
    value === "recent_merged_pull_requests" ||
    value === "pull_request_files" ||
    value === "pull_request_reviews" ||
    value === "check_summaries"
  ) {
    return value;
  }
  return "metadata";
}

function parseRepoSyncSegmentStatus(value: string): RepoSyncSegmentRecord["status"] {
  if (
    value === "running" ||
    value === "refreshing" ||
    value === "complete" ||
    value === "partial" ||
    value === "capped" ||
    value === "sampled" ||
    value === "stale" ||
    value === "rate_limited" ||
    value === "waiting_rate_limit" ||
    value === "error" ||
    value === "skipped" ||
    value === "not_modified"
  ) {
    return value;
  }
  return "never_synced";
}

function parseBackfillMode(value: string): RepoSyncSegmentRecord["mode"] {
  if (value === "full" || value === "resume") return value;
  return "light";
}

function parseCollisionItemType(value: string): CollisionEdgeRecord["leftType"] {
  if (value === "pull_request" || value === "recent_merged_pull_request") return value;
  return "issue";
}

function parseCollisionRisk(value: string): CollisionEdgeRecord["risk"] {
  if (value === "high" || value === "medium") return value;
  return "low";
}

function parseInstallationHealthStatus(value: string): InstallationHealthRecord["status"] {
  if (value === "healthy" || value === "broken") return value;
  return "needs_attention";
}

function parseScoringSourceKind(value: string): ScoringModelSnapshotRecord["sourceKind"] {
  if (value === "raw-github" || value === "api" || value === "test") return value;
  return "fallback";
}

function parseActiveScoringModel(value: string): ScoringModelSnapshotRecord["activeModel"] {
  if (value === "current_density_model" || value === "pending_saturation_model") return value;
  return "unknown";
}

function parseScorePreviewTargetType(value: string): ScorePreviewRecord["targetType"] {
  if (value === "pull_request" || value === "local_diff" || value === "variant") return value;
  return "planned_pr";
}

function parsePullRequestDetailSyncStatus(value: string): PullRequestDetailSyncStateRecord["status"] {
  if (value === "running" || value === "complete" || value === "partial" || value === "waiting_rate_limit" || value === "error") return value;
  return "never_synced";
}

function loginMatches(column: unknown, login: string) {
  return sql`lower(${column}) = ${login.toLowerCase()}`;
}

export function extractLinkedIssueNumbers(text: string): number[] {
  const matches = [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)];
  return [...new Set(matches.map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
}

function extractLinkedPrNumbers(text: string): number[] {
  const matches = [...text.matchAll(/\b(?:PR|pull request)\s+#(\d+)\b/gi)];
  return [...new Set(matches.map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
}
