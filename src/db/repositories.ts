import { and, asc, desc, eq, gte, inArray, not, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
import {
  activeReviewTracking,
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
  repositoryLinearKeys,
  repositorySettings,
  reviewSuppression,
  scorePreviews,
  scoringModelSnapshots,
  signalSnapshots,
  upstreamDriftReports,
  upstreamRulesetSnapshots,
  upstreamSourceSnapshots,
  webhookEvents,
} from "./schema";
import { DEFAULT_REVIEW_EVASION_LABEL, MAX_REVIEW_NAG_COOLDOWN_DAYS } from "../settings/agent-actions";
import { MAX_CONTRIBUTOR_OPEN_ITEM_CAP } from "../types";
import type {
  Advisory,
  AdvisoryFinding,
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
  PullRequestFilePathRecord,
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
  ReviewSuppressionRecord,
  ScorePreviewRecord,
  ScoringModelSnapshotRecord,
  ScreenshotTableGateConfig,
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
import { normalizeContributorBlacklist } from "../settings/contributor-blacklist";
import { normalizeAutoCloseExemptLogins } from "../settings/auto-close-exempt";
import { DEFAULT_GLOBAL_MODERATION_CONFIG, MAX_MODERATION_VIOLATION_DECAY_DAYS, normalizeModerationLabel, normalizeModerationRules, type GlobalModerationConfig, type ModerationRuleType } from "../settings/moderation-rules";
import { normalizeAutonomyPolicy, normalizeAutoMaintainPolicy, DEFAULT_AUTO_MAINTAIN_POLICY } from "../settings/autonomy";
import { DEFAULT_TYPE_LABELS, normalizeTypeLabelSet } from "../settings/pr-type-label";
import { DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION, normalizeLinkedIssueLabelPropagationConfig } from "../review/linked-issue-label-propagation";
import { DEFAULT_LINKED_ISSUE_HARD_RULES } from "../review/linked-issue-hard-rules-config";
import { DEFAULT_SCREENSHOT_TABLE_GATE, isScreenshotTableGateAction, normalizeScreenshotTableGateConfig } from "../review/screenshot-table-gate";
import { decryptSecret, encryptSecret, sha256Hex } from "../utils/crypto";
import { errorMessage, jsonString, nowIso, parseJson, repoParts } from "../utils/json";
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../signals/redaction";

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

export async function upsertInstallation(env: Env, payload: GitHubWebhookPayload): Promise<number | null> {
  if (!payload.installation?.id) return null;
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
  // Capture app_id when the payload carries it (installation events + the App-installation API refresh); keep the
  // stored value otherwise so a payload without it (e.g. a pull_request event) never clears it. Returned so the
  // caller can filter a dual-app webhook without a second read (#selfhost-app-id).
  const appId = payload.installation.app_id ?? existing?.appId ?? null;
  const db = getDb(env.DB);
  await db
    .insert(installations)
    .values({
      id: payload.installation.id,
      accountLogin,
      accountId,
      appId,
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
        appId,
        targetType,
        repositorySelection,
        permissionsJson: jsonString(permissions),
        eventsJson: jsonString(events),
        suspendedAt,
        updatedAt: nowIso(),
      },
    });
  return appId;
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

export async function updateInstallationPermissions(env: Env, installationId: number, permissions: Record<string, string>): Promise<void> {
  if (Object.keys(permissions).length === 0) return;
  const db = getDb(env.DB);
  await db.update(installations).set({ permissionsJson: jsonString(permissions), updatedAt: nowIso() }).where(eq(installations.id, installationId));
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
  const syncedAt = nowIso();
  const lastSeenOpenAt = pr.state === "open" ? (options.seenOpenAt ?? syncedAt) : null;
  const existingClaimRows = await db
    .select({ linkedIssuesJson: pullRequests.linkedIssuesJson, linkedIssueClaimedAt: pullRequests.linkedIssueClaimedAt, payloadJson: pullRequests.payloadJson })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, repoFullName), eq(pullRequests.number, pr.number)))
    .limit(1);
  // A sparse GitHub payload (e.g. a narrower webhook event's embedded pull_request sub-object, as opposed to a
  // full `GET /pulls/{n}` read) can omit `body` entirely (`undefined`) rather than reporting it as explicitly
  // empty (`null`/`""`) — `GitHubPullRequestPayload.body` is typed `string | null` precisely because a caller
  // may not have it at all. Re-deriving linked issues from an ABSENT body would silently wipe an
  // already-correctly-claimed linked issue (and reset its claim timestamp via resolveLinkedIssueClaimedAt's own
  // `linkedIssues.length === 0` branch) on any such upsert. Fall back to whatever is already stored in that
  // case; only a genuinely observed (possibly empty) body updates the claim. (#linked-issue-sparse-payload-preserve)
  const existingClaimRow = existingClaimRows[0];
  const preserveSparseBody = pr.body === undefined && existingClaimRow !== undefined;
  const existingPayload = preserveSparseBody ? parseJson<{ body?: string | null }>(existingClaimRow.payloadJson, {}) : undefined;
  const existingBody = existingPayload?.body ?? null;
  const body = preserveSparseBody ? existingBody : record.body;
  const payload = preserveSparseBody ? compactGitHubPayload({ ...pr, body: existingBody }) : compactGitHubPayload(pr);
  const linkedIssues = preserveSparseBody ? parseLinkedIssuesJson(existingClaimRow.linkedIssuesJson) : record.linkedIssues;
  const linkedIssuesJson = preserveSparseBody ? existingClaimRow.linkedIssuesJson : jsonString(linkedIssues);
  const observedLinkedIssueClaimedAt = linkedIssues.length > 0 ? syncedAt : null;
  const linkedIssueClaimedAt = resolveLinkedIssueClaimedAt(
    linkedIssues,
    linkedIssuesJson,
    existingClaimRow,
    observedLinkedIssueClaimedAt,
  );
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
      linkedIssuesJson,
      linkedIssueClaimedAt,
      lastSeenOpenAt,
      payloadJson: jsonString(payload),
      updatedAt: syncedAt,
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
        linkedIssuesJson,
        linkedIssueClaimedAt,
        lastSeenOpenAt,
        payloadJson: jsonString(payload),
        updatedAt: syncedAt,
      },
    });
  return { ...record, body, linkedIssues, linkedIssueClaimedAt };
}

function resolveLinkedIssueClaimedAt(
  linkedIssues: number[],
  linkedIssuesJson: string,
  existing:
    | {
        linkedIssuesJson: string;
        linkedIssueClaimedAt: string | null;
      }
    | undefined,
  observedLinkedIssueClaimedAt: string | null,
): string | null {
  if (linkedIssues.length === 0) return null;
  if (!existing) return observedLinkedIssueClaimedAt;
  if (
    existing.linkedIssuesJson === linkedIssuesJson ||
    sameLinkedIssueSet(parseLinkedIssuesJson(existing.linkedIssuesJson), linkedIssues)
  )
    return existing.linkedIssueClaimedAt ?? observedLinkedIssueClaimedAt;
  return observedLinkedIssueClaimedAt;
}

function parseLinkedIssuesJson(value: string): number[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? (parsed as number[]) : [];
}

function sameLinkedIssueSet(left: number[], right: number[]): boolean {
  return normalizedLinkedIssueSet(left) === normalizedLinkedIssueSet(right);
}

