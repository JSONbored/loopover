import { DatabaseSync } from "node:sqlite";
import { type MinerD1Database, type SqliteDriver } from "./store-db-adapter.js";
/**
 * Resolve a local store's DB path from, in order: an explicit env var, `LOOPOVER_MINER_CONFIG_DIR`,
 * `XDG_CONFIG_HOME` (falling back to `~/.config`) — mirroring every store's prior hand-written resolver.
 */
export declare function resolveLocalStoreDbPath(defaultDbFileName: string, explicitEnvVarName: string, env?: Record<string, string | undefined>): string;
/** Trim and validate a caller-supplied (or resolved-default) DB path, throwing `invalidPathError` if it is empty. */
export declare function normalizeLocalStoreDbPath(dbPath: string | null | undefined, resolvedDefault: string, invalidPathError: string): string;
/**
 * Open (creating parent dirs on first use) a local store's SQLite file with 0700/0600 permissions and a shared
 * busy-timeout, so two instances of the same store on one file serialize writes instead of racing. Skips the
 * mkdir/chmod steps for the special `:memory:` path, which has no on-disk file. `run-state.js` previously opened
 * its DB with no busy-timeout at all (the one inconsistency among the four stores this issue found); folding it
 * through this shared helper gives it the same wait-don't-fail behavior the other three already had.
 */
export declare function openLocalStoreDb(resolvedPath: string, options?: {
    busyTimeoutMs?: number;
}): DatabaseSync;
/**
 * Open a local store through the #7175 SqliteDriver / D1 adapter seam.
 * Returns the underlying DatabaseSync (for schema migrations / purge helpers that still take it),
 * the sync SqliteDriver (preferred for store CRUD until a store goes fully async), and the async D1
 * adapter (same surface ORB uses — ready for a later createPgAdapter swap).
 */
export declare function openLocalStoreAdapter(resolvedPath: string, options?: {
    busyTimeoutMs?: number;
}): {
    db: DatabaseSync;
    driver: SqliteDriver;
    d1: MinerD1Database;
};
