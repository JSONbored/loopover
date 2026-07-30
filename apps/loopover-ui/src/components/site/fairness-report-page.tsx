import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { TableScroll } from "@/components/site/data-table";
import { Card, Section } from "@/components/site/primitives";
import { StateBoundary } from "@/components/site/state-views";
import { Skeleton } from "@/components/ui/skeleton";
import { isFleetBasis, type PublicStats } from "@/components/site/proof-of-power-stats-model";

// Fairness report (#fairness-analytics): a deeper, linkable page behind the homepage's "Decision accuracy" tile.
// Reads the SAME /v1/public/stats payload proof-of-power-stats.tsx does (no new endpoint) -- this page just
// presents more of it: the full 8-week accuracy trend, the per-repo breakdown, and the fleet-wide anti-gaming
// count, with a short methodology note. Counts only; no PR content, contributor identities, or trust scores.

const pctFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
/** Why an accuracy cell reads "—". Reversal-grounded accuracy needs the deployment to have recorded the
 *  terminal auto-actions a reversal attaches to; where it hasn't, `1 - 0/N` would render as a flawless 100%
 *  over a numerator that can never move, so the backend publishes null and the page says so out loud. */
function UnmeasurableAccuracyNote() {
  return (
    <p className="mt-3 text-token-xs text-muted-foreground">
      An accuracy of <span className="font-mono">—</span> means not measurable on this deployment,
      not 100%: no auto-merge/auto-close was recorded here for a human reversal to be counted
      against. The volume columns beside it are measured directly and are unaffected.
    </p>
  );
}

const intFmt = new Intl.NumberFormat("en");

/** How to describe the span `accuracyPct` actually covers.
 *
 *  This said "lifetime", which it has never been: the accuracy pairing is deliberately bounded by the audit
 *  log's retention window (see public-stats.ts's own note on why a lifetime denominator drifts the ratio
 *  toward 100%), so the headline claimed a wider basis than the number had. The window comes from the
 *  payload rather than a literal here, so it tracks the retention policy instead of drifting from it. */
