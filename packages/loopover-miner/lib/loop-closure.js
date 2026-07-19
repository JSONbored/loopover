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
/**
 * Build a read-only loop-closure summary from local-state sources. Pure: reads `sources` + `options` and returns a
 * structured summary, mutating nothing.
 */
export function buildLoopClosureSummary(sources, options = {}) {
    const eventLedger = sources?.eventLedger;
    const portfolioQueue = sources?.portfolioQueue;
    const runState = sources?.runState;
    if (!eventLedger || typeof eventLedger.readEvents !== "function")
        throw new Error("invalid_event_ledger");
    if (!portfolioQueue || typeof portfolioQueue.listQueue !== "function")
        throw new Error("invalid_portfolio_queue");
    const repoFullName = typeof options.repoFullName === "string" && options.repoFullName.length > 0 ? options.repoFullName : null;
    const sinceSeq = Number.isInteger(options.sinceSeq) && options.sinceSeq >= 0 ? options.sinceSeq : null;
    // Bound "this cycle" to events after the prior cycle's ending seq; event-ledger applies the `since`/repo filter.
    const filter = {};
    if (repoFullName !== null)
        filter.repoFullName = repoFullName;
    if (sinceSeq !== null)
        filter.since = sinceSeq;
    const events = eventLedger.readEvents(filter);
    const byType = {};
    let lastSeq = sinceSeq ?? 0;
    for (const event of events) {
        const type = typeof event?.type === "string" && event.type.length > 0 ? event.type : "unknown";
        byType[type] = (byType[type] ?? 0) + 1;
        if (Number.isInteger(event?.seq) && event.seq > lastSeq)
            lastSeq = event.seq;
    }
    const byStatus = {};
    const queueEntries = portfolioQueue.listQueue(repoFullName);
    for (const entry of queueEntries) {
        const status = typeof entry?.status === "string" && entry.status.length > 0 ? entry.status : "unknown";
        byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    const currentRunState = runState && typeof runState.getRunState === "function" && repoFullName !== null
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcC1jbG9zdXJlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9vcC1jbG9zdXJlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLHFHQUFxRztBQUNyRyxFQUFFO0FBQ0Ysb0hBQW9IO0FBQ3BILG1HQUFtRztBQUNuRyxnSEFBZ0g7QUFDaEgsaUhBQWlIO0FBQ2pILHFGQUFxRjtBQUNyRixFQUFFO0FBQ0YscUhBQXFIO0FBQ3JILGlIQUFpSDtBQUNqSCxtSEFBbUg7QUFDbkgsb0hBQW9IO0FBQ3BILG1IQUFtSDtBQUNuSCw0REFBNEQ7QUF3QzVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSx1QkFBdUIsQ0FDckMsT0FBMkIsRUFDM0IsVUFBOEIsRUFBRTtJQUVoQyxNQUFNLFdBQVcsR0FBRyxPQUFPLEVBQUUsV0FBVyxDQUFDO0lBQ3pDLE1BQU0sY0FBYyxHQUFHLE9BQU8sRUFBRSxjQUFjLENBQUM7SUFDL0MsTUFBTSxRQUFRLEdBQUcsT0FBTyxFQUFFLFFBQVEsQ0FBQztJQUNuQyxJQUFJLENBQUMsV0FBVyxJQUFJLE9BQU8sV0FBVyxDQUFDLFVBQVUsS0FBSyxVQUFVO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO0lBQzFHLElBQUksQ0FBQyxjQUFjLElBQUksT0FBTyxjQUFjLENBQUMsU0FBUyxLQUFLLFVBQVU7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHlCQUF5QixDQUFDLENBQUM7SUFFbEgsTUFBTSxZQUFZLEdBQ2hCLE9BQU8sT0FBTyxDQUFDLFlBQVksS0FBSyxRQUFRLElBQUksT0FBTyxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDNUcsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLElBQUssT0FBTyxDQUFDLFFBQW1CLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBUyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFFcEgsaUhBQWlIO0lBQ2pILE1BQU0sTUFBTSxHQUE4QyxFQUFFLENBQUM7SUFDN0QsSUFBSSxZQUFZLEtBQUssSUFBSTtRQUFFLE1BQU0sQ0FBQyxZQUFZLEdBQUcsWUFBWSxDQUFDO0lBQzlELElBQUksUUFBUSxLQUFLLElBQUk7UUFBRSxNQUFNLENBQUMsS0FBSyxHQUFHLFFBQVEsQ0FBQztJQUMvQyxNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBRTlDLE1BQU0sTUFBTSxHQUEyQixFQUFFLENBQUM7SUFDMUMsSUFBSSxPQUFPLEdBQUcsUUFBUSxJQUFJLENBQUMsQ0FBQztJQUM1QixLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQzNCLE1BQU0sSUFBSSxHQUFHLE9BQU8sS0FBSyxFQUFFLElBQUksS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDL0YsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN2QyxJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxJQUFLLEtBQUssQ0FBQyxHQUFjLEdBQUcsT0FBTztZQUFFLE9BQU8sR0FBRyxLQUFLLENBQUMsR0FBYSxDQUFDO0lBQ3JHLENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBMkIsRUFBRSxDQUFDO0lBQzVDLE1BQU0sWUFBWSxHQUFHLGNBQWMsQ0FBQyxTQUFTLENBQUMsWUFBWSxDQUFDLENBQUM7SUFDNUQsS0FBSyxNQUFNLEtBQUssSUFBSSxZQUFZLEVBQUUsQ0FBQztRQUNqQyxNQUFNLE1BQU0sR0FBRyxPQUFPLEtBQUssRUFBRSxNQUFNLEtBQUssUUFBUSxJQUFJLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1FBQ3ZHLFFBQVEsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDakQsQ0FBQztJQUVELE1BQU0sZUFBZSxHQUNuQixRQUFRLElBQUksT0FBTyxRQUFRLENBQUMsV0FBVyxLQUFLLFVBQVUsSUFBSSxZQUFZLEtBQUssSUFBSTtRQUM3RSxDQUFDLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxZQUFZLENBQUM7UUFDcEMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUVYLE9BQU87UUFDTCxRQUFRO1FBQ1IsT0FBTztRQUNQLE1BQU0sRUFBRSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLE1BQU0sRUFBRTtRQUN4QyxLQUFLLEVBQUUsRUFBRSxLQUFLLEVBQUUsWUFBWSxDQUFDLE1BQU0sRUFBRSxRQUFRLEVBQUU7UUFDL0MsUUFBUSxFQUFFLGVBQWUsSUFBSSxJQUFJO0tBQ2xDLENBQUM7QUFDSixDQUFDIn0=