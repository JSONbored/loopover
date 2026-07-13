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
  claimIssue(repoFullName: string, issueNumber: number, note?: string): ClaimEntry;
  releaseClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;
  expireClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;
  listClaims(filter?: ListClaimsFilter): ClaimEntry[];
  listActiveClaims(repoFullName?: string): ClaimEntry[];
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

export const CLAIM_STATUSES: readonly ClaimStatus[];

export function resolveClaimLedgerDbPath(env?: Record<string, string | undefined>): string;

export function openClaimLedger(dbPath?: string): ClaimLedger;

export type ReadOnlyClaimLedger = {
  dbPath: string;
  listActiveClaims(repoFullName: string): ClaimEntry[];
  close(): void;
};

export function openClaimLedgerReadOnly(dbPath: string): ReadOnlyClaimLedger;

export function recordClaim(claim: RecordClaimInput): ClaimEntry;

export function releaseClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;

export function expireClaim(repoFullName: string, issueNumber: number): ClaimEntry | null;

export function listClaims(filter?: ListClaimsFilter): ClaimEntry[];

export function claimIssue(repoFullName: string, issueNumber: number, note?: string): ClaimEntry;

export function listActiveClaims(repoFullName?: string): ClaimEntry[];

export function closeDefaultClaimLedger(): void;
