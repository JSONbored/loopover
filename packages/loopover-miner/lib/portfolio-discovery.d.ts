/** Local orchestration: materialize ranked fan-out rows into the portfolio queue (#2292). */
import type { EventLedger } from "./event-ledger.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";
export type EnqueueRankedDiscoveryInput = {
    repoFullName: string;
    issueNumber: number;
    title: string;
    labels?: string[];
    rankScore: number;
};
export type EnqueueRankedDiscoveryOptions = {
    queueStore: PortfolioQueueStore;
    eventLedger?: EventLedger;
    minRankScore?: number | null;
    apiBaseUrl?: string;
};
export type EnqueueRankedDiscoverySummary = {
    enqueued: number;
    skippedBelowMinRank: number;
    skippedInvalid: number;
    eventsAppended: number;
};
/**
 * Enqueue ranked discovery rows into the local portfolio backlog. Uses each row's `rankScore` as queue priority
 * (the #2292 placeholder field). Optionally appends `discovered_issue` audit events when an event ledger is supplied.
 * Never calls GitHub — callers rank locally first via `rankCandidateIssues`.
 */
export declare function enqueueRankedDiscovery(rankedIssues: readonly EnqueueRankedDiscoveryInput[], options?: EnqueueRankedDiscoveryOptions): EnqueueRankedDiscoverySummary;
