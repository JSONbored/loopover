import { and, desc, eq, gte, inArray, not, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
import {
  advisories,
  aiUsageEvents,
  agentActions,
  agentContextSnapshots,
  agentRecommendationOutcomes,
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
  digestSubscriptions,
  agentPendingActions,
  gateOutcomes,
  githubAgentCommandAnswers,
  githubAgentCommandFeedback,
  installationHealth,
  installations,
  issueQualityReports,
  issues,
  githubRateLimitObservations,
  notificationDeliveries,
  issueWatchSubscriptions,
  notificationSubscriptions,
  officialMinerDetections,
  pullRequestFiles,
  pullRequestDetailSyncState,
  pullRequestReviews,
  pullRequests,
  productUsageDailyRollups,
  productUsageEvents,
  recentMergedPullRequests,
  repositories,
  repoGithubTotalsSnapshots,
  repoQueueTrendSnapshots,
  registryDriftEvents,
  repoLabels,
  repoSnapshots,
  repoSyncSegments,
  repoSyncState,
  repositoryAiKeys,
  repositorySettings,
  scorePreviews,
  scoringModelSnapshots,
  signalSnapshots,
  upstreamDriftReports,
  upstreamRulesetSnapshots,
  upstreamSourceSnapshots,
  webhookEvents,
} from "./schema";
import type {
  Advisory,
  AgentActionRecord,
  AgentActionStatus,
  AgentActionType,
  AutonomyPolicy,
  AutoMaintainPolicy,
  AgentCommandAnswerRecord,
  AgentCommandFeedbackRecord,
  AgentContextSnapshotRecord,
  AgentRecommendationOutcomeConfidence,
  AgentRecommendationOutcomeRecord,
  AgentRecommendationOutcomeSource,
  AgentRecommendationOutcomeState,
  AgentRecommendationOutcomeSummary,
  AgentRecommendationOutcomeTargetType,
  AgentActionClass,
  AgentPendingActionParams,
  AgentPendingActionRecord,
  AgentPendingActionStatus,
  AutonomyLevel,
  GateOutcomeRecord,
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
  CommandUsefulnessSummary,
  ContributorEvidenceRecord,
  ContributorRecord,
  ContributorRepoStatRecord,
  ContributorScoringProfileRecord,
  DigestSubscriptionRecord,
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
  McpCompatibilityAdoptionSummary,
  NotificationChannel,
  NotificationDeliveryRecord,
  NotificationDeliveryStatus,
  IssueWatchSubscription,
  NotificationSubscriptionRecord,
  ProductUsageActivationFunnel,
  ProductUsageDailyRollupRecord,
  ProductUsageDailyRollupStatus,
  ProductUsageEventRecord,
  ProductUsageRetentionRollup,
  ProductUsageRollupRunResult,
  ProductUsageRollupStatus,
  ProductUsageOutcome,
  ProductUsageRole,
  ProductUsageRoleActivationFunnel,
  ProductUsageRoleDimensionCount,
  ProductUsageRoleRetention,
  ProductUsageSummary,
  ProductUsageSurface,
  ProductUsageSurfaceActivationFunnel,
  ProductUsageSurfaceRetention,
  PullRequestFileRecord,
  PullRequestDetailSyncStateRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RegistryRepoConfig,
  RegistryDriftEventRecord,
  RepoLabelRecord,
  RepoGithubTotalsSnapshotRecord,
  RepoQueueTrendSnapshotRecord,
  RepoSnapshotRecord,
  RepoSyncSegmentRecord,
  RepoSyncStateRecord,
  RepositorySettings,
  RepositoryRecord,
  ScorePreviewRecord,
  ScoringModelSnapshotRecord,
  SignalSnapshotRecord,
  UpstreamDriftArea,
  UpstreamDriftReportRecord,
  UpstreamDriftSeverity,
  UpstreamDriftStatus,
  UpstreamRulesetSnapshotRecord,
  UpstreamSourceSnapshotRecord,
  UpstreamSourceStatus,
} from "../types";
import type { GittensorContributorSnapshot, OfficialGittensorMinerDetection } from "../gittensor/api";
import { classifyMcpClientVersion, LATEST_RECOMMENDED_MCP_VERSION, MINIMUM_SUPPORTED_MCP_VERSION } from "../services/mcp-compatibility";
import { DEFAULT_COMMAND_AUTHORIZATION_POLICY, normalizeCommandAuthorizationPolicy } from "../settings/command-authorization";
import { normalizeAutonomyPolicy, normalizeAutoMaintainPolicy, DEFAULT_AUTO_MAINTAIN_POLICY } from "../settings/autonomy";
import { decryptSecret, encryptSecret, sha256Hex } from "../utils/crypto";
import { jsonString, nowIso, parseJson, repoParts } from "../utils/json";

const MAX_STORED_BODY_CHARS = 4000;
const SIGNAL_FRESHNESS_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SIGNAL_FRESHNESS_TARGETS = 200;
const MAX_SIGNAL_FRESHNESS_TARGET_KEY_CHARS = 256;
const FRESHNESS_SIGNAL_TYPES = [
  "contributor-decision-pack",
  "contributor-evidence-graph",
  "contributor-intake-health",
  "contributor-outcome-history",
  "contributor-strategy",
  "config-quality",
  "label-audit",
  "maintainer-cut-readiness",
  "maintainer-lane",
  "pr-reviewability",
  "queue-health",
];

export async function upsertInstallation(env: Env, payload: GitHubWebhookPayload): Promise<void> {
  if (!payload.installation?.id) return;
  const account = payload.installation.account;
  const existing = await getInstallation(env, payload.installation.id);
  const permissions =
    payload.installation.permissions && Object.keys(payload.installation.permissions).length > 0
      ? (payload.installation.permissions as Record<string, string>)
      : (existing?.permissions ?? {});
  const events = payload.installation.events && payload.installation.events.length > 0 ? payload.installation.events : (existing?.events ?? []);
  const accountLogin = account?.login ?? existing?.accountLogin ?? "unknown";
  const accountId = account?.id ?? existing?.accountId ?? 0;
  const targetType = payload.installation.target_type ?? account?.type ?? existing?.targetType ?? "unknown";
  const repositorySelection = payload.installation.repository_selection ?? existing?.repositorySelection;
  const suspendedAt = payload.installation.suspended_at !== undefined ? payload.installation.suspended_at : (existing?.suspendedAt ?? undefined);
  const db = getDb(env.DB);
  await db
    .insert(installations)
    .values({
      id: payload.installation.id,
      accountLogin,
      accountId,
      targetType,
      repositorySelection,
      permissionsJson: jsonString(permissions),
      eventsJson: jsonString(events),
      suspendedAt,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: installations.id,
      set: {
        accountLogin,
        accountId,
        targetType,
        repositorySelection,
        permissionsJson: jsonString(permissions),
        eventsJson: jsonString(events),
        suspendedAt,
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

export async function markRepositoriesRemovedFromInstallation(env: Env, installationId: number, repoFullNames: string[]): Promise<void> {
  const names = [...new Set(repoFullNames.filter(Boolean))];
  if (names.length === 0) return;
  const db = getDb(env.DB);
  await db
    .update(repositories)
    .set({ isInstalled: false, installationId: null, updatedAt: nowIso() })
    .where(and(eq(repositories.installationId, installationId), inArray(repositories.fullName, names)));
}

export async function getInstallation(env: Env, installationId: number): Promise<InstallationRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(installations).where(eq(installations.id, installationId)).limit(1);
  return row ? toInstallationRecord(row) : null;
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
      publicAudienceMode: "oss_maintainer",
      publicSignalLevel: "standard",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      gateCheckMode: "off",
      gatePack: "gittensor",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "block",
      qualityGateMode: "advisory",
      qualityGateMinScore: null,
      slopGateMode: "off",
      mergeReadinessGateMode: "off",
      manifestPolicyGateMode: "off",
      firstTimeContributorGrace: false,
      slopGateMinScore: null,
      slopAiAdvisory: false,
      aiReviewMode: "off",
      aiReviewByok: false,
      aiReviewProvider: null,
      aiReviewModel: null,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
      badgeEnabled: false,
      agentPaused: false,
      agentDryRun: false,
      commandAuthorization: normalizeCommandAuthorizationPolicy(DEFAULT_COMMAND_AUTHORIZATION_POLICY).policy,
      autonomy: {},
      autoMaintain: { ...DEFAULT_AUTO_MAINTAIN_POLICY },
    };
  }
  return {
    repoFullName: row.repoFullName,
    commentMode: parseCommentMode(row.commentMode),
    publicAudienceMode: parsePublicAudienceMode(row.publicAudienceMode),
    publicSignalLevel: row.publicSignalLevel === "minimal" ? "minimal" : "standard",
    checkRunMode: parseCheckRunMode(row.checkRunMode),
    checkRunDetailLevel: parseCheckRunDetailLevel(row.checkRunDetailLevel),
    gateCheckMode: parseGateCheckMode(row.gateCheckMode),
    gatePack: parseGatePack(row.gatePack),
    linkedIssueGateMode: parseGateRuleMode(row.linkedIssueGateMode),
    duplicatePrGateMode: parseGateRuleMode(row.duplicatePrGateMode),
    qualityGateMode: parseGateRuleMode(row.qualityGateMode),
    qualityGateMinScore: normalizeQualityGateMinScore(row.qualityGateMinScore),
    slopGateMode: parseGateRuleMode(row.slopGateMode),
    mergeReadinessGateMode: parseGateRuleMode(row.mergeReadinessGateMode),
    manifestPolicyGateMode: parseGateRuleMode(row.manifestPolicyGateMode),
    firstTimeContributorGrace: row.firstTimeContributorGrace,
    slopGateMinScore: normalizeQualityGateMinScore(row.slopGateMinScore),
    slopAiAdvisory: row.slopAiAdvisory,
    aiReviewMode: parseGateRuleMode(row.aiReviewMode),
    aiReviewByok: row.aiReviewByok,
    aiReviewProvider: normalizeAiReviewProvider(row.aiReviewProvider),
    aiReviewModel: row.aiReviewModel ?? null,
    autoLabelEnabled: row.autoLabelEnabled,
    gittensorLabel: row.gittensorLabel,
    createMissingLabel: row.createMissingLabel,
    publicSurface: parsePublicSurface(row.publicSurface),
    includeMaintainerAuthors: row.includeMaintainerAuthors,
    requireLinkedIssue: row.requireLinkedIssue,
    backfillEnabled: row.backfillEnabled,
    privateTrustEnabled: row.privateTrustEnabled,
    badgeEnabled: row.badgeEnabled,
    agentPaused: row.agentPaused,
    agentDryRun: row.agentDryRun,
    commandAuthorization: parseCommandAuthorizationPolicy(row.commandAuthorizationJson),
    autonomy: parseAutonomyPolicy(row.autonomyJson),
    autoMaintain: parseAutoMaintainPolicy(row.autoMaintainJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertRepositorySettings(env: Env, settings: Partial<RepositorySettings> & { repoFullName: string }): Promise<RepositorySettings> {
  const resolved: RepositorySettings = {
    repoFullName: settings.repoFullName,
    commentMode: settings.commentMode ?? "detected_contributors_only",
    publicAudienceMode: settings.publicAudienceMode ?? "oss_maintainer",
    publicSignalLevel: settings.publicSignalLevel ?? "standard",
    checkRunMode: settings.checkRunMode ?? "off",
    checkRunDetailLevel: settings.checkRunDetailLevel ?? "minimal",
    gateCheckMode: settings.gateCheckMode ?? "off",
    gatePack: parseGatePack(settings.gatePack),
    linkedIssueGateMode: settings.linkedIssueGateMode ?? "advisory",
    duplicatePrGateMode: settings.duplicatePrGateMode ?? "block",
    qualityGateMode: settings.qualityGateMode ?? "advisory",
    qualityGateMinScore: normalizeQualityGateMinScore(settings.qualityGateMinScore),
    slopGateMode: settings.slopGateMode ?? "off",
    mergeReadinessGateMode: settings.mergeReadinessGateMode ?? "off",
    manifestPolicyGateMode: settings.manifestPolicyGateMode ?? "off",
    firstTimeContributorGrace: settings.firstTimeContributorGrace ?? false,
    slopGateMinScore: normalizeQualityGateMinScore(settings.slopGateMinScore),
    slopAiAdvisory: settings.slopAiAdvisory ?? false,
    aiReviewMode: settings.aiReviewMode ?? "off",
    aiReviewByok: settings.aiReviewByok ?? false,
    aiReviewProvider: normalizeAiReviewProvider(settings.aiReviewProvider),
    aiReviewModel: typeof settings.aiReviewModel === "string" && settings.aiReviewModel.trim() ? settings.aiReviewModel.trim() : null,
    autoLabelEnabled: settings.autoLabelEnabled ?? true,
    gittensorLabel: settings.gittensorLabel ?? "gittensor",
    createMissingLabel: settings.createMissingLabel ?? true,
    publicSurface: settings.publicSurface ?? "comment_and_label",
    includeMaintainerAuthors: settings.includeMaintainerAuthors ?? false,
    requireLinkedIssue: settings.requireLinkedIssue ?? false,
    backfillEnabled: settings.backfillEnabled ?? true,
    privateTrustEnabled: settings.privateTrustEnabled ?? true,
    badgeEnabled: settings.badgeEnabled ?? false,
    agentPaused: settings.agentPaused ?? false,
    agentDryRun: settings.agentDryRun ?? false,
    commandAuthorization: normalizeCommandAuthorizationPolicy(settings.commandAuthorization).policy,
    autonomy: normalizeAutonomyPolicy(settings.autonomy),
    autoMaintain: normalizeAutoMaintainPolicy(settings.autoMaintain),
  };
  const db = getDb(env.DB);
  await db
    .insert(repositorySettings)
    .values({
      repoFullName: resolved.repoFullName,
      commentMode: resolved.commentMode,
      publicAudienceMode: resolved.publicAudienceMode,
      publicSignalLevel: resolved.publicSignalLevel,
      checkRunMode: resolved.checkRunMode,
      checkRunDetailLevel: resolved.checkRunDetailLevel,
      gateCheckMode: resolved.gateCheckMode,
      gatePack: resolved.gatePack,
      linkedIssueGateMode: resolved.linkedIssueGateMode,
      duplicatePrGateMode: resolved.duplicatePrGateMode,
      qualityGateMode: resolved.qualityGateMode,
      qualityGateMinScore: resolved.qualityGateMinScore,
      slopGateMode: resolved.slopGateMode,
      mergeReadinessGateMode: resolved.mergeReadinessGateMode,
      manifestPolicyGateMode: resolved.manifestPolicyGateMode,
      firstTimeContributorGrace: resolved.firstTimeContributorGrace,
      slopGateMinScore: resolved.slopGateMinScore,
      slopAiAdvisory: resolved.slopAiAdvisory,
      aiReviewMode: resolved.aiReviewMode,
      aiReviewByok: resolved.aiReviewByok,
      aiReviewProvider: resolved.aiReviewProvider,
      aiReviewModel: resolved.aiReviewModel,
      autoLabelEnabled: resolved.autoLabelEnabled,
      gittensorLabel: resolved.gittensorLabel,
      createMissingLabel: resolved.createMissingLabel,
      publicSurface: resolved.publicSurface,
      includeMaintainerAuthors: resolved.includeMaintainerAuthors,
      requireLinkedIssue: resolved.requireLinkedIssue,
      backfillEnabled: resolved.backfillEnabled,
      privateTrustEnabled: resolved.privateTrustEnabled,
      badgeEnabled: resolved.badgeEnabled,
      agentPaused: resolved.agentPaused,
      agentDryRun: resolved.agentDryRun,
      commandAuthorizationJson: jsonString(resolved.commandAuthorization),
      autonomyJson: jsonString(resolved.autonomy),
      autoMaintainJson: jsonString(resolved.autoMaintain),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: repositorySettings.repoFullName,
      set: {
        commentMode: resolved.commentMode,
        publicAudienceMode: resolved.publicAudienceMode,
        publicSignalLevel: resolved.publicSignalLevel,
        checkRunMode: resolved.checkRunMode,
        checkRunDetailLevel: resolved.checkRunDetailLevel,
        gateCheckMode: resolved.gateCheckMode,
        gatePack: resolved.gatePack,
        linkedIssueGateMode: resolved.linkedIssueGateMode,
        duplicatePrGateMode: resolved.duplicatePrGateMode,
        qualityGateMode: resolved.qualityGateMode,
        qualityGateMinScore: resolved.qualityGateMinScore,
        // slop_* were previously absent from the UPDATE branch (only INSERT), so slop settings did not
        // persist on update of an existing row. Restored here alongside the new slopAiAdvisory field.
        slopGateMode: resolved.slopGateMode,
        mergeReadinessGateMode: resolved.mergeReadinessGateMode,
        manifestPolicyGateMode: resolved.manifestPolicyGateMode,
        firstTimeContributorGrace: resolved.firstTimeContributorGrace,
        slopGateMinScore: resolved.slopGateMinScore,
        slopAiAdvisory: resolved.slopAiAdvisory,
        aiReviewMode: resolved.aiReviewMode,
        aiReviewByok: resolved.aiReviewByok,
        aiReviewProvider: resolved.aiReviewProvider,
        aiReviewModel: resolved.aiReviewModel,
        autoLabelEnabled: resolved.autoLabelEnabled,
        gittensorLabel: resolved.gittensorLabel,
        createMissingLabel: resolved.createMissingLabel,
        publicSurface: resolved.publicSurface,
        includeMaintainerAuthors: resolved.includeMaintainerAuthors,
        requireLinkedIssue: resolved.requireLinkedIssue,
        backfillEnabled: resolved.backfillEnabled,
        privateTrustEnabled: resolved.privateTrustEnabled,
        badgeEnabled: resolved.badgeEnabled,
        agentPaused: resolved.agentPaused,
        agentDryRun: resolved.agentDryRun,
        commandAuthorizationJson: jsonString(resolved.commandAuthorization),
        autonomyJson: jsonString(resolved.autonomy),
        autoMaintainJson: jsonString(resolved.autoMaintain),
        updatedAt: nowIso(),
      },
    });
  return getRepositorySettings(env, resolved.repoFullName);
}

// ─── Maintainer BYOK provider keys ──────────────────────────────────────────────────────────────

export type AiKeyProvider = "anthropic" | "openai";

/** Public, secret-free status of a repo's BYOK key. NEVER includes the key or ciphertext. */
export type RepositoryAiKeyStatus =
  | { configured: true; provider: AiKeyProvider; last4: string; model: string | null; createdBy: string | null; updatedAt: string | null }
  | { configured: false };

/** A decrypted provider key for use at AI-call time only. Never returned from the API, never logged. */
export type DecryptedRepositoryAiKey = { provider: AiKeyProvider; key: string; model: string | null };

function normalizeAiKeyProvider(value: string): AiKeyProvider {
  return value === "openai" ? "openai" : "anthropic";
}

/** Read the secret-free status of a repo's configured BYOK key (for the dashboard/API). */
export async function getRepositoryAiKeyStatus(env: Env, fullName: string): Promise<RepositoryAiKeyStatus> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(repositoryAiKeys).where(eq(repositoryAiKeys.repoFullName, fullName)).limit(1);
  if (!row) return { configured: false };
  return { configured: true, provider: normalizeAiKeyProvider(row.provider), last4: row.last4, model: row.model ?? null, createdBy: row.createdBy, updatedAt: row.updatedAt };
}

/**
 * Store (or replace) a repo's BYOK provider key, encrypted at rest. Returns the secret-free status.
 * Throws `missing_encryption_secret` when TOKEN_ENCRYPTION_SECRET is not configured — callers must
 * surface that rather than store a key in the clear.
 */
export async function upsertRepositoryAiKey(
  env: Env,
  input: { repoFullName: string; provider: AiKeyProvider; key: string; model?: string | null; createdBy?: string | null },
): Promise<RepositoryAiKeyStatus> {
  const secret = env.TOKEN_ENCRYPTION_SECRET;
  if (!secret) throw new Error("missing_encryption_secret");
  const trimmedKey = input.key.trim();
  const existing = await getRepositoryAiKeyStatus(env, input.repoFullName);
  const { ciphertext, iv, salt, version } = await encryptSecret(trimmedKey, secret);
  const last4 = trimmedKey.slice(-4);
  const model = input.model?.trim() ? input.model.trim() : null;
  const createdBy = input.createdBy ?? null;
  const updatedAt = nowIso();
  const db = getDb(env.DB);
  await db
    .insert(repositoryAiKeys)
    .values({ repoFullName: input.repoFullName, provider: input.provider, ciphertext, iv, salt, keyVersion: version, model, last4, createdBy, updatedAt })
    .onConflictDoUpdate({
      target: repositoryAiKeys.repoFullName,
      set: { provider: input.provider, ciphertext, iv, salt, keyVersion: version, model, last4, createdBy, updatedAt },
    });
  await recordAiKeyChange(env, { repoFullName: input.repoFullName, action: existing.configured ? "replace" : "set", provider: input.provider, last4, actor: createdBy });
  return { configured: true, provider: input.provider, last4, model, createdBy, updatedAt };
}

/** Remove a repo's BYOK key. Records a lifecycle audit event when a key was actually present. */
export async function deleteRepositoryAiKey(env: Env, fullName: string, actor?: string | null): Promise<void> {
  const existing = await getRepositoryAiKeyStatus(env, fullName);
  const db = getDb(env.DB);
  await db.delete(repositoryAiKeys).where(eq(repositoryAiKeys.repoFullName, fullName));
  if (existing.configured) {
    await recordAiKeyChange(env, { repoFullName: fullName, action: "delete", provider: existing.provider, last4: existing.last4, actor: actor ?? null });
  }
}

/**
 * Audit a BYOK key lifecycle change (set/replace/delete). Stored in ai_usage_events as a non-"ok"
 * status so it never counts toward the daily neuron budget. NEVER includes any key material — only the
 * display-only last4 and the actor who made the change.
 */
async function recordAiKeyChange(
  env: Env,
  input: { repoFullName: string; action: "set" | "replace" | "delete"; provider: AiKeyProvider; last4: string; actor: string | null },
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "ai_key_change",
    actor: input.actor,
    route: "maintainer.ai_key",
    model: `byok:${input.provider}`,
    status: input.action,
    estimatedNeurons: 0,
    detail: `provider key ${input.action}`,
    metadata: { repoFullName: input.repoFullName, action: input.action, provider: input.provider, last4: input.last4 },
  });
}

/**
 * Decrypt a repo's BYOK key for an AI call. Returns null when no key is configured OR the encryption
 * secret is unavailable OR decryption fails — so the caller silently falls back to free Workers AI and
 * a misconfiguration never blocks the review. The plaintext key must be used immediately and never cached.
 */
export async function getDecryptedRepositoryAiKey(env: Env, fullName: string): Promise<DecryptedRepositoryAiKey | null> {
  const secret = env.TOKEN_ENCRYPTION_SECRET;
  if (!secret) return null;
  const db = getDb(env.DB);
  const [row] = await db.select().from(repositoryAiKeys).where(eq(repositoryAiKeys.repoFullName, fullName)).limit(1);
  if (!row) return null;
  try {
    const key = await decryptSecret(row.ciphertext, row.iv, secret, row.salt);
    return { provider: normalizeAiKeyProvider(row.provider), key, model: row.model ?? null };
  } catch {
    return null;
  }
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

export async function summarizeRepoSyncOpenPullRequests(env: Env, repoFullNames?: string[]): Promise<{ totalOpenPullRequestsCached: number; reposWithOpenPullRequests: number }> {
  const db = getDb(env.DB);
  const aggregate = async (repoNames?: string[]) => {
    const query = db
      .select({
        totalOpenPullRequestsCached: sql<number>`coalesce(sum(case when ${repoSyncState.openPullRequestsCount} > 0 then ${repoSyncState.openPullRequestsCount} else 0 end), 0)`,
        reposWithOpenPullRequests: sql<number>`coalesce(sum(case when ${repoSyncState.openPullRequestsCount} > 0 then 1 else 0 end), 0)`,
      })
      .from(repoSyncState);
    const [row] = repoNames ? await query.where(inArray(sql`lower(${repoSyncState.repoFullName})`, repoNames)) : await query;
    return {
      totalOpenPullRequestsCached: Number(row?.totalOpenPullRequestsCached ?? 0),
      reposWithOpenPullRequests: Number(row?.reposWithOpenPullRequests ?? 0),
    };
  };

  if (repoFullNames === undefined) return aggregate();

  const normalizedRepoNames = Array.from(new Set(repoFullNames.map((name) => name.toLowerCase())));
  const summary = { totalOpenPullRequestsCached: 0, reposWithOpenPullRequests: 0 };
  for (let index = 0; index < normalizedRepoNames.length; index += 450) {
    const chunk = normalizedRepoNames.slice(index, index + 450);
    if (chunk.length === 0) continue;
    const chunkSummary = await aggregate(chunk);
    summary.totalOpenPullRequestsCached += chunkSummary.totalOpenPullRequestsCached;
    summary.reposWithOpenPullRequests += chunkSummary.reposWithOpenPullRequests;
  }
  return summary;
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

export async function listRepoGithubTotalsSnapshotHistory(
  env: Env,
  fullName: string,
  options: { sinceIso?: string | undefined; limit?: number | undefined } = {},
): Promise<RepoGithubTotalsSnapshotRecord[]> {
  const db = getDb(env.DB);
  const limit = Math.max(2, Math.min(options.limit ?? 120, 240));
  const conditions = [eq(repoGithubTotalsSnapshots.repoFullName, fullName)];
  if (options.sinceIso) conditions.push(gte(repoGithubTotalsSnapshots.fetchedAt, options.sinceIso));
  const rows = await db
    .select()
    .from(repoGithubTotalsSnapshots)
    .where(and(...conditions))
    .orderBy(desc(repoGithubTotalsSnapshots.fetchedAt))
    .limit(limit);
  return rows.map(toRepoGithubTotalsSnapshotRecord).reverse();
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

export async function upsertRepoQueueTrendSnapshot(env: Env, snapshot: RepoQueueTrendSnapshotRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(repoQueueTrendSnapshots)
    .values({ repoFullName: snapshot.repoFullName, payloadJson: jsonString(snapshot.payload), generatedAt: snapshot.generatedAt })
    .onConflictDoUpdate({
      target: repoQueueTrendSnapshots.repoFullName,
      set: { payloadJson: jsonString(snapshot.payload), generatedAt: snapshot.generatedAt },
    });
}

export async function getRepoQueueTrendSnapshot(env: Env, repoFullName: string): Promise<RepoQueueTrendSnapshotRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(repoQueueTrendSnapshots).where(eq(repoQueueTrendSnapshots.repoFullName, repoFullName)).limit(1);
  return row ? toRepoQueueTrendSnapshotRecord(row) : null;
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

export async function persistUpstreamSourceSnapshots(env: Env, snapshots: UpstreamSourceSnapshotRecord[]): Promise<void> {
  const db = getDb(env.DB);
  for (const snapshot of snapshots) {
    await db.insert(upstreamSourceSnapshots).values({
      id: snapshot.id,
      sourceKey: snapshot.sourceKey,
      sourceRepo: snapshot.sourceRepo,
      sourceRef: snapshot.sourceRef,
      path: snapshot.path,
      sourceUrl: snapshot.sourceUrl,
      commitSha: snapshot.commitSha,
      blobSha: snapshot.blobSha,
      contentSha256: snapshot.contentSha256,
      etag: snapshot.etag,
      status: snapshot.status,
      parsedJson: jsonString(snapshot.parsed),
      warningsJson: jsonString(snapshot.warnings),
      payloadJson: jsonString(snapshot.payload),
      fetchedAt: snapshot.fetchedAt,
    });
  }
}

export async function listLatestUpstreamSourceSnapshots(env: Env, limit = 20): Promise<UpstreamSourceSnapshotRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(upstreamSourceSnapshots).orderBy(desc(upstreamSourceSnapshots.fetchedAt)).limit(limit);
  return rows.map(toUpstreamSourceSnapshotRecord);
}

export async function listLatestUpstreamSourceSnapshotsByKey(env: Env): Promise<UpstreamSourceSnapshotRecord[]> {
  const rows = await listLatestUpstreamSourceSnapshots(env, 200);
  const byKey = new Map<string, UpstreamSourceSnapshotRecord>();
  for (const row of rows) {
    if (!byKey.has(row.sourceKey)) byKey.set(row.sourceKey, row);
  }
  return [...byKey.values()].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

export async function persistUpstreamRulesetSnapshot(env: Env, snapshot: UpstreamRulesetSnapshotRecord): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(upstreamRulesetSnapshots).values({
    id: snapshot.id,
    sourceRepo: snapshot.sourceRepo,
    sourceRef: snapshot.sourceRef,
    commitSha: snapshot.commitSha,
    sourceSnapshotIdsJson: jsonString(snapshot.sourceSnapshotIds),
    activeModel: snapshot.activeModel,
    registryRepoCount: snapshot.registryRepoCount,
    totalEmissionShare: snapshot.totalEmissionShare,
    semanticHash: snapshot.semanticHash,
    payloadJson: jsonString(snapshot.payload),
    warningsJson: jsonString(snapshot.warnings),
    generatedAt: snapshot.generatedAt,
  });
}

export async function getLatestUpstreamRulesetSnapshot(env: Env): Promise<UpstreamRulesetSnapshotRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(upstreamRulesetSnapshots).orderBy(desc(upstreamRulesetSnapshots.generatedAt)).limit(1);
  return row ? toUpstreamRulesetSnapshotRecord(row) : null;
}

export async function listLatestUpstreamRulesetSnapshots(env: Env, limit = 2): Promise<UpstreamRulesetSnapshotRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(upstreamRulesetSnapshots).orderBy(desc(upstreamRulesetSnapshots.generatedAt)).limit(limit);
  return rows.map(toUpstreamRulesetSnapshotRecord);
}

export async function upsertUpstreamDriftReport(env: Env, report: UpstreamDriftReportRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(upstreamDriftReports)
    .values({
      id: report.id,
      fingerprint: report.fingerprint,
      severity: report.severity,
      status: report.status,
      summary: report.summary,
      affectedAreasJson: jsonString(report.affectedAreas),
      previousRulesetId: report.previousRulesetId,
      currentRulesetId: report.currentRulesetId,
      issueNumber: report.issueNumber,
      issueUrl: report.issueUrl,
      payloadJson: jsonString(report.payload),
      generatedAt: report.generatedAt,
      updatedAt: report.updatedAt,
    })
    .onConflictDoUpdate({
      target: upstreamDriftReports.fingerprint,
      set: {
        severity: report.severity,
        status: report.status,
        summary: report.summary,
        affectedAreasJson: jsonString(report.affectedAreas),
        previousRulesetId: report.previousRulesetId,
        currentRulesetId: report.currentRulesetId,
        issueNumber: report.issueNumber,
        issueUrl: report.issueUrl,
        payloadJson: jsonString(report.payload),
        updatedAt: report.updatedAt,
      },
    });
}

export async function updateUpstreamDriftReportIssue(env: Env, fingerprint: string, issue: { number: number; url: string }): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(upstreamDriftReports)
    .set({ issueNumber: issue.number, issueUrl: issue.url, updatedAt: nowIso() })
    .where(eq(upstreamDriftReports.fingerprint, fingerprint));
}

export async function listUpstreamDriftReports(env: Env, limit = 20): Promise<UpstreamDriftReportRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(upstreamDriftReports).orderBy(desc(upstreamDriftReports.updatedAt)).limit(limit);
  return rows.map(toUpstreamDriftReportRecord);
}

