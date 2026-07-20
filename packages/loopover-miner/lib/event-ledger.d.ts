export type LedgerEntry = {
    id: number;
    seq: number;
    type: string;
    repoFullName: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
};
export type AppendEventInput = {
    type: string;
    repoFullName?: string;
    payload: Record<string, unknown>;
};
export type ReadEventsFilter = {
    repoFullName?: string | null;
    since?: number | null;
};
export type EventLedger = {
    dbPath: string;
    appendEvent(event: AppendEventInput): LedgerEntry;
    readEvents(filter?: ReadEventsFilter): LedgerEntry[];
    purgeByRepo(repoFullName: string): number;
    close(): void;
};
export declare function resolveEventLedgerDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the local append-only event ledger, creating the table on first use. `seq` is a monotonically increasing
 * counter maintained by this module (next = current MAX(seq) + 1) rather than relying on `AUTOINCREMENT`'s
 * reuse-after-vacuum behavior, so consumers get a stable ordering guarantee. Rows read back in `seq ASC` order.
 * (#2290)
 */
export declare function initEventLedger(dbPath?: string): EventLedger;
export declare function appendEvent(event: AppendEventInput): LedgerEntry;
export declare function readEvents(filter?: ReadEventsFilter): LedgerEntry[];
export declare function closeDefaultEventLedger(): void;
