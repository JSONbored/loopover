import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "@jsonbored/gittensory-ui-kit/components/badge";
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
import { fetchRunStates, type RunHistoryResult, type RunStateRow } from "../lib/run-history";

export const Route = createFileRoute("/run-history")({
  component: RunHistoryPage,
});

// Read-only run-history table (#4305): one row per repo from the local `miner_run_state` store (repo, state,
// last-updated), served by the dev server's local API. No writes, no new state — a fresh install renders the
// empty state, an unreachable API renders an error message.

const STATE_BADGE_VARIANT: Record<RunStateRow["state"], "secondary" | "outline"> = {
  idle: "secondary",
  discovering: "outline",
  planning: "outline",
  preparing: "outline",
};

export function RunHistoryView({ result }: { result: RunHistoryResult | null }) {
  if (result === null) {
    return <p className="text-token-sm text-muted-foreground">Loading local run state…</p>;
  }
  if (!result.ok) {
    return (
      <p role="alert" className="text-token-sm text-[var(--danger)]">
        Could not read local run state: {result.error}
      </p>
    );
  }
  if (result.rows.length === 0) {
    return (
      <p className="text-token-sm text-muted-foreground">
        No local run state yet — the table fills in once the miner records its first repo run.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Last updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.rows.map((row) => (
          <TableRow key={row.repoFullName}>
            <TableCell className="font-mono text-foreground">{row.repoFullName}</TableCell>
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

export function RunHistoryPage({
  loadRunStates = fetchRunStates,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadRunStates?: () => Promise<RunHistoryResult>;
  pollIntervalMs?: number;
}) {
  const result = usePolledFetch(loadRunStates, pollIntervalMs);

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
