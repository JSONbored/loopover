import { useCallback, useEffect, useState } from "react";

import { StateBoundary } from "@/components/site/state-views";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { extractPreviewRepoOptions, splitRepoFullName } from "@/lib/maintainer-settings-preview";

export type AmsMinerCohortMetrics = {
  submitterCount: number;
  prVolume: number;
  acceptanceRate: number | null;
  avgReviewCycleCount: number | null;
  avgTimeToMergeMs: number | null;
};

export type AmsMinerCohortComparison = {
  present: boolean;
  windowDays: number;
  totalSubmitterCount: number;
  checkedSubmitterCount: number;
  amsCohort: AmsMinerCohortMetrics;
  humanCohort: AmsMinerCohortMetrics;
};

function repoApiBase(repoFullName: string): string | null {
  const target = splitRepoFullName(repoFullName);
  if (!target) return null;
  return `${getApiOrigin().replace(/\/$/, "")}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const hours = ms / (1000 * 60 * 60);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function CohortColumn({ title, metrics }: { title: string; metrics: AmsMinerCohortMetrics }) {
  return (
    <div className="rounded-token border border-border/60 bg-background/40 p-4">
      <h3 className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-token-sm">
        <div>
          <dt className="text-token-2xs text-muted-foreground">Submitters</dt>
          <dd className="font-display text-token-lg font-semibold">{metrics.submitterCount}</dd>
        </div>
        <div>
          <dt className="text-token-2xs text-muted-foreground">PR volume</dt>
          <dd className="font-display text-token-lg font-semibold">{metrics.prVolume}</dd>
        </div>
        <div>
          <dt className="text-token-2xs text-muted-foreground">Acceptance rate</dt>
          <dd className="font-display text-token-lg font-semibold">
            {formatPercent(metrics.acceptanceRate)}
          </dd>
        </div>
        <div>
          <dt className="text-token-2xs text-muted-foreground">Review-cycle count</dt>
          <dd className="font-display text-token-lg font-semibold">
            {formatCount(metrics.avgReviewCycleCount)}
          </dd>
        </div>
        <div>
          <dt className="text-token-2xs text-muted-foreground">Time to merge</dt>
          <dd className="font-display text-token-lg font-semibold">
            {formatDuration(metrics.avgTimeToMergeMs)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * AMS-vs-human contributor-mix dashboard panel (#6488), per #6210's decided design: for a selected repo,
 * compares identifiable AMS miners against every other submitter on acceptance rate / review-cycle count /
 * time-to-merge / PR volume. Reuses the ActivationPreview repo-picker + self-fetch shape in this same file
 * group. `present: false` from the API (bridge off, unconfigured, or zero submitter activity) renders the
 * SAME empty state -- never an error, matching #6488's own required empty-state behavior.
 */
export function AmsMinerCohortCard({ reviewability }: { reviewability: Array<{ pr: string }> }) {
  const repoOptions = extractPreviewRepoOptions(reviewability);
  const [repoFullName, setRepoFullName] = useState(repoOptions[0] ?? "");
  const [comparison, setComparison] = useState<AmsMinerCohortComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const base = repoApiBase(repoFullName);
  const hasRepos = repoOptions.length > 0;

  // isCancelled guards against an out-of-order response: a keystroke replaces repoFullName (and re-runs the
  // effect) before an earlier request resolves, so an older fetch must not overwrite the newer repo's state
  // (#7784). Same cancelled-flag idiom as use-polled-fetch.ts -- the flag is flipped in the effect cleanup.
  const load = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const apiBase = repoApiBase(repoFullName);
      if (!apiBase) {
        setComparison(null);
        setLoadError(null);
        return;
      }
      setLoadError(null);
      setLoading(true);
      const result = await apiFetch<AmsMinerCohortComparison>(`${apiBase}/ams-miner-cohort`, {
        label: "AMS miner cohort comparison",
        credentials: "include",
        silentStatus: true,
      });
      if (isCancelled()) return;
      if (result.ok) {
        setComparison(result.data);
      } else {
        setComparison(null);
        setLoadError(result.message);
      }
      setLoading(false);
    },
    [repoFullName],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <section
      className="rounded-token border-hairline bg-card p-5"
      aria-labelledby="ams-miner-cohort-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="ams-miner-cohort-title" className="font-display text-token-lg font-semibold">
            AMS contributor mix
          </h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            How much of this repo's activity comes from identifiable AMS miners, and how that cohort
            performs relative to other contributors.
          </p>
        </div>
      </div>

      <label className="mt-4 block max-w-sm">
        <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          Repository
        </span>
        <input
          value={repoFullName}
          onChange={(event) => setRepoFullName(event.target.value)}
          list="ams-miner-cohort-repos"
          placeholder="owner/repo"
          className="mt-1 min-h-10 w-full rounded-token border border-border bg-background/70 px-3 py-2 font-mono text-token-sm text-foreground outline-none transition-colors focus:border-mint"
        />
        <datalist id="ams-miner-cohort-repos">
          {repoOptions.map((repo) => (
            <option key={repo} value={repo} />
          ))}
        </datalist>
        {!hasRepos ? (
          <span className="mt-1 block text-token-2xs text-muted-foreground">
            No registered repositories detected yet — type an installed{" "}
            <code className="font-mono">owner/repo</code>.
          </span>
        ) : null}
      </label>

      <div className="mt-6">
        <StateBoundary
          isLoading={Boolean(base) && loading}
          isError={Boolean(base) && !loading && loadError !== null}
          isEmpty={Boolean(base) && !loading && comparison !== null && !comparison.present}
          onRetry={load}
          onRefresh={load}
          loadingTitle="Loading AMS contributor mix…"
          errorTitle="Couldn't load the AMS contributor mix"
          errorDescription={loadError ?? undefined}
          emptyTitle="No identifiable AMS activity yet"
          emptyDescription="This repo has no AMS-identifiable submitters in the current window, or the AMS reputation bridge isn't configured."
        >
          {!base ? (
            <p className="text-token-sm text-muted-foreground">
              {hasRepos
                ? "This view is unavailable for this repository."
                : "Enter an installed repository to compare cohorts."}
            </p>
          ) : comparison?.present ? (
            <div>
              <p className="text-token-2xs text-muted-foreground">
                Window: {comparison.windowDays} days · checked {comparison.checkedSubmitterCount} of{" "}
                {comparison.totalSubmitterCount} submitters
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <CohortColumn title="AMS miners" metrics={comparison.amsCohort} />
                <CohortColumn title="Other contributors" metrics={comparison.humanCohort} />
              </div>
            </div>
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}