function normalizedLinkedIssueSet(numbers: number[]): string {
  return jsonString([...new Set(numbers)].sort((left, right) => left - right));
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
      regateSweepOrderMode: "staleness",
      reviewCheckMode: "disabled",
      autoProjectMilestoneMatch: "off",
      autoProjectMilestoneMatchBackend: "github",
      gatePack: "gittensor",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "block",
      qualityGateMode: "advisory",
      qualityGateMinScore: null,
      slopGateMode: "off",
      mergeReadinessGateMode: "off",
      manifestPolicyGateMode: "off",
      selfAuthoredLinkedIssueGateMode: "advisory",
      firstTimeContributorGrace: false,
      slopGateMinScore: null,
      slopAiAdvisory: false,
      aiReviewMode: "off",
      aiReviewByok: false,
      aiReviewProvider: null,
      aiReviewModel: null,
      aiReviewAllAuthors: false,
      closeOwnerAuthors: false,
      autoLabelEnabled: true,
      typeLabelsEnabled: true,
      typeLabels: { ...DEFAULT_TYPE_LABELS },
      linkedIssueLabelPropagation: { ...DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION, mappings: [] },
      linkedIssueHardRules: { ...DEFAULT_LINKED_ISSUE_HARD_RULES, pointBearingLabels: [], maintainerOnlyLabels: [] },
      gittensorLabel: "gittensor",
      blacklistLabel: "slop",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
      badgeEnabled: false,
      publicQualityMetrics: false,
      agentPaused: false,
      agentDryRun: false,
      commandAuthorization: normalizeCommandAuthorizationPolicy(DEFAULT_COMMAND_AUTHORIZATION_POLICY).policy,
      contributorBlacklist: [],
      autonomy: {},
      autoMaintain: { ...DEFAULT_AUTO_MAINTAIN_POLICY },
      contributorOpenPrCap: null,
      contributorOpenIssueCap: null,
      contributorCapLabel: "over-contributor-limit",
      contributorCapCancelCi: null,
      reviewNagPolicy: "off",
      reviewNagMaxPings: 3,
      reviewNagCooldownDays: 5,
      reviewNagLabel: "review-nag-cooldown",
      reviewNagMonitoredMentions: [],
      autoCloseExemptLogins: [],
      requireFreshRebaseWindowMinutes: null,
      accountAgeThresholdDays: null,
      newAccountLabel: "new-account",
      commandRateLimitPolicy: "off",
      commandRateLimitMaxPerWindow: 20,
      commandRateLimitAiMaxPerWindow: 5,
      commandRateLimitWindowHours: 24,
      moderationGateMode: "inherit",
      moderationRules: undefined,
      moderationWarningLabel: undefined,
      moderationBannedLabel: undefined,
      reviewEvasionProtection: "off",
      reviewEvasionLabel: DEFAULT_REVIEW_EVASION_LABEL,
      reviewEvasionComment: true,
      screenshotTableGate: { ...DEFAULT_SCREENSHOT_TABLE_GATE, whenLabels: [], whenPaths: [] },
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
    regateSweepOrderMode: parseRegateSweepOrderMode(row.regateSweepOrderMode),
    reviewCheckMode: parseReviewCheckMode(row.reviewCheckMode),
    autoProjectMilestoneMatch: parseProjectMilestoneMatchMode(row.projectMilestoneMatchMode),
    autoProjectMilestoneMatchBackend: parseProjectMilestoneMatchBackend(row.autoProjectMilestoneMatchBackend),
    gatePack: parseGatePack(row.gatePack),
    linkedIssueGateMode: parseGateRuleMode(row.linkedIssueGateMode),
    duplicatePrGateMode: parseGateRuleMode(row.duplicatePrGateMode),
    qualityGateMode: parseGateRuleMode(row.qualityGateMode),
    qualityGateMinScore: normalizeQualityGateMinScore(row.qualityGateMinScore),
    slopGateMode: parseGateRuleMode(row.slopGateMode),
    mergeReadinessGateMode: parseGateRuleMode(row.mergeReadinessGateMode),
    manifestPolicyGateMode: parseGateRuleMode(row.manifestPolicyGateMode),
    selfAuthoredLinkedIssueGateMode: parseGateRuleMode(row.selfAuthoredLinkedIssueGateMode),
    firstTimeContributorGrace: row.firstTimeContributorGrace,
    slopGateMinScore: normalizeQualityGateMinScore(row.slopGateMinScore),
    slopAiAdvisory: row.slopAiAdvisory,
    aiReviewMode: parseGateRuleMode(row.aiReviewMode),
    aiReviewByok: row.aiReviewByok,
    aiReviewProvider: normalizeAiReviewProvider(row.aiReviewProvider),
    aiReviewModel: row.aiReviewModel ?? null,
    aiReviewAllAuthors: row.aiReviewAllAuthors,
    closeOwnerAuthors: row.closeOwnerAuthors,
    autoLabelEnabled: row.autoLabelEnabled,
    typeLabelsEnabled: row.typeLabelsEnabled,
    typeLabels: parseTypeLabelSet(row.typeLabelsJson),
    linkedIssueLabelPropagation: parseLinkedIssueLabelPropagationConfig(row.linkedIssueLabelPropagationJson),
    linkedIssueHardRules: { ...DEFAULT_LINKED_ISSUE_HARD_RULES, pointBearingLabels: [], maintainerOnlyLabels: [] },
    gittensorLabel: row.gittensorLabel,
    blacklistLabel: row.blacklistLabel,
    createMissingLabel: row.createMissingLabel,
    publicSurface: parsePublicSurface(row.publicSurface),
    includeMaintainerAuthors: row.includeMaintainerAuthors,
    requireLinkedIssue: row.requireLinkedIssue,
    backfillEnabled: row.backfillEnabled,
    privateTrustEnabled: row.privateTrustEnabled,
    badgeEnabled: row.badgeEnabled,
    publicQualityMetrics: row.publicQualityMetrics,
    agentPaused: row.agentPaused,
    agentDryRun: row.agentDryRun,
    commandAuthorization: parseCommandAuthorizationPolicy(row.commandAuthorizationJson),
    contributorBlacklist: parseContributorBlacklist(row.contributorBlacklistJson),
    autonomy: parseAutonomyPolicy(row.autonomyJson),
    autoMaintain: parseAutoMaintainPolicy(row.autoMaintainJson),
    contributorOpenPrCap: normalizeOpenItemCap(row.contributorOpenPrCap),
    contributorOpenIssueCap: normalizeOpenItemCap(row.contributorOpenIssueCap),
    contributorCapLabel: row.contributorCapLabel,
    contributorCapCancelCi: row.contributorCapCancelCi,
    reviewNagPolicy: normalizeReviewNagPolicy(row.reviewNagPolicy),
    reviewNagMaxPings: normalizePositiveIntWithDefault(row.reviewNagMaxPings, 3),
    reviewNagCooldownDays: normalizeReviewNagCooldownDays(row.reviewNagCooldownDays, 5),
    reviewNagLabel: row.reviewNagLabel,
    reviewNagMonitoredMentions: parseAutoCloseExemptLogins(row.reviewNagMonitoredMentionsJson),
    autoCloseExemptLogins: parseAutoCloseExemptLogins(row.autoCloseExemptLoginsJson),
    requireFreshRebaseWindowMinutes: normalizePositiveIntOrNull(row.requireFreshRebaseWindowMinutes),
    accountAgeThresholdDays: normalizePositiveIntOrNull(row.accountAgeThresholdDays),
    newAccountLabel: row.newAccountLabel,
    commandRateLimitPolicy: normalizeCommandRateLimitPolicy(row.commandRateLimitPolicy),
    commandRateLimitMaxPerWindow: normalizePositiveIntWithDefault(row.commandRateLimitMaxPerWindow, 20),
    commandRateLimitAiMaxPerWindow: normalizePositiveIntWithDefault(row.commandRateLimitAiMaxPerWindow, 5),
    commandRateLimitWindowHours: normalizePositiveIntWithDefault(row.commandRateLimitWindowHours, 24),
    moderationGateMode: normalizeModerationGateMode(row.moderationGateMode),
    moderationRules: parseModerationRulesColumn(row.moderationRulesJson),
    moderationWarningLabel: normalizeModerationLabel(row.moderationWarningLabel),
    moderationBannedLabel: normalizeModerationLabel(row.moderationBannedLabel),
    reviewEvasionProtection: normalizeReviewEvasionProtection(row.reviewEvasionProtection),
    reviewEvasionLabel: row.reviewEvasionLabel,
    reviewEvasionComment: row.reviewEvasionComment,
    mergeTrainMode: normalizeMergeTrainMode(row.mergeTrainMode),
    screenshotTableGate: parseScreenshotTableGateRow(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Read the singleton shared/global contributor blacklist (#1425). Missing table or malformed JSON are
 *  treated as an empty list so DB hiccups in this path default to no global blocks rather than halting
 *  processing. A singleton row (`id = 'singleton'`) makes this a global control plane just like
 *  `global_agent_controls`. */
export async function getGlobalContributorBlacklist(env: Env): Promise<RepositorySettings["contributorBlacklist"]> {
  try {
    const row = await env.DB.prepare("SELECT contributor_blacklist_json FROM global_contributor_blacklist WHERE id = 'singleton'").first<{
      contributor_blacklist_json: string;
    }>();
    return parseContributorBlacklist(row?.contributor_blacklist_json ?? "[]");
  } catch {
    return [];
  }
}

/** Upsert the singleton shared/global contributor blacklist (#1425). Input is normalized/validated once so
 *  malformed stored data never reaches execution. Returns the normalized persisted list for convenience/tests.
 */
export async function upsertGlobalContributorBlacklist(env: Env, input: { contributorBlacklist: unknown; updatedBy?: string | null }): Promise<RepositorySettings["contributorBlacklist"]> {
  const normalized = normalizeContributorBlacklist(input.contributorBlacklist).entries;
  await env.DB.prepare(
    "INSERT INTO global_contributor_blacklist (id, contributor_blacklist_json, updated_at, updated_by) VALUES ('singleton', ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(id) DO UPDATE SET contributor_blacklist_json = excluded.contributor_blacklist_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  )
    .bind(jsonString(normalized), input.updatedBy ?? null)
    .run();
  return normalized;
}

export async function upsertRepositorySettings(env: Env, settings: Partial<RepositorySettings> & { repoFullName: string }): Promise<RepositorySettings> {
  // `satisfies` (not a `: RepositorySettings` annotation) so the `?? default` coalescing below keeps its
  // narrower inferred type (`string`, never `null`) for blacklistLabel/contributorCapLabel/reviewNagLabel --
  // the DB columns backing them stay NOT NULL (#label-scoping: only `.gittensory.yml`, not the dashboard/API
  // write path, can express "close without any label" via an explicit null; see focus-manifest.ts).
  const resolved = {
    repoFullName: settings.repoFullName,
    commentMode: settings.commentMode ?? "detected_contributors_only",
    publicAudienceMode: settings.publicAudienceMode ?? "oss_maintainer",
    publicSignalLevel: settings.publicSignalLevel ?? "standard",
    checkRunMode: settings.checkRunMode ?? "off",
    checkRunDetailLevel: settings.checkRunDetailLevel ?? "minimal",
    gateCheckMode: settings.gateCheckMode ?? "off",
    regateSweepOrderMode: settings.regateSweepOrderMode ?? "staleness",
    // Legacy-write compatibility (#2852): a caller that sets ONLY gateCheckMode (never touching the newer,
    // more expressive reviewCheckMode) must keep its historical effect -- "enabled" still means the check
    // publishes. This is safe under this function's existing "no field is preserved from the DB, an absent
    // field always gets a fresh default" contract (see the route-handler comment above): a true partial-update
    // caller already read-merges the full current settings (including its persisted reviewCheckMode) before
    // calling this, so `settings.reviewCheckMode` is never actually undefined for that path -- this fallback
    // only fires for callers that never cared about reviewCheckMode at all.
    reviewCheckMode: settings.reviewCheckMode ?? (settings.gateCheckMode === "enabled" ? "required" : "disabled"),
    autoProjectMilestoneMatch: settings.autoProjectMilestoneMatch ?? "off",
    autoProjectMilestoneMatchBackend: settings.autoProjectMilestoneMatchBackend ?? "github",
    gatePack: parseGatePack(settings.gatePack),
    linkedIssueGateMode: settings.linkedIssueGateMode ?? "advisory",
    duplicatePrGateMode: settings.duplicatePrGateMode ?? "block",
    qualityGateMode: settings.qualityGateMode ?? "advisory",
    qualityGateMinScore: normalizeQualityGateMinScore(settings.qualityGateMinScore),
    slopGateMode: settings.slopGateMode ?? "off",
    mergeReadinessGateMode: settings.mergeReadinessGateMode ?? "off",
    manifestPolicyGateMode: settings.manifestPolicyGateMode ?? "off",
    selfAuthoredLinkedIssueGateMode: settings.selfAuthoredLinkedIssueGateMode ?? "advisory",
    firstTimeContributorGrace: settings.firstTimeContributorGrace ?? false,
    slopGateMinScore: normalizeQualityGateMinScore(settings.slopGateMinScore),
    slopAiAdvisory: settings.slopAiAdvisory ?? false,
    aiReviewMode: settings.aiReviewMode ?? "off",
    aiReviewByok: settings.aiReviewByok ?? false,
    aiReviewProvider: normalizeAiReviewProvider(settings.aiReviewProvider),
    aiReviewModel: typeof settings.aiReviewModel === "string" && settings.aiReviewModel.trim() ? settings.aiReviewModel.trim() : null,
    aiReviewAllAuthors: settings.aiReviewAllAuthors ?? false,
    closeOwnerAuthors: settings.closeOwnerAuthors ?? false,
    autoLabelEnabled: settings.autoLabelEnabled ?? true,
    typeLabelsEnabled: settings.typeLabelsEnabled ?? true,
    typeLabels: normalizeTypeLabelSet(settings.typeLabels, []),
    linkedIssueLabelPropagation: normalizeLinkedIssueLabelPropagationConfig(settings.linkedIssueLabelPropagation, []),
    gittensorLabel: settings.gittensorLabel ?? "gittensor",
    blacklistLabel: settings.blacklistLabel ?? "slop",
    createMissingLabel: settings.createMissingLabel ?? true,
    publicSurface: settings.publicSurface ?? "comment_and_label",
    includeMaintainerAuthors: settings.includeMaintainerAuthors ?? false,
    requireLinkedIssue: settings.requireLinkedIssue ?? false,
    backfillEnabled: settings.backfillEnabled ?? true,
    privateTrustEnabled: settings.privateTrustEnabled ?? true,
    badgeEnabled: settings.badgeEnabled ?? false,
    publicQualityMetrics: settings.publicQualityMetrics ?? false,
    agentPaused: settings.agentPaused ?? false,
    agentDryRun: settings.agentDryRun ?? false,
    commandAuthorization: normalizeCommandAuthorizationPolicy(settings.commandAuthorization).policy,
    contributorBlacklist: normalizeContributorBlacklist(settings.contributorBlacklist).entries,
    autonomy: normalizeAutonomyPolicy(settings.autonomy),
    autoMaintain: normalizeAutoMaintainPolicy(settings.autoMaintain),
    contributorOpenPrCap: normalizeOpenItemCap(settings.contributorOpenPrCap),
    contributorOpenIssueCap: normalizeOpenItemCap(settings.contributorOpenIssueCap),
    contributorCapLabel: settings.contributorCapLabel ?? "over-contributor-limit",
    contributorCapCancelCi: typeof settings.contributorCapCancelCi === "boolean" ? settings.contributorCapCancelCi : null,
    reviewNagPolicy: normalizeReviewNagPolicy(settings.reviewNagPolicy),
    reviewNagMaxPings: normalizePositiveIntWithDefault(settings.reviewNagMaxPings, 3),
    reviewNagCooldownDays: normalizeReviewNagCooldownDays(settings.reviewNagCooldownDays, 5),
    reviewNagLabel: settings.reviewNagLabel ?? "review-nag-cooldown",
    reviewNagMonitoredMentions: normalizeAutoCloseExemptLogins(settings.reviewNagMonitoredMentions).logins,
    autoCloseExemptLogins: normalizeAutoCloseExemptLogins(settings.autoCloseExemptLogins).logins,
    requireFreshRebaseWindowMinutes: normalizePositiveIntOrNull(settings.requireFreshRebaseWindowMinutes),
    accountAgeThresholdDays: normalizePositiveIntOrNull(settings.accountAgeThresholdDays),
    newAccountLabel: settings.newAccountLabel ?? "new-account",
    commandRateLimitPolicy: normalizeCommandRateLimitPolicy(settings.commandRateLimitPolicy),
    commandRateLimitMaxPerWindow: normalizePositiveIntWithDefault(settings.commandRateLimitMaxPerWindow, 20),
    commandRateLimitAiMaxPerWindow: normalizePositiveIntWithDefault(settings.commandRateLimitAiMaxPerWindow, 5),
    commandRateLimitWindowHours: normalizePositiveIntWithDefault(settings.commandRateLimitWindowHours, 24),
    moderationGateMode: normalizeModerationGateMode(settings.moderationGateMode),
    moderationRules: settings.moderationRules,
    moderationWarningLabel: normalizeModerationLabel(settings.moderationWarningLabel),
    moderationBannedLabel: normalizeModerationLabel(settings.moderationBannedLabel),
    reviewEvasionProtection: normalizeReviewEvasionProtection(settings.reviewEvasionProtection),
    reviewEvasionLabel: settings.reviewEvasionLabel ?? DEFAULT_REVIEW_EVASION_LABEL,
    reviewEvasionComment: settings.reviewEvasionComment ?? true,
    mergeTrainMode: normalizeMergeTrainMode(settings.mergeTrainMode),
    screenshotTableGate: normalizeScreenshotTableGateConfig(settings.screenshotTableGate, []),
  } satisfies RepositorySettings;
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
      regateSweepOrderMode: resolved.regateSweepOrderMode,
      reviewCheckMode: resolved.reviewCheckMode,
      projectMilestoneMatchMode: resolved.autoProjectMilestoneMatch,
      autoProjectMilestoneMatchBackend: resolved.autoProjectMilestoneMatchBackend,
      gatePack: resolved.gatePack,
      linkedIssueGateMode: resolved.linkedIssueGateMode,
      duplicatePrGateMode: resolved.duplicatePrGateMode,
      qualityGateMode: resolved.qualityGateMode,
      qualityGateMinScore: resolved.qualityGateMinScore,
      slopGateMode: resolved.slopGateMode,
      mergeReadinessGateMode: resolved.mergeReadinessGateMode,
      manifestPolicyGateMode: resolved.manifestPolicyGateMode,
      selfAuthoredLinkedIssueGateMode: resolved.selfAuthoredLinkedIssueGateMode,
      firstTimeContributorGrace: resolved.firstTimeContributorGrace,
      slopGateMinScore: resolved.slopGateMinScore,
      slopAiAdvisory: resolved.slopAiAdvisory,
      aiReviewMode: resolved.aiReviewMode,
      aiReviewByok: resolved.aiReviewByok,
      aiReviewProvider: resolved.aiReviewProvider,
      aiReviewModel: resolved.aiReviewModel,
      aiReviewAllAuthors: resolved.aiReviewAllAuthors,
      closeOwnerAuthors: resolved.closeOwnerAuthors,
      autoLabelEnabled: resolved.autoLabelEnabled,
      typeLabelsEnabled: resolved.typeLabelsEnabled,
      typeLabelsJson: jsonString(resolved.typeLabels),
      linkedIssueLabelPropagationJson: jsonString(resolved.linkedIssueLabelPropagation),
      gittensorLabel: resolved.gittensorLabel,
      blacklistLabel: resolved.blacklistLabel,
      createMissingLabel: resolved.createMissingLabel,
      publicSurface: resolved.publicSurface,
      includeMaintainerAuthors: resolved.includeMaintainerAuthors,
      requireLinkedIssue: resolved.requireLinkedIssue,
      backfillEnabled: resolved.backfillEnabled,
      privateTrustEnabled: resolved.privateTrustEnabled,
      badgeEnabled: resolved.badgeEnabled,
      publicQualityMetrics: resolved.publicQualityMetrics,
      agentPaused: resolved.agentPaused,
      agentDryRun: resolved.agentDryRun,
      commandAuthorizationJson: jsonString(resolved.commandAuthorization),
      contributorBlacklistJson: jsonString(resolved.contributorBlacklist),
      autonomyJson: jsonString(resolved.autonomy),
      autoMaintainJson: jsonString(resolved.autoMaintain),
      contributorOpenPrCap: resolved.contributorOpenPrCap,
      contributorOpenIssueCap: resolved.contributorOpenIssueCap,
      contributorCapLabel: resolved.contributorCapLabel,
      contributorCapCancelCi: resolved.contributorCapCancelCi,
      reviewNagPolicy: resolved.reviewNagPolicy,
      reviewNagMaxPings: resolved.reviewNagMaxPings,
      reviewNagCooldownDays: resolved.reviewNagCooldownDays,
      reviewNagLabel: resolved.reviewNagLabel,
      reviewNagMonitoredMentionsJson: jsonString(resolved.reviewNagMonitoredMentions),
      autoCloseExemptLoginsJson: jsonString(resolved.autoCloseExemptLogins),
      requireFreshRebaseWindowMinutes: resolved.requireFreshRebaseWindowMinutes,
      accountAgeThresholdDays: resolved.accountAgeThresholdDays,
      newAccountLabel: resolved.newAccountLabel,
      commandRateLimitPolicy: resolved.commandRateLimitPolicy,
      commandRateLimitMaxPerWindow: resolved.commandRateLimitMaxPerWindow,
      commandRateLimitAiMaxPerWindow: resolved.commandRateLimitAiMaxPerWindow,
      commandRateLimitWindowHours: resolved.commandRateLimitWindowHours,
      moderationGateMode: resolved.moderationGateMode,
      moderationRulesJson: resolved.moderationRules === undefined ? null : jsonString(resolved.moderationRules),
      moderationWarningLabel: resolved.moderationWarningLabel ?? null,
      moderationBannedLabel: resolved.moderationBannedLabel ?? null,
      reviewEvasionProtection: resolved.reviewEvasionProtection,
      reviewEvasionLabel: resolved.reviewEvasionLabel,
      reviewEvasionComment: resolved.reviewEvasionComment,
      screenshotTableGateEnabled: resolved.screenshotTableGate.enabled,
      screenshotTableGateWhenLabelsJson: jsonString(resolved.screenshotTableGate.whenLabels),
      screenshotTableGateWhenPathsJson: jsonString(resolved.screenshotTableGate.whenPaths),
      screenshotTableGateAction: resolved.screenshotTableGate.action,
      screenshotTableGateMessage: resolved.screenshotTableGate.message ?? null,
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
        regateSweepOrderMode: resolved.regateSweepOrderMode,
        reviewCheckMode: resolved.reviewCheckMode,
      projectMilestoneMatchMode: resolved.autoProjectMilestoneMatch,
      autoProjectMilestoneMatchBackend: resolved.autoProjectMilestoneMatchBackend,
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
        selfAuthoredLinkedIssueGateMode: resolved.selfAuthoredLinkedIssueGateMode,
        firstTimeContributorGrace: resolved.firstTimeContributorGrace,
        slopGateMinScore: resolved.slopGateMinScore,
        slopAiAdvisory: resolved.slopAiAdvisory,
        aiReviewMode: resolved.aiReviewMode,
        aiReviewByok: resolved.aiReviewByok,
        aiReviewProvider: resolved.aiReviewProvider,
        aiReviewModel: resolved.aiReviewModel,
        aiReviewAllAuthors: resolved.aiReviewAllAuthors,
        closeOwnerAuthors: resolved.closeOwnerAuthors,
        autoLabelEnabled: resolved.autoLabelEnabled,
        typeLabelsEnabled: resolved.typeLabelsEnabled,
        typeLabelsJson: jsonString(resolved.typeLabels),
        linkedIssueLabelPropagationJson: jsonString(resolved.linkedIssueLabelPropagation),
        gittensorLabel: resolved.gittensorLabel,
        blacklistLabel: resolved.blacklistLabel,
        createMissingLabel: resolved.createMissingLabel,
        publicSurface: resolved.publicSurface,
        includeMaintainerAuthors: resolved.includeMaintainerAuthors,
        requireLinkedIssue: resolved.requireLinkedIssue,
        backfillEnabled: resolved.backfillEnabled,
        privateTrustEnabled: resolved.privateTrustEnabled,
        badgeEnabled: resolved.badgeEnabled,
      publicQualityMetrics: resolved.publicQualityMetrics,
        agentPaused: resolved.agentPaused,
        agentDryRun: resolved.agentDryRun,
        commandAuthorizationJson: jsonString(resolved.commandAuthorization),
        contributorBlacklistJson: jsonString(resolved.contributorBlacklist),
        autonomyJson: jsonString(resolved.autonomy),
        autoMaintainJson: jsonString(resolved.autoMaintain),
        contributorOpenPrCap: resolved.contributorOpenPrCap,
        contributorOpenIssueCap: resolved.contributorOpenIssueCap,
        contributorCapLabel: resolved.contributorCapLabel,
        contributorCapCancelCi: resolved.contributorCapCancelCi,
        reviewNagPolicy: resolved.reviewNagPolicy,
        reviewNagMaxPings: resolved.reviewNagMaxPings,
        reviewNagCooldownDays: resolved.reviewNagCooldownDays,
        reviewNagLabel: resolved.reviewNagLabel,
        reviewNagMonitoredMentionsJson: jsonString(resolved.reviewNagMonitoredMentions),
        autoCloseExemptLoginsJson: jsonString(resolved.autoCloseExemptLogins),
        requireFreshRebaseWindowMinutes: resolved.requireFreshRebaseWindowMinutes,
        accountAgeThresholdDays: resolved.accountAgeThresholdDays,
        newAccountLabel: resolved.newAccountLabel,
        commandRateLimitPolicy: resolved.commandRateLimitPolicy,
        commandRateLimitMaxPerWindow: resolved.commandRateLimitMaxPerWindow,
        commandRateLimitAiMaxPerWindow: resolved.commandRateLimitAiMaxPerWindow,
        commandRateLimitWindowHours: resolved.commandRateLimitWindowHours,
        moderationGateMode: resolved.moderationGateMode,
        moderationRulesJson: resolved.moderationRules === undefined ? null : jsonString(resolved.moderationRules),
        moderationWarningLabel: resolved.moderationWarningLabel ?? null,
        moderationBannedLabel: resolved.moderationBannedLabel ?? null,
        reviewEvasionProtection: resolved.reviewEvasionProtection,
        reviewEvasionLabel: resolved.reviewEvasionLabel,
        reviewEvasionComment: resolved.reviewEvasionComment,
        screenshotTableGateEnabled: resolved.screenshotTableGate.enabled,
        screenshotTableGateWhenLabelsJson: jsonString(resolved.screenshotTableGate.whenLabels),
        screenshotTableGateWhenPathsJson: jsonString(resolved.screenshotTableGate.whenPaths),
        screenshotTableGateAction: resolved.screenshotTableGate.action,
        screenshotTableGateMessage: resolved.screenshotTableGate.message ?? null,
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
 * secret is unavailable OR decryption fails — so the caller silently falls back to the free/default
 * reviewer and a misconfiguration never blocks the review. The plaintext key must be used immediately
 * and never cached.
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

// ─── Linear personal API key (#3186) ────────────────────────────────────────────────────────────
// Same isolated-table, encrypted-at-rest shape as the BYOK provider keys above (reuses the same
// TOKEN_ENCRYPTION_SECRET + encryptSecret/decryptSecret envelope) -- never serialized by the
// repository-settings GET surface, never settable via `.gittensory.yml`, never logged in plaintext.

export type RepositoryLinearKeyStatus = { configured: true; last4: string; createdBy: string | null; updatedAt: string | null } | { configured: false };

/** Read the secret-free status of a repo's configured Linear API key (for the dashboard/API). */
export async function getRepositoryLinearKeyStatus(env: Env, fullName: string): Promise<RepositoryLinearKeyStatus> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(repositoryLinearKeys).where(eq(repositoryLinearKeys.repoFullName, fullName)).limit(1);
  if (!row) return { configured: false };
  return { configured: true, last4: row.last4, createdBy: row.createdBy, updatedAt: row.updatedAt };
}

/**
 * Store (or replace) a repo's Linear API key, encrypted at rest. Returns the secret-free status.
 * Throws `missing_encryption_secret` when TOKEN_ENCRYPTION_SECRET is not configured — callers must
 * surface that rather than store a key in the clear.
 */
export async function upsertRepositoryLinearKey(env: Env, input: { repoFullName: string; key: string; createdBy?: string | null }): Promise<RepositoryLinearKeyStatus> {
  const secret = env.TOKEN_ENCRYPTION_SECRET;
  if (!secret) throw new Error("missing_encryption_secret");
  const trimmedKey = input.key.trim();
  const existing = await getRepositoryLinearKeyStatus(env, input.repoFullName);
  const { ciphertext, iv, salt, version } = await encryptSecret(trimmedKey, secret);
  const last4 = trimmedKey.slice(-4);
  const createdBy = input.createdBy ?? null;
  const updatedAt = nowIso();
  const db = getDb(env.DB);
  await db
    .insert(repositoryLinearKeys)
    .values({ repoFullName: input.repoFullName, ciphertext, iv, salt, keyVersion: version, last4, createdBy, updatedAt })
    .onConflictDoUpdate({
      target: repositoryLinearKeys.repoFullName,
      set: { ciphertext, iv, salt, keyVersion: version, last4, createdBy, updatedAt },
    });
  await recordAuditEvent(env, {
    eventType: "linear_key_change",
    actor: createdBy,
    targetKey: input.repoFullName,
    outcome: "completed",
    detail: `linear key ${existing.configured ? "replace" : "set"}`,
    metadata: { repoFullName: input.repoFullName, action: existing.configured ? "replace" : "set", last4 },
  });
  return { configured: true, last4, createdBy, updatedAt };
}

/** Remove a repo's Linear API key. Records a lifecycle audit event when a key was actually present. */
export async function deleteRepositoryLinearKey(env: Env, fullName: string, actor?: string | null): Promise<void> {
  const existing = await getRepositoryLinearKeyStatus(env, fullName);
  const db = getDb(env.DB);
  await db.delete(repositoryLinearKeys).where(eq(repositoryLinearKeys.repoFullName, fullName));
  if (existing.configured) {
    await recordAuditEvent(env, {
      eventType: "linear_key_change",
      actor: actor ?? null,
      targetKey: fullName,
      outcome: "completed",
      detail: "linear key delete",
      metadata: { repoFullName: fullName, action: "delete", last4: existing.last4 },
    });
  }
}

/**
 * Decrypt a repo's Linear API key for a Linear API call. Returns null when no key is configured OR the
 * encryption secret is unavailable OR decryption fails -- so the caller silently degrades (no Linear match
 * attempted) and a misconfiguration never blocks the PR-webhook pipeline. The plaintext key must be used
 * immediately and never cached.
 */
export async function getDecryptedRepositoryLinearKey(env: Env, fullName: string): Promise<string | null> {
  const secret = env.TOKEN_ENCRYPTION_SECRET;
  if (!secret) return null;
  const db = getDb(env.DB);
  const [row] = await db.select().from(repositoryLinearKeys).where(eq(repositoryLinearKeys.repoFullName, fullName)).limit(1);
  if (!row) return null;
  try {
    return await decryptSecret(row.ciphertext, row.iv, secret, row.salt);
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
    admissionKey: observation.admissionKey,
    resource: observation.resource,
    path: observation.path,
    statusCode: observation.statusCode,
    limitValue: observation.limitValue,
    remaining: observation.remaining,
    resetAt: observation.resetAt,
    observedAt: observation.observedAt ?? nowIso(),
  });
}

/**
 * Latest observations, newest first. When `admissionKey` is given, scoped to ONLY that bucket (#audit-rate-scoping)
 * — every managed installation and the separate shared public/registry token draw from DIFFERENT GitHub-side REST
 * buckets, so an unscoped read can return the wrong bucket's row (e.g. a fresh public-token observation masking an
 * exhausted installation bucket, or vice versa) purely because it happened to be the most recently written.
 */
export async function listLatestGitHubRateLimitObservations(env: Env, limit = 50, admissionKey?: string): Promise<GitHubRateLimitObservationRecord[]> {
  const db = getDb(env.DB);
  const rows = await (admissionKey !== undefined
    ? db.select().from(githubRateLimitObservations).where(eq(githubRateLimitObservations.admissionKey, admissionKey)).orderBy(desc(githubRateLimitObservations.observedAt)).limit(limit)
    : db.select().from(githubRateLimitObservations).orderBy(desc(githubRateLimitObservations.observedAt)).limit(limit));
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
  const rows = await db
    .select()
    .from(repoGithubTotalsSnapshots)
    .where(
      sql`${repoGithubTotalsSnapshots.fetchedAt} = (
        select max(latest.fetched_at)
        from repo_github_totals_snapshots latest
        where latest.repo_full_name = ${repoGithubTotalsSnapshots.repoFullName}
      )`,
    );
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

// PARTIAL-UPDATE CONTRACT: an omitted (`undefined`) field on `state` leaves that column UNCHANGED on conflict —
// drizzle's `onConflictDoUpdate` strips `undefined` entries from the generated SQL `SET` clause rather than
// writing NULL. Every "running" pre-fetch stamp (backfill.ts) relies on this to touch only `status` without
// clearing the PREVIOUS `headSha`/`*SyncedAt` row — including the repo+PR+headSha file cache
// (#audit-rate-headroom) and the durable bare-PR-state cache (#2537), which would silently stop hitting if a
// future edit here coalesced an omitted field to `null` (e.g. `headSha: state.headSha ?? null`). Pass `null`
// explicitly to actually clear a column (this is exactly how webhook invalidation clears prMergeableState/prState
// below).
export async function upsertPullRequestDetailSyncState(env: Env, state: PullRequestDetailSyncStateRecord): Promise<void> {
  const db = getDb(env.DB);
  await db
    .insert(pullRequestDetailSyncState)
    .values({
      id: `${state.repoFullName}#${state.pullNumber}`,
      repoFullName: state.repoFullName,
      pullNumber: state.pullNumber,
      status: state.status,
      headSha: state.headSha,
      filesSyncedAt: state.filesSyncedAt,
      reviewsSyncedAt: state.reviewsSyncedAt,
      reviewsInvalidatedAt: state.reviewsInvalidatedAt,
      checksSyncedAt: state.checksSyncedAt,
      lastSyncedAt: state.lastSyncedAt,
      errorSummary: state.errorSummary,
      prMergeableState: state.prMergeableState,
      prState: state.prState,
      prStateFetchedAt: state.prStateFetchedAt,
      ciHeadSha: state.ciHeadSha,
      ciState: state.ciState,
      ciHasPending: state.ciHasPending,
      ciHasVisiblePending: state.ciHasVisiblePending,
      ciHasMissingRequiredContext: state.ciHasMissingRequiredContext,
      ciFailingDetailsJson: state.ciFailingDetailsJson,
      ciNonRequiredFailingDetailsJson: state.ciNonRequiredFailingDetailsJson,
      ciCompletenessWarning: state.ciCompletenessWarning,
      ciRequiredContextsKey: state.ciRequiredContextsKey,
      ciStateFetchedAt: state.ciStateFetchedAt,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [pullRequestDetailSyncState.repoFullName, pullRequestDetailSyncState.pullNumber],
      set: {
        status: state.status,
        headSha: state.headSha,
        filesSyncedAt: state.filesSyncedAt,
        reviewsSyncedAt: state.reviewsSyncedAt,
        reviewsInvalidatedAt: state.reviewsInvalidatedAt,
        checksSyncedAt: state.checksSyncedAt,
        lastSyncedAt: state.lastSyncedAt,
        errorSummary: state.errorSummary,
        prMergeableState: state.prMergeableState,
        prState: state.prState,
        prStateFetchedAt: state.prStateFetchedAt,
        ciHeadSha: state.ciHeadSha,
        ciState: state.ciState,
        ciHasPending: state.ciHasPending,
        ciHasVisiblePending: state.ciHasVisiblePending,
        ciHasMissingRequiredContext: state.ciHasMissingRequiredContext,
        ciFailingDetailsJson: state.ciFailingDetailsJson,
        ciNonRequiredFailingDetailsJson: state.ciNonRequiredFailingDetailsJson,
        ciCompletenessWarning: state.ciCompletenessWarning,
        ciRequiredContextsKey: state.ciRequiredContextsKey,
        ciStateFetchedAt: state.ciStateFetchedAt,
        updatedAt: nowIso(),
      },
    });
}

/** Reviews-cache invalidation stamp (#2537): a pure single-field bump of `reviewsInvalidatedAt`, leaving
 *  every other column (`headSha`/`filesSyncedAt`/`reviewsSyncedAt`/`checksSyncedAt`/...) untouched when the
 *  row already exists — mirrors the narrow single-field touches on `pull_requests` (markPullRequestApproved,
 *  markPullRequestRegated). Creates the row (all other columns default/NULL) if this repo+PR has never been
 *  synced yet, so an early review webhook is not silently dropped.
 *
 *  Unlike its siblings above (advisory/reporting markers with other fallback signals), this write is the SOLE
 *  source of the reviews-cache invalidation signal (#2537 gate finding) — a single failed attempt loses that
 *  PR's specific "reviews changed" event permanently, with nothing to naturally re-trigger it until some LATER
 *  invalidation happens to succeed. The caller already treats this as best-effort (never blocks the webhook),
 *  so a short bounded retry absorbs a transient D1 blip in-process rather than needing a durable retry queue
 *  for what is still, even after this, a best-effort write. */
export async function markPullRequestReviewsInvalidated(env: Env, repoFullName: string, pullNumber: number): Promise<void> {
  const db = getDb(env.DB);
  const now = nowIso();
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await db
        .insert(pullRequestDetailSyncState)
        .values({
          id: `${repoFullName}#${pullNumber}`,
          repoFullName,
          pullNumber,
          status: "never_synced",
          reviewsInvalidatedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [pullRequestDetailSyncState.repoFullName, pullRequestDetailSyncState.pullNumber],
          set: {
            reviewsInvalidatedAt: now,
            updatedAt: now,
          },
        });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function getPullRequestDetailSyncState(env: Env, fullName: string, pullNumber: number): Promise<PullRequestDetailSyncStateRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select()
    .from(pullRequestDetailSyncState)
    .where(and(eq(pullRequestDetailSyncState.repoFullName, fullName), eq(pullRequestDetailSyncState.pullNumber, pullNumber)))
    .limit(1);
  return row ? toPullRequestDetailSyncStateRecord(row) : null;
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

/** Lookup a drift report by its stable fingerprint regardless of status (resolved reports included). */
export async function getUpstreamDriftReportByFingerprint(env: Env, fingerprint: string): Promise<UpstreamDriftReportRecord | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(upstreamDriftReports).where(eq(upstreamDriftReports.fingerprint, fingerprint)).limit(1);
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
    // GitHub logins are case-insensitive, so normalize like every sibling subscription path
    // (notification subscriptions, issue-watch) — otherwise a subscriber stored as "Foo" is missed on a
    // "foo" lookup and the [login, email] conflict target accumulates case-variant duplicate rows.
    login: input.login.toLowerCase(),
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
  const rows = await db
    .select()
    .from(digestSubscriptions)
    .where(sql`lower(${digestSubscriptions.login}) = ${login.toLowerCase()}`)
    .orderBy(desc(digestSubscriptions.updatedAt))
    .limit(20);
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
  const deleted = await db.delete(issueWatchSubscriptions).where(where).returning({ id: issueWatchSubscriptions.id });
  return deleted.length > 0;
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

// Global agent kill-switch (#audit-§5.2). A DB-backed emergency brake an operator flips with one row (no
// redeploy), complementing the env-var AGENT_ACTIONS_PAUSED hard backstop. Fail-OPEN on a read error (return
// false): a transient D1 hiccup must not by itself halt the whole fleet, and the env var is the hard backstop.
// The fail-open VALUE is an intentional, tested tradeoff — but it must never be SILENT: an operator who flips
// this during an incident concurrent with a D1 hiccup (or on a self-host instance that never ran migration
// 0059, or whose singleton row was later lost to a backup restore / manual cleanup) needs a visible signal that
// the kill-switch may not have actually engaged, not silent normal-looking operation. (#2125)
let processLocalGlobalAgentFrozen: boolean | null = null;
export function clearProcessLocalGlobalAgentFrozenCacheForTest(): void { processLocalGlobalAgentFrozen = null; }
export async function isGlobalAgentFrozen(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT frozen FROM global_agent_controls WHERE id = 'singleton'").first<{ frozen: number }>();
    if (!row) {
      console.warn(JSON.stringify({ ev: "global_kill_switch_row_missing", message: "global_agent_controls has no singleton row — treating as unfrozen; re-run migrations or re-seed the row" }));
      if (processLocalGlobalAgentFrozen === null) processLocalGlobalAgentFrozen = false;
      return processLocalGlobalAgentFrozen === true;
    }
    const frozen = row.frozen === 1;
    processLocalGlobalAgentFrozen = frozen;
    return frozen;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    console.warn(JSON.stringify({ ev: "global_kill_switch_read_error", message }));
    if (processLocalGlobalAgentFrozen === true) { console.warn(JSON.stringify({ ev: "global_kill_switch_read_error_fail_closed", message: "process-local cache shows frozen=1 — halting agent actions despite the read error" })); return true; }
    return false;
  }
}

/** Atomic re-gate fan-out dedup (#audit-fanout-dedup): claim the global fan-out slot for this window. The
 *  conditional UPDATE on the singleton matches only when the last fan-out is unset or older than `windowMs`. D1
 *  serializes writes, so when a BURST of fan-out jobs runs at once (a deploy-restart cron catch-up, or fan-out
 *  jobs that queued behind a per-PR backlog and drained together) exactly ONE wins the slot (changes === 1); the
 *  rest get 0 changes and skip, collapsing the burst to a single effective fan-out. Fail-open on a driver error
 *  (return true → the sweep still runs, degrading to the pre-dedup behaviour rather than stalling the fleet). */
export async function claimRegateFanoutSlot(env: Env, now: string, windowMs: number): Promise<boolean> {
  const threshold = new Date(Date.parse(now) - windowMs).toISOString();
  try {
    const result = await env.DB.prepare(
      "UPDATE global_agent_controls SET last_regate_fanout_at = ?1 WHERE id = 'singleton' AND (last_regate_fanout_at IS NULL OR last_regate_fanout_at < ?2)",
    )
      .bind(now, threshold)
      .run();
    /* v8 ignore next -- D1 update metadata normally includes changes; the ?? 0 fallback protects driver anomalies. */
    return Number(result.meta.changes ?? 0) === 1;
  } catch {
    return true;
  }
}

/** Flip the DB-backed global kill-switch (operator emergency brake; no redeploy required). */
export async function setGlobalAgentFrozen(env: Env, frozen: boolean, updatedBy?: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO global_agent_controls (id, frozen, updated_at, updated_by) VALUES ('singleton', ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(id) DO UPDATE SET frozen = excluded.frozen, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  )
    .bind(frozen ? 1 : 0, updatedBy ?? null)
    .run();
  processLocalGlobalAgentFrozen = frozen;
}

/** Strict (non-fail-open) read of the kill-switch row, for the operator route's read-after-write verification
 *  (#2359) and for surfacing current state. Unlike {@link isGlobalAgentFrozen} — deliberately fail-open on the
 *  enforcement hot path so a D1 hiccup never silently freezes the fleet — this THROWS on a driver error or a
 *  missing singleton row, because here a swallowed error must surface as "could not verify", never be silently
 *  reported as "unfrozen". */
export async function getGlobalAgentFrozenState(env: Env): Promise<{ frozen: boolean; updatedAt: string | null; updatedBy: string | null }> {
  const row = await env.DB.prepare("SELECT frozen, updated_at, updated_by FROM global_agent_controls WHERE id = 'singleton'").first<{
    frozen: number;
    updated_at: string | null;
    updated_by: string | null;
  }>();
  if (!row) throw new Error("global_agent_controls has no singleton row — re-run migrations or re-seed the row");
  return { frozen: row.frozen === 1, updatedAt: row.updated_at, updatedBy: row.updated_by };
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

export async function hasRecentAuditEventForOtherTarget(env: Env, actor: string, eventType: string, currentTargetKey: string, sinceIso: string): Promise<boolean> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.actor, actor), eq(auditEvents.eventType, eventType), not(eq(auditEvents.targetKey, currentTargetKey)), gte(auditEvents.createdAt, sinceIso)))
    .limit(1);
  return rows.length > 0;
}

/** Count-returning variant of {@link hasRecentAuditEvent}, additionally scoped to one `targetKey` (e.g. a single
 *  `owner/repo#123` PR/issue) rather than the actor's activity across the whole repo. Backs the review-request
 *  nagging cooldown (#2463): counting how many `@gittensory` pings a contributor has sent on ONE thread within
 *  the configured cooldown window. */
export async function countRecentAuditEventsForActorAndTarget(env: Env, actor: string, eventType: string, targetKey: string, sinceIso: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(and(eq(auditEvents.actor, actor), eq(auditEvents.eventType, eventType), eq(auditEvents.targetKey, targetKey), gte(auditEvents.createdAt, sinceIso)));
  /* v8 ignore next -- count(*) always returns exactly one row; the empty-array guard only satisfies the destructure type. */
  if (!row) return 0;
  return row.count;
}

/** Shared by every `targetKey` literal-prefix `LIKE` scan below ({@link countRecentAuditEventsForActorInRepo},
 *  {@link findHottestReviewTargetForRepo}) so a repo name containing a SQL `LIKE` wildcard (`%`/`_`) is always
 *  matched literally, never as a pattern -- e.g. `owner/foo_bar` must never spuriously match `owner/fooXbar#...`'s
 *  targets. */
function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Repo-scoped sibling of {@link countRecentAuditEventsForActorAndTarget} (#review-nag-cross-pr-carryover): counts
 * one actor's matching events across EVERY target within `repoFullName` (their current PR/issue plus every other
 * one they've touched), not just the single `targetKey` the caller happens to be evaluating. The per-target count
 * lets a contributor who exhausts a cooldown on PR A reset to a clean slate simply by opening a fresh PR B (a new
 * `issue.number` is a new `targetKey`) -- this is the fix: the running count now follows the ACTOR through the
 * repo, mirroring how the contributor blacklist and moderation-rules ban tally already persist by login rather
 * than by thread. Reuses the same literal-prefix `LIKE ... ESCAPE` scoping as {@link findHottestReviewTargetForRepo}
 * so `owner/foo_bar` can never spuriously match `owner/fooXbar#...`'s targets.
 */
export async function countRecentAuditEventsForActorInRepo(env: Env, actor: string, eventType: string, repoFullName: string, sinceIso: string): Promise<number> {
  const db = getDb(env.DB);
  const targetPrefixPattern = `${escapeSqlLikePattern(repoFullName)}#%`;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actor, actor),
        eq(auditEvents.eventType, eventType),
        sql`${auditEvents.targetKey} LIKE ${targetPrefixPattern} ESCAPE '\\'`,
        gte(auditEvents.createdAt, sinceIso),
      ),
    );
  /* v8 ignore next -- count(*) always returns exactly one row; the empty-array guard only satisfies the destructure type. */
  if (!row) return 0;
  return row.count;
}

