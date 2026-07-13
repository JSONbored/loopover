import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import { CLAIM_STATUSES, fetchLedgers, type ClaimStatus, type LedgersResult } from "../lib/ledgers";
import { fetchGovernorPauseState, pauseGovernor, resumeGovernor, type GovernorPauseStateResult } from "../lib/governor";

export const Route = createFileRoute("/ledgers")({
  component: LedgersPage,
});

// Read-only views over the miner's local claim / event / governor ledgers (#4855). All three are aggregated
// server-side (see vite-ledgers-api.ts) to status/type counts plus a small feed of SAFE columns — raw payloads
// and the free-text claim note never reach this component. Same 4-state pattern as the portfolio/run-history
// views (loading / error / fresh-install empty / populated).
//
// The governor control section below is a SEPARATE fetch/action loop from the read-only ledger summary above
// (#4857, the governor half): it reads/writes the governor's pause state via vite-governor-api.ts, the
// miner-ui's first write-capable endpoint, safe only because vite-auth.ts (#4858) now authenticates every
// /api/* request. It does not touch, and is unrelated to, the governor EVENT ledger already shown below.

const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  active: "Active",
  released: "Released",
  expired: "Expired",
};

const CLAIM_STATUS_TONE: Record<ClaimStatus, string> = {
  active: "text-[var(--success)]",
  released: "text-muted-foreground",
  expired: "text-[var(--warning)]",
};

function CountTable({ counts, keyLabel }: { counts: Record<string, number>; keyLabel: string }) {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{keyLabel}</TableHead>
          <TableHead>Count</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([type, count]) => (
          <TableRow key={type}>
            <TableCell className="font-mono text-foreground">{type}</TableCell>
            <TableCell>{count}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function GovernorControlSection({
  result,
  pending,
  onPause,
  onResume,
}: {
  result: GovernorPauseStateResult | null;
  pending: boolean;
  onPause: () => void;
  onResume: () => void;
}) {
  return (
    <section className="grid gap-3">
      <h3 className="font-display text-token-base font-semibold">Governor control</h3>
      {result === null ? (
        <p className="text-token-sm text-muted-foreground">Loading governor state…</p>
      ) : !result.ok ? (
        <p role="alert" className="text-token-sm text-[var(--danger)]">
          Could not read the local governor state: {result.error}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-token-sm text-muted-foreground">
            {result.pauseState.paused
              ? `Paused since ${result.pauseState.pausedAt}${result.pauseState.reason ? ` (${result.pauseState.reason})` : ""}`
              : "Not paused"}
          </p>
          {result.pauseState.paused ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={onResume}>
              Resume governor
            </Button>
          ) : (
            <Button size="sm" variant="destructive" disabled={pending} onClick={onPause}>
              Pause governor
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function LedgersView({ result }: { result: LedgersResult | null }) {
  if (result === null) {
    return <p className="text-token-sm text-muted-foreground">Loading local ledgers…</p>;
  }
  if (!result.ok) {
    return (
      <p role="alert" className="text-token-sm text-[var(--danger)]">
        Could not read the local ledgers: {result.error}
      </p>
    );
  }
  const { claims, events, governor } = result.summary;
  if (claims.total === 0 && events.total === 0 && governor.total === 0) {
    return (
      <p className="text-token-sm text-muted-foreground">
        No ledger activity yet — claims, events, and governor entries appear here once the miner starts working.
      </p>
    );
  }
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Claims ({claims.total})</h3>
        <dl className="grid gap-4 sm:grid-cols-3">
          {CLAIM_STATUSES.map((status) => (
            <Card key={status}>
              <CardContent className="p-4">
                <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">
                  {CLAIM_STATUS_LABELS[status]}
                </dt>
                <dd className={`mt-1 text-token-3xl font-display font-semibold ${CLAIM_STATUS_TONE[status]}`}>
                  {claims.byStatus[status]}
                </dd>
              </CardContent>
            </Card>
          ))}
        </dl>
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Governor events ({governor.total})</h3>
        {governor.total === 0 ? (
          <p className="text-token-sm text-muted-foreground">No governor events recorded.</p>
        ) : (
          <CountTable counts={governor.byEventType} keyLabel="Event type" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Recent events ({events.total})</h3>
        {events.recent.length === 0 ? (
          <p className="text-token-sm text-muted-foreground">No event-ledger entries recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event type</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.recent.map((entry, index) => (
                <TableRow key={`${entry.eventType}-${entry.createdAt ?? index}`}>
                  <TableCell className="font-mono text-foreground">{entry.eventType}</TableCell>
                  <TableCell className="font-mono">{entry.repoFullName ?? "—"}</TableCell>
                  <TableCell>{entry.createdAt ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

export function LedgersPage({
  loadLedgers = fetchLedgers,
  loadGovernorPauseState = fetchGovernorPauseState,
  pauseGovernorAction = pauseGovernor,
  resumeGovernorAction = resumeGovernor,
}: {
  loadLedgers?: () => Promise<LedgersResult>;
  loadGovernorPauseState?: () => Promise<GovernorPauseStateResult>;
  pauseGovernorAction?: () => Promise<GovernorPauseStateResult>;
  resumeGovernorAction?: () => Promise<GovernorPauseStateResult>;
}) {
  const [result, setResult] = useState<LedgersResult | null>(null);
  const [pauseState, setPauseState] = useState<GovernorPauseStateResult | null>(null);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadLedgers().then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadLedgers]);

  useEffect(() => {
    let cancelled = false;
    void loadGovernorPauseState().then((loaded) => {
      if (!cancelled) setPauseState(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadGovernorPauseState]);

  const runGovernorAction = (action: () => Promise<GovernorPauseStateResult>) => {
    setActionPending(true);
    void action().then((next) => {
      setPauseState(next);
      setActionPending(false);
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Ledgers</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only summary of the miner&apos;s claim, event, and governor ledgers.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <GovernorControlSection
            result={pauseState}
            pending={actionPending}
            onPause={() => runGovernorAction(pauseGovernorAction)}
            onResume={() => runGovernorAction(resumeGovernorAction)}
          />
          <LedgersView result={result} />
        </div>
      </CardContent>
    </Card>
  );
}
