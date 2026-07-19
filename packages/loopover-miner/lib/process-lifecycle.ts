/** Process lifecycle / crash-safety for the miner CLI (#4826). The CLI dispatches through a chain of bare
 * `process.exit()` calls with no cleanup hook, so a SIGINT/SIGTERM mid-run — or an uncaught exception — used to
 * kill the process mid-write, leaving whatever local SQLite ledger it was touching in an undefined state. This
 * module is the single cleanup chokepoint: local stores register themselves when opened (see `local-store.js`), and
 * `installCliSignalHandlers` (called once at CLI startup) flushes/closes every still-open resource before exiting
 * cleanly on a signal, and logs + exits non-zero on an uncaught exception / unhandled rejection instead of crashing
 * silently. Cleanup ONLY — no command business logic lives here. Every dependency (`process`, `log`, `exit`) is
 * injectable so the handlers are unit-testable without actually signalling the test runner. */

/** A closable store (`{ close() }`) or a plain cleanup callback. */
export type CleanupResource = { close: () => void } | (() => void);

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

// 128 + signal number, the conventional shell exit code for a process terminated by that signal (SIGINT=2 -> 130,
// SIGTERM=15 -> 143).
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/** Resources to close on exit. A resource is either a `{ close() }` object (e.g. an open SQLite store) or a plain
 * cleanup function. Held in insertion order so cleanup is deterministic. */
const cleanupResources = new Set<CleanupResource>();
let handlersInstalled = false;

/** Render any thrown value as a single log-safe string, preferring an Error's stack. */
function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return String(value);
}

/**
 * Register a resource to be closed on clean exit or crash. Returns an idempotent unregister function (call it from
 * the resource's own normal `close()` so a resource closed during the happy path is not double-closed at exit).
 */
export function registerCleanupResource(resource: CleanupResource | null | undefined): () => void {
  if (resource === null || resource === undefined) return () => {};
  cleanupResources.add(resource);
  return () => {
    cleanupResources.delete(resource);
  };
}

/** Number of currently-registered cleanup resources (exposed for tests / diagnostics). */
export function cleanupResourceCount(): number {
  return cleanupResources.size;
}

/**
 * Close every registered resource, swallowing each individual failure (a store that fails to close must not stop
 * the others from closing) and reporting it via `options.onError`. Idempotent: the registry is emptied afterwards.
 */
export function closeAllCleanupResources(options: { onError?: (error: unknown) => void } = {}): void {
  const onError = typeof options.onError === "function" ? options.onError : null;
  for (const resource of [...cleanupResources]) {
    try {
      if (typeof resource === "function") resource();
      else resource.close();
    } catch (error) {
      if (onError) onError(error);
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
export function installCliSignalHandlers(options: InstallCliSignalHandlersOptions = {}): boolean {
  const proc: ProcessLike = options.process ?? process;
  const log: (message: string) => void = typeof options.log === "function" ? options.log : (message) => console.error(message);
  const exit: (code: number) => void = typeof options.exit === "function" ? options.exit : (code) => proc.exit(code);
  // Optional Sentry (or any) capture hook -- decoupled from a specific implementation so this module stays
  // fully unit-testable without mocking Sentry (#6011). No-op default matches this module's pre-existing
  // behavior for every caller that doesn't pass one.
  const captureError: (error: unknown, context?: Record<string, unknown>) => void | Promise<void> =
    typeof options.captureError === "function" ? options.captureError : () => {};

  if (handlersInstalled && options.force !== true) return false;
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
export function resetProcessLifecycleForTesting(): void {
  cleanupResources.clear();
  handlersInstalled = false;
}
