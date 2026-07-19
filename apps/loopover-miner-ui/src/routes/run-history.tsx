import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "@loopover/ui-kit/components/badge";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
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

import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";
import {
  fetchRunStates,
  forgeHostLabel,
  runStateRowKey,
  type RunHistoryResult,
  type RunStateRow,
} from "../lib/run-history";

export const Route = createFileRoute("/run-history")({
  component: RunHistoryPage,
});

// Read-only run-history table (#4305): one row per (forge, repo) from the local `miner_run_state` store,
// served by the dev server's local API. No writes, no new state.
//
// #6510: the hand-rolled loading/error/empty `<p>` branches are replaced by the shared @loopover/ui-kit
// `StateBoundary`, with a content-shaped `Skeleton` table for the loading state (so the layout doesn't jump when
// the poll resolves), and the table paginates client-side once it exceeds PAGE_SIZE rows via the kit's
// `Pagination`. Purely presentational — `lib/run-history.ts`'s fetch/poll is untouched.
//
// #7080: rows are keyed and labeled by (apiBaseUrl, repoFullName) so the same owner/repo on two forge hosts
// never collides or looks identical.

const STATE_BADGE_VARIANT: Record<RunStateRow["state"], "secondary" | "outline"> = {
  idle: "secondary",
  discovering: "outline",
  planning: "outline",
  preparing: "outline",
};

/** Rows per page once the run-state table grows past this; below it the full table renders unpaginated. */
const PAGE_SIZE = 20;

const TABLE_COLUMNS = ["Repository", "Forge", "State", "Last updated"] as const;

function RunHistoryTableHeader() {
  return (
    <TableHeader>
      <TableRow>
        {TABLE_COLUMNS.map((column) => (
          <TableHead key={column}>{column}</TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/** Table-shaped loading placeholder: header + `rows` shimmer rows matching the real column layout, so the table
 *  keeps its shape and the content doesn't jump once the poll resolves. `role="status"` keeps the loading state
 *  announced to assistive tech (as the flat "Loading…" text it replaces was). */
function RunHistorySkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading local run state">
      <Table>
        <RunHistoryTableHeader />
        <TableBody>
          {Array.from({ length: rows }).map((_, index) => (
            <TableRow key={index}>
              <TableCell>
                <Skeleton className="h-4 w-48" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-36" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-32" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RunStateTable({ rows }: { rows: RunStateRow[] }) {
  return (
    <Table>
      <RunHistoryTableHeader />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={runStateRowKey(row)}>
            <TableCell className="font-mono text-foreground">{row.repoFullName}</TableCell>
            <TableCell className="font-mono text-muted-foreground">{forgeHostLabel(row.apiBaseUrl)}</TableCell>
            <TableCell>
              <Badge variant={STATE_BADGE_VARIANT[row.state]}>{row.state}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{row.updatedAt}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RunHistoryView({ result }: { result: RunHistoryResult | null }) {
  const [page, setPage] = useState(0);
  const rows = result?.ok ? result.rows : [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const isPaginated = rows.length > PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = isPaginated ? rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE) : rows;

  return (
    <StateBoundary
      isLoading={result === null}
      isError={result !== null && !result.ok}
      isEmpty={result !== null && result.ok && result.rows.length === 0}
      loadingSkeleton={<RunHistorySkeleton />}
      errorTitle="Couldn't read local run state"
      errorDescription="The local run-state API didn't respond. This refreshes automatically on the next poll."
      emptyTitle="No local run state yet"
      emptyDescription="The table fills in once the miner records its first repo run."
    >
      <RunStateTable rows={visibleRows} />
      {isPaginated && (
        <Pagination className="mt-4">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={safePage === 0}
                onClick={(event) => {
                  event.preventDefault();
                  setPage((current) => Math.max(0, current - 1));
                }}
              />
            </PaginationItem>
            {Array.from({ length: pageCount }).map((_, index) => (
              <PaginationItem key={index}>
                <PaginationLink
                  href="#"
                  isActive={index === safePage}
                  onClick={(event) => {
                    event.preventDefault();
                    setPage(index);
                  }}
                >
                  {index + 1}
                </PaginationLink>
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={safePage >= pageCount - 1}
                onClick={(event) => {
                  event.preventDefault();
                  setPage((current) => Math.min(pageCount - 1, current + 1));
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </StateBoundary>
  );
}

export function RunHistoryPage({
  loadRunStates = fetchRunStates,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadRunStates?: () => Promise<RunHistoryResult>;
  pollIntervalMs?: number;
}) {
  const { result } = usePolledFetch(loadRunStates, pollIntervalMs);

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Run history</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only view over the miner&apos;s per-repo run state (`miner_run_state`).
        </p>
      </CardHeader>
      <CardContent>
        <RunHistoryView result={result} />
      </CardContent>
    </Card>
  );
}
