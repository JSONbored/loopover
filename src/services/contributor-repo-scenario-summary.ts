import {
  getRepository,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listIssues,
  listPullRequests,
  listRecentMergedPullRequests,
  listRepositories,
} from "../db/repositories";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { fetchPublicContributorProfile } from "../github/public";
import { buildScenarioInput, createScenarioSignalEntry } from "../scenarios/input-model";
import { renderPublicScenarioSummary, type PublicScenarioSummary } from "../scenarios/scenario-summary";
import { buildScorePreview } from "../scoring/preview";
import { detectPendingPrScenario, loadContributorRepoOpenPrSignals } from "../scoring/pending-pr-scenarios";
import { deriveEligibilityPlan } from "./eligibility-plan";
import { simulateOpenPrPressure } from "./open-pr-pressure-scenarios";
import { getOrCreateScoringModelSnapshot } from "../scoring/model";
import {
  buildCollisionReport,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildLaneAdvice,
  buildQueueHealth,
  buildRoleContext,
  type ContributorOutcomeHistory,
  type ContributorProfile,
} from "../signals/engine";
import type { PullRequestRecord, RepositoryRecord } from "../types";
import { nowIso } from "../utils/json";

export type ContributorRepoScenarioSummaryResponse = {
  status: "ready";
  login: string;
  repoFullName: string;
  generatedAt: string;
  summary: PublicScenarioSummary;
};

export type ContributorRepoScenarioSummaryContext = {
  login: string;
  repoFullName: string;
  repo: RepositoryRecord | null;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  contributorPullRequests: PullRequestRecord[];
};

function authoritativeContributorRepoStats(
  gittensorSnapshot: Awaited<ReturnType<typeof fetchGittensorContributorSnapshot>>,
  cachedRepoStats: Awaited<ReturnType<typeof listContributorRepoStats>>,
) {
  const officialRepoStats = contributorRepoStatsFromGittensor(gittensorSnapshot);
  return officialRepoStats.length > 0 ? officialRepoStats : cachedRepoStats;
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return Boolean(value && value.toLowerCase() === login.toLowerCase());
}

function contributorOpenPrsOnRepo(login: string, repoFullName: string, pullRequests: PullRequestRecord[]): PullRequestRecord[] {
  return pullRequests.filter(
    (pr) => pr.state === "open" && sameLogin(pr.authorLogin, login) && pr.repoFullName.toLowerCase() === repoFullName.toLowerCase(),
  );
}

function metadataPreviewTokenEstimates(outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined) {
  const merged = outcome?.mergedPullRequests ?? 0;
  const sourceTokenScore = Math.min(120, Math.max(30, 42 + merged * 2));
  const totalTokenScore = Math.min(220, Math.max(60, 70 + merged * 4));
  return {
    sourceTokenScore,
    totalTokenScore,
    sourceLines: Math.max(12, sourceTokenScore),
  };
}

function bestFitLabels(repo: RepositoryRecord | null): string[] {
  const multipliers = repo?.registryConfig?.labelMultipliers ?? {};
  const labels = Object.entries(multipliers)
    .filter(([label]) => !/status|source|contributor|verified|risk|codex/i.test(label))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label]) => label);
  return labels.slice(0, 1);
}

