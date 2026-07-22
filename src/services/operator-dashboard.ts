import {
  countActiveAuthSessions,
  countActiveDigestSubscriptions,
  getCommandUsefulnessSummary,
  getLatestScoringModelSnapshot,
  getProductUsageRollupStatus,
  listAiCostByTenantSince,
  listAllPullRequests,
  listInstallationHealth,
  listInstallations,
  listLatestGitHubRateLimitObservations,
  listProductUsageDailyRollups,
  listRepositories,
  listRowCountByTenantSince,
  summarizeMcpCompatibilityAdoption,
  summarizeProductUsageEvents,
  type AiCostByTenant,
  type RowCountByTenant,
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
import { computeFleetAnalytics, getFleetHealthSummary, type FleetAnalytics, type FleetHealthSummary } from "../orb/analytics";
import { computeAgentHealth, computeCalibration, type AgentHealth, type Calibration } from "../review/ops";
import { computeGateEval, type GateEvalReport } from "../review/parity";
import { computeContributorGateEval, contributorFairnessFlags, computeBlendedContributorGateEval, contributorGlobalFairnessFlags } from "../review/contributor-gate-eval";
import { computeBlendedRuleGateEval, rulesBelowClosePrecisionFloor } from "../review/rule-gate-eval";
import { computeCycleTimeAggregate, computeFindingAcceptance, type CycleTimeAggregate } from "../review/stats";
import { loadUpstreamStatus, type UpstreamStatus } from "../upstream/ruleset";
import { nowIso } from "../utils/json";
import { buildRecommendationQualityReport, type RecommendationQualityReport } from "./recommendation-quality-report";
import { buildSlopOutcomeCalibration, type SlopOutcomeCalibration } from "./outcome-calibration";
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

/** Finding acceptance rate (#1967), reshaped for the dashboard's `AcceptanceRateCard` (see
 *  apps/loopover-ui/src/components/site/app-panels/acceptance-rate-card.tsx). The card's field names
 *  (windowDays/accepted/total/rate) intentionally differ from `FindingAcceptanceAggregate`'s
 *  (flagged/addressed/unaddressed/acceptanceRate) — this is the UI-facing shape, mapped in buildOperatorDashboardPayload. */
export type OperatorDashboardFindingAcceptance = {
  windowDays: number;
  accepted: number;
  total: number;
  rate: number | null;
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
  // Agent reversal health (#2193): how often humans reopened/reverted bot auto-actions (ops.ts AgentHealth).
  agentHealth: AgentHealth;
  // Slop-band calibration (#2196): org-wide per-band merge/close rates over resolved PRs carrying a persisted
  // slop band — is the deterministic slop score predictive? Bands only, never raw scores. Fails safe to empty.
  slopCalibration: SlopOutcomeCalibration;
  // Finding acceptance rate (#1967): share of gate-flagged (hold|close) PRs later merged, reshaped to the
  // AcceptanceRateCard's field names. Fails safe to an empty aggregate (rate: null) on any read error.
  acceptance: OperatorDashboardFindingAcceptance;
  // #4916: per-tenant AI cost breakdown for hosted deployments, highest-cost-first. Always [] for a self-host
  // operator (no installation-scoped ai_usage_events rows exist there) -- this surfaces the #7176/#7183 ledger
  // data that had no dashboard consumer until now.
  aiCostByTenant: AiCostByTenant[];
  // #4890 (re-scoped): per-tenant row-count breakdown of ai_usage_events, highest-count-first. The account-wide
  // D1 storage cap already has alerting (src/selfhost/d1-size-probe.ts); this is the per-installation dimension
  // that alerting doesn't have. Same self-host-always-empty caveat as aiCostByTenant above.
  storageRowCountByTenant: RowCountByTenant[];
  // #4933: fleet-wide instance READINESS (up/down/unknown), distinct from fleetMetrics above (gate-calibration
  // quality). Always all-zero for a self-host operator (no registered peer instances).
  fleetHealth: FleetHealthSummary;
};

const USAGE_WINDOW_DAYS = 7;
// Gate-precision and cycle-time cards (#2191/#2194) keep a fixed 90d lookback for statistical stability.
const GATE_ANALYTICS_WINDOW_DAYS = 90;

export async function buildOperatorDashboardPayload(
  env: Env,
  options: { windowDays?: number } = {},
): Promise<OperatorDashboardPayload> {
  const windowDays = clampOperatorDashboardWindowDays(options.windowDays);
  const usageSince = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const mcpSince = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
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
    contributorGateEval,
    blendedContributorGateEval,
    blendedRuleGateEval,
    cycleTime,
    calibration,
    agentHealth,
    slopCalibration,
    findingAcceptance,
    aiCostByTenant,
    storageRowCountByTenant,
    fleetHealth,
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
    summarizeMcpCompatibilityAdoption(env, mcpSince),
    getCommandUsefulnessSummary(env, { windowDays }),
    buildRecommendationQualityReport(env, { windowDays: GATE_ANALYTICS_WINDOW_DAYS }),
    computeFleetAnalytics(env, { windowDays: GATE_ANALYTICS_WINDOW_DAYS }),
    // #2191: reuse the existing eval (no new compute); it fails safe to an empty report on any read error.
    computeGateEval(env, { days: GATE_ANALYTICS_WINDOW_DAYS, nowMs: Date.now() }),
    // #fairness-analytics: per-contributor gate accuracy, same window; fails safe to an empty report.
    computeContributorGateEval(env, { days: GATE_ANALYTICS_WINDOW_DAYS, nowMs: Date.now() }),
    // #global-contributor-trust: the SAME data pooled cross-repo into one blended figure per login, same window.
    computeBlendedContributorGateEval(env, { days: GATE_ANALYTICS_WINDOW_DAYS, nowMs: Date.now() }),
    // #7984: the SAME review_audit data re-aggregated by RULE CODE (pooled cross-repo) instead of by project —
    // isolates a single systematically-wrong deterministic rule even while its host project's own aggregate
    // still looks healthy. Fails safe to an empty report on any read error.
    computeBlendedRuleGateEval(env, { days: GATE_ANALYTICS_WINDOW_DAYS, nowMs: Date.now() }),
    // #2194: cycle-time percentiles from the stats feed; fails safe to an empty aggregate.
    computeCycleTimeAggregate(env, { days: GATE_ANALYTICS_WINDOW_DAYS, nowMs: Date.now() }),
    computeCalibration(env, operatorAgentConfig(env)),
    computeAgentHealth(env, operatorAgentConfig(env)),
    buildOrgSlopCalibration(env),
    // #1967: reuse the existing finding-acceptance aggregate (no new compute); fails safe to an empty
    // aggregate on any read error.
    computeFindingAcceptance(env, { days: GATE_ANALYTICS_WINDOW_DAYS, nowMs: Date.now() }),
    // #4916: per-tenant AI cost breakdown, same window as the rest of the usage metrics above.
    listAiCostByTenantSince(env, usageSince),
    // #4890 (re-scoped): per-tenant row-count breakdown, same window as the rest of the usage metrics above.
    listRowCountByTenantSince(env, usageSince),
    // #4933: fleet-wide instance readiness -- a point-in-time summary, no window needed.
    getFleetHealthSummary(env),
  ]);
  const weeklyValueReport = buildWeeklyValueReport({
    generatedAt: nowIso(),
    variant: "operator",
    days: windowDays,
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
  // #fairness-analytics: pure fold over the already-fetched eval rows, no extra I/O.
  const contributorFairnessFlagCount = contributorFairnessFlags(contributorGateEval.rows).length;
  // #global-contributor-trust: same fold, but over the blended (cross-repo) rows.
  const globalContributorFairnessFlagCount = contributorGlobalFairnessFlags(blendedContributorGateEval.rows).length;
  // #7984: rules whose sample has cleared enough volume to trust but whose weighted close precision sits
  // below the SAME floor auto-tune.ts's project-level close-precision breaker uses -- pure fold, no extra I/O.
  const rulesBelowFloor = rulesBelowClosePrecisionFloor(blendedRuleGateEval.rows);
  const installedRepos = repositories.filter((repo: RepositoryRecord) => repo.isInstalled).length;
  const registeredRepos = repositories.filter((repo: RepositoryRecord) => repo.isRegistered).length;
  // #1967: map FindingAcceptanceAggregate's field names onto the AcceptanceRateCard's expected shape.
  const acceptance: OperatorDashboardFindingAcceptance = {
    windowDays: GATE_ANALYTICS_WINDOW_DAYS,
    accepted: findingAcceptance.addressed,
    total: findingAcceptance.flagged,
    rate: findingAcceptance.acceptanceRate,
  };
  return {
    generatedAt: nowIso(),
    metrics: [
      { label: "Active sessions", value: String(activeSessions), delta: "browser + CLI/MCP" },
      { label: "Installations", value: String(installations.length), delta: `${installedRepos} installed repos` },
      {
        label: "Registered repos",
        value: String(registeredRepos),
        // A null registry is the normal, expected state for any operator who hasn't opted into the
        // gittensor plugin (see gittensor-wire.ts) -- "missing" reads as broken when it isn't (#5026).
        delta: registry ? `${registry.repoCount} in latest registry` : "gittensor plugin not enabled",
      },
      { label: "Digest subscriptions", value: String(digestSubscriptions), delta: "store-only" },
      { label: "Product events", value: String(usageSummary.totalEvents), delta: `last ${windowDays} days` },
      { label: "Active users", value: String(usageSummary.activeActors), delta: `hashed, last ${windowDays} days` },
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
      {
        // #2350: human-facing detection signal only — no automatic action reads this value.
        label: "Fleet gaming-pattern flags",
        value: String(fleetMetrics.gamingPatternFlags.length),
        delta: fleetMetrics.gamingPatternFlags.length > 0 ? `${fleetMetrics.gamingPatternFlags.map((f) => f.instanceId).join(", ")}` : "no gaming pattern detected",
      },
      {
        // #fairness-analytics: count only, same privacy posture as the gaming-pattern-flags tile above but
        // stricter -- individual logins are never surfaced here, even to the operator; drill into a specific
        // contributor via GET /v1/internal/fairness/contributors/:login instead.
        label: "Contributor fairness flags",
        value: String(contributorFairnessFlagCount),
        // contributorGateEval.rows is one row per (login, project) -- the SAME login active on two repos
        // contributes two rows, so this counts evaluated rows, not unique contributors (that count lives on
        // the "Global contributor fairness flags" tile below, via blendedContributorGateEval's per-login fold).
        delta: contributorFairnessFlagCount > 0 ? `${contributorGateEval.rows.length} (login, project) row(s) evaluated` : "no outliers detected",
      },
      {
        // #global-contributor-trust: the cross-repo blended counterpart -- one row per LOGIN (pooled across
        // every repo they've touched) rather than one row per (login, project), same privacy posture as the
        // per-project tile above (counts only, never individual logins).
        label: "Global contributor fairness flags",
        value: String(globalContributorFairnessFlagCount),
        delta: globalContributorFairnessFlagCount > 0 ? `${blendedContributorGateEval.rows.length} contributor(s) evaluated` : "no outliers detected",
      },
      {
        // #7984: a rule code (unlike a contributor login) is not personally identifying, so the flagged codes
        // themselves are surfaced directly here -- same "name the specific thing" posture as the fleet
        // gaming-pattern-flags tile above, not the privacy-conscious count-only posture the contributor tiles
        // use for logins.
        label: "Rules below close-precision floor",
        value: String(rulesBelowFloor.length),
        delta: rulesBelowFloor.length > 0 ? rulesBelowFloor.map((r) => r.ruleCode).join(", ") : "no rule below floor",
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
    agentHealth,
    slopCalibration,
    acceptance,
    aiCostByTenant,
    storageRowCountByTenant,
    fleetHealth,
  };
}

/** #2196: org-wide slop-band calibration from persisted slop bands on resolved PRs. `listAllPullRequests` can
 *  throw (unlike the sibling reads, which fail safe internally), so this wraps it and degrades to an empty
 *  calibration on any read error — one DB hiccup must never fail the whole dashboard build. */
async function buildOrgSlopCalibration(env: Env): Promise<SlopOutcomeCalibration> {
  try {
    return buildSlopOutcomeCalibration(await listAllPullRequests(env));
  } catch {
    return buildSlopOutcomeCalibration([]);
  }
}

function operatorAgentConfig(env: Env): { slug: string; secrets: Record<string, never> } {
  const slug =
    typeof env.GITHUB_APP_SLUG === "string" && env.GITHUB_APP_SLUG.trim()
      ? env.GITHUB_APP_SLUG.trim()
      : "loopover";
  return { slug, secrets: {} };
}

export const __operatorDashboardInternals = { operatorAgentConfig, buildOrgSlopCalibration };

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

export function clampOperatorDashboardWindowDays(value: number | undefined): number {
  const numeric = Number(value);
  if (numeric === 7 || numeric === 30 || numeric === 90) return numeric;
  return USAGE_WINDOW_DAYS;
}
