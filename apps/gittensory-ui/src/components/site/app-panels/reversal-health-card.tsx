import { Stat, StatusPill } from "@/components/site/control-primitives";
import { EmptyState } from "@/components/site/state-views";
import {
  formatRatePct,
  formatReversalEventType,
  reversalHealthStatus,
  type ReversalHealth,
} from "@/components/site/app-panels/reversal-health-card-model";

/** Analytics card (#2193): reversal rate and recent auto-action health from computeAgentHealth — read-only
 *  over the operator-dashboard payload. Lists reversed targets when present; EmptyState when none. */
export function ReversalHealthCard({ health }: { health: ReversalHealth }) {
  const status = reversalHealthStatus(health);
  const reversedTargets = health.reversedTargets ?? [];

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Reversal health</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            How often humans reopened or reverted a bot auto-action in the last 7 days. Public-safe
            counts only.
          </p>
        </div>
        <StatusPill status={status.tone}>{status.label}</StatusPill>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Reversal rate"
          value={formatRatePct(health.reversalRate)}
          hint={
            <span className="text-muted-foreground">
              reversals / recent auto-actions (7d window)
            </span>
          }
        />
        <Stat
          label="Reversals"
          value={String(health.reversals)}
          hint={<span className="text-muted-foreground">human overrides in window</span>}
        />
        <Stat
          label="Recent auto-actions"
          value={String(health.recentAutoActions)}
          hint={<span className="text-muted-foreground">merged + closed in window</span>}
        />
        <Stat
          label="Manual rate"
          value={formatRatePct(health.manualRate)}
          hint={<span className="text-muted-foreground">lifetime terminal decisions punted</span>}
        />
      </div>

      {reversedTargets.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {reversedTargets.map((target) => (
            <li
              key={`${target.repo}#${target.number}-${target.eventType}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-token border border-border bg-background/40 px-3 py-2 text-token-sm"
            >
              <a
                href={`https://github.com/${target.repo}/pull/${target.number}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-token-xs text-mint hover:underline"
              >
                {target.repo}#{target.number}
              </a>
              <span className="text-token-xs text-muted-foreground">
                {formatReversalEventType(target.eventType)} · {target.status}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          className="mt-4"
          title="No reversals in window"
          description="When a contributor reopens a bot-close or reverts a bot-merge, the pull request will appear here."
        />
      )}
    </section>
  );
}
