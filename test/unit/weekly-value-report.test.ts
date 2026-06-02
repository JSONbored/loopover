import { describe, expect, it } from "vitest";
import { buildWeeklyValueReport, formatWeeklyValueReportMarkdown, generateWeeklyValueReport } from "../../src/services/weekly-value-report";
import type {
  InstallationHealthRecord,
  InstallationRecord,
  ProductUsageDailyRollupRecord,
  ProductUsageRollupStatus,
  ProductUsageSummary,
  RegistrySnapshot,
  RepositoryRecord,
  ScoringModelSnapshotRecord,
} from "../../src/types";
import type { UpstreamStatus } from "../../src/upstream/ruleset";
import { createTestEnv } from "../helpers/d1";

const FORBIDDEN_EXPORT_TERMS =
  /wallet|hotkey|raw trust|trust[-\s]?score|payout|reward[-\s]?estimate|farming|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)|private[-\s]?scoreability|scoreability/i;

describe("weekly value reports", () => {
  it("builds public-safe adoption and maintainer-value summaries from daily rollups", () => {
    const report = buildWeeklyValueReport({
      generatedAt: "2026-06-01T12:00:00.000Z",
      variant: "public",
      days: 7,
      repositories: [repo("JSONbored/gittensory", true, true), repo("entrius/allways-ui", true, false)],
      installations: [installation(1)],
      health: [health(1, "healthy")],
      registry: registry(["/Users/operator/private-registry.json"]),
      scoring: scoring(["private reviewability source warning"]),
      upstreamDrift: upstream({ status: "current", openReportCount: 0 }),
      usageSummary: usageSummary({ totalEvents: 18, activeActors: 4 }),
      usageRollups: [
        rollup("2026-05-30", {
          totalEvents: 10,
          activeActors: 3,
          activeRepos: 2,
          repos: [
            { key: "JSONbored/gittensory", count: 6 },
            { key: "entrius/allways-ui", count: 4 },
          ],
          events: [
            { eventName: "mcp_request", count: 2 },
            { eventName: "mcp_tool_called", count: 1 },
            { eventName: "agent_command_replied", count: 2 },
            { eventName: "agent_command_skipped", count: 1 },
            { eventName: "agent_preflight_branch_completed", count: 1 },
            { eventName: "agent_pr_packet_completed", count: 1 },
          ],
          surfaces: [{ surface: "mcp", count: 3 }],
          commands: [{ key: "packet", count: 1 }],
          tools: [{ key: "gittensory_local_status", count: 1 }],
        }),
        rollup("2026-05-31", {
          totalEvents: 8,
          activeActors: 2,
          activeRepos: 1,
          repos: [{ key: "JSONbored/gittensory", count: 8 }],
          events: [
            { eventName: "local_branch_analysis_completed", count: 2 },
            { eventName: "agent_pr_packet_completed", count: 2 },
          ],
          surfaces: [{ surface: "api", count: 8 }],
          commands: [{ key: "reviewability", count: 2 }],
          tools: [],
        }),
      ],
      usageRollupStatus: rollupStatus({ status: "ready", warnings: ["github_pat_1234567890abcdef freshness detail"] }),
    });

    expect(report.publicSafe).toBe(true);
    expect(report.operatorDetails).toBeUndefined();
    expect(report.summary).toEqual(
      expect.arrayContaining([
        expect.stringContaining("4 active user(s) and 2 active repo(s)"),
        expect.stringContaining("3 MCP event(s), 3 GitHub command event(s), 3 PR preflight event(s), and 3 PR packet event(s)"),
        expect.stringContaining("1 quiet skip(s), 5 maintainer-value signal(s)"),
      ]),
    );
    expect(report.summary).not.toEqual(expect.arrayContaining([expect.stringMatching(/product event|registered repo|installed repo|GitHub App installation/i)]));
    expect(report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "active_users", value: 4, visibility: "public" }),
        expect.objectContaining({ id: "pr_packets", value: 3, visibility: "public" }),
      ]),
    );
    expect(report.metrics.some((metric) => metric.visibility === "operator")).toBe(false);
    expect(report.metrics.map((metric) => metric.id)).not.toEqual(expect.arrayContaining(["product_events", "registered_repos", "installed_repos", "installations"]));
    expect(report.warnings).toEqual(
      expect.arrayContaining(["Product usage rollups have 1 freshness warning(s).", "Registry data has 1 warning(s).", "Scoring model data has 1 warning(s)."]),
    );
    expect(report.freshness.warnings).toEqual(["Product usage rollups have 1 freshness warning(s)."]);
    expect(JSON.stringify(report)).not.toMatch(/wallet|hotkey|raw trust|payout|reward estimate|farming|private reviewability|public score estimate|\/Users|github_pat/i);

    const markdown = formatWeeklyValueReportMarkdown(report);
    expect(markdown).toContain("# Weekly Gittensory value report");
    expect(markdown).toContain("## Adoption metrics");
    expect(markdown).toContain("## Miner utility");
    expect(markdown).toContain("## Maintainer trust");
    expect(markdown).toContain("## Repo-owner readiness");
    expect(markdown).toContain("## Known blockers");
    expect(markdown).toContain("- Active users: 4");
    expect(markdown).toContain("- PR packets: 3");
    expect(markdown).not.toContain("## Operator detail");
    expect(markdown).not.toMatch(FORBIDDEN_EXPORT_TERMS);
  });

  it("adds operator details, freshness warnings, and redacts unsafe rollup dimensions", () => {
    const report = buildWeeklyValueReport({
      generatedAt: "2026-06-01T12:00:00.000Z",
      variant: "operator",
      days: 7,
      repositories: [repo("JSONbored/gittensory", true, true)],
      installations: [installation(1)],
      health: [health(1, "needs_attention")],
      registry: registry(["source mirror stale", "wallet hotkey reward-estimate trust-score public score prediction private scoreability farming"]),
      scoring: scoring(["fallback model", "private reviewability signal"]),
      upstreamDrift: upstream({ status: "drift_detected", openReportCount: 2 }),
      usageSummary: usageSummary({ totalEvents: 2, activeActors: 1 }),
      usageRollups: [
        rollup("2026-05-31", {
          totalEvents: 2,
          activeActors: 1,
          activeRepos: 1,
          repos: [{ key: "/Users/example/private github_pat_1234567890abcdef", count: 2 }],
          events: [{ eventName: "agent_command_skipped", count: 2 }],
          surfaces: [{ surface: "github_app", count: 2 }],
          commands: [
            { key: "Bearer abcdefghijklmnop", count: 1 },
            { key: "", count: 3 },
          ],
          tools: [{ key: "wallet raw trust", count: 1 }],
        }),
      ],
      usageRollupStatus: rollupStatus({ status: "stale", warnings: ["Product usage rollups are stale relative to the latest raw event."] }),
      activeSessions: 3,
      digestSubscriptions: 2,
    });

    expect(report.publicSafe).toBe(false);
    expect(report.operatorDetails).toMatchObject({
      topRepos: [{ key: "<redacted-path> <redacted-token>", count: 2 }],
      topCommands: [{ key: "Bearer <redacted-token>", count: 1 }],
      topTools: [{ key: "<redacted>", count: 1 }],
    });
    expect(report.summary).toEqual(
      expect.arrayContaining([
        expect.stringContaining("2 product event(s)"),
        expect.stringContaining("1 registered repo(s), 1 installed repo(s), 1 GitHub App installation(s)"),
      ]),
    );
    expect(report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "active_sessions", value: 3, visibility: "operator" }),
        expect.objectContaining({ id: "drift_reports", value: 2, visibility: "public" }),
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        "Product usage rollups are stale relative to the latest raw event.",
        "Product usage rollup status is stale.",
        "Registry warning: source mirror stale",
        "Scoring warning: fallback model",
        "Upstream drift status is drift_detected.",
        "1 installation health record(s) need attention.",
      ]),
    );
    expect(JSON.stringify(report)).not.toMatch(/\/Users|github_pat|wallet|raw trust|abcdef/i);

    const markdown = formatWeeklyValueReportMarkdown(report);
    expect(markdown).toContain("## Operator detail");
    expect(markdown).toContain("## Known blockers");
    expect(markdown).toContain("- Product events: 2");
    expect(markdown).toContain("Top repos: <redacted-path> <redacted-token> (2)");
    expect(markdown).toContain("<redacted>");
    expect(markdown).not.toMatch(FORBIDDEN_EXPORT_TERMS);
  });

  it("keeps clean complete windows marked ready", () => {
    const report = buildWeeklyValueReport({
      generatedAt: "2026-06-01T12:00:00.000Z",
      days: 1,
      repositories: [repo("JSONbored/gittensory", true, true)],
      installations: [installation(1)],
      health: [health(1, "healthy")],
      registry: registry([]),
      scoring: scoring([]),
      upstreamDrift: upstream({ status: "current", openReportCount: 0 }),
      usageSummary: usageSummary({ totalEvents: 1, activeActors: 1 }),
      usageRollups: [rollup("2026-05-31", { totalEvents: 1, activeActors: 1, activeRepos: 1, repos: [{ key: "JSONbored/gittensory", count: 1 }], events: [], surfaces: [], commands: [], tools: [] })],
      usageRollupStatus: rollupStatus({ status: "ready" }),
    });

    expect(report.period.days).toBe(1);
    expect(report.dataQuality).toEqual({ status: "ready", warnings: [] });

    const markdown = formatWeeklyValueReportMarkdown({
      ...report,
      summary: [],
      metrics: [],
      warnings: [],
      freshness: { ...report.freshness, warnings: [] },
      operatorDetails: {
        ...report.operatorDetails!,
        topRepos: [],
        topCommands: [],
        topTools: [],
        topRouteClasses: [],
      },
    });
    expect(markdown).toContain("- No report data available.");
    expect(markdown).toContain("- No rollup-backed metric is available for this section.");
    expect(markdown).toContain("- No known blocker surfaced by the current report window.");
    expect(markdown).toContain("## Operator detail");

    const { operatorDetails: _operatorDetails, ...reportWithoutOperatorDetails } = report;
    const sparseMarkdown = formatWeeklyValueReportMarkdown({
      ...reportWithoutOperatorDetails,
      period: { ...report.period, startDay: null, endDay: null },
      metrics: [{ id: "active_users", label: "Active users", value: 1, detail: "", visibility: "public" }],
    });
    expect(sparseMarkdown).toContain("- Window: 1 day(s)");
    expect(sparseMarkdown).toContain("- Active users: 1\n");
  });

  it("normalizes report windows and records public scheduled generations without operator details", async () => {
    const env = createTestEnv();

    const report = await generateWeeklyValueReport(env, { variant: "public", days: -5, nowIso: "2026-06-01T12:00:00.000Z" });

    expect(report).toMatchObject({
      variant: "public",
      publicSafe: true,
      period: expect.objectContaining({ days: 1 }),
    });
    expect(report).not.toHaveProperty("operatorDetails");
    const audit = await env.DB.prepare("select actor, target_key, metadata_json from audit_events where event_type = ?").bind("weekly_value_report_generated").first();
    expect(audit).toMatchObject({
      actor: "public-report",
      target_key: "weekly-value-report:public:1",
    });
    expect(JSON.parse(String(audit?.metadata_json))).toMatchObject({ variant: "public", days: 1, totalEvents: 0 });

    const zeroDefaulted = buildWeeklyValueReport({
      generatedAt: "2026-06-01T12:00:00.000Z",
      days: 0,
      repositories: [],
      installations: [],
      health: [],
      registry: null,
      scoring: null,
      upstreamDrift: upstream({ status: "unavailable", openReportCount: 0 }),
      usageSummary: usageSummary({ totalEvents: 0, activeActors: 0 }),
      usageRollups: [],
      usageRollupStatus: rollupStatus({ status: "empty" }),
    });
    expect(zeroDefaulted.period.days).toBe(7);

    const defaulted = buildWeeklyValueReport({
      generatedAt: "2026-06-01T12:00:00.000Z",
      repositories: [],
      installations: [],
      health: [],
      registry: null,
      scoring: null,
      upstreamDrift: upstream({ status: "unavailable", openReportCount: 0 }),
      usageSummary: usageSummary({ totalEvents: 0, activeActors: 0 }),
      usageRollups: [],
      usageRollupStatus: rollupStatus({ status: "empty" }),
    });
    expect(defaulted.period.days).toBe(7);

    const clamped = buildWeeklyValueReport({
      generatedAt: "2026-06-01T12:00:00.000Z",
      days: 99,
      repositories: [],
      installations: [],
      health: [],
      registry: null,
      scoring: null,
      upstreamDrift: upstream({ status: "unavailable", openReportCount: 0 }),
      usageSummary: usageSummary({ totalEvents: 0, activeActors: 0 }),
      usageRollups: [],
      usageRollupStatus: rollupStatus({ status: "empty" }),
    });
    expect(clamped.period.days).toBe(31);
  });
});