function accuracyWindowLabel(windowDays: number | null): string {
  return windowDays === null ? "reversal-grounded" : `last ${windowDays} days`;
}

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
                  {/* #9673: `fleetEligible` only gates volume; `basis` says whether this number is
                      corroborated across operators or one instance's own self-report -- say which. */}
                  {fleetEligible
                    ? isFleetBasis(data.fleetAccuracy)
                      ? `across ${intFmt.format(data.fleetAccuracy.instanceCount)} self-hosted instance${data.fleetAccuracy.instanceCount === 1 ? "" : "s"}, last ${data.fleetAccuracy.windowDays} days`
                      : `self-reported by one self-hosted instance, not corroborated across operators, last ${data.fleetAccuracy.windowDays} days`
                    : data.totals.reversed > 0
                      ? `${intFmt.format(data.totals.reversed)} human-reversed, ${accuracyWindowLabel(data.totals.accuracyWindowDays)}`
                      : `reversal-grounded, ${accuracyWindowLabel(data.totals.accuracyWindowDays)}`}
                </p>
                {/* #9168 computes `basis` precisely so this number is not read as corroborated-across-operators
                    when it is one operator's own disclosed outcomes; the page used to drop the field entirely. */}
                {fleetEligible && !isFleetBasis(data.fleetAccuracy) ? (
                  <p className="mt-2 text-token-xs text-muted-foreground">
                    Self-reported by that single instance, not corroborated across operators
                    {data.fleetAccuracy.decidedCount != null
                      ? ` (${intFmt.format(data.fleetAccuracy.decidedCount)} decided`
                      : ""}
                    {data.fleetAccuracy.decidedCount != null &&
                    data.fleetAccuracy.accuracyCiPct != null
                      ? `, 95% CI ${pctFmt.format(data.fleetAccuracy.accuracyCiPct.lo)}–${pctFmt.format(data.fleetAccuracy.accuracyCiPct.hi)}%)`
                      : data.fleetAccuracy.decidedCount != null
                        ? ")"
                        : ""}
                    .
                  </p>
                ) : null}
              </Card>
              <Card className="p-5">
                <div className="text-token-xs text-muted-foreground">Anti-gaming flags caught</div>
                <div className="mt-2 text-token-xl font-medium">
                  {data.fleetAccuracy?.gamingFlagsCaught != null
                    ? intFmt.format(data.fleetAccuracy.gamingFlagsCaught)
                    : "—"}
                </div>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  {/* #9068: null (not 0) below the fleet's own eligibility floor -- a structural zero must
                      never read as "checked, found none". */}
                  {data.fleetAccuracy?.gamingFlagsCaught != null
                    ? "self-hosted instances flagged for mass-submitting easy PRs to inflate their own precision"
                    : "not enough registered instances yet to compare for a gaming pattern"}
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
                <span className="font-medium text-foreground">How accuracy is measured:</span> the
                headline scores the gate's own merge/close <em>decisions</em> — the share the
                realized outcome confirmed, with holds excluded because a deferral to a human is not
                a decision that can be right or wrong (#8820). The per-repository and weekly tables
                below are a different, stricter measure: 1 minus the share of
                auto-merged/auto-closed PRs a human later overturned — a bot-closed PR a contributor
                reopened, or a bot-merged PR undone by a separate revert PR. Neither is a prediction
                or a self-assessment; both are counted after the fact from what actually happened on
                GitHub, which is also why the two can differ.
              </p>
              {/* #9673: this paragraph asserts fleet corroboration -- render it only when `basis` says the
                  headline actually IS a fleet aggregate, not one instance's own self-report. */}
              {isFleetBasis(data.fleetAccuracy) ? (
                <p>
                  <span className="font-medium text-foreground">
                    Why the fleet number, not just our own repos:
                  </span>{" "}
                  the self-hosted instance count above reflects the live fleet running ORB today,
                  not a historical snapshot of LoopOver's own repos alone.
                </p>
              ) : null}
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
                {data.byProject.some((row) => row.accuracyPct == null) ? (
                  <UnmeasurableAccuracyNote />
                ) : null}
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
              {data.accuracyTrend.some(
                (week) => week.merged != null && week.accuracyPct == null,
              ) ? (
                <UnmeasurableAccuracyNote />
              ) : null}
            </div>

            {/* #9676: the fleet-population sibling of the table above. Rendered as its own section, never
                merged into it: the two measure different populations on different estimands, and blending
                them into one column is the bug this whole surface is being corrected for. */}
            {data.fleetAccuracyTrend &&
            data.fleetAccuracyTrend.some((week) => week.verdicts != null) ? (
              <div className="mt-10">
                <h2 className="text-token-lg font-medium">Weekly trend — self-hosted fleet</h2>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  The same weeks, measured over the live self-hosted fleet instead of this
                  site&apos;s own frozen review history. This scores the gate&apos;s merge/close{" "}
                  <em>decisions</em> — the share the realized outcome confirmed — so it matches the
                  headline above rather than the reversal-grounded table beside it. Holds are
                  excluded: a deferral to a human is not a decision that can be right or wrong. Only
                  registered instances count.
                </p>
                <TableScroll className="mt-4" label="Weekly fleet accuracy trend">
                  <table className="w-full min-w-[36rem] text-left text-token-sm">
                    <caption className="sr-only">
                      Weekly scored fleet verdicts and the share the realized outcome confirmed.
                    </caption>
                    <thead className="text-token-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Week
                        </th>
                        <th scope="col" className="pb-2 pr-4 font-medium">
                          Decisions scored
                        </th>
                        <th scope="col" className="pb-2 font-medium">
                          Accuracy
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.fleetAccuracyTrend.map((week) => (
                        <tr key={week.weekStart} className="border-t border-hairline">
                          <td className="py-2 pr-4 font-mono text-token-xs">{week.weekStart}</td>
                          <td className="py-2 pr-4">
                            {week.verdicts != null ? intFmt.format(week.verdicts) : "—"}
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
            ) : null}

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
                  , or read how every number here is computed in the{" "}
                  <Link
                    to="/docs/$slug"
                    params={{ slug: "fairness-methodology" }}
                    className="underline underline-offset-2"
                  >
                    fairness methodology
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

            {/* #9744: re-evaluation rate + author-class parity. Rendered UNCONDITIONALLY when the block is
                present -- a window with no verdicts is a MEASURED zero and says so with its own bounds,
                which is a different claim from "we did not compute this" and must not look identical. */}
            {data.reviewParity ? (
              <div className="mt-10">
                <h2 className="text-token-lg font-medium">Re-evaluation and review parity</h2>
                <p className="mt-2 text-token-sm text-muted-foreground">
                  Every verdict is written to an append-only ledger, and a repeat verdict for the
                  same commit has to declare why. This is how often that happened, and whether a
                  pull request faced the same scrutiny regardless of who wrote it. Computed from the
                  ledger alone over {new Date(data.reviewParity.windowStart).toLocaleDateString()} –{" "}
                  {new Date(data.reviewParity.windowEnd).toLocaleDateString()}, so you can recompute
                  all of it yourself:{" "}
                  <Link
                    to="/docs/$slug"
                    params={{ slug: "verify-this-review" }}
                    className="underline underline-offset-2"
                  >
                    verify this review
                  </Link>
                  . The definitions behind each column are in the{" "}
                  <Link
                    to="/docs/$slug"
                    params={{ slug: "fairness-methodology" }}
                    className="underline underline-offset-2"
                  >
                    fairness methodology
                  </Link>
                  .
                </p>

                {data.reviewParity.verdicts === 0 ? (
                  <p className="mt-4 text-token-sm text-muted-foreground">
                    <span className="font-medium text-foreground">No verdicts recorded</span> in
                    this window — a measured zero over the dates above, not missing data.
                  </p>
                ) : (
                  <>
                    <p className="mt-4 text-token-sm">
                      {intFmt.format(data.reviewParity.reevaluations)} of{" "}
                      {intFmt.format(data.reviewParity.verdicts)} verdicts were re-evaluations
                      {data.reviewParity.reevaluationRatePct != null
                        ? ` (${pctFmt.format(data.reviewParity.reevaluationRatePct)}%)`
                        : ""}
                      .
                    </p>
                    {data.reviewParity.byReason.length > 0 ? (
                      <TableScroll className="mt-4" label="Re-evaluations by declared reason">
                        <table className="w-full min-w-[28rem] text-left text-token-sm">
                          <caption className="sr-only">
                            Re-evaluations by declared reason, and each reason&apos;s share of all
                            verdicts.
                          </caption>
                          <thead className="text-token-xs text-muted-foreground">
                            <tr>
                              <th scope="col" className="pb-2 pr-4 font-medium">
                                Reason
                              </th>
                              <th scope="col" className="pb-2 pr-4 font-medium">
                                Count
                              </th>
                              <th scope="col" className="pb-2 font-medium">
                                Share of verdicts
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.reviewParity.byReason.map((entry) => (
                              <tr key={entry.reason} className="border-t border-hairline">
                                <td className="py-2 pr-4 font-mono text-token-xs">
                                  {entry.reason}
                                </td>
                                <td className="py-2 pr-4">{intFmt.format(entry.count)}</td>
                                <td className="py-2">
                                  {entry.shareOfVerdictsPct != null
                                    ? `${pctFmt.format(entry.shareOfVerdictsPct)}%`
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </TableScroll>
                    ) : (
                      <p className="mt-3 text-token-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          No re-evaluations recorded
                        </span>{" "}
                        in this window — every verdict was a first evaluation.
                      </p>
                    )}

                    <h3 className="mt-8 text-token-sm font-medium">By author class</h3>
                    <p className="mt-2 text-token-xs text-muted-foreground">
                      Author class is GitHub&apos;s own{" "}
                      <span className="font-mono">author_association</span>, not a list this project
                      maintains. Reviews counts evaluations, not pull requests. Findings per PR is a
                      mean over the verdicts that recorded a count — the count behind it is shown,
                      because a mean over three cases is not the same claim as a mean over four
                      hundred. An unrecorded association is its own row rather than folded into
                      either side.
                    </p>
                    <TableScroll className="mt-4" label="Review parity by author class">
                      <table className="w-full min-w-[34rem] text-left text-token-sm">
                        <caption className="sr-only">
                          Reviews, findings, close rate and hold rate per author class.
                        </caption>
                        <thead className="text-token-xs text-muted-foreground">
                          <tr>
                            <th scope="col" className="pb-2 pr-4 font-medium">
                              Author
                            </th>
                            <th scope="col" className="pb-2 pr-4 font-medium">
                              PRs
                            </th>
                            <th scope="col" className="pb-2 pr-4 font-medium">
                              Reviews / PR
                            </th>
                            <th scope="col" className="pb-2 pr-4 font-medium">
                              Findings / PR
                            </th>
                            <th scope="col" className="pb-2 pr-4 font-medium">
                              Close rate
                            </th>
                            <th scope="col" className="pb-2 font-medium">
                              Hold rate
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.reviewParity.byAuthorClass.map((rollup) => (
                            <tr key={rollup.authorClass} className="border-t border-hairline">
                              <td className="py-2 pr-4">{rollup.authorClass}</td>
                              <td className="py-2 pr-4">{intFmt.format(rollup.pullRequests)}</td>
                              <td className="py-2 pr-4">
                                {rollup.reviewsPerPr != null
                                  ? pctFmt.format(rollup.reviewsPerPr)
                                  : "—"}
                              </td>
                              <td className="py-2 pr-4">
                                {rollup.findingsPerPr != null ? (
                                  <>
                                    {pctFmt.format(rollup.findingsPerPr)}{" "}
                                    <span className="text-token-xs text-muted-foreground">
                                      (n={intFmt.format(rollup.findingsBasis)})
                                    </span>
                                  </>
                                ) : (
                                  <span className="text-muted-foreground">insufficient data</span>
                                )}
                              </td>
                              <td className="py-2 pr-4">
                                {rollup.closeRate != null
                                  ? `${pctFmt.format(rollup.closeRate)}%`
                                  : "—"}
                              </td>
                              <td className="py-2">
                                {rollup.holdRate != null
                                  ? `${pctFmt.format(rollup.holdRate)}%`
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableScroll>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </StateBoundary>
    </Section>
  );
}
