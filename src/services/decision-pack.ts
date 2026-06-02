import { loadRepoFocusManifests } from "../signals/focus-manifest-loader";
import type { FocusManifest, FocusManifestIssueDiscoveryPolicy, FocusManifestLinkedIssuePolicy, FocusManifestSource } from "../signals/focus-manifest";
import { isFocusManifestPublicSafe } from "../signals/focus-manifest";
import {
  hasRecentAuditEvent,
  listAllIssues,
  listAllPullRequests,
  listBounties,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listLatestRepoGithubTotalsSnapshots,
  listRepoPullRequestFiles,
  listRepositories,
  listRepoSyncSegments,
  listRepoSyncStates,
  listSignalSnapshots,
  persistSignalSnapshot,
  recordAuditEvent,
  getAgentRecommendationOutcomeSummary,
  upsertContributorEvidence,
  upsertContributorScoringProfile,
} from "../db/repositories";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { fetchPublicContributorProfile } from "../github/public";
import { getOrCreateScoringModelSnapshot } from "../scoring/model";
import {
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildLaneAdvice,
  buildRoleContext,
  type ContributorOpportunity,
  type ContributorOutcomeHistory,
  type ContributorProfile,
  type IssueQualityReport,
  type OutcomePattern,
  type RepoOutcomePatterns,
  type RoleContext,
} from "../signals/engine";
import { buildSignalFidelity } from "../signals/data-quality";
import { buildContributorOpenPrMonitor, type ContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import {
  buildContributorEvidenceGraph,
  CONTRIBUTOR_EVIDENCE_GRAPH_SIGNAL,
  evidenceGraphTouchedRepoFullNames,
  type ContributorEvidenceGraph,
} from "./contributor-evidence-graph";
import { loadIssueQualityReportMap } from "./issue-quality";
import { loadRepoOutcomePatternsMap } from "./repo-outcome-patterns";
import { evaluateRecommendationOutcomes } from "./recommendation-outcomes";
import type {
  BountyRecord,
  AgentRecommendationOutcomeRepoSummary,
  AgentRecommendationOutcomeSummary,
  ContributorRepoStatRecord,
  IssueRecord,
  JsonValue,
  PullRequestFileRecord,
  PullRequestRecord,
  RepositoryRecord,
  RepoGithubTotalsSnapshotRecord,
  RepoSyncSegmentRecord,
  RepoSyncStateRecord,
  ScoringModelSnapshotRecord,
  SignalSnapshotRecord,
} from "../types";
import { nowIso } from "../utils/json";

export const CONTRIBUTOR_DECISION_PACK_SIGNAL = "contributor-decision-pack";
export const DECISION_PACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DECISION_PACK_REBUILD_DEBOUNCE_MS = 15 * 1000;
const pendingDecisionPackRebuilds = new Map<string, Promise<boolean>>();

export type DecisionRecommendation = "pursue" | "cleanup_first" | "maintainer_lane" | "avoid_for_now" | "watch";
export type DecisionActionKind = "cleanup_existing_prs" | "land_existing_prs" | "open_new_direct_pr" | "file_issue_discovery" | "maintainer_lane_improve_repo" | "maintainer_cut_readiness";
export type DecisionPackFreshness = "fresh" | "stale" | "rebuilding" | "missing";
export type ActionPortfolioBucketName = "cleanup" | "wait" | "direct_pr" | "issue_discovery" | "avoid" | "maintainer_lane";

export type ContributorDecisionPack = {
  status: "ready";
  source: "computed" | "snapshot";
  login: string;
  generatedAt: string;
  snapshotAgeSeconds?: number | undefined;
  stale: boolean;
  freshness: DecisionPackFreshness;
  rebuildEnqueued: boolean;
  scoringModelSnapshotId: string;
  profile: {
    login: string;
    github: ContributorProfile["github"];
    source: ContributorProfile["source"];
    officialStats: Omit<NonNullable<ContributorProfile["gittensor"]>, "hotkey"> | null;
    registeredRepoActivity: ContributorProfile["registeredRepoActivity"];
    trustSignals: ContributorProfile["trustSignals"];
  };
  outcomeHistory: ContributorOutcomeHistory;
  roleContexts: RoleContext[];
  opportunities: ContributorOpportunity[];
  repoDecisions: RepoDecision[];
  topActions: DecisionAction[];
  actionPortfolio: ActionPortfolio;
  cleanupFirst: RepoDecision[];
  pursueRepos: RepoDecision[];
  avoidRepos: RepoDecision[];
  maintainerLaneRepos: RepoDecision[];
  scoreBlockers: ScoreBlocker[];
  recommendationOutcomeFeedback: AgentRecommendationOutcomeSummary;
  evidenceGraph?: ContributorEvidenceGraph | undefined;
  dataQuality: {
    signalFidelity: ReturnType<typeof buildSignalFidelity>;
  };
  summary: string;
  nextActions: string[];
  openPrMonitor?: ContributorOpenPrMonitor | undefined;
};

export type DecisionPackRefreshNeeded = {
  status: "needs_snapshot_refresh";
  login: string;
  generatedAt: string;
  reason: "missing_snapshot";
  freshness: Extract<DecisionPackFreshness, "missing">;
  rebuildEnqueued: boolean;
};

export type ContributorDecisionPackServing =
  | { kind: "ready"; pack: ContributorDecisionPack }
  | { kind: "needs_refresh"; refresh: DecisionPackRefreshNeeded };

export type LanguageMatch = {
  language: string | null;
  match: boolean;
};

export type RepoDecision = {
  repoFullName: string;
  recommendation: DecisionRecommendation;
  priorityScore: number;
  lane: ReturnType<typeof buildLaneAdvice>;
  roleContext: RoleContext;
  outcome?: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  queue: {
    openIssues: number;
    openPullRequests: number;
    mergedPullRequests: number;
    closedUnmergedPullRequests: number;
  };
  rewardUpside: {
    emissionShare: number;
    directPrShare: number;
    issueDiscoveryShare: number;
    maintainerCut: number;
  };
  languageMatch: LanguageMatch;
  labelFit: string[];
  scoreBlockers: ScoreBlocker[];
  repoOutcomePatterns?: RepoOutcomeSummary | undefined;
  recommendationOutcomeFeedback?: RepoRecommendationOutcomeFeedback | undefined;
  riskReasons: string[];
  whyThisHelps: string[];
  nextActions: string[];
  publicNextActions: string[];
  issueQuality?: IssueQualitySummary | undefined;
  manifestSummary?: RepoDecisionManifestSummary | undefined;
};

export type RepoDecisionManifestSummary = {
  present: boolean;
  source: FocusManifestSource;
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
  issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
  wantedPathCount: number;
  blockedPathCount: number;
  preferredLabels: string[];
  publicNotes: string[];
};

export type RepoOutcomeSummary = {
  summary: string;
  outsideContributorMergeRate: number;
  sampleSize: number;
  successPatterns: OutcomePattern[];
  riskPatterns: OutcomePattern[];
};

export type RepoRecommendationOutcomeFeedback = {
  signal: AgentRecommendationOutcomeRepoSummary["signal"];
  total: number;
  positive: number;
  negative: number;
  merged: number;
  closed: number;
  stale: number;
  ignored: number;
  improved: number;
  maintainerLaneTotal: number;
  latestOutcomeAt?: string | null | undefined;
};

export type DecisionAction = {
  actionKind: DecisionActionKind;
  repoFullName: string;
  priorityScore: number;
  recommendation: DecisionRecommendation;
  whyThisHelps: string[];
  nextActions: string[];
  publicNextActions: string[];
};

export type ActionPortfolioScenarioProjection = {
  source: ContributorOpenPrMonitor["pendingScenarios"][number]["detection"]["source"];
  pendingMergedPrCount: number;
  pendingClosedPrCount: number;
  approvedPrCount: number;
  expectedOpenPrCountAfterMerge?: number | undefined;
  notes: string[];
};

export type ActionPortfolioItem = {
  bucket: ActionPortfolioBucketName;
  repoFullName: string;
  actionKind?: DecisionActionKind | undefined;
  priorityScore: number;
  recommendation: DecisionRecommendation;
  status: "recommended" | "blocked" | "watch";
  whyNow: string[];
  scoreabilityImpact: string;
  riskImpact: string;
  maintainerImpact: string;
  blockedBy: string[];
  rerunWhen: string;
  publicSafeSummary: string;
  nextActions: string[];
  publicNextActions: string[];
  source: "decision_pack";
  scenarioProjection?: ActionPortfolioScenarioProjection | undefined;
};

export type ActionPortfolioBucket = {
  bucket: ActionPortfolioBucketName;
  label: string;
  summary: string;
  actions: ActionPortfolioItem[];
};

export type ActionPortfolio = {
  generatedAt: string;
  bucketOrder: ActionPortfolioBucketName[];
  buckets: ActionPortfolioBucket[];
  topActions: ActionPortfolioItem[];
  counts: Record<ActionPortfolioBucketName, number>;
  summary: string;
};

export type ScoreBlocker = {
  code: "open_pr_pressure" | "maintainer_lane" | "inactive_or_unknown_lane" | "closed_pr_credibility" | "issue_discovery_only" | "low_credibility";
  repoFullName?: string | undefined;
  severity: "info" | "warning" | "critical";
  detail: string;
};

export type IssueQualitySummary = {
  readyCount: number;
  needsProofCount: number;
  holdCount: number;
  doNotUseCount: number;
  topReadyIssues: Array<{ number: number; title: string; score: number }>;
};

export async function loadContributorDecisionPack(env: Env, login: string): Promise<ContributorDecisionPack | null> {
  const latest = (await listSignalSnapshots(env, CONTRIBUTOR_DECISION_PACK_SIGNAL, login))[0];
  if (!latest) return null;
  return withSnapshotMetadata(latest);
}

export async function loadContributorDecisionPackForServing(
  env: Env,
  login: string,
  options: { maxAgeMs?: number; enqueueRebuild?: boolean } = {},
): Promise<ContributorDecisionPackServing> {
  const maxAgeMs = options.maxAgeMs ?? DECISION_PACK_MAX_AGE_MS;
  const enqueueRebuild = options.enqueueRebuild ?? true;
  const cached = await loadContributorDecisionPack(env, login);
  if (!cached) {
    const rebuildEnqueued = enqueueRebuild ? await tryEnqueueDecisionPackRebuild(env, login) : false;
    return {
      kind: "needs_refresh",
      refresh: {
        status: "needs_snapshot_refresh",
        login,
        generatedAt: nowIso(),
        reason: "missing_snapshot",
        freshness: "missing",
        rebuildEnqueued,
      },
    };
  }
  const stale = cached.stale || snapshotAgeMs(cached.generatedAt) > maxAgeMs;
  if (!stale) {
    return { kind: "ready", pack: { ...cached, freshness: "fresh", rebuildEnqueued: false } };
  }
  const rebuildEnqueued = enqueueRebuild ? await tryEnqueueDecisionPackRebuild(env, login) : false;
  return {
    kind: "ready",
    pack: {
      ...cached,
      stale: true,
      freshness: rebuildEnqueued ? "rebuilding" : "stale",
      rebuildEnqueued,
    },
  };
}

async function tryEnqueueDecisionPackRebuild(env: Env, login: string): Promise<boolean> {
  const pending = pendingDecisionPackRebuilds.get(login);
  if (pending) return pending;
  const sinceIso = new Date(Date.now() - DECISION_PACK_REBUILD_DEBOUNCE_MS).toISOString();
  if (await hasRecentAuditEvent(env, login, "decision_pack.rebuild_enqueued", sinceIso)) {
    return true;
  }
  const existing = pendingDecisionPackRebuilds.get(login);
  if (existing) return existing;
  const rebuild = enqueueDecisionPackRebuild(env, login).finally(() => {
    pendingDecisionPackRebuilds.delete(login);
  });
  pendingDecisionPackRebuilds.set(login, rebuild);
  return rebuild;
}

async function enqueueDecisionPackRebuild(env: Env, login: string): Promise<boolean> {
  try {
    await env.JOBS.send({ type: "build-contributor-decision-packs", requestedBy: "api", login });
    await recordAuditEvent(env, {
      eventType: "decision_pack.rebuild_enqueued",
      actor: login,
      outcome: "queued",
    });
    return true;
  } catch (error) {
    await recordAuditEvent(env, {
      eventType: "decision_pack.rebuild_enqueue_failed",
      actor: login,
      outcome: "error",
      detail: String(error),
    });
    return false;
  }
}

/**
 * Login-independent datasets used to build a decision pack. These are full-table reads, so the
 * batch job loads them ONCE via {@link loadDecisionPackSharedInputs} and reuses them across logins
 * instead of re-scanning per contributor.
 */
export type DecisionPackSharedInputs = {
  repositories: RepositoryRecord[];
  syncStates: RepoSyncStateRecord[];
  syncSegments: RepoSyncSegmentRecord[];
  totals: RepoGithubTotalsSnapshotRecord[];
  allIssues: IssueRecord[];
  allPullRequests: PullRequestRecord[];
  bounties: BountyRecord[];
  scoringSnapshot: ScoringModelSnapshotRecord;
};

export async function loadDecisionPackSharedInputs(env: Env): Promise<DecisionPackSharedInputs> {
  const [repositories, syncStates, syncSegments, totals, allIssues, allPullRequests, bounties, scoringSnapshot] = await Promise.all([
    listRepositories(env),
    listRepoSyncStates(env),
    listRepoSyncSegments(env),
    listLatestRepoGithubTotalsSnapshots(env),
    listAllIssues(env),
    listAllPullRequests(env),
    listBounties(env),
    getOrCreateScoringModelSnapshot(env),
  ]);
  return { repositories, syncStates, syncSegments, totals, allIssues, allPullRequests, bounties, scoringSnapshot };
}

export async function buildAndPersistContributorDecisionPack(env: Env, login: string, shared?: DecisionPackSharedInputs): Promise<ContributorDecisionPack> {
  // The heavy full-table reads are login-independent; reuse caller-provided context (batch job) or load once here (single-login run).
  const { repositories, syncStates, syncSegments, totals, allIssues, allPullRequests, bounties, scoringSnapshot } = shared ?? (await loadDecisionPackSharedInputs(env));
  const [github, contributorPullRequests, contributorIssues, cachedRepoStats, gittensorSnapshot] = await Promise.all([
    fetchPublicContributorProfile(login),
    listContributorPullRequests(env, login),
    listContributorIssues(env, login),
    listContributorRepoStats(env, login),
    fetchGittensorContributorSnapshot(login),
  ]);
  const repoStats = authoritativeContributorRepoStats(gittensorSnapshot, cachedRepoStats);
  await evaluateRecommendationOutcomes(env, login);
  const [issueQualityByRepo, repoOutcomePatternsByRepo, recommendationOutcomeFeedback] = await Promise.all([
    loadIssueQualityReportMap(env, repositories),
    loadRepoOutcomePatternsMap(env, repositories),
    getAgentRecommendationOutcomeSummary(env, login),
  ]);
  const focusManifests = await loadRepoFocusManifests(
    env,
    repositories.filter((repo) => repo.isRegistered).map((repo) => repo.fullName),
  );
  const profile = buildContributorProfile(login, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
  const pullRequestFiles = (
    await Promise.all(
      evidenceGraphTouchedRepoFullNames({
        login,
        profile,
        pullRequests: contributorPullRequests,
        issues: contributorIssues,
        repoStats,
        repositories,
      }).map((repoFullName) => listRepoPullRequestFiles(env, repoFullName)),
    )
  ).flat();
  const outcomeHistory = buildContributorOutcomeHistory({
    login,
    profile,
    repositories,
    pullRequests: contributorPullRequests,
    issues: contributorIssues,
    repoStats,
    cachedRepoStats,
  });
  const fit = buildContributorFit(profile, repositories, allIssues, allPullRequests, syncStates, repoStats, bounties, issueQualityByRepo);
  const scoringProfile = buildContributorScoringProfile({ login, fit, scoringSnapshot });
  const openPrMonitor = await buildContributorOpenPrMonitor(env, login);
  const pack = buildContributorDecisionPack({
    login,
    profile,
    outcomeHistory,
    repositories,
    syncStates,
    syncSegments,
    totals,
    opportunities: fit.opportunities,
    scoringModelSnapshotId: scoringSnapshot.id,
    contributorPullRequests,
    contributorIssues,
    repoStats,
    pullRequestFiles,
    gittensorSnapshot,
    issueQualityByRepo,
    openPrMonitor,
    focusManifests,
    repoOutcomePatternsByRepo,
    recommendationOutcomeFeedback,
  });

  await upsertContributorEvidence(env, {
    login,
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
      evidenceGraph: pack.evidenceGraph as unknown as JsonValue,
    },
  });
  await upsertContributorScoringProfile(env, {
    login,
    scoringModelSnapshotId: scoringSnapshot.id,
    payload: scoringProfile as unknown as Record<string, JsonValue>,
    generatedAt: scoringProfile.generatedAt,
  });
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType: CONTRIBUTOR_DECISION_PACK_SIGNAL,
    targetKey: login,
    payload: pack as unknown as Record<string, JsonValue>,
    generatedAt: pack.generatedAt,
  });
  if (pack.evidenceGraph) {
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: CONTRIBUTOR_EVIDENCE_GRAPH_SIGNAL,
      targetKey: login,
      payload: pack.evidenceGraph as unknown as Record<string, JsonValue>,
      generatedAt: pack.evidenceGraph.generatedAt,
    });
  }
  return pack;
}

