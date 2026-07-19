// Loop-closure summary builder (pure, read-only) — #4282, Wave 2 tracker #2353 (miner-manage phase).
//
// A pure, read-only aggregator in the spirit of manage-status.js's collectManageStatus: read across the local-state
// primitives (event ledger, portfolio queue, run-state) and summarize what happened in a completed
// discover→plan→prepare→manage cycle BEFORE the miner loop considers re-entering (idle → discovering again). It
// never calls GitHub, never writes a local store, and never decides whether to re-enter or performs the re-entry
// itself — it only builds the summary a future caller reads before making that call.
//
// Cycle boundary is CALLER-SUPPLIED (deliberately, per the issue): `options.sinceSeq` is the event-ledger seq at the
// END of the prior cycle, so events with a STRICTLY greater seq are "this cycle" — reusing event-ledger.js's own
// `readEvents({ since })` cursor rather than inventing a new persisted cycle-boundary marker. The ledger stores an
// OPEN type vocabulary (only the phase writers define concrete types), so events are tallied GENERICALLY by `type`;
// new phase event types (plans built, PRs prepared/opened, outcomes recorded — landing via sibling issues) surface
// in the tally automatically without a hardcoded list here.

export interface LoopClosureEventLedger {
  readEvents(filter?: { since?: number; repoFullName?: string }): Array<{
    seq?: number;
    type?: unknown;
    repoFullName?: string | null;
  }>;
}

export interface LoopClosurePortfolioQueue {
  listQueue(repoFullName: string | null): Array<{ status?: unknown }>;
}

export interface LoopClosureRunState {
  getRunState(repoFullName: string): string | null;
}

export interface LoopClosureSources {
  eventLedger: LoopClosureEventLedger;
  portfolioQueue: LoopClosurePortfolioQueue;
  runState?: LoopClosureRunState;
}

export interface LoopClosureOptions {
  /** Event-ledger seq at the END of the prior cycle; events with a strictly greater seq are "this cycle". */
  sinceSeq?: number;
  /** Scope the summary to a single repo (its events and queue entries) when set. */
  repoFullName?: string;
}

export interface LoopClosureSummary {
  sinceSeq: number | null;
  /** Highest event seq observed this cycle (>= sinceSeq); the boundary a caller passes as the next cycle's sinceSeq. */
  lastSeq: number;
  events: { total: number; byType: Record<string, number> };
  queue: { total: number; byStatus: Record<string, number> };
  runState: string | null;
}

/**
 * Build a read-only loop-closure summary from local-state sources. Pure: reads `sources` + `options` and returns a
 * structured summary, mutating nothing.
 */
export function buildLoopClosureSummary(
  sources: LoopClosureSources,
  options: LoopClosureOptions = {},
): LoopClosureSummary {
  const eventLedger = sources?.eventLedger;
  const portfolioQueue = sources?.portfolioQueue;
  const runState = sources?.runState;
  if (!eventLedger || typeof eventLedger.readEvents !== "function") throw new Error("invalid_event_ledger");
  if (!portfolioQueue || typeof portfolioQueue.listQueue !== "function") throw new Error("invalid_portfolio_queue");

  const repoFullName =
    typeof options.repoFullName === "string" && options.repoFullName.length > 0 ? options.repoFullName : null;
  const sinceSeq = Number.isInteger(options.sinceSeq) && (options.sinceSeq as number) >= 0 ? options.sinceSeq! : null;

  // Bound "this cycle" to events after the prior cycle's ending seq; event-ledger applies the `since`/repo filter.
  const filter: { since?: number; repoFullName?: string } = {};
  if (repoFullName !== null) filter.repoFullName = repoFullName;
  if (sinceSeq !== null) filter.since = sinceSeq;
  const events = eventLedger.readEvents(filter);

  const byType: Record<string, number> = {};
  let lastSeq = sinceSeq ?? 0;
  for (const event of events) {
    const type = typeof event?.type === "string" && event.type.length > 0 ? event.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (Number.isInteger(event?.seq) && (event.seq as number) > lastSeq) lastSeq = event.seq as number;
  }

  const byStatus: Record<string, number> = {};
  const queueEntries = portfolioQueue.listQueue(repoFullName);
  for (const entry of queueEntries) {
    const status = typeof entry?.status === "string" && entry.status.length > 0 ? entry.status : "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  const currentRunState =
    runState && typeof runState.getRunState === "function" && repoFullName !== null
      ? runState.getRunState(repoFullName)
      : null;

  return {
    sinceSeq,
    lastSeq,
    events: { total: events.length, byType },
    queue: { total: queueEntries.length, byStatus },
    runState: currentRunState ?? null,
  };
}
