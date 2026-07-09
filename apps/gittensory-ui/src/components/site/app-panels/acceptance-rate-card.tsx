import { Stat, StatusPill } from "@/components/site/control-primitives";
import { EmptyState } from "@/components/site/state-views";

import {
  bandForAcceptanceRate,
  summarizeAcceptanceRate,
  type AcceptanceRateReport,
} from "./acceptance-rate-card-model";

/** Self-host analytics card (#2197): the finding acceptance rate — how often a contributor acted on an inline
 *  finding (the PR merged after it was posted) — as a single percentage Stat plus accepted/total counts, over a
 *  rolling window. UI-only display slice; the acceptance shape is assumed present on the operator-dashboard payload
 *  (backend computation is #1967), so absence renders a graceful "not yet available" EmptyState. */
export function AcceptanceRateCard({ report }: { report?: AcceptanceRateReport }) {
  if (!report) {
    return (
      <EmptyState
        title="Acceptance rate not yet available"
        description="This appears once finding-acceptance data is present on the dashboard payload."
      />
    );
  }
  const summary = summarizeAcceptanceRate(report);
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Finding acceptance rate</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            How often a contributor acted on an inline finding — the PR merged after it was posted.
            Public-safe counts only.
          </p>
        </div>
        <StatusPill status={bandForAcceptanceRate(summary.rate)}>
          {`${report.windowDays}-day window`}
        </StatusPill>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Acceptance rate"
          value={summary.rate !== null ? `${Math.round(summary.rate * 100)}%` : "—"}
          hint={<span className="text-muted-foreground">accepted / findings posted</span>}
        />
        <Stat
          label="Accepted"
          value={String(summary.accepted)}
          hint={<span className="text-muted-foreground">findings acted on</span>}
        />
        <Stat
          label="Findings posted"
          value={String(summary.total)}
          hint={<span className="text-muted-foreground">inline findings in window</span>}
        />
      </div>
    </section>
  );
}
