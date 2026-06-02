import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, FileJson } from "lucide-react";
import { toast } from "sonner";

import {
  BoundaryBadge,
  MiniSparkbar,
  Stat,
  StatusPill,
} from "@/components/site/control-primitives";
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
  weeklyValueReport?: {
    freshness: { status: string; latestRollupDay?: string | null };
    warnings: string[];
    metrics: Array<{ id: string; label: string; value: number; detail: string }>;
  };
  upstreamDrift?: { status?: string } | null;
};

type ReportExportFormat = "markdown" | "json";

function OperatorDashboard() {
  const dashboard = useApiResource<OperatorDashboardResponse>(
    "/v1/app/operator-dashboard",
    "Operator dashboard",
  );
  const [copiedExport, setCopiedExport] = useState<ReportExportFormat | null>(null);
  const data = dashboard.status === "ready" ? dashboard.data : null;
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
          <NotificationReadinessCard />
        </div>
      ) : null}
    </StateBoundary>
  );
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
