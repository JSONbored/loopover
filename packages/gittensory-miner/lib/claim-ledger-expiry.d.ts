import type { ClaimEntry } from "./claim-ledger.js";

export declare const DEFAULT_MAX_CLAIM_AGE_MS: number;

export type ClaimLedgerExpiryStore = {
  listClaims(filter?: { status?: "active" }): ClaimEntry[];
  expireClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;
};

export function findExpiredClaims(
  claims: ClaimEntry[],
  nowMs: number,
  maxAgeMs: number,
): ClaimEntry[];

export function sweepExpiredClaims(
  store: ClaimLedgerExpiryStore,
  nowMs: number,
  maxAgeMs?: number,
): ClaimEntry[];