export function repoDecisionFromPack(pack: ContributorDecisionPack, repoFullName: string): RepoDecision | null {
  const key = repoFullName.toLowerCase();
  return pack.repoDecisions.find((decision) => decision.repoFullName.toLowerCase() === key) ?? null;
}

function buildContributorDecisionPack(args: {
  login: string;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  repositories: RepositoryRecord[];
  syncStates: RepoSyncStateRecord[];
  syncSegments: RepoSyncSegmentRecord[];
  totals: RepoGithubTotalsSnapshotRecord[];
  opportunities?: ContributorOpportunity[] | undefined;
  scoringModelSnapshotId: string;
  contributorPullRequests: Parameters<typeof buildRoleContext>[0]["pullRequests"];
  contributorIssues: Parameters<typeof buildRoleContext>[0]["issues"];
  repoStats?: ContributorRepoStatRecord[] | undefined;
  pullRequestFiles?: PullRequestFileRecord[] | undefined;
  gittensorSnapshot?: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>> | undefined;
  issueQualityByRepo?: Map<string, IssueQualityReport> | undefined;
  openPrMonitor: ContributorOpenPrMonitor;
  focusManifests?: Map<string, FocusManifest> | undefined;
  repoOutcomePatternsByRepo?: Map<string, RepoOutcomePatterns> | undefined;
  recommendationOutcomeFeedback?: AgentRecommendationOutcomeSummary | undefined;
}): ContributorDecisionPack {
  const recommendationOutcomeFeedback = args.recommendationOutcomeFeedback ?? emptyRecommendationOutcomeFeedback(args.login);
  const registeredRepositories = args.repositories.filter((repo) => repo.isRegistered);
  const syncByRepo = new Map(args.syncStates.map((state) => [state.repoFullName.toLowerCase(), state]));
  const totalsByRepo = new Map(args.totals.map((total) => [total.repoFullName.toLowerCase(), total]));
  const outcomeByRepo = new Map(args.outcomeHistory.repoOutcomes.map((outcome) => [outcome.repoFullName.toLowerCase(), outcome]));
  const issueQualityByRepo = args.issueQualityByRepo
    ? new Map([...args.issueQualityByRepo.entries()].map(([repoFullName, report]) => [repoFullName.toLowerCase(), report]))
    : new Map<string, IssueQualityReport>();
  const languageSet = new Set((args.profile.github?.topLanguages ?? []).map((language) => language.toLowerCase()));
  const labelHistory = new Set(args.profile.registeredRepoActivity?.dominantLabels ?? []);
  const roleContexts = registeredRepositories.map((repo) =>
    buildRoleContext({
      login: args.login,
      repo,
      repoFullName: repo.fullName,
      pullRequests: args.contributorPullRequests,
      issues: args.contributorIssues,
      profile: args.profile,
    }),
  );
  const roleByRepo = new Map(roleContexts.map((role) => [role.repoFullName.toLowerCase(), role]));
  const recommendationFeedbackByRepo = new Map(recommendationOutcomeFeedback.repos.map((repo) => [repo.repoFullName.toLowerCase(), repo]));
  const repoDecisions = registeredRepositories
    .map((repo) => {
      const key = repo.fullName.toLowerCase();
      return buildRepoDecision({
        repo,
        roleContext: roleByRepo.get(key) ?? buildRoleContext({ login: args.login, repo, repoFullName: repo.fullName, profile: args.profile }),
        outcome: outcomeByRepo.get(key),
        syncState: syncByRepo.get(key),
        totals: totalsByRepo.get(key),
        languageSet,
        labelHistory,
        issueQuality: issueQualityByRepo.get(key),
        focusManifest: args.focusManifests?.get(key),
        repoOutcomePatterns: args.repoOutcomePatternsByRepo?.get(key),
        recommendationOutcomeFeedback: recommendationFeedbackByRepo.get(key),
      });
    })
    .sort((left, right) => right.priorityScore - left.priorityScore || left.repoFullName.localeCompare(right.repoFullName));
  const topActions = repoDecisions.flatMap(actionsForDecision).sort((left, right) => right.priorityScore - left.priorityScore || left.repoFullName.localeCompare(right.repoFullName)).slice(0, 12);
  const scoreBlockers = repoDecisions.flatMap((decision) => decision.scoreBlockers).sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || (left.repoFullName ?? "").localeCompare(right.repoFullName ?? ""));
  const dataQuality = {
    signalFidelity: buildSignalFidelity(registeredRepositories.length, args.syncStates, args.syncSegments),
  };
  const evidenceGraph = buildContributorEvidenceGraph({
    login: args.login,
    profile: args.profile,
    outcomeHistory: args.outcomeHistory,
    roleContexts,
    repositories: args.repositories,
    pullRequests: args.contributorPullRequests,
    issues: args.contributorIssues,
    repoStats: args.repoStats,
    syncStates: args.syncStates,
    pullRequestFiles: args.pullRequestFiles,
    gittensorSnapshot: args.gittensorSnapshot,
  });
  const monitor = args.openPrMonitor;
  const monitorNextSteps = monitor.guidance.slice(0, 6);
  const packNextActions = [...new Set([...monitorNextSteps, ...topActions.flatMap((action) => action.nextActions)])].slice(0, 12);
  const monitorSummary = monitor.openPrCount > 0 ? ` ${monitor.summary}` : "";
  const generatedAt = nowIso();
  const actionPortfolio = buildActionPortfolio({
    generatedAt,
    repoDecisions,
    topActions,
    openPrMonitor: monitor,
  });
  return {
    status: "ready",
    source: "computed",
    login: args.login,
    generatedAt,
    stale: false,
    freshness: "fresh",
    rebuildEnqueued: false,
    scoringModelSnapshotId: args.scoringModelSnapshotId,
    profile: {
      login: args.profile.login,
      github: args.profile.github,
      source: args.profile.source,
      officialStats: sanitizeOfficialStats(args.profile),
      registeredRepoActivity: args.profile.registeredRepoActivity,
      trustSignals: args.profile.trustSignals,
    },
    outcomeHistory: args.outcomeHistory,
    roleContexts: roleContexts.filter((role) => role.role !== "unknown" || role.maintainerLane),
    opportunities: args.opportunities ?? [],
    repoDecisions,
    topActions,
    actionPortfolio,
    cleanupFirst: repoDecisions.filter((decision) => decision.recommendation === "cleanup_first").slice(0, 8),
    pursueRepos: repoDecisions.filter((decision) => decision.recommendation === "pursue").slice(0, 8),
    avoidRepos: repoDecisions.filter((decision) => decision.recommendation === "avoid_for_now").slice(0, 8),
    maintainerLaneRepos: repoDecisions.filter((decision) => decision.recommendation === "maintainer_lane").slice(0, 8),
    scoreBlockers,
    recommendationOutcomeFeedback,
    evidenceGraph,
    dataQuality,
    summary: `${args.login} has ${topActions.length} ranked action(s), ${scoreBlockers.length} scoreability blocker(s), and ${repoDecisions.length} registered repo decision(s).${monitorSummary}${recommendationFeedbackSummary(recommendationOutcomeFeedback)}`,
    nextActions: packNextActions,
    openPrMonitor: monitor,
  };
}

