import { createFileRoute } from "@tanstack/react-router";

import { BoundaryBadge, Stat, StatusPill } from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
import { TrendChart } from "@/components/site/trend-chart";
import { useApiResource } from "@/lib/api/use-api-resource";

export const Route = createFileRoute("/app/analytics")({
  component: ProductAnalytics,
});

type OperatorDashboard = {
  metrics: Array<{ label: string; value: string; delta: string }>;
  noiseReduction: Array<{ label: string; value: number; spark: number[] }>;
};

function ProductAnalytics() {
  const dashboard = useApiResource<OperatorDashboard>(
    "/v1/app/operator-dashboard",
    "Product analytics",
  );
  const data = dashboard.status === "ready" ? dashboard.data : null;

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
                Product analytics
              </h1>
              <p className="mt-1 max-w-2xl text-token-sm text-muted-foreground">
                Aggregate deployment, session, digest, and installation metrics from the live API.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill status="ready">Live API</StatusPill>
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
        </div>
      ) : null}
    </StateBoundary>
  );
}