export async function getOpenUpstreamDriftReportByFingerprint(env: Env, fingerprint: string): Promise<UpstreamDriftReportRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select()
    .from(upstreamDriftReports)
    .where(and(eq(upstreamDriftReports.fingerprint, fingerprint), eq(upstreamDriftReports.status, "open")))
    .limit(1);
  return row ? toUpstreamDriftReportRecord(row) : null;
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

export async function countActiveAuthSessions(env: Env): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(authSessions)
    .where(and(sql`${authSessions.revokedAt} is null`, gte(authSessions.expiresAt, nowIso())));
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
  return Number(row?.count ?? 0);
}

export async function upsertDigestSubscription(
  env: Env,
  input: { login: string; email: string; source?: string; status?: DigestSubscriptionRecord["status"] },
): Promise<DigestSubscriptionRecord> {
  const db = getDb(env.DB);
  const now = nowIso();
  const record: DigestSubscriptionRecord = {
    id: crypto.randomUUID(),
    login: input.login,
    email: input.email.toLowerCase(),
    status: input.status ?? "active",
    source: input.source ?? "app",
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(digestSubscriptions)
    .values({
      id: record.id,
      login: record.login,
      email: record.email,
      status: record.status,
      source: record.source,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    .onConflictDoUpdate({
      target: [digestSubscriptions.login, digestSubscriptions.email],
      set: {
        status: record.status,
        source: record.source,
        updatedAt: now,
      },
    });
  const [row] = await db
    .select()
    .from(digestSubscriptions)
    .where(and(eq(digestSubscriptions.login, record.login), eq(digestSubscriptions.email, record.email)))
    .limit(1);
  return row ? toDigestSubscriptionRecord(row) : record;
}

export async function listDigestSubscriptionsForLogin(env: Env, login: string): Promise<DigestSubscriptionRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(digestSubscriptions).where(eq(digestSubscriptions.login, login)).orderBy(desc(digestSubscriptions.updatedAt)).limit(20);
  return rows.map(toDigestSubscriptionRecord);
}

export async function countActiveDigestSubscriptions(env: Env): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(digestSubscriptions).where(eq(digestSubscriptions.status, "active"));
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
  return Number(row?.count ?? 0);
}

export async function upsertNotificationSubscription(
  env: Env,
  input: { login: string; channel: NotificationChannel; status?: NotificationSubscriptionRecord["status"]; destination?: string | null; source?: string },
): Promise<NotificationSubscriptionRecord> {
  const db = getDb(env.DB);
  const now = nowIso();
  const record: NotificationSubscriptionRecord = {
    id: crypto.randomUUID(),
    login: input.login.toLowerCase(),
    channel: input.channel,
    status: input.status ?? "active",
    destination: input.destination ?? null,
    source: input.source ?? "app",
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(notificationSubscriptions)
    .values({
      id: record.id,
      login: record.login,
      channel: record.channel,
      status: record.status,
      destination: record.destination,
      source: record.source,
    })
    .onConflictDoUpdate({
      target: [notificationSubscriptions.login, notificationSubscriptions.channel],
      set: { status: record.status, destination: record.destination, source: record.source, updatedAt: now },
    });
  const [row] = await db
    .select()
    .from(notificationSubscriptions)
    .where(and(eq(notificationSubscriptions.login, record.login), eq(notificationSubscriptions.channel, record.channel)))
    .limit(1);
  return row ? toNotificationSubscriptionRecord(row) : record;
}

export async function listNotificationSubscriptionsForLogin(env: Env, login: string): Promise<NotificationSubscriptionRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(notificationSubscriptions).where(eq(notificationSubscriptions.login, login.toLowerCase())).limit(20);
  return rows.map(toNotificationSubscriptionRecord);
}

// ─── Issue-watch subscriptions (#699 path B) ─────────────────────────────────────────────────────────

function toIssueWatchSubscription(row: typeof issueWatchSubscriptions.$inferSelect): IssueWatchSubscription {
  return { login: row.login, repoFullName: row.repoFullName, labels: parseJson<string[]>(row.labelsJson, []), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** Subscribe a miner to a repo's new grabbable issues; idempotent on (login, repo) — re-subscribing just
 *  updates the label filter. `login`, `repoFullName`, and `labels` ([]=any) are all lowercased so matching
 *  is case-insensitive: GitHub repo names are case-insensitive, and the delivery lookup keys off the
 *  webhook's canonical `repository.full_name`, so a watch stored under a different casing must still match. */
export async function upsertIssueWatchSubscription(env: Env, input: { login: string; repoFullName: string; labels?: string[] | undefined }): Promise<IssueWatchSubscription> {
  const db = getDb(env.DB);
  const login = input.login.toLowerCase();
  const repoFullName = input.repoFullName.toLowerCase();
  const labels = [...new Set((input.labels ?? []).map((label) => label.toLowerCase().trim()).filter(Boolean))];
  await db
    .insert(issueWatchSubscriptions)
    .values({ id: crypto.randomUUID(), login, repoFullName, labelsJson: jsonString(labels), updatedAt: nowIso() })
    .onConflictDoUpdate({ target: [issueWatchSubscriptions.login, issueWatchSubscriptions.repoFullName], set: { labelsJson: jsonString(labels), updatedAt: nowIso() } });
  const [row] = await db
    .select()
    .from(issueWatchSubscriptions)
    .where(and(eq(issueWatchSubscriptions.login, login), eq(issueWatchSubscriptions.repoFullName, repoFullName)));
  /* v8 ignore next -- the row always exists immediately after the upsert above; the literal is a type-safety fallback. */
  return row ? toIssueWatchSubscription(row) : { login, repoFullName, labels };
}

export async function listIssueWatchSubscriptionsForLogin(env: Env, login: string): Promise<IssueWatchSubscription[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(issueWatchSubscriptions).where(eq(issueWatchSubscriptions.login, login.toLowerCase())).limit(200);
  return rows.map(toIssueWatchSubscription);
}

/** Returns whether a watch existed and was removed (so the caller can report it accurately). */
export async function deleteIssueWatchSubscription(env: Env, login: string, repoFullName: string): Promise<boolean> {
  const db = getDb(env.DB);
  const where = and(eq(issueWatchSubscriptions.login, login.toLowerCase()), eq(issueWatchSubscriptions.repoFullName, repoFullName.toLowerCase()));
  const existing = await db.select({ id: issueWatchSubscriptions.id }).from(issueWatchSubscriptions).where(where);
  if (existing.length === 0) return false;
  await db.delete(issueWatchSubscriptions).where(where);
  return true;
}

/** All miners watching a repo — the candidate recipients when a new grabbable issue opens there. */
export async function listIssueWatchersForRepo(env: Env, repoFullName: string): Promise<IssueWatchSubscription[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(issueWatchSubscriptions).where(eq(issueWatchSubscriptions.repoFullName, repoFullName.toLowerCase())).limit(5000);
  return rows.map(toIssueWatchSubscription);
}

// Idempotency guard: UNIQUE(dedup_key, channel) means a duplicate webhook / queue retry inserts nothing
// and returns the existing row. Returns whether THIS call created the row (so only the first enqueues delivery).
export async function insertNotificationDeliveryIfAbsent(
  env: Env,
  input: Omit<NotificationDeliveryRecord, "id" | "createdAt" | "deliveredAt" | "readAt" | "status"> & { status?: NotificationDeliveryStatus },
): Promise<{ delivery: NotificationDeliveryRecord; created: boolean }> {
  const db = getDb(env.DB);
  const now = nowIso();
  const record: NotificationDeliveryRecord = {
    id: crypto.randomUUID(),
    dedupKey: input.dedupKey,
    channel: input.channel,
    recipientLogin: input.recipientLogin.toLowerCase(),
    eventType: input.eventType,
    repoFullName: input.repoFullName,
    pullNumber: input.pullNumber,
    title: input.title,
    body: input.body,
    deeplink: input.deeplink,
    actorLogin: input.actorLogin,
    status: input.status ?? "pending",
    createdAt: now,
    deliveredAt: null,
    readAt: null,
  };
  const inserted = await db
    .insert(notificationDeliveries)
    .values({
      id: record.id,
      dedupKey: record.dedupKey,
      channel: record.channel,
      recipientLogin: record.recipientLogin,
      eventType: record.eventType,
      repoFullName: record.repoFullName,
      pullNumber: record.pullNumber,
      title: record.title,
      body: record.body,
      deeplink: record.deeplink,
      actorLogin: record.actorLogin,
      status: record.status,
    })
    .onConflictDoNothing({ target: [notificationDeliveries.dedupKey, notificationDeliveries.channel] })
    .returning();
  if (inserted.length > 0 && inserted[0]) return { delivery: toNotificationDeliveryRecord(inserted[0]), created: true };
  const [existing] = await db
    .select()
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.dedupKey, record.dedupKey), eq(notificationDeliveries.channel, record.channel)))
    .limit(1);
  /* v8 ignore next -- onConflictDoNothing only skips when a row already exists, so the re-select always returns it. */
  return { delivery: existing ? toNotificationDeliveryRecord(existing) : record, created: false };
}