/**
 * Variant of {@link countRecentAuditEventsForActorInRepo} for a `targetKey` shape that carries a THIRD segment
 * after `repo#issueNumber` (e.g. maybeThrottleMonitoredMentions's `owner/repo#123#mention:someLogin`): scopes
 * across every PR/issue NUMBER in the repo (the same repo-wide carryover fix) while still pinning to one EXACT
 * `targetKeySuffix`, so independently-budgeted sub-targets (one per monitored login) never bleed into each
 * other's count. Pass the suffix literally, e.g. `mention:someLogin` -- both `repoFullName` and `targetKeySuffix`
 * are escaped before embedding, so neither can smuggle in a stray SQL `LIKE` wildcard.
 */
export async function countRecentAuditEventsForActorInRepoWithTargetSuffix(
  env: Env,
  actor: string,
  eventType: string,
  repoFullName: string,
  targetKeySuffix: string,
  sinceIso: string,
): Promise<number> {
  const db = getDb(env.DB);
  const targetPattern = `${escapeSqlLikePattern(repoFullName)}#%#${escapeSqlLikePattern(targetKeySuffix)}`;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actor, actor),
        eq(auditEvents.eventType, eventType),
        sql`${auditEvents.targetKey} LIKE ${targetPattern} ESCAPE '\\'`,
        gte(auditEvents.createdAt, sinceIso),
      ),
    );
  /* v8 ignore next -- count(*) always returns exactly one row; the empty-array guard only satisfies the destructure type. */
  if (!row) return 0;
  return row.count;
}

