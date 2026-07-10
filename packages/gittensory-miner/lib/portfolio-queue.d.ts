export type QueueStatus = "queued" | "in_progress" | "done";

export type QueueEntry = {
  repoFullName: string;
  identifier: string;
  priority: number;
  status: QueueStatus;
  enqueuedAt: string;
};

export type EnqueueItem = {
  repoFullName: string;
  identifier: string;
  priority?: number | null;
};

export type PortfolioQueueStore = {
  dbPath: string;
  enqueue(item: EnqueueItem): QueueEntry;
  dequeueNext(): QueueEntry | null;
  listQueue(repoFullName?: string | null): QueueEntry[];
  markDone(repoFullName: string, identifier: string): QueueEntry | null;
  batchClaim(
    selectFn: (entries: QueueEntry[]) => Array<{ repoFullName: string; identifier: string }>,
  ): QueueEntry[];
  close(): void;
};

export const QUEUE_STATUSES: readonly QueueStatus[];

export function resolvePortfolioQueueDbPath(env?: Record<string, string | undefined>): string;

export function initPortfolioQueueStore(dbPath?: string): PortfolioQueueStore;

export function enqueue(item: EnqueueItem): QueueEntry;

export function dequeueNext(): QueueEntry | null;

export function listQueue(repoFullName?: string | null): QueueEntry[];

export function markDone(repoFullName: string, identifier: string): QueueEntry | null;

export function closeDefaultPortfolioQueueStore(): void;