function buildRepoDecision(args: {
  repo: RepositoryRecord;
  roleContext: RoleContext;
  outcome?: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  syncState?: RepoSyncStateRecord | undefined;
  totals?: RepoGithubTotalsSnapshotRecord | undefined;
  languageSet?: Set<string> | undefined;
  labelHistory?: Set<string> | undefined;
  issueQuality?: IssueQualityReport | undefined;
  focusManifest?: FocusManifest | undefined;
  repoOutcomePatterns?: RepoOutcomePatterns | undefined;
  recommendationOutcomeFeedback?: AgentRecommendationOutcomeRepoSummary | undefined;
}): RepoDecision {
  const lane = buildLaneAdvice(args.repo, args.repo.fullName);
  const config = args.repo.registryConfig;
  const openPullRequests = args.totals?.openPullRequestsTotal ?? args.syncState?.openPullRequestsCount ?? 0;
  const openIssues = args.totals?.openIssuesTotal ?? args.syncState?.openIssuesCount ?? 0;
  const queue = {
    openIssues,
    openPullRequests,
    mergedPullRequests: args.totals?.mergedPullRequestsTotal ?? args.syncState?.recentMergedPullRequestsCount ?? 0,
    closedUnmergedPullRequests: args.totals?.closedUnmergedPullRequestsTotal ?? 0,
  };
  const rewardUpside = {
    emissionShare: round(config?.emissionShare ?? 0),
    directPrShare: round((config?.emissionShare ?? 0) * (1 - (config?.issueDiscoveryShare ?? 0))),
    issueDiscoveryShare: round((config?.emissionShare ?? 0) * (config?.issueDiscoveryShare ?? 0)),
    maintainerCut: round(config?.maintainerCut ?? 0),
  };
  const blockers = scoreBlockersFor(args.repo.fullName, lane.lane, args.roleContext, args.outcome);
  const issueQuality = summarizeIssueQuality(args.issueQuality);
  const recommendationFeedback = summarizeRecommendationOutcomeFeedback(args.recommendationOutcomeFeedback);
  const riskReasons = [
    ...(queue.openPullRequests >= 25 ? [`Repo queue is busy with ${queue.openPullRequests} open PR(s).`] : []),
    ...(queue.openIssues >= 100 ? [`Repo issue queue is large with ${queue.openIssues} open issue(s).`] : []),
    ...(args.outcome && args.outcome.closedPullRequestRate >= 0.35 ? [`Repo-specific closed PR rate is ${Math.round(args.outcome.closedPullRequestRate * 100)}%.`] : []),
    ...(args.outcome && args.outcome.openPullRequests >= 3 ? [`Contributor has ${args.outcome.openPullRequests} open PR(s) in this repo.`] : []),
    ...(lane.lane === "issue_discovery" ? ["Direct PRs are not the useful lane here; use issue-discovery behavior only."] : []),
    ...(issueQuality && issueQuality.doNotUseCount > 0 ? [`Issue quality marks ${issueQuality.doNotUseCount} cached issue(s) as already covered or duplicate-prone.`] : []),
    ...(issueQuality && issueQuality.readyCount === 0 && (lane.lane === "issue_discovery" || lane.lane === "split") ? ["No ready issue-quality candidate is cached for this repo."] : []),
  ];
  const recommendation = recommendationFor(lane.lane, args.roleContext, args.outcome, blockers);
  const priorityScore = clamp(priorityFor(recommendation, rewardUpside, args.outcome, queue, blockers) + issueQualityPriorityAdjustment(lane.lane, issueQuality) + recommendationOutcomePriorityAdjustment(recommendationFeedback), 0, 100);
  const syncLanguage = args.syncState?.primaryLanguage ?? null;
  const languageMatch: LanguageMatch = {
    language: syncLanguage,
    match: Boolean(syncLanguage && args.languageSet?.has(syncLanguage.toLowerCase())),
  };
  const labelHistory = args.labelHistory;
  const labelFit = labelHistory
    ? Object.keys(args.repo.registryConfig?.labelMultipliers ?? {}).filter((label) => labelHistory.has(label))
    : [];
  const copyContext: RepoCopyContext = {
    repoFullName: args.repo.fullName,
    lane: lane.lane,
    queue,
    rewardUpside,
    outcome: args.outcome,
    languageMatch,
    labelFit,
    issueQuality,
  };
  const manifest = args.focusManifest;
  const manifestSummary = manifest && manifest.present ? buildRepoDecisionManifestSummary(manifest) : undefined;
  const manifestReasons = manifest && manifest.present ? buildRepoDecisionManifestReasons(manifest) : { whyThisHelps: [], nextActions: [], publicNextActions: [], riskReasons: [] };
  const repoOutcomePatterns = summarizeRepoOutcomePatterns(args.repoOutcomePatterns);
  const outcomeRiskLines = args.roleContext.maintainerLane ? [] : (repoOutcomePatterns?.riskPatterns ?? []).slice(0, 2).map((pattern) => pattern.detail);
  const outcomeSuccessLines = recommendation === "pursue" ? (repoOutcomePatterns?.successPatterns ?? []).slice(0, 1).map((pattern) => pattern.detail) : [];
  const recommendationFeedbackRiskLines = args.roleContext.maintainerLane ? [] : recommendationFeedbackRiskReasons(recommendationFeedback);
  const recommendationFeedbackSuccessLines = recommendationFeedbackWhyThisHelps(recommendationFeedback);
  return {
    repoFullName: args.repo.fullName,
    recommendation,
    priorityScore,
    lane,
    roleContext: args.roleContext,
    outcome: args.outcome,
    queue,
    rewardUpside,
    languageMatch,
    labelFit,
    scoreBlockers: blockers,
    repoOutcomePatterns,
    recommendationOutcomeFeedback: recommendationFeedback,
    riskReasons: [...new Set([...riskReasons, ...manifestReasons.riskReasons, ...outcomeRiskLines, ...recommendationFeedbackRiskLines])],
    whyThisHelps: [...new Set([...whyThisHelpsFor(recommendation, copyContext), ...manifestReasons.whyThisHelps, ...outcomeSuccessLines, ...recommendationFeedbackSuccessLines])],
    nextActions: [...new Set([...nextActionsFor(recommendation, copyContext), ...manifestReasons.nextActions])],
    publicNextActions: [...new Set([...publicNextActionsFor(recommendation, copyContext), ...manifestReasons.publicNextActions])],
    issueQuality,
    manifestSummary,
  };
}

