export type QueueStatus = "queued" | "in_progress" | "done";

export type QueueEntry = {
  apiBaseUrl: string;
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
  apiBaseUrl?: string;
};

/** Lease-annotated view of an in-flight row: when it was claimed, for the expiry sweep (#4827). */
export type QueueLeaseEntry = {
  apiBaseUrl: string;
  repoFullName: string;
  identifier: string;
  status: QueueStatus;
  leasedAt: string | null;
};

/** A real per-item PortfolioConvergenceInput (non-convergence.ts, #5654), read from this store's own
 *  attempt-history counters -- see getAttemptHistory. */
export type QueueAttemptHistory = {
  attempts: number;
  consecutiveFailures: number;
  reenqueues: number;
  reachedDone: boolean;
};

export type PortfolioQueueStore = {
  dbPath: string;
  enqueue(item: EnqueueItem): QueueEntry;
  dequeueNext(): QueueEntry | null;
  listQueue(repoFullName?: string | null): QueueEntry[];
  listInProgress(): QueueLeaseEntry[];
  markDone(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
  markFailed(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
  reclaimStuckItem(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
  requeueItem(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
  batchClaim(
    selectFn: (
      entries: QueueEntry[],
    ) => Array<{ repoFullName: string; identifier: string; apiBaseUrl?: string }>,
  ): QueueEntry[];
  getAttemptHistory(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueAttemptHistory;
  close(): void;
};

export const QUEUE_STATUSES: readonly QueueStatus[];

export function resolvePortfolioQueueDbPath(env?: Record<string, string | undefined>): string;

export function initPortfolioQueueStore(dbPath?: string): PortfolioQueueStore;

export function enqueue(item: EnqueueItem): QueueEntry;

export function dequeueNext(): QueueEntry | null;

export function listQueue(repoFullName?: string | null): QueueEntry[];

export function markDone(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;

export function markFailed(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;

export function getAttemptHistory(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueAttemptHistory;

export function closeDefaultPortfolioQueueStore(): void;