/** #orb-ci-stuck-repeat / #orb-retry-storm ops-alerts signal: the single PR within `repoFullName` that published
 *  the most review surfaces in the last `sinceIso`-bounded window, and how many. `github_app.pr_public_surface_
 *  published` is a genuine INSERT-only event (never upserted) recorded once per successful publish pass
 *  (processors.ts's finishPublicSurfacePublication), so unlike ai_review_cache or review_audit's gate_decision
 *  rows (both keyed + upserted on `(repo, pr, headSha)`, so a repeat pass at an UNCHANGED head silently
 *  overwrites rather than accumulates), this correctly counts repeat publishes even when the head SHA never
 *  changes -- exactly the shape of a stuck-CI or sweep retry-storm bleed. Returns null when the repo published
 *  no surfaces in the window at all. */
export async function findHottestReviewTargetForRepo(
  env: Env,
  repoFullName: string,
  sinceIso: string,
): Promise<{ targetKey: string; count: number } | null> {
  const db = getDb(env.DB);
  const targetPrefixPattern = `${escapeSqlLikePattern(repoFullName)}#%`;
  const [row] = await db
    .select({ targetKey: auditEvents.targetKey, count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "github_app.pr_public_surface_published"),
        sql`${auditEvents.targetKey} LIKE ${targetPrefixPattern} ESCAPE '\\'`,
        gte(auditEvents.createdAt, sinceIso),
      ),
    )
    .groupBy(auditEvents.targetKey)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  /* v8 ignore next -- the WHERE clause's escaped LIKE predicate can never match a NULL target_key
   *  (SQL LIKE against NULL is NULL, never true), so a returned row always has a non-null targetKey; the
   *  column's nullable TS type is a schema-wide default this specific query structurally rules out. */
  if (!row || row.targetKey === null) return null;
  return { targetKey: row.targetKey, count: row.count };
}

/**
 * #review-burst-blind-spot: findHottestReviewTargetForRepo (above) only counts SUCCESSFUL publish events, so a
 * repeat-failure retry storm (every attempt SIGKILLed / zero output, never reaching a publish) is invisible to
 * it -- the exact incident shape c7073949 (#3747) fixed. Every AI review call's `ai_usage_events` row already
 * carries a structured `inconclusive` boolean in its metadata_json (set at src/services/ai-review.ts's `record`
 * call site) regardless of whether the review ever published, so this is a genuine companion signal, not a
 * guess: the hottest PR by INCONCLUSIVE review-call count in the window, across whichever repo's calls those
 * are. Deliberately does not touch `status` (always "ok" for a completed call, inconclusive or not) so the
 * daily neuron-budget sum (which filters status='ok') is never affected by this query.
 */
export async function findHottestInconclusiveReviewTargetForRepo(
  env: Env,
  repoFullName: string,
  sinceIso: string,
): Promise<{ targetKey: string; count: number } | null> {
  const db = getDb(env.DB);
  const pullNumberExpr = sql<string>`json_extract(${aiUsageEvents.metadataJson}, '$.pullNumber')`;
  const [row] = await db
    .select({ pullNumber: pullNumberExpr, count: sql<number>`count(*)` })
    .from(aiUsageEvents)
    .where(
      and(
        eq(aiUsageEvents.feature, "ai_review_pr"),
        gte(aiUsageEvents.createdAt, sinceIso),
        sql`json_extract(${aiUsageEvents.metadataJson}, '$.repoFullName') = ${repoFullName}`,
        sql`json_extract(${aiUsageEvents.metadataJson}, '$.inconclusive') = 1`,
      ),
    )
    .groupBy(pullNumberExpr)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  if (!row || row.pullNumber === null) return null;
  return { targetKey: `${repoFullName}#${row.pullNumber}`, count: row.count };
}

/** Moderation-rules engine (#selfhost-mod-engine): the actor's TOTAL violation count across every rule type in
 *  `eventTypes` and EVERY repo this install tracks (no targetKey/route scoping -- `audit_events` carries no
 *  repo/installation column at all, so this is inherently install-wide, mirroring the install-wide contributor
 *  cap's own use of this same table). `sinceIso` is optional: omitted ⇒ the PERMANENT lifetime tally (the
 *  default moderation-decay behavior); provided ⇒ only violations within that rolling window count, for an
 *  operator who configured `violationDecayDays`. */
export async function countModerationViolationsForActor(env: Env, actor: string, eventTypes: string[], sinceIso?: string): Promise<number> {
  const db = getDb(env.DB);
  const conditions = [eq(auditEvents.actor, actor), inArray(auditEvents.eventType, eventTypes)];
  if (sinceIso !== undefined) conditions.push(gte(auditEvents.createdAt, sinceIso));
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(and(...conditions));
  /* v8 ignore next -- count(*) always returns exactly one row; the empty-array guard only satisfies the destructure type. */
  if (!row) return 0;
  return row.count;
}

/** Moderation-rules engine: whether a violation has ALREADY been recorded for this EXACT (actor, eventType,
 *  targetKey) tuple. Deliberately NO time window (unlike hasRecentAuditEvent's sinceIso) -- "this PR/issue
 *  already contributed a violation of this kind to the tally" is permanently true once recorded, not
 *  something that should re-count on a later replay just because time has passed. */
export async function hasModerationViolationForTarget(env: Env, actor: string, eventType: string, targetKey: string): Promise<boolean> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.actor, actor), eq(auditEvents.eventType, eventType), eq(auditEvents.targetKey, targetKey)))
    .limit(1);
  return rows.length > 0;
}

/** Moderation-rules engine: record one violation for `actor` under the given rule's `eventType` (see
 *  `MODERATION_VIOLATION_EVENT_TYPE` in settings/moderation-rules.ts). `targetKey` carries the repo#number,
 *  and -- unlike the COUNT query above, which deliberately does not scope by it -- IS the idempotency key here
 *  (#gate-flagged): a webhook redelivery or queue retry that re-executes an already-recorded close must not
 *  double-count the SAME enforcement action toward the ban threshold. Returns whether a NEW row was actually
 *  inserted (false for an already-recorded duplicate), so the caller can skip redundant escalation work
 *  (re-labeling, re-checking the ban threshold) when nothing new actually happened. Best-effort, not a hard
 *  guarantee under true concurrency (no unique constraint on audit_events for this) -- matches this
 *  codebase's other check-then-act coalescing helpers, and is more than sufficient for the sequential
 *  redelivery/retry pattern it defends against. */
export async function recordModerationViolation(env: Env, args: { eventType: string; actor: string; targetKey: string; repoFullName: string; ruleReason: string }): Promise<boolean> {
  if (await hasModerationViolationForTarget(env, args.actor, args.eventType, args.targetKey)) return false;
  await recordAuditEvent(env, {
    eventType: args.eventType,
    actor: args.actor,
    targetKey: args.targetKey,
    outcome: "completed",
    detail: args.ruleReason,
    metadata: { repoFullName: args.repoFullName },
  });
  return true;
}

// #gate-flagged: same non-rounding shape as normalizePositiveIntOrNull, PLUS its OWN upper bound -- unlike an
// ordinary open-item cap, this value feeds Date arithmetic on the LIVE close path (`Date.now() -
// violationDecayDays * 86400000`); an unbounded value (e.g. a typo adding extra zeros) can overflow into an
// Invalid Date, and calling .toISOString() on an Invalid Date THROWS, crashing the close. Clamped (Math.min),
// not dropped to null, mirroring normalizeReviewNagCooldownDays' own clamping shape for the same "still
// meaningful, just bounded" family of day-count settings. Deliberately calls normalizePositiveIntOrNull, NOT
// normalizeOpenItemCap: the latter's 100-row cap is specific to the live-verification sample budget and has
// nothing to do with this setting's own, much larger MAX_MODERATION_VIOLATION_DECAY_DAYS ceiling.
function normalizeModerationDecayDays(value: number | null | undefined): number | null {
  const parsed = normalizePositiveIntOrNull(value);
  return parsed === null ? null : Math.min(parsed, MAX_MODERATION_VIOLATION_DECAY_DAYS);
}

/** Read the singleton global moderation-rules engine config (#selfhost-mod-engine). A missing table/row fails
 *  open to the FULL {@link DEFAULT_GLOBAL_MODERATION_CONFIG} (`enabled: false`) -- a DB hiccup on this path
 *  must never accidentally turn ON a layer capable of auto-banning a contributor across every gated repo.
 *  Malformed JSON in an otherwise-present row is narrower: only `rules_json` degrades (to an empty rules
 *  list, via `normalizeModerationRules`), while every other column is still read from the row as normal. */
export async function getGlobalModerationConfig(env: Env): Promise<GlobalModerationConfig> {
  try {
    const row = await env.DB.prepare(
      "SELECT enabled, rules_json, warning_label, banned_label, ban_threshold, violation_decay_days, auto_blacklist_on_ban FROM global_moderation_config WHERE id = 'singleton'",
    ).first<{
      enabled: number;
      rules_json: string;
      warning_label: string;
      banned_label: string;
      ban_threshold: number;
      violation_decay_days: number | null;
      auto_blacklist_on_ban: number;
    }>();
    if (!row) return DEFAULT_GLOBAL_MODERATION_CONFIG;
    return {
      enabled: row.enabled === 1,
      rules: normalizeModerationRules(parseJson<unknown>(row.rules_json, null)).rules,
      warningLabel: normalizeModerationLabel(row.warning_label) ?? DEFAULT_GLOBAL_MODERATION_CONFIG.warningLabel,
      bannedLabel: normalizeModerationLabel(row.banned_label) ?? DEFAULT_GLOBAL_MODERATION_CONFIG.bannedLabel,
      banThreshold: normalizePositiveIntWithDefault(row.ban_threshold, DEFAULT_GLOBAL_MODERATION_CONFIG.banThreshold),
      violationDecayDays: normalizeModerationDecayDays(row.violation_decay_days),
      autoBlacklistOnBan: row.auto_blacklist_on_ban === 1,
    };
  } catch {
    return DEFAULT_GLOBAL_MODERATION_CONFIG;
  }
}

/** Upsert the singleton global moderation-rules engine config. Input is normalized/validated once so malformed
 *  stored data never reaches enforcement. Returns the normalized persisted config for convenience/tests. */
