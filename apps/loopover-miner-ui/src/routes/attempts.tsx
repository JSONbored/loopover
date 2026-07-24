import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "@loopover/ui-kit/components/badge";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Skeleton } from "@loopover/ui-kit/components/skeleton";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import { TablePagination } from "../components/table-pagination";
import { usePagedRows } from "../lib/paged-rows";
import {
  fetchAttemptLog,
  type AttemptFeedEntry,
  type AttemptLogResult,
  type AttemptLogSummary,
  type PrOutcomeDecision,
  type PrOutcomeFeedEntry,
} from "../lib/attempt-log";
import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";

export const Route = createFileRoute("/attempts")({
  component: AttemptsPage,
});

// Read-only per-attempt HISTORY over the miner's local attempt-log + PR-outcome stores (#7656). Both are aggregated
// server-side (see vite-attempt-log-api.ts) to action/type/decision counts plus a small feed of SAFE columns — the
// attempt log's raw payload never reaches this component.
//
// DISTINCT from run-history.tsx: that route shows only the CURRENT per-repo run STATE (one live row per repo). This
// route is the log of individual PAST attempts — each attempt's actionClass, provider, cost, tokens, and event
// outcome — plus how the miner's own PRs ultimately resolved (merged/closed). The two answer "what is the miner
// doing now" vs. "what has the miner already done".

const DECISION_LABELS: Record<PrOutcomeDecision, string> = { merged: "Merged", closed: "Closed" };
const DECISION_VARIANT: Record<PrOutcomeDecision, "secondary" | "outline"> = {
  merged: "secondary",
  closed: "outline",
};

const dashIfNull = (value: string | number | null): string | number => (value === null ? "—" : value);
const formatCost = (costUsd: number | null): string => (costUsd === null ? "—" : `$${costUsd.toFixed(4)}`);

