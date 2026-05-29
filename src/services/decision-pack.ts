import {
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listLatestRepoGithubTotalsSnapshots,
  listRepositories,
  listRepoSyncSegments,
  listRepoSyncStates,
  listSignalSnapshots,
  persistSignalSnapshot,
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
  type ContributorOutcomeHistory,
  type ContributorProfile,
  type RoleContext,
} from "../signals/engine";
import { buildSignalFidelity } from "../signals/data-quality";
import type { ContributorRepoStatRecord, JsonValue, RepositoryRecord, RepoGithubTotalsSnapshotRecord, RepoSyncSegmentRecord, RepoSyncStateRecord, SignalSnapshotRecord } from "../types";
import { nowIso } from "../utils/json";

export const CONTRIBUTOR_DECISION_PACK_SIGNAL = "contributor-decision-pack";
export const DECISION_PACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type DecisionRecommendation = "pursue" | "cleanup_first" | "maintainer_lane" | "avoid_for_now" | "watch";
export type DecisionActionKind = "cleanup_existing_prs" | "land_existing_prs" | "open_new_direct_pr" | "file_issue_discovery" | "maintainer_lane_improve_repo" | "maintainer_cut_readiness";

export type ContributorDecisionPack = {
  status: "ready";
  source: "computed" | "snapshot";
  login: string;
  generatedAt: string;
  snapshotAgeSeconds?: number | undefined;
  stale: boolean;
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
  repoDecisions: RepoDecision[];
  topActions: DecisionAction[];
  cleanupFirst: RepoDecision[];
  pursueRepos: RepoDecision[];
  avoidRepos: RepoDecision[];
  maintainerLaneRepos: RepoDecision[];
  scoreBlockers: ScoreBlocker[];
  dataQuality: {
    signalFidelity: ReturnType<typeof buildSignalFidelity>;
  };
  summary: string;
  nextActions: string[];
};

export type DecisionPackRefreshNeeded = {
  status: "needs_snapshot_refresh";
  login: string;
  generatedAt: string;
  reason: "missing_snapshot" | "stale_snapshot";
  enqueued: boolean;
  staleSnapshot?: {
    generatedAt: string;
    ageSeconds: number;
  };
  dataQuality?: ContributorDecisionPack["dataQuality"] | undefined;
};

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
  riskReasons: string[];
  whyThisHelps: string[];
  nextActions: string[];
  publicNextActions: string[];
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

export type ScoreBlocker = {
  code: "open_pr_pressure" | "maintainer_lane" | "inactive_or_unknown_lane" | "closed_pr_credibility" | "issue_discovery_only" | "low_credibility";
  repoFullName?: string | undefined;
  severity: "info" | "warning" | "critical";
  detail: string;
};

export async function loadContributorDecisionPack(env: Env, login: string): Promise<ContributorDecisionPack | null> {
  const latest = (await listSignalSnapshots(env, CONTRIBUTOR_DECISION_PACK_SIGNAL, login))[0];
  if (!latest) return null;
  return withSnapshotMetadata(latest);
}

export async function loadFreshContributorDecisionPack(env: Env, login: string, maxAgeMs = DECISION_PACK_MAX_AGE_MS): Promise<ContributorDecisionPack | null> {
  const pack = await loadContributorDecisionPack(env, login);
  if (!pack) return null;
  return pack.stale || snapshotAgeMs(pack.generatedAt) > maxAgeMs ? null : pack;
}

