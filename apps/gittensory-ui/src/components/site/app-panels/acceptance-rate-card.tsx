import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { Stat, StatusPill, type Status } from "@/components/site/control-primitives";

/** Finding acceptance-rate slice (#2197): the share of inline AI-review findings the contributor acted on
 *  (a finding was posted inline → the PR then merged). Display-only — the backend acceptance computation is
 *  tracked separately in #1967, so this card assumes the shape may be absent from the dashboard payload today
 *  and degrades to a "not yet available" empty state until it lands, rather than assuming a value. */
export type FindingAcceptance = {
  windowDays: number;
  accepted: number;
  total: number;
  /** accepted / total, already computed server-side; null when total === 0 so the card never divides by zero. */
  rate: number | null;
};

/** Quality band for the rate — higher acceptance = healthier signal; null (no findings) reads as neutral. */
function acceptanceStatus(rate: number | null): Status {
  if (rate === null) return "info";
  if (rate >= 0.6) return "ready";
  if (rate >= 0.3) return "warn";
  return "degraded";
}

function acceptanceBandLabel(rate: number | null): string {
  if (rate === null) return "no findings";
  if (rate >= 0.6) return "healthy";
  if (rate >= 0.3) return "mixed";
  return "low";
}

export function AcceptanceRateCard({ acceptance }: { acceptance?: FindingAcceptance }) {
  if (!acceptance) {
    return (
      <AnalyticsCardShell
        title="Finding acceptance rate"
        description="Inline findings the contributor acted on (posted inline → PR merged)."
        state="empty"
        emptyTitle="Not yet available"
        emptyHint="Acceptance tracking appears once inline findings are posted and their PRs resolve in the analytics window."
      />
    );
  }

  const { windowDays, accepted, total, rate } = acceptance;
  const value = rate === null ? "—" : `${Math.round(rate * 100)}%`;

  return (
    <AnalyticsCardShell
      title="Finding acceptance rate"
      description="Inline findings the contributor acted on (posted inline → PR merged)."
      state="ready"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Stat
          label="Acceptance rate"
          value={value}
          hint={
            <span className="text-muted-foreground">
              {accepted} of {total} inline finding{total === 1 ? "" : "s"} acted on
            </span>
          }
        />
        <div className="flex items-center gap-2">
          <StatusPill status={acceptanceStatus(rate)}>{acceptanceBandLabel(rate)}</StatusPill>
          <StatusPill status="info">{windowDays}d window</StatusPill>
        </div>
      </div>
    </AnalyticsCardShell>
  );
}