function CountTable({ counts, keyLabel }: { counts: Record<string, number>; keyLabel: string }) {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const { visible, isPaginated, page, pageCount, setPage } = usePagedRows(entries);
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
          {visible.map(([key, count]) => (
            <TableRow key={key}>
              <TableCell className="font-mono text-foreground">{key}</TableCell>
              <TableCell>{count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isPaginated && <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />}
    </div>
  );
}

function RecentAttemptsTable({ entries }: { entries: AttemptFeedEntry[] }) {
  const { visible, isPaginated, page, pageCount, setPage } = usePagedRows(entries);
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Attempt</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Recorded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((entry, index) => (
            <TableRow key={`${entry.attemptId}-${entry.createdAt ?? index}`}>
              <TableCell className="font-mono text-foreground">{entry.attemptId}</TableCell>
              <TableCell className="font-mono">{entry.eventType}</TableCell>
              <TableCell className="font-mono text-muted-foreground">{entry.actionClass}</TableCell>
              <TableCell className="font-mono text-muted-foreground">{dashIfNull(entry.provider)}</TableCell>
              <TableCell className="font-mono">{formatCost(entry.costUsd)}</TableCell>
              <TableCell className="font-mono">{dashIfNull(entry.tokensUsed)}</TableCell>
              <TableCell className="text-muted-foreground">{dashIfNull(entry.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isPaginated && <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />}
    </div>
  );
}

function RecentOutcomesTable({ entries }: { entries: PrOutcomeFeedEntry[] }) {
  const { visible, isPaginated, page, pageCount, setPage } = usePagedRows(entries);
  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repository</TableHead>
            <TableHead>PR</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Closed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((entry, index) => (
            <TableRow key={`${entry.repoFullName ?? "?"}-${entry.prNumber ?? index}`}>
              <TableCell className="font-mono">{dashIfNull(entry.repoFullName)}</TableCell>
              <TableCell className="font-mono">{entry.prNumber === null ? "—" : `#${entry.prNumber}`}</TableCell>
              <TableCell>
                <Badge variant={DECISION_VARIANT[entry.decision]}>{DECISION_LABELS[entry.decision]}</Badge>
              </TableCell>
              <TableCell className="font-mono text-muted-foreground">{dashIfNull(entry.reason)}</TableCell>
              <TableCell className="text-muted-foreground">{dashIfNull(entry.closedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isPaginated && <TablePagination page={page} pageCount={pageCount} onPageChange={setPage} />}
    </div>
  );
}

/** Section-shaped loading placeholder mirroring the attempt/outcome section headings + tables, so the layout keeps
 *  its shape while the first poll resolves. `role="status"` keeps the loading state announced to assistive tech. */
function AttemptLogSkeleton() {
  return (
    <div className="grid gap-6" role="status" aria-label="Loading local attempt log">
      {Array.from({ length: 4 }).map((_, index) => (
        <section key={index} className="grid gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </section>
      ))}
    </div>
  );
}

function AttemptLogSummaryContent({ summary }: { summary: AttemptLogSummary }) {
  const { attempts, prOutcomes } = summary;
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Attempts ({attempts.total})</h3>
        <p className="text-token-sm text-muted-foreground">
          Total recorded cost: <span className="font-mono text-foreground">{formatCost(attempts.totalCostUsd)}</span>
        </p>
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Attempts by action class</h3>
        {Object.keys(attempts.byActionClass).length === 0 ? (
          <p className="text-token-sm text-muted-foreground">No attempt events recorded.</p>
        ) : (
          <CountTable counts={attempts.byActionClass} keyLabel="Action class" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Attempts by event type</h3>
        {Object.keys(attempts.byEventType).length === 0 ? (
          <p className="text-token-sm text-muted-foreground">No attempt events recorded.</p>
        ) : (
          <CountTable counts={attempts.byEventType} keyLabel="Event type" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Recent attempts ({attempts.total})</h3>
        {attempts.recent.length === 0 ? (
          <p className="text-token-sm text-muted-foreground">No attempt-log entries recorded.</p>
        ) : (
          <RecentAttemptsTable entries={attempts.recent} />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">PR outcomes ({prOutcomes.total})</h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          {(["merged", "closed"] as const).map((decision) => (
            <Card key={decision}>
              <CardContent className="p-4">
                <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">
                  {DECISION_LABELS[decision]}
                </dt>
                <dd
                  className={`mt-1 text-token-3xl font-display font-semibold ${
                    decision === "merged" ? "text-success" : "text-muted-foreground"
                  }`}
                >
                  {prOutcomes.byDecision[decision]}
                </dd>
              </CardContent>
            </Card>
          ))}
        </dl>
        {Object.keys(prOutcomes.byReason).length > 0 && (
          <CountTable counts={prOutcomes.byReason} keyLabel="Close reason" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Recent PR outcomes ({prOutcomes.total})</h3>
        {prOutcomes.recent.length === 0 ? (
          <p className="text-token-sm text-muted-foreground">No PR outcomes recorded.</p>
        ) : (
          <RecentOutcomesTable entries={prOutcomes.recent} />
        )}
      </section>
    </div>
  );
}

export function AttemptLogView({ result }: { result: AttemptLogResult | null }) {
  const summary = result?.ok ? result.summary : null;
  const isEmpty = summary !== null && summary.attempts.total === 0 && summary.prOutcomes.total === 0;
  const errorText = result !== null && !result.ok ? result.error : undefined;
  return (
    <StateBoundary
      isLoading={result === null}
      isError={result !== null && !result.ok}
      isEmpty={isEmpty}
      loadingSkeleton={<AttemptLogSkeleton />}
      errorTitle="Couldn't read the local attempt log"
      errorDescription={errorText}
      emptyTitle="No attempts yet"
      emptyDescription="Per-attempt events and PR outcomes appear here once the miner runs its first attempt."
    >
      {summary && <AttemptLogSummaryContent summary={summary} />}
    </StateBoundary>
  );
}

export function AttemptsPage({
  loadAttemptLog = fetchAttemptLog,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadAttemptLog?: () => Promise<AttemptLogResult>;
  pollIntervalMs?: number;
}) {
  const { result } = usePolledFetch(loadAttemptLog, pollIntervalMs);

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Attempts</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only history of the miner&apos;s individual past attempts and its own PR outcomes.
        </p>
      </CardHeader>
      <CardContent>
        <AttemptLogView result={result} />
      </CardContent>
    </Card>
  );
}
