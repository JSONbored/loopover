import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCleanupResource } from "./process-lifecycle.js";

// Shared path-resolution + DB-open boilerplate for the package's local SQLite stores (#4272). This is a DRY pass
// only, not a merge: run-state.js, claim-ledger.js, portfolio-queue.js, and event-ledger.js each keep their own
// `.sqlite3` file, table, and env var — this module just extracts the ~15 lines each hand-duplicated
// (env-var/config-dir/XDG path resolution, mkdirSync(0o700) + chmodSync(0o600), and `PRAGMA busy_timeout`).

/**
 * Resolve a local store's DB path from, in order: an explicit env var, `LOOPOVER_MINER_CONFIG_DIR`,
 * `XDG_CONFIG_HOME` (falling back to `~/.config`) — mirroring every store's prior hand-written resolver.
 */
export function resolveLocalStoreDbPath(defaultDbFileName, explicitEnvVarName, env = process.env) {
  const explicitPath = typeof env[explicitEnvVarName] === "string" ? env[explicitEnvVarName].trim() : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
    ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "loopover-miner", defaultDbFileName);
}

/** Trim and validate a caller-supplied (or resolved-default) DB path, throwing `invalidPathError` if it is empty. */
export function normalizeLocalStoreDbPath(dbPath, resolvedDefault, invalidPathError) {
  const raw = dbPath ?? resolvedDefault;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(invalidPathError);
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
  if (!isMemory) mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  if (!isMemory) chmodSync(resolvedPath, 0o600);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // Crash-safety (#4826): register every opened store so a SIGINT/SIGTERM/uncaught-exception handler can close it
  // mid-run instead of leaving it half-written. The normal `close()` unregisters first, so the happy path never
  // double-closes and a long-running `loop` doesn't accumulate stale references.
  const unregister = registerCleanupResource(db);
  const originalClose = db.close.bind(db);
  db.close = () => {
    unregister();
    return originalClose();
  };
  return db;
}
