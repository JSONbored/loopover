import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { StatusPill, type Status } from "@/components/site/control-primitives";
import { cn } from "@/lib/utils";

/** Aggregate slop + duplicate signal for the maintainer quality dashboard (#2202): the share of the maintainer's
 *  open PRs carrying an elevated/high deterministic slop band and the share sitting in a high-risk duplicate
 *  cluster, each as a rate of the open-PR total. Display slice over the dashboard payload's `slopDuplicate`
 *  aggregate — observable rates + bands, never raw scores. Degrades to an empty state when the queue is clear
 *  or the field is absent. (Current-window rates; a time-series trend is a follow-up per the issue thread.) */
export type SlopDuplicateSignal = {
  openPullRequests: number;
  slopFlaggedPullRequests: number;
  duplicateFlaggedPullRequests: number;
  slopRate: number | null;
  duplicateRate: number | null;
};

/** Lower is healthier — a small flagged share is good; a large one is a burden signal. */
function rateStatus(rate: number | null): Status {
  if (rate === null) return "info";
  if (rate < 0.1) return "ready";
  if (rate < 0.3) return "warn";
  return "degraded";
}

function rateBandLabel(rate: number | null): string {
  if (rate === null) return "no data";
  if (rate < 0.1) return "low";
  if (rate < 0.3) return "watch";
  return "high";
}

function SignalRow({
  label,
  rate,
  flagged,
  total,
  bar,
}: {
  label: string;
  rate: number | null;
  flagged: number;
  total: number;
  bar: string;
}) {
  const pct = rate === null ? null : Math.round(rate * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-token-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="font-mono text-token-xs text-muted-foreground">
          {pct === null ? "—" : `${pct}%`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-border" aria-hidden>
        {pct === null ? null : <div className={cn("h-full", bar)} style={{ width: `${pct}%` }} />}
      </div>
      <div className="flex items-center justify-between font-mono text-token-2xs text-muted-foreground">
        <span>
          {flagged} of {total} open PR{total === 1 ? "" : "s"}
        </span>
        <StatusPill status={rateStatus(rate)}>{rateBandLabel(rate)}</StatusPill>
      </div>
    </div>
  );
}

export function SlopDuplicateCard({ signal }: { signal?: SlopDuplicateSignal }) {
  if (!signal || signal.openPullRequests === 0) {
    return (
      <AnalyticsCardShell
        title="Slop & duplicate signal"
        description="Share of open PRs flagged as slop or in a high-risk duplicate cluster, across your repos."
        state="empty"
        emptyTitle={signal ? "Queue is clear" : "Not yet available"}
        emptyHint={
          signal
            ? "No open pull requests across the shaped repos in this window."
            : "The slop + duplicate signal appears once the maintainer dashboard payload includes the aggregate."
        }
      />
    );
  }

  return (
    <AnalyticsCardShell
      title="Slop & duplicate signal"
      description="Share of open PRs flagged as slop or in a high-risk duplicate cluster, across your repos."
      state="ready"
    >
      <div className="space-y-4">
        <SignalRow
          label="Slop-flagged"
          rate={signal.slopRate}
          flagged={signal.slopFlaggedPullRequests}
          total={signal.openPullRequests}
          bar="bg-warning"
        />
        <SignalRow
          label="Duplicate-flagged"
          rate={signal.duplicateRate}
          flagged={signal.duplicateFlaggedPullRequests}
          total={signal.openPullRequests}
          bar="bg-danger"
        />
      </div>
    </AnalyticsCardShell>
  );
}
