import { createFileRoute } from "@tanstack/react-router";

import { BoundaryBadge, Stat, StatusPill } from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
import { TrendChart } from "@/components/site/trend-chart";
import {
  AdoptionRetentionPanel,
  CommandUsefulnessPanel,
  ProductUsageBreakdownPanel,
  WeeklyValueMetricsPanel,
} from "@/components/site/usage-analytics-panels";
import { useApiResource } from "@/lib/api/use-api-resource";

export const Route = createFileRoute("/app/analytics")({
  component: ProductAnalytics,
});

type OperatorDashboard = {
  metrics: Array<{ label: string; value: string; delta: string }>;
  noiseReduction: Array<{ label: string; value: number; spark: number[] }>;
  usageSummary?: {
    totalEvents: number;
    activeActors: number;
    byEvent: Array<{ eventName: string; count: number }>;
    bySurface: Array<{ surface: string; count: number }>;
  };
  usageRollupStatus?: {
    status: "empty" | "ready" | "partial" | "stale" | "incomplete";
    latestRollupDay?: string | null;
    warnings: string[];
  };
  usageRollups?: Array<{
    day: string;
    status: "complete" | "partial" | "incomplete";
    totalEvents: number;
    activeActors: number;
    activeRepos: number;
    byRole: Array<{ role: string; count: number; activeActors: number; activeRepos: number }>;
    activationByRole: Array<{
      role: string;
      firstUsefulActionActors: number;
      doctorPassActors: number;
    }>;
    retention: Array<{
      window: string;
      activeActors: number;
      retainedActors: number;
      retentionRate: number;
      capped: boolean;
      byRole: Array<{
        role: string;
        activeActors: number;
        retainedActors: number;
        retentionRate: number;
      }>;
    }>;
    byTool?: Array<{ key: string; count: number }>;
    activation: {
      fullyActivatedActors: number;
      githubActivatedRepos: number;
    };
  }>;
  weeklyValueReport?: {
    metrics: Array<{ id: string; label: string; value: number; detail: string }>;
    warnings: string[];
    freshness: { status: string; latestRollupDay?: string | null };
  };
  commandUsefulness?: {
    windowDays: number;
    totals: {
      feedbackCount: number;
      usefulCount: number;
      notUsefulCount: number;
      answerCount: number;
      usefulnessRate: number | null;
    };
    commands: Array<{
      command: string;
      feedbackCount: number;
      usefulCount: number;
      notUsefulCount: number;
      usefulnessRate: number | null;
    }>;
  };
  mcpCompatibilityAdoption?: {
    totalEvents: number;
    activeActors: number;
    staleEvents: number;
    incompatibleEvents: number;
    minimumSupportedVersion: string;
    latestRecommendedVersion: string;
    truncated: boolean;
    byClientVersion: Array<{ key: string; count: number }>;
    byProtocolVersion: Array<{ key: string; count: number }>;
    byCompatibilityStatus: Array<{
      status: "current" | "stale" | "incompatible" | "unknown";
      count: number;
    }>;
  };
  upstreamDrift?: { status?: string; openReportCount?: number } | null;
};

