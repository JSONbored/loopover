import { Stat, StatusPill } from "@/components/site/control-primitives";
import { TrendChart } from "@/components/site/trend-chart";
import {
  formatQueueHealthGeneratedAt,
  queueHealthStatus,
  type QueueHealthCardModel,
} from "@/components/site/app-panels/queue-health-card-model";

/** Maintainer quality dashboard card (#2201): aggregate queue-health counts + queue-depth trend from cached
 *  signal snapshots. Read-only over the shaped maintainer-dashboard payload. */
export function QueueHealthCard({ card }: { card: QueueHealthCardModel }) {
  const status = queueHealthStatus(card);
  const statusLabel =
    status === "stale"
      ? "stale snapshot"
      : status === "blocked"
        ? "duplicate risk"
        : status === "warn"
          ? "stale PRs present"
          : "healthy";

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Queue health</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Pending review load, stale PR pressure, and duplicate-risk clusters across shaped repos.
          </p>
        </div>
        <StatusPill status={status}>{statusLabel}</StatusPill>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Pending"
          value={String(card.pending)}
          hint={<span className="text-muted-foreground">open PRs in queue</span>}
        />
        <Stat
          label="In flight"
          value={String(card.inFlight)}
          hint={<span className="text-muted-foreground">likely reviewable now</span>}
        />
        <Stat
          label="Stuck"
          value={String(card.stuck)}
          hint={<span className="text-muted-foreground">stale open PRs</span>}
        />
        <Stat
          label="DLQ"
          value={String(card.dlq)}
          hint={<span className="text-muted-foreground">high-risk duplicate clusters</span>}
        />
      </div>

      {card.queueDepthTrend.length > 0 ? (
        <div className="mt-4 rounded-token border border-border bg-background/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-token-xs text-muted-foreground">Queue depth trend</div>
            <div className="font-mono text-token-2xs text-muted-foreground">
              generated {formatQueueHealthGeneratedAt(card.generatedAt)}
            </div>
          </div>
          <TrendChart values={card.queueDepthTrend} height={80} className="mt-2" />
        </div>
      ) : (
        <p className="mt-4 text-token-sm text-muted-foreground">
          Queue-depth history will appear after queue-health snapshots accumulate for shaped repos.
        </p>
      )}

      <p className="mt-3 text-token-xs text-muted-foreground">{card.summary}</p>
    </section>
  );
}