export async function countRecentNotificationDeliveries(
  env: Env,
  recipientLogin: string,
  channel: NotificationChannel,
  sinceIso: string,
): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.recipientLogin, recipientLogin.toLowerCase()),
        eq(notificationDeliveries.channel, channel),
        not(eq(notificationDeliveries.status, "suppressed")),
        gte(notificationDeliveries.createdAt, sinceIso),
      ),
    );
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
  return Number(row?.count ?? 0);
}

export async function getNotificationDeliveryById(env: Env, id: string): Promise<NotificationDeliveryRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)).limit(1);
  return row ? toNotificationDeliveryRecord(row) : null;
}

export async function markNotificationDeliveryDelivered(env: Env, id: string): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(notificationDeliveries)
    .set({ status: "delivered", deliveredAt: nowIso() })
    .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.status, "pending")));
}

export async function listNotificationDeliveriesForRecipient(
  env: Env,
  recipientLogin: string,
  options: { channel?: NotificationChannel; eventType?: string; unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationDeliveryRecord[]> {
  const db = getDb(env.DB);
  const conditions: SQL[] = [eq(notificationDeliveries.recipientLogin, recipientLogin.toLowerCase())];
  if (options.channel) conditions.push(eq(notificationDeliveries.channel, options.channel));
  if (options.eventType) conditions.push(eq(notificationDeliveries.eventType, options.eventType));
  if (options.unreadOnly) conditions.push(eq(notificationDeliveries.status, "delivered"));
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(and(...conditions))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 100));
  return rows.map(toNotificationDeliveryRecord);
}

export const MAX_NOTIFICATION_MARK_READ_IDS = 100;
export const MAX_NOTIFICATION_DELIVERY_ID_LENGTH = 128;

// Marks a recipient's delivered notifications read (the badge-clear action). Scoped to recipientLogin so a
// caller can never clear another user's notifications. Passing an empty ids array is a no-op.
// Returns the number of rows transitioned.
export async function markNotificationDeliveriesRead(
  env: Env,
  recipientLogin: string,
  ids?: string[],
): Promise<number> {
  if (ids) {
    if (ids.length === 0) return 0;
    if (ids.length > MAX_NOTIFICATION_MARK_READ_IDS) {
      throw new RangeError(`ids must contain at most ${MAX_NOTIFICATION_MARK_READ_IDS} entries`);
    }
    if (ids.some((id) => id.length > MAX_NOTIFICATION_DELIVERY_ID_LENGTH)) {
      throw new RangeError(`ids entries must be at most ${MAX_NOTIFICATION_DELIVERY_ID_LENGTH} characters`);
    }
  }

  const db = getDb(env.DB);
  const conditions: SQL[] = [
    eq(notificationDeliveries.recipientLogin, recipientLogin.toLowerCase()),
    eq(notificationDeliveries.status, "delivered"),
  ];
  if (ids) conditions.push(inArray(notificationDeliveries.id, ids));
  const updated = await db
    .update(notificationDeliveries)
    .set({ status: "read", readAt: nowIso() })
    .where(and(...conditions))
    .returning({ id: notificationDeliveries.id });
  return updated.length;
}

export async function recordProductUsageEvent(
  env: Env,
  event: {
    surface: ProductUsageSurface;
    eventName: string;
    role?: ProductUsageRole | string | null | undefined;
    actor?: string | null | undefined;
    sessionId?: string | null | undefined;
    route?: string | null | undefined;
    repoFullName?: string | null | undefined;
    targetKey?: string | null | undefined;
    outcome?: ProductUsageOutcome | null | undefined;
    latencyMs?: number | null | undefined;
    clientName?: string | null | undefined;
    clientVersion?: string | null | undefined;
    metadata?: Record<string, unknown> | null | undefined;
    occurredAt?: string | null | undefined;
  },
): Promise<ProductUsageEventRecord> {
  const db = getDb(env.DB);
  const actorRedactor = buildProductUsageActorRedactor(event.actor);
  const sanitizedMetadata = sanitizeProductUsageMetadata(event.metadata, actorRedactor);
  const record: ProductUsageEventRecord = {
    id: crypto.randomUUID(),
    surface: normalizeProductUsageSurface(event.surface),
    role: resolveProductUsageRole({
      explicitRole: event.role,
      surface: normalizeProductUsageSurface(event.surface),
      eventName: boundedProductUsageField(event.eventName, 96) ?? "unknown",
      metadata: sanitizedMetadata,
    }),
    eventName: boundedProductUsageField(event.eventName, 96) ?? "unknown",
    route: boundedProductUsageField(event.route, 160),
    actorHash: await hashProductUsageIdentifier(env, "actor", event.actor),
    sessionHash: await hashProductUsageIdentifier(env, "session", event.sessionId),
    repoFullName: redactProductUsageActor(boundedProductUsageField(event.repoFullName, 256), actorRedactor),
    targetKey: redactProductUsageActor(boundedProductUsageField(event.targetKey, 256), actorRedactor),
    outcome: normalizeProductUsageOutcome(event.outcome),
    latencyMs: normalizeProductUsageLatency(event.latencyMs),
    clientName: redactProductUsageActor(boundedProductUsageField(event.clientName, 80), actorRedactor),
    clientVersion: redactProductUsageActor(boundedProductUsageField(event.clientVersion, 80), actorRedactor),
    metadata: sanitizedMetadata,
    occurredAt: event.occurredAt ?? nowIso(),
  };
  await db.insert(productUsageEvents).values({
    id: record.id,
    surface: record.surface,
    role: record.role,
    eventName: record.eventName,
    route: record.route ?? null,
    actorHash: record.actorHash ?? null,
    sessionHash: record.sessionHash ?? null,
    repoFullName: record.repoFullName ?? null,
    targetKey: record.targetKey ?? null,
    outcome: record.outcome,
    latencyMs: record.latencyMs ?? null,
    clientName: record.clientName ?? null,
    clientVersion: record.clientVersion ?? null,
    metadataJson: jsonString(record.metadata),
    occurredAt: record.occurredAt,
  });
  return record;
}

export async function listProductUsageEvents(
  env: Env,
  options: { limit?: number; sinceIso?: string } = {},
): Promise<ProductUsageEventRecord[]> {
  const db = getDb(env.DB);
  const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 100)));
  const rows = options.sinceIso
    ? await db
        .select()
        .from(productUsageEvents)
        .where(gte(productUsageEvents.occurredAt, options.sinceIso))
        .orderBy(desc(productUsageEvents.occurredAt))
        .limit(limit)
    : await db.select().from(productUsageEvents).orderBy(desc(productUsageEvents.occurredAt)).limit(limit);
  return rows.map(toProductUsageEventRecord);
}

export async function summarizeProductUsageEvents(env: Env, sinceIso?: string): Promise<ProductUsageSummary> {
  const db = getDb(env.DB);
  const [totalRow] = sinceIso
    ? await db.select({ count: sql<number>`count(*)` }).from(productUsageEvents).where(gte(productUsageEvents.occurredAt, sinceIso))
    : await db.select({ count: sql<number>`count(*)` }).from(productUsageEvents);
  const [activeActorRow] = sinceIso
    ? await db
        .select({ count: sql<number>`count(distinct ${productUsageEvents.actorHash})` })
        .from(productUsageEvents)
        .where(and(gte(productUsageEvents.occurredAt, sinceIso), sql`${productUsageEvents.actorHash} is not null`))
    : await db
        .select({ count: sql<number>`count(distinct ${productUsageEvents.actorHash})` })
        .from(productUsageEvents)
        .where(sql`${productUsageEvents.actorHash} is not null`);
  const bySurfaceRows = sinceIso
    ? await db
        .select({ surface: productUsageEvents.surface, count: sql<number>`count(*)` })
        .from(productUsageEvents)
        .where(gte(productUsageEvents.occurredAt, sinceIso))
        .groupBy(productUsageEvents.surface)
    : await db.select({ surface: productUsageEvents.surface, count: sql<number>`count(*)` }).from(productUsageEvents).groupBy(productUsageEvents.surface);
  const byOutcomeRows = sinceIso
    ? await db
        .select({ outcome: productUsageEvents.outcome, count: sql<number>`count(*)` })
        .from(productUsageEvents)
        .where(gte(productUsageEvents.occurredAt, sinceIso))
        .groupBy(productUsageEvents.outcome)
    : await db.select({ outcome: productUsageEvents.outcome, count: sql<number>`count(*)` }).from(productUsageEvents).groupBy(productUsageEvents.outcome);
  const byEventRows = sinceIso
    ? await db
        .select({ eventName: productUsageEvents.eventName, count: sql<number>`count(*)` })
        .from(productUsageEvents)
        .where(gte(productUsageEvents.occurredAt, sinceIso))
        .groupBy(productUsageEvents.eventName)
        .orderBy(sql`count(*) desc`)
        .limit(20)
    : await db
        .select({ eventName: productUsageEvents.eventName, count: sql<number>`count(*)` })
        .from(productUsageEvents)
        .groupBy(productUsageEvents.eventName)
        .orderBy(sql`count(*) desc`)
        .limit(20);
  return {
    since: sinceIso,
    totalEvents: Number(totalRow?.count ?? 0),
    activeActors: Number(activeActorRow?.count ?? 0),
    bySurface: bySurfaceRows.map((row) => ({ surface: normalizeProductUsageSurface(row.surface), count: Number(row.count ?? 0) })),
    byOutcome: byOutcomeRows.map((row) => ({ outcome: normalizeProductUsageOutcome(row.outcome), count: Number(row.count ?? 0) })),
    byEvent: byEventRows.map((row) => ({ eventName: row.eventName, count: Number(row.count ?? 0) })),
  };
}

export async function upsertAgentCommandAnswer(env: Env, answer: AgentCommandAnswerRecord): Promise<AgentCommandAnswerRecord> {
  const now = answer.updatedAt ?? nowIso();
  const createdAt = answer.createdAt ?? now;
  const values = {
    id: answer.id,
    repoFullName: boundedString(answer.repoFullName, 200),
    issueNumber: Math.max(0, Math.round(answer.issueNumber)),
    command: boundedString(answer.command, 64),
    requestCommentId: optionalNumber(answer.requestCommentId),
    responseCommentId: optionalNumber(answer.responseCommentId),
    responseUrl: answer.responseUrl ? boundedString(answer.responseUrl, 500) : null,
    actorKind: answer.actorKind,
    createdAt,
    updatedAt: now,
    metadataJson: jsonString(answer.metadata),
  };
  await getDb(env.DB)
    .insert(githubAgentCommandAnswers)
    .values(values)
    .onConflictDoUpdate({
      target: githubAgentCommandAnswers.id,
      set: {
        repoFullName: values.repoFullName,
        issueNumber: values.issueNumber,
        command: values.command,
        requestCommentId: values.requestCommentId,
        responseCommentId: values.responseCommentId,
        responseUrl: values.responseUrl,
        actorKind: values.actorKind,
        updatedAt: values.updatedAt,
        metadataJson: values.metadataJson,
      },
    });
  return (await getAgentCommandAnswer(env, answer.id))!;
}

export async function getAgentCommandAnswer(env: Env, answerId: string): Promise<AgentCommandAnswerRecord | null> {
  const [row] = await getDb(env.DB).select().from(githubAgentCommandAnswers).where(eq(githubAgentCommandAnswers.id, answerId)).limit(1);
  return row ? toAgentCommandAnswer(row) : null;
}

export async function recordAgentCommandFeedback(env: Env, feedback: AgentCommandFeedbackRecord): Promise<void> {
  const actorHash = await hashCommandFeedbackActor(feedback.repoFullName, feedback.actorLogin);
  const now = feedback.updatedAt ?? nowIso();
  const values = {
    id: feedback.id ?? crypto.randomUUID(),
    answerId: feedback.answerId,
    repoFullName: boundedString(feedback.repoFullName, 200),
    issueNumber: Math.max(0, Math.round(feedback.issueNumber)),
    command: boundedString(feedback.command, 64),
    actorHash,
    vote: feedback.vote,
    source: feedback.source,
    actorKind: feedback.actorKind,
    createdAt: feedback.createdAt ?? now,
    updatedAt: now,
    metadataJson: jsonString(feedback.metadata ?? {}),
  };
  await getDb(env.DB)
    .insert(githubAgentCommandFeedback)
    .values(values)
    .onConflictDoUpdate({
      target: [githubAgentCommandFeedback.answerId, githubAgentCommandFeedback.actorHash],
      set: {
        vote: values.vote,
        source: values.source,
        actorKind: values.actorKind,
        updatedAt: values.updatedAt,
        metadataJson: values.metadataJson,
      },
    });
}

