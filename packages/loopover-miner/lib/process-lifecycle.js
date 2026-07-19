/** Process lifecycle / crash-safety for the miner CLI (#4826). The CLI dispatches through a chain of bare
 * `process.exit()` calls with no cleanup hook, so a SIGINT/SIGTERM mid-run — or an uncaught exception — used to
 * kill the process mid-write, leaving whatever local SQLite ledger it was touching in an undefined state. This
 * module is the single cleanup chokepoint: local stores register themselves when opened (see `local-store.js`), and
 * `installCliSignalHandlers` (called once at CLI startup) flushes/closes every still-open resource before exiting
 * cleanly on a signal, and logs + exits non-zero on an uncaught exception / unhandled rejection instead of crashing
 * silently. Cleanup ONLY — no command business logic lives here. Every dependency (`process`, `log`, `exit`) is
 * injectable so the handlers are unit-testable without actually signalling the test runner. */
// 128 + signal number, the conventional shell exit code for a process terminated by that signal (SIGINT=2 -> 130,
// SIGTERM=15 -> 143).
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
/** Resources to close on exit. A resource is either a `{ close() }` object (e.g. an open SQLite store) or a plain
 * cleanup function. Held in insertion order so cleanup is deterministic. */
const cleanupResources = new Set();
let handlersInstalled = false;
/** Render any thrown value as a single log-safe string, preferring an Error's stack. */
function describeError(value) {
    if (value instanceof Error)
        return value.stack ?? value.message;
    return String(value);
}
/**
 * Register a resource to be closed on clean exit or crash. Returns an idempotent unregister function (call it from
 * the resource's own normal `close()` so a resource closed during the happy path is not double-closed at exit).
 */
export function registerCleanupResource(resource) {
    if (resource === null || resource === undefined)
        return () => { };
    cleanupResources.add(resource);
    return () => {
        cleanupResources.delete(resource);
    };
}
/** Number of currently-registered cleanup resources (exposed for tests / diagnostics). */
export function cleanupResourceCount() {
    return cleanupResources.size;
}
/**
 * Close every registered resource, swallowing each individual failure (a store that fails to close must not stop
 * the others from closing) and reporting it via `options.onError`. Idempotent: the registry is emptied afterwards.
 */
export function closeAllCleanupResources(options = {}) {
    const onError = typeof options.onError === "function" ? options.onError : null;
    for (const resource of [...cleanupResources]) {
        try {
            if (typeof resource === "function")
                resource();
            else
                resource.close();
        }
        catch (error) {
            if (onError)
                onError(error);
        }
    }
    cleanupResources.clear();
}
/**
 * Install top-level signal + error handlers once. On SIGINT/SIGTERM: close all resources and exit with the
 * conventional 128+signal code. On uncaughtException/unhandledRejection: log the error, AWAIT the optional
 * captureError hook (so a captured Sentry event has a chance to actually flush before the process exits),
 * close all resources, and exit non-zero. No-op (returns false) if already installed unless `options.force` is
 * set. All of `process`, `log`, `exit`, and `captureError` are injectable for testing.
 */
export function installCliSignalHandlers(options = {}) {
    const proc = options.process ?? process;
    const log = typeof options.log === "function" ? options.log : (message) => console.error(message);
    const exit = typeof options.exit === "function" ? options.exit : (code) => proc.exit(code);
    // Optional Sentry (or any) capture hook -- decoupled from a specific implementation so this module stays
    // fully unit-testable without mocking Sentry (#6011). No-op default matches this module's pre-existing
    // behavior for every caller that doesn't pass one.
    const captureError = typeof options.captureError === "function" ? options.captureError : () => { };
    if (handlersInstalled && options.force !== true)
        return false;
    handlersInstalled = true;
    const runCleanup = () => {
        closeAllCleanupResources({
            onError: (error) => log(`loopover-miner: cleanup error while exiting: ${describeError(error)}`),
        });
    };
    for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
        proc.on(signal, () => {
            log(`loopover-miner: received ${signal}, closing open resources and exiting.`);
            runCleanup();
            exit(code);
        });
    }
    // Awaited (not fire-and-forget): captureError is expected to both capture AND flush before returning (see
    // captureMinerErrorAndFlush in bin/loopover-miner.js) -- Sentry.captureException only QUEUES an event, and
    // process.exit() tears the process down immediately without waiting for any pending HTTP delivery, so a
    // synchronous capture-then-exit would make the crash-capture path a near-total no-op in practice. Node does
    // not require these handlers to be synchronous: nothing exits the process until this handler itself calls
    // `exit()`, so awaiting first is safe. captureError's own default is a synchronous no-op, so `await`-ing it
    // is a harmless no-op for every caller that doesn't pass one.
    proc.on("uncaughtException", async (error) => {
        log(`loopover-miner: uncaught exception: ${describeError(error)}`);
        await captureError(error, { kind: "uncaughtException" });
        runCleanup();
        exit(1);
    });
    proc.on("unhandledRejection", async (reason) => {
        log(`loopover-miner: unhandled promise rejection: ${describeError(reason)}`);
        await captureError(reason, { kind: "unhandledRejection" });
        runCleanup();
        exit(1);
    });
    return true;
}
/** Test-only: clear the registry and the installed flag so each test starts from a clean lifecycle. */
export function resetProcessLifecycleForTesting() {
    cleanupResources.clear();
    handlersInstalled = false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJvY2Vzcy1saWZlY3ljbGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwcm9jZXNzLWxpZmVjeWNsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7OzsrRkFPK0Y7QUF5Qi9GLGtIQUFrSDtBQUNsSCxzQkFBc0I7QUFDdEIsTUFBTSxpQkFBaUIsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztBQUV2RTs0RUFDNEU7QUFDNUUsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsRUFBbUIsQ0FBQztBQUNwRCxJQUFJLGlCQUFpQixHQUFHLEtBQUssQ0FBQztBQUU5Qix3RkFBd0Y7QUFDeEYsU0FBUyxhQUFhLENBQUMsS0FBYztJQUNuQyxJQUFJLEtBQUssWUFBWSxLQUFLO1FBQUUsT0FBTyxLQUFLLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUM7SUFDaEUsT0FBTyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDdkIsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSx1QkFBdUIsQ0FBQyxRQUE0QztJQUNsRixJQUFJLFFBQVEsS0FBSyxJQUFJLElBQUksUUFBUSxLQUFLLFNBQVM7UUFBRSxPQUFPLEdBQUcsRUFBRSxHQUFFLENBQUMsQ0FBQztJQUNqRSxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDL0IsT0FBTyxHQUFHLEVBQUU7UUFDVixnQkFBZ0IsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDcEMsQ0FBQyxDQUFDO0FBQ0osQ0FBQztBQUVELDBGQUEwRjtBQUMxRixNQUFNLFVBQVUsb0JBQW9CO0lBQ2xDLE9BQU8sZ0JBQWdCLENBQUMsSUFBSSxDQUFDO0FBQy9CLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsd0JBQXdCLENBQUMsVUFBa0QsRUFBRTtJ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