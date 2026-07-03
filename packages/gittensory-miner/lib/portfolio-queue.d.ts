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
  priority?: number;
};

export type PortfolioQueueStore = {
  dbPath: string;
  enqueue(item: EnqueueItem): QueueEntry;
  dequeueNext(): QueueEntry | null;
  listQueue(repoFullName?: string): QueueEntry[];
  markDone(repoFullName: string, identifier: string): QueueEntry | null;
  close(): void;
};

export const QUEUE_STATUSES: readonly QueueStatus[];

export function resolvePortfolioQueueDbPath(env?: Record<string, string | undefined>): string;

export function initPortfolioQueueStore(dbPath?: string): PortfolioQueueStore;

export function enqueue(item: EnqueueItem): QueueEntry;

export function dequeueNext(): QueueEntry | null;

export function listQueue(repoFullName?: string): QueueEntry[];

export function markDone(repoFullName: string, identifier: string): QueueEntry | null;

export function closeDefaultPortfolioQueueStore(): void;