/**
 * Public-safe per-repo summary of a maintainer's focus manifest, intentionally excluding the
 * manifest's private `maintainerNotes`. The contributor-facing decision pack must never carry
 * maintainer-private reviewer text.
 */
function buildRepoDecisionManifestSummary(manifest: FocusManifest): RepoDecisionManifestSummary {
  return {
    present: true,
    source: manifest.source,
    linkedIssuePolicy: manifest.linkedIssuePolicy,
    issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
    wantedPathCount: manifest.wantedPaths.length,
    blockedPathCount: manifest.blockedPaths.length,
    preferredLabels: manifest.preferredLabels.slice(0, 8),
    publicNotes: manifest.publicNotes.filter(isFocusManifestPublicSafe).slice(0, 4),
  };
}

function buildRepoDecisionManifestReasons(manifest: FocusManifest): { whyThisHelps: string[]; nextActions: string[]; publicNextActions: string[]; riskReasons: string[] } {
  const whyThisHelps: string[] = [];
  const nextActions: string[] = [];
  const publicNextActions: string[] = [];
  const riskReasons: string[] = [];
  if (manifest.wantedPaths.length > 0) {
    whyThisHelps.push(`Maintainer focus manifest declares ${manifest.wantedPaths.length} wanted path(s) for this repo.`);
    publicNextActions.push("Target the maintainer-wanted areas for this repo when picking a change.");
  }
  if (manifest.blockedPaths.length > 0) {
    riskReasons.push(`Maintainer focus manifest blocks ${manifest.blockedPaths.length} path pattern(s) for this repo.`);
    publicNextActions.push("Avoid the maintainer-blocked areas for this repo.");
  }
  if (manifest.linkedIssuePolicy === "required") {
    nextActions.push("Link a tracked issue on every PR; the maintainer's manifest requires it.");
    publicNextActions.push("Link a tracked issue on every PR; the maintainer requires linked issues.");
  } else if (manifest.linkedIssuePolicy === "preferred") {
    publicNextActions.push("Prefer linking a tracked issue; the maintainer prefers linked issues.");
  }
  if (manifest.preferredLabels.length > 0) {
    publicNextActions.push(`Use a maintainer-preferred label when applicable (${manifest.preferredLabels.slice(0, 3).join(", ")}).`);
  }
  if (manifest.issueDiscoveryPolicy === "discouraged") {
    publicNextActions.push("Prefer direct fixes over new issue-discovery reports here.");
  } else if (manifest.issueDiscoveryPolicy === "encouraged") {
    publicNextActions.push("High-quality issue-discovery reports are welcomed by the maintainer.");
  }
  for (const note of manifest.publicNotes) {
    if (isFocusManifestPublicSafe(note)) publicNextActions.push(note);
  }
  return {
    whyThisHelps,
    nextActions,
    publicNextActions: [...new Set(publicNextActions)].filter(isFocusManifestPublicSafe),
    riskReasons,
  };
}