export async function upsertGlobalModerationConfig(
  env: Env,
  input: Partial<GlobalModerationConfig> & { updatedBy?: string | null },
): Promise<GlobalModerationConfig> {
  const current = await getGlobalModerationConfig(env);
  const resolved: GlobalModerationConfig = {
    enabled: input.enabled ?? current.enabled,
    rules: input.rules ? normalizeModerationRules(input.rules as unknown).rules : current.rules,
    warningLabel: normalizeModerationLabel(input.warningLabel) ?? current.warningLabel,
    bannedLabel: normalizeModerationLabel(input.bannedLabel) ?? current.bannedLabel,
    banThreshold: input.banThreshold !== undefined ? normalizePositiveIntWithDefault(input.banThreshold, current.banThreshold) : current.banThreshold,
    violationDecayDays: input.violationDecayDays !== undefined ? normalizeModerationDecayDays(input.violationDecayDays) : current.violationDecayDays,
    autoBlacklistOnBan: input.autoBlacklistOnBan ?? current.autoBlacklistOnBan,
  };
  await env.DB.prepare(
    "INSERT INTO global_moderation_config (id, enabled, rules_json, warning_label, banned_label, ban_threshold, violation_decay_days, auto_blacklist_on_ban, updated_at, updated_by) VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, rules_json = excluded.rules_json, warning_label = excluded.warning_label, banned_label = excluded.banned_label, ban_threshold = excluded.ban_threshold, violation_decay_days = excluded.violation_decay_days, auto_blacklist_on_ban = excluded.auto_blacklist_on_ban, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  )
    .bind(
      resolved.enabled ? 1 : 0,
      jsonString(resolved.rules),
      resolved.warningLabel,
      resolved.bannedLabel,
      resolved.banThreshold,
      resolved.violationDecayDays,
      resolved.autoBlacklistOnBan ? 1 : 0,
      input.updatedBy ?? null,
    )
    .run();
  return resolved;
}

/** Whether `deliveryId` has ALREADY been recorded for this (actor, eventType, targetKey) within `sinceIso` --
 *  makes a counting/rate-limit check idempotent against a REDELIVERED or retried webhook event (GitHub can
 *  and does redeliver the same issue_comment event), which would otherwise increment the counter twice for
 *  one real invocation and can incorrectly rate-limit it (#2560). Scoped to a short recent window, not the
 *  full rate-limit window -- a genuine redelivery lands within seconds, not hours later.
 *  Gate review finding: an earlier version matched deliveryId IN MEMORY over a `.limit(50)` slice with no
 *  ORDER BY -- once an actor accumulated more than 50 matching rows within the window (a burst/spam scenario,
 *  exactly what this feature exists to handle), the row carrying the original deliveryId could be excluded
 *  from that arbitrary slice, producing a false negative right when it matters most. The deliveryId match is
 *  now pushed into the SQL predicate itself (json_extract on metadataJson, mirroring
 *  countRecentDeadLettersByType's own json_extract usage below), so it's an exact match against every row in
 *  the window regardless of how many other rows exist for this actor/event/target. */
export async function hasAuditEventForDelivery(env: Env, actor: string, eventType: string, targetKey: string, deliveryId: string, sinceIso: string): Promise<boolean> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actor, actor),
        eq(auditEvents.eventType, eventType),
        eq(auditEvents.targetKey, targetKey),
        gte(auditEvents.createdAt, sinceIso),
        sql`json_extract(${auditEvents.metadataJson}, '$.deliveryId') = ${deliveryId}`,
      ),
    );
  /* v8 ignore next -- count(*) always returns exactly one row; the empty-array guard only satisfies the destructure type. */
  return (row?.count ?? 0) > 0;
}

/** Observability for the queue dead-letter rate (#1276): how many jobs (across BOTH the maintenance and webhook
 *  lanes) were dead-lettered since `sinceIso`. Reads the `github_app.dlq_dead_lettered` audit events written by
 *  processDlqBatch — NOT gated behind any review-ops flag, so the infra drop rate is always visible. */
export async function countRecentDeadLetters(env: Env, sinceIso: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(and(eq(auditEvents.eventType, "github_app.dlq_dead_lettered"), gte(auditEvents.createdAt, sinceIso)));
  /* v8 ignore next -- count(*) always returns exactly one row; the empty-array guard only satisfies the destructure type. */
  if (!row) return 0;
  return row.count;
}

/** Observability for the DLQ dashboard (#1208): recent dead letters grouped by job type, using the jobType stored
 *  in each `github_app.dlq_dead_lettered` audit event's metadata. Missing/blank jobType falls back to `unknown`,
 *  and the returned object's keys are sorted deterministically for stable consumers/tests. */
export async function countRecentDeadLettersByType(env: Env, sinceIso: string): Promise<Record<string, number>> {
  const db = getDb(env.DB);
  const jobTypeExpr =
    sql<string>`coalesce(nullif(trim(cast(json_extract(${auditEvents.metadataJson}, '$.jobType') as text)), ''), 'unknown')`;
  const rows = await db
    .select({
      jobType: jobTypeExpr,
      count: sql<number>`count(*)`,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.eventType, "github_app.dlq_dead_lettered"), gte(auditEvents.createdAt, sinceIso)))
    .groupBy(jobTypeExpr)
    .orderBy(asc(jobTypeExpr));
  return Object.fromEntries(rows.map((row) => [row.jobType, Number(row.count)]));
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

// #784 audit feed: the agent's own action history for a repo — both executed actions (`agent.action.<class>`)
// and approval-queue decisions (`agent.pending_action.accepted|rejected`). Repo-scoped via the `repo#pr`
// targetKey prefix range (mirrors listPrVisibilitySkipAuditEvents). Read-only; private trust/score metadata
// is never selected, only the public-safe action posture.
export type AgentAuditEvent = {
  eventType: string;
  pullNumber: number | null;
  outcome: string;
  actor: string | null;
  detail: string | null;
  createdAt: string;
};