export async function getCommandUsefulnessSummary(env: Env, options: { windowDays?: number; now?: string } = {}): Promise<CommandUsefulnessSummary> {
  const windowDays = clampInteger(options.windowDays ?? 30, 1, 180);
  const now = options.now ?? nowIso();
  const sinceIso = new Date(Date.parse(now) - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await getDb(env.DB)
    .select({
      command: githubAgentCommandFeedback.command,
      feedbackCount: sql<number>`count(*)`,
      usefulCount: sql<number>`coalesce(sum(case when ${githubAgentCommandFeedback.vote} = 'useful' then 1 else 0 end), 0)`,
      notUsefulCount: sql<number>`coalesce(sum(case when ${githubAgentCommandFeedback.vote} = 'not_useful' then 1 else 0 end), 0)`,
      answerCount: sql<number>`count(distinct ${githubAgentCommandFeedback.answerId})`,
      latestFeedbackAt: sql<string | null>`max(${githubAgentCommandFeedback.updatedAt})`,
    })
    .from(githubAgentCommandFeedback)
    .where(gte(githubAgentCommandFeedback.updatedAt, sinceIso))
    .groupBy(githubAgentCommandFeedback.command);
  const commands = rows
    .map((row) => {
      const feedbackCount = Number(row.feedbackCount);
      const usefulCount = Number(row.usefulCount);
      const notUsefulCount = Number(row.notUsefulCount);
      return {
        command: row.command,
        feedbackCount,
        usefulCount,
        notUsefulCount,
        answerCount: Number(row.answerCount),
        usefulnessRate: usefulCount / feedbackCount,
        latestFeedbackAt: row.latestFeedbackAt,
      };
    })
    .sort((left, right) => right.feedbackCount - left.feedbackCount || left.command.localeCompare(right.command));
  const totals = commands.reduce(
    (acc, row) => ({
      feedbackCount: acc.feedbackCount + row.feedbackCount,
      usefulCount: acc.usefulCount + row.usefulCount,
      notUsefulCount: acc.notUsefulCount + row.notUsefulCount,
      answerCount: acc.answerCount + row.answerCount,
      latestFeedbackAt: maxIso(acc.latestFeedbackAt, row.latestFeedbackAt),
    }),
    { feedbackCount: 0, usefulCount: 0, notUsefulCount: 0, answerCount: 0, latestFeedbackAt: null as string | null },
  );
  return {
    windowDays,
    generatedAt: now,
    totals: {
      ...totals,
      usefulnessRate: totals.feedbackCount > 0 ? totals.usefulCount / totals.feedbackCount : null,
    },
    commands,
  };
}

export async function summarizeMcpCompatibilityAdoption(
  env: Env,
  sinceIso?: string,
  options: { limit?: number } = {},
): Promise<McpCompatibilityAdoptionSummary> {
  const db = getDb(env.DB);
  const limit = Math.max(1, Math.min(MCP_COMPATIBILITY_ADOPTION_SCAN_LIMIT, Math.round(options.limit ?? MCP_COMPATIBILITY_ADOPTION_SCAN_LIMIT)));
  const mcpClientWhere = or(eq(productUsageEvents.surface, "mcp"), eq(productUsageEvents.clientName, "gittensory-mcp"), eq(productUsageEvents.clientName, "gittensory-mcp-cli"));
  const baseWhere = sinceIso ? and(mcpClientWhere, gte(productUsageEvents.occurredAt, sinceIso)) : mcpClientWhere;
  const [totalRow] = await db.select({ count: sql<number>`count(*)` }).from(productUsageEvents).where(baseWhere);
  const [activeActorRow] = await db
    .select({ count: sql<number>`count(distinct ${productUsageEvents.actorHash})` })
    .from(productUsageEvents)
    .where(and(baseWhere, sql`${productUsageEvents.actorHash} is not null`));
  const [activeSessionRow] = await db
    .select({ count: sql<number>`count(distinct ${productUsageEvents.sessionHash})` })
    .from(productUsageEvents)
    .where(and(baseWhere, sql`${productUsageEvents.sessionHash} is not null`));
  const rows = await db.select().from(productUsageEvents).where(baseWhere).orderBy(desc(productUsageEvents.occurredAt)).limit(limit + 1);
  const events = rows.slice(0, limit).map(toProductUsageEventRecord);
  const compatibilityStatuses = events.map(mcpCompatibilityStatusForEvent);
  return {
    since: sinceIso,
    totalEvents: Number(totalRow?.count ?? 0),
    activeActors: Number(activeActorRow?.count ?? 0),
    activeSessions: Number(activeSessionRow?.count ?? 0),
    scannedEvents: events.length,
    scanLimit: limit,
    truncated: rows.length > limit || Number(totalRow?.count ?? 0) > limit,
    minimumSupportedVersion: MINIMUM_SUPPORTED_MCP_VERSION,
    latestRecommendedVersion: LATEST_RECOMMENDED_MCP_VERSION,
    staleEvents: compatibilityStatuses.filter((status) => status === "stale").length,
    incompatibleEvents: compatibilityStatuses.filter((status) => status === "incompatible").length,
    byClientVersion: countProductUsageDimensions(events.map(mcpClientVersionForEvent)),
    byProtocolVersion: countProductUsageDimensions(events.map((event) => productUsageMetadataString(event, "protocolVersion") ?? "unknown")),
    byCompatibilityStatus: countProductUsageDimensions(compatibilityStatuses).map(({ key, count }) => ({ status: normalizeMcpCompatibilityStatus(key), count })),
  };
}

export async function rollupProductUsageDaily(
  env: Env,
  options: { day?: string; days?: number; nowIso?: string } = {},
): Promise<ProductUsageRollupRunResult> {
  const generatedAt = options.nowIso ?? nowIso();
  const requestedDays = options.day ? [normalizeProductUsageRollupDay(options.day, generatedAt)] : productUsageRollupDays(generatedAt, options.days ?? 7);
  const rollups: ProductUsageDailyRollupRecord[] = [];
  for (const day of requestedDays) rollups.push(await upsertProductUsageDailyRollup(env, day, generatedAt));
  return { generatedAt, requestedDays, rollups, status: await getProductUsageRollupStatus(env, { nowIso: generatedAt }) };
}

export async function listProductUsageDailyRollups(
  env: Env,
  options: { limit?: number; fromDay?: string } = {},
): Promise<ProductUsageDailyRollupRecord[]> {
  const db = getDb(env.DB);
  const limit = Math.max(1, Math.min(90, Math.round(options.limit ?? 14)));
  const rows = options.fromDay
    ? await db
        .select()
        .from(productUsageDailyRollups)
        .where(gte(productUsageDailyRollups.day, options.fromDay))
        .orderBy(desc(productUsageDailyRollups.day))
        .limit(limit)
    : await db.select().from(productUsageDailyRollups).orderBy(desc(productUsageDailyRollups.day)).limit(limit);
  return rows.map(toProductUsageDailyRollupRecord);
}

export async function getProductUsageRollupStatus(
  env: Env,
  options: { nowIso?: string; lookbackDays?: number } = {},
): Promise<ProductUsageRollupStatus> {
  const db = getDb(env.DB);
  const generatedAt = options.nowIso ?? nowIso();
  const lookbackDays = Math.max(1, Math.min(31, Math.round(options.lookbackDays ?? 14)));
  const sinceDay = addProductUsageUtcDays(productUsageDayFromIso(generatedAt), -(lookbackDays - 1));
  const [latestEvent] = await db.select().from(productUsageEvents).orderBy(desc(productUsageEvents.occurredAt)).limit(1);
  const rollups = await listProductUsageDailyRollups(env, { fromDay: sinceDay, limit: lookbackDays + 1 });
  const rollupByDay = new Map(rollups.map((rollup) => [rollup.day, rollup]));
  const eventDayExpr = sql<string>`substr(${productUsageEvents.occurredAt}, 1, 10)`;
  const eventDayRows = await db
    .select({ day: eventDayExpr, count: sql<number>`count(*)` })
    .from(productUsageEvents)
    .where(gte(productUsageEvents.occurredAt, `${sinceDay}T00:00:00.000Z`))
    .groupBy(eventDayExpr);
  const eventDayCounts = new Map(eventDayRows.map((row) => [row.day, Number(row.count ?? 0)]));
  const eventDays = [...eventDayCounts.keys()].sort();
  const missingDays = eventDays.filter((day) => !rollupByDay.has(day));
  const incompleteDays = rollups.filter((rollup) => rollup.status === "incomplete").map((rollup) => rollup.day);
  const partialDays = rollups.filter((rollup) => rollup.status === "partial").map((rollup) => rollup.day);
  const latestRollup = rollups[0];
  const latestEventAt = latestEvent?.occurredAt ?? null;
  const staleDays = [
    ...new Set([
      ...eventDays.filter((day) => {
        const rollup = rollupByDay.get(day);
        return rollup ? rollup.sourceEventCount !== eventDayCounts.get(day) : false;
      }),
      ...(latestEventAt && latestRollup?.generatedAt && latestEventAt > latestRollup.generatedAt ? [productUsageDayFromIso(latestEventAt)] : []),
    ]),
  ].sort();
  const warnings = [
    ...(missingDays.length > 0 ? [`${missingDays.length} product usage day(s) have events but no rollup.`] : []),
    ...(incompleteDays.length > 0 ? [`${incompleteDays.length} product usage rollup day(s) hit the worker-safe event scan cap.`] : []),
    ...(staleDays.length > 0 ? ["Product usage rollups are stale relative to the latest raw event."] : []),
    ...(partialDays.length > 0 ? ["Current-day product usage rollup is partial until the UTC day closes."] : []),
  ];
  const status: ProductUsageRollupStatus["status"] = !latestEvent
    ? "empty"
    : staleDays.length > 0
      ? "stale"
      : missingDays.length > 0
        ? "incomplete"
        : incompleteDays.length > 0
          ? "incomplete"
          : partialDays.length > 0
            ? "partial"
            : "ready";
  return {
    status,
    generatedAt,
    latestEventAt,
    latestRollupDay: latestRollup?.day ?? null,
    latestRollupGeneratedAt: latestRollup?.generatedAt ?? null,
    missingDays,
    staleDays,
    incompleteDays,
    warnings,
  };
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

export type PrVisibilitySkipAuditEvent = {
  repoFullName: string;
  pullNumber: number;
  reason: string;
  outcome: AuditEventRecord["outcome"];
  createdAt: string;
};

export type PrVisibilitySkipAuditPage = {
  limit: number;
  hasMore: boolean;
  items: PrVisibilitySkipAuditEvent[];
};

export async function listPrVisibilitySkipAuditEvents(
  env: Env,
  options: {
    limit?: number | undefined;
    repoFullNames?: string[] | undefined;
    reason?: string | undefined;
    sinceIso?: string | undefined;
  } = {},
): Promise<PrVisibilitySkipAuditPage> {
  const limit = clampInteger(options.limit ?? 50, 1, 100);
  const scopedRepoNames = options.repoFullNames === undefined ? undefined : uniqueRepoNames(options.repoFullNames.map((name) => name.trim()).filter(Boolean));
  if (scopedRepoNames !== undefined && scopedRepoNames.length === 0) return { limit, hasMore: false, items: [] };

  const conditions: SQL[] = [eq(auditEvents.eventType, "github_app.pr_visibility_skipped")];
  if (options.reason) conditions.push(eq(auditEvents.detail, options.reason));
  if (options.sinceIso) conditions.push(gte(auditEvents.createdAt, options.sinceIso));
  if (scopedRepoNames !== undefined) {
    const repoFilters = scopedRepoNames.map((repoFullName) => {
      const prefix = `${repoFullName.toLowerCase()}#`;
      const upperBound = `${repoFullName.toLowerCase()}$`;
      return sql`lower(${auditEvents.targetKey}) >= ${prefix} and lower(${auditEvents.targetKey}) < ${upperBound}`;
    });
    const repoFilter = or(...repoFilters);
    if (repoFilter) conditions.push(repoFilter);
  }

  const rowLimit = Math.min(500, limit * 5 + 20);
  const rows = await getDb(env.DB)
    .select({
      targetKey: auditEvents.targetKey,
      detail: auditEvents.detail,
      outcome: auditEvents.outcome,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(rowLimit);
  const items = rows.flatMap((row) => {
    const target = parsePullRequestTargetKey(row.targetKey);
    if (!target) return [];
    return [
      {
        repoFullName: target.repoFullName,
        pullNumber: target.pullNumber,
        reason: row.detail ?? "skipped",
        outcome: row.outcome as AuditEventRecord["outcome"],
        createdAt: row.createdAt,
      },
    ];
  });
  return { limit, hasMore: items.length > limit, items: items.slice(0, limit) };
}

export async function getFreshOfficialMinerDetection(env: Env, login: string, now = nowIso()): Promise<OfficialGittensorMinerDetection | null> {
  const [row] = await getDb(env.DB).select().from(officialMinerDetections).where(and(eq(officialMinerDetections.login, login.toLowerCase()), gte(officialMinerDetections.expiresAt, now))).limit(1);
  return row ? toOfficialMinerDetection(row) : null;
}

export async function upsertOfficialMinerDetection(env: Env, login: string, detection: OfficialGittensorMinerDetection, ttlMs: number, fetchedAtMs = Date.now()): Promise<OfficialGittensorMinerDetection> {
  const fetchedAt = new Date(fetchedAtMs).toISOString();
  const cacheableDetection = toCacheableOfficialMinerDetection(detection);
  const values = {
    login: login.toLowerCase(), status: cacheableDetection.status,
    snapshotJson: cacheableDetection.status === "confirmed" ? jsonString(cacheableDetection.snapshot) : "{}",
    error: cacheableDetection.status === "unavailable" ? cacheableDetection.error : null, fetchedAt,
    expiresAt: new Date(fetchedAtMs + ttlMs).toISOString(), updatedAt: fetchedAt,
  };
  await getDb(env.DB).insert(officialMinerDetections).values(values).onConflictDoUpdate({ target: officialMinerDetections.login, set: values });
  return cacheableDetection;
}

function toCacheableOfficialMinerDetection(detection: OfficialGittensorMinerDetection): OfficialGittensorMinerDetection {
  return detection.status === "confirmed" ? { status: "confirmed", snapshot: toCacheableGittensorSnapshot(detection.snapshot) } : detection;
}

const OFFICIAL_MINER_CACHE_STRING_LIMITS = {
  githubId: 128,
  githubUsername: 128,
  failedReason: 512,
  timestamp: 64,
} as const;

function toCacheableGittensorSnapshot(snapshot: Partial<GittensorContributorSnapshot>): GittensorContributorSnapshot {
  return {
    source: "gittensor_api",
    githubId: boundedString(snapshot.githubId, OFFICIAL_MINER_CACHE_STRING_LIMITS.githubId),
    githubUsername: boundedString(snapshot.githubUsername, OFFICIAL_MINER_CACHE_STRING_LIMITS.githubUsername),
    uid: optionalNumber(snapshot.uid),
    failedReason:
      typeof snapshot.failedReason === "string"
        ? boundedString(snapshot.failedReason, OFFICIAL_MINER_CACHE_STRING_LIMITS.failedReason)
        : snapshot.failedReason === null
          ? null
          : undefined,
    evaluatedAt: typeof snapshot.evaluatedAt === "string" ? boundedString(snapshot.evaluatedAt, OFFICIAL_MINER_CACHE_STRING_LIMITS.timestamp) : undefined,
    updatedAt: typeof snapshot.updatedAt === "string" ? boundedString(snapshot.updatedAt, OFFICIAL_MINER_CACHE_STRING_LIMITS.timestamp) : undefined,
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
    // The public-surface cache only needs identity, status, and aggregate totals.
    // Do not persist per-repository, PR, title, or label data from Gittensor/GitHub;
    // those untrusted arrays can be arbitrarily large and make D1 rows expensive to
    // serialize, store, read, and parse during webhook processing.
    repositories: [],
    pullRequests: [],
    issueMirrorAvailable: Boolean(snapshot.issueMirrorAvailable),
    issues: [],
    issueLabels: [],
  };
}

function boundedString(value: unknown, maxLength: number): string {
  return String(value ?? "").slice(0, maxLength);
}

async function hashCommandFeedbackActor(repoFullName: string, actorLogin: string): Promise<string> {
  return `sha256:${await sha256Hex(`gittensory-command-feedback:v1:${repoFullName.toLowerCase()}:${actorLogin.toLowerCase()}`)}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function uniqueRepoNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function parsePullRequestTargetKey(targetKey: string | null | undefined): { repoFullName: string; pullNumber: number } | null {
  if (!targetKey) return null;
  const delimiter = targetKey.lastIndexOf("#");
  if (delimiter <= 0 || delimiter === targetKey.length - 1) return null;
  const repoFullName = targetKey.slice(0, delimiter);
  const pullNumber = Number(targetKey.slice(delimiter + 1));
  if (!repoFullName.includes("/") || !Number.isInteger(pullNumber) || pullNumber <= 0) return null;
  return { repoFullName, pullNumber };
}

function maxIso(left: string | null | undefined, right: string | null | undefined): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return right > left ? right : left;
}

function outcomeStateBuckets(outcomes: AgentRecommendationOutcomeRecord[]): AgentRecommendationOutcomeSummary["states"] {
  const states: AgentRecommendationOutcomeState[] = ["accepted", "merged", "improved", "closed", "rejected", "stale", "ignored"];
  return states.flatMap((state) => {
    const count = outcomes.filter((outcome) => outcome.outcomeState === state).length;
    return count > 0 ? [{ state, count }] : [];
  });
}

function recommendationOutcomeTotals(
  outcomes: AgentRecommendationOutcomeRecord[],
  maintainerLaneTotal: number,
): AgentRecommendationOutcomeSummary["totals"] {
  const accepted = outcomes.filter((outcome) => outcome.outcomeState === "accepted").length;
  const rejected = outcomes.filter((outcome) => outcome.outcomeState === "rejected").length;
  const merged = outcomes.filter((outcome) => outcome.outcomeState === "merged").length;
  const improved = outcomes.filter((outcome) => outcome.outcomeState === "improved").length;
  const closed = outcomes.filter((outcome) => outcome.outcomeState === "closed").length;
  const stale = outcomes.filter((outcome) => outcome.outcomeState === "stale").length;
  const ignored = outcomes.filter((outcome) => outcome.outcomeState === "ignored").length;
  return {
    total: outcomes.length,
    accepted,
    rejected,
    ignored,
    stale,
    merged,
    closed,
    improved,
    positive: accepted + merged + improved,
    negative: closed + rejected + stale + ignored,
    maintainerLaneTotal,
  };
}

function recommendationOutcomeSources(outcomes: AgentRecommendationOutcomeRecord[]): AgentRecommendationOutcomeSummary["sources"] {
  const explicit = outcomes.filter((outcome) => outcome.source === "explicit").length;
  return {
    explicit,
    inferred: outcomes.length - explicit,
  };
}

function summarizeRecommendationOutcomeRepos(outcomes: AgentRecommendationOutcomeRecord[]): AgentRecommendationOutcomeSummary["repos"] {
  const byRepo = new Map<string, AgentRecommendationOutcomeRecord[]>();
  for (const outcome of outcomes) {
    const repoFullName = outcome.outcomeRepoFullName ?? outcome.targetRepoFullName;
    if (!repoFullName) continue;
    const key = repoFullName.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), outcome]);
  }
  return [...byRepo.values()]
    .map((repoOutcomes) => {
      const firstRepo = repoOutcomes[0]!;
      const nonMaintainer = repoOutcomes.filter((outcome) => !outcome.maintainerLane);
      const totals = recommendationOutcomeTotals(nonMaintainer, repoOutcomes.length - nonMaintainer.length);
      const signal: AgentRecommendationOutcomeSummary["repos"][number]["signal"] =
        totals.positive > totals.negative ? "positive" : totals.negative > totals.positive ? "negative" : totals.total > 0 ? "mixed" : "neutral";
      return {
        repoFullName: firstRepo.outcomeRepoFullName ?? firstRepo.targetRepoFullName ?? "unknown/repo",
        total: totals.total,
        accepted: totals.accepted,
        rejected: totals.rejected,
        ignored: totals.ignored,
        stale: totals.stale,
        merged: totals.merged,
        closed: totals.closed,
        improved: totals.improved,
        positive: totals.positive,
        negative: totals.negative,
        maintainerLaneTotal: totals.maintainerLaneTotal,
        latestOutcomeAt: repoOutcomes.reduce((latest, outcome) => maxIso(latest, outcome.updatedAt ?? outcome.detectedAt), null as string | null),
        signal,
      };
    })
    .sort((left, right) => right.total - left.total || left.repoFullName.localeCompare(right.repoFullName))
    .slice(0, 20);
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
  /* v8 ignore next -- SQL aggregate sum always returns one row; fallback protects D1 driver anomalies. */
  return Number(row?.total ?? 0);
}

/**
 * Count a repo's maintainer-billed (BYOK) AI calls since `sinceIso`, across ALL AI features (review +
 * slop + any future BYOK path). One shared per-repo/day budget governs every BYOK feature, so a repo
 * cannot multiply its frontier-model spend by enabling more capabilities.
 */
export async function countByokAiEventsForRepoSince(env: Env, repoFullName: string, sinceIso: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(aiUsageEvents)
    .where(
      and(
        gte(aiUsageEvents.createdAt, sinceIso),
        eq(aiUsageEvents.status, "ok"),
        sql`${aiUsageEvents.model} like 'byok:%'`,
        sql`json_extract(${aiUsageEvents.metadataJson}, '$.repoFullName') = ${repoFullName}`,
      ),
    );
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
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

export async function getBurdenForecast(env: Env, repoFullName: string): Promise<BurdenForecastRecord | null> {
  const db = getDb(env.DB);
  const row = await db.select().from(burdenForecasts).where(eq(burdenForecasts.repoFullName, repoFullName)).limit(1);
  const first = row[0];
  if (!first) return null;
  return {
    repoFullName: first.repoFullName,
    payload: parseJson<Record<string, JsonValue>>(first.payloadJson, {}),
    generatedAt: first.generatedAt,
  };
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
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
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
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
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
  /* v8 ignore next -- D1 update metadata normally includes changes; fallback protects driver anomalies. */
  return Number(result.meta.changes ?? 0);
}

export async function listIssues(env: Env, fullName: string): Promise<IssueRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(issues).where(eq(issues.repoFullName, fullName)).limit(500);
  return rows.map(toIssueRecordFromRow);
}

/**
 * Closed issues whose body carries a contributor-issue-draft marker, recent-first and bounded.
 * Used to suppress re-proposing drafts a maintainer already declined (closed).
 */
export async function listClosedContributorDraftIssues(env: Env, fullName: string, markerPrefix: string, limit = 200): Promise<IssueRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.repoFullName, fullName), eq(issues.state, "closed"), sql`${issues.payloadJson} LIKE ${`%${markerPrefix}%`}`))
    .orderBy(desc(issues.updatedAt))
    .limit(limit);
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
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
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
  /* v8 ignore next -- D1 update metadata normally includes changes; fallback protects driver anomalies. */
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

export async function getRepoAuthorPullRequestHistory(env: Env, fullName: string, login: string, excludeNumber?: number): Promise<{ mergedPrCount: number; closedUnmergedPrCount: number }> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({
      mergedPrCount: sql<number>`sum(case when ${pullRequests.mergedAt} is not null or ${pullRequests.state} = 'merged' then 1 else 0 end)`,
      closedUnmergedPrCount: sql<number>`sum(case when ${pullRequests.state} = 'closed' and ${pullRequests.mergedAt} is null then 1 else 0 end)`,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoFullName, fullName),
        loginMatches(pullRequests.authorLogin, login),
        excludeNumber === undefined ? undefined : not(eq(pullRequests.number, excludeNumber)),
      ),
    );
  return {
    mergedPrCount: Number(row?.mergedPrCount ?? 0),
    closedUnmergedPrCount: Number(row?.closedUnmergedPrCount ?? 0),
  };
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

export async function listRepoPullRequestFiles(env: Env, fullName: string): Promise<PullRequestFileRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequestFiles).where(eq(pullRequestFiles.repoFullName, fullName)).limit(2000);
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

export async function listRepoPullRequestReviews(env: Env, fullName: string): Promise<PullRequestReviewRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(pullRequestReviews).where(eq(pullRequestReviews.repoFullName, fullName)).limit(2000);
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
        // Keep a previously-hydrated file list instead of clobbering it with an empty
        // one (e.g. a files-less upsert or a failed file fetch).
        changedFilesJson: pr.changedFiles.length > 0 ? jsonString(pr.changedFiles) : sql`${recentMergedPullRequests.changedFilesJson}`,
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
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
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

export async function listBountiesByRepo(env: Env, fullName: string): Promise<BountyRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(bounties).where(eq(bounties.repoFullName, fullName)).orderBy(desc(bounties.updatedAt)).limit(500);
  return rows.map(toBountyRecord);
}

export async function listBountyLifecycleEvents(env: Env, bountyId: string): Promise<BountyLifecycleEventRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(bountyLifecycleEvents).where(eq(bountyLifecycleEvents.bountyId, bountyId)).orderBy(desc(bountyLifecycleEvents.generatedAt)).limit(100);
  return rows.map(toBountyLifecycleEventRecord);
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

export async function listLatestSignalSnapshotsByTarget(
  env: Env,
  options: { limit?: number; generatedAfter?: string; maxTargetKeyChars?: number } = {},
): Promise<SignalSnapshotRecord[]> {
  const limit = Math.max(1, Math.min(options.limit ?? MAX_SIGNAL_FRESHNESS_TARGETS, MAX_SIGNAL_FRESHNESS_TARGETS));
  const generatedAfter = options.generatedAfter ?? new Date(Date.now() - SIGNAL_FRESHNESS_LOOKBACK_MS).toISOString();
  const maxTargetKeyChars = Math.max(1, Math.min(options.maxTargetKeyChars ?? MAX_SIGNAL_FRESHNESS_TARGET_KEY_CHARS, MAX_SIGNAL_FRESHNESS_TARGET_KEY_CHARS));
  const freshnessSignalPlaceholders = FRESHNESS_SIGNAL_TYPES.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `
      SELECT id, signal_type, target_key, repo_full_name, generated_at
      FROM (
        SELECT
          id,
          signal_type,
          target_key,
          repo_full_name,
          generated_at,
          row_number() OVER (
            PARTITION BY signal_type, target_key
            ORDER BY generated_at DESC, id DESC
          ) AS snapshot_rank
        FROM signal_snapshots
        WHERE generated_at >= ?
          AND length(target_key) <= ?
          AND signal_type IN (${freshnessSignalPlaceholders})
      )
      WHERE snapshot_rank = 1
      ORDER BY generated_at ASC, signal_type, target_key
      LIMIT ?
    `,
  )
    .bind(generatedAfter, maxTargetKeyChars, ...FRESHNESS_SIGNAL_TYPES, limit)
    .all<{ id: string; signal_type: string; target_key: string; repo_full_name: string | null; generated_at: string }>();
  return results.map((row) => ({
    id: row.id,
    signalType: row.signal_type,
    targetKey: row.target_key,
    repoFullName: row.repo_full_name,
    payload: {},
    generatedAt: row.generated_at,
  }));
}

export async function createAgentRun(env: Env, run: AgentRunRecord): Promise<void> {
  /* v8 ignore start -- Agent-run timestamp defaults normalize internal records; route/orchestrator tests cover persisted behavior. */
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
  /* v8 ignore stop */
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

export async function listAgentRunsForActor(env: Env, actorLogin: string, limit = 50): Promise<AgentRunRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.actorLogin, actorLogin)).orderBy(desc(agentRuns.updatedAt)).limit(limit);
  return rows.map(toAgentRunRecord);
}

export async function listAgentActions(env: Env, runId: string): Promise<AgentActionRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(agentActions).where(eq(agentActions.runId, runId)).orderBy(agentActions.createdAt).limit(100);
  return rows.map(toAgentActionRecord);
}

export async function replaceAgentActions(env: Env, runId: string, actions: AgentActionRecord[]): Promise<void> {
  /* v8 ignore start -- Agent action optional-impact fields are defensive payload normalization. */
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
  /* v8 ignore stop */
}

export async function persistAgentContextSnapshot(env: Env, snapshot: AgentContextSnapshotRecord): Promise<void> {
  /* v8 ignore start -- Agent context optional IDs normalize partially generated local-analysis snapshots. */
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
  /* v8 ignore stop */
}

export async function listAgentContextSnapshots(env: Env, runId: string): Promise<AgentContextSnapshotRecord[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(agentContextSnapshots).where(eq(agentContextSnapshots.runId, runId)).orderBy(desc(agentContextSnapshots.createdAt)).limit(50);
  return rows.map(toAgentContextSnapshotRecord);
}

export async function upsertAgentRecommendationOutcome(env: Env, outcome: AgentRecommendationOutcomeRecord): Promise<AgentRecommendationOutcomeRecord> {
  const source = normalizeAgentRecommendationOutcomeSource(outcome.source);
  const existing = source === "inferred" ? await getAgentRecommendationOutcome(env, outcome.actionId) : null;
  if (existing?.source === "explicit") return existing;

  const now = outcome.updatedAt ?? nowIso();
  const values = {
    id: outcome.id ?? `outcome:${outcome.actionId}`,
    actionId: outcome.actionId,
    runId: outcome.runId,
    actorLogin: boundedString(outcome.actorLogin, 100),
    actionType: outcome.actionType,
    surface: outcome.surface ?? null,
    snapshotId: outcome.snapshotId ?? null,
    targetRepoFullName: outcome.targetRepoFullName ? boundedString(outcome.targetRepoFullName, 200) : null,
    targetPullNumber: outcome.targetPullNumber ?? null,
    targetIssueNumber: outcome.targetIssueNumber ?? null,
    source,
    outcomeState: outcome.outcomeState,
    outcomeTargetType: outcome.outcomeTargetType,
    outcomeRepoFullName: outcome.outcomeRepoFullName ? boundedString(outcome.outcomeRepoFullName, 200) : null,
    outcomePullNumber: outcome.outcomePullNumber ?? null,
    outcomeIssueNumber: outcome.outcomeIssueNumber ?? null,
    maintainerLane: outcome.maintainerLane,
    confidence: outcome.confidence,
    reason: boundedString(outcome.reason, 500),
    sourceUpdatedAt: outcome.sourceUpdatedAt ?? null,
    detectedAt: outcome.detectedAt ?? now,
    metadataJson: jsonString(outcome.metadata ?? {}),
    createdAt: outcome.createdAt ?? now,
    updatedAt: now,
  };
  await getDb(env.DB)
    .insert(agentRecommendationOutcomes)
    .values(values)
    .onConflictDoUpdate({
      target: agentRecommendationOutcomes.actionId,
      set: {
        actorLogin: values.actorLogin,
        actionType: values.actionType,
        surface: values.surface,
        snapshotId: values.snapshotId,
        targetRepoFullName: values.targetRepoFullName,
        targetPullNumber: values.targetPullNumber,
        targetIssueNumber: values.targetIssueNumber,
        source: values.source,
        outcomeState: values.outcomeState,
        outcomeTargetType: values.outcomeTargetType,
        outcomeRepoFullName: values.outcomeRepoFullName,
        outcomePullNumber: values.outcomePullNumber,
        outcomeIssueNumber: values.outcomeIssueNumber,
        maintainerLane: values.maintainerLane,
        confidence: values.confidence,
        reason: values.reason,
        sourceUpdatedAt: values.sourceUpdatedAt,
        detectedAt: values.detectedAt,
        metadataJson: values.metadataJson,
        updatedAt: values.updatedAt,
      },
    });
  return (await getAgentRecommendationOutcome(env, outcome.actionId))!;
}

export async function getAgentRecommendationOutcome(env: Env, actionId: string): Promise<AgentRecommendationOutcomeRecord | null> {
  const [row] = await getDb(env.DB).select().from(agentRecommendationOutcomes).where(eq(agentRecommendationOutcomes.actionId, actionId)).limit(1);
  return row ? toAgentRecommendationOutcomeRecord(row) : null;
}

export async function listAgentRecommendationOutcomes(
  env: Env,
  options: { actorLogin?: string; repoFullName?: string; windowDays?: number; now?: string; limit?: number } = {},
): Promise<AgentRecommendationOutcomeRecord[]> {
  const limit = clampInteger(options.limit ?? 500, 1, 5000);
  const conditions = [];
  if (options.actorLogin) conditions.push(eq(agentRecommendationOutcomes.actorLogin, options.actorLogin));
  if (options.repoFullName) {
    const repoFullName = options.repoFullName.toLowerCase();
    conditions.push(
      or(
        sql`lower(${agentRecommendationOutcomes.outcomeRepoFullName}) = ${repoFullName}`,
        sql`lower(${agentRecommendationOutcomes.targetRepoFullName}) = ${repoFullName}`,
      ),
    );
  }
  if (options.windowDays !== undefined) {
    const windowDays = clampInteger(options.windowDays, 1, 365);
    const now = options.now ?? nowIso();
    conditions.push(gte(agentRecommendationOutcomes.updatedAt, new Date(Date.parse(now) - windowDays * 24 * 60 * 60 * 1000).toISOString()));
  }
  const rows = await getDb(env.DB)
    .select()
    .from(agentRecommendationOutcomes)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(agentRecommendationOutcomes.updatedAt), agentRecommendationOutcomes.actionId)
    .limit(limit);
  return rows.map(toAgentRecommendationOutcomeRecord);
}

// #554 gate false-positive telemetry. Upsert the latest gate-block row for a (repo, PR): one row per PR so a
// re-evaluation overwrites the prior block. Preserves `overridden` once set true (a later block must not
// clear a maintainer's override). Privacy: never stores actor or trust/reward fields.
export async function recordGateBlockOutcome(
  env: Env,
  input: { repoFullName: string; pullNumber: number; headSha?: string | null | undefined; blockerCodes: string[] },
): Promise<void> {
  const repoFullName = boundedString(input.repoFullName, 200);
  const values = {
    id: `gate:${repoFullName}#${input.pullNumber}`,
    repoFullName,
    pullNumber: input.pullNumber,
    headSha: input.headSha ?? null,
    blockerCodesJson: jsonString(input.blockerCodes),
    overridden: false,
    // blockedAt + updatedAt default to nowIso() via the schema `$defaultFn` on a fresh insert.
  };
  await getDb(env.DB)
    .insert(gateOutcomes)
    .values(values)
    .onConflictDoUpdate({
      target: [gateOutcomes.repoFullName, gateOutcomes.pullNumber],
      // Refresh the codes/head/timestamp on a re-block; `overridden` is deliberately omitted so a true value
      // is preserved.
      set: { headSha: values.headSha, blockerCodesJson: values.blockerCodesJson, updatedAt: nowIso() },
    });
}

// Flag a gate-block row as maintainer-overridden (#538). No-op when no row exists (an override without a
// recorded block — e.g. a pre-#554 PR — has nothing to flag).
export async function markGateOutcomeOverridden(env: Env, repoFullName: string, pullNumber: number): Promise<void> {
  await getDb(env.DB)
    .update(gateOutcomes)
    .set({ overridden: true, updatedAt: nowIso() })
    .where(and(eq(gateOutcomes.repoFullName, boundedString(repoFullName, 200)), eq(gateOutcomes.pullNumber, pullNumber)));
}

export async function listGateOutcomes(
  env: Env,
  options: { repoFullName?: string; windowDays?: number; now?: string; limit?: number } = {},
): Promise<GateOutcomeRecord[]> {
  const limit = clampInteger(options.limit ?? 500, 1, 5000);
  const conditions = [];
  if (options.repoFullName) conditions.push(eq(gateOutcomes.repoFullName, options.repoFullName));
  if (options.windowDays !== undefined) {
    const windowDays = clampInteger(options.windowDays, 1, 365);
    const now = options.now ?? nowIso();
    conditions.push(gte(gateOutcomes.updatedAt, new Date(Date.parse(now) - windowDays * 24 * 60 * 60 * 1000).toISOString()));
  }
  const rows = await getDb(env.DB)
    .select()
    .from(gateOutcomes)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(gateOutcomes.updatedAt), gateOutcomes.id)
    .limit(limit);
  return rows.map(toGateOutcomeRecord);
}

// #779 approval queue. Stage an auto_with_approval action; `created:false` when one is already staged for this
// (repo, pull, action_class) — re-evaluation never duplicates a staged action or re-surfaces a decided one.
export async function createPendingAgentActionIfAbsent(
  env: Env,
  input: { repoFullName: string; pullNumber: number; installationId: number; actionClass: AgentActionClass; autonomyLevel: AutonomyLevel; params: AgentPendingActionParams; reason?: string | null | undefined },
): Promise<{ action: AgentPendingActionRecord; created: boolean }> {
  const repoFullName = boundedString(input.repoFullName, 200);
  const values = {
    id: crypto.randomUUID(),
    repoFullName,
    pullNumber: input.pullNumber,
    installationId: input.installationId,
    actionClass: input.actionClass,
    autonomyLevel: input.autonomyLevel,
    paramsJson: jsonString(input.params),
    reason: input.reason ?? null,
    status: "pending",
  };
  const inserted = await getDb(env.DB)
    .insert(agentPendingActions)
    .values(values)
    .onConflictDoNothing({ target: [agentPendingActions.repoFullName, agentPendingActions.pullNumber, agentPendingActions.actionClass] })
    .returning();
  if (inserted.length > 0 && inserted[0]) return { action: toAgentPendingActionRecord(inserted[0]), created: true };
  // A row already exists for this target — return it unchanged (the staged/decided action is sticky).
  const [existing] = await getDb(env.DB)
    .select()
    .from(agentPendingActions)
    .where(and(eq(agentPendingActions.repoFullName, repoFullName), eq(agentPendingActions.pullNumber, input.pullNumber), eq(agentPendingActions.actionClass, input.actionClass)))
    .limit(1);
  /* v8 ignore next -- onConflictDoNothing only no-ops when a conflicting row exists, so the lookup always finds it. */
  if (!existing) throw new Error(`pending action conflict had no row: ${repoFullName}#${input.pullNumber} ${input.actionClass}`);
  return { action: toAgentPendingActionRecord(existing), created: false };
}

function pendingAgentActionConditions(options: { repoFullName?: string; status?: AgentPendingActionStatus } = {}): SQL[] {
  const conditions = [];
  if (options.repoFullName) conditions.push(eq(agentPendingActions.repoFullName, options.repoFullName));
  if (options.status) conditions.push(eq(agentPendingActions.status, options.status));
  return conditions;
}

export async function listPendingAgentActions(
  env: Env,
  options: { repoFullName?: string; status?: AgentPendingActionStatus; limit?: number } = {},
): Promise<AgentPendingActionRecord[]> {
  const limit = clampInteger(options.limit ?? 200, 1, 2000);
  const conditions = pendingAgentActionConditions(options);
  const rows = await getDb(env.DB)
    .select()
    .from(agentPendingActions)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(agentPendingActions.createdAt), agentPendingActions.id)
    .limit(limit);
  return rows.map(toAgentPendingActionRecord);
}

export async function countPendingAgentActions(
  env: Env,
  options: { repoFullName?: string; status?: AgentPendingActionStatus } = {},
): Promise<number> {
  const conditions = pendingAgentActionConditions(options);
  const [row] = await getDb(env.DB)
    .select({ count: sql<number>`count(*)` })
    .from(agentPendingActions)
    .where(conditions.length === 0 ? undefined : and(...conditions));
  return Number(row?.count ?? 0);
}

export async function getPendingAgentAction(env: Env, id: string): Promise<AgentPendingActionRecord | null> {
  const [row] = await getDb(env.DB).select().from(agentPendingActions).where(eq(agentPendingActions.id, id)).limit(1);
  return row ? toAgentPendingActionRecord(row) : null;
}

/** Mark a staged action accepted/rejected. Idempotency is the caller's concern (it checks status === pending). */
export async function setPendingAgentActionStatus(env: Env, id: string, update: { status: AgentPendingActionStatus; decidedBy: string | null }): Promise<void> {
  await getDb(env.DB)
    .update(agentPendingActions)
    .set({ status: update.status, decidedBy: update.decidedBy, decidedAt: nowIso(), updatedAt: nowIso() })
    .where(eq(agentPendingActions.id, id));
}

function toAgentPendingActionRecord(row: typeof agentPendingActions.$inferSelect): AgentPendingActionRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    installationId: row.installationId,
    actionClass: row.actionClass as AgentActionClass,
    autonomyLevel: row.autonomyLevel as AutonomyLevel,
    params: parseJson<AgentPendingActionParams>(row.paramsJson, {}),
    reason: row.reason,
    status: row.status as AgentPendingActionStatus,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getAgentRecommendationOutcomeSummary(
  env: Env,
  actorLogin: string,
  options: { windowDays?: number; now?: string } = {},
): Promise<AgentRecommendationOutcomeSummary> {
  const windowDays = clampInteger(options.windowDays ?? 90, 1, 365);
  const generatedAt = options.now ?? nowIso();
  const outcomes = await listAgentRecommendationOutcomes(env, { actorLogin, windowDays, now: generatedAt });
  const nonMaintainer = outcomes.filter((outcome) => !outcome.maintainerLane);
  const maintainer = outcomes.filter((outcome) => outcome.maintainerLane);
  const states = outcomeStateBuckets(nonMaintainer);
  const maintainerStates = outcomeStateBuckets(maintainer);
  const repos = summarizeRecommendationOutcomeRepos(outcomes);
  const totals = recommendationOutcomeTotals(nonMaintainer, maintainer.length);
  const sources = recommendationOutcomeSources(nonMaintainer);
  return {
    login: actorLogin,
    generatedAt,
    windowDays,
    totals,
    sources,
    states,
    repos,
    maintainerLane: {
      total: maintainer.length,
      states: maintainerStates,
    },
    privateSummary:
      outcomes.length === 0
        ? `${actorLogin} has no evaluated recommendation outcomes in the last ${windowDays} day(s).`
        : `${actorLogin} has ${nonMaintainer.length} contributor-lane recommendation outcome(s), ${totals.positive} positive and ${totals.negative} negative, plus ${maintainer.length} maintainer-lane outcome(s) kept separate.`,
  };
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
      receivedAt: nowIso(),
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

function toRepoQueueTrendSnapshotRecord(row: typeof repoQueueTrendSnapshots.$inferSelect): RepoQueueTrendSnapshotRecord {
  return {
    repoFullName: row.repoFullName,
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
    generatedAt: row.generatedAt,
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

function toUpstreamSourceSnapshotRecord(row: typeof upstreamSourceSnapshots.$inferSelect): UpstreamSourceSnapshotRecord {
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    sourceRepo: row.sourceRepo,
    sourceRef: row.sourceRef,
    path: row.path,
    sourceUrl: row.sourceUrl,
    commitSha: row.commitSha,
    blobSha: row.blobSha,
    contentSha256: row.contentSha256,
    etag: row.etag,
    status: parseUpstreamSourceStatus(row.status),
    parsed: parseJson<Record<string, JsonValue>>(row.parsedJson, {}),
    warnings: parseJson<string[]>(row.warningsJson, []),
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
    fetchedAt: row.fetchedAt,
  };
}

function toUpstreamRulesetSnapshotRecord(row: typeof upstreamRulesetSnapshots.$inferSelect): UpstreamRulesetSnapshotRecord {
  return {
    id: row.id,
    sourceRepo: row.sourceRepo,
    sourceRef: row.sourceRef,
    commitSha: row.commitSha,
    sourceSnapshotIds: parseJson<string[]>(row.sourceSnapshotIdsJson, []),
    activeModel: parseActiveScoringModel(row.activeModel),
    registryRepoCount: row.registryRepoCount,
    totalEmissionShare: row.totalEmissionShare,
    semanticHash: row.semanticHash,
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
    warnings: parseJson<string[]>(row.warningsJson, []),
    generatedAt: row.generatedAt,
  };
}

function toUpstreamDriftReportRecord(row: typeof upstreamDriftReports.$inferSelect): UpstreamDriftReportRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    severity: parseUpstreamDriftSeverity(row.severity),
    status: parseUpstreamDriftStatus(row.status),
    summary: row.summary,
    affectedAreas: parseJson<string[]>(row.affectedAreasJson, []).map(parseUpstreamDriftArea),
    previousRulesetId: row.previousRulesetId,
    currentRulesetId: row.currentRulesetId,
    issueNumber: row.issueNumber,
    issueUrl: row.issueUrl,
    payload: parseJson<Record<string, JsonValue>>(row.payloadJson, {}),
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt,
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
  /* v8 ignore start -- GitHub REST row normalization covers sparse provider payloads at representative persistence call sites. */
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
    isDraft: pr.draft ?? pr.isDraft,
    mergeableState: pr.mergeable_state ?? pr.mergeableState ?? mergeableBooleanState(pr.mergeable),
    reviewDecision: pr.reviewDecision,
    body: pr.body,
    labels: (pr.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
    linkedIssues: extractLinkedIssueNumbers(pr.body ?? ""),
  };
  /* v8 ignore stop */
}

function toPullRequestRecordFromRow(row: typeof pullRequests.$inferSelect): PullRequestRecord {
  const payload = parseJson<{
    body?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    closed_at?: string | null;
    draft?: boolean | null;
    mergeable_state?: string | null;
    reviewDecision?: string | null;
  }>(row.payloadJson, {});
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
    isDraft: payload.draft,
    mergeableState: payload.mergeable_state,
    reviewDecision: payload.reviewDecision,
    body: payload.body,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at ?? row.updatedAt,
    closedAt: payload.closed_at,
    labels: parseJson<string[]>(row.labelsJson, []),
    linkedIssues: parseJson<number[]>(row.linkedIssuesJson, []),
    slopRisk: row.slopRisk,
    slopBand: row.slopBand,
  };
}

/**
 * Persist the latest deterministic slop assessment onto an existing cached PR row. Kept separate from the
 * GitHub-sync upsert (whose SET clause never touches these columns) so a later sync cannot clobber the
 * score. A no-op when the PR row does not exist yet — the sync upsert creates it first.
 */
export async function updatePullRequestSlopAssessment(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  assessment: { slopRisk: number; slopBand: string },
): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(pullRequests)
    .set({ slopRisk: assessment.slopRisk, slopBand: assessment.slopBand, updatedAt: nowIso() })
    .where(and(eq(pullRequests.repoFullName, repoFullName), eq(pullRequests.number, pullNumber)));
}

