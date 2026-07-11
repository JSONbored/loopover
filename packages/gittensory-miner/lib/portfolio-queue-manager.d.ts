import type { PortfolioCaps } from "@jsonbored/gittensory-engine";
import type { EnqueueItem, PortfolioQueueStore, QueueEntry } from "./portfolio-queue.js";

export type PortfolioQueueClaimTarget = {
  repoFullName: string;
  identifier: string;
};

export function queueItemId(repoFullName: string, identifier: string): string;

export function parseQueueItemId(id: string): PortfolioQueueClaimTarget;

export function normalizePortfolioCaps(caps?: Partial<PortfolioCaps>): PortfolioCaps;

export function entriesToPortfolioQueue(entries: QueueEntry[]): {
  buckets: Array<{
    repoFullName: string;
    items: Array<{ id: string; repoFullName: string; state: "queued" | "in_progress" }>;
  }>;
};

export function selectEligibleBatch(
  entries: QueueEntry[],
  caps: PortfolioCaps,
): PortfolioQueueClaimTarget[];

export type PortfolioQueueManager = {
  caps: PortfolioCaps;
  store: PortfolioQueueStore;
  dbPath: string;
  enqueue(item: EnqueueItem): QueueEntry;
  listQueue(repoFullName?: string | null): QueueEntry[];
  markDone(repoFullName: string, identifier: string): QueueEntry | null;
  markFailed(repoFullName: string, identifier: string): QueueEntry | null;
  claimNextBatch(): QueueEntry[];
  close(): void;
};

export type InitPortfolioQueueManagerOptions = {
  caps?: Partial<PortfolioCaps>;
  store?: PortfolioQueueStore;
  dbPath?: string;
};

export function initPortfolioQueueManager(options?: InitPortfolioQueueManagerOptions): PortfolioQueueManager;

export function closeDefaultPortfolioQueueManager(): void;