function summarizeRepoOutcomePatterns(patterns: RepoOutcomePatterns | undefined): RepoOutcomeSummary | undefined {
  if (!patterns) return undefined;
  if (patterns.sampleSize < 1 && patterns.successPatterns.length === 0 && patterns.riskPatterns.length === 0) return undefined;
  return {
    summary: patterns.summary,
    outsideContributorMergeRate: patterns.outsideContributorMergeRate,
    sampleSize: patterns.sampleSize,
    successPatterns: patterns.successPatterns.slice(0, 3),
    riskPatterns: patterns.riskPatterns.slice(0, 3),
  };
}

function summarizeRecommendationOutcomeFeedback(feedback: AgentRecommendationOutcomeRepoSummary | undefined): RepoRecommendationOutcomeFeedback | undefined {
  if (!feedback || feedback.total === 0) return undefined;
  return {
    signal: feedback.signal,
    total: feedback.total,
    positive: feedback.positive,
    negative: feedback.negative,
    merged: feedback.merged,
    closed: feedback.closed,
    stale: feedback.stale,
    ignored: feedback.ignored,
    improved: feedback.improved,
    maintainerLaneTotal: feedback.maintainerLaneTotal,
    latestOutcomeAt: feedback.latestOutcomeAt,
  };
}

function recommendationFeedbackWhyThisHelps(feedback: RepoRecommendationOutcomeFeedback | undefined): string[] {
  if (!feedback || feedback.positive === 0) return [];
  return [`Private recommendation feedback has ${feedback.positive} positive contributor-lane outcome(s) for this repo (${feedback.merged} merged, ${feedback.improved} improved, ${feedback.total - feedback.negative - feedback.merged - feedback.improved} accepted).`];
}

function recommendationFeedbackRiskReasons(feedback: RepoRecommendationOutcomeFeedback | undefined): string[] {
  if (!feedback || feedback.negative === 0) return [];
  return [`Private recommendation feedback has ${feedback.negative} unresolved or negative contributor-lane outcome(s) for this repo (${feedback.closed} closed, ${feedback.stale} stale, ${feedback.ignored} ignored).`];
}

function recommendationOutcomePriorityAdjustment(feedback: RepoRecommendationOutcomeFeedback | undefined): number {
  if (!feedback) return 0;
  if (feedback.signal === "positive") return Math.min(8, feedback.positive * 2);
  if (feedback.signal === "negative") return -Math.min(12, feedback.negative * 2);
  if (feedback.signal === "mixed") return -Math.min(4, feedback.negative);
  return 0;
}

function recommendationFeedbackSummary(feedback: AgentRecommendationOutcomeSummary): string {
  if (feedback.totals.total === 0 && feedback.totals.maintainerLaneTotal === 0) return "";
  return ` Recommendation feedback: ${feedback.totals.positive} positive, ${feedback.totals.negative} negative, ${feedback.totals.maintainerLaneTotal} maintainer-lane separated.`;
}

function emptyRecommendationOutcomeFeedback(login: string): AgentRecommendationOutcomeSummary {
  return {
    login,
    generatedAt: nowIso(),
    windowDays: 90,
    totals: {
      total: 0,
      accepted: 0,
      ignored: 0,
      stale: 0,
      merged: 0,
      closed: 0,
      improved: 0,
      positive: 0,
      negative: 0,
      maintainerLaneTotal: 0,
    },
    states: [],
    repos: [],
    maintainerLane: { total: 0, states: [] },
    privateSummary: `${login} has no evaluated recommendation outcomes in the last 90 day(s).`,
  };
}

function scoreBlockersFor(repoFullName: string, lane: string, roleContext: RoleContext, outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined): ScoreBlocker[] {
  const blockers: ScoreBlocker[] = [];
  const openPullRequests = outcome?.openPullRequests ?? 0;
  const closedPullRequestRate = outcome?.closedPullRequestRate ?? 0;
  if (roleContext.maintainerLane) blockers.push({ code: "maintainer_lane", repoFullName, severity: "info", detail: "Maintainer-lane activity is separate from normal outside-contributor reward evidence." });
  if (lane === "inactive" || lane === "unknown") blockers.push({ code: "inactive_or_unknown_lane", repoFullName, severity: "critical", detail: "The repo lane is inactive or unknown in the current registry snapshot." });
  if (lane === "issue_discovery") blockers.push({ code: "issue_discovery_only", repoFullName, severity: "warning", detail: "This repo is issue-discovery-only; direct PR reward/risk reasoning is not applicable." });
  if (openPullRequests >= 5) blockers.push({ code: "open_pr_pressure", repoFullName, severity: "critical", detail: `${openPullRequests} open PR(s) create scoreability and review-pressure risk.` });
  if (closedPullRequestRate >= 0.35) blockers.push({ code: "closed_pr_credibility", repoFullName, severity: "warning", detail: `Closed PR rate is ${Math.round(closedPullRequestRate * 100)}%.` });
  if (outcome && !outcome.maintainerLane && outcome.credibility > 0 && outcome.credibility < 0.8) blockers.push({ code: "low_credibility", repoFullName, severity: "warning", detail: `Official repo credibility is ${round(outcome.credibility)}.` });
  return blockers;
}

function recommendationFor(lane: string, roleContext: RoleContext, outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined, blockers: ScoreBlocker[]): DecisionRecommendation {
  if (roleContext.maintainerLane) return "maintainer_lane";
  if (blockers.some((blocker) => blocker.code === "open_pr_pressure")) return "cleanup_first";
  if (blockers.some((blocker) => blocker.severity === "critical")) return "avoid_for_now";
  if ((outcome?.openPullRequests ?? 0) >= 3) return "cleanup_first";
  if (lane === "direct_pr" || lane === "split") return "pursue";
  if (lane === "issue_discovery") return "watch";
  return "avoid_for_now";
}

