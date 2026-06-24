import { BarChart3, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { StatusPill, type Status } from "@/components/site/control-primitives";
import { StatCard } from "@/components/site/primitives";
import { LoadingState } from "@/components/site/state-views";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { extractPreviewRepoOptions, splitRepoFullName } from "@/lib/maintainer-settings-preview";

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

type RecommendationQualityFailureCategory = {
  category: string;
  label: string;
  count: number;
  detail: string;
};

type RepoRecommendationQualityReport = {
  repoFullName: string;
  generatedAt: string;
  windowDays: number;
  totals: RecommendationQualityTotals;
  failureCategories: RecommendationQualityFailureCategory[];
  warnings: string[];
  summary: string;
};

const SIGNAL_TONE: Record<string, Status> = {
  positive: "ok",
  mixed: "warn",
  negative: "blocked",
  neutral: "info",
};

function signalFor(
  totals: RecommendationQualityTotals,
): "positive" | "negative" | "mixed" | "neutral" {
  if (totals.total === 0) return "neutral";
  if (totals.positive === 0 && totals.negative > 0) return "negative";
  if (totals.negative === 0 && totals.positive > 0) return "positive";
  return "mixed";
}

export function MaintainerRecommendationQualityPanel({
  reviewability,
}: {
  reviewability: Array<{
    pr: string;
    title: string;
    author: string;
    bucket: string;
    reason: string;
  }>;
}) {
  const repoOptions = useMemo(() => extractPreviewRepoOptions(reviewability), [reviewability]);
  const [repoFullName, setRepoFullName] = useState(repoOptions[0] ?? "");
  const [windowDays, setWindowDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RepoRecommendationQualityReport | null>(null);

  useEffect(() => {
    if (!repoFullName && repoOptions[0]) setRepoFullName(repoOptions[0]);
  }, [repoFullName, repoOptions]);

  async function load() {
    const target = splitRepoFullName(repoFullName);
    if (!target) {
      setReport(null);
      setError("Enter a repository as owner/repo.");
      return;
    }
    setBusy(true);
    setError(null);
    const url = `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/recommendation-quality?windowDays=${windowDays}`;
    const result = await apiFetch<RepoRecommendationQualityReport>(url, {
      method: "GET",
      label: "Recommendation quality",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    setBusy(false);
    if (result.ok) {
      setReport(result.data);
      return;
    }
    setReport(null);
    setError(result.message);
  }

  useEffect(() => {
    // Auto-load once a repo is present so the panel isn't empty for maintainers.
    if (splitRepoFullName(repoFullName)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tone = report ? (SIGNAL_TONE[signalFor(report.totals)] ?? "info") : "info";
  const resolved = report ? report.totals.positive + report.totals.negative : 0;
  const positiveRate = report
    ? resolved > 0
      ? Math.round((report.totals.positive / resolved) * 100)
      : null
    : null;

  return (
    <section className="rounded-token border-hairline bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-token-sm font-medium">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            Recommendation quality
          </div>
          <div className="mt-1 text-token-xs text-muted-foreground">
            Repo-scoped calibration of recommendation outcomes (merged/accepted vs closed/rejected)
            over a rolling window.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-token border-hairline bg-background px-3 py-1.5 text-token-xs font-medium text-foreground transition hover:bg-muted/50 disabled:opacity-60"
        >
          <RefreshCw className={busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          Refresh
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1 text-token-xs">
          <div className="text-muted-foreground">Repository</div>
          <input
            value={repoFullName}
            onChange={(e) => setRepoFullName(e.target.value)}
            list="recommendation-quality-repos"
            className="w-full rounded-token border-hairline bg-background px-3 py-2 text-token-sm"
            placeholder="owner/repo"
          />
          <datalist id="recommendation-quality-repos">
            {repoOptions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </label>

        <label className="space-y-1 text-token-xs">
          <div className="text-muted-foreground">Window</div>
          <select
            value={String(windowDays)}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="w-full rounded-token border-hairline bg-background px-3 py-2 text-token-sm"
          >
            {[14, 30, 60, 90, 180].map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="w-full rounded-token bg-primary px-3 py-2 text-token-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
          >
            Load report
          </button>
        </div>
      </div>

      {busy && !report ? <LoadingState title="Loading recommendation quality…" /> : null}

      {error ? (
        <div className="mt-4 rounded-token border border-warning/30 bg-warning/[0.04] p-4 text-token-sm text-warning">
          Recommendation quality is unavailable right now ({error}).
        </div>
      ) : null}

      {report ? (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={tone}>
              {signalFor(report.totals)}{" "}
              {positiveRate === null ? "" : `· ${positiveRate}% positive`}
            </StatusPill>
            <span className="text-token-xs text-muted-foreground">{report.summary}</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total"
              value={String(report.totals.total)}
              hint={
                <span className="text-token-xs text-muted-foreground">{report.windowDays}d</span>
              }
            />
            <StatCard
              label="Positive"
              value={String(report.totals.positive)}
              hint={
                <span className="text-token-xs text-muted-foreground">
                  merged/accepted/improved
                </span>
              }
            />
            <StatCard
              label="Negative"
              value={String(report.totals.negative)}
              hint={<span className="text-token-xs text-muted-foreground">closed/rejected</span>}
            />
            <StatCard
              label="Pending"
              value={String(
                Math.max(0, report.totals.total - report.totals.positive - report.totals.negative),
              )}
              hint={<span className="text-token-xs text-muted-foreground">stale/ignored</span>}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-token border-hairline bg-background p-4">
              <div className="text-token-sm font-medium">Top failure categories</div>
              <div className="mt-1 text-token-xs text-muted-foreground">
                What negative or unresolved outcomes look like for this repo in this window.
              </div>
              <ul className="mt-3 space-y-2 text-token-sm">
                {(report.failureCategories ?? []).slice(0, 6).map((row) => (
                  <li
                    key={`${row.category}-${row.label}`}
                    className="flex items-start justify-between gap-3"
                  >
                    <div>
                      <div className="font-medium">{row.label}</div>
                      <div className="text-token-xs text-muted-foreground">{row.detail}</div>
                    </div>
                    <div className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-token-xs text-muted-foreground">
                      {row.count}
                    </div>
                  </li>
                ))}
                {report.failureCategories.length === 0 ? (
                  <li className="text-token-xs text-muted-foreground">
                    No failures are recorded in this window.
                  </li>
                ) : null}
              </ul>
            </div>

            <div className="rounded-token border-hairline bg-background p-4">
              <div className="text-token-sm font-medium">Warnings</div>
              <div className="mt-1 text-token-xs text-muted-foreground">
                Data sparsity or interpretation caveats. Treat as directional when sparse.
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-token-sm text-muted-foreground">
                {(report.warnings ?? []).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
                {report.warnings.length === 0 ? <li>None.</li> : null}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
