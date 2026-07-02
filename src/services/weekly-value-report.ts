import {
  countActiveAuthSessions,
  countActiveDigestSubscriptions,
  getProductUsageRollupStatus,
  getLatestScoringModelSnapshot,
  listInstallationHealth,
  listInstallations,
  listProductUsageDailyRollups,
  listRepositories,
  recordAuditEvent,
  summarizeProductUsageEvents,
} from "../db/repositories";
import { getLatestRegistrySnapshot } from "../registry/sync";
import { loadUpstreamStatus, type UpstreamStatus } from "../upstream/ruleset";
import type {
  InstallationHealthRecord,
  InstallationRecord,
  ProductUsageActivationFunnel,
  ProductUsageDailyRollupRecord,
  ProductUsageDimensionCount,
  ProductUsageRollupStatus,
  ProductUsageSummary,
  RegistrySnapshot,
  RepositoryRecord,
  ScoringModelSnapshotRecord,
  WeeklyValueReport,
  WeeklyValueReportMetric,
  WeeklyValueReportVariant,
} from "../types";
import { nowIso } from "../utils/json";
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../signals/redaction";

type WeeklyValueReportInputs = {
  generatedAt: string;
  variant?: WeeklyValueReportVariant | null | undefined;
  days?: number | null | undefined;
  repositories: RepositoryRecord[];
  installations: InstallationRecord[];
  health: InstallationHealthRecord[];
  registry: RegistrySnapshot | null;
  scoring: ScoringModelSnapshotRecord | null;
  upstreamDrift: UpstreamStatus;
  usageSummary: ProductUsageSummary;
  usageRollups: ProductUsageDailyRollupRecord[];
  usageRollupStatus: ProductUsageRollupStatus;
  activeSessions?: number | null | undefined;
  digestSubscriptions?: number | null | undefined;
};

type WeeklyAggregate = {
  totalEvents: number;
  activeRepos: number;
  mcpEvents: number;
  githubCommandEvents: number;
  quietSkips: number;
  prPackets: number;
  prPreflights: number;
  maintainerSignals: number;
  driftDetections: number;
  activation: ProductUsageActivationFunnel;
  topRepos: ProductUsageDimensionCount[];
  topCommands: ProductUsageDimensionCount[];
  topTools: ProductUsageDimensionCount[];
  topRouteClasses: ProductUsageDimensionCount[];
};

export async function generateWeeklyValueReport(
  env: Env,
  options: { variant?: WeeklyValueReportVariant; days?: number; nowIso?: string } = {},
): Promise<WeeklyValueReport> {
  const report = await loadWeeklyValueReport(env, options);
  await recordAuditEvent(env, {
    eventType: "weekly_value_report_generated",
    actor: options.variant === "public" ? "public-report" : "operator-report",
    route: "scheduled",
    targetKey: `weekly-value-report:${report.variant}:${report.period.days}`,
    outcome: "success",
    detail: `${report.metrics.length} metric(s), ${report.warnings.length} warning(s)`,
    metadata: {
      variant: report.variant,
      days: report.period.days,
      totalEvents: report.metrics.find((metric) => metric.id === "product_events")?.value ?? 0,
      warnings: report.warnings.length,
    },
    createdAt: report.generatedAt,
  });
  return report;
}