export async function listAgentAuditEvents(
  env: Env,
  options: { repoFullName: string; sinceIso?: string | undefined; limit?: number | undefined },
): Promise<AgentAuditEvent[]> {
  const limit = clampInteger(options.limit ?? 50, 1, 200);
  // Match exactly `repo#<...>` keys: lower bound `repo#`, upper bound `repo#` + the max code point, which
  // sorts past any value that can follow the `#` — robust against delimiter-adjacent edge cases.
  const prefix = `${options.repoFullName.toLowerCase()}#`;
  const upperBound = `${options.repoFullName.toLowerCase()}#\uffff`;
  const conditions: SQL[] = [
    sql`(${auditEvents.eventType} like 'agent.action.%' or ${auditEvents.eventType} like 'agent.pending_action.%')`,
    sql`lower(${auditEvents.targetKey}) >= ${prefix} and lower(${auditEvents.targetKey}) < ${upperBound}`,
  ];
  if (options.sinceIso) conditions.push(gte(auditEvents.createdAt, options.sinceIso));
  const rows = await getDb(env.DB)
    .select({ eventType: auditEvents.eventType, targetKey: auditEvents.targetKey, outcome: auditEvents.outcome, actor: auditEvents.actor, detail: auditEvents.detail, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit);
  return rows.map((row) => ({
    eventType: row.eventType,
    pullNumber: parsePullRequestTargetKey(row.targetKey)?.pullNumber ?? null,
    outcome: row.outcome,
    actor: row.actor,
    detail: row.detail,
    createdAt: row.createdAt,
  }));
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
    provider?: string | null | undefined;
    effort?: string | null | undefined;
    status: string;
    estimatedNeurons: number;
    inputTokens?: number | null | undefined;
    outputTokens?: number | null | undefined;
    totalTokens?: number | null | undefined;
    costUsd?: number | null | undefined;
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
    provider: event.provider?.trim() || null,
    effort: event.effort?.trim() || null,
    status: event.status,
    estimatedNeurons: Math.max(0, Math.round(event.estimatedNeurons)),
    inputTokens: Math.max(0, Math.round(finiteNumber(event.inputTokens))),
    outputTokens: Math.max(0, Math.round(finiteNumber(event.outputTokens))),
    totalTokens: Math.max(0, Math.round(finiteNumber(event.totalTokens))),
    costUsd: Math.max(0, finiteNumber(event.costUsd)),
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

/**
 * #hosted-ai-usage-observability: the ONLY AI activity the HOSTED gittensory-api Worker can ever have is a
 * maintainer's own BYOK call (the legacy Workers-AI-binding path is retired; `env.AI` is undefined there) --
 * yet nothing previously read back the real token/cost columns migration 0109 added to `ai_usage_events` for
 * the hosted deployment specifically (the one dashboard built for this, orb-ai-usage.json, is wired
 * exclusively to self-host's own local reporting-export SQLite mirror and cannot see the hosted D1 at all).
 * Real, not estimated: sums the actual provider-reported input/output/total tokens and cost_usd, not the
 * estimatedNeurons quota-proxy sumAiEstimatedNeuronsSince already tracks.
 */
export async function sumByokAiUsageForRepoSince(
  env: Env,
  repoFullName: string,
  sinceIso: string,
): Promise<{ calls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}), 0)`,
    })
    .from(aiUsageEvents)
    .where(
      and(
        gte(aiUsageEvents.createdAt, sinceIso),
        eq(aiUsageEvents.status, "ok"),
        sql`${aiUsageEvents.model} like 'byok:%'`,
        sql`json_extract(${aiUsageEvents.metadataJson}, '$.repoFullName') = ${repoFullName}`,
      ),
    );
  /* v8 ignore next -- SQL aggregate sum/count always returns one row; fallback protects D1 driver anomalies. */
  if (!row) return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  return {
    calls: Number(row.calls),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    totalTokens: Number(row.totalTokens),
    costUsd: Number(row.costUsd),
  };
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

// RC3 terminal-fail merges. The auto-maintain executor calls these when a merge mutation fails so the planner
// stops planning a merge it can never complete (403/405/409/conflict), instead of retrying every sweep forever.

/** Increment the failed-merge attempt counter for a PR, scoped to the head SHA that failed. Returns the new
 *  count. Scoping to headSha means a new commit's attempts start fresh once the row's head advances. */
export async function bumpPullRequestMergeAttempt(env: Env, fullName: string, number: number, headSha: string): Promise<number> {
  const db = getDb(env.DB);
  await db
    .update(pullRequests)
    .set({ mergeAttemptCount: sql`${pullRequests.mergeAttemptCount} + 1`, updatedAt: nowIso() })
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number), eq(pullRequests.headSha, headSha)));
  const [row] = await db
    .select({ count: pullRequests.mergeAttemptCount })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number)))
    .limit(1);
  return Number(row?.count ?? 0);
}

// Review-evasion: repeated ready<->draft cycling (#gaming-tactic-draft-cycle).

/** Increment the ready<->draft conversion counter for a PR and return the new total. Deliberately NOT scoped
 *  to headSha (unlike bumpPullRequestMergeAttempt) -- a contributor pushing a new commit between draft cycles
 *  is still doing the same repeated-evasion shape, so a fresh head must not reset the count back to zero. */
export async function bumpPullRequestDraftConversionCount(env: Env, fullName: string, number: number): Promise<number> {
  const db = getDb(env.DB);
  await db
    .update(pullRequests)
    .set({ draftConversionCount: sql`${pullRequests.draftConversionCount} + 1`, updatedAt: nowIso() })
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number)));
  const [row] = await db
    .select({ count: pullRequests.draftConversionCount })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number)))
    .limit(1);
  return Number(row?.count ?? 0);
}

/** Mark a PR terminally merge-blocked for its current head SHA: the planner skips the `merge` disposition while
 *  merge_blocked_sha == headSha. Scoped to headSha so a later commit (a pushed fix) auto-clears the block (the
 *  guard compares it to the live head). Records the human-readable terminal reason. */
export async function markPullRequestMergeBlocked(env: Env, fullName: string, number: number, headSha: string, reason: string): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(pullRequests)
    .set({ mergeBlockedSha: headSha, mergeBlockedReason: reason.slice(0, 280), updatedAt: nowIso() })
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number), eq(pullRequests.headSha, headSha)));
}

// Linked-issue hard-rule violation memory (#linked-issue-hard-rule-persistence).

/** Record the FIRST confirmed linked-issue hard-rule violation for a PR. Deliberately NOT scoped to headSha
 *  (unlike markPullRequestMergeBlocked) and NEVER overwritten once set (mirrors bumpPullRequestDraftConversionCount's
 *  own "never resets" discipline) -- COALESCE keeps whichever value was written first, so a contributor editing
 *  the body or the linked issue's state changing after this call is a no-op here: the PR already proved itself in
 *  violation once and stays that way for its lifetime. A no-op (0 rows affected) when the PR row doesn't exist yet
 *  is safe -- the caller only reaches this after a live violation was just evaluated against an existing row. */
export async function markPullRequestLinkedIssueHardRuleViolated(env: Env, fullName: string, number: number, reason: string): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(pullRequests)
    .set({
      linkedIssueHardRuleViolatedAt: sql`COALESCE(${pullRequests.linkedIssueHardRuleViolatedAt}, ${nowIso()})`,
      linkedIssueHardRuleViolationReason: sql`COALESCE(${pullRequests.linkedIssueHardRuleViolationReason}, ${reason.slice(0, 280)})`,
      updatedAt: nowIso(),
    })
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number)));
}

/** Re-approval idempotency: record the head SHA the bot just auto-approved. The planner skips the `approve`
 *  disposition while approved_head_sha == headSha (this commit is already approved by the bot). Scoped to
 *  headSha so a later commit (the live head no longer matches) lets the bot re-approve the new code without
 *  any manual reset. Mirrors markPullRequestMergeBlocked. */
export async function markPullRequestApproved(env: Env, fullName: string, number: number, headSha: string): Promise<void> {
  const db = getDb(env.DB);
  await db
    .update(pullRequests)
    .set({ approvedHeadSha: headSha, updatedAt: nowIso() })
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number), eq(pullRequests.headSha, headSha)));
}

/** Public-surface marker: record the head SHA at which the PR's public surface was just published. This is
 *  reporting/diagnostic state, not a hard scheduled-sweep skip; GitHub comments/checks can be stale or partial even
 *  when the marker matches the current head. The eq(headSha) in the WHERE is load-bearing: if the live head advanced
 *  between review and this write, the UPDATE no-ops (never stamps a stale head). Mirrors markPullRequestApproved. */
export async function markPullRequestSurfacePublished(env: Env, fullName: string, number: number, headSha: string | null | undefined): Promise<void> {
  if (!headSha) return; // no head to key the marker on → nothing to stamp (the caller's advisory had no head SHA)
  const db = getDb(env.DB);
  await db
    .update(pullRequests)
    .set({ lastPublishedSurfaceSha: headSha, updatedAt: nowIso() })
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number), eq(pullRequests.headSha, headSha)));
}

/** Sweep convergence: stamp the timestamp the scheduled re-gate sweep just recomputed this PR. A plain D1 UPDATE
 *  — NOT routed through the agent-action-executor chokepoint (#1258) — so it advances even when GitHub writes are
 *  suppressed (dry-run / paused). selectRegateCandidates orders the sweep by last_regated_at, so a just-regated PR
 *  sorts freshest and the next sweep picks the next-stalest → the sweep converges over all open PRs. Keyed to the
 *  PR (not the head SHA): a re-gate stamps the PR regardless of which commit is live. */
export async function markPullRequestRegated(env: Env, fullName: string, number: number): Promise<void> {
  const db = getDb(env.DB);
  const now = nowIso();
  await db
    .update(pullRequests)
    .set({ lastRegatedAt: now, updatedAt: now })
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.number, number)));
}

/** Batch variant: stamp the re-gate marker for every dispatched candidate in ONE write, at sweep DISPATCH time.
 *  Stamping here — not in the downstream per-PR job — makes getLatestRegatedAt reflect the sweep immediately, so
 *  the in-flight guard engages on the next cron tick before the staggered/deferred per-PR re-reviews complete.
 *  This closes the overlapping-sweep runaway where the per-PR stamp lagged minutes behind under load. A plain D1
 *  write — never the #1258 GitHub chokepoint — so dry-run stays inert. (#audit-sweep-dispatch-stamp) */
export async function markPullRequestsRegated(env: Env, fullName: string, numbers: number[]): Promise<void> {
  if (numbers.length === 0) return;
  const db = getDb(env.DB);
  const now = nowIso();
  await db
    .update(pullRequests)
    .set({ lastRegatedAt: now, updatedAt: now })
    .where(and(eq(pullRequests.repoFullName, fullName), inArray(pullRequests.number, numbers)));
}

/** In-flight guard input for the re-gate sweep fan-out (#audit-sweep-fanout): the MOST RECENT last_regated_at
 *  across a repo's OPEN PRs (the freshest sweep stamp), or null if none has been swept. fanOutAgentRegateSweepJobs
 *  passes this to isRegateSweepDraining to skip re-arming a repo whose prior sweep is still draining. */
export async function getLatestRegatedAt(env: Env, fullName: string): Promise<string | null> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ latest: sql<string | null>`max(${pullRequests.lastRegatedAt})` })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.state, "open")));
  /* v8 ignore next -- max() always returns exactly one row; the empty-array guard only satisfies the destructure type. */
  if (!row) return null;
  return row.latest;
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

const INSTALLATION_REPO_LIST_LIMIT = 20_000;

/** List every repo's fullName tracked under one installation (regression fix, #2562): pullRequests/issues have
 *  no installationId column of their own (only repoFullName, a plain string, matched by convention against
 *  repositories.fullName -- this codebase has no Drizzle joins to lean on instead), so scoping a cross-repo
 *  aggregate to one install means resolving its repo set FIRST, mirroring markRepositoriesRemovedFromInstallation
 *  (same file).
 *
 * INSTALLATION_REPO_LIST_LIMIT (gate finding): raised far above any realistic install size so truncation should
 * never occur in practice, but a silently truncated repo set would understate countOpenItemsForAuthorAcrossRepos
 * for that installation with no signal anything was dropped -- record an audit event on the rare install where
 * the limit is still hit, rather than pretending completeness this query can't actually guarantee unbounded. */
async function listRepoFullNamesForInstallation(env: Env, installationId: number): Promise<string[]> {
  const db = getDb(env.DB);
  const rows = await db.select({ fullName: repositories.fullName }).from(repositories).where(eq(repositories.installationId, installationId)).limit(INSTALLATION_REPO_LIST_LIMIT);
  if (rows.length === INSTALLATION_REPO_LIST_LIMIT) {
    await recordAuditEvent(env, {
      eventType: "agent.global_open_item_cap.repo_list_truncated",
      actor: "gittensory",
      targetKey: `installation:${installationId}`,
      outcome: "error",
      detail: `installation has >= ${INSTALLATION_REPO_LIST_LIMIT} repos; the global contributor-cap check may undercount repos not included here`,
    }).catch(() => undefined);
  }
  return rows.map((row) => row.fullName);
}

/**
 * Install-wide open-item count for one author (#2562, anti-abuse): SUM of this author's open PRs + open
 * issues across every repo THIS INSTALLATION tracks. Same-database aggregate only -- no cross-instance
 * networking, mirroring the install-scoped singleton shape of global_contributor_blacklist. Case-insensitive
 * login match (mirrors loginMatches/findBlacklistEntry elsewhere in this file).
 *
 * Installation-scoped (regression fix): pullRequests/issues rows carry no installationId of their own, only
 * repoFullName. The original version of this query filtered by authorLogin alone with no installation scoping
 * at all, so on a D1 database shared by MULTIPLE installations (the hosted product's normal shape, and possible
 * on self-host too -- the same App installed against more than one org/account) a contributor's open items on
 * a DIFFERENT, unrelated installation would count toward (and could wrongly close a PR on) an install that
 * never gated them on -- the exact cross-tenant leak install-scoped helpers elsewhere in this codebase (e.g.
 * markRepositoriesRemovedFromInstallation) exist to avoid.
 */
export type OpenItemAcrossInstallRow = { repoFullName: string; number: number; kind: "pull_request" | "issue" };

const AUTHOR_OPEN_ITEM_LIST_LIMIT = 20_000;

/**
 * Install-wide open-item ROWS for one author (#2562 gate-review follow-up), across every repo THIS
 * INSTALLATION tracks. Returns the actual rows (not just a count) so the caller can LIVE-VERIFY each one
 * before trusting the aggregate toward an irreversible close -- the stored DB cache can lag GitHub for a repo
 * OTHER than the one the current webhook is for, and an inflated stale count must never itself trigger a
 * close (mirrors the existing per-repo issue-cap's own sibling live-verification, #2479). Same-database
 * aggregate only -- no cross-instance networking, mirroring the install-scoped singleton shape of
 * global_contributor_blacklist. Case-insensitive login match (mirrors loginMatches/findBlacklistEntry
 * elsewhere in this file).
 */
export async function listOpenItemsForAuthorAcrossInstall(env: Env, installationId: number, authorLogin: string): Promise<OpenItemAcrossInstallRow[]> {
  const repoNames = await listRepoFullNamesForInstallation(env, installationId);
  if (repoNames.length === 0) return [];
  const db = getDb(env.DB);
  const prRows = await db
    .select({ repoFullName: pullRequests.repoFullName, number: pullRequests.number })
    .from(pullRequests)
    .where(and(eq(pullRequests.state, "open"), loginMatches(pullRequests.authorLogin, authorLogin), inArray(pullRequests.repoFullName, repoNames)))
    .limit(AUTHOR_OPEN_ITEM_LIST_LIMIT);
  if (prRows.length === AUTHOR_OPEN_ITEM_LIST_LIMIT) {
    await recordAuditEvent(env, {
      eventType: "agent.global_open_item_cap.author_items_truncated",
      actor: "gittensory",
      targetKey: `${authorLogin}@installation:${installationId}`,
      outcome: "error",
      detail: `author has >= ${AUTHOR_OPEN_ITEM_LIST_LIMIT} open pull requests across the install; the global contributor-cap check may undercount`,
    }).catch(() => undefined);
  }
  const issueRows = await db
    .select({ repoFullName: issues.repoFullName, number: issues.number })
    .from(issues)
    .where(and(eq(issues.state, "open"), loginMatches(issues.authorLogin, authorLogin), inArray(issues.repoFullName, repoNames)))
    .limit(AUTHOR_OPEN_ITEM_LIST_LIMIT);
  if (issueRows.length === AUTHOR_OPEN_ITEM_LIST_LIMIT) {
    await recordAuditEvent(env, {
      eventType: "agent.global_open_item_cap.author_items_truncated",
      actor: "gittensory",
      targetKey: `${authorLogin}@installation:${installationId}`,
      outcome: "error",
      detail: `author has >= ${AUTHOR_OPEN_ITEM_LIST_LIMIT} open issues across the install; the global contributor-cap check may undercount`,
    }).catch(() => undefined);
  }
  return [
    ...prRows.map((row) => ({ repoFullName: row.repoFullName, number: row.number, kind: "pull_request" as const })),
    ...issueRows.map((row) => ({ repoFullName: row.repoFullName, number: row.number, kind: "issue" as const })),
  ];
}

// Anti-farming (#anti-gaming-flood): how many PRs this author has SUBMITTED to this repo since `sinceIso` (ANY
// state — open/merged/closed), so a flood that merges fast is still caught. createdAt is the row-insert time
// (≈ when gittensory first saw the PR), a good proxy for submission time on live webhook-driven PRs.
export async function countRecentSubmissionsByAuthor(env: Env, fullName: string, authorLogin: string, sinceIso: string): Promise<number> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.authorLogin, authorLogin), gte(pullRequests.createdAt, sinceIso)));
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
    // Order by ascending PR number so the 100-row cap always retains the LOWEST-numbered open siblings. The
    // duplicate-winner adjudication elects the minimum open number as the winner, so an unordered LIMIT could
    // drop the true winner on a repo with >100 open PRs and mis-elect a higher-numbered sibling. (#audit-3.9)
    .orderBy(asc(pullRequests.number))
    .limit(100);
  return rows.map(toPullRequestRecordFromRow);
}

export async function listOtherOpenPullRequestsForAuthor(env: Env, fullName: string, number: number, authorLogin: string): Promise<PullRequestRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoFullName, fullName), eq(pullRequests.state, "open"), not(eq(pullRequests.number, number)), sql`lower(${pullRequests.authorLogin}) = lower(${authorLogin})`))
    // Keep the per-webhook live-verification and sibling-wake work budget fixed. The cap path only needs the
    // lowest-numbered siblings to preserve the "oldest PRs win" rule, and wake coalescing can discover later
    // over-cap siblings from their own deliveries without letting one delivery fan out across an unbounded set.
    .orderBy(asc(pullRequests.number))
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
    // Target the PRIMARY KEY, not the (repoFullName, pullNumber, path) unique index it's derived from. `id`
    // is a pure function of those same 3 fields, so under a single execution the two are always in lockstep —
    // but on the self-host Postgres backend, ON CONFLICT only protects against a race on the SPECIFIED arbiter
    // index; a genuinely concurrent second writer (e.g. two overlapping detail-sync passes for the same PR,
    // both racing past the "no existing row yet" check) can still hit a raw duplicate-key error on `id` because
    // that constraint isn't the one Postgres is arbitrating. Targeting `id` directly makes Postgres's upsert
    // machinery cover the constraint that's actually racing.
    .onConflictDoUpdate({
      target: pullRequestFiles.id,
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

export async function deletePullRequestFiles(env: Env, fullName: string, pullNumber: number): Promise<void> {
  const db = getDb(env.DB);
  await db.delete(pullRequestFiles).where(and(eq(pullRequestFiles.repoFullName, fullName), eq(pullRequestFiles.pullNumber, pullNumber)));
}

export async function listPullRequestFiles(env: Env, fullName: string, pullNumber: number): Promise<PullRequestFileRecord[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(pullRequestFiles)
    .where(and(eq(pullRequestFiles.repoFullName, fullName), eq(pullRequestFiles.pullNumber, pullNumber)));
  return rows.map(toPullRequestFileRecord);
}

export async function listRepoPullRequestFilePaths(
  env: Env,
  fullName: string,
  options: { pullNumbers?: number[] | undefined; limit?: number | undefined } = {},
): Promise<PullRequestFilePathRecord[]> {
  const db = getDb(env.DB);
  const pullNumbers = [...new Set(options.pullNumbers ?? [])].filter((number) => Number.isInteger(number) && number > 0);
  if (options.pullNumbers && pullNumbers.length === 0) return [];
  const where = pullNumbers.length > 0
    ? and(eq(pullRequestFiles.repoFullName, fullName), inArray(pullRequestFiles.pullNumber, pullNumbers))
    : eq(pullRequestFiles.repoFullName, fullName);
  return db
    .select({
      repoFullName: pullRequestFiles.repoFullName,
      pullNumber: pullRequestFiles.pullNumber,
      path: pullRequestFiles.path,
    })
    .from(pullRequestFiles)
    .where(where)
    .limit(Math.max(0, Math.min(options.limit ?? 500, 500)));
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

/** #1 self-host AI-review cache. Returns the cached AI review for this exact (repo, pull, head SHA) ONLY when the
 *  stored review mode matches — the LLM output changes only with the code (head SHA) or the review mode, so a re-run
 *  at the same SHA+mode reuses it instead of re-spending the call. A nullish head SHA (no commit to key on) is a miss.
 *
 *  #regate-churn: a stored row can be non-cacheable (`cacheable = 0` — a consensus defect / inconclusive / lock-
 *  contention outcome that must never be trusted as a durable, indefinitely-reusable verdict). By default such a
 *  row is a miss here, same as before this column existed. Pass `options.allowNonCacheable` (with a bounded
 *  `options.maxAgeMs`) to ALSO accept a non-cacheable row when it is recent enough — this lets a scheduled re-gate
 *  reuse the last known (even disputed) verdict for a bounded cooldown instead of re-spending an LLM call on every
 *  sweep tick, while a stale non-cacheable row still correctly falls through to a fresh call.
 *
 *  A PUBLISHED row (`published_at` set by markAiReviewPublished, once the review actually reached the PR) skips
 *  the `maxAgeMs` staleness check entirely: the cooldown exists to bound reuse BEFORE the first publish (e.g. two
 *  overlapping sweep passes racing the same head), not to force a periodic re-run of an already-surfaced verdict
 *  for the SAME head+fingerprint — see the migration's doc comment for the production incident this closes. */
export async function getCachedAiReview(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  headSha: string | null | undefined,
  mode: string,
  expectedInputFingerprint?: string | undefined,
  options?: { allowNonCacheable?: boolean; maxAgeMs?: number } | undefined,
): Promise<{ notes: string; reviewerCount: number; findings: AdvisoryFinding[]; metadata?: Record<string, unknown> | undefined } | null> {
  if (!headSha) return null;
  const row = await env.DB
    .prepare("SELECT notes, reviewer_count AS reviewerCount, ai_review_mode AS mode, findings_json AS findingsJson, metadata_json AS metadataJson, cacheable, published_at AS publishedAt, created_at AS createdAt FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
    .bind(repoFullName, pullNumber, headSha)
    .first<{ notes: string; reviewerCount: number; mode: string; findingsJson: string | null; metadataJson: string | null; cacheable: number; publishedAt: string | null; createdAt: string }>();
  if (!row || row.mode !== mode) return null;
  if (row.cacheable !== 1) {
    if (!options?.allowNonCacheable) return null;
    if (row.publishedAt == null) {
      const ageMs = Date.now() - Date.parse(row.createdAt);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > (options.maxAgeMs ?? 0)) return null;
    }
  }
  const metadata = parseJson<Record<string, unknown>>(row.metadataJson, {});
  if (
    expectedInputFingerprint !== undefined &&
    metadata.inputFingerprint !== expectedInputFingerprint
  )
    return null;
  return {
    notes: row.notes,
    reviewerCount: row.reviewerCount,
    findings: parseJson<AdvisoryFinding[]>(row.findingsJson, []),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** #regate-churn (maintainer-gated freeze): the most recently PUBLISHED AI review for this PR, regardless of
 *  which head SHA it was computed against. Used ONLY when the PR is currently held for manual review — a repeat
 *  contributor push must not buy a fresh, real AI call (or a chance to flip the published verdict via plain LLM
 *  non-determinism) while the PR sits in that state; only an explicit maintainer retrigger (which bypasses this
 *  entirely, see `webhook.forceAiReview`) may spend a new one. A nullish/never-published PR is a miss (the caller
 *  falls through to a normal fresh review — this only ever REUSES an already-surfaced result, never invents one). */
export async function getLatestPublishedAiReview(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  mode: string,
): Promise<{ notes: string; reviewerCount: number; findings: AdvisoryFinding[]; metadata?: Record<string, unknown> | undefined } | null> {
  const row = await env.DB
    .prepare(
      "SELECT notes, reviewer_count AS reviewerCount, findings_json AS findingsJson, metadata_json AS metadataJson FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND ai_review_mode = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    )
    .bind(repoFullName, pullNumber, mode)
    .first<{ notes: string; reviewerCount: number; findingsJson: string | null; metadataJson: string | null }>();
  if (!row) return null;
  const metadata = parseJson<Record<string, unknown>>(row.metadataJson, {});
  return {
    notes: row.notes,
    reviewerCount: row.reviewerCount,
    findings: parseJson<AdvisoryFinding[]>(row.findingsJson, []),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** Count distinct prior PR head SHAs that already received a published AI review — used by `review.auto_review.auto_pause_after_reviewed_commits`. (#2042) */
export async function countPublishedAiReviewHeads(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  currentHeadSha?: string | null | undefined,
): Promise<number> {
  const currentHeadClause = currentHeadSha ? " AND head_sha != ?" : "";
  const row = await env.DB
    .prepare(
      `SELECT COUNT(DISTINCT head_sha) AS cnt FROM ai_review_cache WHERE repo_full_name = ? AND pull_number = ? AND published_at IS NOT NULL${currentHeadClause}`,
    )
    .bind(
      ...(currentHeadSha ? [repoFullName, pullNumber, currentHeadSha] : [repoFullName, pullNumber]),
    )
    .first<{ cnt: number }>();
  /* v8 ignore next -- SQL aggregate count always returns one row; fallback protects D1 driver anomalies. */
  return row?.cnt ?? 0;
}

/** Upsert the AI review for (repo, pull, head SHA). A nullish head SHA is a no-op.
 *  #regate-churn: `review.cacheable === false` still PERSISTS the attempt (so a repeated scheduled sweep pass at
 *  the identical head+fingerprint can find it via getCachedAiReview's bounded allowNonCacheable lookup) but marks
 *  it non-durable — omitted or any other value defaults to cacheable (1), the pre-existing behavior.
 *  `published_at` is ALWAYS reset to NULL here: a write only ever happens for a genuinely fresh review (a cache
 *  hit never reaches this function), so any prior publish marker belongs to different, now-superseded content and
 *  must not leak onto it — markAiReviewPublished stamps it again once THIS content actually reaches the PR. */
export async function putCachedAiReview(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  headSha: string | null | undefined,
  mode: string,
  review: { notes: string; reviewerCount: number; findings?: AdvisoryFinding[]; metadata?: Record<string, unknown> | undefined; cacheable?: boolean | undefined },
): Promise<void> {
  if (!headSha) return;
  const createdAt = nowIso();
  const cacheable = review.cacheable === false ? 0 : 1;
  await env.DB
    .prepare(
      `INSERT INTO ai_review_cache (repo_full_name, pull_number, head_sha, ai_review_mode, notes, reviewer_count, findings_json, metadata_json, cacheable, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(repo_full_name, pull_number, head_sha) DO UPDATE SET
         ai_review_mode = excluded.ai_review_mode, notes = excluded.notes, reviewer_count = excluded.reviewer_count, findings_json = excluded.findings_json, metadata_json = excluded.metadata_json, cacheable = excluded.cacheable, published_at = NULL, created_at = excluded.created_at`,
    )
    .bind(repoFullName, pullNumber, headSha, mode, review.notes, review.reviewerCount, jsonString(review.findings ?? []), jsonString(review.metadata ?? {}), cacheable, createdAt)
    .run();
}

/** #regate-churn: stamp the AI review row for (repo, pull, head SHA) as PUBLISHED — called once the review's
 *  content has actually reached the PR (a comment/check-run publish completed), so a later lookup at this exact
 *  head+fingerprint (getCachedAiReview) treats it as indefinitely reusable regardless of the non-cacheable
 *  cooldown. `WHERE published_at IS NULL` keeps this idempotent and non-destructive: a later call for the same
 *  already-published row is a no-op rather than rewriting the timestamp. A nullish head SHA or a missing row
 *  (e.g. AI review was skipped/off this pass) is a harmless no-op — nothing to stamp. */
export async function markAiReviewPublished(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  headSha: string | null | undefined,
): Promise<void> {
  if (!headSha) return;
  await env.DB
    .prepare("UPDATE ai_review_cache SET published_at = ? WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ? AND published_at IS NULL")
    .bind(nowIso(), repoFullName, pullNumber, headSha)
    .run();
}

/** #ai-slop-cache: the stored AI slop advisory result for (repo, pull, head SHA), or null on a miss. Mirrors
 *  getCachedAiReview but deliberately simpler -- see ai_slop_cache's migration doc comment for why no
 *  cacheable/allowNonCacheable/maxAgeMs dimension is needed here: every stored row is unconditionally durable.
 *  A nullish head SHA is always a miss (nothing to key on). `expectedInputFingerprint` mismatching (e.g. the
 *  repo turned BYOK on/off, or changed its BYOK provider/model, since this row was written) is also a miss so a
 *  config change can't silently replay an opinion produced under a different reviewer. */
export async function getCachedAiSlopAdvisory(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  headSha: string | null | undefined,
  expectedInputFingerprint: string,
): Promise<{ status: string; band: string | null; finding: AdvisoryFinding | null; estimatedNeurons: number } | null> {
  if (!headSha) return null;
  const row = await env.DB
    .prepare("SELECT status, band, finding_json AS findingJson, estimated_neurons AS estimatedNeurons, input_fingerprint AS inputFingerprint FROM ai_slop_cache WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?")
    .bind(repoFullName, pullNumber, headSha)
    .first<{ status: string; band: string | null; findingJson: string | null; estimatedNeurons: number; inputFingerprint: string }>();
  if (!row || row.inputFingerprint !== expectedInputFingerprint) return null;
  return {
    status: row.status,
    band: row.band,
    finding: parseJson<AdvisoryFinding | null>(row.findingJson, null),
    estimatedNeurons: row.estimatedNeurons,
  };
}

/** #ai-slop-cache: upsert the AI slop advisory result for (repo, pull, head SHA). A nullish head SHA is a
 *  no-op (mirrors putCachedAiReview). Only call this for a result that actually spent the LLM call/attempts
 *  (status "ok") -- the caller is responsible for not caching a pre-call short-circuit (disabled/unavailable/
 *  quota_exceeded), since those return before any provider call and caching them would suppress a legitimate
 *  retry once quota resets without having saved anything. */
export async function putCachedAiSlopAdvisory(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  headSha: string | null | undefined,
  inputFingerprint: string,
  result: { status: string; band: string | null; finding: AdvisoryFinding | null; estimatedNeurons: number },
): Promise<void> {
  if (!headSha) return;
  await env.DB
    .prepare(
      `INSERT INTO ai_slop_cache (repo_full_name, pull_number, head_sha, input_fingerprint, status, band, finding_json, estimated_neurons, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_full_name, pull_number, head_sha) DO UPDATE SET
         input_fingerprint = excluded.input_fingerprint, status = excluded.status, band = excluded.band, finding_json = excluded.finding_json, estimated_neurons = excluded.estimated_neurons, created_at = excluded.created_at`,
    )
    .bind(repoFullName, pullNumber, headSha, inputFingerprint, result.status, result.band, jsonString(result.finding), result.estimatedNeurons, nowIso())
    .run();
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

const SIGNAL_SNAPSHOT_TARGET_KEY_SQL_BATCH = 90;

/** Bulk variant of `listSignalSnapshots` for callers that need the LATEST snapshot per target key across many
 *  keys in bounded round trips (#3202 review finding: a per-repo loop here made the daily repo-doc refresh sweep
 *  scale linearly in DB round trips with the installed-repo count). Keyed by the exact `targetKey` string, same
 *  casing convention as `listSignalSnapshots` -- callers that key by lowercased repo name must lowercase both
 *  the input and the returned map's keys themselves. */
export async function listLatestSignalSnapshotsForTargets(
  env: Env,
  signalType: string,
  targetKeys: readonly string[],
): Promise<Map<string, SignalSnapshotRecord>> {
  const result = new Map<string, SignalSnapshotRecord>();
  if (targetKeys.length === 0) return result;
  for (let i = 0; i < targetKeys.length; i += SIGNAL_SNAPSHOT_TARGET_KEY_SQL_BATCH) {
    const batch = targetKeys.slice(i, i + SIGNAL_SNAPSHOT_TARGET_KEY_SQL_BATCH);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `
        SELECT id, signal_type, target_key, repo_full_name, generated_at
        FROM (
          SELECT
            id, signal_type, target_key, repo_full_name, generated_at,
            row_number() OVER (PARTITION BY target_key ORDER BY generated_at DESC, id DESC) AS snapshot_rank
          FROM signal_snapshots
          WHERE signal_type = ? AND target_key IN (${placeholders})
        )
        WHERE snapshot_rank = 1
      `,
    )
      .bind(signalType, ...batch)
      .all<{ id: string; signal_type: string; target_key: string; repo_full_name: string | null; generated_at: string }>();
    for (const row of results) {
      result.set(row.target_key, {
        id: row.id,
        signalType: row.signal_type,
        targetKey: row.target_key,
        repoFullName: row.repo_full_name,
        payload: {},
        generatedAt: row.generated_at,
      });
    }
  }
  return result;
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
  // Null-safe, dialect-portable "head SHA unchanged" predicate. Preserve `overridden` ONLY when the head SHA
  // is unchanged: a maintainer override applies to the exact commit it was granted on, so a NEW commit
  // re-blocking must clear it — otherwise a one-time override would permanently disable the gate (and the
  // draft-dodge auto-close) for every future push to the PR. (#audit-3.14)
  //
  // Build the predicate from the (build-time) value rather than SQLite's `head_sha IS <value>` operator:
  // that operator is a hard parse error on the self-host Postgres backend (`head_sha IS $1`), and because the
  // sole caller records this as best-effort telemetry (`.catch`), it silently threw away every gate_outcomes
  // upsert there — killing the draft-dodge enforcement `getGateBlockOutcome` drives. Deriving the branch here
  // also keeps the value out of an untyped `$n IS NULL` position (which Postgres rejects). Both dialects treat
  // `col = ?` / `col IS NULL` identically, matching the original null-safe semantics on SQLite.
  const headShaUnchanged =
    values.headSha === null
      ? sql`${gateOutcomes.headSha} IS NULL`
      : sql`${gateOutcomes.headSha} = ${values.headSha}`;
  await getDb(env.DB)
    .insert(gateOutcomes)
    .values(values)
    .onConflictDoUpdate({
      target: [gateOutcomes.repoFullName, gateOutcomes.pullNumber],
      set: {
        headSha: values.headSha,
        blockerCodesJson: values.blockerCodesJson,
        updatedAt: nowIso(),
        overridden: sql`CASE WHEN ${headShaUnchanged} THEN ${gateOutcomes.overridden} ELSE 0 END`,
      },
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

// Retrieve the latest gate-block outcome for a PR. Returns undefined when no block exists.
// Used to detect draft-dodge attempts: a contributor converting an already-gate-rejected PR to draft
// is trying to keep the PR open past the verdict — this lets the caller enforce the verdict immediately.
export async function getGateBlockOutcome(
  env: Env,
  repoFullName: string,
  pullNumber: number,
): Promise<{ headSha: string | null; blockerCodes: string[]; overridden: boolean } | undefined> {
  const row = await getDb(env.DB)
    .select()
    .from(gateOutcomes)
    .where(and(eq(gateOutcomes.repoFullName, boundedString(repoFullName, 200)), eq(gateOutcomes.pullNumber, pullNumber)))
    .get();
  if (!row) return undefined;
  return { headSha: row.headSha, blockerCodes: parseJson<string[]>(row.blockerCodesJson, []), overridden: row.overridden };
}

// Review-evasion protection (#review-evasion-protection): idempotently mark that gittensory started a fresh
// review pass for repoFullName#pullNumber at headSha, BEFORE any cost-bearing AI-review work begins. A
// redelivery/retry for the SAME headSha while the row is still active is a true no-op (startedAt/deliveryId
// are preserved); a NEW headSha (a fresh commit) or a previously-terminalized row is overwritten with fresh
// values, since a new review pass genuinely restarts the active window.
export async function startActiveReviewTracking(
  env: Env,
  input: { repoFullName: string; pullNumber: number; headSha: string; authorLogin?: string | null | undefined; deliveryId: string },
): Promise<void> {
  const repoFullName = boundedString(input.repoFullName, 200);
  const values = {
    id: `active-review:${repoFullName}#${input.pullNumber}`,
    repoFullName,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    authorLogin: input.authorLogin ?? null,
    deliveryId: input.deliveryId,
    status: "active",
  };
  const sameActiveHead = sql`${activeReviewTracking.headSha} = ${values.headSha} AND ${activeReviewTracking.status} = 'active'`;
  await getDb(env.DB)
    .insert(activeReviewTracking)
    .values(values)
    .onConflictDoUpdate({
      target: [activeReviewTracking.repoFullName, activeReviewTracking.pullNumber],
      set: {
        headSha: values.headSha,
        authorLogin: values.authorLogin,
        deliveryId: sql`CASE WHEN ${sameActiveHead} THEN ${activeReviewTracking.deliveryId} ELSE ${values.deliveryId} END`,
        status: "active",
        startedAt: sql`CASE WHEN ${sameActiveHead} THEN ${activeReviewTracking.startedAt} ELSE ${nowIso()} END`,
        updatedAt: nowIso(),
      },
    });
}

