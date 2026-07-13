import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import {
  fetchPortfolioQueueItems,
  requeuePortfolioQueueItem,
  releasePortfolioQueueItem,
} from "../lib/portfolio-queue-actions";
import type { PortfolioQueueActionItem, PortfolioQueueItemsResult } from "../lib/portfolio-queue-actions";
import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";
import { fetchPortfolioQueue, type PortfolioQueueResult, type QueueStatus } from "../lib/portfolio-queue";

export const Route = createFileRoute("/portfolio")({
  component: PortfolioPage,
});

// Portfolio/queue summary cards + per-repo table (#4306, reunified with the CLI's own richer `queue dashboard`
// by #4846), plus release/requeue controls (#4857) backed by the same store methods the CLI uses.

const STATUS_LABELS: Record<QueueStatus, string> = {
  queued: "Queued",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_TONE: Record<QueueStatus, string> = {
  queued: "text-muted-foreground",
  in_progress: "text-[var(--warning)]",
  done: "text-[var(--success)]",
};

export function PortfolioQueueView({ result }: { result: PortfolioQueueResult | null }) {
  if (result === null) {
    return <p className="text-token-sm text-muted-foreground">Loading local portfolio queue…</p>;
  }
  if (!result.ok) {
    return (
      <p role="alert" className="text-token-sm text-[var(--danger)]">
        Could not read the local portfolio queue: {result.error}
      </p>
    );
  }
  const summary = result.summary;
  if (summary.total === 0) {
    return (
      <p className="text-token-sm text-muted-foreground">
        No queued work yet — the cards fill in once the miner enqueues its first portfolio item.
      </p>
    );
  }
  return (
    <div className="grid gap-6">
      <dl className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(STATUS_LABELS) as QueueStatus[]).map((status) => (
          <Card key={status}>
            <CardContent className="p-4">
              <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">{STATUS_LABELS[status]}</dt>
              <dd className={`mt-1 text-token-3xl font-display font-semibold ${STATUS_TONE[status]}`}>
                {summary.byStatus[status]}
              </dd>
            </CardContent>
          </Card>
        ))}
      </dl>
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
          {summary.repos.map((repo) => (
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
    </div>
  );
}

export function PortfolioQueueActionsSection({
  result,
  pending,
  onRelease,
  onRequeue,
}: {
  result: PortfolioQueueItemsResult | null;
  pending: boolean;
  onRelease: (item: PortfolioQueueActionItem) => void;
  onRequeue: (item: PortfolioQueueActionItem) => void;
}) {
  return (
    <section className="grid gap-3">
      <h3 className="font-display text-token-base font-semibold">Queue actions</h3>
      {result === null ? (
        <p className="text-token-sm text-muted-foreground">Loading actionable queue items…</p>
      ) : !result.ok ? (
        <p role="alert" className="text-token-sm text-[var(--danger)]">
          Could not read actionable queue items: {result.error}
        </p>
      ) : result.items.length === 0 ? (
        <p className="text-token-sm text-muted-foreground">
          No in-progress or completed items to release or requeue right now.
        </p>
      ) : (
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
            {result.items.map((item) => (
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
      )}
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

  const loadSummary = useCallback(() => loadPortfolioQueue(), [loadPortfolioQueue, refreshKey]);
  const summaryResult = usePolledFetch(loadSummary, pollIntervalMs);

  const refreshItems = useCallback(() => {
    void loadPortfolioQueueItems().then(setItemsResult);
  }, [loadPortfolioQueueItems, refreshKey]);

  useEffect(() => {
    refreshItems();
  }, [refreshItems]);

  const runQueueAction = (action: () => Promise<unknown>) => {
    setActionPending(true);
    void action().then(() => {
      setRefreshKey((key) => key + 1);
      refreshItems();
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
            pending={actionPending}
            onRelease={(item) => runQueueAction(() => releaseItem(item))}
            onRequeue={(item) => runQueueAction(() => requeueItem(item))}
          />
        </div>
      </CardContent>
    </Card>
  );
}
