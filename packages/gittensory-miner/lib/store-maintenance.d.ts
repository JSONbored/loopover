import type { DatabaseSync } from "node:sqlite";

export const LEDGER_RETENTION_DAYS_ENV: string;
export const LEDGER_RETENTION_MAX_ROWS_ENV: string;

export type LedgerRetentionSpec = { table: string; timestampColumn: string; orderColumn: string };
export const EVENT_LEDGER_RETENTION_SPEC: LedgerRetentionSpec;
export const GOVERNOR_LEDGER_RETENTION_SPEC: LedgerRetentionSpec;
export const PREDICTION_LEDGER_RETENTION_SPEC: LedgerRetentionSpec;

export type LedgerPurgeSpec = { table: string; repoColumn: string };
export const CLAIM_LEDGER_PURGE_SPEC: LedgerPurgeSpec;
export const EVENT_LEDGER_PURGE_SPEC: LedgerPurgeSpec;
export const GOVERNOR_LEDGER_PURGE_SPEC: LedgerPurgeSpec;
export const PREDICTION_LEDGER_PURGE_SPEC: LedgerPurgeSpec;

export type StoreIntegrityResult = { name: string; ok: boolean; detail: string };
export type LedgerRetentionPolicy = { maxAgeMs?: number; maxRows?: number };

export function describeError(error: unknown): string;
export function classifyIntegrityRows(rows: Array<{ integrity_check?: unknown }>): { ok: boolean; note: string };
export function checkStoreIntegrity(name: string, dbPath: string): StoreIntegrityResult;
export function resolveLedgerRetentionPolicy(env?: Record<string, string | undefined>): LedgerRetentionPolicy | null;
export function pruneLedgerByRetention(
  db: DatabaseSync,
  spec: LedgerRetentionSpec,
  policy: LedgerRetentionPolicy | null,
  nowMs: number,
): number;
export function purgeStoreByRepo(db: DatabaseSync, spec: LedgerPurgeSpec, repoFullName: string): number;
export function countStoreByRepo(db: DatabaseSync, spec: LedgerPurgeSpec, repoFullName: string): number;
