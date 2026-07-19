/** Opt-in Sentry error tracking for the miner CLI (#6011). Complete no-op unless LOOPOVER_MINER_SENTRY_DSN is
 * set -- an operator points this at their OWN Sentry project; this is a published, independently-installed CLI
 * (@loopover/miner), so nothing here is ever auto-enabled or phones home by default, mirroring the main repo's
 * self-host Sentry integration (src/selfhost/sentry.ts). `@sentry/node` is lazy-imported only inside
 * `initMinerSentry()` so a miner invocation that never opts in pays zero module-load cost -- this CLI runs very
 * frequently under an unattended loop (lib/loop-cli.js). Unlike the main repo, there is no structured JSON-log
 * forwarding here: this package's own logger (lib/logger.js) writes plain `key=value` lines, not JSON, so
 * capture is explicit (`captureMinerError`) at each call site rather than a console-override. */
let Sentry;
let active = false;
/** Initialize Sentry from `env` (default `process.env`). Returns whether it activated. Call once, as early as
 * possible in a bin's startup -- after `loadMinerFileSecrets()` (so a `_FILE`-mounted DSN resolves first) and
 * before `installCliSignalHandlers()` (so a startup crash is still captured). */
export async function initMinerSentry(env = process.env) {
    if (!env.LOOPOVER_MINER_SENTRY_DSN)
        return false;
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
export function captureMinerError(error, context) {
    if (!active || !Sentry)
        return;
    const sentry = Sentry;
    try {
        sentry.withScope((scope) => {
            if (context)
                scope.setContext("miner", context);
            sentry.captureException(error instanceof Error ? error : new Error(String(error)));
        });
    }
    catch {
        /* Sentry capture must never crash the caller it's instrumenting. */
    }
}
/** Flush buffered events before the process exits. No-op when off. Never throws or hangs past `timeoutMs`. */
export async function flushMinerSentry(timeoutMs = 2000) {
    if (!active || !Sentry)
        return;
    try {
        await Sentry.flush(timeoutMs);
    }
    catch {
        /* Best-effort -- a flush failure must never block process exit. */
    }
}
/** Capture AND flush before returning -- the crash-path convenience wrapper for
 * installCliSignalHandlers' `captureError` hook (process-lifecycle.js). A bare `captureMinerError()` only
 * QUEUES the event in Sentry's transport; `process.exit()` tears the process down immediately afterward
 * without waiting for any pending HTTP delivery, so the crash-capture path needs this awaited flush or it is
 * very likely a near-total no-op in practice. */
export async function captureMinerErrorAndFlush(error, context) {
    captureMinerError(error, context);
    await flushMinerSentry();
}
/** Test-only: reset module state so one test's activation can't leak into the next. */
export function resetMinerSentryForTesting() {
    Sentry = undefined;
    active = false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VudHJ5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2VudHJ5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7O2lHQU9pRztBQU1qRyxJQUFJLE1BQTRCLENBQUM7QUFDakMsSUFBSSxNQUFNLEdBQUcsS0FBSyxDQUFDO0FBRW5COztpRkFFaUY7QUFDakYsTUFBTSxDQUFDLEtBQUssVUFBVSxlQUFlLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7SUFDekYsSUFBSSxDQUFDLEdBQUcsQ0FBQyx5QkFBeUI7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUNqRCxNQUFNLEdBQUcsR0FBRyxNQUFNLE1BQU0sQ0FBQyxjQUFjLENBQUMsQ0FBQztJQUN6QyxNQUFNLEdBQUcsR0FBRyxDQUFDO0lBQ2IsTUFBTSxDQUFDLElBQUksQ0FBQztRQUNWLEdBQUcsRUFBRSxHQUFHLENBQUMseUJBQXlCO1FBQ2xDLFdBQVcsRUFBRSxHQUFHLENBQUMsaUNBQWlDLElBQUksWUFBWTtLQUNuRSxDQUFDLENBQUM7SUFDSCxNQUFNLEdBQUcsSUFBSSxDQUFDO0lBQ2QsT0FBTyxJQUFJLENBQUM7QUFDZCxDQUFDO0FBRUQsaUdBQWlHO0FBQ2pHLE1BQU0sVUFBVSxpQkFBaUIsQ0FBQyxLQUFjLEVBQUUsT0FBaUM7SUFDakYsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLE1BQU07UUFBRSxPQUFPO0lBQy9CLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQztJQUN0QixJQUFJLENBQUM7UUFDSCxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7WUFDekIsSUFBSSxPQUFPO2dCQUFFLEtBQUssQ0FBQyxVQUFVLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1lBQ2hELE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksS0FBSyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDckYsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1Asb0VBQW9FO0lBQ3RFLENBQUM7QUFDSCxDQUFDO0FBRUQsOEdBQThHO0FBQzlHLE1BQU0sQ0FBQyxLQUFLLFVBQVUsZ0JBQWdCLENBQUMsU0FBUyxHQUFHLElBQUk7SUFDckQsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLE1BQU07UUFBRSxPQUFPO0lBQy9CLElBQUksQ0FBQztRQUNILE1BQU0sTUFBTSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUNoQyxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsbUVBQW1FO0lBQ3JFLENBQUM7QUFDSCxDQUFDO0FBRUQ7Ozs7aURBSWlEO0FBQ2pELE1BQU0sQ0FBQyxLQUFLLFVBQVUseUJBQXlCLENBQUMsS0FBYyxFQUFFLE9BQWlDO0lBQy9GLGlCQUFpQixDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsQ0FBQztJQUNsQyxNQUFNLGdCQUFnQixFQUFFLENBQUM7QUFDM0IsQ0FBQztBQUVELHVGQUF1RjtBQUN2RixNQUFNLFVBQVUsMEJBQTBCO0lBQ3hDLE1BQU0sR0FBRyxTQUFTLENBQUM7SUFDbkIsTUFBTSxHQUFHLEtBQUssQ0FBQztBQUNqQixDQUFDIn0=