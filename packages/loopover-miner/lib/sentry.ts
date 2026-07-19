/** Opt-in Sentry error tracking for the miner CLI (#6011). Complete no-op unless LOOPOVER_MINER_SENTRY_DSN is
 * set -- an operator points this at their OWN Sentry project; this is a published, independently-installed CLI
 * (@loopover/miner), so nothing here is ever auto-enabled or phones home by default, mirroring the main repo's
 * self-host Sentry integration (src/selfhost/sentry.ts). `@sentry/node` is lazy-imported only inside
 * `initMinerSentry()` so a miner invocation that never opts in pays zero module-load cost -- this CLI runs very
 * frequently under an unattended loop (lib/loop-cli.js). Unlike the main repo, there is no structured JSON-log
 * forwarding here: this package's own logger (lib/logger.js) writes plain `key=value` lines, not JSON, so
 * capture is explicit (`captureMinerError`) at each call site rather than a console-override. */

// @sentry/node is NEVER imported at module top level -- it loads lazily inside initMinerSentry() (see the module
// comment above), so `typeof import(...)` gives us its types without pulling it into the module-load path.
type SentryNs = typeof import("@sentry/node");

let Sentry: SentryNs | undefined;
let active = false;

/** Initialize Sentry from `env` (default `process.env`). Returns whether it activated. Call once, as early as
 * possible in a bin's startup -- after `loadMinerFileSecrets()` (so a `_FILE`-mounted DSN resolves first) and
 * before `installCliSignalHandlers()` (so a startup crash is still captured). */
export async function initMinerSentry(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!env.LOOPOVER_MINER_SENTRY_DSN) return false;
  const mod = await import("@sentry/node");
  Sentry = mod;
  Sentry.init({
    dsn: env.LOOPOVER_MINER_SENTRY_DSN,
    environment: env.LOOPOVER_MINER_SENTRY_ENVIRONMENT ?? "production",
  });
  active = true;
  return true;
}

/** Capture an error with optional structured context. No-op when Sentry is off. Never throws. */
export function captureMinerError(error: unknown, context?: Record<string, unknown>): void {
  if (!active || !Sentry) return;
  const sentry = Sentry;
  try {
    sentry.withScope((scope) => {
      if (context) scope.setContext("miner", context);
      sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
  } catch {
    /* Sentry capture must never crash the caller it's instrumenting. */
  }
}

/** Flush buffered events before the process exits. No-op when off. Never throws or hangs past `timeoutMs`. */
export async function flushMinerSentry(timeoutMs = 2000): Promise<void> {
  if (!active || !Sentry) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* Best-effort -- a flush failure must never block process exit. */
  }
}

/** Capture AND flush before returning -- the crash-path convenience wrapper for
 * installCliSignalHandlers' `captureError` hook (process-lifecycle.js). A bare `captureMinerError()` only
 * QUEUES the event in Sentry's transport; `process.exit()` tears the process down immediately afterward
 * without waiting for any pending HTTP delivery, so the crash-capture path needs this awaited flush or it is
 * very likely a near-total no-op in practice. */
export async function captureMinerErrorAndFlush(error: unknown, context?: Record<string, unknown>): Promise<void> {
  captureMinerError(error, context);
  await flushMinerSentry();
}

/** Test-only: reset module state so one test's activation can't leak into the next. */
export function resetMinerSentryForTesting(): void {
  Sentry = undefined;
  active = false;
}
