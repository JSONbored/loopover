import type { DatabaseSync } from "node:sqlite";

export function resolveLocalStoreDbPath(
  defaultDbFileName: string,
  explicitEnvVarName: string,
  env?: Record<string, string | undefined>,
): string;

export function normalizeLocalStoreDbPath(
  dbPath: string | null | undefined,
  resolvedDefault: string,
  invalidPathError: string,
): string;

export function openLocalStoreDb(
  resolvedPath: string,
  options?: { busyTimeoutMs?: number },
): DatabaseSync;

export function openLocalStoreAdapter(
  resolvedPath: string,
  options?: { busyTimeoutMs?: number },
): {
  db: DatabaseSync;
  driver: import("./store-db-adapter.js").SqliteDriver;
  d1: import("./store-db-adapter.js").MinerD1Database;
};
