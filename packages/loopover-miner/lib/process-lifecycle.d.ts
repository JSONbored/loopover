/** Process lifecycle / crash-safety for the miner CLI (#4826). The CLI dispatches through a chain of bare
 * `process.exit()` calls with no cleanup hook, so a SIGINT/SIGTERM mid-run — or an uncaught exception — used to
 * kill the process mid-write, leaving whatever local SQLite ledger it was touching in an undefined state. This
 * module is the single cleanup chokepoint: local stores register themselves when opened (see `local-store.js`), and
 * `installCliSignalHandlers` (called once at CLI startup) flushes/closes every still-open resource before exiting
 * cleanly on a signal, and logs + exits non-zero on an uncaught exception / unhandled rejection instead of crashing
 * silently. Cleanup ONLY — no command business logic lives here. Every dependency (`process`, `log`, `exit`) is
 * injectable so the handlers are unit-testable without actually signalling the test runner. */
/** A closable store (`{ close() }`) or a plain cleanup callback. */
export type CleanupResource = {
    close: () => void;
} | (() => void);
/** The subset of `process` the handlers use; injectable for tests. */
export type ProcessLike = {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    exit: (code?: number) => void;
};
export type InstallCliSignalHandlersOptions = {
    process?: ProcessLike;
    log?: (message: string) => void;
    exit?: (code: number) => void;
    /** Called (in addition to `log`) for uncaughtException/unhandledRejection specifically -- not the clean
     *  SIGINT/SIGTERM exits, which are not errors. AWAITED before the process exits, so it should both capture
     *  AND flush (see captureMinerErrorAndFlush in bin/loopover-miner.js) -- a synchronous capture alone only
     *  queues the event, which process.exit() would then likely never deliver. No-op default. Never expected to
     *  throw/reject. */
    captureError?: (error: unknown, context?: Record<string, unknown>) => void | Promise<void>;
    /** Reinstall even if handlers were already installed (mainly for tests). */
    force?: boolean;
};
/**
 * Register a resource to be closed on clean exit or crash. Returns an idempotent unregister function (call it from
 * the resource's own normal `close()` so a resource closed during the happy path is not double-closed at exit).
 */
export declare function registerCleanupResource(resource: CleanupResource | null | undefined): () => void;
/** Number of currently-registered cleanup resources (exposed for tests / diagnostics). */
export declare function cleanupResourceCount(): number;
/**
 * Close every registered resource, swallowing each individual failure (a store that fails to close must not stop
 * the others from closing) and reporting it via `options.onError`. Idempotent: the registry is emptied afterwards.
 */
export declare function closeAllCleanupResources(options?: {
    onError?: (error: unknown) => void;
}): void;
/**
 * Install top-level signal + error handlers once. On SIGINT/SIGTERM: close all resources and exit with the
 * conventional 128+signal code. On uncaughtException/unhandledRejection: log the error, AWAIT the optional
 * captureError hook (so a captured Sentry event has a chance to actually flush before the process exits),
 * close all resources, and exit non-zero. No-op (returns false) if already installed unless `options.force` is
 * set. All of `process`, `log`, `exit`, and `captureError` are injectable for testing.
 */
export declare function installCliSignalHandlers(options?: InstallCliSignalHandlersOptions): boolean;
/** Test-only: clear the registry and the installed flag so each test starts from a clean lifecycle. */
export declare function resetProcessLifecycleForTesting(): void;
