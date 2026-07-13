import type { GovernorCapUsage, OwnSubmissionRecord, RepoOutcomeHistory, WriteRateLimitBackoffStore, WriteRateLimitBucketStore } from "@jsonbored/gittensory-engine";

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
  close(): void;
};

export function resolveGovernorStateDbPath(env?: Record<string, string | undefined>): string;

export function openGovernorState(dbPath?: string): GovernorState;

export function loadRateLimitState(): GovernorRateLimitState;

export function saveRateLimitState(rateLimitState: GovernorRateLimitState): void;

export function loadCapUsage(): GovernorCapUsage;

export function saveCapUsage(capUsage: GovernorCapUsage): void;

export function loadPauseState(): GovernorPauseState;

export function savePauseState(pauseState: GovernorPauseInput): GovernorPauseState;

export function loadReputationHistory(repoFullName: string, apiBaseUrl?: string): RepoOutcomeHistory;

export function saveReputationHistory(repoFullName: string, history: RepoOutcomeHistory, apiBaseUrl?: string): RepoOutcomeHistory;

export function recordOwnSubmission(record: OwnSubmissionRecord): OwnSubmissionRecord;

export function listRecentOwnSubmissions(filter?: ListRecentOwnSubmissionsFilter): OwnSubmissionRecord[];

export function closeDefaultGovernorState(): void;