export function buildContributorRepoScenarioSummaryFromContext(
  context: ContributorRepoScenarioSummaryContext & {
    issues: Awaited<ReturnType<typeof listIssues>>;
    pullRequests: Awaited<ReturnType<typeof listPullRequests>>;
    recentMergedPullRequests: Awaited<ReturnType<typeof listRecentMergedPullRequests>>;
    scoringSnapshot: Awaited<ReturnType<typeof getOrCreateScoringModelSnapshot>>;
    pendingDetection: ReturnType<typeof detectPendingPrScenario>;
    generatedAt?: string | undefined;
  },
): ContributorRepoScenarioSummaryResponse {
  const generatedAt = context.generatedAt ?? nowIso();
  const { login, repoFullName, repo, profile, outcomeHistory, contributorPullRequests, issues, pullRequests, recentMergedPullRequests, scoringSnapshot, pendingDetection } =
    context;
  const repoOutcome = outcomeHistory.repoOutcomes.find((entry) => entry.repoFullName.toLowerCase() === repoFullName.toLowerCase());
  const roleContext = buildRoleContext({
    login,
    repo,
    repoFullName,
    pullRequests,
    issues,
    profile,
  });
  const lane = buildLaneAdvice(repo, repoFullName);
  const collisions = buildCollisionReport(repoFullName, issues, pullRequests, recentMergedPullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
  const contributorOpenPrCount = contributorOpenPrsOnRepo(login, repoFullName, contributorPullRequests).length;
  const tokenEstimates = metadataPreviewTokenEstimates(repoOutcome);
  const credibility = repoOutcome?.credibility && repoOutcome.credibility > 0 ? repoOutcome.credibility : outcomeHistory.totals.credibility ?? 0.8;
  const preview = buildScorePreview({
    input: {
      repoFullName,
      targetType: "planned_pr",
      targetKey: `${login}:${repoFullName}:scenario-summary`,
      contributorLogin: login,
      labels: bestFitLabels(repo),
      linkedIssueMode: lane.lane === "issue_discovery" ? "none" : "standard",
      ...tokenEstimates,
      existingContributorTokenScore: 0,
      credibility,
      metadataOnly: true,
      duplicateRiskCount: collisions.summary.highRiskCount,
      openPrCount: contributorOpenPrCount,
    },
    repo,
    snapshot: scoringSnapshot,
  });
  const pressureSimulation = simulateOpenPrPressure({
    repoFullName,
    generatedAt,
    queueHealth,
    roleContext,
    contributorOpenPrCount,
  });
  const eligibilityPlan = deriveEligibilityPlan(preview);
  const scenarioInput = buildScenarioInput({
    scenarioType: "general_repo",
    repoFullName,
    registered: Boolean(repo?.isRegistered),
    maintainerLane: roleContext.role !== "outside_contributor",
    facts: [
      createScenarioSignalEntry({
        id: "queue",
        kind: "fact",
        label: "Queue pressure",
        detail: queueHealth.summary,
        source: "github_observed",
      }),
      createScenarioSignalEntry({
        id: "open_prs",
        kind: "fact",
        label: "Open PRs",
        detail: `Contributor has ${contributorOpenPrCount} open PR(s) on ${repoFullName}.`,
        source: "github_observed",
      }),
    ],
    assumptions: pendingDetection
      ? pendingDetection.scenarioNotes.slice(0, 3).map((note, index) =>
          createScenarioSignalEntry({
            id: `pending-${index + 1}`,
            kind: "assumption",
            label: "Pending PR scenario",
            detail: note,
            source: pendingDetection.source === "user_supplied" ? "user_supplied" : "github_observed",
          }),
        )
      : [],
    unavailableSignals: [],
  });
  const summary = renderPublicScenarioSummary({
    repoFullName,
    generatedAt,
    pressureSimulation,
    eligibilityPlan,
    pendingDetection: pendingDetection ?? undefined,
    publicBlockers: preview.blockedBy,
    scenarioInput,
  });
  return { status: "ready", login, repoFullName, generatedAt, summary };
}

export async function buildContributorRepoScenarioSummary(env: Env, login: string, repoFullName: string): Promise<ContributorRepoScenarioSummaryResponse> {
  const [github, contributorPullRequests, contributorIssues, repositories, cachedRepoStats, gittensorSnapshot, repo, issues, pullRequests, recentMergedPullRequests, scoringSnapshot] =
    await Promise.all([
      fetchPublicContributorProfile(login),
      listContributorPullRequests(env, login),
      listContributorIssues(env, login),
      listRepositories(env),
      listContributorRepoStats(env, login),
      fetchGittensorContributorSnapshot(login),
      getRepository(env, repoFullName),
      listIssues(env, repoFullName),
      listPullRequests(env, repoFullName),
      listRecentMergedPullRequests(env, repoFullName),
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
    cachedRepoStats,
  });
  const repoOpen = contributorOpenPrsOnRepo(login, repoFullName, contributorPullRequests);
  const signals = await loadContributorRepoOpenPrSignals(env, repoFullName, repoOpen);
  const roleContext = buildRoleContext({
    login,
    repo,
    repoFullName,
    pullRequests,
    issues,
    profile,
  });
  const pendingDetection = detectPendingPrScenario({
    login,
    repoFullName,
    pullRequests,
    roleContext,
    openPrCount: repoOpen.length,
    reviewsByPullNumber: signals.reviewsByPullNumber,
    checksByPullNumber: signals.checksByPullNumber,
  });
  return buildContributorRepoScenarioSummaryFromContext({
    login,
    repoFullName,
    repo,
    profile,
    outcomeHistory,
    contributorPullRequests,
    issues,
    pullRequests,
    recentMergedPullRequests,
    scoringSnapshot,
    pendingDetection,
  });
}
