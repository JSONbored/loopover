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
import { computeFleetAnalytics, type FleetAnalytics } from "../orb/analytics";
import { computeGateEval, type GateEvalReport } from "../review/parity";
import { computeCalibration, type Calibration } from "../review/ops";
import { computeCycleTimeAggregate, type CycleTimeAggregate } from "../review/stats";
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
  fleetMetrics: FleetAnalytics;
  // Gate-precision eval (#2191): the per-project confusion matrix + precisions from computeGateEval, surfaced
  // read-only for the maintainer analytics card. Fail-safe empty report when there is no review_audit signal.
  gateEval: GateEvalReport;
  // PR review cycle-time percentiles (#2194): gate decision → outcome from review_audit; fail-safe empty aggregate.
  cycleTime: CycleTimeAggregate;
  // Confidence-vs-outcome calibration curve (#2192): merge confidence bins + recommended floor from computeCalibration.
  calibration: Calibration;
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
    fleetMetrics,
    gateEval,
    cycleTime,
    calibration,
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
    computeFleetAnalytics(env, { windowDays: 90 }),
    // #2191: reuse the existing eval (no new compute); it fails safe to an empty report on any read error.
    computeGateEval(env, { days: 90, nowMs: Date.now() }),
    // #2194: cycle-time percentiles from the stats feed; fails safe to an empty aggregate.
    computeCycleTimeAggregate(env, { days: 90, nowMs: Date.now() }),
    computeCalibration(env, operatorAgentConfig(env)),
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
      {
        label: "Fleet instances",
        value: String(fleetMetrics.instanceCount),
        delta: fleetMetrics.outliers.length > 0 ? `${fleetMetrics.outliers.length} outlier(s)` : "self-host fleet",
      },
      {
        label: "Fleet merge precision",
        value: fleetMetrics.fleet.mergePrecision !== null ? `${Math.round(fleetMetrics.fleet.mergePrecision * 100)}%` : "—",
        delta: "median across the fleet",
      },
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
    fleetMetrics,
    gateEval,
    cycleTime,
    calibration,
  };
}

function operatorAgentConfig(env: Env): { slug: string; secrets: Record<string, never> } {
  const slug =
    typeof env.GITHUB_APP_SLUG === "string" && env.GITHUB_APP_SLUG.trim()
      ? env.GITHUB_APP_SLUG.trim()
      : "gittensory";
  return { slug, secrets: {} };
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
