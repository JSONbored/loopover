import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

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
  fetchRankedCandidates,
  formatScorePercent,
  rankedCandidateRowKey,
  type RankedCandidateRow,
  type RankedCandidatesResult,
} from "../lib/ranked-candidates";

export const Route = createFileRoute("/ranked-candidates")({
  component: RankedCandidatesPage,
});

// Read-only ranked-candidates table (#7675): mirrors run-history.tsx's exact data-fetching, loading-state, and
// layout conventions (usePolledFetch + StateBoundary + a content-shaped Skeleton + client-side Pagination above
// PAGE_SIZE rows). `/api/ranked-candidates` already exposes the browser extension's opportunity-badge data --
// the last discover run's full per-issue discovery breakdown (laneFit/freshness/potential/feasibility/dupRisk)
// -- this route is the first miner-ui dashboard consumer of it. Purely presentational: `lib/ranked-candidates.ts`'s
// fetch/poll and `vite-ranked-candidates-api.ts`'s ranking data are both untouched.

/** Rows per page once the ranked-candidates table grows past this; below it the full table renders unpaginated.
 *  Same threshold as run-history / ledgers / portfolio (#6510/#6832/#6511). */
const PAGE_SIZE = 20;

const TABLE_COLUMNS = [
  "Issue",
  "Rank score",
  "Lane fit",
  "Freshness",
  "Potential",
  "Feasibility",
  "Dup risk",
  "Ranked at",
] as const;

function RankedCandidatesTableHeader() {
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
 *  keeps its shape and the content doesn't jump once the poll resolves (mirrors run-history's RunHistorySkeleton).
 *  `role="status"` keeps the loading state announced to assistive tech. */
function RankedCandidatesSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading ranked candidates">
      <Table>
        <RankedCandidatesTableHeader />
        <TableBody>
          {Array.from({ length: rows }).map((_, index) => (
            <TableRow key={index}>
              {TABLE_COLUMNS.map((column) => (
                <TableCell key={column}>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function IssueCell({ row }: { row: RankedCandidateRow }) {
  const label = `${row.repoFullName}#${row.issueNumber} ${row.title}`;
  if (row.htmlUrl === null) {
    return <span className="text-foreground">{label}</span>;
  }
  return (
    <a
      href={row.htmlUrl}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline underline-offset-2 hover:text-primary"
    >
      {label}
    </a>
  );
}

function RankedCandidatesTable({ rows }: { rows: RankedCandidateRow[] }) {
  return (
    <Table>
      <RankedCandidatesTableHeader />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rankedCandidateRowKey(row)}>
            <TableCell className="font-mono text-foreground">
              <IssueCell row={row} />
            </TableCell>
            <TableCell className="text-foreground">{formatScorePercent(row.rankScore)}</TableCell>
            <TableCell className="text-muted-foreground">{formatScorePercent(row.laneFit)}</TableCell>
            <TableCell className="text-muted-foreground">{formatScorePercent(row.freshness)}</TableCell>
            <TableCell className="text-muted-foreground">{formatScorePercent(row.potential)}</TableCell>
            <TableCell className="text-muted-foreground">{formatScorePercent(row.feasibility)}</TableCell>
            <TableCell className="text-muted-foreground">{formatScorePercent(row.dupRisk)}</TableCell>
            <TableCell className="text-muted-foreground">{row.rankedAt}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RankedCandidatesView({ result }: { result: RankedCandidatesResult | null }) {
  const [page, setPage] = useState(0);
  const rows = result?.ok ? result.candidates : [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const isPaginated = rows.length > PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = isPaginated ? rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE) : rows;

  return (
    <StateBoundary
      isLoading={result === null}
      isError={result !== null && !result.ok}
      isEmpty={result !== null && result.ok && result.candidates.length === 0}
      loadingSkeleton={<RankedCandidatesSkeleton />}
      errorTitle="Couldn't read ranked candidates"
      errorDescription="The local ranked-candidates API didn't respond. This refreshes automatically on the next poll."
      emptyTitle="No ranked candidates yet"
      emptyDescription="This fills in once the miner's discover step ranks its next batch of issues."
    >
      <RankedCandidatesTable rows={visibleRows} />
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

export function RankedCandidatesPage({
  loadRankedCandidates = fetchRankedCandidates,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadRankedCandidates?: () => Promise<RankedCandidatesResult>;
  pollIntervalMs?: number;
}) {
  const { result } = usePolledFetch(loadRankedCandidates, pollIntervalMs);

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Ranked candidates</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only view over the miner&apos;s last discover run&apos;s per-issue ranking breakdown.
        </p>
      </CardHeader>
      <CardContent>
        <RankedCandidatesView result={result} />
      </CardContent>
    </Card>
  );
}
