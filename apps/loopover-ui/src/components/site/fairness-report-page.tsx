import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { TableScroll } from "@/components/site/data-table";
import { Card, Section } from "@/components/site/primitives";
import { StateBoundary } from "@/components/site/state-views";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicStats } from "@/components/site/proof-of-power-stats-model";

// Fairness report (#fairness-analytics): a deeper, linkable page behind the homepage's "Decision accuracy" tile.
// Reads the SAME /v1/public/stats payload proof-of-power-stats.tsx does (no new endpoint) -- this page just
// presents more of it: the full 8-week accuracy trend, the per-repo breakdown, and the fleet-wide anti-gaming
// count, with a short methodology note. Counts only; no PR content, contributor identities, or trust scores.

const pctFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat("en");

async function fetchPublicStats(): Promise<PublicStats | null> {
  const result = await apiFetch<PublicStats>(`${getApiOrigin()}/v1/public/stats`, {
    label: "LoopOver fairness report",
    timeoutMs: 8000,
    silentStatus: true,
  });
  if (!result.ok) throw new Error(result.message || "Fairness report unavailable");
  return result.data ?? null;
}

function FairnessReportSkeleton() {
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

export function FairnessReportPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["public-stats"],
    queryFn: fetchPublicStats,
    staleTime: 30_000,
  });

  // `fleetAccuracy` is optional-chained: until the backend carrying it is deployed, an older /v1/public/stats
  // response simply won't have the field yet, and this must degrade to the own-ledger number rather than throw.
  const fleetEligible =
    (data?.fleetAccuracy?.instanceCount ?? 0) > 0 && data?.fleetAccuracy?.accuracyPct != null;
  const headlineAccuracyPct = fleetEligible
    ? data!.fleetAccuracy!.accuracyPct
    : (data?.totals.accuracyPct ?? null);

  return (
    <Section className="pt-16 pb-16">
      <StateBoundary
        isLoading={isLoading}
        isError={isError}
        isEmpty={!isLoading && !isError && (!data || data.totals.handled <= 0)}
        onRetry={() => void refetch()}
        loadingSkeleton={<FairnessReportSkeleton />}
        emptyTitle="Fairness report unavailable"
        emptyDescription="LoopOver hasn't reviewed enough PRs yet to publish a meaningful fairness report, or the report is temporarily unavailable."
        errorTitle="Fairness report unavailable"
        errorDescription="LoopOver hasn't reviewed enough PRs yet to publish a meaningful fairness report, or the report is temporarily unavailable."
      >
        {data ? (
          <div className="max-w-4xl">
            <div className="text-token-xs text-muted-foreground">
              Fairness &amp; anti-gaming report
            </div>
            <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
              Is ORB treating contributors fairly?
            </h1>
            <p className="mt-3 text-token-sm text-muted-foreground">
              Reversal-grounded accuracy across every PR ORB has auto-merged or auto-closed — a
              human overturning an auto-action is the only thing that counts as a mistake here.
              Aggregate counts only, no PR content, no contributor identities, no trust scores.
              Updated {new Date(data.updatedAt).toLocaleString()}.
            </p>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <Card className="p-5">
                <div className="text-token-xs text-muted-foreground">Decision accuracy</div>
                <div className="mt-2 text-token-xl font-medium">
                  {headlineAccuracyPct != null ? `${pctFmt.format(headlineAccuracyPct)}%` : "—"}
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  {fleetEligible
                    ? `across ${intFmt.format(data.fleetAccuracy.instanceCount)} self-hosted instance${data.fleetAccuracy.instanceCount === 1 ? "" : "s"}, last ${data.fleetAccuracy.windowDays} days`
                    : data.totals.reversed > 0
                      ? `${intFmt.format(data.totals.reversed)} human-reversed, lifetime`
                      : "reversal-grounded, lifetime"}
                </p>
              </Card>
              <Card className="p-5">
                <div className="text-token-xs text-muted-foreground">Anti-gaming flags caught</div>
                <div className="mt-2 text-token-xl font-medium">
                  {data.fleetAccuracy ? intFmt.format(data.fleetAccuracy.gamingFlagsCaught) : "—"}
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  self-hosted instances flagged for mass-submitting easy PRs to inflate their own
                  precision
                </p>
              </Card>
              <Card className="p-5">
                <div className="text-token-xs text-muted-foreground">PRs reviewed</div>
                <div className="mt-2 text-token-xl font-medium">
                  {intFmt.format(data.totals.reviewed)}
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  {intFmt.format(data.totals.merged)} merged across {data.byProject.length} repo
                  {data.byProject.length === 1 ? "" : "s"}
                </p>
              </Card>
            </div>

            <div className="mt-10 space-y-2 rounded-token border-hairline px-4 py-4 text-token-sm text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">How accuracy is measured:</span> 1
                minus the share of auto-merged/auto-closed PRs a human later overturned — a
                bot-closed PR a contributor reopened, or a bot-merged PR undone by a separate revert
                PR. Nothing here is a prediction or a self-assessment; it's counted after the fact
                from what actually happened on GitHub.
              </p>
              <p>
                <span className="font-medium text-foreground">
                  Why the fleet number, not just our own repos:
                </span>{" "}
                the self-hosted instance count above reflects the live fleet running ORB today, not
                a historical snapshot of LoopOver's own repos alone.
              </p>
            </div>

            {data.byProject.length > 0 ? (
              <div className="mt-10">
                <h2 className="text-token-lg font-medium">By repository</h2>
                <TableScroll className="mt-4" label="Accuracy by repository">
                  <table className="w-full min-w-[32rem] text-left text-token-sm">
                    <caption className="sr-only">
                      Reviewed, merged, closed, and accuracy per repository.
                    </caption>
                    <thead className="text-token-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Repository
                        </th>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Reviewed
                        </th>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Merged
                        </th>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Closed
                        </th>
                        <th scope="col" className="pb-2 font-medium">
                          Accuracy
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byProject.map((row) => (
                        <tr key={row.project} className="border-t border-hairline">
                          <td className="py-2 pr-4 font-mono text-token-xs">{row.project}</td>
                          <td className="py-2 pr-4">{intFmt.format(row.reviewed)}</td>
                          <td className="py-2 pr-4">{intFmt.format(row.merged)}</td>
                          <td className="py-2 pr-4">{intFmt.format(row.closed)}</td>
                          <td className="py-2">
                            {row.accuracyPct != null ? `${pctFmt.format(row.accuracyPct)}%` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </div>
            ) : null}

            <div className="mt-10">
              <h2 className="text-token-lg font-medium">Weekly trend</h2>
              <TableScroll className="mt-4" label="Weekly accuracy trend">
                <table className="w-full min-w-[36rem] text-left text-token-sm">
                  <caption className="sr-only">
                    Weekly merged, closed, reversed, and accuracy counts.
                  </caption>
                  <thead className="text-token-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Week
                      </th>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Merged
                      </th>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Closed
                      </th>
                      <th scope="col" className="pb-2 pr-4 font-medium">
                        Reversed
                      </th>
                      <th scope="col" className="pb-2 font-medium">
                        Accuracy
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.accuracyTrend.map((week) => (
                      <tr key={week.weekStart} className="border-t border-hairline">
                        <td className="py-2 pr-4 font-mono text-token-xs">{week.weekStart}</td>
                        <td className="py-2 pr-4">
                          {week.merged != null ? intFmt.format(week.merged) : "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {week.closed != null ? intFmt.format(week.closed) : "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {week.reversed != null ? intFmt.format(week.reversed) : "—"}
                        </td>
                        <td className="py-2">
                          {week.accuracyPct != null ? `${pctFmt.format(week.accuracyPct)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>

            {data.rulePrecision && data.rulePrecision.rules.length > 0 ? (
              <div className="mt-10">
                <h2 className="text-token-lg font-medium">Measured accuracy per rule</h2>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  Precision of each automated rule over its human-decided cases in the last{" "}
                  {data.rulePrecision.windowDays} days. A rule below the decided-sample floor shows{" "}
                  <span className="font-medium text-foreground">insufficient data</span> — an
                  unknown is never rendered as 0%. Reproduce these numbers yourself:{" "}
                  <Link
                    to="/docs/$slug"
                    params={{ slug: "verify-this-review" }}
                    className="underline underline-offset-2"
                  >
                    verify this review
                  </Link>
                  .
                </p>
                <TableScroll className="mt-4" label="Measured precision per rule">
                  <table className="w-full min-w-[28rem] text-left text-token-sm">
                    <caption className="sr-only">
                      Decided cases and measured precision per rule.
                    </caption>
                    <thead className="text-token-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Rule
                        </th>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Decided
                        </th>
                        <th scope="col" className="pb-2 font-medium">
                          Precision
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rulePrecision.rules.map((row) => (
                        <tr key={row.ruleId} className="border-t border-hairline">
                          <td className="py-2 pr-4 font-mono text-token-xs">{row.ruleId}</td>
                          <td className="py-2 pr-4">{intFmt.format(row.decided)}</td>
                          <td className="py-2">
                            {row.precision != null ? (
                              `${pctFmt.format(row.precision * 100)}%`
                            ) : (
                              <span className="text-muted-foreground">insufficient data</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
                {data.rulePrecision.latestBacktestRun ? (
                  <p className="mt-3 text-token-xs text-muted-foreground">
                    Reproducibility freeze point: corpus checksum{" "}
                    <span className="font-mono">
                      {data.rulePrecision.latestBacktestRun.corpusChecksum.slice(0, 16)}…
                    </span>{" "}
                    from the latest persisted backtest run (
                    {new Date(data.rulePrecision.latestBacktestRun.at).toLocaleDateString()}).
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </StateBoundary>
    </Section>
  );
}