function priorityFor(
  recommendation: DecisionRecommendation,
  rewardUpside: RepoDecision["rewardUpside"],
  outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined,
  queue: RepoDecision["queue"],
  blockers: ScoreBlocker[],
): number {
  const upside = Math.max(rewardUpside.directPrShare, rewardUpside.issueDiscoveryShare, rewardUpside.emissionShare * 0.35) * 1000;
  const history = (outcome?.mergedPullRequests ?? 0) * 2 + (outcome?.validSolvedIssues ?? 0) * 3 - (outcome?.closedPullRequests ?? 0) * 1.5;
  const queuePenalty = Math.min(30, queue.openPullRequests * 0.25);
  const penalizedBlockers = recommendation === "cleanup_first"
    ? blockers.filter((blocker) => blocker.code !== "open_pr_pressure")
    : blockers;
  const blockerPenalty = penalizedBlockers.reduce((sum, blocker) => sum + (blocker.severity === "critical" ? 35 : blocker.severity === "warning" ? 15 : 5), 0);
  const base = recommendation === "cleanup_first" ? 75 : recommendation === "pursue" ? 65 : recommendation === "maintainer_lane" ? 55 : recommendation === "watch" ? 35 : 20;
  return clamp(round(base + upside + history - queuePenalty - blockerPenalty), 0, 100);
}

function actionsForDecision(decision: RepoDecision): DecisionAction[] {
  if (decision.recommendation === "maintainer_lane") {
    return [
      action("maintainer_lane_improve_repo", decision, decision.priorityScore),
      action("maintainer_cut_readiness", decision, Math.max(0, decision.priorityScore - 10)),
    ];
  }
  if (decision.recommendation === "cleanup_first") {
    return [action("cleanup_existing_prs", decision, decision.priorityScore), action("land_existing_prs", decision, Math.max(0, decision.priorityScore - 8))];
  }
  if (decision.recommendation === "pursue") return [action("open_new_direct_pr", decision, decision.priorityScore)];
  if (decision.lane.lane === "issue_discovery" || decision.lane.lane === "split") return [action("file_issue_discovery", decision, decision.priorityScore)];
  return [];
}

function action(kind: DecisionActionKind, decision: RepoDecision, priorityScore: number): DecisionAction {
  return {
    actionKind: kind,
    repoFullName: decision.repoFullName,
    priorityScore,
    recommendation: decision.recommendation,
    whyThisHelps: decision.whyThisHelps,
    nextActions: decision.nextActions,
    publicNextActions: decision.publicNextActions,
  };
}

const ACTION_PORTFOLIO_BUCKET_ORDER: ActionPortfolioBucketName[] = ["cleanup", "wait", "direct_pr", "issue_discovery", "avoid", "maintainer_lane"];

function buildActionPortfolio(args: {
  generatedAt: string;
  repoDecisions: RepoDecision[];
  topActions: DecisionAction[];
  openPrMonitor?: ContributorOpenPrMonitor | undefined;
}): ActionPortfolio {
  const repoDecisions = args.repoDecisions.filter(isPortfolioDecision);
  const decisionByRepo = new Map(repoDecisions.map((decision) => [decision.repoFullName.toLowerCase(), decision]));
  const scenarioByRepo = new Map((args.openPrMonitor?.pendingScenarios ?? []).map((scenario) => [scenario.repoFullName.toLowerCase(), scenario.detection]));
  const items = [
    ...args.topActions
      .filter((entry) => typeof entry.repoFullName === "string")
      .map((entry) => {
        const decision = decisionByRepo.get(entry.repoFullName.toLowerCase());
        return decision ? portfolioItemFromAction(entry, decision, scenarioByRepo.get(entry.repoFullName.toLowerCase())) : null;
      })
      .filter((entry): entry is ActionPortfolioItem => Boolean(entry)),
    ...repoDecisions
      .filter((decision) => decision.recommendation === "avoid_for_now")
      .map((decision) => portfolioItemFromDecision(decision, "avoid", scenarioByRepo.get(decision.repoFullName.toLowerCase()))),
  ];
  const uniqueItems = dedupePortfolioItems(items).sort(comparePortfolioItems);
  const buckets = ACTION_PORTFOLIO_BUCKET_ORDER.map((bucket) => {
    const actions = uniqueItems.filter((entry) => entry.bucket === bucket);
    return {
      bucket,
      label: portfolioBucketLabel(bucket),
      summary: portfolioBucketSummary(bucket, actions),
      actions,
    } satisfies ActionPortfolioBucket;
  });
  const counts = Object.fromEntries(buckets.map((bucket) => [bucket.bucket, bucket.actions.length])) as Record<ActionPortfolioBucketName, number>;
  const activeBuckets = buckets.filter((bucket) => bucket.actions.length > 0);
  return {
    generatedAt: args.generatedAt,
    bucketOrder: ACTION_PORTFOLIO_BUCKET_ORDER,
    buckets,
    topActions: uniqueItems.slice(0, 12),
    counts,
    summary:
      activeBuckets.length === 0
        ? "No portfolio actions are currently available from the decision pack."
        : `Portfolio has ${uniqueItems.length} action(s) across ${activeBuckets.length} active bucket(s): ${activeBuckets.map((bucket) => `${bucket.bucket} ${bucket.actions.length}`).join(", ")}.`,
  };
}

function portfolioItemFromAction(
  actionEntry: DecisionAction,
  decision: RepoDecision,
  scenario: ContributorOpenPrMonitor["pendingScenarios"][number]["detection"] | undefined,
): ActionPortfolioItem {
  const bucket = bucketForAction(actionEntry);
  return portfolioItem({
    bucket,
    actionKind: actionEntry.actionKind,
    decision,
    priorityScore: Number.isFinite(actionEntry.priorityScore) ? actionEntry.priorityScore : decision.priorityScore,
    whyNow: [...safeStringArray(actionEntry.whyThisHelps), ...safeStringArray(decision.riskReasons), ...scenarioWhyNow(scenario)].slice(0, 8),
    nextActions: safeStringArray(actionEntry.nextActions).length > 0 ? safeStringArray(actionEntry.nextActions) : safeStringArray(decision.nextActions),
    publicNextActions: safeStringArray(actionEntry.publicNextActions).length > 0 ? safeStringArray(actionEntry.publicNextActions) : safeStringArray(decision.publicNextActions),
    scenario,
  });
}

function portfolioItemFromDecision(
  decision: RepoDecision,
  bucket: ActionPortfolioBucketName,
  scenario: ContributorOpenPrMonitor["pendingScenarios"][number]["detection"] | undefined,
): ActionPortfolioItem {
  return portfolioItem({
    bucket,
    decision,
    priorityScore: decision.priorityScore,
    whyNow: [...safeStringArray(decision.whyThisHelps), ...safeStringArray(decision.riskReasons), ...scenarioWhyNow(scenario)].slice(0, 8),
    nextActions: safeStringArray(decision.nextActions),
    publicNextActions: safeStringArray(decision.publicNextActions),
    scenario,
  });
}

function portfolioItem(args: {
  bucket: ActionPortfolioBucketName;
  actionKind?: DecisionActionKind | undefined;
  decision: RepoDecision;
  priorityScore: number;
  whyNow: string[];
  nextActions: string[];
  publicNextActions: string[];
  scenario?: ContributorOpenPrMonitor["pendingScenarios"][number]["detection"] | undefined;
}): ActionPortfolioItem {
  return {
    bucket: args.bucket,
    repoFullName: args.decision.repoFullName,
    actionKind: args.actionKind,
    priorityScore: args.priorityScore,
    recommendation: args.decision.recommendation,
    status: portfolioStatusFor(args.decision, args.bucket),
    whyNow: args.whyNow.length > 0 ? args.whyNow : [`${args.decision.repoFullName}: current decision-pack signals place this repo in ${args.bucket}.`],
    scoreabilityImpact: portfolioScoreabilityImpact(args.decision, args.bucket),
    riskImpact: safeStringArray(args.decision.riskReasons)[0] ?? "No major repo-specific risk is visible in the current decision pack.",
    maintainerImpact: portfolioMaintainerImpact(args.decision, args.bucket),
    blockedBy: safeScoreBlockers(args.decision).map((blocker) => blocker.code),
    rerunWhen: portfolioRerunWhen(args.decision, args.bucket),
    publicSafeSummary: sanitizePortfolioPublicSummary(args.publicNextActions[0] ?? `${args.decision.repoFullName}: Use Gittensory preflight before posting public PR context.`),
    nextActions: args.nextActions,
    publicNextActions: args.publicNextActions.map(sanitizePortfolioPublicSummary),
    source: "decision_pack",
    scenarioProjection: args.scenario ? portfolioScenarioProjection(args.scenario) : undefined,
  };
}

