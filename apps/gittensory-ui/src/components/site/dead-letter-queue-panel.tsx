import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  buildDeadLetterJobActionPath,
  buildDeadLetterQueuePath,
  DEAD_LETTER_QUEUE_PURGE_PATH,
  formatDeadLetterTimestamp,
  normalizeDeadLetterQueuePage,
  truncateErrorMessage,
  type DeadLetterQueueItem,
} from "@/components/site/dead-letter-queue-panel-model";
import { StatusPill } from "@/components/site/control-primitives";
import { StateActionButton, StateBoundary } from "@/components/site/state-views";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { useApiResource } from "@/lib/api/use-api-resource";

function apiUrl(path: string): string {
  return `${getApiOrigin().replace(/\/$/, "")}${path}`;
}

export function DeadLetterQueuePanel() {
  const [offset, setOffset] = useState(0);
  const path = useMemo(() => buildDeadLetterQueuePath(offset), [offset]);
  const resource = useApiResource<unknown>(path, "Dead-letter queue");
  const page = resource.status === "ready" ? normalizeDeadLetterQueuePage(resource.data) : null;
  const isMalformed = resource.status === "ready" && page === null;
  const [purging, setPurging] = useState(false);

  async function purgeAll() {
    setPurging(true);
    try {
      const result = await apiFetch<{ ok: true; purged: number }>(
        apiUrl(DEAD_LETTER_QUEUE_PURGE_PATH),
        {
          method: "DELETE",
          label: "Purge dead-letter queue",
          credentials: "include",
        },
      );
      if (result.ok) {
        toast.success("Dead-letter queue purged", {
          description: `Purged ${result.data.purged} job${result.data.purged === 1 ? "" : "s"}.`,
        });
        // Deliberately no step-back-a-page logic here (unlike runJobAction below): purge empties the ENTIRE
        // queue, so any offset now legitimately returns zero items -- there's no earlier page with real data
        // to redirect to, unlike a single-row action where other pages still have jobs.
        resource.reload();
      } else {
        toast.error("Purge failed", { description: result.message });
      }
    } finally {
      setPurging(false);
    }
  }

  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Dead-letter queue</h2>
          <p className="mt-1 max-w-2xl text-token-xs text-muted-foreground">
            Jobs that exhausted their retry budget. Newest failures first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {page ? (
            <StatusPill status={page.total === 0 ? "ready" : "warn"}>{page.total} dead</StatusPill>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <StateActionButton disabled={!page || page.total === 0 || purging}>
                Purge all
              </StateActionButton>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Purge the dead-letter queue?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes every dead-letter job. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => void purgeAll()}
                  disabled={purging}
                >
                  Purge all
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
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
            <DeadLetterQueueTable page={page} onPageChange={setOffset} onReload={resource.reload} />
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}

function DeadLetterQueueTable({
  page,
  onPageChange,
  onReload,
}: {
  page: { limit: number; offset: number; total: number; items: DeadLetterQueueItem[] };
  onPageChange: (offset: number) => void;
  onReload: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A Set, not a single id: two DIFFERENT rows can have requests in flight at once (the user clicks Replay on
  // row A, then Delete on row B before A resolves). A single shared "pendingRowId" would have row A's own
  // completion clear row B's still-in-flight indicator too, letting a duplicate click fire against row B's
  // active request.
  const [pendingRowIds, setPendingRowIds] = useState<Set<number>>(new Set());

  async function runJobAction(id: number, action: "replay" | "delete") {
    setPendingRowIds((current) => new Set(current).add(id));
    try {
      const result = await apiFetch<{ ok: true; id: number }>(
        apiUrl(buildDeadLetterJobActionPath(id, action)),
        {
          method: action === "replay" ? "POST" : "DELETE",
          label: action === "replay" ? "Replay dead-letter job" : "Delete dead-letter job",
          credentials: "include",
        },
      );
      if (result.ok) {
        toast.success(action === "replay" ? "Job queued for replay" : "Job deleted", {
          description: `Job #${id} ${action === "replay" ? "was requeued." : "was removed from the dead-letter queue."}`,
        });
        // The row just acted on was the ONLY item on a non-first page -- reloading the SAME offset would
        // return zero items there (even though earlier pages still have jobs), stranding the operator on a
        // misleadingly-empty page. Step back a page instead; any other case just refetches in place.
        // KNOWN LIMITATION: page.items.length is a snapshot from this render, shared by every in-flight
        // action's closure -- if an operator fires two DIFFERENT rows' actions on the same 2-item page before
        // either resolves, both closures see length===2 and neither steps back, even though together they
        // empty the page. Recoverable (Previous still works) and narrow enough that fixing it would need a
        // bigger redesign (e.g. tracking resolved-this-batch count instead of a static snapshot) -- left as a
        // deliberate, documented gap rather than expanding this fix's scope.
        if (page.items.length === 1 && page.offset > 0) {
          onPageChange(Math.max(0, page.offset - page.limit));
        } else {
          onReload();
        }
      } else {
        toast.error(action === "replay" ? "Replay failed" : "Delete failed", {
          description: result.message,
        });
      }
    } finally {
      setPendingRowIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  const rangeStart = page.total === 0 ? 0 : page.offset + 1;
  const rangeEnd = Math.min(page.offset + page.items.length, page.total);
  const hasPrevious = page.offset > 0;
  const hasNext = page.offset + page.limit < page.total;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-token border border-border bg-transparent">
        <table className="w-full min-w-[880px] text-left text-token-sm">
          <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Job ID</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Attempts</th>
              <th className="px-4 py-3 font-medium">Last error</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium">Died</th>
              <th className="px-4 py-3 font-medium">Actions</th>
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
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StateActionButton
                        onClick={() => void runJobAction(item.id, "replay")}
                        disabled={pendingRowIds.has(item.id)}
                      >
                        Replay
                      </StateActionButton>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <StateActionButton disabled={pendingRowIds.has(item.id)}>
                            Delete
                          </StateActionButton>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete job #{item.id}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This permanently removes this dead-letter job. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => void runJobAction(item.id, "delete")}
                              disabled={pendingRowIds.has(item.id)}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
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
