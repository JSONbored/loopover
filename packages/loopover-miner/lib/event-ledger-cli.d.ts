import type { EventLedger, LedgerEntry } from "./event-ledger.js";
export type ParsedLedgerListArgs = {
    json: boolean;
    repoFullName: string | null;
    since: number | null;
    type: string | null;
} | {
    error: string;
};
export declare function parseLedgerListArgs(args: string[]): ParsedLedgerListArgs;
export declare function filterLedgerEvents(events: LedgerEntry[], options?: {
    type?: string | null;
}): LedgerEntry[];
/** Metadata-only audit-feed columns exposed by the MCP tool (#5158). */
export declare const AUDIT_FEED_ENTRY_FIELDS: readonly ["eventType", "repoFullName", "outcome", "actor", "detail", "createdAt"];
/** Project one ledger row to the public, metadata-only audit-feed shape — never returns payload_json. */
export declare function projectLedgerEventToAuditFeedEntry(entry: LedgerEntry): {
    eventType: string;
    repoFullName: string | null;
    outcome: string | null;
    actor: string | null;
    detail: string | null;
    createdAt: string;
};
export type AuditFeedMcpFilterInput = {
    repoFullName?: string | null;
    since?: number | null;
    type?: string | null;
};
/** Normalize optional MCP/JSON filter args into the shape `ledger list` already uses (#5158). */
export declare function normalizeAuditFeedMcpFilter(input?: AuditFeedMcpFilterInput): {
    repoFullName: string | null;
    since: number | null;
    type: string | null;
};
/** Read-only audit feed shared by the MCP audit-feed tool (#5158). */
export declare function collectEventLedgerAuditFeed(eventLedger: EventLedger, filter?: {
    repoFullName?: string | null;
    since?: number | null;
    type?: string | null;
}): {
    repoFullName?: string;
    events: Array<{
        eventType: string;
        repoFullName: string | null;
        outcome: string | null;
        actor: string | null;
        detail: string | null;
        createdAt: string;
    }>;
};
export declare function renderLedgerTable(events: LedgerEntry[]): string;
/**
 * Render event-ledger activity as Prometheus text-exposition counters: one `loopover_miner_events_total{type}`
 * series per event type, so a self-hoster's own Grafana/alerting can scrape ledger activity instead of polling
 * `ledger list --json` (#4841). Pure + side-effect-free — the caller supplies the rows and prints the result;
 * deterministic (series emitted in sorted type order); always emits HELP/TYPE so an empty ledger is still a
 * well-formed exposition document.
 */
export declare function renderEventLedgerMetrics(events: readonly LedgerEntry[]): string;
export declare function runLedgerList(args: string[], options?: {
    initEventLedger?: () => EventLedger;
}): number;
export declare function runLedgerMetrics(args: string[], options?: {
    initEventLedger?: () => EventLedger;
}): number;
export declare function runLedgerCli(subcommand: string | undefined, args: string[], options?: {
    initEventLedger?: () => EventLedger;
}): number;