function bucketForAction(actionEntry: DecisionAction): ActionPortfolioBucketName {
  if (actionEntry.actionKind === "cleanup_existing_prs") return "cleanup";
  if (actionEntry.actionKind === "land_existing_prs") return "wait";
  if (actionEntry.actionKind === "file_issue_discovery") return "issue_discovery";
  if (actionEntry.actionKind === "maintainer_lane_improve_repo" || actionEntry.actionKind === "maintainer_cut_readiness") return "maintainer_lane";
  return "direct_pr";
}

function portfolioStatusFor(decision: RepoDecision, bucket: ActionPortfolioBucketName): ActionPortfolioItem["status"] {
  if (bucket === "avoid" || bucket === "wait") return "watch";
  if (safeScoreBlockers(decision).some((blocker) => blocker.severity === "critical")) return "blocked";
  return "recommended";
}

function portfolioScoreabilityImpact(decision: RepoDecision, bucket: ActionPortfolioBucketName): string {
  if (bucket === "cleanup") return "Resolving open PR pressure can unblock scoreability before opening new work.";
  if (bucket === "wait") return "Wait for current PR outcomes or close stale work before adding more queue pressure.";
  if (bucket === "issue_discovery") return "Direct PR scoreability is not the target; issue-discovery evidence is the useful lane.";
  if (bucket === "maintainer_lane") return "Maintainer-lane work is separated from outside-contributor scoreability evidence.";
  const blockers = safeScoreBlockers(decision);
  if (blockers.length > 0) return `Blocked by ${blockers.map((blocker) => blocker.code).join(", ")}.`;
  return `Lane fit: ${decision.lane?.lane ?? "unknown"}; direct PR share ${decision.rewardUpside?.directPrShare ?? 0}.`;
}

function portfolioMaintainerImpact(decision: RepoDecision, bucket: ActionPortfolioBucketName): string {
  if (bucket === "cleanup") return "Cleanup lowers active-review pressure before adding more queue load.";
  if (bucket === "wait") return "Waiting on merge-ready or stale PR outcomes avoids noisy parallel work.";
  if (bucket === "maintainer_lane") return "Repo-owner work should improve intake quality and contributor routing.";
  if (bucket === "avoid") return "Avoiding this repo keeps maintainer attention away from low-fit or blocked submissions.";
  return "Narrow, validated work with clear lane fit is easier to review.";
}

function portfolioRerunWhen(decision: RepoDecision, bucket: ActionPortfolioBucketName): string {
  if (bucket === "cleanup" || bucket === "wait") return "Rerun after open PRs merge, close, or are withdrawn.";
  if (safeScoreBlockers(decision).length > 0) return "Rerun after the listed scoreability blockers change.";
  return "Rerun before opening a PR or when repo queue/registry signals change.";
}

function scenarioWhyNow(scenario: ContributorOpenPrMonitor["pendingScenarios"][number]["detection"] | undefined): string[] {
  if (!scenario) return [];
  return scenario.scenarioNotes.slice(0, 2).map((note) => `Scenario projection: ${note}`);
}

function portfolioScenarioProjection(
  scenario: ContributorOpenPrMonitor["pendingScenarios"][number]["detection"],
): ActionPortfolioScenarioProjection {
  return {
    source: scenario.source,
    pendingMergedPrCount: scenario.pendingMergedPrCount,
    pendingClosedPrCount: scenario.pendingClosedPrCount,
    approvedPrCount: scenario.approvedPrCount,
    ...(scenario.expectedOpenPrCountAfterMerge !== undefined ? { expectedOpenPrCountAfterMerge: scenario.expectedOpenPrCountAfterMerge } : {}),
    notes: scenario.scenarioNotes.slice(0, 4),
  };
}

function portfolioBucketLabel(bucket: ActionPortfolioBucketName): string {
  if (bucket === "cleanup") return "Cleanup first";
  if (bucket === "wait") return "Wait or land existing work";
  if (bucket === "direct_pr") return "Direct PR opportunities";
  if (bucket === "issue_discovery") return "Issue discovery";
  if (bucket === "avoid") return "Avoid for now";
  return "Maintainer lane";
}

function portfolioBucketSummary(bucket: ActionPortfolioBucketName, actions: ActionPortfolioItem[]): string {
  if (actions.length === 0) return `No ${portfolioBucketLabel(bucket).toLowerCase()} actions are currently recommended.`;
  const topRepo = actions[0]?.repoFullName ?? "repo";
  if (bucket === "cleanup") return `${actions.length} cleanup action(s), led by ${topRepo}.`;
  if (bucket === "wait") return `${actions.length} wait/land action(s), led by ${topRepo}.`;
  if (bucket === "direct_pr") return `${actions.length} direct-PR action(s), led by ${topRepo}.`;
  if (bucket === "issue_discovery") return `${actions.length} issue-discovery action(s), led by ${topRepo}.`;
  if (bucket === "avoid") return `${actions.length} repo(s) should be avoided for now, led by ${topRepo}.`;
  return `${actions.length} maintainer-lane action(s), led by ${topRepo}.`;
}