// Review-evasion protection: whether gittensory has an ACTIVE review pass recorded for this EXACT
// repo/PR/headSha -- the read side the closed/converted_to_draft evasion guards check before treating a
// contributor's action as evasion. A row for a DIFFERENT headSha (or a terminalized row) does not count --
// the active window is scoped to the specific commit under review.
export async function hasActiveReviewForHeadSha(env: Env, repoFullName: string, pullNumber: number, headSha: string): Promise<boolean> {
  const row = await getDb(env.DB)
    .select({ headSha: activeReviewTracking.headSha, status: activeReviewTracking.status })
    .from(activeReviewTracking)
    .where(and(eq(activeReviewTracking.repoFullName, boundedString(repoFullName, 200)), eq(activeReviewTracking.pullNumber, pullNumber)))
    .get();
  return row !== undefined && row.status === "active" && row.headSha === headSha;
}

// Review-evasion protection: guarded status transition -- terminalize the active-review row for
// repoFullName#pullNumber ONLY if it is still 'active' (and, when given, still pinned to headSha), the same
// CAS shape as claimPendingAgentActionDecision, so a stale/already-terminalized row is never double-processed.
// Called when the review pass concludes (published), the PR closes/merges, the head moves, or evasion
// enforcement completes. Returns whether this call's write actually changed a row.
export async function terminalizeActiveReviewTracking(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  opts?: { onlyIfHeadSha?: string | undefined },
): Promise<boolean> {
  const conditions = [
    eq(activeReviewTracking.repoFullName, boundedString(repoFullName, 200)),
    eq(activeReviewTracking.pullNumber, pullNumber),
    eq(activeReviewTracking.status, "active"),
  ];
  if (opts?.onlyIfHeadSha !== undefined) conditions.push(eq(activeReviewTracking.headSha, opts.onlyIfHeadSha));
  const result = await getDb(env.DB)
    .update(activeReviewTracking)
    .set({ status: "terminal", updatedAt: nowIso() })
    .where(and(...conditions));
  /* v8 ignore next -- D1 update metadata normally includes changes; the ?? 0 fallback protects driver anomalies. */
  return Number(result.meta.changes ?? 0) > 0;
}

// Review memory (#2178, data-model slice of #1964). Hard per-repo cap on stored suppression signals — mirrors
// rag.ts's MAX_CHUNKS_PER_REPO discipline (bound a repo-controlled, unboundedly-growable store). A repo that
// keeps dismissing NEW finding shapes evicts its OLDEST suppression first rather than growing forever.
export const MAX_REVIEW_SUPPRESSIONS_PER_REPO = 500;

