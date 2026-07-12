import type { GovernorCapUsage, OwnSubmissionRecord, RepoOutcomeHistory, WriteRateLimitBackoffStore, WriteRateLimitBucketStore } from "@jsonbored/gittensory-engine";

export type GovernorRateLimitState = {
  buckets: WriteRateLimitBucketStore;
  backoffAttempts: WriteRateLimitBackoffStore;
};

export type ListRecentOwnSubmissionsFilter = {
  repoFullName?: string;
  limit?: number;
};

export type GovernorState = {
  dbPath: string;
  loadRateLimitState(): GovernorRateLimitState;
  saveRateLimitState(rateLimitState: GovernorRateLimitState): void;
  loadCapUsage(): GovernorCapUsage;
  saveCapUsage(capUsage: GovernorCapUsage): void;
  loadReputationHistory(repoFullName: string): RepoOutcomeHistory;
  saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory): RepoOutcomeHistory;
  recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord;
  listRecentOwnSubmissions(filter?: ListRecentOwnSubmissionsFilter): OwnSubmissionRecord[];
  close(): void;
};

export function resolveGovernorStateDbPath(env?: Record<string, string | undefined>): string;

export function openGovernorState(dbPath?: string): GovernorState;

export function loadRateLimitState(): GovernorRateLimitState;

export function saveRateLimitState(rateLimitState: GovernorRateLimitState): void;

export function loadCapUsage(): GovernorCapUsage;

export function saveCapUsage(capUsage: GovernorCapUsage): void;

export function loadReputationHistory(repoFullName: string): RepoOutcomeHistory;

export function saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory): RepoOutcomeHistory;

export function recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord;

export function listRecentOwnSubmissions(filter?: ListRecentOwnSubmissionsFilter): OwnSubmissionRecord[];

export function closeDefaultGovernorState(): void;
