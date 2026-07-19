import type { ClaimEntry, ClaimLedger, ClaimStatus } from "./claim-ledger.js";
export type ParsedClaimClaimArgs = {
    repoFullName: string;
    issueNumber: number;
    note: string | undefined;
    dryRun: boolean;
    json: boolean;
    apiBaseUrl: string | undefined;
} | {
    error: string;
};
export type ParsedClaimReleaseArgs = {
    repoFullName: string;
    issueNumber: number;
    dryRun: boolean;
    json: boolean;
    apiBaseUrl: string | undefined;
} | {
    error: string;
};
export type ParsedClaimListArgs = {
    json: boolean;
    repoFullName: string | null;
    status: ClaimStatus | null;
} | {
    error: string;
};
type ClaimCliOptions = {
    openClaimLedger?: () => ClaimLedger;
};
export declare function parseClaimClaimArgs(args: string[]): ParsedClaimClaimArgs;
export declare function parseClaimReleaseArgs(args: string[]): ParsedClaimReleaseArgs;
export declare function parseClaimListArgs(args: string[]): ParsedClaimListArgs;
export declare function renderClaimsTable(entries: ClaimEntry[]): string;
export declare function runClaimClaim(args: string[], options?: ClaimCliOptions): number;
export declare function runClaimRelease(args: string[], options?: ClaimCliOptions): number;
export declare function runClaimList(args: string[], options?: ClaimCliOptions): number;
export declare function runClaimCli(subcommand: string | undefined, args: string[], options?: ClaimCliOptions): number;
export {};