function toReviewSuppressionRecord(row: typeof reviewSuppression.$inferSelect): ReviewSuppressionRecord {
  return {
    id: row.id,
    repoFullName: row.repoFullName,
    category: row.category,
    pathGlob: row.pathGlob,
    patternHash: row.patternHash,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/** Idempotently record a review-memory suppression signal: a maintainer dismissed a finding matching
 *  (repoFullName, category, pathGlob, patternHash) as a false positive. Re-recording the SAME key is a true
 *  no-op upsert (bumps createdAt/createdBy only) — mirrors startActiveReviewTracking's upsert shape — so
 *  repeatedly dismissing the same recurring finding never creates duplicate rows. After the write, evicts the
 *  OLDEST rows for this repo beyond MAX_REVIEW_SUPPRESSIONS_PER_REPO (fail-safe: eviction errors are swallowed
 *  — a failed prune never blocks the recording write that already succeeded). */
export async function recordReviewSuppression(
  env: Env,
  input: { repoFullName: string; category: string; pathGlob?: string | null | undefined; patternHash: string; createdBy?: string | null | undefined },
): Promise<ReviewSuppressionRecord> {
  const repoFullName = boundedString(input.repoFullName, 200);
  const category = boundedString(input.category, 200);
  const pathGlob = boundedString(input.pathGlob ?? "", 500);
  const patternHash = boundedString(input.patternHash, 128);
  const db = getDb(env.DB);
  const values = {
    id: crypto.randomUUID(),
    repoFullName,
    category,
    pathGlob,
    patternHash,
    createdBy: input.createdBy ?? null,
  };
  await db
    .insert(reviewSuppression)
    .values(values)
    .onConflictDoUpdate({
      target: [reviewSuppression.repoFullName, reviewSuppression.category, reviewSuppression.pathGlob, reviewSuppression.patternHash],
      set: { createdAt: nowIso(), createdBy: values.createdBy },
    });
  const row = await db
    .select()
    .from(reviewSuppression)
    .where(
      and(
        eq(reviewSuppression.repoFullName, repoFullName),
        eq(reviewSuppression.category, category),
        eq(reviewSuppression.pathGlob, pathGlob),
        eq(reviewSuppression.patternHash, patternHash),
      ),
    )
    .get();
  await pruneReviewSuppressionsOverCap(env, repoFullName).catch((error) => {
    console.warn("Failed to prune over-cap review suppressions", { repoFullName, error: errorMessage(error) });
  });
  /* v8 ignore next -- the row was just inserted/updated in this same call; a missing read-back would mean D1
   *  itself failed silently, not a reachable application branch. */
  return row ? toReviewSuppressionRecord(row) : { ...values, createdAt: nowIso() };
}

/** Evict the OLDEST review_suppression rows for repoFullName once the per-repo count exceeds
 *  MAX_REVIEW_SUPPRESSIONS_PER_REPO — a repo that keeps dismissing new finding shapes never grows this table
 *  unbounded. Internal to recordReviewSuppression; not exported. */
async function pruneReviewSuppressionsOverCap(env: Env, repoFullName: string): Promise<void> {
  const db = getDb(env.DB);
  // Fetch every row for the repo (bounded: never more than MAX+1, since this runs after each insert) and slice
  // the overflow off in JS, rather than a SQL OFFSET -- Drizzle's D1 dialect drops a `.limit(-1)` "unbounded
  // limit" hint from the emitted SQL entirely, leaving a bare `OFFSET` clause that this driver rejects outright.
  const rows = await db
    .select({ id: reviewSuppression.id })
    .from(reviewSuppression)
    .where(eq(reviewSuppression.repoFullName, repoFullName))
    .orderBy(desc(reviewSuppression.createdAt));
  const overflow = rows.slice(MAX_REVIEW_SUPPRESSIONS_PER_REPO);
  if (overflow.length === 0) return;
  await db.delete(reviewSuppression).where(
    and(
      eq(reviewSuppression.repoFullName, repoFullName),
      inArray(
        reviewSuppression.id,
        overflow.map((row) => row.id),
      ),
    ),
  );
}

/** List every stored suppression signal for repoFullName, newest first. Bounded by `limit` (default 500,
 *  matching MAX_REVIEW_SUPPRESSIONS_PER_REPO) so a caller can never accidentally request an unbounded scan. */
export async function listReviewSuppressions(env: Env, repoFullName: string, limit = MAX_REVIEW_SUPPRESSIONS_PER_REPO): Promise<ReviewSuppressionRecord[]> {
  const rows = await getDb(env.DB)
    .select()
    .from(reviewSuppression)
    .where(eq(reviewSuppression.repoFullName, boundedString(repoFullName, 200)))
    .orderBy(desc(reviewSuppression.createdAt))
    .limit(clampInteger(limit, 1, MAX_REVIEW_SUPPRESSIONS_PER_REPO));
  return rows.map(toReviewSuppressionRecord);
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

/** Atomically transition a pending approval-queue row to a decided status: the `WHERE status='pending'` only
 *  matches (and updates) a row still awaiting a decision, so of two concurrent callers deciding the SAME row,
 *  exactly one update actually changes a row. Returns whether THIS call was the one that won the claim -- a
 *  `false` return means another decision already landed first, and the caller must not execute the action. */
export async function claimPendingAgentActionDecision(env: Env, id: string, update: { status: AgentPendingActionStatus; decidedBy: string }): Promise<boolean> {
  const result = await getDb(env.DB)
    .update(agentPendingActions)
    .set({ status: update.status, decidedBy: update.decidedBy, decidedAt: nowIso(), updatedAt: nowIso() })
    .where(and(eq(agentPendingActions.id, id), eq(agentPendingActions.status, "pending")));
  /* v8 ignore next -- D1 update metadata normally includes changes; the ?? 0 fallback protects driver anomalies. */
  return Number(result.meta.changes ?? 0) === 1;
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
      authMode: health.authMode,
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
        authMode: health.authMode,
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
    // "superseded": a coalescable delivery (e.g. a pr-refresh) whose queue row was overwritten by a later
    // redelivery sharing the same job_key before either was claimed — written directly by the self-host queue
    // backends (pg-queue.ts / sqlite-queue.ts) at coalesce time, not through this function, but included here so
    // the full set of terminal statuses this column can hold is documented in one place (#audit-webhook-supersede-trace).
    status: "queued" | "processed" | "error" | "superseded";
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
        payloadHash: args.payloadHash,
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
    appId: row.appId,
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
    admissionKey: row.admissionKey,
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
    headSha: row.headSha,
    filesSyncedAt: row.filesSyncedAt,
    reviewsSyncedAt: row.reviewsSyncedAt,
    reviewsInvalidatedAt: row.reviewsInvalidatedAt,
    checksSyncedAt: row.checksSyncedAt,
    lastSyncedAt: row.lastSyncedAt,
    errorSummary: row.errorSummary,
    prMergeableState: row.prMergeableState,
    prState: row.prState,
    prStateFetchedAt: row.prStateFetchedAt,
    ciHeadSha: row.ciHeadSha,
    ciState: parseCiState(row.ciState),
    ciHasPending: row.ciHasPending,
    ciHasVisiblePending: row.ciHasVisiblePending,
    ciHasMissingRequiredContext: row.ciHasMissingRequiredContext,
    ciFailingDetailsJson: row.ciFailingDetailsJson,
    ciNonRequiredFailingDetailsJson: row.ciNonRequiredFailingDetailsJson,
    ciCompletenessWarning: row.ciCompletenessWarning,
    ciRequiredContextsKey: row.ciRequiredContextsKey,
    ciStateFetchedAt: row.ciStateFetchedAt,
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
    // GitHub's true PR-creation time (#dup-winner true-creation-time). Already persisted into payloadJson via
    // compactGitHubPayload below and re-surfaced correctly by toPullRequestRecordFromRow on any later read — this
    // populates it on the IMMEDIATE upsert return too, so a caller acting on this same call's result (not a
    // subsequent DB round-trip) sees the same value instead of `undefined`.
    createdAt: pr.created_at,
    labels: (pr.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
    linkedIssues: extractLinkedIssueNumbers(pr.body ?? "", repoFullName),
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
    linkedIssueClaimedAt: row.linkedIssueClaimedAt,
    labels: parseJson<string[]>(row.labelsJson, []),
    linkedIssues: parseJson<number[]>(row.linkedIssuesJson, []),
    slopRisk: row.slopRisk,
    slopBand: row.slopBand,
    mergeAttemptCount: row.mergeAttemptCount,
    mergeBlockedSha: row.mergeBlockedSha,
    mergeBlockedReason: row.mergeBlockedReason,
    approvedHeadSha: row.approvedHeadSha,
    // Read straight from the row, NEVER the GitHub payload — this is a gittensory-internal sweep marker.
    lastRegatedAt: row.lastRegatedAt,
    lastPublishedSurfaceSha: row.lastPublishedSurfaceSha,
    linkedIssueHardRuleViolatedAt: row.linkedIssueHardRuleViolatedAt,
    linkedIssueHardRuleViolationReason: row.linkedIssueHardRuleViolationReason,
  };
}

/**
 * Persist or clear the latest deterministic slop assessment on an existing cached PR row. Kept separate
 * from the GitHub-sync upsert (whose SET clause never touches these columns) so a later sync cannot
 * clobber the score. A no-op when the PR row does not exist yet — the sync upsert creates it first.
 */
export async function updatePullRequestSlopAssessment(
  env: Env,
  repoFullName: string,
  pullNumber: number,
  assessment: { slopRisk: number | null; slopBand: string | null },
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
    authMode: parseInstallationHealthAuthMode(row.authMode),
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
    const next = source[offset + match.length] ?? "";
    const hasLeftBoundary = isProductUsageActorTokenBoundary(previous) || isProductUsageCamelBoundaryBefore(previous, match);
    const hasRightBoundary = isProductUsageActorTokenBoundary(next) || isProductUsageCamelBoundaryAfter(next, match);
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

function isProductUsageCamelBoundaryAfter(next: string, match: string): boolean {
  // Mirror of isProductUsageCamelBoundaryBefore: a camelCase boundary after the match requires the match
  // to END in a lowercase/digit and the next char to be uppercase (a real `bob`→`Key` hump). Without the
  // `match` end check, an uppercase→uppercase transition inside an all-caps word (e.g. `bob` matched in
  // `BOBCAT`) is mistaken for a boundary and the surrounding word is wrongly redacted.
  return /[A-Z]/.test(next) && /[a-z0-9]$/.test(match);
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
    case "reviewers":
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
// Compose from the canonical scrubber in redaction.ts so this surface cannot drift from the boundary;
// it already covered /root/ and /var/, and now unifies the Windows form (also accepts `C:/Users/`).
const PRODUCT_USAGE_LOCAL_PATH = PUBLIC_LOCAL_PATH_SCRUB_PATTERN;
const PRODUCT_USAGE_TOKEN_VALUE = /\b(?:ghp_|github_pat_|gts_|orbenr_|orbsec_|glpat-|sk-)[A-Za-z0-9_=-]{8,}/g;
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

function parseRegateSweepOrderMode(value: string): RepositorySettings["regateSweepOrderMode"] {
  return value === "oldest-first" ? "oldest-first" : "staleness";
}

function parseReviewCheckMode(value: string): RepositorySettings["reviewCheckMode"] {
  return value === "required" || value === "visible" ? value : "disabled";
}

function parseProjectMilestoneMatchMode(value: string): RepositorySettings["autoProjectMilestoneMatch"] {
  return value === "suggest" || value === "auto" ? value : "off";
}

function parseProjectMilestoneMatchBackend(value: string): RepositorySettings["autoProjectMilestoneMatchBackend"] {
  return value === "linear" ? "linear" : "github";
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

// A discrete positive count (not a 0-100 score), so unlike normalizeQualityGateMinScore it is not rounded —
// a fractional or non-positive value is malformed (there's no such thing as "allow 2.5 open PRs") and is
// dropped to null. Shared by callers with entirely different upper bounds (or none at all) — see
// normalizeOpenItemCap for the one that clamps to the live-verification sample budget, and
// normalizeModerationDecayDays for one with its own, unrelated ceiling.
function normalizePositiveIntOrNull(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

// A per-contributor open-item cap (#2270): valid counts are clamped to the fixed live-verification sample
// budget so the cap cannot exceed the rows enforcement sees. Only for caps that are actually enforced against
// that sample (contributorOpenPrCap/contributorOpenIssueCap) — an unrelated positive-int setting that happens
// to reuse the same validation shape must call normalizePositiveIntOrNull directly, not this function, or it
// silently inherits a 100-row ceiling that has nothing to do with its own semantics (gate-flagged: this is
// exactly how normalizeModerationDecayDays's unrelated 3650-day ceiling got clamped down to 100 by mistake).
function normalizeOpenItemCap(value: number | null | undefined): number | null {
  const parsed = normalizePositiveIntOrNull(value);
  return parsed === null ? null : Math.min(parsed, MAX_CONTRIBUTOR_OPEN_ITEM_CAP);
}

function parsePublicSurface(value: string): RepositorySettings["publicSurface"] {
  if (value === "comment_only" || value === "label_only" || value === "off") return value;
  return "comment_and_label";
}

function parseCommandAuthorizationPolicy(value: string): RepositorySettings["commandAuthorization"] {
  return normalizeCommandAuthorizationPolicy(parseJson<unknown>(value, null)).policy;
}

function parseTypeLabelSet(value: string): RepositorySettings["typeLabels"] {
  return normalizeTypeLabelSet(parseJson<unknown>(value, null), []);
}

function parseLinkedIssueLabelPropagationConfig(value: string): RepositorySettings["linkedIssueLabelPropagation"] {
  return normalizeLinkedIssueLabelPropagationConfig(parseJson<unknown>(value, null), []);
}

function parseContributorBlacklist(value: string): RepositorySettings["contributorBlacklist"] {
  return normalizeContributorBlacklist(parseJson<unknown>(value, null)).entries;
}

function parseAutoCloseExemptLogins(value: string): string[] {
  return normalizeAutoCloseExemptLogins(parseJson<unknown>(value, null)).logins;
}

function normalizeReviewNagPolicy(value: string | null | undefined): "off" | "hold" | "close" {
  return value === "hold" || value === "close" ? value : "off";
}

// Review-evasion protection (#review-evasion-protection): binary off|close, mirroring reviewNagPolicy's
// shape minus the "hold" tier (an evasion attempt is always re-closed as the App when enabled, never merely
// held -- there is no partial-enforcement mode).
function normalizeReviewEvasionProtection(value: string | null | undefined): "off" | "close" {
  return value === "close" ? "close" : "off";
}

function normalizeMergeTrainMode(value: string | null | undefined): "off" | "audit" | "enforce" {
  return value === "audit" || value === "enforce" ? value : "off";
}

// Config-driven before/after screenshot-table gate (#2006): the row stores whenLabels/whenPaths as JSON string
// arrays (mirroring contributorBlacklistJson's shape) across dedicated flat columns rather than one combined
// JSON blob, so a self-hoster can inspect/edit a single field (e.g. just the action) without round-tripping the
// whole object.
function parseScreenshotTableGateRow(row: typeof repositorySettings.$inferSelect): ScreenshotTableGateConfig {
  return {
    enabled: row.screenshotTableGateEnabled,
    whenLabels: parseJsonStringArray(row.screenshotTableGateWhenLabelsJson),
    whenPaths: parseJsonStringArray(row.screenshotTableGateWhenPathsJson),
    action: isScreenshotTableGateAction(row.screenshotTableGateAction) ? row.screenshotTableGateAction : DEFAULT_SCREENSHOT_TABLE_GATE.action,
    ...(row.screenshotTableGateMessage ? { message: row.screenshotTableGateMessage } : {}),
  };
}

// Generic "JSON array of non-empty strings" parse for a column with no additional per-item validation (labels
// and path globs have no fixed shape, unlike a GitHub login) -- any malformed/non-string entry is silently
// dropped, never throws, matching every other settings parse in this file.
function parseJsonStringArray(value: string): string[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeCommandRateLimitPolicy(value: string | null | undefined): "off" | "hold" {
  return value === "hold" ? value : "off";
}

function normalizeModerationGateMode(value: string | null | undefined): "inherit" | "off" | "enabled" {
  return value === "off" || value === "enabled" ? value : "inherit";
}

// NULL means "inherit the global rule set" (undefined), distinct from a normalized-but-empty list -- a repo
// that explicitly configured an empty moderationRules override (opting every rule out) must stay empty, not
// be coerced back to "inherit". Mirrors parseContributorBlacklist/parseAutoCloseExemptLogins's JSON-parse
// shape, except the column itself (not just malformed JSON) can be genuinely absent.
function parseModerationRulesColumn(value: string | null | undefined): RepositorySettings["moderationRules"] {
  if (value === null || value === undefined) return undefined;
  return normalizeModerationRules(parseJson<unknown>(value, null)).rules;
}

// A review-nag threshold/window is a discrete positive count, not a score — reuses the same non-clamping,
// non-rounding shape as contributorOpenPrCap's normalizeOpenItemCap (#2270): an invalid value (fractional,
// non-positive, non-finite) falls back to the given default rather than being silently coerced.
function normalizePositiveIntWithDefault(value: number | null | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function normalizeReviewNagCooldownDays(value: number | null | undefined, fallback: number): number {
  const normalized = normalizePositiveIntWithDefault(value, fallback);
  return Math.min(normalized, MAX_REVIEW_NAG_COOLDOWN_DAYS);
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

function parseInstallationHealthAuthMode(value: string): InstallationHealthRecord["authMode"] {
  return value === "broker" ? "broker" : "local";
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

// Unlike parsePullRequestDetailSyncStatus above, `ci_state` has no sensible non-null default -- absent/invalid
// genuinely means "never cached", so this returns null rather than coercing to a fake status.
function parseCiState(value: string | null): PullRequestDetailSyncStateRecord["ciState"] {
  if (value === "passed" || value === "failed" || value === "pending" || value === "unverified") return value;
  return null;
}

function loginMatches(column: unknown, login: string) {
  return sql`lower(${column}) = ${login.toLowerCase()}`;
}

export const MAX_LINKED_ISSUE_NUMBERS = 50;

export type LinkedIssueExtractionResult = {
  numbers: number[];
  overflow: boolean;
};

export function extractLinkedIssueNumbersWithOverflow(text: string, repoFullName: string, limit = MAX_LINKED_ISSUE_NUMBERS): LinkedIssueExtractionResult {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  const target = repoFullName.toLowerCase();

  // Strip inline code spans before scanning: GitHub's own native closing-keyword linker does not treat
  // backtick-wrapped text as a real "Closes #N" directive, and this repo's own PR template checklist item
  // contains the literal example text "(e.g. `Closes #123`)" -- without this, every PR that keeps the
  // unmodified template checklist would spuriously link to issue #123.
  const withoutCodeSpans = text.replace(/`[^`\n]*`/g, " ");

  const linkedIssues: number[] = [];
  const seen = new Set<number>();
  // Matches both GitHub's bare `KEYWORD #N` and fully-qualified `KEYWORD owner/repo#N` closing syntax (#3862) --
  // the qualified form only counts when owner/repo case-insensitively matches THIS repo; a reference to a
  // different repo closes an issue there, not here, and must not spoof a same-repo linked-issue match.
  for (const match of withoutCodeSpans.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+)#|#)(\d+)\b/gi)) {
    const owner = match[1];
    if (owner && owner.toLowerCase() !== target) continue;
    const value = Number(match[2]);
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    if (linkedIssues.length >= normalizedLimit) return { numbers: linkedIssues, overflow: true };
    linkedIssues.push(value);
  }
  return { numbers: linkedIssues, overflow: false };
}

export function extractLinkedIssueNumbers(text: string, repoFullName: string, limit = MAX_LINKED_ISSUE_NUMBERS): number[] {
  return extractLinkedIssueNumbersWithOverflow(text, repoFullName, limit).numbers;
}

function extractLinkedPrNumbers(text: string): number[] {
  const matches = [...text.matchAll(/\b(?:PR|pull request)\s+#(\d+)\b/gi)];
  return [...new Set(matches.map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
}
