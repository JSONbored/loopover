import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { BoundaryBadge, Stat } from "@/components/site/control-primitives";
import { EmptyState } from "@/components/site/state-views";
import {
  formatGateOutcomeRate,
  gateOutcomeHasSamples,
  gateOutcomeSegments,
  type GateOutcomeCardData,
} from "@/components/site/app-panels/gate-outcome-card-model";
import { formatGeneratedAt } from "@/components/site/app-panels/slop-duplicate-trend-card-model";

/** Gate-outcome breakdown card (#2203, part of #539): auto-merged / auto-closed / held counts and rates
 *  from repo-scoped gate-outcome audit events. Read-only; public-safe aggregate counts only. The count Stats
 *  always render regardless of the outcome mix, so this card stays in AnalyticsCardShell's "ready" state and
 *  keeps its own inner outcome-mix-vs-EmptyState toggle (#6175), matching ReversalHealthCard's shape. */
export function GateOutcomeCard({ breakdown }: { breakdown: GateOutcomeCardData }) {
  const segments = gateOutcomeSegments(breakdown);
  const hasSamples = gateOutcomeHasSamples(breakdown);

  return (
    <AnalyticsCardShell
      title="Gate outcomes"
      description={`Terminal gate dispositions from audit events over the last ${breakdown.windowDays} day(s).`}
      state="ready"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-token-2xs text-muted-foreground">
            generated {formatGeneratedAt(breakdown.generatedAt)}
          </span>
          <BoundaryBadge boundary="public" />
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Auto-merged"
          value={String(breakdown.counts.autoMerged)}
          hint={
            <span className="text-muted-foreground">
              {formatGateOutcomeRate(breakdown.rates.autoMerged)} of outcomes
            </span>
          }
        />
        <Stat
          label="Auto-closed"
          value={String(breakdown.counts.autoClosed)}
          hint={
            <span className="text-muted-foreground">
              {formatGateOutcomeRate(breakdown.rates.autoClosed)} of outcomes
            </span>
          }
        />
        <Stat
          label="Held / manual"
          value={String(breakdown.counts.held)}
          hint={
            <span className="text-muted-foreground">
              {formatGateOutcomeRate(breakdown.rates.held)} of outcomes
            </span>
          }
        />
      </div>

      {hasSamples ? (
        <div className="mt-4">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Outcome mix
          </div>
          <div
            className="mt-2 flex h-3 overflow-hidden rounded-token border border-border"
            role="img"
            aria-label={`Gate outcome mix: ${breakdown.counts.autoMerged} auto-merged, ${breakdown.counts.autoClosed} auto-closed, ${breakdown.counts.held} held`}
          >
            {segments.map((segment) => (
              <div
                key={segment.key}
                className={segment.barClassName}
                style={{ width: `${segment.widthPct}%` }}
                title={`${segment.label}: ${segment.count}`}
              />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-token-2xs text-muted-foreground">
            {segments.map((segment) => (
              <li key={segment.key} className="inline-flex items-center gap-1.5">
                <span
                  className={`inline-block size-2 rounded-full ${segment.barClassName}`}
                  aria-hidden
                />
                {segment.label} · {segment.count}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <EmptyState
          className="mt-4"
          title="No gate-outcome events yet"
          description="Auto-merge, auto-close, and hold audit rows appear here once the agent processes PRs in your scoped repos."
        />
      )}
    </AnalyticsCardShell>
  );
}