export async function buildAndPersistContributorDecisionPack(env: Env, login: string): Promise<ContributorDecisionPack> {
  const [
    github,
    contributorPullRequests,
    contributorIssues,
    repositories,
    syncStates,
    syncSegments,
    totals,
    cachedRepoStats,
    gittensorSnapshot,
    scoringSnapshot,
  ] = await Promise.all([
    fetchPublicContributorProfile(login),
    listContributorPullRequests(env, login),
    listContributorIssues(env, login),
    listRepositories(env),
    listRepoSyncStates(env),
    listRepoSyncSegments(env),
    listLatestRepoGithubTotalsSnapshots(env),
    listContributorRepoStats(env, login),
    fetchGittensorContributorSnapshot(login),
    getOrCreateScoringModelSnapshot(env),
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
  const fit = buildContributorFit(profile, repositories, [], [], syncStates, repoStats);
  const scoringProfile = buildContributorScoringProfile({ login, fit, scoringSnapshot });
  const pack = buildContributorDecisionPack({
    login,
    profile,
    outcomeHistory,
    repositories,
    syncStates,
    syncSegments,
    totals,
    scoringModelSnapshotId: scoringSnapshot.id,
    contributorPullRequests,
    contributorIssues,
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
  scoringModelSnapshotId: string;
  contributorPullRequests: Parameters<typeof buildRoleContext>[0]["pullRequests"];
  contributorIssues: Parameters<typeof buildRoleContext>[0]["issues"];
}): ContributorDecisionPack {
  const registeredRepositories = args.repositories.filter((repo) => repo.isRegistered);
  const syncByRepo = new Map(args.syncStates.map((state) => [state.repoFullName.toLowerCase(), state]));
  const totalsByRepo = new Map(args.totals.map((total) => [total.repoFullName.toLowerCase(), total]));
  const outcomeByRepo = new Map(args.outcomeHistory.repoOutcomes.map((outcome) => [outcome.repoFullName.toLowerCase(), outcome]));
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
      });
    })
    .sort((left, right) => right.priorityScore - left.priorityScore || left.repoFullName.localeCompare(right.repoFullName));
  const topActions = repoDecisions.flatMap(actionsForDecision).sort((left, right) => right.priorityScore - left.priorityScore || left.repoFullName.localeCompare(right.repoFullName)).slice(0, 12);
  const scoreBlockers = repoDecisions.flatMap((decision) => decision.scoreBlockers).sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || (left.repoFullName ?? "").localeCompare(right.repoFullName ?? ""));
  const dataQuality = {
    signalFidelity: buildSignalFidelity(registeredRepositories.length, args.syncStates, args.syncSegments),
  };
  return {
    status: "ready",
    source: "computed",
    login: args.login,
    generatedAt: nowIso(),
    stale: false,
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
    repoDecisions,
    topActions,
    cleanupFirst: repoDecisions.filter((decision) => decision.recommendation === "cleanup_first").slice(0, 8),
    pursueRepos: repoDecisions.filter((decision) => decision.recommendation === "pursue").slice(0, 8),
    avoidRepos: repoDecisions.filter((decision) => decision.recommendation === "avoid_for_now").slice(0, 8),
    maintainerLaneRepos: repoDecisions.filter((decision) => decision.recommendation === "maintainer_lane").slice(0, 8),
    scoreBlockers,
    dataQuality,
    summary: `${args.login} has ${topActions.length} ranked action(s), ${scoreBlockers.length} scoreability blocker(s), and ${repoDecisions.length} registered repo decision(s).`,
    nextActions: [...new Set(topActions.flatMap((action) => action.nextActions))].slice(0, 10),
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
  const riskReasons = [
    ...(queue.openPullRequests >= 25 ? [`Repo queue is busy with ${queue.openPullRequests} open PR(s).`] : []),
    ...(queue.openIssues >= 100 ? [`Repo issue queue is large with ${queue.openIssues} open issue(s).`] : []),
    ...(args.outcome && args.outcome.closedPullRequestRate >= 0.35 ? [`Repo-specific closed PR rate is ${Math.round(args.outcome.closedPullRequestRate * 100)}%.`] : []),
    ...(args.outcome && args.outcome.openPullRequests >= 3 ? [`Contributor has ${args.outcome.openPullRequests} open PR(s) in this repo.`] : []),
    ...(lane.lane === "issue_discovery" ? ["Direct PRs are not the useful lane here; use issue-discovery behavior only."] : []),
  ];
  const recommendation = recommendationFor(lane.lane, args.roleContext, args.outcome, blockers);
  const priorityScore = priorityFor(recommendation, rewardUpside, args.outcome, queue, blockers);
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
  };
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
    riskReasons,
    whyThisHelps: whyThisHelpsFor(recommendation, copyContext),
    nextActions: nextActionsFor(recommendation, copyContext),
    publicNextActions: publicNextActionsFor(recommendation, copyContext),
  };
}

function scoreBlockersFor(repoFullName: string, lane: string, roleContext: RoleContext, outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined): ScoreBlocker[] {
  const blockers: ScoreBlocker[] = [];
  if (roleContext.maintainerLane) blockers.push({ code: "maintainer_lane", repoFullName, severity: "info", detail: "Maintainer-lane activity is separate from normal outside-contributor reward evidence." });
  if (lane === "inactive" || lane === "unknown") blockers.push({ code: "inactive_or_unknown_lane", repoFullName, severity: "critical", detail: "The repo lane is inactive or unknown in the current registry snapshot." });
  if (lane === "issue_discovery") blockers.push({ code: "issue_discovery_only", repoFullName, severity: "warning", detail: "This repo is issue-discovery-only; direct PR reward/risk reasoning is not applicable." });
  if ((outcome?.openPullRequests ?? 0) >= 5) blockers.push({ code: "open_pr_pressure", repoFullName, severity: "critical", detail: `${outcome?.openPullRequests ?? 0} open PR(s) create scoreability and review-pressure risk.` });
  if ((outcome?.closedPullRequestRate ?? 0) >= 0.35) blockers.push({ code: "closed_pr_credibility", repoFullName, severity: "warning", detail: `Closed PR rate is ${Math.round((outcome?.closedPullRequestRate ?? 0) * 100)}%.` });
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

type RepoCopyContext = {
  repoFullName: string;
  lane: string;
  queue: RepoDecision["queue"];
  rewardUpside: RepoDecision["rewardUpside"];
  outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  languageMatch: LanguageMatch;
  labelFit: string[];
};

function whyThisHelpsFor(recommendation: DecisionRecommendation, context: RepoCopyContext): string[] {
  const { repoFullName, rewardUpside, outcome, languageMatch, labelFit, lane } = context;
  const labelPhrase = labelFit.length > 0 ? ` Label overlap with your history: ${labelFit.slice(0, 3).join(", ")}.` : "";
  const languagePhrase = languageMatch.match && languageMatch.language ? ` Primary language ${languageMatch.language} matches your top languages.` : "";
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
      return [`${repoFullName}: split lane (direct PR ${round(rewardUpside.directPrShare)}, issue-discovery ${round(rewardUpside.issueDiscoveryShare)}); both lanes are useful here.${languagePhrase}${labelPhrase}${historyPhrase}`];
    }
    return [`${repoFullName}: direct PR lane share ${round(rewardUpside.directPrShare)} with no hard personal blocker.${languagePhrase}${labelPhrase}${historyPhrase}`];
  }
  if (recommendation === "watch") {
    return [`${repoFullName}: ${lane === "issue_discovery" ? "issue-discovery-only" : "low-direct-PR"} lane; only actionable, non-duplicate issue reports add value.${labelPhrase}`];
  }
  return [`${repoFullName}: risk-adjusted priority is low until blockers improve.`];
}

