import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";

import { Button } from "@loopover/ui-kit/components/button";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@loopover/ui-kit/components/chart";
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
  fetchPortfolioQueueItems,
  requeuePortfolioQueueItem,
  releasePortfolioQueueItem,
  type PortfolioQueueActionItem,
  type PortfolioQueueActionResult,
  type PortfolioQueueItemsResult,
} from "../lib/portfolio-queue-actions";
import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";
import {
  fetchPortfolioQueue,
  QUEUE_STATUSES,
  type PortfolioQueueResult,
  type PortfolioRepoSummary,
  type QueueStatus,
  type QueueStatusCounts,
} from "../lib/portfolio-queue";

export const Route = createFileRoute("/portfolio")({
  component: PortfolioPage,
});

// Portfolio/queue summary cards + per-repo table (#4306, reunified with the CLI's own richer `queue dashboard`
// by #4846), plus release/requeue controls (#4857) backed by the same store methods the CLI uses.
//
// #6511: the hand-rolled loading/error/empty `<p>` branches are replaced by the shared @loopover/ui-kit
// `StateBoundary`, with content-shaped `Skeleton` placeholders so the layout doesn't jump when the poll lands.
// The summary and the queue-actions section each keep their OWN independent boundary — a failure in one must
// not blank the other.
//
// #6831: status cards gain a ui-kit `ChartContainer` bar chart (so the bare numbers aren't the only signal),
// and both the per-repo table + the queue-actions table paginate client-side via the kit's `Pagination` once
// they exceed PAGE_SIZE rows — matching the ledgers restyle (#6832) and run-history (#6510). Purely
// presentational: `lib/portfolio-queue.ts` / `lib/portfolio-queue-actions.ts`, the poll/fetch loops, and the
// release/requeue Button wiring stay untouched.

const STATUS_LABELS: Record<QueueStatus, string> = {
  queued: "Queued",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_TONE: Record<QueueStatus, string> = {
  queued: "text-muted-foreground",
  in_progress: "text-warning",
  done: "text-success",
};

/** Rows per page once a repos/actions table grows past this; below it the full table renders unpaginated. */
const PAGE_SIZE = 20;

const QUEUE_CHART_CONFIG = {
  count: { label: "Queue items" },
  queued: { label: "Queued", color: "var(--muted-foreground)" },
  in_progress: { label: "In progress", color: "var(--warning)" },
  done: { label: "Done", color: "var(--success)" },
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

/** Horizontal bar chart of queue status counts — the chart.tsx adoption for the status cards section (#6831).
 *  Cards still show the exact numbers; the chart is the glanceable breakdown the bare `<dd>`s alone weren't. */
function QueueStatusChart({ byStatus }: { byStatus: QueueStatusCounts }) {
  const data = QUEUE_STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    count: byStatus[status],
  }));
  return (
    <ChartContainer config={QUEUE_CHART_CONFIG} className="aspect-auto h-40 w-full" aria-label="Queue by status chart">
      <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={88}
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

function ReposTable({ repos }: { repos: PortfolioRepoSummary[] }) {
  const [page, setPage] = useState(0);
  // Sorted by total desc (then name) so the busiest repos surface first — same "sort then page" shape as the
  // ledgers CountTable (#6832), without inventing interactive column headers.
  const sorted = [...repos].sort((a, b) => b.total - a.total || a.repoFullName.localeCompare(b.repoFullName));
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const isPaginated = sorted.length > PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const visible = isPaginated ? sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE) : sorted;
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repository</TableHead>
            <TableHead>Queued</TableHead>
            <TableHead>In progress</TableHead>
            <TableHead>Done</TableHead>
            <TableHead>Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((repo) => (
            <TableRow key={repo.repoFullName}>
              <TableCell className="font-mono text-foreground">{repo.repoFullName}</TableCell>
              <TableCell>{repo.byStatus.queued}</TableCell>
              <TableCell>{repo.byStatus.in_progress}</TableCell>
              <TableCell>{repo.byStatus.done}</TableCell>
              <TableCell>{repo.total}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isPaginated && <TablePagination page={safePage} pageCount={pageCount} onPageChange={setPage} />}
    </div>
  );
}

