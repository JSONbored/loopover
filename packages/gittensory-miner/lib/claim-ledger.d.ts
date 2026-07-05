export type ClaimStatus = "active" | "released" | "expired";

export type ClaimEntry = {
  id: number;
  repoFullName: string;
  issueNumber: number;
  claimedAt: string;
  status: ClaimStatus;
  note: string | null;
};

export type RecordClaimInput = {
  repoFullName: string;
  issueNumber: number;
  note?: string;
};

export type ListClaimsFilter = {
  repoFullName?: string | null;
  status?: ClaimStatus | null;
};

export type ClaimLedger = {
  dbPath: string;
  recordClaim(claim: RecordClaimInput): ClaimEntry;
  releaseClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;
  expireClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;
  listClaims(filter?: ListClaimsFilter): ClaimEntry[];
  close(): void;
};

export const CLAIM_STATUSES: readonly ClaimStatus[];

export function resolveClaimLedgerDbPath(env?: Record<string, string | undefined>): string;

export function openClaimLedger(dbPath?: string): ClaimLedger;

export function recordClaim(claim: RecordClaimInput): ClaimEntry;

export function releaseClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;

export function expireClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;

export function listClaims(filter?: ListClaimsFilter): ClaimEntry[];

export function closeDefaultClaimLedger(): void;