function repo(fullName: string, isRegistered: boolean, isInstalled: boolean): RepositoryRecord {
  return {
    fullName,
    owner: fullName.split("/")[0] ?? "owner",
    name: fullName.split("/")[1] ?? "repo",
    isPrivate: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${fullName}`,
    isRegistered,
    isInstalled,
  };
}

function installation(id: number): InstallationRecord {
  return {
    id,
    accountLogin: "repo-owner",
    accountId: id,
    targetType: "User",
    permissions: {},
    events: [],
  };
}

function health(installationId: number, status: InstallationHealthRecord["status"]): InstallationHealthRecord {
  return {
    installationId,
    accountLogin: "repo-owner",
    installedReposCount: 1,
    registeredInstalledCount: 1,
    status,
    missingPermissions: [],
    missingEvents: [],
    permissions: {},
    events: [],
    checkedAt: "2026-06-01T00:00:00.000Z",
  };
}

function registry(warnings: string[]): RegistrySnapshot {
  return {
    id: "registry",
    generatedAt: "2026-06-01T00:00:00.000Z",
    fetchedAt: "2026-06-01T00:00:00.000Z",
    source: { kind: "api", url: "https://example.test/registry.json" },
    repoCount: 2,
    totalEmissionShare: 0.1,
    warnings,
    repositories: [],
  };
}

function scoring(warnings: string[]): ScoringModelSnapshotRecord {
  return {
    id: "scoring",
    sourceKind: "test",
    sourceUrl: "test",
    fetchedAt: "2026-06-01T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {},
    programmingLanguages: {},
    warnings,
    payload: {},
  };
}

function upstream(input: Pick<UpstreamStatus, "status" | "openReportCount">): UpstreamStatus {
  return {
    generatedAt: "2026-06-01T00:00:00.000Z",
    status: input.status,
    latestCommitSha: "abc123",
    latestRulesetId: "ruleset",
    latestRulesetGeneratedAt: "2026-06-01T00:00:00.000Z",
    activeModel: "current_density_model",
    highestSeverity: null,
    affectedAreas: [],
    registryHyperparameterDrift: { totalEvents: 0, omittedEvents: 0, highImpactCount: 0, affectedRepoCount: 0, affectedFields: [], affectedSurfaces: [] },
    openReportCount: input.openReportCount,
    reports: [],
  };
}

function usageSummary(input: Pick<ProductUsageSummary, "totalEvents" | "activeActors">): ProductUsageSummary {
  return {
    since: "2026-05-25T00:00:00.000Z",
    totalEvents: input.totalEvents,
    activeActors: input.activeActors,
    bySurface: [],
    byOutcome: [],
    byEvent: [],
  };
}

function rollup(
  day: string,
  input: {
    totalEvents: number;
    activeActors: number;
    activeRepos: number;
    repos: ProductUsageDailyRollupRecord["byRepo"];
    events: ProductUsageDailyRollupRecord["byEvent"];
    surfaces: ProductUsageDailyRollupRecord["bySurface"];
    commands: ProductUsageDailyRollupRecord["byCommand"];
    tools: ProductUsageDailyRollupRecord["byTool"];
  },
): ProductUsageDailyRollupRecord {
  return {
    day,
    status: "complete",
    totalEvents: input.totalEvents,
    activeActors: input.activeActors,
    activeSessions: input.activeActors,
    activeRepos: input.activeRepos,
    sourceEventCount: input.totalEvents,
    maxEventCapacity: 5000,
    bySurface: input.surfaces,
    byOutcome: [],
    byEvent: input.events,
    byRepo: input.repos,
    byCommand: input.commands,
    byTool: input.tools,
    byRouteClass: [{ key: "agent", count: input.totalEvents }],
    activation: {
      loginActors: 0,
      doctorPassActors: 0,
      firstUsefulActionActors: 0,
      fullyActivatedActors: 0,
      githubInstalledRepos: 0,
      githubFirstCommandRepos: 1,
      githubUsefulMaintainerRepos: 1,
      githubActivatedRepos: 1,
    },
    byRole: [],
    activationByRole: [],
    activationBySurface: [],
    retention: [],
    generatedAt: `${day}T23:59:00.000Z`,
    updatedAt: `${day}T23:59:00.000Z`,
  };
}

function rollupStatus(input: Pick<ProductUsageRollupStatus, "status"> & { warnings?: string[] }): ProductUsageRollupStatus {
  return {
    status: input.status,
    generatedAt: "2026-06-01T00:00:00.000Z",
    latestEventAt: "2026-05-31T23:00:00.000Z",
    latestRollupDay: "2026-05-31",
    latestRollupGeneratedAt: "2026-06-01T00:00:00.000Z",
    missingDays: [],
    staleDays: [],
    incompleteDays: [],
    warnings: input.warnings ?? [],
  };
}
