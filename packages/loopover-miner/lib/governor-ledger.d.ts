export type GovernorLedgerEntry = {
    id: number;
    ts: string;
    eventType: string;
    repoFullName: string | null;
    actionClass: string;
    decision: string;
    reason: string;
    payload: Record<string, unknown>;
};
export type AppendGovernorEventInput = {
    eventType: string;
    repoFullName?: string | null;
    actionClass: string;
    decision: string;
    reason: string;
    payload?: Record<string, unknown>;
};
export type ReadGovernorEventsFilter = {
    repoFullName?: string | null;
};
/** The public decision-log projection (#5159): every {@link GovernorLedgerEntry} field EXCEPT `payload`. */
export type GovernorDecisionEntry = Omit<GovernorLedgerEntry, "payload">;
export type GovernorLedger = {
    dbPath: string;
    appendGovernorEvent(event: AppendGovernorEventInput): GovernorLedgerEntry;
    readGovernorEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[];
    /** Read-only decision-log projection; excludes `payload` by construction (explicit named-column SELECT). */
    readGovernorDecisions(filter?: ReadGovernorEventsFilter): GovernorDecisionEntry[];
    purgeByRepo(repoFullName: string): number;
    close(): void;
};
export declare function resolveGovernorLedgerDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the append-only governor ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#2328)
 */
export declare function initGovernorLedger(dbPath?: string): GovernorLedger;
export declare function appendGovernorEvent(event: AppendGovernorEventInput): GovernorLedgerEntry;
export declare function readGovernorEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[];
export declare function closeDefaultGovernorLedger(): void;
