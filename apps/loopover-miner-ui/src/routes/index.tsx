import { createFileRoute } from "@tanstack/react-router";

import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Skeleton } from "@loopover/ui-kit/components/skeleton";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";

import { fetchLedgers, type LedgersResult } from "../lib/ledgers";
import { fetchPortfolioQueue, type PortfolioQueueResult } from "../lib/portfolio-queue";
import { fetchRunStates, type RunHistoryResult } from "../lib/run-history";
import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

// Overview dashboard (#4853): replaces the Phase-6 placeholder with a live, at-a-glance summary of real miner
// state — run activity, portfolio queue, and claims — aggregated from the same local read-only APIs the dedicated
// views use (run-state, portfolio-queue, ledgers). Each card degrades independently: it shows its own loading or
// error surface without taking the others down. Live-refreshed on the shared poll cadence (#4856).
//
// #6509: the per-card loading/error surface is the shared `StateBoundary` + content-shaped `Skeleton` from
// @loopover/ui-kit (the same primitives the main app's routes already use), replacing this route's own
// hand-rolled "Loading …" / "Could not read …" text. The skeleton mirrors each card's Stat rows so the layout
// doesn't shift once data arrives, and — unlike a flat gray sentence re-rendered every 10s poll — reads as a
// live placeholder. Errors auto-recover on the next successful poll, so no manual retry action is wired.

/** One metric line inside a summary card. */
function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-token-sm text-muted-foreground">{label}</span>
      <span className={`font-display text-token-lg font-semibold ${tone ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h3 className="font-display text-token-base font-semibold">{title}</h3>
      </CardHeader>
      <CardContent className="grid gap-2">{children}</CardContent>
    </Card>
  );
}

/** Content-shaped loading placeholder for a summary card: `rows` shimmer lines mirroring the `Stat` label/value
 *  layout, so the card keeps its height and the content doesn't jump once the poll resolves. `role="status"`
 *  keeps the loading state announced to assistive tech (the flat "Loading …" text it replaces was announced too). */
function CardStatsSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div className="grid gap-2" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-baseline justify-between gap-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-12" />
        </div>
      ))}
    </div>
  );
}

export function OverviewRunsCard({ runs }: { runs: RunHistoryResult | null }) {
  return (
    <SummaryCard title="Run activity">
      <StateBoundary
        isLoading={runs === null}
        isError={runs !== null && !runs.ok}
        loadingSkeleton={<CardStatsSkeleton rows={2} label="Loading run activity" />}
        errorTitle="Couldn't read run state"
        errorDescription="The local run-state API didn't respond. This refreshes automatically."
      >
        {runs?.ok && (
          <>
            <Stat label="Repositories tracked" value={runs.rows.length} />
            <Stat
              label="Currently working"
              value={runs.rows.filter((row) => row.state !== "idle").length}
              tone="text-success"
            />
          </>
        )}
      </StateBoundary>
    </SummaryCard>
  );
}

export function OverviewPortfolioCard({ portfolio }: { portfolio: PortfolioQueueResult | null }) {
  return (
    <SummaryCard title="Portfolio queue">
      <StateBoundary
        isLoading={portfolio === null}
        isError={portfolio !== null && !portfolio.ok}
        loadingSkeleton={<CardStatsSkeleton rows={4} label="Loading the portfolio queue" />}
        errorTitle="Couldn't read the portfolio queue"
        errorDescription="The local portfolio-queue API didn't respond. This refreshes automatically."
      >
        {portfolio?.ok && (
          <>
            <Stat label="Total items" value={portfolio.summary.total} />
            <Stat label="Queued" value={portfolio.summary.byStatus.queued} />
            <Stat label="In progress" value={portfolio.summary.byStatus.in_progress} tone="text-warning" />
            <Stat label="Done" value={portfolio.summary.byStatus.done} tone="text-success" />
            {/* Deliver the CLI/web-UI parity the portfolio-queue data path promises (#6185): the CLI's `queue
                dashboard` renders "oldest-queued: Xm" (portfolio-dashboard.js), and the same minutes-rounded age
                is shown here. Omitted (like the CLI) when the queue is empty and the age is null. */}
            {portfolio.summary.oldestQueuedAgeMs !== null && (
              <Stat label="Oldest queued" value={`${Math.round(portfolio.summary.oldestQueuedAgeMs / 60000)}m`} />
            )}
          </>
        )}
      </StateBoundary>
    </SummaryCard>
  );
}

export function OverviewClaimsCard({ claims }: { claims: LedgersResult | null }) {
  return (
    <SummaryCard title="Claims">
      <StateBoundary
        isLoading={claims === null}
        isError={claims !== null && !claims.ok}
        loadingSkeleton={<CardStatsSkeleton rows={2} label="Loading the claim ledger" />}
        errorTitle="Couldn't read the claim ledger"
        errorDescription="The local ledgers API didn't respond. This refreshes automatically."
      >
        {claims?.ok && (
          <>
            <Stat label="Active" value={claims.summary.claims.byStatus.active} tone="text-success" />
            <Stat label="Total recorded" value={claims.summary.claims.total} />
          </>
        )}
      </StateBoundary>
    </SummaryCard>
  );
}

export function OverviewView({
  runs,
  portfolio,
  claims,
}: {
  runs: RunHistoryResult | null;
  portfolio: PortfolioQueueResult | null;
  claims: LedgersResult | null;
}) {
  return (
    <div className="grid gap-6">
      <div>
        <h2 className="font-display text-token-lg font-semibold">Overview</h2>
        <p className="text-token-sm text-muted-foreground">
          A live, read-only snapshot of the miner&apos;s current state, refreshed automatically.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <OverviewRunsCard runs={runs} />
        <OverviewPortfolioCard portfolio={portfolio} />
        <OverviewClaimsCard claims={claims} />
      </div>
    </div>
  );
}

export function IndexPage({
  loadRuns = fetchRunStates,
  loadPortfolio = fetchPortfolioQueue,
  loadClaims = fetchLedgers,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadRuns?: () => Promise<RunHistoryResult>;
  loadPortfolio?: () => Promise<PortfolioQueueResult>;
  loadClaims?: () => Promise<LedgersResult>;
  pollIntervalMs?: number;
}) {
  const { result: runs } = usePolledFetch(loadRuns, pollIntervalMs);
  const { result: portfolio } = usePolledFetch(loadPortfolio, pollIntervalMs);
  const { result: claims } = usePolledFetch(loadClaims, pollIntervalMs);
  return <OverviewView runs={runs} portfolio={portfolio} claims={claims} />;
}