function ProductAnalytics() {
  const dashboard = useApiResource<OperatorDashboard>(
    "/v1/app/operator-dashboard",
    "Product analytics",
  );
  const data = dashboard.status === "ready" ? dashboard.data : null;
  const latestRollup =
    data?.usageRollups && data.usageRollups.length > 0
      ? [...data.usageRollups].sort((a, b) => b.day.localeCompare(a.day))[0]
      : null;

  return (
    <StateBoundary
      isLoading={dashboard.status === "loading"}
      isError={dashboard.status === "error"}
      isEmpty={dashboard.status === "ready" && dashboard.data.metrics.length === 0}
      onRetry={dashboard.reload}
      onRefresh={dashboard.reload}
      loadingTitle="Loading analytics…"
      emptyTitle="No analytics yet"
      emptyDescription="Aggregate adoption and command usage metrics will appear once the API has data."
      errorDescription={dashboard.status === "error" ? dashboard.error : undefined}
    >
      {data ? (
        <div className="space-y-8">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="font-mono text-token-2xs uppercase tracking-wider text-mint">
                Analytics
              </div>
              <h1 className="mt-1 font-display text-token-2xl font-semibold tracking-tight">
                Usage & value analytics
              </h1>
              <p className="mt-1 max-w-2xl text-token-sm text-muted-foreground">
                Operator-facing adoption, activation, retention, and ecosystem value from product
                usage rollups — not security audit logs or private source data.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill
                status={
                  data.usageRollupStatus?.status === "ready" ||
                  data.usageRollupStatus?.status === "partial"
                    ? "ready"
                    : data.usageRollupStatus?.status === "empty"
                      ? "info"
                      : "degraded"
                }
              >
                {data.usageRollupStatus?.status ?? "Live API"}
              </StatusPill>
              {data.upstreamDrift?.status ? (
                <StatusPill status={data.upstreamDrift.status === "current" ? "ready" : "warn"}>
                  Drift · {data.upstreamDrift.status}
                </StatusPill>
              ) : null}
              <BoundaryBadge boundary="private-api" />
            </div>
          </header>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.metrics.map((metric) => (
              <Stat
                key={metric.label}
                label={metric.label}
                value={metric.value}
                hint={<span className="text-mint">{metric.delta}</span>}
              />
            ))}
          </section>

          {data.weeklyValueReport ? (
            <WeeklyValueMetricsPanel
              metrics={data.weeklyValueReport.metrics}
              warnings={data.weeklyValueReport.warnings}
            />
          ) : null}

          {data.usageSummary ? (
            <ProductUsageBreakdownPanel
              byEvent={data.usageSummary.byEvent}
              bySurface={data.usageSummary.bySurface}
              byTool={latestRollup?.byTool}
            />
          ) : null}

          {latestRollup ? (
            <AdoptionRetentionPanel
              byRole={latestRollup.byRole}
              retention={latestRollup.retention}
              activationByRole={latestRollup.activationByRole}
            />
          ) : null}

          {data.commandUsefulness ? (
            <CommandUsefulnessPanel
              totals={data.commandUsefulness.totals}
              commands={data.commandUsefulness.commands}
              windowDays={data.commandUsefulness.windowDays}
            />
          ) : null}

          <section className="rounded-token border border-border bg-transparent p-5">
            <h2 className="font-display text-token-lg font-semibold">Operational trend signals</h2>
            <p className="mt-1 text-token-xs text-muted-foreground">
              Current cached values from app health, repository coverage, and installation health.
            </p>
            <div className="mt-4 grid gap-6 lg:grid-cols-3">
              {data.noiseReduction.map((signal) => (
                <div
                  key={signal.label}
                  className="rounded-token border border-border bg-background/40 p-3"
                >
                  <div className="flex items-center justify-between text-token-xs">
                    <span className="text-muted-foreground">{signal.label}</span>
                    <span className="font-mono text-mint">{signal.value}</span>
                  </div>
                  <div className="mt-3 h-20 w-full">
                    <TrendChart values={signal.spark} height={80} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {data.mcpCompatibilityAdoption ? (
            <section className="rounded-token border border-border bg-transparent p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-token-lg font-semibold">
                    MCP compatibility adoption
                  </h2>
                  <p className="mt-1 text-token-xs text-muted-foreground">
                    Version distribution from redacted MCP product events.
                  </p>
                </div>
                <StatusPill
                  status={
                    data.mcpCompatibilityAdoption.incompatibleEvents > 0
                      ? "degraded"
                      : data.mcpCompatibilityAdoption.staleEvents > 0
                        ? "info"
                        : "ready"
                  }
                >
                  {data.mcpCompatibilityAdoption.latestRecommendedVersion}
                </StatusPill>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="MCP events"
                  value={String(data.mcpCompatibilityAdoption.totalEvents)}
                  hint={<span className="text-muted-foreground">last 7 days</span>}
                />
                <Stat
                  label="Active clients"
                  value={String(data.mcpCompatibilityAdoption.activeActors)}
                  hint={<span className="text-muted-foreground">hashed actors</span>}
                />
                <Stat
                  label="Stale clients"
                  value={String(data.mcpCompatibilityAdoption.staleEvents)}
                  hint={<span className="text-muted-foreground">upgrade available</span>}
                />
                <Stat
                  label="Unsupported"
                  value={String(data.mcpCompatibilityAdoption.incompatibleEvents)}
                  hint={
                    <span className="text-muted-foreground">
                      min {data.mcpCompatibilityAdoption.minimumSupportedVersion}
                    </span>
                  }
                />
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <CompatibilityList
                  title="Client versions"
                  rows={data.mcpCompatibilityAdoption.byClientVersion}
                />
                <CompatibilityList
                  title="Protocol versions"
                  rows={data.mcpCompatibilityAdoption.byProtocolVersion}
                />
                <CompatibilityList
                  title="Compatibility"
                  rows={data.mcpCompatibilityAdoption.byCompatibilityStatus.map((row) => ({
                    key: row.status,
                    count: row.count,
                  }))}
                />
              </div>
              {data.mcpCompatibilityAdoption.truncated ? (
                <p className="mt-3 text-token-xs text-muted-foreground">
                  Displayed distribution is capped to keep dashboard reads bounded.
                </p>
              ) : null}
            </section>
          ) : null}

          {data.usageRollups && data.usageRollups.length > 0 ? (
            <section className="rounded-token border border-border bg-transparent p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-token-lg font-semibold">
                    Daily activation rollups
                  </h2>
                  <p className="mt-1 text-token-xs text-muted-foreground">
                    Hashed actor, repo, command, tool, and maintainer-action funnels by UTC day.
                  </p>
                </div>
                <StatusPill status={data.usageRollupStatus?.warnings.length ? "degraded" : "ready"}>
                  {data.usageRollupStatus?.latestRollupDay ?? "current"}
                </StatusPill>
              </div>
              {data.usageRollupStatus?.warnings.length ? (
                <ul className="mt-3 space-y-1 text-token-xs text-amber-200/90">
                  {data.usageRollupStatus.warnings.slice(0, 4).map((warning) => (
                    <li key={warning}>· {warning}</li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-token-sm">
                  <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Day</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Events</th>
                      <th className="py-2 pr-4 font-medium">Actors</th>
                      <th className="py-2 pr-4 font-medium">Repos</th>
                      <th className="py-2 pr-4 font-medium">Activated</th>
                      <th className="py-2 font-medium">GitHub activated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.usageRollups.slice(0, 7).map((rollup) => (
                      <tr key={rollup.day} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-4 font-mono text-token-xs">{rollup.day}</td>
                        <td className="py-2 pr-4">{rollup.status}</td>
                        <td className="py-2 pr-4 font-mono">{rollup.totalEvents}</td>
                        <td className="py-2 pr-4 font-mono">{rollup.activeActors}</td>
                        <td className="py-2 pr-4 font-mono">{rollup.activeRepos}</td>
                        <td className="py-2 pr-4 font-mono">
                          {rollup.activation.fullyActivatedActors}
                        </td>
                        <td className="py-2 font-mono">{rollup.activation.githubActivatedRepos}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </StateBoundary>
  );
}

function CompatibilityList({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; count: number }>;
}) {
  return (
    <div className="rounded-token border border-border bg-background/40 p-3">
      <div className="text-token-xs font-medium uppercase text-muted-foreground">{title}</div>
      <div className="mt-3 space-y-2">
        {rows.length > 0 ? (
          rows.slice(0, 5).map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-3 text-token-sm">
              <span className="min-w-0 truncate font-mono text-token-xs">{row.key}</span>
              <span className="font-mono text-mint">{row.count}</span>
            </div>
          ))
        ) : (
          <div className="text-token-xs text-muted-foreground">No events</div>
        )}
      </div>
    </div>
  );
}
