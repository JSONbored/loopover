import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCleanupResource } from "./process-lifecycle.js";
import { createD1Adapter, nodeSqliteDriver } from "./store-db-adapter.js";
// Shared path-resolution + DB-open boilerplate for the package's local SQLite stores (#4272). This is a DRY pass
// only, not a merge: run-state.js, claim-ledger.js, portfolio-queue.js, and event-ledger.js each keep their own
// `.sqlite3` file, table, and env var — this module just extracts the ~15 lines each hand-duplicated
// (env-var/config-dir/XDG path resolution, mkdirSync(0o700) + chmodSync(0o600), and `PRAGMA busy_timeout`).
//
// #7175 part 1 adds `openLocalStoreAdapter`: same open path, then wraps the handle as SqliteDriver + D1 adapter
// so stores can migrate onto the shared seam without changing self-host's node:sqlite default.
/**
 * Resolve a local store's DB path from, in order: an explicit env var, `LOOPOVER_MINER_CONFIG_DIR`,
 * `XDG_CONFIG_HOME` (falling back to `~/.config`) — mirroring every store's prior hand-written resolver.
 */
export function resolveLocalStoreDbPath(defaultDbFileName, explicitEnvVarName, env = process.env) {
    const explicitPath = typeof env[explicitEnvVarName] === "string" ? env[explicitEnvVarName].trim() : "";
    if (explicitPath)
        return explicitPath;
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return join(explicitConfigDir, defaultDbFileName);
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner", defaultDbFileName);
}
/** Trim and validate a caller-supplied (or resolved-default) DB path, throwing `invalidPathError` if it is empty. */
export function normalizeLocalStoreDbPath(dbPath, resolvedDefault, invalidPathError) {
    const raw = dbPath ?? resolvedDefault;
    if (typeof raw !== "string" || !raw.trim())
        throw new Error(invalidPathError);
    return raw.trim();
}
/**
 * Open (creating parent dirs on first use) a local store's SQLite file with 0700/0600 permissions and a shared
 * busy-timeout, so two instances of the same store on one file serialize writes instead of racing. Skips the
 * mkdir/chmod steps for the special `:memory:` path, which has no on-disk file. `run-state.js` previously opened
 * its DB with no busy-timeout at all (the one inconsistency among the four stores this issue found); folding it
 * through this shared helper gives it the same wait-don't-fail behavior the other three already had.
 */
export function openLocalStoreDb(resolvedPath, options = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    const isMemory = resolvedPath === ":memory:";
    if (!isMemory)
        mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(resolvedPath);
    if (!isMemory)
        chmodSync(resolvedPath, 0o600);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // Crash-safety (#4826): register every opened store so a SIGINT/SIGTERM/uncaught-exception handler can close it
    // mid-run instead of leaving it half-written. The normal `close()` unregisters first, so the happy path never
    // double-closes and a long-running `loop` doesn't accumulate stale references.
    const unregister = registerCleanupResource(db);
    const originalClose = db.close.bind(db);
    // Wrap close so cleanup registration is torn down with the handle. Assignment is intentional runtime behavior
    // that the DatabaseSync type does not expose as writable.
    db.close = () => {
        unregister();
        return originalClose();
    };
    return db;
}
/**
 * Open a local store through the #7175 SqliteDriver / D1 adapter seam.
 * Returns the underlying DatabaseSync (for schema migrations / purge helpers that still take it),
 * the sync SqliteDriver (preferred for store CRUD until a store goes fully async), and the async D1
 * adapter (same surface ORB uses — ready for a later createPgAdapter swap).
 */
export function openLocalStoreAdapter(resolvedPath, options = {}) {
    const db = openLocalStoreDb(resolvedPath, options);
    const driver = nodeSqliteDriver(db);
    const d1 = createD1Adapter(driver);
    return { db, driver, d1 };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9jYWwtc3RvcmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsb2NhbC1zdG9yZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUMvQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQzFDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDM0MsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sd0JBQXdCLENBQUM7QUFDakUsT0FBTyxFQUFFLGVBQWUsRUFBRSxnQkFBZ0IsRUFBMkMsTUFBTSx1QkFBdUIsQ0FBQztBQUVuSCxpSEFBaUg7QUFDakgsZ0hBQWdIO0FBQ2hILHFHQUFxRztBQUNyRyw0R0FBNEc7QUFDNUcsRUFBRTtBQUNGLGdIQUFnSDtBQUNoSCwrRkFBK0Y7QUFFL0Y7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLHVCQUF1QixDQUNyQyxpQkFBeUIsRUFDekIsa0JBQTBCLEVBQzFCLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBRXJELE1BQU0sWUFBWSxHQUFHLE9BQU8sR0FBRyxDQUFDLGtCQUFrQixDQUFDLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsa0JBQWtCLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3ZHLElBQUksWUFBWTtRQUFFLE9BQU8sWUFBWSxDQUFDO0lBRXRDLE1BQU0saUJBQWlCLEdBQUcsT0FBTyxHQUFHLENBQUMseUJBQXlCLEtBQUssUUFBUTtRQUN6RSxDQUFDLENBQUMsR0FBRyxDQUFDLHlCQUF5QixDQUFDLElBQUksRUFBRTtRQUN0QyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1AsSUFBSSxpQkFBaUI7UUFBRSxPQUFPLElBQUksQ0FB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