function nextActionsFor(recommendation: DecisionRecommendation, context: RepoCopyContext): string[] {
  const { repoFullName, queue, outcome, languageMatch, labelFit, lane } = context;
  const labelHint = labelFit.length > 0 ? ` (target labels: ${labelFit.slice(0, 3).join(", ")})` : "";
  const languageHint = languageMatch.match && languageMatch.language ? ` in ${languageMatch.language}` : "";
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
      return [
        `${repoFullName}: split lane — choose direct PR${languageHint}${labelHint} OR file an actionable issue-discovery report; queue has ${queue.openPullRequests} open PR(s) and ${queue.openIssues} open issue(s).`,
      ];
    }
    return [
      `${repoFullName}: pick one narrow change${languageHint}${labelHint}; run tests + branch preflight before opening the PR. Queue has ${queue.openPullRequests} open PR(s).`,
    ];
  }
  if (recommendation === "watch" || lane === "issue_discovery") {
    return [
      `${repoFullName}: file only high-confidence, actionable, non-duplicate issue-discovery reports${labelHint}. Open issues in queue: ${queue.openIssues}.`,
    ];
  }
  return [`${repoFullName}: choose a different repo or wait for cleaner lane/credibility conditions.`];
}

function publicNextActionsFor(recommendation: DecisionRecommendation, context: RepoCopyContext): string[] {
  const { repoFullName, languageMatch, labelFit, lane } = context;
  const languageHint = languageMatch.match && languageMatch.language ? ` in ${languageMatch.language}` : "";
  const labelHint = labelFit.length > 0 ? ` (consider labels: ${labelFit.slice(0, 3).join(", ")})` : "";
  if (recommendation === "cleanup_first") {
    return [`${repoFullName}: resolve open PR pressure before opening additional review load.`];
  }
  if (recommendation === "maintainer_lane") {
    return [`${repoFullName}: as repo owner, improve intake health, label clarity, and queue hygiene.`];
  }
  if (recommendation === "pursue") {
    if (lane === "split") {
      return [`${repoFullName}: split lane — direct PR or actionable issue report${languageHint}${labelHint}; use Gittensory preflight before posting public PR context.`];
    }
    return [`${repoFullName}: pick a narrow change${languageHint}${labelHint}; use Gittensory preflight before posting public PR context.`];
  }
  if (recommendation === "watch" || lane === "issue_discovery") {
    return [`${repoFullName}: file only actionable, non-duplicate issue-discovery reports${labelHint}.`];
  }
  return [`${repoFullName}: consider a different repo until lane/credibility signals improve.`];
}

function sanitizeOfficialStats(profile: ContributorProfile): ContributorDecisionPack["profile"]["officialStats"] {
  if (!profile.gittensor) return null;
  const { hotkey: _hotkey, ...safe } = profile.gittensor;
  return safe;
}

function withSnapshotMetadata(snapshot: SignalSnapshotRecord): ContributorDecisionPack {
  const payload = snapshot.payload as unknown as ContributorDecisionPack;
  const generatedAt = snapshot.generatedAt ?? payload.generatedAt ?? nowIso();
  const ageSeconds = Math.max(0, Math.floor(snapshotAgeMs(generatedAt) / 1000));
  return {
    ...payload,
    status: "ready",
    source: "snapshot",
    generatedAt,
    snapshotAgeSeconds: ageSeconds,
    stale: snapshotAgeMs(generatedAt) > DECISION_PACK_MAX_AGE_MS,
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
