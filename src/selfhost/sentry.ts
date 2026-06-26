// Self-host-only error tracking (#1468). Opt-in: a complete NO-OP when SENTRY_DSN is unset, mirroring the
// env-gated, dynamically-imported selfhost-integration pattern (Redis/Qdrant/embed-provider in server.ts).
// @sentry/node is NEVER imported at module top level — it loads lazily inside initSentry(), so it never enters
// the Worker bundle (src/index.ts) and cloudflare:* stubbing stays clean. All helpers are safe to call when off.
type SentryNs = typeof import("@sentry/node");
let Sentry: SentryNs | undefined;
let active = false;

const SECRET_KEY =
  /(token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private)/i;

/** beforeSend scrubber — redact anything token/secret-like before an event leaves the box (privacy boundary). */
export function scrubEvent<T>(event: T): T {
  const redact = (obj: unknown, depth: number): void => {
    if (!obj || typeof obj !== "object" || depth > 6) return;
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const rec = obj as Record<string, unknown>;
      if (SECRET_KEY.test(key)) rec[key] = "[redacted]";
      else if (typeof rec[key] === "object") redact(rec[key], depth + 1);
    }
  };
  try {
    const e = event as {
      request?: { headers?: unknown };
      contexts?: unknown;
      extra?: unknown;
    };
    redact(e.request?.headers, 0);
    redact(e.contexts, 0);
    redact(e.extra, 0);
  } catch {
    /* scrubbing must never break the send */
  }
  return event;
}

/** Initialize Sentry from the environment. Returns false (and stays a no-op) when SENTRY_DSN is unset. */
export async function initSentry(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!env.SENTRY_DSN) return false;
  Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    release: env.SENTRY_RELEASE ?? env.GITTENSORY_VERSION,
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    serverName: env.PUBLIC_API_ORIGIN,
    beforeSend: (e) => scrubEvent(e),
  });
  active = true;
  return true;
}

/** Capture an error with optional structured context. No-op when Sentry is off. */
export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    if (context) scope.setContext("gittensory", context);
    Sentry!.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

/** Capture a degraded/failed review at WARNING level, tagged by repo/PR/SHA for triage. No-op when off. */
export function captureReviewFailure(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    if (context) {
      scope.setContext("review", context);
      for (const tag of ["owner", "repo", "pr", "head_sha"]) {
        const value = context[tag];
        if (value !== undefined && value !== null)
          scope.setTag(tag, String(value));
      }
    }
    Sentry!.captureException(
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}

/** Flush buffered events before exit. No-op when off. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!active || !Sentry) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}

/** Test-only: reset module state between cases. */
export function resetSentryForTest(): void {
  Sentry = undefined;
  active = false;
}
