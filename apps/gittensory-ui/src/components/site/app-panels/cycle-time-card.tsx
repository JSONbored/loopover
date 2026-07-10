import { MiniSparkbar, Stat, StatusPill } from "@/components/site/control-primitives";
import {
  formatCycleTimeMs,
  type CycleTimeAggregate,
} from "@/components/site/app-panels/cycle-time-card-model";

/** Self-host maintainer analytics card (#2194): PR review cycle-time percentiles (p50/p90/p99) from the stats
 *  feed, read-only over the operator-dashboard payload. Shows an inline empty state when there are no paired
 *  gate_decision → pr_outcome samples in the window. */
export function CycleTimeCard({ cycleTime }: { cycleTime: CycleTimeAggregate }) {
  const hasSamples = cycleTime.sampleSize > 0;
  const hasDistribution = cycleTime.distribution.length > 0;

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Review cycle time</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Gate decision → PR outcome duration percentiles from review_audit. Public-safe
            aggregates only.
          </p>
        </div>
        <StatusPill status={hasSamples ? "ready" : "info"}>
          {hasSamples ? `${cycleTime.sampleSize} paired PR(s)` : "no samples yet"}
        </StatusPill>
      </div>

      {hasSamples ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat
              label="p50"
              value={formatCycleTimeMs(cycleTime.p50Ms)}
              hint={<span className="text-muted-foreground">median cycle time</span>}
            />
            <Stat
              label="p90"
              value={formatCycleTimeMs(cycleTime.p90Ms)}
              hint={<span className="text-muted-foreground">90th percentile</span>}
            />
            <Stat
              label="p99"
              value={formatCycleTimeMs(cycleTime.p99Ms)}
              hint={<span className="text-muted-foreground">99th percentile</span>}
            />
          </div>
          {hasDistribution ? (
            <div className="mt-4 rounded-token border border-border bg-background/40 p-3">
              <div className="text-token-xs text-muted-foreground">Cycle-time distribution</div>
              <MiniSparkbar values={cycleTime.distribution} className="mt-2" />
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-4 text-token-sm text-muted-foreground">
          Paired gate decisions and PR outcomes will appear here once the gate has resolved pull
          requests in the analytics window.
        </p>
      )}
    </section>
  );
}
