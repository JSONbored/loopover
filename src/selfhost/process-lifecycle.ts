// Self-host process crash-safety (#9133). server.ts previously registered NO uncaughtException/
// unhandledRejection handlers of its own -- the reasoning (removed by this fix, see the corrected comment
// in server.ts) was that PostHog's own `enableExceptionAutocapture` (posthog-node) already installs
// equivalent handlers when telemetry is configured, so no manual `process.on` wiring was needed for the
// crash case. That holds for `uncaughtException` ONLY: posthog-node's addUncaughtExceptionListener counts
// OTHER `uncaughtException` listeners and calls its own `process.exit(1)` only when it is the sole one. It
// does NOT hold for `unhandledRejection` -- posthog-node's addUnhandledRejectionListener captures the
// rejection but never rethrows or exits. Node 22's default `--unhandled-rejections=throw` escalates a
// rejection to an uncaught exception ONLY when no `unhandledRejection` listener is registered at all;
// installing PostHog's own (via enableExceptionAutocapture) silently downgrades every unhandled rejection
// into a captured telemetry event with no crash, no Docker restart, and no recovery of whatever in-flight
// job the crash used to reclaim (`loopover_jobs_recovered_total`) -- an absorbing state: the worker loop is
// dead, the process stays alive, and `/health` keeps reporting 200.
//
// FIX: this module is the SOLE, unconditional source of truth for the crash-and-restart contract -- the
// SAME two handlers are installed regardless of whether telemetry is configured, so the contract never
// depends on PostHog's own state. `initPostHog` (posthog.ts) sets `enableExceptionAutocapture: false`
// specifically so posthog-node never installs its OWN competing listeners for these two events: this
// avoids a double-captured exception (its internal listener firing IN ADDITION to this one) AND sidesteps
// the foreign-listener-count heuristic entirely -- a foreign `uncaughtException` listener (this module's
// own) would otherwise make posthog-node silently skip ITS `process.exit(1)`, quietly making this module
// responsible for that anyway. Better to own the whole contract outright than depend on that heuristic.
//
// Mirrors packages/loopover-miner/lib/process-lifecycle.ts's injectable-dependency shape (process/log/exit/
// captureError), adapted for a single long-running server rather than a one-shot CLI: no SIGINT/SIGTERM or
// cleanup-resource registry here -- server.ts's own graceful `shutdown()` already owns those, unchanged.

/** The subset of `process` the handlers use; injectable for tests. */
export type ProcessLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  exit: (code?: number) => void;
};

export type InstallSelfHostCrashHandlersOptions = {
  process?: ProcessLike;
  /** Structured log line, forwarded to PostHog by the existing installPostHogStructuredLogForwarding wiring
   *  when telemetry is active (a `level` field is required for that forwarding to pick it up). Defaults to
   *  `console.error`. */
  log?: (line: string) => void;
  exit?: (code: number) => void;
  /** Best-effort telemetry capture (`capturePostHogError` at the real call site) -- a no-op when telemetry
   *  isn't configured. Synchronous; never expected to throw. Belt-and-suspenders alongside `log` (which
   *  already reaches PostHog via structured-log-forwarding when active) so capture doesn't depend on that
   *  wiring having run first. */
  captureError?: (error: unknown, context: Record<string, unknown>) => void;
  /** Awaited before exit so a captured/queued telemetry event has a chance to actually leave the process --
   *  `process.exit()` tears the event loop down immediately otherwise, which would make capture a near-total
   *  no-op in practice for a batching client. No-op default. Never expected to throw/reject. */
  flush?: () => Promise<void>;
  /** #9487: hard ceiling on how long the flush above may delay the exit. Injectable so a test can drive the
   *  deadline path deterministically instead of waiting out the real one. */
  flushDeadlineMs?: number;
  /** Reinstall even if handlers were already installed (mainly for tests). */
  force?: boolean;
};

let handlersInstalled = false;

/** #9487: how long a fatal handler may wait on telemetry flush before exiting anyway. This handler exists to
 *  GUARANTEE the restart; a wedged egress must not be able to hold a process that has already declared itself
 *  unsound. Three seconds is generous for a batching HTTP client and still far inside any restart supervisor's
 *  patience. */
const FATAL_FLUSH_DEADLINE_MS = 3_000;

/** Render any thrown/rejected value as a single log-safe string, preferring an Error's stack -- mirrors the
 *  miner's own describeError exactly. */
function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return String(value);
}

/**
 * Install the uncaughtException/unhandledRejection crash handlers once. Both events are treated IDENTICALLY
 * (log, best-effort capture, flush, exit non-zero) -- the point of this fix is that BOTH must terminate the
 * process regardless of whether PostHog is configured, not just whichever one posthog-node's own
 * (now-disabled) autocapture happened to handle correctly. No-op (returns false) if already installed
 * unless `options.force` is set. All of `process`, `log`, `exit`, `captureError`, and `flush` are
 * injectable so this is unit-testable without ever registering a REAL process-level handler.
 */
export function installSelfHostCrashHandlers(options: InstallSelfHostCrashHandlersOptions = {}): boolean {
  const proc = options.process ?? (process as unknown as ProcessLike);
  const log = typeof options.log === "function" ? options.log : (line: string) => console.error(line);
  const exit = typeof options.exit === "function" ? options.exit : (code: number) => proc.exit(code);
  const captureError = typeof options.captureError === "function" ? options.captureError : () => {};
  const flush = typeof options.flush === "function" ? options.flush : async () => {};
  const flushDeadlineMs = typeof options.flushDeadlineMs === "number" ? options.flushDeadlineMs : FATAL_FLUSH_DEADLINE_MS;

  if (handlersInstalled && options.force !== true) return false;
  handlersInstalled = true;

  const handleFatal = (kind: "uncaughtException" | "unhandledRejection") => async (error: unknown): Promise<void> => {
    log(
      JSON.stringify({
        level: "fatal",
        event: `selfhost_${kind}`,
        error: describeError(error).slice(0, 4000),
      }),
    );
    captureError(error, { kind });
    // #9487: bounded. This handler exists to GUARANTEE the restart, and an unbounded `await flush()` let a
    // wedged telemetry egress (PostHog, via server.ts's flushPostHog) delay or entirely prevent the very exit
    // it is here to perform -- a process that has already logged a fatal sitting alive indefinitely, serving
    // requests from a state it declared unsound. Losing a few telemetry events is unambiguously the cheaper
    // failure. `race` (not a cancel) because there is nothing to cancel: the flush promise is abandoned and
    // the process exits under it.
    await Promise.race([
      flush(),
      new Promise<void>((resolve) => {
        // `unref()` so a pending deadline timer can never itself hold the process open past a flush that
        // resolved first -- the timer exists to bound the wait, not to extend the lifetime it is bounding.
        const timer = setTimeout(resolve, flushDeadlineMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    exit(1);
  };

  proc.on("uncaughtException", handleFatal("uncaughtException"));
  proc.on("unhandledRejection", handleFatal("unhandledRejection"));

  return true;
}

/** Test-only: clear the installed flag so each test starts from a clean lifecycle. */
export function resetSelfHostCrashHandlersForTest(): void {
  handlersInstalled = false;
}
