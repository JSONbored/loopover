import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BarChart3, Check, Copy, FileJson } from "lucide-react";
import { toast } from "sonner";

import {
  BoundaryBadge,
  MiniSparkbar,
  Stat,
  StatusPill,
} from "@/components/site/control-primitives";
import { DeadLetterQueuePanel } from "@/components/site/dead-letter-queue-panel";
import { NotificationReadinessCard } from "@/components/site/notification-readiness-card";
import { StateBoundary } from "@/components/site/state-views";
import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { useApiResource } from "@/lib/api/use-api-resource";

export const Route = createFileRoute("/app/operator")({
  component: OperatorDashboard,
});

type OperatorDashboardResponse = {
  metrics: Array<{ label: string; value: string; delta: string }>;
  noiseReduction: Array<{ label: string; value: number; spark: number[] }>;
  weeklyReport: string[];
  recommendationQuality?: RecommendationQualityReport;
  fleetMetrics?: FleetMetrics;
  weeklyValueReport?: {
    freshness: { status: string; latestRollupDay?: string | null };
    warnings: string[];
    metrics: Array<{ id: string; label: string; value: number; detail: string }>;
  };
  upstreamDrift?: { status?: string } | null;
};

type FleetMetrics = {
  windowDays: number;
  instanceCount: number;
  fleet: {
    mergePrecision: number | null;
    closePrecision: number | null;
    fpRate: number | null;
    reversalRate: number | null;
    cycleP50Ms: number | null;
    cycleP95Ms: number | null;
  };
  outliers: Array<{ instanceId: string; metric: string; value: number; fleetMedian: number }>;
};

const formatPct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);
const formatMs = (v: number | null): string =>
  v === null
    ? "—"
    : v >= 3_600_000
      ? `${(v / 3_600_000).toFixed(1)}h`
      : `${Math.round(v / 60_000)}m`;

type RecommendationQualityReport = {
  windowDays: number;
  visibility: "operator_only";
  empty: boolean;
  sparse: boolean;
  totals: RecommendationQualityTotals;
  trends: Array<RecommendationQualityTotals & { periodStart: string; periodEnd: string }>;
  failureCategories: Array<{ category: string; label: string; count: number; detail: string }>;
  roleSurfaces: Array<
    RecommendationQualityTotals & {
      role: "miner" | "maintainer" | "owner" | "operator";
      label: string;
      topRepos: Array<{
        repoFullName: string;
        total: number;
        positive: number;
        negative: number;
        signal: "positive" | "negative" | "mixed";
      }>;
    }
  >;
  warnings: string[];
  publicExport: { available: false; reason: string };
  privateSummary: string;
};

type RecommendationQualityTotals = {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
  maintainerLaneTotal: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
};

type ReportExportFormat = "markdown" | "json";