function QueueActionsTable({
  items,
  pending,
  onRelease,
  onRequeue,
}: {
  items: PortfolioQueueActionItem[];
  pending: boolean;
  onRelease: (item: PortfolioQueueActionItem) => void;
  onRequeue: (item: PortfolioQueueActionItem) => void;
}) {
  const [page, setPage] = useState(0);
  // in_progress before done, then repo/identifier — actionable release rows float to the top of page 1.
  const sorted = [...items].sort((a, b) => {
    const statusOrder = (status: PortfolioQueueActionItem["status"]) => (status === "in_progress" ? 0 : 1);
    return (
      statusOrder(a.status) - statusOrder(b.status) ||
      a.repoFullName.localeCompare(b.repoFullName) ||
      a.identifier.localeCompare(b.identifier)
    );
  });
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const isPaginated = sorted.length > PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const visible = isPaginated ? sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE) : sorted;
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repository</TableHead>
            <TableHead>Identifier</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((item) => (
            <TableRow key={`${item.apiBaseUrl}:${item.repoFullName}:${item.identifier}`}>
              <TableCell className="font-mono text-foreground">{item.repoFullName}</TableCell>
              <TableCell className="font-mono">{item.identifier}</TableCell>
              <TableCell>{STATUS_LABELS[item.status]}</TableCell>
              <TableCell>
                {item.status === "in_progress" ? (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => onRelease(item)}>
                    Release
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => onRequeue(item)}>
                    Requeue
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isPaginated && <TablePagination page={safePage} pageCount={pageCount} onPageChange={setPage} />}
    </div>
  );
}

/** Placeholder shaped like the real summary -- three status cards, the status chart, and the repo table -- so
 *  the layout doesn't jump when the 10s poll lands. A single generic bar would just move the jump later. */