function toIssueRecord(repoFullName: string, issue: GitHubIssuePayload): IssueRecord {
  /* v8 ignore start -- GitHub REST row normalization covers sparse provider payloads at representative persistence call sites. */
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
  /* v8 ignore stop */
}

function compactGitHubPayload(payload: {
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  draft?: boolean | null;
  isDraft?: boolean | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  mergeableState?: string | null;
  reviewDecision?: string | null;
}): Record<string, JsonValue> {
  const draft = payload.draft ?? payload.isDraft;
  const mergeableState = payload.mergeable_state ?? payload.mergeableState ?? mergeableBooleanState(payload.mergeable);
  return {
    body: truncateBody(payload.body),
    created_at: payload.created_at ?? null,
    updated_at: payload.updated_at ?? null,
    closed_at: payload.closed_at ?? null,
    ...(draft !== undefined ? { draft } : {}),
    ...(mergeableState !== undefined ? { mergeable_state: mergeableState } : {}),
    ...(payload.reviewDecision !== undefined ? { reviewDecision: payload.reviewDecision } : {}),
  };
}

function mergeableBooleanState(value: boolean | null | undefined): string | undefined {
  if (value === true) return "mergeable";
  if (value === false) return "blocked";
  return undefined;
}

function truncateBody(body: string | null | undefined): string | null {
  if (!body) return body ?? null;
  return body.length > MAX_STORED_BODY_CHARS ? body.slice(0, MAX_STORED_BODY_CHARS) : body;
}

