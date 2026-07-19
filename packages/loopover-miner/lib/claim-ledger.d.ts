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
export type ClaimWithinCapResult = {
    claimed: true;
    claim: ClaimEntry;
    activeClaimCount: number;
    maxConcurrentClaims: number;
} | {
    claimed: false;
    claim: null;
    activeClaimCount: number;
    maxConcurrentClaims: number;
};
export type ClaimLedger = {
    dbPath: string;
    recordClaim(claim: RecordClaimInput): ClaimEntry;
    /** Claims the issue, expiring any claim orphaned by a dead process first (#6156). */
    claimIssue(repoFullName: string, issueNumber: number, note?: string, apiBaseUrl?: string): ClaimEntry;
    /** Atomically records the claim only while this repo's active-claim count is under `maxConcurrentClaims`,
     *  counting and inserting in one transaction so racing sibling processes can't exceed the cap (#6758). */
    claimIssueWithinCap(repoFullName: string, issueNumber: number, note: string | undefined, apiBaseUrl: string | undefined, maxConcurrentClaims: number): ClaimWithinCapResult;
    /** Expire claims orphaned by a crashed/killed process, returning the transitioned rows (#6156). */
    reclaimExpiredClaims(maxAgeMs?: number): ClaimEntry[];
    releaseClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
    expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
    listClaims(filter?: ListClaimsFilter): ClaimEntry[];
    listActiveClaims(repoFullName?: string): ClaimEntry[];
    purgeByRepo(repoFullName: string): number;
    close(): void;
};
export type ReadOnlyClaimLedger = {
    dbPath: string;
    listActiveClaims(repoFullName: string): ClaimEntry[];
    close(): void;
};
export declare const CLAIM_STATUSES: readonly ClaimStatus[];
export declare function resolveClaimLedgerDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the local claim ledger, creating the table on first use. `UNIQUE(api_base_url, repo_full_name,
 * issue_number)` keeps ONE row per claimed issue per forge host, and `recordClaim` is a single atomic
 * INSERT…ON CONFLICT statement (no read-then-write), so concurrent claims cannot duplicate a row. (#2314, #5563)
 */
export declare function openClaimLedger(dbPath?: string): ClaimLedger;
/**
 * Strictly read-only ledger access for advisory-only callers (#5157) that must never write anything --
 * not even the schema-creation DDL and schema-version stamp {@link openClaimLedger} always runs on open.
 * Opens the DB file in SQLite's own `readonly` mode (driver-enforced: an attempted write throws, this isn't
 * just a by-convention guarantee) and touches the filesystem in no other way -- no `mkdirSync`/`chmodSync`,
 * no `CREATE TABLE IF NOT EXISTS`, no migrations. The caller MUST only call this against a path it has
 * already confirmed exists (e.g. via `existsSync`); a read-only connection to a nonexistent file throws.
 * Throws if the expected table is missing too (a file exists at this path but isn't a real claim ledger) --
 * callers should treat that identically to any other open/query failure.
 */
export declare function openClaimLedgerReadOnly(dbPath: string): ReadOnlyClaimLedger;
export declare function recordClaim(claim: RecordClaimInput): ClaimEntry;
export declare function releaseClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
export declare function expireClaim(repoFullName: string, issueNumber: number, apiBaseUrl?: string): ClaimEntry | null;
export declare function listClaims(filter?: ListClaimsFilter): ClaimEntry[];
/** Foundation-phase alias for `recordClaim({ repoFullName, issueNumber, note, apiBaseUrl })`. (#3351) */
export declare function claimIssue(repoFullName: string, issueNumber: number, note?: string, apiBaseUrl?: string): ClaimEntry;
/** List only `active` claims, optionally scoped to one repo. (#3351) */
export declare function listActiveClaims(repoFullName?: string): ClaimEntry[];
export declare function closeDefaultClaimLedger(): void;