function PortfolioQueueSkeleton() {
  return (
    <div
      className="grid gap-6"
      data-testid="portfolio-queue-skeleton"
      role="status"
      aria-label="Loading local portfolio queue"
    >
      <dl className="grid gap-4 sm:grid-cols-3">
        {QUEUE_STATUSES.map((status) => (
          <Card key={status}>
            <CardContent className="p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-8 w-12" />
            </CardContent>
          </Card>
        ))}
      </dl>
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={`repo-row-${row}`} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export function PortfolioQueueView({ result }: { result: PortfolioQueueResult | null }) {
  const summary = result?.ok ? result.summary : null;
  return (
    <StateBoundary
      isLoading={result === null}
      isError={result !== null && !result.ok}
      isEmpty={summary !== null && summary.total === 0}
      loadingSkeleton={<PortfolioQueueSkeleton />}
      // Each message is passed as the WHOLE original sentence with the description suppressed, rather than
      // split across title/description: the issue requires the user-visible strings not be reworded, and Shell
      // renders `{description && ...}` so an empty one adds nothing. The rendered text is byte-identical to the
      // <p> tags this replaces. ErrorState emits role="alert" itself, so failures still announce the same way.
      errorTitle={
        result !== null && !result.ok ? `Could not read the local portfolio queue: ${result.error}` : undefined
      }
      errorDescription=""
      emptyTitle="No queued work yet — the cards fill in once the miner enqueues its first portfolio item."
      emptyDescription={null}
    >
      {summary === null ? null : (
        <div className="grid gap-6">
          <dl className="grid gap-4 sm:grid-cols-3">
            {QUEUE_STATUSES.map((status) => (
              <Card key={status}>
                <CardContent className="p-4">
                  <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">
                    {STATUS_LABELS[status]}
                  </dt>
                  <dd className={`mt-1 text-token-3xl font-display font-semibold ${STATUS_TONE[status]}`}>
                    {summary.byStatus[status]}
                  </dd>
                </CardContent>
              </Card>
            ))}
          </dl>
          <QueueStatusChart byStatus={summary.byStatus} />
          <ReposTable repos={summary.repos} />
        </div>
      )}
    </StateBoundary>
  );
}

/** Placeholder shaped like the queue-actions table's rows, for the same reason as the summary's. */
function QueueActionsSkeleton() {
  return (
    <div
      className="grid gap-2"
      data-testid="queue-actions-skeleton"
      role="status"
      aria-label="Loading actionable queue items"
    >
      {[0, 1, 2].map((row) => (
        <Skeleton key={`action-row-${row}`} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function PortfolioQueueActionsSection({
  result,
  actionResult,
  pending,
  onRelease,
  onRequeue,
}: {
  result: PortfolioQueueItemsResult | null;
  actionResult: PortfolioQueueActionResult | null;
  pending: boolean;
  onRelease: (item: PortfolioQueueActionItem) => void;
  onRequeue: (item: PortfolioQueueActionItem) => void;
}) {
  return (
    <section className="grid gap-3">
      <h3 className="font-display text-token-base font-semibold">Queue actions</h3>
      {actionResult !== null && !actionResult.ok ? (
        <p role="alert" className="text-token-sm text-danger">
          Queue action failed: {actionResult.error}
        </p>
      ) : null}
      {/* Its own boundary, deliberately: this fetch is independent of the summary above, so a failure here
          must not blank the summary -- and a summary failure must not hide the actions. Same whole-sentence
          treatment as above, so the empty/error copy stays byte-identical to the <p> tags it replaces. */}
      <StateBoundary
        isLoading={result === null}
        isError={result !== null && !result.ok}
        isEmpty={result !== null && result.ok && result.items.length === 0}
        loadingSkeleton={<QueueActionsSkeleton />}
        errorTitle={
          result !== null && !result.ok ? `Could not read actionable queue items: ${result.error}` : undefined
        }
        errorDescription=""
        emptyTitle="No in-progress or completed items to release or requeue right now."
        emptyDescription={null}
      >
        {result === null || !result.ok || result.items.length === 0 ? null : (
          <QueueActionsTable items={result.items} pending={pending} onRelease={onRelease} onRequeue={onRequeue} />
        )}
      </StateBoundary>
    </section>
  );
}

export function PortfolioPage({
  loadPortfolioQueue = fetchPortfolioQueue,
  loadPortfolioQueueItems = fetchPortfolioQueueItems,
  releaseItem = releasePortfolioQueueItem,
  requeueItem = requeuePortfolioQueueItem,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadPortfolioQueue?: () => Promise<PortfolioQueueResult>;
  loadPortfolioQueueItems?: () => Promise<PortfolioQueueItemsResult>;
  releaseItem?: typeof releasePortfolioQueueItem;
  requeueItem?: typeof requeuePortfolioQueueItem;
  pollIntervalMs?: number;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const [itemsResult, setItemsResult] = useState<PortfolioQueueItemsResult | null>(null);
  const [actionResult, setActionResult] = useState<PortfolioQueueActionResult | null>(null);

  const loadSummary = useCallback(() => loadPortfolioQueue(), [loadPortfolioQueue, refreshKey]);
  const summaryResult = usePolledFetch(loadSummary, pollIntervalMs);

  const refreshItems = useCallback(() => {
    void loadPortfolioQueueItems().then(setItemsResult);
  }, [loadPortfolioQueueItems, refreshKey]);

  useEffect(() => {
    refreshItems();
  }, [refreshItems]);

  const runQueueAction = (action: () => Promise<PortfolioQueueActionResult>) => {
    setActionPending(true);
    void action().then((next) => {
      setActionResult(next);
      if (next.ok) {
        setRefreshKey((key) => key + 1);
        refreshItems();
      }
      setActionPending(false);
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Portfolio queue</h2>
        <p className="text-token-sm text-muted-foreground">
          Local summary and controls for the miner&apos;s portfolio queue (`miner_portfolio_queue`).
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <PortfolioQueueView result={summaryResult} />
          <PortfolioQueueActionsSection
            result={itemsResult}
            actionResult={actionResult}
            pending={actionPending}
            onRelease={(item) => runQueueAction(() => releaseItem(item))}
            onRequeue={(item) => runQueueAction(() => requeueItem(item))}
          />
        </div>
      </CardContent>
    </Card>
  );
}
