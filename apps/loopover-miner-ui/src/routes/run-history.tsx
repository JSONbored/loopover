import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "@loopover/ui-kit/components/badge";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Skeleton } from "@loopover/ui-kit/components/skeleton";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import { TablePagination } from "../components/table-pagination";
import { usePagedRows } from "../lib/paged-rows";
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
  const rows = result?.ok ? result.rows : [];
  const { visible, isPaginated, page, pageCount, setPage } = usePagedRows(rows);

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
      <RunStateTable rows={visible} />
      {isPaginated && <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />}
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
