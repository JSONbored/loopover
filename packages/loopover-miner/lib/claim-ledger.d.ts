export type ClaimStatus = "active" | "released" | "expired";

export type ClaimEntry = {
  id: number;
  apiBaseUrl: string;
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
  apiBaseUrl?: string;
};

export type ListClaimsFilter = {
  repoFullName?: string | null;
  status?: ClaimStatus | null;
};

/** Result of an atomic, concurrency-capped claim (#6758). `claimed` discriminates success (a recorded claim)
 *  from a cap rejection (`claim: null`); both carry the pre-insert active count and the resolved cap so a
 *  rejected caller can still log the violation. */
export type ClaimWithinCapResult =
  | { claimed: true; claim: ClaimEntry; activeClaimCount: number; maxConcurrentClaims: number }
  | { claimed: false; claim: null; activeClaimCount: number; maxConcurrentClaims: number };

export type ClaimLedger = {
  dbPath: string;
  recordClaim(claim: RecordClaimInput): ClaimEntry;
  /** Claims the issue, expiring any claim orphaned by a dead process first (#6156). */
  claimIssue(repoFullName: string, issueNumber: number, note?: string, apiBaseUrl?: string): ClaimEntry;
  /** Atomically records the claim only while this repo's active-claim count is under `maxConcurrentClaims`,
   *  counting and inserting in one transaction so racing sibling processes can't exceed the cap (#6758). */
  claimIssueWithinCap(
    repoFullName: string,
    issueNumber: number,
    note: string | undefined,
    apiBaseUrl: string | undefined,
    maxConcurrentClaims: number,
  ): ClaimWithinCapResult;
  /** Expire claims orphaned by a crashed/killed process, returning the transitioned rows (#6156). */
  reclaimExpiredClaims(maxAgeMs?: number): ClaimEntry[];
  releaseClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
  expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
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

export function releaseClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;

export function expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;

export function listClaims(filter?: ListClaimsFilter): ClaimEntry[];

export function claimIssue(repoFullName: string, issueNumber: number, note?: string, apiBaseUrl?: string): ClaimEntry;

export function listActiveClaims(repoFullName?: string): ClaimEntry[];

export function closeDefaultClaimLedger(): void;
