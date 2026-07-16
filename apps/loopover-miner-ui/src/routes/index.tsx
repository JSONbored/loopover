import { createFileRoute } from "@tanstack/react-router";

import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";

import { fetchLedgers, type LedgersResult } from "../lib/ledgers";
import { fetchPortfolioQueue, formatOldestQueuedAge, type PortfolioQueueResult } from "../lib/portfolio-queue";
import { fetchRunStates, type RunHistoryResult } from "../lib/run-history";
import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

// Overview dashboard (#4853): replaces the Phase-6 placeholder with a live, at-a-glance summary of real miner
// state — run activity, portfolio queue, and claims — aggregated from the same local read-only APIs the dedicated
// views use (run-state, portfolio-queue, ledgers). Each card degrades independently: it shows its own loading or
// error message without taking the others down. Live-refreshed on the shared poll cadence (#4856).

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

function Fallback({ state, subject }: { state: "loading" | "error"; subject: string }) {
  return state === "loading" ? (
    <p className="text-token-sm text-muted-foreground">Loading {subject}…</p>
  ) : (
    <p role="alert" className="text-token-sm text-[var(--danger)]">
      Could not read {subject}.
    </p>
  );
}

export function OverviewRunsCard({ runs }: { runs: RunHistoryResult | null }) {
  return (
    <SummaryCard title="Run activity">
      {runs === null ? (
        <Fallback state="loading" subject="run state" />
      ) : !runs.ok ? (
        <Fallback state="error" subject="run state" />
      ) : (
        <>
          <Stat label="Repositories tracked" value={runs.rows.length} />
          <Stat
            label="Currently working"
            value={runs.rows.filter((row) => row.state !== "idle").length}
            tone="text-[var(--success)]"
          />
        </>
      )}
    </SummaryCard>
  );
}

export function OverviewPortfolioCard({ portfolio }: { portfolio: PortfolioQueueResult | null }) {
  return (
    <SummaryCard title="Portfolio queue">
      {portfolio === null ? (
        <Fallback state="loading" subject="the portfolio queue" />
      ) : !portfolio.ok ? (
        <Fallback state="error" subject="the portfolio queue" />
      ) : (
        <>
          <Stat label="Total items" value={portfolio.summary.total} />
          <Stat label="Queued" value={portfolio.summary.byStatus.queued} />
          <Stat label="In progress" value={portfolio.summary.byStatus.in_progress} tone="text-[var(--warning)]" />
          <Stat label="Done" value={portfolio.summary.byStatus.done} tone="text-[var(--success)]" />
          {portfolio.summary.oldestQueuedAgeMs !== null ? (
            <Stat label="Oldest queued" value={formatOldestQueuedAge(portfolio.summary.oldestQueuedAgeMs)} />
          ) : null}
        </>
      )}
    </SummaryCard>
  );
}

export function OverviewClaimsCard({ claims }: { claims: LedgersResult | null }) {
  return (
    <SummaryCard title="Claims">
      {claims === null ? (
        <Fallback state="loading" subject="the claim ledger" />
      ) : !claims.ok ? (
        <Fallback state="error" subject="the claim ledger" />
      ) : (
        <>
          <Stat label="Active" value={claims.summary.claims.byStatus.active} tone="text-[var(--success)]" />
          <Stat label="Total recorded" value={claims.summary.claims.total} />
        </>
      )}
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
  const runs = usePolledFetch(loadRuns, pollIntervalMs);
  const portfolio = usePolledFetch(loadPortfolio, pollIntervalMs);
  const claims = usePolledFetch(loadClaims, pollIntervalMs);
  return <OverviewView runs={runs} portfolio={portfolio} claims={claims} />;
}
