import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";

import { Button } from "@loopover/ui-kit/components/button";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@loopover/ui-kit/components/chart";
import { Input } from "@loopover/ui-kit/components/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@loopover/ui-kit/components/pagination";
import { Skeleton } from "@loopover/ui-kit/components/skeleton";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import {
  CLAIM_STATUSES,
  fetchLedgers,
  type ClaimStatus,
  type ClaimStatusCounts,
  type EventFeedEntry,
  type LedgersResult,
  type LedgersSummary,
} from "../lib/ledgers";
import { fetchGovernorPauseState, pauseGovernor, resumeGovernor, type GovernorPauseStateResult } from "../lib/governor";
import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";

export const Route = createFileRoute("/ledgers")({
  component: LedgersPage,
});

// Read-only views over the miner's local claim / event / governor ledgers (#4855). All three are aggregated
// server-side (see vite-ledgers-api.ts) to status/type counts plus a small feed of SAFE columns — raw payloads
// and the free-text claim note never reach this component.
//
// #6512: the two hand-rolled loading/error/empty `<p>` blocks (the read-only ledger summary, and the SEPARATE
// governor control section) are each replaced by the shared @loopover/ui-kit `StateBoundary`, with a
// content-shaped `Skeleton` placeholder for the loading state so the layout doesn't jump when the poll resolves.
// The two flows keep their OWN independent boundary — a governor-state fetch failure must not blank the ledger
// summary, and vice-versa.
//
// #6832: claims status cards gain a ui-kit `ChartContainer` bar chart (so the bare numbers aren't the only
// signal), and both event count-tables + the recent-events feed paginate client-side via the kit's `Pagination`
// once they exceed PAGE_SIZE rows — matching the run-history restyle (#6510). Purely presentational:
// `lib/ledgers.ts`/`lib/governor.ts`, the two fetch loops, and the pause/resume Button wiring stay untouched.
//
// The governor control section below is a SEPARATE fetch/action loop from the read-only ledger summary above
// (#4857, the governor half): it reads/writes the governor's pause state via vite-governor-api.ts, the
// miner-ui's first write-capable endpoint, safe only because vite-auth.ts (#4858) now authenticates every
// /api/* request. It does not touch, and is unrelated to, the governor EVENT ledger already shown below.

const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  active: "Active",
  released: "Released",
  expired: "Expired",
};

const CLAIM_STATUS_TONE: Record<ClaimStatus, string> = {
  active: "text-success",
  released: "text-muted-foreground",
  expired: "text-warning",
};

/** Rows per page once a count/feed table grows past this; below it the full table renders unpaginated. */
const PAGE_SIZE = 20;

const CLAIMS_CHART_CONFIG = {
  count: { label: "Claims" },
  active: { label: "Active", color: "var(--success)" },
  released: { label: "Released", color: "var(--muted-foreground)" },
  expired: { label: "Expired", color: "var(--warning)" },
} satisfies ChartConfig;

function TablePagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (next: number) => void;
}) {
  return (
    <Pagination className="mt-4">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            aria-disabled={page === 0}
            onClick={(event) => {
              event.preventDefault();
              onPageChange(Math.max(0, page - 1));
            }}
          />
        </PaginationItem>
        {Array.from({ length: pageCount }).map((_, index) => (
          <PaginationItem key={index}>
            <PaginationLink
              href="#"
              isActive={index === page}
              onClick={(event) => {
                event.preventDefault();
                onPageChange(index);
              }}
            >
              {index + 1}
            </PaginationLink>
          </PaginationItem>
        ))}
        <PaginationItem>
          <PaginationNext
            href="#"
            aria-disabled={page >= pageCount - 1}
            onClick={(event) => {
              event.preventDefault();
              onPageChange(Math.min(pageCount - 1, page + 1));
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

function CountTable({ counts, keyLabel }: { counts: Record<string, number>; keyLabel: string }) {
  const [page, setPage] = useState(0);
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const isPaginated = entries.length > PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const visible = isPaginated ? entries.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE) : entries;
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{keyLabel}</TableHead>
            <TableHead>Count</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map(([type, count]) => (
            <TableRow key={type}>
              <TableCell className="font-mono text-foreground">{type}</TableCell>
              <TableCell>{count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isPaginated && <TablePagination page={safePage} pageCount={pageCount} onPageChange={setPage} />}
    </div>
  );
}

function RecentEventsTable({ entries }: { entries: EventFeedEntry[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const isPaginated = entries.length > PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const visible = isPaginated ? entries.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE) : entries;
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event type</TableHead>
            <TableHead>Repository</TableHead>
            <TableHead>Recorded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((entry, index) => (
            <TableRow key={`${entry.eventType}-${entry.createdAt ?? index}`}>
              <TableCell className="font-mono text-foreground">{entry.eventType}</TableCell>
              <TableCell className="font-mono">{entry.repoFullName ?? "—"}</TableCell>
              <TableCell>{entry.createdAt ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isPaginated && <TablePagination page={safePage} pageCount={pageCount} onPageChange={setPage} />}
    </div>
  );
}

/** Horizontal bar chart of claim status counts — the chart.tsx adoption for the claims cards section (#6832).
 *  Cards still show the exact numbers; the chart is the glanceable breakdown the bare `<dd>`s alone weren't. */
function ClaimsStatusChart({ byStatus }: { byStatus: ClaimStatusCounts }) {
  const data = CLAIM_STATUSES.map((status) => ({
    status,
    label: CLAIM_STATUS_LABELS[status],
    count: byStatus[status],
  }));
  return (
    <ChartContainer
      config={CLAIMS_CHART_CONFIG}
      className="aspect-auto h-40 w-full"
      aria-label="Claims by status chart"
    >
      <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={72}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
        />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="count" radius={4}>
          {data.map((entry) => (
            <Cell key={entry.status} fill={`var(--color-${entry.status})`} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/** Card+chart+table-shaped loading placeholder for the ledger summary: mirrors the 3 status cards, the claims
 *  chart, and the stacked count/feed tables below them, so the summary keeps its shape while the first fetch
 *  resolves. `role="status"` keeps the loading state announced to assistive tech (as the flat "Loading local
 *  ledgers…" text it replaces was). */
function LedgerSummarySkeleton() {
  return (
    <div className="grid gap-6" role="status" aria-label="Loading local ledgers">
      <section className="grid gap-3">
        <Skeleton className="h-5 w-28" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Card key={index}>
              <CardContent className="p-4">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-8 w-12" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
      </section>
      {Array.from({ length: 2 }).map((_, index) => (
        <section key={index} className="grid gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </section>
      ))}
    </div>
  );
}

/** Row-shaped loading placeholder for the governor control section: a status line plus an action-sized block,
 *  matching the "Not paused / Resume" row it stands in for. Its own `role="status"` announces this flow
 *  independently of the ledger-summary skeleton above. */
function GovernorControlSkeleton() {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-token-sm bg-muted/40 p-3"
      role="status"
      aria-label="Loading governor state"
    >
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-9 w-28" />
    </div>
  );
}

function LedgersSummaryContent({ summary }: { summary: LedgersSummary }) {
  const { claims, events, governor } = summary;
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Claims ({claims.total})</h3>
        <dl className="grid gap-4 sm:grid-cols-3">
          {CLAIM_STATUSES.map((status) => (
            <Card key={status}>
              <CardContent className="p-4">
                <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">
                  {CLAIM_STATUS_LABELS[status]}
                </dt>
                <dd className={`mt-1 text-token-3xl font-display font-semibold ${CLAIM_STATUS_TONE[status]}`}>
                  {claims.byStatus[status]}
                </dd>
              </CardContent>
            </Card>
          ))}
        </dl>
        <ClaimsStatusChart byStatus={claims.byStatus} />
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Governor events ({governor.total})</h3>
        {governor.total === 0 ? (
          <p className="text-token-sm text-muted-foreground">No governor events recorded.</p>
        ) : (
          <CountTable counts={governor.byEventType} keyLabel="Event type" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Events by type ({events.total})</h3>
        {events.total === 0 ? (
          <p className="text-token-sm text-muted-foreground">No events recorded.</p>
        ) : (
          <CountTable counts={events.byType} keyLabel="Event type" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Recent events ({events.total})</h3>
        {events.recent.length === 0 ? (
          <p className="text-token-sm text-muted-foreground">No event-ledger entries recorded.</p>
        ) : (
          <RecentEventsTable entries={events.recent} />
        )}
      </section>
    </div>
  );
}

export function GovernorControlSection({
  result,
  pending,
  onPause,
  onResume,
}: {
  result: GovernorPauseStateResult | null;
  pending: boolean;
  onPause: (reason?: string) => void;
  onResume: () => void;
}) {
  // Optional pause reason, mirroring the CLI's `governor pause [--reason <text>]`; an empty field
  // is passed through as `undefined` so it matches the CLI's own optional-flag behavior.
  const [reason, setReason] = useState("");
  // #7079: once a pause succeeds the polled `result` flips to paused; clear the reason so a later
  // resume→pause starts from a blank input. Done with React's "info from previous renders" pattern (a
  // render-phase reset when `paused` turns true) rather than an effect. A FAILED pause leaves `result.ok`
  // false and never sets `paused`, so the reason is preserved for a retry.
  const paused = result?.ok === true && result.pauseState.paused;
  const [wasPaused, setWasPaused] = useState(paused);
  if (paused !== wasPaused) {
    setWasPaused(paused);
    if (paused) setReason("");
  }
  const errorText = result !== null && !result.ok ? result.error : undefined;
  return (
    <section className="grid gap-3">
      <h3 className="font-display text-token-base font-semibold">Governor control</h3>
      <StateBoundary
        isLoading={result === null}
        isError={result !== null && !result.ok}
        loadingSkeleton={<GovernorControlSkeleton />}
        errorTitle="Couldn't read the local governor state"
        errorDescription={errorText}
      >
        {result?.ok && (
          <div className="flex flex-wrap items-center gap-3 rounded-token-sm bg-muted/40 p-3">
            <p className="text-token-sm text-muted-foreground">
              {result.pauseState.paused
                ? `Paused since ${result.pauseState.pausedAt}${result.pauseState.reason ? ` (${result.pauseState.reason})` : ""}`
                : "Not paused"}
            </p>
            {result.pauseState.paused ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={onResume} className="ml-auto">
                Resume governor
              </Button>
            ) : (
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <Input
                  type="text"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={pending}
                  placeholder="Reason (optional)"
                  aria-label="Pause reason"
                  className="w-auto flex-1 min-w-[12rem]"
                />
                <Button size="sm" variant="destructive" disabled={pending} onClick={() => onPause(reason || undefined)}>
                  Pause governor
                </Button>
              </div>
            )}
          </div>
        )}
      </StateBoundary>
    </section>
  );
}

export function LedgersView({ result }: { result: LedgersResult | null }) {
  const summary = result?.ok ? result.summary : null;
  const isEmpty =
    summary !== null && summary.claims.total === 0 && summary.events.total === 0 && summary.governor.total === 0;
  const errorText = result !== null && !result.ok ? result.error : undefined;
  return (
    <StateBoundary
      isLoading={result === null}
      isError={result !== null && !result.ok}
      isEmpty={isEmpty}
      loadingSkeleton={<LedgerSummarySkeleton />}
      errorTitle="Couldn't read the local ledgers"
      errorDescription={errorText}
      emptyTitle="No ledger activity yet"
      emptyDescription="Claims, events, and governor entries appear here once the miner starts working."
    >
      {summary && <LedgersSummaryContent summary={summary} />}
    </StateBoundary>
  );
}

export function LedgersPage({
  loadLedgers = fetchLedgers,
  loadGovernorPauseState = fetchGovernorPauseState,
  pauseGovernorAction = pauseGovernor,
  resumeGovernorAction = resumeGovernor,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadLedgers?: () => Promise<LedgersResult>;
  loadGovernorPauseState?: () => Promise<GovernorPauseStateResult>;
  pauseGovernorAction?: (reason?: string) => Promise<GovernorPauseStateResult>;
  resumeGovernorAction?: () => Promise<GovernorPauseStateResult>;
  pollIntervalMs?: number;
}) {
  const [pauseState, setPauseState] = useState<GovernorPauseStateResult | null>(null);
  const [lastPolledPauseState, setLastPolledPauseState] = useState<GovernorPauseStateResult | null>(null);
  const [actionPending, setActionPending] = useState(false);

  // Join the app's shared live-refresh cadence so newly-recorded claims/events appear without a manual reload,
  // matching the Overview page's claims card that reads the same data source (#7082).
  const { result } = usePolledFetch(loadLedgers, pollIntervalMs);

  // Poll the governor pause-state on the same cadence. Each fresh poll result is synced into `pauseState` during
  // render, while the operator's own pause/resume action writes `pauseState` directly so it reflects immediately,
  // not only on the next tick (#7082).
  const { result: polledPauseState } = usePolledFetch(loadGovernorPauseState, pollIntervalMs);
  if (polledPauseState !== lastPolledPauseState) {
    setLastPolledPauseState(polledPauseState);
    setPauseState(polledPauseState);
  }

  const runGovernorAction = (action: () => Promise<GovernorPauseStateResult>) => {
    setActionPending(true);
    void action().then((next) => {
      setPauseState(next);
      setActionPending(false);
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Ledgers</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only summary of the miner&apos;s claim, event, and governor ledgers.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <GovernorControlSection
            result={pauseState}
            pending={actionPending}
            onPause={(reason) => runGovernorAction(() => pauseGovernorAction(reason))}
            onResume={() => runGovernorAction(resumeGovernorAction)}
          />
          <LedgersView result={result} />
        </div>
      </CardContent>
    </Card>
  );
}