export async function loadWeeklyValueReport(
  env: Env,
  options: { variant?: WeeklyValueReportVariant; days?: number; nowIso?: string } = {},
): Promise<WeeklyValueReport> {
  const generatedAt = options.nowIso ?? nowIso();
  const days = normalizeReportDays(options.days);
  const sinceIso = new Date(Date.parse(generatedAt) - days * 24 * 60 * 60 * 1000).toISOString();
  const [repositories, installations, health, registry, scoring, upstreamDrift, usageSummary, usageRollups, usageRollupStatus, activeSessions, digestSubscriptions] = await Promise.all([
    listRepositories(env),
    listInstallations(env),
    listInstallationHealth(env),
    getLatestRegistrySnapshot(env),
    getLatestScoringModelSnapshot(env),
    loadUpstreamStatus(env),
    summarizeProductUsageEvents(env, sinceIso),
    listProductUsageDailyRollups(env, { limit: days }),
    getProductUsageRollupStatus(env, { nowIso: generatedAt, lookbackDays: days }),
    countActiveAuthSessions(env),
    countActiveDigestSubscriptions(env),
  ]);
  const report = buildWeeklyValueReport({
    generatedAt,
    days,
    variant: options.variant,
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
  return report;
}

export function buildWeeklyValueReport(args: WeeklyValueReportInputs): WeeklyValueReport {
  const variant = args.variant === "public" ? "public" : "operator";
  const days = normalizeReportDays(args.days);
  const rollups = args.usageRollups.slice(0, days).sort((a, b) => a.day.localeCompare(b.day));
  const aggregate = { ...aggregateWeeklyRollups(rollups), driftDetections: args.upstreamDrift.openReportCount };
  const registeredRepos = args.repositories.filter((repo) => repo.isRegistered).length;
  const installedRepos = args.repositories.filter((repo) => repo.isInstalled).length;
  const unhealthyInstallations = args.health.filter((record) => record.status !== "healthy").length;
  const warnings = weeklyValueWarnings(args, rollups, unhealthyInstallations, variant);
  const metrics = buildWeeklyMetrics({
    activeActors: args.usageSummary.activeActors,
    aggregate,
    registeredRepos,
    installedRepos,
    installations: args.installations.length,
    unhealthyInstallations,
    activeSessions: args.activeSessions ?? 0,
    digestSubscriptions: args.digestSubscriptions ?? 0,
  });
  const summary = (
    variant === "public"
      ? [
          `Adoption: ${args.usageSummary.activeActors} active user(s) and ${aggregate.activeRepos} active repo(s) in the last ${days} day(s).`,
          `Usage: ${aggregate.mcpEvents} MCP event(s), ${aggregate.githubCommandEvents} GitHub command event(s), ${aggregate.prPreflights} PR preflight event(s), and ${aggregate.prPackets} PR packet event(s).`,
          `Maintainer value: ${aggregate.quietSkips} quiet skip(s), ${aggregate.maintainerSignals} maintainer-value signal(s), and ${aggregate.driftDetections} open drift report(s).`,
        ]
      : [
          `Adoption: ${args.usageSummary.activeActors} active user(s), ${aggregate.activeRepos} active repo(s), ${aggregate.totalEvents} product event(s) in the last ${days} day(s).`,
          `Usage: ${aggregate.mcpEvents} MCP event(s), ${aggregate.githubCommandEvents} GitHub command event(s), ${aggregate.prPreflights} PR preflight event(s), and ${aggregate.prPackets} PR packet event(s).`,
          `Maintainer value: ${aggregate.quietSkips} quiet skip(s), ${aggregate.maintainerSignals} maintainer-value signal(s), and ${aggregate.driftDetections} open drift report(s).`,
          `Coverage: ${registeredRepos} registered repo(s), ${installedRepos} installed repo(s), ${args.installations.length} GitHub App installation(s).`,
        ]
  ).map(sanitizeReportText);
  return {
    generatedAt: args.generatedAt,
    variant,
    publicSafe: variant === "public",
    period: {
      days,
      startDay: rollups[0]?.day ?? null,
      endDay: rollups.at(-1)?.day ?? null,
      rollupDays: rollups.map((rollup) => rollup.day),
    },
    summary,
    metrics: variant === "public" ? metrics.filter((metric) => metric.visibility === "public") : metrics,
    warnings,
    freshness: {
      status: args.usageRollupStatus.status,
      latestEventAt: args.usageRollupStatus.latestEventAt ?? null,
      latestRollupDay: args.usageRollupStatus.latestRollupDay ?? null,
      latestRollupGeneratedAt: args.usageRollupStatus.latestRollupGeneratedAt ?? null,
      warnings: variant === "operator" ? args.usageRollupStatus.warnings.map(sanitizeReportText) : publicFreshnessWarnings(args.usageRollupStatus),
    },
    dataQuality: {
      status: warnings.length > 0 ? "warn" : "ready",
      warnings,
    },
    ...(variant === "operator"
      ? {
          operatorDetails: {
            topRepos: aggregate.topRepos,
            topCommands: aggregate.topCommands,
            topTools: aggregate.topTools,
            topRouteClasses: aggregate.topRouteClasses,
            daily: rollups.map((rollup) => ({
              day: rollup.day,
              status: rollup.status,
              totalEvents: rollup.totalEvents,
              activeActors: rollup.activeActors,
              activeRepos: rollup.activeRepos,
            })),
            activation: aggregate.activation,
          },
        }
      : {}),
  };
}

export function formatWeeklyValueReportMarkdown(report: WeeklyValueReport): string {
  const lines = [
    "# Weekly Gittensory value report",
    "",
    `- Generated: ${markdownText(report.generatedAt)}`,
    `- Variant: ${markdownText(report.variant)}`,
    `- Window: ${report.period.days} day(s)${report.period.startDay && report.period.endDay ? `, ${markdownText(report.period.startDay)} to ${markdownText(report.period.endDay)}` : ""}`,
    `- Public-safe: ${report.publicSafe ? "yes" : "operator-only"}`,
    "",
    "## Summary",
    ...listLines(report.summary),
    "",
    "## Adoption metrics",
    ...metricLines(report, ["active_users", "active_repos", "product_events", "active_sessions", "digest_subscriptions"]),
    "",
    "## Miner utility",
    ...metricLines(report, ["mcp_usage", "pr_preflights", "pr_packets"]),
    "",
    "## Maintainer trust",
    ...metricLines(report, ["github_commands", "quiet_skips", "maintainer_signals", "drift_reports"]),
    "",
    "## Repo-owner readiness",
    ...metricLines(report, ["registered_repos", "installed_repos", "installations", "install_issues", "active_repos"]),
    "",
    "## Known blockers",
    ...knownBlockerLines(report),
    ...operatorDetailLines(report),
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function buildWeeklyMetrics(args: {
  activeActors: number;
  aggregate: WeeklyAggregate;
  registeredRepos: number;
  installedRepos: number;
  installations: number;
  unhealthyInstallations: number;
  activeSessions: number;
  digestSubscriptions: number;
}): WeeklyValueReportMetric[] {
  return [
    metric("active_users", "Active users", args.activeActors, "distinct hashed actors in the report window", "public"),
    metric("active_repos", "Active repos", args.aggregate.activeRepos, "unique sanitized repo buckets in rollups", "public"),
    metric("mcp_usage", "MCP usage", args.aggregate.mcpEvents, "MCP request and tool-call events", "public"),
    metric("github_commands", "GitHub commands", args.aggregate.githubCommandEvents, "command replies and quiet skips", "public"),
    metric("quiet_skips", "Quiet skips", args.aggregate.quietSkips, "commands intentionally skipped without public noise", "public"),
    metric("pr_preflights", "PRs preflighted", args.aggregate.prPreflights, "local branch and agent preflight events", "public"),
    metric("pr_packets", "PR packets", args.aggregate.prPackets, "maintainer packet generation events", "public"),
    metric("drift_reports", "Drift detections", args.aggregate.driftDetections, "open upstream drift reports", "public"),
    metric("maintainer_signals", "Maintainer value signals", args.aggregate.maintainerSignals, "maintainer command and activation signals", "public"),
    metric("product_events", "Product events", args.aggregate.totalEvents, "events represented by completed daily rollups", "operator"),
    metric("active_sessions", "Active sessions", args.activeSessions, "browser plus CLI/MCP sessions", "operator"),
    metric("digest_subscriptions", "Digest subscriptions", args.digestSubscriptions, "stored operator digest subscriptions", "operator"),
    metric("registered_repos", "Registered repos", args.registeredRepos, "repos tracked from the registry cache", "operator"),
    metric("installed_repos", "Installed repos", args.installedRepos, "repos with installation coverage in cache", "operator"),
    metric("installations", "Installations", args.installations, "GitHub App installations in cache", "operator"),
    metric("install_issues", "Install issues", args.unhealthyInstallations, "installation health records needing attention", "operator"),
  ];
}

function metric(id: string, label: string, value: number, detail: string, visibility: WeeklyValueReportMetric["visibility"]): WeeklyValueReportMetric {
  return { id, label, value, detail, visibility };
}

function aggregateWeeklyRollups(rollups: ProductUsageDailyRollupRecord[]): WeeklyAggregate {
  const repoEntries = rollups.flatMap((rollup) => rollup.byRepo);
  const topRepos = countDimensions(repoEntries);
  const githubCommandEvents = sumEvent(rollups, "agent_command_replied") + sumEvent(rollups, "agent_command_skipped");
  const quietSkips = sumEvent(rollups, "agent_command_skipped");
  const prPackets = sumEvent(rollups, "agent_pr_packet_completed");
  const prPreflights = sumEvent(rollups, "agent_preflight_branch_completed") + sumEvent(rollups, "local_branch_analysis_completed");
  return {
    totalEvents: sum(rollups.map((rollup) => rollup.totalEvents)),
    activeRepos: new Set(repoEntries.map((entry) => sanitizeReportText(entry.key)).filter(Boolean)).size,
    mcpEvents: sum(rollups.map((rollup) => rollup.bySurface.find((entry) => entry.surface === "mcp")?.count ?? 0)),
    githubCommandEvents,
    quietSkips,
    prPackets,
    prPreflights,
    maintainerSignals: githubCommandEvents + sum(rollups.map((rollup) => rollup.activation.githubUsefulMaintainerRepos)),
    driftDetections: 0,
    activation: {
      loginActors: sum(rollups.map((rollup) => rollup.activation.loginActors)),
      doctorPassActors: sum(rollups.map((rollup) => rollup.activation.doctorPassActors)),
      firstUsefulActionActors: sum(rollups.map((rollup) => rollup.activation.firstUsefulActionActors)),
      fullyActivatedActors: sum(rollups.map((rollup) => rollup.activation.fullyActivatedActors)),
      githubInstalledRepos: sum(rollups.map((rollup) => rollup.activation.githubInstalledRepos)),
      githubFirstCommandRepos: sum(rollups.map((rollup) => rollup.activation.githubFirstCommandRepos)),
      githubUsefulMaintainerRepos: sum(rollups.map((rollup) => rollup.activation.githubUsefulMaintainerRepos)),
      githubActivatedRepos: sum(rollups.map((rollup) => rollup.activation.githubActivatedRepos)),
    },
    topRepos,
    topCommands: countDimensions(rollups.flatMap((rollup) => rollup.byCommand)),
    topTools: countDimensions(rollups.flatMap((rollup) => rollup.byTool)),
    topRouteClasses: countDimensions(rollups.flatMap((rollup) => rollup.byRouteClass)),
  };
}

function publicFreshnessWarnings(status: ProductUsageRollupStatus): string[] {
  return status.warnings.length > 0 ? [`Product usage rollups have ${status.warnings.length} freshness warning(s).`] : [];
}

function weeklyValueWarnings(args: WeeklyValueReportInputs, rollups: ProductUsageDailyRollupRecord[], unhealthyInstallations: number, variant: WeeklyValueReportVariant): string[] {
  const detailed = variant === "operator";
  return [
    ...(rollups.length === 0 ? ["No daily product usage rollups are available for this report window."] : []),
    ...(rollups.length > 0 && rollups.length < normalizeReportDays(args.days) ? [`Only ${rollups.length} daily rollup(s) are available for this report window.`] : []),
    ...(detailed
      ? args.usageRollupStatus.warnings
      : args.usageRollupStatus.warnings.length > 0
        ? [`Product usage rollups have ${args.usageRollupStatus.warnings.length} freshness warning(s).`]
        : []),
    ...(args.usageRollupStatus.status === "stale" || args.usageRollupStatus.status === "incomplete" ? [`Product usage rollup status is ${args.usageRollupStatus.status}.`] : []),
    ...(args.registry
      ? detailed
        ? args.registry.warnings.map((warning) => `Registry warning: ${warning}`)
        : args.registry.warnings.length > 0
          ? [`Registry data has ${args.registry.warnings.length} warning(s).`]
          : []
      : ["Registry snapshot is missing."]),
    ...(args.scoring
      ? detailed
        ? args.scoring.warnings.map((warning) => `Scoring warning: ${warning}`)
        : args.scoring.warnings.length > 0
          ? [`Scoring model data has ${args.scoring.warnings.length} warning(s).`]
          : []
      : ["Scoring model snapshot is missing."]),
    ...(args.upstreamDrift.status === "current" ? [] : [`Upstream drift status is ${args.upstreamDrift.status}.`]),
    ...(unhealthyInstallations > 0 ? [`${unhealthyInstallations} installation health record(s) need attention.`] : []),
  ].map(sanitizeReportText);
}

function sumEvent(rollups: ProductUsageDailyRollupRecord[], eventName: string): number {
  return sum(rollups.map((rollup) => rollup.byEvent.find((entry) => entry.eventName === eventName)?.count ?? 0));
}

function countDimensions(entries: ProductUsageDimensionCount[], limit = 10): ProductUsageDimensionCount[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = sanitizeReportText(entry.key);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function metricLines(report: WeeklyValueReport, ids: string[]): string[] {
  const metrics = new Map(report.metrics.map((metric) => [metric.id, metric]));
  const lines = ids.flatMap((id) => {
    const metric = metrics.get(id);
    if (!metric) return [];
    const detail = markdownText(metric.detail);
    return [`- ${markdownText(metric.label)}: ${metric.value}${detail ? ` (${detail})` : ""}`];
  });
  return lines.length > 0 ? lines : ["- No rollup-backed metric is available for this section."];
}

function knownBlockerLines(report: WeeklyValueReport): string[] {
  const blockers = [...report.warnings, ...report.freshness.warnings];
  return blockers.length > 0 ? listLines([...new Set(blockers)]) : ["- No known blocker surfaced by the current report window."];
}

function operatorDetailLines(report: WeeklyValueReport): string[] {
  if (!report.operatorDetails) return [];
  return [
    "",
    "## Operator detail",
    `- Activation: ${report.operatorDetails.activation.fullyActivatedActors} fully activated actor(s), ${report.operatorDetails.activation.githubActivatedRepos} GitHub activated repo(s).`,
    ...dimensionLines("Top repos", report.operatorDetails.topRepos),
    ...dimensionLines("Top commands", report.operatorDetails.topCommands),
    ...dimensionLines("Top tools", report.operatorDetails.topTools),
    ...dimensionLines("Top route classes", report.operatorDetails.topRouteClasses),
  ];
}

function dimensionLines(title: string, entries: ProductUsageDimensionCount[]): string[] {
  if (entries.length === 0) return [];
  return [`- ${title}: ${entries.slice(0, 5).map((entry) => `${markdownText(entry.key)} (${entry.count})`).join(", ")}`];
}

function listLines(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${markdownText(item)}`) : ["- No report data available."];
}

function markdownText(value: string): string {
  return sanitizeReportText(value).replace(/\s+/g, " ").trim();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function normalizeReportDays(value: number | null | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 7;
  const rounded = Math.round(numeric);
  if (rounded === 0) return 7;
  return Math.max(1, Math.min(31, rounded));
}

function sanitizeReportText(value: string): string {
  const redacted = value
    .replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>")
    .replace(/\b(?:ghp_|github_pat_|gts_|glpat-|sk-|npm_|xox[baprs]-)[A-Za-z0-9_=-]{8,}/g, "<redacted-token>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted-token>");
  if (
    /\b(seed phrase|mnemonic|private key|raw[-\s]?trust|trust[-\s]?score|wallet|hotkey|coldkey|payout|reward(?:[-\s]?(?:estimate|prediction|claim|score|payout|risk))?|farming|private[-\s]?reviewability|private[-\s]?scoreability|scoreability|public[-\s]?score[-\s]?(?:estimate|prediction|claim)|score[-\s]?(?:estimate|prediction|preview))\b/i.test(
      redacted,
    )
  )
    return "<redacted>";
  return redacted.slice(0, 240);
}