function dedupePortfolioItems(items: ActionPortfolioItem[]): ActionPortfolioItem[] {
  const seen = new Set<string>();
  const deduped: ActionPortfolioItem[] = [];
  for (const item of items) {
    const key = `${item.bucket}:${item.repoFullName.toLowerCase()}:${item.actionKind ?? item.recommendation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function comparePortfolioItems(left: ActionPortfolioItem, right: ActionPortfolioItem): number {
  return (
    ACTION_PORTFOLIO_BUCKET_ORDER.indexOf(left.bucket) - ACTION_PORTFOLIO_BUCKET_ORDER.indexOf(right.bucket) ||
    right.priorityScore - left.priorityScore ||
    left.repoFullName.localeCompare(right.repoFullName) ||
    (left.actionKind ?? "").localeCompare(right.actionKind ?? "")
  );
}

function isPortfolioDecision(value: RepoDecision): boolean {
  return typeof value.repoFullName === "string" && typeof value.recommendation === "string";
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function safeScoreBlockers(decision: RepoDecision): ScoreBlocker[] {
  return Array.isArray(decision.scoreBlockers) ? decision.scoreBlockers : [];
}

function sanitizePortfolioPublicSummary(value: string): string {
  return value
    .replace(/\b(reward|payout|farming|estimated score|public score estimate|raw trust score|trust score|scoreability|wallet|hotkey|coldkey|private reviewability)\b/gi, "private signal")
    .replace(/\s+/g, " ")
    .trim();
}

type RepoCopyContext = {
  repoFullName: string;
  lane: string;
  queue: RepoDecision["queue"];
  rewardUpside: RepoDecision["rewardUpside"];
  outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  languageMatch: LanguageMatch;
  labelFit: string[];
  issueQuality?: IssueQualitySummary | undefined;
};

function whyThisHelpsFor(recommendation: DecisionRecommendation, context: RepoCopyContext): string[] {
  const { repoFullName, rewardUpside, outcome, languageMatch, labelFit, lane, issueQuality } = context;
  const labelPhrase = labelFit.length > 0 ? ` Label overlap with your history: ${labelFit.slice(0, 3).join(", ")}.` : "";
  const languagePhrase = languageMatch.match && languageMatch.language ? ` Primary language ${languageMatch.language} matches your top languages.` : "";
  const qualityPhrase = issueQuality && issueQuality.readyCount > 0 ? ` Issue quality has ${issueQuality.readyCount} ready candidate(s).` : "";
  if (recommendation === "cleanup_first") {
    const openCount = outcome?.openPullRequests ?? 0;
    return [`${repoFullName}: ${openCount} of your open PR(s) here block scoreability; clearing them lowers maintainer friction.${labelPhrase}`];
  }
  if (recommendation === "maintainer_lane") {
    return [`${repoFullName}: maintainer-owned work should improve repo health, intake quality, labels, and queue clarity. Maintainer cut: ${round(rewardUpside.maintainerCut)}.`];
  }
  if (recommendation === "pursue") {
    const merged = outcome?.mergedPullRequests ?? 0;
    const historyPhrase = merged > 0 ? ` You have ${merged} merged PR(s) in this repo already.` : "";
    if (lane === "split") {
      return [`${repoFullName}: split lane (direct PR ${round(rewardUpside.directPrShare)}, issue-discovery ${round(rewardUpside.issueDiscoveryShare)}); both lanes are useful here.${languagePhrase}${labelPhrase}${historyPhrase}${qualityPhrase}`];
    }
    return [`${repoFullName}: direct PR lane share ${round(rewardUpside.directPrShare)} with no hard personal blocker.${languagePhrase}${labelPhrase}${historyPhrase}`];
  }
  if (recommendation === "watch") {
    return [`${repoFullName}: ${lane === "issue_discovery" ? "issue-discovery-only" : "low-direct-PR"} lane; only actionable, non-duplicate issue reports add value.${labelPhrase}${qualityPhrase}`];
  }
  return [`${repoFullName}: risk-adjusted priority is low until blockers improve.`];
}

function nextActionsFor(recommendation: DecisionRecommendation, context: RepoCopyContext): string[] {
  const { repoFullName, queue, outcome, languageMatch, labelFit, lane, issueQuality } = context;
  const labelHint = labelFit.length > 0 ? ` (target labels: ${labelFit.slice(0, 3).join(", ")})` : "";
  const languageHint = languageMatch.match && languageMatch.language ? ` in ${languageMatch.language}` : "";
  const topReadyIssue = issueQuality?.topReadyIssues[0];
  if (recommendation === "cleanup_first") {
    const openCount = outcome?.openPullRequests ?? 0;
    return [
      `${repoFullName}: close, update, or land your ${openCount} open PR(s) before opening more work${labelHint}.`,
      "Use local branch preflight on each active PR to reduce review friction.",
    ];
  }
  if (recommendation === "maintainer_lane") {
    return [
      `${repoFullName}: improve contributor intake health, label clarity, and queue hygiene as repo owner.`,
      "Review maintainer_cut readiness separately from outside-contributor strategy.",
    ];
  }
  if (recommendation === "pursue") {
    if (lane === "split") {
      if (topReadyIssue) {
        return [
          `${repoFullName}: split lane — either open a narrow direct PR${languageHint}${labelHint} or file issue-discovery on #${topReadyIssue.number}: ${topReadyIssue.title}.`,
        ];
      }
      return [
        `${repoFullName}: split lane — choose direct PR${languageHint}${labelHint} OR file an actionable issue-discovery report; queue has ${queue.openPullRequests} open PR(s) and ${queue.openIssues} open issue(s).`,
      ];
    }
    return [
      `${repoFullName}: pick one narrow change${languageHint}${labelHint}; run tests + branch preflight before opening the PR. Queue has ${queue.openPullRequests} open PR(s).`,
    ];
  }
  if (recommendation === "watch" || lane === "issue_discovery") {
    if (topReadyIssue) {
      return [
        `${repoFullName}: file issue-discovery on ready candidate #${topReadyIssue.number}: ${topReadyIssue.title}${labelHint}.`,
      ];
    }
    return [
      `${repoFullName}: file only high-confidence, actionable, non-duplicate issue-discovery reports${labelHint}. Open issues in queue: ${queue.openIssues}.`,
    ];
  }
  return [`${repoFullName}: choose a different repo or wait for cleaner lane/credibility conditions.`];
}

function publicNextActionsFor(recommendation: DecisionRecommendation, context: RepoCopyContext): string[] {
  const { repoFullName, languageMatch, labelFit, lane, issueQuality } = context;
  const languageHint = languageMatch.match && languageMatch.language ? ` in ${languageMatch.language}` : "";
  const labelHint = labelFit.length > 0 ? ` (consider labels: ${labelFit.slice(0, 3).join(", ")})` : "";
  const issueQualityHint = issueQuality && issueQuality.readyCount > 0 ? " Use issue-quality ready candidates before posting." : "";
  if (recommendation === "cleanup_first") {
    return [`${repoFullName}: resolve open PR pressure before opening additional review load.`];
  }
  if (recommendation === "maintainer_lane") {
    return [`${repoFullName}: as repo owner, improve intake health, label clarity, and queue hygiene.`];
  }
  if (recommendation === "pursue") {
    if (lane === "split") {
      return [`${repoFullName}: split lane — direct PR or actionable issue report${languageHint}${labelHint}; use Gittensory preflight before posting public PR context.${issueQualityHint}`];
    }
    return [`${repoFullName}: pick a narrow change${languageHint}${labelHint}; use Gittensory preflight before posting public PR context.`];
  }
  if (recommendation === "watch" || lane === "issue_discovery") {
    return [`${repoFullName}: file only actionable, non-duplicate issue-discovery reports${labelHint}.${issueQualityHint}`];
  }
  return [`${repoFullName}: consider a different repo until lane/credibility signals improve.`];
}

function summarizeIssueQuality(report: IssueQualityReport | undefined): IssueQualitySummary | undefined {
  if (!report) return undefined;
  const ready = report.issues.filter((issue) => issue.status === "ready");
  return {
    readyCount: ready.length,
    needsProofCount: report.issues.filter((issue) => issue.status === "needs_proof").length,
    holdCount: report.issues.filter((issue) => issue.status === "hold").length,
    doNotUseCount: report.issues.filter((issue) => issue.status === "do_not_use").length,
    topReadyIssues: ready.slice(0, 3).map((issue) => ({ number: issue.number, title: issue.title, score: issue.score })),
  };
}

function issueQualityPriorityAdjustment(lane: string, issueQuality: IssueQualitySummary | undefined): number {
  if (!issueQuality || (lane !== "issue_discovery" && lane !== "split")) return 0;
  if (issueQuality.readyCount > 0) return 8;
  if (issueQuality.doNotUseCount > 0 || issueQuality.needsProofCount > 0 || issueQuality.holdCount > 0) return -8;
  return 0;
}

function sanitizeOfficialStats(profile: ContributorProfile): ContributorDecisionPack["profile"]["officialStats"] {
  if (!profile.gittensor) return null;
  const { hotkey: _hotkey, ...safe } = profile.gittensor;
  return safe;
}

function withSnapshotMetadata(snapshot: SignalSnapshotRecord): ContributorDecisionPack {
  const payload = snapshot.payload as unknown as ContributorDecisionPack;
  const login = payload.login ?? snapshot.targetKey;
  const generatedAt = snapshot.generatedAt ?? payload.generatedAt ?? nowIso();
  const ageSeconds = Math.max(0, Math.floor(snapshotAgeMs(generatedAt) / 1000));
  const stale = snapshotAgeMs(generatedAt) > DECISION_PACK_MAX_AGE_MS;
  const actionPortfolio =
    (payload as Partial<ContributorDecisionPack>).actionPortfolio ??
    buildActionPortfolio({
      generatedAt,
      repoDecisions: payload.repoDecisions ?? [],
      topActions: payload.topActions ?? [],
      openPrMonitor: payload.openPrMonitor,
    });
  return {
    ...payload,
    status: "ready",
    source: "snapshot",
    login,
    generatedAt,
    snapshotAgeSeconds: ageSeconds,
    stale,
    freshness: stale ? "stale" : "fresh",
    rebuildEnqueued: false,
    opportunities: payload.opportunities ?? [],
    actionPortfolio,
    recommendationOutcomeFeedback: payload.recommendationOutcomeFeedback ?? emptyRecommendationOutcomeFeedback(login),
  };
}

function snapshotAgeMs(generatedAt: string): number {
  const parsed = Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.POSITIVE_INFINITY;
}

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>>,
  cachedRepoStats: ContributorRepoStatRecord[],
) {
  const officialRepoStats = contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
}

function severityRank(severity: ScoreBlocker["severity"]): number {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export const __decisionPackInternals = {
  buildRepoDecision,
  buildContributorDecisionPack,
  scoreBlockersFor,
  recommendationFor,
  priorityFor,
  actionsForDecision,
  buildActionPortfolio,
  whyThisHelpsFor,
  nextActionsFor,
  publicNextActionsFor,
  sanitizeOfficialStats,
  withSnapshotMetadata,
  snapshotAgeMs,
  authoritativeContributorRepoStats,
  severityRank,
  clamp,
  round,
};