function toIssueRecordFromRow(row: typeof issues.$inferSelect): IssueRecord {
  const payload = parseJson<{ body?: string | null; created_at?: string | null; updated_at?: string | null; closed_at?: string | null }>(row.payloadJson, {});
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
    closedAt: payload.closed_at,
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

function toBountyLifecycleEventRecord(row: typeof bountyLifecycleEvents.$inferSelect): BountyLifecycleEventRecord {
  return {
    id: row.id,
    bountyId: row.bountyId,
    repoFullName: row.repoFullName,
    issueNumber: row.issueNumber,
    status: row.status,
    payload: parseJson<Record<string, never>>(row.payloadJson, {}),
    generatedAt: row.generatedAt,
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

function toAgentRecommendationOutcomeRecord(row: typeof agentRecommendationOutcomes.$inferSelect): AgentRecommendationOutcomeRecord {
  return {
    id: row.id,
    actionId: row.actionId,
    runId: row.runId,
    actorLogin: row.actorLogin,
    actionType: parseAgentActionType(row.actionType),
    surface: row.surface ? parseAgentSurface(row.surface) : null,
    snapshotId: row.snapshotId ?? null,
    targetRepoFullName: row.targetRepoFullName,
    targetPullNumber: row.targetPullNumber,
    targetIssueNumber: row.targetIssueNumber,
    source: parseAgentRecommendationOutcomeSource(row.source),
    outcomeState: parseAgentRecommendationOutcomeState(row.outcomeState),
    outcomeTargetType: parseAgentRecommendationOutcomeTargetType(row.outcomeTargetType),
    outcomeRepoFullName: row.outcomeRepoFullName,
    outcomePullNumber: row.outcomePullNumber,
    outcomeIssueNumber: row.outcomeIssueNumber,
    maintainerLane: row.maintainerLane,
    confidence: parseAgentRecommendationOutcomeConfidence(row.confidence),
    reason: row.reason,
    sourceUpdatedAt: row.sourceUpdatedAt,
    detectedAt: row.detectedAt,
    metadata: parseJson<Record<string, JsonValue>>(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toGateOutcomeRecord(row: typeof gateOutcomes.$inferSelect): GateOutcomeRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber,
    headSha: row.headSha,
    blockerCodes: parseJson<string[]>(row.blockerCodesJson, []),
    overridden: row.overridden,
    blockedAt: row.blockedAt,
    updatedAt: row.updatedAt,
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

function toDigestSubscriptionRecord(row: typeof digestSubscriptions.$inferSelect): DigestSubscriptionRecord {
  return {
    id: row.id,
    login: row.login,
    email: row.email,
    status: row.status === "paused" ? "paused" : "active",
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toNotificationChannel(value: string): NotificationChannel {
  return value === "email" ? "email" : "badge";
}

function toNotificationSubscriptionRecord(row: typeof notificationSubscriptions.$inferSelect): NotificationSubscriptionRecord {
  return {
    id: row.id,
    login: row.login,
    channel: toNotificationChannel(row.channel),
    status: row.status === "paused" ? "paused" : "active",
    destination: row.destination ?? null,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toNotificationDeliveryStatus(value: string): NotificationDeliveryStatus {
  return value === "delivered" || value === "read" || value === "suppressed" ? value : "pending";
}

function toNotificationDeliveryRecord(row: typeof notificationDeliveries.$inferSelect): NotificationDeliveryRecord {
  return {
    id: row.id,
    dedupKey: row.dedupKey,
    channel: toNotificationChannel(row.channel),
    recipientLogin: row.recipientLogin,
    eventType: row.eventType,
    repoFullName: row.repoFullName,
    pullNumber: row.pullNumber ?? null,
    title: row.title,
    body: row.body,
    deeplink: row.deeplink,
    actorLogin: row.actorLogin ?? null,
    status: toNotificationDeliveryStatus(row.status),
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt ?? null,
    readAt: row.readAt ?? null,
  };
}

function toProductUsageEventRecord(row: typeof productUsageEvents.$inferSelect): ProductUsageEventRecord {
  return {
    id: row.id,
    surface: normalizeProductUsageSurface(row.surface),
    role: normalizeProductUsageRole(row.role) ?? "unknown",
    eventName: row.eventName,
    route: row.route,
    actorHash: row.actorHash,
    sessionHash: row.sessionHash,
    repoFullName: row.repoFullName,
    targetKey: row.targetKey,
    outcome: normalizeProductUsageOutcome(row.outcome),
    latencyMs: row.latencyMs,
    clientName: row.clientName,
    clientVersion: row.clientVersion,
    metadata: parseJson<Record<string, JsonValue>>(row.metadataJson, {}),
    occurredAt: row.occurredAt,
  };
}

function toProductUsageDailyRollupRecord(row: typeof productUsageDailyRollups.$inferSelect): ProductUsageDailyRollupRecord {
  return {
    day: row.day,
    status: normalizeProductUsageDailyRollupStatus(row.status),
    totalEvents: row.totalEvents,
    activeActors: row.activeActors,
    activeSessions: row.activeSessions,
    activeRepos: row.activeRepos,
    sourceEventCount: row.sourceEventCount,
    maxEventCapacity: row.maxEventCapacity,
    firstEventAt: row.firstEventAt,
    lastEventAt: row.lastEventAt,
    bySurface: parseJson<Array<{ surface: ProductUsageSurface; count: number }>>(row.surfacesJson, []),
    byOutcome: parseJson<Array<{ outcome: ProductUsageOutcome; count: number }>>(row.outcomesJson, []),
    byEvent: parseJson<Array<{ eventName: string; count: number }>>(row.eventsJson, []),
    byRepo: parseJson<Array<{ key: string; count: number }>>(row.reposJson, []),
    byCommand: parseJson<Array<{ key: string; count: number }>>(row.commandsJson, []),
    byTool: parseJson<Array<{ key: string; count: number }>>(row.toolsJson, []),
    byRouteClass: parseJson<Array<{ key: string; count: number }>>(row.routeClassesJson, []),
    activation: parseJson<ProductUsageActivationFunnel>(row.activationJson, emptyProductUsageActivationFunnel()),
    byRole: parseJson<ProductUsageRoleDimensionCount[]>(row.rolesJson, []),
    activationByRole: parseJson<ProductUsageRoleActivationFunnel[]>(row.activationByRoleJson, []),
    activationBySurface: parseJson<ProductUsageSurfaceActivationFunnel[]>(row.activationBySurfaceJson, []),
    retention: parseJson<ProductUsageRetentionRollup[]>(row.retentionJson, []),
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeProductUsageSurface(surface: unknown): ProductUsageSurface {
  if (typeof surface === "string" && PRODUCT_USAGE_SURFACES.has(surface as ProductUsageSurface)) return surface as ProductUsageSurface;
  return "api";
}

function normalizeProductUsageOutcome(outcome: unknown): ProductUsageOutcome {
  if (typeof outcome === "string" && PRODUCT_USAGE_OUTCOMES.has(outcome as ProductUsageOutcome)) return outcome as ProductUsageOutcome;
  return "success";
}

function normalizeProductUsageDailyRollupStatus(status: unknown): ProductUsageDailyRollupStatus {
  if (status === "complete" || status === "partial" || status === "incomplete") return status;
  return "incomplete";
}

function normalizeProductUsageLatency(latencyMs: unknown): number | null {
  return typeof latencyMs === "number" && Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null;
}

async function hashProductUsageIdentifier(env: Env, kind: "actor" | "session", value: unknown): Promise<string | null> {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) return null;
  const salt = env.PRODUCT_USAGE_HASH_SALT;
  if (!salt) return null;
  return sha256Hex(`gittensory:product-usage:v1:${kind}:${salt}:${normalized}`);
}

function boundedProductUsageField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const safe = sanitizeProductUsageString(value.trim(), maxLength);
  return safe ? safe : null;
}

type ProductUsageActorRedactor = {
  pattern: RegExp;
};

function buildProductUsageActorRedactor(actor: unknown): ProductUsageActorRedactor | null {
  const normalized = typeof actor === "string" ? actor.trim() : "";
  if (!normalized || normalized.length > PRODUCT_USAGE_ACTOR_REDACTION_MAX_CHARS) return null;
  return { pattern: new RegExp(escapeRegExp(normalized), "gi") };
}

function redactProductUsageActor(value: string | null, actorRedactor: ProductUsageActorRedactor | null): string | null {
  if (!value || !actorRedactor) return value;
  return value.replace(actorRedactor.pattern, (match, offset: number, source: string) => {
    const previous = offset > 0 ? source[offset - 1] : undefined;
    const next = source[offset + match.length];
    const hasLeftBoundary = isProductUsageActorTokenBoundary(previous) || isProductUsageCamelBoundaryBefore(previous, match);
    const hasRightBoundary = isProductUsageActorTokenBoundary(next) || isProductUsageCamelBoundaryAfter(next);
    return hasLeftBoundary && hasRightBoundary ? "<redacted-actor>" : match;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isProductUsageActorTokenBoundary(value: string | undefined): boolean {
  return value === undefined || !/[A-Za-z0-9]/.test(value);
}

function isProductUsageCamelBoundaryBefore(previous: string | undefined, match: string): boolean {
  return Boolean(previous && /[a-z0-9]/.test(previous) && /^[A-Z]/.test(match));
}

function isProductUsageCamelBoundaryAfter(next: string | undefined): boolean {
  return Boolean(next && /[A-Z]/.test(next));
}

async function upsertProductUsageDailyRollup(env: Env, day: string, generatedAt: string): Promise<ProductUsageDailyRollupRecord> {
  const db = getDb(env.DB);
  const startIso = `${day}T00:00:00.000Z`;
  const endIso = `${addProductUsageUtcDays(day, 1)}T00:00:00.000Z`;
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(productUsageEvents)
    .where(and(gte(productUsageEvents.occurredAt, startIso), sql`${productUsageEvents.occurredAt} < ${endIso}`));
  const sourceEventCount = Number(totalRow?.count ?? 0);
  const rows = await db
    .select()
    .from(productUsageEvents)
    .where(and(gte(productUsageEvents.occurredAt, startIso), sql`${productUsageEvents.occurredAt} < ${endIso}`))
    .orderBy(productUsageEvents.occurredAt)
    .limit(PRODUCT_USAGE_ROLLUP_EVENT_SCAN_LIMIT + 1);
  const capped = rows.length > PRODUCT_USAGE_ROLLUP_EVENT_SCAN_LIMIT || sourceEventCount > PRODUCT_USAGE_ROLLUP_EVENT_SCAN_LIMIT;
  const events = rows.slice(0, PRODUCT_USAGE_ROLLUP_EVENT_SCAN_LIMIT).map(toProductUsageEventRecord);
  const retentionStartIso = `${addProductUsageUtcDays(day, -PRODUCT_USAGE_RETENTION_MAX_WINDOW_DAYS)}T00:00:00.000Z`;
  const retentionWhere = and(gte(productUsageEvents.occurredAt, retentionStartIso), sql`${productUsageEvents.occurredAt} < ${startIso}`, sql`${productUsageEvents.actorHash} is not null`);
  const [retentionSourceRow] = await db.select({ count: sql<number>`count(*)` }).from(productUsageEvents).where(retentionWhere);
  const retentionRows = await db
    .select()
    .from(productUsageEvents)
    .where(retentionWhere)
    .orderBy(desc(productUsageEvents.occurredAt))
    .limit(PRODUCT_USAGE_RETENTION_EVENT_SCAN_LIMIT + 1);
  const retentionCapped = retentionRows.length > PRODUCT_USAGE_RETENTION_EVENT_SCAN_LIMIT || Number(retentionSourceRow?.count ?? 0) > PRODUCT_USAGE_RETENTION_EVENT_SCAN_LIMIT;
  const retentionEvents = retentionRows.slice(0, PRODUCT_USAGE_RETENTION_EVENT_SCAN_LIMIT).map(toProductUsageEventRecord);
  const record = buildProductUsageDailyRollupRecord({
    day,
    generatedAt,
    sourceEventCount,
    capped,
    events,
    retentionEvents,
    retentionCapped,
  });
  await db
    .insert(productUsageDailyRollups)
    .values({
      day: record.day,
      status: record.status,
      totalEvents: record.totalEvents,
      activeActors: record.activeActors,
      activeSessions: record.activeSessions,
      activeRepos: record.activeRepos,
      sourceEventCount: record.sourceEventCount,
      maxEventCapacity: record.maxEventCapacity,
      firstEventAt: record.firstEventAt ?? null,
      lastEventAt: record.lastEventAt ?? null,
      surfacesJson: jsonString(record.bySurface),
      outcomesJson: jsonString(record.byOutcome),
      eventsJson: jsonString(record.byEvent),
      reposJson: jsonString(record.byRepo),
      commandsJson: jsonString(record.byCommand),
      toolsJson: jsonString(record.byTool),
      routeClassesJson: jsonString(record.byRouteClass),
      activationJson: jsonString(record.activation),
      rolesJson: jsonString(record.byRole),
      activationByRoleJson: jsonString(record.activationByRole),
      activationBySurfaceJson: jsonString(record.activationBySurface),
      retentionJson: jsonString(record.retention),
      generatedAt: record.generatedAt,
      updatedAt: record.updatedAt,
    })
    .onConflictDoUpdate({
      target: productUsageDailyRollups.day,
      set: {
        status: record.status,
        totalEvents: record.totalEvents,
        activeActors: record.activeActors,
        activeSessions: record.activeSessions,
        activeRepos: record.activeRepos,
        sourceEventCount: record.sourceEventCount,
        maxEventCapacity: record.maxEventCapacity,
        firstEventAt: record.firstEventAt ?? null,
        lastEventAt: record.lastEventAt ?? null,
        surfacesJson: jsonString(record.bySurface),
        outcomesJson: jsonString(record.byOutcome),
        eventsJson: jsonString(record.byEvent),
        reposJson: jsonString(record.byRepo),
        commandsJson: jsonString(record.byCommand),
        toolsJson: jsonString(record.byTool),
        routeClassesJson: jsonString(record.byRouteClass),
        activationJson: jsonString(record.activation),
        rolesJson: jsonString(record.byRole),
        activationByRoleJson: jsonString(record.activationByRole),
        activationBySurfaceJson: jsonString(record.activationBySurface),
        retentionJson: jsonString(record.retention),
        generatedAt: record.generatedAt,
        updatedAt: record.updatedAt,
      },
    });
  return record;
}

// Bounded enum dimensions (surface / outcome / eventName) are consumed by exact-name lookups
// (e.g. the weekly value report's sumEvent over byEvent), so they must be stored complete:
// frequency-truncating a bounded exact-lookup dimension silently zeroes any value below the
// top-N cut on a high-diversity day. Only the genuinely-unbounded repo/command/tool/route
// dimensions keep a display top-N.
const FULL_DIMENSION_LIMIT = Number.MAX_SAFE_INTEGER;

function buildProductUsageDailyRollupRecord(args: {
  day: string;
  generatedAt: string;
  sourceEventCount: number;
  capped: boolean;
  events: ProductUsageEventRecord[];
  retentionEvents: ProductUsageEventRecord[];
  retentionCapped: boolean;
}): ProductUsageDailyRollupRecord {
  const today = productUsageDayFromIso(args.generatedAt);
  const actorHashes = new Set(args.events.map((event) => event.actorHash).filter(isNonEmptyString));
  const sessionHashes = new Set(args.events.map((event) => event.sessionHash).filter(isNonEmptyString));
  const repoNames = new Set(args.events.map((event) => event.repoFullName).filter(isNonEmptyString));
  const roleBuckets = productUsageRoleBuckets(args.events);
  const surfaceBuckets = productUsageSurfaceBuckets(args.events);
  const activation = buildProductUsageActivationFunnel(args.events);
  return {
    day: args.day,
    status: args.capped ? "incomplete" : args.day === today ? "partial" : "complete",
    totalEvents: args.sourceEventCount,
    activeActors: actorHashes.size,
    activeSessions: sessionHashes.size,
    activeRepos: repoNames.size,
    sourceEventCount: args.sourceEventCount,
    maxEventCapacity: PRODUCT_USAGE_ROLLUP_EVENT_SCAN_LIMIT,
    firstEventAt: args.events[0]?.occurredAt ?? null,
    lastEventAt: args.events.at(-1)?.occurredAt ?? null,
    bySurface: countProductUsageDimensions(args.events.map((event) => event.surface), FULL_DIMENSION_LIMIT).map(({ key, count }) => ({ surface: normalizeProductUsageSurface(key), count })),
    byOutcome: countProductUsageDimensions(args.events.map((event) => event.outcome), FULL_DIMENSION_LIMIT).map(({ key, count }) => ({ outcome: normalizeProductUsageOutcome(key), count })),
    byEvent: countProductUsageDimensions(args.events.map((event) => event.eventName), FULL_DIMENSION_LIMIT).map(({ key, count }) => ({ eventName: key, count })),
    byRepo: countProductUsageDimensions(args.events.map((event) => event.repoFullName)),
    byCommand: countProductUsageDimensions(args.events.map((event) => productUsageMetadataString(event, "command"))),
    byTool: countProductUsageDimensions(args.events.map((event) => productUsageMetadataString(event, "toolName"))),
    byRouteClass: countProductUsageDimensions(args.events.map((event) => productUsageRouteClass(event.route))),
    activation,
    byRole: roleBuckets.map(({ role, events }) => ({
      role,
      count: events.length,
      activeActors: new Set(events.map((event) => event.actorHash).filter(isNonEmptyString)).size,
      activeRepos: new Set(events.map((event) => event.repoFullName).filter(isNonEmptyString)).size,
    })),
    activationByRole: roleBuckets.map(({ role, events }) => ({ role, ...buildProductUsageActivationFunnel(events) })),
    activationBySurface: surfaceBuckets.map(({ surface, events }) => ({ surface, ...buildProductUsageActivationFunnel(events) })),
    retention: buildProductUsageRetentionRollups(args.day, args.events, args.retentionEvents, args.retentionCapped),
    generatedAt: args.generatedAt,
    updatedAt: args.generatedAt,
  };
}

function buildProductUsageActivationFunnel(events: ProductUsageEventRecord[]): ProductUsageActivationFunnel {
  const loginActors = productUsageActorSet(events, (event) => event.eventName === "auth_session_created");
  const doctorPassActors = productUsageActorSet(events, isProductUsageDoctorPassEvent);
  const firstUsefulActionActors = productUsageActorSet(events, isProductUsageUsefulActionEvent);
  const githubInstalledRepos = productUsageRepoSet(events, (event) => event.eventName === "github_installation_created");
  const githubFirstCommandRepos = productUsageRepoSet(events, isProductUsageGitHubCommandEvent);
  const githubUsefulMaintainerRepos = productUsageRepoSet(events, isProductUsageUsefulMaintainerEvent);
  return {
    loginActors: loginActors.size,
    doctorPassActors: doctorPassActors.size,
    firstUsefulActionActors: firstUsefulActionActors.size,
    fullyActivatedActors: intersectionCount(loginActors, doctorPassActors, firstUsefulActionActors),
    githubInstalledRepos: githubInstalledRepos.size,
    githubFirstCommandRepos: githubFirstCommandRepos.size,
    githubUsefulMaintainerRepos: githubUsefulMaintainerRepos.size,
    githubActivatedRepos: intersectionCount(githubInstalledRepos, githubFirstCommandRepos, githubUsefulMaintainerRepos),
  };
}

function productUsageRoleBuckets(events: ProductUsageEventRecord[]): Array<{ role: ProductUsageRole; events: ProductUsageEventRecord[] }> {
  const buckets = new Map<ProductUsageRole, ProductUsageEventRecord[]>();
  const actorRoles = productUsageRolesByActor(events);
  for (const event of events) {
    for (const role of productUsageRolesForEvent(event, actorRoles)) {
      const bucket = buckets.get(role);
      if (bucket) bucket.push(event);
      else buckets.set(role, [event]);
    }
  }
  return [...buckets.entries()]
    .map(([role, bucketEvents]) => ({ role, events: bucketEvents }))
    .sort((a, b) => b.events.length - a.events.length || productUsageRoleSortValue(a.role) - productUsageRoleSortValue(b.role));
}

function productUsageSurfaceBuckets(events: ProductUsageEventRecord[]): Array<{ surface: ProductUsageSurface; events: ProductUsageEventRecord[] }> {
  const buckets = new Map<ProductUsageSurface, ProductUsageEventRecord[]>();
  for (const event of events) {
    const surface = normalizeProductUsageSurface(event.surface);
    const bucket = buckets.get(surface);
    if (bucket) bucket.push(event);
    else buckets.set(surface, [event]);
  }
  return [...buckets.entries()]
    .map(([surface, bucketEvents]) => ({ surface, events: bucketEvents }))
    .sort((a, b) => b.events.length - a.events.length || a.surface.localeCompare(b.surface));
}

function buildProductUsageRetentionRollups(day: string, currentEvents: ProductUsageEventRecord[], previousEvents: ProductUsageEventRecord[], capped: boolean): ProductUsageRetentionRollup[] {
  return PRODUCT_USAGE_RETENTION_WINDOWS.map(({ window, days }) => {
    const previousStartIso = `${addProductUsageUtcDays(day, -days)}T00:00:00.000Z`;
    const windowPreviousEvents = previousEvents.filter((event) => event.occurredAt >= previousStartIso);
    const currentActors = productUsageActorHashes(currentEvents);
    const previousActors = productUsageActorHashes(windowPreviousEvents);
    const retainedActors = intersectionCount(currentActors, previousActors);
    return {
      window,
      capped,
      activeActors: currentActors.size,
      retainedActors,
      retentionRate: productUsageRetentionRate(retainedActors, currentActors.size),
      byRole: productUsageRetentionByRole(currentEvents, windowPreviousEvents),
      bySurface: productUsageRetentionBySurface(currentEvents, windowPreviousEvents),
    };
  });
}

function productUsageRetentionByRole(currentEvents: ProductUsageEventRecord[], previousEvents: ProductUsageEventRecord[]): ProductUsageRoleRetention[] {
  const previousActorRoles = productUsageRolesByActor(previousEvents);
  return productUsageRoleBuckets(currentEvents).map(({ role, events }) => {
    const currentActors = productUsageActorHashes(events);
    const previousActors = productUsageActorHashes(previousEvents.filter((event) => productUsageRolesForEvent(event, previousActorRoles).includes(role)));
    const retainedActors = intersectionCount(currentActors, previousActors);
    return {
      role,
      activeActors: currentActors.size,
      retainedActors,
      retentionRate: productUsageRetentionRate(retainedActors, currentActors.size),
    };
  });
}

function productUsageRetentionBySurface(currentEvents: ProductUsageEventRecord[], previousEvents: ProductUsageEventRecord[]): ProductUsageSurfaceRetention[] {
  return productUsageSurfaceBuckets(currentEvents).map(({ surface, events }) => {
    const currentActors = productUsageActorHashes(events);
    const previousActors = productUsageActorHashes(previousEvents.filter((event) => normalizeProductUsageSurface(event.surface) === surface));
    const retainedActors = intersectionCount(currentActors, previousActors);
    return {
      surface,
      activeActors: currentActors.size,
      retainedActors,
      retentionRate: productUsageRetentionRate(retainedActors, currentActors.size),
    };
  });
}

function productUsageActorHashes(events: ProductUsageEventRecord[]): Set<string> {
  return new Set(events.map((event) => event.actorHash).filter(isNonEmptyString));
}

function productUsageRetentionRate(retainedActors: number, activeActors: number): number {
  return activeActors > 0 ? Number((retainedActors / activeActors).toFixed(4)) : 0;
}

function productUsageRolesByActor(events: ProductUsageEventRecord[]): Map<string, ProductUsageRole[]> {
  const rolesByActor = new Map<string, Set<ProductUsageRole>>();
  for (const event of events) {
    if (!event.actorHash) continue;
    const roles = productUsageBaseRolesForEvent(event).filter((role) => role !== "unknown");
    if (roles.length === 0) continue;
    const bucket = rolesByActor.get(event.actorHash) ?? new Set<ProductUsageRole>();
    for (const role of roles) bucket.add(role);
    rolesByActor.set(event.actorHash, bucket);
  }
  return new Map(
    [...rolesByActor.entries()].map(([actorHash, roles]) => [
      actorHash,
      [...roles].sort((a, b) => productUsageRoleSortValue(a) - productUsageRoleSortValue(b)),
    ]),
  );
}

function productUsageRolesForEvent(event: ProductUsageEventRecord, actorRoles: Map<string, ProductUsageRole[]> = new Map()): ProductUsageRole[] {
  const baseRoles = productUsageBaseRolesForEvent(event);
  if (baseRoles.length === 1 && baseRoles[0] === "unknown" && event.actorHash) return actorRoles.get(event.actorHash) ?? baseRoles;
  return baseRoles;
}

function productUsageBaseRolesForEvent(event: ProductUsageEventRecord): ProductUsageRole[] {
  const roles = new Set<ProductUsageRole>();
  if (event.role && event.role !== "unknown") roles.add(event.role);
  addProductUsageRolesFromValue(roles, event.metadata.role);
  addProductUsageRolesFromValue(roles, event.metadata.roles);
  addProductUsageRolesFromValue(roles, event.metadata.audience);
  addProductUsageRolesFromValue(roles, event.metadata.actorRole);
  addProductUsageRolesFromValue(roles, event.metadata.actorKind);
  if (roles.size > 0) return [...roles].sort((a, b) => productUsageRoleSortValue(a) - productUsageRoleSortValue(b));

  if (event.eventName === "github_installation_created") return ["owner"];
  if (event.eventName === "extension_session_created" || event.eventName === "pull_context_viewed") return ["maintainer"];
  if (event.surface === "mcp") return ["miner"];
  if (
    event.eventName === "local_branch_analysis_completed" ||
    event.eventName === "agent_run_started" ||
    event.eventName === "agent_plan_next_work_completed" ||
    event.eventName === "agent_preflight_branch_completed" ||
    event.eventName === "agent_pr_packet_completed" ||
    event.eventName === "agent_blockers_completed"
  ) {
    return ["miner"];
  }
  if (event.eventName === "pr_public_surface_published") return ["contributor"];
  return ["unknown"];
}

function addProductUsageRolesFromValue(roles: Set<ProductUsageRole>, value: JsonValue | undefined): void {
  if (Array.isArray(value)) {
    for (const entry of value) addProductUsageRolesFromValue(roles, entry);
    return;
  }
  if (typeof value !== "string") return;
  const role = normalizeProductUsageRole(value);
  if (role) roles.add(role);
}

function resolveProductUsageRole(args: {
  explicitRole?: ProductUsageRole | string | null | undefined;
  surface: ProductUsageSurface;
  eventName: string;
  metadata: Record<string, JsonValue>;
}): ProductUsageRole {
  if (typeof args.explicitRole === "string") {
    const normalized = normalizeProductUsageRole(args.explicitRole);
    if (normalized) return normalized;
  }
  const fromMetadata = new Set<ProductUsageRole>();
  addProductUsageRolesFromValue(fromMetadata, args.metadata.role);
  addProductUsageRolesFromValue(fromMetadata, args.metadata.roles);
  addProductUsageRolesFromValue(fromMetadata, args.metadata.audience);
  addProductUsageRolesFromValue(fromMetadata, args.metadata.actorRole);
  addProductUsageRolesFromValue(fromMetadata, args.metadata.actorKind);
  if (fromMetadata.size > 0) return [...fromMetadata].sort((a, b) => productUsageRoleSortValue(a) - productUsageRoleSortValue(b))[0] ?? "unknown";
  const [inferred] = productUsageBaseRolesForEvent({
    id: "",
    surface: args.surface,
    role: "unknown",
    eventName: args.eventName,
    outcome: "success",
    metadata: args.metadata,
    occurredAt: nowIso(),
  });
  return inferred ?? "unknown";
}

function normalizeProductUsageRole(value: string): ProductUsageRole | null {
  switch (value.trim().toLowerCase().replace(/[\s-]+/g, "_")) {
    case "miner":
    case "miners":
      return "miner";
    case "maintainer":
    case "maintainers":
    case "reviewer":
      return "maintainer";
    case "owner":
    case "owners":
    case "repo_owner":
    case "repo_owners":
    case "repository_owner":
    case "repository_owners":
      return "owner";
    case "operator":
    case "operators":
      return "operator";
    case "author":
    case "contributor":
    case "contributors":
    case "outside_contributor":
    case "outside_contributors":
      return "contributor";
    case "none":
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

function productUsageRoleSortValue(role: ProductUsageRole): number {
  return PRODUCT_USAGE_ROLE_ORDER.indexOf(role);
}

function productUsageActorSet(events: ProductUsageEventRecord[], predicate: (event: ProductUsageEventRecord) => boolean): Set<string> {
  return new Set(events.filter(predicate).map((event) => event.actorHash).filter(isNonEmptyString));
}

function productUsageRepoSet(events: ProductUsageEventRecord[], predicate: (event: ProductUsageEventRecord) => boolean): Set<string> {
  return new Set(events.filter(predicate).map((event) => event.repoFullName).filter(isNonEmptyString));
}

function isProductUsageDoctorPassEvent(event: ProductUsageEventRecord): boolean {
  return event.outcome === "success" || event.outcome === "completed" ? event.eventName === "mcp_request" || event.eventName === "mcp_tool_called" || event.eventName === "mcp_doctor_passed" : false;
}

function isProductUsageUsefulActionEvent(event: ProductUsageEventRecord): boolean {
  if (event.outcome !== "success" && event.outcome !== "completed" && event.outcome !== "queued") return false;
  return PRODUCT_USAGE_USEFUL_ACTION_EVENTS.has(event.eventName);
}

function isProductUsageGitHubCommandEvent(event: ProductUsageEventRecord): boolean {
  return event.eventName === "agent_command_replied" || event.eventName === "agent_command_skipped";
}

function isProductUsageUsefulMaintainerEvent(event: ProductUsageEventRecord): boolean {
  return event.eventName === "agent_command_replied" && productUsageMetadataString(event, "actorKind") === "maintainer" && event.outcome === "completed";
}

function mcpClientVersionForEvent(event: ProductUsageEventRecord): string {
  return aggregateMcpClientVersion(event.clientVersion ?? productUsageMetadataString(event, "packageVersion"));
}

function aggregateMcpClientVersion(version: string | null | undefined): string {
  if (!version) return "unknown";
  const semver = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.*)?$/.exec(version.trim());
  return semver?.[1] ?? "unknown";
}

function mcpCompatibilityStatusForEvent(event: ProductUsageEventRecord): "current" | "stale" | "incompatible" | "unknown" {
  const metadataStatus = normalizeMcpCompatibilityStatus(productUsageMetadataString(event, "compatibilityStatus"));
  if (metadataStatus !== "unknown") return metadataStatus;
  return classifyMcpClientVersion(mcpClientVersionForEvent(event));
}

function normalizeMcpCompatibilityStatus(value: unknown): "current" | "stale" | "incompatible" | "unknown" {
  return value === "current" || value === "stale" || value === "incompatible" ? value : "unknown";
}

function productUsageMetadataString(event: ProductUsageEventRecord, key: string): string | null {
  const value = event.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function countProductUsageDimensions(values: Array<string | null | undefined>, limit = 20): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function productUsageRouteClass(route: string | null | undefined): string {
  if (!route) return "unknown";
  if (route === "/health") return "health";
  if (route.startsWith("/v1/auth/")) return "auth";
  if (route === "/mcp" || route.startsWith("/v1/mcp/")) return "mcp";
  if (route.startsWith("/v1/app/")) return "control_panel";
  if (route.startsWith("/v1/agent/")) return "agent";
  if (route.startsWith("/v1/extension/")) return "browser_extension";
  if (route.startsWith("/v1/github/")) return "github_app";
  if (route.startsWith("/v1/internal/")) return "internal";
  if (route.startsWith("/v1/repos/")) return "repository";
  return "api";
}

function intersectionCount(first: Set<string>, ...rest: Array<Set<string>>): number {
  return [...first].filter((value) => rest.every((set) => set.has(value))).length;
}

function emptyProductUsageActivationFunnel(): ProductUsageActivationFunnel {
  return {
    loginActors: 0,
    doctorPassActors: 0,
    firstUsefulActionActors: 0,
    fullyActivatedActors: 0,
    githubInstalledRepos: 0,
    githubFirstCommandRepos: 0,
    githubUsefulMaintainerRepos: 0,
    githubActivatedRepos: 0,
  };
}

function productUsageRollupDays(nowValue: string, count: number): string[] {
  const days = Math.max(1, Math.min(31, Math.round(count)));
  const today = productUsageDayFromIso(nowValue);
  return Array.from({ length: days }, (_, index) => addProductUsageUtcDays(today, index - (days - 1)));
}

function normalizeProductUsageRollupDay(value: string, fallbackIso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ? value : productUsageDayFromIso(fallbackIso);
}

function productUsageDayFromIso(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : nowIso().slice(0, 10);
}

function addProductUsageUtcDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

const PRODUCT_USAGE_METADATA_MAX_DEPTH = 3;
const PRODUCT_USAGE_METADATA_MAX_KEYS = 20;
const PRODUCT_USAGE_METADATA_MAX_ARRAY_ITEMS = 20;
const PRODUCT_USAGE_METADATA_MAX_KEY_CHARS = 64;
const PRODUCT_USAGE_METADATA_MAX_STRING_CHARS = 200;
const PRODUCT_USAGE_ROLLUP_EVENT_SCAN_LIMIT = 5000;
const PRODUCT_USAGE_RETENTION_EVENT_SCAN_LIMIT = 5000;
const PRODUCT_USAGE_RETENTION_MAX_WINDOW_DAYS = 30;
const PRODUCT_USAGE_RETENTION_WINDOWS: Array<{ window: ProductUsageRetentionRollup["window"]; days: number }> = [
  { window: "previous_7_days", days: 7 },
  { window: "previous_30_days", days: 30 },
];
const MCP_COMPATIBILITY_ADOPTION_SCAN_LIMIT = 5000;
const PRODUCT_USAGE_ACTOR_REDACTION_MAX_CHARS = 256;
const PRODUCT_USAGE_ROLE_ORDER: ProductUsageRole[] = ["miner", "maintainer", "owner", "operator", "contributor", "unknown"];
const PRODUCT_USAGE_USEFUL_ACTION_EVENTS = new Set([
  "command_previewed",
  "pull_context_viewed",
  "local_branch_analysis_completed",
  "agent_run_started",
  "agent_plan_next_work_completed",
  "agent_preflight_branch_completed",
  "agent_pr_packet_completed",
  "agent_blockers_completed",
  "agent_command_replied",
  "pr_public_surface_published",
  "mcp_tool_called",
]);
const PRODUCT_USAGE_SURFACES = new Set<ProductUsageSurface>(["api", "mcp", "github_app", "control_panel", "browser_extension", "internal"]);
const PRODUCT_USAGE_OUTCOMES = new Set<ProductUsageOutcome>(["success", "denied", "error", "queued", "completed", "skipped"]);
const PRODUCT_USAGE_SENSITIVE_KEY =
  /authorization|cookie|token|secret|password|private[_-]?key|source|body|diff|patch|prompt|raw[_-]?trust|trust[_-]?score|wallet|hotkey|coldkey|seed|mnemonic|local[_-]?path|repo[_-]?root|cwd|scoreability|reviewability|farming/i;
const PRODUCT_USAGE_SENSITIVE_VALUE =
  /\b(seed phrase|mnemonic|private key|raw trust|trust score|wallet|hotkey|coldkey|scoreability|reviewability|farming|reward estimate|payout)\b/i;
const PRODUCT_USAGE_LOCAL_PATH = /(?:\/Users|\/home|\/tmp)\/[^\s"',;)]*|[A-Za-z]:\\Users\\[^\s"',;)]*/g;
const PRODUCT_USAGE_TOKEN_VALUE = /\b(?:ghp_|github_pat_|gts_|glpat-|sk-)[A-Za-z0-9_=-]{8,}/g;
const PRODUCT_USAGE_BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

function sanitizeProductUsageMetadata(value: Record<string, unknown> | null | undefined, actorRedactor: ProductUsageActorRedactor | null): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, JsonValue> = {};
  for (const [key, entryValue] of Object.entries(value).slice(0, PRODUCT_USAGE_METADATA_MAX_KEYS)) {
    if (PRODUCT_USAGE_SENSITIVE_KEY.test(key)) continue;
    const safeKey = redactProductUsageActor(sanitizeProductUsageString(key, PRODUCT_USAGE_METADATA_MAX_KEY_CHARS), actorRedactor);
    if (!safeKey) continue;
    const safeValue = sanitizeProductUsageJson(entryValue, 0, actorRedactor);
    if (safeValue !== undefined) output[safeKey] = safeValue;
  }
  return output;
}

function sanitizeProductUsageJson(value: unknown, depth: number, actorRedactor: ProductUsageActorRedactor | null): JsonValue | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return redactProductUsageActor(sanitizeProductUsageString(String(value), PRODUCT_USAGE_METADATA_MAX_STRING_CHARS), actorRedactor);
  if (typeof value === "string") return redactProductUsageActor(sanitizeProductUsageString(value, PRODUCT_USAGE_METADATA_MAX_STRING_CHARS), actorRedactor);
  if (value instanceof Date) return value.toISOString();
  if (depth >= PRODUCT_USAGE_METADATA_MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, PRODUCT_USAGE_METADATA_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeProductUsageJson(item, depth + 1, actorRedactor))
      .filter((item): item is JsonValue => item !== undefined);
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, PRODUCT_USAGE_METADATA_MAX_KEYS)) {
    if (PRODUCT_USAGE_SENSITIVE_KEY.test(key)) continue;
    const safeKey = redactProductUsageActor(sanitizeProductUsageString(key, PRODUCT_USAGE_METADATA_MAX_KEY_CHARS), actorRedactor);
    if (!safeKey) continue;
    const safeValue = sanitizeProductUsageJson(entryValue, depth + 1, actorRedactor);
    if (safeValue !== undefined) output[safeKey] = safeValue;
  }
  return output;
}

function sanitizeProductUsageString(value: string, maxLength: number): string {
  const redacted = value
    .replace(PRODUCT_USAGE_LOCAL_PATH, "<redacted-path>")
    .replace(PRODUCT_USAGE_TOKEN_VALUE, "<redacted-token>")
    .replace(PRODUCT_USAGE_BEARER_VALUE, "Bearer <redacted-token>");
  if (PRODUCT_USAGE_SENSITIVE_VALUE.test(redacted)) return "<redacted>";
  return redacted.slice(0, maxLength);
}

function toAgentCommandAnswer(row: typeof githubAgentCommandAnswers.$inferSelect): AgentCommandAnswerRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    issueNumber: row.issueNumber,
    command: row.command,
    requestCommentId: row.requestCommentId,
    responseCommentId: row.responseCommentId,
    responseUrl: row.responseUrl,
    actorKind: row.actorKind === "maintainer" ? "maintainer" : "author",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: parseJson<Record<string, JsonValue>>(row.metadataJson, {}),
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

function parseAgentRecommendationOutcomeState(value: string): AgentRecommendationOutcomeState {
  if (value === "accepted" || value === "rejected" || value === "ignored" || value === "stale" || value === "merged" || value === "closed" || value === "improved") return value;
  return "ignored";
}

function normalizeAgentRecommendationOutcomeSource(value: AgentRecommendationOutcomeSource | null | undefined): AgentRecommendationOutcomeSource {
  return value === "explicit" ? "explicit" : "inferred";
}

function parseAgentRecommendationOutcomeSource(value: string): AgentRecommendationOutcomeSource {
  return value === "explicit" ? "explicit" : "inferred";
}

function parseAgentRecommendationOutcomeTargetType(value: string): AgentRecommendationOutcomeTargetType {
  if (value === "pull_request" || value === "issue" || value === "repository") return value;
  return "none";
}

function parseAgentRecommendationOutcomeConfidence(value: string): AgentRecommendationOutcomeConfidence {
  if (value === "high" || value === "low") return value;
  return "medium";
}

function parseCommentMode(value: string): RepositorySettings["commentMode"] {
  if (value === "detected_contributors_only" || value === "all_prs") return value;
  return "off";
}

function parsePublicAudienceMode(value: string): RepositorySettings["publicAudienceMode"] {
  return value === "gittensor_only" ? "gittensor_only" : "oss_maintainer";
}

function parseCheckRunMode(value: string): RepositorySettings["checkRunMode"] {
  return value === "enabled" ? "enabled" : "off";
}

function parseCheckRunDetailLevel(value: string): RepositorySettings["checkRunDetailLevel"] {
  if (value === "minimal" || value === "deep") return value;
  return "standard";
}

function parseGateCheckMode(value: string): RepositorySettings["gateCheckMode"] {
  return value === "enabled" ? "enabled" : "off";
}

function parseGatePack(value: string | null | undefined): RepositorySettings["gatePack"] {
  return value === "oss-anti-slop" ? "oss-anti-slop" : "gittensor";
}

function parseGateRuleMode(value: string): RepositorySettings["linkedIssueGateMode"] {
  if (value === "off" || value === "block") return value;
  return "advisory";
}

function normalizeAiReviewProvider(value: string | null | undefined): "anthropic" | "openai" | null {
  return value === "anthropic" || value === "openai" ? value : null;
}

function normalizeQualityGateMinScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parsePublicSurface(value: string): RepositorySettings["publicSurface"] {
  if (value === "comment_only" || value === "label_only" || value === "off") return value;
  return "comment_and_label";
}

function parseCommandAuthorizationPolicy(value: string): RepositorySettings["commandAuthorization"] {
  return normalizeCommandAuthorizationPolicy(parseJson<unknown>(value, null)).policy;
}

function parseAutonomyPolicy(value: string): AutonomyPolicy {
  return normalizeAutonomyPolicy(parseJson<unknown>(value, null));
}

function parseAutoMaintainPolicy(value: string): AutoMaintainPolicy {
  return normalizeAutoMaintainPolicy(parseJson<unknown>(value, null));
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
  if (value === "current_density_model" || value === "pending_saturation_model" || value === "exponential_saturation_model") return value;
  return "unknown";
}

function parseUpstreamSourceStatus(value: string): UpstreamSourceStatus {
  if (value === "not_modified" || value === "fallback" || value === "error") return value;
  return "fetched";
}

function parseUpstreamDriftSeverity(value: string): UpstreamDriftSeverity {
  /* v8 ignore start -- Database enum parsing fallback protects legacy/manual rows; typed writers cover normal values. */
  if (value === "medium" || value === "high" || value === "blocking") return value;
  return "low";
  /* v8 ignore stop */
}

function parseUpstreamDriftStatus(value: string): UpstreamDriftStatus {
  /* v8 ignore start -- Database enum parsing fallback protects legacy/manual rows; typed writers cover normal values. */
  if (value === "acknowledged" || value === "resolved" || value === "ignored") return value;
  return "open";
  /* v8 ignore stop */
}

function parseUpstreamDriftArea(value: string): UpstreamDriftArea {
  if (value === "registry" || value === "scoring_model" || value === "issue_discovery" || value === "mirror_linkage" || value === "language_weights") return value;
  return "source";
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
