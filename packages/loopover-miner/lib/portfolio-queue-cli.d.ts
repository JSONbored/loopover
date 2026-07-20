import type { PortfolioQueueStore, QueueEntry } from "./portfolio-queue.js";
import type { PortfolioQueueManager } from "./portfolio-queue-manager.js";
export type ParsedQueueListArgs = {
    json: boolean;
    repoFullName: string | null;
} | {
    error: string;
};
export type ParsedQueueNextArgs = {
    json: boolean;
    dryRun: boolean;
    globalWipCap: number | undefined;
    perRepoWipCap: number | undefined;
} | {
    error: string;
};
export type QueueClaimTarget = {
    repoFullName: string;
    identifier: string;
    apiBaseUrl: string;
};
export type ParsedQueueDoneArgs = {
    repoFullName: string;
    identifier: string;
    dryRun: boolean;
    json: boolean;
    apiBaseUrl: string | undefined;
} | {
    error: string;
};
export type ParsedQueueClaimBatchArgs = {
    json: boolean;
    dryRun: boolean;
    globalWipCap: number;
    perRepoWipCap: number;
} | {
    error: string;
};
export declare function parseQueueListArgs(args: string[]): ParsedQueueListArgs;
export declare function parseQueueNextArgs(args: string[]): ParsedQueueNextArgs;
/**
 * Pick at most one atomically-claimable target from the store's already-priority-ordered active rows (queued
 * AND in_progress interleaved, exactly `batchClaim`'s own `entries` shape). `caps` of `null` replicates the
 * pre-#4850 behavior: the single highest-priority queued row, unconditionally. When caps are set, refuses to
 * select anything once the global or the target row's own per-repo in-progress count has reached its cap --
 * "stops claiming once the cap is reached" (#4850), not a diversifying batch selection (that remains
 * claim-batch's job via the engine's own `nextEligibleItems`).
 * @param {Array<{ repoFullName: string, identifier: string, apiBaseUrl: string, status: string }>} entries
 * @param {{ globalWipCap: number, perRepoWipCap: number } | null} caps
 */
export declare function selectNextEligibleTarget(entries: Array<{
    repoFullName: string;
    identifier: string;
    apiBaseUrl: string;
    status: string;
}>, caps: {
    globalWipCap: number;
    perRepoWipCap: number;
} | null): QueueClaimTarget[];
export declare function parseQueueDoneArgs(args: string[]): ParsedQueueDoneArgs;
export declare function parseQueueReleaseArgs(args: string[]): ParsedQueueDoneArgs;
export declare function parseQueueRequeueArgs(args: string[]): ParsedQueueDoneArgs;
export declare function renderQueueTable(entries: QueueEntry[]): string;
export declare function runQueueList(args: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
}): number;
export declare function runQueueNext(args: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
}): number;
export declare function runQueueDone(args: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
}): number;
/** `release <owner/repo> <identifier>`: manually give up a CLAIMED (in_progress) item, returning it to the queue
 *  (the manual counterpart to the automated stuck-lease sweep). Exit 2 when there is no in-flight item to release. */
export declare function runQueueRelease(args: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
}): number;
/** `requeue <owner/repo> <identifier>`: manually put a COMPLETED (done) item back on the queue so it is picked up
 *  again, keeping its original FIFO position. Exit 2 when there is no done item to requeue (already queued,
 *  in-flight — release it instead — or absent). */
export declare function runQueueRequeue(args: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
}): number;
export declare function parseQueueClaimBatchArgs(args: string[]): ParsedQueueClaimBatchArgs;
/** Claim the next caps-aware batch via the WIP-cap-aware batch claimer (portfolio-queue-manager.js), which also
 *  reclaims any leases orphaned by a crashed process first (#4833 wires the previously caller-less claimer). */
export declare function runQueueClaimBatch(args: string[], options?: {
    initPortfolioQueueManager?: (opts: unknown) => PortfolioQueueManager;
}): number;
export declare const QUEUE_ITEMS = "loopover_miner_portfolio_queue_items";
export declare const QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS = "loopover_miner_portfolio_queue_oldest_in_progress_lease_age_seconds";
/**
 * Render portfolio-queue backlog health as Prometheus text-exposition gauges: current item count per status, and
 * the age of the OLDEST still-in-flight lease -- the concrete "is anything stuck" signal a
 * `loopover_queue_oldest_maintenance_pending_age_seconds`-style alert rule can threshold on (#5186). Pure and
 * side-effect-free: the caller supplies the rows and `nowMs` (no internal clock read, matching
 * store-maintenance.js's pruneLedgerByRetention convention) and prints the result. Deterministic (status series
 * sorted); always emits HELP/TYPE so an empty queue is still a well-formed exposition document, and the lease-age
 * gauge reads 0 (never stuck) rather than being omitted when nothing is in-flight.
 * @param {Array<{ status: string }>} queueEntries - every row, any status (e.g. store.listQueue()'s output).
 * @param {Array<{ leasedAt: string | null }>} leaseEntries - in-flight rows only (store.listInProgress()'s output).
 * @param {number} nowMs
 */
export declare function renderPortfolioQueueMetrics(queueEntries: Array<{
    status: string;
}>, leaseEntries: Array<{
    leasedAt: string | null;
}>, nowMs: number): string;
export declare function runQueueMetrics(args: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
    nowMs?: number;
}): number;
export declare function runQueueCli(subcommand: string | undefined, args: string[], options?: {
    initPortfolioQueue?: () => PortfolioQueueStore;
    initPortfolioQueueManager?: (opts: unknown) => PortfolioQueueManager;
}): number;
