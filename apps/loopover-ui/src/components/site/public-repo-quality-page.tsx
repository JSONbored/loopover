import { useQuery } from "@tanstack/react-query";

import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { TableScroll } from "@/components/site/data-table";
import { Card, Section } from "@/components/site/primitives";
import { StateBoundary } from "@/components/site/state-views";
import { Skeleton } from "@/components/ui/skeleton";

export type PublicQualityMetrics = {
  repoFullName: string;
  generatedAt: string;
  gate: {
    blocked: number;
    blockedThenMerged: number;
    falsePositiveRate: number | null;
    precisionPct: number | null;
    topGateTypes: Array<{
      gateType: string;
      blocked: number;
      blockedThenMerged: number;
      falsePositiveRate: number | null;
      precisionPct: number | null;
    }>;
  };
  outcomes: { merged: number; closed: number; mergeRatioPct: number | null };
  slop: { totalResolved: number; overallMergeRate: number | null; discriminates: boolean | null };
  trend: Array<{
    weekStart: string;
    gateBlocked: number;
    gateBlockedThenMerged: number;
    gateFalsePositiveRate: number | null;
    outcomesMerged: number;
    outcomesClosed: number;
    mergeRatioPct: number | null;
  }>;
};

const pctFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

async function fetchPublicQualityMetrics(
  owner: string,
  repo: string,
): Promise<PublicQualityMetrics | null> {
  const result = await apiFetch<PublicQualityMetrics>(
    `${getApiOrigin()}/v1/public/repos/${owner}/${repo}/quality`,
    {
      label: "Public quality metrics",
      timeoutMs: 8000,
      silentStatus: true,
    },
  );
  // Distinguish transport/HTTP failure (ErrorState + retry) from a successful opt-out/null payload
  // (EmptyState) so StateBoundary can assign the right ARIA role (#6821).
  if (!result.ok) {
    throw new Error(result.message || "Public quality metrics unavailable");
  }
  return result.data ?? null;
}

function slopCalibrationHint(discriminates: boolean | null): string {
  if (discriminates === true) return " · discriminating";
  if (discriminates === false) return " · recalibrate";
  return "";
}

/** Content-shaped placeholder matching the 3-stat-card + trend-table layout so the page does not
 *  jump once metrics arrive (#6821). */
function PublicRepoQualitySkeleton() {
  return (
    <div className="max-w-4xl space-y-10" aria-hidden>
      <div className="space-y-3">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index} className="space-y-3 p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-4 w-40" />
          </Card>
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <div className="overflow-x-auto rounded-token border border-border">
          <div className="border-b border-border px-4 py-3">
            <Skeleton className="h-3 w-48" />
          </div>
          <div className="divide-y divide-border/60">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="px-4 py-3">
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PublicRepoQualityPage({ owner, repo }: { owner: string; repo: string }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["public-quality", owner, repo],
    queryFn: () => fetchPublicQualityMetrics(owner, repo),
    staleTime: 60_000,
  });

  return (
    <Section className="pt-16 pb-16">
      <StateBoundary
        isLoading={isLoading}
        isError={isError}
        isEmpty={!isLoading && !isError && !data}
        onRetry={() => void refetch()}
        loadingSkeleton={<PublicRepoQualitySkeleton />}
        emptyTitle="Review quality unavailable"
        emptyDescription="This repository has not opted in to public review-quality metrics, or the metrics are temporarily unavailable."
        errorTitle="Review quality unavailable"
        errorDescription="This repository has not opted in to public review-quality metrics, or the metrics are temporarily unavailable."
      >
        {data ? (
          <div className="max-w-4xl">
            <div className="text-token-xs text-muted-foreground">Public review quality</div>
            <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
              {data.repoFullName}
            </h1>
            <p className="mt-3 text-token-sm text-muted-foreground">
              Aggregate counts only — no raw trust scores, rewards, or contributor rankings. Updated{" "}
              {new Date(data.generatedAt).toLocaleString()}.
            </p>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <Card className="p-5">
                <div className="text-token-xs text-muted-foreground">Gate precision</div>
                <div className="mt-2 text-token-xl font-medium">
                  {data.gate.precisionPct != null
                    ? `${pctFmt.format(data.gate.precisionPct)}%`
                    : "—"}
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  {data.gate.blocked} blocks, {data.gate.blockedThenMerged} later merged
                </p>
              </Card>
              <Card className="p-5">
                <div className="text-token-xs text-muted-foreground">Merge ratio</div>
                <div className="mt-2 text-token-xl font-medium">
                  {data.outcomes.mergeRatioPct != null
                    ? `${pctFmt.format(data.outcomes.mergeRatioPct)}%`
                    : "—"}
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  {data.outcomes.merged} merged / {data.outcomes.closed} closed
                </p>
              </Card>
              <Card className="p-5">
                <div className="text-token-xs text-muted-foreground">Slop calibration</div>
                <div className="mt-2 text-token-xl font-medium">
                  {data.slop.overallMergeRate != null
                    ? `${pctFmt.format(data.slop.overallMergeRate)}% merge`
                    : "—"}
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  {data.slop.totalResolved} resolved PRs
                  {slopCalibrationHint(data.slop.discriminates)}
                </p>
              </Card>
            </div>

            {data.gate.topGateTypes.length > 0 ? (
              <div className="mt-10">
                <h2 className="text-token-lg font-medium">Top gate types</h2>
                <ul className="mt-4 space-y-2 text-token-sm">
                  {data.gate.topGateTypes.map((row) => (
                    <li key={row.gateType} className="rounded-token border-hairline px-4 py-3">
                      <span className="font-mono text-foreground">{row.gateType}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {row.blocked} blocks, {row.blockedThenMerged} merged anyway
                        {row.precisionPct != null
                          ? ` (${pctFmt.format(row.precisionPct)}% precision)`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-10">
              <h2 className="text-token-lg font-medium">Weekly trend</h2>
              <TableScroll className="mt-4" label="Weekly trend">
                <table className="w-full min-w-[36rem] text-left text-token-sm">
                  <caption className="sr-only">
                    Weekly gate false-positive rate, merge ratio, and blocked count.
                  </caption>
                  <thead className="text-token-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Week
                      </th>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Gate FP rate
                      </th>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Merge ratio
                      </th>
                      <th scope="col" className="pb-2 font-medium">
                        Blocks
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trend.map((row) => (
                      <tr key={row.weekStart} className="border-t border-hairline">
                        <td className="py-2 pr-4 font-mono text-token-xs">{row.weekStart}</td>
                        <td className="py-2 pr-4">
                          {row.gateFalsePositiveRate != null
                            ? `${pctFmt.format(row.gateFalsePositiveRate * 100)}%`
                            : "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {row.mergeRatioPct != null ? `${pctFmt.format(row.mergeRatioPct)}%` : "—"}
                        </td>
                        <td className="py-2">{row.gateBlocked}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          </div>
        ) : null}
      </StateBoundary>
    </Section>
  );
}
