import { StatusPill } from "@/components/site/control-primitives";
import { TrendChart } from "@/components/site/trend-chart";
import {
  chartValuesForSeries,
  formatGeneratedAt,
  formatTrendRatePct,
  latestWeekWithSignal,
  seriesHasSignal,
  trendHasAnySignal,
  type MaintainerSlopDuplicateTrend,
  type SlopBandLabel,
} from "@/components/site/app-panels/slop-duplicate-trend-card-model";
import { cn } from "@/lib/utils";

const SLOP_BAND_TONE: Record<SlopBandLabel, string> = {
  clean: "text-success",
  low: "text-mint",
  elevated: "text-warning",
  high: "text-danger",
};

/** Maintainer quality dashboard card (#2202): weekly slop-flag and duplicate-flag rates from queue-health
 *  snapshots. Band labels only — never raw slop-risk or credibility numbers. */
export function SlopDuplicateTrendCard({ trend }: { trend: MaintainerSlopDuplicateTrend }) {
  const hasSignal = trendHasAnySignal(trend.weeks);
  const hasSlop = seriesHasSignal(trend.weeks, "slop");
  const hasDuplicate = seriesHasSignal(trend.weeks, "duplicate");
  const latest = latestWeekWithSignal(trend.weeks);

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Slop + duplicate trend</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Weekly slop-flag and duplicate-flag rates from queue-health snapshots. Band labels only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={trend.stale ? "warn" : "ready"}>
            {trend.stale ? "stale snapshot" : "fresh snapshot"}
          </StatusPill>
          <span className="font-mono text-token-2xs text-muted-foreground">
            generated {formatGeneratedAt(trend.generatedAt)}
          </span>
        </div>
      </div>

      {hasSignal ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-token-xs">
            <LegendItem
              color="var(--mint)"
              label="Slop flag rate"
              detail={
                latest?.slopBandLabel
                  ? `latest band: ${latest.slopBandLabel}`
                  : hasSlop
                    ? `latest: ${formatTrendRatePct(latest?.slopFlagRatePct)}`
                    : "no slop samples"
              }
              bandLabel={latest?.slopBandLabel}
            />
            <LegendItem
              color="var(--warning)"
              label="Duplicate flag rate"
              detail={
                hasDuplicate
                  ? `latest: ${formatTrendRatePct(latest?.duplicateFlagRatePct)}`
                  : "no duplicate samples"
              }
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <TrendPanel
              title="Slop flag rate"
              emptyMessage="No slop-flag samples in the snapshot window yet."
              hasSignal={hasSlop}
              values={chartValuesForSeries(trend.weeks, "slop")}
              stroke="var(--mint)"
              fill="color-mix(in oklab, var(--mint) 18%, transparent)"
            />
            <TrendPanel
              title="Duplicate flag rate"
              emptyMessage="No duplicate-flag samples in the snapshot window yet."
              hasSignal={hasDuplicate}
              values={chartValuesForSeries(trend.weeks, "duplicate")}
              stroke="var(--warning)"
              fill="color-mix(in oklab, var(--warning) 18%, transparent)"
            />
          </div>

          <p className="mt-3 text-token-xs text-muted-foreground">{trend.summary}</p>
        </>
      ) : (
        <p className="mt-4 text-token-sm text-muted-foreground">
          Queue-health snapshot history will appear here after signal snapshot jobs run for your
          scoped repositories.
        </p>
      )}
    </section>
  );
}

function TrendPanel({
  title,
  emptyMessage,
  hasSignal,
  values,
  stroke,
  fill,
}: {
  title: string;
  emptyMessage: string;
  hasSignal: boolean;
  values: number[];
  stroke: string;
  fill: string;
}) {
  return (
    <div className="rounded-token border border-border bg-background/40 p-3">
      <div className="text-token-xs font-medium text-foreground">{title}</div>
      {hasSignal ? (
        <div className="mt-2 h-20">
          <TrendChart values={values} stroke={stroke} fill={fill} height={80} showAxis />
        </div>
      ) : (
        <p className="mt-2 text-token-xs text-muted-foreground">{emptyMessage}</p>
      )}
    </div>
  );
}

function LegendItem({
  color,
  label,
  detail,
  bandLabel,
}: {
  color: string;
  label: string;
  detail: string;
  bandLabel?: SlopBandLabel | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block h-2 w-6 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-foreground">{label}</span>
      <span
        className={cn("text-muted-foreground", bandLabel ? SLOP_BAND_TONE[bandLabel] : undefined)}
      >
        {detail}
      </span>
    </div>
  );
}
