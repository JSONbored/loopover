import {
  countActiveAuthSessions,
  countActiveDigestSubscriptions,
  getCommandUsefulnessSummary,
  getLatestScoringModelSnapshot,
  getProductUsageRollupStatus,
  listInstallationHealth,
  listInstallations,
  listLatestGitHubRateLimitObservations,
  listProductUsageDailyRollups,
  listRepositories,
  summarizeMcpCompatibilityAdoption,
  summarizeProductUsageEvents,
} from "../db/repositories";
import { getLatestRegistrySnapshot } from "../registry/sync";
import type {
  CommandUsefulnessSummary,
  InstallationHealthRecord,
  McpCompatibilityAdoptionSummary,
  ProductUsageDailyRollupRecord,
  ProductUsageRollupStatus,
  ProductUsageSummary,
  RegistrySnapshot,
  RepositoryRecord,
  ScoringModelSnapshotRecord,
  WeeklyValueReport,
} from "../types";
import { loadUpstreamStatus, type UpstreamStatus } from "../upstream/ruleset";
import { nowIso } from "../utils/json";
import { buildRecommendationQualityReport, type RecommendationQualityReport } from "./recommendation-quality-report";
import { buildWeeklyValueReport } from "./weekly-value-report";

export type OperatorDashboardMetric = {
  label: string;
  value: string;
  delta: string;
};

export type OperatorDashboardNoiseMetric = {
  label: string;
  value: number;
  spark: number[];
};

export type OperatorDashboardPayload = {
  generatedAt: string;
  metrics: OperatorDashboardMetric[];
  noiseReduction: OperatorDashboardNoiseMetric[];
  weeklyReport: string[];
  weeklyValueReport: WeeklyValueReport;
  usageSummary: ProductUsageSummary;
  usageRollups: ProductUsageDailyRollupRecord[];
  usageRollupStatus: ProductUsageRollupStatus;
  mcpCompatibilityAdoption: McpCompatibilityAdoptionSummary;
  commandUsefulness: CommandUsefulnessSummary;
  recommendationQuality: RecommendationQualityReport;
  registry: RegistrySnapshot | null;
  scoringModel: ScoringModelSnapshotRecord | null;
  upstreamDrift: UpstreamStatus;
};

const USAGE_WINDOW_DAYS = 7;

export async function buildOperatorDashboardPayload(env: Env): Promise<OperatorDashboardPayload> {
  const usageSince = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [
    repositories,
    installations,
    health,
    registry,
    scoring,
    upstreamDrift,
    activeSessions,
    digestSubscriptions,
    rateLimits,
    usageSummary,
    usageRollups,
    usageRollupStatus,
    mcpCompatibilityAdoption,
    commandUsefulness,
    recommendationQuality,
  ] = await Promise.all([
    listRepositories(env),
    listInstallations(env),
    listInstallationHealth(env),
    getLatestRegistrySnapshot(env),
    getLatestScoringModelSnapshot(env),
    loadUpstreamStatus(env),
    countActiveAuthSessions(env),
    countActiveDigestSubscriptions(env),
    listLatestGitHubRateLimitObservations(env, 20),
    summarizeProductUsageEvents(env, usageSince),
    listProductUsageDailyRollups(env, { limit: 14 }),
    getProductUsageRollupStatus(env),
    summarizeMcpCompatibilityAdoption(env, usageSince),
    getCommandUsefulnessSummary(env),
    buildRecommendationQualityReport(env, { windowDays: 90 }),
  ]);
  const weeklyValueReport = buildWeeklyValueReport({
    generatedAt: nowIso(),
    variant: "operator",
    days: USAGE_WINDOW_DAYS,
    repositories,
    installations,
    health,
    registry,
    scoring,
    upstreamDrift,
    usageSummary,
    usageRollups,
    usageRollupStatus,
    activeSessions,
    digestSubscriptions,
  });
  const installedRepos = repositories.filter((repo: RepositoryRecord) => repo.isInstalled).length;
  const registeredRepos = repositories.filter((repo: RepositoryRecord) => repo.isRegistered).length;
  return {
    generatedAt: nowIso(),
    metrics: [
      { label: "Active sessions", value: String(activeSessions), delta: "browser + CLI/MCP" },
      { label: "Installations", value: String(installations.length), delta: `${installedRepos} installed repos` },
      { label: "Registered repos", value: String(registeredRepos), delta: registry ? `${registry.repoCount} in latest registry` : "registry missing" },
      { label: "Digest subscriptions", value: String(digestSubscriptions), delta: "store-only" },
      { label: "Product events", value: String(usageSummary.totalEvents), delta: "last 7 days" },
      { label: "Active users", value: String(usageSummary.activeActors), delta: "hashed, last 7 days" },
      { label: "Activation rollups", value: usageRollupStatus.status, delta: usageRollupStatus.latestRollupDay ?? "not generated" },
      {
        label: "MCP stale clients",
        value: String(mcpCompatibilityAdoption.staleEvents + mcpCompatibilityAdoption.incompatibleEvents),
        delta: `${mcpCompatibilityAdoption.totalEvents} MCP event(s)`,
      },
      {
        label: "Command usefulness",
        value: `${commandUsefulness.totals.usefulCount}/${commandUsefulness.totals.feedbackCount}`,
        delta: usefulnessDelta(commandUsefulness.totals.usefulnessRate),
      },
      {
        label: "Recommendation quality",
        value: `${recommendationQuality.totals.positive}/${recommendationQuality.totals.total}`,
        delta: recommendationQuality.empty ? "no evaluated outcomes" : `${Math.round(recommendationQuality.totals.positiveRate * 100)}% positive`,
      },
      {
        label: "Install issues",
        value: String(health.filter((record: InstallationHealthRecord) => record.status !== "healthy").length),
        delta: "current health cache",
      },
      { label: "Rate-limit events", value: String(rateLimits.length), delta: "latest observations" },
    ],
    noiseReduction: [
      {
        label: "Healthy installations",
        value: health.filter((record: InstallationHealthRecord) => record.status === "healthy").length,
        spark: sparklineFromCounts(
          health.filter((record: InstallationHealthRecord) => record.status === "healthy").length,
          Math.max(health.length, 1),
        ),
      },
      {
        label: "Registered coverage",
        value: registeredRepos,
        spark: sparklineFromCounts(registeredRepos, Math.max(repositories.length, 1)),
      },
      {
        label: "Installed coverage",
        value: installedRepos,
        spark: sparklineFromCounts(installedRepos, Math.max(repositories.length, 1)),
      },
    ],
    weeklyReport: weeklyValueReport.summary,
    weeklyValueReport,
    usageSummary,
    usageRollups,
    usageRollupStatus,
    mcpCompatibilityAdoption,
    commandUsefulness,
    recommendationQuality,
    registry,
    scoringModel: scoring,
    upstreamDrift,
  };
}

export function latestUsageRollup(rollups: ProductUsageDailyRollupRecord[]): ProductUsageDailyRollupRecord | null {
  if (rollups.length === 0) return null;
  return [...rollups].sort((a, b) => b.day.localeCompare(a.day))[0]!;
}

function usefulnessDelta(rate: number | null): string {
  return rate === null ? "no feedback yet" : `${Math.round(rate * 100)}% useful over 30 days`;
}

function sparklineFromCounts(value: number, total: number): number[] {
  const safeTotal = Math.max(total, 1);
  const ratio = Math.min(1, Math.max(0, value / safeTotal));
  return [Math.round(ratio * 40), Math.round(ratio * 55), Math.round(ratio * 70), Math.round(ratio * 85), Math.round(ratio * 100)];
}
