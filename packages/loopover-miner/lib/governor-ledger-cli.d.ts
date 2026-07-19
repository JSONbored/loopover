import type { GovernorPauseCliOptions } from "./governor-pause-cli.js";
import type { GovernorLedger, GovernorLedgerEntry } from "./governor-ledger.js";
export type GovernorLedgerEventType = "allowed" | "denied" | "throttled" | "kill_switch";
export type ParsedGovernorListArgs = {
    json: boolean;
    repoFullName: string | null;
    type: GovernorLedgerEventType | null;
} | {
    error: string;
};
export declare function parseGovernorListArgs(args: string[]): ParsedGovernorListArgs;
export declare function filterGovernorEvents(events: GovernorLedgerEntry[], options?: {
    type?: string | null;
}): GovernorLedgerEntry[];
export declare function renderGovernorTable(events: GovernorLedgerEntry[]): string;
export declare function runGovernorList(args: string[], options?: {
    initGovernorLedger?: () => GovernorLedger;
}): Promise<number>;
export declare function runGovernorCli(subcommand: string | undefined, args: string[], options?: {
    initGovernorLedger?: () => GovernorLedger;
    nowMs?: number;
} & GovernorPauseCliOptions): Promise<number>;
