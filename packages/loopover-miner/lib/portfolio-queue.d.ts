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
    batchClaim(selectFn: (entries: QueueEntry[]) => Array<{
        repoFullName: string;
        identifier: string;
        apiBaseUrl?: string;
    }>): QueueEntry[];
    getAttemptHistory(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueAttemptHistory;
    purgeByRepo(repoFullName: string): number;
    close(): void;
};
export declare const QUEUE_STATUSES: readonly QueueStatus[];
export declare function resolvePortfolioQueueDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the local portfolio/queue store, creating the table on first use. Rows are ordered highest-priority-first
 * with an insertion-order tie-break: `priority DESC, enqueued_at ASC, rowid ASC` — the implicit `rowid` guarantees
 * FIFO order even when two items share a priority AND an `enqueued_at` timestamp. (#2292)
 */
export declare function initPortfolioQueueStore(dbPath?: string): PortfolioQueueStore;
export declare function enqueue(item: EnqueueItem): QueueEntry;
export declare function dequeueNext(): QueueEntry | null;
export declare function listQueue(repoFullName?: string | null): QueueEntry[];
export declare function markDone(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
export declare function markFailed(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
export declare function getAttemptHistory(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueAttemptHistory;
export declare function closeDefaultPortfolioQueueStore(): void;
