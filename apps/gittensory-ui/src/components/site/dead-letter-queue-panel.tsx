import { useMemo, useState } from "react";

import {
  buildDeadLetterQueuePath,
  formatDeadLetterTimestamp,
  normalizeDeadLetterQueuePage,
  truncateErrorMessage,
  type DeadLetterQueueItem,
} from "@/components/site/dead-letter-queue-panel-model";
import { StatusPill } from "@/components/site/control-primitives";
import { StateBoundary } from "@/components/site/state-views";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { useApiResource } from "@/lib/api/use-api-resource";

export function DeadLetterQueuePanel() {
  const [offset, setOffset] = useState(0);
  const path = useMemo(() => buildDeadLetterQueuePath(offset), [offset]);
  const resource = useApiResource<unknown>(path, "Dead-letter queue");
  const page = resource.status === "ready" ? normalizeDeadLetterQueuePage(resource.data) : null;
  const isMalformed = resource.status === "ready" && page === null;

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Dead-letter queue</h2>
          <p className="mt-1 max-w-2xl text-token-xs text-muted-foreground">
            Jobs that exhausted their retry budget. Newest failures first.
          </p>
        </div>
        {page ? (
          <StatusPill status={page.total === 0 ? "ready" : "warn"}>{page.total} dead</StatusPill>
        ) : null}
      </div>

      <div className="mt-4">
        <StateBoundary
          isLoading={resource.status === "loading"}
          isError={resource.status === "error" || isMalformed}
          isEmpty={page !== null && page.items.length === 0}
          onRetry={resource.reload}
          onRefresh={resource.reload}
          loadingTitle="Loading dead-letter queue…"
          loadingDescription="Fetching failed jobs from the self-host queue backend."
          emptyTitle="No dead-letter jobs"
          emptyDescription="Jobs that exhaust their retry budget will appear here."
          errorTitle="Couldn't load the dead-letter queue"
          errorDescription={
            resource.status === "error"
              ? resource.error
              : "The dead-letter queue endpoint returned an unexpected response."
          }
        >
          {page && page.items.length > 0 ? (
            <DeadLetterQueueTable page={page} onPageChange={setOffset} />
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}

function DeadLetterQueueTable({
  page,
  onPageChange,
}: {
  page: { limit: number; offset: number; total: number; items: DeadLetterQueueItem[] };
  onPageChange: (offset: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rangeStart = page.total === 0 ? 0 : page.offset + 1;
  const rangeEnd = Math.min(page.offset + page.items.length, page.total);
  const hasPrevious = page.offset > 0;
  const hasNext = page.offset + page.limit < page.total;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-token border border-border bg-transparent">
        <table className="w-full min-w-[760px] text-left text-token-sm">
          <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Job ID</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Attempts</th>
              <th className="px-4 py-3 font-medium">Last error</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium">Died</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => {
              const error = item.lastError ?? "";
              const isTruncated = error.length > truncateErrorMessage(error).length;
              const isExpanded = expanded.has(item.id);
              return (
                <tr key={item.id} className="border-b border-border/60 last:border-0 align-top">
                  <td className="px-4 py-3 font-mono text-token-xs">{item.id}</td>
                  <td className="px-4 py-3 font-mono text-token-xs">{item.jobType}</td>
                  <td className="px-4 py-3 font-mono text-token-xs">{item.attempts}</td>
                  <td className="px-4 py-3 text-token-xs text-muted-foreground">
                    {item.lastError === null ? (
                      "—"
                    ) : (
                      <>
                        {isExpanded ? item.lastError : truncateErrorMessage(item.lastError)}
                        {isTruncated ? (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(item.id)}
                            className="ml-1.5 text-mint hover:underline focus-ring rounded-token"
                          >
                            {isExpanded ? "Show less" : "Show more"}
                          </button>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-token-xs text-muted-foreground whitespace-nowrap">
                    {formatDeadLetterTimestamp(item.createdAtMs)}
                  </td>
                  <td className="px-4 py-3 font-mono text-token-xs text-muted-foreground whitespace-nowrap">
                    {formatDeadLetterTimestamp(item.deadAtMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-token-2xs text-muted-foreground">
          Showing {rangeStart}–{rangeEnd} of {page.total}
        </p>
        <Pagination className="mx-0 w-auto justify-end">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={!hasPrevious}
                onClick={(event) => {
                  event.preventDefault();
                  if (hasPrevious) onPageChange(Math.max(0, page.offset - page.limit));
                }}
                className={hasPrevious ? undefined : "pointer-events-none opacity-40"}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={!hasNext}
                onClick={(event) => {
                  event.preventDefault();
                  if (hasNext) onPageChange(page.offset + page.limit);
                }}
                className={hasNext ? undefined : "pointer-events-none opacity-40"}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
