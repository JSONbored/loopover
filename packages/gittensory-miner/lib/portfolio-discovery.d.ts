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
};

export type EnqueueRankedDiscoverySummary = {
  enqueued: number;
  skippedBelowMinRank: number;
  skippedInvalid: number;
  eventsAppended: number;
};

export function enqueueRankedDiscovery(
  rankedIssues: readonly EnqueueRankedDiscoveryInput[],
  options: EnqueueRankedDiscoveryOptions,
): EnqueueRankedDiscoverySummary;