function OperatorDashboard() {
  const dashboard = useApiResource<OperatorDashboardResponse>(
    "/v1/app/operator-dashboard",
    "Operator dashboard",
  );
  const [copiedExport, setCopiedExport] = useState<ReportExportFormat | null>(null);
  const data = dashboard.status === "ready" ? dashboard.data : null;
  const quality = data?.recommendationQuality;
  const copyWeeklyReport = async (format: ReportExportFormat) => {
    if (!data?.weeklyValueReport) return;
    try {
      const text =
        format === "json"
          ? JSON.stringify(data.weeklyValueReport, null, 2)
          : await loadWeeklyReportMarkdown();
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
      setCopiedExport(format);
      toast.success("Weekly report copied", {
        description: `${format === "json" ? "JSON" : "Markdown"} export copied.`,
      });
      window.setTimeout(() => setCopiedExport(null), 1400);
    } catch (error) {
      toast.error("Copy failed", {
        description:
          error instanceof Error && error.message
            ? `${error.message}. Select the report text and copy manually.`
            : "Select the report text and copy manually.",
      });
    }
  };

  return (
    <StateBoundary
      isLoading={dashboard.status === "loading"}
      isError={dashboard.status === "error"}
      isEmpty={dashboard.status === "ready" && dashboard.data.metrics.length === 0}
      onRetry={dashboard.reload}
      onRefresh={dashboard.reload}
      loadingTitle="Loading operator dashboard…"
      emptyTitle="No operator metrics yet"
      emptyDescription="Deployment health and value metrics appear once backend data is available."
      errorDescription={dashboard.status === "error" ? dashboard.error : undefined}
    >
      {data ? (
        <div className="space-y-8">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="font-mono text-token-2xs uppercase tracking-wider text-mint">
                Operator
              </div>
              <h1 className="mt-1 font-display text-token-2xl font-semibold tracking-tight">
                Usage & value
              </h1>
              <p className="mt-1 max-w-2xl text-token-sm text-muted-foreground">
                High-level deployment health and noise-reduction impact across all installations.
              </p>
            </div>
            <BoundaryBadge boundary="private-api" />
          </header>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.metrics.map((metric) => (
              <Stat
                key={metric.label}
                label={metric.label}
                value={metric.value}
                hint={metric.delta}
              />
            ))}
          </section>

          {data.fleetMetrics && data.fleetMetrics.instanceCount > 0 ? (
            <section className="rounded-token border border-border bg-transparent p-5">
              <div className="flex items-center gap-2">
                <BarChart3 className="size-4 text-mint" />
                <h2 className="font-display text-token-lg font-semibold">Fleet health</h2>
              </div>
              <p className="mt-1 max-w-2xl text-token-xs text-muted-foreground">
                Gate calibration aggregated (median) across {data.fleetMetrics.instanceCount}{" "}
                self-hosted instance(s) over the last {data.fleetMetrics.windowDays} days.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Stat
                  label="Merge precision"
                  value={formatPct(data.fleetMetrics.fleet.mergePrecision)}
                  hint="approve → merged"
                />
                <Stat
                  label="Close precision"
                  value={formatPct(data.fleetMetrics.fleet.closePrecision)}
                  hint="block → closed"
                />
                <Stat
                  label="False-positive rate"
                  value={formatPct(data.fleetMetrics.fleet.fpRate)}
                  hint="approve → reverted/closed"
                />
                <Stat
                  label="Reversal rate"
                  value={formatPct(data.fleetMetrics.fleet.reversalRate)}
                  hint="humans overrode the gate"
                />
                <Stat
                  label="Cycle time (p50)"
                  value={formatMs(data.fleetMetrics.fleet.cycleP50Ms)}
                  hint="decision → close"
                />
                <Stat
                  label="Instance outliers"
                  value={String(data.fleetMetrics.outliers.length)}
                  hint="off the fleet median"
                />
              </div>
            </section>
          ) : null}

          {quality ? (
            <section className="rounded-token border border-border bg-transparent p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <BarChart3 className="size-4 text-mint" />
                    <h2 className="font-display text-token-lg font-semibold">
                      Recommendation quality
                    </h2>
                  </div>
                  <p className="mt-1 max-w-2xl text-token-xs text-muted-foreground">
                    {quality.privateSummary}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusPill status={quality.empty ? "warn" : quality.sparse ? "stale" : "ready"}>
                    {quality.empty ? "empty" : quality.sparse ? "sparse" : "populated"}
                  </StatusPill>
                  <StatusPill status="info">{quality.windowDays}d</StatusPill>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Positive rate"
                  value={`${Math.round(quality.totals.positiveRate * 100)}%`}
                  hint={`${quality.totals.positive}/${quality.totals.total} evaluated`}
                />
                <Stat
                  label="Unresolved or negative"
                  value={quality.totals.negative}
                  hint="closed, stale, or unmatched"
                />
                <Stat
                  label="Maintainer lane"
                  value={quality.totals.maintainerLaneTotal}
                  hint="separated from contributor guidance"
                />
                <Stat
                  label="High confidence"
                  value={quality.totals.highConfidence}
                  hint={`${quality.totals.mediumConfidence} medium · ${quality.totals.lowConfidence} low`}
                />
              </div>

              <div className="mt-5 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
                <div>
                  <h3 className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    Role surfaces
                  </h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {quality.roleSurfaces.length ? (
                      quality.roleSurfaces.map((surface) => (
                        <div key={surface.role} className="rounded-token border border-border p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-token-sm font-medium text-foreground">
                                {surface.label}
                              </div>
                              <div className="mt-1 font-mono text-token-2xs text-muted-foreground">
                                {surface.positive} positive · {surface.negative} negative
                              </div>
                            </div>
                            <StatusPill status={qualityStatus(surface.positiveRate)}>
                              {Math.round(surface.positiveRate * 100)}%
                            </StatusPill>
                          </div>
                          {surface.topRepos.length ? (
                            <ul className="mt-3 space-y-1 text-token-xs text-muted-foreground">
                              {surface.topRepos.slice(0, 3).map((repo) => (
                                <li key={repo.repoFullName} className="flex justify-between gap-3">
                                  <span className="truncate">{repo.repoFullName}</span>
                                  <span className="font-mono">
                                    {repo.positive}/{repo.total}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-token border border-border p-3 text-token-sm text-muted-foreground sm:col-span-2">
                        No role-specific outcomes in this window.
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    Failure categories
                  </h3>
                  <div className="mt-3 space-y-3">
                    {quality.failureCategories.length ? (
                      quality.failureCategories.map((category) => (
                        <div key={category.category}>
                          <div className="flex items-center justify-between gap-3 text-token-sm">
                            <span className="text-foreground/90">{category.label}</span>
                            <span className="font-mono text-muted-foreground">
                              {category.count}
                            </span>
                          </div>
                          <p className="mt-0.5 text-token-xs text-muted-foreground">
                            {category.detail}
                          </p>
                        </div>
                      ))
                    ) : (
                      <div className="text-token-sm text-muted-foreground">
                        No failure categories in this window.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {quality.trends.length ? (
                <div className="mt-5">
                  <h3 className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    Trend
                  </h3>
                  <div className="mt-3 flex h-20 items-end gap-1">
                    {quality.trends.map((bucket) => (
                      <div
                        key={bucket.periodStart}
                        className="min-w-0 flex-1 rounded-token bg-mint/45"
                        title={`${new Date(bucket.periodStart).toLocaleDateString()} · ${bucket.positive}/${bucket.total}`}
                        style={{ height: `${Math.max(6, bucket.positiveRate * 100)}%` }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {quality.warnings.length ? (
                <ul className="mt-4 space-y-1 text-token-xs text-muted-foreground">
                  {quality.warnings.slice(0, 3).map((warning) => (
                    <li key={warning}>· {warning}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-token border border-border bg-transparent p-5">
              <h2 className="font-display text-token-lg font-semibold">Noise reduction</h2>
              <div className="mt-4 space-y-4">
                {data.noiseReduction.map((metric) => (
                  <div key={metric.label} className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-token-sm text-foreground/90">{metric.label}</div>
                      <div className="font-mono text-token-2xs text-muted-foreground">
                        total {metric.value}
                      </div>
                    </div>
                    <MiniSparkbar values={metric.spark} className="w-40" />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-token border border-border bg-transparent p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-token-lg font-semibold">Weekly value report</h2>
                  <p className="mt-1 text-token-xs text-muted-foreground">
                    Rollup-backed summary across usage, maintenance, and drift signals.
                  </p>
                </div>
                {data.weeklyValueReport ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void copyWeeklyReport("markdown")}
                      aria-label="Copy weekly report Markdown"
                      title="Copy weekly report Markdown"
                      className="inline-flex h-8 items-center gap-1.5 rounded-token border border-border bg-transparent px-2.5 text-token-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-ring motion-reduce:transition-none"
                    >
                      {copiedExport === "markdown" ? (
                        <Check className="size-3.5 text-mint" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      Markdown
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyWeeklyReport("json")}
                      aria-label="Copy weekly report JSON"
                      title="Copy weekly report JSON"
                      className="inline-flex h-8 items-center gap-1.5 rounded-token border border-border bg-transparent px-2.5 text-token-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-ring motion-reduce:transition-none"
                    >
                      {copiedExport === "json" ? (
                        <Check className="size-3.5 text-mint" />
                      ) : (
                        <FileJson className="size-3.5" />
                      )}
                      JSON
                    </button>
                  </div>
                ) : null}
              </div>
              {data.weeklyValueReport ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusPill
                    status={data.weeklyValueReport.warnings.length > 0 ? "degraded" : "ready"}
                  >
                    Rollups{" "}
                    {data.weeklyValueReport.freshness.latestRollupDay ??
                      data.weeklyValueReport.freshness.status}
                  </StatusPill>
                  <StatusPill status={data.upstreamDrift?.status === "current" ? "ready" : "warn"}>
                    Drift · {data.upstreamDrift?.status ?? "unknown"}
                  </StatusPill>
                </div>
              ) : null}
              <ul className="mt-4 space-y-2 text-token-sm text-foreground/90">
                {data.weeklyReport.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
              {data.weeklyValueReport?.warnings.length ? (
                <ul className="mt-4 space-y-1 text-token-xs text-muted-foreground">
                  {data.weeklyValueReport.warnings.slice(0, 3).map((warning) => (
                    <li key={warning}>· {warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
          <DeadLetterQueuePanel />
          <NotificationReadinessCard />
        </div>
      ) : null}
    </StateBoundary>
  );
}

function qualityStatus(rate: number): "ready" | "warn" | "stale" {
  if (rate >= 0.67) return "ready";
  if (rate >= 0.4) return "stale";
  return "warn";
}

async function loadWeeklyReportMarkdown(): Promise<string> {
  const result = await apiFetch<string>(
    `${getApiOrigin().replace(/\/$/, "")}/v1/app/analytics/weekly-value-report?variant=operator&format=markdown`,
    {
      label: "Weekly report export",
      credentials: "include",
      headers: { Accept: "text/markdown" },
      parse: (res) => res.text(),
    },
  );
  if (!result.ok) throw new Error(result.message);
  return result.data;
}
