import type { ClaimEntry } from "./claim-ledger.js";
/** PURE — no IO, no Date, no random (#2316). */
export declare const DEFAULT_MAX_CLAIM_AGE_MS: number;
export type ClaimLedgerExpiryStore = {
    listClaims(filter?: {
        status?: "active";
    }): ClaimEntry[];
    expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
};
/**
 * Return active claims whose age is strictly greater than `maxAgeMs`. A claim whose age equals `maxAgeMs` exactly
 * is still considered within the window (not expired).
 */
export declare function findExpiredClaims(claims: ClaimEntry[], nowMs: number, maxAgeMs: number): ClaimEntry[];
export declare function sweepExpiredClaims(store: ClaimLedgerExpiryStore, nowMs: number, maxAgeMs?: number): ClaimEntry[];
