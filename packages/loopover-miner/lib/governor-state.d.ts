import type { GovernorCapUsage, OwnSubmissionRecord, RepoOutcomeHistory, WriteRateLimitBackoffStore, WriteRateLimitBucketStore } from "@loopover/engine";
export type GovernorRateLimitState = {
    buckets: WriteRateLimitBucketStore;
    backoffAttempts: WriteRateLimitBackoffStore;
};
export type ListRecentOwnSubmissionsFilter = {
    repoFullName?: string;
    limit?: number;
};
export type GovernorPauseState = {
    paused: boolean;
    reason: string | null;
    pausedAt: string | null;
};
export type GovernorPauseInput = {
    paused: boolean;
    reason?: string | null;
};
export type GovernorState = {
    dbPath: string;
    loadRateLimitState(): GovernorRateLimitState;
    saveRateLimitState(rateLimitState: GovernorRateLimitState): void;
    loadCapUsage(): GovernorCapUsage;
    saveCapUsage(capUsage: GovernorCapUsage): void;
    loadPauseState(): GovernorPauseState;
    savePauseState(pauseState: GovernorPauseInput): GovernorPauseState;
    loadReputationHistory(repoFullName: string, apiBaseUrl?: string): RepoOutcomeHistory;
    saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory, apiBaseUrl?: string): RepoOutcomeHistory;
    recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord;
    listRecentOwnSubmissions(filter?: ListRecentOwnSubmissionsFilter): OwnSubmissionRecord[];
    /** Delete every repo-scoped row for one repo across both governor tables (#7091); returns total rows removed. */
    purgeByRepo(repoFullName: string): number;
    close(): void;
};
export declare function resolveGovernorStateDbPath(env?: Record<string, string | undefined>): string;
/** Opens the local governor-state store, creating tables on first use. */
export declare function openGovernorState(dbPath?: string): GovernorState;
export declare function loadRateLimitState(): GovernorRateLimitState;
export declare function saveRateLimitState(rateLimitState: GovernorRateLimitState): void;
export declare function loadCapUsage(): GovernorCapUsage;
export declare function saveCapUsage(capUsage: GovernorCapUsage): void;
export declare function loadPauseState(): GovernorPauseState;
export declare function savePauseState(pauseState: GovernorPauseInput): GovernorPauseState;
export declare function loadReputationHistory(repoFullName: string, apiBaseUrl?: string): RepoOutcomeHistory;
export declare function saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory, apiBaseUrl?: string): RepoOutcomeHistory;
export declare function recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord;
export declare function listRecentOwnSubmissions(filter?: ListRecentOwnSubmissionsFilter): OwnSubmissionRecord[];
export declare function closeDefaultGovernorState(): void;
