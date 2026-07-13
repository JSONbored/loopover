import { createFileRoute } from "@tanstack/react-router";

import { Card, CardContent, CardHeader } from "@jsonbored/gittensory-ui-kit/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@jsonbored/gittensory-ui-kit/components/table";

import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";
import { fetchPortfolioQueue, type PortfolioQueueResult, type QueueStatus } from "../lib/portfolio-queue";

export const Route = createFileRoute("/portfolio")({
  component: PortfolioPage,
});

// Portfolio/queue summary cards + per-repo table (#4306, reunified with the CLI's own richer `queue dashboard`
// by #4846): read-only counts by status over the local `miner_portfolio_queue` store, now broken out per repo
// exactly as `gittensory-miner queue dashboard` already shows -- the miner-ui no longer maintains a narrower,
// global-only aggregation. Same 4-state pattern as the run-history view (loading / error / fresh-install empty
// / populated).

const STATUS_LABELS: Record<QueueStatus, string> = {
  queued: "Queued",
  in_progress: "In progress",
  done: "Done",
};

// Semantic tone per status, sourced from the shared design system's success/warning
// tokens rather than arbitrary color utilities — kept separate from the accent hue.
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

export function PortfolioPage({
  loadPortfolioQueue = fetchPortfolioQueue,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadPortfolioQueue?: () => Promise<PortfolioQueueResult>;
  pollIntervalMs?: number;
}) {
  const result = usePolledFetch(loadPortfolioQueue, pollIntervalMs);

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Portfolio queue</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only summary of the miner&apos;s portfolio queue (`miner_portfolio_queue`).
        </p>
      </CardHeader>
      <CardContent>
        <PortfolioQueueView result={result} />
      </CardContent>
    </Card>
  );
}
